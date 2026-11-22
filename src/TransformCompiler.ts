import { defaultMetadataStorage } from './storage';
import { TransformationType } from './enums';
import { ClassTransformOptions, TransformMetadata, TypeHelpOptions, TypeMetadata, TypeOptions } from './interfaces';
import { getGlobal } from './utils';
import type { TransformOperationExecutor } from './TransformOperationExecutor';

/**
 * JIT compiler for object transformations.
 *
 * The interpreted transformation (TransformOperationExecutor#transformObject) looks up the metadata storage for
 * every key of every object it transforms: exposed / excluded keys, renamed keys, @Type and @Transform metadata,
 * version and group filters, property descriptors... All of these only depend on the target class and on the
 * transformation options, so for every (transformation type, options, class) combination we resolve them once and
 * generate (with `new Function`) a specialized function that transforms objects of that class.
 *
 * The generated code mirrors the interpreted algorithm step by step, so the result is the same. Whenever a case
 * cannot be compiled (Map values, target maps, a failing metadata lookup, CSP forbidding `new Function`...) the
 * executor falls back to the interpreted transformation.
 */

export type CompiledTransformer = (executor: TransformOperationExecutor, source: any, value: any, level: number) => any;

/** Max number of different option combinations kept in cache. */
const MAX_CACHES = 256;
/** Max number of unknown keys for which implicit types are cached per compiled class. */
const MAX_IMPLICIT_CACHE = 1000;

let jitEnabled = true;
const caches = new Map<string, JitCache>();

/**
 * Enables or disables the compiled (JIT) transformation. Enabled by default.
 * @internal mainly used for testing the compiled and interpreted transformations against each other.
 */
export function setJitEnabled(enabled: boolean): void {
  jitEnabled = enabled;
  caches.clear();
}

/**
 * Returns the cache of compiled transformers for given transformation type and options,
 * or undefined when the options cannot be compiled.
 */
export function getJitCache(transformationType: TransformationType, options: ClassTransformOptions): JitCache {
  if (!jitEnabled || !options || options.targetMaps) return undefined;

  // the global storage may have been created by another (older) copy of the library
  const storage: any = defaultMetadataStorage;
  if (typeof storage.version !== 'number' || typeof storage.getMetadataPropertyNames !== 'function') return undefined;

  const fingerprint = getFingerprint(transformationType, options);
  let cache = caches.get(fingerprint);
  if (!cache) {
    if (caches.size >= MAX_CACHES) caches.clear();
    cache = new JitCache();
    caches.set(fingerprint, cache);
  }
  return cache;
}

/**
 * Builds a key from everything in the options that influences the generated code.
 */
function getFingerprint(transformationType: TransformationType, o: ClassTransformOptions): string {
  return (
    String(transformationType) +
    '|' +
    String(o.strategy || '') +
    '|' +
    (o.excludeExtraneousValues ? '1' : '0') +
    (o.ignoreDecorators ? '1' : '0') +
    (o.enableCircularCheck ? '1' : '0') +
    (o.enableImplicitConversion ? '1' : '0') +
    (o.exposeDefaultValues ? '1' : '0') +
    (o.exposeUnsetFields ? '1' : '0') +
    '|' +
    typeof o.version +
    ':' +
    String(o.version) +
    '|' +
    (o.groups && o.groups.length ? JSON.stringify(o.groups) : '') +
    '|' +
    (o.excludePrefixes && o.excludePrefixes.length ? JSON.stringify(o.excludePrefixes) : '')
  );
}

/**
 * Compiled transformers of each class for one transformation type and set of options.
 */
export class JitCache {
  private version = -1;
  private classes = new WeakMap<Function, CompiledTransformer | null>();
  private directs = new WeakMap<Function, DirectTransformer | null>();
  private anonymous: CompiledTransformer | null | undefined = undefined;

