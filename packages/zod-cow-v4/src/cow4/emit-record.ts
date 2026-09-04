/** Record skeleton: key-name/value double reference comparison + conditional {...input} copy. */
import { regexes, util, ZodCompileUnsupportedError } from "zod/v4/core";
import { type CodeCtx, escKey } from "./codectx.js";
import { childProduct, containerChecksFn } from "./emit.js";
import { officialFn } from "./official.js";
import { isAsyncProduct, type Node } from "./product.js";

/* ── record skeleton: key-name/value double reference comparison + conditional {...input} copy ── */

/**
 * Three compile-time paths (one for one with the official generateRecordCheck, aggressively covering all of them):
 *   A. Declaration-driven enum keys (keyType._zod.values exists and it is not partial):
 *      official output = unconditionally materialize every declared key in declaration order + strictly reject unknown keys;
 *      skeleton: a missing declared key (stock materializes it) → dirty; the rebuild branch writes back every declared key unconditionally.
 *   B. General keys (string format / number numeric retry / partialRecord):
 *      keyFast product + numeric key retry; key names compared by reference (outKey !== k → delete the old key and write the new one);
 *      loose keeps the keys the key schema rejects ({...input} keeps them naturally and the value is not validated -- same as the official code).
 *   C. bare-string keys (z.record(z.string(), v)): the key name never changes, only values are compared.
 */
export function emitCoWRecord(
  ctx: CodeCtx,
  schema: Node,
  accessor: string,
  seen: Set<Node>,
): string {
  const def = schema._zod.def as {
    keyType: Node;
    valueType: Node;
    mode?: string;
    partial?: boolean;
  };
  const childSeen = new Set(seen);
  childSeen.add(schema);

  // Same guard as the official one: util.isPlainObject (rejects Date/Map/class instances and the like)
  const isPlain = ctx.addConst(util.isPlainObject);
  ctx.write(`if (!${isPlain}(${accessor})) return INVALID;`);

  const out = ctx.var();
  const dirty = ctx.var();
  ctx.write(`let ${out} = ${accessor}, ${dirty} = false;`);

  const keyValues = def.partial
    ? undefined
    : (def.keyType._zod as { values?: Set<unknown> }).values;
  const loose = def.mode === "loose";

  if (keyValues) {
    /* ── Path A: declaration-driven ── */
    /** Write-back plan for the copy branch: collected first, emitted together after the loop (after the out = {...input} assignment) */
    const writebacks: { keyExpr: string; inVar: string; outVar: string | null }[] = [];

    for (const kv of keyValues) {
      if (typeof kv !== "string" && typeof kv !== "number" && typeof kv !== "symbol") {
        throw new ZodCompileUnsupportedError(`record key value ${String(kv)}`);
      }
      const inputKey: string | symbol = typeof kv === "number" ? kv.toString() : kv;
      if (inputKey === "__proto__") throw new ZodCompileUnsupportedError('record key "__proto__"');
      const keyExpr = typeof inputKey === "symbol" ? ctx.addConst(inputKey) : escKey(inputKey);
      const inVar = ctx.var();
      // The official code runs the keyType check on a constant key (enum has, known to be always true at compile time) → omitted
      ctx.write(`const ${inVar} = ${accessor}[${keyExpr}];`);
      const product = childProduct(def.valueType, childSeen);
      const f = ctx.addConst(product.fn);
      const pAsync = product.kind === "async";
      if (pAsync) ctx.async = true;
      const awaitKw = pAsync ? "await " : "";
      // Missing declared key: the official code materializes it unconditionally (value = undefined) → absence in the input means dirty
      const missing = ctx.var();
      ctx.write(`const ${missing} = !(${keyExpr} in ${accessor});`);
      if (product.kind === "validator") {
        ctx.write(`if (${f}(${inVar}) === INVALID) return INVALID;`);
        ctx.write(`if (${missing}) ${dirty} = true;`);
        writebacks.push({ keyExpr, inVar, outVar: null });
      } else {
        const outVar = ctx.var();
        ctx.write(`const ${outVar} = ${awaitKw}${f}(${inVar});`);
        ctx.write(`if (${outVar} === INVALID) return INVALID;`);
        ctx.write(`if (${outVar} !== ${inVar} || ${missing}) ${dirty} = true;`);
        writebacks.push({ keyExpr, inVar, outVar });
      }
    }
    // Unknown keys: the official enum record is strict (for...in → INVALID)
    const knownConst = ctx.addConst(new Set(keyValues as Iterable<string | symbol>));
    ctx.write(`for (const k in ${accessor}) {`);
    ctx.indented(() => {
      ctx.write(`if (!${knownConst}.has(k)) return INVALID;`);
    });
    ctx.write(`}`);

    ctx.write(`if (!${dirty}) return ${accessor};`);
    ctx.write(`${out} = { ...${accessor} };`);
    for (const w of writebacks) {
      if (w.outVar === null) {
        // validator product: value = input (when present inVar is the original value; when missing inVar === undefined)
        ctx.write(`${out}[${w.keyExpr}] = ${w.inVar};`);
      } else {
        // The official code writes declared keys unconditionally (including undefined values)
        ctx.write(`${out}[${w.keyExpr}] = ${w.outVar};`);
      }
    }
    return out;
  }

  /* ── Paths B/C: iterate the input keys ── */
  const keyDef = def.keyType._zod.def as {
    type: string;
    format?: string;
    coerce?: boolean;
    checks?: unknown[];
  };
  const keyIsBareString =
    keyDef.type === "string" &&
    keyDef.format === undefined &&
    !keyDef.coerce &&
    (keyDef.checks?.length ?? 0) === 0;

  const propIsEnumerable = ctx.addConst(Object.prototype.propertyIsEnumerable);

  if (keyIsBareString) {
    /* ── Path C: the key name never changes ── */
    ctx.write(`for (const k of Reflect.ownKeys(${accessor})) {`);
    ctx.indented(() => {
      ctx.write(`if (k === "__proto__") continue;`);
      ctx.write(`if (!${propIsEnumerable}.call(${accessor}, k)) continue;`);
      ctx.write(`if (typeof k !== "string") return INVALID;`);
      ctx.write(`const vIn = ${accessor}[k];`);
      emitRecordValueProduct(ctx, def.valueType, childSeen, dirty, out, accessor, "k");
    });
    ctx.write(`}`);
  } else {
    /* ── Path B: keyFast + numeric retry + key-name comparison ── */
    // The official keyFast = compileFn(keyType) (parser product: returns the validated/converted key name); an async key schema → async island
    const keyFastFn = officialFn(def.keyType, false);
    const keyFast = ctx.addConst(keyFastFn);
    const keyAsync = isAsyncProduct(keyFastFn);
    if (keyAsync) ctx.async = true;
    const kAwait = keyAsync ? "await " : "";
    const numeric = ctx.addConst(regexes.number);
    ctx.write(`for (const k of Reflect.ownKeys(${accessor})) {`);
    ctx.indented(() => {
      ctx.write(`if (k === "__proto__") continue;`);
      ctx.write(`if (!${propIsEnumerable}.call(${accessor}, k)) continue;`);
      ctx.write(`let outKey = ${kAwait}${keyFast}(k);`);
      ctx.write(
        `if (outKey === INVALID && typeof k === "string" && ${numeric}.test(k)) outKey = ${kAwait}${keyFast}(Number(k));`,
      );
      ctx.write(`if (outKey === INVALID) {`);
      ctx.indented(() => {
        // loose: keys the key schema rejects are kept as they are (the value is not validated); {...input} already carries the original value, so no write-back is needed -- same as the official code
        if (loose) ctx.write(`continue;`);
        else ctx.write(`return INVALID;`);
      });
      ctx.write(`}`);
      ctx.write(`if (outKey === "__proto__") continue;`);
      ctx.write(`const vIn = ${accessor}[k];`);
      emitRecordValueProduct(ctx, def.valueType, childSeen, dirty, out, accessor, "k", "outKey");
    });
    ctx.write(`}`);
  }

  // The container's own checks (refine and friends; record has no size check)
  const checksFn = containerChecksFn(schema);
  if (checksFn) {
    const cName = ctx.addConst(checksFn);
    ctx.write(`if (!${dirty}) {`);
    ctx.indented(() => {
      ctx.write(`if (${cName}(${accessor}) === INVALID) return INVALID;`);
      ctx.write(`return ${accessor};`);
    });
    ctx.write(`}`);
    ctx.write(`if (${cName}(${out}) === INVALID) return INVALID;`);
  }
  return out;
}

