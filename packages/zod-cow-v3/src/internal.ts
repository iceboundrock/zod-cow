/**
 * Internal protocol — the shared contract of the CoW compilation layer.
 *
 * ┌───────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
 * │ Core idea: every compiled node is a synchronous function                                                          │
 * │                                                                                                                   │
 * │   (data, ctx) => value | FAILED                                                                                   │
 * │                                                                                                                   │
 * │  · Success → returns the parsed value. That value may be === data (unchanged, zero-copy),                         │
 * │          or it may also be a new reference (default injection / transform / strip extra keys …)                   │
 * │  · Failure → returns the FAILED sentinel, the issue is appended to ctx.issues                                     │
 * │                                                                                                                   │
 * │ "Has the value been modified?" needs no flag bit at all — it is decided directly by outVal !== inVal:             │
 * │  · Primitives (string/number/…) compare by value; when validation passes they are always "unchanged";             │
 * │  · Objects/arrays compare by reference; a child passes the original reference through → the parent needs no copy; │
 * │  · Transform nodes (transform/default/coerce/catch) return a new value →                                          │
 * │    the "dirty" signal propagates naturally upward by reference comparison, and the parent makes one shallow copy  │
 * │    at the first change point (copy-on-write / path-copying), and all other sibling subtrees stay shared.          │
 * └───────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * Two kinds of failure, as in stock zod's ParseStatus:
 *   · aborted   the node returns FAILED (a type mismatch, or a container whose child aborted). The
 *               parent stops treating the value as usable but keeps walking its other children so
 *               one parse collects every issue.
 *   · dirty     the node pushes an issue and returns the value anyway (a failed check such as
 *               `.min(3)`, a failed refinement, an array length check). Parents keep going with the
 *               value: later checks still run on it, refinements at the ancestors still run, a union
 *               prefers a dirty option over an aborted one, `catch` replaces it. The parse as a whole
 *               fails whenever `ctx.issues` is non-empty at the top.
 */
import { defaultErrorMap, getErrorMap, type ZodErrorMap, type ZodIssueOptionalMessage } from "zod";

export const FAILED: unique symbol = Symbol("zc.FAILED");

export type PathSegment = string | number;

export interface Issue {
  code: string;
  path: PathSegment[];
  message: string;
  expected?: unknown;
  received?: unknown;
  /** For unrecognized_keys only */
  keys?: string[];
  /** Extra fields (minimum / maximum / validation / multipleOf …), aligned with stock zod's issue params */
  [param: string]: unknown;
}

export interface Ctx {
  issues: Issue[];
  /**
   * Path of the current node, maintained eagerly (push/pop) only inside subtrees that hold a
   * ZodEffects node (their callbacks read it); elsewhere containers splice their key into the
   * issues a child left behind (see `prefixIssues` in compile.ts). Materialized with slice() only
   * when an issue is produced. Stock zod builds a new path array per node, one of the sources of
   * its per-node allocation.
   */
  path: PathSegment[];
  /**
   * Stock's rebuild mode. Set by a `readonly` node and by a `default` whose value fired, for the
   * duration of their inner call, when stock would build a fresh output below them: every
   * container skeleton then assembles its output from the validated values instead of returning
   * the input by reference (the same assembly the dirty path uses), and a `date` leaf returns a
   * copy, so `readonly` freezes exactly what stock freezes (a fresh container, the input in place
   * over a pass-through leaf) and a parsed default never aliases the schema's default value.
   * Off everywhere else: the CoW paths are untouched.
   */
  force: boolean;
}

export type Validator = (data: any, ctx: Ctx) => any;

export class ZcNotSupportedError extends Error {
  constructor(feature: string) {
    super(`zc: schema feature not supported by the sync CoW compiler: ${feature}`);
    this.name = "ZcNotSupportedError";
  }
}

export class ZcError extends Error {
  constructor(public readonly issues: Issue[]) {
    super(
      issues.length === 0
        ? "Invalid input."
        : issues.map((i) => `[${i.code}] ${i.path.join(".") || "<root>"}: ${i.message}`).join("; "),
    );
    this.name = "ZcError";
  }
}

/* ────────────────────────── issue helpers ────────────────────────── */

/** Issue data as the compiler produces it: code plus params, `message` set when the check carries one */
export type IssueData = {
  code: string;
  message?: string;
  path?: PathSegment[];
  [param: string]: unknown;
};

