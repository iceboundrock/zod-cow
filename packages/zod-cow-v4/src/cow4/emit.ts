/**
 * Skeleton codegen core: node dispatch, child-product selection and container-check
 * subroutines. Forms an import cycle with the emit-*.ts skeletons (mutual recursion through
 * hoisted function declarations only; nothing in the cycle runs at module load).
 */
import { compileFn, ZodCompileAsyncError, ZodCompileUnsupportedError } from "zod/v4/core";
import { buildFn, CodeCtx, escKey } from "./codectx.js";
import { emitCoWArray } from "./emit-array.js";
import { emitCoWMap } from "./emit-map.js";
import { emitCoWObject } from "./emit-object.js";
import { emitCoWRecord } from "./emit-record.js";
import { emitCoWSet } from "./emit-set.js";
import { emitCoWTuple } from "./emit-tuple.js";
import { emitCoWUnion } from "./emit-union.js";
import { makeAsyncIsland, officialFn, type RunPayload, runCarried } from "./official.js";
import { DEFAULT_OPTIONS } from "./options.js";
import { aborted } from "./predicates.js";
import {
  type Fn,
  isAsyncFn,
  isAsyncProduct,
  type Node,
  rethrowCallerError,
  throwAsync,
} from "./product.js";
import { cowSafeContainerForChild, isPure } from "./purity.js";

/* ═══════════════════ Skeleton codegen ═══════════════════ */

/**
 * Compile a subtree into a standalone product function (the recursion entry for container sub-skeletons); on failure → official product/island.
 * seen is passed down: compile-time cyclic-reference guard. The child context inherits the parent's
 * compile options and its `sources` list, so the sub-skeleton's source lands in the debug dump (#46).
 */
function subFn(schema: Node, seen: Set<Node>, parent: CodeCtx): Fn {
  const ctx = new CodeCtx(parent.options, parent.sources);
  const acc = emitNode(ctx, schema, "input", true, new Set(seen));
  ctx.write(`return ${acc ?? "true"};`);
  return buildFn(ctx);
}

/**
 * Runs `build` and, when it throws, drops the sources of the sub-skeletons it built before failing:
 * the caller replaces the whole subtree with an official product, so those functions are unreachable
 * and would only mislead a reader of the debug dump.
 */
function dropSourcesOnThrow<T>(parent: CodeCtx, build: () => T): T {
  const mark = parent.sources.length;
  try {
    return build();
  } catch (e) {
    parent.sources.length = mark;
    throw e;
  }
}

/** The four shapes a child product can take */
export type ChildProduct =
  | { kind: "validator"; fn: Fn } // official assertOnly: answers pass/fail only, output = input (unusable as a value)
  | { kind: "parser"; fn: Fn } // official parser: returns the output value (stock semantics), paired with a reference comparison to detect dirtiness
  | { kind: "cow"; fn: Fn } // this layer's container sub-skeleton: the original reference when clean, a new container when dirty
  | { kind: "async"; fn: Fn }; // async island / async sub-skeleton: returns Promise<output | INVALID>, the call site emits await

function productOf(fn: Fn, syncKind: "parser" | "cow"): ChildProduct {
  return isAsyncProduct(fn) ? { kind: "async", fn } : { kind: syncKind, fn };
}

/**
 * Child-product selection shared by key/element/value positions (the object key loop, the array element loop,
 * the record value loop, map keys and values, set members and tuple slots all come through here):
 *   container (including an optional/nullable wrapper chain) → CoW sub-skeleton (strip semantics intact);
 *   pure leaf → official validator; everything else → official parser; async subtree → async island.
 */
export function childProduct(child: Node, seen: Set<Node>, parent: CodeCtx): ChildProduct {
  if (cowSafeContainerForChild(child)) {
    try {
      return productOf(
        dropSourcesOnThrow(parent, () => subFn(child, seen, parent)),
        "cow",
      );
    } catch (e) {
      if (e instanceof ZodCompileUnsupportedError) throw e; // recursion/exotic features: propagate upwards, an outer layer degrades
      // ZodCompileAsyncError and other product generation failures → official product (async is turned into an async island automatically)
      return productOf(officialFn(child, false), "parser");
    }
  }
  const pure = isPure(child);
  const fn = officialFn(child, pure);
  if (isAsyncProduct(fn)) return { kind: "async", fn };
  return { kind: pure ? "validator" : "parser", fn };
}

