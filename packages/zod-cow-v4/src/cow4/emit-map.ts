/** Map skeleton: key/value double reference comparison + ordered rebuild of the clean prefix at the first change; the async entry loop follows stock's settlement order. */
import type { CodeCtx } from "./codectx.js";
import { childProduct, emitContainerChecks } from "./emit.js";
import type { Node } from "./product.js";

/* ── map skeleton: key/value double reference comparison + ordered rebuild of the clean prefix at the first change ── */

export function emitCoWMap(ctx: CodeCtx, schema: Node, accessor: string, seen: Set<Node>): string {
  const def = schema._zod.def as { keyType: Node; valueType: Node };
  const childSeen = new Set(seen);
  childSeen.add(schema);

  ctx.write(`if (!(${accessor} instanceof Map)) return INVALID;`);
  const out = ctx.var();
  const dirty = ctx.var();
  // Products are compile-time: hoisted out of the loop emission so the async case can pick its shape
  const keyProduct = childProduct(def.keyType, childSeen, ctx);
  const kf = ctx.addConst(keyProduct.fn);
  const product = childProduct(def.valueType, childSeen, ctx);
  const vf = ctx.addConst(product.fn);
  if (keyProduct.kind === "async" || product.kind === "async") {
    ctx.async = true;
    emitAsyncMapLoop(
      ctx,
      accessor,
      out,
      dirty,
      kf,
      keyProduct.kind === "validator",
      vf,
      product.kind === "validator",
    );
  } else {
    const idx = ctx.var();
    ctx.write(`let ${out} = ${accessor}, ${dirty} = false, ${idx} = 0;`);
    ctx.write(`for (const [kIn, vIn] of ${accessor}) {`);
    ctx.indented(() => {
      // Key: a value position -- a pure key is validated by the validator and its name never changes; an impure key uses the parser product (returning the converted key name)
      let keyExpr = "kIn";
      if (keyProduct.kind === "validator") {
        ctx.write(`if (${kf}(kIn) === INVALID) return INVALID;`);
      } else {
        const ko = ctx.var();
        ctx.write(`const ${ko} = ${kf}(kIn);`);
        ctx.write(`if (${ko} === INVALID) return INVALID;`);
        keyExpr = ko;
      }
      let valExpr = "vIn";
      if (product.kind === "validator") {
        ctx.write(`if (${vf}(vIn) === INVALID) return INVALID;`);
      } else {
        const vo = ctx.var();
        ctx.write(`const ${vo} = ${vf}(vIn);`);
        ctx.write(`if (${vo} === INVALID) return INVALID;`);
        valExpr = vo;
      }
      // Both pure: the name and the value never change, so the loop has no dirty path
      if (keyExpr === "kIn" && valExpr === "vIn") return;
      // Stock sets the parsed pairs into a fresh Map in iteration order, so a transformed key that
      // collides with a later entry is overwritten by it and the output keeps the input's order.
      // The first forced change rebuilds the clean prefix (the first `idx` pairs) into an empty Map,
      // a second pass over the input's iterator (#36), and every later pair is written from the
      // single read the loop makes, never `new Map(input)` plus delete/set (#67).
      const clean = [
        keyExpr !== "kIn" ? `${keyExpr} === kIn` : "",
        valExpr !== "vIn" ? `${valExpr} === vIn` : "",
      ]
        .filter(Boolean)
        .join(" && ");
      ctx.write(`if (!${dirty}) {`);
      ctx.indented(() => {
        ctx.write(`if (${clean}) { ${idx}++; continue; }`);
        ctx.write(`${dirty} = true; ${out} = new Map();`);
        ctx.write(
          `let j = 0; for (const e of ${accessor}) { if (j++ === ${idx}) break; ${out}.set(e[0], e[1]); }`,
        );
      });
      ctx.write(`}`);
      ctx.write(`${idx}++;`);
      ctx.write(`${out}.set(${keyExpr}, ${valExpr});`);
    });
    ctx.write(`}`);
  }

  emitContainerChecks(ctx, schema, accessor, out, `!${dirty}`);
  return out;
}

/**
 * The async entry loop, stock's runtime schedule: key and value products are both started inside
 * the loop; when either is a Promise the pair is logged when `Promise.all([key, value])` settles,
 * otherwise at once (stock's own structure, so the pairs settle in the same order). The output is
 * assembled from the log, each pair read exactly once; the input is shared when the log is in
 * iteration order and every pair came back as itself (review of #70). A validator product answers
 * `true` or `INVALID`, so its output is the input key or value.
 * Log layout: four slots per pair (iteration position, clean flag, output key, output value).
 */
function emitAsyncMapLoop(
  ctx: CodeCtx,
  accessor: string,
  out: string,
  dirty: string,
  kf: string,
  keyIsValidator: boolean,
  vf: string,
  valIsValidator: boolean,
): void {
  const idx = ctx.var();
  const log = ctx.var();
  const proms = ctx.var();
  const ko = keyIsValidator ? "(kr === INVALID ? INVALID : kIn)" : "kr";
  const vo = valIsValidator ? "(vr === INVALID ? INVALID : vIn)" : "vr";
  const entry = `const ko = ${ko}, vo = ${vo}; ${log}.push(i, ko === kIn && vo === vIn, ko, vo);`;
  ctx.write(
    `let ${out} = ${accessor}, ${dirty} = false, ${idx} = 0; const ${log} = [], ${proms} = [];`,
  );
  ctx.write(`for (const [kIn, vIn] of ${accessor}) {`);
  ctx.indented(() => {
    ctx.write(`const i = ${idx}++;`);
    ctx.write(`const kp = ${kf}(kIn);`);
    ctx.write(`const vp = ${vf}(vIn);`);
    ctx.write(`if (kp instanceof Promise || vp instanceof Promise) {`);
    ctx.indented(() => {
      ctx.write(`${proms}.push(Promise.all([kp, vp]).then(([kr, vr]) => { ${entry} }));`);
    });
    ctx.write(`} else { const kr = kp, vr = vp; ${entry} }`);
  });
  ctx.write(`}`);
  ctx.write(`if (${proms}.length) await Promise.all(${proms});`);
  ctx.write(`for (let j = 0, n = 0; j < ${log}.length; j += 4, n++) {`);
  ctx.indented(() => {
    ctx.write(`if (${log}[j + 2] === INVALID || ${log}[j + 3] === INVALID) return INVALID;`);
    ctx.write(`if (${log}[j] !== n || !${log}[j + 1]) ${dirty} = true;`);
  });
  ctx.write(`}`);
  ctx.write(
    `if (${dirty}) { ${out} = new Map(); for (let j = 0; j < ${log}.length; j += 4) ${out}.set(${log}[j + 2], ${log}[j + 3]); }`,
  );
}
