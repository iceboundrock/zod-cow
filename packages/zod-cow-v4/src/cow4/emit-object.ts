/**
 * Object skeleton: reference comparison on every key, the input reference when nothing changed,
 * otherwise the output rebuilt in shape order from the captured locals (the official parser's
 * own assembly rules).
 */
import { ZodCompileUnsupportedError } from "zod/v4/core";
import { type CodeCtx, escKey } from "./codectx.js";
import { containerChecksFn, containerChildFn } from "./emit.js";
import { officialFn } from "./official.js";
import { dropsWhenAbsent, mayOutputUndefined, requiresPresence } from "./predicates.js";
import { isAsyncProduct, type Node } from "./product.js";
import { cowSafeContainerForChild, isPure } from "./purity.js";

/* ── object skeleton ── */

/**
 * Shapes with at most this many string keys probe unknown keys with a generated
 * `k !== "a" && k !== "b" …` chain; larger shapes fall back to `Set.has(k)`.
 * `for...in` hands V8 internalized strings, so each comparison is a pointer
 * compare, while `Set.has` hashes and probes per key. Measured on Node 24 the
 * chain is still 4 to 5x faster than the Set at 16 to 32 keys and only reaches
 * parity around 128 keys, so this cap is conservative; it bounds the generated
 * code size rather than marking the break-even point. Raising it is a
 * benchmark-backed decision, not a correctness one (#34).
 */
const MAX_INLINE_KEY_COMPARISONS = 16;

/**
 * Two paths, decided at runtime per object:
 *
 *   clean   every key's product returned its input (or validated a pure leaf) and, in strip
 *           mode, the input carries no undeclared string key and (unless the tree was compiled
 *           with `ownSymbolKeys: "ignore"`, #43) no undeclared own symbol key: the container
 *           checks run on the input and the input reference is returned;
 *   copy    something changed (a value producer fired, a nested container was copied) or strip
 *           found an undeclared key: the output is a fresh object assembled in shape order from
 *           the locals captured while validating, with the official presence rules
 *           (`dropsWhenAbsent` / `mayOutputUndefined`, copied from zod's generateObjectCheck), and
 *           in loose mode the undeclared string keys appended by the official for...in template.
 *
 * The copy path never spreads the input: a spread would re-read every getter (#36), keep the
 * undeclared keys (which then had to be deleted, turning the copy into a dictionary-mode object)
 * and produce the input's key order instead of stock's shape order. Assembling from the locals
 * gives stock's output exactly and lets strip mode skip both undeclared-key probes once a key is
 * known dirty: the probes only decide whether the input can be returned by reference.
 *
 * The own-symbol probe (`Object.getOwnPropertySymbols`, about 36 ns per object, the whole gap of
 * the clean path to the compiled parser) exists because stock's rebuild drops own symbol keys and
 * a pass-through has to prove there are none. `ownSymbolKeys: "ignore"` drops the probe: the
 * input is then returned by reference on the strength of the string probe alone, and an own symbol
 * key survives where stock would drop it, the behavior strict and loose objects already have (#42).
 */
