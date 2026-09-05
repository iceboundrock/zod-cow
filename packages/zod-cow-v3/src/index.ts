/**
 * zc — Zod-compatible CoW compilation layer (prototype).
 *
 * Consumes stock zod schemas (reads their .def tree) and compiles zero-copy / copy-on-demand validation closures.
 * Does not fork zod and does not change the Zod API: z.schema is still used for type inference and plain parse;
 * compile(schema) additionally provides three entry points:
 *
 *   .parse(data)     CoW semantics: returns the value on success (may be === the input, structurally shared)
 *   .validate(data)  The same runtime as parse, with the return type marked DeepReadonly — it writes
 *                    the fact that "the output shares with the input" into the type system
 *   .safeParse(data) The non-throwing version
 */
import type { z } from "zod";
import { FAILED, type Issue, ZcError } from "./internal.js";
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

export type SafeParseResult<T> = { success: true; data: T } | { success: false; error: ZcError };

export interface Compiled<T extends z.ZodTypeAny> {
  /** The original zod schema (still usable for type inference / .extend / stock parse) */
  readonly schema: T;
  /**
   * Static purity: true means this schema always returns the input reference when validation succeeds
   * (strip-mode objects assume the input carries no extra keys; at runtime the reference comparison is always what counts).
   */
  readonly pure: boolean;
  /**
   * CoW parse: returns the parsed value on success.
   * === the input itself when nothing was "forced to change"; otherwise only the objects on the dirty path are shallow-copied.
   * Throws ZcError (carrying issues) on failure. The input is never altered (never mutated in place).
   */
  parse(data: unknown): z.output<T>;
  /**
   * validate semantics (the Numeric use case): exactly the same runtime as parse,
   * but the return type is DeepReadonly — a hint to the caller that output and input share structure.
   */
  validate(data: unknown): DeepReadonly<z.output<T>>;
  safeParse(data: unknown): SafeParseResult<z.output<T>>;
}

/**
 * Failure result with a lazy `error`: the `ZcError` (an `Error`, so a stack capture plus the joined
 * message) is built on first access, as stock zod's `safeParse` does. A caller that only reads
 * `success` pays for the issues alone.
 */
function failure<T>(issues: Issue[]): SafeParseResult<T> {
  let error: ZcError | undefined;
  return {
    success: false,
    get error(): ZcError {
      error ??= new ZcError(issues);
      return error;
    },
  };
}

export function compile<T extends z.ZodTypeAny>(schema: T): Compiled<T> {
  const validator = go(schema);
  const pure = isStaticPure(schema);

  const compiled: Compiled<T> = {
    schema,
    pure,

    parse(data: unknown): z.output<T> {
      const ctx = { issues: [], path: [] as (string | number)[], rebuilt: false };
      const r = validator(data, ctx);
      // FAILED = aborted; a value with issues = dirty (a failed check): both are a failed parse, as in stock
      if (r === FAILED || ctx.issues.length !== 0) throw new ZcError(ctx.issues as Issue[]);
      return r as z.output<T>;
    },

    validate(data: unknown): DeepReadonly<z.output<T>> {
      return compiled.parse(data) as DeepReadonly<z.output<T>>;
    },

    safeParse(data: unknown): SafeParseResult<z.output<T>> {
      const ctx = { issues: [], path: [] as (string | number)[], rebuilt: false };
      const r = validator(data, ctx);
      if (r === FAILED || ctx.issues.length !== 0) return failure(ctx.issues as Issue[]);
      return { success: true, data: r as z.output<T> };
    },
  };

  return compiled;
}
