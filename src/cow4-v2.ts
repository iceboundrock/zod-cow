/**
 * zc-v2 —— CoW 容器修饰层（复用 zod4 官方 codegen 作为语义后端）。
 *
 * ═══════════════════════════════════════════════════════════════════
 *  设计原则：zod4（>=4.1）自带的 JIT 编译器（src/v4/core/compile.ts，
 *  经 "zod/compile" 或 z.compile() 暴露）已经把全部校验/变换语义编译成
 *  单体函数。本层不再自研语义 codegen，只做三件事：
 *
 *  1. 纯度分析（保守白名单）：判定一棵子树的 parse 输出是否必然 === 输入。
 *     纯净子树 → 直接复用官方 assertOnly 产物（bag.validator 同款，
 *     校验语义完整、零输出构造）；非纯净子树 → 复用官方 parser 产物，
 *     用引用比较（out !== in）检测"值产生器"是否实际点火。
 *
 *  2. 容器 CoW 骨架 codegen（object/array 两种）：唯一自研的代码生成，
 *     把官方"无条件新容器"（const out = {...} / new Array(n)）改写为
 *     "引用比较判脏 + 条件浅拷贝"——干净输入返回原引用，被迫才拷贝。
 *     键序/键存在性由 {...input} 扩展天然保真；strip/strict/loose 的
 *     多余键规则与官方 for...in + Set 模板逐行对齐。
 *
 *  3. 失败回退：任何 INVALID 只回传哨兵，顶层统一回退 stock safeParse ——
 *     issues/path/error map/ZodError 构造 100% 官方，零语义复刻。
 *     与全局 "zod/compile" shim 共存：回退路径自动享受官方 JIT。
 *
 *  降级链（每棵子树独立）：
 *    assertOnly 产物 → parser 产物 → runtime island（黑盒 _zod.run）
 *    → 整树 stock（async/递归等本层完全不管的情形）。
 *
 *  复用的官方内部 API（zod4/v4/core 公开 re-export，版本锚点 4.5.4）：
 *    compileFn(schema, { assertOnly?, debug? })  单体函数生成
 *    INVALID                                     失败哨兵
 *    ZodCompileUnsupportedError / ZodCompileAsyncError
 * ═══════════════════════════════════════════════════════════════════
 */
import {
  $ZodAsyncError,
  INVALID,
  compileFn,
  regexes,
  util,
  ZodCompileAsyncError,
  ZodCompileUnsupportedError,
} from "zod4/v4/core";

/* zod4 core 类型（宽松处理，prototype 语义层为准） */
type Node = any;
/** 产物契约：输出值 | INVALID | true(assertOnly)；async 产物返回 Promise<输出值 | INVALID> */
export type Fn = (input: any) => unknown;

/** 产物返回 Promise（async 骨架）的标记 —— buildFn/officialFn/island 挂载，调用点据此发射 await */
export const ZC_ASYNC = Symbol.for("zc-v2.async");

function markAsync(fn: Fn): Fn {
  (fn as unknown as Record<symbol, boolean>)[ZC_ASYNC] = true;
  return fn;
}

export function isAsyncProduct(fn: Fn | null | undefined): boolean {
  return !!fn && (fn as unknown as Record<symbol, boolean>)[ZC_ASYNC] === true;
}

/* ═══════════════════ 代码生成上下文（官方 CodeCtx/Doc 的最小等价物） ═══════════════════ */

class CodeCtx {
  lines: string[] = [];
  indent = 0;
  constNames: string[] = [];
  constValues: unknown[] = [];
  /** 树中含 async 子树 → 产物为 async 函数（await 发射点已就位） */
  async = false;
  private varN = 0;

  /** 官方 addConstant 等价：运行时引用提升为函数参数（c0,c1,…），按 === 去重 */
  addConst(value: unknown): string {
    for (let i = 0; i < this.constValues.length; i++) {
      if (this.constValues[i] === value) return this.constNames[i]!;
    }
    const name = `c${this.constNames.length}`;
    this.constNames.push(name);
    this.constValues.push(value);
    return name;
  }

  var(): string {
    // 前缀 x 区别于官方 v，便于肉眼比对官方 dump
    return `x${this.varN++}`;
  }

  write(line: string): void {
    this.lines.push("  ".repeat(this.indent) + line);
  }

  indented(fn: () => void): void {
    this.indent++;
    fn();
    this.indent--;
  }
}

/** 编译期已知字符串键的源码转义（官方 util.esc 语义的最小覆盖） */
function escKey(k: string): string {
  return JSON.stringify(k);
}

/* ═══════════════════ 语义谓词（照抄官方 compile.ts，版本锚点 4.5.4） ═══════════════════ */

// 官方 fastPathAcceptsAbsence：值级快路径把缺席键读成 undefined，
// 这些 schema 会把"缺席"误当合法值 —— 官方对此发射 presence guard。
function acceptsAbsence(schema: Node): boolean {
  const def = schema._zod.def;
  switch (def.type) {
    case "any":
    case "unknown":
    case "undefined":
    case "void":
    case "default":
    case "prefault":
    case "transform":
    case "custom":
    case "lazy":
      return true;
    case "string":
    case "number":
    case "boolean":
    case "bigint":
    case "symbol":
    case "null":
    case "never":
    case "nan":
    case "date":
    case "object":
    case "array":
    case "tuple":
    case "record":
    case "map":
    case "set":
    case "file":
    case "template_literal":
      return false;
    case "nonoptional":
    case "optional":
    case "nullable":
    case "readonly":
    case "success":
      return def.innerType ? acceptsAbsence(def.innerType) : true;
    case "literal":
      return !!def.values?.includes(undefined);
    case "enum":
      return !!schema._zod.values?.has(undefined);
    case "catch":
      return true;
    case "union":
      return def.options ? def.options.some(acceptsAbsence) : true;
    case "intersection":
      if (!def.left || !def.right) return true;
      return acceptsAbsence(def.left) && acceptsAbsence(def.right);
    case "pipe":
      return def.in ? acceptsAbsence(def.in) : true;
    default:
      return true;
  }
}

// 官方 requiresPresenceCheck：非 optin 键但快路径接受缺席 → 需要 in 探测
function requiresPresence(schema: Node): boolean {
  return schema._zod.optin === undefined && acceptsAbsence(schema);
}

// 官方 mayOutputUndefined：输出组装时该键是否可能产出 undefined
// （决定拷贝分支对 absent/present-undefined 键的写入规则）
// biome-ignore lint/correctness/noUnusedVariables: reference copy of zod's predicate, kept for version anchoring (see AGENTS.md)
function mayOutputUndefined(schema: Node): boolean {
  const def = schema._zod.def;
  switch (def.type) {
    case "string":
    case "number":
    case "boolean":
    case "bigint":
    case "symbol":
    case "null":
    case "nan":
    case "date":
    case "object":
    case "array":
    case "tuple":
    case "record":
    case "map":
    case "set":
    case "file":
    case "template_literal":
    case "never":
    case "success":
      return false;
    case "literal":
      return !!def.values?.includes(undefined);
    case "enum":
      return !!schema._zod.values?.has(undefined);
    case "optional":
      return true;
    case "nullable":
    case "readonly":
    case "nonoptional":
      return def.innerType ? mayOutputUndefined(def.innerType) : true;
    case "union":
      return def.options ? def.options.some(mayOutputUndefined) : true;
    case "intersection":
      return !def.left || !def.right || mayOutputUndefined(def.left) || mayOutputUndefined(def.right);
    case "pipe":
      return def.out ? mayOutputUndefined(def.out) : true;
    default:
      return true; // any/unknown/undefined/void/default/prefault/transform/custom/lazy/catch
  }
}

