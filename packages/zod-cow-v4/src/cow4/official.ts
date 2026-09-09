/**
 * Official-product wrappers: assertOnly validator, parser, runtime island and async island
 * (the per-subtree degradation chain).
 */
import { INVALID, compileFn, ZodCompileAsyncError, ZodCompileUnsupportedError } from "zod/v4/core";
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

/** The payload stock's `_zod.run` answers: the issues decide the verdict (empty is a pass) and whether the check chain aborts */
export type RunPayload = { value: unknown; issues: { continue?: boolean }[]; aborted?: boolean };

/**
 * The run stock's `$ZodCheckProperty` makes of the schema a `z.property` / `z.properties` check carries: the
 * carried schema's `_zod.run` on the key's value under an empty context, whose payload comes back synchronously
 * or as a promise. The async checks subroutine runs a property check this way (#85) because the payload's issues
 * decide what `INVALID` cannot: whether the failure aborts stock's `runChecks` chain (`aborted` in
 * `predicates.ts`), which skips the later checks after a synchronous abort with no promise started. A throw that
 * leaves the run synchronously is a callback's, recorded like an island's (`runIsland`); the empty context is the
 * one the check hands stock, so the run never throws `$ZodAsyncError` on its own there either.
 */
export function runCarried(schema: Node, value: unknown): RunPayload | Promise<RunPayload> {
  return runIsland(schema, value, SYNC_CTX) as RunPayload | Promise<RunPayload>;
}

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
 * Channel for async subtrees. Marked async so the skeleton makes its call site an await site (or the
 * settlement log of the set / map / record skeletons), which suspends only on a `Promise` (#105).
 * The island itself is not an async function:
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
 * Static inspection of the subtrees that become this layer's islands, where the official `ZodCompileAsyncError`
 * never arrives: a subtree holding a `lazy` (the official generateLazyCheck is a runtime island, so the async of its
 * subtree raises no compile-time error and would leak out silently as a Promise), and a subtree whose stock compile
 * fails for a non-async reason before its checks are reached (a symbol literal, coercion, `z.xor`, a `catch`
 * callback, #75). For every other subtree the official compileFn throws on its own. The walk answers whether the
 * subtree holds an async function (a check, a transform, a lazy's expansion).
 *
 * A `lazy` whose getter throws right now (#83) counts as sync: stock never calls a getter at compile time, so the
 * throw says nothing about the subtree, which is handed to the runtime, where the getter is called at parse time
 * like stock's parser does. The realistic case is a temporal dead zone (a lazy reading a binding declared later in
 * the module, `compile()` called between the two declarations). The getter is read off `def` directly, never through
 * `_zod.innerType`: `$ZodLazy` defines that slot with `util.defineLazy`, which marks its cell before calling the
 * getter and never resets it when the getter throws, so one read through the memo while the getter throws makes
 * every later read answer `undefined` and every parse of the schema, stock's own included, end in a `TypeError`.
 * Stock's `compileFn` makes that read (`isRecursiveSchema`), which is why `officialFn` and `officialValidator` never
 * hand a subtree holding a `lazy` to it (`subtreeFollowsRuntime`).
 *
 * The walk reads every object shape below the subtree, which stock reads only at parse time (`$ZodObject` copies
 * the caller's shape on the first read of `def.shape`, so a shape getter may reference a schema still under
 * construction), and stock's compile of a refused subtree never reached the shape. A getter that throws here is
 * therefore contained rather than raised from `compile()`: the answer gathered before the throw stands (`false`
 * unless an async function was met first), the subtree takes the sync island, whose run meets the same throw at
 * parse time where stock's parser does, and a getter that resolves by then meets any Promise on the #76 route
 * (review of #82).
 */
function inspectSubtree(schema: Node): boolean {
  try {
    return walkSubtree(schema, new Set());
  } catch {
    return false; // a shape getter threw: contained, the answer so far stands
  }
}

function walkSubtree(schema: Node, seen: Set<Node>): boolean {
  if (seen.has(schema)) return false; // recursive subtree (lazy self-reference) -- asyncness is decided by the first expansion
  seen.add(schema);
  const def = schema._zod.def;
  if (def.type === "lazy") {
    let inner: Node | null = null;
    try {
      inner = def.getter();
    } catch {
      // stock runs the getter at parse time only: sync until then, opaque now (#83)
    }
    if (inner && walkSubtree(inner, seen)) return true;
  }
  if (isAsyncFn(def.fn) || isAsyncFn(def.transform)) return true;
  const checks: Node[] = def.checks ?? [];
  for (const c of checks) {
    const d = c._zod?.def ?? c;
    if (isAsyncFn(d.fn) || isAsyncFn(c._zod?.check)) return true;
  }
  return childrenOf(schema).some((k) => walkSubtree(k, seen));
}

/**
 * Whether the official product for the subtree must be one of this layer's islands, whose `_zod.run` is the runtime,
 * because stock's compiled product would answer differently from the runtime somewhere inside it:
 *
 * - an optional / nullable layer whose checks stock's compiler answers differently from its runtime on the shortcut
 *   (`wrapperFollowsRuntime`, #69);
 * - a `lazy` (#81, #90, #91). Stock's compiled product runs a `lazy` in the runtime already (`generateLazyCheck` runs
 *   the getter's `_zod.run` under an empty context), so no compiled fast path is lost, but its generated code reads
 *   `.issues` off whatever came back, without the thenable check stock's `runtimeRun` has: a `Promise` a plain
 *   function returns inside the lazy (a transform, a refine), which no static detector sees, ends in a `TypeError`
 *   there, where this layer's `makeIsland` throws `$ZodAsyncError` on the thenable (`throwAsync`), the fast path's
 *   Promise signal the async entries of `compile()` hand to stock's async runtime, and `runIsland` records a
 *   callback's own `$ZodAsyncError` (the #80 residual does not reach a lazy position). Stock's `compileFn` also reads
 *   the getter through the memo a throwing getter poisons for every later parse (#83, see `inspectSubtree`); this
 *   walk stops at the lazy and never makes that read.
 *
 * The walk reads every object shape below the subtree; a getter that throws is contained like in `inspectSubtree`.
 * The subtree then goes on to `compileFn`, whose cycle check reads the same shape before any codegen and counts a
 * read that throws as a reference cycle (zod 4.5.4 `compile.js`: "can't tell" is recursive), so `compileFn` throws
 * `ZodCompileUnsupportedError` for a compilable subtree too and `officialFn` takes an island, whose run meets the
 * getter's own error at parse time where stock's parser does (review of #82, review of #100).
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
  if (wrapperFollowsRuntime(schema) || schema._zod.def.type === "lazy") return true;
  return childrenOf(schema).some((k) => walkFollowsRuntime(k, seen));
}

/**
 * Whether the subtree holds a transform whose function is not an async function (a `.transform`, a `z.transform`,
 * the transform side of a `pipe` / `preprocess`, the decode function of a `z.codec`, which zod 4.5.4 stores on the
 * `pipe` def itself rather than in a child transform node, review of #89), the one position where a plain function
 * returning a `Promise` is not thrown at the sync API by the official products: their transform helpers answer
 * `INVALID` for a `Promise` (`generateTransformCheck` and the pipe helper of zod 4.5.4 `compile.js`), which every other entry of `compile()`
 * hands to stock, while `validate` would read as a rejection. `validate` consults stock's sync parse before
 * answering null for such a tree (#79). An async-function transform makes the tree async, so its sync entries throw
 * before any product runs. A `lazy` is not descended, since the official transform helper is never reached inside
 * one: a tree holding a `lazy` has no whole-tree validator (`officialValidator`), so `validate` runs the skeleton,
 * whose `lazy` is one of this layer's islands, and the island throws `$ZodAsyncError` on the thenable (#90). A shape
 * getter that throws is contained as in `inspectSubtree`; the parse meets it again.
 */
export function subtreeHasPlainTransform(schema: Node): boolean {
  try {
    return walkHasPlainTransform(schema, new Set());
  } catch {
    return false;
  }
}

function walkHasPlainTransform(schema: Node, seen: Set<Node>): boolean {
  if (seen.has(schema)) return false;
  seen.add(schema);
  const def = schema._zod.def;
  if (def.type === "lazy") return false;
  // a `transform` node, or a `pipe` node carrying the decode function of a `z.codec` on its own def
  if ((def.type === "transform" || def.type === "pipe") && typeof def.transform === "function") {
    if (!isAsyncFn(def.transform)) return true;
  }
  return childrenOf(schema).some((k) => walkHasPlainTransform(k, seen));
}

/**
 * The schema nodes directly below `schema` (every def slot that holds one), object shape included, and the schema a
 * check carries (`z.property` / `z.properties`, whose `$ZodCheckProperty` holds a schema stock's compiler compiles
 * inline through `generatePropertyCheck` while the runtime runs it through `_zod.run`, review of #84): a wrapper
 * `wrapperFollowsRuntime` names, or an async check, inside such a schema counts like one under a shape key.
 */
function childrenOf(schema: Node): Node[] {
  const def = schema._zod.def;
  const kids: Node[] = [];
  const checks: Node[] = def.checks ?? [];
  for (const c of checks) {
    const carried = (c._zod?.def ?? c).schema;
    if (carried?._zod) kids.push(carried);
  }
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

/* ═══════════════════ #80: recording the $ZodAsyncError a plain-function callback throws ═══════════════════ */

/**
 * A plain function that returns a `Promise` reaches the synchronous fast path as stock's `$ZodAsyncError`,
 * thrown by the `throwAsync` stock hoists into an official product's generated code (§5.5 item 6). A callback
 * can throw the same public class itself (a nested sync `parse` of an async schema does, or `new $ZodAsyncError()`),
 * and that throw is the caller's: stock rejects the parse with it after one call. This layer records the ones its
 * own call sites see (a container / wrapper / union `.refine`, an awaited predicate, an island's run) in a WeakSet
 * so the async entries reject after one call instead of rerunning (`rethrowCallerError` / `isPromiseSignal`).
 *
 * A callback stock's generated code calls — a leaf `.refine`, `.check`, `.superRefine`, `z.custom` predicate, a
 * custom string format's predicate, `overwrite` or `transform` inside an official product — was not recorded (#80):
 * stock calls the hoisted `def.fn` / `_zod.check` / `def.tx` / `def.transform` directly and reports a `Promise` from its own `throwAsync`. But those
 * slots are plain, writable data properties that stock's compiler reads only at compile time (`addConstant` hoists
 * the reference into the generated closure). So a wrapper installed on each such slot for the duration of the
 * `compileFn` call is captured by the generated code as a constant and stays in force at parse time, while the
 * slot itself is restored immediately, descriptor and all, leaving the caller's schema as it was. The wrapper records a
 * thrown `$ZodAsyncError` (and rethrows every throw unchanged), so a callback's own throw inside an official
 * product now rejects after one call like stock, and a returned `Promise` still reaches stock's `throwAsync` as
 * the unrecorded signal it is.
 *
 * Only a non-async callback is wrapped: an async function must stay visible to stock's `isAsyncFunction`, which
 * decides the `ZodCompileAsyncError` that routes the subtree to an async island. A `.default()` / `.prefault()`
 * value factory is a getter, not a writable slot, so its throw stays the one documented residual.
 */
type CallbackSlot = { obj: Record<string, unknown>; key: string; fn: unknown };
/**
 * A slot the install wrote (or tried to write): `desc` is the own descriptor it had before the write, `undefined`
 * for an inherited one; `wrapper` is the function the write handed it, which the restore looks for.
 */
type InstalledSlot = CallbackSlot & { desc: PropertyDescriptor | undefined; wrapper: unknown };

function wrapCallback(orig: unknown): (this: unknown, ...args: unknown[]) => unknown {
  return function (this: unknown, ...args: unknown[]): unknown {
    try {
      return (orig as (...a: unknown[]) => unknown).apply(this, args);
    } catch (e) {
      rethrowCallerError(e); // records a $ZodAsyncError, rethrows everything
    }
  };
}

/**
 * Walk the subtree stock's `compileFn` would inline (never a `lazy`, which is already island-routed by
 * `subtreeFollowsRuntime` before this runs) and collect every non-async user-callback slot stock's compiler
 * reads, plus the set of nodes that carry one. `childrenOf` supplies the structural descent, including the shape
 * a `z.property` / `z.properties` check carries, which stock compiles inline.
 */
function collectCallbackSlots(schema: Node): { slots: CallbackSlot[]; nodes: Node[] } {
  const slots: CallbackSlot[] = [];
  const nodes: Node[] = [];
  const seen = new Set<Node>();
  const visit = (node: Node): void => {
    if (!node?._zod || seen.has(node)) return;
    seen.add(node);
    const def = node._zod.def;
    if (!def || def.type === "lazy") return;
    let hasCb = false;
    const add = (obj: unknown, key: string, fn: unknown): void => {
      slots.push({ obj: obj as Record<string, unknown>, key, fn });
      hasCb = true;
    };
    const checks: Node[] = Array.isArray(def.checks) ? def.checks : [];
    for (const c of checks) {
      const cz = c?._zod;
      if (!cz) continue;
      const cdef = cz.def ?? {};
      // refine / z.custom predicate / string_format all live on def.fn (stock reads it first); superRefine and
      // .check() carry a check function on _zod.check; overwrite carries its transform on def.tx.
      if (typeof cdef.fn === "function" && !isAsyncFn(cdef.fn)) add(cdef, "fn", cdef.fn);
      else if (typeof cz.check === "function" && !isAsyncFn(cz.check)) add(cz, "check", cz.check);
      if (typeof cdef.tx === "function" && !isAsyncFn(cdef.tx)) add(cdef, "tx", cdef.tx);
    }
    if (
      (def.type === "transform" || def.type === "pipe") &&
      typeof def.transform === "function" &&
      !isAsyncFn(def.transform)
    )
      add(def, "transform", def.transform);
    if (def.type === "custom" && typeof def.fn === "function" && !isAsyncFn(def.fn))
      add(def, "fn", def.fn);
    // A custom string format (`z.stringFormat(name, fn)`, and the regex closures of `z.hostname()` / `z.hex()` /
    // `z.hash()`) is a `string` schema whose predicate sits on its own `def.fn`, which stock's
    // `generateStringFormatCheck` hoists like a check's (third review of #112).
    if (def.type === "string" && typeof def.fn === "function" && !isAsyncFn(def.fn))
      add(def, "fn", def.fn);
    if (hasCb) nodes.push(node);
    // A shape getter that throws (the #82 / #100 case) is contained like every other walk here: stock's own
    // `compileFn` reads the shape in its cycle check and counts the throw as recursion, so `officialFn`'s compile
    // below throws and islands the subtree; the slots gathered so far are harmless (the island uses the schema).
    let kids: Node[];
    try {
      kids = childrenOf(node);
    } catch {
      return;
    }
    for (const k of kids) visit(k);
  };
  visit(schema);
  return { slots, nodes };
}

/**
 * Install the recording wrappers, all or none. A slot that refuses the write (a frozen or sealed `def`, a
 * non-writable property, an accessor that swallows the write, a Proxy trap that throws on the write or on the read
 * that verifies it) undoes the slots already wrapped and answers `null`, so the caller's schema is never left partly
 * wrapped and the caller takes the island instead, whose `runIsland` records the throw without writing the schema
 * (review of #112). Stock's `compileFn` never writes a schema, so a frozen one parses on stock and must keep
 * compiling and parsing here.
 *
 * The restore puts the slot back as it was, not only its value (third review of #112): an own data property gets
 * its original descriptor back through `defineProperty` (value and attributes), an own accessor is handed the
 * original through its setter (the descriptor itself was never replaced), and a slot the schema inherited is deleted
 * again so it does not become an own property. It puts back only what holds the wrapper (fourth review of #112): a
 * slot whose write failed usually holds nothing (an own accessor without a setter, which is declined before any
 * write since a strict-mode assignment to it can only throw; an inherited getter whose function differs per read; a
 * Proxy `set` trap that throws or answers `false`), and writing it a second time would throw again or hand the
 * schema a function it never held, where stock, which writes nothing, parses the schema; so the restore reads the
 * slot first (its own descriptor for a data property, the value for an accessor or an inherited slot) and skips a
 * slot that shows no wrapper. Every slot is restored even when one of them throws (a Proxy trap that accepted the
 * wrapper and refuses the write back, or one that stored it and then threw from `set`): the others are put back
 * first, then a `TypeError` naming the slot, with the trap's error as `cause`, surfaces from `compile()`
 * (`isSlotRestoreFailure` lets it through the pure branch of `emitNode`, which swallows a refused compile), since the
 * slot it guards holds the wrapper and silence would hide the mutation; a later install would otherwise read that
 * wrapper as the caller's function. The wrapper is transparent to every call (it applies the original with the same
 * receiver and arguments), so such a schema still parses like stock.
 */
const slotRestoreFailures = new WeakSet<TypeError>();

/** Whether `e` is the `TypeError` `installWrappers` throws when a slot refused the write back after the compile. */
export function isSlotRestoreFailure(e: unknown): boolean {
  return e instanceof TypeError && slotRestoreFailures.has(e);
}

function installWrappers(slots: CallbackSlot[]): (() => void) | null {
  const done: InstalledSlot[] = [];
  const restore = (): void => {
    let failure: TypeError | null = null;
    for (const s of done) {
      try {
        restoreSlot(s);
      } catch (e) {
        if (failure === null) {
          failure = new TypeError(
            `zod-cow: the callback slot "${s.key}" refused the write back of the caller's function after the compile; the schema still holds the recording wrapper`,
            { cause: e },
          );
          slotRestoreFailures.add(failure);
        }
      }
    }
    done.length = 0;
    if (failure) throw failure;
  };
  for (const s of slots) {
    const w = wrapCallback(s.fn);
    let desc: PropertyDescriptor | undefined;
    try {
      desc = Object.getOwnPropertyDescriptor(s.obj, s.key);
    } catch {
      restore();
      return null;
    }
    // An own accessor without a setter cannot take the write (a strict-mode assignment to it throws before any
    // code runs), so it is declined before the write, with nothing to restore on it (fourth review of #112).
    if (desc !== undefined && isAccessor(desc) && typeof desc.set !== "function") {
      restore();
      return null;
    }
    // Recorded before the write: a write that throws or a read-back that refuses may still have taken effect.
    done.push({ ...s, desc, wrapper: w });
    try {
      s.obj[s.key] = w;
      if (s.obj[s.key] !== w) {
        restore();
        return null;
      }
    } catch {
      restore();
      return null;
    }
  }
  return restore;
}

function isAccessor(desc: PropertyDescriptor): boolean {
  return "get" in desc || "set" in desc;
}

/** Whether two own descriptors read the same (every attribute, `value` by identity). */
function sameDescriptor(a: PropertyDescriptor, b: PropertyDescriptor): boolean {
  return (
    Object.is(a.value, b.value) &&
    a.writable === b.writable &&
    a.get === b.get &&
    a.set === b.set &&
    a.enumerable === b.enumerable &&
    a.configurable === b.configurable
  );
}

/**
 * Put one slot back as it was, touching only what holds the wrapper: a slot whose write failed may hold nothing,
 * and a write to it would throw again (fourth review of #112). A read that throws here counts as "holds it", so
 * the restore is attempted and its throw surfaces through `restore`.
 */
function restoreSlot(s: InstalledSlot): void {
  if (s.desc === undefined) {
    // Inherited before the write (or absent): a write that took effect created an own property, so delete it; an
    // inherited accessor that stored the wrapper elsewhere still answers it, so hand the original back through it
    // then.
    let own = true;
    try {
      own = Object.getOwnPropertyDescriptor(s.obj, s.key) !== undefined;
    } catch {}
    if (own) delete s.obj[s.key];
    let answersWrapper = true;
    try {
      answersWrapper = s.obj[s.key] === s.wrapper;
    } catch {}
    if (answersWrapper) s.obj[s.key] = s.fn;
  } else if (isAccessor(s.desc)) {
    let answersWrapper = true;
    try {
      answersWrapper = s.obj[s.key] === s.wrapper;
    } catch {}
    if (answersWrapper) s.obj[s.key] = s.fn;
  } else {
    let unchanged = false;
    try {
      const now = Object.getOwnPropertyDescriptor(s.obj, s.key);
      unchanged = now !== undefined && sameDescriptor(now, s.desc);
    } catch {}
    if (!unchanged) Object.defineProperty(s.obj, s.key, s.desc);
  }
}

/**
 * Whether stock would run this callback-bearing node inside a runtime island of its own generated code (an
 * islandable `ZodCompileUnsupportedError` at the node: a coercion, an unsupported format, a custom-`when` check,
 * …). A compile-time wrapper cannot reach such a callback — the island reads the schema through `runtimeRun` at
 * parse time, after the slot is restored — so the whole subtree is routed to this layer's island instead, whose
 * `runIsland` records the throw. A non-islandable refusal (a `catch` callback) and an async throw are left to the
 * whole-subtree `compileFn` below, which throws and lets `officialFn` island the tree the usual way.
 */
function wouldRuntimeIslandCallback(node: Node): boolean {
  try {
    compileFn(node);
    return false;
  } catch (e) {
    return (
      e instanceof ZodCompileUnsupportedError &&
      (e as { islandable?: boolean }).islandable !== false
    );
  }
}

/**
 * The pure-subtree assertOnly validator (`emitNode`'s pure branch) with the same callback recording (#80).
 * Throws whatever `compileFn` throws, so the caller keeps its `ZodCompileAsyncError` handling; the wrappers are
 * always restored. Answers `null` when a slot refuses the wrapper (a frozen `def`), so the caller falls through to
 * `officialFn`, which islands the subtree. A pure subtree that compiles here has no islandable refusal (it
 * compiled), so no island check is needed on the success path; a callback stock would runtime-island is caught by
 * `pureSubtreeNeedsIsland`, which the caller consults first.
 */
export function compileAssertOnlyRecording(schema: Node): Fn | null {
  const restore = installWrappers(collectCallbackSlots(schema).slots);
  if (restore === null) return null;
  try {
    return compileFn(schema, { assertOnly: true }) as Fn;
  } finally {
    restore();
  }
}

/**
 * Whether a pure subtree holds a callback stock would run inside a runtime island (#80): the validator baked from
 * `compileFn` cannot record such a callback's throw, so the caller sends the subtree down the island path instead.
 */
export function pureSubtreeNeedsIsland(schema: Node): boolean {
  return collectCallbackSlots(schema).nodes.some(wouldRuntimeIslandCallback);
}

/**
 * Get the official product for a subtree. pure → assertOnly validator (validation semantics intact, output = input);
 * otherwise → parser (stock output semantics). On product generation failure it degrades step by step.
 * async is no longer rethrown upwards (Task 6): a subtree for which the official compileFn throws ZodCompileAsyncError
 * is routed to an async island instead (an await site at the call site, which suspends only when the island answered
 * a Promise, #105); lazy(async·…) is covered by the static detection.
 *
 * Callbacks stock's generated code calls are wrapped for the duration of the compile so a `$ZodAsyncError` they throw
 * is recorded like this layer's own (#80); a callback stock would run in a runtime island is unreachable that way, so
 * the subtree takes an island instead.
 */
export function officialFn(schema: Node, pure: boolean): Fn {
  // A subtree stock's compiled product would answer differently from its runtime takes one of this layer's islands
  // (`subtreeFollowsRuntime`): one holding a wrapper carrying a check stock's compiler answers differently from its
  // runtime on the shortcut (#69), or holding a `lazy` (#81, #90, #91; a bare `lazy` since the sixth review of #76),
  // whose official product is a runtime island of stock's own anyway (`generateLazyCheck`), one that reads `.issues`
  // off a thenable a plain function returned where this layer's `runIsland` and `throwAsync` answer stock's class.
  // A `lazy` whose getter throws at compile time is covered by the same rule (#83): stock's `compileFn` would read
  // the getter through the memo that a throw poisons for every later parse (`inspectSubtree`), so it is never tried
  // on such a subtree. The static walk decides which island: inner async raises no compile-time error inside a lazy.
  const island = (): Fn => (inspectSubtree(schema) ? makeAsyncIsland(schema) : makeIsland(schema));
  if (subtreeFollowsRuntime(schema)) return island();
  const { slots, nodes } = collectCallbackSlots(schema);
  // #80: a callback stock would run inside a runtime island cannot be reached by a compile-time wrapper;
  // route the whole subtree to this layer's island so its `runIsland` records the throw.
  if (nodes.some(wouldRuntimeIslandCallback)) return island();
  const restore = installWrappers(slots);
  // A slot refused the write (a frozen `def`, a Proxy trap): the island records the throw without writing the schema.
  if (restore === null) return island();
  try {
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
      return island();
    }
  } finally {
    restore(); // the generated closure captured the wrappers as constants; the caller's schema is left as it was
  }
}

/**
 * The whole-tree official assertOnly product (the validate fast path); failure → null, and so is a tree holding a
 * wrapper the runtime must answer (#69) or a `lazy` (#90; a `lazy` whose getter throws at compile time included,
 * #83, since stock's `compileFn` would poison its memo, see `inspectSubtree`): the skeleton, whose islands run such a
 * subtree, serves `validate` then, at the cost of the validator fast path on every recursive schema.
 */
export function officialValidator(schema: Node): Fn | null {
  if (subtreeFollowsRuntime(schema)) return null;
  // Record a plain-function callback's own `$ZodAsyncError` in the validator too (#80); `validate` is sync,
  // so the result parity here is a thrown error either way, but the wrapper keeps the two paths consistent.
  const restore = installWrappers(collectCallbackSlots(schema).slots);
  if (restore === null) return null; // a frozen `def`: `validate` runs the skeleton, whose subtree islands
  try {
    return compileFn(schema, { assertOnly: true }) as Fn;
  } catch {
    return null;
  } finally {
    restore();
  }
}
