# Upstream issue draft for zod

> **Maintainer notes (not part of the issue).** The body below can be pasted as is into a new issue on colinhacks/zod.
> Suggested title: `[v4] Promote the internal JIT compiler (compileFn / assertOnly) to a public, supported API`
>
> Sources: `docs/ARCHITECTURE-z4.md` (architecture document), `bench/bench-z4.ts` (reproducible benchmarks),
> `tests/differential-z4.test.ts` (50 000-case differential suite).
> Data anchor: zod 4.5.4, node v24.19.0, `--expose-gc`, median of 3 runs, 500 000 records.
> If upstream would rather fix the bug first, the runtime quirk in the "Bonus" section can be filed as a separate issue.

---

## [v4] Promote the internal JIT compiler (compileFn / assertOnly) to a public, supported API

### Summary

Zod 4 ships a production-grade JIT compiler for schemas — `src/v4/core/compile.ts` (~2.2k lines), already powering the `zod/compile` side-effect entry. It is however only reachable through the `zod/v4/core` internal re-export path and carries no stability guarantee. We built a Copy-on-Write (CoW) compilation layer on top of it ([zc-z4](#what-we-built--measured)) and found the compiler's surface to be *exactly* what third-party tooling needs. We're asking for `compileFn` (and a small, closed set of companions) to be promoted to a documented, semver-supported public API.

### Motivation

The interpreter (`schema.safeParse`) always rebuilds the entire output tree — even when validation passes and nothing changed. Three classes of tooling need *programmable* access to the parse outcome, not just the final value:

1. **Structural-sharing / CoW parse layers.** Compilers emit "unconditional new containers" (`const out = {...}`, `new Array(n)`). A thin layer that rewrites container emission into "compare child outputs by reference; copy only when something actually changed" gets large wins for free (benchmarks below). This is impossible to build without the compiled artifacts.
2. **Validation-only data channels.** The `assertOnly` artifact validates the full tree and skips output construction entirely — ideal for request validation, form validation, and column-level checks in table UIs, where the input object is often reused as-is.
3. **Async trees.** Stock async parse walks the schema interpretively with per-node promise allocation. A compiled skeleton that `await`s black-box islands only where async actually lives, and stays synchronous-by-reference everywhere else, measured 2.43x on 50k rows with 74% less allocation pressure.

### What exists today

`zod/v4/core` re-exports the compiler, so the surface is *de facto* reachable, but:

- it is documented as internal (comments in `compile.js` say so);
- `z.compile()` (the `zod/compile` entry) only installs a `globalConfig.postProcessor` shim — it does not hand the compiled function to the caller;
- nothing pins the artifact contract (`out | INVALID | true`), the error classes, or `assertOnly` behavior across releases.

Everything below is verified against **zod 4.5.4**.

```ts
import {
  compileFn,                   // (schema, { assertOnly?, debug? }) => (input) => out | INVALID | true
  INVALID,                     // Symbol.for("zod.compile.invalid") failure sentinel
  ZodCompileUnsupportedError,  // compile refusal: recursion, __proto__, exotic checks…
  ZodCompileAsyncError,        // async refine/transform on the synchronous fast path
  regexes, util,               // number-key retry regex, isPlainObject guard, etc.
} from "zod4/v4/core";         // internal path — no stability guarantee
```

Three artifact contracts we rely on:

| Artifact | Signature | Semantics |
|---|---|---|
| parser | `(input) => out \| INVALID` | stock zod semantics (validate + transform + unconditional new containers) |
| validator (`assertOnly: true`) | `(input) => true \| INVALID` | full validation semantics, **output construction skipped** |
| runtime island | `(input) => out \| INVALID` | black-box `_zod.run({ value, issues: [] }, {})` for subtrees the compiler refuses |

### What we built & measured

zc-z4: a CoW *post-processor* over the official compiler — purity analysis picks official artifacts per subtree; the layer itself only emits container skeletons (object/array/tuple/record/map/set) that replace "unconditional new container" with "reference-compare dirty signal + copy on first forced write". Any `INVALID` falls back to stock `safeParse`, so issues/path/ZodError semantics are 100% stock. 50k-case randomized differential testing against stock: 0 divergences.

Node v24, `--expose-gc`, median of 3 passes, 500k records (`BENCH_N` adjustable):

| Scenario | stock zod4 | official parser (JIT) | **zc-z4 (CoW)** | stock/z4 | JIT/z4 | allocation (stock → z4) | retained after GC |
|---|---|---|---|---|---|---|---|
| S1 pure objects | 654ms | 263ms | **283ms** | 2.31x | 0.93x | 162MB → 30.5MB | 123MB → **0** |
| S2 dirty 10% (default inject) | 619ms | 363ms | **247ms** | 2.50x | 1.47x | 149MB → 41.6MB | 123MB → 10.3MB* |
| S5 record+map+set | 922ms | 681ms | **353ms** | 2.61x | 1.93x | 256MB → 38MB | 217MB → **0** |
| S6 tuple | 508ms | 340ms | **111ms** | 4.57x | 3.06x | 214MB → 15.3MB | 206MB → **0** |
| S7 async transform (50k rows) | 262ms | (unsupported) | **105ms** | 2.50x | — | 95.6MB → 34.9MB | — |
| validate fast path (per-account) | 219ms | — | **50ms** | 4.4x | — | — | — |

\* S2 retains 10.3MB because the injected `default("viewer")` values are genuinely new strings the caller didn't have.

Takeaway: the deeper/heavier the containers, the larger the share of output construction in stock — and the larger the CoW dividend. Tuple was the biggest surprise (3.06x over the official parser) because numeric tuples reconstruct `new Array` on every parse yet almost never change.

### The internal surface we depend on

| API | Used for | Drift risk |
|---|---|---|
| `compileFn(schema, { assertOnly, debug })` | leaf/subtree artifacts | low (signature), behavior guarded by differential tests |
| `INVALID` sentinel | failure protocol | very low (`Symbol.for`) |
| `ZodCompileUnsupportedError` / `ZodCompileAsyncError` | degradation decisions; the latter doubles as our **async-subtree detector** | low |
| `$ZodAsyncError` | official semantics for "Promise reached a synchronous fast path"; our sync API throws it for async skeletons | low |
| `regexes.number`, `util.isPlainObject` | record skeleton (100% official semantics for numeric-key retry / plain-object guard) | low |
| semantic predicates copied from source: `fastPathAcceptsAbsence`, `dropsWhenAbsent`, `getTupleOptStart`, `WHEN_DEFAULTED_CHECKS` | purity analysis & tuple tail semantics | **medium** — must be re-synced if zod changes `when`/optin-optout semantics |

Our mitigation is a strict degradation chain (any drift degrades to stock, never to wrong results) plus the 50k-case differential suite as an upgrade gate — but a public guarantee would remove the entire class of risk.

### Proposal

1. Export from `zod` (or a documented `zod/compile` entry):

```ts
export declare function compileFn(
  schema: $ZodType,
  opts?: { assertOnly?: boolean; debug?: boolean },
): (input: unknown) => unknown; // out | INVALID | true (assertOnly)

export declare const INVALID: unique symbol;
export class ZodCompileUnsupportedError extends Error { /* ... */ }
export class ZodCompileAsyncError extends Error { /* ... */ }
```

2. Document the artifact contract (`out | INVALID | true`) and the two option flags.
3. SemVer: signature stable within minors; behavior changes only in majors.
4. *(Optional, if cheap)*: export the handful of semantic predicates third parties currently copy-paste — `fastPathAcceptsAbsence`, `dropsWhenAbsent`, `WHEN_DEFAULTED_CHECKS` — so downstream layers can track semantics by import instead of by forked source.

This is deliberately minimal: the compiler keeps evolving behind the same facade, and `zod/compile` continues to work exactly as today. We're only asking that the *existing* surface stop being internal.

### Bonus: a runtime quirk we found while fuzzing async tuples

While extending our differential suite to async trees, we hit a deterministic output-shape bug in the **runtime interpreter** (not the compiler — the compiler rejects async today, which is why this never surfaced). Posting it here since it may be a two-line fix and it's adjacent to this proposal.

```ts
import { z } from "zod";
const S = z.tuple([z.string()], z.boolean().nullable().refine(async (v) => v !== "forbidden"));
const r = await S.safeParseAsync(["a", null, null]);
console.log(Object.getOwnPropertyNames(r.data).join(",")); // "0,2,length" — slot 1 is a HOLE
// expected: "0,1,2,length" with values ["a", null, null]
```

`$ZodTuple`'s rest loop pushes `result.then((r) => handleTupleResult(r, payload, i))` for async rest elements, but the element writes then land on the output array **out of order** (microtask resolution order): slot 2 resolves first, materializing `value[2] = null` (length 3), and by the time `handleTupleResults` fills the fixed slots, slot 1 never receives its own-key write — the `null` from the input is lost into a hole. Deterministic across runs (V8/node 24); sync rest parses correctly.

Reproduction, differential suite, and benchmarks: `cow-zod-prototype` (local project), zod 4.5.4, node v24.19.0.

### Compatibility & risk

- The compiler is already load-bearing for `zod/compile`; promoting it formalizes what exists rather than adding surface.
- All failure modes are throws (`ZodCompileUnsupportedError` / `ZodCompileAsyncError`), never silently wrong results — safe to build on.
- Our differential methodology (random schema generator, 50k cases: success parity + `deepStrictEqual` outputs + input-mutation checks + reference-sharing rate, `REPRO=seed:case` hooks) is available if it's useful for the repo's own compile tests.

---

### Appendix: draft self-check (for the maintainer, not submitted with the issue)

- [x] Every benchmark number is reproducible from `bench/bench-z4.ts` (all scenarios S1 to S7)
- [x] The dependency table matches `docs/ARCHITECTURE-z4.md` §9, including `getTupleOptStart` / `dropsWhenAbsent` introduced by the tuple skeleton (v0.5)
- [x] The minimal reproduction of the quirk in the "Bonus" section was verified in a `node` REPL of this project (ownKeys is stably "0,2,length", sync rest parses correctly)
- [x] Tone: a request to promote an existing surface plus an attached bug report, not a wish list; the proposed API shape is deliberately minimal
- [ ] Before submitting: check whether colinhacks/zod already has an issue or PR about `zod/compile`, and reference and extend it rather than opening a duplicate
