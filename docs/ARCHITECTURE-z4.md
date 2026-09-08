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
| validator (`assertOnly: true`) | `(input) => true \| INVALID` | validation semantics complete, output construction skipped |
| runtime island | `(input) => out \| INVALID` | a black box calling `_zod.run({value, issues:[]}, {})`, swallows async in a sync context |

Another official mount point is `globalConfig.postProcessor` (the side-effect entry of `zod/compile` installs its shim
there). This layer does not use it (that is the "clone every instance and replace run" route, incompatible with CoW's
"whole-tree product"), but the two can coexist: zc-z4's failure fallback calls
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
that a "pure subtree" needs in CoW. Measured (500 000 accounts, assertOnly in a per-account loop): 265ms / +13MB, against
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
  ├─ yes → emitBoxedContainer (unwrap optional/nullable, run the wrappers' refine predicates) → one of the six container skeletons
  └─ no  → isPure(schema)?
        ├─ yes → official assertOnly product + return accessor (output === input)
        └─ no  → official parser product (dirty check by reference comparison, performed by the host skeleton)
```

### 3.1 Official object skeleton vs zc-z4 CoW skeleton (the same schema, side by side)

schema: `z.object({ id: number.int(), firstName: string.max(64), email: z.email(), tags: array(string).max(8), address: object({...}) })`

```js
// ═══ zc-z4 CoW skeleton (real dump) ═══
if (typeof input !== "object" || input === null || Array.isArray(input)) return INVALID;
let x0 = false;                                            // dirty
const x1 = input["id"];
if (c0(x1) === INVALID) return INVALID;                    // pure leaf key: official assertOnly product
const x2 = input["firstName"];
if (c1(x2) === INVALID) return INVALID;
const x3 = input["email"];
if (c2(x3) === INVALID) return INVALID;                    // (email validation lives inside the product)
const x4 = input["tags"];
const x5 = c3(x4);                                         // container key: CoW sub-skeleton product
if (x5 === INVALID) return INVALID;
if (x5 !== x4) x0 = true;                                  // <- reference comparison is the dirty signal
const x6 = input["address"];
const x7 = c4(x6);                                         // same as above (nested CoW)
if (x7 === INVALID) return INVALID;
if (x7 !== x6) x0 = true;
if (!x0) {                                                 // strip probes, only while the input may still be returned
  let x8 = false;
  for (const k in input) {
    if (k !== "id" && k !== "firstName" && k !== "email" && k !== "tags" && k !== "address") { x8 = true; break; }
  }                                                         // fixed string keys are generated comparisons
  if (!x8) {
    const x9 = Object.getOwnPropertySymbols(input);        // the clean path's only allocation: one empty array per object
    if (x9.length !== 0) x8 = true;                        // no declared symbols: any own symbol is extra
  }
  if (!x8) {
    return input;                                          // ═══ the one line the official template does not have ═══
  }
}
const out = { "id": x1, "firstName": x2, "email": x3, "tags": x5, "address": x7 };   // the official assembly, from the captured locals
return out;
```

Point-by-point correspondence with the official dump:

| Official parser | zc-z4 skeleton | Note |
|---|---|---|
| `const v8 = {...}` unconditionally | `if (!dirty) { probes; return input; }` | The CoW core: no copy on clean input; the strip probe's one empty own-symbol array per object is the clean path's only allocation |
| `const v5 = new Array(len)` | (inside the element loop) `out = new Array(len)` plus the clean prefix | Same for arrays: the prefix rebuild only on the first dirt, every later element written once (#70) |
| `if (!c1.test(v2)) return INVALID` | same (inside the assertOnly product) | Leaf validation is 100% official |
| `const v8 = { "id": v0, … }` in shape order, with the `mayOutputUndefined` / `dropsWhenAbsent` rules for conditional keys and a `for...in` append in passthrough mode | the same literal, from the captured locals, on the copy path | The copy is stock's output: shape order, the same key-presence rules, getters read once. Undeclared keys are dropped by construction, so the copy path needs no probe and no `delete` (the earlier `{ ...input }` plus `delete` copy kept the input's order, re-read every getter (#36) and turned the copy into a dictionary-mode object, which made strip parity (S8) slower than stock) |
| `for (const k in …)` unknown probe | generated string comparisons for shapes up to `MAX_INLINE_KEY_COMPARISONS` (32 since #34, 16 before) keys, then a `Set` fallback; the own-symbol probe follows only when no undeclared string key was found (strict and loose objects run the own-symbol probe alone, #42) | Same inherited-enumerable semantics with faster monomorphic small-object membership; both probes run only when no key is dirty, since a dirty object is rebuilt from its declared keys anyway. The `Set` is hoisted only when something references it (large shapes, declared symbol keys, the loose append loop), and the cap sits where the chain stops winning: measured through the real skeleton (the S11 rows of `bench-v4`, #34), the chain is 20 to 30% faster than the `Set` at 17 to 32 keys, level at 48 and slower from 64, since it is quadratic in the key count where the `Set` is linear (see the constant's comment for the numbers). A strip shape declaring only symbol keys treats every string key as undeclared (#35) |

Cost of the clean path, measured per object on a 6-key primitive record (the calibration scenario of `bench-v4`, single-record hot loop): the own-symbol probe is about 31 ns of a 69 ns skeleton call (run 34069671088, the default row against the opt-in row that skips the probe), the `for...in` probe about 9 ns (measured locally on Node 24); the official parser of the same schema costs 29 ns in that run, its validator 15 ns locally. The leaf validator calls are not a cost (V8 inlines them: one official validator call for all pure keys measured the same as six leaf calls). The symbol probe is what stock's object semantics cost: stock drops own symbol keys in every mode (strict's unknown-key loop sees string keys only, so it never rejects a symbol either), so a pass-through has to prove there are none, and `Object.getOwnPropertySymbols` is the only way to ask (`Reflect.ownKeys` allocates every key). It runs in every mode (strip since #33, strict and loose since #42; for strict and loose it is the clean path's only probe, since strict rejected undeclared string keys during validation and loose keeps them) and, since #51, on the clean path of an enum-keyed record as well (§5.1; the helper is `emitOwnSymbolProbe` in `codectx.ts`, shared by both skeletons), and stays on by default. `compile(schema, { ownSymbolKeys: "ignore" })` (#43) drops it: the options are resolved once in `compile`, carried by every `CodeCtx` of the tree (`subFn` creates a child context with its parent's options and its parent's `sources` list, so every nested object sees the same setting and lands in the debug dump, #46), and the strip skeleton then emits the `for...in` string probe alone (a strict or loose skeleton returns the input as soon as no key is dirty):

```js
if (!x0) {
  let x8 = false;
  for (const k in input) {
    if (k !== "id" && k !== "firstName" && k !== "email" && k !== "tags" && k !== "address") { x8 = true; break; }
  }
  if (!x8) {
    return input;                                          // no own-symbol probe: an own symbol key would survive here
  }
}
```

Under the option a clean input that does carry an undeclared own symbol key is returned by reference with the symbol kept, where stock's rebuild drops it; strict and loose objects had that behavior unconditionally until #42, and records until #51, now it is opt-in in every mode and in every record path. Everything else is unchanged: declared symbol keys are validated and written, the copy path drops undeclared symbols by construction, `validate()` is the official validator. The differential fuzzer runs a second pass with the option against a generator that emits no extra own symbol (§8). In [Benchmarks workflow run 34069671088](https://github.com/iceboundrock/zod-cow/actions/runs/34069671088) (calibration parse, 1 000 000 operations per round, §7): 69 ns per parse with the probe, 38 ns without it, `z.compile()` 29 to 34 ns in the same two rows; `bench-v4` reports the option as a separate, labelled row of the calibration section and keeps the default in the zod-cow-v4 column of every scenario.

What the two probes do not prove (#48): the `for...in` probe lists enumerable string keys, own and inherited (so it walks the prototype chain, and on a Proxy consults `ownKeys`, `getOwnPropertyDescriptor` and `getPrototypeOf`), and the own-symbol probe lists own symbols (`ownKeys` on a Proxy); no explicit descriptor or prototype probe runs on the clean path, so a clean input comes back with whatever stock's rebuild would have normalized away. Four members: a non-enumerable undeclared string key (objects in every mode; records too, whose key loop skips a non-enumerable string key like stock and then returns the input where stock's rebuild drops it), a declared key the input defines as non-enumerable (§5.1), the input's prototype (a class instance stays that instance; a loose object also keeps an inherited enumerable key inherited, since only strip runs `for...in` on the clean path, where stock's loose append writes it as an own key; records reject a class instance on both sides), and the set of Proxy traps consulted (strip consults `ownKeys`, `getOwnPropertyDescriptor` and `getPrototypeOf` through its `for...in` probe where stock's strip template consults nothing; loose consults `ownKeys` alone, through the own-symbol probe, and nothing under `"ignore"`, where stock's `for...in` append consults all three; strict runs the official unknown-key loop, a `for...in`, on both sides). The copy path is the official assembly and matches stock in every case. Proving their absence would cost an `Object.getOwnPropertyNames` or `Reflect.ownKeys` array per object, a `propertyIsEnumerable` call per declared key or a prototype read on every clean container, the cost class `ownSymbolKeys: "ignore"` exists to remove, so they are documented (README, known limitations) and pinned next to stock's behavior by smoke groups 16 and 17, not probed.

### 3.2 The container's own checks: the two-path timing

When `.refine()` / `.min()` is attached to a container, the stock semantics is "run the checks on the output after the output
is constructed". zc-z4 compiles the checks into a separate validation subroutine and calls it on both paths:

```js
const cChecks = /* the containerChecksFn product */;
if (!x0) {
  /* strip probes */
  if (!x8) {
    if (cChecks(input) === INVALID) return INVALID;   // clean: output === input
    return input;
  }
}
const out = { "id": x1, /* … the captured locals in shape order */ };
if (cChecks(out) === INVALID) return INVALID;       // dirty: aligned with stock's "run the checks on the output"
return out;
```

Supported set: `custom` (the predicate in `.refine()`'s `def.fn`, sync or async) + array's
`min_length/max_length/length_equals` (`.length` read directly) + map/set's
`min_size/max_size/size_equals` (`.size` read directly) + an object's `property` (`z.property` /
`z.properties`, #85, below); a record has no length or size check, so only
predicates reach its skeleton (a record with any check took the official parser until #13). Everything
else (superRefine rewriting `ctx.value`, overwrite, a custom `when`) → the whole node degrades to the
official parser product.

A `property` check is a predicate on one key of the output: stock's `$ZodCheckProperty` runs the schema it
carries on `payload.value[property]` under an empty context and keeps only the issues, prefixed with the key
(`handleCheckPropertyResult`); the carried value never reaches the output. So the object keeps its skeleton
(`checksAreCowSafe` admits the kind on an object, for a string key other than `__proto__`; the carried schema
is not judged, since its output is discarded) and the subroutine takes the key's value as a parameter after
its target, one per distinct key in check order: the clean call hands it the local the skeleton holds for a
declared key, with the `in` read stock's assembly makes where a presence rule may leave the key out
(`dropsWhenAbsent`, `mayOutputUndefined`) and the prototype of a fresh object as the value then, so no getter
of the input is read a second time; the copy call lets it read `out`, which is stock's assembly. An
undeclared key is not read off the returned input on the clean path, since that input is not stock's
assembled output (review of #98): a non-enumerable own or inherited property is one `for...in` never yields,
so strip's probe and strict's check let the input through by reference while stock's fresh object lacks the
key, and a getter there is one stock never reads. The clean call hands the subroutine what that assembly
holds: in strip and strict mode the prototype of a fresh object (the clean path is reached only when
`for...in` yields no undeclared key), in loose mode the input's value when a scan with stock's enumeration
finds the key (the append writes it then, and reads it once, as the clean call does) and the prototype
otherwise. In the sync variant the carried schema's product is `officialFn(carried, true)`,
the verdict-only chain (validator, else parser, else island; a wrapper `wrapperFollowsRuntime` names or a
`lazy` inside it takes its island as anywhere else), and a failure returns `INVALID` at once like every other
check of the variant. In the async variant the carried schema runs through stock's `_zod.run` as the check
runs it (`runCarried` in `official.ts`): the payload's issues say whether the failure aborts the chain
(`aborted`, copied into `predicates.ts`), which `INVALID` cannot, so a carried type mismatch skips the later
checks exactly where stock skips them and a carried check failure (`continue: true`) does not; whether the run
came back as a promise is a runtime test, like a plain-function predicate's result, and a promise is settled
with the others by `settleChecks`. Smoke group 25 pins the sharing at every position, the getter read count,
the prototype read, the schedule and the abort rule; the fuzzer's property draw keeps its object's skeleton
since #85. The extended property/input draw of #99 measures 82.0% / 83.1% sharing among successful
cases at the default size; the run retains the unrelated async Set-order failure #105 (see §8).

An async predicate used to be rejected by the gate, so a container carrying one became a runtime island and
came back as a copy on every parse (#13). Since #13 the subroutine is an async function whenever a predicate
is async, on stock's schedule: `runChecks` calls every check synchronously in declaration order and only chains
the awaits, so every predicate (sync or async) is called before the first `await`, a length / size check keeps
its place, and the results are settled at the end in order by `settleChecks` (a `Promise` is awaited, any other
result is read as is, a `false` does not stop the settlement of the later ones, a rejection throws at its
position). A length / size check that fails after a predicate was started settles the started ones before
returning `INVALID`, so no rejecting promise is left unattached. One exception to "every predicate is called":
`runChecks` tracks its abort state synchronously until a check returns a `Promise`, so an `abort: true` predicate
that fails synchronously while no promise has started skips every later check without a `when` (the length / size
checks carry one and still run, side-effect free). The subroutine returns `INVALID` at that point instead of
starting the later predicates, so a predicate stock never calls is never called here either (third review of #76);
after the first promise stock updates the state inside its chain, too late for the loop, so nothing is skipped and
the predicates are all started. Whether a promise has started is decided at runtime for the predicates that are
not async functions, since a plain function may return a `Promise` too. Every predicate call, in both
variants, is wrapped in a `try / catch` that hands a throw to `rethrowCallerError`: a `$ZodAsyncError` the
predicate threw is recorded as the caller's before it propagates, so the async entries rethrow it instead of
reading it as the fast path's Promise signal (§5.5 item 6; a rejection an awaited predicate settles with is
recorded the same way in `settleChecks`). The call sites (the six container skeletons, the union skeleton and
the wrapper layers of `emitBoxedContainer`) emit `await` and the skeleton becomes async (the wrapper is
left out of the example):

```js
const x0 = f0(input);                                   // sync predicate
const x1 = f1(input);                                   // sync predicate with abort: true
if (!x1 && !(x0 instanceof Promise)) return INVALID;    // stock skips x2 here; x0 may still have returned a Promise
const x2 = f2(input);                                   // async predicate, started
if (input.length < 2) { await settle([x0, x1, x2]); return INVALID; }
const x3 = f3(input);                                   // sync predicate, called before x2 settles
if (!(await settle([x0, x1, x2, x3]))) return INVALID;
return true;
```

The same subroutine for an object with a property check (#85), `(input, p0)` taking the held value of `k`:

```js
const x0 = run(carried, p0);                            // stock's $ZodCheckProperty run of the carried schema on the key's value
const x1 = x0 instanceof Promise ? x0.then(passed) : x0.issues.length === 0;
if (x1 === false && aborted(x0)) return INVALID;        // a carried type mismatch aborts stock's chain; a check failure continues
const x2 = f2(input);                                   // async predicate, started
if (!(await settle([x1, x2]))) return INVALID;
return true;
```


That schedule is the success path's. A failing check answers `INVALID` like every other failure of this line (§6): the
subroutine does not reach the checks declared after a failing length / size check, and the caller falls back to stock
`safeParse` / `safeParseAsync`, which runs every check of the schema again from the start. A predicate that passed before
the failure therefore runs twice (`A, A, B` for `refine(A).min(3).refine(B)` on a one-element array, where the runtime
logs `A, B`), the case listed under Known limitations in the README; stock's own `z.compile()` fast path bails out at the
same check and its fallback produces the same log. Before #13 the container was a runtime island whose failure fell back
the same way, so every predicate ran twice (`A, B, A, B`).

## 4. Purity analysis: the whitelist and the four traps

Definition: `isPure(schema)` = validation passes ⇒ the output is necessarily `===` the input reference, with no side effects.
A pure subtree goes through the official validator (value = input); anything uncertain is treated as impure (parser product + reference comparison).

| def.type | Verdict | Reason |
|---|---|---|
| string/number/boolean/bigint/symbol/null/undefined/void/nan/date/any/unknown/literal/enum | `leafChecksArePure` | the official product passes the accessor through; checks are the exception, see below |
| optional/nullable | the wrapper's own checks pass `leafChecksArePure` (above a container: `wrapperChecksAreCowSafe`, the gate the skeleton applies) and the inner is pure | the value passes through; an overwrite or a superRefine on the wrapper rewrites the value as it would on a leaf (#57; an async refine is a predicate the skeleton awaits since #13), and above a container the validator would also keep the undeclared keys stock strips (#56); a length / size check attached to a wrapper through `.check()` is a pure predicate on a leaf but not a check the skeleton runs, so above a container it must fail this gate too or the chain falls through to the validator (second review of #68) |
| object/array (own checks safe + the whole subtree pure) | true | the skeleton takes over (strip is handled by the skeleton) |
| record/map/set | true (once the skeleton takes over) | reference comparison of key names and values, see §5 |
| union | the union's own checks pass `leafChecksArePure` (with a container option: `unionSkeletonOk`, the gate the union skeleton applies) and every option is pure | a leaf-only union is one official product whose options pass through; a union with a container option (directly, through optional / nullable, or in a nested union) gets the union skeleton (#58), whose options are skeleton positions, see trap four |
| readonly | false | the `Object.freeze` side effect. The official parser then freezes exactly what stock freezes: a new container, or the input itself for a pass-through leaf such as `any` / `unknown` (#28) |
| default/prefault/catch/coerce/transform/pipe/intersection/lazy/custom/nonoptional/success | false | value producer / black box / new container |

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

The wrapper layers of that chain may carry checks of their own, and until #56 the skeleton dropped them: the gate
admitted a `.refine` on `optional(object)` as a pure predicate and `emitBoxedContainer` emitted the shell checks and
the container skeleton only, so `z.object({ a: z.string() }).optional().refine(f)` accepted what stock rejects. Stock
runs a wrapper's checks after the wrapper's own codegen, on the value it produced: the shortcut value on the shortcut
(`undefined` for optional, `null` for nullable), the inner output otherwise, and the inner wrapper's checks before the
outer's. `emitBoxedContainer` now collects the chain first; a shortcut runs the checks of its own layer and of every
layer above it before returning, and the container's output runs every layer's checks inner to outer. A chain with such
checks builds the container as a nested skeleton called once, because an inline skeleton returns the clean input from
inside its own branch and nothing emitted after it would run on that path; a chain without checks emits the inline
skeleton as before. The gate (`wrapperChecksAreCowSafe`) admits `.refine` predicates only, the checks `containerChecksFn`
can emit; any other check on a wrapper (an overwrite, a superRefine, a length or size check attached
through `.check()`) sends the chain to the official parser (an async refine passes the gate since #13, the subroutine awaits it), and `isPure` rejects it as well (it used to recurse into the
inner without looking at the wrapper's checks, so such a chain took the validator and kept the undeclared keys; the same
line fixes the leaf case of #57). Above a container `isPure` applies the skeleton's gate rather than the leaf one: a
length / size check on the wrapper is a pure predicate on a leaf, and judging it pure on a container chain the gate had
just rejected handed `z.object({ a: z.number() }).optional().check(z.minLength(1))` to the validator, which kept the
undeclared key stock strips (found in the second review of #68; the fix is a hand-off from the leaf gate to the wrapper
gate whenever the inner unwraps to a container). The fuzzer never built this shape: a child took at most one wrapper, and its refine
predicate could not fail on a container. It now stacks a check (a sync or async refine, an overwrite) on one wrapped
child in three and its refine also rejects a container with exactly three entries; on the unfixed engine that finds
5 of 20 000 cases in each pass.

### Trap four: a union option is not a skeleton position (found in the review of #44, reproduced by the fuzzer once it generated unions, #47; resolved by the union skeleton, #58)

The whitelist judges a container pure on the premise that "this layer's skeleton takes over", which holds at the top
level and at the key / element / value positions (`cowSafeContainerForChild` / `containerChildFn` route a container into a
sub-skeleton). A union is one official product as a whole, so its options get no skeleton: `z.union([z.object({ a: z.string() }), z.number()])`
was judged pure (every option pure), `childProduct` emitted the `assertOnly` validator for the whole union, and an input
`{ a: "x", extra: 1 }` came back by reference with `extra` kept where stock rebuilds the object and drops it (top level and
nested alike; a strict option kept an undeclared own symbol key, `array(object)` and `optional(object)` options and
discriminated unions behaved the same). Fix: `isPure(union)` is `false` as soon as one option is, or unwraps through
optional / nullable to, a container (object / array / tuple / record / map / set); the union then takes the official parser
plus the reference comparison, which rebuilds the matching container the way stock does. The price was the CoW path of a
union with a container option (it always copied). The differential generator emits unions since this fix (2 to 3 random
options, one in four a discriminated union of two object branches); the earlier runs quoted below generated none, although
the list said "union".

The union skeleton (`emit-union.ts`, #58) removes that price by making a union option a skeleton position. A union with a
container option (directly, through optional / nullable, or inside a nested union; `unwrapsToContainer` looks through
unions) is admitted by `cowSafeContainerForChild` when `unionSkeletonOk` holds: not `z.xor` (`inclusive === false`, where
exactly one option must match, which a first-hit chain cannot decide); for a discriminated union no `unionFallback`,
static discriminator values of a comparable type for every option and no value claimed twice (the cases stock's own
codegen declines); and the union's own checks `.refine` predicates only, the gate a wrapper applies. `emitCoWUnion`
mirrors stock's `generateUnionCheck`: one product per option from `childProduct` (a container option its own CoW
sub-skeleton, a pure leaf the validator, an impure leaf the parser), tried in order (`let x = try0; if (x === INVALID)
x = try1; …`), a discriminated union dispatching on the discriminator read once through `?.` with stock's
`literalEquality` forms, and the union's refine checks on the winning value. A clean input comes back by reference from
the matching option's skeleton, so the parent's reference comparison sees no dirt; a dirty option returns its copy and
only the path to the root is copied. A leaf-only union stays one official product (the validator when pure). An option
whose product is async keeps the previous route, the whole union as the official product (an async island): stock's async
runtime starts every option and picks the first success, which a sequential chain of awaits would reproduce in output
but not in the side effects of the later options. A declined union takes the official parser as before.

Two gaps came out with the skeleton. `isPure(union)` never looked at the union's own checks, so
`z.union([z.string(), z.number()]).overwrite(f)` (or a superRefine on such a union) was judged pure and took the
validator, which returned the input where stock returns the rewritten value, the gap of #57 on a union; the union's
checks now pass the leaf gate (a leaf-only union) or the skeleton's gate (with a container option) before the options are
judged. And the first skeleton failed one fuzz case in each pass (seed 145, case 12):
`optional(union([boolean.default(true), array(…)]))` at an absent key, where `emitBoxedContainer` shortcut `undefined`
at the optional layer while stock's `generateOptionalCheck` hands `undefined` to an inner whose `optin` is `defaulted`
so the default fires, and answers `undefined` when the inner rejects it. No chain could end in such an inner before
(`default` is never unwrapped; a union with a defaulted option is `defaulted` itself). The chain now ends at such a
layer and builds the inner as a nested product called on both paths, with the layer's checks and those above it run on
the branch value (smoke group 21 pins both).

The review of the skeleton (#73) found a third gap of the same family. `$ZodExactOptional` shares `def.type === "optional"`
with `$ZodOptional`, and `emitBoxedContainer` shortcut every optional layer on `undefined`, where stock's
`generateOptionalCheck` starts with `isExactOptional` and compiles the inner directly, so the container below rejects
`undefined`. A top-level `z.exactOptional(container)` had that gap already (#74); the union skeleton widened it to
`z.exactOptional(union([object, number]))`, which took the official parser before. `cowSafeContainerForChild` and
`isPure` now decline an exact-optional layer above a container, so the chain takes the official parser at every position
(a present `undefined` under such a key is rejected like stock as well); making the layer transparent in the skeleton, and
the fuzzer's `bWrap` draw for it, stay with #74. The union skeleton also hands its input to an object option as it is, so a
`Set`, `Map` or `Date` an earlier option rejects and an object option accepts comes back by reference where stock returns a
plain object: the prototype limitation of the clean path (#48), reachable through a union since #58 and documented with it.

> Methodology: not one of the first three traps was found by reading code; all of them were caught by differential testing
> with random schemas (the fourth was found in a review and had escaped the fuzzer only because it generated no unions, so the generator gained them) (`REPRO=seed:case` reproduces one in a single command). The completeness of purity analysis can only be
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
  if (k === "__proto__") { if (!x1) { x1 = true; /* rebuild the clean prefix */ } continue; }  // stock skips the pair (#67)
  if (!c1.call(input, k)) {                                // propertyIsEnumerable (same as the official code)
    if (typeof k !== "symbol") continue;
    if (!x1) { x1 = true; /* rebuild the clean prefix */ } // a non-enumerable own symbol: stock's rebuild drops it (#51)
    continue;
  }
  if (typeof k !== "string") return INVALID;               // the official code rejects symbol keys
  const vIn = input[k];
  const t = cValue(vIn);                                   // value product (validator / parser / CoW sub-skeleton)
  if (t === INVALID) return INVALID;
  if (!x1) {
    if (t === vIn) continue;                               // reference comparison: clean pair
    x1 = true;                                             // first dirty pair: replay stock's assembly up to here
    x0 = {};
    for (const k2 of Reflect.ownKeys(input)) {
      if (k2 === k) break;
      if (k2 === "__proto__" || !c1.call(input, k2)) continue;
      x0[k2] = input[k2];
    }
  }
  x0[k] = t;                                               // this and every later pair, in order
}
return x0;                                                 // clean → the original reference
```

The non-enumerable skip is where paths B and C handle undeclared own symbol keys (#51): stock validates an enumerable
symbol as a key (rejected by a string key schema, accepted by one that admits symbols, kept unvalidated by a loose record)
and the skeleton does the same, but a non-enumerable one is skipped by stock and then dropped by its rebuild, while the
clean path would return the input with it. `Reflect.ownKeys` has already listed it, so the skip marks the record dirty on
a `typeof k === "symbol"` branch at no extra call; the `{ ...input }` copy carries enumerable keys only and so drops it
like stock. Under `ownSymbolKeys: "ignore"` (#43) the skip is the plain `continue` and the symbol survives by reference.

Path B (numeric-key retry, key names can change): reuses the official `keyFast + regexes.number retry`
template and also performs a key-name comparison: `outKey !== k` also counts as dirty, whether or not the value product is
a validator (a pure value used to skip it, so `z.record(z.string().transform(…), z.number())` returned the input, #67), a
retried numeric key that names the same property (`"1"` retried as `1`, which stock writes under `"1"`) is normalized back
to the string and counts as clean, a key the schema normalizes into `"__proto__"` marks the record dirty and is left out,
and a loose record writes a rejected key in its position once dirty. In the sub-case where key names do not change
(string-format keys such as `z.record(z.email(), v)`), `outKey === k` always holds and the key-name comparison costs nothing.

The copy of paths B and C is stock's assembly order, not `{ ...input }`: stock writes `out[outKey] = value` for every pair
in `Reflect.ownKeys` order, so a transformed key that collides with a later key is overwritten by it and the output keeps
the input's order. The skeleton replays that sequence: at the first dirty pair it starts from `{}`, copies the clean
prefix (every enumerable own key before the current one, `__proto__` skipped, read from the input a second time, the one
place the copy reads twice, #36) and writes this and every later pair from the loop's single read (`emitRebuildPrefix`, #67). An own `__proto__` data property (`JSON.parse`) is
skipped by stock's loop and so missing from its output; the clean path would keep it by reference, so it marks the record
dirty, and the same holds for a loose enum-keyed record, whose `for...in` append skips that key (path A tests
`propertyIsEnumerable(input, "__proto__")` on its clean path). With an async value product the loop takes stock's
runtime schedule instead (#70): stock starts every value inside its loop, writes a sync result at once and an async one
when its promise settles, so the output is in settlement order and an earlier async pair wins a collision with a later
sync one. The skeleton starts every value inside the loop and logs each pair in that order (iteration position, clean
flag, output key, output value; a loose record's rejected key is a sync entry, a dropped `__proto__` pair sets `dirty`),
awaits `Promise.all` over the started promises, then scans the log: a failed value fails the record, a pair out of
iteration position or not its input marks it dirty, and the copy is assembled from the log (`emitAsyncRecordTail`), each
pair read exactly once. The async island (`makeAsyncIsland`) answers a sync run synchronously for this, so a sync entry
keeps its place, and an async run adds one `.then` before the skeleton's own, the same number of microtask hops for every
entry. Zod's own compiler has no async mode (`ZodCompileAsyncError`), so the runtime is the only stock reference.

Path A (enum, declaration-driven): the official output unconditionally materializes every declared key in declaration order
(a missing key with an optional value → write undefined) + strict rejection of unknown keys. The skeleton:

- a missing declared key is dirty (`!(k in input)` → stock materializes that key);
- the unknown-key probe is the official `for...in` template over the declared keys *as `for...in` yields them*: numeric enum
  values are stringified (`z.enum({ A: 1 })` declares the key `"1"`; comparing against the raw `1` rejected every enumerated
  key and sent every parse to stock, #37), symbol keys never take part. The probe expression is shared with the object skeleton
  (`unknownStringKeyExpr` in `codectx.ts`): a `k !== "a" && k !== "b" …` chain up to `MAX_INLINE_KEY_COMPARISONS` (32
  since #34) declared string keys, a hoisted `Set` above (#33). Strict runs it on every path (`→ INVALID`); loose (`z.looseRecord`)
  keeps unknown keys, so its probe runs only on the copy path;
- undeclared own symbol keys: `for...in` never yields one, so neither strict nor loose sees it while stock's rebuild drops it
  on every path, exactly the #42 case of the object skeleton. When no key is dirty the skeleton runs the same
  `Object.getOwnPropertySymbols` probe as the object skeleton (`emitOwnSymbolProbe`, #51) and marks the record dirty on an
  undeclared one (a declared symbol key, from a symbol enum value, is known through the hoisted `Set`); the copy path drops
  them by construction. `ownSymbolKeys: "ignore"` skips the probe here as it does for objects. Measured locally on Node 24
  (single-record hot loop, 2 000 000 operations per round) on a clean 6-key enum record: 74 ns per parse with the probe,
  31.5 ns without it, the official parser 99 ns;
- the copy branch is the official assembly, never `{...input}`: an empty literal, every declared key written in declaration order
  from the locals captured during validation (a validator-product key writes `inVar`; when the key is missing,
  `inVar === undefined` happens to be exactly the stock semantics; a parser-product key writes the product's output value), then in
  loose mode the undeclared string keys appended by `for...in` (stock skips only `"__proto__"`). Getters are read once and the
  copy carries stock's key order (declared keys first, then the undeclared ones in input order).

Measured semantic anchors: `{a:1}` against `z.record(z.enum(["a","b"]), z.number().optional())`
→ stock materializes `b: undefined` → ours marks it dirty and returns `{a:1, b:undefined}` ✓; an unknown key
`{a:1,b:2,extra:3}` → both sides reject ✓; `{"1":"x","2":"y"}` against `z.record(z.enum({ A: 1, B: 2 }), z.string())`
→ the input reference ✓; `{a:"x",b:"y",extra:"z"}` against `z.looseRecord(z.enum(["a","b"]), z.string())` → the input reference ✓.
`{a:1, b:2, [Symbol()]: 3}` against `z.record(z.enum(["a","b"]), z.number())` → stock drops the symbol → ours copies and
drops it too, and the same input without the symbol stays the input reference ✓ (#51; before it the clean path returned the
input with the symbol while the copy path dropped it). A *declared* key defined as a non-enumerable property (a symbol enum
value or a declared string key) is the #48 family, documented rather than probed: the probe asks only whether an undeclared
symbol exists, so the clean path returns the input with the property as defined, where stock's rebuild writes an enumerable
data property; the copy path writes it like stock. The object skeleton behaves the same way (README, known limitations).

### 5.2 map / set

```js
// map: reference comparison on both key and value, ordered rebuild of the clean prefix at the first dirt
let out = input, x1 = false, idx = 0;
for (const [kIn, vIn] of input) {
  /* pure key: cKey(kIn) validates, the key name never changes (keyExpr = kIn)
     impure key: const ko = cKey(kIn), key-name reference comparison */
  const vo = cValue(vIn);
  if (vo === INVALID) return INVALID;
  if (!x1) {
    if (keyExpr === kIn && vo === vIn) { idx++; continue; }   // only the comparisons that exist are emitted
    x1 = true; out = new Map();
    let j = 0; for (const e of input) { if (j++ === idx) break; out.set(e[0], e[1]); }  // the first idx pairs
  }
  idx++;
  out.set(keyExpr, vo);                                        // this and every later pair, in order
}
return out;

// set: the same over the members: rebuild the first idx members into new Set(), then add every later one
```

- No cost when the key is pure: for a key schema (string/number) the official product passes the original key through →
  `keyExpr === kIn` always holds, and V8 optimizes the key-name comparison away.
- Key transformation stays correct: stock sets the parsed pairs into a fresh Map in iteration order, so a transformed key
  that collides with a later entry is overwritten by it and the output keeps the input's order; the prefix rebuild replays
  that sequence, where `new Map(input)` plus `delete` / `set` kept the old value and moved the entry to the end (#67).
- NaN: `vo !== vIn` is always true for NaN → a false dirty verdict → an over-copy, but the result is correct
  (under SameValueZero the rebuilt Set has the same members). This matches the NaN note already in the README.
- Async entries (#70): with an async key or value product the map and set skeletons take stock's runtime schedule, like
  the record above: every entry's product is started inside the loop (a map pair through `Promise.all([key, value])`
  when either is a Promise, stock's own structure), a sync result is logged at once and an async one when it settles, and
  after `Promise.all` over the started promises the log is scanned (a failed entry fails the container, an entry out of
  iteration position or not its input marks it dirty) and the copy is assembled from it (`emitAsyncSetLoop`,
  `emitAsyncMapLoop`), each entry read exactly once. The input is shared only when the entries settled in iteration
  order and unchanged.
- Map/Set comparison in the fuzzer: Node's assert compares Map/Set as entry sets (order-independent), which is what hid
  the order and collision divergences until #67; the fuzzer compares both as ordered lists on every parse
  (`orderedView`), and its async transform settles after a value-dependent number of microtask hops so that sibling
  entries settle out of order (#70).

The array and tuple copies follow the same pattern since the review of #70: the first forced change (a changed element
or an undefined one) rebuilds the clean prefix into a fresh array, reading those elements from the input a second time
(#36), and every later element is written from the single read the loop makes, so a getter or a hole after the first
change is observed as stock observes it; `slice()` re-read every element and kept a hole where stock writes an own
`undefined` slot. An element that reads as `undefined` and comes back unchanged is judged dirty without asking whether
the index is own (#95): stock's runtime reads `input[i]` (or `HasProperty` then `Get` inside `input.slice`) and never
asks, and its output holds an own `undefined` slot there whether the input held an own `undefined`, a hole or a hole
over an inherited `undefined`, so the copy is stock's output in every case. Until #95 the skeletons asked
`Object.hasOwn` on such a value to keep the reference for an own `undefined`, a `getOwnPropertyDescriptor` trap stock
never consults, so a trap with effects or a throw was observable on the clean path alone (third review of #88); there
is no trapless own-ness test, so the probe went instead of moving. What it costs is the reference for an input holding
an explicit `undefined` member (`z.array(z.string().optional())` on `["a", undefined]`, a tuple's optional slot given
explicitly), the class of `z.nan()`, which `NaN !== NaN` judges dirty on every parse: the differential fuzzer at its
default size put the loss at 0.1 point of its top-level sharing rate (32.6% to 32.5%, 82.8% to 82.5% among successful
cases), no `bench-v4` fixture holds a present `undefined` in an array or tuple, and the probe sat inside the branch
taken only on an `undefined` value, so the hot path is unchanged. An inherited value under a hole reads as that value
and stays the prototype limitation of the clean path (#48). The second Proxy-only property of the same skeletons is
documented, not probed (#95): they size their walk from `input.length` as stock does (`i < input.length`,
`input.slice(items.length)`) and return the input by reference when every element that length covers is unchanged,
so a Proxy under-reporting its length (a plain array's length is exact) gets stock a fresh truncated output and the
compiled parser the input itself, whose further elements stock never saw; a length stock's `Array(length)` rejects (a
fraction, `NaN`, a negative) throws stock's `RangeError` from the copy path only, since the clean path allocates
nothing. Proving the length would cost a `Reflect.ownKeys` allocation or a trap call per clean array, the cost class
`ownSymbolKeys: "ignore"` exists to remove, and what a consumer reads through the reported length is stock's output,
so it sits with the non-enumerable undeclared key and the prototype (§3.1, README known limitations), pinned by the
#95 smoke group next to stock's behavior.

### 5.3 Wiring

- `cowSafeContainerForChild` gains `record/map/set` cases → key positions, element positions and the top level are taken over automatically;
- `emitBoxedContainer` is extended at the end to all six containers → `nullable(record)` / `optional(map)` / `optional(tuple)` work directly;
- `checksAreCowSafe` / `containerChecksFn` gain the size-family checks for map/set;
- value positions all go through `childProduct()` (container → CoW sub-skeleton / pure → validator / impure → parser / async → async island),
  sharing the same selection logic as object key positions and array element positions;
- since #58 a union with a container option is a container for all of the above: `cowSafeContainerForChild` admits it through `unionSkeletonOk`, `emitNode` / `emitBoxedContainer` dispatch it to `emitCoWUnion`, and each option goes through `childProduct()` in turn (see trap four in §4).

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

4. Slots below `optinStart` are present by the length guard, so their absent branch is not emitted, and the first
   tail slot has no `fillLen` gate (statically dead branches of the official template, folded at compile time; no
   measured effect on S6). Inlining small leaf tuples into the parent object skeleton was tried in #40 and reverted:
   S6 measured 49ms with and 50ms without it at 500 000 rows, because the per-row cost of the row skeleton is its
   strip probes (§3.1), not the sub-skeleton call.

The case with the biggest gain: an all-numeric, all-clean tuple. stock does `new Array` plus a per-slot write every time, while CoW copies nothing
(S6 in run 33948313612: 8.04x vs stock / 2.62x vs the public compiled API; ArkType is ahead here at 0.40x, see §7).

### 5.5 async channel (added in v0.5)

Design premise: the official compileFn always throws `ZodCompileAsyncError` for async (refine/transform/custom/superRefine/pipe, 6
`isAsyncFunction` detection points in total), which is exactly a ready-made "subtree async detector".
This layer turns "async detected → degrade the whole tree" into "convert in place to an async island + a local await in the skeleton":

1. async island: `makeAsyncIsland(schema)` = an async black box returning `Promise<output | INVALID>`,
   and the product carries the `ZC_ASYNC` symbol marker.
2. await emission: every product call site checks `isAsyncProduct(fn)` and sets `ctx.async = true`. The set, map and
   iterating-record skeletons start every entry inside their loop and write in stock's settlement order (#70). The object,
   enum-keyed record, array and tuple skeletons take an async layout when any child is async (#71): every product is called
   in stock's order before the first await (a sync child's result is captured, an async child's promise started; the tuple
   starts every fixed slot with `input[i]`, an absent slot included, then the rest elements, as stock's runtime does), one
   `await Promise.all` settles the async ones, and the existing checks, reference comparisons and copy logic run on the
   settled results. So N async children cost one round trip instead of N, their side effects interleave as in stock (the
   second child's transform starts before the first settles), and a container with two async children settles in the same
   round as one with a single child, which decides its place in a parent set, map or record writing in settlement order.
   Nothing returns between the first start and the `Promise.all`, so a rejecting promise is always attached. The
   container's own checks run after the children have settled, as stock runs `runChecks` after the parse; an async
   predicate among them makes the checks subroutine itself async on the same schedule (every predicate called before
   its first `await`, §3.2, #13). Nothing is read from the input after the `Promise.all` except the tuple's length
   (#77): the array skeleton takes the length before its loop, captures each read in the first pass and rebuilds the
   clean prefix from the captured reads; the tuple skeleton does the same for its fixed
   slots, takes stock's `input.slice(items.length)` after the fixed slots started and before any rest product runs (a
   sync rest callback that mutates a later rest slot is not observed, a fixed slot's callback that ran before the slice
   is, a rest hole is decided on the slice), starts every rest element from that slice, and keeps its presence guards
   on the live `input.length`, as stock's `handleTupleResults` decides presence after the await. Since #94 the async layout's rest source is the sync rest
   layout's below: `slice` is read once, the native one run by hand under an `Array` constructor and species, the
   facade or the custom call taken otherwise, and the result iterated as stock's `for...of` iterates it, one rest
   product started per copy element or per yield before the `Promise.all` (in stock's order: the fixed slots, the
   slice, the rest elements inside the iteration). Every fixed slot's settled result is held (an absent slot's run on
   `undefined` included, which closes the async half of #96: a slot a truncation gated out is materialized from what
   settled when the length grew), the live length is read once after the await for every gate, and after the rest
   loop the same presence decision runs stock's `handleTupleResults` over the held results whenever a continuation
   ran or that length differs from the guard's read or the copy's converted one: a continuation's rest results under
   a truncated prefix are dropped, a held result the length now covers is materialized, an over-long result reaches
   the read past `items` that throws stock's `TypeError` from `parseAsync` and `safeParseAsync` alike. Before #94 the
   async layout called the real `slice` and indexed its result by `length`, so a custom `slice`, a swapped species or
   a non-array iterable gave it a rest stock never ran, and a validator-shaped rest then returned the input by
   reference where stock's output held the slice's elements. A child that mutates the input before its promise
   settles is therefore not observed by the copy path, as stock, which reads every element once before any promise
   settles, does not observe it either; the clean path still returns the input as it then is. The sync layout keeps
   its documented second read of the fixed prefix (#36) and, since #78, takes the same rest slice after its fixed
   slots ran and before any rest element runs: its rest loop walks the slice, decides a rest hole on it and rebuilds
   the rest part of the prefix from it, so a sync rest callback that overwrites a later rest slot is not observed by
   either layout, as stock does not observe it. The slice is the one allocation on the clean path of a tuple with a
   rest element (a tuple without one still allocates nothing). The sync layout builds it by hand and follows stock's runtime timeline for everything around it (#87, #88). Stock's
   `$ZodTuple` runtime runs every fixed item and keeps each result (`itemResults`), reads `input.slice` once and calls
   it once, iterates what came back with `for...of` running the rest element per yield, and only then decides each
   fixed slot's presence from the live `input.length` (`handleTupleResults`), assembling from the results it holds;
   the native `slice` itself reads the length (once, `ToLength`), then the constructor, then the species off an
   `Array` constructor (`ArraySpeciesCreate`), then asks `HasProperty` and `Get` per index and builds its result
   through the species. The sync rest layout holds every fixed slot's result in a local (a slot an earlier
   truncation gates out of the assembly is still run at its stock position, on `undefined`, and held; an absent slot
   whose run on `undefined` failed holds INVALID) and rebuilds every fresh output from those locals, never from a
   second read of the input (the async layout's rule, #77; the sync layout without a rest keeps the second read of
   #36). It reads `slice` once. The native one it runs by hand with the same reads in the same order: the length
   once, converted as `ToLength` converts it (a fraction floored, `NaN`, a negative or a non-numeric string an empty
   copy, a BigInt or a Symbol the `TypeError` `ToNumber` throws, an infinite length the `RangeError` the allocation
   throws), then the constructor, then, when the constructor is `Array`, the species (the built-in getter, or one
   installed on `Array`: the one read that can run user code, made where the builtin makes it, once), then `in` and
   the read per index and nothing else (`HasProperty` then `Get`, so a Proxy whose `has` trap denies an index gets a
   hole there under both, and a slot written when `in` answered, so a hole stays a hole; an `undefined` the copy
   holds, own or not, is judged dirty by the rest loop without an own-ness probe, as at every array position, #95).
   When the constructor is `Array` and the species is `Array`, the builtin's remaining steps (`ArrayCreate`, the
   stores into it, its length) run no user code, so the copy stands in for them. Stock then iterates its result with
   `for...of`, which reads `Symbol.iterator` off it, calls what it got, reads `next` off the iterator and calls it
   per step; the skeleton makes the two reads on the copy with the same receivers (the copy is a plain array holding
   what the native slice would hold, which is all an accessor on either prototype can tell about its receiver) and,
   when both answered the native array iterator and its `next`, runs the inline index loop, since that iteration is
   the copy's elements in order and runs no user code (the loop closes the iterator through its `return`, read off
   it, when the rest element throws, as `for...of` does); any other answer continues through a real `for...of` from
   the values already read (`restFromMethod`, `restFromIterator` in `emit-tuple-rest.ts`), so the call of the
   method on the copy, the object check on its result, the read and call of `next` per step, the reads of `done`
   and `value`, the close through `return` and every `TypeError` are the engine's own. The sixth review of #88
   found the earlier guard reading the two properties off their prototypes, which invoked an accessor with the
   prototype as receiver where stock's iteration hands it the array or the iterator, so a receiver-sensitive
   accessor could pass the guard and iterate differently under stock; a descriptor check that invokes nothing
   (`Object.getOwnPropertyDescriptor` twice) costs 60 to 80 ns per parse, more than the parse, and a `for...of` over
   the copy that verifies each yield against it costs about a nanosecond per element, where the two reads with
   stock's receivers cost nothing measurable. Any other constructor (a subclass instance, an own or
   inherited `constructor`, another realm's `Array`) or any other species hands the builtin the reads already made
   and lets it finish: `Array.prototype.slice` is called on a facade that answers `length` and `constructor` from what
   was read (the species that was read, when the constructor was `Array`, carried on a plain object the builtin reads
   back without running the getter again) and forwards `HasProperty` and `Get` to the input, so the realm check, the
   species construction, the per-index reads, the writes into the constructed result and the errors are the builtin's
   own, made once. Any other `slice` (an own one, a subclass override, a replaced `Array.prototype.slice`) is called as
   stock calls it, on the function that was read. Both results are consumed with `for...of` like stock's (a Set, a
   generator, any iterable; a non-iterable throws the engine's `TypeError` on an iterable named `rest`, as stock's
   does), the rest element run per yield and its results collected. After the rest ran, the live length is read once
   more: when it equals every read the fixed slots and the copy decided with (the copy's read as the number it was
   converted to) the inline assembly stands, being that algorithm for a length that holds; otherwise, and after every
   continuation, stock's `handleTupleResults` runs over the held results: a slot the length excludes truncates the
   output at the first optional-in slot at or past `optoutStart` (or an excluded slot whose run failed), a covered
   slot's failure is reported (INVALID, stock's rerun), every result it passes is written, the rest results follow,
   and the trailing loop drops trailing `undefined` results of optional-out slots the length excludes and, past
   `items`, makes the read stock makes (`items[i]._zod`), so the engine's own `TypeError` with stock's message is
   thrown from `parse` and `safeParse` alike. So a `slice` getter, a custom `slice`, a species getter or constructor,
   an iterator, a rest callback or a Proxy trap that moves the length or rewrites a slot after that slot's result was
   held gives stock's value, throw and hook calls (the timeline group of the tuple smoke runs one mutation per source
   and target on both sides; the earlier heads of #88 handed such a parse back to stock, whose rerun met the input as
   the hooks had left it and ran them again). What remains is the CoW contract itself: the clean path returns the
   input, so a slot rewritten after its read is visible in that output only (§5.3); a Proxy under-reporting its
   length keeps the clean path, the input with the elements stock never saw (the known limitation of #95, above),
   except that a length converting to `NaN` is never equal to itself and takes the presence decision, stock's fresh
   output; a Proxy sees the skeleton read `length` a different number of times than
   stock's runtime does (the guard, each gated slot, the copy and the presence decision, against stock's slice and
   its two loops); a present slot whose product fails returns to stock at once where stock keeps going and may drop
   the failure with a truncation the rest moved, and that early exit from a continuation's `for...of` closes a
   custom iterator through its `return`, which stock's loop, never exiting early, does not call; a `slice` that is
   not callable throws a `TypeError` on both sides with the engine's message for each call site. `Array.prototype.slice` costs a near-constant 30 ns per call (its
   species lookup and generic entry, not the copy), the inlined loop about a third of that at a short rest; measured
   on #88 (the #78 microbenchmark), a clean parse of `[string, ...string[]]` with one rest element went from about
   79 ns under `slice` to 62 ns, with four from 84 to 69 ns, with sixteen from 117 to 108 ns, an object rest of four
   from 306 to 285 ns, against a stock parse of 170 to 250 ns; the presence decision and the two iterator reads
   cost the fast path nothing measurable over the bare copy (within 1 to 3 ns, the control row's spread; the reads
   measured against the earlier data-property comparison on the same rows, interleaved, sixth review of #88). A rest hole over an inherited `undefined` comes out as an own slot like stock's
   in both layouts, since the rest loop judges the `undefined` the copy holds dirty without asking whether it is own
   (#95); `slice` read the inherited value through `HasProperty` and made it own on the copy, which until #95 kept the
   async layout's clean path there.
3. making the skeleton async: `buildFn` decides between `async (input) =>` and `(input) =>` based on `ctx.async`,
   and the product carries `ZC_ASYNC` so a sub-skeleton's parent notices automatically (`childProduct` returns `kind: "async"`).
4. public API: `Compiled` gains `async: boolean`, `parseAsync` / `safeParseAsync`;
   under an async skeleton the sync API throws `$ZodAsyncError` (the same semantics as the official code; measured, a sync parse on an async tree does throw).
5. plugging the lazy(async) hole: the official product for lazy is a runtime island, so an inner async raises no compile-time error →
   the Promise would leak out silently. `inspectSubtree` detects it statically (recursion over the def tree, covering the fn/superRefine of checks,
   the schema a `z.property` / `z.properties` check carries (review of #84), the transform of pipe, and expansion of the lazy getter, with a seen set to prevent cycles) → an async lazy goes through an async island instead.
   The same walk decides the island of a subtree whose stock compile failed for a non-async reason (#75): a symbol literal,
   coercion, `z.xor` or a `catch` callback throws `ZodCompileUnsupportedError` before stock's codegen reaches the checks, so that
   error says nothing about async, and the fallback of `officialFn` used to take the sync island. The island then met the
   Promise at parse time: `.async` reported false, and since #76 the async entries caught the throw and reran the parse in
   stock's async runtime, so every callback ran twice and the CoW reference was lost. With `inspectSubtree` consulted the
   subtree is an async island, the skeleton awaits it, and a tuple, array or object around it returns the clean input.
   The walk reads every object shape below the subtree, which stock reads only at parse time (`$ZodObject` copies the
   caller's shape on the first read of `def.shape`, so a shape getter may reference a schema still under construction)
   and which stock's compile of a refused subtree never reached, so a shape getter that throws during the walk is
   contained instead of raised from `compile()` (review of #82): the subtree takes the sync island, whose run meets the
   same throw at parse time where stock's parser does, and a getter that resolves by then meets any Promise on the #76
   route.
   A `lazy` whose getter throws at compile time is opaque (#83). Stock never calls the getter before parse time, so the
   throw says nothing about the subtree and the getter counts as sync. The sync island alone would not do: `$ZodLazy`
   memoizes its inner type with `util.defineLazy`, which marks the cell before calling the getter and never resets it
   when the getter throws, so one read through `_zod.innerType` while the getter throws makes every later read answer
   `undefined` and every parse of the schema, stock's own `safeParse` included, end in a `TypeError` (stock's own
   `z.compile()` does this to a schema compiled in a temporal dead zone). Stock's `compileFn` makes that read first
   thing (`isRecursiveSchema`), and so do the presence rules the skeletons decide at compile time, since the lazy's
   `optin` / `optout` / `values` / `propValues` compute through the memo. So the walk reads the getter off `def`,
   `officialFn` takes the island before `compileFn` is tried when the walk saw such a getter, `officialValidator`
   answers `null` (the skeleton serves `validate`, as for #69), and `cowSafeContainerForChild` declines the skeleton of
   a container that would read the lazy's presence, through `presenceReadable` (`purity.ts`), which follows the slots
   stock forwards those values through (`innerType`, `in` / `out`, `options`, `left` / `right`, the getter of a lazy):
   every shape child of an object, the tail slots of a tuple that `getTupleOptStart` scans (both keys, so a lazy in a
   slot the scan never reaches keeps the tuple's skeleton), the inner of an `optional` layer (`emitBoxedContainer`
   reads its `optin`), each option of a discriminated union (`unionSkeletonOk` reads `propValues`). The declined
   container goes to `officialFn` and to the runtime island, where the read happens at parse time like stock's; an
   array, a record, a map or a set never read a child's presence and keep their skeleton with the lazy as an island
   child. A getter that resolves to a sync subtree by parse time (the temporal dead zone: a binding declared later in
   the module, `compile()` called between the two declarations) then answers the sync API like stock, with the
   reference kept wherever the skeleton survived; one that resolves to an async subtree meets the Promise on the #76
   route; one that always throws surfaces its own error from the sync API on the first call and stock's `TypeError`
   afterwards, the sequence stock's schema goes through, and `compile()` leaves the memo untouched. The getter is
   called a few times at compile time (the island decision, the validator check, the gates), where stock calls it
   once, at first parse.
   Since the sixth review of #76 a bare `lazy` goes through this layer's islands whether or not its subtree is async
   (`officialFn`: `makeAsyncIsland` or `makeIsland`), and since #81 / #90 / #91 so does every official subtree holding a
   `lazy` anywhere (under an `optional` / `nullable` layer, in a union of leaves, on either side of a pipe, and under an
   object key through one of those; `subtreeFollowsRuntime` stops at the lazy and answers true). Stock's own product
   for a `lazy` is a runtime island too (`generateLazyCheck` runs the getter's `_zod.run` under an empty context), so
   no compiled fast path is lost for the lazy itself, but its generated code reads `.issues` off whatever came back,
   without the thenable check stock's `runtimeRun` has: a `Promise` a plain function returns inside the lazy (a
   transform, a refine), which no static detector sees, ends in a `TypeError` there, and while the lazy sat inside a
   larger official subtree that `TypeError` left the sync entries where stock's runtime throws `$ZodAsyncError`, and
   the async entries had nothing to catch. In an island the run is owned by this layer: `makeIsland` throws stock's
   class on the thenable (`throwAsync`), the Promise signal the async entries hand to stock's async runtime, and
   `runIsland` records a callback's own `$ZodAsyncError`, so the #80 residual does not reach a lazy position either.
   The cost is the interpreter instead of stock's codegen for the official subtree around such a lazy (a bare `lazy`
   already paid it), and the whole-tree validator behind `validate` for every tree holding a `lazy` (below). The one
   row left unmatched is a stock quirk: stock's runtime meets the thenable of a plain-`Promise` transform inside a
   lazy under an object key in the generated parser of `$ZodObject`, which reads `.issues.length` off it and throws
   a `TypeError`, where the object skeleton calls the lazy as an island and throws `$ZodAsyncError`; the smoke pins
   both sides, and the canary pins stock's compiled lazy check (`compilerLazyCheckThrowsOnThenable`), so an upstream
   fix is the signal to revisit the route.
6. runtime detection (fourth review of #76): a plain function that returns a `Promise` passes every static detector (the
   official `isAsyncFunction` and `isAsyncFn` are syntactic), so the schema is a sync skeleton and the `Promise` is met at
   runtime. The checks subroutine and the official products throw `$ZodAsyncError` there (`throwAsync` in `product.ts`
   throws stock's class, as the official `throwAsync` does; a plain-`Promise` transform answers INVALID in the official
   product, its transform helpers answering INVALID for a `Promise` on purpose, so the parse entries reach stock's throw
   through their stock fallback and `validate` consults stock's sync parse before an INVALID becomes null on a tree
   holding a plain transform, `subtreeHasPlainTransform` in `official.ts` naming such a tree at compile time, a
   `z.codec` decode function, stored on the `pipe` def itself, counting as one, #79; a `lazy` is not descended, since
   a tree holding one has no whole-tree validator and `validate` runs the skeleton, whose lazy is this layer's island
   and throws stock's class on the thenable like the parse entries, #90). The
   sync API lets the throw out, as stock's does; `parseAsync` / `safeParseAsync` catch it on both skeleton
   kinds and, like every INVALID reaching the async entries, hand the parse to stock `safeParseAsync`, which is where stock's
   own `z.compile()` sends every async parse up front (its wrapped run bypasses the compiled parser under `ctx.async`). The
   output is then stock's copy and the callbacks called before the `Promise` run twice, the failure-path duplicate of §6.
   A `$ZodAsyncError` a callback throws itself (a nested sync parse of an async schema does) is the caller's, not that
   signal (fifth review of #76): the checks subroutine wraps every predicate call, `settleChecks` every awaited predicate
   and both islands their run in `rethrowCallerError` (`product.ts`), which records the error in a WeakSet, and
   the async entries rethrow a recorded one (`isPromiseSignal`), so the parse rejects after one call, as stock does. For
   an island that covers a rejection of the async island's run and a throw that leaves either island's run synchronously
   (`runIsland` in `official.ts`, sixth review of #76): the interpreter calls a sync callback before the run has come
   back, and it never throws `$ZodAsyncError` on its own under the contexts the islands hand it (its three check and
   parse chain sites fire only under `async: false`, the sync island's empty context chains a Promise instead; the
   core transform node's site only under a falsy `async`, and the async island runs under `async: true`, the context
   stock's async runtime hands the subtree), so a synchronous throw of that class out of `_zod.run` is a callback's.
   A callback that stock's generated code calls (a leaf `.refine` / `.check` / `.superRefine` inside an official
   product) reports its `Promise` from stock's own `throwAsync`, which this layer cannot mark, so its
   `$ZodAsyncError` still takes the fallback and the callback runs twice; tracked in #80 with the options (an upstream
   marker on that throw is the cheap exact fix). A callback inside a `lazy` is not such a callback since #81 / #90 /
   #91: the official subtree holding the lazy is an island, whose `runIsland` records the throw.

A semantic the layer preserves: a sync island (`makeIsland`) throws `$ZodAsyncError` when it meets a Promise (the same comment as the official
compile.js `throwAsync`: returning INVALID would be read by a union as a branch rejection, so the throw must survive). That throw
is this layer's own (`throwAsync` in `product.ts`), unrecorded, so the async entries hand the parse to stock's async runtime; a
throw that leaves the island's `_zod.run` itself is a callback's and is recorded (§5.5 item 6).

In a mixed tree only the async subtree positions pay the microtask cost, everything else keeps the reference-comparison skeleton
(S7 in run 33948313612: an async transform scenario over 5 000 rows, 1.55x vs stock safeParseAsync, allocation -30%; 1.83x in run 33940596453 and 2.67x in run 33837195401, all inside runner noise at that row count).

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
  │     │     │     │     ├─ generation failed → makeIsland (black-box _zod.run, throws $ZodAsyncError on a Promise),
  │     │     │     │     │     or makeAsyncIsland when inspectSubtree says the subtree holds an async check (#75;
  │     │     │     │     │     a shape getter that throws during that walk keeps the sync island, review of #82;
  │     │     │     │     │     a subtree holding a lazy takes the island before compileFn is tried, #83, #91)
  │     │     │     │     ├─ ZodCompileAsyncError → makeAsyncIsland (await channel) ★v0.5
  │     │     │     │     └─ an optional / nullable layer with a non-callback check anywhere in the subtree
  │     │     │     │           (subtreeFollowsRuntime, #69) → makeIsland / makeAsyncIsland before compileFn is tried:
  │     │     │     │           stock's compiler answers the shortcut value differently from its runtime
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
Sync skeleton (ctx.async = false):
  parseAsync/safeParseAsync run the fast path and fall back to stock safeParseAsync on INVALID, and on the
  $ZodAsyncError the fast path throws when a plain function returned a Promise (§5.5 item 6); a $ZodAsyncError a
  callback threw through this layer's own call sites is recorded and rethrown instead (isPromiseSignal).
  validate runs the official validator (or the skeleton, #69) and answers null on INVALID; on a tree holding a plain
  transform (subtreeHasPlainTransform) it consults stock's sync parse first, since the official transform helpers
  answer INVALID for a Promise where stock throws $ZodAsyncError (#79); a tree holding a lazy has no whole-tree
  validator, so validate runs the skeleton, whose lazy island throws stock's class on the thenable (#90).
```

A check attached to an optional / nullable layer through `.check()` (`z.string().optional().check(z.minLength(3))`) is a
fourth reason for an island (#69). Stock's compiler emits every non-callback check as an inline test of the value's own
properties without the runtime's `when` guard, so on the shortcut value a length / size check reads `.length` / `.size`
off `undefined` / `null` and throws where the runtime's default `when` passes, and a range check is skipped where the
runtime evaluates `undefined > n` and fails. The two callback checks (`custom`, `overwrite`) are called with the layer's
value as the runtime calls them and keep their routes. `wrapperFollowsRuntime` (`purity.ts`) names such a layer, `isPure`
judges it impure so no pure subtree holds one (the direct `assertOnly` compile of `emitNode` therefore never meets it),
`subtreeFollowsRuntime` (`official.ts`) walks the official subtree for one, or for a `lazy` (#81, #90, #91: stock's
compiled lazy check reads `.issues` off a thenable where the runtime throws `$ZodAsyncError`, §5.5 item 5; the walk stops
at the lazy, whose expansion stock runs in the runtime anyway; the schema a `z.property` / `z.properties` check carries is
descended, since stock's `generatePropertyCheck` compiles it inline and a wrapper inside it meets the same disagreement,
review of #84; `childrenOf` is the enumeration both walks share) and `officialFn` takes the island for the whole subtree,
the async answer of `inspectSubtree` choosing which; `officialValidator` declines a tree holding one, so `validate` runs
the skeleton. The canary pins the three divergences.

Actual behavior for recursive schemas: the top-level skeleton of `z.object({children: z.array(z.lazy(() => Tree))})`
compiles as usual. The lazy subtree goes through this layer's runtime island at the element position (`subtreeFollowsRuntime`
answers true at the lazy, §5.5 item 5), which runs the getter's schema and handles circular references correctly
(smoke test #9: `stock: false` and the semantics are normal).
What really degrades the whole tree is a top-level recursive schema (a circular reference in the def tree, which the official compileFn rejects).

## 7. Benchmarks (Benchmarks workflow run, 50 000 accounts, node v24, --expose-gc, medians over complete rotations of the candidate order)

The numbers come from [Benchmarks workflow run 33948313612](https://github.com/iceboundrock/zod-cow/actions/runs/33948313612) on a GitHub-hosted `ubuntu-latest` runner with `BENCH_N=50 000`, measuring the built `zod-cow-v4` package. The single-record hot-loop rows come from [run 34069671088](https://github.com/iceboundrock/zod-cow/actions/runs/34069671088) of the same workflow at `BENCH_ITERS=1 000 000` operations per timed round (100 000 for the S10 rows that build detailed errors; #45): at the 50 000 operations of run 33948313612 a hot-loop round was 1 to 5 ms, where JIT state and scheduling noise dominate, and the identical `z.compile()` loop read 29 ns in one calibration row and 53 ns in the next; `BENCH_N` and the batch rows are unaffected. Every candidate gets at least 2 warmup and 3 timed rounds, both counts rounded up to a multiple of the candidate count so the rounds form complete rotations of the candidate order (5 plus 5 with five candidates: every candidate holds every position equally often); rounds are separated by `gc()`, every timed call verifies its own result, and an equivalence gate runs valid and invalid fixtures plus the generated dataset through every implementation before timing, in every scenario including each S3 ratio (`packages/bench-v4/harness.ts`, `gates.ts`). The columns are stock zod4 (`safeParse`), the public compiled API of Zod 4.5 (`z.compile(schema).safeParse`, `z.validate(compiled, data)`), zod-cow-v4 and ArkType 2.2.3 through its normal public API on a schema with the same constraints where one exists, `N/A` with the reason otherwise (the cross-library table is in the README). The internal `compileFn` / `assertOnly` product that this layer reuses is measured in a diagnostic table of the same run against the public column: level (1.00x on S1, 1.01x on S2, 1.02x to 1.06x across S3, 1.04x on S8; the public wrapper is the internal parser plus a result object), so the public API is the baseline. Runner noise at this record count exceeds the S1 / S3 gaps: [run 33945725973](https://github.com/iceboundrock/zod-cow/actions/runs/33945725973), the same suite on the same branch one commit earlier (with the tuple-inlining experiment that was then reverted for no gain), read every column 5 to 20% lower and S3 at 1.13x to 1.18x against `z.compile()` where this run reads 0.88x to 0.97x. The superseded tables from runs 33940596453 and 33837195401 and the earlier local 500 000-record measurement are kept in the CHANGELOG.

| Scenario | stock | z.compile() | zod-cow-v4 | ArkType |
|---|---|---|---|---|
| S1 clean-input parse (no undeclared keys) | 68ms | 23ms | **24ms** | 23ms |
| S1 allocation pressure / retained | +18.0MB / +11.6MB | +11.0MB / +10.8MB | **+3.1MB / 0.0MB** | +5.4MB / 0.0MB |
| S2 10% default | 69ms | 23ms | **25ms** | 805ms |
| S2 allocation pressure / retained | +19.8MB / +11.6MB | +18.2MB / +11.6MB | **+4.1MB / +1.0MB** | +91.2MB / +11.6MB |
| S3 sweep 0% / 25% / 50% / 100% dirty | 68/69/70/70ms | 23/23/23/24ms | **23/25/26/25ms** | 806/806/799/781ms |
| S3 retained | +11.6 to +12.3MB | +11.6MB constant | **0.0 / 2.0 / 3.6 / 6.9MB** | +11.6MB constant |
| S4 validation only | N/A (no validation-only API) | 17ms (`z.validate`) | **18ms** (`validate()`) | 23ms (`.allows()`) |
| S5 record/map/set | 81ms | 41ms | **30ms** | N/A (`Map`/`Set` instanceof-only; non-equivalent reference 10ms) |
| S5 allocation pressure / retained | +54.0MB / +21.7MB | +49.6MB / +21.7MB | **+29.4MB / 0.0MB** | N/A |
| S6 tuple | 43ms | 14ms | **5ms** | 2ms |
| S6 allocation pressure / retained | +55.0MB / +20.6MB | +20.2MB / +20.2MB | **+1.5MB / 0.0MB** | +0.0MB / 0.0MB |
| S7 async transform (5 000 rows) | 12ms (safeParseAsync) | N/A (an async schema is handed back uncompiled) | **7ms (safeParseAsync)** | N/A (no native async morph) |
| S7 allocation pressure | +12.8MB | N/A | **+9.0MB** | N/A |
| S8 strip-unknown parse parity | 79ms | 29ms | **24ms** | 1092ms (`onDeepUndeclaredKey("delete")`) |
| S8 allocation pressure / retained | +28.2MB / +11.6MB | +11.2MB / +10.8MB | **+8.0MB / +8.0MB** | +157.5MB / +66.6MB |
| S10 parse failures, per-row safeParse, 1% / 10% / 50% / 100% invalid | 69/88/151/224ms | 18/40/128/227ms | **25/47/132/231ms** | 30/91/287/426ms |
| calibration parse, single 6-field record (ns/op) | 232ns | 29ns | **69ns** | 40ns |
| calibration parse, `ownSymbolKeys: "ignore"` (opt-in, #43; ns/op) | N/A (unchanged) | 34ns | **38ns** | N/A (unchanged) |
| calibration validate, same record (ns/op) | N/A | 22ns | **19ns** | 20ns |
| S9 validation-only failure, first / last / nested / email / tuple (ns/op) | N/A | 1550/1689/1807/2490/869ns | **17/166/165/92/31ns** | 172/16/21/145/31ns |
| S10 parse failure with errors, first / last / nested / refine (ns/op) | 3621/3576/3693/3475ns | 3578/3762/3807/3754ns | **3563/3819/3727/3929ns** | 6859/11886/7161/5843ns |

Ratios against zod-cow-v4 (above 1 = the other implementation took longer): stock 2.80x (S1), 2.72x (S2), 2.88x / 2.78x / 2.64x / 2.80x (S3), 2.75x (S5), 8.04x (S6), 1.55x (S7), 3.35x (S8); z.compile() 0.95x (S1), 0.90x (S2), 0.97x / 0.94x / 0.88x / 0.97x (S3), 0.93x (S4), 1.39x (S5), 2.62x (S6), 1.22x (S8), 0.42x (calibration parse), 0.89x (calibration parse with the opt-in), 1.16x (calibration validate); ArkType 0.97x (S1), 31.90x (S2), 30.27x to 34.42x (S3), 1.25x (S4), 0.40x (S6), 46.28x (S8), 0.59x (calibration parse), 1.09x (calibration validate).

How to read it:

1. Against stock: 2.6x to 8.0x on the sync batch scenarios, with retained memory going from 12~22MB to zero on clean input; the async scenario (S7) is 1.55x at 5 000 rows, where runner noise weighs heavily.
2. Against the public compiled API: level on object input within runner noise at every dirty share (S1 0.95x, S2 0.90x, S3 0.88x to 0.97x here, 1.13x to 1.18x in run 33945725973), ahead on strip input (S8 1.22x) and in the container scenarios (S5 1.39x, S6 2.62x). The dirty and strip results are the copy path of §3.1: the copy is the same shape-ordered literal the compiled parser builds, so a dirty row costs what a compiled row costs while the clean rows around it cost nothing, and the untouched nested arrays are shared. Before this change (run 33940596453) the copy was a spread plus `delete`, S3 read 24 / 28 / 31 / 36ms (0.70x at 100% dirty) and S8 measured locally at 500 000 rows was slower than stock (1038ms against 686ms, with 637MB retained: the deleted-from copies were dictionary-mode objects; 205ms and 80MB after). Behind on per-row parses of small objects (calibration parse 0.42x, S10 1% invalid 0.73x), which is the per-object cost of the strip probes (§3.1: about 45ns of a 65ns skeleton call on a 6-field record, 36ns of it the own-symbol probe).
3. Against ArkType: level on the clean parse (S1 0.97x), ahead on validation-only (S4 1.25x, calibration validate 1.09x), behind on tuples (S6 0.40x, 2ms against 5ms: ArkType's precompiled check returns the input and allocates nothing, while the skeleton pays the strip probes per row; inlining the tuple sub-skeletons into the row skeleton was measured at no gain and reverted, §5.4) and on the single-record parse (0.59x, the same probes). The S2/S3/S8 gap is architectural: a type with any morph (a key default or an undeclared-key deletion is one) loses ArkType's `allows` root-apply strategy and runs the contextual one, an interpreted `traverseApply` over a `Traversal` context whose `finalize` deep-clones the whole input before applying the queued morphs (`@ark/schema` `node.js` / `traversal.js`), so every row is rebuilt at every ratio (+90MB allocated in S3, +158MB in S8, 781 to 1092ms at 50 000 rows, independent of the dirty share). zod-cow compiles the default as an ordinary official leaf and copies only the rows that changed. S1 compares the clean fixture only (zod strips undeclared keys into a copy, ArkType keeps them by reference); S8 is where both implementations do the same work.
4. Failure paths (S9, S10): `validate()` answers from the compiled validator alone (17 to 166ns), the public `z.validate` falls back to the runtime parser on failure (0.9 to 2.5µs), ArkType's `.allows()` checks keys in its own cost order (16ns when the cheap boolean fails, 172ns when `id` does; zod checks in declaration order). With detailed errors every zod path costs 3.5 to 3.9µs per invalid record: the fast path of the two compiled variants is a small fraction of the runtime parse that builds the `ZodError`, so the double work of "fast path first, runtime on failure" is not visible; a failing refine predicate runs twice for `z.compile()`, zod-cow and ArkType, once per successful parse everywhere. On mixed datasets zod-cow follows the invalid share, 2.79x (1%) to 0.97x (100%) against stock.
5. async channel (S7): the async children of a container are started together and settled by one `Promise.all` (#71), so async subtree positions pay one round trip and the rest keeps the reference-comparison skeleton; an all-dirty async transform scenario is 1.55x here, with allocation -30% (12.8→9.0MB).
6. validate fast path: `validate()` is the official assertOnly whole-tree product of the same array schema, so S4 reads level with `z.validate` by construction (18ms against 17ms, 0.93x). Its value is the validation-only cost: 18ms / 50 000 = 360ns per account, with nothing retained after GC (the +2.0MB is the `tags` arrays the official array product materializes even in assertOnly mode once a size check such as `.max(8)` is present).

S1's +3.1MB of short-lived allocation is the strip probe's own-symbol array: exactly one empty array (32 bytes) per object, 100 000 objects at 50 000 accounts with a nested address, read to prove that the object can be returned by reference. The official leaf products allocate nothing measurable (the datetime/email format checks included; measured per leaf with the sampling heap profiler and `heapUsed` deltas on Node 24), and nothing is retained after GC: CoW itself copies no containers. In the v0.5 local measurement v1 allocated less (12.1MB against zc-z4's 30.5MB) but was twice as slow; the trade-off between speed and a small amount of short-lived allocation was decided in favor of zc-z4 in a production context (where minor GC is cheap), which is also one of the reasons v1 was eventually removed.

## 8. Correctness evidence

- `packages/zod-cow-v4/tests/smoke-z4.test.ts` (22 groups of behavioral assertions; the twenty-second, the review of #73: `z.exactOptional` above a container, a further wrapper or a union with a container option rejects `undefined` like stock at the top level and under a key, keeps strip and the leaf options on the official parser, and over a leaf stays on the validator; the twenty-first #58: a union of strip objects shares the clean input through its first and through a later option, a fired default copies like stock, strip / strict / loose options behave like stock, a nested union shares with its parent when clean and copies only the dirty path, leaf and container options mix, a discriminated union dispatches and shares, `optional(union)`, `array(union)` and a nested union reach the skeleton, an optional over a union with a defaulted option fires the default like stock (also under a refine and under a further nullable), the union's own refine, overwrite and superRefine behave like stock, `z.xor` and an async option take the official product, a leaf-only union keeps the validator, and the dump lists one nested skeleton per container option; the twentieth #71: set members that are tuples, objects, enum records or arrays with two async children settle in stock's order, the children's side effects interleave like stock (the second key's transform starts before the first settles), a rejecting child next to a failing sync sibling rejects the parse with nothing reaching `unhandledRejection`, and the async layout of a tuple (fixed slots or rest), object, array and enum record awaits one `Promise.all` and nothing else while a sync tuple awaits nothing; the eighteenth #56: a refine on an optional / nullable wrapper above a container rejects like stock at the top level and nested (object and array, and the same above a record, a map, a set and a tuple), sees the shortcut value, runs in stock's order along a two-wrapper chain, sees the stripped copy and keeps sharing when it passes, a superRefine on such a wrapper takes the official parser (an async refine keeps the skeleton and shares since #13), and a length / size check attached to the wrapper through `.check()` takes the official parser and strips like stock above every container kind, at the top level and under a key; the nineteenth #57: an overwrite or a superRefine on a wrapper around a leaf rewrites like stock at the top level, under an object key and as a union option; the twelfth and thirteenth the `ownSymbolKeys` option: default and `"probe"` still copy on an undeclared symbol, `"ignore"` returns the input by reference with the symbol kept, keeps strip semantics for string keys and the copy path, validates declared symbol keys, reaches nested skeletons under every container (object, array, tuple, record, map, set), treats a non-enumerable undeclared symbol like an enumerable one, rejects an unknown value, an explicit `null` or a non-plain options object with `TypeError` (also when the rejected object carries a throwing `constructor` / `name` accessor or a throwing Proxy `getPrototypeOf` trap, when the rejected value carries a throwing `toJSON` or Proxy `get` trap, is a bigint, a symbol, a function or a cycle, and when the options object is a Proxy whose `getOwnPropertyDescriptor` / `get` trap throws, then with the trap's error as `cause`), treats an explicit `undefined` as the default, ignores an `ownSymbolKeys` inherited from `Object.prototype`; then the same probe in strict and loose mode, #42: default copies on an undeclared symbol, enumerable or not, and shares the same input without it, `"ignore"` shares and emits no probe, the copy path drops the symbol under both settings, strict still rejects an undeclared string key, loose keeps one in the copy while dropping the symbol, declared symbol keys count as known, a nested loose object is reached; the fourteenth #47: a union with a strip-object option drops an undeclared key like stock at the top level and nested with the sibling still shared, a strict option drops an undeclared own symbol, `optional(object)`, `array(object)` and discriminated-union options strip like stock, and a leaf-only union keeps the validator so its parent shares; the fifteenth #46: `code` of a schema with object, array, tuple, record, map and set children holds the top-level source first and one `nested skeleton` header per nested skeleton, carries a probe per object skeleton by default and none under `"ignore"`, and a schema without nested containers has no header; the sixteenth #51: strict and loose enum-keyed records copy and drop an undeclared own symbol, enumerable or not, under the default and `"probe"`, share the same input without it, `"ignore"` shares and emits no probe, the copy path drops the symbol under both settings, string-keyed, checked-string-keyed and number-keyed records still reject an enumerable symbol key and copy-and-drop a non-enumerable one without a probe call, a key schema that admits symbols and a loose record keep the symbol like stock, and a nested enum record under a strip object is reached; the seventeenth #48: a non-enumerable undeclared string key survives the clean path of every object mode and every record path (the number-keyed record included) and is dropped by the copy path like stock, a class instance is returned as it is while the copy is a plain object and records reject it on both sides, an inherited enumerable key is copied by strip like stock, rejected by strict on both sides and kept inherited by loose where stock writes it as an own key, a throwing `ownKeys`, `getOwnPropertyDescriptor` or `getPrototypeOf` trap throws from strip's `for...in` probe under both settings where stock's strip parses, throws on both sides for strict and for loose's `ownKeys` by default, and is not consulted by loose for `getOwnPropertyDescriptor` or `getPrototypeOf`, nor for any of the three under `"ignore"`, and the object skeleton's `code` carries no explicit descriptor or prototype probe) + `packages/zod-cow-v4/tests/smoke-z4-containers.test.ts`
  (the three record paths / map / set / size checks / container combinations) + `packages/zod-cow-v4/tests/smoke-z4-tuple-async.test.ts`
  (tuple truncate/fill/rest/refine + the async channel through array / record / map / set / tuple children and object keys / lazy(async) / union async branches; the override cases of its #78 group and every case of its #88 timeline matrix run on the sync rest layout and on an async twin whose first slot carries an async refine, #94, except the array-iterator swaps of the matrix, which stock's own `Promise.all` consumes; its last group pins the two decisions of #95: no own-ness probe in any array-shaped skeleton, an explicit `undefined` element copying to stock's output, and the array skeleton under every under-reported Proxy length) all pass.
- Historical v0.5 run of `packages/zod-cow-v4/tests/differential-z4.test.ts`: 50000 cases (seeds=500×100, randomly nested
  object/array/tuple/record/map/set/union + optional/nullable/default/refine/transform
  + async refine / async transform wrappers), fully consistent with stock zod4:
  - success/failure parity identical (20813 successes / 29187 failures)
  - outputs identical under `deepStrictEqual` (Map and Set contents compared in iteration order on every parse, #67, #70)
  - zero input distortion (compared against a structuredClone snapshot)
  - top-level reference-sharing rate 89.1% (over successful cases), 0 degradations to stock
  - since #43 the suite runs every case a second time compiled with `ownSymbolKeys: "ignore"` against the same RNG stream minus the extra own symbol (the one input the option treats differently from stock; since #42 the generator emits it in every object mode, so the default pass compares strict and loose objects carrying an undeclared symbol against stock, which the previous generator excluded), with the same three checks plus: no generated skeleton at any depth carries `getOwnPropertySymbols` (`compiled.code` covered the top-level skeleton only until #46, which appends the nested skeletons to the dump), and the pass shares at least as many top-level references as the default pass (at the 20 000-case default after #42: 88.8% default, 89.4% with the option among successful cases, 0 degradations in both). Since #51 the two record generators emit the extra own symbol too (one in ten, half of them non-enumerable through `Object.defineProperty`), the input snapshot keeps enumerability, and the runner pins the symbol's presence on the top-level output next to the `deepEqual` comparison, because the harness comparator copies enumerable keys only and would not see a non-enumerable symbol surviving by reference; on the unfixed engine that generator fails 26 of 20 000 cases in the default pass (all that check), on the fixed engine none, and the sharing rate at the default size is 85.1% (default) and 86.0% (`"ignore"`) on both engines with the new generator, from 85.6% / 86.2% with the previous one
- since #47 the generator emits unions (2 to 3 random options, one in four a discriminated union of two object branches), which the list above had claimed while no union was generated; on the unfixed engine the new generator failed 15 of 20 000 cases in the default pass and 11 in the `"ignore"` pass, all output mismatches of the trap-four shape, and the fixed engine fails none. Top-level reference sharing among successful cases at the default size is 85.6% (default) and 86.2% (`"ignore"`), from 85.9% and 86.6% on the unfixed engine with the same generator (the union-of-containers CoW path given up by the rule) and 88.8% / 89.4% with the previous generator.
- since #56 one wrapped child in three carries a second check on top of its wrapper (a sync or async refine, or an overwrite that upper-cases a string, #57) and the refine predicate rejects a container with exactly three entries as well as the string "forbidden"; on the unfixed engine that finds 5 of 20 000 cases in each pass (a wrapper refine above a container never run, or a wrapper overwrite above a leaf judged pure), and the fixed engine fails none. The sharing rate at the default size is 85.4% (default) / 86.1% (`"ignore"`) among successful cases, the previous generator reading 85.1% / 86.0% on both engines.
- since #61 one enum-keyed record in five declares the shared symbol next to its string or numeric keys, as a symbol value of the enum's entries form (`z.enum({ K0: "k0", S: sym })`), and one in forty declares nothing but that symbol through `z.literal(sym)`, next to the extra undeclared symbol of #51, so the hoisted-`Set` form of the record's own-symbol probe (`emitOwnSymbolProbe`, the branch that compares every own symbol against the known-key `Set` instead of testing the length) and its absence under `"ignore"` run under the differential checks, as they have on objects since #33 (one shape in ten declares a symbol key there). The input writes a declared symbol as an enumerable data property, never a non-enumerable one, because a declared key the input defines as non-enumerable comes back as it is on the clean path (#48, pinned by smoke group 16), and the `REPRO` dump now prints the symbol-keyed entries of an input, which `JSON.stringify` dropped. The sharing rate at the default size is 81.7% (default) / 82.4% (`"ignore"`) among successful cases, from 81.4% / 81.9% with the previous generator. The shifted random stream also surfaced one case of #71 in each pass (seed 108, case 55: a set of tuples with two async children each, whose members stock adds in settlement order while the tuple skeleton's in-place awaits settled a member with two async children a round later than one with a single), no symbol involved, fixed in the same PR.
- since #71 the object, enum-keyed record, array and tuple skeletons call every child before the first await and settle the async ones with one `Promise.all`; on the unfixed engine the default-size stream of #61 fails 1 of 20 000 cases in each pass (the set-of-tuples case above), on the fixed engine none, with the sharing rate unchanged at 81.7% / 82.4% among successful cases, since the layout changes no output value.
- since #58 a union with a container option gets the union skeleton instead of the official parser; the generator is unchanged, and the default-size stream reads 82.5% (default) / 83.3% (`"ignore"`) among successful cases, from 81.7% / 82.4% with the parser fallback of #47, 0 degradations, every case agreeing with stock; at 50 000 cases (seeds 500 × 100) 82.1% / 82.8% with the same result. The first skeleton failed seed 145, case 12 in each pass (the defaulted-optional shape described under trap four), fixed before merge.
- Since #99 the one-in-forty object property draw targets the reserved undeclared `propertyExtra` key one third of the time, with equal required/optional string schemas; the declared `f0` branch is retained. In every object mode, independent draws add a non-enumerable own key (one quarter) and an occasionally shadowed non-enumerable inherited key (one tenth), with string and non-string values, alongside existing extras. Only registered generator-created prototypes are normalized to plain objects for enumerable-output equality; mutation snapshots separately capture all own descriptors, hidden/symbol values, extensibility, and generated prototype identity/state, recursively through containers. Replay annotates hidden own and inherited data. Helper checks pin these distinctions, holes, class-instance boundaries and Map order. Schema/default probing uses the same symbol policy in both passes; only case input generation omits the symbol under `"ignore"`, and per-case RNG draw counts must match.
- Current #99 verification on Node 24.20.0: at 200 × 100 cases, default / `"ignore"` success counts are 7 814 / 7 864, failure counts 12 186 / 12 136, sharing 82.0% / 83.1% among successes (32.1% / 32.7% overall), and 0 degradations. Both passes retain one output-order mismatch at `REPRO=150:57`, also the only mismatch per pass at 500 × 100 cases (82.4% / 83.3% sharing among successes). [#105](https://github.com/iceboundrock/zod-cow/issues/105) tracks the reduced reproduction: a statically async empty Set completes synchronously in stock, while generated async container/wrapper products add Promise hops and reverse two outer Set members. It has no property check or hidden key; no generator exclusion or order-comparison relaxation hides it. The default-size property schema/input counters cover 35 required and 48 optional cases, including 42 non-object roots, 26 schemas containing unions, 57 async products, 33 inputs with hidden own keys and 13 with generated prototypes. These overlapping counters describe schema/input composition, not proof that every check executes after prior validation failures.
- Known misalignment (deliberately kept): with an async rest slot and a nullable null input, the stock runtime produces
  a sparse array and loses the null (deterministic repro: `z.tuple([z.string()], z.boolean().nullable().refine(async …))
  .safeParseAsync(["a", null, null])` → ownKeys "0,2,length", slot 1 becomes a hole).
  The skeleton outputs a dense array (which is more correct), and the differential generator avoids that combination; see upstream-issue-draft.md §Bonus.
- Failure diagnostic hook: `REPRO=seed:case pnpm --filter zod-cow-v4 exec tsx tests/differential-z4.test.ts`
  prints the schema description, the input, and the CoW skeleton source: the top-level skeleton first, then every nested
  container skeleton the tree built (a separate `Function` build each, reaching its parent as a hoisted constant), in build
  order under a `// ── nested skeleton #n ──` header. `CodeCtx.sources` carries them: `subFn` gives a child context its
  parent's list and `buildFn` appends every built body, and a sub-skeleton that failed and was replaced by an official
  product is dropped again so the dump holds only functions the tree calls (#46).

## 9. Version anchor and risks

The unsupported surface we depend on (all reachable through the public `zod/v4/core` permalink subpath, but positioned as internal by the official comments; only the two `ZodCompile*` errors are public API):

| API | Purpose | Drift risk |
|---|---|---|
| `compileFn(schema, {assertOnly, debug})` | leaf/subtree products | signature change (low); behavior changes are backstopped by the differential tests |
| `INVALID` | failure sentinel | extremely low (Symbol.for is stable) |
| `ZodCompileUnsupportedError/AsyncError` | degradation verdict + the async detector (v0.5) | low |
| `$ZodAsyncError` | the official semantics of throwing when a sync island meets a Promise; the sync API on an async skeleton; the fast path's Promise signal the async entries catch (§5.5 item 6), a public class a callback can throw too, which is why a callback's own throw inside an official product is indistinguishable (#80) | low |
| `regexes.number` / `util.isPlainObject` | record skeleton | low (the official internals depend on the same ones for consistency) |
| `WHEN_DEFAULTED_CHECKS` / `fastPathAcceptsAbsence` and other semantic predicates (implementation copied, not imported) | purity analysis | medium: must be synced when zod changes the `when` semantics |
| `getTupleOptStart` / `dropsWhenAbsent` (implementation copied, not imported) | tuple trailing-slot truncation semantics (v0.5) | medium: must be synced when zod changes the optin/optout ladder |

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
  optimizations benefit it automatically; speed is level with the public compiled API on objects at every dirty share, ahead on strip input (S8 1.22x) and on containers (record/map/set 1.39x, tuple 2.62x), async 1.55x vs stock
  (2.6~8.0x against stock on the sync batch scenarios; run 33948313612, see §7), with GC-retained memory down to zero.
- Both routes share the same CoW mental model: reference comparison is the dirty signal, path-copying is the copy strategy.
  The only difference is who implements the validation and transformation layer.

## 11. Source layout (issue #5)

The engine lives in `packages/zod-cow-v4/src/cow4/` as a set of modules cut along the seams described above; every function kept its body and comments when it moved, so the sections of this document still map one-to-one onto the code.

| Module | Section of this doc | Holds |
|---|---|---|
| `index.ts` | §6 | Thin entry: `compileCowFn`, `compileCowDebug`; re-exports `INVALID`, `Fn`, `ZC_ASYNC`, `isAsyncProduct`, `officialValidator`, `CompileOptions`, `resolveOptions` |
| `product.ts` | §5.5 | `Fn` product contract, `ZC_ASYNC` marker, `isAsyncFn`, `throwAsync` |
| `options.ts` | §3.1 | `CompileOptions` (public), the resolved `CowOptions`, `DEFAULT_OPTIONS`, `resolveOptions` (#43) |
| `codectx.ts` | §3 | `CodeCtx` (carries the resolved options and the shared `sources` list of the debug dump), `escKey`, `buildFn` |
| `predicates.ts` | §9 | Verbatim zod copies: `acceptsAbsence`, `requiresPresence`, `mayOutputUndefined`, `getTupleOptStart`, `dropsWhenAbsent` |
| `purity.ts` | §4 | `isPure`, `leafChecksArePure`, `checksAreCowSafe`, `WHEN_DEFAULTED_CHECKS`, `cowSafeContainerForChild`, `presenceReadable` |
| `official.ts` | §6 | `officialFn`, `officialValidator`, `makeIsland`, `makeAsyncIsland`, `inspectSubtree`, `subtreeFollowsRuntime`, `subtreeHasPlainTransform` |
| `emit.ts` | §3, §5.3 | `emitNode`, `emitBoxedContainer`, `childProduct`, `containerChildFn`, `containerChecksFn`, `subFn` |
| `emit-object.ts`, `emit-array.ts` | §3.1, §3.2 | `emitCoWObject`, `emitCoWArray` |
| `emit-tuple.ts` | §5.4 | `emitCoWTuple`: the fixed-slot segments and the async layout's start and settlement |
| `emit-tuple-rest.ts` | §5.4 | `emitSyncRest`, `emitAsyncRestStart`, `emitAsyncRestDecision`: the rest segment of both layouts and the presence decision after it (#87, #88, #94), sharing the slice source and stock's `handleTupleResults` over the held results; `nativeSliceFrom`, `restFromMethod`, `restFromIterator`; imported by `emit-tuple.ts` only, outside the cycle below |
| `emit-record.ts`, `emit-map.ts`, `emit-set.ts` | §5.1, §5.2 | `emitCoWRecord`, `emitCoWMap`, `emitCoWSet` |
| `emit-union.ts` | §4 trap four | `emitCoWUnion` (#58) |

`emit.ts` and the seven `emit-*.ts` modules import each other: `emitBoxedContainer` dispatches to the skeletons, and the skeletons recurse into child containers through `containerChildFn` / `childProduct`. The cycle is safe because every binding involved is a hoisted function declaration and none of these modules executes anything at load time. Do not add top-level code that calls across the cycle.

## Appendix A. Structural differences between zod3 and zod4 (probed)

This table was written for the removed self-written zod4 front-end (v0.2) and moved here from the README in issue #7. It describes stock zod3 vs zod4, so it still constrains the current line; every row was anchored by `src/probe-z4.ts`.

| Dimension | zod3 | zod4 |
|---|---|---|
| checks location | the wrapper type (the checks array on `ZodString`) | a flat `def.checks`, and `z.email()/z.iso.*()/z.int()` attach the format check directly on the def itself (`def.check`) |
| check instance | `c.kind` + `c.value` | `check` kinds are named differently (`min_length/max_length/greater_than/string_format/number_format/overwrite/custom`…), and may be an instance or a bare def, so they need normalizing |
| `.int()` | `ZodNumber` check kind `"int"` | `number_format "safeint"` (isInteger + the 2^53 range, out of range reports too_big) |
| object mode | the `def.unknownKeys` flag | strict = `catchall: never`, loose = `catchall: unknown` |
| object output rebuild | the `alwaysSet` rule | driven by `optin`/`optout`: an absent optional key is not materialized, a present undefined is kept, an absent required key reports `nonoptional` |
| `.default()` | the default value must pass the inner validation | short-circuits (the default value is not validated); and `handleDefaultResult` fills in the default when the inner produces undefined |
| `.optional()` | passes undefined straight through | when the inner has `optin === "defaulted"` it hands undefined to the inner (so the default fires) |
| `.catch()` | swallows exceptions | does not swallow exceptions (only a validation failure falls back to the catch value) |
| `.transform()` | `ZodEffects` | `pipe(in, transform)`; `fn(value, payload{issues, addIssue})` |
| refine | `ZodEffects.refinement` | a `custom` check inside `def.checks`; every check instance has a lazily compiled `_zod.check(payload)`, which serves as the generic channel for kinds we did not hand-write |
| string format | regexes copied verbatim into `regexes.ts` | a `string_format` check carries its own pattern regex (email/uuid/datetime/ipv4… inlined directly) |
| record keys | string only | number keys are supported (retried by falling back to the numeric string); enum/literal keys are declaration-driven (all declared keys required + extra keys report unrecognized_keys) |
| NaN | `invalid_type received nan` | same as zod3 (z.number() rejects NaN) |