/* ═══════════════════ 纯度分析（保守白名单） ═══════════════════ */
/**
 * 纯 = （在本层组合下）校验通过 ⇒ 输出必然 === 输入引用，且无副作用。
 * 纯净子树走官方 assertOnly 产物（校验完整、零构造）；
 * 拿不准的一律非纯（走官方 parser 产物 + 引用比较，正确性无损）。
 */
function isPure(schema: Node): boolean {
  const def = schema._zod.def;
  switch (def.type) {
    // 叶子透传型：官方产物 return accessor ⇒ 输出 === 输入。
    // 前提：叶子自身 checks 无值改写（overwrite/trim/toLowerCase…是值变换！见差分 seed=51）。
    case "string":
    case "number":
    case "boolean":
    case "bigint":
    case "symbol":
    case "null":
    case "undefined":
    case "void":
    case "nan":
    case "date":
    case "any":
    case "unknown":
    case "literal":
    case "enum":
      return leafChecksArePure(schema);
    // 包装型：递归 inner
    case "optional":
    case "nullable":
      return isPure(def.innerType);
    // 容器型：本层骨架接管（strip/strict/loose 均可原引用返回）。
    // 前提：schema 自身 checks 可被骨架安全处理（见 checksAreCowSafe）。
    case "object": {
      if (!checksAreCowSafe(schema)) return false;
      if (def.catchall) {
        const t = def.catchall._zod.def.type;
        if (t === "never") return true; // strict：多余键 → INVALID，干净时原引用
        if ((t === "unknown" || t === "any") && !def.catchall._zod.def.checks?.length) return true; // loose
        return false; // schema 型 catchall：官方 parser island
      }
      for (const k of Object.keys(def.shape)) if (!isPure(def.shape[k])) return false;
      for (const s of Object.getOwnPropertySymbols(def.shape)) if (!isPure(def.shape[s])) return false;
      return true;
    }
    case "array":
      return checksAreCowSafe(schema) && isPure(def.element);
    case "tuple": {
      if (!checksAreCowSafe(schema)) return false;
      for (const it of def.items) if (!isPure(it)) return false;
      if (def.rest && !isPure(def.rest)) return false;
      return true;
    }
    case "union":
      return def.options.every(isPure);
    // freeze 副作用 / 值产生器 / 黑盒：一律非纯
    // readonly（Object.freeze）、default/prefault/catch/coerce、transform/pipe、
    // tuple/record/map/set（官方产物无条件新容器）、intersection（mergeValues）、
    // lazy/custom/nonoptional/success（保守）
    default:
      return false;
  }
}

/** 官方 WHEN_DEFAULTED_CHECKS 同款：length/size 系 check 自带默认 when（_whenHasLength），不算自定义 when */
const WHEN_DEFAULTED_CHECKS = new Set([
  "max_size",
  "min_size",
  "size_equals",
  "max_length",
  "min_length",
  "length_equals",
]);

/** 官方 generateChecks 同款判定：自定义 when（非默认）在快路径无法表达 → 不可编译 */
function hasCustomWhen(d: { check?: string; when?: unknown }): boolean {
  return !!d.when && !WHEN_DEFAULTED_CHECKS.has(d.check as string);
}

/**
 * 叶子（string/number/…）自身 checks 的纯度：
 *   - overwrite（.trim/.toLowerCase/.normalize 等值改写）→ 非纯
 *   - custom 无 fn（superRefine 可能改写 ctx.value）→ 非纯
 *   - 自定义 when 条件（非默认）→ 保守非纯
 *   - 其余（string_format/length/number_format/greater_than/refine 谓词…）→ 纯谓词
 */
function leafChecksArePure(schema: Node): boolean {
  const checks = schema._zod.def.checks;
  if (!checks || checks.length === 0) return true;
  return checks.every((c: Node) => {
    const d = c._zod?.def ?? c;
    if (hasCustomWhen(d)) return false;
    if (d.check === "overwrite") return false;
    if (d.check === "custom") return !!d.fn && !isAsyncFn(d.fn); // async refine 是值产生器时序（非纯）+ 同步产物不可达
    return true;
  });
}

/**
 * 容器（object/array）自身的 def.checks 是否可被 CoW 骨架安全处理：
 *   - 无 checks ✓
 *   - custom 且 def.fn 存在（.refine() 纯谓词，只回答 yes/no，不改值）✓
 *   - min_length / max_length / length_equals（array .min/.max/.length，只读 .length）✓
 * 其余（superRefine 可能改写 ctx.value、overwrite 变换值、自定义 when…）→ 非纯，
 * 该节点整体降级官方 parser 产物（stock 语义，正确性无损）。
 */
function checksAreCowSafe(schema: Node): boolean {
  const checks = schema._zod.def.checks;
  if (!checks || checks.length === 0) return true;
  const def = schema._zod.def;
  const isContainer =
    def.type === "object" || def.type === "array" || def.type === "map" || def.type === "set" || def.type === "tuple";
  if (!isContainer) return false; // record 自身无 size checks；非容器保守拒绝
  return checks.every((c: Node) => {
    const d = c._zod?.def ?? c;
    if (hasCustomWhen(d)) return false;
    if (d.check === "custom") return !!d.fn && !isAsyncFn(d.fn); // superRefine（无 fn）可能改写值 → 拒；async refine 非纯
    if (def.type === "array" && (d.check === "min_length" || d.check === "max_length" || d.check === "length_equals")) {
      return true;
    }
    if ((def.type === "map" || def.type === "set") && (d.check === "min_size" || d.check === "max_size" || d.check === "size_equals")) {
      return true;
    }
    return false;
  });
}

/* ═══════════════════ 官方产物获取（降级链） ═══════════════════ */

function makeIsland(schema: Node): Fn {
  // 官方 runtimeRun 等价：子树黑盒执行，失败 → INVALID。
  // async 经此岛到达同步快路径 → 抛 $ZodAsyncError（官方 compile.js throwAsync 同款语义：
  // 返回 INVALID 会被 union 读成分支拒绝，必须让 throw 存活）。
  return (value: unknown): unknown => {
    const r = schema._zod.run({ value, issues: [] }, {});
    if (r && typeof r.then === "function") throw new $ZodAsyncError();
    return r.issues.length === 0 ? r.value : INVALID;
  };
}

/**
 * async 子树通道：返回 Promise<输出值 | INVALID> 的黑盒岛。
 * 骨架在调用位发射 await 并把 CodeCtx.async 置真 → 整个骨架变 async 函数。
 */
function makeAsyncIsland(schema: Node): Fn {
  return markAsync(async (value: unknown): Promise<unknown> => {
    const r = await schema._zod.run({ value, issues: [] }, {});
    return r.issues.length === 0 ? r.value : INVALID;
  });
}

