/**
 * Benchmark for the zod4 line (zod-cow-v4: official codegen + CoW skeletons), reproducing the
 * 500k-account scenario from the Numeric article, with the public compiled Zod API and ArkType as
 * first-class baselines.
 *
 * Columns, measured in every scenario where an equivalent workload exists:
 *   stock Zod 4          safeParse, interpreter baseline (rebuilds the whole output tree on every parse)
 *   Zod 4 z.compile()    the public compiled API of Zod 4.5: `z.compile(schema).safeParse` for
 *                        parsing, `z.validate(compiled, data)` for validation only
 *   zod-cow-v4           the subject: official codegen + CoW container skeletons
 *   ArkType              external control, normal public API (direct Type invocation for parse,
 *                        `.allows()` for validation-only), schema built to the same constraints
 *   Zod internal compiler product   zod4's own `compileFn` parser / `assertOnly` validator, the
 *                        engineering control behind the public API; reported in a diagnostic table,
 *                        not as a user-facing baseline
 *
 * Batch scenarios (one call parses the whole dataset):
 *   S1 clean-input parse       clean input, no undeclared keys; CoW returns the input reference
 *   S2 10% default             `role` carries a default and 10% of the rows are missing it
 *   S3 dirty sweep             missing-role ratio 0% / 25% / 50% / 100%
 *   S4 validation only         z.validate / assertOnly / zod-cow validate / ArkType allows
 *   S5 record / map / set      one record + one Map + one Set per row
 *   S6 tuple                   [number, number] and [string, string?] per row
 *   S7 async transform         async lowercase transform on one leaf (safeParseAsync)
 *   S8 strip-unknown parity    every row carries undeclared keys, top-level and nested (strip.ts)
 *   S10 parse failures         per-row safeParse over datasets with 1% to 100% invalid rows (failures.ts)
 * Single-record hot loops (ns per operation):
 *   calibration                a simple primitive-field object, parse and validation only (calibration.ts)
 *   S9 validation failures     boolean verdicts on invalid records (failures.ts)
 *   S10 failure position       detailed errors for a failure at the first key, the last key, a
 *                              nested key and a refine (failures.ts)
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
import { compileFn, ZodCompileAsyncError } from "zod/v4/core";
import { compile } from "zod-cow-v4";
import { runCalibration } from "./calibration.js";
import { runFailures } from "./failures.js";
import { type Fixture, gate, type Impl } from "./gates.js";
import {
  PASSES,
  printRatios,
  printSummary,
  runScenario,
  type ScenarioRun,
  WARMUP,
} from "./harness.js";
import {
  AccountsCow,
  AccountsStock,
  ArkAccounts,
  ArkAccountsCow,
  ArkTupleRows,
  arkFinite,
  arkRun,
  boundaryFixtures,
  commonInvalid,
  data,
  deriveMissingRole,
  fail,
  makeTupleRows,
  N,
  officialParser,
  officialParserCow,
  officialRun,
  officialValidator,
  parseImpls,
  printArkKeywordChecks,
  PublicAccountsCow,
  PublicAccountsStock,
  publicRun,
  sample,
  stockRun,
  TupleRows,
  variant,
  without,
  Z4Cow,
  Z4Stock,
  zcRun,
} from "./schemas.js";
import { runStripParity } from "./strip.js";

console.log(
  `bench-v4 · ${N.toLocaleString()} records · at least ${WARMUP} warmup + ${PASSES} timed rounds per candidate, rounded up to complete rotations of the candidate order · node ${process.version}`,
);
printArkKeywordChecks();

const runs: ScenarioRun[] = [];

/* ─────────────────────────── S1: clean-input parse ─────────────────────────── */

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

  // The S1 fixture has no undeclared keys. zod's default object mode strips undeclared keys into
  // a copy while ArkType's default keeps them on the input reference, so S1 is a fair comparison
  // of this clean fixture, not of identical parse semantics: the extra-key fixture below declares
  // that divergence, and S8 measures the strip case with ArkType configured to delete.
  await gate(
    "S1",
    parseImpls(AccountsStock, PublicAccountsStock, officialParser, Z4Stock, ArkAccounts),
    [
      { name: "valid account", input: [sample], accept: true },
      { name: `generated dataset (${N.toLocaleString()} rows)`, input: data, accept: true },
      {
        name: "valid account with an extra key",
        input: variant(sample, { extra: 1 }),
        accept: true,
        outputDiffers:
          "zod strips undeclared keys into a copy, ArkType passes them through by reference (S8 measures the strip case)",
      },
      { name: "missing role", input: without(sample, "role"), accept: false },
      {
        name: "present-undefined role",
        input: variant(sample, { role: undefined }),
        accept: false,
      },
      ...boundaryFixtures,
      ...commonInvalid,
    ],
  );

  const run = await runScenario(
    "S1 clean-input parse (no undeclared keys)",
    `${N.toLocaleString()} accounts, clean input without undeclared keys`,
    [
      {
        column: "stock",
        label: "stock zod4 safeParse (interpreter)",
        run: stockRun(AccountsStock, data),
      },
      {
        column: "public",
        label: "z.compile() safeParse (public compiled API)",
        run: publicRun(PublicAccountsStock, data),
      },
      {
        column: "official",
        label: "internal compileFn parser (stock sem.)",
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
    accept: { stock: true, public: true, official: true, zc: true, ark: false },
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
  ...boundaryFixtures,
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
    parseImpls(AccountsCow, PublicAccountsCow, officialParserCow, Z4Cow, ArkAccountsCow),
    [
      ...cowGateFixtures,
      {
        name: `generated dataset (${injected.toLocaleString()} of ${N.toLocaleString()} rows lack role)`,
        input: dataCow,
        accept: true,
      },
    ],
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
        column: "public",
        label: "z.compile() safeParse (default)",
        run: publicRun(PublicAccountsCow, dataCow),
      },
      {
        column: "official",
        label: "internal compileFn parser (default)",
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
  // Same schemas as S2, so the S2 fixtures apply as they are; the generated dataset of this ratio
  // is gated too (accepted by all, outputs deepStrictEqual, internal parser included)
  await gate(
    `S3 ${pct}`,
    parseImpls(AccountsCow, PublicAccountsCow, officialParserCow, Z4Cow, ArkAccountsCow),
    [
      ...cowGateFixtures,
      {
        name: `generated dataset (${pct} of ${N.toLocaleString()} rows lack role)`,
        input: ds,
        accept: true,
      },
    ],
  );
  const run = await runScenario(`S3 ${pct} dirty`, `missing-role ratio ${pct} (same S2 schemas)`, [
    {
      column: "stock",
      label: `stock zod4 safeParse (${pct} missing)`,
      run: stockRun(AccountsCow, ds),
    },
    {
      column: "public",
      label: `z.compile() safeParse (${pct} missing)`,
      run: publicRun(PublicAccountsCow, ds),
    },
    {
      column: "official",
      label: `internal compileFn parser (${pct} missing)`,
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
  // Validation only, no output construction: the public `z.validate(compiled, data)` (the
  // compiled validator with a runtime fallback on failure), the internal assertOnly product,
  // zod-cow validate() (the official whole-tree assertOnly product of the same array schema,
  // returning the input reference) and ArkType `.allows()`. All of them consume the whole S1
  // array; every call checks the verdict.
  const validateImpls: Impl[] = [
    {
      column: "public",
      label: "z.validate(compiled)",
      accepts: (i) => z.validate(PublicAccountsStock, i),
    },
    {
      column: "official",
      label: "internal assertOnly validator",
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
    ...boundaryFixtures,
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
        column: "public",
        label: "z.validate(compiled, data) (public API)",
        run: () => (z.validate(PublicAccountsStock, data) ? N : fail("z.validate")),
      },
      {
        column: "official",
        label: "internal assertOnly validator (whole array)",
        run: () => (officialValidator(data) === true ? N : fail("internal assertOnly validator")),
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
  const rowsParser = compileFn(Rows) as (input: unknown) => unknown;
  const RowsPublic = z.compile(Rows);
  assert.ok(!RowsZ4.stock && RowsPublic !== Rows);

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
    dict: type.Record("string", arkFinite),
    lookup: "Map",
    tags: "Set",
  }).array();

  const base = rows[5]!;
  const rowVariant = (patch: Partial<S5Row>): unknown[] => [{ ...base, ...patch }];
  const refOnly =
    "ArkType `Map` / `Set` are instanceof-only in 2.2.3: entries and members are not validated (non-equivalent reference)";
  const s5Impls = parseImpls(Rows, RowsPublic, rowsParser, RowsZ4, ArkRowsRef);
  s5Impls[4]!.label = "ArkType non-equivalent reference (Map/Set instanceof)";
  const allZodReject = { stock: false, public: false, official: false, zc: false, ark: true };
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
      name: "record value is Infinity",
      input: rowVariant({ dict: { a: Number.POSITIVE_INFINITY } }),
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
      accept: allZodReject,
      divergence: refOnly,
    },
    {
      name: "Map value is a string",
      input: rowVariant({ lookup: new Map([["k1", "x" as never]]) }),
      accept: allZodReject,
      divergence: refOnly,
    },
    {
      name: "Set member is not an integer (1.5)",
      input: rowVariant({ tags: new Set([1, 1.5]) }),
      accept: allZodReject,
      divergence: refOnly,
    },
    {
      name: "Set member is a string",
      input: rowVariant({ tags: new Set(["x" as never]) }),
      accept: allZodReject,
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
        column: "public",
        label: "z.compile() safeParse (stock sem.)",
        run: publicRun(RowsPublic, rows),
      },
      {
        column: "official",
        label: "internal compileFn parser (stock sem.)",
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
  const rows = makeTupleRows();
  const RowsZ4 = compile(TupleRows);
  const rowsParser = compileFn(TupleRows) as (input: unknown) => unknown;
  const RowsPublic = z.compile(TupleRows);
  assert.ok(!RowsZ4.stock && RowsPublic !== TupleRows);

  const base = rows[4]!;
  const rowVariant = (patch: Record<string, unknown>): unknown[] => [{ ...base, ...patch }];
  await gate("S6", parseImpls(TupleRows, RowsPublic, rowsParser, RowsZ4, ArkTupleRows), [
    { name: "valid row, 2-element label", input: [rows[4]!], accept: true },
    { name: "valid row, 1-element label", input: [rows[5]!], accept: true },
    { name: "point has 3 elements", input: rowVariant({ point: [1, 2, 3] }), accept: false },
    { name: "point has 1 element", input: rowVariant({ point: [1] }), accept: false },
    { name: "point element is a string", input: rowVariant({ point: [1, "2"] }), accept: false },
    {
      name: "point element is Infinity",
      input: rowVariant({ point: [Number.POSITIVE_INFINITY, 2] }),
      accept: false,
    },
    {
      name: "point element is -Infinity",
      input: rowVariant({ point: [1, Number.NEGATIVE_INFINITY] }),
      accept: false,
    },
    { name: "point element is NaN", input: rowVariant({ point: [Number.NaN, 2] }), accept: false },
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
      accept: { stock: true, public: true, official: true, zc: true, ark: false },
      divergence:
        "zod's optional tuple element accepts an explicit undefined in the slot; ArkType `string?` only lets the slot be absent (the benchmark data never has a present undefined)",
    },
  ]);
  const probe = RowsZ4.parse(rows);
  const arkOut = ArkTupleRows(rows);
  assert.ok(!(arkOut instanceof ArkErrors));
  assert.deepStrictEqual(probe, TupleRows.parse(rows));
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
        run: stockRun(TupleRows, rows),
      },
      {
        column: "public",
        label: "z.compile() safeParse (stock sem.)",
        run: publicRun(RowsPublic, rows),
      },
      {
        column: "official",
        label: "internal compileFn parser (stock sem.)",
        run: officialRun(rowsParser, rows),
      },
      { column: "zc", label: "zod-cow-v4 safeParse (zero-copy)", run: zcRun(RowsZ4, rows) },
      { column: "ark", label: "ArkType Type(data) (tuples)", run: arkRun(ArkTupleRows, rows) },
    ],
  );
  printRatios(run);
  runs.push(run);
}

/* ─────────────────────────── S7: async transform ─────────────────────────── */

{
  // Async adds one microtask chain per element; N/10 rows keeps a single round measurable
  // (rounded up, so any BENCH_N >= 10 gives at least one row).
  const M = Math.ceil(N / 10);
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

  // The official compiler refuses async transforms; keep the exact error as the N/A reason. The
  // public `z.compile()` hands the schema back uncompiled in that case (strict mode throws), so a
  // "compiled" column here would time the interpreter under another label.
  let officialNA = "compileFn accepted the async schema (unexpected)";
  try {
    compileFn(Rows);
  } catch (e) {
    assert.ok(e instanceof ZodCompileAsyncError, `unexpected compileFn error: ${String(e)}`);
    officialNA = "compileFn refuses async transforms (ZodCompileAsyncError)";
  }
  assert.equal(z.compile(Rows), Rows, "z.compile() no longer returns an async schema uncompiled");
  let publicNA = "z.compile() accepted the async schema (unexpected)";
  try {
    z.compile(Rows, { strict: true });
  } catch (e) {
    assert.ok(e instanceof ZodCompileAsyncError, `unexpected z.compile error: ${String(e)}`);
    publicNA =
      "z.compile() returns the schema uncompiled for async transforms (strict mode throws ZodCompileAsyncError)";
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
  const s7Sample = rows[0]!;
  await gate("S7", asyncImpls, [
    { name: "valid row (email lowercased in the output)", input: [s7Sample], accept: true },
    { name: "non-integer id (1.5)", input: [{ ...s7Sample, id: 1.5 }], accept: false },
    { name: "email is a number", input: [{ ...s7Sample, email: 5 }], accept: false },
    { name: "score is a string", input: [{ ...s7Sample, score: "1" }], accept: false },
  ]);
  const probe = await RowsZ4.parseAsync(rows);
  assert.equal(probe.length, M);
  for (let i = 0; i < M; i++) assert.equal(probe[i]!.email, rows[i]!.email.toLowerCase());
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
      { column: "public", label: "z.compile()", na: publicNA },
      { column: "official", label: "internal compileFn", na: officialNA },
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

/* ─────────────────────────── S8, calibration, S9, S10 ─────────────────────────── */

runs.push(await runStripParity());
runs.push(...(await runCalibration()));
runs.push(...(await runFailures()));

/* ─────────────────────────── Summary ─────────────────────────── */

printSummary(runs);
console.log(
  "\nNotes: alloc = heapUsed delta at the end of a timed call (before gc); retained = the delta still held after gc; hot-loop rows report ns per operation and no allocation.",
);
console.log(
  "  zod-cow returns the input reference on the clean path (≈0 allocated beyond the strip probe, 0 retained) and shallow-copies only the dirty path otherwise.",
);
console.log(
  "  ArkType schemas carry the same constraints as the zod schemas (see the gate output: code-point length on overflow, finite numbers, zod's email/datetime patterns); its `Map`/`Set` and async morphs have no equivalent in 2.2.3, hence the S5/S7 N/A.",
);
