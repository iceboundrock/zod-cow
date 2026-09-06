/**
 * CoW compiler — compiles stock zod's schema tree into specialized validation closures.
 *
 * Differences from stock zod (an interpreter):
 *   1. No more { status, value } wrapper objects / ParseStatus merging — the return value goes straight through;
 *      a failed check pushes its issue and hands the value on (stock's "dirty"), a type mismatch returns FAILED
 *      (stock's "aborted"), and the parse fails at the top whenever ctx.issues is non-empty;
 *   2. No new ParseContext and path array per node — a single mutable ctx + a lazy path (see prefixIssues);
 *   3. No rebuilding of the output tree — CoW: return the original reference when no child value changed, shallow-copy only at the first change point
 *      (path-copying: changing one leaf copies only the single path from it to the root, all sibling subtrees stay shared);
 *   4. shape() / keys / checks / options are resolved once at compile time (stock re-reads them on every parse).
 *
 * Issue construction follows stock's makeIssue: an explicit check message wins, otherwise zod's own error maps run
 * (default map, `z.setErrorMap` override, the schema's create-param map), so messages, params and paths match stock.
 *
 * Compile-time cache: a global WeakMap<schema, validator>, so the same schema instance is compiled only once;
 * the z.lazy getter is resolved lazily on the first parse, which together with "placeholder first, compile later" supports recursive schemas.
 */
import { z, type ZodErrorMap } from "zod";
import {
  type Ctx,
  FAILED,
  floatSafeRemainder,
  type Issue,
  type IssueData,
  type PathSegment,
  type Validator,
  ZcError,
  ZcNotSupportedError,
  parsedType,
  pushInvalidType,
  pushIssue,
  safeSet,
  isObjectType,
} from "./internal.js";
import { CODEGEN_AVAILABLE, genArray, genObject, genTuple } from "./codegen.js";
import { PROBE } from "./probe.js";
import {
  BASE64_REGEX,
  BASE64URL_REGEX,
  CUID2_REGEX,
  CUID_REGEX,
  DATE_REGEX,
  DURATION_REGEX,
  EMAIL_REGEX,
  IPV4_CIDR_REGEX,
  IPV4_REGEX,
  IPV6_CIDR_REGEX,
  IPV6_REGEX,
  JWT_REGEX,
  NANOID_REGEX,
  ULID_REGEX,
  UUID_REGEX,
  datetimeRegex,
  timeRegex,
} from "./regexes.js";

const hop = Object.prototype.hasOwnProperty;

/**
 * Lazy issue paths. A container whose subtree holds no ZodEffects node does not maintain
 * `ctx.path` while it walks its children (no push/pop on the success path): when a child leaves
 * issues behind, the container splices its key into the path of every issue pushed since the call,
 * at the depth of the eager prefix (`ctx.path.length`, constant inside a lazy subtree). Containers
 * with an effect below them stay eager (push/pop), because the effect's `ctx.path` getter and
 * `addIssue({ path })` need the absolute path while the callback runs. Eagerness is closed under
 * ancestors, so the eager containers form a prefix of the tree and every lazy container sits in a
 * complete lazy subtree; the two schemes compose into the same absolute paths as stock zod.
 */
function prefixIssues(ctx: Ctx, from: number, key: PathSegment, to = ctx.issues.length): void {
  const issues = ctx.issues;
  const at = ctx.path.length;
  for (let i = from; i < to; i++) prefixIssue(issues[i]!, at, key);
}

/** Splice one key into an issue's path; a union's nested errors were created at the same depth and follow */
function prefixIssue(issue: Issue, at: number, key: PathSegment): void {
  issue.path.splice(at, 0, key);
  const nested = issue.unionErrors as ZcError[] | undefined;
  if (nested !== undefined) {
    for (const e of nested) for (const ni of e.issues) prefixIssue(ni, at, key);
  }
}

/** Whether the subtree holds a ZodEffects node (preprocess / refinement / transform), the nodes whose callbacks observe `ctx.path` */
function subtreeHasEffect(schema: z.ZodTypeAny, seen = new Set<z.ZodTypeAny>()): boolean {
  if (seen.has(schema)) return false; // back edge of a z.lazy cycle: the rest of the cycle is visited from the query root
  seen.add(schema);
  const def: any = (schema as any)._def;
  switch (def.typeName) {
    case "ZodEffects":
      return true;
    case "ZodObject":
      return Object.values(def.shape() as Record<string, z.ZodTypeAny>).some((c) =>
        subtreeHasEffect(c, seen),
      );
    case "ZodArray":
      return subtreeHasEffect(def.type, seen);
    case "ZodTuple":
      return (def.items as z.ZodTypeAny[]).some((it) => subtreeHasEffect(it, seen));
    case "ZodRecord":
    case "ZodMap":
      return subtreeHasEffect(def.keyType, seen) || subtreeHasEffect(def.valueType, seen);
    case "ZodSet":
      return subtreeHasEffect(def.valueType, seen);
    case "ZodUnion":
    case "ZodDiscriminatedUnion":
      return (def.options as z.ZodTypeAny[]).some((o) => subtreeHasEffect(o, seen));
    case "ZodOptional":
    case "ZodNullable":
    case "ZodDefault":
    case "ZodCatch":
    case "ZodReadonly":
      return subtreeHasEffect(def.innerType, seen);
    case "ZodPipeline":
      return subtreeHasEffect(def.in, seen) || subtreeHasEffect(def.out, seen);
    case "ZodBranded":
      return subtreeHasEffect(def.type, seen);
    case "ZodLazy":
      return subtreeHasEffect(def.getter(), seen);
    default:
      return false;
  }
}

/* ════════════════════════════ ZodString ════════════════════════════ */

/**
 * One string check: pushes its issue and returns the value on failure (stock's dirty status, the
 * remaining checks still run), returns the possibly rewritten value on success (trim etc.).
 */
type StringStep = (v: string, ctx: Ctx) => string;

/** Stock zod's isValidJWT: the regex, then the decoded header must carry `typ` and `alg` (matching `alg` when given) */
function isValidJWT(jwt: string, alg?: string): boolean {
  if (!JWT_REGEX.test(jwt)) return false;
  try {
    const [header] = jwt.split(".");
    if (!header) return false;
    const base64 = header
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(header.length + ((4 - (header.length % 4)) % 4), "=");
    const decoded = JSON.parse(atob(base64));
    if (typeof decoded !== "object" || decoded === null) return false;
    if (!decoded.typ || !decoded.alg) return false;
    if (alg && decoded.alg !== alg) return false;
    return true;
  } catch {
    return false;
  }
}

/** The RegExp behind a string check, for the format kinds that are one regex test (and `.regex()` itself); null otherwise */
function checkRegex(c: any): RegExp | null {
  const kind: string = c.kind;
  switch (kind) {
    case "regex":
      return c.regex;
    case "email":
      return EMAIL_REGEX;
    case "uuid":
      return UUID_REGEX;
    case "cuid":
      return CUID_REGEX;
    case "cuid2":
      return CUID2_REGEX;
    case "ulid":
      return ULID_REGEX;
    case "nanoid":
      return NANOID_REGEX;
    case "duration":
      return DURATION_REGEX;
    case "date":
      return DATE_REGEX;
    case "time":
      return timeRegex(c.precision ?? null);
    case "datetime":
      return datetimeRegex({
        precision: c.precision ?? null,
        offset: !!c.offset,
        local: !!c.local,
      });
    case "base64":
      return BASE64_REGEX;
    case "base64url":
      return BASE64URL_REGEX;
    case "emoji":
      // zod builds it lazily: ^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$ (u flag)
      return /^(\p{Extended_Pictographic}|\p{Emoji_Component})+$/u;
    default:
      return null;
  }
}

