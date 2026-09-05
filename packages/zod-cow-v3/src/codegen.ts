/**
 * Generated container skeletons (object / array / tuple).
 *
 * The closure-tree skeletons in compile.ts share one piece of compiled code across every schema
 * instance (every object validator is the same closure literal), so V8 sees one type-feedback
 * vector for all of them: the child call site `children[i](inVal, ctx)` is megamorphic, `data[k]`
 * is a keyed load and nothing can be inlined. A skeleton generated per schema with `new Function`
 * gets its own code and feedback: `data.id` is a named load, `c3(v, ctx)` is a monomorphic call,
 * and a leaf whose acceptance is a pure predicate (`typeof v === "string"`, a length bound, a
 * format regex, an enum set …) is tested inline and only handed to its closure when the test
 * fails, so the closure produces the issue exactly as before. The generated code follows the
 * closure skeleton line by line (same CoW copy points, same lazy / eager path handling, same strip
 * and strict probes, same abort / dirty semantics); compile.ts keeps the closure skeletons as the
 * fallback where `new Function` is unavailable (a CSP without `unsafe-eval`) and for the probe
 * flags the template does not specialize.
 *
 * `ZC_V3_CODEGEN=0` in the environment disables the generator so the closure skeletons can be run
 * through the same tests.
 */
import type { z, ZodErrorMap } from "zod";
import { type Ctx, FAILED, pushInvalidType, pushIssue, type Validator } from "./internal.js";

/** Whether `new Function` is available (false under a CSP without `unsafe-eval`) and not switched off */
export const CODEGEN_AVAILABLE: boolean = (() => {
  if (process.env.ZC_V3_CODEGEN === "0") return false;
  try {
    return new Function("return 1")() === 1;
  } catch {
    return false;
  }
})();

const hop = Object.prototype.hasOwnProperty;

/** Compile-time environment of one generated function: named constants handed in as parameters */
class Gen {
  readonly names: string[] = [];
  readonly values: unknown[] = [];
  private seq = 0;
  /** Register a constant and return the parameter name that holds it inside the generated code */
  hoist(value: unknown, hint = "k"): string {
    const name = `${hint}${this.seq++}`;
    this.names.push(name);
    this.values.push(value);
    return name;
  }
}

/**
 * Inline acceptance predicate of a leaf schema: an expression over `V` that is true exactly when
 * the leaf's closure would return `V` itself with no issue (a pure check, no rewrite). `null` when
 * the leaf cannot be expressed that way (transforms, coercion, multipleOf, effects, containers …).
 */
export function inlinePredicate(
  schema: z.ZodTypeAny,
  g: Gen,
  V: string,
  regexOf: (check: any) => RegExp | null,
): string | null {
  const def: any = (schema as any)._def;
  if (def.coerce) return null;
  switch (def.typeName) {
    case "ZodString": {
      const parts = [`typeof ${V} === "string"`];
      for (const c of def.checks ?? []) {
        switch (c.kind) {
          case "min":
            parts.push(`${V}.length >= ${Number(c.value)}`);
            break;
          case "max":
            parts.push(`${V}.length <= ${Number(c.value)}`);
            break;
          case "length":
            parts.push(`${V}.length === ${Number(c.value)}`);
            break;
          case "startsWith":
            parts.push(`${V}.startsWith(${g.hoist(c.value, "s")})`);
            break;
          case "endsWith":
            parts.push(`${V}.endsWith(${g.hoist(c.value, "s")})`);
            break;
          case "includes":
            parts.push(
              `${V}.includes(${g.hoist(c.value, "s")}${c.position === undefined ? "" : `, ${Number(c.position)}`})`,
            );
            break;
          default: {
            // Format checks and `.regex()`: the same RegExp the closure step tests. A global or
            // sticky regex carries state in lastIndex and every other kind (trim, url, ip, jwt …)
            // stays with the closure call
            const re = regexOf(c);
            if (re === null || re.global || re.sticky) return null;
            parts.push(`${g.hoist(re, "re")}.test(${V})`);
          }
        }
      }
      return parts.join(" && ");
    }
    case "ZodNumber": {
      const parts = [`typeof ${V} === "number"`, `!Number.isNaN(${V})`];
      for (const c of def.checks ?? []) {
        switch (c.kind) {
          case "int":
            parts.push(`Number.isInteger(${V})`);
            break;
          case "finite":
            parts.push(`Number.isFinite(${V})`);
            break;
          case "min":
            parts.push(`${V} ${c.inclusive === false ? ">" : ">="} ${Number(c.value)}`);
            break;
          case "max":
            parts.push(`${V} ${c.inclusive === false ? "<" : "<="} ${Number(c.value)}`);
            break;
          default:
            return null;
        }
      }
      return parts.join(" && ");
    }
    case "ZodBoolean":
      return `typeof ${V} === "boolean"`;
    case "ZodBigInt":
      return (def.checks ?? []).length === 0 ? `typeof ${V} === "bigint"` : null;
    case "ZodNull":
      return `${V} === null`;
    case "ZodUndefined":
    case "ZodVoid":
      return `${V} === undefined`;
    case "ZodAny":
    case "ZodUnknown":
      return "true";
    case "ZodLiteral":
      return `${V} === ${g.hoist(def.value, "lit")}`;
    case "ZodEnum":
      return `(typeof ${V} === "string" && ${g.hoist(new Set(def.values), "set")}.has(${V}))`;
    case "ZodDate":
      return (def.checks ?? []).length === 0
        ? `(${V} instanceof Date && !Number.isNaN(${V}.getTime()))`
        : null;
    case "ZodOptional": {
      const inner = inlinePredicate(def.innerType, g, V, regexOf);
      return inner === null ? null : `(${V} === undefined || ${inner})`;
    }
    case "ZodNullable": {
      const inner = inlinePredicate(def.innerType, g, V, regexOf);
      return inner === null ? null : `(${V} === null || ${inner})`;
    }
    case "ZodBranded":
      return inlinePredicate(def.type, g, V, regexOf);
    default:
      return null;
  }
}

