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

/* 1) Pure schema: zero-copy ─────────────────────────────────────────── */

const Pure = z.object({
  id: z.number().int(),
  email: z.string().email(),
  tags: z.array(z.string()),
});
const CPure = compile(Pure);
console.log("pure flag:", CPure.pure);

const input = { id: 1, email: "a@b.co", tags: ["x"] };
console.log("parse(input) === input :", CPure.parse(input) === input);

/* 2) default injection: CoW path copying ───────────────────────────────── */

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
console.log("\nafter default injection:");
console.log("  out !== input        :", out !== missingRole, "(top level forced to copy)");
console.log("  out.role             :", out.role);
console.log(
  "  out.address === input.address :",
  out.address === missingRole.address,
  "(clean subtree shared)",
);
console.log("  'role' in input      :", "role" in missingRole, "(input untouched)");

/* 3) strip extra keys: a clean copy, never an in-place delete ─────────────────────── */

const evil: any = { id: 3, email: "x@y.co", tags: [], hacked: true };
const snapshot = JSON.stringify(evil);
const outStrip = CPure.parse(evil) as any;
console.log("\nafter stripping extra keys:");
console.log("  'hacked' in output   :", "hacked" in outStrip, "(output is clean)");
console.log("  input unchanged      :", JSON.stringify(evil) === snapshot, "(input untouched)");

/* 4) Type level: DeepReadonly signals structural sharing ──────────────────────── */

const readonlyView = CPure.validate(input);
// readonlyView.id = 42; // ← type error: the output shares with the input, do not modify
console.log("\nvalidate() returns a DeepReadonly type view:", readonlyView.id === 1);
