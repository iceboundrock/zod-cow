/**
 * Benchmark for the zod4 line (zod-cow-v4: official codegen + CoW skeletons), reproducing the
 * 500k-account scenario from the Numeric article, with ArkType as a first-class external baseline.
 *
 * Four columns, measured in every scenario where an equivalent workload exists:
 *   stock Zod 4      safeParse, interpreter baseline (rebuilds the whole output tree on every parse)
 *   official JIT     zod4's own compileFn parser product, stock semantics (always allocates new
 *                    containers): the "reuse only, no skeleton" control
 *   zod-cow-v4       the subject: official codegen + CoW container skeletons
 *   ArkType          external control, normal public API (direct Type invocation for parse,
 *                    `.allows()` for validation-only), schema built to the same constraints
 *
 * Scenarios:
 *   S1 pure validation parse   clean input; CoW should return the input reference with zero copies
 *   S2 10% default             `role` carries a default and 10% of the rows are missing it
 *   S3 dirty sweep             missing-role ratio 0% / 25% / 50% / 100%
 *   S4 validation only         official assertOnly / zod-cow validate / ArkType allows
 *   S5 record / map / set      one record + one Map + one Set per row
 *   S6 tuple                   [number, number] and [string, string?] per row
 *   S7 async transform         async lowercase transform on one leaf (safeParseAsync)
 *
 * Fairness rules (see harness.ts and gates.ts): compilation and fixture construction stay outside
 * the timed region; every candidate gets the same warmup and the same rotated, gc()-separated
 * timed rounds on the identical input; every timed call verifies its own result; and before a
 * scenario is timed, an equivalence gate runs valid and deliberately invalid fixtures through every
 * implementation and aborts on an undeclared disagreement. Where ArkType cannot express the
 * workload natively the column prints `N/A — <reason>` and is excluded from the ratios.
 */
import assert from "node:assert/strict";
import { ArkErrors, type } from "arktype";
import { z } from "zod";
import { compileFn, INVALID, ZodCompileAsyncError } from "zod/v4/core";
import { type Compiled, compile } from "zod-cow-v4";
import { type Fixture, gate, type Impl } from "./gates.js";
import {
  PASSES,
  printRatios,
  printSummary,
  runScenario,
  type ScenarioRun,
  WARMUP,
} from "./harness.js";

const N = Number(process.env.BENCH_N ?? 500_000);

console.log(
  `bench-v4 · ${N.toLocaleString()} records · ${WARMUP} warmup + ${PASSES} interleaved timed rounds per candidate · node ${process.version}`,
);

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

function deriveMissingRole(accounts: RawAccount[], everyNth: number, offset: number): RawAccount[] {
  if (everyNth <= 0) return accounts;
  return accounts.map((a, i) => {
    if (i % everyNth !== offset % everyNth) return a;
    const { role: _role, ...rest } = a;
    return rest as RawAccount;
  });
}

/** One account with a field replaced, as a single-element array (every schema under test is an array) */
const variant = (base: RawAccount, patch: Record<string, unknown>): unknown[] => [
  { ...structuredClone(base), ...patch },
];
const without = (base: RawAccount, key: keyof RawAccount): unknown[] => {
  const copy: Record<string, unknown> = { ...structuredClone(base) };
  delete copy[key];
  return [copy];
};

/* ─────────────────────────── Schemas: zod4 ─────────────────────────── */

