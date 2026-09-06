/** Purity analysis (conservative whitelist) and the CoW-safe container decision. */
import type { Node } from "./product.js";

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
    // Wrappers: the wrapper's own checks first (an overwrite, a superRefine or an async refine on the
    // wrapper rewrites or times the value exactly as on a leaf, and the validator would return the
    // input, #57; on a wrapper around a container the same verdict sent the chain to the validator,
    // which keeps the undeclared keys stock strips, #56), then the inner. Above a container the
    // verdict holds only where the chain gets a skeleton, so the wrapper's checks must pass the gate
    // `cowSafeContainerForChild` applies: a length / size check attached through `.check()` is a
    // pure predicate on a leaf but sends a container chain to the official parser, and judging it
    // pure here would hand the chain to the validator, which keeps the undeclared keys stock strips
    // (second review of #68).
    case "optional":
    case "nullable": {
      if (!unwrapsToContainer(def.innerType))
        return leafChecksArePure(schema) && isPure(def.innerType);
      // Above a container the verdict holds only where the chain gets a skeleton, so an exact-optional
      // layer is impure here for the same reason `cowSafeContainerForChild` declines it (#74)
      if (isExactOptional(schema)) return false;
      return wrapperChecksAreCowSafe(schema) && isPure(def.innerType);
    }
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
    // Union: the union's own checks first (a `.overwrite` or a superRefine on the union rewrites the
    // winning value exactly as on a leaf, and the validator would hand the input back; found while
    // building the skeleton of #58), then the options. A union whose options are all leaves is one
    // official product; one with a container option (directly, through optional / nullable, or in a
    // nested union) gets the union skeleton (#58), which tries each option's CoW product in order, so
    // its verdict follows the skeleton's gate like the wrapper case above: a union the skeleton
    // declines (`z.xor`, a discriminated union stock's codegen declines, a check other than a refine
    // predicate) takes the official parser plus the reference comparison, which rebuilds the
    // matching container like stock (#47). discriminatedUnion shares this def.type.
    case "union": {
      const hasContainer = def.options.some(unwrapsToContainer);
      if (!(hasContainer ? unionSkeletonOk(schema) : leafChecksArePure(schema))) return false;
      return def.options.every((o: Node) => isPure(o));
    }
    // freeze side effects / value producers / black boxes: always impure
    // readonly (Object.freeze), default/prefault/catch/coerce, transform/pipe,
    // tuple/record/map/set (the official product unconditionally builds a new container), intersection (mergeValues),
    // lazy/custom/nonoptional/success (conservative)
    default:
      return false;
  }
}

/**
 * Whether the node is a container, or an optional / nullable chain ending in one, or a union with such
 * an option at any depth of nested unions (any checks along the way ignored)
 */
function unwrapsToContainer(node: Node): boolean {
  let cur: Node = node;
  for (;;) {
    const t: string = cur._zod.def.type;
    if (t === "optional" || t === "nullable") {
      cur = cur._zod.def.innerType;
      continue;
    }
    if (t === "union") return cur._zod.def.options.some(unwrapsToContainer);
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
    // A superRefine (no fn) may rewrite ctx.value → impure. An async predicate is judged like a sync one:
    // for a leaf the verdict picks between two products that are the same async island (`officialFn`)
    if (d.check === "custom") return !!d.fn;
    return true;
  });
}

/**
 * Whether a container's own def.checks (object / array / tuple / record / map / set) can be handled safely by the CoW skeleton:
 *   - no checks ✓
 *   - custom with def.fn present (a .refine() pure predicate: answers only yes/no, never changes the
 *     value), sync or async: an async predicate is still a predicate, `containerChecksFn` starts it
 *     inside an async skeleton on stock's schedule (#13) ✓
 *   - min_length / max_length / length_equals (array .min/.max/.length, reads only .length) ✓
 *   - min_size / max_size / size_equals (map / set .min/.max/.size, reads only .size) ✓
 *   A record has no length or size check, so only predicates reach its skeleton (a record with any check
 *   used to take the official parser, sync predicates included; found while fixing #13).
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
    def.type === "record" ||
    def.type === "map" ||
    def.type === "set" ||
    def.type === "tuple";
  if (!isContainer) return false; // non-containers are conservatively rejected
  return checks.every((c: Node) => {
    const d = c._zod?.def ?? c;
    if (hasCustomWhen(d)) return false;
    if (d.check === "custom") return !!d.fn; // superRefine (no fn) may rewrite the value → reject
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
 * Whether the checks of an optional / nullable layer above a container can run in the skeleton: none, or
 * `.refine` predicates only (`custom` with a `fn`, sync or async, and no custom `when`), which
 * `containerChecksFn` emits and `emitBoxedContainer` runs on the layer's value, the shortcut
 * `undefined` / `null` included (#56; async since #13). A length / size check reaches a wrapper only
 * through `.check()` and, like an overwrite or a superRefine, sends the chain to the official parser
 * instead; `isPure` applies this gate too on a wrapper above a container, so the chain never falls
 * through to the validator. The union skeleton applies the same gate to the union's own checks.
 */
