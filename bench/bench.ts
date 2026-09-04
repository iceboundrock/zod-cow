/**
 * Benchmark — reproduces the 500k-account scenario from the Numeric article.
 *
 *   S1 (main track): pure-validation schema (the Numeric scenario, no default/transform)
 *       - stock zod 3.24.1 .parse (deep-copy semantics)
 *       - zc compiled .parse (CoW: zero allocation expected)
 *       - arktype (reference line, no copying)
 *   S2 (CoW showcase): same schema but role carries a default, 10% of the data is missing role
 *       - stock vs zc: how CoW behaves under a "dirty load"
 *
 * Per variant: 1 warmup round + 3 timed rounds (started after gc()), reporting the best/median
 * time, the heapUsed delta after the run (allocation pressure, before gc) and the retained delta after gc.
 */
import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";
import { z } from "zod";
import { compile } from "../src/index.js";

const N = Number(process.env.BENCH_N ?? 500_000);
const PASSES = 3;

/* ─────────────────────────── Data generation ─────────────────────────── */

const first = ["Ana", "Bob", "Cid", "Dee", "Eve", "Fay", "Gus", "Hal"];
const cities = ["NYC", "SFO", "SEA", "ATX", "CHI"];
const streets = ["Main St", "Oak Ave", "Elm Rd", "Pine Dr"];

interface RawAccount {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  role?: string;
  balance: number;
  createdAt: string;
  tags: string[];
  address: { street: string; city: string; zip: string; country: string };
  active: boolean;
}

