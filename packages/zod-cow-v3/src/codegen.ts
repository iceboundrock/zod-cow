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
import {
  type Ctx,
  FAILED,
  isObjectType,
  pushInvalidType,
  pushIssue,
  stockSpread,
  type Validator,
} from "./internal.js";

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
      // In stock's rebuild mode (`ctx.force`, below a readonly or a fired default) the leaf closure
      // returns a copy, so the inline test hands the value to it there
      return (def.checks ?? []).length === 0
        ? `(!ctx.force && ${V} instanceof Date && !Number.isNaN(${V}.getTime()))`
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
 * The closure call of one child slot: `outVal` receives the closure's result for `inVar`; the
 * issues it left are prefixed lazily with the key, or the call is bracketed by push/pop (eager).
 */
function childCall(
  g: Gen,
  child: ChildSpec,
  eager: boolean,
  keyExpr: string,
  inVar: string,
): string {
  const c = g.hoist(child.validator, "c");
  return eager
    ? `ctx.path.push(${keyExpr}); const outVal = ${c}(${inVar}, ctx); ctx.path.pop();`
    : `const before = ctx.issues.length; const outVal = ${c}(${inVar}, ctx); if (ctx.issues.length !== before) prefixIssues(ctx, before, ${keyExpr});`;
}

/**
 * Whether the inline predicate of a leaf can be true for `undefined`. A hole reads as undefined and
 * is parsed as such, so a slot whose predicate rejects undefined needs no hole test on its
 * predicate path (the test costs a compare per element on the clean path).
 */
function predicateAcceptsUndefined(schema: z.ZodTypeAny): boolean {
  const def: any = (schema as any)._def;
  switch (def.typeName) {
    case "ZodOptional":
    case "ZodUndefined":
    case "ZodVoid":
    case "ZodAny":
    case "ZodUnknown":
      return true;
    case "ZodNullable":
      return predicateAcceptsUndefined(def.innerType);
    case "ZodBranded":
      return predicateAcceptsUndefined(def.type);
    case "ZodLiteral":
      return def.value === undefined;
    default:
      return false;
  }
}

/**
 * One slot of an array or tuple: `inVal` holds the value read. When the leaf has an inline
 * predicate, `onPass` runs when it holds (the value is then the output) and the closure runs only
 * when it fails; `onResult` runs after the closure with `outVal` holding its result (a value or
 * FAILED).
 */
function slotBlock(
  g: Gen,
  child: ChildSpec,
  spec: { eager: boolean; regexOf: (check: any) => RegExp | null },
  keyExpr: string,
  onPass: (holeTest: boolean) => string,
  onResult: string,
): string {
  const pred = inlinePredicate(child.schema, g, "inVal", spec.regexOf);
  const call = `${childCall(g, child, spec.eager, keyExpr, "inVal")} ${onResult}`;
  if (pred === null) return call;
  const pass = onPass(predicateAcceptsUndefined(child.schema));
  return pass === "" ? `if (!(${pred})) { ${call} }` : `if (${pred}) { ${pass} } else { ${call} }`;
}

/**
 * Generated object skeleton (the closure `makeObject` in compile.ts, specialized per shape).
 *
 * Every shape key is read once into a local (`v0`, `v1`, …) that ends up holding the output value
 * of the slot; the clean path returns the input by reference, and the copy is stock's own output
 * assembly from those locals: the shape keys in shape order under stock's presence rule
 * (`value !== undefined || key in input`), never a spread of the input. So the copy holds a
 * declared key the input defines as non-enumerable, drops undeclared own symbol keys, reads a
 * getter once and, in passthrough mode, appends the undeclared keys the way stock's `for...in`
 * does (inherited enumerable keys included, an `undefined` value dropped). The strip / strict
 * probe is stock's `for...in` as well, so an inherited enumerable key counts as undeclared. In
 * stock's rebuild mode (`ctx.force`, below a readonly or a fired default) the skeleton starts out
 * dirty and always takes that assembly. The clean path runs no own-symbol probe: an undeclared own
 * symbol key survives it by reference where stock's assembly drops it, a documented divergence of
 * this line (#65; `Object.getOwnPropertySymbols` costs about 40 ns per object, the whole clean
 * cost of a small object, and a symbol key cannot come from a serialized input).
 */
