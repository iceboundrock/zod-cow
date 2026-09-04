/**
 * Minimal unit-test framework (zero dependencies, deterministic output).
 */
import { isDeepStrictEqual } from "node:util";

export let passed = 0;
export let failed = 0;
export const failures: string[] = [];

export function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    const msg = e instanceof Error ? e.message : String(e);
    failures.push(`${name}\n      ${msg.split("\n").join("\n      ")}`);
    console.log(`  ✗ ${name}`);
  }
}

export function summary(suite: string): void {
  console.log(`\n${suite}: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

/**
 * Boolean deep-strict equality with the semantics of `assert.deepStrictEqual`,
 * with exactly one deviation: two invalid Dates (`getTime()` is NaN) are equal.
 *
 * Why: Node 22's deepStrictEqual compares Dates with `getTime() !== getTime()`,
 * and `NaN !== NaN`, so `new Date(NaN)` never equals its own structuredClone
 * (fixed in Node 24+). The differential fuzzers put `new Date(NaN)` in the
 * input pool, so on Node 22 every such case was falsely reported as
 * INPUT MUTATED. Instead of rewriting the comparator, both sides are
 * normalized and then handed to `util.isDeepStrictEqual`, which stays the
 * source of truth for prototypes, key sets, NaN, Map/Set membership, etc.
 *
 * Normalization is structure-preserving: everything deepStrictEqual looks at
 * survives it, so `deepEqual(a, b)` differs from `isDeepStrictEqual(a, b)`
 * only when an invalid Date is involved.
 *   - invalid Date            -> a fresh InvalidDateMarker instance
 *   - Array                   -> same length and holes, index elements
 *                                normalized, non-index own enumerable
 *                                properties copied, prototype preserved
 *   - Map / Set               -> entries normalized, own enumerable properties
 *                                on the collection instance copied, prototype
 *                                preserved (a Map subclass stays a subclass)
 *   - plain object (Object.prototype or null prototype)
 *                             -> own enumerable keys (string + symbol) copied
 *   - anything else (class instances, boxed primitives, RegExp, ...)
 *                             -> returned as-is
 * Markers are created per occurrence so a Map or Set holding several invalid
 * Dates keeps its size; distinct instances still compare deepStrictEqual
 * because they share a prototype and have no own properties. The marker's
 * prototype is not Object.prototype, so no plain-object input can forge it.
 * Cyclic inputs are not supported (the fuzzers never produce them).
 *
 * Regression coverage: `tests/harness.test.ts` (runs as part of `pnpm test`).
 */
class InvalidDateMarker {}

/** Copy own enumerable properties of `src` onto `dst`, normalizing values. */
function copyOwnEnumerable(src: object, dst: object, skip: (k: PropertyKey) => boolean): void {
  for (const k of Reflect.ownKeys(src)) {
    if (skip(k)) continue;
    const d = Object.getOwnPropertyDescriptor(src, k)!;
    if (!d.enumerable) continue;
    // defineProperty rather than assignment: a "__proto__" key must not set the prototype
    Object.defineProperty(dst, k, {
      value: normalizeForCompare((src as Record<PropertyKey, unknown>)[k]),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
}

function normalizeForCompare(v: unknown): unknown {
  if (typeof v !== "object" || v === null) return v;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? new InvalidDateMarker() : v;
  const proto = Object.getPrototypeOf(v);
  if (Array.isArray(v)) {
    // new Array(n) keeps holes as holes; only own index keys are written back
    const out: unknown[] = new Array(v.length);
    copyOwnEnumerable(v, out, (k) => k === "length");
    if (proto !== Array.prototype) Object.setPrototypeOf(out, proto);
    return out;
  }
  if (v instanceof Map) {
    const out = new Map<unknown, unknown>();
    for (const [k, x] of v) out.set(normalizeForCompare(k), normalizeForCompare(x));
    copyOwnEnumerable(v, out, () => false);
    if (proto !== Map.prototype) Object.setPrototypeOf(out, proto);
    return out;
  }
  if (v instanceof Set) {
    const out = new Set<unknown>();
    for (const x of v) out.add(normalizeForCompare(x));
    copyOwnEnumerable(v, out, () => false);
    if (proto !== Set.prototype) Object.setPrototypeOf(out, proto);
    return out;
  }
  if (proto !== Object.prototype && proto !== null) return v; // not a plain object: leave to deepStrictEqual
  const out = Object.create(proto);
  copyOwnEnumerable(v, out, () => false);
  return out;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  return isDeepStrictEqual(normalizeForCompare(a), normalizeForCompare(b));
}
