/**
 * 60-second demo of zod-cow-v4 against the published API.
 * Run from the repository root: pnpm run demo   (builds zod-cow-v4 first; this file imports the built package)
 *
 * Shows the promises of the CoW compilation layer:
 *   1. Pure validation is zero-copy: parse returns the input reference itself
 *   2. A forced change (a default firing) copies only the dirty path; clean siblings stay shared
 *   3. The input is never mutated, not even by strip
 *   4. validate() returns the input reference on success and null on failure
 *   5. The generated skeleton is inspectable through .code
 */
import { z } from "zod";
import { compile } from "zod-cow-v4";

/* 1) Pure schema: zero-copy ─────────────────────────────────────────── */

const Pure = z.object({
  id: z.number().int(),
  email: z.email(),
  tags: z.array(z.string()),
});
const CPure = compile(Pure);
console.log("degraded to stock:", CPure.stock, "(false = the CoW skeleton is in use)");

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

const missingRole = {
  id: 2,
  name: "Ana",
  address: { city: "NYC", zip: "10001" },
};
const out = CUser.parse(missingRole);
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

const evil = { id: 3, email: "x@y.co", tags: [], hacked: true };
const snapshot = JSON.stringify(evil);
const outStrip = CPure.parse(evil);
console.log("\nafter stripping extra keys:");
console.log("  'hacked' in output   :", "hacked" in outStrip, "(output is clean)");
console.log("  input unchanged      :", JSON.stringify(evil) === snapshot, "(input untouched)");

/* 4) validate(): the input reference or null ───────────────────────────────── */

console.log("\nvalidate():");
console.log("  validate(input) === input :", CPure.validate(input) === input);
console.log("  validate({ id: 'x' })     :", CPure.validate({ id: "x" }), "(null = rejected)");

/* 5) The generated skeleton ────────────────────────────────────────────────── */

console.log("\ngenerated skeleton (first lines of CPure.code):");
for (const line of (CPure.code ?? "").split("\n").slice(0, 6)) console.log(`  ${line}`);
