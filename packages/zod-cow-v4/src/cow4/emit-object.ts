/**
 * Object skeleton: reference comparison on every key, the input reference when nothing changed,
 * otherwise the output rebuilt in shape order from the captured locals (the official parser's
 * own assembly rules).
 */
import { ZodCompileUnsupportedError } from "zod/v4/core";
import { type CodeCtx, emitOwnSymbolProbe, escKey, unknownStringKeyExpr } from "./codectx.js";
import { containerChecksCall, containerChildFn } from "./emit.js";
import { officialFn } from "./official.js";
import { dropsWhenAbsent, mayOutputUndefined, requiresPresence } from "./predicates.js";
import { type Fn, isAsyncProduct, type Node } from "./product.js";
import { cowSafeContainerForChild, isPure } from "./purity.js";

/* ── object skeleton ── */

/**
 * Two paths, decided at runtime per object:
 *
 *   clean   every key's product returned its input (or validated a pure leaf), in strip mode the
 *           input carries no undeclared string key, and in every mode (unless the tree was
 *           compiled with `ownSymbolKeys: "ignore"`, #43) no undeclared own symbol key: the
 *           container checks run on the input and the input reference is returned;
 *   copy    something changed (a value producer fired, a nested container was copied) or a probe
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
 * the clean path to the compiled parser) exists because stock's rebuild drops own symbol keys in
 * every mode (strict's for...in sees string keys only, so a symbol is never rejected either) and
 * a pass-through has to prove there are none. It runs in all three modes (strip since #33, strict
 * and loose since #42). `ownSymbolKeys: "ignore"` drops it: the input is then returned by
 * reference on the strength of the string probe alone (strip) or of the key comparisons alone
 * (strict, loose), and an undeclared own symbol key survives where stock would drop it.
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

  /**
   * One plan per key, products built up front (shape order, so nested skeletons are built in the
   * order the loop below emits them). `validator`: a pure leaf, the official assertOnly product,
   * output === input (container keys never take it: strip semantics need a CoW sub-skeleton, see
   * cowSafeContainerForChild); `cow`: a container key, the CoW sub-skeleton; `parser`: an impure
   * key, the official parser plus a reference comparison for dirtiness.
   */
  type KeyPlan = {
    key: string | symbol;
    keyExpr: string;
    inVar: string;
    kind: "validator" | "cow" | "parser";
    fnVar: string;
    async: boolean;
  };
  const plans: KeyPlan[] = allKeys.map((key) => {
    const child: Node = shape[key];
    const keyExpr = typeof key === "symbol" ? ctx.addConst(key) : escKey(key);
    let kind: KeyPlan["kind"];
    let fn: Fn;
    if (isPure(child) && !cowSafeContainerForChild(child)) {
      kind = "validator";
      fn = officialFn(child, true);
    } else if (cowSafeContainerForChild(child)) {
      kind = "cow";
      fn = containerChildFn(child, seen, ctx);
    } else {
      kind = "parser";
      fn = officialFn(child, false);
    }
    return {
      key,
      keyExpr,
      inVar: ctx.var(),
      kind,
      fnVar: ctx.addConst(fn),
      async: isAsyncProduct(fn),
    };
  });

  /** The checks on a key's settled result `res` (a call expression or a local) and its dirtiness */
  const emitKeyResult = (p: KeyPlan, res: string): void => {
    const { key, keyExpr, inVar } = p;
    if (p.kind === "validator") {
      ctx.write(`if (${res} === INVALID) return INVALID;`);
      outputs.push({ key, keyExpr, valueVar: inVar });
      return;
    }
    const outVar = ctx.var();
    if (p.kind === "cow") {
      ctx.write(`const ${outVar} = ${res};`);
      ctx.write(`if (${outVar} === INVALID) return INVALID;`);
      // A clean sub-skeleton returns the original reference → equal, not dirty; a dirty one returns a new reference → mark dirty
      ctx.write(`if (${outVar} !== ${inVar}) ${dirty} = true;`);
      outputs.push({ key, keyExpr, valueVar: outVar });
      return;
    }
    const child: Node = shape[key];
    const optoutOptional = child._zod.optin !== undefined && child._zod.optout === "optional";
    if (optoutOptional) {
      // Official optin branch template: an absent key is not a failure, the output is undefined
      ctx.write(`let ${outVar} = ${res};`);
      ctx.write(`if (${outVar} === INVALID) {`);
      ctx.indented(() => {
        ctx.write(`if (${keyExpr} in ${accessor}) return INVALID;`);
        ctx.write(`${outVar} = undefined;`);
      });
      ctx.write(`}`);
    } else {
      ctx.write(`const ${outVar} = ${res};`);
      ctx.write(`if (${outVar} === INVALID) return INVALID;`);
    }
    // Dirtiness: reference comparison. Output undefined with the key absent → treated as unchanged (stock does not materialize the key either)
    ctx.write(
      `if (${outVar} !== ${inVar} && !(${outVar} === undefined && !(${keyExpr} in ${accessor}))) ${dirty} = true;`,
    );
    outputs.push({ key, keyExpr, valueVar: outVar });
  };
  /** Official presence guard: the value-level fast path cannot tell an absent required key from a present-undefined one */
  const emitPresenceGuard = (p: KeyPlan): void => {
    if (requiresPresence(shape[p.key])) {
      ctx.write(`if (!(${p.keyExpr} in ${accessor})) return INVALID;`);
    }
  };

  if (!plans.some((p) => p.async)) {
    // Sync layout: read, call and check each key in shape order
    for (const p of plans) {
      // Read the getter only once (official comment: checks and output assembly must not trigger the getter a second time)
      ctx.write(`const ${p.inVar} = ${accessor}[${p.keyExpr}];`);
      emitPresenceGuard(p);
      emitKeyResult(p, `${p.fnVar}(${p.inVar})`);
    }
  } else {
    // Async layout (#71): stock's runtime starts every key's parse inside its loop and awaits them
    // together, so every product is called in shape order before the first await (a sync child's
    // result is captured, an async child's promise started), one `Promise.all` settles the async
    // ones, and the checks run on the settled results in shape order. Nothing returns between the
    // first start and the `Promise.all`, so a rejected promise is always attached.
    ctx.async = true;
    const started: { p: KeyPlan; resVar: string }[] = [];
    for (const p of plans) {
      ctx.write(`const ${p.inVar} = ${accessor}[${p.keyExpr}];`);
      const resVar = ctx.var();
      ctx.write(`const ${resVar} = ${p.fnVar}(${p.inVar});`);
      started.push({ p, resVar });
    }
    const settled = new Map<KeyPlan, string>();
    const asyncOnes = started.filter((s) => s.p.async);
    for (const s of asyncOnes) settled.set(s.p, ctx.var());
    ctx.write(
      `const [${asyncOnes.map((s) => settled.get(s.p)).join(", ")}] = await Promise.all([${asyncOnes.map((s) => s.resVar).join(", ")}]);`,
    );
    for (const s of started) {
      emitPresenceGuard(s.p);
      emitKeyResult(s.p, settled.get(s.p) ?? s.resVar);
    }
  }

  // Undeclared-key predicate (official for...in template: inherited keys participate, matching the runtime).
  // `for...in` yields string keys only, so the string probe never sees a symbol; own symbols get a probe of their own.
  // The known-key Set is hoisted lazily: a small shape without declared symbols never references it.
  let known: string | null = null;
  const knownSet = () => (known ??= ctx.addConst(new Set(allKeys)));
  let unknownStringKeyProbe: string | null = null;
  const unknownStringKey = () =>
    (unknownStringKeyProbe ??= unknownStringKeyExpr(stringKeys, knownSet));

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
  const checksCall = containerChecksCall(ctx, schema);
  const cName = checksCall ? `${checksCall.awaitKw}${checksCall.name}` : null;

  // ═══ CoW core: the branch the official template does not have ═══
  // Undeclared-key probes, only here: a copy assembled from the declared keys drops undeclared keys
  // by construction, so the probes exist solely to prove that the input can be returned as is.
  // Strip probes for undeclared string keys (shapes without a string key, symbol-only or empty,
  // treat every string key as undeclared, #35); strict rejected them above and loose keeps them, so
  // neither needs that probe. Every mode probes for undeclared own symbol keys (#42), which stock's
  // rebuild drops on every path, unless the tree was compiled with `ownSymbolKeys: "ignore"` (#43).
  const probeSymbols = ctx.options.ownSymbolKeys === "probe";
  ctx.write(`if (!${dirty}) {`);
  ctx.indented(() => {
    if (mode === "strip" || probeSymbols) {
      const extra = ctx.var();
      ctx.write(`let ${extra} = false;`);
      if (mode === "strip") {
        ctx.write(`for (const k in ${accessor}) {`);
        ctx.indented(() => {
          ctx.write(`if (${unknownStringKey()}) { ${extra} = true; break; }`);
        });
        ctx.write(`}`);
      }
      if (probeSymbols) {
        if (mode === "strip") {
          // Only worth asking when the string probe found nothing
          ctx.write(`if (!${extra}) {`);
          ctx.indented(() => emitOwnSymbolProbe(ctx, accessor, extra, symbolKeys, knownSet));
          ctx.write(`}`);
        } else {
          emitOwnSymbolProbe(ctx, accessor, extra, symbolKeys, knownSet);
        }
      }
      ctx.write(`if (!${extra}) {`);
      ctx.indented(() => {
        if (cName) ctx.write(`if ((${cName}(${accessor})) === INVALID) return INVALID;`);
        ctx.write(`return ${accessor};`);
      });
      ctx.write(`}`);
    } else {
      if (cName) ctx.write(`if ((${cName}(${accessor})) === INVALID) return INVALID;`);
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

  if (cName) ctx.write(`if ((${cName}(out)) === INVALID) return INVALID;`);

  return "out";
}
