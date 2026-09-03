/**
 * zc — Zod-compatible CoW compilation layer (prototype).
 *
 * 消费 stock zod 的 schema（读取其 .def 树），编译出零拷贝/按需拷贝的校验闭包。
 * 不 fork zod、不改 Zod API：z.schema 继续用于类型推断与普通 parse；
 * compile(schema) 额外提供三个入口：
 *
 *   .parse(data)     CoW 语义：成功返回值（可能 === 输入，结构共享）
 *   .validate(data)  与 parse 相同的运行时，返回类型标 DeepReadonly —— 把
 *                    “输出与输入共享”这一事实写进类型系统
 *   .safeParse(data) 不抛错误的版本
 */
import { z } from "zod";
import { FAILED, Issue, ZcError } from "./internal.js";
import { go, isStaticPure } from "./compile.js";

export type { Issue, PathSegment, Ctx, Validator } from "./internal.js";
export { ZcError, ZcNotSupportedError } from "./internal.js";
export { PROBE } from "./probe.js";

export type DeepReadonly<T> = T extends (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends Map<infer K, infer V>
    ? ReadonlyMap<DeepReadonly<K>, DeepReadonly<V>>
    : T extends Set<infer U>
      ? ReadonlySet<DeepReadonly<U>>
      : T extends object
        ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
        : T;

export type SafeParseResult<T> =
  | { success: true; data: T }
  | { success: false; error: ZcError };

export interface Compiled<T extends z.ZodTypeAny> {
  /** 原始 zod schema（仍可用作类型推断 / .extend / stock parse） */
  readonly schema: T;
  /**
   * 静态纯度：true 表示该 schema 校验成功时恒等返回输入引用
   * （strip 模式对象假定输入不含多余键；运行时始终以引用比较为准）。
   */
  readonly pure: boolean;
  /**
   * CoW parse：成功返回解析值。
   * 未发生任何“被迫修改”时 === 输入本身；否则仅脏路径上的对象被浅拷贝。
   * 失败抛 ZcError（含 issues）。输入永不失真（绝不原地修改）。
   */
  parse(data: unknown): z.output<T>;
  /**
   * validate 语义（Numeric 用例）：与 parse 完全相同的运行时，
   * 但返回类型为 DeepReadonly —— 提示调用方输出与输入共享结构。
   */
  validate(data: unknown): DeepReadonly<z.output<T>>;
  safeParse(data: unknown): SafeParseResult<z.output<T>>;
}

export function compile<T extends z.ZodTypeAny>(schema: T): Compiled<T> {
  const validator = go(schema);
  const pure = isStaticPure(schema);

  const compiled: Compiled<T> = {
    schema,
    pure,

    parse(data: unknown): z.output<T> {
      const ctx = { issues: [], path: [] as (string | number)[] };
      const r = validator(data, ctx);
      if (r === FAILED) throw new ZcError(ctx.issues as Issue[]);
      return r as z.output<T>;
    },

    validate(data: unknown): DeepReadonly<z.output<T>> {
      return compiled.parse(data) as DeepReadonly<z.output<T>>;
    },

    safeParse(data: unknown): SafeParseResult<z.output<T>> {
      const ctx = { issues: [], path: [] as (string | number)[] };
      const r = validator(data, ctx);
      if (r === FAILED) return { success: false, error: new ZcError(ctx.issues as Issue[]) };
      return { success: true, data: r as z.output<T> };
    },
  };

  return compiled;
}