const AccountStock = z.object({
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

const AccountCow = AccountStock.extend({
  role: z.enum(["admin", "member", "viewer"]).default("viewer"),
});

const AccountsStock = z.array(AccountStock);
const AccountsCow = z.array(AccountCow);

/* ─────────────────────────── Schemas: ArkType ─────────────────────────── */

// Constraint-by-constraint equivalents of AccountStock / AccountCow, using ArkType's public API:
//   id          zod `.int()` is Number.isSafeInteger; ArkType `number.integer` alone is `% 1 === 0`
//               with no range bound, so the safe range is added with `number.safe`
//   names       `string <= 64`, same inclusive bound as `.max(64)`
//   email,      ArkType's own `string.email` and `string.date.iso` keywords accept supersets of
//   createdAt   zod's patterns (`string.email` takes `a..b@x.com`, `.a@x.com`, `%`; `string.date.iso`
//               takes date-only `2025-01-10` and `+02:00` offsets, which `z.iso.datetime()` rejects).
//               The keywords are plain regex nodes inside ArkType, so the exact zod patterns are
//               used as ArkType regex constraints: identical accepted/rejected sets, same node kind.
//   role        the literal union; S2/S3 add `= 'viewer'` (ArkType's key default; it applies to
//               absent keys only, zod also defaults a present `undefined`, declared in the gate)
//   tags        `string[] <= 8`
//   address     nested object literal; extra keys pass through by reference (zod strips them, the
//               benchmark data has none)
const patternOf = (schema: z.ZodType): RegExp => {
  const p = (schema as any)._zod.def.pattern;
  assert.ok(p instanceof RegExp, "zod string format without a pattern");
  return p;
};
const emailPattern = patternOf(AccountStock.shape.email);
const datetimePattern = patternOf(AccountStock.shape.createdAt);

const arkAccountShape = {
  id: "number.integer & number.safe",
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

const ArkAccounts = type(arkAccountShape).array();
const ArkAccountsCow = type({
  ...arkAccountShape,
  role: "'admin' | 'member' | 'viewer' = 'viewer'",
}).array();

// Keyword divergences, printed once so the substitution above is visible in every log
{
  const kwEmail = type("string.email");
  const kwIso = type("string.date.iso");
  const acc = (t: (i: unknown) => unknown, i: unknown) => !(t(i) instanceof ArkErrors);
  console.log(
    `  ArkType keyword check: string.email accepts ".a@example.com" = ${acc(kwEmail, ".a@example.com")} (zod: ${z.email().safeParse(".a@example.com").success}); string.date.iso accepts "2025-01-10" = ${acc(kwIso, "2025-01-10")} (zod: ${z.iso.datetime().safeParse("2025-01-10").success}) → the bench uses zod's patterns as ArkType regex constraints`,
  );
}

/* ─────────────────────────── Products under test ─────────────────────────── */

type Parser = (input: unknown) => unknown;

const officialParser = compileFn(AccountsStock) as Parser;
const officialParserCow = compileFn(AccountsCow) as Parser;
const officialValidator = compileFn(AccountsStock, { assertOnly: true }) as Parser;

const Z4Stock = compile(AccountsStock);
const Z4Cow = compile(AccountsCow);
assert.ok(!Z4Stock.stock && !Z4Cow.stock, "zod-cow degraded to stock (unexpected)");

const fail = (who: string): never => {
  throw new Error(`${who} rejected the benchmark input`);
};

/** Timed bodies: each one verifies the result so a rejection can never be timed as a success */
const stockRun = (schema: z.ZodType, input: unknown) => () => {
  const r = schema.safeParse(input);
  return r.success ? r.data : fail("stock");
};
const officialRun = (fn: Parser, input: unknown) => () => {
  const r = fn(input);
  return r === INVALID ? fail("official JIT") : r;
};
const zcRun = (c: Compiled<z.ZodType>, input: unknown) => () => {
  const r = c.safeParse(input);
  return r.success ? r.data : fail("zod-cow");
};
const arkRun = (t: (input: unknown) => unknown, input: unknown) => () => {
  const r = t(input);
  return r instanceof ArkErrors ? fail("ArkType") : r;
};

/** Gate implementations for a parse scenario */
const parseImpls = (
  schema: z.ZodType,
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
    column: "official",
    label: "official compileFn parser",
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

const runs: ScenarioRun[] = [];

/* ─────────────────────────── S1: pure validation parse ─────────────────────────── */

const data = makeAccounts();
const sample = data[7]!;

{
  const stockOut = AccountsStock.parse(data);
  const zcOut = Z4Stock.parse(data);
  const arkOut = ArkAccounts(data);
  assert.ok(!(arkOut instanceof ArkErrors), "ArkType rejected the S1 data");
  assert.deepStrictEqual(zcOut, stockOut);
  assert.deepStrictEqual(arkOut, stockOut);
  console.log(
    `\n  S1 output reference: zod-cow === input ${zcOut === data ? "yes (zero-copy)" : "no"} · ArkType === input ${arkOut === data ? "yes (validation returns the input)" : "no"} · stock === input ${(stockOut as unknown) === data ? "yes" : "no (rebuilt)"}`,
  );

  const commonInvalid: Fixture[] = [
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
  await gate("S1", parseImpls(AccountsStock, officialParser, Z4Stock, ArkAccounts), [
    { name: "valid account", input: [sample], accept: true },
    {
      name: "valid account with an extra key",
      input: variant(sample, { extra: 1 }),
      accept: true,
      outputDiffers:
        "zod strips undeclared keys into a copy, ArkType passes them through by reference",
    },
    { name: "missing role", input: without(sample, "role"), accept: false },
    { name: "present-undefined role", input: variant(sample, { role: undefined }), accept: false },
    ...commonInvalid,
  ]);

  const run = await runScenario(
    "S1 pure validation parse",
    `${N.toLocaleString()} accounts, clean input`,
    [
      {
        column: "stock",
        label: "stock zod4 safeParse (interpreter)",
        run: stockRun(AccountsStock, data),
      },
      {
        column: "official",
        label: "official compileFn parser (JIT, stock sem.)",
        run: officialRun(officialParser, data),
      },
      {
        column: "zc",
        label: "zod-cow-v4 safeParse (codegen + CoW skeleton)",
        run: zcRun(Z4Stock, data),
      },
      { column: "ark", label: "ArkType Type(data) (parse path)", run: arkRun(ArkAccounts, data) },
    ],
  );
  printRatios(run);
  runs.push(run);
}

/* ─────────────────────────── S2: 10% default injection ─────────────────────────── */

const dataCow = deriveMissingRole(data, 10, 5);
const cowGateFixtures: Fixture[] = [
  { name: "valid account (role present)", input: [sample], accept: true },
  { name: "missing role → default viewer", input: without(sample, "role"), accept: true },
  {
    name: "present-undefined role",
    input: variant(sample, { role: undefined }),
    accept: { stock: true, official: true, zc: true, ark: false },
    divergence:
      "zod applies the default to a present key holding undefined; ArkType key defaults apply to absent keys only (the benchmark data only has absent keys)",
  },
  { name: "invalid role (root)", input: variant(sample, { role: "root" }), accept: false },
  { name: "non-integer id (1.5)", input: variant(sample, { id: 1.5 }), accept: false },
  {
    name: "malformed email (not-an-email)",
    input: variant(sample, { email: "not-an-email" }),
    accept: false,
  },
  {
    name: "date-only createdAt",
    input: variant(sample, { createdAt: "2025-01-10" }),
    accept: false,
  },
];

{
  let injected = 0;
  for (let i = 0; i < N; i++) if (!("role" in dataCow[i]!)) injected++;
  const stockOut = AccountsCow.parse(dataCow);
  const zcOut = Z4Cow.parse(dataCow);
  const arkOut = ArkAccountsCow(dataCow);
  assert.ok(!(arkOut instanceof ArkErrors), "ArkType rejected the S2 data");
  assert.deepStrictEqual(zcOut, stockOut);
  assert.deepStrictEqual(arkOut, stockOut);
  const arkSharesRows = arkOut.filter((row, i) => row === dataCow[i]).length;
  const zcSharesRows = zcOut.filter((row, i) => row === dataCow[i]).length;
  console.log(
    `\n  S2 missing-role share ${((injected / N) * 100).toFixed(1)}% · rows returned by reference: zod-cow ${zcSharesRows.toLocaleString()} / ${N.toLocaleString()}, ArkType ${arkSharesRows.toLocaleString()} / ${N.toLocaleString()} (a defaulted ArkType object is a morph: every row and the array are rebuilt), stock 0`,
  );
  await gate(
    "S2",
    parseImpls(AccountsCow, officialParserCow, Z4Cow, ArkAccountsCow),
    cowGateFixtures,
  );

  const run = await runScenario(
    "S2 10% default",
    "role defaults to viewer, 10% of the rows lack it",
    [
      {
        column: "stock",
        label: "stock zod4 safeParse (default scenario)",
        run: stockRun(AccountsCow, dataCow),
      },
      {
        column: "official",
        label: "official compileFn parser (JIT, default)",
        run: officialRun(officialParserCow, dataCow),
      },
      { column: "zc", label: "zod-cow-v4 safeParse (90% zero-copy)", run: zcRun(Z4Cow, dataCow) },
      {
        column: "ark",
        label: "ArkType Type(data) (default morph)",
        run: arkRun(ArkAccountsCow, dataCow),
      },
    ],
  );
  printRatios(run);
  runs.push(run);
}

/* ─────────────────────────── S3: dirty-ratio sweep ─────────────────────────── */

for (const ratio of [0, 0.25, 0.5, 1.0]) {
  const ds = deriveMissingRole(data, ratio === 0 ? 0 : Math.round(1 / ratio), 3);
  const pct = `${(ratio * 100).toFixed(0)}%`;
  const arkOut = ArkAccountsCow(ds);
  assert.ok(!(arkOut instanceof ArkErrors), `ArkType rejected the S3 ${pct} data`);
  assert.deepStrictEqual(Z4Cow.parse(ds), AccountsCow.parse(ds));
  assert.deepStrictEqual(arkOut, AccountsCow.parse(ds));
  const run = await runScenario(`S3 ${pct} dirty`, `missing-role ratio ${pct} (same S2 schemas)`, [
    {
      column: "stock",
      label: `stock zod4 safeParse (${pct} missing)`,
      run: stockRun(AccountsCow, ds),
    },
    {
      column: "official",
      label: `official compileFn parser (${pct} missing)`,
      run: officialRun(officialParserCow, ds),
    },
    { column: "zc", label: `zod-cow-v4 safeParse (${pct} missing)`, run: zcRun(Z4Cow, ds) },
    {
      column: "ark",
      label: `ArkType Type(data) (${pct} missing)`,
      run: arkRun(ArkAccountsCow, ds),
    },
  ]);
  printRatios(run);
  runs.push(run);
}

/* ─────────────────────────── S4: validation only ─────────────────────────── */

{
  // Validation only, no output construction: official assertOnly product, zod-cow validate() (the
  // official whole-tree assertOnly product of the same array schema, returning the input reference)
  // and ArkType `.allows()`. All three consume the whole S1 array; every call checks the verdict.
  const validateImpls: Impl[] = [
    {
      column: "official",
      label: "official assertOnly validator",
      accepts: (i) => officialValidator(i) === true,
    },
    { column: "zc", label: "zod-cow validate", accepts: (i) => Z4Stock.validate(i) === i },
    { column: "ark", label: "ArkType allows", accepts: (i) => ArkAccounts.allows(i) },
  ];
  await gate("S4", validateImpls, [
    { name: "valid account", input: [sample], accept: true },
    { name: "missing role", input: without(sample, "role"), accept: false },
    { name: "non-integer id (1.5)", input: variant(sample, { id: 1.5 }), accept: false },
    {
      name: "malformed email (not-an-email)",
      input: variant(sample, { email: "not-an-email" }),
      accept: false,
    },
    {
      name: "date-only createdAt",
      input: variant(sample, { createdAt: "2025-01-10" }),
      accept: false,
    },
    {
      name: "oversized tags (9)",
      input: variant(sample, { tags: "abcdefghi".split("") }),
      accept: false,
    },
  ]);

  const run = await runScenario(
    "S4 validation only",
    `${N.toLocaleString()} accounts, whole-array validators on the S1 data (no output construction)`,
    [
      {
        column: "stock",
        label: "stock zod4",
        na: "no validation-only API (safeParse always builds the output)",
      },
      {
        column: "official",
        label: "official assertOnly validator (whole array)",
        run: () => (officialValidator(data) === true ? N : fail("official assertOnly validator")),
      },
      {
        column: "zc",
        label: "zod-cow-v4 validate (whole-tree assertOnly)",
        run: () => (Z4Stock.validate(data) === data ? N : fail("zod-cow validate")),
      },
      {
        column: "ark",
        label: "ArkType Type.allows(data) (validation only)",
        run: () => (ArkAccounts.allows(data) ? N : fail("ArkType allows")),
      },
    ],
  );
  printRatios(run);
  const s1 = runs[0]!.results.find((r) => r.column === "zc");
  const s4 = run.results.find((r) => r.column === "zc");
  if (s1 && s4 && "medianMs" in s1 && "medianMs" in s4 && s1.medianMs && s4.medianMs)
    console.log(
      `  S1 zod-cow parse / S4 zod-cow validate = ${(s1.medianMs / s4.medianMs).toFixed(2)}x`,
    );
  runs.push(run);
}

/* ─────────────────────────── S5: record / map / set ─────────────────────────── */

{
  const Row = z.object({
    id: z.number().int(),
    dict: z.record(z.string(), z.number()),
    lookup: z.map(z.string(), z.number()),
    tags: z.set(z.number().int()),
  });
  const Rows = z.array(Row);
  type S5Row = {
    id: number;
    dict: Record<string, number>;
    lookup: Map<string, number>;
    tags: Set<number>;
  };
  const rows: S5Row[] = new Array(N);
  for (let i = 0; i < N; i++) {
    rows[i] = {
      id: i,
      dict: { a: i % 97, b: i % 89, c: i % 83, d: i % 79 },
      lookup: new Map([
        ["k1", i % 71],
        ["k2", i % 73],
        ["k3", i % 77],
      ]),
      tags: new Set([i % 3, i % 5, i % 7]),
    };
  }
  const RowsZ4 = compile(Rows);
  const rowsParser = compileFn(Rows) as Parser;
  assert.ok(!RowsZ4.stock);

  // ArkType 2.2.3: `Record<string, number>` validates keys and values natively, but `Map` and `Set`
  // are instanceof checks only; there is no `Map<K, V>` / `Set<T>` generic ("Comparator < must be
  // followed by a corresponding literal"), so the entries are never traversed. The closest native
  // schema is measured as a non-equivalent reference and kept out of the tables' ratios.
  let arkGenericMapSupported = false;
  try {
    type("Map<string, number>" as never);
    arkGenericMapSupported = true;
  } catch {
    /* expected: no generic Map/Set in 2.2.3 */
  }
  assert.ok(!arkGenericMapSupported, "ArkType now parses Map<string, number>: revisit the S5 N/A");
  const ArkRowsRef = type({
    id: "number.integer & number.safe",
    dict: "Record<string, number>",
    lookup: "Map",
    tags: "Set",
  }).array();

  const base = rows[5]!;
  const rowVariant = (patch: Partial<S5Row>): unknown[] => [{ ...base, ...patch }];
  const refOnly =
    "ArkType `Map` / `Set` are instanceof-only in 2.2.3: entries and members are not validated (non-equivalent reference)";
  const s5Impls = parseImpls(Rows, rowsParser, RowsZ4, ArkRowsRef);
  s5Impls[3]!.label = "ArkType non-equivalent reference (Map/Set instanceof)";
  await gate("S5", s5Impls, [
    { name: "valid row", input: [base], accept: true },
    { name: "non-integer id (1.5)", input: rowVariant({ id: 1.5 }), accept: false },
    {
      name: "record value is a string",
      input: rowVariant({ dict: { a: 1, b: "x" as never } }),
      accept: false,
    },
    {
      name: "record value is a number-like string",
      input: rowVariant({ dict: { a: "1" as never } }),
      accept: false,
    },
    {
      name: "lookup is a plain object, not a Map",
      input: rowVariant({ lookup: { k1: 1 } as never }),
      accept: false,
    },
    {
      name: "tags is an array, not a Set",
      input: rowVariant({ tags: [1, 2] as never }),
      accept: false,
    },
    {
      name: "Map key is a number",
      input: rowVariant({ lookup: new Map([[1 as never, 2]]) }),
      accept: { stock: false, official: false, zc: false, ark: true },
      divergence: refOnly,
    },
    {
      name: "Map value is a string",
      input: rowVariant({ lookup: new Map([["k1", "x" as never]]) }),
      accept: { stock: false, official: false, zc: false, ark: true },
      divergence: refOnly,
    },
    {
      name: "Set member is not an integer (1.5)",
      input: rowVariant({ tags: new Set([1, 1.5]) }),
      accept: { stock: false, official: false, zc: false, ark: true },
      divergence: refOnly,
    },
    {
      name: "Set member is a string",
      input: rowVariant({ tags: new Set(["x" as never]) }),
      accept: { stock: false, official: false, zc: false, ark: true },
      divergence: refOnly,
    },
  ]);
  const probe = RowsZ4.parse(rows);
  console.log(
    `  S5 output reference: zod-cow === input ${probe === rows ? "yes (zero-copy)" : "no"}`,
  );

  const run = await runScenario(
    "S5 record/map/set",
    `${N.toLocaleString()} rows, one 4-key record + 3-entry Map + 3-member Set each`,
    [
      {
        column: "stock",
        label: "stock zod4 safeParse (record+map+set rebuilt)",
        run: stockRun(Rows, rows),
      },
      {
        column: "official",
        label: "official compileFn parser (JIT, stock sem.)",
        run: officialRun(rowsParser, rows),
      },
      { column: "zc", label: "zod-cow-v4 safeParse (zero-copy)", run: zcRun(RowsZ4, rows) },
      {
        column: "ark",
        label: "ArkType",
        na: "no equivalent native typed Map/Set traversal",
        detail:
          "ArkType 2.2.3 `Map` / `Set` are instanceof checks; there is no `Map<K, V>` / `Set<T>` generic, so entries and members are never validated. The closest native schema is measured below as a non-equivalent reference.",
      },
      {
        column: "ark",
        label: "ArkType non-equivalent reference (Map/Set instanceof)",
        run: arkRun(ArkRowsRef, rows),
        nonEquivalent: refOnly,
      },
    ],
  );
  printRatios(run);
  runs.push(run);
}

/* ─────────────────────────── S6: tuple ─────────────────────────── */

{
  const Point = z.tuple([z.number(), z.number()]);
  const Label = z.tuple([z.string(), z.optional(z.string())]);
  const Row = z.object({ id: z.number().int(), point: Point, label: Label });
  const Rows = z.array(Row);
  type S6Row = { id: number; point: [number, number]; label: [string, string?] };
  const rows: S6Row[] = new Array(N);
  for (let i = 0; i < N; i++) {
    rows[i] = {
      id: i,
      point: [i % 360, i % 180],
      label: i % 2 === 0 ? [`L${i % 97}`, `T${i % 31}`] : [`L${i % 97}`],
    };
  }
  const RowsZ4 = compile(Rows);
  const rowsParser = compileFn(Rows) as Parser;
  assert.ok(!RowsZ4.stock);

  // ArkType tuples: fixed-length `["number", "number"]` and an optional trailing element `"string?"`.
  // `string?` means the slot may be absent; zod's `z.optional()` element also accepts a present
  // `undefined` (declared in the gate; the benchmark data uses 1- and 2-element labels only).
  const ArkRows = type({
    id: "number.integer & number.safe",
    point: ["number", "number"],
    label: ["string", "string?"],
  }).array();

  const base = rows[4]!;
  const rowVariant = (patch: Record<string, unknown>): unknown[] => [{ ...base, ...patch }];
  await gate("S6", parseImpls(Rows, rowsParser, RowsZ4, ArkRows), [
    { name: "valid row, 2-element label", input: [rows[4]!], accept: true },
    { name: "valid row, 1-element label", input: [rows[5]!], accept: true },
    { name: "point has 3 elements", input: rowVariant({ point: [1, 2, 3] }), accept: false },
    { name: "point has 1 element", input: rowVariant({ point: [1] }), accept: false },
    { name: "point element is a string", input: rowVariant({ point: [1, "2"] }), accept: false },
    { name: "label has 3 elements", input: rowVariant({ label: ["a", "b", "c"] }), accept: false },
    {
      name: "label second element is a number",
      input: rowVariant({ label: ["a", 1] }),
      accept: false,
    },
    { name: "label is empty", input: rowVariant({ label: [] }), accept: false },
    { name: "point is not an array", input: rowVariant({ point: { 0: 1, 1: 2 } }), accept: false },
    {
      name: "label second element is a present undefined",
      input: rowVariant({ label: ["a", undefined] }),
      accept: { stock: true, official: true, zc: true, ark: false },
      divergence:
        "zod's optional tuple element accepts an explicit undefined in the slot; ArkType `string?` only lets the slot be absent (the benchmark data never has a present undefined)",
    },
  ]);
  const probe = RowsZ4.parse(rows);
  const arkOut = ArkRows(rows);
  assert.ok(!(arkOut instanceof ArkErrors));
  assert.deepStrictEqual(probe, Rows.parse(rows));
  assert.deepStrictEqual(arkOut, probe);
  console.log(
    `  S6 output reference: zod-cow === input ${probe === rows ? "yes (zero-copy)" : "no"} · ArkType === input ${arkOut === rows ? "yes" : "no"}`,
  );

  const run = await runScenario(
    "S6 tuple",
    `${N.toLocaleString()} rows, [number, number] and [string, string?] each`,
    [
      {
        column: "stock",
        label: "stock zod4 safeParse (new array per tuple)",
        run: stockRun(Rows, rows),
      },
      {
        column: "official",
        label: "official compileFn parser (JIT, stock sem.)",
        run: officialRun(rowsParser, rows),
      },
      { column: "zc", label: "zod-cow-v4 safeParse (zero-copy)", run: zcRun(RowsZ4, rows) },
      { column: "ark", label: "ArkType Type(data) (tuples)", run: arkRun(ArkRows, rows) },
    ],
  );
  printRatios(run);
  runs.push(run);
}

/* ─────────────────────────── S7: async transform ─────────────────────────── */

{
  // Async adds one microtask chain per element; N/10 rows keeps a single round measurable.
  const M = N / 10;
  const Row = z.object({
    id: z.number().int(),
    email: z.string().transform(async (e) => e.toLowerCase()),
    score: z.number(),
  });
  const Rows = z.array(Row);
  const rows: { id: number; email: string; score: number }[] = new Array(M);
  for (let i = 0; i < M; i++) rows[i] = { id: i, email: `USER${i}@EXAMPLE.COM`, score: i % 100 };
  const RowsZ4 = compile(Rows);
  assert.ok(RowsZ4.async && !RowsZ4.stock, "async skeleton compiled");

  // The official compiler refuses async transforms; keep the exact error as the N/A reason.
  let officialNA = "compileFn accepted the async schema (unexpected)";
  try {
    compileFn(Rows);
  } catch (e) {
    assert.ok(e instanceof ZodCompileAsyncError, `unexpected compileFn error: ${String(e)}`);
    officialNA = "compileFn refuses async transforms (ZodCompileAsyncError)";
  }

  // ArkType 2.2.3 has no async morph: a `.pipe(async fn)` morph returns a Promise that the pipeline
  // does not await, so the parse result is a pending Promise (not the transformed string) and any
  // subsequent `.to("string")` rejects it. Proven here, not assumed.
  const arkAsyncMorph = type("string").pipe(async (s) => s.toLowerCase());
  const arkAsyncOut = arkAsyncMorph("ABC");
  assert.ok(arkAsyncOut instanceof Promise, "ArkType now awaits async morphs: revisit the S7 N/A");
  const arkAsyncThenString = type("string")
    .pipe(async (s) => s.toLowerCase())
    .to("string");
  assert.ok(
    arkAsyncThenString("ABC") instanceof ArkErrors,
    "ArkType now awaits async morphs: revisit the S7 N/A",
  );
  await arkAsyncOut;
  const arkNA = "native async morph unsupported";
  const arkNADetail =
    "ArkType 2.2.3: a `.pipe(async fn)` morph returns an un-awaited Promise, so the parse result is a pending Promise and a following `.to('string')` rejects it as an object; wrapping a sync morph in Promise.resolve() would not be the same workload.";

  const asyncImpls: Impl[] = [
    {
      column: "stock",
      label: "stock safeParseAsync",
      accepts: async (i) => (await Rows.safeParseAsync(i)).success,
      output: (i) => Rows.parseAsync(i),
    },
    {
      column: "zc",
      label: "zod-cow safeParseAsync",
      accepts: async (i) => (await RowsZ4.safeParseAsync(i)).success,
      output: (i) => RowsZ4.parseAsync(i),
    },
  ];
  await gate("S7", asyncImpls, [
    { name: "valid row (email lowercased in the output)", input: [rows[3]!], accept: true },
    { name: "non-integer id (1.5)", input: [{ ...rows[3]!, id: 1.5 }], accept: false },
    { name: "email is a number", input: [{ ...rows[3]!, email: 5 }], accept: false },
    { name: "score is a string", input: [{ ...rows[3]!, score: "1" }], accept: false },
  ]);
  const probe = await RowsZ4.parseAsync(rows);
  assert.equal(probe[3]!.email, rows[3]!.email.toLowerCase());
  console.log(
    `  S7 output: email lowercased ✓ · every row is dirty (a new object per row), the array is rebuilt`,
  );

  const stockAsync = Rows.safeParseAsync.bind(Rows);
  const run = await runScenario(
    "S7 async transform",
    `${M.toLocaleString()} rows, async lowercase transform on one leaf`,
    [
      {
        column: "stock",
        label: "stock zod4 safeParseAsync (async interpreter)",
        run: async () => {
          const r = await stockAsync(rows);
          return r.success ? r.data : fail("stock async");
        },
      },
      { column: "official", label: "official compileFn", na: officialNA },
      {
        column: "zc",
        label: "zod-cow-v4 safeParseAsync (async skeleton + CoW)",
        run: async () => {
          const r = await RowsZ4.safeParseAsync(rows);
          return r.success ? r.data : fail("zod-cow async");
        },
      },
      { column: "ark", label: "ArkType", na: arkNA, detail: arkNADetail },
    ],
  );
  printRatios(run);
  runs.push(run);
}

/* ─────────────────────────── Summary ─────────────────────────── */

printSummary(runs);
console.log(
  "\nNotes: alloc = heapUsed delta at the end of a timed call (before gc); retained = the delta still held after gc.",
);
console.log(
  "  zod-cow returns the input reference on the clean path (≈0 allocated beyond the strip probe, 0 retained) and shallow-copies only the dirty path otherwise.",
);
console.log(
  "  ArkType schemas carry the same constraints as the zod schemas (see the gate output); its `Map`/`Set` and async morphs have no equivalent in 2.2.3, hence the S5/S7 N/A.",
);
