/**
 * Union skeleton: each option's product tried in stock's order, the first non-INVALID result wins,
 * a discriminated union dispatching on the discriminator (#58).
 */
import { ZodCompileUnsupportedError } from "zod/v4/core";
import { type CodeCtx, escKey } from "./codectx.js";
import { type ChildProduct, childProduct, containerChecksCall } from "./emit.js";
import { officialFn } from "./official.js";
import { isAsyncProduct, type Node } from "./product.js";

/* ── union skeleton ── */

/**
 * Mirrors stock's `generateUnionCheck` / `generateDiscriminatedUnionCheck`: a plain union is a
 * chain of tries (`let x = try0; if (x === INVALID) x = try1; …`), a discriminated union reads the
 * discriminator once and dispatches on each option's static values; the union's own checks (the
 * `.refine` predicates `unionSkeletonOk` admits) run on the winning value. Where stock's chain
 * inlines each option's codegen in an IIFE, this skeleton gives every option the product
 * `childProduct` selects: a container option (or an optional / nullable chain ending in one, or a
 * nested union with such an option) gets its own CoW sub-skeleton, so a clean input comes back by
 * reference from the matching option and the parent's reference comparison sees no dirt; a dirty
 * option returns its copy and only the path to the root is copied. A pure leaf option is the
 * official validator (a hit hands the input back), an impure leaf the official parser.
 *
 * An option whose product is async (an async refine anywhere under it) keeps the route the union
 * had before this skeleton: the whole union becomes the official product, an async island that
 * runs stock's runtime, which starts every option and picks the first success. A sequential chain
 * of awaits would reproduce the output but not the side effects of the later options, so the
 * skeleton does not attempt it. The sub-skeletons built for the options are dropped from the
 * debug dump, as `childProduct` drops a replaced sub-skeleton.
 */
export function emitCoWUnion(
  ctx: CodeCtx,
  schema: Node,
  accessor: string,
  seen: Set<Node>,
): string {
  const def = schema._zod.def;
  const options: Node[] = def.options;
  const childSeen = new Set(seen);
  childSeen.add(schema);

  // Every option's product first: an async option is known before a line is emitted
  const mark = ctx.sources.length;
  const products: ChildProduct[] = options.map((o) => childProduct(o, childSeen, ctx));
  if (products.some((p) => p.kind === "async")) {
    ctx.sources.length = mark;
    return emitOfficialUnion(ctx, schema, accessor);
  }

  /** The expression that tries option `p` on the input: the input itself on a validator hit, the product's output otherwise */
  const tryExpr = (p: ChildProduct): string => {
    const c = ctx.addConst(p.fn);
    return p.kind === "validator"
      ? `(${c}(${accessor}) === INVALID ? INVALID : ${accessor})`
      : `${c}(${accessor})`;
  };

  const out = ctx.var();
  if (def.discriminator) {
    // Stock's discriminated dispatch: the discriminator read once (through `?.`, so a primitive
    // input reads `undefined` and falls into the rejecting branch unless it happens to carry the
    // property), one branch per option over its static values, no match → INVALID
    const disc = ctx.var();
    ctx.write(`const ${disc} = ${accessor}?.[${escKey(def.discriminator)}];`);
    ctx.write(`let ${out};`);
    options.forEach((option, i) => {
      const values: Set<unknown> = option._zod.propValues[def.discriminator];
      const conds = Array.from(values, (v) => literalEquality(ctx, disc, v));
      ctx.write(
        `${i === 0 ? "if" : "else if"} (${conds.join(" || ")}) ${out} = ${tryExpr(products[i]!)};`,
      );
    });
    ctx.write(`else return INVALID;`);
  } else {
    products.forEach((p, i) => {
      if (i === 0) ctx.write(`let ${out} = ${tryExpr(p)};`);
      else ctx.write(`if (${out} === INVALID) ${out} = ${tryExpr(p)};`);
    });
  }
  ctx.write(`if (${out} === INVALID) return INVALID;`);

  // The union's own checks run on the winning value (stock: after the option chain, on its output)
  const checks = containerChecksCall(ctx, schema);
  if (checks)
    ctx.write(`if ((${checks.awaitKw}${checks.name}(${out})) === INVALID) return INVALID;`);
  return out;
}

/** The official product for the whole union (the route of `emitNode` for an impure subtree): an async island here */
function emitOfficialUnion(ctx: CodeCtx, schema: Node, accessor: string): string {
  const fnC = officialFn(schema, false);
  const fn = ctx.addConst(fnC);
  const isAsync = isAsyncProduct(fnC);
  if (isAsync) ctx.async = true;
  const out = ctx.var();
  ctx.write(`const ${out} = ${isAsync ? "await " : ""}${fn}(${accessor});`);
  ctx.write(`if (${out} === INVALID) return INVALID;`);
  return out;
}

/** Stock's `literalEquality`: the comparison of the discriminator read against one static value */
function literalEquality(ctx: CodeCtx, acc: string, value: unknown): string {
  if (typeof value === "string") return `${acc} === ${escKey(value)}`;
  if (typeof value === "number") {
    return Number.isNaN(value) ? `Number.isNaN(${acc})` : `${acc} === ${value}`;
  }
  if (typeof value === "boolean") return `${acc} === ${value}`;
  if (value === null) return `${acc} === null`;
  if (value === undefined) return `${acc} === undefined`;
  if (typeof value === "bigint") return `${acc} === ${value}n`;
  if (typeof value === "symbol") return `${acc} === ${ctx.addConst(value)}`;
  // unionSkeletonOk admits the value types above only, so this is unreachable
  throw new ZodCompileUnsupportedError(`literal discriminator value ${String(value)}`);
}