/**
 * lazy(async·…) 的静态 async 探测：官方 generateLazyCheck 是 runtime island，
 * compileFn 对它不抛 ZodCompileAsyncError，async 会被 Promise 静默传出去 ——
 * 必须在编译期识破，改走 async 岛。其余类型的 async 官方 compileFn 自会抛错，无需此函数。
 */
function subtreeHasAsync(schema: Node, seen: Set<Node> = new Set()): boolean {
  if (seen.has(schema)) return false; // 递归子树（lazy 自引用）——async 与否由首个展开判定
  seen.add(schema);
  const def = schema._zod.def;
  if (def.type === "lazy") {
    try {
      if (subtreeHasAsync(def.getter(), seen)) return true;
    } catch {
      return true; // getter 抛错 → 保守按 async 处理（正确性无损）
    }
  }
  if (isAsyncFn(def.fn) || isAsyncFn(def.transform)) return true;
  const checks: Node[] = def.checks ?? [];
  for (const c of checks) {
    const d = c._zod?.def ?? c;
    if (isAsyncFn(d.fn) || isAsyncFn(c._zod?.check)) return true;
  }
  const kids: Node[] = [];
  if (def.innerType) kids.push(def.innerType);
  if (def.element) kids.push(def.element);
  if (def.keyType) kids.push(def.keyType);
  if (def.valueType) kids.push(def.valueType);
  if (def.in) kids.push(def.in);
  if (def.out) kids.push(def.out);
  if (def.left) kids.push(def.left);
  if (def.right) kids.push(def.right);
  if (def.rest) kids.push(def.rest);
  if (def.catchall) kids.push(def.catchall);
  if (def.items) kids.push(...def.items);
  if (def.options) kids.push(...def.options);
  if (def.shape) {
    for (const k of Object.keys(def.shape)) kids.push(def.shape[k]);
    for (const s of Object.getOwnPropertySymbols(def.shape)) kids.push(def.shape[s]);
  }
  return kids.some((k) => subtreeHasAsync(k, seen));
}

/**
 * 取子树的官方产物。pure → assertOnly validator（校验语义完整，输出=输入）；
 * 否则 → parser（stock 语义输出）。产物生成失败时逐级降级。
 * async 不再向上抛（Task 6）：官方 compileFn 抛 ZodCompileAsyncError 的子树
 * 改走 async 岛（返回 Promise，调用位 await）；lazy(async·…) 由静态探测补漏。
 */
function officialFn(schema: Node, pure: boolean): Fn {
  // 官方对 lazy 产物是 runtime island，内部 async 编译期不报错 → 静态补漏
  if (schema._zod.def.type === "lazy" && subtreeHasAsync(schema)) {
    return makeAsyncIsland(schema);
  }
  if (pure) {
    try {
      return compileFn(schema, { assertOnly: true }) as Fn;
    } catch (e) {
      if (e instanceof ZodCompileAsyncError) return makeAsyncIsland(schema); // isPure 白名单已拦 async，防御性兼得
      // 其余 → 落到 parser（输出值没人读时无害，只是多构造）
    }
  }
  try {
    return compileFn(schema) as Fn;
  } catch (e) {
    if (e instanceof ZodCompileAsyncError) return makeAsyncIsland(schema);
    return makeIsland(schema);
  }
}

/* ═══════════════════ 骨架 codegen ═══════════════════ */

/**
 * 子树编译成独立产物函数（容器子骨架递归入口），失败 → 官方产物/island。
 * seen 向下传递：编译期循环引用防护。
 */
function subFn(schema: Node, seen: Set<Node>): Fn {
  const ctx = new CodeCtx();
  const acc = emitNode(ctx, schema, "input", true, new Set(seen));
  ctx.write(`return ${acc ?? "true"};`);
  return buildFn(ctx);
}

/** 子节点产物的四种形态 */
type ChildProduct =
  | { kind: "validator"; fn: Fn } // 官方 assertOnly：只答成败，输出=输入（不可当值用）
  | { kind: "parser"; fn: Fn } // 官方 parser：返回输出值（stock 语义），配合引用比较判脏
  | { kind: "cow"; fn: Fn } // 本层容器子骨架：干净返回原引用，脏返回新容器
  | { kind: "async"; fn: Fn }; // async 岛/async 子骨架：返回 Promise<输出 | INVALID>，调用位发射 await

function productOf(fn: Fn, syncKind: "parser" | "cow"): ChildProduct {
  return isAsyncProduct(fn) ? { kind: "async", fn } : { kind: syncKind, fn };
}

/**
 * 键位/元素位/值位通用的子节点产物选择（object 键循环、array 元素循环、
 * record 值循环、map 键值、set 成员、tuple 槽位全部走这里）：
 *   容器（含 optional/nullable 包装链）→ CoW 子骨架（strip 语义完整）；
 *   纯净叶子 → 官方 validator；其余 → 官方 parser；async 子树 → async 岛。
 */
function childProduct(child: Node, seen: Set<Node>): ChildProduct {
  if (cowSafeContainerForChild(child)) {
    try {
      return productOf(subFn(child, seen), "cow");
    } catch (e) {
      if (e instanceof ZodCompileUnsupportedError) throw e; // 递归/冷僻特性：向上由上层降级
      // ZodCompileAsyncError 及其它产物生成失败 → 官方产物（async 自动转 async 岛）
      return productOf(officialFn(child, false), "parser");
    }
  }
  const pure = isPure(child);
  const fn = officialFn(child, pure);
  if (isAsyncProduct(fn)) return { kind: "async", fn };
  return { kind: pure ? "validator" : "parser", fn };
}

/**
 * 容器自身 checks 的校验子程序（独立产物函数，只答成败）。
 * 支持：custom(def.fn 谓词，官方 generateCustomRefineCheck 同款模板) /
 * min_length / max_length / length_equals（array .length）。
 * 返回 null 表示存在骨架处理不了的 check（调用方应已通过 checksAreCowSafe 拦截）。
 */
function containerChecksFn(schema: Node): Fn | null {
  const checks: Node[] = schema._zod.def.checks ?? [];
  if (checks.length === 0) return null;
  const ctx = new CodeCtx();
  for (const check of checks) {
    const d = check._zod?.def ?? check;
    if (d.check === "custom" && d.fn) {
      // 官方 generateCustomRefineCheck 的 def.fn 分支同款；
      // async 谓词在 async 骨架（ctx.async）中发射 await，同步骨架中抛错（官方语义）
      const asyncFn = isAsyncFn(d.fn);
      const fnC = ctx.addConst(d.fn);
      const res = ctx.var();
      if (asyncFn) {
        ctx.async = true;
        ctx.write(`const ${res} = await ${fnC}(input);`);
      } else {
        const throwAsyncC = ctx.addConst(throwAsync);
        ctx.write(`const ${res} = ${fnC}(input);`);
        ctx.write(`if (${res} instanceof Promise) ${throwAsyncC}();`);
      }
      ctx.write(`if (!${res}) return INVALID;`);
      continue;
    }
    if (d.check === "min_length") {
      ctx.write(`if (input.length < ${Number(d.minimum)}) return INVALID;`);
      continue;
    }
    if (d.check === "max_length") {
      ctx.write(`if (input.length > ${Number(d.maximum)}) return INVALID;`);
      continue;
    }
    if (d.check === "length_equals") {
      ctx.write(`if (input.length !== ${Number(d.length)}) return INVALID;`);
      continue;
    }
    if (d.check === "min_size") {
      ctx.write(`if (input.size < ${Number(d.minimum)}) return INVALID;`);
      continue;
    }
    if (d.check === "max_size") {
      ctx.write(`if (input.size > ${Number(d.maximum)}) return INVALID;`);
      continue;
    }
    if (d.check === "size_equals") {
      ctx.write(`if (input.size !== ${Number(d.size)}) return INVALID;`);
      continue;
    }
    return null; // 不可表达的 check —— 调用方负责已用 checksAreCowSafe 拦截
  }
  ctx.write("return true;");
  return buildFn(ctx);
}

