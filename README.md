# cow-zod-prototype

[![CI](https://github.com/iceboundrock/zod-cow/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/iceboundrock/zod-cow/actions/workflows/ci.yml)

English | [简体中文](README.zh-CN.md)

A prototype Copy-on-Write (CoW) compilation layer for Zod schemas, grown out of the [Numeric fork](https://numeric.substack.com/p/how-we-doubled-zod-performance-to) idea.

`compile(schema)` returns a fast parser whose output is `===` the input reference whenever nothing was forced to change (no default, transform, strip, coerce, catch, preprocess or pipe fired). When something did change, only the path from that leaf to the root is copied; every sibling subtree keeps sharing the input.

The difference from the Numeric fork: Numeric made `parse` return the original object by deleting seven features (`default / transform / coerce / catch / pipe / preprocess / intersection`). This prototype keeps all of them. It uses reference comparison as the dirty signal and copies on demand, so a copy happens only at the point where a new value was produced at runtime.

- No fork of zod and no change to the Zod API: schemas are consumed as they are (the `.def` tree is read), type inference stays `z.infer`.
- Shape, keys and checks are resolved once at compile time into specialized validation code.
- The layer never mutates the input on its own: nothing is deleted or rewritten in place. The Numeric fork's strip deletes extra keys on the input object; that footgun is fixed here. The one in-place write that can reach the input is the `Object.freeze` of `readonly`. The zod4 line performs it exactly where stock zod 4 does, on a pass-through leaf such as `any` / `unknown` (see [When a copy is forced](#when-a-copy-is-forced) and #28); the frozen zod3 line performs it on every `readonly` node (#27).
- Failure paths carry no issue data of their own: the compiled function returns a sentinel and the caller falls back to stock `safeParse` for the full `ZodError`.

## Two compiler lines

| Line | Entry | Engine | Status |
|---|---|---|---|
| **zod4** | `packages/zod-cow-v4/src/index.ts` → `packages/zod-cow-v4/src/cow4/` | Reuses zod4's official JIT codegen (`compileFn` / `assertOnly`) as the semantic backend and adds CoW container skeletons for object, array, tuple, record, map and set, plus async support | **Active line**, all new work goes here |
| zod3 | `packages/zod-cow-v3/src/index.ts` → `packages/zod-cow-v3/src/compile.ts` | Hand-written closure-tree compiler; string format regexes copied verbatim from zod 3.24.1 | **Frozen reference implementation**: the origin of the CoW idea and a comparison baseline, kept passing but not extended |

The lines live in two workspace packages, each installing its own zod: `packages/zod-cow-v4` (published as [`zod-cow-v4`](packages/zod-cow-v4/README.md)) against zod 4.5.4, `packages/zod-cow-v3` (private, the frozen line) against zod 3.24.1; both import `zod` by its real specifier. The two lines share no code. An earlier self-written zod4 front-end (v0.2) was replaced by the current zod4 line and removed; its findings are recorded in the [CHANGELOG](CHANGELOG.md#020).

## Quick start

Requires Node.js >= 22.13.0 and pnpm 11.24.0.

```bash
pnpm install
pnpm run build       # build zod-cow-v4 (ESM + declarations into packages/zod-cow-v4/dist)
pnpm run test:v4     # zod4 line: version canary + smoke tests + 20 000-case differential fuzz against stock zod4
pnpm run test:v3     # zod3 line: 27 unit tests + 20 000-case differential fuzz against stock zod3
pnpm run smoke:pack  # pack zod-cow-v4 and exercise the tarball from a temporary consumer project
pnpm run bench:v4    # zod4 benchmark against the built package, 500 000 records (needs node --expose-gc, already in the script)
pnpm run bench:v3    # zod3 benchmark
pnpm run probe:v4    # survey stock zod4 def structure and behavior
pnpm run probe:v3    # probe stock zod3 edge semantics (zod3 line)
pnpm run demo        # 60-second demo of the CoW promises against the published zod-cow-v4 API
```

Environment knobs: `SEEDS` / `CASES` set the differential fuzz size (default 200 × 100). `REPRO=seed:case` re-runs one failing zod4 differential case and dumps the schema, input and generated code (`REPRO=112:80 pnpm --filter zod-cow-v4 exec tsx tests/differential-z4.test.ts`). `BENCH_N` sets the benchmark record count (an integer of at least 10).

> The benchmark tables in this README and in `docs/` come from the
> [Benchmarks workflow](https://github.com/iceboundrock/zod-cow/actions/workflows/bench.yml),
> [run 33945725973](https://github.com/iceboundrock/zod-cow/actions/runs/33945725973):
> a GitHub-hosted `ubuntu-latest` runner, node v24, `BENCH_N=50 000`, the built
> `zod-cow-v4` package, warmup and timed rounds in complete rotations of the candidate order
> (at least 2 warmup and 3 timed rounds per candidate, rounded up to a multiple of the
> candidate count, so 5 plus 5 with five candidates), medians.
> The workflow builds `zod-cow-v4`, runs `bench-v4` and `bench-v3` manually or weekly and prints
> the tables in the job summary. Runner noise is a few milliseconds at this
> record count, so ratios close to 1.0x (S1 against the public compiled API and against
> ArkType) should be read as level. A local `pnpm run bench:v4` uses the script default
> of 500 000 records.

## Install and usage

`zod-cow-v4` is the published package. Its README, [packages/zod-cow-v4/README.md](packages/zod-cow-v4/README.md), is the consumer document and the only place that carries the install, usage, API and zod peer-policy text; install it from there (`pnpm add zod-cow-v4 zod`) and read the API table there.

The zod3 line is not published. It is the frozen reference implementation in `packages/zod-cow-v3`, exercised through its workspace export by its own tests and by `bench-v3`; its API differs from the zod4 line (`ZcError` instead of `ZodError`, a `DeepReadonly` view from `validate()`, a static `.pure` flag), see `packages/zod-cow-v3/src/index.ts` and `pnpm run demo:v3`.

## The CoW invariant

Every compiled node is `(input) => output | FAILED-sentinel`. No "change notification" protocol is needed:

| Input type | Dirty signal |
|---|---|
| Primitives (string, number, bigint, …) | Value comparison: `'  x '.trim() !== '  x'` is dirty; `'x'.trim() === 'x'` is clean, zero copy |
| object / array / tuple / record / Map / Set | Reference comparison: a child returning the input reference means "unchanged", so the parent does not copy |
| default / transform / coerce / catch / preprocess / pipe | Return a new value, which the parent notices through `outVal !== inVal` |

A parent does its first shallow copy (`{...input}` / `slice()` / `new Map(input)`) at the first changed child and writes further dirty children into that copy. Siblings keep sharing. This is the path copying of persistent data structures: changing one leaf copies exactly the path from that leaf to the root. Cost model: expected allocations ≈ Σ P(node is dirty) × depth; the worst case is a full rebuild (stock behavior), the typical case is about zero.

### When a copy is forced

| Feature | Copies when |
|---|---|
| string / number / boolean / bigint / date / literal / enum / instanceof, refine (pure predicate), optional / nullable / any / unknown | Never |
| readonly | The zod4 line hands the subtree to the official parser (the purity analysis treats `Object.freeze` as a side effect), so it freezes exactly what stock zod 4 freezes. Over a container (`object` / `array` / `tuple` / `record` / `map` / `set`) that is a new container: the copy is frozen, the input stays unfrozen and unshared. Over a pass-through leaf (`any` / `unknown` / `custom`, or a wrapper of one) stock returns the input itself and freezes it in place, and so does this line (#28). The zod3 line freezes the input in place on every `readonly` node and returns it (#27) |
| object / array / tuple / record / map / set | Never while every child is unchanged: the input reference is returned |
| union / discriminatedUnion | Never while the matching branch returns its input |
| default | Only when `undefined` is actually replaced |
| transform / preprocess / pipe / catch | Only when a new value is actually produced at runtime |
| strip (default object mode) | Only when the input really has extra keys (`for...in` with generated comparisons for small fixed shapes, a `Set` fallback for large shapes, plus an own-symbol probe) |
| strict / passthrough | Never (strict fails on extra keys) |
| `.trim()` / `.toLowerCase()` / `.toUpperCase()` | Only when the value actually changes (value comparison) |

Consequences that constrain every change:

- Never mutate the input. Strip must never `delete` on the input object. The only in-place write is the `Object.freeze` of `readonly`: the zod4 line freezes a copy for containers and freezes a pass-through leaf in place exactly as stock does (#28); the zod3 line freezes the input in place on every `readonly` node (#27).
- Output may alias input, so refines must not mutate.
- Failure paths return the sentinel; the caller falls back to stock `safeParse` for the full `ZodError`.

## How the zod4 line stays aligned with stock

The zod4 line does not re-implement zod's semantics. zod4 (>= 4.1) ships a JIT compiler (`src/v4/core/compile.ts`) whose products are reused per subtree:

1. Official products as leaves and subtrees. `compileFn(schema)` gives a stock-semantics parser; `compileFn(schema, {assertOnly: true})` gives a validator that skips output construction.
2. Purity analysis is a conservative whitelist deciding "validation passes ⇒ output === input". Pure subtrees get the official validator, impure subtrees get the official parser plus a reference comparison.
3. Container skeletons are string-templated codegen that mirrors zod's own `generate*` functions line by line, then rewrites the unconditional `const out = {...}` into "compare references, copy on first dirt, `return input` when clean". Container-level checks (`min` / `max` / `refine`) run on the final output on both paths.
4. Async: async subtrees become async islands, every product call site emits `await`, and the skeleton becomes an async function. The sync API on an async product throws `$ZodAsyncError`, same as stock.
5. Degradation chain, per subtree, never giving up correctness: CoW skeleton → official validator (pure leaf) → official parser (impure subtree) → runtime island (`_zod.run` black box) → whole-tree stock `safeParse` (`compiled.stock === true`).

The layer depends on `zod/v4/core`, a public permalink subpath whose compiler exports (`compileFn`, `assertOnly`, `INVALID`, the artifact protocol) are unsupported, and on a few hand-copied predicates. It is anchored to zod 4.5.4, the lower bound of the package's peer range: `packages/zod-cow-v4/tests/canary-z4.test.ts` asserts the stock behaviors the compiler assumes, so an upgrade turns the tests red instead of drifting silently. [docs/upstream-issue-draft.md](docs/upstream-issue-draft.md) asks zod upstream to make that surface public.

The zod3 line aligns itself with probes instead (`packages/zod-cow-v3/src/probe.ts` measures stock zod3 edge semantics at runtime): absent optional keys are not materialized, present-undefined keys are kept, default values pass the inner validation, issues are collected across sibling fields, `readonly` freezes shallowly.

The full design, with generated code dumped side by side against the official products, is in [docs/ARCHITECTURE-z4.md](docs/ARCHITECTURE-z4.md).

## Benchmarks

zod4 line, [Benchmarks workflow run 33945725973](https://github.com/iceboundrock/zod-cow/actions/runs/33945725973): 50 000 accounts, GitHub-hosted `ubuntu-latest` runner, node v24, `--expose-gc`, the built `zod-cow-v4` package, warmup and timed rounds in complete rotations of the candidate order (at least 2 warmup and 3 timed rounds per candidate, rounded up to a multiple of the candidate count: 5 plus 5 with five candidates), medians (`pnpm run bench:v4` with `BENCH_N=50000`). "z.compile()" is the public compiled API of Zod 4.5: `z.compile(schema).safeParse` in the parse scenarios and `z.validate(compiled, data)` in the validation-only ones. "ArkType" is arktype 2.2.3 through its normal public API (direct `Type(data)` for parsing, `.allows()` for validation only) on a schema built to the same constraints as the zod schema; the bench checks that equivalence with valid and invalid fixtures before timing and prints `N/A` with the reason where ArkType has no native equivalent (see [Cross-library comparison](#cross-library-comparison)). The internal `compileFn` / `assertOnly` product, the engineering control behind the public API, is measured in a diagnostic table of the run and reads level with the public column (no systematic direction at this record count: 1.26x on S1, 0.77x on S2, 0.89x to 1.03x across S3, 1.07x on S8), so it is no longer a column here.

Batch scenarios (one call parses the whole dataset):

| Scenario | stock zod4 | z.compile() | **zod-cow-v4** | ArkType |
|---|---|---|---|---|
| S1 clean-input parse (no undeclared keys) | 57 ms | 20 ms | **22 ms** | 22 ms |
| S1 allocation pressure / retained after GC | +17.9 MB / +11.6 MB | +11.0 MB / +10.8 MB | **+3.1 MB / 0.0 MB** | +5.4 MB / 0.0 MB |
| S2 10% default injection | 60 ms | 25 ms | **25 ms** | 765 ms |
| S2 allocation pressure / retained | +19.8 MB / +11.6 MB | +18.2 MB / +11.6 MB | **+4.1 MB / +1.0 MB** | +91.4 MB / +11.6 MB |
| S3 sweep, 0% / 25% / 50% / 100% dirty | 58 / 60 / 58 / 59 ms | 28 / 28 / 28 / 29 ms | **25 / 24 / 24 / 25 ms** | 759 / 746 / 754 / 737 ms |
| S3 retained after GC | +11.6 to +12.3 MB | +11.6 MB constant | **0.0 / 2.0 / 3.6 / 6.9 MB** | +11.6 MB constant |
| S4 validation only | N/A (no validation-only API) | 19 ms (`z.validate`) | **20 ms** (`validate()`) | 23 ms (`.allows()`) |
| S5 record / map / set | 76 ms | 49 ms | **26 ms** | N/A (`Map` / `Set` are instanceof-only; non-equivalent reference 8 ms) |
| S5 allocation pressure / retained | +54.1 MB / +21.7 MB | +61.6 MB / +21.7 MB | **+29.4 MB / 0.0 MB** | N/A |
| S6 tuple | 37 ms | 14 ms | **4 ms** | 2 ms |
| S6 allocation pressure / retained | +55.2 MB / +20.6 MB | +20.2 MB / +20.2 MB | **+1.5 MB / 0.0 MB** | +0.0 MB / 0.0 MB |
| S7 async transform (5 000 rows) | 13 ms (safeParseAsync) | N/A (`z.compile()` hands an async schema back uncompiled) | **7 ms (safeParseAsync)** | N/A (no native async morph) |
| S7 allocation pressure | +14.3 MB | N/A | **+9.0 MB** | N/A |
| S8 strip-unknown parse parity | 70 ms | 35 ms | **27 ms** | 1 025 ms (`onDeepUndeclaredKey("delete")`) |
| S8 allocation pressure / retained | +28.3 MB / +11.6 MB | +11.4 MB / +10.8 MB | **+8.0 MB / +8.0 MB** | +158.0 MB / +66.6 MB |
| S10 parse failures, per-row `safeParse`, 1% / 10% / 50% / 100% invalid rows | 58 / 76 / 125 / 200 ms | 19 / 37 / 108 / 201 ms | **24 / 44 / 116 / 203 ms** | 29 / 82 / 253 / 390 ms |

Single-record hot loops (one small input, 50 000 operations per timed round, median nanoseconds per operation; a calibration against the shape of public single-object benchmarks, not a product workload):

| Scenario | stock zod4 | z.compile() | **zod-cow-v4** | ArkType |
|---|---|---|---|---|
| calibration parse (6-field primitive object) | 466 ns | 42 ns | **82 ns** | 58 ns |
| calibration validate (same record) | N/A | 11 ns (`z.validate`) | **10 ns** (`validate()`) | 18 ns (`.allows()`) |
| S9 validation-only failure: first field / last field / nested / email / tuple slot | N/A | 1 402 / 1 520 / 1 656 / 2 269 / 1 223 ns | **18 / 243 / 242 / 132 / 47 ns** | 268 / 8 / 22 / 206 / 46 ns |
| S10 parse failure with errors: first key / last key / nested / refine | 3 322 / 3 316 / 3 492 / 3 270 ns | 3 300 / 3 426 / 3 572 / 3 439 ns | **3 261 / 3 440 / 3 466 / 3 612 ns** | 6 386 / 11 157 / 6 783 / 5 813 ns |

Ratios against zod-cow-v4 (a value above 1 means the other implementation took longer, so zod-cow was faster; not computed for N/A cells):

| Scenario | stock / zod-cow | z.compile() / zod-cow | ArkType / zod-cow |
|---|---|---|---|
| S1 clean-input parse | 2.57x | 0.93x | 1.00x |
| S2 10% default | 2.38x | 0.99x | 30.16x |
| S3 0% / 25% / 50% / 100% dirty | 2.33x / 2.45x / 2.37x / 2.39x | 1.14x / 1.13x / 1.15x / 1.18x | 30.53x / 30.49x / 30.97x / 29.85x |
| S4 validation only | n/a | 0.96x | 1.17x |
| S5 record / map / set | 2.94x | 1.89x | n/a |
| S6 tuple | 9.19x | 3.50x | 0.45x |
| S7 async transform | 1.88x | n/a | n/a |
| S8 strip-unknown parse parity | 2.58x | 1.28x | 37.83x |
| S10 parse failures, 1% / 10% / 50% / 100% invalid | 2.45x / 1.72x / 1.08x / 0.99x | 0.79x / 0.84x / 0.93x / 0.99x | 1.23x / 1.87x / 2.19x / 1.93x |
| calibration parse / validate | 5.68x / n/a | 0.52x / 1.14x | 0.71x / 1.81x |

How to read it:

- Against stock: 2.3x to 9.2x on the sync batch scenarios (S1 2.57x, S2 2.38x, S3 2.33x to 2.45x, S5 2.94x, S6 9.19x, S8 2.58x), and the 12 to 22 MB retained after GC drops to zero on clean input. Async (S7) is 1.88x at 5 000 rows, where a few milliseconds of runner noise weigh heavily.
- Against the public compiled API: level on clean object input within runner noise (S1 0.93x, S2 0.99x: 0 to 2 ms at 50 000 rows), ahead once rows are dirty (S3 1.13x to 1.18x: the copy path assembles the output from the captured locals exactly as the compiled parser does, so a dirty row costs the same literal, while the clean rows around it cost nothing) and on strip input (S8 1.28x: the copy drops undeclared keys by construction and shares the untouched `tags` arrays), and ahead on the container scenarios (S5 1.89x, S6 3.50x), where the whole-tree rebuild of stock semantics is a fixed cost and CoW pays only for the paths that changed. Behind on per-row parses of small objects (calibration parse 0.52x, S10 1% invalid 0.79x): the per-object cost of the skeleton is the strip-mode probes, see below.
- Against ArkType: level on the clean parse (S1 1.00x), ahead on validation-only (S4 1.17x, calibration validate 1.81x), behind on tuples (S6 0.45x, 2 ms against 4 ms: ArkType's precompiled check returns the input and allocates nothing, while the skeleton pays the strip probes per row) and on the single-record parse (0.71x). The S2/S3/S8 gap (30x to 38x in zod-cow's favor) is architectural: any morph, a key default or an undeclared-key deletion included, moves ArkType 2.2.3 off its precompiled `allows` path onto an interpreted traversal that deep-clones the whole input before applying the queued morphs (+90 MB allocated at 50 000 rows in S3, +158 MB in S8, every row rebuilt), whereas zod-cow compiles the default like every other leaf and copies only the rows that changed. S1 is a fair comparison of the clean fixture only: zod's default object mode strips undeclared keys and ArkType's keeps them by reference, so S8 is the scenario where both do the same work.
- Failure paths: `validate()` answers `null` from the compiled validator alone (18 to 243 ns), while the public `z.validate` falls back to the runtime parser on failure (1.2 to 2.3 µs) and ArkType's `.allows()` checks keys in its own cost order (8 ns when the cheap `active` key fails, 268 ns when `id` does). With detailed errors (S10) every zod path costs the same 3.3 to 3.6 µs per invalid record: the fast path of both compiled variants is a small fraction of the runtime parse that builds the `ZodError`, so their double work is not visible; a failing refine predicate runs twice for `z.compile()`, zod-cow and ArkType (once per successful parse everywhere). On mixed datasets zod-cow follows the invalid share from 2.45x (1%) to 0.99x (100%) against stock.
- validate fast path: `validate()` is the official whole-tree `assertOnly` product of the same array schema, so S4 reads level with `z.validate` by construction (20 ms against 19 ms, 0.96x). Its value is the validation-only cost: 20 ms / 50 000 = 400 ns per account, with nothing retained after GC.
- The +3.1 MB in S1 is short-lived allocation from the strip-mode probe: exactly one empty own-symbol array (32 bytes) per object, 100 000 objects here, read to prove that the object can be returned by reference. That probe (`Object.getOwnPropertySymbols`) is also the skeleton's per-object cost: about 36 ns of a 65 ns skeleton call on a 6-field record measured locally on Node 24, next to about 9 ns for the `for...in` probe and nothing measurable for the leaf validator calls, against 24 ns for the compiled parser of the same schema. It stays because stock drops own symbol keys and a pass-through has to prove there are none; an opt-in mode for JSON-shaped data is a design question tracked in #40, not a benchmark setting.

The zod3 line measured 4.2x to 4.7x against stock zod 3.24.1 in the same run (S1 4.22x, S2 4.67x; stock zod3 still pays the interpreter tax). The superseded tables from runs 33940596453 and 33837195401 and the earlier local 500 000-record tables, including the v0.5 zod4 table and those of the removed v0.2 front-end and of v0.3, are in the [CHANGELOG](CHANGELOG.md).

### Cross-library comparison

The ArkType column is measured only where arktype 2.2.3 expresses the same workload through its normal public API. `packages/bench-v4/schemas.ts` builds the ArkType schema next to the zod schema, and `gates.ts` runs valid and deliberately invalid fixtures (non-integer and unsafe-integer `id`, overlong name in ASCII and in astral characters next to a 64-astral-character name every implementation accepts, non-finite numbers, malformed email and datetime, invalid role, oversized tags, missing role, invalid nested and container values, tuple length and type errors, undeclared keys at every level) through every implementation before anything is timed; an undeclared disagreement aborts the run, a declared one prints as `known divergence`.

| Scenario | ArkType equivalent | ArkType API | Notes |
|---|---|---|---|
| S1 | yes | `Type(data)` | `number.integer & number.safe` for `.int()`, `string[] <= 8`, the literal union. zod's `.max(64)` counts Unicode code points and ArkType's `string <= 64` counts UTF-16 units (64 astral characters pass zod and fail the keyword), so the bound goes in as zod's own rule: the native `string <= 64` as the first union branch and a predicate counting code points on the overflow branch only. `z.number()` rejects both infinities and ArkType's `number` accepts them, so numbers carry a finite range through ArkType's range API (native range nodes). The zod email and datetime patterns go in as ArkType regex constraints because `string.email` and `string.date.iso` accept supersets (`.a@x.com`, date-only dates, offsets). The gate holds a boundary fixture for each of these (64 and 65 astral characters, ±Infinity, NaN). Extra keys pass through by reference in ArkType and are stripped into a copy by zod (declared on the extra-key fixture); the S1 data has none, S8 measures the strip case |
| S2, S3 | yes | `Type(data)` with `role: "'admin' \| 'member' \| 'viewer' = 'viewer'"` | Same absent-key input, same outputs. Declared divergence: zod also defaults a present `undefined`, ArkType rejects it |
| S4, calibration validate, S9 | yes | `Type.allows(data)` | Validation only, next to `z.validate(compiled, data)` and `validate()`. ArkType checks keys in its own cost order, zod in declaration order, which the S9 per-position results show |
| S5 | no | N/A | `Map` / `Set` are instanceof checks and there is no `Map<K, V>` / `Set<T>` generic, so entries and members are never validated. The closest schema runs as a labeled non-equivalent reference (8 ms) and stays out of the ratios |
| S6, S9 tuple | yes | `Type(data)` with a pair of finite numbers (the same finite range as S1) and `["string", "string?"]` | Declared divergence: zod's optional slot accepts a present `undefined`, ArkType's `string?` only an absent one; the data has 1- and 2-element labels |
| S7 | no | N/A | A `.pipe(async fn)` morph returns an un-awaited Promise and a following `.to("string")` rejects it as an object; a sync lowercase or a `Promise.resolve()` wrapper would be a different workload |
| S8 | yes | `type(shape).onDeepUndeclaredKey("delete").array()` | ArkType's native deep deletion of undeclared keys, the counterpart of zod's nested strip; a morph, so every row is rebuilt. Declared divergence: an undeclared own symbol key is stripped by zod and kept by ArkType (its deletion sees string keys only). The gate also checks that no implementation mutates the input |
| S10, calibration parse | yes | `Type(data)` returning `ArkErrors` | The normal parse API with detailed errors on both sides (`ZodError` / `ArkErrors`); the refine scenario uses `.narrow()` with the same predicate |

## Correctness evidence

- Differential fuzzing (`packages/zod-cow-v4/tests/differential-z4.test.ts`): random nested object / array / tuple / record / map / set / union schemas with optional / nullable / default / refine / transform and async refine / transform wrappers, compared against stock zod4 on success parity, `deepStrictEqual` outputs (Map/Set compared as entry sets) and zero input mutation (structuredClone snapshot). The v0.5 run of 50 000 cases had 20 813 successes / 29 187 failures, a top-level reference-sharing rate of 89.1% on successful cases and 0 stock degradations. The code default is 200 × 100 = 20 000 cases.
- Smoke tests (`packages/zod-cow-v4/tests/smoke-z4*.test.ts`): behavior assertions for the original reference, strip, strict, default, transform, nested sharing, array elements, optional, union, the degradation chain, the three record paths, map / set and size checks, tuple truncation / fill / rest / refine, and async through all containers, `lazy(async)` and union async branches.
- Version canary (`packages/zod-cow-v4/tests/canary-z4.test.ts`): asserts the stock zod4 behaviors the compiler assumes (default short-circuits, catch does not swallow throws, optional hands undefined to a defaulted inner, …).
- The zod3 line has 27 unit tests plus its own 20 000-case differential fuzzer (`packages/zod-cow-v3/tests/differential.test.ts`), with a top-level reference-sharing rate of about 92%.
- Every one of the purity traps described in the architecture doc was found by the fuzzer, not by reading code. Purity analysis can only be proven complete by fuzzing, which is why any change to the purity rules or a container skeleton must be validated with the differential suite and its reference-sharing rate reported.

## Known limitations (prototype scope)

- Structural sharing is observable: parsing the same input twice returns the same reference, and modifying the output modifies the input. Only the zod3 line's `validate()` hints at this in the types, with `DeepReadonly`; the zod4 line's `validate()` returns `unknown` and its `parse` / `safeParse` use the ordinary zod output types. Use stock `schema.parse` when an independent copy is needed.
- Refines must not mutate the input (the CoW premise); deep-freeze inputs during development to catch violations.
- Refine side effects on failure: a failing parse runs the refine callback in the skeleton and again in the stock fallback, so it runs twice. The official `zod/compile` shim has the same semantics.
- Key order: pass-through preserves the input's key order; stock rebuilds in shape order (`deepStrictEqual` does not notice, snapshot tools might). A copy made by the zod4 object skeleton follows shape order, as stock does.
- Unsupported, with an explicit failure rather than silent drift:
  - zod4 line: `intersection`, `file` / `templateLiteral` / `promise`, `string_format` without a `pattern` (such as `url`), recursive top-level schemas and schema-level `catchall`. The official `ZodCompileUnsupportedError` makes the tree degrade to stock (`compiled.stock === true`), which is correct but not CoW.
  - zod3 line: `intersection`, `catchall`, tuple rest, `ZodPromise`, async refine. `ZcNotSupportedError` is thrown at compile time.
- NaN: `z.nan()` is always judged dirty (`NaN !== NaN`); the output is still correct, at the cost of one extra copy.
- Symbol keys / getters: a strict or loose object returned by reference keeps own enumerable symbol keys that stock's rebuild drops (strip mode probes for them and copies). The zod4 object skeleton reads a getter once on both paths, like stock; the array, record, map and set skeletons copy with `slice()` / `{ ...input }` / `new Map(input)` / `new Set(input)` on the dirty path, which reads an accessor property a second time (#36).
- A stock quirk that is deliberately not matched: with an async rest element and a `null` input in a nullable slot, stock zod4's runtime produces a sparse array and loses the `null`; the skeleton outputs a dense array. The differential generator avoids that combination; the reproduction is in the upstream issue draft.

## Repository layout

A pnpm workspace, one package per zod major plus one benchmark package per line ([ADR 0001](docs/adr/0001-package-layout.md)):

```
packages/zod-cow-v4/        published as zod-cow-v4 (the active line); peer zod >=4.5.4 <4.6.0, ESM + declarations in dist/
  README.md                 consumer document: install, usage, API, peer policy
  src/index.ts              compile() API
  src/cow4/                 engine: official codegen + CoW container skeletons + async channel
                            (index, product, codectx, predicates, purity, official, emit, emit-{object,array,tuple,record,map,set})
  src/probe-z4.ts           zod4 def structure and behavior survey (one-off diagnostics, not built)
  src/probe-z4-flags.ts     zod4 semantic canary flags (a version bump raises an alarm, not built)
  tests/harness.ts          zero-dependency test harness (test / summary / deepEqual), byte-identical to the zod3 copy
  tests/canary-z4.test.ts   zod version canary (stock zod4 behavior vs compiler assumptions)
  tests/smoke-z4*.test.ts   zod4 behavior assertions (containers / tuple / async)
  tests/differential-z4.test.ts   zod4 differential fuzzer (20 000 cases, REPRO hook)
  scripts/pack-smoke.ts     packed-tarball smoke (listing, manifest, import, require, consumer typecheck)
packages/zod-cow-v3/        private zod-cow-v3 (frozen reference); exports the TypeScript source, no build
  src/index.ts              compile() API
  src/compile.ts            closure-tree compiler
  src/internal.ts           protocol: FAILED sentinel / Ctx / issue helpers / safeSet
  src/regexes.ts            verbatim copy of zod 3.24.1's internal format regexes
  src/probe.ts              stock zod3 behavior probes
  tests/harness.ts          the other copy of the harness (+ harness.test.ts, its self-test)
  tests/unit.test.ts        zod3 unit tests (27)
  tests/differential.test.ts   zod3 differential fuzzer (20 000 cases)
packages/bench-v4/          bench.ts (S1 pure / S2 dirty / S3 dirty sweep / S4 validate / S5 containers / S6 tuple / S7 async, with ArkType as a column), harness.ts (measurement), gates.ts (equivalence gates) and demo.ts, against the built zod-cow-v4
packages/bench-v3/          bench.ts (500 000 accounts) and the zod3 demo.ts
docs/ARCHITECTURE-z4.md     architecture deep dive on the zod4 engine (English source; docs/ARCHITECTURE-z4.zh-CN.md is a frozen Chinese snapshot)
docs/upstream-issue-draft.md   draft issue for zod upstream: make compileFn / assertOnly / INVALID public
docs/adr/0001-package-layout.md   ADR: one package per zod major in a pnpm workspace, `zod-cow-v4` published name, benchmarks split per line, peer-dependency policy, zod3 line unpublished
CHANGELOG.md                v0.1 to v0.5 history with the historical benchmark tables (covers the whole workspace)
```

## Further reading

- [packages/zod-cow-v4/README.md](packages/zod-cow-v4/README.md): the consumer document of the published package (install, usage, API, peer policy).
- [docs/ARCHITECTURE-z4.md](docs/ARCHITECTURE-z4.md): generated code side by side with the official products, the purity whitelist and its three traps, the record / map / set / tuple skeletons, the async channel, the degradation-chain state machine, the version anchor and its risks.
- [CHANGELOG.md](CHANGELOG.md): how the project moved from a self-written zod3 compiler (v0.1) through a self-written zod4 port (v0.2, removed) to the official-codegen reuse (v0.3 to v0.5), with the benchmark table of each step.
- [docs/upstream-issue-draft.md](docs/upstream-issue-draft.md): the case for a public `compileFn` API, plus the zod4 runtime quirk found while fuzzing.
- [AGENTS.md](AGENTS.md): working conventions for contributors and coding agents (commands, module map, version anchoring, PR rules).
