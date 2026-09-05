# cow-zod-prototype

[![CI](https://github.com/iceboundrock/zod-cow/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/iceboundrock/zod-cow/actions/workflows/ci.yml)

English | [简体中文](README.zh-CN.md)

A prototype Copy-on-Write (CoW) compilation layer for Zod schemas, grown out of the [Numeric fork](https://numeric.substack.com/p/how-we-doubled-zod-performance-to) idea.

`compile(schema)` returns a fast parser whose output is `===` the input reference whenever nothing was forced to change (no default, transform, strip, coerce, catch, preprocess or pipe fired). When something did change, only the path from that leaf to the root is copied; every sibling subtree keeps sharing the input.

The difference from the Numeric fork: Numeric made `parse` return the original object by deleting seven features (`default / transform / coerce / catch / pipe / preprocess / intersection`). This prototype keeps all of them. It uses reference comparison as the dirty signal and copies on demand, so a copy happens only at the point where a new value was produced at runtime.

- No fork of zod and no change to the Zod API: schemas are consumed as they are (the `.def` tree is read), type inference stays `z.infer`.
- Shape, keys and checks are resolved once at compile time into specialized validation code.
- The layer never mutates the input on its own: nothing is deleted or rewritten in place. The Numeric fork's strip deletes extra keys on the input object; that footgun is fixed here. The one in-place write that can reach the input is the `Object.freeze` of `readonly`, and both lines perform it exactly where stock does: on a pass-through leaf such as `any` / `unknown`, where stock returns the input itself (see [When a copy is forced](#when-a-copy-is-forced), #28 for the zod4 line and #27 for the zod3 line); over a container the frozen value is a copy.
- Failure paths of the zod4 line carry no issue data of their own: the compiled function returns a sentinel and the caller falls back to stock `safeParse` for the full `ZodError`. The zod3 line builds its own `ZcError` while it walks, through zod's own error maps, with stock's issue list (codes, paths, messages and params, verified by its differential fuzzer).

## Two compiler lines

| Line | Entry | Engine | Status |
|---|---|---|---|
| zod4 | `packages/zod-cow-v4/src/index.ts` → `packages/zod-cow-v4/src/cow4/` | Reuses zod4's official JIT codegen (`compileFn` / `assertOnly`) as the semantic backend and adds CoW container skeletons for object, array, tuple, record, map and set, plus async support | Primary line: the published package, where new features go |
| zod3 | `packages/zod-cow-v3/src/index.ts` → `packages/zod-cow-v3/src/compile.ts` + `codegen.ts` | Hand-written compiler: a closure tree for leaves and wrappers, with the object / array / tuple skeletons generated per schema (`new Function`, leaf checks inlined as predicates) and closure skeletons as the fallback where `new Function` is unavailable; string format regexes copied verbatim from zod 3.24.1 | Maintained: the origin of the CoW idea and a comparison baseline, kept passing and still optimized; not published |

The lines live in two workspace packages, each installing its own zod: `packages/zod-cow-v4` (published as [`zod-cow-v4`](packages/zod-cow-v4/README.md)) against zod 4.5.4, `packages/zod-cow-v3` (private) against zod 3.24.1; both import `zod` by its real specifier. The two lines share no code. An earlier self-written zod4 front-end (v0.2) was replaced by the current zod4 line and removed; its findings are recorded in the [CHANGELOG](CHANGELOG.md#020).

## Quick start

Requires Node.js >= 22.13.0 and pnpm 11.24.0.

```bash
pnpm install
pnpm run build       # build zod-cow-v4 (ESM + declarations into packages/zod-cow-v4/dist)
pnpm run test:v4     # zod4 line: version canary + smoke tests + 20 000-case differential fuzz against stock zod4
pnpm run test:v3     # zod3 line: 45 unit tests + 20 000-case differential fuzz against stock zod3 (ordered issue lists included), run with the generated and the closure skeletons
pnpm run smoke:pack  # pack zod-cow-v4 and exercise the tarball from a temporary consumer project
pnpm run bench:v4    # zod4 benchmark against the built package, 500 000 records (needs node --expose-gc, already in the script)
pnpm run bench:v3    # zod3 benchmark: S1 to S9, single-record calibration and scaling sweeps, ArkType as a column
pnpm run probe:v4    # survey stock zod4 def structure and behavior
pnpm run probe:v3    # probe stock zod3 edge semantics (zod3 line)
pnpm run demo        # 60-second demo of the CoW promises against the published zod-cow-v4 API
```

Environment knobs: `SEEDS` / `CASES` set the differential fuzz size (default 200 × 100). `REPRO=seed:case` re-runs one failing zod4 differential case and dumps the schema, input and generated code (`REPRO=112:80 pnpm --filter zod-cow-v4 exec tsx tests/differential-z4.test.ts`). `BENCH_N` sets the benchmark record count (an integer of at least 10). The dirty and invalid shares of S2, S3 and S9 mark every round(1 / share)-th row, so a share is exact only when `BENCH_N` is a multiple of that period (100 for the 1% row); each scenario prints the realized count.

> The benchmark tables in this README and in `docs/` come from the
> [Benchmarks workflow](https://github.com/iceboundrock/zod-cow/actions/workflows/bench.yml),
> [run 33948313612](https://github.com/iceboundrock/zod-cow/actions/runs/33948313612):
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

The zod3 line is not published. It lives in `packages/zod-cow-v3` and is exercised through its workspace export by its own tests and by `bench-v3`; its API differs from the zod4 line (`ZcError` instead of `ZodError`, a `DeepReadonly` view from `validate()`, a static `.pure` flag), see `packages/zod-cow-v3/src/index.ts` and `pnpm run demo:v3`.

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
| readonly | The zod4 line hands the subtree to the official parser (the purity analysis treats `Object.freeze` as a side effect), so it freezes exactly what stock zod 4 freezes. Over a container (`object` / `array` / `tuple` / `record` / `map` / `set`) that is a new container: the copy is frozen, the input stays unfrozen and unshared. Over a pass-through leaf (`any` / `unknown` / `custom`, or a wrapper of one) stock returns the input itself and freezes it in place, and so does this line (#28). The zod3 line does the same by analysis of the inner schema: a frozen copy where stock zod3 rebuilds (containers, `date` and their wrappers), the input frozen in place over a pass-through leaf (`any` / `unknown`). Where the answer depends on the branch taken (a union whose options disagree, a `catch` whose fallback hands back the input, a pipeline of such nodes) the deciding node reports it at run time; a transform, refinement or preprocess that returns the reference it was given follows its inner schema, and one returning another reference is frozen in place, as stock freezes what the callback handed it (#27) |
| object / array / tuple / record / map / set | Never while every child is unchanged: the input reference is returned |
| union / discriminatedUnion | Never while every option is a leaf (or an optional / nullable leaf) and the matching option returns its input. A union with a container option (object / array / tuple / record / map / set, possibly under optional / nullable) is handed to the official parser as a whole, so a matching container is rebuilt the way stock rebuilds it and always copies; a union skeleton that keeps the CoW path is future work (#47) |
| default | Only when `undefined` is actually replaced |
| transform / preprocess / pipe / catch | Only when a new value is actually produced at runtime |
| strip (default object mode) | Only when the input really has extra keys (`for...in` with generated comparisons for small fixed shapes, a `Set` fallback for large shapes, plus an own-symbol probe that `compile(schema, { ownSymbolKeys: "ignore" })` switches off, #43) |
| strict / passthrough | Only when the input carries an undeclared own symbol key, which stock drops in every mode (strict fails on extra string keys); the same own-symbol probe as strip, switched off by the same option (#42) |
| record | Only when the input carries an undeclared own symbol key, which stock's rebuild drops on every path: an enum-keyed record (`z.record(z.enum(…), v)`, strict or loose) runs the same own-symbol probe as objects on its clean path; a record that iterates its keys (`z.record(z.string(), v)` and every other key schema) validates an enumerable symbol key like stock and marks a non-enumerable one dirty inside the key loop it already runs. Both switched off by the same option (#51) |
| `.trim()` / `.toLowerCase()` / `.toUpperCase()` | Only when the value actually changes (value comparison) |

Consequences that constrain every change:

- Never mutate the input. Strip must never `delete` on the input object. The only in-place write is the `Object.freeze` of `readonly`: both lines freeze a copy for containers and freeze a pass-through leaf in place exactly as stock does (#28 for the zod4 line, #27 for the zod3 line).
- Output may alias input, so refines must not mutate.
- Failure paths of the zod4 line return the sentinel; the caller falls back to stock `safeParse` for the full `ZodError`. The zod3 line keeps stock's two failure kinds itself: a type mismatch aborts (the sentinel), a failed check is dirty (the issue is recorded and the value goes on, so later checks, ancestor refinements and unions behave as in stock).

## How the zod4 line stays aligned with stock

The zod4 line does not re-implement zod's semantics. zod4 (>= 4.1) ships a JIT compiler (`src/v4/core/compile.ts`) whose products are reused per subtree:

1. Official products as leaves and subtrees. `compileFn(schema)` gives a stock-semantics parser; `compileFn(schema, {assertOnly: true})` gives a validator that skips output construction.
2. Purity analysis is a conservative whitelist deciding "validation passes ⇒ output === input". Pure subtrees get the official validator, impure subtrees get the official parser plus a reference comparison.
3. Container skeletons are string-templated codegen that mirrors zod's own `generate*` functions line by line, then rewrites the unconditional `const out = {...}` into "compare references, copy on first dirt, `return input` when clean". Container-level checks (`min` / `max` / `refine`) run on the final output on both paths.
4. Async: async subtrees become async islands, every product call site emits `await`, and the skeleton becomes an async function. The sync API on an async product throws `$ZodAsyncError`, same as stock.
5. Degradation chain, per subtree, every step keeping stock's results: CoW skeleton → official validator (pure leaf) → official parser (impure subtree) → runtime island (`_zod.run` black box) → whole-tree stock `safeParse` (`compiled.stock === true`).

The layer depends on `zod/v4/core`, a public permalink subpath whose compiler exports (`compileFn`, `assertOnly`, `INVALID`, the artifact protocol) are unsupported, and on a few hand-copied predicates. It is anchored to zod 4.5.4, the lower bound of the package's peer range: `packages/zod-cow-v4/tests/canary-z4.test.ts` asserts the stock behaviors the compiler assumes, so an upgrade turns the tests red instead of drifting silently. [docs/upstream-issue-draft.md](docs/upstream-issue-draft.md) asks zod upstream to make that surface public.

The zod3 line aligns itself with probes instead (`packages/zod-cow-v3/src/probe.ts` measures stock zod3 edge semantics at runtime): absent optional keys are not materialized, present-undefined keys are kept, default values pass the inner validation, issues are collected across sibling fields, `readonly` freezes shallowly. Its issue messages come from zod's own error maps (`defaultErrorMap`, the `z.setErrorMap` override and the schema's create-param map), so `required_error` / `invalid_type_error` / custom messages read as in stock. Its object, array and tuple skeletons are generated per schema (`packages/zod-cow-v3/src/codegen.ts`): named property loads, one monomorphic call site per child, leaf checks inlined as predicates that hand the value to the leaf closure only when they fail, an undeclared-key probe that compares each enumerated key against the shape key expected at that position before consulting the key set, and no path bookkeeping on the success path of a subtree without refinements or transforms (the container splices its key into the issues a child left behind). The closure skeletons in `compile.ts` implement the same algorithm and are used where `new Function` is unavailable.

The full design, with generated code dumped side by side against the official products, is in [docs/ARCHITECTURE-z4.md](docs/ARCHITECTURE-z4.md).

## Benchmarks

zod4 line, [Benchmarks workflow run 33948313612](https://github.com/iceboundrock/zod-cow/actions/runs/33948313612): 50 000 accounts, GitHub-hosted `ubuntu-latest` runner, node v24, `--expose-gc`, the built `zod-cow-v4` package, warmup and timed rounds in complete rotations of the candidate order (at least 2 warmup and 3 timed rounds per candidate, rounded up to a multiple of the candidate count: 5 plus 5 with five candidates), medians (`pnpm run bench:v4` with `BENCH_N=50000`). "z.compile()" is the public compiled API of Zod 4.5: `z.compile(schema).safeParse` in the parse scenarios and `z.validate(compiled, data)` in the validation-only ones. "ArkType" is arktype 2.2.3 through its normal public API (direct `Type(data)` for parsing, `.allows()` for validation only) on a schema built to the same constraints as the zod schema; the bench checks that equivalence with valid and invalid fixtures before timing and prints `N/A` with the reason where ArkType has no native equivalent (see [Cross-library comparison](#cross-library-comparison)). The internal `compileFn` / `assertOnly` product, the engineering control behind the public API, is measured in a diagnostic table of the run and reads level with the public column (1.00x on S1, 1.01x on S2, 1.02x to 1.06x across S3, 1.04x on S8), so it is no longer a column here. Runner noise at this record count is larger than the S1 / S3 gaps: the previous run of the same suite on the same branch ([33945725973](https://github.com/iceboundrock/zod-cow/actions/runs/33945725973), before the reverted tuple-inlining experiment) read every column 5 to 20% lower and S3 at 1.13x to 1.18x against `z.compile()` where this run reads 0.88x to 0.97x.

Batch scenarios (one call parses the whole dataset):

| Scenario | stock zod4 | z.compile() | **zod-cow-v4** | ArkType |
|---|---|---|---|---|
| S1 clean-input parse (no undeclared keys) | 68 ms | 23 ms | **24 ms** | 23 ms |
| S1 allocation pressure / retained after GC | +18.0 MB / +11.6 MB | +11.0 MB / +10.8 MB | **+3.1 MB / 0.0 MB** | +5.4 MB / 0.0 MB |
| S2 10% default injection | 69 ms | 23 ms | **25 ms** | 805 ms |
| S2 allocation pressure / retained | +19.8 MB / +11.6 MB | +18.2 MB / +11.6 MB | **+4.1 MB / +1.0 MB** | +91.2 MB / +11.6 MB |
| S3 sweep, 0% / 25% / 50% / 100% dirty | 68 / 69 / 70 / 70 ms | 23 / 23 / 23 / 24 ms | **23 / 25 / 26 / 25 ms** | 806 / 806 / 799 / 781 ms |
| S3 retained after GC | +11.6 to +12.3 MB | +11.6 MB constant | **0.0 / 2.0 / 3.6 / 6.9 MB** | +11.6 MB constant |
| S4 validation only | N/A (no validation-only API) | 17 ms (`z.validate`) | **18 ms** (`validate()`) | 23 ms (`.allows()`) |
| S5 record / map / set | 81 ms | 41 ms | **30 ms** | N/A (`Map` / `Set` are instanceof-only; non-equivalent reference 10 ms) |
| S5 allocation pressure / retained | +54.0 MB / +21.7 MB | +49.6 MB / +21.7 MB | **+29.4 MB / 0.0 MB** | N/A |
| S6 tuple | 43 ms | 14 ms | **5 ms** | 2 ms |
| S6 allocation pressure / retained | +55.0 MB / +20.6 MB | +20.2 MB / +20.2 MB | **+1.5 MB / 0.0 MB** | +0.0 MB / 0.0 MB |
| S7 async transform (5 000 rows) | 12 ms (safeParseAsync) | N/A (`z.compile()` hands an async schema back uncompiled) | **7 ms (safeParseAsync)** | N/A (no native async morph) |
| S7 allocation pressure | +12.8 MB | N/A | **+9.0 MB** | N/A |
| S8 strip-unknown parse parity | 79 ms | 29 ms | **24 ms** | 1 092 ms (`onDeepUndeclaredKey("delete")`) |
| S8 allocation pressure / retained | +28.2 MB / +11.6 MB | +11.2 MB / +10.8 MB | **+8.0 MB / +8.0 MB** | +157.5 MB / +66.6 MB |
| S10 parse failures, per-row `safeParse`, 1% / 10% / 50% / 100% invalid rows | 69 / 88 / 151 / 224 ms | 18 / 40 / 128 / 227 ms | **25 / 47 / 132 / 231 ms** | 30 / 91 / 287 / 426 ms |

Single-record hot loops (one small input, 50 000 operations per timed round, median nanoseconds per operation; this calibrates against the shape of public single-object benchmarks and is not a product workload):

| Scenario | stock zod4 | z.compile() | **zod-cow-v4** | ArkType |
|---|---|---|---|---|
| calibration parse (6-field primitive object) | 608 ns | 30 ns | **99 ns** | 65 ns |
| calibration validate (same record) | N/A | 12 ns (`z.validate`) | **11 ns** (`validate()`) | 19 ns (`.allows()`) |
| S9 validation-only failure: first field / last field / nested / email / tuple slot | N/A | 1 611 / 1 772 / 1 881 / 2 538 / 1 192 ns | **19 / 222 / 229 / 151 / 46 ns** | 267 / 18 / 34 / 218 / 50 ns |
| S10 parse failure with errors: first key / last key / nested / refine | 3 780 / 3 646 / 3 993 / 3 609 ns | 3 716 / 3 815 / 4 066 / 3 847 ns | **3 643 / 3 743 / 3 682 / 4 043 ns** | 7 053 / 12 225 / 7 469 / 6 206 ns |

Ratios against zod-cow-v4 (a value above 1 means the other implementation took longer, so zod-cow was faster; not computed for N/A cells):

| Scenario | stock / zod-cow | z.compile() / zod-cow | ArkType / zod-cow |
|---|---|---|---|
| S1 clean-input parse | 2.80x | 0.95x | 0.97x |
| S2 10% default | 2.72x | 0.90x | 31.90x |
| S3 0% / 25% / 50% / 100% dirty | 2.88x / 2.78x / 2.64x / 2.80x | 0.97x / 0.94x / 0.88x / 0.97x | 34.42x / 32.34x / 30.27x / 31.26x |
| S4 validation only | n/a | 0.93x | 1.25x |
| S5 record / map / set | 2.75x | 1.39x | n/a |
| S6 tuple | 8.04x | 2.62x | 0.40x |
| S7 async transform | 1.55x | n/a | n/a |
| S8 strip-unknown parse parity | 3.35x | 1.22x | 46.28x |
| S10 parse failures, 1% / 10% / 50% / 100% invalid | 2.79x / 1.89x / 1.15x / 0.97x | 0.73x / 0.86x / 0.98x / 0.98x | 1.20x / 1.94x / 2.18x / 1.85x |
| calibration parse / validate | 6.11x / n/a | 0.31x / 1.13x | 0.65x / 1.75x |

How to read it:

- Against stock: 2.6x to 8.0x on the sync batch scenarios (S1 2.80x, S2 2.72x, S3 2.64x to 2.88x, S5 2.75x, S6 8.04x, S8 3.35x), and the 12 to 22 MB retained after GC drops to zero on clean input. Async (S7) is 1.55x at 5 000 rows, where a few milliseconds of runner noise weigh heavily.
- Against the public compiled API: level on object input within runner noise at every dirty share (S1 0.95x, S2 0.90x, S3 0.88x to 0.97x: 0 to 3 ms at 50 000 rows, and 1.13x to 1.18x for S3 in run 33945725973). The copy path assembles the output from the captured locals exactly as the compiled parser does, so a dirty row costs the same literal while the clean rows around it cost nothing; before that change (run 33940596453) S3 read 0.70x at 100% dirty. Ahead on strip input (S8 1.22x: the copy drops undeclared keys by construction and shares the untouched `tags` arrays) and on the container scenarios (S5 1.39x, S6 2.62x), where the whole-tree rebuild of stock semantics is a fixed cost and CoW pays only for the paths that changed. Behind on per-row parses of small objects (calibration parse 0.31x, S10 1% invalid 0.73x): the per-object cost of the skeleton is the strip-mode probes, see below.
- Against ArkType: level on the clean parse (S1 0.97x), ahead on validation-only (S4 1.25x, calibration validate 1.75x), behind on tuples (S6 0.40x, 2 ms against 5 ms: ArkType's precompiled check returns the input and allocates nothing, while the skeleton pays the strip probes per row) and on the single-record parse (0.65x). The S2/S3/S8 gap (30x to 46x in zod-cow's favor) is architectural: any morph, a key default or an undeclared-key deletion included, moves ArkType 2.2.3 off its precompiled `allows` path onto an interpreted traversal that deep-clones the whole input before applying the queued morphs (+90 MB allocated at 50 000 rows in S3, +158 MB in S8, every row rebuilt), whereas zod-cow compiles the default like every other leaf and copies only the rows that changed. S1 is a fair comparison of the clean fixture only: zod's default object mode strips undeclared keys and ArkType's keeps them by reference, so S8 is the scenario where both do the same work.
- Failure paths: `validate()` answers `null` from the compiled validator alone (19 to 229 ns), while the public `z.validate` falls back to the runtime parser on failure (1.2 to 2.5 µs) and ArkType's `.allows()` checks keys in its own cost order (18 ns when the cheap `active` key fails, 267 ns when `id` does). With detailed errors (S10) every zod path costs the same 3.6 to 4.1 µs per invalid record: the fast path of both compiled variants is a small fraction of the runtime parse that builds the `ZodError`, so their double work is not visible; a failing refine predicate runs twice for `z.compile()`, zod-cow and ArkType (once per successful parse everywhere). On mixed datasets zod-cow follows the invalid share from 2.79x (1%) to 0.97x (100%) against stock.
- validate fast path: `validate()` is the official whole-tree `assertOnly` product of the same array schema, so S4 reads level with `z.validate` by construction (18 ms against 17 ms, 0.93x). Its value is the validation-only cost: 18 ms / 50 000 = 360 ns per account, with nothing retained after GC.
- The +3.1 MB in S1 is short-lived allocation from the strip-mode probe: exactly one empty own-symbol array (32 bytes) per object, 100 000 objects here, read to prove that the object can be returned by reference. That probe (`Object.getOwnPropertySymbols`) is also the skeleton's per-object cost: about 36 ns of a 65 ns skeleton call on a 6-field record measured locally on Node 24, next to about 9 ns for the `for...in` probe and nothing measurable for the leaf validator calls, against 24 ns for the compiled parser of the same schema. It stays on by default because stock drops own symbol keys and a pass-through has to prove there are none. `compile(schema, { ownSymbolKeys: "ignore" })` switches it off for callers whose data carries no symbol keys (#43, documented in the [package README](packages/zod-cow-v4/README.md#compileoptions)); the bench measures that as a separate, labelled opt-in row of the calibration section while the zod-cow-v4 column of every scenario keeps the default. Measured locally on Node 24 at 2 000 000 operations per round, the calibration parse reads 75 ns with the probe and 32 ns without it, against 24 to 29 ns for `z.compile()`.

The zod3 line has its own suite, `bench-v3` (`pnpm run bench:v3`), with the same methodology and ArkType built to zod3's constraints. From [Benchmarks workflow run 33992895288](https://github.com/iceboundrock/zod-cow/actions/runs/33992895288) (same runner class, node 24, `BENCH_N=50 000`, the generated skeletons of the zod3 line):

| Scenario | stock Zod 3 | zod-cow-v3 | ArkType | stock / zod-cow | ArkType / zod-cow |
|---|---:|---:|---:|---:|---:|
| S1 clean-input parse | 254 ms (+75.5 MB / +17.7 MB) | **24 ms (0 / 0)** | 23 ms | 10.75x | 0.99x |
| S2 10% default | 268 ms | **27 ms** | 819 ms (morph) | 10.12x | 30.89x |
| S3 0% / 25% / 50% / 100% dirty | 259 / 272 / 271 / 270 ms | **25 / 29 / 33 / 40 ms** | 828 / 833 / 852 / 819 ms | 10.44x to 6.78x | 33.40x to 20.55x |
| S4 validate (same runtime as parse) | N/A | **27 ms** | 25 ms (`allows`) | n/a | 0.93x |
| S5 record / map / set, clean / 10% dirty | 200 / 230 ms | **12 / 15 ms** | N/A (instanceof-only) | 16.23x / 15.33x | n/a |
| S6 tuple, clean / 50% dirty | 129 / 142 ms | **3 / 7 ms** | 2 ms / N/A | 39.39x / 21.05x | 0.69x |
| S7 sync transform, every row / no-op | 228 / 223 ms | **17 / 10 ms** | 398 / 391 ms | 13.60x / 22.06x | 23.77x / 38.61x |
| S8 strip-unknown parity | 278 ms | **37 ms (+23.7 MB / +9.5 MB)** | 1 113 ms | 7.52x | 30.14x |
| S9 per-row parse, 1% / 10% / 50% / 100% invalid | 265 / 273 / 299 / 340 ms | **33 / 37 / 58 / 79 ms** | 36 / 104 / 301 / 474 ms | 8.02x to 4.29x | 1.08x to 5.99x |
| calibration parse, 6-field record | 2 123 ns | **107 ns** | 80 ns | 19.8x | 0.75x |
| S9 failure hot loops (first / last / nested / 3 siblings / array / tuple) | 6.5 / 6.5 / 6.3 / 8.1 / 6.4 / 4.0 µs | **1.4 / 1.3 / 1.3 / 2.6 / 1.4 / 0.9 µs** | 7.3 / 12.4 / 7.5 / 20.3 / 7.9 / 6.3 µs | 3.1x to 4.9x | 5.2x to 9.4x |

How to read it: the zod3 line is level with ArkType on the clean parse (S1 0.99x, within runner noise at these sizes; S4 puts the same parse runtime next to ArkType's validation-only `allows` and reads 0.93x, a different amount of work per row) and on the leaf and tuple sweeps, behind it on deep nesting and long arrays (the scaling sweeps in the run: nesting depth 5 195 ns against 79 ns, 100-element array 643 ns against 170 ns, a monomorphic call per nested skeleton and per element), and far ahead wherever ArkType's morphs rebuild (S2, S3, S7, S8). Failure paths carry stock's issue lists (the run's parity section: 16 of 16 fixtures identical in order and in every property; an undeclared difference aborts the run) at a fifth of stock's cost. Before this round the zod3 line measured 3.2x to 3.7x against stock on S1 (572 ms against 2 101 ms at 500 000 rows locally) and was behind stock on the failure hot loops; the before / after table at 500 000 rows is in the [CHANGELOG](CHANGELOG.md#unreleased). The superseded tables from runs 33940596453 and 33837195401 and the earlier local 500 000-record tables, including the v0.5 zod4 table and those of the removed v0.2 front-end and of v0.3, are in the [CHANGELOG](CHANGELOG.md).

### Cross-library comparison

The ArkType column is measured only where arktype 2.2.3 expresses the same workload through its normal public API. `packages/bench-v4/schemas.ts` builds the ArkType schema next to the zod schema, and `gates.ts` runs valid and deliberately invalid fixtures (non-integer and unsafe-integer `id`, overlong name in ASCII and in astral characters next to a 64-astral-character name every implementation accepts, non-finite numbers, malformed email and datetime, invalid role, oversized tags, missing role, invalid nested and container values, tuple length and type errors, undeclared keys at every level) through every implementation before anything is timed; an undeclared disagreement aborts the run, a declared one prints as `known divergence`.

| Scenario | ArkType equivalent | ArkType API | Notes |
|---|---|---|---|
| S1 | yes | `Type(data)` | `number.integer & number.safe` for `.int()`, `string[] <= 8`, the literal union. zod's `.max(64)` counts Unicode code points and ArkType's `string <= 64` counts UTF-16 units (64 astral characters pass zod and fail the keyword), so the bound goes in as zod's own rule: the native `string <= 64` as the first union branch and a predicate counting code points on the overflow branch only. `z.number()` rejects both infinities and ArkType's `number` accepts them, so numbers carry a finite range through ArkType's range API (native range nodes). The zod email and datetime patterns go in as ArkType regex constraints because `string.email` and `string.date.iso` accept supersets (`.a@x.com`, date-only dates, offsets). The gate holds a boundary fixture for each of these (64 and 65 astral characters, ±Infinity, NaN). Extra keys pass through by reference in ArkType and are stripped into a copy by zod (declared on the extra-key fixture); the S1 data has none, S8 measures the strip case |
| S2, S3 | yes | `Type(data)` with `role: "'admin' \| 'member' \| 'viewer' = 'viewer'"` | Same absent-key input, same outputs. Declared divergence: zod also defaults a present `undefined`, ArkType rejects it |
| S4, calibration validate, S9 | yes | `Type.allows(data)` | Validation only, next to `z.validate(compiled, data)` and `validate()`. ArkType checks keys in its own cost order, zod in declaration order, which the S9 per-position results show |
| S5 | no | N/A | `Map` / `Set` are instanceof checks and there is no `Map<K, V>` / `Set<T>` generic, so entries and members are never validated. The closest schema runs as a labeled non-equivalent reference (10 ms) and stays out of the ratios |
| S6, S9 tuple | yes | `Type(data)` with a pair of finite numbers (the same finite range as S1) and `["string", "string?"]` | Declared divergence: zod's optional slot accepts a present `undefined`, ArkType's `string?` only an absent one; the data has 1- and 2-element labels |
| S7 | no | N/A | A `.pipe(async fn)` morph returns an un-awaited Promise and a following `.to("string")` rejects it as an object; a sync lowercase or a `Promise.resolve()` wrapper would be a different workload |
| S8 | yes | `type(shape).onDeepUndeclaredKey("delete").array()` | ArkType's native deep deletion of undeclared keys, the counterpart of zod's nested strip; a morph, so every row is rebuilt. Declared divergence: an undeclared own symbol key is stripped by zod and kept by ArkType (its deletion sees string keys only). The gate also checks that no implementation mutates the input |
| S10, calibration parse | yes | `Type(data)` returning `ArkErrors` | The normal parse API with detailed errors on both sides (`ZodError` / `ArkErrors`); the refine scenario uses `.narrow()` with the same predicate |

## Correctness evidence

- Differential fuzzing (`packages/zod-cow-v4/tests/differential-z4.test.ts`): random nested object / array / tuple / record / map / set / union schemas (plain unions of 2 to 3 random options, so object branches with undeclared keys occur, and discriminated unions of two object branches; the generator emits unions since #47, before which no union was generated despite this list) with optional / nullable / default / refine / transform and async refine / transform wrappers, compared against stock zod4 on success parity, `deepStrictEqual` outputs (Map/Set compared as entry sets) and zero input mutation (structuredClone snapshot). The v0.5 run of 50 000 cases had 20 813 successes / 29 187 failures, a top-level reference-sharing rate of 89.1% on successful cases and 0 stock degradations. The code default is 200 × 100 = 20 000 cases. Every case runs twice: with the default options, then compiled with `ownSymbolKeys: "ignore"` against the same inputs minus the extra own symbol the option is documented to treat differently (the generator emits it in every object mode since #42), checking in addition that no generated top-level skeleton carries the probe and that the second pass shares at least as many references as the first (85.6% and 86.2% among successful cases at the default size since the union generator and the union rule of #47; 88.8% and 89.4% before them, #43).
- Smoke tests (`packages/zod-cow-v4/tests/smoke-z4*.test.ts`): behavior assertions for the original reference, strip, strict, default, transform, nested sharing, array elements, optional, union, the degradation chain, the `ownSymbolKeys` option (both settings in strip, strict and loose mode and in the three record paths, nested propagation, the pinned divergence, the `TypeError`), the three record paths, map / set and size checks, tuple truncation / fill / rest / refine, and async through all containers, `lazy(async)` and union async branches.
- Version canary (`packages/zod-cow-v4/tests/canary-z4.test.ts`): asserts the stock zod4 behaviors the compiler assumes (default short-circuits, catch does not swallow throws, optional hands undefined to a defaulted inner, …).
- The zod3 line has 45 unit tests plus its own 20 000-case differential fuzzer (`packages/zod-cow-v3/tests/differential.test.ts`): random object / array / tuple / record / map / set / union / discriminated-union schemas, an `unknown` pass-through leaf that accepts containers, union options that are leaves, containers or wrapped schemas (so a union under `readonly` and `readonly` / `catch` / `transform` over a union option occur), optional / nullable / default / catch / readonly / refine / transform wrappers, create-param error maps and the string `length` / `includes` / `startsWith` checks, compared against stock zod3 on success parity, `deepStrictEqual` outputs, zero input mutation (structuredClone snapshot), frozenness of input and output, and on every failing case the ordered issue list (every issue in stock's order with every property it carries: code, path, message, `fatal`, the check params, a union's nested errors). It runs twice, with the generated skeletons and with the closure fallback (`--no-codegen`). Top-level reference sharing among successful cases is about 87% with this generator (92.1% with the earlier, smaller generator, unchanged from before this work).
- Every one of the purity traps described in the architecture doc was found by the fuzzer, not by reading code. Purity analysis can only be proven complete by fuzzing, which is why any change to the purity rules or a container skeleton must be validated with the differential suite and its reference-sharing rate reported.

## Known limitations (prototype scope)

- Structural sharing is observable: parsing the same input twice returns the same reference, and modifying the output modifies the input. Only the zod3 line's `validate()` hints at this in the types, with `DeepReadonly`; the zod4 line's `validate()` returns `unknown` and its `parse` / `safeParse` use the ordinary zod output types. Use stock `schema.parse` when an independent copy is needed.
- Refines must not mutate the input (the CoW premise); deep-freeze inputs during development to catch violations.
- Callbacks see the CoW output, not a fresh container: a `refine` / `superRefine` / `transform` above a container receives the input reference when nothing below it changed, where stock's callback receives the container stock just rebuilt. A container that is dirty only through its own length or size check (`array.max`, `set.size`) is included: the value goes on by reference with the issue recorded. Observable only through reference identity inside the callback.
- Refine side effects on failure: a failing parse runs the refine callback in the skeleton and again in the stock fallback, so it runs twice. The official `zod/compile` shim has the same semantics.
- Key order: pass-through preserves the input's key order; stock rebuilds in shape order (`deepStrictEqual` does not notice, snapshot tools might). A copy made by the zod4 object skeleton follows shape order, as stock does.
- Unsupported, with an explicit failure rather than silent drift:
  - zod4 line: `intersection`, `file` / `templateLiteral` / `promise`, `string_format` without a `pattern` (such as `url`), recursive top-level schemas and schema-level `catchall`. The official `ZodCompileUnsupportedError` makes the tree degrade to stock (`compiled.stock === true`), which is correct but not CoW.
  - zod3 line: `intersection`, `catchall`, tuple rest, `ZodPromise`. `ZcNotSupportedError` is thrown at compile time; an async refine, transform or preprocess (a callback returning a `Promise`) throws it at parse time. An ordinary thenable is a sync result, as in stock, whose detector is `instanceof Promise`; stock's sync parser hands a preprocess `Promise` on to the inner schema as data, which this line refuses instead.
- Unions with a container option always copy: a union whose options are all leaves keeps the input by reference, but one with an object / array / tuple / record / map / set option (also under optional / nullable) goes to the official parser as a whole, because an option gets no skeleton of its own and the official validator would keep the undeclared keys that stock strips (#47). Stock's parser rebuilds the matching container, so the union's value, and with it the path to the root, is copied on every parse. A union skeleton that tries each option's CoW product in order would restore the sharing and is future work.
- NaN: `z.nan()` is always judged dirty (`NaN !== NaN`); the output is still correct, at the cost of one extra copy.
- Symbol keys / getters: stock's rebuild drops undeclared own symbol keys (enumerable or not) on every path, in every object mode and in records. By default the skeletons prove there are none before returning the input by reference and copy otherwise: the object skeleton probes in every mode (strip since #33, strict and loose since #42), an enum-keyed record probes the same way, and a record that iterates its keys validates an enumerable symbol key like stock and marks a non-enumerable one dirty inside its key loop (#51). Under `compile(schema, { ownSymbolKeys: "ignore" })` the probes are skipped: a clean input keeps its own symbol keys by reference, while a copy made by the skeleton still drops them like stock, so the outcome then depends on whether the container was dirty (#43). The zod4 object skeleton and the enum-keyed record skeleton read a getter once on both paths, like stock; the array, iterating record, map and set skeletons copy with `slice()` / `{ ...input }` / `new Map(input)` / `new Set(input)` on the dirty path, which reads an accessor property a second time (#36).
- The clean path returns the input as it is, so what stock's rebuild normalizes away survives when nothing forced a copy: a non-enumerable undeclared string key (the `for...in` probe and the record key loop skip it), the property descriptor of a declared key (a declared key the input defines as non-enumerable, string or symbol, on an object or an enum-keyed record comes back as defined, where stock's rebuild writes an enumerable data property; the own-symbol probe asks only whether an undeclared symbol exists, and the copy path writes the key like stock), the input's prototype (a class instance comes back as that instance where stock returns a plain object; a strip object sees an inherited enumerable key in its `for...in` probe and copies like stock, a loose object does not enumerate on its clean path and keeps such a key inherited where stock's `for...in` append writes it as an own key; records reject a class instance on both sides) and Proxy traps (a `for...in` consults `ownKeys`, `getOwnPropertyDescriptor` and, walking the prototype chain, `getPrototypeOf`; a strip object consults all three through its `for...in` probe where stock's strip template enumerates nothing; a loose object consults `ownKeys` alone, through the own-symbol probe, and nothing under `ownSymbolKeys: "ignore"`, where stock's `for...in` append consults all three; so a throwing trap is observed differently in both directions). No explicit probe is added for them: proving their absence on every clean container is the cost `ownSymbolKeys: "ignore"` exists to remove, and stock `parse` is there for inputs that need the normalization (#48).
- A stock quirk that is deliberately not matched: with an async rest element and a `null` input in a nullable slot, stock zod4's runtime produces a sparse array and loses the `null`; the skeleton outputs a dense array. The differential generator avoids that combination; the reproduction is in the upstream issue draft.

## Repository layout

A pnpm workspace, one package per zod major plus one benchmark package per line ([ADR 0001](docs/adr/0001-package-layout.md)):

```
packages/zod-cow-v4/        published as zod-cow-v4 (the primary line); peer zod >=4.5.4 <4.6.0, ESM + declarations in dist/
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
packages/zod-cow-v3/        private zod-cow-v3; exports the TypeScript source, no build
  src/index.ts              compile() API
  src/compile.ts            compiler: closure tree for leaves and wrappers, closure skeletons as the codegen fallback, purity analysis
  src/codegen.ts            generated object / array / tuple skeletons (new Function, inline leaf predicates)
  src/internal.ts           protocol: FAILED sentinel / Ctx / issue construction through zod's error maps / safeSet
  src/regexes.ts            verbatim copy of zod 3.24.1's internal format regexes
  src/probe.ts              stock zod3 behavior probes
  tests/harness.ts          the other copy of the harness (+ harness.test.ts, its self-test)
  tests/unit.test.ts        zod3 unit tests (38)
  tests/differential.test.ts   zod3 differential fuzzer (20 000 cases, issue lists compared, --no-codegen for the closure fallback)
packages/bench-v4/          bench.ts (S1 pure / S2 dirty / S3 dirty sweep / S4 validate / S5 containers / S6 tuple / S7 async, with ArkType as a column), harness.ts (measurement), gates.ts (equivalence gates) and demo.ts, against the built zod-cow-v4
packages/bench-v3/          bench.ts (S1 clean / S2 default / S3 dirty sweep / S4 validate / S5 containers / S6 tuple / S7 transforms / S8 strip, ArkType as a column), calibration.ts (single-record hot loops, scaling sweeps), failures.ts (S9, issue parity first), schemas.ts, harness.ts, gates.ts and the zod3 demo.ts
docs/ARCHITECTURE-z4.md     architecture deep dive on the zod4 engine (English source of truth; docs/ARCHITECTURE-z4.zh-CN.md is its Chinese counterpart)
docs/upstream-issue-draft.md   draft issue for zod upstream: make compileFn / assertOnly / INVALID public
docs/adr/0001-package-layout.md   ADR: one package per zod major in a pnpm workspace, `zod-cow-v4` published name, benchmarks split per line, peer-dependency policy, zod3 line unpublished
CHANGELOG.md                v0.1 to v0.5 history with the historical benchmark tables (covers the whole workspace)
```

## Further reading

- [packages/zod-cow-v4/README.md](packages/zod-cow-v4/README.md): the consumer document of the published package (install, usage, API, peer policy).
- [docs/ARCHITECTURE-z4.md](docs/ARCHITECTURE-z4.md): generated code side by side with the official products, the purity whitelist and its four traps, the record / map / set / tuple skeletons, the async channel, the degradation-chain state machine, the version anchor and its risks.
- [CHANGELOG.md](CHANGELOG.md): how the project moved from a self-written zod3 compiler (v0.1) through a self-written zod4 port (v0.2, removed) to the official-codegen reuse (v0.3 to v0.5), with the benchmark table of each step.
- [docs/upstream-issue-draft.md](docs/upstream-issue-draft.md): the case for a public `compileFn` API, plus the zod4 runtime quirk found while fuzzing.
- [AGENTS.md](AGENTS.md): working conventions for contributors and coding agents (commands, module map, version anchoring, PR rules).