function isAsyncFn(fn: unknown): boolean {
  return (
    typeof fn === "function" &&
    (fn.constructor.name === "AsyncFunction" || (fn as { [Symbol.toStringTag]?: string })[Symbol.toStringTag] === "AsyncFunction")
  );
}

function throwAsync(): never {
  throw new ZodCompileAsyncError("async function on the synchronous fast path");
}

/**
 * 容器（object/array）在键位/元素位的处理：必须走 CoW 子骨架，
 * 绝不能用官方 assertOnly 产物 —— 官方 validator 会跳过多余键剥离
 * （strip 是输出构造行为，不影响校验成败），导致 strip 语义丢失。
 * 子骨架内完整处理 strip/strict/loose，干净时返回原引用。
 */
function containerChildFn(child: Node, seen: Set<Node>): Fn {
  try {
    return subFn(child, seen);
  } catch (e) {
    if (e instanceof ZodCompileUnsupportedError) throw e; // 递归等：向上由外层决定降级层级
    return officialFn(child, false); // 官方 parser 产物（async 自动转 async 岛），stock 语义正确性无损
  }
}

function buildFn(ctx: CodeCtx): Fn {
  const F = Function;
  const head = ctx.async ? "return async (input) => {" : "return (input) => {";
  const factory = new F(
    "INVALID",
    ...ctx.constNames,
    `${head}\n${ctx.lines.join("\n")}\n}`,
  );
  const fn = factory(INVALID, ...ctx.constValues) as Fn;
  return ctx.async ? markAsync(fn) : fn;
}

/**
 * 穿透 optional/nullable 包装链，判断是否最终落到一个 CoW 可接管的容器
 * （object/array/record/map/set），且整链与容器自身 checks 均安全。
 * 这是键位/元素位/顶层判定「走 CoW 子骨架」的唯一入口 ——
 * 裸判 def.type 会把 optional(object) 误送官方 assertOnly，丢失 strip 剥离语义
 * （差分 seed=104/133/137 实证）。
 */
function cowSafeContainerForChild(child: Node): boolean {
  let cur: Node = child;
  for (;;) {
    if (!leafChecksArePure(cur)) return false; // 包装层上的 refine/overwrite 等
    const t: string = cur._zod.def.type;
    if (t === "object" || t === "array") return checksAreCowSafe(cur);
    if (t === "record") return recordKeyShapeOk(cur) && checksAreCowSafe(cur);
    if (t === "map" || t === "set" || t === "tuple") return checksAreCowSafe(cur);
    if (t === "optional" || t === "nullable") {
      cur = cur._zod.def.innerType;
      continue;
    }
    return false;
  }
}

/**
 * record 键形态是否可骨架化（激进全覆盖）：
 *   - bare-string 键 → 键名恒不变，纯值比较
 *   - 一般键（string format / number 数值重试 / enum 声明驱动 / partialRecord）→
 *     键名引用比较（outKey !== k → 判脏 + 删旧键写新键），声明驱动额外做缺失键物化判定
 *   - 键 schema 带 async/coerce → keyFast 产物生成失败时由 containerChildFn 降级兜底
 */
function recordKeyShapeOk(record: Node): boolean {
  void record; // 全部键形态均已覆盖；保留谓词便于后续收窄
  return true;
}

/**
 * optional/nullable 包装链包着的容器骨架：沿链发射壳检查（null→null，
 * undefined→undefined，值透传），到容器后走普通 CoW 骨架。
 */
function emitBoxedContainer(ctx: CodeCtx, schema: Node, accessor: string, seen: Set<Node>): string {
  let cur: Node = schema;
  for (;;) {
    const def = cur._zod.def;
    if (def.type === "nullable") {
      ctx.write(`if (${accessor} === null) return ${accessor};`);
      cur = def.innerType;
      continue;
    }
    if (def.type === "optional") {
      ctx.write(`if (${accessor} === undefined) return ${accessor};`);
      cur = def.innerType;
      continue;
    }
    break;
  }
  const t2: string = cur._zod.def.type;
  if (t2 === "object") return emitCoWObject(ctx, cur, accessor, seen);
  if (t2 === "array") return emitCoWArray(ctx, cur, accessor, seen);
  if (t2 === "tuple") return emitCoWTuple(ctx, cur, accessor, seen);
  if (t2 === "record") return emitCoWRecord(ctx, cur, accessor, seen);
  if (t2 === "map") return emitCoWMap(ctx, cur, accessor, seen);
  return emitCoWSet(ctx, cur, accessor, seen);
}

/**
 * 向 ctx 发射 schema 的校验/CoW 代码，返回输出 accessor（needsValue=false 时可能为 null）。
 * seen：编译期循环引用防护 —— 递归子树不再展开，交官方产物/岛。
 */
function emitNode(ctx: CodeCtx, schema: Node, accessor: string, needsValue: boolean, seen: Set<Node>): string | null {
  const def = schema._zod.def;
  const t: string = def.type;
  if (needsValue) {
    // 容器（含 optional/nullable 包装链）→ CoW 骨架
    if (
      (t === "object" || t === "array" || t === "tuple" || t === "record" || t === "map" || t === "set" || t === "optional" || t === "nullable") &&
      cowSafeContainerForChild(schema)
    ) {
      return emitBoxedContainer(ctx, schema, accessor, seen);
    }
  }
  // 其余一切类型：官方产物黑盒调用
  const pure = isPure(schema);
  if (pure) {
    // 纯子树：官方 assertOnly 产物只答成败，输出 = 输入引用（纯度定义）。
    // validator 产物不可得时落官方 parser（值可能≠输入，走非纯路径）；
    // 纯子树理论上无 async（白名单已拦），防御性兼得转 async 岛。
    let v: Fn | null = null;
    try {
      v = compileFn(schema, { assertOnly: true }) as Fn;
    } catch (e) {
      if (e instanceof ZodCompileAsyncError) {
        const f = ctx.addConst(makeAsyncIsland(schema));
        ctx.async = true;
        ctx.write(`if ((await ${f}(${accessor})) === INVALID) return INVALID;`);
        // 纯子树校验通过 ⇒ 输出 = 输入引用，accessor 即输出
        return needsValue ? accessor : null;
      }
      v = null;
    }
    if (v) {
      const c = ctx.addConst(v);
      ctx.write(`if (${c}(${accessor}) === INVALID) return INVALID;`);
      return needsValue ? accessor : null;
    }
  }
  const fnC = officialFn(schema, false);
  const fn = ctx.addConst(fnC);
  if (isAsyncProduct(fnC)) ctx.async = true;
  const awaitKw = isAsyncProduct(fnC) ? "await " : "";
  if (!needsValue) {
    ctx.write(`if ((${awaitKw}${fn}(${accessor})) === INVALID) return INVALID;`);
    return null;
  }
  const out = ctx.var();
  ctx.write(`const ${out} = ${awaitKw}${fn}(${accessor});`);
  ctx.write(`if (${out} === INVALID) return INVALID;`);
  return out;
}