export interface ChildSpec {
  schema: z.ZodTypeAny;
  validator: Validator;
}

export interface ObjectSpec {
  keys: string[];
  children: ChildSpec[];
  undefStable: boolean[];
  mode: "strip" | "strict" | "passthrough";
  eager: boolean;
  errorMap: ZodErrorMap | undefined;
  /** Optional predicate builder for leaves with format regexes (needs compile.ts's regex table) */
  regexOf: (check: any) => RegExp | null;
  prefixIssues: (ctx: Ctx, from: number, key: string | number, to?: number) => void;
}

const lit = (s: string): string => JSON.stringify(s);

/**
 * One child slot: test the inline predicate when there is one, otherwise call the closure; on a
 * call, prefix the issues it left (lazy) or bracket it with push/pop (eager), then the CoW
 * bookkeeping. `access` is the expression that reads the input value, `key` the path segment
 * expression and `assign` the statement that writes a changed value into the copy.
 */
function childBlock(
  g: Gen,
  child: ChildSpec,
  spec: { eager: boolean; regexOf: (check: any) => RegExp | null },
  access: string,
  keyExpr: string,
  copyExpr: string,
  assign: (outVal: string) => string,
  guardUndefined: boolean,
): string {
  const c = g.hoist(child.validator, "c");
  const pred = inlinePredicate(child.schema, g, "inVal", spec.regexOf);
  const call = spec.eager
    ? `ctx.path.push(${keyExpr}); const outVal = ${c}(inVal, ctx); ctx.path.pop();`
    : `const before = ctx.issues.length; const outVal = ${c}(inVal, ctx); if (ctx.issues.length !== before) prefixIssues(ctx, before, ${keyExpr});`;
  const body = `${call}
      if (outVal === FAILED) anyFailed = true;
      else if (outVal !== inVal && !anyFailed) { if (!dirty) { dirty = true; out = ${copyExpr}; } ${assign("outVal")} }`;
  const guarded = pred === null ? body : `if (!(${pred})) { ${body} }`;
  return `{ const inVal = ${access};
    ${guardUndefined ? `if (inVal !== undefined) { ${guarded} }` : guarded} }`;
}

/** Generated object skeleton (the closure `makeObject` in compile.ts, specialized per shape) */
export function genObject(spec: ObjectSpec): Validator {
  const g = new Gen();
  const em = g.hoist(spec.errorMap, "em");
  const n = spec.keys.length;
  const slots = spec.keys.map((k, i) =>
    childBlock(
      g,
      spec.children[i]!,
      spec,
      `data[${lit(k)}]`,
      lit(k),
      "{ ...data }",
      (outVal) => `out[${lit(k)}] = ${outVal};`,
      spec.undefStable[i]!,
    ),
  );
  const keysName = g.hoist(spec.keys, "keys");
  // Undeclared-key probe: position hint, then the inline comparison chain (a Map above 16 keys)
  const knownTest =
    n <= 16
      ? spec.keys.map((k) => `k === ${lit(k)}`).join(" || ")
      : `${g.hoist(new Map(spec.keys.map((k, i) => [k, i])), "idx")}.has(k)`;
  const probe =
    spec.mode === "passthrough"
      ? ""
      : `let extras = null; let hint = 0;
    for (const k in data) {
      if (k === ${keysName}[hint]) { hint++; continue; }
      if (${knownTest || "false"}) continue;
      if (!hop.call(data, k)) continue;
      ${spec.mode === "strict" ? "(extras ??= []).push(k);" : "extras = [k]; break;"}
    }
    if (extras !== null) {
      ${spec.mode === "strict" ? `pushIssue(ctx, data, ${em}, { code: "unrecognized_keys", keys: extras }); if (anyFailed) return FAILED;` : ""}
      const src = out; out = {};
      ${spec.keys.map((k) => `if (src[${lit(k)}] !== undefined || hop.call(data, ${lit(k)})) out[${lit(k)}] = src[${lit(k)}];`).join("\n      ")}
      dirty = true;
    }`;
  const src = `return function generatedObject(data, ctx) {
    if (data === null || typeof data !== "object" || Array.isArray(data)) { pushInvalidType(ctx, data, ${em}, "object"); return FAILED; }
    let out = data, dirty = false, anyFailed = false;
    ${slots.join("\n    ")}
    ${spec.mode === "strict" ? "" : "if (anyFailed) return FAILED;"}
    ${probe}
    ${spec.mode === "strict" ? "if (anyFailed) return FAILED;" : ""}
    return out;
  };`;
  return build(g, spec.prefixIssues, src);
}

