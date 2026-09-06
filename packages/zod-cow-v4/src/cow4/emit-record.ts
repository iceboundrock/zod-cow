/** Record skeleton: key-name/value double reference comparison + ordered rebuild of the clean prefix at the first change. */
import { regexes, util, ZodCompileUnsupportedError } from "zod/v4/core";
import { type CodeCtx, emitOwnSymbolProbe, escKey, unknownStringKeyExpr } from "./codectx.js";
import { childProduct, containerChecksFn } from "./emit.js";
import { officialFn } from "./official.js";
import { isAsyncProduct, type Node } from "./product.js";

/* ── record skeleton: key-name/value double reference comparison + ordered rebuild of the clean prefix at the first change ── */

/**
 * Three compile-time paths (one for one with the official generateRecordCheck, aggressively covering all of them):
 *   A. Declaration-driven enum keys (keyType._zod.values exists and it is not partial):
 *      official output = unconditionally materialize every declared key in declaration order + strictly reject unknown keys;
 *      skeleton: a missing declared key (stock materializes it) → dirty; the rebuild branch writes back every declared key unconditionally.
 *   B. General keys (string format / number numeric retry / partialRecord):
 *      keyFast product + numeric key retry; key names compared by reference (outKey !== k → dirty, the pair written under outKey);
 *      loose keeps the keys the key schema rejects in their position, with the value not validated -- same as the official code.
 *   C. bare-string keys (z.record(z.string(), v)): the key name never changes, only values are compared.
 * The copy of paths B and C replays stock's assembly sequence (`emitRebuildPrefix`), never `{ ...input }`.
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
    /** Copy plan: every declared key in declaration order, written from the locals captured during validation */
    const writebacks: { keyExpr: string; valueVar: string }[] = [];
    /** The declared keys as `for...in` yields them (numbers stringified), the form the unknown-key probe compares against (#37) */
    const inputKeys: (string | symbol)[] = [];
    const stringKeys: string[] = [];
    const symbolKeys: symbol[] = [];

    for (const kv of keyValues) {
      if (typeof kv !== "string" && typeof kv !== "number" && typeof kv !== "symbol") {
        throw new ZodCompileUnsupportedError(`record key value ${String(kv)}`);
      }
      const inputKey: string | symbol = typeof kv === "number" ? kv.toString() : kv;
      if (inputKey === "__proto__") throw new ZodCompileUnsupportedError('record key "__proto__"');
      inputKeys.push(inputKey);
      if (typeof inputKey === "string") stringKeys.push(inputKey);
      else symbolKeys.push(inputKey);
      const keyExpr = typeof inputKey === "symbol" ? ctx.addConst(inputKey) : escKey(inputKey);
      const inVar = ctx.var();
      // The official code runs the keyType check on a constant key (enum has, known to be always true at compile time) → omitted
      ctx.write(`const ${inVar} = ${accessor}[${keyExpr}];`);
      const product = childProduct(def.valueType, childSeen, ctx);
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
        // validator product: value = input (when present inVar is the original value; when missing inVar === undefined)
        writebacks.push({ keyExpr, valueVar: inVar });
      } else {
        const outVar = ctx.var();
        ctx.write(`const ${outVar} = ${awaitKw}${f}(${inVar});`);
        ctx.write(`if (${outVar} === INVALID) return INVALID;`);
        ctx.write(`if (${outVar} !== ${inVar} || ${missing}) ${dirty} = true;`);
        writebacks.push({ keyExpr, valueVar: outVar });
      }
    }

    // Undeclared keys, the official for...in template: strict rejects them on every path; loose keeps
    // them, so its probe runs only on the copy path, where the copy has to carry them.
    // `for...in` yields strings only, so declared symbol keys never reach the probe and the known-key
    // Set is hoisted only when the declared string keys exceed the inline comparison cap.
    let known: string | null = null;
    const knownSet = () => (known ??= ctx.addConst(new Set(inputKeys)));
    const unknownKey = unknownStringKeyExpr(stringKeys, knownSet);
    if (!loose) {
      ctx.write(`for (const k in ${accessor}) {`);
      ctx.indented(() => {
        ctx.write(`if (${unknownKey}) return INVALID;`);
      });
      ctx.write(`}`);
    } else {
      // An own enumerable `__proto__` (JSON.parse) is enumerated by stock's `for...in` append and
      // skipped there, so it is missing from stock's output; strict rejected it above as unknown,
      // loose has to copy (the copy path skips it like stock) instead of returning the input (#67)
      const propIsEnumerable = ctx.addConst(Object.prototype.propertyIsEnumerable);
      ctx.write(
        `if (!${dirty} && ${propIsEnumerable}.call(${accessor}, "__proto__")) ${dirty} = true;`,
      );
    }

    // Undeclared own symbol keys: `for...in` never sees them, so neither strict nor loose rejects or
    // keeps one, and stock's rebuild drops them on every path (the object skeleton's #42 case, #51).
    // The clean path has to prove there are none before returning the input by reference; the copy
    // path drops them by construction. Skipped under `ownSymbolKeys: "ignore"` (#43), like objects.
    if (ctx.options.ownSymbolKeys === "probe") {
      ctx.write(`if (!${dirty}) {`);
      ctx.indented(() => emitOwnSymbolProbe(ctx, accessor, dirty, symbolKeys, knownSet));
      ctx.write(`}`);
    }

    // Copy path: the official assembly, never a spread of the input. Declared keys in declaration
    // order (a missing declared key is written as undefined, which is what stock does), then in loose
    // mode the undeclared string keys appended by for...in (stock skips only "__proto__").
    ctx.write(`if (${dirty}) {`);
    ctx.indented(() => {
      ctx.write(`${out} = {};`);
      for (const w of writebacks) ctx.write(`${out}[${w.keyExpr}] = ${w.valueVar};`);
      if (loose) {
        ctx.write(`for (const k in ${accessor}) {`);
        ctx.indented(() => {
          ctx.write(`if (${unknownKey} && k !== "__proto__") ${out}[k] = ${accessor}[k];`);
        });
        ctx.write(`}`);
      }
    });
    ctx.write(`}`);
    return emitRecordChecks(ctx, schema, accessor, out, dirty);
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
  /** A pair stock leaves out of its output: the clean path may not return the input with it, so the record is dirty from here and the pair is skipped */
  const dropPair = (): void => {
    ctx.write(`if (!${dirty}) {`);
    ctx.indented(() => {
      ctx.write(`${dirty} = true;`);
      emitRebuildPrefix(ctx, accessor, out, propIsEnumerable, "k");
    });
    ctx.write(`}`);
    ctx.write(`continue;`);
  };
  // An own `__proto__` (JSON.parse) is skipped by stock's loop and so missing from its output;
  // the clean path returning the input would keep it, so it marks the record dirty (#67)
  const skipProto = (): void => {
    ctx.write(`if (k === "__proto__") {`);
    ctx.indented(dropPair);
    ctx.write(`}`);
  };
  // Stock skips a non-enumerable own key and its rebuild then drops it. A non-enumerable own
  // *symbol* is the record-side case of #42 (an enumerable one is validated as a key below, like
  // stock): under `ownSymbolKeys: "probe"` it marks the record dirty from inside the skip the loop
  // already runs, so the rebuilt copy (enumerable keys only) drops it like stock (#51).
  // No second probe: `Reflect.ownKeys` has listed it already. `"ignore"` keeps the plain skip.
  const skipNonEnumerable = (): void => {
    if (ctx.options.ownSymbolKeys === "probe") {
      ctx.write(`if (!${propIsEnumerable}.call(${accessor}, k)) {`);
      ctx.indented(() => {
        ctx.write(`if (typeof k !== "symbol") continue;`);
        dropPair();
      });
      ctx.write(`}`);
    } else {
      ctx.write(`if (!${propIsEnumerable}.call(${accessor}, k)) continue;`);
    }
  };

  if (keyIsBareString) {
    /* ── Path C: the key name never changes ── */
    ctx.write(`for (const k of Reflect.ownKeys(${accessor})) {`);
    ctx.indented(() => {
      skipProto();
      skipNonEnumerable();
      ctx.write(`if (typeof k !== "string") return INVALID;`);
      ctx.write(`const vIn = ${accessor}[k];`);
      emitRecordValueProduct(
        ctx,
        def.valueType,
        childSeen,
        dirty,
        out,
        accessor,
        propIsEnumerable,
        "k",
      );
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
      skipProto();
      skipNonEnumerable();
      ctx.write(`let outKey = ${kAwait}${keyFast}(k);`);
      ctx.write(
        `if (outKey === INVALID && typeof k === "string" && ${numeric}.test(k)) outKey = ${kAwait}${keyFast}(Number(k));`,
      );
      // A retried key comes back as a number that stock writes under `String(outKey)`, the very key
      // it read: the same property, so it is clean (a number the schema changed stays dirty)
      ctx.write(`if (typeof outKey === "number" && String(outKey) === k) outKey = k;`);
      ctx.write(`if (outKey === INVALID) {`);
      ctx.indented(() => {
        // loose: a key the schema rejects is kept as it is with its value unvalidated, in its
        // position: part of the clean prefix while clean, written explicitly once dirty
        if (loose) ctx.write(`if (${dirty}) ${out}[k] = ${accessor}[k];`);
        ctx.write(loose ? `continue;` : `return INVALID;`);
      });
      ctx.write(`}`);
      // The key schema can normalize an ordinary key into "__proto__": stock skips the pair
      ctx.write(`if (outKey === "__proto__") {`);
      ctx.indented(dropPair);
      ctx.write(`}`);
      ctx.write(`const vIn = ${accessor}[k];`);
      emitRecordValueProduct(
        ctx,
        def.valueType,
        childSeen,
        dirty,
        out,
        accessor,
        propIsEnumerable,
        "k",
        "outKey",
      );
    });
    ctx.write(`}`);
  }

  return emitRecordChecks(ctx, schema, accessor, out, dirty);
}