export function emitCoWObject(
  ctx: CodeCtx,
  schema: Node,
  accessor: string,
  seen: Set<Node>,
): string {
  const def = schema._zod.def;
  if (seen.has(schema)) throw new ZodCompileUnsupportedError("recursive object");
  seen.add(schema);

  // Container guard (verbatim from the official template)
  ctx.write(
    `if (typeof ${accessor} !== "object" || ${accessor} === null || Array.isArray(${accessor})) return INVALID;`,
  );

  const shape = def.shape;
  const stringKeys = Object.keys(shape);
  const symbolKeys = Object.getOwnPropertySymbols(shape);
  const allKeys: (string | symbol)[] = [...stringKeys, ...symbolKeys];

  // __proto__ shape key: the official codegen rejects it too (literal assignment would change the prototype)
  if (stringKeys.includes("__proto__"))
    throw new ZodCompileUnsupportedError('object shape key "__proto__"');

  // catchall mode classification (same decision as the official unknownKeysMode)
  let mode: "strip" | "strict" | "loose" = "strip";
  if (def.catchall) {
    const t = def.catchall._zod.def.type;
    if (t === "never") mode = "strict";
    else if ((t === "unknown" || t === "any") && !def.catchall._zod.def.checks?.length)
      mode = "loose";
    else throw new ZodCompileUnsupportedError("schema catchall");
  }

  const dirty = ctx.var();
  ctx.write(`let ${dirty} = false;`);

  /** Per key: the expression holding its output value on the copy path */
  const outputs: { key: string | symbol; keyExpr: string; valueVar: string }[] = [];

  for (const key of allKeys) {
    const child: Node = shape[key];
    const keyExpr = typeof key === "symbol" ? ctx.addConst(key) : escKey(key);
    const inVar = ctx.var();
    // Read the getter only once (official comment: checks and output assembly must not trigger the getter a second time)
    ctx.write(`const ${inVar} = ${accessor}[${keyExpr}];`);

    // Official presence guard: the value-level fast path cannot tell an absent required key from a present-undefined one
    if (requiresPresence(child)) {
      ctx.write(`if (!(${keyExpr} in ${accessor})) return INVALID;`);
    }

    if (isPure(child) && !cowSafeContainerForChild(child)) {
      // Pure leaf key: the official assertOnly product. Output === input, so the captured local is the output value.
      // (container keys do not take this branch: the strip semantics need a CoW sub-skeleton, see cowSafeContainerForChild)
      const vFn = officialFn(child, true);
      const v = ctx.addConst(vFn);
      if (isAsyncProduct(vFn)) {
        // A pure key has no async in theory; handled defensively anyway (after awaiting an async validator, output = input)
        ctx.async = true;
        ctx.write(`if ((await ${v}(${inVar})) === INVALID) return INVALID;`);
      } else {
        ctx.write(`if (${v}(${inVar}) === INVALID) return INVALID;`);
      }
      outputs.push({ key, keyExpr, valueVar: inVar });
      continue;
    }

    if (cowSafeContainerForChild(child)) {
      // Container key (including optional/nullable wrapping): CoW sub-skeleton (nested CoW + strip semantics intact)
      const vFn = containerChildFn(child, seen, ctx.options);
      const v = ctx.addConst(vFn);
      const isA = isAsyncProduct(vFn);
      if (isA) ctx.async = true;
      const outVar = ctx.var();
      ctx.write(`const ${outVar} = ${isA ? "await " : ""}${v}(${inVar});`);
      ctx.write(`if (${outVar} === INVALID) return INVALID;`);
      // A clean sub-skeleton returns the original reference → equal, not dirty; a dirty one returns a new reference → mark dirty
      ctx.write(`if (${outVar} !== ${inVar}) ${dirty} = true;`);
      outputs.push({ key, keyExpr, valueVar: outVar });
      continue;
    }

    // Impure key: official parser product + reference comparison for dirtiness
    const vFn = officialFn(child, false);
    const v = ctx.addConst(vFn);
    const isA = isAsyncProduct(vFn);
    if (isA) ctx.async = true;
    const awaitKw = isA ? "await " : "";
    const outVar = ctx.var();
    const optoutOptional = child._zod.optin !== undefined && child._zod.optout === "optional";
    if (optoutOptional) {
      // Official optin branch template: an absent key is not a failure, the output is undefined
      ctx.write(`let ${outVar} = ${awaitKw}${v}(${inVar});`);
      ctx.write(`if (${outVar} === INVALID) {`);
      ctx.indented(() => {
        ctx.write(`if (${keyExpr} in ${accessor}) return INVALID;`);
        ctx.write(`${outVar} = undefined;`);
      });
      ctx.write(`}`);
    } else {
      ctx.write(`const ${outVar} = ${awaitKw}${v}(${inVar});`);
      ctx.write(`if (${outVar} === INVALID) return INVALID;`);
    }

    // Dirtiness: reference comparison. Output undefined with the key absent → treated as unchanged (stock does not materialize the key either)
    ctx.write(
      `if (${outVar} !== ${inVar} && !(${outVar} === undefined && !(${keyExpr} in ${accessor}))) ${dirty} = true;`,
    );
    outputs.push({ key, keyExpr, valueVar: outVar });
  }

  // Undeclared-key predicate (official for...in template: inherited keys participate, matching the runtime).
  // `for...in` yields string keys only, so the string probe never sees a symbol; own symbols get a probe of their own.
  // The known-key Set is hoisted lazily: a small shape without declared symbols never references it.
  let known: string | null = null;
  const knownSet = () => (known ??= ctx.addConst(new Set(allKeys)));
  let unknownStringKeyExpr: string | null = null;
  const unknownStringKey = () =>
    (unknownStringKeyExpr ??=
      stringKeys.length <= MAX_INLINE_KEY_COMPARISONS
        ? stringKeys.map((key) => `k !== ${escKey(key)}`).join(" && ") || "true"
        : `!${knownSet()}.has(k)`);

  if (mode === "strict") {
    // Validation, not output shaping: runs on every path (the official template)
    ctx.write(`for (const k in ${accessor}) {`);
    ctx.indented(() => {
      ctx.write(`if (${unknownStringKey()}) return INVALID;`);
    });
    ctx.write(`}`);
  }

  // The container's own checks (.refine/.min and friends): a standalone validation subroutine,
  // called on both paths to match stock semantics (checks apply to the final output: the input when clean, the rebuilt out when dirty)
  const checksFn = containerChecksFn(schema);
  const cName = checksFn ? ctx.addConst(checksFn) : null;

  // ═══ CoW core: the branch the official template does not have ═══
  ctx.write(`if (!${dirty}) {`);
  ctx.indented(() => {
    if (mode === "strip") {
      // Strip probes, only here: a copy assembled from the declared keys drops undeclared keys by
      // construction, so the probes exist solely to prove that the input can be returned as is.
      // Shapes without a string key (symbol-only or empty) treat every string key as undeclared (#35).
      const extra = ctx.var();
      ctx.write(`let ${extra} = false;`);
      ctx.write(`for (const k in ${accessor}) {`);
      ctx.indented(() => {
        ctx.write(`if (${unknownStringKey()}) { ${extra} = true; break; }`);
      });
      ctx.write(`}`);
      if (ctx.options.ownSymbolKeys === "probe") {
        ctx.write(`if (!${extra}) {`);
        ctx.indented(() => {
          // Official strip discards extra enumerable own symbol keys, which a pass-through would keep → probe for them
          const syms = ctx.var();
          ctx.write(`const ${syms} = Object.getOwnPropertySymbols(${accessor});`);
          if (symbolKeys.length === 0) {
            ctx.write(`if (${syms}.length !== 0) ${extra} = true;`);
          } else {
            ctx.write(`for (const s of ${syms}) {`);
            ctx.indented(() => {
              ctx.write(`if (!${knownSet()}.has(s)) { ${extra} = true; break; }`);
            });
            ctx.write(`}`);
          }
        });
        ctx.write(`}`);
      }
      ctx.write(`if (!${extra}) {`);
      ctx.indented(() => {
        if (cName) ctx.write(`if (${cName}(${accessor}) === INVALID) return INVALID;`);
        ctx.write(`return ${accessor};`);
      });
      ctx.write(`}`);
    } else {
      if (cName) ctx.write(`if (${cName}(${accessor}) === INVALID) return INVALID;`);
      ctx.write(`return ${accessor};`);
    }
  });
  ctx.write(`}`);

  // ═══ Copy path: the official output assembly, from the captured locals ═══
  // Shape keys in declared order (a literal when no key is conditional, else `{}` plus guarded
  // writes), then in loose mode the undeclared keys in for...in order. Same rules as the official
  // generateObjectCheck, so the copy is stock's output: key order, key presence and no second
  // getter read.
  const hasConditionalKeys = allKeys.some(
    (k) => mayOutputUndefined(shape[k]) || dropsWhenAbsent(shape[k]),
  );
  if (!hasConditionalKeys) {
    const literal = outputs
      .map((o) => `${typeof o.key === "symbol" ? `[${o.keyExpr}]` : o.keyExpr}: ${o.valueVar}`)
      .join(", ");
    ctx.write(`const out = { ${literal} };`);
  } else {
    ctx.write(`const out = {};`);
    for (const o of outputs) {
      const child = shape[o.key];
      if (dropsWhenAbsent(child)) {
        ctx.write(`if (${o.keyExpr} in ${accessor}) out[${o.keyExpr}] = ${o.valueVar};`);
      } else if (mayOutputUndefined(child)) {
        ctx.write(
          `if (${o.valueVar} !== undefined || ${o.keyExpr} in ${accessor}) out[${o.keyExpr}] = ${o.valueVar};`,
        );
      } else {
        ctx.write(`out[${o.keyExpr}] = ${o.valueVar};`);
      }
    }
  }
  if (mode === "loose") {
    // Undeclared string keys are copied after the shape keys (official passthrough template:
    // for...in so inherited enumerables participate, `__proto__` skipped)
    ctx.write(`for (const k in ${accessor}) {`);
    ctx.indented(() => {
      ctx.write(`if (k === "__proto__") continue;`);
      ctx.write(`if (${unknownStringKey()}) out[k] = ${accessor}[k];`);
    });
    ctx.write(`}`);
  }

  if (cName) ctx.write(`if (${cName}(out) === INVALID) return INVALID;`);

  return "out";
}