export interface ArraySpec {
  element: ChildSpec;
  eager: boolean;
  errorMap: ZodErrorMap | undefined;
  min: { value: number; message?: string } | null;
  max: { value: number; message?: string } | null;
  exact: { value: number; message?: string } | null;
  regexOf: (check: any) => RegExp | null;
  prefixIssues: (ctx: Ctx, from: number, key: string | number, to?: number) => void;
}

/** Generated array skeleton (the closure `makeArray` in compile.ts) */
export function genArray(spec: ArraySpec): Validator {
  const g = new Gen();
  const em = g.hoist(spec.errorMap, "em");
  const checks: string[] = [];
  if (spec.exact !== null) {
    const v = spec.exact.value;
    const m = g.hoist(spec.exact.message, "msg");
    checks.push(
      `if (data.length !== ${v}) { const tooBig = data.length > ${v}; pushIssue(ctx, data, ${em}, { code: tooBig ? "too_big" : "too_small", minimum: tooBig ? undefined : ${v}, maximum: tooBig ? ${v} : undefined, type: "array", inclusive: true, exact: true, message: ${m} }); }`,
    );
  }
  if (spec.min !== null) {
    const m = g.hoist(spec.min.message, "msg");
    checks.push(
      `if (data.length < ${spec.min.value}) pushIssue(ctx, data, ${em}, { code: "too_small", minimum: ${spec.min.value}, type: "array", inclusive: true, exact: false, message: ${m} });`,
    );
  }
  if (spec.max !== null) {
    const m = g.hoist(spec.max.message, "msg");
    checks.push(
      `if (data.length > ${spec.max.value}) pushIssue(ctx, data, ${em}, { code: "too_big", maximum: ${spec.max.value}, type: "array", inclusive: true, exact: false, message: ${m} });`,
    );
  }
  const slot = childBlock(
    g,
    spec.element,
    spec,
    "data[i]",
    "i",
    "data.slice()",
    (outVal) => `out[i] = ${outVal};`,
    false,
  );
  const src = `return function generatedArray(data, ctx) {
    if (!Array.isArray(data)) { pushInvalidType(ctx, data, ${em}, "array"); return FAILED; }
    ${checks.join("\n    ")}
    let out = data, dirty = false, anyFailed = false;
    for (let i = 0; i < data.length; i++) ${slot}
    if (anyFailed) return FAILED;
    return out;
  };`;
  return build(g, spec.prefixIssues, src);
}

export interface TupleSpec {
  items: ChildSpec[];
  eager: boolean;
  errorMap: ZodErrorMap | undefined;
  regexOf: (check: any) => RegExp | null;
  prefixIssues: (ctx: Ctx, from: number, key: string | number, to?: number) => void;
}

/** Generated tuple skeleton (the closure `makeTuple` in compile.ts), one unrolled block per slot */
export function genTuple(spec: TupleSpec): Validator {
  const g = new Gen();
  const em = g.hoist(spec.errorMap, "em");
  const n = spec.items.length;
  const slots = spec.items.map((item, i) =>
    childBlock(
      g,
      item,
      spec,
      `data[${i}]`,
      String(i),
      "data.slice()",
      (outVal) => `out[${i}] = ${outVal};`,
      false,
    ),
  );
  const src = `return function generatedTuple(data, ctx) {
    if (!Array.isArray(data)) { pushInvalidType(ctx, data, ${em}, "array"); return FAILED; }
    if (data.length < ${n}) { pushIssue(ctx, data, ${em}, { code: "too_small", minimum: ${n}, inclusive: true, exact: false, type: "array" }); return FAILED; }
    let out = data, dirty = false, anyFailed = false;
    if (data.length > ${n}) { pushIssue(ctx, data, ${em}, { code: "too_big", maximum: ${n}, inclusive: true, exact: false, type: "array" }); out = data.slice(0, ${n}); dirty = true; }
    ${slots.join("\n    ")}
    if (anyFailed) return FAILED;
    return out;
  };`;
  return build(g, spec.prefixIssues, src);
}

function build(
  g: Gen,
  prefixIssues: (ctx: Ctx, from: number, key: string | number, to?: number) => void,
  src: string,
): Validator {
  const factory = new Function(
    "FAILED",
    "hop",
    "pushIssue",
    "pushInvalidType",
    "prefixIssues",
    ...g.names,
    src,
  );
  return factory(FAILED, hop, pushIssue, pushInvalidType, prefixIssues, ...g.values) as Validator;
}