/* ── object 骨架：引用比较 + {...input} 条件拷贝 ── */

function emitCoWObject(ctx: CodeCtx, schema: Node, accessor: string, seen: Set<Node>): string {
  const def = schema._zod.def;
  if (seen.has(schema)) throw new ZodCompileUnsupportedError("recursive object");
  seen.add(schema);

  // 容器守卫（官方模板原文）
  ctx.write(`if (typeof ${accessor} !== "object" || ${accessor} === null || Array.isArray(${accessor})) return INVALID;`);

  const shape = def.shape;
  const stringKeys = Object.keys(shape);
  const symbolKeys = Object.getOwnPropertySymbols(shape);
  const allKeys: (string | symbol)[] = [...stringKeys, ...symbolKeys];

  // __proto__ 形状键：官方同样拒绝（字面量赋值会改原型）
  if (stringKeys.includes("__proto__")) throw new ZodCompileUnsupportedError('object shape key "__proto__"');

  // catchall 模式分类（官方 unknownKeysMode 同款判定）
  let mode: "strip" | "strict" | "loose" = "strip";
  if (def.catchall) {
    const t = def.catchall._zod.def.type;
    if (t === "never") mode = "strict";
    else if ((t === "unknown" || t === "any") && !def.catchall._zod.def.checks?.length) mode = "loose";
    else throw new ZodCompileUnsupportedError("schema catchall");
  }

  const dirty = ctx.var();
  const extra = ctx.var();
  ctx.write(`let ${dirty} = false, ${extra} = false;`);

  /** 拷贝分支需要覆写的非纯键 */
  const writeback: { keyExpr: string; outVar: string; inVar: string }[] = [];

  for (const key of allKeys) {
    const child: Node = shape[key];
    const keyExpr = typeof key === "symbol" ? ctx.addConst(key) : escKey(key);
    const inVar = ctx.var();
    // getter 只读一次（官方注释：checks 与输出组装不得二次触发 getter）
    ctx.write(`const ${inVar} = ${accessor}[${keyExpr}];`);

    // 官方 presence guard：值级快路径无法区分缺席与 undefined 的 required 键
    if (requiresPresence(child)) {
      ctx.write(`if (!(${typeof key === "symbol" ? keyExpr : keyExpr} in ${accessor})) return INVALID;`);
    }

    if (isPure(child) && !cowSafeContainerForChild(child)) {
      // 纯净叶子键：官方 assertOnly 产物。输出 === 输入，{...input} 已保真，无写回。
      // （容器键不走此分支：strip 剥离语义需要 CoW 子骨架，见 cowSafeContainerForChild）
      const vFn = officialFn(child, true);
      const v = ctx.addConst(vFn);
      if (isAsyncProduct(vFn)) {
        // 纯键理论上无 async；防御性兼得（async validator await 后输出=输入）
        ctx.async = true;
        ctx.write(`if ((await ${v}(${inVar})) === INVALID) return INVALID;`);
      } else {
        ctx.write(`if (${v}(${inVar}) === INVALID) return INVALID;`);
      }
      continue;
    }

    if (cowSafeContainerForChild(child)) {
      // 容器键（含 optional/nullable 包装）：CoW 子骨架（嵌套 CoW + strip 语义完整）
      const vFn = containerChildFn(child, seen);
      const v = ctx.addConst(vFn);
      const isA = isAsyncProduct(vFn);
      if (isA) ctx.async = true;
      const outVar = ctx.var();
      ctx.write(`const ${outVar} = ${isA ? "await " : ""}${v}(${inVar});`);
      ctx.write(`if (${outVar} === INVALID) return INVALID;`);
      // 子骨架干净时返回原引用 → 相等不判脏；脏时新引用 → 判脏 + 写回
      ctx.write(`if (${outVar} !== ${inVar}) ${dirty} = true;`);
      writeback.push({ keyExpr, outVar, inVar });
      continue;
    }

    // 非纯键：官方 parser 产物 + 引用比较判脏
    const vFn = officialFn(child, false);
    const v = ctx.addConst(vFn);
    const isA = isAsyncProduct(vFn);
    if (isA) ctx.async = true;
    const awaitKw = isA ? "await " : "";
    const outVar = ctx.var();
    const optoutOptional = child._zod.optin !== undefined && child._zod.optout === "optional";
    if (optoutOptional) {
      // 官方 optin 分支模板：缺席键不判失败，输出 undefined
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

    // 脏判定：引用比较。输出 undefined 且键缺席 → 视为未变（stock 亦不物化该键）
    ctx.write(`if (${outVar} !== ${inVar} && !(${outVar} === undefined && !(${keyExpr} in ${accessor}))) ${dirty} = true;`);
    writeback.push({ keyExpr, outVar, inVar });
  }

  // 多余键探测（官方 for...in 模板：继承键参与，与 runtime 一致）
  if (mode !== "loose" && (mode === "strict" || stringKeys.length > 0 || allKeys.length === 0)) {
    const known = ctx.addConst(new Set(allKeys));
    if (mode === "strict") {
      ctx.write(`for (const k in ${accessor}) {`);
      ctx.indented(() => {
        ctx.write(`if (!${known}.has(k)) return INVALID;`);
      });
      ctx.write(`}`);
    } else {
      // strip：零分配早退探测
      ctx.write(`for (const k in ${accessor}) {`);
      ctx.indented(() => {
        ctx.write(`if (!${known}.has(k)) { ${extra} = true; break; }`);
      });
      ctx.write(`}`);
      // 官方 strip 会丢弃 enumerable own symbol 多余键；{...input} 会保留 → 探测之
      ctx.write(`for (const s of Object.getOwnPropertySymbols(${accessor})) {`);
      ctx.indented(() => {
        ctx.write(`if (!${known}.has(s)) { ${extra} = true; break; }`);
      });
      ctx.write(`}`);
    }
  }

  // 容器自身 checks（.refine/.min 等）：独立校验子程序，
  // 双路径调用对齐 stock 语义（checks 作用于最终输出：干净时=输入，脏时=重建后的 out）
  const checksFn = containerChecksFn(schema);
  const cName = checksFn ? ctx.addConst(checksFn) : null;

  // ═══ CoW 核心：官方模板没有的分支 ═══
  ctx.write(`if (!${dirty} && !${extra}) {`);
  ctx.indented(() => {
    if (cName) ctx.write(`if (${cName}(${accessor}) === INVALID) return INVALID;`);
    ctx.write(`return ${accessor};`);
  });
  ctx.write(`}`);
  ctx.write(`const out = { ...${accessor} };`);

  for (const { keyExpr, outVar, inVar } of writeback) {
    // 对齐官方 mayOutputUndefined 组装规则：
    //   值变 → 写；输出 undefined 且键缺席 → 不物化；输出 undefined 且键在 → 写 undefined
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
      ctx.write(`for (const s of Object.getOwnPropertySymbols(${accessor})) if (!${known2}.has(s)) delete out[s];`);
    });
    ctx.write(`}`);
  }

  if (cName) ctx.write(`if (${cName}(out) === INVALID) return INVALID;`);

  return "out";
}

