/** Set skeleton: member reference comparison + ordered rebuild of the clean prefix at the first change; the async member loop follows stock's settlement order. */
import type { CodeCtx } from "./codectx.js";
import { childProduct, containerChecksFn } from "./emit.js";
import type { Node } from "./product.js";

/* ── set skeleton: member reference comparison + ordered rebuild of the clean prefix at the first change ── */

export function emitCoWSet(ctx: CodeCtx, schema: Node, accessor: string, seen: Set<Node>): string {
  const def = schema._zod.def as { valueType: Node };
  const childSeen = new Set(seen);
  childSeen.add(schema);

  ctx.write(`if (!(${accessor} instanceof Set)) return INVALID;`);
  const out = ctx.var();
  const dirty = ctx.var();
  const product = childProduct(def.valueType, childSeen, ctx);
  const f = ctx.addConst(product.fn);
  if (product.kind === "async") {
    ctx.async = true;
    emitAsyncSetLoop(ctx, accessor, out, dirty, f);
  } else {
    const idx = ctx.var();
    ctx.write(`let ${out} = ${accessor}, ${dirty} = false, ${idx} = 0;`);
    ctx.write(`for (const vIn of ${accessor}) {`);
    ctx.indented(() => {
      if (product.kind === "validator") {
        // A pure member never changes: the loop has no dirty path (the counter stays unused)
        ctx.write(`if (${f}(vIn) === INVALID) return INVALID;`);
      } else {
        const vo = ctx.var();
        ctx.write(`const ${vo} = ${f}(vIn);`);
        ctx.write(`if (${vo} === INVALID) return INVALID;`);
        // Stock adds the parsed members to a fresh Set in iteration order, so a transformed member
        // that lands on a later member is overwritten by it and the output keeps the input's order.
        // The first forced change rebuilds the clean prefix (the first `idx` members) into an empty
        // Set, a second pass over the input's iterator (#36), and every later member is written from
        // the single read the loop makes, never `new Set(input)` plus delete/add (#67).
        // NaN false positive: vo !== vIn is always true for NaN → an over-copy with the same members.
        ctx.write(`if (!${dirty}) {`);
        ctx.indented(() => {
          ctx.write(`if (${vo} === vIn) { ${idx}++; continue; }`);
          ctx.write(`${dirty} = true; ${out} = new Set();`);
          ctx.write(
            `let j = 0; for (const m of ${accessor}) { if (j++ === ${idx}) break; ${out}.add(m); }`,
          );
        });
        ctx.write(`}`);
        ctx.write(`${idx}++;`);
        ctx.write(`${out}.add(${vo});`);
      }
    });
    ctx.write(`}`);
  }

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
 * The async member loop, stock's runtime schedule: every member's product is started inside the
 * loop; a sync result is logged at once, an async one when its promise settles, so the log holds
 * stock's write order (sync members first, in iteration order, then the async ones as they
 * settle). The output is assembled from the log, each member read exactly once. The input is
 * shared when the log is in iteration order and every member came back as itself (review of #70).
 * Log layout: three slots per member (iteration position, clean flag, output value).
 */
function emitAsyncSetLoop(
  ctx: CodeCtx,
  accessor: string,
  out: string,
  dirty: string,
  f: string,
): void {
  const idx = ctx.var();
  const log = ctx.var();
  const proms = ctx.var();
  ctx.write(
    `let ${out} = ${accessor}, ${dirty} = false, ${idx} = 0; const ${log} = [], ${proms} = [];`,
  );
  ctx.write(`for (const vIn of ${accessor}) {`);
  ctx.indented(() => {
    ctx.write(`const i = ${idx}++;`);
    ctx.write(`const r = ${f}(vIn);`);
    ctx.write(
      `if (r instanceof Promise) ${proms}.push(r.then((vo) => { ${log}.push(i, vo === vIn, vo); }));`,
    );
    ctx.write(`else ${log}.push(i, r === vIn, r);`);
  });
  ctx.write(`}`);
  ctx.write(`if (${proms}.length) await Promise.all(${proms});`);
  ctx.write(`for (let j = 0, n = 0; j < ${log}.length; j += 3, n++) {`);
  ctx.indented(() => {
    ctx.write(`if (${log}[j + 2] === INVALID) return INVALID;`);
    ctx.write(`if (${log}[j] !== n || !${log}[j + 1]) ${dirty} = true;`);
  });
  ctx.write(`}`);
  ctx.write(
    `if (${dirty}) { ${out} = new Set(); for (let j = 2; j < ${log}.length; j += 3) ${out}.add(${log}[j]); }`,
  );
}