  /**
   * Returns the compiled transformer to call directly for elements of arrays of given type, or null.
   */
  direct(targetType: Function, executor: TransformOperationExecutor): DirectTransformer | null {
    // get() first: it drops everything when metadata changed
    const transformer = this.get(targetType, executor);
    if (!transformer) return null;
    let direct = this.directs.get(targetType);
    if (direct === undefined || direct.transformer !== transformer) {
      const resolved = helpers.resolveChild(executor, targetType);
      direct = resolved ? new DirectTransformer(resolved, helpers.directPrototype(targetType)) : null;
      this.directs.set(targetType, direct);
    }
    return direct;
  }

  /**
   * Returns the compiled transformer for given target type (undefined when it can not be compiled).
   */
  get(targetType: any, executor: TransformOperationExecutor): CompiledTransformer | undefined {
    // metadata changed since the transformers were compiled: drop them all
    const version = defaultMetadataStorage.version;
    if (version !== this.version) {
      this.version = version;
      this.classes = new WeakMap();
      this.directs = new WeakMap();
      this.anonymous = undefined;
    }

    if (targetType === undefined || targetType === null) {
      if (this.anonymous === undefined) this.anonymous = compileSafe(undefined, executor);
      return this.anonymous || undefined;
    }
    if (typeof targetType !== 'function') return undefined;

    let compiled = this.classes.get(targetType);
    if (compiled === undefined) {
      compiled = compileSafe(targetType, executor);
      this.classes.set(targetType, compiled);
    }
    return compiled || undefined;
  }
}

/**
 * Compiled transformer of a type, with the check of the values TransformOperationExecutor#transform would
 * transform with it: plain objects and instances of the type which are not arrays, sets, dates, maps, buffers or
 * promises.
 */
export class DirectTransformer {
  constructor(readonly transformer: CompiledTransformer, private readonly prototype: any) {}

  accepts(value: any): boolean {
    if (value === null || typeof value !== 'object') return false;
    const prototype = Object.getPrototypeOf(value);
    return (prototype === Object.prototype || prototype === this.prototype) && typeof value.then !== 'function';
  }
}

// ---------------------------------------------------------------------------
// Runtime helpers used by the generated code
// ---------------------------------------------------------------------------

function getPropertyDescriptor(obj: any, key: PropertyKey): PropertyDescriptor | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(obj, key);
  if (descriptor) return descriptor;

  const prototype = Object.getPrototypeOf(obj);
  return prototype ? getPropertyDescriptor(prototype, key) : undefined;
}