/* ── array 骨架：元素级引用比较 + slice 条件拷贝 ── */

function emitCoWArray(ctx: CodeCtx, schema: Node, accessor: string, seen: Set<Node>): string {
  const element: Node = schema._zod.def.element;
  ctx.write(`if (!Array.isArray(${accessor})) return INVALID;`);

  const childSeen = new Set(seen);
  childSeen.add(schema);
  const elemPure = isPure(element);
  const elemIsContainer = cowSafeContainerForChild(element);

  // 元素处理函数：容器（含包装链）→ CoW 子骨架（strip 语义完整）；纯净叶子 → 官方 validator；其余 → 官方 parser；async → async 岛
  let elemFn: Fn;
  if (elemIsContainer) {
    elemFn = containerChildFn(element, childSeen);
  } else {
    elemFn = officialFn(element, elemPure);
  }
  const f = ctx.addConst(elemFn);
  const elemAsync = isAsyncProduct(elemFn);
  if (elemAsync) ctx.async = true;
  const awaitKw = elemAsync ? "await " : "";

  const out = ctx.var();
  const dirty = ctx.var();
  const i = ctx.var();
  const e = ctx.var();
  const t = ctx.var();

  ctx.write(`let ${out} = ${accessor}, ${dirty} = false;`);
  ctx.write(`for (let ${i} = 0; ${i} < ${accessor}.length; ${i}++) {`);
  ctx.indented(() => {
    ctx.write(`const ${e} = ${accessor}[${i}];`);
    ctx.write(`const ${t} = ${awaitKw}${f}(${e});`);
    ctx.write(`if (${t} === INVALID) return INVALID;`);
    if (elemPure && !elemIsContainer) {
      // 纯叶子元素：值 === 输入，无拷贝（validator 产物返回 true，不可引用比较）
      // 容器元素走子骨架：产物返回原引用或新容器，引用比较安全
    } else {
      ctx.write(`if (${t} !== ${e}) {`);
      ctx.indented(() => {
        ctx.write(`if (!${dirty}) { ${dirty} = true; ${out} = ${accessor}.slice(); }`);
        ctx.write(`${out}[${i}] = ${t};`);
      });
      ctx.write(`}`);
    }
  });
  ctx.write(`}`);

  // 容器自身 checks（array .min/.max/.length/.refine）：双路径同 object 骨架
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

/* ── tuple 骨架：镜像官方 generateTupleCheck + fillLen 截断跟踪 + CoW 修饰 ── */

/**
 * 官方 getTupleOptStart 逐字照抄（compile.js 与 runtime 双份同款）：
 * 从尾向头找第一个不可省槽位，返回 i+1。
 *   optin：三档梯子（optin !== undefined 即可省，含 optional/defaulted）；
 *   optout：两档（optout === "optional" 才可省）。
 */
function getTupleOptStart(items: Node[], key: "optin" | "optout"): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const omittable =
      key === "optin" ? items[i]!._zod.optin !== undefined : items[i]!._zod.optout === "optional";
    if (!omittable) return i + 1;
  }
  return 0;
}

/** 官方 dropsWhenAbsent 逐字照抄：缺席槽位输出侧是否直接截断 */
function dropsWhenAbsent(schema: Node): boolean {
  return schema._zod.optin === "optional" && schema._zod.optout === "optional";
}

/**
 * tuple CoW 骨架 —— 与官方 generateTupleCheck 逐行对应，唯一区别是把
 * "无条件新容器"（const out = []）改写为引用比较判脏 + slice 条件拷贝：
 *
 *   长度守卫（官方同款，optinStart/optoutStart 编译期算好）
 *   段 1 [0, optoutStart)：官方无条件分支 out[i] = child(input[i])
 *         → validator 校验 / 值引用比较写回；缺席槽位保留官方"物化"语义
 *   段 2 [optoutStart, N)：官方尾槽门（out.length === i）+ 缺席截断/IIFE 填充
 *         → fillLen 变量镜像官方 out.length（CoW 时输出可能还是输入引用，
 *           不能读 .length，必须显式跟踪）
 *   段 3 rest [N, L)：官方无门控逐槽写 → 引用比较写回
 *
 * 干净判定：out === input（拷贝从未发生）⇔ 全部槽引用未变且无截断/填充。
 * 不变量：out === input ⟹ fillLen === input.length（截断/填充路径必先拷贝）。
 */
