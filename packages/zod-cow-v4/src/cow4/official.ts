/**
 * Official-product wrappers: assertOnly validator, parser, runtime island and async island
 * (the per-subtree degradation chain).
 */
import { $ZodAsyncError, INVALID, compileFn, ZodCompileAsyncError } from "zod/v4/core";
import { type Fn, isAsyncFn, markAsync, type Node, rethrowCallerError } from "./product.js";

/* ═══════════════════ Obtaining the official product (degradation chain) ═══════════════════ */

function makeIsland(schema: Node): Fn {
  // Equivalent of the official runtimeRun: black-box execution of the subtree, failure → INVALID.
  // async reaching the synchronous fast path through this island → throw $ZodAsyncError (same semantics as the official compile.js throwAsync:
  // returning INVALID would be read by a union as a rejected branch, so the throw must survive).
  return (value: unknown): unknown => {
    const r = schema._zod.run({ value, issues: [] }, {});
    if (r && typeof r.then === "function") throw new $ZodAsyncError();
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
 * signal, so a `$ZodAsyncError` among them is recorded for the async entries (fifth review of #76); a throw
 * that comes back synchronously is left as it is, as the interpreter called that callback, not this layer.
 */
export function makeAsyncIsland(schema: Node): Fn {
  const settle = (r: { issues: unknown[]; value: unknown }): unknown =>
    r.issues.length === 0 ? r.value : INVALID;
  return markAsync((value: unknown): unknown => {
    const r = schema._zod.run({ value, issues: [] }, {});
    return r instanceof Promise ? r.then(settle, rethrowCallerError) : settle(r);
  });
}

/**
 * Static async detection for lazy(async·…): the official generateLazyCheck is a runtime island,
 * compileFn does not throw ZodCompileAsyncError for it, and the async leaks out silently as a Promise --
 * it has to be spotted at compile time and routed to an async island. For async in every other type the official compileFn throws on its own, so this function is not needed.
 */
function subtreeHasAsync(schema: Node, seen: Set<Node> = new Set()): boolean {
  if (seen.has(schema)) return false; // recursive subtree (lazy self-reference) -- asyncness is decided by the first expansion
  seen.add(schema);
  const def = schema._zod.def;
  if (def.type === "lazy") {
    try {
      if (subtreeHasAsync(def.getter(), seen)) return true;
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
  return kids.some((k) => subtreeHasAsync(k, seen));
}

/**
 * Get the official product for a subtree. pure → assertOnly validator (validation semantics intact, output = input);
 * otherwise → parser (stock output semantics). On product generation failure it degrades step by step.
 * async is no longer rethrown upwards (Task 6): a subtree for which the official compileFn throws ZodCompileAsyncError
 * is routed to an async island instead (returns a Promise, awaited at the call site); lazy(async·…) is covered by the static detection.
 */
export function officialFn(schema: Node, pure: boolean): Fn {
  // The official product for lazy is a runtime island and inner async raises no compile-time error → covered statically
  if (schema._zod.def.type === "lazy" && subtreeHasAsync(schema)) {
    return makeAsyncIsland(schema);
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
    return makeIsland(schema);
  }
}

/** The whole-tree official assertOnly product (the validate fast path); failure → null */
export function officialValidator(schema: Node): Fn | null {
  try {
    return compileFn(schema, { assertOnly: true }) as Fn;
  } catch {
    return null;
  }
}
