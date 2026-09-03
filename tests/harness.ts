/**
 * 极简单元测试框架（零依赖，确定性输出）
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
 * 深度严格相等（布尔版），语义等同 assert.deepStrictEqual，唯一差别：
 * 两个 Invalid Date（getTime() 为 NaN）视为相等。
 *
 * 背景：Node 22 的 deepStrictEqual 用 `!==` 比较 Date.getTime()，NaN !== NaN，
 * 于是 `new Date(NaN)` 与它的 structuredClone 被判为不等（Node 24+ 已修复）。
 * 差分模糊测试的输入池含 `new Date(NaN)`，在 Node 22 上会被误报为 INPUT MUTATED。
 * 这里不重写比较器，只把 Invalid Date 归一化为同一个哨兵对象，其余仍交给 Node 判断。
 */
// 私有 class 实例作哨兵：原型不是 Object.prototype，普通输入无法伪造出与之 deepStrictEqual 的值
class InvalidDateMarker {}
const INVALID_DATE = Object.freeze(new InvalidDateMarker());

function normalizeForCompare(v: unknown): unknown {
  if (typeof v !== "object" || v === null) return v;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? INVALID_DATE : v;
  if (Array.isArray(v)) return v.map(normalizeForCompare);
  if (v instanceof Map) {
    return new Map([...v].map(([k, x]) => [normalizeForCompare(k), normalizeForCompare(x)]));
  }
  if (v instanceof Set) return new Set([...v].map(normalizeForCompare));
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return v; // 非普通对象：原样交给 deepStrictEqual
  const out = Object.create(proto);
  for (const k of Reflect.ownKeys(v)) {
    const d = Object.getOwnPropertyDescriptor(v, k)!;
    if (!d.enumerable) continue;
    // defineProperty 而非赋值：避免 "__proto__" 键触发原型写入
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