/**
 * Settles the results of the predicates an async checks subroutine started, the way stock's
 * `runChecks` chain does: a Promise is awaited, any other result is read as is, every started result
 * is settled even after a `false` (stock awaits the whole chain, and a promise left unattached could
 * reject unhandled), and a rejection throws at its position in check order.
 */
async function settleChecks(results: unknown[]): Promise<boolean> {
  let ok = true;
  for (const r of results) {
    let v = r;
    if (r instanceof Promise) {
      try {
        v = await r;
      } catch (e) {
        rethrowCallerError(e); // a rejection is the predicate's, never the fast path's Promise signal
      }
    }
    if (!v) ok = false;
  }
  return ok;
}

/** The subroutine of `containerChecksFn` and the property keys whose held values it takes after its target, in parameter order (#85) */
type ChecksProduct = { fn: Fn; held: string[] };

/**
 * Validation subroutine for a container's own checks (a standalone product function, answering pass/fail only).
 * Supported: custom (a def.fn predicate, same template as the official generateCustomRefineCheck) /
 * min_length / max_length / length_equals (array .length) / min_size / max_size / size_equals (map / set .size) /
 * property (`z.property` / `z.properties` on an object, #85: the schema the check carries run for its verdict on
 * the key's value, which the subroutine takes as a parameter after its target, one per distinct key in check
 * order (`held`), so the object skeleton hands it the value it holds for a declared key and the output's own
 * property is read for no key twice; the carried value is discarded, as stock's `handleCheckPropertyResult`
 * keeps only the issues). In the sync variant the product is `officialFn(carried, true)`, the verdict-only
 * chain (validator, else parser, else island) since nothing reads the output; a `$ZodAsyncError` it throws is
 * stock's own signal, as from any official product (#80). In the async variant the carried schema runs through
 * stock's `_zod.run` as `$ZodCheckProperty` runs it (`runCarried`): its payload's issues say whether a failure
 * aborts the chain, which the product's `INVALID` cannot, so the abort rule below applies to a property check
 * exactly as stock applies it (a carried type mismatch aborts, a carried check failure carries `continue: true`
 * and does not; the check's own `abort` flag is ignored by stock and here). Whether the run came back as a
 * promise is a runtime test, like a plain-function predicate's result.
 * With an async predicate among the checks (#13) the subroutine is an async function on stock's schedule:
 * `runChecks` calls every check synchronously in declaration order and only chains the awaits, so every
 * predicate (sync or async) is called before the first `await`, a length / size check keeps its place,
 * and the results are settled at the end by `settleChecks`. A length / size check that fails after a
 * predicate was started settles the started ones first, so nothing returns while a promise is unattached.
 * One exception to "every predicate is called": `runChecks` tracks its abort state synchronously until
 * a check returns a Promise, so an `abort: true` predicate that fails synchronously while no promise has
 * started skips every later check without a `when` (the length / size checks carry one and still run,
 * side-effect free). The subroutine returns INVALID at that point instead of starting the later
 * predicates (third review of #76); after the first promise the state is updated inside stock's chain,
 * too late for the loop, so nothing is skipped and the predicates are all started as before. Whether a
 * promise has started is decided at runtime for the predicates that are not async functions, since a
 * plain function may return a Promise too. Every predicate call is wrapped so that a `$ZodAsyncError` the
 * predicate throws is recorded as the caller's (`rethrowCallerError`): the async entries rethrow it, where an
 * unrecorded one (this subroutine's own `throwAsync` at a Promise) hands the parse to stock's async runtime.
 * Returning null means a check the skeleton cannot handle is present (the caller should already have blocked it via checksAreCowSafe).
 */
