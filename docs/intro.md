# Validation Does Not Have to Rebuild: A Copy-on-Write Experiment on Zod 4's Compiler

# TL;DR

Numeric doubled Zod's throughput by returning the input object instead of a copy, at the price of removing every feature that can change a value. I wanted to know whether the same win survives when transforms stay. So I built a copy-on-write layer on top of Zod 4's own compiler and measured it: what it wins, what it costs, and which of my own optimizations I had to throw away.

## Numeric's observation

In March 2025 Justin Chang at Numeric published [How we doubled Zod performance](https://numeric.substack.com/p/how-we-doubled-zod-performance-to). The core of the post is one change to a fork of Zod 3: on success, "return the original object when validation succeeds, instead of creating a deep copy." Stock Zod rebuilds every object and array it parses, whether or not anything changed, so skipping that rebuild was worth about **1.5x** on its own and roughly **2x** once combined with smaller changes.

The change is only sound if nothing in the schema can produce a value that differs from the input, so the fork removes `catch`, `coerce`, `default`, `intersection`, `pipe`, `preprocess` and `transform`. Strip mode, which drops undeclared keys, became an in-place `delete` on the caller's object, which the post names as its biggest footgun in plain words: "extra keys are removed in place rather than on a cloned object." Chang is explicit that the fork is not a candidate for upstreaming, and that it works for Numeric because "our system already separates transformation logic from validation." That is a deliberate trade for their system, and nothing below is a claim that they should have done something else. But the post did make me curious about a different set of constraints.

## The constraint that made me curious

All removed features can return something other than its input. `default` fills in a missing value, `transform` and `pipe` produce a new one, `coerce` and `preprocess` rewrite before validation, `catch` substitutes on failure, and `intersection` merges two outputs into a new object. With any of them present, "return the input" is wrong whenever one fires.

But that also means the information needed to decide whether returning the input is safe already exists at runtime. A `default` node knows when it fired, a `transform` node knows it produced a fresh value, and a container knows whether any child came back changed. The decision does not have to be made once per schema, ahead of time; it can be made per record. So I wanted to know whether you could keep the seven features and still return the input in the common case, copying only where something actually changed: copy-on-write rather than never-copy.

The result is [zod-cow](https://github.com/iceboundrock/zod-cow), a layer on top of an unmodified Zod install, in two packages because Zod 3 and Zod 4 have different internals. `zod-cow-v4` runs on stock Zod 4.5.4 and its compiler, and `zod-cow-v3` is a separate hand-written compiler for Zod 3. I keep them apart throughout, and comparisons against stock Zod, against `z.compile()` in Zod 4.5, and against ArkType 2.2.3 are labelled as such.

## The copy-on-write invariant

The invariant fits in one line: for any node, `output === input` if and only if nothing in the subtree changed. Primitives are compared by value in JavaScript, so `'x'.trim() === 'x'` is clean even though a function ran. Containers are compared by reference, so a container is clean exactly when every child came back by reference and no key was added, dropped, or rewritten. That makes the reference comparison at each container boundary the dirty signal, and it prices copying per record and per path rather than per schema, which is the whole difference from the never-copy approach.

```
input                                 output
  order ────────────────────────────►  order            (same reference)
   ├─ id: "o_91"                        (validated, untouched)
   ├─ customer ──────────────────────►  customer        (same reference)
   │    ├─ name                         (validated, untouched)
   │    └─ email                        (regex ran, value unchanged)
   └─ lines[] ────────────────────────► lines[]         (same reference)
        └─ [0] ──────────────────────►  [0]             (same reference)

input                                 output
  order                                 order'          (new object, one path)
   ├─ id                                 id             (shared)
   ├─ customer                           customer'      (new object)
   │    ├─ name                           name          (shared)
   │    └─ tier: undefined ─default─►     tier: "free"  (the only change)
   └─ lines[]                            lines[]        (shared)
```

The upper tree is a clean parse and the result is the caller's object. The lower tree is a dirty parse where one `default` fired two levels down: two new objects, everything else shared. That is path copying, the same idea as a persistent data structure, applied to a validator's output.

## Copying one path instead of the tree

The hard part of a copy-on-write container is the decision not to copy. For an object schema in strip mode, "clean" means every declared child came back by reference and the input carries no undeclared keys. The first half is a chain of reference comparisons. The second half is a probe over the input's own keys, and it is where most of the engineering time went, because it runs on every clean object and has to be cheaper than the rebuild it replaces.

The probe walks `for...in` and compares each key positionally against the declared list, on the assumption that JSON-shaped inputs usually arrive in declaration order. When the walk falls out of order it drops to a comparison chain for narrow shapes and a `Set` lookup for wide ones. The generated code for a five-key object(with some locals renamed for readability):

```js
if (!anyChildDirty) {                            // set upstream by the child checks
  let hasExtraKey = false; let declIdx = 0;
  for (const k in input) {
    if (declIdx < 5 && k === declaredKeys[declIdx]) declIdx++;   // positional walk
    else if (k !== "id" && k !== "firstName" && k !== "email"
          && k !== "tags" && k !== "address") { hasExtraKey = true; break; }
  }
  if (!hasExtraKey) {
    const symbols = Object.getOwnPropertySymbols(input);
    if (symbols.length !== 0) hasExtraKey = true;  // stock strips own symbol keys too
  }
  if (!hasExtraKey) { return input; }              // the one line stock does not have
}
const out = { "id": vId, "firstName": vFirstName, "email": vEmail,
              "tags": vTags, "address": vAddress };
return out;
```

The copy path at the bottom assembles the output from the already validated locals in shape order. An earlier version used `{...input}` followed by `delete`, and it was slow for a reason I return to below.

## Compilation changes the problem

If zod-cow were an interpreter walking the schema, all of this would still lose to Zod 4, because Zod 4 does not interpret. Zod 4.5 carries a compiler in `zod/v4/core` that turns a schema into a specialized function with per-shape code, exposed publicly as `z.compile()`. The same machinery can be asked for an `assertOnly` product that validates without producing an output, and on failure the compiled functions return a sentinel rather than building an error.

That reframes the problem. There is no point in reimplementing string, number, or email validation, because the official leaf products are already specialized and any copy of them is a correctness liability against a moving target. Meanwhile a compiled validator that returns the input for free at leaves is exactly the building block copy-on-write wants. So the Zod 4 implementation generates only container skeletons, for object, array, tuple, record, map and set, and calls official products for everything inside them. The dispatch is a purity analysis:

```ts
export function isPure(schema: Node): boolean {
  const def = schema._zod.def;
  switch (def.type) {
    case "string": case "number": /* ...leaves... */ case "enum":
      return leafChecksArePure(schema);        // overwrite, superRefine: impure
    case "optional": case "nullable": { /* unwrap; wrapper checks gated */ }
    case "object": { /* catchall never: strict; every shape child pure */ }
    case "array": return checksAreCowSafe(schema) && isPure(def.element);
    case "union": { /* leaf-only unions pass through; container options get a skeleton */ }
    default: return false;   // default, catch, coerce, transform, pipe, readonly, lazy...
  }
}
```

A pure child gets the official `assertOnly` validator and its value is the input. An impure child gets the official parser plus one reference comparison, which is the dirty flag. A container child gets its own skeleton. Anything the generator cannot emit safely degrades one step at a time: skeleton, then official validator, then official parser, then a runtime island calling `_zod.run`, and at the root, stock `safeParse`. Correctness therefore rests on that fallback chain rather than on the generator getting the analysis right. Only speed depends on the analysis.

The compiler entry points are exported from `zod/v4/core` but are not documented public API, so the package pins a narrow peer range and runs a canary test against the installed version. A [draft upstream issue](https://github.com/iceboundrock/zod-cow/blob/main/docs/upstream-issue-draft.md) asks whether they could be promoted. Until then this is an experiment on top of internals.

## Correctness is harder than copy-on-write

The copy-on-write mechanism took a few days. Making the purity whitelist agree with stock Zod took the rest of the project, and every disagreement was found by a differential fuzzer rather than by reasoning. It generates random schemas and inputs, parses each with stock Zod and with the compiled product, and requires identical success and identical output structure, over **20,000** cases per pass with every failure reproducible from its seed. Four traps came out of it, and each is a place where my model of Zod was wrong rather than a coding mistake:

- `z.string().toLowerCase()` is an `overwrite` check inside the string node in Zod 4, not a wrapper around it, so a "pure string" that passed validation still came back with the wrong case. Leaf purity now inspects the node's own checks.
- Length and size checks carry a default `when` predicate that the generator read as custom, which sent every bounded array through the parser and produced a new array per record. That one misjudgement was the largest source of allocation in an early clean-batch run.
- `nullable(object)` has to be unwrapped to the container, because the official validator does not strip undeclared keys, so treating the wrapper as a pure leaf let extra keys through.
- Unions with a container option looked pure when each option was pure, but a union is one official product with no skeleton for its options, so an object with an undeclared key came back by reference with that key intact ([#47](https://github.com/iceboundrock/zod-cow/issues/47), fixed in [#58](https://github.com/iceboundrock/zod-cow/pull/58)).

Every extension to the fuzzer found a small, real disagreement, a handful of cases in ten thousand and at worst dozens in twenty thousand. Those are the numbers you want; zero would mean the generator is not reaching the code. A frozenness fuzzer checks that `readonly` freezes exactly what stock freezes, since `Object.freeze` is a side effect the layer must not skip, and a weekly workflow reinstalls the newest Zod so drift in the peer dependency arrives as a red build rather than a user report.

## What the measurements say

Every number below comes from one job, [run 34278463565](https://github.com/iceboundrock/zod-cow/actions/runs/34278463565), 2026-09-08, `main` at head `36186e6`, on a GitHub-hosted `ubuntu-latest` runner with Node **v24.20.0**, Zod **4.5.4**, Zod **3.24.1** for the v3 line, and ArkType **2.2.3**. Quoting one run is deliberate: every scenario ran in one process on one machine, so the columns can be compared with each other. Batch scenarios parse **50,000** records per candidate, hot loops run **1,000,000** iterations, candidates rotate order every round, and each figure is the median of at least three timed rounds after two warmups. An equivalence gate parses a fixture set through every candidate first and fails the run when outputs disagree undeclared, as ArkType's do on the record, map and set scenario. Runner speed moves everything, so I read anything inside roughly **15 percent** as level.

### The clean batch, which is the case the idea is for

![Clean batch of 50,000 records. Time is level across the three compiled candidates on S1, while zod-cow retains no memory and the other two retain about 11 MB. On S8 strip parity zod-cow runs at 25 ms against 29 for z.compile(), and ArkType runs 1,104 ms. Tuples and the record, map, set scenario widen the margin to 2.66x and 1.77x.](figures/fig1-clean-batch.webp)

On S1 the three compiled candidates are level in time and the difference is entirely memory. Stock Zod and `z.compile()` allocate a full output tree and retain it; the copy-on-write output retains nothing, because it is the input. That is the deliverable, and it is worth being precise about what it is not. The layer does not beat the compiler it sits on, it calls the same leaf products underneath, and I would not expect it to win on time here.

S8 speaks to Numeric's footgun directly, since every record carries undeclared keys and every output must therefore differ from its input. This is the case their in-place `delete` handles by mutating the caller's object, and the case zod-cow handles by copying once from locals, which turns out to be enough to pass the official compiler. S6 and S5 are where the skeleton owns more of the work and the margins widen, because a tuple or a record has more structure to skip and less leaf validation to defer to. ArkType is slow on S8 for an unrelated reason: its `delete` is a morph, and a morph moves the whole traversal onto an interpreted path.

The dirty path is the direct test of the cost model.

![Dirty ratio sweep from 0 to 100 percent. Time for all three candidates stays flat, stock Zod near 70 ms and both compiled candidates near 27 ms. Memory retained by zod-cow climbs from 0.0 to 6.9 MB, staying under the roughly 11 MB the other two retain at every ratio.](figures/fig2-dirty-ratio.webp)

Retained memory rises with the dirty ratio, which is what the model predicts, and even at fully dirty it stays under the constant the other two columns retain at every ratio, because a copy is one path and the rest of the record stays shared. Time never leaves the noise floor. Nothing degrades sharply, which is the property I cared about: the worst case for copy-on-write is roughly the ordinary case for a compiler that always copies.

### The case it is bad at

![Hot loop on one six-field object, nanoseconds per call. Parsing a clean object costs stock Zod 249 ns, z.compile() 30 ns, zod-cow 69 ns of which about 25 is Object.getOwnPropertySymbols, and ArkType 42 ns. Opting the symbol check out brings zod-cow to 44 ns against 34. Validation costs zod-cow 19 ns against 22 for z.compile() and 20 for ArkType.](figures/fig3-hot-loop.webp)

One small object in a loop is where the layer is worst, and the reason is a single call. Stock Zod strips own symbol keys, so a validator that wants to return the input has to prove there are none, and `Object.getOwnPropertySymbols` is the only way to ask. It costs the same on a small object as on a large one, so at six keys it dominates and there is nothing to amortize it against. Opting the check out closes most of the gap and leaves the positional walk as the residue. There is no allocation-free own-symbol predicate in JavaScript, which makes this a semantic cost rather than an implementation one ([#108](https://github.com/iceboundrock/zod-cow/issues/108)). Validation is the one hot loop the layer wins, because it returns the sentinel and never assembles a result at all.

The batch and the hot loop disagree because they measure different things. Across 50,000 distinct records with email and datetime fields the official regex checks dominate and the skeleton is a rounding error, while on one object in a loop the skeleton is the whole cost. If your workload looks like the second one, `z.compile()` is the right tool and copy-on-write buys you nothing but memory. Failure splits along the same line:

| Failure hot loop | `z.compile()`, ns | zod-cow-v4, ns | ArkType, ns |
|---|---:|---:|---:|
| S9 validate, first field invalid | 1,541 | 17 | 172 |
| S9 validate, last field invalid | 1,684 | 167 | 15 |
| S9 validate, nested field invalid | 1,810 | 167 | 24 |
| S10 parse with error, first field invalid | 3,553 | 3,528 | 6,914 |
| S10 parse with error, nested field invalid | 3,843 | 3,676 | 7,195 |

When the caller only wants a boolean, the sentinel does its job and the layer returns as soon as a check fails, while `z.compile()` pays to build a report nobody asked for. When the caller wants a real `ZodError` the skeleton has nothing to offer: it returns the sentinel, the layer reruns stock `safeParse`, and the record gets parsed twice. Error construction is expensive enough that the Zod candidates converge once most records are invalid, but at a low invalid ratio that second parse is pure overhead, and in a batch at 1 percent invalid it costs the layer about a quarter of its throughput. If your input is often wrong and you need the error object, copy-on-write is the wrong optimization to reach for.

### The same probe cuts both ways

![Width sweep, zod-cow against z.compile(), ratios on a log scale around parity. Strip mode loses at every width, 0.27x at 16 keys and about 0.33x at 32 and 64, reaching 0.93x once a default fires. Strict mode goes the other way, 0.73x at 16 keys and 2.44x at 64.](figures/fig4-width-sweep.webp)

In strip mode the ratio is roughly flat above 16 keys, because the probe and the rebuild it replaces both scale with width; at 16 keys it is worse, since the fixed own-symbol call has the fewest declared keys to amortize over. When a `default` fires the two are level, because both are building an output anyway.

Strict mode inverts the picture. Stock strict has to reject undeclared keys, which means it runs the same kind of probe zod-cow runs, and zod-cow's positional walk is the cheaper of the two. So the single most expensive thing the layer does is a liability in strip mode and its largest win in strict mode, which is a fair summary of the whole project.

That walk also produced the regression I am least proud of. The first version terminated the declared-key list with a `null` sentinel so the loop could skip a bound check, and it ran much slower than the strict variant executing the identical walk. My reading, which I have not confirmed with a V8 trace, is type feedback: after the equivalence gate ran fixtures whose walk fell off the end, the `===` site had seen both string and `null`, and V8 kept it generic from then on. An explicit bound check ([`ce84678`](https://github.com/iceboundrock/zod-cow/commit/ce84678)) recovered most of the loss, and the alternatives that lost are in [#102](https://github.com/iceboundrock/zod-cow/issues/102).

## Optimizations that did not work

Local runs on 500,000 records unless the row says otherwise:

| Attempt | Measured |
|---|---|
| Closure-tree design ported from the Zod 3 engine, clean batch | **510 ms** against **223 ms** for stock Zod 4 |
| Spread and `delete` replaced by a rebuild from locals, fully dirty | **385 ms** to **247 ms** |
| The same rebuild on the strip scenario | **1,038 ms** to **208 ms**, retained **637 MB** to **80 MB** |
| Address skeleton inlined into its parent, focused clean batch | **186 ms** to **200 ms** |
| Tuple skeleton inlined into its parent, CI run | **49 ms** against **50 ms**, noise |
| Whole-tree `assertOnly` plus a validation-free structural scan | **228 ms** to **250 ms**, allocation **30.5 MB** to **45.3 MB** |
| Comparison chain against `Set.has`, 16 keys | **38 ns** against **202 ns** |

The first Zod 4 port went in the bin. Porting the closure-tree design kept the memory win and lost the time, because Zod 4 already generates specialized per-shape functions and a tree of closures cannot beat generated code. My leaves were actually faster than the official ones in micro-probes, and the gap in object assembly swamped that entirely. That result is what pushed the project onto the official compiler ([#4](https://github.com/iceboundrock/zod-cow/issues/4), [#17](https://github.com/iceboundrock/zod-cow/pull/17)), and the current engine is the third design.

Spreading the input and deleting keys was the wrong copy. On V8 it transitions the object to dictionary mode, which makes every later property access on the output slower, including in the caller's code, so part of the cost lands outside the benchmark entirely. Rebuilding from the validated locals in shape order ([#41](https://github.com/iceboundrock/zod-cow/pull/41)) fixed both the time and the retained memory. That dictionary-mode reading is mine, taken from the numbers rather than from a heap snapshot.

Inlining sub-skeletons lost twice, and the profiling report behind [#33](https://github.com/iceboundrock/zod-cow/pull/33) explains why: TurboFan was already refusing to inline the account product into the root array skeleton because of code size, so hand-fusing the bodies only made that worse. The whole-tree `assertOnly` pass failed for a different reason worth knowing, that the official validator still builds the `tags` array before checking its bound, so the structural scan afterwards walks the tree a second time for nothing. The comparison-chain cap has a smaller history in the same key: the chain wins at narrow widths, loses from 64 keys up, and stops mattering at 128 where V8 drops the object literal into dictionary mode, and the cap moved to 32 ([#101](https://github.com/iceboundrock/zod-cow/pull/101)) on the strength of the CI matrix rather than my local table. The pattern across all of them is the same: V8 already makes good decisions about function boundaries, and source-level fusion fights them.

## Why the Zod 4 implementation owns less

The two packages are two answers to the same question, and the contrast is the argument for building on a compiler rather than being one:

| Package | Clean batch against its own stock Zod |
|---|---:|
| zod-cow-v3 on Zod 3 | 10.2x |
| zod-cow-v4 on Zod 4 | 2.78x |

`zod-cow-v3` is a full compiler: hand-written leaf predicates, regexes copied from Zod 3.24.1, generated skeletons through `new Function`, lazy issue paths, and its own error class reproducing stock's issue lists. It has to be, because Zod 3 has no compiler to lean on. Its ratio looks spectacular, but most of that is compilation against interpretation and only a little is copy-on-write, so it should not be read as the copy-on-write result.

`zod-cow-v4` owns about **120** lines of purity analysis and **200** of container skeletons, replacing roughly **1,100** lines of self-written codegen from the discarded port. Everything semantic comes from official compiled products. That is why its ratio is the smaller one, why the honest comparison for it is `z.compile()`, and why the fuzzer finds disagreements in tens of cases rather than thousands: the surface where I can be wrong is the whitelist and the skeletons, not string validation.

## What I learned

Numeric's post ends on a line I agree with more now than when I first read it: "general-purpose tools don't always scale perfectly for specific workloads." Their workload let them delete the features that make output differ from input. Mine did not, and it turned out the runtime already had the signal to decide per record rather than per schema. That decision costs a reference comparison per container plus one own-symbol probe, and on a clean batch it removes the output allocation while staying level with Zod 4's own compiler in time. It does not make a single small object faster than `z.compile()`, it loses on low invalid ratios when a full error is needed, and it depends on internals that Zod has not promised to keep. Those are the constraints the experiment ran under, and they are different constraints from Numeric's, not better ones.

The other lesson is about where the time went. The copy-on-write idea is a paragraph. The purity whitelist and its four traps, the differential run that found them, the failed inlinings, the copy path that put outputs into dictionary mode with nothing to show for it, and the null sentinel that poisoned an equality site are the project. If I had to hand this to someone else, the fuzzer and the equivalence gates are the parts I would insist on keeping, and the skeletons are the parts I would expect them to rewrite.

# References

- Justin Chang, "How we doubled Zod performance," Numeric, 2025-03-12: https://numeric.substack.com/p/how-we-doubled-zod-performance-to
- Numeric's fork of Zod: https://github.com/numeric-io/zod
- zod-cow repository at head `6835d5a` (2026-09-08), including `README.md`, `README.zh-CN.md`, `CHANGELOG.md`, `AGENTS.md`, `docs/ARCHITECTURE-z4.md`, `docs/upstream-issue-draft.md`, `packages/zod-cow-v4/src/cow4/purity.ts`, `packages/zod-cow-v4/tests/differential-z4.test.ts`, `.github/workflows/bench.yml`: https://github.com/iceboundrock/zod-cow
- Bench workflow runs: [34278463565](https://github.com/iceboundrock/zod-cow/actions/runs/34278463565) (every table in this post, 2026-09-08, `main` at head 36186e6, Node 24, `BENCH_N=50000`, `BENCH_ITERS=1000000`, no scenario filter), [33948313612](https://github.com/iceboundrock/zod-cow/actions/runs/33948313612), [33945725973](https://github.com/iceboundrock/zod-cow/actions/runs/33945725973), [34184664743](https://github.com/iceboundrock/zod-cow/actions/runs/34184664743) (earlier runs, cited for runner spread), [33940596453](https://github.com/iceboundrock/zod-cow/actions/runs/33940596453) (superseded copy path)
- Pull requests: [#17](https://github.com/iceboundrock/zod-cow/pull/17), [#33](https://github.com/iceboundrock/zod-cow/pull/33), [#41](https://github.com/iceboundrock/zod-cow/pull/41), [#58](https://github.com/iceboundrock/zod-cow/pull/58), [#63](https://github.com/iceboundrock/zod-cow/pull/63), [#93](https://github.com/iceboundrock/zod-cow/pull/93), [#101](https://github.com/iceboundrock/zod-cow/pull/101), [#109](https://github.com/iceboundrock/zod-cow/pull/109), [#110](https://github.com/iceboundrock/zod-cow/pull/110), [#111](https://github.com/iceboundrock/zod-cow/pull/111)
- Issues: [#4](https://github.com/iceboundrock/zod-cow/issues/4), [#32](https://github.com/iceboundrock/zod-cow/issues/32), [#34](https://github.com/iceboundrock/zod-cow/issues/34), [#47](https://github.com/iceboundrock/zod-cow/issues/47), [#102](https://github.com/iceboundrock/zod-cow/issues/102), [#108](https://github.com/iceboundrock/zod-cow/issues/108)
- Commits: [`ce84678`](https://github.com/iceboundrock/zod-cow/commit/ce84678) (bound check replaces null sentinel), [`a6309b2`](https://github.com/iceboundrock/zod-cow/commit/a6309b2) (tuple inlining reverted), [`358d259`](https://github.com/iceboundrock/zod-cow/commit/358d259) (copy path from locals), [`5c0958a`](https://github.com/iceboundrock/zod-cow/commit/5c0958a) (comparison-chain probe)
- Zod 4 compiler source, `src/v4/core/compile.ts`, and the `z.compile()` public API in Zod 4.5: https://github.com/colinhacks/zod
- ArkType 2.2.3: https://github.com/arktypeio/arktype
