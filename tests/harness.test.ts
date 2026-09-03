/**
 * Self-test for the `deepEqual` comparator in tests/harness.ts.
 *
 * `deepEqual` is the oracle the three differential fuzzers use for their
 * INPUT MUTATED check, so it must agree with `util.isDeepStrictEqual` on
 * everything except invalid Dates. Each case below asserts both the expected
 * verdict and, where the stock comparator is defined, agreement with it.
 */
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { deepEqual, summary, test } from "./harness.js";

/** Assert deepEqual's verdict and that it matches util.isDeepStrictEqual. */
function same(a: unknown, b: unknown, expected: boolean): void {
  assert.equal(deepEqual(a, b), expected, "deepEqual verdict");
  assert.equal(isDeepStrictEqual(a, b), expected, "stock isDeepStrictEqual verdict");
}

const invalid = (): Date => new Date(NaN);

// --- the one intended deviation ---------------------------------------------

test("invalid Date equals another invalid Date (the intended deviation)", () => {
  assert.equal(deepEqual(invalid(), invalid()), true);
  assert.equal(deepEqual(invalid(), structuredClone(invalid())), true);
});

test("invalid Date is not equal to a valid Date, null, NaN, or a marker-shaped object", () => {
  assert.equal(deepEqual(invalid(), new Date(0)), false);
  assert.equal(deepEqual(invalid(), null), false);
  assert.equal(deepEqual(invalid(), NaN), false);
  assert.equal(deepEqual(invalid(), {}), false);
  assert.equal(deepEqual(invalid(), Object.create(null)), false);
});

test("invalid Dates nested in object / array / Map value / Set", () => {
  const mk = () => ({ a: [invalid(), 1], m: new Map([["k", invalid()]]), s: new Set([invalid()]) });
  assert.equal(deepEqual(mk(), mk()), true);
  const other = mk();
  other.a[0] = new Date(0);
  assert.equal(deepEqual(mk(), other), false);
});

test("Map / Set keep their size when several invalid Dates are present", () => {
  const two = () => new Map([[invalid(), 1], [invalid(), 2]]);
  const one = () => new Map([[invalid(), 2]]);
  assert.equal(deepEqual(two(), two()), true);
  assert.equal(deepEqual(two(), one()), false);
  assert.equal(deepEqual(new Set([invalid(), invalid()]), new Set([invalid(), invalid()])), true);
  assert.equal(deepEqual(new Set([invalid(), invalid()]), new Set([invalid()])), false);
});

// --- everything else must agree with util.isDeepStrictEqual -----------------

test("primitives, NaN, -0, boxed primitives, RegExp, class instances", () => {
  same(1, 1, true);
  same(NaN, NaN, true);
  same(0, -0, false);
  same("x", "x", true);
  same(new Number(1), new Number(1), true);
  same(new Number(1), 1, false);
  same(/a/g, /a/g, true);
  same(/a/g, /a/i, false);
  class P { constructor(public x: number) {} }
  same(new P(1), new P(1), true);
  same(new P(1), { x: 1 }, false);
});

test("plain objects: key set, values, prototype, symbol keys, __proto__ key", () => {
  same({ a: 1 }, { a: 1 }, true);
  same({ a: 1 }, { a: 2 }, false);
  same({ a: 1 }, { a: 1, b: undefined }, false);
  same({ a: 1 }, Object.assign(Object.create(null), { a: 1 }), false);
  const sym = Symbol("s");
  same({ [sym]: 1 }, { [sym]: 1 }, true);
  same({ [sym]: 1 }, { [sym]: 2 }, false);
  same(JSON.parse('{"__proto__":{"x":1}}'), JSON.parse('{"__proto__":{"x":1}}'), true);
  same(JSON.parse('{"__proto__":{"x":1}}'), JSON.parse('{"__proto__":{"x":2}}'), false);
  same(JSON.parse('{"__proto__":{"x":1}}'), {}, false);
});

test("arrays: elements, length, holes vs undefined", () => {
  same([1, 2], [1, 2], true);
  same([1, 2], [1, 2, 3], false);
  same([1, , 3], [1, undefined, 3], false);
  same([1, , 3], [1, , 3], true);
  same([1, 2], { 0: 1, 1: 2, length: 2 }, false);
});

test("arrays: custom enumerable properties on the array instance are compared", () => {
  const tagged = (tag: string) => Object.assign([1, 2], { tag });
  same(tagged("x"), tagged("x"), true);
  same(tagged("x"), tagged("y"), false);
  same(tagged("x"), [1, 2], false);
  const sym = Symbol("s");
  same(Object.assign([1], { [sym]: 1 }), Object.assign([1], { [sym]: 2 }), false);
});

test("arrays: custom property holding an invalid Date is normalized too", () => {
  assert.equal(deepEqual(Object.assign([1], { d: invalid() }), Object.assign([1], { d: invalid() })), true);
  assert.equal(deepEqual(Object.assign([1], { d: invalid() }), Object.assign([1], { d: new Date(0) })), false);
});

test("Map / Set: entries, custom enumerable properties on the instance", () => {
  same(new Map([[1, "a"]]), new Map([[1, "a"]]), true);
  same(new Map([[1, "a"]]), new Map([[1, "b"]]), false);
  same(new Set([1, 2]), new Set([2, 1]), true);
  same(new Set([1, 2]), new Set([1]), false);
  same(Object.assign(new Map([[1, 2]]), { tag: "x" }), Object.assign(new Map([[1, 2]]), { tag: "x" }), true);
  same(Object.assign(new Map([[1, 2]]), { tag: "x" }), new Map([[1, 2]]), false);
  same(Object.assign(new Set([1]), { tag: "x" }), Object.assign(new Set([1]), { tag: "y" }), false);
});

test("Array / Map / Set subclasses keep their prototype", () => {
  class A extends Array<number> {}
  class M extends Map<number, number> {}
  class S extends Set<number> {}
  same(A.from([1, 2]), A.from([1, 2]), true);
  same(A.from([1, 2]), [1, 2], false);
  same(new M([[1, 2]]), new M([[1, 2]]), true);
  same(new M([[1, 2]]), new Map([[1, 2]]), false);
  same(new S([1]), new S([1]), true);
  same(new S([1]), new Set([1]), false);
});

test("normalization does not mutate its inputs", () => {
  const a = { d: invalid(), arr: Object.assign([1], { tag: "x" }), m: new Map([[invalid(), 1]]) };
  const before = { keys: Object.keys(a), arrTag: a.arr.tag, mapSize: a.m.size, dTime: a.d.getTime() };
  deepEqual(a, structuredClone({ d: invalid(), arr: [1], m: new Map() }));
  assert.deepEqual(Object.keys(a), before.keys);
  assert.equal(a.arr.tag, before.arrTag);
  assert.equal(a.m.size, before.mapSize);
  assert.ok(Number.isNaN(a.d.getTime()));
  assert.ok(a.d instanceof Date);
});

summary("harness self-test");