export function containerChecksFn(schema: Node): ChecksProduct | null {
  const checks: Node[] = schema._zod.def.checks ?? [];
  if (checks.length === 0) return null;
  // A check subroutine emits no container skeleton, so the compile options never matter here
  const ctx = new CodeCtx(DEFAULT_OPTIONS);
  const defOf = (check: Node) => check._zod?.def ?? check;
  // The verdict-only product of every property check, built first: the async decision reads it
  const carried = new Map<Node, Fn>();
  for (const c of checks) {
    const d = defOf(c);
    if (d.check === "property") carried.set(c, officialFn(d.schema, true));
  }
  const anyAsync = checks.some((c) => {
    const d = defOf(c);
    if (d.check === "property") return isAsyncProduct(carried.get(c));
    return d.check === "custom" && !!d.fn && isAsyncFn(d.fn);
  });
  ctx.async = anyAsync;
  const settleC = anyAsync ? ctx.addConst(settleChecks) : null;
  const rethrowC = ctx.addConst(rethrowCallerError);
  const held: string[] = [];
  const heldParam = (key: string): string => {
    let i = held.indexOf(key);
    if (i < 0) {
      i = held.push(key) - 1;
      ctx.params.push(`p${i}`);
    }
    return `p${i}`;
  };
  const started: string[] = []; // async variant: the results of the checks called so far
  let promiseStarted = false; // async variant: an async-function predicate was called, so a promise has certainly started
  /** The runtime test that no promise has started among the results so far (an async-function predicate settles it statically) */
  const noPromiseStarted = (): string[] => started.map((s) => `!(${s} instanceof Promise)`);
  const fail = (): string =>
    started.length === 0
      ? "return INVALID;"
      : `{ await ${settleC}([${started.join(", ")}]); return INVALID; }`;
  for (const check of checks) {
    const d = defOf(check);
    if (d.check === "custom" && d.fn) {
      const fnC = ctx.addConst(d.fn);
      const res = ctx.var();
      ctx.write(`let ${res}; try { ${res} = ${fnC}(input); } catch (e) { ${rethrowC}(e); }`);
      if (anyAsync) {
        const asyncFn = isAsyncFn(d.fn);
        if (d.abort && !asyncFn && !promiseStarted) {
          // stock skips the later checks after a sync aborting failure with no promise started yet;
          // `!res` already excludes a Promise returned by this plain function, the earlier results
          // (all from plain functions or carried runs at this point) are tested at runtime
          ctx.write(`if (${[`!${res}`, ...noPromiseStarted()].join(" && ")}) return INVALID;`);
        }
        if (asyncFn) promiseStarted = true;
        started.push(res);
        continue;
      }
      // Same as the def.fn branch of the official generateCustomRefineCheck: a Promise on the sync path throws (official semantics)
      const throwAsyncC = ctx.addConst(throwAsync);
      ctx.write(`if (${res} instanceof Promise) ${throwAsyncC}();`);
      ctx.write(`if (!${res}) return INVALID;`);
      continue;
    }
    if (d.check === "property") {
      const value = heldParam(d.property);
      if (!anyAsync) {
        const fnC = ctx.addConst(carried.get(check)!);
        ctx.write(`if (${fnC}(${value}) === INVALID) return INVALID;`);
        continue;
      }
      // stock's $ZodCheckProperty: the carried schema's run under an empty context, a promise chained, a sync
      // payload read at once; a failure aborts the chain when its issues say so (`aborted`), which skips the
      // later checks only while no promise has started, as for a predicate
      const runC = ctx.addConst(runCarried);
      const passedC = ctx.addConst(carriedPassed);
      const abortedC = ctx.addConst(aborted);
      const run = ctx.var();
      const res = ctx.var();
      ctx.write(`const ${run} = ${runC}(${ctx.addConst(d.schema)}, ${value});`);
      ctx.write(
        `const ${res} = ${run} instanceof Promise ? ${run}.then(${passedC}) : ${run}.issues.length === 0;`,
      );
      if (!promiseStarted) {
        ctx.write(
          `if (${[`${res} === false`, `${abortedC}(${run})`, ...noPromiseStarted()].join(" && ")}) return INVALID;`,
        );
      }
      started.push(res);
      continue;
    }
    if (d.check === "min_length") {
      ctx.write(`if (input.length < ${Number(d.minimum)}) ${fail()}`);
      continue;
    }
    if (d.check === "max_length") {
      ctx.write(`if (input.length > ${Number(d.maximum)}) ${fail()}`);
      continue;
    }
    if (d.check === "length_equals") {
      ctx.write(`if (input.length !== ${Number(d.length)}) ${fail()}`);
      continue;
    }
    if (d.check === "min_size") {
      ctx.write(`if (input.size < ${Number(d.minimum)}) ${fail()}`);
      continue;
    }
    if (d.check === "max_size") {
      ctx.write(`if (input.size > ${Number(d.maximum)}) ${fail()}`);
      continue;
    }
    if (d.check === "size_equals") {
      ctx.write(`if (input.size !== ${Number(d.size)}) ${fail()}`);
      continue;
    }
    return null; // inexpressible check -- the caller is responsible for having blocked it with checksAreCowSafe
  }
  if (started.length > 0) {
    ctx.write(`if (!(await ${settleC}([${started.join(", ")}]))) return INVALID;`);
  }
  ctx.write("return true;");
  return { fn: buildFn(ctx), held };
}