/** Format-style string checks: kind → predicate (regexes come from regexes.ts, verbatim from stock) */
function formatStringStep(c: any, em: ZodErrorMap | undefined): StringStep {
  const kind: string = c.kind;
  const message: string | undefined = c.message;
  const re = checkRegex(c);

  if (re !== null) {
    return (v, ctx) => {
      if (!re.test(v)) pushIssue(ctx, v, em, { code: "invalid_string", validation: kind, message });
      return v;
    };
  }

  // Non-regex predicates (identical to stock's predicate functions)
  switch (kind) {
    case "url":
      return (v, ctx) => {
        try {
          new URL(v);
        } catch {
          pushIssue(ctx, v, em, { code: "invalid_string", validation: "url", message });
        }
        return v;
      };
    case "jwt": {
      const alg: string | undefined = c.alg;
      return (v, ctx) => {
        if (!isValidJWT(v, alg))
          pushIssue(ctx, v, em, { code: "invalid_string", validation: "jwt", message });
        return v;
      };
    }
    case "ip": {
      const version: string | undefined = c.version;
      return (v, ctx) => {
        const ok =
          (version === "v4" || !version) && IPV4_REGEX.test(v)
            ? true
            : (version === "v6" || !version) && IPV6_REGEX.test(v);
        if (!ok) pushIssue(ctx, v, em, { code: "invalid_string", validation: "ip", message });
        return v;
      };
    }
    case "cidr": {
      const version: string | undefined = c.version;
      return (v, ctx) => {
        const ok =
          (version === "v4" || !version) && IPV4_CIDR_REGEX.test(v)
            ? true
            : (version === "v6" || !version) && IPV6_CIDR_REGEX.test(v);
        if (!ok) pushIssue(ctx, v, em, { code: "invalid_string", validation: "cidr", message });
        return v;
      };
    }
    default:
      throw new ZcNotSupportedError(`ZodString check kind "${kind}"`);
  }
}

function stringStep(c: any, em: ZodErrorMap | undefined): StringStep {
  const message: string | undefined = c.message;
  switch (c.kind) {
    case "min": {
      const n: number = c.value;
      return (v, ctx) => {
        if (v.length < n)
          pushIssue(ctx, v, em, {
            code: "too_small",
            minimum: n,
            type: "string",
            inclusive: true,
            exact: false,
            message,
          });
        return v;
      };
    }
    case "max": {
      const n: number = c.value;
      return (v, ctx) => {
        if (v.length > n)
          pushIssue(ctx, v, em, {
            code: "too_big",
            maximum: n,
            type: "string",
            inclusive: true,
            exact: false,
            message,
          });
        return v;
      };
    }
    case "length": {
      const n: number = c.value;
      return (v, ctx) => {
        if (v.length > n)
          pushIssue(ctx, v, em, {
            code: "too_big",
            maximum: n,
            type: "string",
            inclusive: true,
            exact: true,
            message,
          });
        else if (v.length < n)
          pushIssue(ctx, v, em, {
            code: "too_small",
            minimum: n,
            type: "string",
            inclusive: true,
            exact: true,
            message,
          });
        return v;
      };
    }
    case "regex": {
      const re: RegExp = c.regex;
      return (v, ctx) => {
        // Same as stock: reset lastIndex so a global/sticky regex starts from 0 on every test
        re.lastIndex = 0;
        if (!re.test(v))
          pushIssue(ctx, v, em, { code: "invalid_string", validation: "regex", message });
        return v;
      };
    }
    case "includes": {
      const p: string = c.value;
      const position: number | undefined = c.position;
      return (v, ctx) => {
        if (!v.includes(p, position))
          pushIssue(ctx, v, em, {
            code: "invalid_string",
            validation: { includes: p, position },
            message,
          });
        return v;
      };
    }
    case "startsWith": {
      const p: string = c.value;
      return (v, ctx) => {
        if (!v.startsWith(p))
          pushIssue(ctx, v, em, { code: "invalid_string", validation: { startsWith: p }, message });
        return v;
      };
    }
    case "endsWith": {
      const p: string = c.value;
      return (v, ctx) => {
        if (!v.endsWith(p))
          pushIssue(ctx, v, em, { code: "invalid_string", validation: { endsWith: p }, message });
        return v;
      };
    }
    case "trim":
      // Transform: returns a new string. '  x ' → 'x' differs in value → the parent marks dirty;
      // 'x' → 'x' is the same value → not dirty (zero-copy). The primitive-type version of "copy-on-demand".
      return (v) => v.trim();
    case "toLowerCase":
      return (v) => v.toLowerCase();
    case "toUpperCase":
      return (v) => v.toUpperCase();
    default:
      // Format checks (email/uuid/datetime/…) — regexes are verbatim from stock
      return formatStringStep(c, em);
  }
}

function makeString(def: any): Validator {
  const em: ZodErrorMap | undefined = def.errorMap;
  const coerce = !!def.coerce;
  const steps: StringStep[] = (def.checks ?? []).map((c: any) => stringStep(c, em));
  const n = steps.length;
  // Specialized closures for the common step counts: no step array loop on the hot path
  if (n === 0) {
    return (data, ctx) => {
      if (coerce) data = String(data);
      if (typeof data !== "string") {
        pushInvalidType(ctx, data, em, "string");
        return FAILED;
      }
      return data;
    };
  }
  if (n === 1) {
    const s0 = steps[0]!;
    return (data, ctx) => {
      if (coerce) data = String(data);
      if (typeof data !== "string") {
        pushInvalidType(ctx, data, em, "string");
        return FAILED;
      }
      return s0(data, ctx);
    };
  }
  if (n === 2) {
    const s0 = steps[0]!;
    const s1 = steps[1]!;
    return (data, ctx) => {
      if (coerce) data = String(data);
      if (typeof data !== "string") {
        pushInvalidType(ctx, data, em, "string");
        return FAILED;
      }
      return s1(s0(data, ctx), ctx);
    };
  }
  return (data, ctx) => {
    if (coerce) data = String(data);
    if (typeof data !== "string") {
      pushInvalidType(ctx, data, em, "string");
      return FAILED;
    }
    let v: string = data;
    for (let i = 0; i < n; i++) v = steps[i]!(v, ctx);
    return v;
  };
}

/* ════════════════════════════ ZodNumber ════════════════════════════ */

/** One number check: pushes its issue on failure (dirty), never rewrites the value */
type NumberStep = (v: number, ctx: Ctx) => void;

function numberStep(c: any, em: ZodErrorMap | undefined): NumberStep {
  const message: string | undefined = c.message;
  switch (c.kind) {
    case "min": {
      const n: number = c.value;
      const inclusive = c.inclusive !== false;
      return (v, ctx) => {
        if (inclusive ? v < n : v <= n)
          pushIssue(ctx, v, em, {
            code: "too_small",
            minimum: n,
            type: "number",
            inclusive,
            exact: false,
            message,
          });
      };
    }
    case "max": {
      const n: number = c.value;
      const inclusive = c.inclusive !== false;
      return (v, ctx) => {
        if (inclusive ? v > n : v >= n)
          pushIssue(ctx, v, em, {
            code: "too_big",
            maximum: n,
            type: "number",
            inclusive,
            exact: false,
            message,
          });
      };
    }
    case "int":
      return (v, ctx) => {
        if (!Number.isInteger(v))
          pushIssue(ctx, v, em, {
            code: "invalid_type",
            expected: "integer",
            received: "float",
            message,
          });
      };
    case "multipleOf": {
      const step: number = c.value;
      return (v, ctx) => {
        if (floatSafeRemainder(v, step) !== 0)
          pushIssue(ctx, v, em, { code: "not_multiple_of", multipleOf: step, message });
      };
    }
    case "finite":
      return (v, ctx) => {
        if (!Number.isFinite(v)) pushIssue(ctx, v, em, { code: "not_finite", message });
      };
    default:
      throw new ZcNotSupportedError(`ZodNumber check kind "${c.kind}"`);
  }
}

