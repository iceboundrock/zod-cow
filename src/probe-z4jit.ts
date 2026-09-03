/**
 * 探针：zod4 官方 codegen（v4/core/compile.ts）的复用可行性验证。
 *
 * 验证四件事：
 *  1. compileFn / INVALID 能否从 "zod4/v4/core" 直接 import（复用入口）
 *  2. 官方生成的代码长什么样（debug 选项 dump 源码）
 *  3. assertOnly（validator 产物）对含 transform 子树的语义
 *  4. 性能基线：stock / 官方 parser 产物 / 官方 validator 产物 / zc CoW / arktype
 */
import { performance } from "node:perf_hooks";

/* ── 1. 复用入口验证 ── */
const core = await import("zod4/v4/core");
const { compileFn, INVALID } = core as any;
console.log("── 复用入口 ──");
console.log("  compileFn:", typeof compileFn, " INVALID:", String(INVALID));
console.log(
  "  compile:",
  typeof core.compile,
  " ZodCompileUnsupportedError:",
  typeof (core as any).ZodCompileUnsupportedError,
);

const { z } = await import("zod4");
const { compile } = await import("./index-z4.js");

/* ── 2. 代码 dump：官方为 object/array/enum/email 生成了什么 ── */
console.log("\n── 官方生成代码（parser 模式）──");
const Demo = z.object({
  a: z.string().max(4),
  b: z.email(),
  c: z.enum(["x", "y"]),
  d: z.array(z.number().int()),
});
const demoFn = compileFn(Demo, { debug: true });
console.log(demoFn.code);

console.log("\n── 官方生成代码（assertOnly 模式，同一 schema）──");
const demoVal = compileFn(Demo, { debug: true, assertOnly: true });
console.log(demoVal.code);

console.log("\n── 官方生成代码（含 default/transform/optional）──");
const Demo2 = z.object({
  keep: z.string(),
  role: z.enum(["a", "b"]).default("a"),
  len: z.string().transform((s: string) => s.length),
  opt: z.number().optional(),
});
console.log((compileFn(Demo2, { debug: true }) as any).code);

/* ── 3. assertOnly 语义验证 ── */
console.log("\n── assertOnly 语义 ──");
const ok = demoVal({ a: "abc", b: "u@e.com", c: "x", d: [1, 2] });
const bad = demoVal({ a: "toolong", b: "u@e.com", c: "x", d: [1, 2] });
console.log("  合法输入 →", ok, "（期望 true）");
console.log("  非法输入 →", bad, "（期望 INVALID）");
const p2 = compileFn(Demo2) as any;
console.log(
  "  transform 树 parser：",
  JSON.stringify(p2({ keep: "s", role: undefined, len: "abcd", opt: undefined })),
);
const v2 = compileFn(Demo2, { assertOnly: true } as any) as any;
console.log(
  "  transform 树 validator：",
  v2({ keep: "s", role: undefined, len: "abcd", opt: undefined }),
  "（校验语义保留，输出 true）",
);

/* ── 4. 性能基线（50 万账户，与 bench-z4 同数据集）── */
const N = Number(process.env.BENCH_N ?? 500_000);
const first = ["Ana", "Bob", "Cid", "Dee", "Eve", "Fay", "Gus", "Hal"];
const cities = ["NYC", "SFO", "SEA", "ATX", "CHI"];
const streets = ["Main St", "Oak Ave", "Elm Rd", "Pine Dr"];

const data: any[] = new Array(N);
for (let i = 0; i < N; i++) {
  data[i] = {
    id: i,
    firstName: first[i % first.length]!,
    lastName: "Doe",
    email: `user${i}@example.com`,
    role: ["admin", "member", "viewer"][i % 3],
    balance: (i % 1000) + 0.5,
    createdAt: `2025-0${1 + (i % 9)}-1${i % 9}T12:00:00.000Z`,
    tags: i % 3 === 0 ? ["a", "b"] : ["c"],
    address: {
      street: `${i % 9999} ${streets[i % streets.length]}`,
      city: cities[i % cities.length]!,
      zip: String(10000 + (i % 89999)),
      country: "US",
    },
    active: i % 2 === 0,
  };
}

