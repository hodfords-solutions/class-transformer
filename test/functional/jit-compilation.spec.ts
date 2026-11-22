import 'reflect-metadata';
import {
  ClassTransformOptions,
  Exclude,
  Expose,
  instanceToInstance,
  instanceToPlain,
  plainToClassFromExist,
  plainToInstance,
  Transform,
  Type,
} from '../../src/index';
import { defaultMetadataStorage } from '../../src/storage';
import { setJitEnabled } from '../../src/TransformCompiler';

/**
 * The compiled (JIT) transformation must give exactly the same results as the interpreted one:
 * every transformation here is run with both and the results are compared (values, prototypes and key order).
 */
describe('compiled (JIT) transformation', () => {
  afterEach(() => setJitEnabled(true));

  /** Deep structure including constructor names and key order, so differences in prototypes or order fail. */
  function describeValue(value: any, seen = new Set<any>()): any {
    if (value === null || typeof value !== 'object') {
      return typeof value === 'number' && isNaN(value) ? 'NaN' : value;
    }
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    let result: any;
    if (value instanceof Date) result = { date: value.getTime() };
    else if (value instanceof Map)
      result = { map: Array.from(value.entries()).map(([k, v]) => [k, describeValue(v, seen)]) };
    else if (value instanceof Set) result = { set: Array.from(value).map(v => describeValue(v, seen)) };
    else if (Array.isArray(value)) result = value.map(v => describeValue(v, seen));
    else if (typeof value.then === 'function') result = 'promise';
    else {
      result = { __class: value.constructor ? value.constructor.name : 'null-prototype' };
      for (const key of Object.keys(value)) result[key] = describeValue(value[key], seen);
    }
    seen.delete(value);
    return result;
  }

  function compare(run: () => any): any {
    const input = () => run();
    setJitEnabled(false);
    let interpreted: any, interpretedError: any;
    try {
      interpreted = describeValue(input());
    } catch (error) {
      interpretedError = error;
    }
    setJitEnabled(true);
    let compiled: any, compiledError: any;
    try {
      // twice: the first run compiles, the second one uses the cache
      input();
      compiled = describeValue(input());
    } catch (error) {
      compiledError = error;
    }
    expect(compiledError && String(compiledError)).toEqual(interpretedError && String(interpretedError));
    expect(compiled).toEqual(interpreted);
    expect(JSON.stringify(compiled)).toEqual(JSON.stringify(interpreted));
    return compiled;
  }

  const optionSets: ClassTransformOptions[] = [
    {},
    { excludeExtraneousValues: true },
    { strategy: 'excludeAll' },
    { groups: ['admin'] },
    { groups: ['user'] },
    { version: 0.5 },
    { version: 2 },
    { excludePrefixes: ['_', 'sec'] },
    { exposeUnsetFields: false },
    { exposeDefaultValues: true },
    { enableImplicitConversion: true },
    { enableCircularCheck: true },
    { ignoreDecorators: true },
    { ignoreDecorators: true, excludeExtraneousValues: true },
    { groups: ['admin'], version: 1, excludePrefixes: ['_'], exposeUnsetFields: false },
  ];

  it('gives the same results as the interpreter for all kinds of metadata and options', () => {
    defaultMetadataStorage.clear();

    class Tag {
      @Expose()
      name: string;

      @Expose()
      @Type(() => Date)
      createdAt: Date;
    }

    abstract class Animal {
      @Expose()
      kind: string;
      @Expose()
      name: string;
    }
    class Dog extends Animal {
      @Expose()
      barks: boolean;
    }
    class Cat extends Animal {
      @Expose()
      lives: number;
    }

    class Base {
      @Expose()
      id: number;

      @Exclude({ toPlainOnly: true })
      secret: string;

      _internal = 'internal';
    }

    class Model extends Base {
      @Expose({ name: 'full_name' })
      fullName: string;

      @Expose({ groups: ['admin'] })
      role: string;

      @Expose({ since: 1, until: 3 })
      versioned: string;

      @Expose()
      @Transform(({ value }) => (typeof value === 'string' ? value.toUpperCase() : value), { toClassOnly: true })
      @Transform(({ value }) => (typeof value === 'string' ? '<' + value + '>' : value), { toPlainOnly: true })
      @Transform(({ value }) => (typeof value === 'string' ? value + '!' : value), { groups: ['admin'] })
      title: string;

      @Expose()
      @Type(() => Tag)
      tags: Tag[];

      @Expose()
      @Type(() => Tag)
      mainTag: Tag;

      @Expose()
      @Type(() => Animal, {
        discriminator: {
          property: 'kind',
          subTypes: [
            { value: Dog, name: 'dog' },
            { value: Cat, name: 'cat' },
          ],
        },
        keepDiscriminatorProperty: true,
      })
      pets: Animal[];

      @Expose()
      @Type(() => Animal, {
        discriminator: {
          property: 'kind',
          subTypes: [
            { value: Dog, name: 'dog' },
            { value: Cat, name: 'cat' },
          ],
        },
        keepDiscriminatorProperty: true,
      })
      favoritePet: Animal;

      @Expose()
      @Type(() => String)
      code: string;

      @Expose()
      @Type(() => Number)
      count: number;

      @Expose()
      @Type(() => Boolean)
      flag: boolean;

      @Expose()
      @Type(() => Date)
      date: Date;

      @Expose()
      @Type(() => Tag)
      tagMap: Map<string, Tag>;

      @Expose()
      @Type(() => Set)
      tagSet: Set<string>;

      @Expose()
      implicitNumber: number;

      @Expose()
      defaulted: string = 'default';

      @Exclude()
      excluded = 'excluded';

      secretToken = 'abc';

      @Expose()
      get computed(): string {
        return 'computed:' + String(this.id);
      }

      method(): string {
        return 'method';
      }
    }

    const plain = (): any => ({
      id: '1',
      secret: 'pwd',
      _internal: 'x',
      full_name: 'John Doe',
      fullName: 'not renamed',
      role: 'admin',
      versioned: 'v',
      title: 'hello',
      tags: [
        { name: 'a', createdAt: '2020-01-01T00:00:00.000Z' },
        { name: 'b', createdAt: '2021-01-01T00:00:00.000Z', extra: 1 },
      ],
      mainTag: { name: 'main', createdAt: '2022-01-01T00:00:00.000Z' },
      pets: [
        { kind: 'dog', name: 'Rex', barks: true },
        { kind: 'cat', name: 'Tom', lives: 9 },
      ],
      favoritePet: { kind: 'cat', name: 'Kitty', lives: 7 },
      code: 123,
      count: '42',
      flag: 1,
      date: '2023-05-05T00:00:00.000Z',
      tagMap: { first: { name: 'first', createdAt: '2020-01-01T00:00:00.000Z' } },
      tagSet: ['x', 'y'],
      implicitNumber: '7',
      excluded: 'should not be here',
      secretToken: 'token',
      computed: 'from plain',
      method: 'from plain',
      unknown: { nested: { deep: [1, 2, { x: null }] } },
      nothing: null,
      undef: undefined,
      constructor: 'evil',
    });

    for (const options of optionSets) {
      const instance = compare(() => plainToInstance(Model, plain(), options));
      expect(instance).toBeDefined();
      compare(() => plainToInstance(Model, [plain(), plain()], options));

      setJitEnabled(false);
      const modelInstance = plainToInstance(Model, plain(), { enableImplicitConversion: true });
      setJitEnabled(true);
      compare(() => instanceToPlain(modelInstance, options));
      compare(() => instanceToInstance(modelInstance, options));
      compare(() => plainToClassFromExist(new Model(), plain(), options));
      compare(() => instanceToPlain({ plain: plain(), list: [modelInstance] }, options));
      compare(() => plainToInstance(Tag, { name: 1, createdAt: 0, other: 'x' }, options));
    }
  });

  it('gives the same results for unusual nested values', () => {
    defaultMetadataStorage.clear();

    class Item {
      @Type(() => Number)
      value: number;
      name: string;
    }

    class SubItem extends Item {}

    class ItemList extends Array<Item> {}

    class Holder {
      @Type(() => Item)
      items: Item[];

      @Type(() => Item)
      item: Item;

      @Type(() => Item)
      itemSet: Set<Item>;
    }

    const sparse: any[] = [{ value: '1' }, , { value: '3' }]; // eslint-disable-line no-sparse-arrays
    const customForEach: any[] = [{ value: '1' }, { value: '2' }];
    customForEach.forEach = function (callback: any) {
      Array.prototype.forEach.call([this[1]], callback);
    };
    const values = (): any[] => [
      sparse,
      customForEach,
      [{ value: '1', then: () => 'not a promise' }],
      [Object.assign(Object.create(null), { value: '2' })],
      [Object.assign(new Item(), { value: '3' }), Object.assign(new SubItem(), { value: '4' })],
      [1, 'a', null, undefined, true, new Date(0), new Map([['a', { value: '5' }]]), [{ value: '6' }]],
      Object.assign(new ItemList(), { 0: { value: '7' }, length: 1 }),
      new Set([{ value: '8' }]),
      { value: '9', then: 1 },
      Object.assign(new SubItem(), { value: '10' }),
    ];

    for (const options of [{}, { enableCircularCheck: true }]) {
      values().forEach((value, index) => {
        compare(() => plainToInstance(Holder, { items: values()[index], item: value, itemSet: value }, options));
        compare(() => plainToInstance(Item, values()[index], options));
        const holder = plainToInstance(Holder, { items: values()[index], item: value }, options);
        compare(() => instanceToPlain(holder, options));
        compare(() => instanceToInstance(holder, options));
      });
    }
  });

  it('gives the same results for circular references', () => {
    defaultMetadataStorage.clear();

    class Node {
      @Type(() => Node)
      parent: Node;

      @Type(() => Node)
      children: Node[];

      name: string;
    }

    const root = new Node();
    root.name = 'root';
    const child = new Node();
    child.name = 'child';
    child.parent = root;
    root.children = [child];

    // objects referencing themselves, transformed through arrays and properties
    const self = new Node();
    self.name = 'self';
    self.parent = self;
    self.children = [self];
    root.children.push(self);
    const selfPlain: any = { name: 'self' };
    selfPlain.parent = selfPlain;
    selfPlain.children = [selfPlain];

    compare(() => instanceToPlain(root, { enableCircularCheck: true }));
    compare(() => instanceToInstance(root, { enableCircularCheck: true }));
    compare(() =>
      plainToInstance(Node, { name: 'root', children: [selfPlain], parent: selfPlain }, { enableCircularCheck: true })
    );
    compare(() => plainToInstance(Node, [selfPlain], { enableCircularCheck: true }));
  });

  it('recompiles when metadata is added after a transformation', () => {
    defaultMetadataStorage.clear();

    class Late {
      name: string;
      age: number;
    }

    expect(plainToInstance(Late, { name: 'a', age: '1' })).toEqual(Object.assign(new Late(), { name: 'a', age: '1' }));
    Type(() => Number)(Late.prototype, 'age');
    Exclude()(Late.prototype, 'name');
    const result = plainToInstance(Late, { name: 'a', age: '1' });
    expect(result).toBeInstanceOf(Late);
    expect(result.age).toBe(1);
    expect(result.name).toBeUndefined();
  });

  it('falls back to the interpreter when code generation is not allowed', () => {
    defaultMetadataStorage.clear();

    class Simple {
      @Type(() => Number)
      value: number;
    }

    // simulate a Content-Security-Policy forbidding eval
    const originalFunction = global.Function;
    (global as any).Function = function () {
      throw new EvalError('Code generation from strings disallowed for this context');
    };
    try {
      const result = plainToInstance(Simple, { value: '3' });
      expect(result).toBeInstanceOf(Simple);
      expect(result.value).toBe(3);
    } finally {
      (global as any).Function = originalFunction;
    }
  });
});