/**
 * The container's own checks (refine and friends; record has no size check), run on the final
 * output of both paths: the input when clean, the copy when dirty. Returns the output variable.
 */
function emitRecordChecks(
  ctx: CodeCtx,
  schema: Node,
  accessor: string,
  out: string,
  dirty: string,
): string {
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
 * The first forced change of an iterating record: stock assembles its output from the parsed
 * pairs in `Reflect.ownKeys` order, so the copy starts empty and replays the clean prefix (every
 * enumerable own key before `keyVar`, `__proto__` skipped, the value read from the input again)
 * and every later pair is written after it. This keeps stock's assignment sequence, so a
 * transformed key that collides with a later key is overwritten by it and the copy keeps the
 * input's order; `{ ...input }` plus delete / write did neither (#67).
 */
function emitRebuildPrefix(
  ctx: CodeCtx,
  accessor: string,
  out: string,
  propIsEnumerable: string,
  keyVar: string,
): void {
  ctx.write(`${out} = {};`);
  ctx.write(`for (const k2 of Reflect.ownKeys(${accessor})) {`);
  ctx.indented(() => {
    ctx.write(`if (k2 === ${keyVar}) break;`);
    ctx.write(`if (k2 === "__proto__" || !${propIsEnumerable}.call(${accessor}, k2)) continue;`);
    ctx.write(`${out}[k2] = ${accessor}[k2];`);
  });
  ctx.write(`}`);
}

/**
 * The two emission shapes for record value handling (every variable parameterized, no hard-coded variable names):
 *   validator product: answers pass/fail only, value = input; path B still compares the key name;
 *   parser/cow product: returns a value, reference comparison for dirtiness.
 * A clean pair moves on to the next key. The first dirty pair rebuilds the clean prefix
 * (`emitRebuildPrefix`), then this and every later pair is written under its output key, as stock does.
 */
function emitRecordValueProduct(
  ctx: CodeCtx,
  valueType: Node,
  seen: Set<Node>,
  dirty: string,
  outVar: string,
  accessorVar: string,
  propIsEnumerable: string,
  keyVar: string,
  outKeyVar?: string,
): void {
  const product = childProduct(valueType, seen, ctx);
  const f = ctx.addConst(product.fn);
  let valExpr = "vIn";
  if (product.kind === "validator") {
    ctx.write(`if (${f}(vIn) === INVALID) return INVALID;`);
    // Path C with a pure value: the name and the value never change, but a pair after the first
    // forced change (a dropped `__proto__` or non-enumerable symbol) still has to be written
    if (!outKeyVar) {
      ctx.write(`if (${dirty}) ${outVar}[${keyVar}] = vIn;`);
      return;
    }
  } else {
    const t = ctx.var();
    if (product.kind === "async") {
      ctx.async = true;
      ctx.write(`const ${t} = await ${f}(vIn);`);
    } else {
      ctx.write(`const ${t} = ${f}(vIn);`);
    }
    ctx.write(`if (${t} === INVALID) return INVALID;`);
    valExpr = t;
  }
  const clean = [
    outKeyVar ? `${outKeyVar} === ${keyVar}` : "",
    valExpr !== "vIn" ? `${valExpr} === vIn` : "",
  ]
    .filter(Boolean)
    .join(" && ");
  ctx.write(`if (!${dirty}) {`);
  ctx.indented(() => {
    ctx.write(`if (${clean}) continue;`);
    ctx.write(`${dirty} = true;`);
    emitRebuildPrefix(ctx, accessorVar, outVar, propIsEnumerable, keyVar);
  });
  ctx.write(`}`);
  ctx.write(`${outVar}[${outKeyVar ?? keyVar}] = ${valExpr};`);
}
