# zc-z4 architecture: self-written codegen vs reusing zod4's official codegen

> Version anchor: zod 4.5.4 · every piece of generated code in this document is a real product dump (`compileFn(schema, {debug:true})` and `compileCowDebug(schema)`).
> Companion code: `packages/zod-cow-v4/src/cow4/` (the current zod4 line, reusing the official compiler; module layout in §11).
>
> v1 is no longer in the repository: the self-written zod4 front-end (at the time `src/compile-z4.ts` + `src/index-z4.ts`) was deleted
> after zc-z4 landed (issue #4). The zc-z4 entry is `packages/zod-cow-v4/src/index.ts` today (it was `src/index-z4.ts` until the package split, #9).
> Every description of v1 in this document, together with its code references and benchmark numbers, is a historical
> comparison, recording the decision path of "why we went from self-written codegen to reusing the official codegen";
> the corresponding source has to be traced back to commits from before the deletion. The only zod4 compile line in the
> current repository is zc-z4.

## TL;DR

The S1 to S7 rows below are the v0.5 local measurement (500 000 accounts, node v24) taken while both front-ends still existed, so the two columns are comparable; the current CI numbers are in §7.

| | v1 (self-written codegen) | zc-z4 (official codegen + CoW decoration) |
|---|---|---|
| Self-written code (physical lines at commit c0453dd, the v0.5 import) | 1271 lines in `src/compile-z4.ts`, reimplementing zod's checks, issues and formats, plus official regexes copied verbatim | 1521 lines in `src/cow4-v2.ts`: purity analysis, 6 container skeletons, async channel, official-product wrappers and predicates copied from zod. After the #20 split, `packages/zod-cow-v4/src/cow4/` (then `src/cow4/`) is 1667 lines across 13 modules |
| Source of semantic correctness | reimplementing zod semantics ourselves (issue/format/check, the whole set) | official compiler + official runtime fallback |
| S1 pure validation (500 000 accounts) | 521ms | **283ms** (~1.0x vs the official parser) |
| S2 dirty load (10% default) | 504ms | **247ms** (1.47x vs the official parser) |
| S5 containers (record/map/set) | not supported | **353ms** (1.93x vs the official parser) |
| S6 tuple | not supported | **111ms** (3.06x vs the official parser) |
| S7 async schema | not supported | **105ms** (2.50x vs stock safeParseAsync) |
| retained after GC | 0MB | **0MB** (the official parser is 108~217MB) |
| following upstream upgrades | a manual semantic sync every time | automatic benefit (official compiler optimizations) |
| risk | semantic drift (regexes / issue format) | dependence on unsupported APIs (the compiler exports of `zod/v4/core`) |

The conclusion: zod4's JIT compiler (`src/v4/core/compile.ts`) is a ready-made semantic backend.
Rather than writing another compiler, the layer uses official products as the leaves and subtrees,
takes over only the containers with the CoW skeleton, and falls back to the stock runtime on any failure.

---

## 1. Background: why there were once two routes

The fork approach in the Numeric article is "cut features to buy performance" (drop 7 features such as default/transform/catch
so the deep copy disappears). The CoW layer (this repository) proves that those 7 features can be kept: reference comparison is
a natural dirty signal. A child returning the original reference means unchanged, returning a new value means changed, and only
at that moment does the parent make its first shallow copy (path-copying).

In the zod3 era this required writing an entire compile layer ourselves (the v1 route). Since zod 4.1 the official project
also shipped a JIT (`import "zod/compile"` or `z.compile()`) and exposed a programmable internal API. That is where the zc-z4
route comes from: do not write a semantic codegen of our own, use the official compiler as a "leaf-level / expression-level" backend.

## 2. The reusable surface of the official codegen (evidence from the source)

The `zod/v4/core` namespace (a public permalink subpath) re-exports everything `compile.js` exports:

```ts
import {
  compileFn,                    // builds a monolithic function (input) => out | INVALID | true
  INVALID,                      // Symbol.for("zod.compile.invalid"), the failure sentinel
  ZodCompileUnsupportedError,   // compile rejection (coerce / recursion / __proto__ / obscure checks...)
  ZodCompileAsyncError,         // async refine/transform (not expressible in the sync fast path)
  regexes,                      // the official regex family (number/uuid/email sources...)
  util,                         // official util (isPlainObject/shallowClone...)
} from "zod/v4/core";
```

Three key product contracts:

| Product | Signature | Semantics |
|---|---|---|
| parser | `(input) => out \| INVALID` | stock zod semantics (validation + transformation + an unconditional new container) |
| validator (`assertOnly: true`) | `(input) => true \| INVALID` | validation semantics complete, **output construction skipped** |
| runtime island | `(input) => out \| INVALID` | a black box calling `_zod.run({value, issues:[]}, {})`, swallows async in a sync context |

Another official mount point is `globalConfig.postProcessor` (the side-effect entry of `zod/compile` installs its shim
there). This layer does not use it (that is the "clone every instance and replace run" route, incompatible with CoW's
"whole-tree product"), but note that the two can coexist: zc-z4's failure fallback calls
`schema.safeParse`, so if the user also enables `zod/compile`, the fallback path automatically enjoys the official JIT.

### 2.1 The real code the official compiler generates for an object (parser mode)

```js
// Constants: INVALID, c0, c1, c2
if (typeof input !== "object" || input === null || Array.isArray(input)) return INVALID;
const v0 = input["a"];
if (typeof v0 !== "string") return INVALID;
const v1 = typeof v0 === "string" && v0.length > 4 ? c0(v0) : v0.length;  // lazy code point scan
if (v1 > 4) return INVALID;
const v2 = input["b"];
if (typeof v2 !== "string") return INVALID;
c1.lastIndex = 0;
if (!c1.test(v2)) return INVALID;                 // email format
const v3 = input["c"];
if (!c2.has(v3)) return INVALID;                  // enum
const v4 = input["d"];
if (!Array.isArray(v4)) return INVALID;
const v5 = new Array(v4.length);
for (let v6 = 0; v6 < v4.length; v6++) {
  const v7 = v4[v6];
  if (typeof v7 !== "number" || !Number.isFinite(v7)) return INVALID;
  if (!Number.isSafeInteger(v7)) return INVALID;
  v5[v6] = v7;
}
const v8 = { "a": v0, "b": v2, "c": v3, "d": v5 };   // <- unconditional new object
return v8;
```

Three things to note: (1) the getter is read exactly once (`const v0 = input["a"]`; the checks and the output assembly do not
trigger it a second time); (2) leaf optimization is fine-grained (`.max(4)` only counts code points for long strings);
(3) output construction is unconditional: even when every child value passes through unchanged, there is still a `new Array`
plus a new object literal. That is the source of stock's allocation pressure (500 000 accounts, +112MB), and it is the only
place CoW needs to "decorate".

### 2.2 The assertOnly product for the same schema

```js
// the same tree, assertOnly: true, the official built-in "pure validator"
if (typeof input !== "object" || input === null || Array.isArray(input)) return INVALID;
const v0 = input["a"];
if (typeof v0 !== "string") return INVALID;
/* ...all validation code kept as is... */
for (let v5 = 0; v5 < v4.length; v5++) { /* element validation */ }
return true;                                      // <- constructs no output at all
```

`assertOnly` cuts output construction away entirely and keeps the validation semantics untouched, which is exactly the product
that a "pure subtree" needs in CoW. Measured (500 000 accounts, assertOnly in a per-account loop): **265ms / +13MB**, against
the parser product's 332ms / +112MB. The net cost of output construction is 67ms plus 99MB of allocation.

### 2.3 The product shape of transform/default/optional

```js
// z.object({ keep: string, role: enum.default("a"), len: string.transform(s=>s.length), opt: number.optional() })
const v1 = input["role"];
let v2 = (() => {
  let v3;
  if (v1 === undefined) { v3 = c1(c0()); }        // shallowClone(defaultValue()), #5855
  else {
    if (!c2.has(v1)) return INVALID;
    v3 = v1 === undefined ? c1(c0()) : v1;        // an inner output of undefined is also replaced by the default
  }
  return v3;
})();
if (v2 === INVALID) return INVALID;
const v4 = input["len"];
if (typeof v4 !== "string") return INVALID;
const v5 = c3(v4);                                 // transform helper (forged payload + issue channel)
if (v5 === INVALID) return INVALID;
const v6 = input["opt"];
let v7 = (() => { /* optional IIFE */ })();
if (v7 === INVALID) {
  if ("opt" in input) return INVALID;              // optout=optional: an absent key is not a failure
  v7 = undefined;
}
const v9 = {};
v9["keep"] = v0;
if (v2 !== undefined || "role" in input) v9["role"] = v2;   // the mayOutputUndefined assembly rule
```

These are exactly the semantics v1 kept tripping over in the differential tests (default short-circuit, absent keys not
materialized, exactOptional, catch constant values, record numeric-key retry, for...in inherited keys, and so on).
zc-z4 lets the official compiler digest all of these details, and the self-written layer only does purity dispatch.
That is why correctness moved ahead while the self-written layer shrank in scope, not in size: measured as physical lines at commit c0453dd the two front-ends were comparable (v1 1271 lines, zc-z4 1521 lines, see §1), but v1's lines reimplement zod semantics and zc-z4's are purity dispatch, skeletons and predicates copied from zod.

## 3. zc-z4's generated code: how the official product gets decorated by CoW

zc-z4's compile-time dispatch (`emitNode`):

```
needsValue && cowSafeContainerForChild(schema)?
  ├─ yes → emitBoxedContainer (unwrap optional/nullable) → one of the six container skeletons
  └─ no  → isPure(schema)?
        ├─ yes → official assertOnly product + return accessor (output === input)
        └─ no  → official parser product (dirty check by reference comparison, performed by the host skeleton)
```

### 3.1 Official object skeleton vs zc-z4 CoW skeleton (the same schema, side by side)

schema: `z.object({ id: number.int(), firstName: string.max(64), email: z.email(), tags: array(string).max(8), address: object({...}) })`

```js
// ═══ zc-z4 CoW skeleton (real dump) ═══
if (typeof input !== "object" || input === null || Array.isArray(input)) return INVALID;
let x0 = false, x1 = false;                                // dirty / extra
const x2 = input["id"];
if (c0(x2) === INVALID) return INVALID;                    // pure leaf key: official assertOnly product
const x3 = input["email"];
if (c1(x3) === INVALID) return INVALID;                    // (email validation lives inside the product)
const x4 = input["tags"];
const x5 = c2(x4);                                         // container key: CoW sub-skeleton product
if (x5 === INVALID) return INVALID;
if (x5 !== x4) x0 = true;                                  // <- reference comparison is the dirty signal
const x6 = input["address"];
const x7 = c3(x6);                                         // same as above (nested CoW)
if (x7 === INVALID) return INVALID;
if (x7 !== x6) x0 = true;
for (const k in input) {
  if (k !== "id" && k !== "email" && k !== "tags" && k !== "address") { x1 = true; break; }
}                                                           // fixed string keys are generated comparisons
const x8 = Object.getOwnPropertySymbols(input);            // the clean path's only allocation: one empty array per object
if (x8.length !== 0) x1 = true;                            // no declared symbols: any own symbol is extra
if (!x0 && !x1) {
  return input;                                            // ═══ the one line the official template does not have ═══
}
const out = { ...input };                                  // copy only when forced: key presence and key order stay faithful
if (x1) {
  for (const k in input) if (k !== "id" && k !== "email" && k !== "tags" && k !== "address") delete out[k];
  for (const s of x8) delete out[s];                       // the same comparisons and the same symbol array decide what to drop
}
return out;
```

Point-by-point correspondence with the official dump:

| Official parser | zc-z4 skeleton | Note |
|---|---|---|
| `const v8 = {...}` unconditionally | `if (!dirty && !extra) return input;` | The CoW core: no copy on clean input; the strip probe's one empty own-symbol array per object is the clean path's only allocation |
| `const v5 = new Array(len)` | (inside the element loop) `out = input.slice()` | Same for arrays: slice only on the first dirt |
| `if (!c1.test(v2)) return INVALID` | same (inside the assertOnly product) | Leaf validation is 100% official |
| (output assembly handles key presence implicitly) | `{ ...input }` | Spread keeps presence and key order faithful naturally |
| `for (const k in …)` unknown probe | generated string comparisons for shapes up to `MAX_INLINE_KEY_COMPARISONS` (16) keys, then a `Set` fallback; the strip deletion path reuses the same predicate and the symbol array the probe read | Same inherited-enumerable semantics with faster monomorphic small-object membership; the `Set` is hoisted only when something references it (large shapes, declared symbol keys), and the cap bounds the generated code size (see the constant's comment for the measurement) |

### 3.2 The container's own checks: the two-path timing

When `.refine()` / `.min()` is attached to a container, the stock semantics is "run the checks on the output after the output
is constructed". zc-z4 compiles the checks into a separate validation subroutine and **calls it on both paths**:

```js
const cChecks = /* the containerChecksFn product */;
if (!x0 && !x1) {
  if (cChecks(input) === INVALID) return INVALID;   // clean: output === input
  return input;
}
const out = { ...input };
/* ...write back / strip... */
if (cChecks(out) === INVALID) return INVALID;       // dirty: aligned with stock's "run the checks on the output"
return out;
```

Supported set: `custom` (the pure predicate in `.refine()`'s `def.fn`) + array's
`min_length/max_length/length_equals` (`.length` read directly) + map/set's
`min_size/max_size/size_equals` (`.size` read directly). Everything else (superRefine rewriting
`ctx.value`, overwrite, a custom `when`) → the whole node degrades to the official parser product.

## 4. Purity analysis: the whitelist and the three traps

Definition: `isPure(schema)` = validation passes ⇒ the output is necessarily `===` the input reference, with no side effects.
A pure subtree goes through the official validator (value = input); anything uncertain is treated as impure (parser product + reference comparison).

| def.type | Verdict | Reason |
|---|---|---|
| string/number/boolean/bigint/symbol/null/undefined/void/nan/date/any/unknown/literal/enum | `leafChecksArePure` | the official product passes the accessor through; checks are the exception, see below |
| optional/nullable | recurse into the inner | the value passes through |
| object/array (own checks safe + the whole subtree pure) | true | the skeleton takes over (strip is handled by the skeleton) |
| record/map/set | true (once the skeleton takes over) | reference comparison of key names and values, see §5 |
| union | all branches pure | branches pass through |
| readonly | **false** | the `Object.freeze` side effect. The official parser then freezes exactly what stock freezes: a new container, or the input itself for a pass-through leaf such as `any` / `unknown` (#28) |
| default/prefault/catch/coerce/transform/pipe/intersection/lazy/custom/nonoptional/success | **false** | value producer / black box / new container |

### Trap one: `overwrite` rewrites values (proved by differential seed=51)

In zod4 `z.string().max(16).toLowerCase()` is an `overwrite` check inside def.checks, not a schema wrapper.
The whitelist judged string pure → the validator passed → `return input` →
stock output "ab1" vs ours "AB1". Fix: leaf purity must inspect the node's own checks.
`overwrite` is always impure; a `custom` check with no `fn` (superRefine can rewrite `ctx.value`) is always impure.

### Trap two: length/size checks carry a default `when` (proved by diagnostic logs)

The check instance for `.max(64)` carries `when: [Function: _whenHasLength]`. The official
`generateChecks` exempts these through the `WHEN_DEFAULTED_CHECKS` whitelist (max_size/min_size/
size_equals/max_length/min_length/length_equals). zc-z4 initially rejected any truthy `when`
as a "custom when" → an array with `.max(8)` was misjudged impure → it went through the parser → a new array per element
→ CoW wiped out entirely (the root cause of the 98MB allocated in S1). Fix: copy the official whitelist verbatim,
`hasCustomWhen = when && !WHEN_DEFAULTED_CHECKS.has(check)`.

### Trap three: `nullable(object)` must be unwrapped (proved by differential seed=104/133/137)

If container recognition only looks at `def.type === "object"`, `nullable(object)` falls into the "pure leaf key" branch
and goes through the official assertOnly. But the official validator skips stripping extra keys (strip is an
output-construction behavior and does not affect whether validation succeeds) → the input's extra keys pass straight through →
divergence from stock. Fix:
`cowSafeContainerForChild` unwraps along the optional/nullable chain, `emitBoxedContainer`
emits the wrapper checks (null→null, undefined→undefined), and once at the container the CoW skeleton takes over.

> Methodology: not one of these three traps was found by reading code; all of them were caught by differential testing
> with random schemas (`REPRO=seed:case` reproduces one in a single command). The completeness of purity analysis can only be
> verified by fuzzing: the whitelist's conservatism of "rather misjudge as impure" plus 50 000 differential cases is the
> safety boundary of this route.

## 5. record/map/set skeletons (added in v0.4, aggressive full coverage)

These three official generators are equally "unconditional new container": record `const v0 = {}`, map
`new Map()` (plus a destructuring allocation per entry), set `new Set()`. The skeleton strategy matches object,
with two extra CoW-specific problems: key names can change (numeric-key retry / key transformation) and key order is declaration-driven.

### 5.1 record: three compile-time paths

```
keyType._zod.values exists and is not partial?
  ├─ yes → Path A: declaration-driven (z.record(z.enum([...]), v))
  └─ no  → is keyType a bare-string (type==="string" && no format && no coerce && no checks)?
        ├─ yes → Path C: key names never change, compare values only
        └─ no  → Path B: keyFast product + numeric-key retry + key-name reference comparison
```

Path C (the most common) generates this skeleton:

```js
if (!c0(input)) return INVALID;                            // util.isPlainObject (the official function of the same name)
let x0 = input, x1 = false;
for (const k of Reflect.ownKeys(input)) {
  if (k === "__proto__") continue;
  if (!c1.call(input, k)) continue;                        // propertyIsEnumerable (same as the official code)
  if (typeof k !== "string") return INVALID;               // the official code rejects symbol keys
  const vIn = input[k];
  const t = cValue(vIn);                                   // value product (validator / parser / CoW sub-skeleton)
  if (t === INVALID) return INVALID;
  if (t !== vIn) {                                         // reference comparison
    if (!x1) { x1 = true; x0 = { ...input }; }
    x0[k] = t;
  }
}
return x0;                                                 // clean → the original reference
```

Path B (numeric-key retry, key names can change): reuses the official `keyFast + regexes.number retry`
template and additionally performs a key-name reference comparison: `outKey !== k` also counts as dirty, and the copy branch does
`delete out[k]; out[outKey] = t;`. In the sub-case where key names do not change (string-format keys such as
`z.record(z.email(), v)`), `outKey === k` always holds and the key-name comparison costs nothing.

Path A (enum, declaration-driven): the official output unconditionally materializes every declared key in declaration order
(a missing key with an optional value → write undefined) + strict rejection of unknown keys. The skeleton:

- a missing declared key is dirty (`!(k in input)` → stock materializes that key);
- the strict rejection of unknown keys is copied verbatim (`for...in → INVALID`);
- in the copy branch, after `{...input}`, every declared key is written back (a validator-product key writes `inVar`; when the key
  is missing, `inVar === undefined` happens to be exactly the stock semantics; a parser-product key writes the product's output value).

Measured semantic anchors: `{a:1}` against `z.record(z.enum(["a","b"]), z.number().optional())`
→ stock materializes `b: undefined` → ours marks it dirty and returns `{a:1, b:undefined}` ✓; an unknown key
`{a:1,b:2,extra:3}` → both sides reject ✓.

### 5.2 map / set

```js
// map: reference comparison on both key and value, new Map(input) on the first dirt
for (const [kIn, vIn] of input) {
  /* pure key: cKey(kIn) validates, the key name never changes (keyExpr = kIn)
     impure key: const ko = cKey(kIn), key-name reference comparison */
  const vo = cValue(vIn);
  if (vo === INVALID) return INVALID;
  if (vo !== vIn || keyExpr !== kIn) {
    if (!x1) { x1 = true; out = new Map(input); }
    if (keyExpr !== kIn) out.delete(kIn);
    out.set(keyExpr, vo);
  }
}
return out;

// set: reference comparison on members, new Set(input) on the first dirt, delete(vIn) + add(vo)
```

- No cost when the key is pure: for a key schema (string/number) the official product passes the original key through →
  `keyExpr === kIn` always holds, and V8 optimizes the key-name comparison away.
- Key transformation stays correct: when the key is a container or a transform (rare), the CoW/parser product returns a new key, and
  `delete(kIn) + set(newKey)` matches stock (stock also sets the transformed key on a Map).
- NaN: `vo !== vIn` is always true for NaN → a false dirty verdict → an over-copy, but the result is correct
  (under SameValueZero `delete/add` is equivalent). This matches the NaN note already in the README.
- Map/Set deepStrictEqual: Node's assert compares Map/Set as entry sets
  (order-independent), so the ordering difference of `delete+set/add` does not affect the differential.

### 5.3 Wiring

- `cowSafeContainerForChild` gains `record/map/set` cases → key positions, element positions and the top level are taken over automatically;
- `emitBoxedContainer` is extended at the end to all six containers → `nullable(record)` / `optional(map)` / `optional(tuple)` work directly;
- `checksAreCowSafe` / `containerChecksFn` gain the size-family checks for map/set;
- value positions all go through `childProduct()` (container → CoW sub-skeleton / pure → validator / impure → parser / async → async island),
  sharing the same selection logic as object key positions and array element positions.

### 5.4 tuple skeleton (added in v0.5)

A line-by-line mirror of the official `generateTupleCheck` (compile.js L1289-1374) plus CoW decoration. Three key semantic mechanisms:

1. optinStart / optoutStart (the official `getTupleOptStart`, copied verbatim): scan from the tail toward the head for the first
   slot that cannot be omitted. The optin ladder has three rungs (`optin !== undefined` is enough to be omissible, covering optional/defaulted),
   optout has two (only `optout === "optional"`). Length guard: `[optinStart, N]` when there is no rest,
   `>= optinStart` when there is.
2. The fillLen variable (invented in this layer): the official code uses the dynamic `out.length` for trailing-slot gating (`if (out.length === i)`),
   but under CoW the output may still be the original input reference (its `.length` must not be read or written), so the logical length
   has to be tracked explicitly.
   Invariant: `out === input ⟹ fillLen === input.length` (the truncate/fill paths always copy first).
3. Three segments: segment 1, `[0, optoutStart)`, the unconditional slots (the official code materializes absent slots all the same: a validator slot writes
   `undefined`, a value slot writes the produced value); segment 2, trailing-slot gating plus three absence branches (`dropsWhenAbsent` → truncate
   / validator → truncate / IIFE → INVALID or undefined truncates, a value fills); segment 3, rest, slot by slot with no gating.
   Truncation has three states: already copied → truncate for real; the original reference and the target length ≠ the input length → copy then truncate;
   target === the input length → output === input, zero operations
   (the case where a trailing optional truncates to the input length can keep the original reference).

The case with the biggest gain: an all-numeric, all-clean tuple. stock does `new Array` plus a per-slot write every time, while CoW copies nothing
(S6 in run 33936127958: 4.37x vs stock / 1.75x vs the official parser; ArkType is ahead here at 0.61x, see §7).

### 5.5 async channel (added in v0.5)

Design premise: the official compileFn always throws `ZodCompileAsyncError` for async (refine/transform/custom/superRefine/pipe, 6
`isAsyncFunction` detection points in total), which is exactly a ready-made "subtree async detector".
This layer turns "async detected → degrade the whole tree" into "convert in place to an async island + a local await in the skeleton":

1. async island: `makeAsyncIsland(schema)` = an async black box returning `Promise<output | INVALID>`,
   and the product carries the `ZC_ASYNC` symbol marker.
2. await emission: every product call site (object keys / array elements / tuple slots / record values / map keys and values / set members /
   the async refine predicate of container checks) checks `isAsyncProduct(fn)` → emits `await` and sets `ctx.async = true`.
3. making the skeleton async: `buildFn` decides between `async (input) =>` and `(input) =>` based on `ctx.async`,
   and the product carries `ZC_ASYNC` so a sub-skeleton's parent notices automatically (`childProduct` returns `kind: "async"`).
4. public API: `Compiled` gains `async: boolean`, `parseAsync` / `safeParseAsync`;
   under an async skeleton the sync API throws `$ZodAsyncError` (the same semantics as the official code; measured, a sync parse on an async tree does throw).
5. plugging the lazy(async) hole: the official product for lazy is a runtime island, so an inner async raises no compile-time error →
   the Promise would leak out silently. `subtreeHasAsync` detects it statically (recursion over the def tree, covering the fn/superRefine of checks,
   the transform of pipe, and expansion of the lazy getter, with a seen set to prevent cycles) → an async lazy goes through an async island instead.

A semantic the layer preserves: a sync island (`makeIsland`) throws `$ZodAsyncError` when it meets a Promise (the same comment as the official
compile.js `throwAsync`: returning INVALID would be read by a union as a branch rejection, so the throw must survive).

In a mixed tree only the async subtree positions pay the microtask cost, everything else keeps the reference-comparison skeleton
(S7 in run 33936127958: an async transform scenario over 5 000 rows, 1.60x vs stock safeParseAsync, allocation -27%; 2.67x in the earlier run 33837195401, both inside runner noise at that row count).

## 6. Degradation chain state machine

```
compile(schema)
  │
  ├─ compileCowFn (whole-tree skeleton compilation)
  │     ├─ emitBoxedContainer ── cowSafeContainerForChild (unwrap + checks safe)
  │     │     ├─ object/array/tuple/record/map/set skeletons
  │     │     │     ├─ pure leaf → officialFn (assertOnly product)
  │     │     │     │     └─ generation failed → officialFn(parser) → island
  │     │     │     ├─ impure subtree → officialFn (parser product)
  │     │     │     │     ├─ generation failed → makeIsland (black-box _zod.run, throws $ZodAsyncError on a Promise)
  │     │     │     │     └─ ZodCompileAsyncError → makeAsyncIsland (await channel) ★v0.5
  │     │     │     ├─ container subtree → subFn recursion (a seen set prevents circular references)
  │     │     │     │     └─ the sub-skeleton is itself async → kind:"async", the parent position emits await ★v0.5
  │     │     │     └─ async subtree → makeAsyncIsland + ctx.async (the skeleton becomes an async function) ★v0.5
  │     │     └─ checks not safe (superRefine/overwrite/custom when) → degrade to officialFn(parser)
  │     └─ top level not compilable (top-level recursion / schema catchall / __proto__ key)
  │           └─ stock = true: parse/safeParse/validate all go straight to stock
  │
  └─ At runtime: any INVALID → stock safeParse / safeParseAsync (full issues / error map / ZodError)
        └─ Side-effect note: a refine callback runs "once in the skeleton + once again in the runtime" = 2 times
           (the official zod/compile shim has the same semantics; already noted in the README)

Top-level contract of an async skeleton (ctx.async = true):
  Compiled.async = true → sync parse/safeParse/validate throw $ZodAsyncError;
  parseAsync/safeParseAsync are available, and the failure path falls back to stock safeParseAsync.
```

Actual behavior for recursive schemas: the top-level skeleton of `z.object({children: z.array(z.lazy(() => Tree))})`
compiles as usual. The lazy subtree goes through the official parser product at the element position, and the official `generateLazyCheck`
brings its own cache-parser black box that handles circular references correctly (smoke test #9: `stock: false` and the semantics are normal).
What really degrades the whole tree is a top-level recursive schema (a circular reference in the def tree, which the official compileFn rejects).

## 7. Benchmarks (Benchmarks workflow run, 50 000 accounts, node v24, --expose-gc, medians of 3 interleaved rounds)

The numbers come from [Benchmarks workflow run 33936127958](https://github.com/iceboundrock/zod-cow/actions/runs/33936127958) on a GitHub-hosted `ubuntu-latest` runner with `BENCH_N=50 000`, measuring the built `zod-cow-v4` package. Every candidate gets 2 warmup rounds and 3 timed rounds; the timed rounds are interleaved with a rotated candidate order and separated by `gc()`, every timed call verifies its own result, and an equivalence gate runs valid and invalid fixtures through every implementation before timing (`packages/bench-v4/harness.ts`, `gates.ts`). ArkType 2.2.3 is a column of its own: measured through its normal public API on a schema with the same constraints where one exists, `N/A` with the reason otherwise (the cross-library table is in the README). The superseded table from run 33837195401 and the earlier local 500 000-record measurement, including the `zc-v1` column for the front-end deleted in issue #4, are kept in the CHANGELOG.

| Scenario | stock | official compileFn parser | zod-cow-v4 | ArkType |
|---|---|---|---|---|
| S1 pure validation parse | 51ms | 14ms | **15ms** | 15ms |
| S1 allocation pressure / retained | +17.0MB / +12.3MB | +11.0MB / +10.8MB | **+3.1MB / 0.0MB** | +5.4MB / 0.0MB |
| S2 10% default | 53ms | 22ms | **19ms** | 610ms |
| S2 allocation pressure / retained | +16.0MB / +11.7MB | +18.2MB / +11.6MB | **+4.4MB / +1.0MB** | +81.3MB / +11.6MB |
| S3 sweep 0% / 25% / 50% / 100% dirty | 52/55/55/56ms | 19/20/19/19ms | **18/22/25/32ms** | 611/613/612/602ms |
| S3 retained | +11.6 to +12.3MB | +11.6MB constant | **0.0 / 1.8 / 3.2 / 6.1MB** | +11.6MB constant |
| S4 validation only | N/A (no validation-only API) | 14ms (`assertOnly` validator) | **14ms** (`validate()`) | 17ms (`.allows()`) |
| S5 record/map/set | 66ms | 42ms | **21ms** | N/A (`Map`/`Set` instanceof-only; non-equivalent reference 7ms) |
| S5 allocation pressure / retained | +52.4MB / +21.7MB | +60.2MB / +21.7MB | **+29.4MB / 0.0MB** | N/A |
| S6 tuple | 20ms | 8ms | **4ms** | 3ms |
| S6 allocation pressure / retained | +54.4MB / +20.6MB | +20.2MB / +20.2MB | **+1.5MB / 0.0MB** | +0.0MB / 0.0MB |
| S7 async transform (5 000 rows) | 9ms (safeParseAsync) | N/A (compile rejected) | **6ms (safeParseAsync)** | N/A (no native async morph) |
| S7 allocation pressure | +12.8MB | N/A | **+9.4MB** | N/A |

Ratios against zod-cow-v4 (above 1 = the other implementation took longer): stock 3.40x (S1), 2.74x (S2), 2.88x / 2.43x / 2.23x / 1.78x (S3), 3.13x (S5), 4.37x (S6), 1.60x (S7); official JIT 0.95x (S1), 1.11x (S2), 1.04x / 0.88x / 0.77x / 0.61x (S3), 1.00x (S4), 2.01x (S5), 1.75x (S6); ArkType 1.00x (S1), 31.43x (S2), 33.60x / 27.29x / 24.78x / 19.12x (S3), 1.21x (S4), 0.61x (S6).

How to read it:

1. Against stock: 2.7x to 4.4x on the sync scenarios (S1 3.40x, S2 2.74x, S5 3.13x, S6 4.37x),
   with retained memory going from 12~22MB to zero on clean input; the async scenario (S7) is 1.60x at 5 000 rows, where runner noise weighs heavily.
2. Against the official JIT parser: level on clean object input (S1 0.95x, S3 0% 1.04x, within runner noise; the output
   construction the skeleton saves offsets the call overhead of the sub-skeleton functions), ahead when the default fires on a minority of rows (S2 1.11x),
   behind as the dirty share grows (S3 100% 0.61x: every row is copied and the reference comparisons are still paid), and ahead in the container scenarios (S5 2.01x, S6 1.75x),
   because the whole-tree rebuild of the official stock semantics is a fixed cost, while CoW only pays for the paths
   that actually got dirty. Tuple is the container with the highest share of rebuilding (every parse does a new Array plus a per-slot write,
   while the slots barely change), so CoW decoration gains the most there.
3. Against ArkType: level on the pure parse (S1 1.00x), ahead on validation-only (S4 1.21x), behind on tuples (S6 0.61x: ArkType's precompiled
   check returns the input and allocates nothing, while the skeleton pays the strip probe and one sub-skeleton call per row). The S2/S3 gap is architectural:
   a type with any morph (a key default is one) loses ArkType's `allows` root-apply strategy and runs the contextual one, an interpreted `traverseApply`
   over a `Traversal` context whose `finalize` deep-clones the whole input before applying the queued morphs (`@ark/schema` `node.js` / `traversal.js`),
   so every row is rebuilt at every ratio (+80MB allocated, 610ms at 50 000 rows, independent of the dirty share). zod-cow compiles the default as an
   ordinary official leaf and copies only the rows that were missing the key. The earlier reference line (8ms in run 33837195401) used a weaker ArkType
   schema (no integer bound on `id`, `createdAt` as a plain string, no bound on `tags`); with equivalent constraints ArkType's S1 cost is 15ms.
4. async channel (S7): a local await in the skeleton, so async subtree positions pay the microtask cost and the rest keeps the reference-comparison
   skeleton; an all-dirty async transform scenario is 1.60x here (2.67x in run 33837195401; at 5 000 rows both numbers sit inside runner noise), with allocation -27% (12.8→9.4MB).
5. validate fast path: `validate()` is the official assertOnly whole-tree product of the same array schema, so S4 reads level
   with that baseline by construction (14ms against 14ms, 1.00x). Its value is the validation-only cost: 14ms / 50 000 = 280ns per account,
   with nothing retained after GC (the +2.0MB is the `tags` arrays the official array product materializes even in assertOnly mode once a size check such as `.max(8)` is present).
   The S4 baseline is the validator, not the parser product named in the column header: the parser has no validation-only mode.

S1's +3.1MB of short-lived allocation is the strip probe's own-symbol array: exactly one empty array (32 bytes) per object, 100 000 objects at 50 000 accounts with a nested address, read to prove that the object can be returned by reference. The official leaf products allocate nothing measurable (the datetime/email format checks included; measured per leaf with the sampling heap profiler and `heapUsed` deltas on Node 24),
and nothing is retained after GC: CoW itself copies no containers. In the v0.5 local measurement v1 allocated less (12.1MB against zc-z4's 30.5MB) but was twice as slow; the trade-off between speed and
a small amount of short-lived allocation was decided in favor of zc-z4 in a production context (where minor GC is cheap), which is also one of the reasons v1 was eventually removed.

## 8. Correctness evidence

- `packages/zod-cow-v4/tests/smoke-z4.test.ts` (11 groups of behavioral assertions) + `packages/zod-cow-v4/tests/smoke-z4-containers.test.ts`
  (the three record paths / map / set / size checks / container combinations) + `packages/zod-cow-v4/tests/smoke-z4-tuple-async.test.ts`
  (tuple truncate/fill/rest/refine + the async channel through array / record / map / set / tuple children and object keys / lazy(async) / union async branches) all pass.
- `packages/zod-cow-v4/tests/differential-z4.test.ts`: 50000 cases (seeds=500×100, randomly nested
  object/array/tuple/record/map/set/union + optional/nullable/default/refine/transform
  + async refine / async transform wrappers), fully consistent with stock zod4:
  - success/failure parity identical (20813 successes / 29187 failures)
  - outputs identical under `deepStrictEqual` (Map/Set compared as entry sets)
  - zero input distortion (compared against a structuredClone snapshot)
  - top-level reference-sharing rate 89.1% (over successful cases), 0 degradations to stock
- Known misalignment (deliberately kept): with an async rest slot and a nullable null input, the stock runtime produces
  a sparse array and loses the null (deterministic repro: `z.tuple([z.string()], z.boolean().nullable().refine(async …))
  .safeParseAsync(["a", null, null])` → ownKeys "0,2,length", slot 1 becomes a hole).
  The skeleton outputs a dense array (which is more correct), and the differential generator avoids that combination; see upstream-issue-draft.md §Bonus.
- Failure diagnostic hook: `REPRO=seed:case pnpm --filter zod-cow-v4 exec tsx tests/differential-z4.test.ts`
  prints the schema description, the input, and the CoW skeleton source.

## 9. Version anchor and risks

The unsupported surface we depend on (all reachable through the public `zod/v4/core` permalink subpath, but positioned as internal by the official comments; only the two `ZodCompile*` errors are public API):

| API | Purpose | Drift risk |
|---|---|---|
| `compileFn(schema, {assertOnly, debug})` | leaf/subtree products | signature change (low); behavior changes are backstopped by the differential tests |
| `INVALID` | failure sentinel | extremely low (Symbol.for is stable) |
| `ZodCompileUnsupportedError/AsyncError` | degradation verdict + the **async detector** (v0.5) | low |
| `$ZodAsyncError` | the official semantics of throwing when a sync island meets a Promise; the sync API on an async skeleton | low |
| `regexes.number` / `util.isPlainObject` | record skeleton | low (the official internals depend on the same ones for consistency) |
| `WHEN_DEFAULTED_CHECKS` / `fastPathAcceptsAbsence` and other semantic predicates (implementation copied, not imported) | purity analysis | **medium**: must be synced when zod changes the `when` semantics |
| `getTupleOptStart` / `dropsWhenAbsent` (implementation copied, not imported) | tuple trailing-slot truncation semantics (v0.5) | **medium**: must be synced when zod changes the optin/optout ladder |

Mitigations: the degradation chain guarantees that any drift shows up at worst as "degrading to stock" (correctness is never lost);
the async channel uses `ZodCompileAsyncError` as an async detector maintained by the official project (when the official code adds async detection points,
this layer follows automatically); the 50 000-case differential test (including the tuple/async generators) is a mandatory regression gate when upgrading zod;
an upstream issue has been drafted to push `compileFn`/assertOnly toward becoming public (docs/upstream-issue-draft.md),
which would remove the largest single internal dependency.

## 10. Conclusion: where each of the two routes applies

- v1 (self-written codegen) applies to strongly controlled environments and long support windows: zero dependence on internal APIs
  (it only reads `_zod.def`), lower allocation, and the ability to pin an old zod version. This repository no longer needs that domain:
  it maintains a single zod4 line, and v1 was removed with issue #4; the comparison below is therefore a decision record,
  not two options still being maintained.
- zc-z4 (official codegen + CoW decoration) is the right answer for the zod4 era: semantic correctness is outsourced to the official
  compiler and runtime, the self-written surface shrinks to "purity analysis + 6 container skeletons + async channel", and upstream
  optimizations benefit it automatically; speed is level with the official JIT on objects and ahead on containers (record/map/set 1.76x, tuple 1.88x), async 2.67x vs stock
  (2.7~4.4x against stock overall; run 33936127958, see §7), with GC-retained memory down to zero.
- Both routes share the same CoW mental model: reference comparison is the dirty signal, path-copying is the copy strategy.
  The only difference is who implements the validation and transformation layer.

## 11. Source layout (issue #5)

The engine lives in `packages/zod-cow-v4/src/cow4/` as a set of modules cut along the seams described above; every function kept its body and comments when it moved, so the sections of this document still map one-to-one onto the code.

| Module | Section of this doc | Holds |
|---|---|---|
| `index.ts` | §6 | Thin entry: `compileCowFn`, `compileCowDebug`; re-exports `INVALID`, `Fn`, `ZC_ASYNC`, `isAsyncProduct`, `officialValidator` |
| `product.ts` | §5.5 | `Fn` product contract, `ZC_ASYNC` marker, `isAsyncFn`, `throwAsync` |
| `codectx.ts` | §3 | `CodeCtx`, `escKey`, `buildFn` |
| `predicates.ts` | §9 | Verbatim zod copies: `acceptsAbsence`, `requiresPresence`, `mayOutputUndefined`, `getTupleOptStart`, `dropsWhenAbsent` |
| `purity.ts` | §4 | `isPure`, `leafChecksArePure`, `checksAreCowSafe`, `WHEN_DEFAULTED_CHECKS`, `cowSafeContainerForChild` |
| `official.ts` | §6 | `officialFn`, `officialValidator`, `makeIsland`, `makeAsyncIsland`, `subtreeHasAsync` |
| `emit.ts` | §3, §5.3 | `emitNode`, `emitBoxedContainer`, `childProduct`, `containerChildFn`, `containerChecksFn`, `subFn` |
| `emit-object.ts`, `emit-array.ts` | §3.1, §3.2 | `emitCoWObject`, `emitCoWArray` |
| `emit-tuple.ts` | §5.4 | `emitCoWTuple` |
| `emit-record.ts`, `emit-map.ts`, `emit-set.ts` | §5.1, §5.2 | `emitCoWRecord`, `emitCoWMap`, `emitCoWSet` |

`emit.ts` and the six `emit-*.ts` modules import each other: `emitBoxedContainer` dispatches to the skeletons, and the skeletons recurse into child containers through `containerChildFn` / `childProduct`. The cycle is safe because every binding involved is a hoisted function declaration and none of these modules executes anything at load time. Do not add top-level code that calls across the cycle.

## Appendix A. Structural differences between zod3 and zod4 (probed)

This table was written for the removed self-written zod4 front-end (v0.2) and moved here from the README in issue #7. It describes stock zod3 vs zod4, so it still constrains the current line; every row was anchored by `src/probe-z4.ts`.

| Dimension | zod3 | zod4 |
|---|---|---|
| checks location | the wrapper type (the checks array on `ZodString`) | a flat `def.checks`, and `z.email()/z.iso.*()/z.int()` attach the format check **directly on the def itself** (`def.check`) |
| check instance | `c.kind` + `c.value` | `check` kinds are named differently (`min_length/max_length/greater_than/string_format/number_format/overwrite/custom`…), and may be an instance or a bare def, so they need normalizing |
| `.int()` | `ZodNumber` check kind `"int"` | `number_format "safeint"` (isInteger + the 2^53 range, out of range reports too_big) |
| object mode | the `def.unknownKeys` flag | strict = `catchall: never`, loose = `catchall: unknown` |
| object output rebuild | the `alwaysSet` rule | **driven by `optin`/`optout`**: an absent optional key is not materialized, a present undefined is kept, an absent required key reports `nonoptional` |
| `.default()` | the default value **must pass** the inner validation | **short-circuits** (the default value is not validated); and `handleDefaultResult` fills in the default when the inner produces undefined |
| `.optional()` | passes undefined straight through | when the inner has `optin === "defaulted"` it **hands undefined to the inner** (so the default fires) |
| `.catch()` | **swallows exceptions** | **does not swallow exceptions** (only a validation failure falls back to the catch value) |
| `.transform()` | `ZodEffects` | `pipe(in, transform)`; `fn(value, payload{issues, addIssue})` |
| refine | `ZodEffects.refinement` | a `custom` check inside `def.checks`; every check instance has a lazily compiled `_zod.check(payload)`, which serves as the generic channel for kinds we did not hand-write |
| string format | regexes copied verbatim into `regexes.ts` | a `string_format` check **carries its own pattern regex** (email/uuid/datetime/ipv4… inlined directly) |
| record keys | string only | number keys are supported (retried by falling back to the numeric string); **enum/literal keys are declaration-driven** (all declared keys required + extra keys report unrecognized_keys) |
| NaN | `invalid_type received nan` | same as zod3 (z.number() rejects NaN) |