function makeNumber(def: any): Validator {
  const em: ZodErrorMap | undefined = def.errorMap;
  const coerce = !!def.coerce;
  const steps: NumberStep[] = (def.checks ?? []).map((c: any) => numberStep(c, em));
  const n = steps.length;
  if (n === 0) {
    return (data, ctx) => {
      if (coerce) data = Number(data);
      // Same as stock: z.number() rejects NaN (received: 'nan')
      if (typeof data !== "number" || Number.isNaN(data)) {
        pushInvalidType(ctx, data, em, "number");
        return FAILED;
      }
      return data;
    };
  }
  if (n === 1) {
    const s0 = steps[0]!;
    return (data, ctx) => {
      if (coerce) data = Number(data);
      if (typeof data !== "number" || Number.isNaN(data)) {
        pushInvalidType(ctx, data, em, "number");
        return FAILED;
      }
      s0(data, ctx);
      return data;
    };
  }
  return (data, ctx) => {
    if (coerce) data = Number(data);
    if (typeof data !== "number" || Number.isNaN(data)) {
      pushInvalidType(ctx, data, em, "number");
      return FAILED;
    }
    for (let i = 0; i < n; i++) steps[i]!(data, ctx);
    return data; // Primitive value: returning it is pass-through
  };
}

/* ════════════════════════════ Leaf nodes ════════════════════════════ */

function makeBigInt(def: any): Validator {
  const em: ZodErrorMap | undefined = def.errorMap;
  const coerce = !!def.coerce;
  const checks: any[] = def.checks ?? [];
  for (const c of checks) {
    if (c.kind !== "min" && c.kind !== "max" && c.kind !== "multipleOf")
      throw new ZcNotSupportedError(`ZodBigInt check kind "${c.kind}"`);
  }
  return (data, ctx) => {
    if (coerce) {
      try {
        data = BigInt(data);
      } catch {
        pushInvalidType(ctx, data, em, "bigint");
        return FAILED;
      }
    }
    if (typeof data !== "bigint") {
      pushInvalidType(ctx, data, em, "bigint");
      return FAILED;
    }
    for (const c of checks) {
      if (c.kind === "min") {
        const inclusive = c.inclusive !== false;
        if (inclusive ? data < c.value : data <= c.value)
          pushIssue(ctx, data, em, {
            code: "too_small",
            type: "bigint",
            minimum: c.value,
            inclusive,
            message: c.message,
          });
      } else if (c.kind === "max") {
        const inclusive = c.inclusive !== false;
        if (inclusive ? data > c.value : data >= c.value)
          pushIssue(ctx, data, em, {
            code: "too_big",
            type: "bigint",
            maximum: c.value,
            inclusive,
            message: c.message,
          });
      } else if (data % c.value !== BigInt(0)) {
        pushIssue(ctx, data, em, {
          code: "not_multiple_of",
          multipleOf: c.value,
          message: c.message,
        });
      }
    }
    return data;
  };
}

function makeDate(def: any): Validator {
  const em: ZodErrorMap | undefined = def.errorMap;
  const coerce = !!def.coerce;
  const checks: any[] = def.checks ?? [];
  for (const c of checks) {
    if (c.kind !== "min" && c.kind !== "max")
      throw new ZcNotSupportedError(`ZodDate check kind "${c.kind}"`);
  }
  return (data, ctx) => {
    if (coerce) data = new Date(data);
    if (!(data instanceof Date)) {
      pushInvalidType(ctx, data, em, "date");
      return FAILED;
    }
    if (Number.isNaN(data.getTime())) {
      pushIssue(ctx, data, em, { code: "invalid_date" });
      return FAILED;
    }
    for (const c of checks) {
      if (c.kind === "min") {
        if (data.getTime() < c.value)
          pushIssue(ctx, data, em, {
            code: "too_small",
            message: c.message,
            inclusive: true,
            exact: false,
            minimum: c.value,
            type: "date",
          });
      } else if (data.getTime() > c.value) {
        pushIssue(ctx, data, em, {
          code: "too_big",
          message: c.message,
          inclusive: true,
          exact: false,
          maximum: c.value,
          type: "date",
        });
      }
    }
    return data;
  };
}

function makeLiteral(def: any): Validator {
  const em: ZodErrorMap | undefined = def.errorMap;
  const value = def.value;
  return (data, ctx) => {
    if (data !== value) {
      pushIssue(ctx, data, em, { code: "invalid_literal", expected: value, received: data });
      return FAILED;
    }
    return data;
  };
}

function makeEnum(def: any): Validator {
  const em: ZodErrorMap | undefined = def.errorMap;
  const values: string[] = def.values;
  const set = new Set<unknown>(values);
  const expected = values.map((v) => `'${v}'`).join(" | ");
  return (data, ctx) => {
    if (typeof data !== "string") {
      pushIssue(ctx, data, em, { code: "invalid_type", expected, received: parsedType(data) });
      return FAILED;
    }
    if (!set.has(data)) {
      pushIssue(ctx, data, em, { code: "invalid_enum_value", received: data, options: values });
      return FAILED;
    }
    return data;
  };
}

function makeNativeEnum(def: any): Validator {
  const em: ZodErrorMap | undefined = def.errorMap;
  const obj = def.values;
  // Same as stock: skip the reverse mapping of numeric enums (keys that are numeric strings)
  const values: (string | number)[] = [];
  for (const k in obj) {
    if (hop.call(obj, k) && Number.isNaN(Number(k))) values.push(obj[k]);
  }
  const set = new Set<unknown>(values);
  const expected = values.map((v) => (typeof v === "string" ? `'${v}'` : v)).join(" | ");
  return (data, ctx) => {
    if (typeof data !== "string" && (typeof data !== "number" || Number.isNaN(data))) {
      pushIssue(ctx, data, em, { code: "invalid_type", expected, received: parsedType(data) });
      return FAILED;
    }
    if (!set.has(data)) {
      pushIssue(ctx, data, em, { code: "invalid_enum_value", received: data, options: values });
      return FAILED;
    }
    return data;
  };
}

/* ════════════════════════════ ZodObject (CoW core) ════════════════════════════ */

/**
 * Whether stock's parse of `undefined` is known, from the schema's structure alone, to succeed
 * with `undefined` and without reaching user code: `optional` short-circuits before its inner
 * schema, `any` / `unknown` / `undefined` / `void` accept the value, `nullable` and `branded`
 * hand it to their inner schema, a union answers with its first option when every option does.
 * Decided structurally, never by running the schema: a compile-time `safeParse(undefined)` would
 * execute the user's callbacks (a preprocess, transform, refine or default function) and freeze
 * their answer into the skeleton, while stock consults them on every parse.
 */
function isUndefStable(s: z.ZodTypeAny, seen = new Set<z.ZodTypeAny>()): boolean {
  if (seen.has(s)) return false;
  seen.add(s);
  const def: any = (s as any)._def;
  switch (def.typeName) {
    case "ZodOptional":
    case "ZodAny":
    case "ZodUnknown":
    case "ZodUndefined":
    case "ZodVoid":
      return true;
    case "ZodLiteral":
      return def.value === undefined;
    case "ZodNullable":
      return isUndefStable(def.innerType, seen);
    case "ZodBranded":
      return isUndefStable(def.type, seen);
    case "ZodUnion":
      return (def.options as z.ZodTypeAny[]).every((o) => isUndefStable(o, seen));
    default:
      return false;
  }
}

