/**
 * Predicates copied verbatim from zod's compile.ts (version anchor 4.5.4).
 * Diff this file against upstream on a zod bump.
 */
import type { Node } from "./product.js";

/* ═══════════════════ Semantic predicates (copied verbatim from the official compile.ts, version anchor 4.5.4) ═══════════════════ */

// Official fastPathAcceptsAbsence: the value-level fast path reads an absent key as undefined,
// so these schemas mistake "absence" for a legal value -- the official codegen emits a presence guard for them.
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

// Official requiresPresenceCheck: a non-optin key whose fast path accepts absence → needs an in probe
export function requiresPresence(schema: Node): boolean {
  return schema._zod.optin === undefined && acceptsAbsence(schema);
}

// Official mayOutputUndefined: whether this key may produce undefined when the output is assembled
// (decides the copy path's write rule for absent/present-undefined keys)
export function mayOutputUndefined(schema: Node): boolean {
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
 * Verbatim copy of the official getTupleOptStart (identical in compile.js and in the runtime):
 * scan from the tail towards the head for the first non-omittable slot and return i+1.
 *   optin: a three-rung ladder (optin !== undefined is omittable, covering optional/defaulted);
 *   optout: two rungs (only optout === "optional" is omittable).
 */
export function getTupleOptStart(items: Node[], key: "optin" | "optout"): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const omittable =
      key === "optin" ? items[i]!._zod.optin !== undefined : items[i]!._zod.optout === "optional";
    if (!omittable) return i + 1;
  }
  return 0;
}

/** Verbatim copy of the official dropsWhenAbsent: whether an absent slot is simply truncated on the output side */
export function dropsWhenAbsent(schema: Node): boolean {
  return schema._zod.optin === "optional" && schema._zod.optout === "optional";
}