export function genObject(spec: ObjectSpec): Validator {
  const g = new Gen();
  const em = g.hoist(spec.errorMap, "em");
  const n = spec.keys.length;
  // A declared "__proto__" key is validated like any other but never written: stock's output
  // assembly skips that key (`key.value !== "__proto__"` in `mergeObjectSync`), and writing it
  // through `out["__proto__"] = v` would set the prototype of the copy instead of a property.
  // An own "__proto__" on the input (`JSON.parse`) is therefore dropped from the output on every
  // path; strip and strict mode drop an undeclared one through their key probe, passthrough mode
  // and a declared one need the explicit copy below.
  const protoIdx = spec.keys.indexOf("__proto__");
  const slots = spec.keys.map((k, i) => {
    const V = `v${i}`;
    const pred = inlinePredicate(spec.children[i]!.schema, g, V, spec.regexOf);
    const body = `${childCall(g, spec.children[i]!, spec.eager, lit(k), V)}
      if (outVal === FAILED) anyFailed = true;
      else if (outVal !== ${V}) { dirty = true; ${V} = outVal; }`;
    const guarded = pred === null ? body : `if (!(${pred})) { ${body} }`;
    return `${V} = data[${lit(k)}];
    ${spec.undefStable[i] ? `if (${V} !== undefined) { ${guarded} }` : `{ ${guarded} }`}`;
  });
  const dropOwnProto =
    protoIdx !== -1 || spec.mode === "passthrough"
      ? `if (hop.call(data, "__proto__")) dirty = true;`
      : "";
  const keysName = g.hoist(spec.keys, "keys");
  // Undeclared-key test: the inline comparison chain (a Map above 16 keys)
  const knownTest =
    n <= 16
      ? spec.keys.map((k) => `k === ${lit(k)}`).join(" || ") || "false"
      : `${g.hoist(new Map(spec.keys.map((k, i) => [k, i])), "idx")}.has(k)`;
  // Strip / strict probe with a position hint: each enumerated key is first compared against the
  // shape key expected at that position, the test above runs only on a mismatch
  const probe =
    spec.mode === "passthrough"
      ? ""
      : `let extras = null; let hint = 0;
    for (const k in data) {
      if (k === ${keysName}[hint]) { hint++; continue; }
      if (${knownTest}) continue;
      ${spec.mode === "strict" ? "(extras ??= []).push(k);" : "extras = [k]; break;"}
    }
    if (extras !== null) {
      ${spec.mode === "strict" ? `pushIssue(ctx, data, ${em}, { code: "unrecognized_keys", keys: extras }); if (anyFailed) return FAILED;` : ""}
      dirty = true;
    }`;
  const assembly = spec.keys
    .map((k, i) =>
      i === protoIdx ? "" : `if (v${i} !== undefined || ${lit(k)} in data) out[${lit(k)}] = v${i};`,
    )
    .filter((s) => s !== "");
  const extrasAppend =
    spec.mode === "passthrough"
      ? `for (const k in data) { if (${knownTest} || k === "__proto__") continue; const v = data[k]; if (v !== undefined) out[k] = v; }`
      : "";
  const src = `return function generatedObject(data, ctx) {
    if (!isObjectType(data)) { pushInvalidType(ctx, data, ${em}, "object"); return FAILED; }
    let dirty = ctx.force, anyFailed = false;
    ${n === 0 ? "" : `let ${spec.keys.map((_, i) => `v${i}`).join(", ")};`}
    ${slots.join("\n    ")}
    ${spec.mode === "strict" ? "" : "if (anyFailed) return FAILED;"}
    ${dropOwnProto}
    ${probe}
    ${spec.mode === "strict" ? "if (anyFailed) return FAILED;" : ""}
    if (!dirty) return data;
    const out = {};
    ${assembly.join("\n    ")}
    ${extrasAppend}
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

/**
 * Generated array skeleton (the closure `makeArray` in compile.ts).
 *
 * The capture is stock's own: after the length checks, `stockSpread` evaluates `[...ctx.data]` as
 * `ZodArray._parse` does, so every read the capture makes on the input, every piece of user code
 * it runs, every intrinsic it consults and every engine error it throws are stock's by identity,
 * and every element is validated from the copy, so the validation result is stock's for every
 * input (#116). The copy is the output when an element's result differs from what the capture
 * read, when an element reads as `undefined` (a hole, which stock's spread turns into an own
 * `undefined` slot, or an explicit `undefined`, which the skeleton cannot tell from a hole without
 * a `has` stock never performs, #117) or in stock's rebuild mode (`ctx.force`); each result is
 * written into it, as stock's `mergeArray` collects the results into a fresh array. Otherwise the
 * input is returned by reference, without any read to prove that it still holds what the capture
 * yielded (that proof would be reads stock does not make, the rule of #115), so an input whose
 * capture differs from its indexed contents (an own `Symbol.iterator` or a replaced prototype
 * iterator yielding other values, a Proxy answering another length, an accessor that shrinks the
 * input or rewrites an earlier index while it is read) comes back as itself where stock returns
 * the capture: the documented alias rule of the clean path. Every element is read once on every
 * path, and the skeleton makes no read of the input of its own.
 */
export function genArray(spec: ArraySpec): Validator {
  const g = new Gen();
  const em = g.hoist(spec.errorMap, "em");
  const spread = g.hoist(stockSpread, "stockSpread");
  const checks: string[] = [];
  if (spec.exact !== null) {
    const v = spec.exact.value;
    const m = g.hoist(spec.exact.message, "msg");
    checks.push(
      // Stock's two reads of the length, in its order (`>` then `<`), so a Proxy sees stock's log
      `{ const tooBig = data.length > ${v}; const tooSmall = data.length < ${v}; if (tooBig || tooSmall) pushIssue(ctx, data, ${em}, { code: tooBig ? "too_big" : "too_small", minimum: tooSmall ? ${v} : undefined, maximum: tooBig ? ${v} : undefined, type: "array", inclusive: true, exact: true, message: ${m} }); }`,
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
  // A changed result is written into the copy and makes it the output; an element that reads as
  // `undefined` and comes back unchanged makes it the output too, hole or explicit `undefined`
  // alike (#117). The copy already holds every unchanged value, so a clean slot writes nothing.
  const slot = slotBlock(
    g,
    spec.element,
    spec,
    "i",
    (holeTest) => (holeTest ? "if (inVal === undefined) dirty = true;" : ""),
    `if (outVal === FAILED) anyFailed = true;
      else if (outVal !== inVal) { dirty = true; items[i] = outVal; }
      else if (inVal === undefined) dirty = true;`,
  );
  const src = `return function generatedArray(data, ctx) {
    if (!Array.isArray(data)) { pushInvalidType(ctx, data, ${em}, "array"); return FAILED; }
    ${checks.join("\n    ")}
    const items = ${spread}(data);
    const n = items.length;
    let dirty = ctx.force, anyFailed = false;
    for (let i = 0; i < n; i++) { const inVal = items[i]; ${slot} }
    if (anyFailed) return FAILED;
    return dirty ? items : data;
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

/**
 * Generated tuple skeleton (the closure `makeTuple` in compile.ts), one unrolled block per slot.
 *
 * The capture is stock's own: after the length checks and the `too_big` issue and before any slot
 * runs, `stockSpread` evaluates `[...ctx.data]` as `ZodTuple._parse` does, so every read the
 * capture makes on the input, every piece of user code it runs, every intrinsic it consults and
 * every engine error it throws are stock's by identity (#65, reviews of #115). The fresh array it
 * returns is the output: each slot is validated from it and its result written back into it, the
 * slots past the captured count never run (an input whose accessors shrank it during the capture
 * is parsed as stock parses it, from what the capture holds), a too-long input is truncated to the
 * declared slots after its excess elements were read, and a hole is an own `undefined` slot. The
 * skeleton makes no read of the input of its own, so it never returns the input by reference: the
 * only proof that the input still holds what the capture yielded would be reads stock does not
 * make (the reviews of #115), and the output stock builds is a fresh array in every case.
 */
export function genTuple(spec: TupleSpec): Validator {
  const g = new Gen();
  const em = g.hoist(spec.errorMap, "em");
  const n = spec.items.length;
  const spread = g.hoist(stockSpread, "stockSpread");
  const slots = spec.items.map(
    (item, i) =>
      `if (k > ${i}) { const inVal = items[${i}]; ${slotBlock(
        g,
        item,
        spec,
        String(i),
        () => "",
        `if (outVal === FAILED) anyFailed = true; else items[${i}] = outVal;`,
      )} }`,
  );
  const src = `return function generatedTuple(data, ctx) {
    if (!Array.isArray(data)) { pushInvalidType(ctx, data, ${em}, "array"); return FAILED; }
    if (data.length < ${n}) { pushIssue(ctx, data, ${em}, { code: "too_small", minimum: ${n}, inclusive: true, exact: false, type: "array" }); return FAILED; }
    if (data.length > ${n}) pushIssue(ctx, data, ${em}, { code: "too_big", maximum: ${n}, inclusive: true, exact: false, type: "array" });
    const items = ${spread}(data);
    let k = items.length;
    if (k > ${n}) items.length = k = ${n};
    let anyFailed = false;
    ${slots.join("\n    ")}
    if (anyFailed) return FAILED;
    return items;
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
    "isObjectType",
    "pushIssue",
    "pushInvalidType",
    "prefixIssues",
    ...g.names,
    src,
  );
  return factory(
    FAILED,
    hop,
    isObjectType,
    pushIssue,
    pushInvalidType,
    prefixIssues,
    ...g.values,
  ) as Validator;
}
