# cow-zod-prototype

[![CI](https://github.com/iceboundrock/zod-cow/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/iceboundrock/zod-cow/actions/workflows/ci.yml)

English | [简体中文](README.zh-CN.md)

A prototype **Copy-on-Write (CoW) compilation layer for Zod schemas**, grown out of the [Numeric fork](https://numeric.substack.com/p/how-we-doubled-zod-performance-to) idea.

`compile(schema)` returns a fast parser whose output is `===` the input reference whenever nothing was forced to change (no default, transform, strip, coerce, catch, preprocess or pipe fired). When something did change, only the path from that leaf to the root is copied; every sibling subtree keeps sharing the input.

**The difference from the Numeric fork**: Numeric made `parse` return the original object by deleting seven features (`default / transform / coerce / catch / pipe / preprocess / intersection`). This prototype keeps all of them. It uses **reference comparison as the dirty signal and copies on demand**, so the copy happens only at the point where a new value was actually produced at runtime.

- No fork of zod and no change to the Zod API: schemas are consumed as they are (the `.def` tree is read), type inference stays `z.infer`.
- Shape, keys and checks are resolved once at compile time into specialized validation code.
- **The input is never altered**: nothing is mutated in place. The Numeric fork's strip deletes extra keys on the input object; that footgun is fixed here.
- Failure paths carry no issue data of their own: the compiled function returns a sentinel and the caller falls back to stock `safeParse` for the full `ZodError`.

## Two compiler lines

| Line | Entry | Engine | Status |
|---|---|---|---|
| **zod4** | `src/index-z4.ts` → `src/cow4/` | Reuses zod4's **official JIT codegen** (`compileFn` / `assertOnly`) as the semantic backend and adds CoW container skeletons for object, array, tuple, record, map and set, plus async support | **Active line**, all new work goes here |
| zod3 | `src/index.ts` → `src/compile.ts` | Hand-written closure-tree compiler; string format regexes copied verbatim from zod 3.24.1 | **Frozen reference implementation**: the origin of the CoW idea and a comparison baseline, kept passing but not extended |

zod 3 and zod 4 are installed side by side: `import { z } from "zod"` is 3.24.1, `import { z } from "zod4"` is the npm alias for zod@4.5.4. The two lines share no code. An earlier self-written zod4 front-end (v0.2) was replaced by the current zod4 line and removed; its findings are recorded in the [CHANGELOG](CHANGELOG.md#020).

## Quick start

Requires Node.js >= 22.13.0 and pnpm 11.24.0.

```bash
pnpm install
pnpm run test:z4     # zod4 line: version canary + smoke tests + 20 000-case differential fuzz against stock zod4
pnpm test            # zod3 line: 27 unit tests + 20 000-case differential fuzz against stock zod3
pnpm run bench:z4    # zod4 benchmark, 500 000 records (needs node --expose-gc, already in the script)
pnpm run bench       # zod3 benchmark
pnpm run probe:z4    # survey stock zod4 def structure and behavior
pnpm exec tsx examples/demo.ts   # 60-second demo of the three CoW promises (zod3 line)
```

Environment knobs: `SEEDS` / `CASES` set the differential fuzz size (default 200 × 100), `REPRO=seed:case` re-runs one failing zod4 differential case and dumps the schema, input and generated code, `BENCH_N` sets the benchmark record count.

> **CI benchmark runs are smoke results, not reference numbers.** The
> [Benchmarks workflow](https://github.com/iceboundrock/zod-cow/actions/workflows/bench.yml)
> runs `bench:z4` and `bench` manually (or weekly) with a reduced `BENCH_N`
> (default 50 000) and prints the tables in the job summary. It exists to catch
> broken bench scripts and to show a rough shape without cloning; GitHub-hosted
> runners are too noisy for the numbers to be compared across runs. All numbers
> in this README and in `docs/` come from local runs (node v24, 500 000 records).

## Usage

### zod4 line

```ts
import { z } from "zod4";                       // zod@4.5.4 through the npm alias
import { compile } from "./src/index-z4.js";

const User = z.object({
  id: z.number().int(),
  name: z.string(),
  role: z.enum(["admin", "member", "viewer"]).default("viewer"),
});

const fast = compile(User);

fast.parse(data);           // CoW: === the input reference when clean, otherwise only the dirty path is copied
fast.safeParse(data);       // non-throwing; the failure path is stock safeParse, so issues/ZodError are official
fast.validate(data);        // validation only (official whole-tree assertOnly product): the input reference on success, null on failure
await fast.parseAsync(data);     // async variants; the only usable entry when the schema holds an async refine/transform
await fast.safeParseAsync(data);
fast.async;                 // true = the skeleton holds an async subtree; the sync API then throws $ZodAsyncError, as stock does
fast.stock;                 // true = this layer gave up on the whole tree and everything goes through stock (never a semantic loss)
fast.code;                  // generated CoW skeleton source, for debugging (null when degraded to stock)
```

### zod3 line

```ts
import { z } from "zod";                        // zod@3.24.1
import { compile } from "./src/index.js";

const fast = compile(User);

fast.parse(data);     // CoW semantics as above; throws ZcError with issues on failure
fast.validate(data);  // same runtime as parse, typed as DeepReadonly<User>
fast.safeParse(data); // non-throwing
fast.pure;            // static purity: true means success always returns the input reference
```

## The CoW invariant

Every compiled node is `(input) => output | FAILED-sentinel`. No "change notification" protocol is needed:

| Input type | Dirty signal |
|---|---|
| Primitives (string, number, bigint, …) | Value comparison: `'  x '.trim() !== '  x'` is dirty; `'x'.trim() === 'x'` is clean, zero copy |
| object / array / tuple / record / Map / Set | Reference comparison: a child returning the input reference means "unchanged", so the parent does not copy |
| default / transform / coerce / catch / preprocess / pipe | Return a new value, which the parent notices through `outVal !== inVal` |

A parent does its **first** shallow copy (`{...input}` / `slice()` / `new Map(input)`) at the first changed child and writes further dirty children into that copy. Siblings keep sharing. This is the path copying of persistent data structures: changing one leaf copies exactly the path from that leaf to the root. Cost model: expected allocations ≈ Σ P(node is dirty) × depth; the worst case is a full rebuild (stock behavior), the typical case is about zero.

### When a copy is forced

| Feature | Copies when |
|---|---|
| string / number / boolean / bigint / date / literal / enum / instanceof, refine (pure predicate), optional / nullable / readonly / any / unknown | **Never** |
| object / array / tuple / record / map / set | Never while every child is unchanged: the **input reference** is returned |
| union / discriminatedUnion | Never while the matching branch returns its input |
| default | Only when `undefined` is actually replaced |
| transform / preprocess / pipe / catch | Only when a new value is actually produced at runtime |
| strip (default object mode) | Only when the input **really has** extra keys (zero-allocation `for...in` plus `Set` probe) |
| strict / passthrough | Never (strict fails on extra keys) |
| `.trim()` / `.toLowerCase()` / `.toUpperCase()` | Only when the value actually changes (value comparison) |

Consequences that constrain every change:

- Never mutate the input. Strip must never `delete` on the input object.
- Output may alias input, so refines must not mutate, and `readonly` freezing is applied to shared structure.
- Failure paths return the sentinel; the caller falls back to stock `safeParse` for the full `ZodError`.

## How the zod4 line stays aligned with stock

The zod4 line does not re-implement zod's semantics. zod4 (>= 4.1) ships a JIT compiler (`src/v4/core/compile.ts`) whose products are reused per subtree:

1. **Official products as leaves and subtrees.** `compileFn(schema)` gives a stock-semantics parser; `compileFn(schema, {assertOnly: true})` gives a validator that skips output construction.
2. **Purity analysis** is a conservative whitelist deciding "validation passes ⇒ output === input". Pure subtrees get the official validator, impure subtrees get the official parser plus a reference comparison.
3. **Container skeletons** are string-templated codegen that mirrors zod's own `generate*` functions line by line, then rewrites the unconditional `const out = {...}` into "compare references, copy on first dirt, `return input` when clean". Container-level checks (`min` / `max` / `refine`) run on the final output on both paths.
4. **Async**: async subtrees become async islands, every product call site emits `await`, and the skeleton becomes an async function. The sync API on an async product throws `$ZodAsyncError`, same as stock.
5. **Degradation chain**, per subtree, never trading correctness: CoW skeleton → official validator (pure leaf) → official parser (impure subtree) → runtime island (`_zod.run` black box) → whole-tree stock `safeParse` (`compiled.stock === true`).

The layer depends on zod4 internals (`compileFn`, `INVALID`, the compile error classes from `zod4/v4/core`) and on a few hand-copied predicates. It is anchored to **zod 4.5.4**: `tests/canary-z4.test.ts` asserts the stock behaviors the compiler assumes, so an upgrade turns the tests red instead of drifting silently. [docs/upstream-issue-draft.md](docs/upstream-issue-draft.md) asks zod upstream to make that surface public.

The zod3 line aligns itself with probes instead (`src/probe.ts` measures stock zod3 edge semantics at runtime): absent optional keys are not materialized, present-undefined keys are kept, default values pass the inner validation, issues are collected across sibling fields, `readonly` freezes shallowly.

The full design, with generated code dumped side by side against the official products, is in [docs/ARCHITECTURE-z4.md](docs/ARCHITECTURE-z4.md).

## Benchmarks

zod4 line, v0.5 measurement: 500 000 accounts, node v24.19, `--expose-gc`, median of 3 runs (`pnpm run bench:z4`). "official parser" is zod4's own `compileFn` parser product.

| Scenario | stock zod4 | official parser | **zc-z4 (CoW)** | arktype |
|---|---|---|---|---|
| S1 pure validation | 654 ms | 263 ms | **283 ms** | 144 ms |
| S1 allocation pressure | +160.5 MB | +111.0 MB | **+30.5 MB** | +26.7 MB |
| S1 retained after GC | +123.4 MB | +108.1 MB | **0.0 MB** | 0.0 MB |
| S2 dirty load (10% default injection) | 619 ms | 363 ms | **247 ms** | — |
| S3 sweep, 0% / 25% / 50% / 100% dirty | 622 / 647 / 679 / 660 ms | 391 / 415 / 452 / 449 ms | **245 / 268 / 311 / 404 ms** | — |
| S3 retained after GC | +123.3 MB constant | — | **0 / 20 / 36 / 68.7 MB** | — |
| S4 validate | — | 219 ms (per account) | **50 ms** | 144 ms |
| S5 record / map / set | 922 ms | 681 ms | **353 ms** | — |
| S5 allocation pressure / retained | +256.1 MB / +217.4 MB | +245.3 MB / +217.4 MB | **+38.1 MB / 0.0 MB** | — |
| S6 tuple | 508 ms | 340 ms | **111 ms** | — |
| S6 allocation pressure / retained | +214.0 MB / +206 MB | +202.2 MB / +202 MB | **+15.3 MB / 0 MB** | — |
| S7 async transform (50 000 rows) | 262 ms (safeParseAsync) | compile refused | **105 ms (safeParseAsync)** | — |
| S7 allocation pressure | +95.6 MB | — | **+34.9 MB** | — |

How to read it:

- **Against stock**: 2.31x (S1) to 2.61x (S5) to **4.57x (S6 tuple, the highest)**, and memory retained after GC drops from 123 to 217 MB to zero. Async (S7) is 2.50x.
- **Against the official JIT parser**: level on clean input (S1 0.93x to 1.00x, within run-to-run noise: the output construction the skeleton skips pays for the sub-skeleton calls), and ahead on dirty input (S2 1.47x, S5 1.93x, S6 3.06x) because the default `shallowClone` and the whole-tree rebuild are fixed costs of stock semantics while CoW pays only for the paths that really changed.
- **validate fast path**: the official whole-tree `assertOnly` product does 50 ms / 500 000 = 100 ns per account with zero allocation.
- The +30.5 MB in S1 is short-lived allocation inside the official leaf products (datetime/email format temporaries); the CoW layer itself copies nothing.

The zod3 line measured 4.3 to 5.0x against stock zod 3.24.1 (which still pays the interpreter tax). That table, and the tables of the removed v0.2 front-end and of v0.3, are in the [CHANGELOG](CHANGELOG.md).

## Correctness evidence

- **Differential fuzzing** (`tests/differential-z4.test.ts`): random nested object / array / tuple / record / map / set / union schemas with optional / nullable / default / refine / transform and async refine / transform wrappers, compared against stock zod4 on success parity, `deepStrictEqual` outputs (Map/Set compared as entry sets) and zero input mutation (structuredClone snapshot). The v0.5 run of 50 000 cases had 20 813 successes / 29 187 failures, a top-level reference-sharing rate of **89.1%** on successful cases and 0 stock degradations. The code default is 200 × 100 = 20 000 cases.
- **Smoke tests** (`tests/smoke-z4*.test.ts`): behavior assertions for the original reference, strip, strict, default, transform, nested sharing, array elements, optional, union, the degradation chain, the three record paths, map / set and size checks, tuple truncation / fill / rest / refine, and async through all containers, `lazy(async)` and union async branches.
- **Version canary** (`tests/canary-z4.test.ts`): asserts the stock zod4 behaviors the compiler assumes (default short-circuits, catch does not swallow throws, optional hands undefined to a defaulted inner, …).
- The zod3 line has 27 unit tests plus its own 20 000-case differential fuzzer (`tests/differential.test.ts`), with a top-level reference-sharing rate of about 92%.
- Every one of the purity traps described in the architecture doc was found by the fuzzer, not by reading code. Purity analysis can only be proven complete by fuzzing, which is why any change to the purity rules or a container skeleton must be validated with the differential suite and its reference-sharing rate reported.

## Known limitations (prototype scope)

- **Structural sharing is observable**: parsing the same input twice returns the same reference, and modifying the output modifies the input. The type layer hints at this with `DeepReadonly`; use stock `schema.parse` when an independent copy is needed.
- **Refines must not mutate the input** (the CoW premise); deep-freeze inputs during development to catch violations.
- **Refine side effects on failure**: a failing parse runs the refine callback in the skeleton and again in the stock fallback, so it runs twice. The official `zod/compile` shim has the same semantics.
- **Key order**: pass-through preserves the input's key order; stock rebuilds in shape order (`deepStrictEqual` does not notice, snapshot tools might).
- **Unsupported, with an explicit failure rather than silent drift**:
  - zod4 line: `intersection`, `file` / `templateLiteral` / `promise`, `string_format` without a `pattern` (such as `url`), recursive top-level schemas and schema-level `catchall`. The official `ZodCompileUnsupportedError` makes the tree degrade to stock (`compiled.stock === true`), which is correct but not CoW.
  - zod3 line: `intersection`, `catchall`, tuple rest, `ZodPromise`, async refine. `ZcNotSupportedError` is thrown at compile time.
- **NaN**: `z.nan()` is always judged dirty (`NaN !== NaN`); the output is still correct, at the cost of one extra copy.
- **Symbol keys / getters**: pass-through keeps own enumerable symbol keys visible to spread, a small difference from stock's rebuild.
- **Known stock quirk, deliberately not matched**: with an async rest element and a `null` input in a nullable slot, stock zod4's runtime produces a sparse array and loses the `null`; the skeleton outputs a dense array. The differential generator avoids that combination; the reproduction is in the upstream issue draft.

## Repository layout

```
src/index-z4.ts             zod4 compile() API (active line)
src/cow4/                   zod4 engine: official codegen + CoW container skeletons + async channel
                            (index, product, codectx, predicates, purity, official, emit, emit-{object,array,tuple,record,map,set})
src/probe-z4.ts             zod4 def structure and behavior survey (one-off diagnostics)
src/probe-z4-flags.ts       zod4 semantic canary flags (a version bump raises an alarm)
src/index.ts                zod3 compile() API (frozen reference)
src/compile.ts              zod3 closure-tree compiler
src/internal.ts             zod3 protocol: FAILED sentinel / Ctx / issue helpers / safeSet
src/regexes.ts              verbatim copy of zod 3.24.1's internal format regexes (zod3 line)
src/probe.ts                stock zod3 behavior probes
tests/harness.ts            zero-dependency test harness (test / summary / deepEqual)
tests/canary-z4.test.ts     zod version canary (stock zod4 behavior vs compiler assumptions)
tests/smoke-z4*.test.ts     zod4 behavior assertions (containers / tuple / async)
tests/differential-z4.test.ts   zod4 differential fuzzer (20 000 cases, REPRO hook)
tests/unit.test.ts          zod3 unit tests (27)
tests/differential.test.ts  zod3 differential fuzzer (20 000 cases)
bench/bench-z4.ts           zod4 benchmark (S1 pure / S2 dirty / S3 dirty sweep / S4 validate / S5 containers / S6 tuple / S7 async)
bench/bench.ts              zod3 benchmark (500 000 accounts)
examples/demo.ts            60-second demo
docs/ARCHITECTURE-z4.md     architecture deep dive on the zod4 engine (English source; docs/ARCHITECTURE-z4.zh-CN.md is a frozen Chinese snapshot)
docs/upstream-issue-draft.md   draft issue for zod upstream: make compileFn / assertOnly / INVALID public
CHANGELOG.md                v0.1 to v0.5 history with the historical benchmark tables
```

## Further reading

- [docs/ARCHITECTURE-z4.md](docs/ARCHITECTURE-z4.md): generated code side by side with the official products, the purity whitelist and its three traps, the record / map / set / tuple skeletons, the async channel, the degradation-chain state machine, the version anchor and its risks.
- [CHANGELOG.md](CHANGELOG.md): how the project moved from a self-written zod3 compiler (v0.1) through a self-written zod4 port (v0.2, removed) to the official-codegen reuse (v0.3 to v0.5), with the benchmark table of each step.
- [docs/upstream-issue-draft.md](docs/upstream-issue-draft.md): the case for a public `compileFn` API, plus the zod4 runtime quirk found while fuzzing.
- [AGENTS.md](AGENTS.md): working conventions for contributors and coding agents (commands, module map, version anchoring, PR rules).