function wrapperChecksAreCowSafe(schema: Node): boolean {
  const checks = schema._zod.def.checks;
  if (!checks || checks.length === 0) return true;
  return checks.every((c: Node) => {
    const d = c._zod?.def ?? c;
    return d.check === "custom" && !!d.fn && !hasCustomWhen(d);
  });
}

/**
 * Whether a union can take the union skeleton (`emitCoWUnion`, #58), the same conditions under which
 * stock's codegen compiles the union rather than handing it to the runtime, plus the check gate of a
 * wrapper: the union's own checks are `.refine` predicates only (`containerChecksFn` runs them on the
 * winning value); a plain union is not `z.xor` (`inclusive === false`: exactly one option must match,
 * which a first-hit chain cannot decide); a discriminated union has no `unionFallback`, every option
 * carries static discriminator values of a type `literalEquality` can compare, and no value is claimed
 * twice. A declined union takes the official parser, whose product is stock's runtime island for the
 * same cases. Whether the skeleton is worth emitting (an option that unwraps to a container) is the
 * caller's question.
 */
export function unionSkeletonOk(schema: Node): boolean {
  const def = schema._zod.def;
  if (!wrapperChecksAreCowSafe(schema)) return false;
  if (def.discriminator) {
    if (def.unionFallback) return false;
    const claimed = new Set<unknown>();
    for (const option of def.options) {
      const values: Set<unknown> | undefined = option._zod.propValues?.[def.discriminator];
      if (!values || values.size === 0) return false;
      for (const v of values) {
        if (claimed.has(v) || !isLiteralDiscriminatorValue(v)) return false;
        claimed.add(v);
      }
    }
    return true;
  }
  return def.inclusive !== false;
}

/** Stock's `isExactOptional` (compile.js): the trait `z.exactOptional` adds on top of `def.type === "optional"` */
function isExactOptional(node: Node): boolean {
  return node._zod.traits?.has("$ZodExactOptional") === true;
}

/** The value types stock's `literalEquality` compares (a literal or enum discriminator can hold nothing else, kept as a guard) */
function isLiteralDiscriminatorValue(v: unknown): boolean {
  const t = typeof v;
  return (
    v === null ||
    t === "string" ||
    t === "number" ||
    t === "boolean" ||
    t === "undefined" ||
    t === "bigint" ||
    t === "symbol"
  );
}

/**
 * Pierce the optional/nullable wrapper chain to decide whether it finally lands on a container CoW can take over
 * (object/array/tuple/record/map/set, or a union with such an option, #58), with the whole chain and the container's own checks all safe.
 * This is the only entry point for the key-position/element-position/top-level decision to "use a CoW sub-skeleton" --
 * testing def.type bare would misroute optional(object) to the official assertOnly and lose the strip semantics
 * (demonstrated by differential seed=104/133/137). A wrapper layer may carry `.refine` predicates, which the
 * skeleton runs (#56); any other check on a wrapper sends the chain to the official parser. So does an
 * exact-optional layer (`z.exactOptional`, the `$ZodExactOptional` trait on `def.type === "optional"`):
 * `emitBoxedContainer` shortcuts every optional layer on `undefined`, while stock's `generateOptionalCheck`
 * compiles the inner directly for that trait so the container or union below rejects `undefined`. The
 * official parser keeps stock's answer on both paths; restoring the CoW path for it is #74.
 */
export function cowSafeContainerForChild(child: Node): boolean {
  let cur: Node = child;
  for (;;) {
    const t: string = cur._zod.def.type;
    if (t === "optional" || t === "nullable") {
      if (isExactOptional(cur) || !wrapperChecksAreCowSafe(cur)) return false;
      cur = cur._zod.def.innerType;
      continue;
    }
    if (t === "object" || t === "array") return checksAreCowSafe(cur);
    if (t === "record") return recordKeyShapeOk(cur) && checksAreCowSafe(cur);
    if (t === "map" || t === "set" || t === "tuple") return checksAreCowSafe(cur);
    // A union with a container option (at any depth of nested unions) gets the union skeleton, which
    // routes that option through this same decision (#58); a leaf-only union stays one official product
    if (t === "union") return cur._zod.def.options.some(unwrapsToContainer) && unionSkeletonOk(cur);
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
