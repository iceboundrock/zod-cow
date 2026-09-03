/**
 * 60-second demo. Run: pnpm exec tsx examples/demo.ts
 *
 * Shows the three core promises of the CoW compilation layer:
 *   1. Pure validation is zero-copy (returns the input reference itself)
 *   2. A forced change copies only the dirty path (copy-on-write / path copying)
 *   3. The input is never mutated (contrast: the Numeric fork strips keys in place)
 */
import { z } from "zod";
import { compile } from "../src/index.js";

/* 1) 纯 schema：零拷贝 ─────────────────────────────────────────── */

const Pure = z.object({
  id: z.number().int(),
  email: z.string().email(),
  tags: z.array(z.string()),
});
const CPure = compile(Pure);
console.log("pure flag:", CPure.pure);

const input = { id: 1, email: "a@b.co", tags: ["x"] };
console.log("parse(input) === input :", CPure.parse(input) === input);

/* 2) default 注入：CoW 路径拷贝 ───────────────────────────────── */

const User = z.object({
  id: z.number().int(),
  name: z.string(),
  role: z.enum(["admin", "member", "viewer"]).default("viewer"),
  address: z.object({ city: z.string(), zip: z.string() }),
});
const CUser = compile(User);

const missingRole: any = {
  id: 2,
  name: "Ana",
  address: { city: "NYC", zip: "10001" },
};
const out = CUser.parse(missingRole) as any;
console.log("\ndefault 注入后：");
console.log("  out !== input        :", out !== missingRole, "（顶层被迫拷贝）");
console.log("  out.role             :", out.role);
console.log("  out.address === input.address :", out.address === missingRole.address, "（未脏子树共享）");
console.log("  'role' in input      :", "role" in missingRole, "（输入无损）");

/* 3) strip 多余键：干净副本，绝不原地删除 ─────────────────────── */

const evil: any = { id: 3, email: "x@y.co", tags: [], hacked: true };
const snapshot = JSON.stringify(evil);
const outStrip = CPure.parse(evil) as any;
console.log("\nstrip 多余键后：");
console.log("  'hacked' in output   :", "hacked" in outStrip, "（输出干净）");
console.log("  input unchanged      :", JSON.stringify(evil) === snapshot, "（输入无损）");

/* 4) 类型层面：DeepReadonly 提示结构共享 ──────────────────────── */

const readonlyView = CPure.validate(input);
// readonlyView.id = 42; // ← 类型错误：输出与输入共享，请勿修改
console.log("\nvalidate() 返回 DeepReadonly 类型视图：", readonlyView.id === 1);
