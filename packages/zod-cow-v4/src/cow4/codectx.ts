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
  /**
   * Parameters the built function takes after `input`, in order: the checks subroutine of an object with
   * `z.property` checks receives the held value of each such key from the skeleton (#85); a skeleton takes none
   */
  params: string[] = [];
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
 * probes per key. The chain is quadratic in the key count (a declared key at position i costs
 * i + 1 comparisons), the Set linear, so the two cross.
 *
 * Measured through the real skeleton (#34; the S11 rows of `bench-v4`, single-record hot loops of
 * flat objects of string keys built with `JSON.parse`, the whole parse timed): against the Set at
 * the same width the chain is 20 to 30% faster at 17 to 32 keys, level at 48 and 5 to 10% slower
 * at 64 on Node 24 locally (strip clean 219 → 177 ns at 17 keys, 354 → 275 ns at 32, 446 → 443 ns
 * at 48, 621 → 663 ns at 64; the strict and extra-key rows move the same way, the dirty row, which
 * runs no probe, not at all). The Benchmarks workflow (GitHub-hosted runner, `BENCH_ITERS=1 000 000`)
 * read the 32-key rows at the cap of 16 and at 32 on Node 22 / 24 / 26: strip clean 380 → 250,
 * 273 → 222 and 227 → 200 ns, strict clean 379 → 245, 273 → 208 and 226 → 197 ns, the extra-key row
 * 294 → 191, 288 → 214 and 226 → 216 ns, while the 16- and 64-key rows, whose probe did not change,
 * moved by at most 4% on Node 24 and 26 and by about 25% either way on Node 22, its run-to-run
 * variance (runs 34155229369 / 34155230627 / 34155231942 at 16, 34155316232 / 34155317795 /
 * 34155319415 at 32). 32 is the largest width with a clear win on every lane; the code
 * size is not a concern at that width (a 32-key strip skeleton is about 500 characters longer with
 * the chain). The review microbenchmark of #33, which timed the probe alone over an object of that
 * width, put the crossover near 128 keys; timing the whole parse moves it to about 48, since the
 * rest of the skeleton is linear in the key count and the chain's quadratic term shows earlier.
 */
export const MAX_INLINE_KEY_COMPARISONS = 32;

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

/**
 * Own-symbol probe of a clean container: sets `extraVar` when `accessor` carries an own symbol key
 * that is not one of the declared `symbolKeys`. Shared by the object skeleton (every mode, #42)
 * and the enum-keyed record skeleton (#51): stock's rebuild drops undeclared own symbol keys,
 * enumerable or not, so a skeleton has to prove there are none before returning the input by
 * reference, and `Object.getOwnPropertySymbols` is the only way to ask without listing every key.
 * Callers emit it only under `ownSymbolKeys: "probe"`. `knownSet` hoists the caller's known-key
 * `Set` on first use; a container without a declared symbol key never references it.
 */
export function emitOwnSymbolProbe(
  ctx: CodeCtx,
  accessor: string,
  extraVar: string,
  symbolKeys: readonly symbol[],
  knownSet: () => string,
): void {
  const syms = ctx.var();
  ctx.write(`const ${syms} = Object.getOwnPropertySymbols(${accessor});`);
  if (symbolKeys.length === 0) {
    ctx.write(`if (${syms}.length !== 0) ${extraVar} = true;`);
  } else {
    ctx.write(`for (const s of ${syms}) {`);
    ctx.indented(() => {
      ctx.write(`if (!${knownSet()}.has(s)) { ${extraVar} = true; break; }`);
    });
    ctx.write(`}`);
  }
}

export function buildFn(ctx: CodeCtx): Fn {
  const F = Function;
  const params = ["input", ...ctx.params].join(", ");
  const head = ctx.async ? `return async (${params}) => {` : `return (${params}) => {`;

  const body = ctx.lines.join("\n");
  const factory = new F("INVALID", ...ctx.constNames, `${head}\n${body}\n}`);
  ctx.sources.push(body);
  const fn = factory(INVALID, ...ctx.constValues) as Fn;
  return ctx.async ? markAsync(fn) : fn;
}
