/** Purity analysis (conservative whitelist) and the CoW-safe container decision. */
import { isAsyncFn, type Node } from "./product.js";

/* ═══════════════════ Purity analysis (conservative whitelist) ═══════════════════ */
/**
 * Pure = (under this layer's composition) validation passes ⇒ the output is necessarily === the input reference, with no side effects.
 * A pure subtree uses the official assertOnly product (validation intact, zero construction);
 * anything uncertain counts as impure (official parser product + reference comparison, no loss of correctness).
 */
export function isPure(schema: Node): boolean {
  const def = schema._zod.def;
  switch (def.type) {
    // Pass-through leaves: the official product is a plain "return accessor" ⇒ output === input.
    // Precondition: the leaf's own checks rewrite no value (overwrite/trim/toLowerCase… are value transforms! see differential seed=51).
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
    // Wrappers: recurse into inner
    case "optional":
    case "nullable":
      return isPure(def.innerType);
    // Containers: this layer's skeleton takes over (strip/strict/loose can all return the original reference).
    // Precondition: the schema's own checks can be handled safely by the skeleton (see checksAreCowSafe).
    // The verdict holds only where a skeleton is actually emitted for the container (the top level and the
    // key / element / value positions, which route containers through cowSafeContainerForChild); a union
    // option is not such a position, see the union case below.
    case "object": {
      if (!checksAreCowSafe(schema)) return false;
      if (def.catchall) {
        const t = def.catchall._zod.def.type;
        if (t === "never") return true; // strict: extra key → INVALID; the original reference when clean
        if ((t === "unknown" || t === "any") && !def.catchall._zod.def.checks?.length) return true; // loose
        return false; // schema-typed catchall: official parser island
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
    // Union: the whole union is one official product, so an option gets no skeleton of its own. A container
    // option would therefore be validated by assertOnly and returned by reference, keeping the undeclared
    // keys of a strip object (or of an object nested in an array / tuple option) that stock's rebuild drops
    // (#47). Any option that is, or unwraps through optional / nullable to, a container makes the union
    // impure: it takes the official parser plus the reference comparison, which rebuilds like stock.
    // discriminatedUnion shares this def.type.
    case "union":
      return def.options.every((o: Node) => !unwrapsToContainer(o) && isPure(o));
    // freeze side effects / value producers / black boxes: always impure
    // readonly (Object.freeze), default/prefault/catch/coerce, transform/pipe,
    // tuple/record/map/set (the official product unconditionally builds a new container), intersection (mergeValues),
    // lazy/custom/nonoptional/success (conservative)
    default:
      return false;
  }
}

/** Whether the node is a container, or an optional / nullable chain ending in one (any checks along the way ignored) */
function unwrapsToContainer(node: Node): boolean {
  let cur: Node = node;
  for (;;) {
    const t: string = cur._zod.def.type;
    if (t === "optional" || t === "nullable") {
      cur = cur._zod.def.innerType;
      continue;
    }
    return (
      t === "object" ||
      t === "array" ||
      t === "tuple" ||
      t === "record" ||
      t === "map" ||
      t === "set"
    );
  }
}

/** Same as the official WHEN_DEFAULTED_CHECKS: length/size checks carry a default when (_whenHasLength), which does not count as a custom when */
const WHEN_DEFAULTED_CHECKS = new Set([
  "max_size",
  "min_size",
  "size_equals",
  "max_length",
  "min_length",
  "length_equals",
]);

/** Same decision as the official generateChecks: a custom when (non-default) cannot be expressed on the fast path → not compilable */
function hasCustomWhen(d: { check?: string; when?: unknown }): boolean {
  return !!d.when && !WHEN_DEFAULTED_CHECKS.has(d.check as string);
}

/**
 * Purity of a leaf's own checks (string/number/…):
 *   - overwrite (.trim/.toLowerCase/.normalize and other value rewrites) → impure
 *   - custom without fn (superRefine may rewrite ctx.value) → impure
 *   - a custom when condition (non-default) → conservatively impure
 *   - everything else (string_format/length/number_format/greater_than/refine predicates…) → pure predicates
 */
function leafChecksArePure(schema: Node): boolean {
  const checks = schema._zod.def.checks;
  if (!checks || checks.length === 0) return true;
  return checks.every((c: Node) => {
    const d = c._zod?.def ?? c;
    if (hasCustomWhen(d)) return false;
    if (d.check === "overwrite") return false;
    if (d.check === "custom") return !!d.fn && !isAsyncFn(d.fn); // an async refine is value-producer timing (impure) + unreachable from a sync product
    return true;
  });
}

/**
 * Whether a container's own def.checks (object/array) can be handled safely by the CoW skeleton:
 *   - no checks ✓
 *   - custom with def.fn present (a .refine() pure predicate: answers only yes/no, never changes the value) ✓
 *   - min_length / max_length / length_equals (array .min/.max/.length, reads only .length) ✓
 * Everything else (superRefine may rewrite ctx.value, overwrite transforms the value, a custom when…) → impure,
 * and the node as a whole degrades to the official parser product (stock semantics, no loss of correctness).
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
  if (!isContainer) return false; // record itself has no size checks; non-containers are conservatively rejected
  return checks.every((c: Node) => {
    const d = c._zod?.def ?? c;
    if (hasCustomWhen(d)) return false;
    if (d.check === "custom") return !!d.fn && !isAsyncFn(d.fn); // superRefine (no fn) may rewrite the value → reject; an async refine is impure
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
 * Pierce the optional/nullable wrapper chain to decide whether it finally lands on a container CoW can take over
 * (object/array/record/map/set), with the whole chain and the container's own checks all safe.
 * This is the only entry point for the key-position/element-position/top-level decision to "use a CoW sub-skeleton" --
 * testing def.type bare would misroute optional(object) to the official assertOnly and lose the strip semantics
 * (demonstrated by differential seed=104/133/137).
 */
export function cowSafeContainerForChild(child: Node): boolean {
  let cur: Node = child;
  for (;;) {
    if (!leafChecksArePure(cur)) return false; // refine/overwrite and friends on a wrapper layer
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
 * Whether a record's key shape can be skeletonized (aggressively, all shapes covered):
 *   - bare-string key → the key name never changes, so only values are compared
 *   - general key (string format / number numeric retry / enum declaration-driven / partialRecord) →
 *     compare key names by reference (outKey !== k → mark dirty + delete the old key and write the new one); declaration-driven keys additionally decide whether missing keys are materialized
 *   - key schema with async/coerce → when keyFast product generation fails, containerChildFn falls back and degrades
 */
function recordKeyShapeOk(record: Node): boolean {
  void record; // every key shape is already covered; the predicate is kept so it can be narrowed later
  return true;
}
