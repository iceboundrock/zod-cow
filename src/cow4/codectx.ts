/** Codegen context and the Function-constructor build step shared by all skeletons. */
import { INVALID } from "zod4/v4/core";
import { type Fn, markAsync } from "./product.js";

/* ═══════════════════ 代码生成上下文（官方 CodeCtx/Doc 的最小等价物） ═══════════════════ */

export class CodeCtx {
  lines: string[] = [];
  indent = 0;
  constNames: string[] = [];
  constValues: unknown[] = [];
  /** 树中含 async 子树 → 产物为 async 函数（await 发射点已就位） */
  async = false;
  private varN = 0;

  /** 官方 addConstant 等价：运行时引用提升为函数参数（c0,c1,…），按 === 去重 */
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
    // 前缀 x 区别于官方 v，便于肉眼比对官方 dump
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

/** 编译期已知字符串键的源码转义（官方 util.esc 语义的最小覆盖） */
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
