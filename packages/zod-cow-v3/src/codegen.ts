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
  NATIVE_ARRAY_ITERATOR,
  NATIVE_ARRAY_NEXT,
  callArrayIterator,
  isObjectType,
  pushInvalidType,
  pushIssue,
  spreadFromIterator,
  spreadFromMethod,
  toLength,
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
  return `if (${pred}) { ${onPass(predicateAcceptsUndefined(child.schema))} } else { ${call} }`;
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
 * Generated array skeleton (the closure `makeArray` in compile.ts). Stock reads every element
 * once (`[...data]`) and builds a fresh array from the results; here the clean path returns the
 * input by reference, the first forced change (a changed element, or a hole, which stock's spread
 * turns into an own `undefined` slot) rebuilds the clean prefix from the input into a fresh array
 * (the one second read, of the elements before the change) and every later element is written
 * from the loop's single read, so a getter at or after the change is read once, as stock reads it
 * (#65). In stock's rebuild mode (`ctx.force`) the fresh array is allocated up front and every
 * element is written once.
 */
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
  // The first forced change: a fresh array of the input's length takes the clean prefix
  const copy =
    "dirty = true; out = new Array(data.length); for (let j = 0; j < i; j++) out[j] = data[j];";
  const slot = slotBlock(
    g,
    spec.element,
    spec,
    "i",
    (holeTest) =>
      `if (dirty) out[i] = inVal;${holeTest ? ` else if (inVal === undefined && !(i in data)) { ${copy} out[i] = inVal; }` : ""}`,
    `if (outVal === FAILED) anyFailed = true;
      else if (dirty) out[i] = outVal;
      else if (!anyFailed && (outVal !== inVal || (inVal === undefined && !(i in data)))) { ${copy} out[i] = outVal; }`,
  );
  const src = `return function generatedArray(data, ctx) {
    if (!Array.isArray(data)) { pushInvalidType(ctx, data, ${em}, "array"); return FAILED; }
    ${checks.join("\n    ")}
    let dirty = ctx.force, out = dirty ? new Array(data.length) : data, anyFailed = false;
    for (let i = 0; i < data.length; i++) { const inVal = data[i]; ${slot} }
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

/**
 * Generated tuple skeleton (the closure `makeTuple` in compile.ts), one unrolled block per slot.
 * The elements are captured as stock's `[...ctx.data]` captures them, after the length checks and
 * the too_big issue and before any item runs (review of #115): `Symbol.iterator` is read off the
 * input and, when it answered the native array iterator, `next` off the iterator that iterator
 * creates (the reads stock's spread makes, with stock's receivers); when both answered the natives
 * the walk is inline, reading the live length (converted as `ToLength` converts it) before each
 * element and the element into its local (`v0`, `v1`, …), the excess elements of a too-long input
 * included, until the index reaches the length, so a getter that moves the length changes how
 * many elements are read and parsed exactly as it does in stock (second review of #115); any other
 * answer continues through a real spread from the values already read (`spreadFromMethod`,
 * `spreadFromIterator`), whose elements fill the locals and whose output is always a fresh array.
 * Each local then takes its slot's result, the slots past the captured count never run, and the
 * copy is an array literal of the locals cut to that count, so no element is read twice on any
 * path (#65): a too-long input (too_big, dirty like stock) and stock's rebuild mode take the same
 * assembly. The clean path returns the input when every captured slot came back unchanged and the
 * length the last step read is the captured count (an input that grew or shrank after a read
 * holds elements stock's output does not, or lacks some). A hole reads as undefined, is parsed as
 * such and makes the tuple dirty, since stock's spread turns it into an own `undefined` slot.
 */
export function genTuple(spec: TupleSpec): Validator {
  const g = new Gen();
  const em = g.hoist(spec.errorMap, "em");
  const n = spec.items.length;
  const nativeIter = g.hoist(NATIVE_ARRAY_ITERATOR, "nativeIter");
  const nativeNext = g.hoist(NATIVE_ARRAY_NEXT, "nativeNext");
  const callIter = g.hoist(callArrayIterator, "callIter");
  const toLen = g.hoist(toLength, "toLength");
  const fromMethod = g.hoist(spreadFromMethod, "spreadFromMethod");
  const fromIterator = g.hoist(spreadFromIterator, "spreadFromIterator");
  // The live length as the array iterator reads it: `ToLength` of the read, the conversion inline
  // for the answer a real array gives (a non-negative integer)
  const liveLength = `(len = data.length, typeof len === "number" && (len | 0) === len && len >= 0 ? len : (len = ${toLen}(len)))`;
  const walk = [
    ...spec.items.map(
      (_, i) => `if (!(${i} < ${liveLength})) { k = ${i}; break cap; } v${i} = data[${i}];`,
    ),
    `k = ${n};`,
    `for (let i = ${n}; i < ${liveLength}; i++) data[i];`,
  ].join("\n        ");
  const fill = spec.items.map((_, i) => `v${i} = cap[${i}];`).join(" ");
  const slots = spec.items.map((item, i) => {
    const V = `v${i}`;
    const hole = `if (!dirty && inVal === undefined && !(${i} in data)) dirty = true;`;
    return `if (k === ${i}) break slots; { const inVal = ${V}; ${slotBlock(
      g,
      item,
      spec,
      String(i),
      (holeTest) => (holeTest ? hole : ""),
      `if (outVal === FAILED) anyFailed = true; else { ${V} = outVal; if (outVal !== inVal) dirty = true; else ${hole} }`,
    )} }`;
  });
  const src = `return function generatedTuple(data, ctx) {
    if (!Array.isArray(data)) { pushInvalidType(ctx, data, ${em}, "array"); return FAILED; }
    if (data.length < ${n}) { pushIssue(ctx, data, ${em}, { code: "too_small", minimum: ${n}, inclusive: true, exact: false, type: "array" }); return FAILED; }
    let dirty = ctx.force, anyFailed = false;
    if (data.length > ${n}) { pushIssue(ctx, data, ${em}, { code: "too_big", maximum: ${n}, inclusive: true, exact: false, type: "array" }); dirty = true; }
    ${n === 0 ? "" : `let ${spec.items.map((_, i) => `v${i}`).join(", ")};`}
    let k, len, cap;
    const iter = data[Symbol.iterator];
    if (iter === ${nativeIter}) {
      const it = ${callIter}(data);
      const next = it.next;
      if (next === ${nativeNext}) { cap: {
        ${walk}
      } } else cap = ${fromIterator}(it, next);
    } else cap = ${fromMethod}(iter, data);
    if (cap !== undefined) { k = cap.length < ${n} ? cap.length : ${n}; ${fill} dirty = true; }
    slots: {
    ${slots.join("\n    ")}
    }
    if (anyFailed) return FAILED;
    if (!dirty && len === k) return data;
    const out = [${spec.items.map((_, i) => `v${i}`).join(", ")}];
    if (k !== ${n}) out.length = k;
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