/**
 * Stock zod's makeIssue: an explicit `message` wins; otherwise the error maps run in the order
 * default map → global override map (`z.setErrorMap`) → the schema's own map (`{ errorMap }`,
 * `{ message }`, `{ required_error }`, `{ invalid_type_error }` create params), each receiving the
 * previous message as `defaultError`. `data` is the value the node was parsing, which the create
 * param map reads to tell a missing value from a wrong type.
 */
export function issueMessage(
  issue: IssueData & { path: PathSegment[] },
  data: unknown,
  schemaMap: ZodErrorMap | undefined,
): string {
  const iss = issue as unknown as ZodIssueOptionalMessage;
  let message = defaultErrorMap(iss, { data, defaultError: "" }).message;
  const override = getErrorMap();
  if (override !== defaultErrorMap)
    message = override(iss, { data, defaultError: message }).message;
  if (schemaMap) message = schemaMap(iss, { data, defaultError: message }).message;
  return message;
}

/**
 * Append an issue at the current path. `extra.path` (an `addIssue` argument) is appended to the
 * current path as stock does.
 */
export function pushIssue(
  ctx: Ctx,
  data: unknown,
  schemaMap: ZodErrorMap | undefined,
  issue: IssueData,
): void {
  const path = issue.path ? [...ctx.path, ...issue.path] : ctx.path.slice();
  const full = { ...issue, path } as Issue;
  if (issue.message === undefined) full.message = issueMessage(full, data, schemaMap);
  ctx.issues.push(full);
}

export function pushInvalidType(
  ctx: Ctx,
  data: unknown,
  schemaMap: ZodErrorMap | undefined,
  expected: string,
): void {
  pushIssue(ctx, data, schemaMap, { code: "invalid_type", expected, received: parsedType(data) });
}

/** Stock zod's getParsedType, used for the `received` field of an issue */
/**
 * Stock's `ZodParsedType.object`: a non-null object that is not an array, a Date, a Map, a Set or
 * a promise (`then` and `catch` functions), the same tests in the same order as `getParsedType`.
 * The object, record and discriminated-union skeletons reject everything else as `invalid_type`.
 */
export function isObjectType(v: unknown): v is Record<string, unknown> {
  return (
    v !== null &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    !(typeof (v as any).then === "function" && typeof (v as any).catch === "function") &&
    !(v instanceof Map) &&
    !(v instanceof Set) &&
    !(v instanceof Date)
  );
}

export function parsedType(v: unknown): string {
  switch (typeof v) {
    case "undefined":
      return "undefined";
    case "string":
      return "string";
    case "number":
      return Number.isNaN(v) ? "nan" : "number";
    case "boolean":
      return "boolean";
    case "function":
      return "function";
    case "bigint":
      return "bigint";
    case "symbol":
      return "symbol";
    case "object":
      if (v === null) return "null";
      if (Array.isArray(v)) return "array";
      if (typeof (v as any).then === "function" && typeof (v as any).catch === "function")
        return "promise";
      if (v instanceof Map) return "map";
      if (v instanceof Set) return "set";
      if (v instanceof Date) return "date";
      return "object";
    default:
      return "unknown";
  }
}

/** Stock zod's util.floatSafeRemainder, the `multipleOf` arithmetic (decimal-safe: 0.3 is a multiple of 0.1) */
export function floatSafeRemainder(val: number, step: number): number {
  const valDecCount = (val.toString().split(".")[1] || "").length;
  const stepDecCount = (step.toString().split(".")[1] || "").length;
  const decCount = valDecCount > stepDecCount ? valDecCount : stepDecCount;
  const valInt = Number.parseInt(val.toFixed(decCount).replace(".", ""), 10);
  const stepInt = Number.parseInt(step.toFixed(decCount).replace(".", ""), 10);
  return (valInt % stepInt) / 10 ** decCount;
}

/** Stock zod's util.joinValues: strings quoted, other values as they are */
export function joinValues(values: readonly unknown[], separator = " | "): string {
  return values.map((v) => (typeof v === "string" ? `'${v}'` : v)).join(separator);
}

/**
 * Prototype-pollution-safe key write. `JSON.parse('{"__proto__": …}')` produces an own
 * property named __proto__, so a plain `out[k] = v` would change the prototype instead of writing the property.
 */
export function safeSet(obj: Record<string, unknown>, key: string, value: unknown): void {
  if (key === "__proto__" || key === "constructor" || key === "prototype") {
    Object.defineProperty(obj, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  } else {
    obj[key] = value;
  }
}
