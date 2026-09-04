/** Object skeleton: reference comparison + conditional {...input} copy. */
import { ZodCompileUnsupportedError } from "zod4/v4/core";
import { type CodeCtx, escKey } from "./codectx.js";
import { containerChecksFn, containerChildFn } from "./emit.js";
import { officialFn } from "./official.js";
import { requiresPresence } from "./predicates.js";
import { isAsyncProduct, type Node } from "./product.js";
import { cowSafeContainerForChild, isPure } from "./purity.js";

/* ── object skeleton: reference comparison + conditional {...input} copy ── */

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
  const extra = ctx.var();
  ctx.write(`let ${dirty} = false, ${extra} = false;`);

  /** Impure keys the copy branch has to overwrite */
  const writeback: { keyExpr: string; outVar: string; inVar: string }[] = [];

  for (const key of allKeys) {
    const child: Node = shape[key];
    const keyExpr = typeof key === "symbol" ? ctx.addConst(key) : escKey(key);
    const inVar = ctx.var();
    // Read the getter only once (official comment: checks and output assembly must not trigger the getter a second time)
    ctx.write(`const ${inVar} = ${accessor}[${keyExpr}];`);

    // Official presence guard: the value-level fast path cannot tell an absent required key from a present-undefined one
    if (requiresPresence(child)) {
      ctx.write(
        `if (!(${typeof key === "symbol" ? keyExpr : keyExpr} in ${accessor})) return INVALID;`,
      );
    }

    if (isPure(child) && !cowSafeContainerForChild(child)) {
      // Pure leaf key: the official assertOnly product. Output === input, {...input} already preserves it, no write-back.
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
      continue;
    }

    if (cowSafeContainerForChild(child)) {
      // Container key (including optional/nullable wrapping): CoW sub-skeleton (nested CoW + strip semantics intact)
      const vFn = containerChildFn(child, seen);
      const v = ctx.addConst(vFn);
      const isA = isAsyncProduct(vFn);
      if (isA) ctx.async = true;
      const outVar = ctx.var();
      ctx.write(`const ${outVar} = ${isA ? "await " : ""}${v}(${inVar});`);
      ctx.write(`if (${outVar} === INVALID) return INVALID;`);
      // A clean sub-skeleton returns the original reference → equal, not dirty; a dirty one returns a new reference → mark dirty + write back
      ctx.write(`if (${outVar} !== ${inVar}) ${dirty} = true;`);
      writeback.push({ keyExpr, outVar, inVar });
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
    writeback.push({ keyExpr, outVar, inVar });
  }

  // Extra-key detection (official for...in template: inherited keys participate, matching the runtime)
  if (mode !== "loose" && (mode === "strict" || stringKeys.length > 0 || allKeys.length === 0)) {
    const known = ctx.addConst(new Set(allKeys));
    if (mode === "strict") {
      ctx.write(`for (const k in ${accessor}) {`);
      ctx.indented(() => {
        ctx.write(`if (!${known}.has(k)) return INVALID;`);
      });
      ctx.write(`}`);
    } else {
      // strip: zero-allocation early-exit probe
      ctx.write(`for (const k in ${accessor}) {`);
      ctx.indented(() => {
        ctx.write(`if (!${known}.has(k)) { ${extra} = true; break; }`);
      });
      ctx.write(`}`);
      // Official strip discards extra enumerable own symbol keys while {...input} keeps them → probe for them
      ctx.write(`for (const s of Object.getOwnPropertySymbols(${accessor})) {`);
      ctx.indented(() => {
        ctx.write(`if (!${known}.has(s)) { ${extra} = true; break; }`);
      });
      ctx.write(`}`);
    }
  }

  // The container's own checks (.refine/.min and friends): a standalone validation subroutine,
  // called on both paths to match stock semantics (checks apply to the final output: the input when clean, the rebuilt out when dirty)
  const checksFn = containerChecksFn(schema);
  const cName = checksFn ? ctx.addConst(checksFn) : null;

  // ═══ CoW core: the branch the official template does not have ═══
  ctx.write(`if (!${dirty} && !${extra}) {`);
  ctx.indented(() => {
    if (cName) ctx.write(`if (${cName}(${accessor}) === INVALID) return INVALID;`);
    ctx.write(`return ${accessor};`);
  });
  ctx.write(`}`);
  ctx.write(`const out = { ...${accessor} };`);

  for (const { keyExpr, outVar, inVar } of writeback) {
    // Aligned with the official mayOutputUndefined assembly rule:
    //   value changed → write; output undefined and key absent → do not materialize; output undefined and key present → write undefined
    ctx.write(`if (${outVar} !== ${inVar}) {`);
    ctx.indented(() => {
      ctx.write(`if (${outVar} !== undefined) out[${keyExpr}] = ${outVar};`);
      ctx.write(`else if (${keyExpr} in ${accessor}) out[${keyExpr}] = undefined;`);
    });
    ctx.write(`}`);
  }

  if (mode === "strip") {
    ctx.write(`if (${extra}) {`);
    ctx.indented(() => {
      const known2 = ctx.addConst(new Set(allKeys));
      ctx.write(`for (const k in ${accessor}) if (!${known2}.has(k)) delete out[k];`);
      ctx.write(
        `for (const s of Object.getOwnPropertySymbols(${accessor})) if (!${known2}.has(s)) delete out[s];`,
      );
    });
    ctx.write(`}`);
  }

  if (cName) ctx.write(`if (${cName}(out) === INVALID) return INVALID;`);

  return "out";
}
