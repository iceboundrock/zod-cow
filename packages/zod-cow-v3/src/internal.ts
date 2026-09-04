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
 */

export const FAILED: unique symbol = Symbol("zc.FAILED");

export type PathSegment = string | number;

export interface Issue {
  code: string;
  path: PathSegment[];
  message: string;
  expected?: string;
  received?: string;
  /** For unrecognized_keys only */
  keys?: string[];
  /** Extra fields (minimum / maximum / validation / multipleOf …), aligned with stock zod's issue params */
  [param: string]: unknown;
}

export interface Ctx {
  issues: Issue[];
  /**
   * Lazy path: one mutable array is reused for the whole parse, pushed/popped on entering and leaving a child,
   * and slice() only materializes a snapshot when an issue is actually produced.
   * stock zod builds a new path array per node — one of the sources of its per-node allocation.
   */
  path: PathSegment[];
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

export function pushIssue(ctx: Ctx, code: string, message: string, extra?: Partial<Issue>): void {
  ctx.issues.push({ code, path: ctx.path.slice(), message, ...extra });
}

/** Append an issue at an explicit path (e.g. the discriminator key of a discriminated union) */
export function pushIssueAt(
  ctx: Ctx,
  path: PathSegment[],
  code: string,
  message: string,
  extra?: Partial<Issue>,
): void {
  ctx.issues.push({ code, path: path.slice(), message, ...extra });
}

export function pushInvalidType(ctx: Ctx, expected: string, received: string): void {
  pushIssue(ctx, "invalid_type", `Expected ${expected}, received ${received}`, {
    expected,
    received,
  });
}

/**
 * An approximation of stock zod's getParsedType — used only for the received field of an issue.
 * Uncovered types always fall back to 'object' / typeof, which does not affect the pass/fail decision.
 */
export function parsedType(v: unknown): string {
  if (v === null) return "null";
  const t = typeof v;
  if (t === "object") {
    if (Array.isArray(v)) return "array";
    if (v instanceof Map) return "map";
    if (v instanceof Set) return "set";
    if (v instanceof Date) return "date";
    return "object";
  }
  if (t === "number") return Number.isNaN(v) ? "nan" : "number";
  return t;
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

/** Zero-allocation check for whether an object has own keys outside the shape (used by strip/strict) */
export function findExtraKey(data: object, keySet: Set<string>): string | null {
  for (const k in data) {
    if (Object.hasOwn(data, k) && !keySet.has(k)) return k;
  }
  return null;
}

export function allExtraKeys(data: object, keySet: Set<string>): string[] {
  const out: string[] = [];
  for (const k in data) {
    if (Object.hasOwn(data, k) && !keySet.has(k)) out.push(k);
  }
  return out;
}