/** The verdict of a settled carried run (`runCarried`): a pass when the payload holds no issue */
function carriedPassed(payload: RunPayload): boolean {
  return payload.issues.length === 0;
}

/**
 * A checks subroutine hoisted into `ctx` for its call sites (`ctx.async` is set for an async one, #13); null when
 * the schema has no checks. `expr` is the call on `target`, `await` included, with the held value of every
 * property key (`keys`, in parameter order) after it: `heldOf(key)` names the expression holding the output
 * value of a key the caller answers for (the object skeleton on its clean path, #85: every key, declared or
 * not, since the input it returns is not stock's assembled output), and any other key is read off the target,
 * which must then be that output (the copy path's `out`).
 */
export type ChecksCall = {
  keys: readonly string[];
  expr: (target: string, heldOf?: (key: string) => string | undefined) => string;
};

export function containerChecksCall(ctx: CodeCtx, schema: Node): ChecksCall | null {
  const product = containerChecksFn(schema);
  if (!product) return null;
  const isAsync = isAsyncProduct(product.fn);
  if (isAsync) ctx.async = true;
  const name = ctx.addConst(product.fn);
  const awaitKw = isAsync ? "await " : "";
  const { held } = product;
  return {
    keys: held,
    expr: (target, heldOf) => {
      const args = held.map((key) => heldOf?.(key) ?? `${target}[${escKey(key)}]`);
      return `${awaitKw}${name}(${[target, ...args].join(", ")})`;
    },
  };
}

/**
 * The container's own checks on both paths, as stock runs them on the final output: on the input
 * when `clean` holds (the input is then returned) and on `out` otherwise. Returns false when the
 * schema has no checks, so the caller emits its own clean return.
 */
export function emitContainerChecks(
  ctx: CodeCtx,
  schema: Node,
  accessor: string,
  out: string,
  clean: string,
): boolean {
  const call = containerChecksCall(ctx, schema);
  if (!call) return false;
  const check = (value: string): string => `if ((${call.expr(value)}) === INVALID) return INVALID;`;
  ctx.write(`if (${clean}) {`);
  ctx.indented(() => {
    ctx.write(check(accessor));
    ctx.write(`return ${accessor};`);
  });
  ctx.write(`}`);
  ctx.write(check(out));
  return true;
}

/**
 * Handling of a container (object/array) at a key or element position: it must go through a CoW sub-skeleton,
 * never the official assertOnly product -- the official validator skips stripping extra keys
 * (strip is output-construction behavior and does not affect pass/fail), which loses the strip semantics.
 * The sub-skeleton handles strip/strict/loose in full and returns the original reference when clean.
 */
