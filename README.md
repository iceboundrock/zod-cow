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
> [run 33940596453](https://github.com/iceboundrock/zod-cow/actions/runs/33940596453):
> a GitHub-hosted `ubuntu-latest` runner, node v24, `BENCH_N=50 000`, the built
> `zod-cow-v4` package, warmup and timed rounds in complete rotations of the candidate order
> (at least 2 warmup and 3 timed rounds per candidate, rounded up to a multiple of the
> candidate count, so 4 plus 4 with four candidates), medians.
> The workflow builds `zod-cow-v4`, runs `bench-v4` and `bench-v3` manually or weekly and prints
> the tables in the job summary. Runner noise is a few milliseconds at this
> record count, so ratios close to 1.0x (S1 against the official parser and against
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

zod4 line, [Benchmarks workflow run 33940596453](https://github.com/iceboundrock/zod-cow/actions/runs/33940596453): 50 000 accounts, GitHub-hosted `ubuntu-latest` runner, node v24, `--expose-gc`, the built `zod-cow-v4` package, warmup and timed rounds in complete rotations of the candidate order (at least 2 warmup and 3 timed rounds per candidate, rounded up to a multiple of the candidate count: 4 plus 4 with four candidates), medians (`pnpm run bench:v4` with `BENCH_N=50000`). "official JIT" is zod4's own `compileFn` parser product; in S4 it is the `assertOnly` validator of the same array schema, since the parser has no validation-only mode. "ArkType" is arktype 2.2.3 through its normal public API (direct `Type(data)` for parsing, `.allows()` in S4) on a schema built to the same constraints as the zod schema; the bench checks that equivalence with valid and invalid fixtures before timing and prints `N/A` with the reason where ArkType has no native equivalent (see [Cross-library comparison](#cross-library-comparison)).

| Scenario | stock zod4 | official JIT | **zod-cow-v4** | ArkType |
|---|---|---|---|---|
| S1 pure validation parse | 55 ms | 20 ms | **22 ms** | 22 ms |
| S1 allocation pressure / retained after GC | +20.9 MB / +12.3 MB | +11.0 MB / +10.8 MB | **+3.1 MB / 0.0 MB** | +5.4 MB / 0.0 MB |
| S2 10% default injection | 57 ms | 24 ms | **26 ms** | 729 ms |
| S2 allocation pressure / retained | +19.9 MB / +11.7 MB | +18.2 MB / +11.6 MB | **+4.4 MB / +1.0 MB** | +91.3 MB / +11.6 MB |
| S3 sweep, 0% / 25% / 50% / 100% dirty | 55 / 58 / 57 / 55 ms | 24 / 24 / 29 / 25 ms | **24 / 28 / 31 / 36 ms** | 723 / 715 / 724 / 704 ms |
| S3 retained after GC | +11.6 to +12.3 MB | +11.6 MB constant | **0.0 / 1.8 / 3.2 / 6.1 MB** | +11.6 MB constant |
| S4 validation only | N/A (no validation-only API) | 18 ms (`assertOnly` validator) | **18 ms** (`validate()`) | 23 ms (`.allows()`) |
| S5 record / map / set | 74 ms | 44 ms | **25 ms** | N/A (`Map` / `Set` are instanceof-only) |
| S5 allocation pressure / retained | +53.7 MB / +21.7 MB | +61.3 MB / +21.7 MB | **+29.4 MB / 0.0 MB** | N/A |
| S6 tuple | 33 ms | 14 ms | **4 ms** | 2 ms |
| S6 allocation pressure / retained | +54.5 MB / +20.6 MB | +20.2 MB / +20.2 MB | **+1.5 MB / 0.0 MB** | +0.0 MB / 0.0 MB |
| S7 async transform (5 000 rows) | 10 ms (safeParseAsync) | N/A (compileFn refuses async) | **6 ms (safeParseAsync)** | N/A (no native async morph) |
| S7 allocation pressure | +12.8 MB | N/A | **+9.5 MB** | N/A |

Ratios against zod-cow-v4 (a value above 1 means the other implementation took longer, so zod-cow was faster; not computed for N/A cells):

| Scenario | stock / zod-cow | official JIT / zod-cow | ArkType / zod-cow |
|---|---|---|---|
| S1 pure validation parse | 2.50x | 0.90x | 1.00x |
| S2 10% default | 2.15x | 0.91x | 27.51x |
| S3 0% / 25% / 50% / 100% dirty | 2.30x / 2.08x / 1.84x / 1.56x | 1.00x / 0.88x / 0.94x / 0.70x | 30.27x / 25.81x / 23.51x / 19.81x |
| S4 validation only | n/a | 0.99x | 1.26x |
| S5 record / map / set | 2.99x | 1.77x | n/a |
| S6 tuple | 7.90x | 3.34x | 0.43x |
| S7 async transform | 1.83x | n/a | n/a |

How to read it:

- Against stock: 2.2x to 7.9x on the sync scenarios (S1 2.50x, S2 2.15x, S5 2.99x, S6 7.90x), and the 12 to 22 MB retained after GC drops to zero on clean input. Async (S7) is 1.83x at 5 000 rows, where a few milliseconds of runner noise weigh heavily.
- Against the official JIT parser: level on object input within runner noise (S1 0.90x, S2 0.91x, S3 0% 1.00x: 0 to 2 ms behind at 50 000 rows, where earlier runs read S2 anywhere between 0.88x and 1.11x), further behind as the dirty share grows (S3 100% 0.70x: the skeleton then copies every row and still pays the reference comparisons), and ahead on the container scenarios (S5 1.77x, S6 3.34x), where the whole-tree rebuild of stock semantics is a fixed cost and CoW pays only for the paths that changed.
- Against ArkType: level on the pure parse (S1 1.00x), ahead on validation-only (S4 1.26x), behind on tuples (S6 0.43x, 2 ms against 4 ms: ArkType's precompiled check returns the input and allocates nothing, while the skeleton pays a strip probe and a sub-skeleton call per row). The S2/S3 gap (20x to 30x in zod-cow's favor) is architectural: any morph, a key default included, moves ArkType 2.2.3 off its precompiled `allows` path onto an interpreted traversal that deep-clones the whole input before applying the queued morphs (+90 MB allocated at 50 000 rows, every row rebuilt), whereas zod-cow compiles the default like every other leaf and copies only the rows that were missing the key. The earlier reference line (8 ms in run 33837195401) used a weaker ArkType schema (no integer bound on `id`, `createdAt` as a plain string, no bound on `tags`); with equivalent constraints ArkType's S1 cost is 22 ms (18 ms in run 33939238724, before the code-point length rule and the finite range were added; every column moved by a similar share between the two runs, stock 47 to 55 ms and zod-cow 19 to 22 ms, so the added constraints have no visible cost on ASCII data, whose names never leave the native `string <= 64` branch).
- validate fast path: `validate()` is the official whole-tree `assertOnly` product of the same array schema, so S4 reads level with that baseline by construction (18 ms against 18 ms, 0.99x). Its value is the validation-only cost: 18 ms / 50 000 = 360 ns per account, with nothing retained after GC.
- The +3.1 MB in S1 is short-lived allocation from the strip-mode probe: exactly one empty own-symbol array (32 bytes) per object, 100 000 objects here, read to prove that the object can be returned by reference. The official leaf products allocate nothing measurable and the CoW layer copies no containers.

The zod3 line measured 4.0x to 4.4x against stock zod 3.24.1 in the same run (S1 3.96x, S2 4.40x; stock zod3 still pays the interpreter tax). The superseded table from run 33837195401 and the earlier local 500 000-record tables, including the v0.5 zod4 table and those of the removed v0.2 front-end and of v0.3, are in the [CHANGELOG](CHANGELOG.md).

### Cross-library comparison

The ArkType column is measured only where arktype 2.2.3 expresses the same workload through its normal public API. `packages/bench-v4/bench.ts` builds the ArkType schema next to the zod schema, and `gates.ts` runs valid and deliberately invalid fixtures (non-integer and unsafe-integer `id`, overlong name in ASCII and in astral characters next to a 64-astral-character name every implementation accepts, non-finite numbers, malformed email and datetime, invalid role, oversized tags, missing role, invalid nested and container values, tuple length and type errors) through every implementation before anything is timed; an undeclared disagreement aborts the run, a declared one prints as `known divergence`.

| Scenario | ArkType equivalent | ArkType API | Notes |
|---|---|---|---|
| S1 | yes | `Type(data)` | `number.integer & number.safe` for `.int()`, `string[] <= 8`, the literal union. zod's `.max(64)` counts Unicode code points and ArkType's `string <= 64` counts UTF-16 units (64 astral characters pass zod and fail the keyword), so the bound goes in as zod's own rule: the native `string <= 64` as the first union branch and a predicate counting code points on the overflow branch only. `z.number()` rejects both infinities and ArkType's `number` accepts them, so numbers carry a finite range through ArkType's range API (native range nodes). The zod email and datetime patterns go in as ArkType regex constraints because `string.email` and `string.date.iso` accept supersets (`.a@x.com`, date-only dates, offsets). The gate holds a boundary fixture for each of these (64 and 65 astral characters, ±Infinity, NaN). Extra keys pass through by reference in ArkType and are stripped into a copy by zod; the data has none |
| S2, S3 | yes | `Type(data)` with `role: "'admin' \| 'member' \| 'viewer' = 'viewer'"` | Same absent-key input, same outputs. Declared divergence: zod also defaults a present `undefined`, ArkType rejects it |
| S4 | yes | `Type.allows(data)` | Validation only, next to the official `assertOnly` validator and `validate()` |
| S5 | no | N/A | `Map` / `Set` are instanceof checks and there is no `Map<K, V>` / `Set<T>` generic, so entries and members are never validated. The closest schema runs as a labeled non-equivalent reference (8 ms) and stays out of the ratios |
| S6 | yes | `Type(data)` with a pair of finite numbers (the same finite range as S1) and `["string", "string?"]` | Declared divergence: zod's optional slot accepts a present `undefined`, ArkType's `string?` only an absent one; the data has 1- and 2-element labels |
| S7 | no | N/A | A `.pipe(async fn)` morph returns an un-awaited Promise and a following `.to("string")` rejects it as an object; a sync lowercase or a `Promise.resolve()` wrapper would be a different workload |

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
