/**
 * Predicates copied verbatim from zod's compile.ts (version anchor 4.5.4).
 * Diff this file against upstream on a zod bump.
 */
import type { Node } from "./product.js";

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
export function requiresPresence(schema: Node): boolean {
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
      return (
        !def.left || !def.right || mayOutputUndefined(def.left) || mayOutputUndefined(def.right)
      );
    case "pipe":
      return def.out ? mayOutputUndefined(def.out) : true;
    default:
      return true; // any/unknown/undefined/void/default/prefault/transform/custom/lazy/catch
  }
}

/**
 * 官方 getTupleOptStart 逐字照抄（compile.js 与 runtime 双份同款）：
 * 从尾向头找第一个不可省槽位，返回 i+1。
 *   optin：三档梯子（optin !== undefined 即可省，含 optional/defaulted）；
 *   optout：两档（optout === "optional" 才可省）。
 */
export function getTupleOptStart(items: Node[], key: "optin" | "optout"): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const omittable =
      key === "optin" ? items[i]!._zod.optin !== undefined : items[i]!._zod.optout === "optional";
    if (!omittable) return i + 1;
  }
  return 0;
}

/** 官方 dropsWhenAbsent 逐字照抄：缺席槽位输出侧是否直接截断 */
export function dropsWhenAbsent(schema: Node): boolean {
  return schema._zod.optin === "optional" && schema._zod.optout === "optional";
}