export function containerChildFn(child: Node, seen: Set<Node>, parent: CodeCtx): Fn {
  try {
    return dropSourcesOnThrow(parent, () => subFn(child, seen, parent));
  } catch (e) {
    if (e instanceof ZodCompileUnsupportedError) throw e; // recursion and the like: propagate upwards, the outer layer picks the degradation level
    return officialFn(child, false); // official parser product (async is turned into an async island automatically), stock semantics, no loss of correctness
  }
}

/** Dispatch to the skeleton of a bare container or union (the chain of `emitBoxedContainer` already unwrapped) */
function emitContainer(ctx: CodeCtx, schema: Node, accessor: string, seen: Set<Node>): string {
  const t: string = schema._zod.def.type;
  if (t === "object") return emitCoWObject(ctx, schema, accessor, seen);
  if (t === "array") return emitCoWArray(ctx, schema, accessor, seen);
  if (t === "tuple") return emitCoWTuple(ctx, schema, accessor, seen);
  if (t === "record") return emitCoWRecord(ctx, schema, accessor, seen);
  if (t === "map") return emitCoWMap(ctx, schema, accessor, seen);
  if (t === "set") return emitCoWSet(ctx, schema, accessor, seen);
  return emitCoWUnion(ctx, schema, accessor, seen);
}

/**
 * Skeleton for a container wrapped in an optional/nullable chain: emit the shell checks along the chain (null→null,
 * undefined→undefined, value passed through), then the ordinary CoW skeleton once the container is reached.
 *
 * A wrapper layer may carry `.refine` predicates (the only checks `cowSafeContainerForChild` admits on a
 * wrapper, #56), which stock runs after the layer's own codegen on the value the layer produced: the shortcut
 * value on the shortcut, the inner output otherwise, and the inner wrapper's checks before the outer's. So a
 * shortcut runs the checks of its own layer and of every layer above it before returning, and the container's
 * output runs every layer's checks inner to outer. A chain with such checks builds the container as a nested
 * skeleton called once: an inline skeleton returns the clean input from inside its own branch, so nothing
 * emitted after it would run on that path. A chain without checks emits the inline skeleton as before.
 *
 * An `optional` layer whose inner is `defaulted` (`_zod.optin`; a union with a defaulted option, since
 * #58 the one such inner a chain can hold) does not shortcut: stock's `generateOptionalCheck` hands
 * `undefined` to the inner so the default can fire, and answers `undefined` when the inner rejects it.
 * Such a layer ends the flat chain: its inner is built as a nested product called once on both paths.
 */
function emitBoxedContainer(ctx: CodeCtx, schema: Node, accessor: string, seen: Set<Node>): string {
  const layers: { shortcut: "null" | "undefined"; checks: ChecksCall | null }[] = [];
  let cur: Node = schema;
  let defaultedInner: Node | null = null;
  for (;;) {
    const def = cur._zod.def;
    if (def.type !== "nullable" && def.type !== "optional") break;
    // custom predicates only, sync or async, see wrapperChecksAreCowSafe
    layers.push({
      shortcut: def.type === "nullable" ? "null" : "undefined",
      checks: containerChecksCall(ctx, cur),
    });
    cur = def.innerType;
    if (def.type === "optional" && cur._zod.optin === "defaulted") {
      defaultedInner = cur;
      break;
    }
  }
  // The checks of layer i and of every layer above it, inner first (stock's order)
  const emitChecksUpTo = (i: number, value: string): void => {
    for (let j = i; j >= 0; j--) {
      const c = layers[j]!.checks;
      if (c) ctx.write(`if ((${c.expr(value)}) === INVALID) return INVALID;`);
    }
  };
  const hasChecksUpTo = (i: number): boolean => layers.slice(0, i + 1).some((l) => l.checks);

  const shortcutLayers = defaultedInner ? layers.length - 1 : layers.length;
  for (let i = 0; i < shortcutLayers; i++) {
    const { shortcut } = layers[i]!;
    if (!hasChecksUpTo(i)) {
      ctx.write(`if (${accessor} === ${shortcut}) return ${accessor};`);
      continue;
    }
    ctx.write(`if (${accessor} === ${shortcut}) {`);
    ctx.indented(() => {
      emitChecksUpTo(i, accessor);
      ctx.write(`return ${accessor};`);
    });
    ctx.write(`}`);
  }

  if (!defaultedInner && !hasChecksUpTo(layers.length - 1)) {
    return emitContainer(ctx, cur, accessor, seen);
  }

  const fn = containerChildFn(cur, seen, ctx);
  const f = ctx.addConst(fn);
  const isAsync = isAsyncProduct(fn);
  if (isAsync) ctx.async = true;
  const awaitKw = isAsync ? "await " : "";
  if (defaultedInner) {
    // Stock's defaulted branch of generateOptionalCheck: the inner runs on `undefined`, a rejection
    // answers `undefined` (the layer's skip value) and the checks of this layer and above run on it
    ctx.write(`if (${accessor} === undefined) {`);
    ctx.indented(() => {
      const branch = ctx.var();
      const value = ctx.var();
      ctx.write(`const ${branch} = ${awaitKw}${f}(${accessor});`);
      ctx.write(`const ${value} = ${branch} === INVALID ? undefined : ${branch};`);
      emitChecksUpTo(layers.length - 1, value);
      ctx.write(`return ${value};`);
    });
    ctx.write(`}`);
  }
  const out = ctx.var();
  ctx.write(`const ${out} = ${awaitKw}${f}(${accessor});`);
  ctx.write(`if (${out} === INVALID) return INVALID;`);
  emitChecksUpTo(layers.length - 1, out);
  return out;
}

