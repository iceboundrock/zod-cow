/** Codegen context and the Function-constructor build step shared by all skeletons. */
import { INVALID } from "zod/v4/core";
import type { CowOptions } from "./options.js";
import { type Fn, markAsync } from "./product.js";

/* ═══════════════════ Codegen context (minimal equivalent of the official CodeCtx/Doc) ═══════════════════ */

export class CodeCtx {
  lines: string[] = [];
  indent = 0;
  constNames: string[] = [];
  constValues: unknown[] = [];
  /** The tree contains an async subtree → the product is an async function (await emit points already in place) */
  async = false;
  private varN = 0;

  /**
   * The compile options of the tree and the source of every skeleton built so far, both shared by
   * the whole tree: a sub-skeleton context is created with its parent's options and its parent's
   * `sources` (`subFn`), so `compileCowDebug` can dump the nested skeletons next to the top-level
   * one (#46). `buildFn` appends to `sources`, `compileCowDebug` reads it, and a failed sub-skeleton
   * build truncates it back (`dropSourcesOnThrow` in `emit.ts`).
   */
  constructor(
    readonly options: CowOptions,
    readonly sources: string[] = [],
  ) {}

  /** Equivalent of the official addConstant: runtime references are hoisted into function parameters (c0,c1,…), deduped by === */
  addConst(value: unknown): string {
    for (let i = 0; i < this.constValues.length; i++) {
      if (this.constValues[i] === value) return this.constNames[i]!;
    }
    const name = `c${this.constNames.length}`;
    this.constNames.push(name);
    this.constValues.push(value);
    return name;
  }

  var(): string {
    // The x prefix distinguishes them from the official v, so the official dump is easy to compare by eye
    return `x${this.varN++}`;
  }

  write(line: string): void {
    this.lines.push("  ".repeat(this.indent) + line);
  }

  indented(fn: () => void): void {
    this.indent++;
    fn();
    this.indent--;
  }
}

/** Source escaping for string keys known at compile time (minimal coverage of the official util.esc semantics) */
export function escKey(k: string): string {
  return JSON.stringify(k);
}

/**
 * Containers with at most this many declared string keys probe undeclared keys with a generated
 * `k !== "a" && k !== "b" …` chain; larger ones fall back to `Set.has(k)`. `for...in` hands V8
 * internalized strings, so each comparison is a pointer compare, while `Set.has` hashes and
 * probes per key. Measured on Node 24 the chain is still 4 to 5x faster than the Set at 16 to 32
 * keys and only reaches parity around 128 keys, so this cap is conservative; it bounds the
 * generated code size rather than marking the break-even point. Raising it is a benchmark-backed
 * decision, not a correctness one (#34).
 */
export const MAX_INLINE_KEY_COMPARISONS = 16;

/**
 * Expression over a `for...in` loop variable `k` that is true when `k` is none of `stringKeys`.
 * Shared by the object and record skeletons (#33, #37): the comparison chain up to
 * `MAX_INLINE_KEY_COMPARISONS` keys, `!<set>.has(k)` above it, where `knownSet` hoists the
 * caller's known-key `Set` on first use (a small shape never references it). `for...in` yields
 * strings only, so declared symbol keys never reach this probe; a shape without a string key
 * treats every string key as undeclared (#35).
 */
export function unknownStringKeyExpr(
  stringKeys: readonly string[],
  knownSet: () => string,
): string {
  return stringKeys.length <= MAX_INLINE_KEY_COMPARISONS
    ? stringKeys.map((key) => `k !== ${escKey(key)}`).join(" && ") || "true"
    : `!${knownSet()}.has(k)`;
}

export function buildFn(ctx: CodeCtx): Fn {
  const F = Function;
  const head = ctx.async ? "return async (input) => {" : "return (input) => {";
  const body = ctx.lines.join("\n");
  const factory = new F("INVALID", ...ctx.constNames, `${head}\n${body}\n}`);
  ctx.sources.push(body);
  const fn = factory(INVALID, ...ctx.constValues) as Fn;
  return ctx.async ? markAsync(fn) : fn;
}
