# Benchmark

Micro-benchmark of the main transformation functions, used to measure the compiled (JIT) transformation added in
`src/TransformCompiler.ts`.

```bash
npm run benchmark
```

This builds the library into `build/benchmark` and runs `benchmark/run.js` against it. To compare two versions,
build each one into its own folder and run the script once per build, in separate processes (the metadata storage
lives on `globalThis`):

```bash
node benchmark/run.js path/to/build-a before
node benchmark/run.js path/to/build-b after
```

## How the JIT works

The interpreted transformation looks up the metadata storage for every key of every object it transforms: exposed
and excluded keys, renamed keys, `@Type()` and `@Transform()` metadata, version and group filters, property
descriptors... All of these only depend on the target class and on the transformation options. For every
`(transformation type, options, class)` combination they are now resolved once and a specialized function is
generated with `new Function`, which:

- iterates a precomputed key list (`excludeAll` strategy or `excludeExtraneousValues`), or `Object.keys()` with a
  `switch` on the keys that have metadata (`exposeAll` strategy),
- has renamed keys, `@Type()` functions, `@Transform()` functions and implicit conversion types inlined,
- converts primitive values (`String`, `Number`, `Boolean`, `Date`) inline, without going through `transform()`,
- calls the compiled function of nested classes directly for plain objects (or instances of the class) and arrays of
  them, with a per call site cache of the last resolved type, instead of going through `transform()`.

Arrays of a class having a compiled function are transformed with a plain loop (same semantics as `forEach`) that
calls it directly.

The generated code follows the interpreted algorithm step by step. Compiled functions are dropped whenever metadata
is added to the storage. When a case can not be compiled (`targetMaps`, `Map` values, a Content-Security-Policy
forbidding `new Function`...) the interpreted transformation is used. `test/functional/jit-compilation.spec.ts` runs
the transformations with and without the JIT and checks the results are the same.

## Results

Node.js v24.20.0, Apple M1 Pro, median of 7 samples (higher is better). 0.5.1 is the upstream
`class-transformer` (`develop` at `a2734a5`), 1.0.0 the first JIT version.

| Scenario                                              | class-transformer 0.5.1 | turbo-transformer 1.0.0 |   Current | vs 1.0.0 |  vs 0.5.1 |
| ----------------------------------------------------- | ----------------------: | ----------------------: | --------: | -------: | --------: |
| plainToInstance flat (no decorators)                  |                 558,898 |               1,626,554 | 1,871,613 | **1.2×** |  **3.3×** |
| plainToInstance nested User                           |                  76,652 |                 650,628 | 1,307,221 | **2.0×** | **17.1×** |
| plainToInstance nested User (excludeExtraneousValues) |                  84,485 |               1,019,649 | 1,500,639 | **1.5×** | **17.8×** |
| plainToInstance nested User (groups: admin)           |                  71,848 |                 603,238 | 1,169,711 | **1.9×** | **16.3×** |
| plainToInstance 1000 Users                            |                      77 |                     779 |     2,411 | **3.1×** | **31.4×** |
| instanceToPlain nested User                           |                 103,298 |                 728,400 | 1,587,922 | **2.2×** | **15.4×** |
| instanceToPlain 1000 Users                            |                     101 |                     888 |     2,856 | **3.2×** | **28.1×** |
| instanceToInstance nested User                        |                  96,035 |                 652,861 | 1,540,574 | **2.4×** | **16.0×** |
| plainToInstance implicit conversion                   |                 323,404 |               1,530,181 | 2,041,794 | **1.3×** |  **6.3×** |
| plainToInstance nested User (enableCircularCheck)     |                  73,832 |                 520,941 |   971,610 | **1.9×** | **13.2×** |

`plainToInstance 1000 Users`, 5 interleaved runs (ops/s): 0.5.1 71–80, 1.0.0 716–786, current 2,352–2,406.

The nested `User` has 13 properties: exposed / renamed / excluded properties, a group, a `@Transform()`, a `Date`, a
nested `Address` and an array of 3 `Photo`.