function makeObject(def: any): Validator {
  const em: ZodErrorMap | undefined = def.errorMap;
  const mode: "strip" | "strict" | "passthrough" = def.unknownKeys ?? "strip";
  const catchall = def.catchall;
  if (catchall && !(catchall instanceof z.ZodNever)) {
    throw new ZcNotSupportedError(
      "ZodObject with catchall (only the default ZodNever is supported)",
    );
  }

  // Resolve shape / keys / child compilers / undefined-stability once at compile time
  const shape: Record<string, z.ZodTypeAny> = def.shape();
  const keys = Object.keys(shape);
  const n = keys.length;
  const children: Validator[] = new Array(n);
  const undefStable: boolean[] = new Array(n);
  let eager = false;
  for (let i = 0; i < n; i++) {
    const child = shape[keys[i]!]!;
    children[i] = go(child);
    undefStable[i] = isUndefStable(child);
    if (subtreeHasEffect(child)) eager = true;
  }
  // Key → shape index, for the undeclared-key probe below
  const keyIndex = new Map<string, number>();
  for (let i = 0; i < n; i++) keyIndex.set(keys[i]!, i);
  // A declared "__proto__" key is validated but never written (stock's output assembly skips it,
  // and `out["__proto__"] = v` would set the prototype of the copy); an own "__proto__" on the
  // input is dropped from the output on every path (see the generated skeleton in codegen.ts)
  const protoIdx = keys.indexOf("__proto__");
  const dropOwnProto = protoIdx !== -1 || mode === "passthrough";

  // Probe-driven version compatibility. Measured on zod 3.24.1: an absent optional key is not materialized (output {}),
  // and present-undefined is kept — both agree naturally with pass-through semantics, so the branches below usually do not fire.
  const matAbsent =
    mode === "passthrough" ? PROBE.absentOptionalKeptPassthrough : PROBE.absentOptionalKeptStrip;
  const keepPresentUndef =
    mode === "passthrough" ? PROBE.presentUndefKeptPassthrough : PROBE.presentUndefKeptStrip;

  // Generated skeleton (codegen.ts) where `new Function` is available and the probe flags are the
  // measured zod 3.24.1 ones; the closure below is the same algorithm and stays as the fallback
  if (CODEGEN_AVAILABLE && !matAbsent && keepPresentUndef) {
    return genObject({
      keys,
      children: keys.map((k, i) => ({ schema: shape[k]!, validator: children[i]! })),
      undefStable,
      mode,
      eager,
      errorMap: em,
      regexOf: checkRegex,
      prefixIssues,
    });
  }

  // Same algorithm as the generated skeleton: every shape key is read once into `vals` (the
  // output value of the slot once validated), the clean path returns the input by reference and
  // the copy is stock's output assembly from those values (shape order, stock's presence rule,
  // passthrough extras appended by `for...in`), never a spread of the input.
  return (data, ctx): any => {
    if (!isObjectType(data)) {
      pushInvalidType(ctx, data, em, "object");
      return FAILED;
    }

    const vals: any[] = new Array(n);
    let dirty = false;
    let anyFailed = false;

    for (let i = 0; i < n; i++) {
      const k = keys[i]!;
      const inVal = data[k];
      vals[i] = inVal;

      if (inVal === undefined && undefStable[i]) {
        // The child is not run; the presence rule of the assembly below covers the key. Only the
        // flags of another zod version (an absent optional key materialized as undefined, a
        // present undefined dropped) force a copy here.
        if (matAbsent || !keepPresentUndef) {
          if (k in data ? !keepPresentUndef : matAbsent) dirty = true;
        }
        continue;
      }

      let outVal: any;
      if (eager) {
        ctx.path.push(k);
        outVal = children[i]!(inVal, ctx);
        ctx.path.pop();
      } else {
        const before = ctx.issues.length;
        outVal = children[i]!(inVal, ctx);
        if (ctx.issues.length !== before) prefixIssues(ctx, before, k);
      }
      if (outVal === FAILED) {
        // Keep walking the remaining fields after a failure — same as stock, one parse collects every issue
        anyFailed = true;
        continue;
      }
      if (outVal !== inVal) {
        // The first point "forced to change": the copy is assembled once at the end
        dirty = true;
        vals[i] = outVal;
      }
    }
    // An aborted child aborts the object, after the strict probe below has had its say (stock parses
    // every pair, then reports the unrecognized keys, then returns INVALID)
    if (anyFailed && mode !== "strict") return FAILED;
    if (dropOwnProto && hop.call(data, "__proto__")) dirty = true;

    if (mode !== "passthrough") {
      // Undeclared-key probe, stock's own `for...in` (an inherited enumerable key counts as
      // undeclared, as it does for stock). strip only needs to know whether an extra key exists
      // (stops at the first hit); strict collects every extra key for the error. The enumeration
      // order of a plain object usually follows the shape (JSON payloads, literals), so each
      // enumerated key is first compared against the shape key expected at that position (one
      // string compare, no hash) and the index map is consulted only on a mismatch.
      let extras: string[] | null = null;
      let hint = 0;
      for (const k in data) {
        if (k === keys[hint]) {
          hint++;
          continue;
        }
        const j = keyIndex.get(k);
        if (j !== undefined) {
          hint = j + 1;
          continue;
        }
        if (mode === "strict") {
          extras ??= [];
          extras.push(k);
        } else {
          extras = [k];
          break;
        }
      }
      if (extras !== null) {
        // strict: the issue, then the value goes on as dirty (stock keeps parsing, the output holds the shape keys)
        if (mode === "strict")
          pushIssue(ctx, data, em, { code: "unrecognized_keys", keys: extras });
        if (anyFailed) return FAILED;
        dirty = true;
      }
    }
    if (anyFailed) return FAILED;
    if (!dirty) return data; // Pure case: === data, the original reference goes straight through

    // Stock's output assembly (`mergeObjectSync`): the shape keys in shape order, a key written when
    // its value is defined or the key is present on the input (`in`, as stock tests it; the flags
    // of another zod version widen or narrow that), "__proto__" never; then, in passthrough mode,
    // the undeclared keys stock's `for...in` appends, an undefined value dropped as stock drops it
    const out: any = {};
    for (let i = 0; i < n; i++) {
      if (i === protoIdx) continue;
      const k = keys[i]!;
      const v = vals[i];
      if (v !== undefined || (k in data ? keepPresentUndef : matAbsent)) out[k] = v;
    }
    if (mode === "passthrough") {
      for (const k in data) {
        if (keyIndex.has(k) || k === "__proto__") continue;
        const v = data[k];
        if (v !== undefined) out[k] = v;
      }
    }
    return out;
  };
}

/* ════════════════════════════ ZodArray / ZodTuple ════════════════════════════ */

function makeArray(def: any): Validator {
  const em: ZodErrorMap | undefined = def.errorMap;
  const el = go(def.type);
  const eager = subtreeHasEffect(def.type);
  const min: { value: number; message?: string } | null = def.minLength ?? null;
  const max: { value: number; message?: string } | null = def.maxLength ?? null;
  const exact: { value: number; message?: string } | null = def.exactLength ?? null;
  if (CODEGEN_AVAILABLE) {
    return genArray({
      element: { schema: def.type, validator: el },
      eager,
      errorMap: em,
      min,
      max,
      exact,
      regexOf: checkRegex,
      prefixIssues,
    });
  }
  return (data, ctx): any => {
    if (!Array.isArray(data)) {
      pushInvalidType(ctx, data, em, "array");
      return FAILED;
    }
    // Length checks are dirty, not aborting: the elements are still parsed (same order as stock: exact, min, max)
    if (exact !== null && data.length !== exact.value) {
      const tooBig = data.length > exact.value;
      pushIssue(ctx, data, em, {
        code: tooBig ? "too_big" : "too_small",
        minimum: tooBig ? undefined : exact.value,
        maximum: tooBig ? exact.value : undefined,
        type: "array",
        inclusive: true,
        exact: true,
        message: exact.message,
      });
    }
    if (min !== null && data.length < min.value) {
      pushIssue(ctx, data, em, {
        code: "too_small",
        minimum: min.value,
        type: "array",
        inclusive: true,
        exact: false,
        message: min.message,
      });
    }
    if (max !== null && data.length > max.value) {
      pushIssue(ctx, data, em, {
        code: "too_big",
        maximum: max.value,
        type: "array",
        inclusive: true,
        exact: false,
        message: max.message,
      });
    }

    let out: any[] = data;
    let dirty = false;
    let anyFailed = false;
    for (let i = 0; i < data.length; i++) {
      const inVal = data[i];
      let outVal: any;
      if (eager) {
        ctx.path.push(i);
        outVal = el(inVal, ctx);
        ctx.path.pop();
      } else {
        const before = ctx.issues.length;
        outVal = el(inVal, ctx);
        if (ctx.issues.length !== before) prefixIssues(ctx, before, i);
      }
      if (outVal === FAILED) {
        anyFailed = true; // Keep collecting issues from the remaining elements (same as stock)
        continue;
      }
      if (outVal !== inVal && !anyFailed) {
        if (!dirty) {
          dirty = true;
          out = data.slice(); // slice only at the first "forced" change — the other elements stay shared
        }
        out[i] = outVal;
      } else if (inVal === undefined && !anyFailed && !(i in out)) {
        // A hole: stock spreads the input, so its output owns every index (`slice()` keeps holes)
        if (!dirty) {
          dirty = true;
          out = data.slice();
        }
        out[i] = undefined;
      }
    }
    if (anyFailed) return FAILED;
    return out;
  };
}

