/**
 * Schemas, datasets, products and fixture helpers shared by the bench-v3 scenario files.
 *
 * The account schema is the Numeric-article workload (the same data as bench-v4, for continuity
 * with the earlier zod3 tables): a flat object with formatted strings, an enum, a bounded array
 * and a nested address. Every implementation under test gets a schema built to the same
 * constraints (the ArkType notes below say how each zod3 constraint is reproduced), and every
 * scenario file gates equivalence on fixtures before timing.
 */
import assert from "node:assert/strict";
import { ArkErrors, type } from "arktype";
import { datetimeRegex, z } from "zod";
import { type Compiled, compile } from "zod-cow-v3";
import type { Fixture, Impl } from "./gates.js";

/**
 * Record count (`BENCH_N`, an integer of at least 10: S2 marks every tenth row as missing its role
 * and the failure datasets mark every hundredth row invalid).
 */
export const N = Number(process.env.BENCH_N ?? 500_000);
if (!Number.isInteger(N) || N < 10) {
  throw new Error(
    `BENCH_N must be an integer of at least 10, got ${JSON.stringify(process.env.BENCH_N)}`,
  );
}

/* ─────────────────────────── Data generation ─────────────────────────── */

const first = ["Ana", "Bob", "Cid", "Dee", "Eve", "Fay", "Gus", "Hal"];
const cities = ["NYC", "SFO", "SEA", "ATX", "CHI"];
const streets = ["Main St", "Oak Ave", "Elm Rd", "Pine Dr"];

