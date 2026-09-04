/** Record skeleton: key-name/value double reference comparison + conditional {...input} copy. */
import { regexes, util, ZodCompileUnsupportedError } from "zod4/v4/core";
import { type CodeCtx, escKey } from "./codectx.js";
import { childProduct, containerChecksFn } from "./emit.js";
import { officialFn } from "./official.js";
import { isAsyncProduct, type Node } from "./product.js";

/* ── record 骨架：键名/键值双引用比较 + {...input} 条件拷贝 ── */

/**
 * 三条编译期路径（与官方 generateRecordCheck 一一对应，激进全覆盖）：
 *   A. enum 声明驱动键（keyType._zod.values 存在且非 partial）：
 *      官方输出 = 按声明序无条件物化全部声明键 + 未知键 strict 拒绝；
 *      骨架：缺失声明键（stock 会物化）→ 判脏；重建分支逐声明键无条件写回。
 *   B. 一般键（string format / number 数值重试 / partialRecord）：
 *      keyFast 产物 + 数值键重试；键名引用比较（outKey !== k → 删旧键写新键）；
 *      loose 保留键 schema 拒绝的键（{...input} 天然保留，值不校验——官方同款）。
 *   C. bare-string 键（z.record(z.string(), v)）：键名恒不变，纯值比较。
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

  // 官方守卫同款：util.isPlainObject（拒绝 Date/Map/class 实例等）
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
    /* ── 路径 A：声明驱动 ── */
    /** 拷贝分支的写回计划：先收集，循环后统一发射（out = {...input} 赋值之后） */
    const writebacks: { keyExpr: string; inVar: string; outVar: string | null }[] = [];

    for (const kv of keyValues) {
      if (typeof kv !== "string" && typeof kv !== "number" && typeof kv !== "symbol") {
        throw new ZodCompileUnsupportedError(`record key value ${String(kv)}`);
      }
      const inputKey: string | symbol = typeof kv === "number" ? kv.toString() : kv;
      if (inputKey === "__proto__") throw new ZodCompileUnsupportedError('record key "__proto__"');
      const keyExpr = typeof inputKey === "symbol" ? ctx.addConst(inputKey) : escKey(inputKey);
      const inVar = ctx.var();
      // 官方对常量键跑 keyType 校验（enum has，编译期已知恒真）→ 省略
      ctx.write(`const ${inVar} = ${accessor}[${keyExpr}];`);
      const product = childProduct(def.valueType, childSeen);
      const f = ctx.addConst(product.fn);
      const pAsync = product.kind === "async";
      if (pAsync) ctx.async = true;
      const awaitKw = pAsync ? "await " : "";
      // 缺失声明键：官方无条件物化（值=undefined）→ 输入缺失即脏
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
    // 未知键：官方 enum record 是 strict（for...in → INVALID）
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
        // validator 产物：值=输入（present 时 inVar 即原值；缺失时 inVar===undefined）
        ctx.write(`${out}[${w.keyExpr}] = ${w.inVar};`);
      } else {
        // 官方无条件写声明键（含 undefined 值）
        ctx.write(`${out}[${w.keyExpr}] = ${w.outVar};`);
      }
    }
    return out;
  }

  /* ── 路径 B/C：遍历输入键 ── */
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
    /* ── 路径 C：键名恒不变 ── */
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
    /* ── 路径 B：keyFast + 数值重试 + 键名比较 ── */
    // 官方 keyFast = compileFn(keyType)（parser 产物：返回校验/转换后的键名）；async 键 schema → async 岛
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
        // loose：键 schema 拒绝的键原样保留（值不校验）；{...input} 已带原值，无需写回——官方同款
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

  // 容器自身 checks（refine 等；record 无 size check）
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
 * record 值处理的两种发射形态（变量全部参数化，杜绝写死变量名）：
 *   validator 产物：只答成败，值=输入，无拷贝；
 *   parser/cow 产物：返回值，引用比较判脏 + 首脏 {...accessor} 浅拷贝 + 写回。
 * 路径 B 额外做键名比较（outKey !== k → delete 旧键、写新键）。
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
