# AGENTS.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A prototype Copy-on-Write (CoW) compilation layer for Zod schemas. `compile(schema)` returns a fast parser whose output is `===` the input reference when nothing was forced to change (no default/transform/strip/etc. fired), and otherwise copies only the dirty path from leaf to root. The README is the authoritative narrative; `docs/ARCHITECTURE-z4.md` is the deep dive on the current engine; `CHANGELOG.md` holds the v0.1 to v0.5 history and the superseded benchmark tables.

Git repository with GitHub Actions CI (`.github/workflows/ci.yml`: typecheck, both test lines, the `zod-cow-v4` build and the packed-tarball smoke on a Node `22.13.0` / 22 / 24 / 26 matrix, plus a separate `lint` job that also compares the two harness copies). A second workflow, `.github/workflows/bench.yml`, builds `zod-cow-v4` and runs `bench-v4` and `bench-v3` on `workflow_dispatch` / weekly schedule only (never on push/PR) with `BENCH_N=50 000` by default and writes the output to the job summary; the benchmark tables in the READMEs and docs quote one of those runs by run id. Linting and formatting use Biome (`biome.json`: recommended rules with `noExplicitAny` and `noNonNullAssertion` off); `pnpm run lint` must pass before a PR is opened.

Language: code comments, test and bench output strings, and non-code artifacts (docs, issues, PR text, plans, reviews) are all written in English. Code comments and test/bench output were translated in #6, the docs in #7. The only Chinese files are the two deliberate ones listed under Documentation layout below.

Documentation layout:

| File | Role |
|---|---|
| `README.md` | English source of truth for the repository: what the layer is, quick start, the CoW invariant, the current benchmark table, correctness evidence, known limitations, repository layout. Its install and usage sections are a link to the package README |
| `README.zh-CN.md` | Chinese counterpart with the same headings. A change to `README.md` must be applied to `README.zh-CN.md` in the same PR |
| `packages/zod-cow-v4/README.md` | Consumer document for the published package and the authority for install, usage, API and peer-policy text (ADR 0001 §5): that text lives there and nowhere else; the root README links to it, and it links back to the root README for the CoW invariant, the benchmarks, the evidence and the limitations. Ships in the npm tarball. No Chinese counterpart |
| `CHANGELOG.md` | Keep a Changelog style; `Unreleased` plus v0.1 to v0.5. Historical benchmark tables live here, never in the README. Covers the whole workspace; `zod-cow-v4` carries the project version |
| `docs/ARCHITECTURE-z4.md` | English architecture deep dive on the zod4 engine (§1 to §11 plus Appendix A). Architecture changes go here |
| `docs/ARCHITECTURE-z4.zh-CN.md` | Chinese counterpart of the architecture deep dive with the same section numbering. A change to `docs/ARCHITECTURE-z4.md` must be applied to it in the same PR. Its text still reflects v0.5; bringing it up to date is tracked in #52 |
| `docs/upstream-issue-draft.md` | Draft issue for zod upstream asking to make `compileFn` / `assertOnly` / `INVALID` public |
| `docs/adr/` | Architecture decision records, numbered. `0001-package-layout.md` (#8, implemented in #9): one package per zod major in a pnpm workspace, `zod-cow-v4` published name, benchmarks split per line, verified-minor peer range for zod, zod3 line unpublished. A new decision gets the next number; a superseded ADR keeps its file and gains a `Superseded by` status line |

## Package layout

A pnpm workspace (`pnpm-workspace.yaml`: `packages/*`). The root is a private package that holds the tooling (`biome.json`, the base `tsconfig.json`, `typescript` / `tsx` / `@types/node` / Biome as devDependencies), the workflows, `docs/`, both READMEs and `CHANGELOG.md`, and fans out to the packages with `pnpm --filter` and `pnpm -r`. There is no shared package and no task runner.

| Package | Directory | Published | Owns |
|---|---|---|---|
| `zod-cow-v4` | `packages/zod-cow-v4/` | yes, as `zod-cow-v4` | The zod4 line: entry `src/index.ts`, engine `src/cow4/`, probes `src/probe-z4.ts` and `src/probe-z4-flags.ts`, the canary, smoke and differential tests, its own `tests/harness.ts`, the packed-tarball smoke `scripts/pack-smoke.ts`, a consumer README and a copy of `LICENSE`. devDependency `zod@4.5.4`, peerDependency `zod >=4.5.4 <4.6.0`, `engines.node >=22.13.0`, `license: MIT` |
| `zod-cow-v3` | `packages/zod-cow-v3/` | no (`private`) | The zod3 line (`src/compile.ts` closure compiler, `src/codegen.ts` generated container skeletons, `src/internal.ts` protocol and issue construction), its unit and differential tests (each run with the generated skeletons and with `--no-codegen`), its own `tests/harness.ts`. `exports` points at `./src/index.ts` (no build; `tsx` transpiles through the workspace link). devDependency `zod@3.24.1` |
| `bench-v4` | `packages/bench-v4/` | no | `bench.ts` (the S1 to S7 batch scenarios and the orchestration of the rest), `schemas.ts` (the account and tuple schemas for zod and ArkType side by side, datasets, products, fixture helpers), `strip.ts` (S8 strip-unknown parity), `calibration.ts` (single-record hot loops), `failures.ts` (S9 validation-only failures, S10 full parse failures), `harness.ts` (measurement: warmup, interleaved gc-separated rounds, batch and per-operation modes, `N/A` candidates, summary and diagnostic tables), `gates.ts` (equivalence gates run before timing) and `demo.ts`, written against the published API; depends on `zod-cow-v4` (`workspace:*`), `zod@4.5.4`, `arktype`. Imports `compile` from `"zod-cow-v4"`, so it needs the build first. Columns: stock Zod 4, the public `z.compile()` / `z.validate` API, zod-cow-v4 and ArkType in the primary tables; the internal `compileFn` / `assertOnly` product only in a diagnostic table |
| `bench-v3` | `packages/bench-v3/` | no | The zod3 benchmark, the same methodology as `bench-v4` with the zod3 columns (stock Zod 3, zod-cow-v3, ArkType): `bench.ts` (S1 clean parse, S2 10% default, S3 dirty sweep, S4 validate, S5 record / map / set clean and dirty, S6 tuple clean and dirty, S7 sync transforms dirty and no-op plus an async row that is N/A for the sync compiler, S8 strip parity), `calibration.ts` (single-record hot loops and the scaling sweeps: primitive leaves, object width 1 to 50, nesting depth 1 to 5, arrays 1 to 100, tuples 1 to 10), `failures.ts` (S9: issue-semantics parity of every failure fixture against stock printed before any timing, per-row datasets with 1% to 100% invalid rows, failure-position hot loops), `schemas.ts` (zod3 account schema and the constraint-equivalent ArkType schema: zod3 `.int()` is `number.integer`, `.max(64)` is `string <= 64` since zod3 counts UTF-16 units, `z.number()` is `number` since zod3 accepts the infinities, email and datetime as zod3's own regexes), `harness.ts` and `gates.ts` (copies of the bench-v4 modules with the zod3 columns) and the zod3 `demo.ts` (reads `.pure`, shows the `DeepReadonly` view); depends on `zod-cow-v3` (`workspace:*`), `zod@3.24.1`, `arktype` |

Each package installs exactly one `zod` at the right major and imports it by its real specifier (`zod`, `zod/v4/core`); there is no `zod4` alias anywhere.

`zod-cow-v4` is built by `tsc -p tsconfig.build.json` into `dist/` (ESM plus `.d.ts`, the probes excluded); `exports` lists `.` and `./package.json` only and `files` is `["dist"]`, so the tarball holds the build output plus the `package.json`, README and LICENSE that npm always adds. `pnpm run smoke:pack` packs the package, checks the listing both ways and the shipped `engines.node` / `exports`, installs the tarball into a temporary project with the verified zod (packed from the workspace, no registry), parses through `import` and `require`, resolves the `./package.json` export and typechecks an ESM and a CommonJS consumer against the declarations. It runs on every push/PR lane, including the one pinned to the exact Node floor.

The test harness exists twice (`packages/zod-cow-v3/tests/harness.ts`, `packages/zod-cow-v4/tests/harness.ts`) and the copies must stay byte-identical: `pnpm run check:harness` compares them and runs in CI, so a change to one lands in the other in the same PR.

## Commands

Use Node.js >= 22.13.0 with pnpm 11.24.0.

`pnpm install` first (tsx/tsc are local devDependencies; nothing works without it). Run the root scripts from the repository root; `pnpm --filter <package> run <script>` reaches one package.

| Task | Command |
|---|---|
| Build `zod-cow-v4` (`dist/`) | `pnpm run build` |
| Typecheck every package (builds `zod-cow-v4` first because `bench-v4` types against `dist/`) | `pnpm run typecheck` |
| Lint + format check (read-only, fails on warnings) | `pnpm run lint` |
| Apply safe lint fixes and formatting | `pnpm run lint:fix` |
| Format only | `pnpm run format` |
| Compare the two harness copies | `pnpm run check:harness` |
| Tests, zod4 line: canary, smoke, differential | `pnpm run test:v4` |
| Tests, zod3 line, plus the harness self-test | `pnpm run test:v3` |
| Both test lines | `pnpm test` |
| Run one test file | `pnpm --filter zod-cow-v4 exec tsx tests/smoke-z4.test.ts` (or `--filter zod-cow-v3 exec tsx tests/unit.test.ts`) |
| Packed-tarball smoke (builds first) | `pnpm run smoke:pack` |
| Benchmarks | `pnpm run bench:v4` (builds first) / `pnpm run bench:v3` (need `--expose-gc`, already in the package scripts) |
| Probe stock zod behavior | `pnpm run probe:v4` / `pnpm run probe:v3` |
| 60-second demo against the published API | `pnpm run demo` (builds first; `pnpm run demo:v3` runs the zod3 demo) |

There is no test runner. Test files are plain `tsx` scripts: unit/smoke tests use the package's `tests/harness.ts` (`test()` + `summary()`, sets `process.exitCode = 1` on failure); differential tests are standalone fuzzers that compare against stock zod and share only the `deepEqual` comparator from the harness.

Environment knobs:

- `SEEDS` / `CASES` set the differential fuzz size. Code defaults are 200 × 100 = 20 000 cases (the 50 000-case figures in README/docs were larger runs). Use `SEEDS=20 CASES=50 pnpm run test:v4` for a quick pass. The zod4 fuzzer runs every case twice: with the default options, then compiled with `ownSymbolKeys: "ignore"` against the same RNG stream minus the extra own symbol; it fails if the second pass shares fewer top-level references than the first or if a generated top-level skeleton still carries the probe.
- The zod3 fuzzer (`packages/zod-cow-v3/tests/differential.test.ts`) compares the ordered issue list (every property of every issue, `fatal` and nested union errors included) against stock on every failing case; its union options include containers and wrapped schemas and its leaves include an `unknown` pass-through. It runs twice in `test:v3`: with the generated skeletons and with `--no-codegen` (the closure fallback; `ZC_V3_CODEGEN=0` in the environment forces the same fallback for any process); the unit tests run the same two ways.
- `REPRO=seed:case` re-runs exactly one failing differential case and dumps the schema/input/generated code (zod4 tests only, e.g. `REPRO=112:80 pnpm --filter zod-cow-v4 exec tsx tests/differential-z4.test.ts`).
- `BENCH_N` sets the benchmark record count (default 500 000; the CI bench workflow uses 50 000; `bench-v4` requires an integer of at least 10 because S2 marks every tenth row and S7 runs on N / 10 rows). The dirty and invalid shares (S2, S3, S9) mark every round(1 / share)-th row, so a share is exact only when `BENCH_N` is a multiple of that period (100 for the 1% row); the scenarios print the realized counts. `BENCH_PASSES` sets the minimum number of timed rounds per candidate in `bench-v4` (default 3, after at least 2 warmup rounds); both counts are rounded up to a multiple of the scenario's candidate count so the rotated order forms complete rotations (5 plus 5 with five candidates). `BENCH_ITERS` sets the operations per timed round of the single-record hot loops (default `BENCH_N`). `BENCH_ONLY` (comma-separated scenario-id prefixes, e.g. `S3,S8`) skips every other scenario after its gate, for re-measuring one change.

## Architecture

Two compiler front-ends live in two packages; they share no code (`internal.ts` is the zod3 line's protocol module; the zod4 engine never imported it). Know which line you are editing:

| Line | Entry | Engine | Status |
|---|---|---|---|
| zod3 | `packages/zod-cow-v3/src/index.ts` → `packages/zod-cow-v3/src/compile.ts` (+ `codegen.ts`) | Hand-written compiler: closure tree for leaves and wrappers; object / array / tuple skeletons generated per schema with `new Function` (`codegen.ts`), the closure skeletons of `compile.ts` as the fallback where `new Function` is unavailable (`ZC_V3_CODEGEN=0` forces it, the differential test runs both through `--no-codegen`); string regexes copied verbatim into `src/regexes.ts` from zod 3.24.1 | Maintained: kept passing and optimized further; not published |
| zod4 | `packages/zod-cow-v4/src/index.ts` → `packages/zod-cow-v4/src/cow4/index.ts` | Reuses zod4's official JIT codegen as the semantic backend, adds CoW container skeletons | Primary line: the published package, where new features go |

Each package installs its own zod: `packages/zod-cow-v4` against zod 4.5.4, `packages/zod-cow-v3` against zod 3.24.1; both import `zod` by its real specifier.

### The CoW invariant (all lines)

Every compiled node is `(input) => output | FAILED-sentinel`. Dirtiness needs no protocol: a child returning the same reference means "unchanged"; a parent does its first shallow copy (`{...input}` / `slice()` / `new Map(input)`) only at the first changed child, then writes further dirty children into that copy. Primitives compare by value (`'x'.trim() === 'x'` is clean). Consequences that constrain every change:

- Never mutate input. Strip must never `delete` on the input object. The only in-place write is the `Object.freeze` of `readonly`. In the zod4 line `readonly` is impure and goes to the official parser, so it freezes exactly what stock freezes: a copy for containers, the input itself for a pass-through leaf such as `any` / `unknown` (#28). The zod3 line reaches the same result through stock's rebuild mode (`ctx.force`): `readonly` sets it for its inner call when the inner schema may rebuild in stock (`mayRebuild` in `compile.ts`: a container or `date`, or a wrapper / union option / effect / pipeline side around one), every container skeleton below then starts out dirty and assembles its output from the validated values, a `date` leaf returns a copy, and a pass-through leaf or a `catch` fallback still hands back the input, which is frozen in place like stock (#27). A `default` whose value fired sets the same mode for the same reason, so a parsed container default is rebuilt at every level and never aliases the schema's default value (fifth review of #63). Nothing else reads the flag; a new node kind that builds output must honor it. A declared `__proto__` shape key is validated but never written and an own `__proto__` on the input is dropped from the output on every path, as stock's output assembly skips that key; the object, record and discriminated-union skeletons reject a Date / Map / Set / promise-like input as `invalid_type` like stock's `getParsedType` (`isObjectType` in `internal.ts`). The copy an object skeleton makes is stock's output assembly from the validated values (shape order, `value !== undefined || key in input`, passthrough extras appended by `for...in` with an `undefined` value dropped), never a spread of the input, and the strip / strict probe is stock's `for...in`, so an inherited enumerable key counts as undeclared; the record skeleton assembles its copy from the parsed pairs in stock's `for...in` order (an inherited enumerable key written as own, a pair whose output key is `__proto__` left out, a transformed key that collides with a later entry overwritten by it) and the array and tuple skeletons copy with `slice()` and materialize a hole as an own `undefined` slot, as stock's spread does (#65, review of #63). Whether an object child is skipped on an `undefined` value is decided from the schema's structure (`isUndefStable`), never by running it at compile time; the only user code `compile()` runs is a `z.lazy` getter, once per lazy node (`resolveLazy`, memoized), whose answer every analysis and every parse share.
- Output may alias input, so refines must not mutate.
- Failure paths of the zod4 line carry no issue data of their own: they return the sentinel and the caller falls back to stock `safeParse` for the full `ZodError`. The zod3 line builds its own issues (a preprocess callback's fatal issue aborts and a non-fatal one is dirty with the inner schema still running on the mapped value; an async callback is detected as stock does, by `instanceof Promise`; a callback may re-enter its own schema through a nested parse, so the one callback context an effect node keeps (`EffectHolder` in `compile.ts`) is saved and restored around every callback and the outer callback's `addIssue`, `fatal` flag and `path` still reach the outer parse, review of #63): a type mismatch aborts (returns FAILED), a failed check is dirty (pushes the issue, returns the value, later checks and ancestor refinements still run, a union prefers a dirty option, `catch` replaces it), the parse fails at the top when `ctx.issues` is non-empty; messages come from zod's own error maps (`pushIssue` in `internal.ts`), never from hand-written strings, and the differential fuzzer compares the full issue list against stock on every failing case.

### zod4 engine (`packages/zod-cow-v4/src/cow4/`): how the pieces fit

The engine is a directory of small modules (guideline: about 500 lines per file for this line and new code; the zod3 compiler and the fuzzers are exempt):

| Module | Holds |
|---|---|
| `index.ts` | Thin entry: `compileCowFn`, `compileCowDebug`; re-exports `INVALID`, `Fn`, `ZC_ASYNC`, `isAsyncProduct`, `officialValidator`, `CompileOptions`, `resolveOptions` |
| `product.ts` | The `Fn` product contract, the `ZC_ASYNC` marker (`markAsync`/`isAsyncProduct`), `isAsyncFn`, `throwAsync` |
| `options.ts` | `CompileOptions` (the public options of `compile(schema, options?)`: `ownSymbolKeys: "probe" \| "ignore"`), the resolved `CowOptions`, `DEFAULT_OPTIONS`, `resolveOptions` (throws `TypeError` on an unknown value, `null` included, or a non-plain options object, and formats that error from property descriptors and type tags, never `JSON.stringify` or a method of the rejected object or value, so a throwing accessor, `toJSON` or Proxy trap cannot replace the `TypeError`; a throw while reading the option off the options object becomes a `TypeError` with the caller's error as `cause`; reads only an own `ownSymbolKeys`, never an inherited one, and treats an own `undefined` as absent) |
| `codectx.ts` | `CodeCtx` (lines, hoisted constants, var names, async flag, the resolved compile options; `subFn` gives a child context its parent's options), `escKey`, `unknownStringKeyExpr` and `emitOwnSymbolProbe` (the undeclared-key probes shared by the object and record skeletons), `buildFn` (Function-constructor build) |
| `predicates.ts` | Predicates copied verbatim from zod: `acceptsAbsence`, `requiresPresence`, `mayOutputUndefined`, `getTupleOptStart`, `dropsWhenAbsent` |
| `purity.ts` | `isPure`, `leafChecksArePure`, `checksAreCowSafe`, `WHEN_DEFAULTED_CHECKS`, `cowSafeContainerForChild` |
| `official.ts` | Official-product wrappers: `officialFn`, `officialValidator`, `makeIsland`, `makeAsyncIsland`, `subtreeHasAsync` |
| `emit.ts` | Codegen core: `emitNode`, `emitBoxedContainer`, `childProduct`, `containerChildFn`, `containerChecksFn`, `subFn` |
| `emit-object.ts`, `emit-array.ts`, `emit-tuple.ts`, `emit-record.ts`, `emit-map.ts`, `emit-set.ts` | One container skeleton each (`emitCoWObject` … `emitCoWSet`) |

`emit.ts` and the six `emit-*.ts` files form an import cycle on purpose: `emitBoxedContainer` dispatches to the skeletons and the skeletons recurse through `containerChildFn`/`childProduct`. It is safe because every binding in the cycle is a hoisted function declaration and nothing in those modules runs at load time; keep it that way (no top-level code that calls across the cycle).

1. Official products as leaves and subtrees (`official.ts`). Imports `compileFn`, `INVALID`, `ZodCompileUnsupportedError`, `ZodCompileAsyncError`, `$ZodAsyncError` from `zod/v4/core` (a public permalink subpath; the two `ZodCompile*` errors are public, the rest are unsupported compiler internals). `compileFn(schema)` gives a stock-semantics parser; `compileFn(schema, {assertOnly:true})` gives a validator that skips output construction.
2. Purity analysis (`isPure`, `leafChecksArePure`, `checksAreCowSafe` in `purity.ts`): a conservative whitelist deciding "validation passes ⇒ output === input". Pure subtrees get the official *validator*; impure subtrees get the official *parser* plus a reference comparison. Four documented traps, each reproduced by the differential fuzzer: `overwrite` checks (`.trim()` etc.) rewrite values and are impure; length/size checks carry a default `when` (`WHEN_DEFAULTED_CHECKS`, copied from zod) and must not be rejected as custom-`when`; `optional/nullable` wrappers must be unwrapped before deciding whether a container gets a skeleton; a union option is not a skeleton position, so a union with a container option (also under `optional/nullable`) is impure and takes the official parser, which strips like stock (#47).
3. Container skeletons (`emitCoWObject/Array/Tuple/Record/Map/Set`, one `emit-*.ts` each): string-templated codegen that mirrors zod's own `generate*` functions line by line, then rewrites the unconditional `const out = {...}` into "compare refs, copy on first dirt, `return input` when clean". The object skeleton's copy path is the official output assembly from the locals captured during validation (shape order, `mayOutputUndefined` / `dropsWhenAbsent` presence rules, loose keys appended by `for...in`), never a spread of the input: getters are read once, undeclared keys are dropped by construction, and strip mode runs its two undeclared-key probes (the `for...in` string probe and `Object.getOwnPropertySymbols`) only when no key is dirty, since they exist solely to prove that the input can be returned by reference. The map, set and iterating-record skeletons rebuild the clean prefix in iteration order at the first forced change and write every later entry after it (stock's assembly sequence, so a colliding transformed key or member loses to the later entry and a pair whose output key is `__proto__` is dropped), and the array and tuple skeletons materialize a hole as an own `undefined` slot (#67). `compile(schema, { ownSymbolKeys: "ignore" })` (#43) drops the symbol probe at every depth: a clean input then keeps an undeclared own symbol key by reference where stock drops it (the strict / loose behavior of #42, opt-in for strip mode); the default `"probe"` keeps stock semantics. The record skeleton follows the same option (#51): an enum-keyed record runs the same probe on its clean path (`emitOwnSymbolProbe` in `codectx.ts`, shared with the object skeleton), and a record that iterates its keys marks a non-enumerable own symbol dirty inside the key loop it already runs. Any new option goes through `options.ts` and `ctx.options`, never through module state. Container-level checks (`min/max/refine`) run via `containerChecksFn` on the final output in both clean and copied paths. A `.refine` on an optional / nullable wrapper above a container runs the same way, on the shortcut value and on the container's output, inner wrapper first; `emitBoxedContainer` then builds the container as a nested skeleton called once, since an inline skeleton returns the clean input from inside itself (#56). Any other check on such a wrapper sends the chain to the official parser, and `isPure` looks at a wrapper's own checks before recursing (an overwrite or superRefine on `optional(string)` is impure, #57); above a container it applies the same gate the skeleton does, so a `.check(z.minLength(n))` on the wrapper cannot fall through to the validator and keep the keys stock strips (#68). Wiring goes through `childProduct` / `cowSafeContainerForChild` / `emitBoxedContainer` (`emit.ts` and `purity.ts`); extend those when adding a container or wrapper combination.
4. Async: the official `ZodCompileAsyncError` is the detector. Async subtrees become async islands (marked with the `ZC_ASYNC` symbol), every product call site emits `await`, and the skeleton becomes an async function. `subtreeHasAsync` statically covers `lazy(async…)` which the official compiler misses. Sync API on an async product throws `$ZodAsyncError`, same as stock.
5. Degradation chain, per subtree, every step keeping stock's results: CoW skeleton → official validator (pure leaf) → official parser (impure subtree) → runtime island (`_zod.run` black box) → whole-tree stock `safeParse` (`compiled.stock === true`). `compiled.code` exposes the generated skeleton source for debugging: the top-level skeleton followed by every nested skeleton the tree built (`CodeCtx.sources`, shared from parent to child by `subFn` and appended by `buildFn`; a sub-skeleton that failed and was replaced by an official product is dropped from the dump), so a check over `compiled.code` covers every depth (#46).

### zod3 engine (`packages/zod-cow-v3/src/`): how the pieces fit

| Module | Holds |
|---|---|
| `index.ts` | `compile(schema)`: `parse` / `validate` (same runtime, `DeepReadonly` return type) / `safeParse` (lazy `error`), the `.pure` flag from `isStaticPure` |
| `compile.ts` | `go` (compile cache, z.lazy placeholder), one `make*` per zod3 node kind (closure tree), `subtreeHasEffect` (which containers keep `ctx.path` eagerly), `prefixIssues` (lazy paths), `mayRebuild` (whether stock may build a fresh output on some path: switches `ctx.force` on under `readonly` and a fired `default`, makes a `readonly` over such a schema impure), `resolveLazy` (the once-per-node lazy resolution), `isStaticPure`; the closure skeletons of object / array / tuple stay as the fallback |
| `codegen.ts` | `genObject` / `genArray` / `genTuple`: per-schema skeletons built with `new Function`, the same algorithm as the closure skeletons; `inlinePredicate` turns a check-free or pure-check leaf (string bounds and formats, number bounds and `int`, boolean, literal, enum, date, optional / nullable of those) into an inline test that hands the value to the leaf closure only when it fails |
| `internal.ts` | `FAILED`, `Ctx`, `Issue`, `pushIssue` / `pushInvalidType` (issue construction through zod's error maps), `parsedType`, `floatSafeRemainder`, `safeSet` |
| `probe.ts`, `regexes.ts` | Stock zod3 behavior probes read at module load; the format regexes copied verbatim |

Hot-path rules for this line, each measured in the optimization round (see the CHANGELOG entry): `Object.hasOwn` inside a `for...in` is not folded by V8 while `hasOwnProperty.call` is; the undeclared-key probe compares each enumerated key against the shape key at that position before touching the key map; a container without an effect below it does no `ctx.path` push/pop on success; a generated skeleton has one monomorphic call site per child, which is what the closure tree cannot offer (every closure instance shares one feedback vector). Any change to `codegen.ts` must keep the closure skeleton in `compile.ts` semantically identical, and `pnpm run test:v3` fuzzes both.

### Version anchoring

The zod4 line depends on `zod/v4/core`, a public permalink subpath whose compiler exports (`compileFn`, `assertOnly`, `INVALID`, the artifact protocol) are unsupported (the two `ZodCompile*` errors are public), and on hand-copied predicates (`WHEN_DEFAULTED_CHECKS` in `packages/zod-cow-v4/src/cow4/purity.ts`; `getTupleOptStart`, `mayOutputUndefined`, `acceptsAbsence` in `packages/zod-cow-v4/src/cow4/predicates.ts`, which is the one file to diff against upstream on a bump). Anchored to zod 4.5.4, which is both the package's devDependency and the lower bound of its peer range (`>=4.5.4 <4.6.0`; widening is a release, see ADR 0001 §3). `packages/zod-cow-v4/src/probe-z4-flags.ts` encodes the stock behaviors the compilers assume (default short-circuits, catch does not swallow throws, optional hands undefined to a defaulted inner, etc.), and `packages/zod-cow-v4/tests/canary-z4.test.ts` (first step of `test:v4`) asserts them so an upgrade turns tests red instead of drifting silently. After bumping zod: rerun probes, then the full differential suites, the packed-tarball smoke and `bench:v4` (its `patternOf` in `packages/bench-v4/schemas.ts` reads the unsupported `_zod.def.pattern` of the email / datetime leaves to hand zod's exact patterns to ArkType, and asserts that a `RegExp` came back).

### Known unsupported (throws at compile time or degrades to stock)

`intersection`; zod3 `catchall`/tuple rest/`ZodPromise` (compile time) and async refine/transform/preprocess (parse time); zod4 `file`/`templateLiteral`/`promise`, `string_format` without a `pattern` (e.g. `url`), recursive top-level and schema-level `catchall` in the zod4 line. Do not silently widen support: either add a differential-verified path, or keep the explicit failure (the zod3 v1 line throws `ZcNotSupportedError` at compile time; the zod4 line lets the official `ZodCompileUnsupportedError` degrade the tree to stock).

## Working conventions

- Any change to purity rules or a container skeleton must be validated with the differential fuzzer for that line (`packages/zod-cow-v4/tests/differential-z4.test.ts` for the zod4 line), not only the smoke tests. Report the reference-sharing rate it prints; a drop indicates a lost CoW path.
- Benchmarks in the README/docs come from a Benchmarks workflow run (node v24, `BENCH_N=50 000`, medians over complete rotations of the candidate order), cited by run id next to each table. When re-measuring, replace the tables and the run id rather than adding new tables, and move the superseded table to the CHANGELOG.
- ArkType is a first-class column of `bench-v4`, not a reference line: every scenario either measures an ArkType schema built to the same constraints as the zod schema (checked before timing by the equivalence gate in `packages/bench-v4/gates.ts`, valid and invalid fixtures, outputs compared) or prints `N/A — <reason>`. Never weaken the ArkType schema to fill a cell, never label a hand-written validator "ArkType", and keep non-equivalent references (such as the S5 instanceof-only Map/Set schema) out of the ratios. Where an ArkType keyword accepts a superset of the zod constraint (`string.email`, `string.date.iso`), the zod pattern goes in as an ArkType regex constraint so the accepted sets match; where the keyword differs in unit or range (`string <= n` counts UTF-16 units where `.max(n)` counts code points, `number` accepts ±Infinity where `z.number()` does not), the zod rule is reproduced through ArkType's public API (a union with a code-point predicate on the overflow branch, a finite range through the range API) and the gate carries a boundary fixture for it. A known semantic divergence (present-undefined defaults, tuple optional slots) is declared on the fixture. The same rules apply to any further external baseline.
- Architecture changes to the zod4 line belong in `docs/ARCHITECTURE-z4.md` (English, with the same change applied to `docs/ARCHITECTURE-z4.zh-CN.md` in the same PR). User-facing changes (API, supported features, benchmark tables) go into both READMEs and the `Unreleased` section of `CHANGELOG.md`; install, usage, API and peer-policy text goes into `packages/zod-cow-v4/README.md` only, with the root READMEs linking to it.
- A change to `tests/harness.ts` in one line package must be applied to the other copy in the same PR (`pnpm run check:harness`).
- Anything that changes what `zod-cow-v4` ships (`exports`, `files`, the build config, `engines`) must keep `pnpm run smoke:pack` green; extend the smoke when a new promise is made to consumers.

## Non-code artifacts

Anything a task produces that is not code (design docs, specs, plans, research notes, assessments) must end up on GitHub. A copy on disk alone does not count.

- Write non-code artifacts in English (see the Language rule above).
- Post the artifact as a comment on the relevant issue. If the work has no issue yet, create one first; if the artifact is about changes already under review, post it to the PR instead.
- Post the full content, not a summary or a file path. Several child repos keep planning notes in gitignored local directories (for example `__ref__/plan/` in `ltbase.api`, see #497); a local working copy is fine, but it is invisible to everyone else and does not survive the branch.
- Do not force-add gitignored planning files to make them shareable. The issue comment is the sharing mechanism.
- Say in the comment which artifact it is and where the working copy lives, so a later reader knows whether they are looking at a plan, a spec, or a review.
- Anything that must become a durable repository convention still belongs in that repo's `docs/` (an ADR, runbook, or reference page). The issue comment records the thinking; `docs/` records the decision.

## PR rules

- Do not merge a PR unless I explicitly ask you to.
- When reviewing a PR, post everything (findings, spec and standards checks, assessment, observations, verification, summary) as one comment on the PR.
- When I ask you to merge a PR, squash-merge by default unless I ask for something else.
- After a PR is merged, clean up local branches and worktrees, fast-forward main, then update and close related issues.

## Git conventions

Never include AI attribution in commit messages, PR titles, or PR descriptions, in any form. That means no

- `Co-Authored-By: Claude`
- `Generated with ...` footers
- sign-offs or footers naming an LLM or AI agent (OpenAI, GPT, Claude, Anthropic, and the like)
- `Claude-Session:` trailers or session URLs (`https://claude.ai/code/session_...`), even when a tool inserts them automatically

When squash-merging, write a clean commit message that describes only the change itself.
