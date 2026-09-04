/** Codegen context and the Function-constructor build step shared by all skeletons. */
import { INVALID } from "zod4/v4/core";
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

export function buildFn(ctx: CodeCtx): Fn {
  const F = Function;
  const head = ctx.async ? "return async (input) => {" : "return (input) => {";
  const factory = new F("INVALID", ...ctx.constNames, `${head}\n${ctx.lines.join("\n")}\n}`);
  const fn = factory(INVALID, ...ctx.constValues) as Fn;
  return ctx.async ? markAsync(fn) : fn;
}