/**
 * The two emission shapes for record value handling (every variable parameterized, no hard-coded variable names):
 *   validator product: answers pass/fail only, value = input, no copy;
 *   parser/cow product: returns a value, reference comparison for dirtiness + {...accessor} shallow copy at the first dirt + write-back.
 * Path B additionally compares key names (outKey !== k → delete the old key, write the new one).
 */
function emitRecordValueProduct(
  ctx: CodeCtx,
  valueType: Node,
  seen: Set<Node>,
  dirty: string,
  outVar: string,
  accessorVar: string,
  keyVar: string,
  outKeyVar?: string,
): void {
  const product = childProduct(valueType, seen);
  const f = ctx.addConst(product.fn);
  if (product.kind === "validator") {
    ctx.write(`if (${f}(vIn) === INVALID) return INVALID;`);
    return;
  }
  const t = ctx.var();
  if (product.kind === "async") {
    ctx.async = true;
    ctx.write(`const ${t} = await ${f}(vIn);`);
  } else {
    ctx.write(`const ${t} = ${f}(vIn);`);
  }
  ctx.write(`if (${t} === INVALID) return INVALID;`);
  ctx.write(`if (${t} !== vIn${outKeyVar ? ` || ${outKeyVar} !== ${keyVar}` : ""}) {`);
  ctx.indented(() => {
    ctx.write(`if (!${dirty}) { ${dirty} = true; ${outVar} = { ...${accessorVar} }; }`);
    if (outKeyVar) {
      ctx.write(`if (${outKeyVar} !== ${keyVar}) delete ${outVar}[${keyVar}];`);
      ctx.write(`${outVar}[${outKeyVar}] = ${t};`);
    } else {
      ctx.write(`${outVar}[${keyVar}] = ${t};`);
    }
  });
  ctx.write(`}`);
}