function makeTuple(def: any): Validator {
  if (def.rest) throw new ZcNotSupportedError("ZodTuple with rest schema");
  const em: ZodErrorMap | undefined = def.errorMap;
  const items: Validator[] = def.items.map(go);
  const n = items.length;
  const eager = (def.items as z.ZodTypeAny[]).some((it) => subtreeHasEffect(it));
  if (CODEGEN_AVAILABLE) {
    return genTuple({
      items: (def.items as z.ZodTypeAny[]).map((it, i) => ({ schema: it, validator: items[i]! })),
      eager,
      errorMap: em,
      regexOf: checkRegex,
      prefixIssues,
    });
  }
  return (data, ctx): any => {
    if (!Array.isArray(data)) {
      pushInvalidType(ctx, data, em, "array");
      return FAILED;
    }
    if (data.length < n) {
      pushIssue(ctx, data, em, {
        code: "too_small",
        minimum: n,
        inclusive: true,
        exact: false,
        type: "array",
      });
      return FAILED;
    }
    let out: any[] = data;
    let dirty = false;
    if (data.length > n) {
      // Dirty, not aborting: the declared slots are still parsed and the output is truncated to them
      pushIssue(ctx, data, em, {
        code: "too_big",
        maximum: n,
        inclusive: true,
        exact: false,
        type: "array",
      });
      out = data.slice(0, n);
      dirty = true;
    }
    let anyFailed = false;
    for (let i = 0; i < n; i++) {
      const inVal = data[i];
      let outVal: any;
      if (eager) {
        ctx.path.push(i);
        outVal = items[i]!(inVal, ctx);
        ctx.path.pop();
      } else {
        const before = ctx.issues.length;
        outVal = items[i]!(inVal, ctx);
        if (ctx.issues.length !== before) prefixIssues(ctx, before, i);
      }
      if (outVal === FAILED) {
        anyFailed = true;
        continue;
      }
      if (outVal !== inVal && !anyFailed) {
        if (!dirty) {
          dirty = true;
          out = data.slice();
        }
        out[i] = outVal;
      } else if (inVal === undefined && !anyFailed && !(i in out)) {
        // A hole is materialized as an own slot, as stock's spread of the input does
        if (!dirty) {
          dirty = true;
          out = data.slice();
        }
        out[i] = undefined;
      }
    }
    if (anyFailed) return FAILED;
    return out;
  };
}

/* ════════════════════════════ ZodRecord / ZodMap / ZodSet ════════════════════════════ */

function makeRecord(def: any): Validator {
  const em: ZodErrorMap | undefined = def.errorMap;
  const keyV = go(def.keyType);
  const valV = go(def.valueType);
  const eager = subtreeHasEffect(def.keyType) || subtreeHasEffect(def.valueType);
  return (data, ctx): any => {
    if (!isObjectType(data)) {
      pushInvalidType(ctx, data, em, "object");
      return FAILED;
    }
    // Stock's loop is `for...in` without an own check, so an inherited enumerable key is parsed
    // and written as an own key of the output; the output is assembled from the parsed pairs in
    // that order (`mergeObjectSync`), a pair whose output key is "__proto__" left out. The clean
    // path returns the input by reference; the first forced change rebuilds the clean prefix in
    // order and every later pair is written after it, so a transformed key that collides with a
    // later entry is overwritten by that entry as in stock.
    let out: any = data;
    let dirty = false;
    let anyFailed = false;
    for (const k in data) {
      const inVal = data[k];
      // Key and value are both parsed (same as stock: a failing key does not skip the value's issues)
      let outKey: any;
      let outVal: any;
      if (eager) {
        ctx.path.push(k);
        outKey = keyV(k, ctx);
        outVal = valV(inVal, ctx);
        ctx.path.pop();
      } else {
        const before = ctx.issues.length;
        outKey = keyV(k, ctx);
        outVal = valV(inVal, ctx);
        if (ctx.issues.length !== before) prefixIssues(ctx, before, k);
      }
      if (outKey === FAILED || outVal === FAILED) {
        anyFailed = true;
        continue;
      }
      if (anyFailed) continue;
      if (!dirty) {
        if (outKey === k && outVal === inVal && k !== "__proto__" && hop.call(data, k)) continue;
        dirty = true;
        out = {};
        for (const k2 in data) {
          if (k2 === k) break;
          out[k2] = data[k2];
        }
      }
      if (outKey !== "__proto__") safeSet(out, outKey, outVal);
    }
    if (anyFailed) return FAILED;
    return out;
  };
}

function makeMap(def: any): Validator {
  const em: ZodErrorMap | undefined = def.errorMap;
  const keyV = go(def.keyType);
  const valV = go(def.valueType);
  const eager = subtreeHasEffect(def.keyType) || subtreeHasEffect(def.valueType);
  return (data, ctx): any => {
    if (!(data instanceof Map)) {
      pushInvalidType(ctx, data, em, "map");
      return FAILED;
    }
    let out: Map<any, any> = data;
    let dirty = false;
    let anyFailed = false;
    let i = 0;
    for (const [k, v] of data) {
      // Issue paths follow stock: [index, "key"] and [index, "value"]; both sides are always parsed
      let outKey: any;
      let outVal: any;
      if (eager) {
        ctx.path.push(i, "key");
        outKey = keyV(k, ctx);
        ctx.path[ctx.path.length - 1] = "value";
        outVal = valV(v, ctx);
        ctx.path.length -= 2;
      } else {
        const before = ctx.issues.length;
        outKey = keyV(k, ctx);
        const mid = ctx.issues.length;
        outVal = valV(v, ctx);
        if (mid !== before) prefixIssues(ctx, before, "key", mid);
        if (ctx.issues.length !== mid) prefixIssues(ctx, mid, "value");
        if (ctx.issues.length !== before) prefixIssues(ctx, before, i);
      }
      i++;
      if (outKey === FAILED || outVal === FAILED) {
        anyFailed = true;
        continue;
      }
      if (anyFailed) continue;
      if (!dirty) {
        if (outKey === k && outVal === v) continue;
        // Stock sets the parsed pairs into a fresh Map in order: rebuild the clean prefix (the
        // first i - 1 entries), then write every later pair, so a transformed key that collides
        // with a later entry is overwritten by it
        dirty = true;
        out = new Map();
        let j = 1;
        for (const [k2, v2] of data) {
          if (j++ === i) break;
          out.set(k2, v2);
        }
      }
      out.set(outKey, outVal);
    }
    if (anyFailed) return FAILED;
    return out;
  };
}