function emitCoWTuple(ctx: CodeCtx, schema: Node, accessor: string, seen: Set<Node>): string {
  const def = schema._zod.def as { items: Node[]; rest?: Node };
  const items: Node[] = def.items;
  const rest: Node | undefined = def.rest;
  const N = items.length;
  if (seen.has(schema)) throw new ZodCompileUnsupportedError("recursive tuple");
  const childSeen = new Set(seen);
  childSeen.add(schema);

  ctx.write(`if (!Array.isArray(${accessor})) return INVALID;`);
  const optinStart = getTupleOptStart(items, "optin");
  const optoutStart = getTupleOptStart(items, "optout");
  // 长度守卫（官方同款）：无 rest 时 [optinStart, N]，有 rest 时 >= optinStart
  if (rest) {
    ctx.write(`if (${accessor}.length < ${optinStart}) return INVALID;`);
  } else {
    ctx.write(`if (${accessor}.length < ${optinStart} || ${accessor}.length > ${N}) return INVALID;`);
  }

  // 每个固定槽位的产物（编译期生成一次；键位/元素位/值位统一走 childProduct）
  const itemProducts = items.map((it) => childProduct(it, childSeen));

  const out = ctx.var();
  const fillLen = ctx.var();
  ctx.write(`let ${out} = ${accessor};`);

  /** 值形态槽（parser/cow/async 产物）：判 INVALID + 引用比较 + 首脏 slice 写回。
   *  eVar=null 表示缺席槽（官方无条件 out[i] = 产出，含 undefined 物化/结构扩展）→ 无条件写。 */
  const emitValueSlot = (p: ChildProduct, argExpr: string, idxExpr: string, eVar: string | null): void => {
    const f = ctx.addConst(p.fn);
    const isA = p.kind === "async";
    if (isA) ctx.async = true;
    const t = ctx.var();
    ctx.write(`const ${t} = ${isA ? "await " : ""}${f}(${argExpr});`);
    ctx.write(`if (${t} === INVALID) return INVALID;`);
    if (eVar === null) {
      // 缺席槽：官方无条件写 out[i]（t === undefined 时也物化，保持输出长度/内容一致）
      ctx.write(`if (${out} === ${accessor}) ${out} = ${accessor}.slice();`);
      ctx.write(`${out}[${idxExpr}] = ${t};`);
    } else {
      ctx.write(`if (${t} !== ${eVar}) {`);
      ctx.indented(() => {
        ctx.write(`if (${out} === ${accessor}) ${out} = ${accessor}.slice();`);
        ctx.write(`${out}[${idxExpr}] = ${t};`);
      });
      ctx.write(`}`);
    }
  };
  /** 校验形态槽（validator 产物）：只答成败；缺席时官方照样物化 out[i] = undefined（纯子树输出=输入=undefined） */
  const emitValidatorSlot = (p: ChildProduct, argExpr: string, idxExpr: string, present: boolean): void => {
    const f = ctx.addConst(p.fn);
    const isA = p.kind === "async";
    if (isA) ctx.async = true;
    ctx.write(`if ((${isA ? "await " : ""}${f}(${argExpr})) === INVALID) return INVALID;`);
    if (!present) {
      // absent + validator（纯 optional 等）：stock 物化 undefined 槽（输出长度 i+1 > 输入）→ 必写
      ctx.write(`if (${out} === ${accessor}) ${out} = ${accessor}.slice();`);
      ctx.write(`${out}[${idxExpr}] = undefined;`);
    }
  };
  /** 官方截断三态（out.length = i 的 CoW 版）：已拷贝 → 实截；原引用且目标≠输入长 → 拷后截；原引用且目标=输入长 → 输出=输入，无操作 */
  const emitTruncate = (i: number): void => {
    ctx.write(`if (${out} !== ${accessor}) {`);
    ctx.indented(() => {
      ctx.write(`${out}.length = ${i};`);
    });
    ctx.write(`} else if (${i} !== ${accessor}.length) {`);
    ctx.indented(() => {
      ctx.write(`${out} = ${accessor}.slice();`);
      ctx.write(`${out}.length = ${i};`);
    });
    ctx.write(`}`);
  };

  /* 段 1：无条件槽 [0, optoutStart) —— 官方 `out[i] = compileChild(...)` */
  for (let i = 0; i < optoutStart; i++) {
    const p = itemProducts[i]!;
    ctx.write(`{`);
    ctx.indented(() => {
      const e = ctx.var();
      ctx.write(`const ${e} = ${accessor}[${i}];`);
      // 缺席判定编译期不可知（input.length 运行时值）→ present 分支运行时守卫
      ctx.write(`if (${i} < ${accessor}.length) {`);
      ctx.indented(() => {
        if (p.kind === "validator") emitValidatorSlot(p, e, String(i), true);
        else emitValueSlot(p, e, String(i), e);
      });
      ctx.write(`} else {`);
      ctx.indented(() => {
        // 缺席（i >= input.length）：官方照样跑 child(undefined)（IIFE 等价语义）
        if (p.kind === "validator") emitValidatorSlot(p, "undefined", String(i), false);
        else emitValueSlot(p, "undefined", String(i), null);
      });
      ctx.write(`}`);
    });
    ctx.write(`}`);
  }
  // 段 1 结束：官方 out.length = optoutStart（顺序填充），fillLen 镜像之
  ctx.write(`let ${fillLen} = ${optoutStart};`);

  /* 段 2：尾槽 [optoutStart, N) —— 官方门控 + 缺席截断/IIFE 填充 */
  for (let i = optoutStart; i < N; i++) {
    const p = itemProducts[i]!;
    const drop = dropsWhenAbsent(items[i]!); // 编译期已知 → 只发射实际分支
    ctx.write(`{`);
    ctx.indented(() => {
      ctx.write(`if (${fillLen} === ${i}) {`);
      ctx.indented(() => {
        ctx.write(`if (${i} < ${accessor}.length) {`);
        ctx.indented(() => {
          const e = ctx.var();
          ctx.write(`const ${e} = ${accessor}[${i}];`);
          if (p.kind === "validator") emitValidatorSlot(p, e, String(i), true);
          else emitValueSlot(p, e, String(i), e);
          ctx.write(`${fillLen} = ${i + 1};`);
        });
        ctx.write(`} else {`);
        ctx.indented(() => {
          if (drop) {
            // 官方 dropsWhenAbsent 分支：out.length = i（截断）
            ctx.write(`${fillLen} = ${i};`);
            emitTruncate(i);
          } else if (p.kind === "validator") {
            // 纯子树槽缺席：child(undefined) 校验（纯 optional 系恒过，防御 INVALID）→ 输出=undefined → 官方截断
            const f = ctx.addConst(p.fn);
            const isA = (p as ChildProduct).kind === "async"; // 防御（validator 产物恒同步）
            if (isA) ctx.async = true;
            ctx.write(`if ((${isA ? "await " : ""}${f}(undefined)) === INVALID) return INVALID;`);
            ctx.write(`${fillLen} = ${i};`);
            emitTruncate(i);
          } else {
            // 官方 IIFE 分支：branch = child(undefined)；INVALID/undefined → 截断，有值 → out[i] = branch（结构扩展）
            const f = ctx.addConst(p.fn);
            const isA = p.kind === "async";
            if (isA) ctx.async = true;
            const t = ctx.var();
            ctx.write(`const ${t} = ${isA ? "await " : ""}${f}(undefined);`);
            ctx.write(`if (${t} === INVALID || ${t} === undefined) {`);
            ctx.indented(() => {
              ctx.write(`${fillLen} = ${i};`);
              emitTruncate(i);
            });
            ctx.write(`} else {`);
            ctx.indented(() => {
              ctx.write(`if (${out} === ${accessor}) ${out} = ${accessor}.slice();`);
              ctx.write(`${out}[${i}] = ${t};`);
              ctx.write(`${fillLen} = ${i + 1};`);
            });
            ctx.write(`}`);
          }
        });
        ctx.write(`}`);
      });
      ctx.write(`}`);
    });
    ctx.write(`}`);
  }

  /* 段 3：rest [N, L) —— 官方无门控逐槽写 */
  if (rest) {
    const restProduct = childProduct(rest, childSeen);
    const f = ctx.addConst(restProduct.fn);
    const isA = restProduct.kind === "async";
    if (isA) ctx.async = true;
    ctx.write(`for (let i = ${N}; i < ${accessor}.length; i++) {`);
    ctx.indented(() => {
      const e = ctx.var();
      ctx.write(`const ${e} = ${accessor}[i];`);
      if (restProduct.kind === "validator") {
        ctx.write(`if ((${isA ? "await " : ""}${f}(${e})) === INVALID) return INVALID;`);
      } else {
        const t = ctx.var();
        ctx.write(`const ${t} = ${isA ? "await " : ""}${f}(${e});`);
        ctx.write(`if (${t} === INVALID) return INVALID;`);
        ctx.write(`if (${t} !== ${e}) {`);
        ctx.indented(() => {
          ctx.write(`if (${out} === ${accessor}) ${out} = ${accessor}.slice();`);
          ctx.write(`${out}[i] = ${t};`);
        });
        ctx.write(`}`);
      }
    });
    ctx.write(`}`);
  }

  // 容器自身 checks（tuple .refine 纯谓词）：双路径同 object/array 骨架
  const checksFn = containerChecksFn(schema);
  if (checksFn) {
    const cName = ctx.addConst(checksFn);
    const isA = isAsyncProduct(checksFn);
    const awaitKw = isA ? "await " : "";
    ctx.write(`if (${out} === ${accessor}) {`);
    ctx.indented(() => {
      ctx.write(`if ((${awaitKw}${cName}(${accessor})) === INVALID) return INVALID;`);
      ctx.write(`return ${accessor};`);
    });
    ctx.write(`}`);
    ctx.write(`if ((${awaitKw}${cName}(${out})) === INVALID) return INVALID;`);
  } else {
    ctx.write(`if (${out} === ${accessor}) return ${accessor};`);
  }

  return out;
}

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
function emitCoWRecord(ctx: CodeCtx, schema: Node, accessor: string, seen: Set<Node>): string {
  const def = schema._zod.def as { keyType: Node; valueType: Node; mode?: string; partial?: boolean };
  const childSeen = new Set(seen);
  childSeen.add(schema);

  // 官方守卫同款：util.isPlainObject（拒绝 Date/Map/class 实例等）
  const isPlain = ctx.addConst(util.isPlainObject);
  ctx.write(`if (!${isPlain}(${accessor})) return INVALID;`);

  const out = ctx.var();
  const dirty = ctx.var();
  ctx.write(`let ${out} = ${accessor}, ${dirty} = false;`);

  const keyValues = def.partial ? undefined : (def.keyType._zod as { values?: Set<unknown> }).values;
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
  const keyDef = def.keyType._zod.def as { type: string; format?: string; coerce?: boolean; checks?: unknown[] };
  const keyIsBareString =
    keyDef.type === "string" && keyDef.format === undefined && !keyDef.coerce && (keyDef.checks?.length ?? 0) === 0;

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
      ctx.write(`if (outKey === INVALID && typeof k === "string" && ${numeric}.test(k)) outKey = ${kAwait}${keyFast}(Number(k));`);
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

/* ── map 骨架：键/值双引用比较 + new Map(input) 条件拷贝 ── */

function emitCoWMap(ctx: CodeCtx, schema: Node, accessor: string, seen: Set<Node>): string {
  const def = schema._zod.def as { keyType: Node; valueType: Node };
  const childSeen = new Set(seen);
  childSeen.add(schema);

  ctx.write(`if (!(${accessor} instanceof Map)) return INVALID;`);
  const out = ctx.var();
  const dirty = ctx.var();
  ctx.write(`let ${out} = ${accessor}, ${dirty} = false;`);
  ctx.write(`for (const [kIn, vIn] of ${accessor}) {`);
  ctx.indented(() => {
    // 键：值位置 —— 纯键用 validator 校验 + 键名恒不变；非纯键用 parser 产物（返回转换后键名）；async → await
    const keyProduct = childProduct(def.keyType, childSeen);
    const kf = ctx.addConst(keyProduct.fn);
    const keyAsync = keyProduct.kind === "async";
    if (keyAsync) ctx.async = true;
    const kAwait = keyAsync ? "await " : "";
    let keyExpr = "kIn";
    if (keyProduct.kind === "validator") {
      ctx.write(`if (${kf}(kIn) === INVALID) return INVALID;`);
    } else {
      const ko = ctx.var();
      ctx.write(`const ${ko} = ${kAwait}${kf}(kIn);`);
      ctx.write(`if (${ko} === INVALID) return INVALID;`);
      keyExpr = ko;
    }
    const product = childProduct(def.valueType, childSeen);
    const vf = ctx.addConst(product.fn);
    const vAsync = product.kind === "async";
    if (vAsync) ctx.async = true;
    const vAwait = vAsync ? "await " : "";
    if (product.kind === "validator") {
      ctx.write(`if (${vf}(vIn) === INVALID) return INVALID;`);
      if (keyExpr !== "kIn") {
        // 键被转换但值没变：官方输出 set(新键, 原值) → 键名变化即脏
        ctx.write(`if (${keyExpr} !== kIn) {`);
        ctx.indented(() => {
          ctx.write(`if (!${dirty}) { ${dirty} = true; ${out} = new Map(${accessor}); }`);
          ctx.write(`if (${keyExpr} !== kIn) ${out}.delete(kIn);`);
          ctx.write(`${out}.set(${keyExpr}, vIn);`);
        });
        ctx.write(`}`);
      }
    } else {
      const vo = ctx.var();
      ctx.write(`const ${vo} = ${vAwait}${vf}(vIn);`);
      ctx.write(`if (${vo} === INVALID) return INVALID;`);
      ctx.write(`if (${vo} !== vIn || ${keyExpr} !== kIn) {`);
      ctx.indented(() => {
        ctx.write(`if (!${dirty}) { ${dirty} = true; ${out} = new Map(${accessor}); }`);
        ctx.write(`if (${keyExpr} !== kIn) ${out}.delete(kIn);`);
        ctx.write(`${out}.set(${keyExpr}, ${vo});`);
      });
      ctx.write(`}`);
    }
  });
  ctx.write(`}`);

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

/* ── set 骨架：成员引用比较 + new Set(input) 条件拷贝 ── */

function emitCoWSet(ctx: CodeCtx, schema: Node, accessor: string, seen: Set<Node>): string {
  const def = schema._zod.def as { valueType: Node };
  const childSeen = new Set(seen);
  childSeen.add(schema);

  ctx.write(`if (!(${accessor} instanceof Set)) return INVALID;`);
  const out = ctx.var();
  const dirty = ctx.var();
  ctx.write(`let ${out} = ${accessor}, ${dirty} = false;`);
  ctx.write(`for (const vIn of ${accessor}) {`);
  ctx.indented(() => {
    const product = childProduct(def.valueType, childSeen);
    const f = ctx.addConst(product.fn);
    if (product.kind === "validator") {
      ctx.write(`if (${f}(vIn) === INVALID) return INVALID;`);
    } else {
      const vo = ctx.var();
      if (product.kind === "async") {
        ctx.async = true;
        ctx.write(`const ${vo} = await ${f}(vIn);`);
      } else {
        ctx.write(`const ${vo} = ${f}(vIn);`);
      }
      ctx.write(`if (${vo} === INVALID) return INVALID;`);
      // NaN 误报：vo!==vIn 对 NaN 恒真 → 过度拷贝但结果正确（SameValueZero 下 delete/add 等价）
      ctx.write(`if (${vo} !== vIn) {`);
      ctx.indented(() => {
        ctx.write(`if (!${dirty}) { ${dirty} = true; ${out} = new Set(${accessor}); }`);
        ctx.write(`${out}.delete(vIn);`);
        ctx.write(`${out}.add(${vo});`);
      });
      ctx.write(`}`);
    }
  });
  ctx.write(`}`);

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

/* ═══════════════════ 顶层编译 ═══════════════════ */

/** 生成 CoW 单体函数；不可编译（async/递归/冷僻特性）时抛出，由调用方整树降级 */
export function compileCowFn(schema: Node): Fn {
  const ctx = new CodeCtx();
  const acc = emitNode(ctx, schema, "input", true, new Set());
  ctx.write(`return ${acc ?? "true"};`);
  return buildFn(ctx);
}

/** 同上，但返回 [函数, 源码]，供 debug dump */
export function compileCowDebug(schema: Node): { fn: Fn; code: string } {
  const ctx = new CodeCtx();
  const acc = emitNode(ctx, schema, "input", true, new Set());
  ctx.write(`return ${acc ?? "true"};`);
  return { fn: buildFn(ctx), code: ctx.lines.join("\n") };
}

/** 整树官方 assertOnly 产物（validate 快路径），失败 → null */
export function officialValidator(schema: Node): Fn | null {
  try {
    return compileFn(schema, { assertOnly: true }) as Fn;
  } catch {
    return null;
  }
}

export { INVALID };