/**
 * Emit the validation/CoW code for schema into ctx and return the output accessor (may be null when needsValue=false).
 * seen: compile-time cyclic-reference guard -- a recursive subtree is not expanded again and is handed to the official product/island.
 */
export function emitNode(
  ctx: CodeCtx,
  schema: Node,
  accessor: string,
  needsValue: boolean,
  seen: Set<Node>,
): string | null {
  const def = schema._zod.def;
  const t: string = def.type;
  if (needsValue) {
    // container (including an optional/nullable wrapper chain) or a union with a container option → CoW skeleton
    if (
      (t === "object" ||
        t === "array" ||
        t === "tuple" ||
        t === "record" ||
        t === "map" ||
        t === "set" ||
        t === "union" ||
        t === "optional" ||
        t === "nullable") &&
      cowSafeContainerForChild(schema)
    ) {
      return emitBoxedContainer(ctx, schema, accessor, seen);
    }
  }
  // every other type: black-box call into the official product
  const pure = isPure(schema);
  if (pure) {
    // Pure subtree: the official assertOnly product answers pass/fail only, output = input reference (the definition of purity).
    // When no validator product is available, fall to the official parser (the value may be ≠ input, taking the impure path);
    // a pure subtree has no async in theory (the whitelist blocks it), and defensively it becomes an async island.
    let v: Fn | null = null;
    try {
      v = compileFn(schema, { assertOnly: true }) as Fn;
    } catch (e) {
      if (e instanceof ZodCompileAsyncError) {
        const f = ctx.addConst(makeAsyncIsland(schema));
        ctx.async = true;
        ctx.write(`if ((await ${f}(${accessor})) === INVALID) return INVALID;`);
        // a pure subtree that validates ⇒ output = input reference, so accessor is the output
        return needsValue ? accessor : null;
      }
      v = null;
    }
    if (v) {
      const c = ctx.addConst(v);
      ctx.write(`if (${c}(${accessor}) === INVALID) return INVALID;`);
      return needsValue ? accessor : null;
    }
  }
  const fnC = officialFn(schema, false);
  const fn = ctx.addConst(fnC);
  if (isAsyncProduct(fnC)) ctx.async = true;
  const awaitKw = isAsyncProduct(fnC) ? "await " : "";
  if (!needsValue) {
    ctx.write(`if ((${awaitKw}${fn}(${accessor})) === INVALID) return INVALID;`);
    return null;
  }
  const out = ctx.var();
  ctx.write(`const ${out} = ${awaitKw}${fn}(${accessor});`);
  ctx.write(`if (${out} === INVALID) return INVALID;`);
  return out;
}