export interface RawAccount {
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

export function makeAccounts(): RawAccount[] {
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

/** Shallow-copy derivation: every `everyNth`-th row loses its role (nested address/tags shared) */
export function deriveMissingRole(
  accounts: RawAccount[],
  everyNth: number,
  offset: number,
): RawAccount[] {
  if (everyNth <= 0) return accounts;
  return accounts.map((a, i) => {
    if (i % everyNth !== offset % everyNth) return a;
    const { role: _role, ...rest } = a;
    return rest as RawAccount;
  });
}

/** One account with a field replaced, as a single-element array (every array schema under test) */
export const variant = (base: RawAccount, patch: Record<string, unknown>): unknown[] => [
  { ...structuredClone(base), ...patch },
];
export const without = (base: RawAccount, key: keyof RawAccount): unknown[] => {
  const copy: Record<string, unknown> = { ...structuredClone(base) };
  delete copy[key];
  return [copy];
};
/** The same two helpers for a single object (the per-record scenarios) */
export const variantOne = (base: RawAccount, patch: Record<string, unknown>): unknown => ({
  ...structuredClone(base),
  ...patch,
});

/* ─────────────────────────── Schemas: zod3 ─────────────────────────── */

export const AccountStock = z.object({
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

export const AccountCow = AccountStock.extend({
  role: z.enum(["admin", "member", "viewer"]).default("viewer"),
});

export const AccountsStock = z.array(AccountStock);
export const AccountsCow = z.array(AccountCow);

/* ─────────────────────────── Schemas: ArkType ─────────────────────────── */

// Constraint-by-constraint equivalents of AccountStock / AccountCow, using ArkType's public API.
// zod 3.24.1 differs from zod 4 in three of these constraints, so the mapping is not the bench-v4
// one:
//   id          zod3 `.int()` is `Number.isInteger` (no safe-range bound: 2^53 + 2 is accepted,
//               Infinity is rejected); ArkType `number.integer` is exactly that
//   names       zod3 `.max(64)` compares `.length`, i.e. UTF-16 code units, the same unit as
//               ArkType `string <= 64` (zod 4 counts code points; bench-v4 reproduces that rule)
//   email,      ArkType's own `string.email` and `string.date.iso` keywords accept supersets of
//   createdAt   zod's patterns (`.a@x.com`, date-only dates, offsets), so zod3's exact regexes are
//               used as ArkType regex constraints: `datetimeRegex` is exported by zod 3.24.1 and
//               the email regex is copied verbatim (zod3 does not export it); the gate holds
//               fixtures for both
//   role        the literal union; S2/S3 add `= 'viewer'` (ArkType's key default; it applies to
//               absent keys only, zod also defaults a present `undefined`, declared in the gate)
//   balance     zod3 `z.number()` rejects NaN and accepts both infinities, the same as ArkType
//               `number` (zod 4 rejects the infinities; bench-v4 adds a finite range for that)
//   tags        `string[] <= 8`
//   address     nested object literal; extra keys pass through by reference (zod strips them; the
//               S1 to S7 data has none, S8 measures the strip case with `onDeepUndeclaredKey`)
/** zod 3.24.1's email regex (lib/index.mjs), the pattern behind `z.string().email()` */
export const emailPattern =
  // biome-ignore lint/complexity/noUselessEscapeInRegex: copied verbatim from zod 3.24.1
  /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$/i;
/** The pattern behind `z.string().datetime()` (no precision, no offset, no local) */
export const datetimePattern = datetimeRegex({ precision: null, offset: false, local: false });

export const arkAccountShape = {
  id: "number.integer",
  firstName: "string <= 64",
  lastName: "string <= 64",
  email: emailPattern,
  role: "'admin' | 'member' | 'viewer'",
  balance: "number",
  createdAt: datetimePattern,
  tags: "string[] <= 8",
  address: { street: "string", city: "string", zip: "string", country: "string" },
  active: "boolean",
} as const;

export const ArkAccount = type(arkAccountShape);
export const ArkAccounts = ArkAccount.array();
export const ArkAccountsCow = type({
  ...arkAccountShape,
  role: "'admin' | 'member' | 'viewer' = 'viewer'",
}).array();

/** Print the keyword divergences once so the substitutions above are visible in every log */
export function printArkKeywordChecks(): void {
  const kwEmail = type("string.email");
  const kwIso = type("string.date.iso");
  const acc = (t: (i: unknown) => unknown, i: unknown) => !(t(i) instanceof ArkErrors);
  const emailOk = (s: string) => z.string().email().safeParse(s).success;
  const dtOk = (s: string) => z.string().datetime().safeParse(s).success;
  console.log(
    `  ArkType keyword check: string.email accepts ".a@example.com" = ${acc(kwEmail, ".a@example.com")} (zod3: ${emailOk(".a@example.com")}); string.date.iso accepts "2025-01-10" = ${acc(kwIso, "2025-01-10")} (zod3: ${dtOk("2025-01-10")}) → the bench uses zod3's patterns as ArkType regex constraints`,
  );
  // The copied email regex must agree with zod3 on every fixture string used below
  for (const s of [
    "user7@example.com",
    ".a@example.com",
    "a..b@example.com",
    "user@example",
    "not-an-email",
    "a+b@x.co",
    "a%b@x.co",
  ]) {
    assert.equal(emailPattern.test(s), emailOk(s), `email regex copy diverges from zod3 on ${s}`);
  }
  console.log(
    `  zod3 unit check: .max(64) counts UTF-16 units like ArkType \`string <= 64\` (64 astral characters: zod3 ${z.string().max(64).safeParse("😀".repeat(64)).success}, ArkType ${acc(type("string <= 64"), "😀".repeat(64))}); z.number() accepts Infinity like ArkType \`number\` (zod3 ${z.number().safeParse(Number.POSITIVE_INFINITY).success}, ArkType ${acc(type("number"), Number.POSITIVE_INFINITY)}); .int() accepts 2^53+2 like \`number.integer\` (zod3 ${
      z
        .number()
        .int()
        .safeParse(2 ** 53 + 2).success
    }, ArkType ${acc(type("number.integer"), 2 ** 53 + 2)})`,
  );
}

/* ─────────────────────────── Products under test ─────────────────────────── */

export const Z3Stock = compile(AccountsStock);
export const Z3Cow = compile(AccountsCow);
export const Z3Account = compile(AccountStock);
assert.ok(Z3Stock.pure && !Z3Cow.pure && Z3Account.pure, "unexpected static purity");

export const fail = (who: string): never => {
  throw new Error(`${who} rejected the benchmark input`);
};

/** Timed bodies: each one verifies the result so a rejection can never be timed as a success */
export const stockRun = (schema: z.ZodTypeAny, input: unknown) => () => {
  const r = schema.safeParse(input);
  return r.success ? r.data : fail("stock");
};
export const zcRun = (c: Compiled<z.ZodTypeAny>, input: unknown) => () => {
  const r = c.safeParse(input);
  return r.success ? r.data : fail("zod-cow");
};
export const arkRun = (t: (input: unknown) => unknown, input: unknown) => () => {
  const r = t(input);
  return r instanceof ArkErrors ? fail("ArkType") : r;
};

/** Gate implementations for a parse scenario */
export const parseImpls = (
  schema: z.ZodTypeAny,
  zc: Compiled<z.ZodTypeAny>,
  ark: (input: unknown) => unknown,
): Impl[] => [
  {
    column: "stock",
    label: "stock safeParse",
    accepts: (i) => schema.safeParse(i).success,
    output: (i) => schema.parse(i),
  },
  {
    column: "zc",
    label: "zod-cow safeParse",
    accepts: (i) => zc.safeParse(i).success,
    output: (i) => zc.parse(i),
  },
  {
    column: "ark",
    label: "ArkType Type(data)",
    accepts: (i) => !(ark(i) instanceof ArkErrors),
    output: (i) => ark(i),
  },
];

/* ─────────────────────────── The S1 dataset and its fixtures ─────────────────────────── */

export const data = makeAccounts();
export const sample = data[7]!;

// Boundary fixtures for the constraints whose zod3 rule differs from zod 4 (UTF-16 length, the
// infinities under `z.number()`, the unbounded `.int()`); every implementation must agree.
export const boundaryFixtures: Fixture[] = [
  {
    name: "lastName of exactly 64 ASCII characters",
    input: variant(sample, { lastName: "y".repeat(64) }),
    accept: true,
  },
  {
    name: "firstName of 64 astral code points (128 UTF-16 units, rejected by zod3 .max(64))",
    input: variant(sample, { firstName: "😀".repeat(64) }),
    accept: false,
  },
  {
    name: "firstName of 32 astral code points (64 UTF-16 units)",
    input: variant(sample, { firstName: "😀".repeat(32) }),
    accept: true,
  },
  {
    name: "balance is Infinity (accepted by zod3 z.number())",
    input: variant(sample, { balance: Number.POSITIVE_INFINITY }),
    accept: true,
  },
  { name: "balance is NaN", input: variant(sample, { balance: Number.NaN }), accept: false },
  {
    name: "unsafe integer id (2^53+2, accepted by zod3 .int())",
    input: variant(sample, { id: 2 ** 53 + 2 }),
    accept: true,
  },
  {
    name: "id is Infinity",
    input: variant(sample, { id: Number.POSITIVE_INFINITY }),
    accept: false,
  },
];

export const commonInvalid: Fixture[] = [
  { name: "non-integer id (1.5)", input: variant(sample, { id: 1.5 }), accept: false },
  {
    name: "overlong firstName (65)",
    input: variant(sample, { firstName: "x".repeat(65) }),
    accept: false,
  },
  {
    name: "malformed email (not-an-email)",
    input: variant(sample, { email: "not-an-email" }),
    accept: false,
  },
  {
    name: "malformed email (user@example)",
    input: variant(sample, { email: "user@example" }),
    accept: false,
  },
  {
    name: "leading-dot email (.a@example.com)",
    input: variant(sample, { email: ".a@example.com" }),
    accept: false,
  },
  {
    name: "date-only createdAt",
    input: variant(sample, { createdAt: "2025-01-10" }),
    accept: false,
  },
  {
    name: "offset createdAt (+02:00)",
    input: variant(sample, { createdAt: "2025-01-10T12:00:00+02:00" }),
    accept: false,
  },
  {
    name: "malformed createdAt",
    input: variant(sample, { createdAt: "not-a-date" }),
    accept: false,
  },
  { name: "invalid role (root)", input: variant(sample, { role: "root" }), accept: false },
  {
    name: "oversized tags (9)",
    input: variant(sample, { tags: "abcdefghi".split("") }),
    accept: false,
  },
  {
    name: "nested address.zip is a number",
    input: variant(sample, { address: { ...sample.address, zip: 12345 } }),
    accept: false,
  },
  { name: "balance is a string", input: variant(sample, { balance: "1" }), accept: false },
  // Non-string values for the regex-constrained fields: a bare RegExp field in ArkType implies a
  // string base, so these must be rejected by every implementation, not just by zod
  { name: "email is a number", input: variant(sample, { email: 123 }), accept: false },
  { name: "createdAt is null", input: variant(sample, { createdAt: null }), accept: false },
  { name: "not an array", input: sample, accept: false },
];

/* ─────────────────────────── The S6 tuple row (shared with S9) ─────────────────────────── */

// zod3 tuples have no optional slots: `[string, string?]` still needs two elements and the
// second may hold undefined (an absent slot is `too_small`). ArkType `[string, string | undefined]`
// accepts exactly the same arrays, so no divergence has to be declared.
export const Point = z.tuple([z.number(), z.number()]);
export const Label = z.tuple([z.string(), z.string().optional()]);
export const TupleRow = z.object({ id: z.number().int(), point: Point, label: Label });
export const TupleRows = z.array(TupleRow);
export type S6Row = { id: number; point: [number, number]; label: [string, string | undefined] };

export const ArkTupleRow = type({
  id: "number.integer",
  point: ["number", "number"],
  label: ["string", "string | undefined"],
});
export const ArkTupleRows = ArkTupleRow.array();

export function makeTupleRows(): S6Row[] {
  const rows: S6Row[] = new Array(N);
  for (let i = 0; i < N; i++) {
    rows[i] = {
      id: i,
      point: [i % 360, i % 180],
      label: [`L${i % 97}`, i % 2 === 0 ? `T${i % 31}` : undefined],
    };
  }
  return rows;
}