const Account = z.object({
  id: z.number().int(),
  firstName: z.string().max(64),
  lastName: z.string().max(64),
  email: z.email(),
  role: z.enum(["admin", "member", "viewer"]),
  balance: z.number(),
  createdAt: z.iso.datetime(),
  tags: z.array(z.string()).max(8),
  address: z.object({ street: z.string(), city: z.string(), zip: z.string(), country: z.string() }),
  active: z.boolean(),
});
const Accounts = z.array(Account);

const accountValidator = compileFn(Account, { assertOnly: true }) as any; // 官方 validator（纯校验）
const accountsParser = compileFn(Accounts) as (i: unknown) => unknown;

// 现有 zc CoW 层
const Compiled = compile(Accounts);

const gc = (): void => (globalThis as any).gc?.();

function bench(label: string, fn: () => unknown, passes = 3): number {
  for (let i = 0; i < 2; i++) fn();
  const samples: number[] = [];
  let heap = 0;
  for (let p = 0; p < passes; p++) {
    gc();
    const hb = process.memoryUsage().heapUsed;
    const t0 = performance.now();
    const r = fn();
    heap = Math.max(heap, process.memoryUsage().heapUsed - hb);
    samples.push(performance.now() - t0);
    if (r === undefined) throw new Error("no result");
    (globalThis as any).__last = r;
  }
  samples.sort((a, b) => a - b);
  console.log(
    `  ${label.padEnd(44)} median ${samples[Math.floor(passes / 2)]!.toFixed(0).padStart(6)}ms  best ${samples[0]!.toFixed(0).padStart(6)}ms  heap +${(heap / 1048576).toFixed(0)}MB`,
  );
  return samples[Math.floor(passes / 2)]!;
}

console.log(`\n── 性能基线 · ${N.toLocaleString()} 账户数组 ──`);

// 正确性预检：官方 parser 产物输出 === stock 输出
const stockOut = Accounts.safeParse(data);
const jitOut = accountsParser(data) as any;
console.log("  官方 parser 产物输出 deepStrictEqual stock：");
let eq = true;
for (let i = 0; i < N; i += 9999)
  if (JSON.stringify(jitOut[i]) !== JSON.stringify((stockOut as any).data[i])) {
    eq = false;
    break;
  }
console.log("   ", eq ? "一致 ✓" : "不一致 ✗");
console.log("  官方 validator 产物（单账户）：", accountValidator(data[0]), "（true = 通过）");

const mStock = bench("stock zod4 safeParse（解释器）", () => Accounts.safeParse(data));
const mJitP = bench("官方 compileFn parser（stock 语义 JIT）", () => accountsParser(data));
const mJitV = bench("官方 compileFn validator（assertOnly 纯校验）", () => {
  let ok = 0;
  for (let i = 0; i < N; i++) if (accountValidator(data[i]) !== true) ok++;
  return ok;
});
const mZc = bench("zc CoW parse（Task3 自研编译层）", () => Compiled.safeParse(data));

console.log(`\n  比值（中位）: stock / 官方parser = ${(mStock / mJitP).toFixed(2)}x`);
console.log(
  `               官方parser / 官方validator = ${(mJitP / mJitV).toFixed(2)}x  ← 输出构造的净成本`,
);
console.log(`               stock / zc CoW = ${(mStock / mZc).toFixed(2)}x`);

/* ── 5. arktype 参照 ── */
try {
  const { type } = await import("arktype");
  const At = type({
    id: "number",
    firstName: "string<=64",
    lastName: "string<=64",
    email: "string.email",
    role: "'admin'|'member'|'viewer'",
    balance: "number",
    createdAt: "string",
    tags: "string[]",
    address: { street: "string", city: "string", zip: "string", country: "string" },
    active: "boolean",
  }).array();
  bench("arktype（参照线，不拷贝）", () => At(data));
} catch {
  console.log("  arktype 未安装，跳过");
}
