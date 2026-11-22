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
- converts primitive values (`String`, `Number`, `Boolean`, `Date`) inline, without going through `transform()`.

The generated code follows the interpreted algorithm step by step. Compiled functions are dropped whenever metadata
is added to the storage. When a case can not be compiled (`targetMaps`, `Map` values, a Content-Security-Policy
forbidding `new Function`...) the interpreted transformation is used. `test/functional/jit-compilation.spec.ts` runs
the transformations with and without the JIT and checks the results are the same.

## Results

Node.js v24.20.0, Apple M1 Pro, median of 7 samples (higher is better). Before: `develop` at `a2734a5`.

| Scenario                                              | Before (ops/s) | After (ops/s) |   Speedup |
| ----------------------------------------------------- | -------------: | ------------: | --------: |
| plainToInstance flat (no decorators)                  |        558,898 |     1,578,520 |  **2.8×** |
| plainToInstance nested User                           |         76,652 |       617,672 |  **8.1×** |
| plainToInstance nested User (excludeExtraneousValues) |         84,485 |       972,789 | **11.5×** |
| plainToInstance nested User (groups: admin)           |         71,848 |       542,707 |  **7.6×** |
| plainToInstance 1000 Users                            |             77 |           740 |  **9.6×** |
| instanceToPlain nested User                           |        103,298 |       709,832 |  **6.9×** |
| instanceToPlain 1000 Users                            |            101 |           878 |  **8.7×** |
| instanceToInstance nested User                        |         96,035 |       641,585 |  **6.7×** |
| plainToInstance implicit conversion                   |        323,404 |     1,493,518 |  **4.6×** |
| plainToInstance nested User (enableCircularCheck)     |         73,832 |       498,332 |  **6.7×** |

The nested `User` has 13 properties: exposed / renamed / excluded properties, a group, a `@Transform()`, a `Date`, a
nested `Address` and an array of 3 `Photo`.
