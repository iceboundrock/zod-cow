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
 * Normalization scope (deliberately narrow):
 *   - invalid Date            -> a fresh InvalidDateMarker instance
 *   - Array / Map / Set       -> rebuilt from elements / entries only; custom
 *                                enumerable properties set on the collection
 *                                instance itself are NOT carried over
 *   - plain object (Object.prototype or null prototype)
 *                             -> own enumerable keys (string + symbol) copied
 *   - anything else (class instances, boxed primitives, RegExp, ...)
 *                             -> returned as-is
 * Markers are created per occurrence so a Map or Set holding several invalid
 * Dates keeps its size; distinct instances still compare deepStrictEqual
 * because they share a prototype and have no own properties. The marker's
 * prototype is not Object.prototype, so no plain-object input can forge it.
 */
class InvalidDateMarker {}

function normalizeForCompare(v: unknown): unknown {
  if (typeof v !== "object" || v === null) return v;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? new InvalidDateMarker() : v;
  if (Array.isArray(v)) return v.map(normalizeForCompare);
  if (v instanceof Map) {
    return new Map([...v].map(([k, x]) => [normalizeForCompare(k), normalizeForCompare(x)]));
  }
  if (v instanceof Set) return new Set([...v].map(normalizeForCompare));
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return v; // not a plain object: leave to deepStrictEqual
  const out = Object.create(proto);
  for (const k of Reflect.ownKeys(v)) {
    const d = Object.getOwnPropertyDescriptor(v, k)!;
    if (!d.enumerable) continue;
    // defineProperty rather than assignment: a "__proto__" key must not set the prototype
    Object.defineProperty(out, k, {
      value: normalizeForCompare((v as Record<PropertyKey, unknown>)[k]),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  return isDeepStrictEqual(normalizeForCompare(a), normalizeForCompare(b));
}
