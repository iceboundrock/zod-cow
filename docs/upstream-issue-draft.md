# Upstream issue draft for zod

> Maintainer notes (not part of the issue). The body below can be pasted as is into a new issue on colinhacks/zod.
> Suggested title: `[v4] Promote the internal JIT compiler (compileFn / assertOnly) to a public, supported API`
>
> Sources: `docs/ARCHITECTURE-z4.md` (architecture document), `bench/bench-z4.ts` (reproducible benchmarks),
> `tests/differential-z4.test.ts` (50 000-case differential suite).
> Data anchor: zod 4.5.4, node v24.19.0, `--expose-gc`, median of 3 runs, 500 000 records.
> If upstream would rather fix the bug first, the runtime quirk in the "Bonus" section can be filed as a separate issue.

---

## [v4] Promote the internal JIT compiler (compileFn / assertOnly) to a public, supported API

### Summary

Zod 4 ships a JIT compiler for schemas in `src/v4/core/compile.ts` (about 2.2k lines). It already powers the `zod/compile` side-effect entry, but it is only reachable through the `zod/v4/core` internal re-export path and carries no stability guarantee. We built a Copy-on-Write (CoW) compilation layer on top of it ([zc-z4](#what-we-built--measured)), and the surface it exposes turned out to be what such a layer needs. We are asking for `compileFn`, plus a small, closed set of companions, to become a documented, semver-supported public API.

### Motivation

The interpreter (`schema.safeParse`) always rebuilds the entire output tree, even when validation passes and nothing changed. Three kinds of tooling need programmable access to the parse outcome rather than only the final value:

1. Structural-sharing (CoW) parse layers. The compiler emits unconditional new containers (`const out = {...}`, `new Array(n)`). A thin layer that rewrites container emission into "compare child outputs by reference and copy only when something changed" gets the gains shown in the benchmarks below, and it cannot be built without access to the compiled artifacts.
2. Validation-only paths. The `assertOnly` artifact validates the full tree and skips output construction. That suits request validation, form validation and column-level checks in table UIs, where the input object is usually reused as is.
3. Async trees. Stock async parse walks the schema interpretively and allocates a promise per node. A compiled skeleton that `await`s black-box islands only where the async code lives, and keeps synchronous reference comparison everywhere else, measured 2.43x on 50k rows with 74% less allocation pressure.

### What exists today

`zod/v4/core` re-exports the compiler, so the surface is reachable in practice, but:

- it is documented as internal (comments in `compile.js` say so);
- `z.compile()` (the `zod/compile` entry) only installs a `globalConfig.postProcessor` shim and does not hand the compiled function to the caller;
- nothing pins the artifact contract (`out | INVALID | true`), the error classes, or `assertOnly` behavior across releases.

Everything below is verified against zod 4.5.4.

```ts
import {
  compileFn,                   // (schema, { assertOnly?, debug? }) => (input) => out | INVALID | true
  INVALID,                     // Symbol.for("zod.compile.invalid") failure sentinel
  ZodCompileUnsupportedError,  // compile refusal: recursion, __proto__, exotic checks…
  ZodCompileAsyncError,        // async refine/transform on the synchronous fast path
  regexes, util,               // number-key retry regex, isPlainObject guard, etc.
} from "zod4/v4/core";         // internal path, no stability guarantee
```

Three artifact contracts we rely on:

| Artifact | Signature | Semantics |
|---|---|---|
| parser | `(input) => out \| INVALID` | stock zod semantics (validate + transform + unconditional new containers) |
| validator (`assertOnly: true`) | `(input) => true \| INVALID` | full validation semantics, output construction skipped |
| runtime island | `(input) => out \| INVALID` | black-box `_zod.run({ value, issues: [] }, {})` for subtrees the compiler refuses |

### What we built & measured

zc-z4 is a CoW post-processor over the official compiler. A purity analysis picks an official artifact for each subtree. The layer itself only emits container skeletons (object, array, tuple, record, map, set) in which the unconditional new container is replaced by a reference comparison that acts as the dirty signal, with a copy made on the first forced write. Any `INVALID` falls back to stock `safeParse`, so issues, paths and `ZodError` behave as in stock. A randomized differential run of 50k cases against stock found 0 divergences.

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

The deeper and heavier the containers, the more of stock's time goes into output construction, and the more CoW saves. Tuple was the biggest surprise (3.06x over the official parser): numeric tuples get a `new Array` on every parse yet almost never change.

### The internal surface we depend on

| API | Used for | Drift risk |
|---|---|---|
| `compileFn(schema, { assertOnly, debug })` | leaf/subtree artifacts | low (signature), behavior guarded by differential tests |
| `INVALID` sentinel | failure protocol | very low (`Symbol.for`) |
| `ZodCompileUnsupportedError` / `ZodCompileAsyncError` | degradation decisions; the latter doubles as our async-subtree detector | low |
| `$ZodAsyncError` | official semantics for "Promise reached a synchronous fast path"; our sync API throws it for async skeletons | low |
| `regexes.number`, `util.isPlainObject` | record skeleton (100% official semantics for numeric-key retry / plain-object guard) | low |
| semantic predicates copied from source: `fastPathAcceptsAbsence`, `dropsWhenAbsent`, `getTupleOptStart`, `WHEN_DEFAULTED_CHECKS` | purity analysis & tuple tail semantics | medium: must be re-synced if zod changes `when`/optin-optout semantics |

We mitigate this with a strict degradation chain, where any drift degrades to stock rather than to wrong results, and with the 50k-case differential suite as an upgrade gate. A public guarantee would remove that class of risk.

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
3. Semver: keep the signature stable within minors and change behavior only in majors.
4. Optional, if cheap: export the handful of semantic predicates third parties currently copy (`fastPathAcceptsAbsence`, `dropsWhenAbsent`, `WHEN_DEFAULTED_CHECKS`) so downstream layers can track semantics by import instead of by forked source.

The proposal is small on purpose. The compiler keeps evolving behind the same facade, `zod/compile` keeps working as it does today, and the only change is that the existing surface stops being internal.

### Bonus: a runtime quirk we found while fuzzing async tuples

While extending our differential suite to async trees, we hit a deterministic output-shape bug in the runtime interpreter. The compiler rejects async today, so it never surfaced there. We are posting it here because it may be a two-line fix and it sits next to this proposal.

```ts
import { z } from "zod";
const S = z.tuple([z.string()], z.boolean().nullable().refine(async (v) => v !== "forbidden"));
const r = await S.safeParseAsync(["a", null, null]);
console.log(Object.getOwnPropertyNames(r.data).join(",")); // "0,2,length": slot 1 is a hole
// expected: "0,1,2,length" with values ["a", null, null]
```

`$ZodTuple`'s rest loop pushes `result.then((r) => handleTupleResult(r, payload, i))` for async rest elements, so the element writes land on the output array in microtask resolution order rather than index order. Slot 2 resolves first and materializes `value[2] = null`, giving the array length 3. By the time `handleTupleResults` fills the fixed slots, slot 1 never receives its own-key write, and the `null` from the input becomes a hole. This is deterministic across runs (V8/node 24). A sync rest element parses correctly.

Reproduction, differential suite, and benchmarks: `cow-zod-prototype` (local project), zod 4.5.4, node v24.19.0.

### Compatibility & risk

- The compiler is already load-bearing for `zod/compile`; promoting it formalizes what exists rather than adding surface.
- All failure modes are throws (`ZodCompileUnsupportedError` / `ZodCompileAsyncError`) rather than silently wrong results, which makes the surface safe to build on.
- Our differential setup (a random schema generator, 50k cases checking success parity, `deepStrictEqual` outputs, input mutation and the reference-sharing rate, with `REPRO=seed:case` hooks) is available if it is useful for the repo's own compile tests.

---

### Appendix: draft self-check (for the maintainer, not submitted with the issue)

- [x] Every benchmark number is reproducible from `bench/bench-z4.ts` (all scenarios S1 to S7)
- [x] The dependency table matches `docs/ARCHITECTURE-z4.md` §9, including `getTupleOptStart` / `dropsWhenAbsent` introduced by the tuple skeleton (v0.5)
- [x] The minimal reproduction of the quirk in the "Bonus" section was verified in a `node` REPL of this project (ownKeys is stably "0,2,length", sync rest parses correctly)
- [x] Tone: a request to promote an existing surface plus an attached bug report, not a wish list; the proposed API shape is deliberately minimal
- [ ] Before submitting: check whether colinhacks/zod already has an issue or PR about `zod/compile`, and reference and extend it rather than opening a duplicate