function makeSet(def: any): Validator {
  const em: ZodErrorMap | undefined = def.errorMap;
  const valV = go(def.valueType);
  const eager = subtreeHasEffect(def.valueType);
  const min: { value: number; message?: string } | null = def.minSize ?? null;
  const max: { value: number; message?: string } | null = def.maxSize ?? null;
  return (data, ctx): any => {
    if (!(data instanceof Set)) {
      pushInvalidType(ctx, data, em, "set");
      return FAILED;
    }
    // Size checks are dirty, not aborting: the members are still parsed
    if (min !== null && data.size < min.value) {
      pushIssue(ctx, data, em, {
        code: "too_small",
        minimum: min.value,
        type: "set",
        inclusive: true,
        exact: false,
        message: min.message,
      });
    }
    if (max !== null && data.size > max.value) {
      pushIssue(ctx, data, em, {
        code: "too_big",
        maximum: max.value,
        type: "set",
        inclusive: true,
        exact: false,
        message: max.message,
      });
    }
    let out: Set<any> = data;
    let dirty = false;
    let anyFailed = false;
    let i = 0;
    for (const item of data) {
      // Issue path is the member index, as in stock
      let outVal: any;
      if (eager) {
        ctx.path.push(i);
        outVal = valV(item, ctx);
        ctx.path.pop();
      } else {
        const before = ctx.issues.length;
        outVal = valV(item, ctx);
        if (ctx.issues.length !== before) prefixIssues(ctx, before, i);
      }
      i++;
      if (outVal === FAILED) {
        anyFailed = true;
        continue;
      }
      if (anyFailed) continue;
      if (!dirty) {
        if (outVal === item) continue;
        // Stock adds the parsed members to a fresh Set in order: rebuild the clean prefix, then
        // add every later member, so a transformed member that collides with a later one keeps
        // stock's position and the later member wins
        dirty = true;
        out = new Set();
        let j = 1;
        for (const item2 of data) {
          if (j++ === i) break;
          out.add(item2);
        }
      }
      out.add(outVal);
    }
    if (anyFailed) return FAILED;
    return out;
  };
}

/* ════════════════════════════ Union / DiscriminatedUnion ════════════════════════════ */

/**
 * Per-option provenance reports for a union whose options disagree on whether stock rebuilds
 * (see `stockRebuilds`): the report of the winning option, or `undefined` where the option reports
 * for itself or the union needs no report at all.
 */
function unionReports(options: z.ZodTypeAny[]): (boolean | undefined)[] | null {
  const answers = options.map((o) => stockRebuilds(o));
  if (answers.every((a) => a === true) || answers.every((a) => a === false)) return null;
  return answers.map((a) => (a === null ? undefined : a));
}

function makeUnion(def: any): Validator {
  const em: ZodErrorMap | undefined = def.errorMap;
  const opts: Validator[] = (def.options as z.ZodTypeAny[]).map(go);
  const n = opts.length;
  const reports = unionReports(def.options);
  return (data, ctx): any => {
    const base = ctx.issues.length;
    // Same as stock: the first valid option wins; failing that, the first dirty option (a value with
    // issues) is the result and its issues stay; failing that, invalid_union with every option's issues
    let dirtyValue: any = FAILED;
    let dirtyIssues: Issue[] | null = null;
    let unionIssues: Issue[][] | null = null;
    for (let i = 0; i < n; i++) {
      const r = opts[i]!(data, ctx);
      if (ctx.issues.length === base) {
        if (r !== FAILED) {
          if (reports !== null && reports[i] !== undefined) ctx.rebuilt = reports[i]!;
          return r;
        }
        continue; // an option that aborted without an issue cannot happen; keep looking
      }
      const issues = ctx.issues.splice(base); // Truncate the issues produced by this option
      if (r !== FAILED && dirtyIssues === null) {
        dirtyValue = r;
        dirtyIssues = issues;
      }
      unionIssues ??= [];
      unionIssues.push(issues);
    }
    if (dirtyIssues !== null) {
      for (const iss of dirtyIssues) ctx.issues.push(iss);
      return dirtyValue;
    }
    pushIssue(ctx, data, em, {
      code: "invalid_union",
      unionErrors: (unionIssues ?? []).map((iss) => new ZcError(iss)),
    });
    return FAILED;
  };
}

function makeDiscriminated(def: any): Validator {
  const em: ZodErrorMap | undefined = def.errorMap;
  const disc: string = def.discriminator;
  // Stock resolves every option's discriminator value when the schema is built (`optionsMap`)
  const optionsMap: Map<unknown, z.ZodTypeAny> = def.optionsMap;
  const map = new Map<unknown, Validator>();
  for (const [v, opt] of optionsMap) map.set(v, go(opt));
  const options = [...optionsMap.keys()];
  const reports = unionReports(def.options);
  const reportOf = new Map<unknown, boolean>();
  if (reports !== null) {
    (def.options as z.ZodTypeAny[]).forEach((opt, i) => {
      if (reports[i] === undefined) return;
      for (const [v, o] of optionsMap) if (o === opt) reportOf.set(v, reports[i]!);
    });
  }
  return (data, ctx): any => {
    if (!isObjectType(data)) {
      pushInvalidType(ctx, data, em, "object");
      return FAILED;
    }
    const option = map.get(data[disc]);
    if (option === undefined) {
      pushIssue(ctx, data, em, { code: "invalid_union_discriminator", options, path: [disc] });
      return FAILED;
    }
    const r = option(data, ctx); // The option's result passes through as it is, issues included (same as stock)
    if (reports !== null) {
      const report = reportOf.get(data[disc]);
      if (report !== undefined) ctx.rebuilt = report;
    }
    return r;
  };
}

/* ════════════════════════════ Wrapper nodes ════════════════════════════ */

/**
 * The ctx parameter inside transform/refinement callbacks — one per effect node, reused across
 * calls. Stock builds a fresh one per invocation; here the holder's fields are saved and restored
 * around every callback (`makeEffects`), so a callback that re-enters its own schema (a nested
 * parse through the same compiled parser) still reports to the invocation it belongs to
 */
interface EffectShim {
  readonly path: PathSegment[];
  addIssue(arg: any): void;
}

interface EffectHolder {
  ctx: Ctx | null;
  /** The effect node's input, handed to the error maps as `data` (same as stock) */
  data: unknown;
  /** Set by `addIssue({ fatal: true })`: the refinement aborts instead of going on dirty */
  fatal: boolean;
}

function makeShim(holder: EffectHolder, em: ZodErrorMap | undefined): EffectShim {
  return {
    get path() {
      return holder.ctx ? holder.ctx.path.slice() : [];
    },
    addIssue(arg: any) {
      const ctx = holder.ctx!;
      const issue: IssueData =
        typeof arg === "string" ? { code: "custom", message: arg } : { ...arg };
      if (issue.code === undefined) issue.code = "custom";
      pushIssue(ctx, holder.data, em, issue);
      if (issue.fatal) holder.fatal = true;
    },
  };
}