function makeAccounts(): RawAccount[] {
  const out: RawAccount[] = new Array(N);
  for (let i = 0; i < N; i++) {
    out[i] = {
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
  return out;
}

/** For S2: shallow-copy derivation (the nested address/tags are shared), 10% missing role → default injection path */
function deriveMissingRole(accounts: RawAccount[]): RawAccount[] {
  return accounts.map((a, i) => {
    if (i % 10 !== 5) return a;
    const { role: _role, ...rest } = a;
    return rest as RawAccount;
  });
}

/* ─────────────────────────── schemas ─────────────────────────── */

const AccountStock = z.object({
  id: z.number().int(),
  firstName: z.string().max(64),
  lastName: z.string().max(64),
  email: z.string().email(),
  role: z.enum(["admin", "member", "viewer"]),
  balance: z.number(),
  createdAt: z.string().datetime(),
  tags: z.array(z.string()).max(8),
  address: z.object({ street: z.string(), city: z.string(), zip: z.string(), country: z.string() }),
  active: z.boolean(),
});

const AccountCow = z.object({
  id: z.number().int(),
  firstName: z.string().max(64),
  lastName: z.string().max(64),
  email: z.string().email(),
  role: z.enum(["admin", "member", "viewer"]).default("viewer"),
  balance: z.number(),
  createdAt: z.string().datetime(),
  tags: z.array(z.string()).max(8),
  address: z.object({ street: z.string(), city: z.string(), zip: z.string(), country: z.string() }),
  active: z.boolean(),
});

const AccountsStock = z.array(AccountStock);
const AccountsCow = z.array(AccountCow);
const Compiled = compile(AccountsStock);
const CompiledCow = compile(AccountsCow);

/* ─────────────────────────── Measurement helpers ─────────────────────────── */

const gc = (): void => {
  (globalThis as any).gc?.();
};

interface Sample {
  ms: number;
  heapDelta: number; // heapUsed delta after the run (before gc) ≈ allocation pressure
  retainedDelta: number; // delta after gc ≈ retained
}

function measure(_label: string, fn: () => unknown): Sample[] {
  const samples: Sample[] = [];
  for (let p = -1; p < PASSES; p++) {
    gc();
    const heapBefore = process.memoryUsage().heapUsed;
    const t0 = performance.now();
    const result = fn(); // keep the result to prevent dead-code elimination
    const t1 = performance.now();
    const heapAfter = process.memoryUsage().heapUsed;
    gc();
    const heapAfterGc = process.memoryUsage().heapUsed;
    if (p >= 0) {
      samples.push({
        ms: t1 - t0,
        heapDelta: heapAfter - heapBefore,
        retainedDelta: heapAfterGc - heapBefore,
      });
    }
    if (result === undefined) throw new Error("no result");
    (globalThis as any).__last = result;
  }
  return samples;
}

function report(label: string, samples: Sample[]): { best: number; median: number } {
  const ms = samples.map((s) => s.ms).sort((a, b) => a - b);
  const best = ms[0]!;
  const median = ms[Math.floor(ms.length / 2)]!;
  const heap = samples.reduce((m, s) => Math.max(m, s.heapDelta), 0);
  const retained = samples.reduce((m, s) => Math.max(m, s.retainedDelta), 0);
  const fmt = (v: number) =>
    v > 0 ? `+${(v / 1048576).toFixed(1)}MB` : `${(v / 1048576).toFixed(1)}MB`;
  console.log(
    `  ${label.padEnd(38)} best ${best.toFixed(0).padStart(6)}ms   median ${median
      .toFixed(0)
      .padStart(6)}ms   alloc ${fmt(heap).padStart(10)}   retained ${fmt(retained).padStart(10)}`,
  );
  return { best, median };
}

const median = (samples: Sample[]) =>
  samples.map((s) => s.ms).sort((a, b) => a - b)[Math.floor(PASSES / 2)]!;

/* ─────────────────────────── S1: pure-validation main track ─────────────────────────── */

console.log(
  `\n═══ S1 pure validation · ${N.toLocaleString()} accounts · ${PASSES} rounds per variant ═══`,
);
const data = makeAccounts();
const dataCow = deriveMissingRole(data);

// Correctness precheck: the output values must match stock
{
  const stockOut = AccountsStock.safeParse(data);
  assert.ok(stockOut.success);
  const cowOut = Compiled.safeParse(data);
  assert.ok(cowOut.success);
  assert.deepStrictEqual(cowOut.data, stockOut.data);
  console.log(
    `  correctness: deepStrictEqual ✓   CoW output === input ref: ${cowOut.data === data ? "yes (zero-copy)" : "no"}`,
  );
}

const s1Stock = measure("stock zod3 parse (deep copy)", () => AccountsStock.parse(data));
const s1Cow = measure("zc compiled parse (CoW)", () => Compiled.parse(data));
report("stock zod3 parse (deep copy)", s1Stock);
report("zc compiled parse (CoW)", s1Cow);
console.log(`  → speedup: ${(median(s1Stock) / median(s1Cow)).toFixed(2)}x (by median)`);

// arktype reference line (optional)
try {
  const { type } = await import("arktype");
  const At = type({
    id: "number",
    firstName: "string<=64",
    lastName: "string<=64",
    email: "string.email",
    role: "'admin'|'member'|'viewer'",
    balance: "number",
    createdAt: "string", // arktype's datetime keyword has different semantics; approximate with string
    tags: "string[]",
    address: { street: "string", city: "string", zip: "string", country: "string" },
    active: "boolean",
  }).array();
  const s1Ark = measure("arktype (reference line, no copying)", () => At(data));
  report("arktype (reference line, no copying)", s1Ark);
  console.log(`  → zc vs arktype: ${(median(s1Cow) / median(s1Ark)).toFixed(2)}x (by median)`);
} catch {
  console.log("  arktype not installed, skipping the reference line");
}

/* ─────────────────────────── S2: CoW dirty load ─────────────────────────── */

console.log(
  `\n═══ S2 CoW dirty load · role carries a default · 10% of the data is missing role ═══`,
);
{
  const stockOut = AccountsCow.safeParse(dataCow);
  assert.ok(stockOut.success);
  const cowOut = CompiledCow.safeParse(dataCow);
  assert.ok(cowOut.success);
  assert.deepStrictEqual(cowOut.data, stockOut.data);
  let injected = 0;
  for (let i = 0; i < N; i++) if (!("role" in dataCow[i]!)) injected++;
  console.log(
    `  correctness: deepStrictEqual ✓   missing-role share ${((injected / N) * 100).toFixed(1)}%`,
  );
}

const s2Stock = measure("stock zod3 parse (default scenario)", () => AccountsCow.parse(dataCow));
const s2Cow = measure("zc compiled parse (CoW: 90% zero-copy)", () => CompiledCow.parse(dataCow));
report("stock zod3 parse (default scenario)", s2Stock);
report("zc compiled parse (CoW: 90% zero-copy)", s2Cow);
console.log(`  → speedup: ${(median(s2Stock) / median(s2Cow)).toFixed(2)}x (by median)`);

console.log(
  "\nNote: alloc = the heapUsed delta at the end of the run (before gc), including garbage + retained;",
);
console.log(
  "    stock rebuilds the whole output tree every round; CoW returns the input reference on the pure path (≈0 allocation).",
);
