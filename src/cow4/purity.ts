/** Purity analysis (conservative whitelist) and the CoW-safe container decision. */
import { isAsyncFn, type Node } from "./product.js";

/* ═══════════════════ 纯度分析（保守白名单） ═══════════════════ */
/**
 * 纯 = （在本层组合下）校验通过 ⇒ 输出必然 === 输入引用，且无副作用。
 * 纯净子树走官方 assertOnly 产物（校验完整、零构造）；
 * 拿不准的一律非纯（走官方 parser 产物 + 引用比较，正确性无损）。
 */
export function isPure(schema: Node): boolean {
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
      for (const s of Object.getOwnPropertySymbols(def.shape))
        if (!isPure(def.shape[s])) return false;
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
    def.type === "object" ||
    def.type === "array" ||
    def.type === "map" ||
    def.type === "set" ||
    def.type === "tuple";
  if (!isContainer) return false; // record 自身无 size checks；非容器保守拒绝
  return checks.every((c: Node) => {
    const d = c._zod?.def ?? c;
    if (hasCustomWhen(d)) return false;
    if (d.check === "custom") return !!d.fn && !isAsyncFn(d.fn); // superRefine（无 fn）可能改写值 → 拒；async refine 非纯
    if (
      def.type === "array" &&
      (d.check === "min_length" || d.check === "max_length" || d.check === "length_equals")
    ) {
      return true;
    }
    if (
      (def.type === "map" || def.type === "set") &&
      (d.check === "min_size" || d.check === "max_size" || d.check === "size_equals")
    ) {
      return true;
    }
    return false;
  });
}

/**
 * 穿透 optional/nullable 包装链，判断是否最终落到一个 CoW 可接管的容器
 * （object/array/record/map/set），且整链与容器自身 checks 均安全。
 * 这是键位/元素位/顶层判定「走 CoW 子骨架」的唯一入口 ——
 * 裸判 def.type 会把 optional(object) 误送官方 assertOnly，丢失 strip 剥离语义
 * （差分 seed=104/133/137 实证）。
 */
export function cowSafeContainerForChild(child: Node): boolean {
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