function makeEffects(def: any): Validator {
  const em: ZodErrorMap | undefined = def.errorMap;
  const inner = go(def.schema);
  const eff = def.effect;
  const holder: EffectHolder = { ctx: null, data: undefined, fatal: false };
  const shim = makeShim(holder, em);
  // One holder serves every invocation of this node, and a callback may re-enter the node (a nested
  // parse through the same schema, direct or through a compiled parser, is valid in stock). An
  // invocation therefore saves the fields of the invocation it interrupts, points the holder at
  // itself for the callback and restores them once the callback returns, throw included; the outer
  // callback's `addIssue`, `fatal` flag and `path` then still reach the outer parse. `fatal` is
  // read from the invocation that finished last, which is always the caller's own: a nested
  // invocation completes inside the outer callback, before the outer `finally` runs
  let fatal = false;
  const call = (
    fn: (v: unknown, c: EffectShim) => unknown,
    arg: unknown,
    data: unknown,
    ctx: Ctx,
  ) => {
    const outerCtx = holder.ctx;
    const outerData = holder.data;
    const outerFatal = holder.fatal;
    holder.ctx = ctx;
    holder.data = data;
    holder.fatal = false;
    try {
      return fn(arg, shim); // May throw (same as stock, propagates upward)
    } finally {
      fatal = holder.fatal;
      holder.ctx = outerCtx;
      holder.data = outerData;
      holder.fatal = outerFatal;
    }
  };

  if (eff.type === "preprocess") {
    const transform = eff.transform;
    return (data, ctx) => {
      const mapped = call(transform, data, data, ctx);
      // Stock's sync parser hands a Promise on to the inner schema as data; this line refuses it
      // (an explicit failure, documented under known limitations) instead of validating a Promise
      if (mapped instanceof Promise) {
        throw new ZcNotSupportedError(
          "async preprocess (the sync compiler only accepts sync data)",
        );
      }
      // Same as stock: a fatal issue from the callback aborts; otherwise the inner schema runs on
      // the mapped value, dirty when the callback left a non-fatal issue (issues from other
      // nodes of the same parse do not matter here)
      if (fatal) return FAILED;
      return inner(mapped, ctx);
    };
  }

  if (eff.type === "transform") {
    const transform = eff.transform;
    return (data, ctx) => {
      const base = ctx.issues.length;
      const r = inner(data, ctx);
      if (r === FAILED) return FAILED;
      if (ctx.issues.length !== base) return r; // dirty: stock does not run the transform
      const t = call(transform, r, data, ctx); // Returns a new value → the parent's reference comparison marks dirty automatically
      // Stock's detector: an actual Promise, not any thenable (an object with a `then` method is
      // an ordinary sync result there and here)
      if (t instanceof Promise) {
        throw new ZcNotSupportedError(
          "async transforms (the sync compiler only accepts sync data)",
        );
      }
      return fatal ? FAILED : t; // a fatal issue from the callback aborts, as in stock
    };
  }

  // refinement: a pure predicate. By contract the callback must not modify the input (the premise of CoW, explained in the README).
  // Same as stock, it also runs on a dirty inner value (a failed check), only an aborted inner skips it.
  const refinement = eff.refinement;
  return (data, ctx) => {
    const r = inner(data, ctx);
    if (r === FAILED) return FAILED;
    const ret = call(refinement, r, data, ctx);
    if (ret instanceof Promise) {
      throw new ZcNotSupportedError("async refinements (the sync compiler only accepts sync data)");
    }
    return fatal ? FAILED : r;
  };
}

function makeDefault(def: any): Validator {
  const inner = go(def.innerType);
  const getDefaultValue: () => unknown = def.defaultValue;
  return (data, ctx) => {
    if (data === undefined) {
      // Same as stock: the default value also runs through the inner validation (an invalid default → validation failure)
      return inner(getDefaultValue(), ctx); // A new value → the parent marks dirty automatically
    }
    return inner(data, ctx);
  };
}

function makeCatch(def: any): Validator {
  const inner = go(def.innerType);
  const catchValue: (p: { error: ZcError; input: unknown }) => unknown = def.catchValue;
  // Provenance for a `readonly` above (see `stockRebuilds`): stock hands the fallback callback the
  // raw input, so a callback returning it gives readonly the input to freeze in place, where the
  // success path gives it the inner schema's output
  const innerRebuilds = stockRebuilds(def.innerType);
  const reports = innerRebuilds !== false;
  return (data, ctx) => {
    const base = ctx.issues.length;
    const r = inner(data, ctx); // A throwing callback propagates, as in stock (no try/catch)
    if (r !== FAILED && ctx.issues.length === base) {
      if (reports && innerRebuilds !== null) ctx.rebuilt = innerRebuilds;
      return r;
    }
    if (reports) ctx.rebuilt = false;
    // Aborted or dirty: the inner issues are dropped (stock parses into a separate context) and
    // handed to the catch callback, which gets the input too
    const issues = ctx.issues.splice(base);
    return catchValue({
      get error() {
        return new ZcError(issues);
      },
      input: data,
    });
  };
}

/**
 * Whether stock zod builds a fresh container for this schema's valid output (object / array /
 * tuple / record / map / set, or a wrapper around one), so that `readonly` freezes a copy there
 * and leaves the caller's input untouched. A pass-through leaf (`any` / `unknown`) returns the
 * input itself in stock and is frozen in place there too; a Date is rebuilt by stock as well.
 *
 * `true`: always rebuilt; `false`: never (the input passes through); `null`: decided by the branch
 * taken at run time, which the deciding node reports through `ctx.rebuilt` (a union whose options
 * disagree, a catch whose fallback may hand back the input, a pipeline of two such nodes).
 *
 * A transform, refinement or preprocess reports its inner schema: `readonly` only consults this
 * when the callback handed back the very reference it received, and stock's callback received the
 * inner schema's output (fresh over a container, the input over a pass-through leaf). A callback
 * returning another reference is frozen in place, as stock freezes what it is handed.
 */
function stockRebuilds(
  schema: z.ZodTypeAny,
  memo = new Map<z.ZodTypeAny, boolean | null>(),
): boolean | null {
  const known = memo.get(schema);
  if (known !== undefined) return known;
  memo.set(schema, true); // a cycle (through z.lazy) always runs through a container
  const answer = stockRebuildsOf((schema as any)._def, memo);
  memo.set(schema, answer);
  return answer;
}

function stockRebuildsOf(def: any, memo: Map<z.ZodTypeAny, boolean | null>): boolean | null {
  switch (def.typeName) {
    case "ZodObject":
    case "ZodArray":
    case "ZodTuple":
    case "ZodRecord":
    case "ZodMap":
    case "ZodSet":
    case "ZodDate": // stock returns `new Date(input.getTime())`
      return true;
    case "ZodUnion":
    case "ZodDiscriminatedUnion": {
      const answers = (def.options as z.ZodTypeAny[]).map((o) => stockRebuilds(o, memo));
      if (answers.every((a) => a === true)) return true;
      if (answers.every((a) => a === false)) return false;
      return null;
    }
    case "ZodEffects":
      return stockRebuilds(def.schema, memo);
    case "ZodCatch":
      // The fallback callback may return the raw input; only a never-rebuilding inner is static
      return stockRebuilds(def.innerType, memo) === false ? false : null;
    case "ZodOptional":
    case "ZodNullable":
    case "ZodDefault":
    case "ZodReadonly":
      return stockRebuilds(def.innerType, memo);
    case "ZodPipeline": {
      // Either side rebuilding gives the `out` side a fresh reference in stock
      const a = stockRebuilds(def.in, memo);
      const b = stockRebuilds(def.out, memo);
      if (a === true || b === true) return true;
      if (a === false && b === false) return false;
      return null;
    }
    case "ZodBranded":
      return stockRebuilds(def.type, memo);
    case "ZodLazy":
      return stockRebuilds(def.getter(), memo);
    default:
      return false;
  }
}

function shallowCopy(v: object): object {
  if (Array.isArray(v)) return v.slice();
  if (v instanceof Date) return new Date(v.getTime());
  if (v instanceof Map) return new Map(v);
  if (v instanceof Set) return new Set(v);
  return { ...v };
}

function makeReadonly(def: any): Validator {
  const inner = go(def.innerType);
  const rebuilds = stockRebuilds(def.innerType);
  return (data, ctx) => {
    const base = ctx.issues.length;
    let r = inner(data, ctx);
    if (r === FAILED) return FAILED;
    if (ctx.issues.length !== base) return r; // dirty: stock does not freeze a dirty value
    if (r !== null && (typeof r === "object" || typeof r === "function")) {
      // Stock freezes the output it built. Where that output would be a fresh container, freeze a
      // copy so the caller's input is not frozen in place (#27); a pass-through leaf is frozen in
      // place, exactly as stock does. When the inner schema decides that per branch (a union, a
      // catch) the deciding node reported it through `ctx.rebuilt`.
      if (r === data && (rebuilds === true || (rebuilds === null && ctx.rebuilt)))
        r = shallowCopy(r);
      Object.freeze(r);
    }
    return r;
  };
}

