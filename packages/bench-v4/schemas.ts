/**
 * Schemas, datasets, products and fixture helpers shared by the bench-v4 scenario files.
 *
 * The account schema is the Numeric-article workload: a flat object with formatted strings, an
 * enum, a bounded array and a nested address. Every implementation under test gets a schema built
 * to the same constraints (the ArkType notes below say how each zod constraint is reproduced), and
 * every scenario file gates equivalence on fixtures before timing.
 */
import assert from "node:assert/strict";
import { ArkErrors, type } from "arktype";
import { z } from "zod";
import { compileFn, INVALID } from "zod/v4/core";
import { type Compiled, compile } from "zod-cow-v4";
import type { Fixture, Impl } from "./gates.js";

/**
 * Record count (`BENCH_N`, an integer of at least 10: S2 marks every tenth row as missing its role
 * and S7 runs on N / 10 rows).
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

/* ─────────────────────────── Schemas: zod4 ─────────────────────────── */

export const AccountStock = z.object({
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

export const AccountCow = AccountStock.extend({
  role: z.enum(["admin", "member", "viewer"]).default("viewer"),
});

export const AccountsStock = z.array(AccountStock);
export const AccountsCow = z.array(AccountCow);

/* ─────────────────────────── Schemas: ArkType ─────────────────────────── */

// Constraint-by-constraint equivalents of AccountStock / AccountCow, using ArkType's public API:
//   id          zod `.int()` is Number.isSafeInteger; ArkType `number.integer` alone is `% 1 === 0`
//               with no range bound, so the safe range is added with `number.safe`
//   names       zod `.max(64)` counts Unicode code points, ArkType `string <= 64` counts UTF-16
//               code units (`"😀".repeat(64)` passes zod and fails `string <= 64`), so the zod rule
//               is reproduced as `arkStringMax64` below
//   email,      ArkType's own `string.email` and `string.date.iso` keywords accept supersets of
//   createdAt   zod's patterns (`string.email` takes `a..b@x.com`, `.a@x.com`, `%`; `string.date.iso`
//               takes date-only `2025-01-10` and `+02:00` offsets, which `z.iso.datetime()` rejects).
//               The keywords are plain regex nodes inside ArkType, so the exact zod patterns are
//               used as ArkType regex constraints: identical accepted/rejected sets, same node kind.
//   role        the literal union; S2/S3 add `= 'viewer'` (ArkType's key default; it applies to
//               absent keys only, zod also defaults a present `undefined`, declared in the gate)
//   balance     zod `z.number()` rejects NaN and both infinities; ArkType `number` rejects NaN but
//               accepts ±Infinity, so the finite range is added explicitly (`arkFinite` below)
//   tags        `string[] <= 8`
//   address     nested object literal; extra keys pass through by reference (zod strips them; the
//               S1 to S7 data has none, S8 measures the strip case with `onDeepUndeclaredKey`)
export const patternOf = (schema: z.ZodType): RegExp => {
  const p = (schema as any)._zod.def.pattern;
  assert.ok(p instanceof RegExp, "zod string format without a pattern");
  return p;
};
export const emailPattern = patternOf(AccountStock.shape.email);
export const datetimePattern = patternOf(AccountStock.shape.createdAt);

/** true when `s` holds at most `max` Unicode code points (a code point is one or two UTF-16 units) */
const codePointsAtMost =
  (max: number) =>
  (s: string): boolean => {
    if (s.length > max * 2) return false;
    let n = 0;
    for (const _ of s) if (++n > max) return false;
    return true;
  };
// zod's `.max(64)` check is "accept when the UTF-16 length fits; otherwise count code points". The
// same two steps in ArkType: the native `string <= 64` bound as the first union branch, and a
// predicate that counts code points on the overflow branch only. Accepted set identical to zod,
// and the benchmark data (ASCII names) never leaves the native branch. A single `.narrow()` over
// every string would also be exact but costs ArkType a predicate call per name (about 1 ms per
// 50 000 rows in a probe), which would understate it.
export const arkStringMax64 = type("string <= 64").or(
  type("string > 64").narrow(codePointsAtMost(64)),
);
// ArkType has no finite-number keyword and its string DSL does not resolve `Infinity`, so the
// finite range goes in through the fluent range API: native range nodes, the same node kind as
// `<=` in the DSL. NaN is already rejected by ArkType's `number`.
export const arkFinite = type.number.atMost(Number.MAX_VALUE).atLeast(-Number.MAX_VALUE);

export const arkAccountShape = {
  id: "number.integer & number.safe",
  firstName: arkStringMax64,
  lastName: arkStringMax64,
  email: emailPattern,
  role: "'admin' | 'member' | 'viewer'",
  balance: arkFinite,
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
  const kwLen = type("string <= 64");
  const kwNum = type("number");
  const acc = (t: (i: unknown) => unknown, i: unknown) => !(t(i) instanceof ArkErrors);
  console.log(
    `  ArkType keyword check: string.email accepts ".a@example.com" = ${acc(kwEmail, ".a@example.com")} (zod: ${z.email().safeParse(".a@example.com").success}); string.date.iso accepts "2025-01-10" = ${acc(kwIso, "2025-01-10")} (zod: ${z.iso.datetime().safeParse("2025-01-10").success}) → the bench uses zod's patterns as ArkType regex constraints`,
  );
  console.log(
    `  ArkType keyword check: \`string <= 64\` accepts 64 astral code points = ${acc(kwLen, "😀".repeat(64))} (zod .max(64): ${z.string().max(64).safeParse("😀".repeat(64)).success}); \`number\` accepts Infinity = ${acc(kwNum, Number.POSITIVE_INFINITY)} (zod: ${z.number().safeParse(Number.POSITIVE_INFINITY).success}) → the bench counts code points on overflow (\`${arkStringMax64.expression}\`) and bounds numbers to the finite range (\`${arkFinite.expression}\`)`,
  );
}

/* ─────────────────────────── Products under test ─────────────────────────── */

export type Parser = (input: unknown) => unknown;

/** Internal `compileFn` products: the engineering control behind the public `z.compile()` */
export const officialParser = compileFn(AccountsStock) as Parser;
export const officialParserCow = compileFn(AccountsCow) as Parser;
export const officialValidator = compileFn(AccountsStock, { assertOnly: true }) as Parser;

/**
 * Public compiled API of Zod 4.5: `z.compile(schema)` returns a clone whose `safeParse` / `parse`
 * run the compiled parser and fall back to the runtime parser on failure; `z.validate(schema, v)`
 * runs the compiled validator (`_zod.bag.validator`) and falls back to the runtime on failure.
 */
export const PublicAccountsStock = z.compile(AccountsStock);
export const PublicAccountsCow = z.compile(AccountsCow);
export const PublicAccount = z.compile(AccountStock);
function assertCompiled(): void {
  // The public API silently returns the schema itself when it refuses to compile it; prove that
  // the benchmark measures a compiled clone, not the interpreter under a different label.
  for (const [name, c, s] of [
    ["AccountsStock", PublicAccountsStock, AccountsStock],
    ["AccountsCow", PublicAccountsCow, AccountsCow],
    ["AccountStock", PublicAccount, AccountStock],
  ] as const) {
    assert.ok(c !== s, `z.compile(${name}) returned the schema uncompiled`);
    assert.ok(
      typeof (c as any)._zod.bag.validator === "function",
      `z.compile(${name}) carries no validator`,
    );
  }
}
assertCompiled();

export const Z4Stock = compile(AccountsStock);
export const Z4Cow = compile(AccountsCow);
export const Z4Account = compile(AccountStock);
assert.ok(!Z4Stock.stock && !Z4Cow.stock && !Z4Account.stock, "zod-cow degraded to stock");

export const fail = (who: string): never => {
  throw new Error(`${who} rejected the benchmark input`);
};

/** Timed bodies: each one verifies the result so a rejection can never be timed as a success */
export const stockRun = (schema: z.ZodType, input: unknown) => () => {
  const r = schema.safeParse(input);
  return r.success ? r.data : fail("stock");
};
export const publicRun = (compiled: z.ZodType, input: unknown) => () => {
  const r = compiled.safeParse(input);
  return r.success ? r.data : fail("z.compile()");
};
export const officialRun = (fn: Parser, input: unknown) => () => {
  const r = fn(input);
  return r === INVALID ? fail("internal compiler product") : r;
};
export const zcRun = (c: Compiled<z.ZodType>, input: unknown) => () => {
  const r = c.safeParse(input);
  return r.success ? r.data : fail("zod-cow");
};
export const arkRun = (t: (input: unknown) => unknown, input: unknown) => () => {
  const r = t(input);
  return r instanceof ArkErrors ? fail("ArkType") : r;
};

/** Gate implementations for a parse scenario */
export const parseImpls = (
  schema: z.ZodType,
  compiled: z.ZodType,
  official: Parser,
  zc: Compiled<z.ZodType>,
  ark: (input: unknown) => unknown,
): Impl[] => [
  {
    column: "stock",
    label: "stock safeParse",
    accepts: (i) => schema.safeParse(i).success,
    output: (i) => schema.parse(i),
  },
  {
    column: "public",
    label: "z.compile() safeParse",
    accepts: (i) => compiled.safeParse(i).success,
    output: (i) => compiled.parse(i),
  },
  {
    column: "official",
    label: "internal compileFn parser",
    accepts: (i) => official(i) !== INVALID,
    output: (i) => official(i),
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

// Boundary fixtures for the constraints whose ArkType keyword differs from zod in unit (length in
// UTF-16 units vs code points) or in range (`number` accepts ±Infinity). Shared by every scenario
// that runs the account schema.
export const boundaryFixtures: Fixture[] = [
  {
    name: "firstName of 64 astral code points (128 UTF-16 units)",
    input: variant(sample, { firstName: "😀".repeat(64) }),
    accept: true,
  },
  {
    name: "lastName of exactly 64 ASCII characters",
    input: variant(sample, { lastName: "y".repeat(64) }),
    accept: true,
  },
  {
    name: "overlong firstName (65 astral code points)",
    input: variant(sample, { firstName: "😀".repeat(65) }),
    accept: false,
  },
  {
    name: "overlong lastName (64 ASCII + 1 astral)",
    input: variant(sample, { lastName: `${"y".repeat(64)}😀` }),
    accept: false,
  },
  {
    name: "balance is Infinity",
    input: variant(sample, { balance: Number.POSITIVE_INFINITY }),
    accept: false,
  },
  {
    name: "balance is -Infinity",
    input: variant(sample, { balance: Number.NEGATIVE_INFINITY }),
    accept: false,
  },
  { name: "balance is NaN", input: variant(sample, { balance: Number.NaN }), accept: false },
];

export const commonInvalid: Fixture[] = [
  { name: "non-integer id (1.5)", input: variant(sample, { id: 1.5 }), accept: false },
  {
    name: "unsafe integer id (2^53+2)",
    input: variant(sample, { id: 2 ** 53 + 2 }),
    accept: false,
  },
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

export const Point = z.tuple([z.number(), z.number()]);
export const Label = z.tuple([z.string(), z.optional(z.string())]);
export const TupleRow = z.object({ id: z.number().int(), point: Point, label: Label });
export const TupleRows = z.array(TupleRow);
export type S6Row = { id: number; point: [number, number]; label: [string, string?] };

// ArkType tuples: a fixed-length pair of finite numbers (`arkFinite`, since ArkType's `number`
// accepts ±Infinity and zod's does not) and an optional trailing element `"string?"`. `string?`
// means the slot may be absent; zod's `z.optional()` element also accepts a present `undefined`
// (declared in the gate; the benchmark data uses 1- and 2-element labels only).
export const ArkTupleRow = type({
  id: "number.integer & number.safe",
  point: [arkFinite, arkFinite],
  label: ["string", "string?"],
});
export const ArkTupleRows = ArkTupleRow.array();

export function makeTupleRows(): S6Row[] {
  const rows: S6Row[] = new Array(N);
  for (let i = 0; i < N; i++) {
    rows[i] = {
      id: i,
      point: [i % 360, i % 180],
      label: i % 2 === 0 ? [`L${i % 97}`, `T${i % 31}`] : [`L${i % 97}`],
    };
  }
  return rows;
}
