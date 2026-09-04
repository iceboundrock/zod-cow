/**
 * zc-z4 -- the CoW container decoration layer (reuses zod4's official codegen as the semantic backend).
 *
 * ═══════════════════════════════════════════════════════════════════
 *  Design principle: the JIT compiler shipped with zod4 (>=4.1) (src/v4/core/compile.ts,
 *  exposed through "zod/compile" or z.compile()) already compiles every validation/transform
 *  semantic into a monolithic function. This layer writes no semantic codegen of its own; it only does three things:
 *
 *  1. Purity analysis (conservative whitelist): decide whether a subtree's parse output is necessarily === its input.
 *     Pure subtree → reuse the official assertOnly product directly (the same thing as bag.validator:
 *     complete validation semantics, zero output construction); impure subtree → reuse the official parser product,
 *     using a reference comparison (out !== in) to detect whether a "value producer" actually fired.
 *
 *  2. Container CoW skeleton codegen (two of them: object/array): the only codegen written here,
 *     rewriting the official "unconditional new container" (const out = {...} / new Array(n)) into
 *     "reference comparison for dirtiness + conditional shallow copy" -- a clean input returns the original reference, a copy only happens when forced.
 *     Key order and key presence are preserved naturally by the {...input} spread; the extra-key
 *     rules of strip/strict/loose are aligned line by line with the official for...in + Set template.
 *
 *  3. Failure fallback: any INVALID only passes the sentinel back, and the top level uniformly falls back to stock safeParse --
 *     issues/path/error map/ZodError construction is 100% official, with zero semantics reimplemented.
 *     Coexists with the global "zod/compile" shim: the fallback path automatically enjoys the official JIT.
 *
 *  Degradation chain (independent per subtree):
 *    assertOnly product → parser product → runtime island (black-box _zod.run)
 *    → whole-tree stock (async/recursion and other cases this layer does not handle at all).
 *
 *  Official internal APIs reused (publicly re-exported from zod/v4/core, version anchor 4.5.4):
 *    compileFn(schema, { assertOnly?, debug? })  monolithic function generation
 *    INVALID                                     failure sentinel
 *    ZodCompileUnsupportedError / ZodCompileAsyncError
 * ═══════════════════════════════════════════════════════════════════
 */
import { INVALID } from "zod/v4/core";
import { buildFn, CodeCtx } from "./codectx.js";
import { emitNode } from "./emit.js";
import type { Fn, Node } from "./product.js";

export { officialValidator } from "./official.js";
export { type Fn, isAsyncProduct, ZC_ASYNC } from "./product.js";

/* ═══════════════════ Top-level compilation ═══════════════════ */

/** Builds the CoW monolithic function; throws when not compilable (async/recursion/exotic features), and the caller degrades the whole tree */
export function compileCowFn(schema: Node): Fn {
  const ctx = new CodeCtx();
  const acc = emitNode(ctx, schema, "input", true, new Set());
  ctx.write(`return ${acc ?? "true"};`);
  return buildFn(ctx);
}

/** Same as above, but returns [function, source] for a debug dump */
export function compileCowDebug(schema: Node): { fn: Fn; code: string } {
  const ctx = new CodeCtx();
  const acc = emitNode(ctx, schema, "input", true, new Set());
  ctx.write(`return ${acc ?? "true"};`);
  return { fn: buildFn(ctx), code: ctx.lines.join("\n") };
}

export { INVALID };
