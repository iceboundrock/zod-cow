/**
 * Official-product wrappers: assertOnly validator, parser, runtime island and async island
 * (the per-subtree degradation chain).
 */
import { INVALID, compileFn, ZodCompileAsyncError } from "zod/v4/core";
import {
  type Fn,
  isAsyncFn,
  markAsync,
  type Node,
  rethrowCallerError,
  throwAsync,
} from "./product.js";
import { wrapperFollowsRuntime } from "./purity.js";

/* ═══════════════════ Obtaining the official product (degradation chain) ═══════════════════ */

/**
 * The interpreter's `_zod.run` never throws `$ZodAsyncError` on its own under the contexts the two islands hand
 * it: the three throw sites of its check and parse chains fire only under `async: false` (the sync island runs
 * under an empty context, where a Promise a plain function returned is chained instead and comes back as a
 * thenable), and the core transform node's fourth site only under a falsy `async` (the async island runs under
 * `async: true`, the context stock's own async runtime hands the subtree; the classic transform node never throws
 * it). A throw that leaves `_zod.run` synchronously is therefore a callback's, thrown before the run came back
 * (a nested sync parse of an async schema, or the class thrown by hand), and is recorded for the async entries
 * of `compile()` like a throw from this layer's own call sites (sixth review of #76).
 */
function runIsland(schema: Node, value: unknown, ctx: object): unknown {
  try {
    return schema._zod.run({ value, issues: [] }, ctx);
  } catch (e) {
    rethrowCallerError(e);
  }
}

const SYNC_CTX = {};
const ASYNC_CTX = { async: true };

function makeIsland(schema: Node): Fn {
  // Equivalent of the official runtimeRun: black-box execution of the subtree, failure → INVALID.
  // async reaching the synchronous fast path through this island → throw $ZodAsyncError (same semantics as the official compile.js throwAsync:
  // returning INVALID would be read by a union as a rejected branch, so the throw must survive). The thenable is
  // the fast path's Promise signal, which the async entries of `compile()` hand to stock's async runtime.
  return (value: unknown): unknown => {
    const r = runIsland(schema, value, SYNC_CTX) as {
      then?: unknown;
      issues: unknown[];
      value: unknown;
    };
    if (r && typeof r.then === "function") throwAsync();
    return r.issues.length === 0 ? r.value : INVALID;
  };
}

/**
 * Channel for async subtrees. Marked async so the skeleton emits `await` (or the settlement log of
 * the set / map / record skeletons) at the call site. The island itself is not an async function:
 * a run that came back synchronously is answered synchronously, so a sync entry of a set, map or
 * record keeps its place in stock's write order (stock's runtime writes a sync entry inside its
 * loop and an async one when its promise settles), and an async run adds exactly one `.then`
 * before the skeleton's own, the same number of microtask hops for every entry (review of #70). A rejection
 * of that run is the caller's (a callback threw inside stock's async chain), never the fast path's Promise
 * signal, so a `$ZodAsyncError` among them is recorded for the async entries (fifth review of #76), and so
 * is a throw that leaves the run synchronously (`runIsland`, sixth review of #76).
 */
export function makeAsyncIsland(schema: Node): Fn {
  const settle = (r: { issues: unknown[]; value: unknown }): unknown =>
    r.issues.length === 0 ? r.value : INVALID;
  return markAsync((value: unknown): unknown => {
    const r = runIsland(schema, value, ASYNC_CTX) as Promise<never> | Parameters<typeof settle>[0];
    return r instanceof Promise ? r.then(settle, rethrowCallerError) : settle(r);
  });
}

/**
 * Static async detection for the subtrees that become this layer's islands, where the official
 * `ZodCompileAsyncError` never arrives: a `lazy` (the official generateLazyCheck is a runtime island, so the
 * async of its subtree raises no compile-time error and would leak out silently as a Promise), and a subtree
 * whose stock compile fails for a non-async reason before its checks are reached (a symbol literal, coercion,
 * `z.xor`, a `catch` callback, #75). For every other subtree the official compileFn throws on its own.
 *
 * The walk reads every object shape below the subtree, which stock reads only at parse time (`$ZodObject` copies
 * the caller's shape on the first read of `def.shape`, so a shape getter may reference a schema still under
 * construction), and stock's compile of a refused subtree never reached the shape. A getter that throws here is
 * therefore contained rather than raised from `compile()`: the subtree takes the sync island, whose run meets the
 * same throw at parse time where stock's parser does, and a getter that resolves by then meets any Promise on
 * the #76 route (review of #82). A `lazy` getter that throws still takes the async island (#83).
 */
function subtreeHasAsync(schema: Node): boolean {
  try {
    return walkHasAsync(schema, new Set());
  } catch {
    return false;
  }
}

function walkHasAsync(schema: Node, seen: Set<Node>): boolean {
  if (seen.has(schema)) return false; // recursive subtree (lazy self-reference) -- asyncness is decided by the first expansion
  seen.add(schema);
  const def = schema._zod.def;
  if (def.type === "lazy") {
    try {
      if (walkHasAsync(def.getter(), seen)) return true;
    } catch {
      return true; // the getter throws → conservatively treated as async (no loss of correctness)
    }
  }
  if (isAsyncFn(def.fn) || isAsyncFn(def.transform)) return true;
  const checks: Node[] = def.checks ?? [];
  for (const c of checks) {
    const d = c._zod?.def ?? c;
    if (isAsyncFn(d.fn) || isAsyncFn(c._zod?.check)) return true;
  }
  return childrenOf(schema).some((k) => walkHasAsync(k, seen));
}