const helpers = {
  /**
   * Same as the primitive branches of TransformOperationExecutor#transform (value is not an object).
   */
  conv(value: any, targetType: any): any {
    if (targetType === String) return value === null || value === undefined ? value : String(value);
    if (targetType === Number) return value === null || value === undefined ? value : Number(value);
    if (targetType === Boolean) return value === null || value === undefined ? value : Boolean(value);
    if (targetType === Date) return value === null || value === undefined ? value : new Date(value);
    if (!!getGlobal().Buffer && targetType === Buffer) {
      return value === null || value === undefined ? value : Buffer.from(value);
    }
    return value;
  },

  /**
   * True when the prototype has a property without setter (getter / method) for given key.
   */
  descSkip(prototype: any, key: string): boolean {
    if (!(key in prototype)) return false;
    const descriptor = getPropertyDescriptor(prototype, key);
    return !!(descriptor && !descriptor.set);
  },

  /**
   * Returns the compiled transformer to call directly for objects of given (resolved) type, or null when
   * TransformOperationExecutor#transform would not take its object branch with this type as target.
   */
  resolveChild(executor: TransformOperationExecutor, type: any): CompiledTransformer | null {
    if (typeof type !== 'function' || type === String || type === Number || type === Boolean || type === Date) {
      return null;
    }
    if (!!getGlobal().Buffer && type === Buffer) return null;
    const jit: JitCache = (executor as any).jit;
    return (jit && jit.get(type, executor)) || null;
  },

  /**
   * Prototype of the instances that can be passed directly to the compiled transformer of given type, besides plain
   * objects: null when instances of the type are arrays, sets, dates, maps or buffers (handled by other branches).
   */
  directPrototype(type: Function): any {
    const prototype = type.prototype;
    if (!prototype) return null;
    const excluded: Function[] = [Array, Set, Date, Map];
    if (getGlobal().Buffer) excluded.push(Buffer);
    for (const cls of excluded) {
      if (prototype === cls.prototype || prototype instanceof cls) return null;
    }
    return prototype;
  },

  /** Same as instantiateArrayType in TransformOperationExecutor. */
  newArray(arrayType: any): any {
    if (!arrayType) return [];
    const array = new arrayType();
    if (!(array instanceof Set) && !('push' in array)) {
      return [];
    }
    return array;
  },

  prefixBlocked(key: string, prefixes: string[]): boolean {
    return !prefixes.every(prefix => key.substr(0, prefix.length) !== prefix);
  },

  implicitType(cache: Map<string, any>, target: Function, key: string): any {
    let type = cache.get(key);
    if (type === undefined && !cache.has(key)) {
      type = (Reflect as any).getMetadata('design:type', target.prototype, key) || undefined;
      if (cache.size < MAX_IMPLICIT_CACHE) cache.set(key, type);
    }
    return type;
  },

  /**
   * Resolves the type of a property having a @Type() with discriminator, exactly like the interpreted version.
   */
  discType(
    executor: TransformOperationExecutor,
    metadata: TypeMetadata,
    value: any,
    valueKey: string,
    subValue: any,
    newValue: any,
    propertyName: string
  ): any {
    const options: TypeHelpOptions = { newObject: newValue, object: value, property: propertyName };
    const newType = metadata.typeFunction ? metadata.typeFunction(options) : metadata.reflectedType;
    const transformationType: TransformationType = (executor as any).transformationType;
    let type: any = undefined;
    if (!(value[valueKey] instanceof Array)) {
      if (transformationType === TransformationType.PLAIN_TO_CLASS) {
        type = metadata.options.discriminator.subTypes.find(subType => {
          if (subValue && subValue instanceof Object && metadata.options.discriminator.property in subValue) {
            return subType.name === subValue[metadata.options.discriminator.property];
          }
        });
        type === undefined ? (type = newType) : (type = type.value);
        if (!metadata.options.keepDiscriminatorProperty) {
          if (subValue && subValue instanceof Object && metadata.options.discriminator.property in subValue) {
            delete subValue[metadata.options.discriminator.property];
          }
        }
      }
      if (transformationType === TransformationType.CLASS_TO_CLASS) {
        type = subValue.constructor;
      }
      if (transformationType === TransformationType.CLASS_TO_PLAIN) {
        if (subValue) {
          subValue[metadata.options.discriminator.property] = metadata.options.discriminator.subTypes.find(
            subType => subType.value === subValue.constructor
          ).name;
        }
      }
    } else {
      type = metadata;
    }
    return type;
  },
};

// ---------------------------------------------------------------------------
// Compiler
// ---------------------------------------------------------------------------

function compileSafe(target: Function | undefined, executor: TransformOperationExecutor): CompiledTransformer | null {
  try {
    // objects extending Map are filled using `set`, leave them to the interpreter
    if (target && (target === Map || target.prototype instanceof Map)) return null;
    return compile(target, executor);
  } catch (error) {
    // any failure (CSP forbidding `new Function`, a throwing metadata lookup...) => use the interpreter,
    // which reproduces the error when it applies
    return null;
  }
}

type TypeKind = 'none' | 'string' | 'number' | 'boolean' | 'date' | 'dynamic';

function kindOfStaticType(type: any): TypeKind {
  if (type === undefined) return 'none';
  if (type === String) return 'string';
  if (type === Number) return 'number';
  if (type === Boolean) return 'boolean';
  if (type === Date) return 'date';
  if (typeof Buffer !== 'undefined' && type === Buffer) return 'dynamic';
  // any other class: primitives are returned as they are
  return 'none';
}