function makePipe(def: any): Validator {
  const a = go(def.in);
  const b = go(def.out);
  // Both sides deciding provenance at run time (see `stockRebuilds`): a rebuilt `in` output stays
  // fresh through a pass-through `out` branch, so the reports combine as an OR
  const bothReport = stockRebuilds(def.in) === null && stockRebuilds(def.out) === null;
  return (data, ctx) => {
    const base = ctx.issues.length;
    const r = a(data, ctx);
    if (r === FAILED) return FAILED;
    if (ctx.issues.length !== base) return r; // dirty: stock stops before the `out` side
    if (!bothReport) return b(r, ctx); // The dirty mark propagates naturally along the chain
    const inRebuilt = ctx.rebuilt;
    const out = b(r, ctx);
    if (inRebuilt) ctx.rebuilt = true;
    return out;
  };
}

/* ════════════════════════════ Compile cache and dispatcher ════════════════════════════ */

const cache = new WeakMap<z.ZodTypeAny, Validator>();

/**
 * Compilation entry point: schema tree → specialized validation closure.
 * "Placeholder first, replace later" handles z.lazy recursion: the placeholder closure forwards to the real compiler before it is ready.
 */
export function go(schema: z.ZodTypeAny): Validator {
  const hit = cache.get(schema);
  if (hit) return hit;

  let real: Validator | undefined;
  const placeholder: Validator = (data, ctx) => real!(data, ctx);
  cache.set(schema, placeholder);

  const def: any = (schema as any)._def;
  real = build(def);
  cache.set(schema, real);
  return real;
}

function leaf(def: any, expected: string, test: (data: any) => boolean): Validator {
  const em: ZodErrorMap | undefined = def.errorMap;
  return (data, ctx) => {
    if (!test(data)) {
      pushInvalidType(ctx, data, em, expected);
      return FAILED;
    }
    return data;
  };
}

function build(def: any): Validator {
  switch (def.typeName) {
    case "ZodString":
      return makeString(def);
    case "ZodNumber":
      return makeNumber(def);
    case "ZodBoolean": {
      const em: ZodErrorMap | undefined = def.errorMap;
      const coerce = !!def.coerce;
      return (data, ctx) => {
        if (coerce) data = Boolean(data);
        if (typeof data !== "boolean") {
          pushInvalidType(ctx, data, em, "boolean");
          return FAILED;
        }
        return data;
      };
    }
    case "ZodBigInt":
      return makeBigInt(def);
    case "ZodSymbol":
      return leaf(def, "symbol", (d) => typeof d === "symbol");
    case "ZodNull":
      return leaf(def, "null", (d) => d === null);
    case "ZodUndefined":
      return leaf(def, "undefined", (d) => d === undefined);
    case "ZodVoid":
      return leaf(def, "void", (d) => d === undefined);
    case "ZodAny":
    case "ZodUnknown":
      return (data) => data; // Accepts everything, pure pass-through
    case "ZodNever":
      return leaf(def, "never", () => false);
    case "ZodNaN":
      // Note NaN !== NaN is always true → the parent always marks dirty (output is still correct, just one extra copy)
      return leaf(def, "nan", (d) => typeof d === "number" && Number.isNaN(d));
    case "ZodDate":
      return makeDate(def);
    case "ZodLiteral":
      return makeLiteral(def);
    case "ZodEnum":
      return makeEnum(def);
    case "ZodNativeEnum":
      return makeNativeEnum(def);
    case "ZodObject":
      return makeObject(def);
    case "ZodArray":
      return makeArray(def);
    case "ZodTuple":
      return makeTuple(def);
    case "ZodRecord":
      return makeRecord(def);
    case "ZodMap":
      return makeMap(def);
    case "ZodSet":
      return makeSet(def);
    case "ZodUnion":
      return makeUnion(def);
    case "ZodDiscriminatedUnion":
      return makeDiscriminated(def);
    case "ZodEffects":
      return makeEffects(def);
    case "ZodOptional": {
      const inner = go(def.innerType);
      return (data, ctx) => (data === undefined ? data : inner(data, ctx));
    }
    case "ZodNullable": {
      const inner = go(def.innerType);
      return (data, ctx) => (data === null ? data : inner(data, ctx));
    }
    case "ZodDefault":
      return makeDefault(def);
    case "ZodCatch":
      return makeCatch(def);
    case "ZodReadonly":
      return makeReadonly(def);
    case "ZodPipeline":
      return makePipe(def);
    case "ZodLazy": {
      const getter: () => z.ZodTypeAny = def.getter;
      let inner: Validator | null = null;
      return (data, ctx) => {
        if (inner === null) inner = go(getter()); // Resolved on the first parse; the cache hit closes the recursion
        return inner(data, ctx);
      };
    }
    case "ZodBranded":
      return go(def.type);
    default:
      throw new ZcNotSupportedError(String(def.typeName));
  }
}

/* ════════════════════════════ Static purity analysis ════════════════════════════ */

/**
 * Static purity: whether this schema "can never possibly produce a new value".
 * A pure schema's parse always returns the input reference (strip mode assumes the input carries no extra keys).
 * Used for documentation and test assertions, not part of the runtime logic (at runtime the reference comparison is what counts).
 */
export function isStaticPure(schema: z.ZodTypeAny, seen = new Set<z.ZodTypeAny>()): boolean {
  if (seen.has(schema)) return true; // z.lazy cycle: nodes on the cycle count as pure (the caller guarantees their expansion)
  seen.add(schema);
  const def: any = (schema as any)._def;
  if (def.coerce) return false;
  switch (def.typeName) {
    case "ZodString":
      return (def.checks ?? []).every(
        (c: any) => c.kind !== "trim" && c.kind !== "toLowerCase" && c.kind !== "toUpperCase",
      );
    case "ZodNumber":
    case "ZodBoolean":
    case "ZodBigInt":
    case "ZodSymbol":
    case "ZodNull":
    case "ZodUndefined":
    case "ZodVoid":
    case "ZodAny":
    case "ZodUnknown":
    case "ZodNever":
    case "ZodNaN":
    case "ZodDate":
    case "ZodLiteral":
    case "ZodEnum":
    case "ZodNativeEnum":
      return true;
    case "ZodObject":
      // strip counts as pure: it copies only when the input really has extra keys (at runtime the reference comparison is what counts)
      return Object.values(def.shape() as Record<string, z.ZodTypeAny>).every((c) =>
        isStaticPure(c, seen),
      );
    case "ZodArray":
      return isStaticPure(def.type, seen);
    case "ZodTuple":
      return def.items.every((it: z.ZodTypeAny) => isStaticPure(it, seen));
    case "ZodRecord":
      return isStaticPure(def.keyType, seen) && isStaticPure(def.valueType, seen);
    case "ZodMap":
      return isStaticPure(def.keyType, seen) && isStaticPure(def.valueType, seen);
    case "ZodSet":
      return isStaticPure(def.valueType, seen);
    case "ZodUnion":
      return def.options.every((o: z.ZodTypeAny) => isStaticPure(o, seen));
    case "ZodDiscriminatedUnion":
      return def.options.every((o: z.ZodTypeAny) => isStaticPure(o, seen));
    case "ZodEffects":
      return def.effect.type === "refinement" && isStaticPure(def.schema, seen);
    case "ZodOptional":
    case "ZodNullable":
      return isStaticPure(def.innerType, seen);
    case "ZodReadonly":
      // Frozen copy for containers (#27): only a pass-through leaf keeps the reference. A `null`
      // answer (the branch taken decides at run time, see `stockRebuilds`) may rebuild, so it is
      // not pure either
      return stockRebuilds(def.innerType) === false && isStaticPure(def.innerType, seen);
    case "ZodPipeline":
      return isStaticPure(def.in, seen) && isStaticPure(def.out, seen);
    case "ZodBranded":
      return isStaticPure(def.type, seen);
    case "ZodLazy":
      return isStaticPure(def.getter(), seen);
    default:
      return false; // Default/Catch/transform/preprocess/Pipe etc.: may produce a new value
  }
}