/**
 * Whether the subtree holds an optional / nullable layer whose checks stock's compiler answers differently from
 * its runtime on the shortcut (`wrapperFollowsRuntime`, #69), in which case the whole official product for the
 * subtree is one of this layer's islands, whose `_zod.run` is the runtime. A `lazy` is not descended: stock's
 * compiled product runs a `lazy` in the runtime already (`generateLazyCheck`), whatever its getter returns. The
 * walk reads every object shape below the subtree; a getter that throws is contained like in `subtreeHasAsync`
 * (the subtree goes on to `compileFn`, which meets the same getter).
 */
function subtreeFollowsRuntime(schema: Node): boolean {
  try {
    return walkFollowsRuntime(schema, new Set());
  } catch {
    return false;
  }
}

function walkFollowsRuntime(schema: Node, seen: Set<Node>): boolean {
  if (seen.has(schema)) return false;
  seen.add(schema);
  if (wrapperFollowsRuntime(schema)) return true;
  if (schema._zod.def.type === "lazy") return false;
  return childrenOf(schema).some((k) => walkFollowsRuntime(k, seen));
}

/** The schema nodes directly below `schema` (every def slot that holds one), object shape included */
function childrenOf(schema: Node): Node[] {
  const def = schema._zod.def;
  const kids: Node[] = [];
  if (def.innerType) kids.push(def.innerType);
  if (def.element) kids.push(def.element);
  if (def.keyType) kids.push(def.keyType);
  if (def.valueType) kids.push(def.valueType);
  if (def.in) kids.push(def.in);
  if (def.out) kids.push(def.out);
  if (def.left) kids.push(def.left);
  if (def.right) kids.push(def.right);
  if (def.rest) kids.push(def.rest);
  if (def.catchall) kids.push(def.catchall);
  if (def.items) kids.push(...def.items);
  if (def.options) kids.push(...def.options);
  if (def.shape) {
    for (const k of Object.keys(def.shape)) kids.push(def.shape[k]);
    for (const s of Object.getOwnPropertySymbols(def.shape)) kids.push(def.shape[s]);
  }
  return kids;
}

/**
 * Get the official product for a subtree. pure → assertOnly validator (validation semantics intact, output = input);
 * otherwise → parser (stock output semantics). On product generation failure it degrades step by step.
 * async is no longer rethrown upwards (Task 6): a subtree for which the official compileFn throws ZodCompileAsyncError
 * is routed to an async island instead (returns a Promise, awaited at the call site); lazy(async·…) is covered by the static detection.
 */
export function officialFn(schema: Node, pure: boolean): Fn {
  // The official product for lazy is a runtime island of stock's own (`generateLazyCheck` runs the getter's
  // `_zod.run` under an empty context and reads `.issues` off whatever came back), so no compiled fast path is lost
  // by running the node through this layer's islands instead: inner async raises no compile-time error and is
  // covered statically (async island), and a callback's synchronous `$ZodAsyncError` or a thenable a plain function
  // returned is then met by `runIsland` and `throwAsync` rather than by stock's code (sixth review of #76).
  // A wrapper carrying a check stock's compiler answers differently from its runtime on the shortcut (#69)
  // is run by the runtime too, wherever it sits inside the subtree: stock's product for the subtree would
  // compile that wrapper, so the whole subtree takes an island.
  if (schema._zod.def.type === "lazy" || subtreeFollowsRuntime(schema)) {
    return subtreeHasAsync(schema) ? makeAsyncIsland(schema) : makeIsland(schema);
  }
  if (pure) {
    try {
      return compileFn(schema, { assertOnly: true }) as Fn;
    } catch (e) {
      if (e instanceof ZodCompileAsyncError) return makeAsyncIsland(schema); // the isPure whitelist already blocks async; this is defensive
      // everything else → fall through to the parser (harmless when nobody reads the output value, just extra construction)
    }
  }
  try {
    return compileFn(schema) as Fn;
  } catch (e) {
    if (e instanceof ZodCompileAsyncError) return makeAsyncIsland(schema);
    // Any other failure (a symbol literal, coercion, `z.xor`, a `catch` callback) was thrown before stock's
    // codegen reached the checks, so it says nothing about async: the static walk decides the island, as for
    // `lazy`. A sync island here would meet the Promise at parse time, and the async entries would then rerun
    // the parse in stock's async runtime, twice the callbacks and no CoW reference (#75).
    return subtreeHasAsync(schema) ? makeAsyncIsland(schema) : makeIsland(schema);
  }
}

/**
 * The whole-tree official assertOnly product (the validate fast path); failure → null, and so is a tree holding a
 * wrapper the runtime must answer (#69): the skeleton, whose islands run it, serves `validate` then.
 */
export function officialValidator(schema: Node): Fn | null {
  if (subtreeFollowsRuntime(schema)) return null;
  try {
    return compileFn(schema, { assertOnly: true }) as Fn;
  } catch {
    return null;
  }
}
