# Changelog

All notable changes to this prototype. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

The v0.1 to v0.5 history below was developed as a local worklog and imported into this repository in a single commit (c0453dd, 2026-09-03), so those versions carry no individual release dates. Benchmark tables attached to a version are the numbers measured at that time, on the environment stated next to each table; they are kept as a historical record and are superseded by the current table in the [README](README.md#benchmarks).

## [Unreleased]

### Changed

- The repository is a pnpm workspace with one package per zod major, as decided in ADR 0001 (#8, #9): `packages/zod-cow-v4` (published as `zod-cow-v4`, version 0.5.0, MIT, `engines.node >=22.13.0`, peer `zod >=4.5.4 <4.6.0`), `packages/zod-cow-v3` (private, `exports` pointing at its TypeScript source), `packages/bench-v4` and `packages/bench-v3` (private benchmark packages, `arktype` moved there from the root). Every package installs its own zod and imports it by its real specifier; the `zod4` npm alias is gone. Paths moved accordingly: `src/index-z4.ts` is `packages/zod-cow-v4/src/index.ts`, `src/cow4/`, the probes and the zod4 tests are under `packages/zod-cow-v4/`, the zod3 line and its tests under `packages/zod-cow-v3/`, `bench/bench-z4.ts` is `packages/bench-v4/bench.ts`, `bench/bench.ts` and `examples/demo.ts` are `packages/bench-v3/bench.ts` and `demo.ts`. The root scripts are `build`, `typecheck`, `test:v4` / `test:v3` / `test`, `bench:v4` / `bench:v3`, `probe:v4` / `probe:v3`, `demo` / `demo:v3`, `smoke:pack` and `check:harness`. `bench-v4` measures the built package from now on; the cited benchmark table predates the split and measured the source.
- The root README's install and usage sections are a link to `packages/zod-cow-v4/README.md`, which is now the only place carrying install, usage, API and peer-policy text (ADR 0001 §5); the maintained English docs name `zod/v4/core` as a public permalink subpath whose compiler exports are unsupported, instead of calling the subpath itself internal (#9).
- The zod4 v1 compiler line (the self-written zod4 front-end documented under v0.2) was removed; the version canary it carried lives on as `tests/canary-z4.test.ts`, the first step of `pnpm run test:z4` (#4, #17).
- The remaining zod4 line dropped its `v2` suffix: the engine is `src/cow4/`, the entry is `src/index-z4.ts`, the scripts are `test:z4` and `bench:z4` (#19).
- The zod4 engine was split from one file into cohesive modules under `src/cow4/` (product contract, code context, copied predicates, purity analysis, official-product wrappers, codegen core, one skeleton module per container). Section 11 of `docs/ARCHITECTURE-z4.md` maps modules to document sections (#5, #20).
- Package management moved to pnpm 11 with a Node.js >= 22.13.0 floor (#11).
- All code comments and test/bench output strings were translated to English (#6, #21, #22, #23, #24). The README, the architecture document and this changelog followed in #7; the Chinese README is `README.zh-CN.md` and the Chinese architecture text is kept as a frozen snapshot in `docs/ARCHITECTURE-z4.zh-CN.md`.
- The benchmark tables in both READMEs, `docs/ARCHITECTURE-z4.md` §7 and the upstream issue draft now quote [Benchmarks workflow run 33837195401](https://github.com/iceboundrock/zod-cow/actions/runs/33837195401) (GitHub-hosted `ubuntu-latest` runner, node 24, `BENCH_N=50 000`, median of 3 runs) instead of a local 500 000-record run. The superseded v0.5 table is kept below under 0.5.0.

### Added

- `zod-cow-v4` build: `tsc` emits ESM plus `.d.ts` declarations into `dist/`; `exports` lists `.` and `./package.json`, `files` restricts the tarball to `dist/` (npm adds `package.json`, the package README and a copy of `LICENSE`). A packed-tarball smoke (`packages/zod-cow-v4/scripts/pack-smoke.ts`, `pnpm run smoke:pack`) packs the package, checks the listing both ways and the shipped `engines.node` and `exports`, installs the tarball into a temporary project with the verified zod, parses through `import` and `require`, resolves the `./package.json` export and typechecks an ESM and a CommonJS consumer against the declarations (#9).
- A demo against the published API (`packages/bench-v4/demo.ts`, `pnpm run demo`): the zod3 demo kept its `.pure` and `DeepReadonly` view and moved to `bench-v3` (#9).
- GitHub Actions CI: typecheck (building `zod-cow-v4` first), both test lines and the packed-tarball smoke on a Node `22.13.0` (exact engines floor) / 22 / 24 / 26 matrix, and a separate Biome lint job that also compares the two `tests/harness.ts` copies byte for byte (`.github/workflows/ci.yml`; the split, the smoke, the floor lane and the harness check came with #9).
- A manual/weekly benchmark workflow (`.github/workflows/bench.yml`) that builds `zod-cow-v4` and runs `bench-v4` and `bench-v3` on a GitHub-hosted runner (node 24, `BENCH_N=50 000`) and writes the tables to the job summary. The published benchmark tables quote one run of it by run id (see Changed above); the other runs check that the bench scripts still work, and only a run at the same configuration (node 24, `BENCH_N=50 000`) can be compared against the cited run, which the job summary states per run.
- Biome for linting and formatting (`biome.json`).
- `docs/adr/0001-package-layout.md` records the package layout decision for the upcoming split (#8): a pnpm workspace with one package per zod major, `zod-cow-v4` published for the zod4 line (benchmarks in packages of their own, one per line) with a peer range on zod limited to verified minors (initially `>=4.5.4 <4.6.0`), the zod3 line kept private, ESM-only output. #9 implements it.
- Two version-canary flags (`readonlyFreezesPassThroughInput`, `readonlyContainerFreezesCopy` in `src/probe-z4-flags.ts`, asserted by `tests/canary-z4.test.ts`) and a `readonly` block in `tests/smoke-z4.test.ts` pin the `readonly` freeze semantics of the zod4 line: a copy for containers, the input itself for a pass-through leaf, both exactly as stock zod 4.5.4 (#28).

### Fixed

- `bench/bench-z4.ts` S4: the zc-z4 side was compiled from the array schema but called once per account, so `validate()` rejected every input at the type check and the reported time was the cost of the rejections, not of validation (this also affects the S4 rows of the v0.3 and v0.5 tables below, marked there). Both validators now take the whole S1 array, the run asserts that both accept it, and every timed call throws on a rejection. S4 now reads level with the official `assertOnly` validator, which `validate()` wraps (#25).

## [0.5.0]

Tuple CoW skeleton, async schema support, upstream issue draft.

### Added

- Tuple skeleton, completing the six containers: a line-by-line mirror of the official `generateTupleCheck` with the CoW rewrite applied.
  - `optinStart` / `optoutStart` (official `getTupleOptStart`, copied verbatim) plus the official length guard (`[optinStart, N]` when there is no rest element).
  - A `fillLen` variable: the official template gates trailing slots on the dynamic `out.length`, but under CoW the output may still be the input reference, whose `.length` must not be read or written, so the logical length is tracked explicitly. Invariant: `out === input ⟹ fillLen === input.length`.
  - Three segments: unconditional slots (absent slots keep the official materialization semantics), gated trailing slots with three absent-branches (`dropsWhenAbsent` truncation, validator truncation, IIFE INVALID/undefined truncation, value fill), and ungated rest slots.
  - Three truncation states. If the output is already a copy, truncate in place. If it is still the input reference and the target length differs from the input length, copy, then truncate. If the target length equals the input length, the output stays the input and nothing happens, so short inputs with trailing optionals keep the original reference.
- Async channel: async schemas no longer degrade the whole tree.
  - The six `isAsyncFunction` throw sites in the official `compileFn` are a ready-made async detector: a `ZodCompileAsyncError` turns the subtree into an async island (returns `Promise<out | INVALID>`, product tagged with the `ZC_ASYNC` marker).
  - Every product call site (object keys, array elements, tuple slots, record values, map keys and values, set members, container check predicates) is async-aware, emitting `await` and setting `ctx.async`, so the skeleton becomes an async function and parent skeletons pick it up automatically.
  - `lazy(async …)` gap: the official compiler treats lazy products as runtime islands and reports no async error at compile time, so `subtreeHasAsync` probes the def tree statically (recursion, getter expansion, cycle guard).
  - A sync island that meets a Promise throws `$ZodAsyncError` (same semantics as the official `throwAsync`: returning INVALID would be misread by a union as a rejected branch).
  - Public API: `Compiled.async` flag plus `parseAsync` / `safeParseAsync`; the sync API on an async skeleton throws `$ZodAsyncError`, as stock does.
- Upstream issue draft: [docs/upstream-issue-draft.md](docs/upstream-issue-draft.md) asks zod to promote `compileFn` / `assertOnly` / `INVALID` and the error classes to a public API, and attaches a zod4 runtime quirk found while fuzzing (async rest slots on a tuple produce a sparse array and lose a `null`, deterministic reproduction).

### Verification

- Differential fuzzing, 50 000 cases (generator extended with `bTuple` and async refine/transform variants), fully consistent with stock: 20 813 successes / 29 187 failures, top-level reference-sharing rate 89.1%, 0 stock degradations.
- 14 new smoke assertions for tuple and async behavior.

### Benchmarks (500 000 records, node v24.19, `--expose-gc`, median of 3 runs)

- S6 tuple: 4.57x vs stock, 3.06x vs the official parser (the highest ratio of all scenarios; tuple is the container with the largest share of reconstruction cost).
- S7 async (50 000 rows): 2.50x vs stock `safeParseAsync`, allocation -63%.

The full v0.5 table (S1 to S7), superseded by the CI-run table in the [README](README.md#benchmarks). The `zc-v1` column is the last measurement of the front-end removed in #4.

| Scenario | stock | official compileFn parser | zc-z4 | zc-v1 | arktype |
|---|---|---|---|---|---|
| S1 pure validation | 654ms | 263ms | **283ms** | 521ms | 144ms |
| S1 allocation pressure | +160.5MB | +111.0MB | **+30.5MB** | +12.1MB | +26.7MB |
| S1 retained after GC | +123.4MB | +108.1MB | **0.0MB** | 0.0MB | 0.0MB |
| S2 dirty load (10% default) | 619ms | 363ms | **247ms** | 504ms | — |
| S3 sweep 0% / 25% / 50% / 100% dirty | 622/647/679/660ms | 391/415/452/449ms | **245/268/311/404ms** | 490/518/540/643ms | — |
| S3 zc-z4 retained | +123.3MB constant | — | **0 / 20 / 36 / 68.7MB** | — | — |
| S4 validate | — | 219ms (official `assertOnly` validator, per account) | **50ms** (invalid, see note) | — | 144ms |
| S5 record/map/set | 922ms | 681ms | **353ms** | not supported | — |
| S5 allocation pressure | +256.1MB | +245.3MB | **+38.1MB** | — | — |
| S5 retained after GC | +217.4MB | +217.4MB | **0.0MB** | — | — |
| S6 tuple | 508ms | 340ms | **111ms** | not supported | — |
| S6 allocation pressure / retained | +214.0MB / +206MB | +202.2MB / +202MB | **+15.3MB / 0MB** | — | — |
| S7 async transform (50 000 rows) | 262ms (safeParseAsync) | compile rejected | **105ms (safeParseAsync)** | not supported | — |
| S7 allocation pressure | +95.6MB | — | **+34.9MB** | — | — |

Note on S4: the zc-z4 value of this row is not a validation cost. The bench compiled the zc-z4 side from the array schema and called it once per account, so `validate()` rejected every account at the type check and the 50ms timed 500 000 rejections (fixed under Unreleased). The official-validator and arktype values of the row are unaffected.

## [0.4.0]

record/map/set CoW skeletons and the architecture comparison document.

### Added

- Record skeleton with three compile-time paths.
  - Path A, declaration-driven keys (enum keys): a missing declared key is dirty (stock materializes it unconditionally), unknown keys are rejected in strict mode, the copy branch writes every declared key back.
  - Path B, general keys (string formats, numeric-key retry, `partialRecord`): the official `keyFast` product plus the numeric-key retry template, plus a key-name reference comparison (`outKey !== k` deletes the old key and writes the new one).
  - Path C, bare-string keys: key names never change, values compared by reference only.
- Map and set skeletons: keys, values and members compared by reference, first dirt does `new Map(input)` / `new Set(input)`, pure keys cost nothing (key identity holds). Map/Set `.min()` / `.max()` size checks are supported.
- Wiring: `cowSafeContainerForChild` / `emitBoxedContainer` / `childProduct()` extended uniformly, so `nullable(record)`, `optional(map)` and records whose values are nested objects are all CoW.
- Architecture deep dive: [docs/ARCHITECTURE-z4.md](docs/ARCHITECTURE-z4.md), the full comparison of the self-written v1 codegen with the official-codegen reuse (side-by-side generated code, purity whitelist, the three traps, the degradation-chain state machine, benchmark interpretation).

### Verification

- Differential fuzzing, 50 000 cases including map/set generators, fully consistent with stock; reference-sharing rate 89.8% on successful cases.
- S5 container benchmark: 2.65x vs stock, 1.93x vs the official parser, 0 MB retained after GC.

## [0.3.0]

zc-z4: a CoW layer over zod4's official codegen. This is the design the current zod4 line still follows.

### Motivation

zod4 (>= 4.1) ships a JIT compiler, `src/v4/core/compile.ts`, reachable through the side-effect entry `import "zod/compile"` or an explicit `z.compile()`. It compiles a whole schema tree into a monolithic validation function (`new Function` plus hoisted constants) and exposes two products this layer reuses:

| Official capability | Meaning | Reused as |
|---|---|---|
| `compileFn(schema)`, the parser product | stock semantics (unconditional new containers) | semantic backend for impure subtrees (transform/default/catch/record/union, all official) |
| `compileFn(schema, {assertOnly: true})`, the validator product | validation only, output construction skipped | validation backend for pure leaf keys, and the whole-tree `validate()` fast path |
| `INVALID` sentinel plus runtime fallback | the failure path falls back to the runtime to collect full issues | any failure in this layer returns the sentinel; issues, paths and `ZodError` are 100% official |

The earlier self-written zod4 front-end (v0.2) contained about 1100 lines of semantic codegen. The self-written part of v0.3 shrank to:

1. Purity analysis (about 120 lines, a conservative whitelist) deciding "validation passes ⇒ output must be `===` input". Traps found by fuzzing: `overwrite` checks (`.trim()` / `.toLowerCase()`) rewrite values and are impure; length/size checks carry a default `when` function (the official `WHEN_DEFAULTED_CHECKS` whitelist) and must not be rejected as custom `when`; containers wrapped in `optional` / `nullable` must be unwrapped before classification (checking `def.type` alone sends `nullable(object)` to the official `assertOnly` product and loses strip semantics).
2. Container CoW skeleton codegen (object and array templates, about 200 lines): the official "unconditional new container" (`const out = {...}` / `new Array(n)`) is rewritten into "reference comparison as dirty check plus conditional shallow copy". Clean input does `return input` (the one line the official template lacks); a forced copy does `out = { ...input }`, so key presence and key order are preserved by the spread, and strip detects extra keys with the official `for...in` plus `Set` probe and deletes them on the copy.
3. Container-level checks subroutine (refine/min/max): an independent validation function called on both paths, matching stock semantics (checks run on the final output: the input when clean, the rebuilt `out` when dirty).

### Degradation chain (per subtree, never giving up correctness)

```
CoW container skeleton
  ├─ pure leaf → official assertOnly validator (full validation, zero construction)
  ├─ impure subtree → official parser product plus reference comparison
  ├─ product generation failed → runtime island (black-box _zod.run)
  └─ whole tree not compilable (async / recursive top level / schema catchall) → stock safeParse
Every failure path falls back to stock (full issues / error map / ZodError).
Coexists with the global "zod/compile" shim: the fallback path gets the official JIT for free.
```

(v0.5 later replaced the whole-tree degradation for async schemas with async islands.)

### Benchmarks (v0.3, 500 000 accounts, node v24, `--expose-gc`, median of 3 runs)

| Scenario | stock | official JIT parser | zc-z4 (CoW) | zc-v1 (self-written) | arktype |
|---|---|---|---|---|---|
| S1 pure validation | 685 ms | 279 ms | **280 ms** | 566 ms | 120 ms |
| S1 allocation pressure | +160.5 MB | +111.0 MB | **+30.5 MB** | +12.1 MB | +26.7 MB |
| S1 retained after GC | +123.4 MB | +108.1 MB | **0.0 MB** | 0.0 MB | 0.0 MB |
| S2 dirty load (10% default injection) | 641 ms | 383 ms | **238 ms** | 537 ms | — |
| S3 100% dirty | 662 ms | 439 ms | **420 ms** | 668 ms | — |
| S4 validate (whole-tree product) | — | 174 ms (official `assertOnly` validator, per account) | **27 ms** (invalid, see the S4 note under 0.5.0) | — | 120 ms |

The `zc-v1` column is the v0.3 measurement of the self-written zod4 front-end, which was removed in #4.

Takeaways at the time:

- Reusing the official codegen made zc-z4 2.0x faster than v1 (S1 566 → 280 ms), level with the official parser product (1.00x), with 73% less allocation (30.5 vs 111 MB) and 0 MB retained.
- Under dirty load zc-z4 beat the official parser by 1.61x: the default `shallowClone` and the output rebuild are fixed costs of stock semantics, CoW skips the rebuild of the clean part.
- `validate()` is the official whole-tree `assertOnly` product. The takeaway drawn from S4 at the time (27 ms, 54 ns per account, 4.4x faster than arktype) was wrong: the 27 ms timed rejections of a mismatched input, see the S4 note under 0.5.0.
- The remaining 30.5 MB of short-lived allocation comes from inside the official leaf products (temporaries of datetime/email format checks); 0 MB retained after GC, the CoW layer itself copies nothing.

### Verification

- `tests/differential-z4.test.ts`: 50 000 cases of random schemas and data, success parity plus `deepStrictEqual` outputs plus zero input mutation, all consistent with stock zod4 (`REPRO=seed:case` reproduces one case). Top-level reference-sharing rate 81.8% on successful cases.
- `tests/smoke-z4.test.ts`: 11 groups of behavior assertions (original reference, strip, strict, default, transform, nested sharing, array elements, optional, union, degradation chain).

### Version anchor

The layer reads zod4 internals: `compileFn` / `INVALID` / `ZodCompileUnsupportedError` / `ZodCompileAsyncError` from `zod4/v4/core`, plus hand-copied semantic predicates (`WHEN_DEFAULTED_CHECKS`, `fastPathAcceptsAbsence`, `mayOutputUndefined`). Anchored to zod **4.5.4**; a zod upgrade requires rerunning the differential suite to confirm the predicates did not drift.

## [0.2.0]

Self-written zod4 front-end. This compiler line was removed in #4; the record below is the adaptation findings and the benchmark measured at the time. The script names `test:z4` / `bench:z4` and the path `src/index-z4.ts` have since been reused by the current zod4 line and mean something different today.

### Added

- A zod4 port of the v0.1 closure-tree compiler (then `src/compile-z4.ts` + `src/index-z4.ts`), consuming `zod@4.5.4` through the `zod4` npm alias so both zod majors are installed side by side.
- `src/probe-z4.ts`: a survey of zod4 def structures and behavior, with a `REPRO=seed:case` hook for reproducing differential failures. The probe is still in the repository.
- Probe canary assertions (stock zod4 behavior vs compiler assumptions), later moved to `tests/canary-z4.test.ts`, which now runs as the first step of `pnpm run test:z4` so that a zod upgrade that changes an implicit contract turns the tests red first.

### Structural differences between zod3 and zod4

The table of structural differences, every row anchored by `src/probe-z4.ts`, is still valid because it describes stock zod3 vs zod4 and constrains the current line too. It lives in `docs/ARCHITECTURE-z4.md`, Appendix A.

### Verification (at the time)

- `pnpm run test:z4`: 39 unit tests (including the probe canaries and optional/default combination regressions) plus 20 000 differential cases, all consistent with stock zod4; top-level reference-sharing rate 91.2% on successful cases.

### Benchmarks (v0.2, 500 000 accounts, node v24.19, `--expose-gc`, median of 3 runs)

| Variant | Time (median) | Allocation pressure (before GC) | Retained after GC |
|---|---|---|---|
| S1 pure validation, stock zod4 parse | **223 ms** | +110 MB | +108 MB |
| S1 pure validation, stock zod4 + JIT (`zod4/compile`) | 235 ms | +110 MB | +108 MB |
| S1 pure validation, **zc CoW parse** | 510 ms (0.51x) | **+0.3 MB** | **+0.0 MB** |
| S1 reference line, arktype 2.2 | 158 ms | +27 MB | +0.0 MB |
| S2 dirty load (default, 10% missing), stock | 381 ms | +134 MB | +123 MB |
| S2 dirty load, **zc CoW** | 500 ms (0.76x) | **+18 MB** | +10 MB |
| S3 dirty-ratio sweep, zc retained | 0% → 0 MB / 25% → 20 MB / 50% → 36 MB / 100% → 69 MB | — | (stock constant +123 MB) |

Conclusions at the time (how the value proposition changed on zod4):

1. zod4 had already removed most of the "interpreter tax": the same scenario went from 2092 ms on stock zod3 to 223 ms on stock zod4 (9.4x). zod4's parse is a specialized function per type with lazy paths and no per-node context allocation.
2. The CoW closure tree was no longer the speed winner on zod4 (4.3 to 5.0x on zod3, 0.5 to 0.8x on zod4): the allocation saved by not rebuilding the output tree (cheap on V8's bump allocator) did not offset the call overhead of a generic closure tree against zod4's specialized functions. Micro-probes showed the leaf validators were faster (string 1.6x, number 2.4x); the gap was in object assembly, where zod4 classic uses `$ZodObjectJIT` code generation.
3. The structural benefits were unchanged: allocation pressure -99.7%, 0 MB retained after GC (stock constant +108 MB), output `===` input reference (structural sharing, safe aliasing, incremental-update semantics).
4. The `zod4/compile` JIT was level with stock in this scenario; arktype stayed fastest (158 ms).
5. Closing the speed gap meant the `new Function` monolithic codegen proposed in the v0.1 worklog. v0.3 took the shortcut of reusing zod4's own codegen instead.

## [0.1.0]

The zod3 CoW compilation layer: a hand-written closure-tree compiler (`src/compile.ts` + `src/index.ts`) that is now the frozen reference implementation.

### Added

- `compile(schema)` for zod 3.24.1 schemas, returning `parse` / `validate` (a `DeepReadonly` view) / `safeParse` and a static `pure` flag. The schema is consumed as is (the `.def` tree is read); zod is not forked and the Zod API is unchanged.
- Compile-time parsing of shape, keys and checks into specialized validation closures; a single mutable ctx with lazy paths (a path snapshot is materialized only when an issue is produced).
- The CoW invariant: every node is `(data, ctx) => value | FAILED`; primitives compare by value, containers by reference; a parent shallow-copies at the first changed child. Strip never deletes on the input object (the Numeric fork's in-place delete was the footgun this fixes).
- `src/probe.ts`: runtime probes of stock zod3 edge semantics (absent optional keys are not materialized, present-undefined keys are kept, default values pass the inner validation, issues are collected across siblings, readonly freezes shallowly), so the compiler adapts to the installed version.
- String format regexes copied verbatim from zod 3.24.1 into `src/regexes.ts`.
- `ZcNotSupportedError` at compile time for `intersection`, `catchall`, tuple rest, `ZodPromise` and async refine (detected at runtime).

### Verification

- 27 unit tests plus 20 000 differential cases (random schema plus random data, asserting success parity, `deepStrictEqual` outputs and zero input mutation), all passing; top-level reference-sharing rate about 92% on successful cases.

### Benchmarks (v0.1, 500 000 accounts, node v24, `--expose-gc`, median of 3 runs)

| Variant | Time (median) | Allocation pressure (before GC) | Retained after GC |
|---|---|---|---|
| S1 pure validation, stock zod 3.24.1 | 2092 ms | +266.7 MB | +183.8 MB |
| S1 pure validation, **zc compiled (CoW)** | **487 ms (4.29x)** | **+10.1 MB** | **+0.0 MB** |
| S1 reference line, arktype 2.2 | 182 ms | +10.7 MB | +0.0 MB |
| S2 dirty load (role with default, 10% missing), stock | 2185 ms | +246.8 MB | +183.8 MB |
| S2 dirty load, **zc compiled (CoW)** | **434 ms (5.03x)** | **+20.2 MB** | +10.3 MB |

Compared with the roughly 2x that Numeric reported, this prototype reached 4.3 to 5.0x because, on top of zero-copy, it removed wrapper objects, made paths lazy and parsed shapes at compile time. The remaining gap of about 2.7x to arktype was per-node function dispatch (interpreter residue); the worklog proposed `new Function` monolithic codegen (the ArkType route) as the next step.