function compile(target: Function | undefined, executor: TransformOperationExecutor): CompiledTransformer {
  // the compiler reuses private members of the executor (options, key resolution, version & group checks)
  const ex: any = executor;
  const storage = defaultMetadataStorage;
  const options: ClassTransformOptions = ex.options;
  const transformationType: TransformationType = ex.transformationType;
  const isPlainToClass = transformationType === TransformationType.PLAIN_TO_CLASS;
  const isClassToClass = transformationType === TransformationType.CLASS_TO_CLASS;
  const isClassToPlain = transformationType === TransformationType.CLASS_TO_PLAIN;
  const createsInstance = isPlainToClass || isClassToClass;
  const targetPrototype = target ? target.prototype : Object.prototype;

  // constants made available to the generated code
  const constants: any[] = [];
  const ref = (value: any): string => {
    let index = constants.indexOf(value);
    if (index === -1) index = constants.push(value) - 1;
    return 'k' + String(index);
  };
  const str = (value: string): string => JSON.stringify(value);
  let labelCounter = 0;
  // per call site caches of the last resolved child type => compiled transformer
  const siteDeclarations: string[] = [];
  const circularCheck = !!options.enableCircularCheck;

  // custom @Transform() functions applied to a key, filtered exactly like applyCustomTransformations
  const getTransforms = (key: string): TransformMetadata[] => {
    let metadatas = storage.findTransformMetadatas(target, key, transformationType);
    if (options.version !== undefined) {
      metadatas = metadatas.filter(
        metadata => !metadata.options || ex.checkVersion(metadata.options.since, metadata.options.until)
      );
    }
    if (options.groups && options.groups.length) {
      metadatas = metadatas.filter(metadata => !metadata.options || ex.checkGroups(metadata.options.groups));
    } else {
      metadatas = metadatas.filter(
        metadata => !metadata.options || !metadata.options.groups || !metadata.options.groups.length
      );
    }
    return metadatas;
  };

  const emitTransforms = (metadatas: TransformMetadata[], keyExpr: string): string =>
    metadatas
      .map(
        metadata =>
          `fv = ${ref(metadata)}.transformFn({ value: fv, key: ${keyExpr}, obj: value, type: ${String(
            transformationType
          )}, options: ex.options });\n`
      )
      .join('');

  const emitAssign = (newKeyExpr: string): string => {
    const assign = `if (nvm) newValue.set(${newKeyExpr}, fv); else newValue[${newKeyExpr}] = fv;\n`;
    return options.exposeUnsetFields ? assign : `if (fv !== undefined) { ${assign} }\n`;
  };

  /**
   * Transformation of `fv` (sub value) into `fv`, same as TransformOperationExecutor#transform:
   * - primitives are converted inline,
   * - plain objects (or instances of the target type) and arrays of them, when the type has a compiled transformer,
   *   are passed directly to that compiled transformer,
   * - everything else goes through TransformOperationExecutor#transform.
   */
  const emitChild = (
    typeExpr: string,
    kind: TypeKind,
    arrayTypeExpr: string,
    isMapExpr: string,
    valueKeyExpr: string
  ): string => {
    let primitive: string;
    const convert = (expr: string) => (isMapExpr === 'true' ? 'fv' : `(${isMapExpr} || fv == null ? fv : ${expr})`);
    switch (kind) {
      case 'none':
        primitive = 'fv';
        break;
      case 'string':
        primitive = convert('String(fv)');
        break;
      case 'number':
        primitive = convert('Number(fv)');
        break;
      case 'boolean':
        primitive = convert('Boolean(fv)');
        break;
      case 'date':
        primitive = convert('new Date(fv)');
        break;
      default:
        primitive = isMapExpr === 'true' ? 'fv' : `(${isMapExpr} ? fv : H.conv(fv, ${typeExpr}))`;
    }
    const slow = `fv = ex.transform(source ? source[${valueKeyExpr}] : undefined, fv, ${typeExpr}, ${arrayTypeExpr}, ${isMapExpr}, level + 1);`;

    // types which can never have a compiled transformer: no direct call
    if (kind !== 'none' && kind !== 'dynamic') {
      return `if (typeof fv !== 'object' || fv === null) { fv = ${primitive}; }\nelse { ${slow} }\n`;
    }
    if (typeExpr === 'undefined') {
      return `if (typeof fv !== 'object' || fv === null) { fv = ${primitive}; }\nelse { ${slow} }\n`;
    }

    const site = String(siteDeclarations.length);
    const sT = 'sT' + site; // last type seen at this call site
    const sF = 'sF' + site; // its compiled transformer (null: not directly callable)
    const sP = 'sP' + site; // prototype of instances which can be passed directly
    siteDeclarations.push(`let ${sT} = UNSET, ${sF} = null, ${sP} = null;\n`);

    const callDirect = (valueExpr: string, levelExpr: string) =>
      circularCheck
        ? `(ex.recursionStack.add(${valueExpr}), r = ${sF}(ex, undefined, ${valueExpr}, ${levelExpr}), ex.recursionStack.delete(${valueExpr}), r)`
        : `${sF}(ex, undefined, ${valueExpr}, ${levelExpr})`;
    const isDirect = (valueExpr: string) =>
      `((pp = Object.getPrototypeOf(${valueExpr})) === OP || pp === ${sP}) && typeof ${valueExpr}.then !== 'function'`;

    // array branch of TransformOperationExecutor#transform, with forEach and the element type checks unrolled
    const newArray = isPlainToClass && arrayTypeExpr !== 'undefined' ? `H.newArray(${arrayTypeExpr})` : '[]';
    const add = (valueExpr: string) =>
      newArray === '[]' ? `arr.push(${valueExpr});` : `if (isSet) arr.add(${valueExpr}); else arr.push(${valueExpr});`;
    let arrayCode =
      `const n = fv.length;\nconst arr = ${newArray};\n` +
      (newArray === '[]' ? '' : 'const isSet = arr instanceof Set;\n') +
      `for (let j = 0; j < n; j++) {\nif (!(j in fv)) continue;\nconst el = fv[j];\n`;
    if (circularCheck) {
      arrayCode += `if (ex.recursionStack.has(el)) { ${isClassToClass ? add('el') : ''} continue; }\n`;
    }
    arrayCode +=
      `let r;\n` +
      `if (typeof el !== 'object' || el === null) r = el;\n` +
      `else if (${isDirect('el')}) r = ${callDirect('el', 'level + 2')};\n` +
      `else r = ex.transform(undefined, el, t, undefined, el instanceof Map, level + 2);\n` +
      `${add('r')}\n}\nfv = arr;\n`;

    return (
      `if (typeof fv !== 'object' || fv === null) { fv = ${primitive}; }\n` +
      `else {\nconst t = ${typeExpr};\n` +
      `if (t !== ${sT}) { ${sT} = t; ${sF} = H.resolveChild(ex, t); ${sP} = ${sF} === null ? null : H.directPrototype(t); }\n` +
      `let pp, r;\n` +
      `if (${sF} === null || source) { ${slow} }\n` +
      `else if (Array.isArray(fv) && fv.forEach === AFE) {\n${arrayCode}}\n` +
      `else if (!${isMapExpr} && ${isDirect('fv')}) { fv = ${callDirect('fv', 'level + 1')}; }\n` +
      `else { ${slow} }\n}\n`
    );
  };

  /**
   * Generates the transformation of a single key. `key` is the static key, or undefined for the
   * generic code handling (at runtime) keys without any metadata, stored in the `key` variable.
   */
  const emitKey = (key: string | undefined): string => {
    if (key === '__proto__' || key === 'constructor') return '';
    const label = 'p' + String(labelCounter++);
    const keyExpr = key === undefined ? 'key' : str(key);

    // key renaming
    let newValueKey = key;
    let propertyName = key;
    if (key !== undefined && !options.ignoreDecorators && target) {
      if (isPlainToClass) {
        const exposeMetadata = storage.findExposeMetadataByCustomName(target, key);
        if (exposeMetadata) {
          propertyName = exposeMetadata.propertyName;
          newValueKey = exposeMetadata.propertyName;
        }
      } else {
        const exposeMetadata = storage.findExposeMetadata(target, key);
        if (exposeMetadata && exposeMetadata.options && exposeMetadata.options.name) {
          newValueKey = exposeMetadata.options.name;
        }
      }
    }
    const newKeyExpr = key === undefined ? 'key' : str(newValueKey);
    const propertyExpr = key === undefined ? 'key' : str(propertyName);
    const transformKey = isPlainToClass ? newValueKey : key;
    const transformKeyExpr = isPlainToClass ? newKeyExpr : keyExpr;

    let code = `${label}: {\n`;

    // sub value
    code += isPlainToClass
      ? `const sv = value[${keyExpr}];\n`
      : `const sv = value[${keyExpr}] instanceof Function ? value[${keyExpr}]() : value[${keyExpr}];\n`;

    // type
    let typeExpr = 'undefined';
    let kind: TypeKind = 'none';
    let isMapExpr = 'sv instanceof Map';
    let arrayTypeExpr = 'undefined';
    const typeMetadata = key !== undefined && target ? storage.findTypeMetadata(target, propertyName) : undefined;
    if (typeMetadata) {
      const typeOptions: TypeOptions = typeMetadata.options;
      if (
        typeOptions &&
        typeOptions.discriminator &&
        typeOptions.discriminator.property &&
        typeOptions.discriminator.subTypes
      ) {
        code += `const type = H.discType(ex, ${ref(
          typeMetadata
        )}, value, ${keyExpr}, sv, newValue, ${propertyExpr});\n`;
        typeExpr = 'type';
        kind = 'dynamic';
      } else if (typeMetadata.typeFunction) {
        code += `const type = ${ref(
          typeMetadata
        )}.typeFunction({ newObject: newValue, object: value, property: ${propertyExpr} });\n`;
        typeExpr = 'type';
        kind = 'dynamic';
      } else {
        typeExpr = ref(typeMetadata.reflectedType);
        kind = kindOfStaticType(typeMetadata.reflectedType);
      }
      if (typeMetadata.reflectedType === Map) isMapExpr = 'true';
      if (typeMetadata.reflectedType !== undefined) {
        arrayTypeExpr = `(Array.isArray(value[${keyExpr}]) ? ${ref(typeMetadata.reflectedType)} : undefined)`;
      }
    } else if (target && options.enableImplicitConversion && isPlainToClass) {
      if (key === undefined) {
        code += `const type = H.implicitType(${ref(new Map())}, ${ref(target)}, key);\n`;
        typeExpr = 'type';
        kind = 'dynamic';
      } else {
        const reflectedType = (Reflect as any).getMetadata('design:type', target.prototype, propertyName);
        if (reflectedType) {
          typeExpr = ref(reflectedType);
          kind = kindOfStaticType(reflectedType);
        }
      }
    }
    if (isMapExpr !== 'true') code += `const ism = ${isMapExpr};\n`;
    const isMapVar = isMapExpr === 'true' ? 'true' : 'ism';

    // skip keys matching a getter / method of the new value
    if (createsInstance) {
      const staticSkip =
        key === undefined ? `H.descSkip(proto, key)` : String(helpers.descSkip(targetPrototype, newValueKey));
      const descriptorSkip =
        staticSkip === 'false'
          ? `(!protoIsTarget && H.descSkip(proto, ${newKeyExpr}))`
          : staticSkip === 'true'
          ? `(protoIsTarget || H.descSkip(proto, ${newKeyExpr}))`
          : `(protoIsTarget ? ${staticSkip} : H.descSkip(proto, ${newKeyExpr}))`;
      // `newValue.constructor.prototype` is read once per object, but must throw here like the interpreter
      code +=
        `if (nvc == null) newValue.constructor.prototype;\n` +
        `if (proto && (${descriptorSkip} || newValue[${newKeyExpr}] instanceof Function)) break ${label};\n`;
    }

    const transforms = key === undefined ? [] : getTransforms(transformKey);

    let main = 'let fv;\n';
    if (isClassToPlain) {
      main += `fv = value[${transformKeyExpr}];\n`;
      main += emitTransforms(transforms, transformKeyExpr);
      main += `fv = value[${transformKeyExpr}] === fv ? sv : fv;\n`;
      main += emitChild(typeExpr, kind, arrayTypeExpr, isMapVar, keyExpr);
    } else {
      const transformSub =
        'fv = sv;\n' +
        emitChild(typeExpr, kind, arrayTypeExpr, isMapVar, keyExpr) +
        emitTransforms(transforms, transformKeyExpr);
      main += options.exposeDefaultValues
        ? `if (sv === undefined) { fv = newValue[${newKeyExpr}]; } else {\n${transformSub}}\n`
        : transformSub;
    }
    main += emitAssign(newKeyExpr);

    if (options.enableCircularCheck) {
      code += `if (!ex.recursionStack.has(sv)) {\n${main}}\n`;
      if (isClassToClass) {
        const circularTransforms = key === undefined ? [] : getTransforms(key);
        code += `else {\nlet fv = sv;\n${emitTransforms(circularTransforms, keyExpr)}${emitAssign(newKeyExpr)}}\n`;
      }
    } else {
      code += main;
    }

    return code + '}\n';
  };

  // -------------------------------------------------------------------------
  // keys to transform
  // -------------------------------------------------------------------------

  let strategy = storage.getStrategy(target);
  if (strategy === 'none') strategy = options.strategy || 'exposeAll';
  // with exposeAll, keys of the transformed object are used (see TransformOperationExecutor#getKeys)
  const dynamicKeys = strategy === 'exposeAll' && !(target && options.excludeExtraneousValues);
  // keys always transformed (exposed properties), or all keys when they are not dynamic
  const staticKeys: string[] = ex.getKeys(target, {}, false);

  let body = `const newValue = source ? source : ${
    createsInstance && target ? `new ${ref(target)}()` : '{}'
  };\nconst nvm = newValue instanceof Map;\n`;
  if (createsInstance) {
    body +=
      `const nvc = newValue.constructor;\nconst proto = nvc == null ? undefined : nvc.prototype;\n` +
      `const protoIsTarget = proto === ${ref(targetPrototype)};\n`;
  }

  if (!dynamicKeys) {
    for (const key of staticKeys) body += emitKey(key);
  } else {
    // keys having metadata get their own compiled code, other keys use the generic code
    const knownKeys = new Set<string>(staticKeys);
    if (target) {
      storage.getMetadataPropertyNames(target).forEach(name => knownKeys.add(name));
      storage.getExposedMetadatas(target).forEach(metadata => {
        if (metadata.options && typeof metadata.options.name === 'string') knownKeys.add(metadata.options.name);
      });
    }
    knownKeys.delete('__proto__');
    knownKeys.delete('constructor');

    const extraKeys = staticKeys.filter(key => key !== '__proto__' && key !== 'constructor');
    // exposed keys missing from the object are transformed after the object keys
    // set when the key is found in the object keys
    extraKeys.forEach((key, index) => {
      body += `let has${String(index)} = false;\n`;
    });

    let cases = `case "__proto__": case "constructor": continue;\n`;
    knownKeys.forEach(key => {
      const probe: Record<string, any> = {};
      probe[key] = true;
      const blocked = !ex.getKeys(target, probe, false).includes(key);
      const extraIndex = extraKeys.indexOf(key);
      const seen = extraIndex === -1 ? '' : `has${String(extraIndex)} = true;\n`;
      cases += blocked ? `case ${str(key)}: continue;\n` : `case ${str(key)}: ${seen}${emitKey(key)}continue;\n`;
    });

    body += `const keys = Object.keys(value);\n`;
    body += `for (let i = 0; i < keys.length; i++) {\nconst key = keys[i];\nswitch (key) {\n${cases}}\n`;
    if (options.excludePrefixes && options.excludePrefixes.length) {
      body += `if (H.prefixBlocked(key, ${ref(options.excludePrefixes.slice())})) continue;\n`;
    }
    body += emitKey(undefined);
    body += '}\n';

    extraKeys.forEach((key, index) => {
      body += `if (!has${String(index)}) {\n${emitKey(key)}}\n`;
    });
  }
  body += 'return newValue;\n';

  const declarations = constants.map((_, index) => `const k${index} = K[${index}];\n`).join('');
  const source =
    `'use strict';\n${declarations}const OP = Object.prototype;\nconst AFE = Array.prototype.forEach;\nconst UNSET = {};\n${siteDeclarations.join(
      ''
    )}` + `return function compiledTransform(ex, source, value, level) {\n${body}};`;

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function('K', 'H', source) as (constants: any[], h: typeof helpers) => CompiledTransformer;
  return factory(constants, helpers);
}
