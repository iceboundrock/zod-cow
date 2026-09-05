/**
 * Benchmark for the zod3 line (zod-cow-v3: the hand-written closure-tree compiler), reproducing
 * the 500k-account scenario from the Numeric article with ArkType as a first-class baseline.
 *
 * Columns, measured in every scenario where an equivalent workload exists:
 *   stock Zod 3   safeParse, interpreter baseline (rebuilds the whole output tree on every parse)
 *   zod-cow-v3    the subject: compiled closure tree with CoW containers
 *   ArkType       external control, normal public API (direct Type invocation for parse,
 *                 `.allows()` for validation-only), schema built to the same constraints
 *
 * Batch scenarios (one call parses the whole dataset):
 *   S1 clean-input parse       clean input, no undeclared keys; CoW returns the input reference
 *   S2 10% default             `role` carries a default and 10% of the rows are missing it
 *   S3 dirty sweep             missing-role ratio 0% / 25% / 50% / 100%
 *   S4 validate                zod-cow `validate()` (same runtime as parse) next to ArkType allows
 *   S5 record / map / set      one record + one Map + one Set per row
 *   S6 tuple                   [number, number] and [string, string | undefined] per row
 *   S7 transforms              sync string transforms, dirty and no-op; async is N/A for the line
 *   S8 strip-unknown parity    every row carries undeclared keys, top-level and nested
 *   S9 parse failures          per-row safeParse over datasets with 1% to 100% invalid rows
 *                              (failures.ts)
 * Single-record hot loops (ns per operation):
 *   calibration                a simple primitive-field object, parse and validate (calibration.ts)
 *   scaling sweeps             primitive leaves, object width, nesting depth, array length and
 *                              tuple length (calibration.ts)
 *   S9 failure position        detailed errors for a failure at the first key, the last key, a
 *                              nested key, sibling errors, containers and a refine (failures.ts)
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
import { compile } from "zod-cow-v3";
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
  arkAccountShape,
  ArkTupleRows,
  arkRun,
  boundaryFixtures,
  commonInvalid,
  data,
  deriveMissingRole,
  fail,
  makeTupleRows,
  N,
  parseImpls,
  printArkKeywordChecks,
  type RawAccount,
  sample,
  stockRun,
  TupleRows,
  variant,
  without,
  Z3Cow,
  Z3Stock,
  zcRun,
} from "./schemas.js";

console.log(
  `bench-v3 · ${N.toLocaleString()} records · at least ${WARMUP} warmup + ${PASSES} timed rounds per candidate, rounded up to complete rotations of the candidate order · node ${process.version}`,
);
printArkKeywordChecks();

const runs: ScenarioRun[] = [];

/** Count the rows an output shares with the input by reference (and a nested field of each) */
function shareReport(out: unknown[], input: unknown[], nested: string): string {
  let rows = 0;
  let nestedShared = 0;
  for (let i = 0; i < input.length; i++) {
    if (out[i] === input[i]) rows++;
    if ((out[i] as any)?.[nested] === (input[i] as any)?.[nested]) nestedShared++;
  }
  return `root === input ${out === input ? "yes" : "no"} · rows by reference ${rows.toLocaleString()} / ${input.length.toLocaleString()} · ${nested} by reference ${nestedShared.toLocaleString()} / ${input.length.toLocaleString()}`;
}

/* ─────────────────────────── S1: clean-input parse ─────────────────────────── */

{
  const stockOut = AccountsStock.parse(data);
  const zcOut = Z3Stock.parse(data);
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
  await gate("S1", parseImpls(AccountsStock, Z3Stock, ArkAccounts), [
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
    { name: "present-undefined role", input: variant(sample, { role: undefined }), accept: false },
    ...boundaryFixtures,
    ...commonInvalid,
  ]);

  const run = await runScenario(
    "S1 clean-input parse (no undeclared keys)",
    `${N.toLocaleString()} accounts, clean input without undeclared keys`,
    [
      {
        column: "stock",
        label: "stock zod3 safeParse (interpreter)",
        run: stockRun(AccountsStock, data),
      },
      {
        column: "zc",
        label: "zod-cow-v3 safeParse (closure tree + CoW)",
        run: zcRun(Z3Stock, data),
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
    accept: { stock: true, zc: true, ark: false },
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
  const zcOut = Z3Cow.parse(dataCow);
  const arkOut = ArkAccountsCow(dataCow);
  assert.ok(!(arkOut instanceof ArkErrors), "ArkType rejected the S2 data");
  assert.deepStrictEqual(zcOut, stockOut);
  assert.deepStrictEqual(arkOut, stockOut);
  // The input must be untouched: no row gained a role
  let stillMissing = 0;
  for (let i = 0; i < N; i++) if (!("role" in dataCow[i]!)) stillMissing++;
  assert.equal(stillMissing, injected, "the input was mutated");
  const arkSharesRows = arkOut.filter((row, i) => row === dataCow[i]).length;
  console.log(
    `\n  S2 missing-role share ${((injected / N) * 100).toFixed(1)}% · zod-cow: ${shareReport(zcOut, dataCow, "address")} · ArkType rows by reference ${arkSharesRows.toLocaleString()} / ${N.toLocaleString()} (a defaulted ArkType object is a morph: every row and the array are rebuilt) · stock 0 · input untouched ✓`,
  );
  await gate("S2", parseImpls(AccountsCow, Z3Cow, ArkAccountsCow), [
    ...cowGateFixtures,
    {
      name: `generated dataset (${injected.toLocaleString()} of ${N.toLocaleString()} rows lack role)`,
      input: dataCow,
      accept: true,
    },
  ]);

  const run = await runScenario(
    "S2 10% default",
    "role defaults to viewer, 10% of the rows lack it",
    [
      {
        column: "stock",
        label: "stock zod3 safeParse (default scenario)",
        run: stockRun(AccountsCow, dataCow),
      },
      { column: "zc", label: "zod-cow-v3 safeParse (90% zero-copy)", run: zcRun(Z3Cow, dataCow) },
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
  await gate(`S3 ${pct}`, parseImpls(AccountsCow, Z3Cow, ArkAccountsCow), [
    ...cowGateFixtures,
    {
      name: `generated dataset (${pct} of ${N.toLocaleString()} rows lack role)`,
      input: ds,
      accept: true,
    },
  ]);
  console.log(`  S3 ${pct} zod-cow: ${shareReport(Z3Cow.parse(ds), ds, "address")}`);
  const run = await runScenario(`S3 ${pct} dirty`, `missing-role ratio ${pct} (same S2 schemas)`, [
    {
      column: "stock",
      label: `stock zod3 safeParse (${pct} missing)`,
      run: stockRun(AccountsCow, ds),
    },
    { column: "zc", label: `zod-cow-v3 safeParse (${pct} missing)`, run: zcRun(Z3Cow, ds) },
    {
      column: "ark",
      label: `ArkType Type(data) (${pct} missing)`,
      run: arkRun(ArkAccountsCow, ds),
    },
  ]);
  printRatios(run);
  runs.push(run);
}

/* ─────────────────────────── S4: validate ─────────────────────────── */

{
  // zod-cow-v3 `validate()` is the same runtime as `parse()`: it runs the same closure tree and
  // differs only in its TypeScript return type (`DeepReadonly`, a hint that output and input share
  // structure). It is not a validation-only fast path like the zod4 line's `assertOnly` product;
  // the row exists to document the API and is expected to read level with S1. ArkType `.allows()`
  // is a true validation-only entry point and stock zod3 has none.
  const validateImpls: Impl[] = [
    { column: "zc", label: "zod-cow validate", accepts: (i) => Z3Stock.safeParse(i).success },
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
    "S4 validate (same runtime as parse)",
    `${N.toLocaleString()} accounts on the S1 data; zod-cow validate() is parse() with a DeepReadonly return type, not a validation-only mode`,
    [
      {
        column: "stock",
        label: "stock zod3",
        na: "no validation-only API (safeParse always builds the output)",
      },
      {
        column: "zc",
        label: "zod-cow-v3 validate (same closure tree as parse)",
        run: () => (Z3Stock.validate(data) === data ? N : fail("zod-cow validate")),
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
      `  S1 zod-cow parse / S4 zod-cow validate = ${(s1.medianMs / s4.medianMs).toFixed(2)}x (expected level: same runtime)`,
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
  const RowsZ3 = compile(Rows);

  // ArkType 2.2.3: `Record<string, number>` validates keys and values natively, but `Map` and `Set`
  // are instanceof checks only; there is no `Map<K, V>` / `Set<T>` generic, so the entries are
  // never traversed. The closest native schema is measured as a non-equivalent reference and kept
  // out of the tables' ratios.
  let arkGenericMapSupported = false;
  try {
    type("Map<string, number>" as never);
    arkGenericMapSupported = true;
  } catch {
    /* expected: no generic Map/Set in 2.2.3 */
  }
  assert.ok(!arkGenericMapSupported, "ArkType now parses Map<string, number>: revisit the S5 N/A");
  const ArkRowsRef = type({
    id: "number.integer",
    dict: type.Record("string", "number"),
    lookup: "Map",
    tags: "Set",
  }).array();

  const base = rows[5]!;
  const rowVariant = (patch: Partial<S5Row>): unknown[] => [{ ...base, ...patch }];
  const refOnly =
    "ArkType `Map` / `Set` are instanceof-only in 2.2.3: entries and members are not validated (non-equivalent reference)";
  const s5Impls = parseImpls(Rows, RowsZ3, ArkRowsRef);
  s5Impls[2]!.label = "ArkType non-equivalent reference (Map/Set instanceof)";
  const zodReject = { stock: false, zc: false, ark: true };
  await gate("S5", s5Impls, [
    { name: "valid row", input: [base], accept: true },
    { name: "non-integer id (1.5)", input: rowVariant({ id: 1.5 }), accept: false },
    {
      name: "record value is a string",
      input: rowVariant({ dict: { a: 1, b: "x" as never } }),
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
      accept: zodReject,
      divergence: refOnly,
    },
    {
      name: "Map value is a string",
      input: rowVariant({ lookup: new Map([["k1", "x" as never]]) }),
      accept: zodReject,
      divergence: refOnly,
    },
    {
      name: "Set member is not an integer (1.5)",
      input: rowVariant({ tags: new Set([1, 1.5]) }),
      accept: zodReject,
      divergence: refOnly,
    },
  ]);
  const probe = RowsZ3.parse(rows);
  let mapsShared = 0;
  let setsShared = 0;
  for (let i = 0; i < N; i++) {
    if (probe[i]!.lookup === rows[i]!.lookup) mapsShared++;
    if (probe[i]!.tags === rows[i]!.tags) setsShared++;
  }
  console.log(
    `  S5 zod-cow: ${shareReport(probe, rows, "dict")} · Map by reference ${mapsShared.toLocaleString()} / ${N.toLocaleString()} · Set by reference ${setsShared.toLocaleString()} / ${N.toLocaleString()}`,
  );

  const run = await runScenario(
    "S5 record/map/set",
    `${N.toLocaleString()} rows, one 4-key record + 3-entry Map + 3-member Set each`,
    [
      {
        column: "stock",
        label: "stock zod3 safeParse (record+map+set rebuilt)",
        run: stockRun(Rows, rows),
      },
      { column: "zc", label: "zod-cow-v3 safeParse (zero-copy)", run: zcRun(RowsZ3, rows) },
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

  // Dirty containers: the Set member carries a default-free transform-like change through a
  // record value default. One record value in ten is absent and gets a default, so the record
  // and its row are copied while the Map and the Set of that row stay shared.
  const RowDirty = z.object({
    id: z.number().int(),
    dict: z.record(z.string(), z.number().default(0)),
    lookup: z.map(z.string(), z.number()),
    tags: z.set(z.number().int()),
  });
  const RowsDirty = z.array(RowDirty);
  const RowsDirtyZ3 = compile(RowsDirty);
  const dirtyRows = rows.map((r, i) =>
    i % 10 === 5 ? { ...r, dict: { a: r.dict.a, b: r.dict.b, c: undefined, d: r.dict.d } } : r,
  );
  {
    const stockOut = RowsDirty.parse(dirtyRows);
    const zcOut = RowsDirtyZ3.parse(dirtyRows);
    assert.deepStrictEqual(zcOut, stockOut);
    let mapsShared = 0;
    for (let i = 0; i < N; i++) if (zcOut[i]!.lookup === dirtyRows[i]!.lookup) mapsShared++;
    console.log(
      `  S5 dirty zod-cow: ${shareReport(zcOut, dirtyRows, "dict")} · Map by reference ${mapsShared.toLocaleString()} / ${N.toLocaleString()} (the copied rows keep their Map and Set)`,
    );
  }
  const runDirty = await runScenario(
    "S5 record/map/set, 10% dirty records",
    `${N.toLocaleString()} rows, one record value in ten of every tenth row is undefined and defaulted`,
    [
      {
        column: "stock",
        label: "stock zod3 safeParse (default in record value)",
        run: stockRun(RowsDirty, dirtyRows),
      },
      {
        column: "zc",
        label: "zod-cow-v3 safeParse (90% zero-copy)",
        run: zcRun(RowsDirtyZ3, dirtyRows),
      },
      { column: "ark", label: "ArkType", na: "no equivalent native typed Map/Set traversal" },
    ],
  );
  printRatios(runDirty);
  runs.push(runDirty);
}

/* ─────────────────────────── S6: tuple ─────────────────────────── */

{
  const rows = makeTupleRows();
  const RowsZ3 = compile(TupleRows);
  const base = rows[4]!;
  const rowVariant = (patch: Record<string, unknown>): unknown[] => [{ ...base, ...patch }];
  await gate("S6", parseImpls(TupleRows, RowsZ3, ArkTupleRows), [
    { name: "valid row, 2-element label", input: [rows[4]!], accept: true },
    { name: "valid row, label with undefined second slot", input: [rows[5]!], accept: true },
    {
      name: "label with 1 element (zod3 tuples have no optional slots)",
      input: rowVariant({ label: ["a"] }),
      accept: false,
    },
    { name: "point has 3 elements", input: rowVariant({ point: [1, 2, 3] }), accept: false },
    { name: "point has 1 element", input: rowVariant({ point: [1] }), accept: false },
    { name: "point element is a string", input: rowVariant({ point: [1, "2"] }), accept: false },
    { name: "point element is NaN", input: rowVariant({ point: [Number.NaN, 2] }), accept: false },
    { name: "label has 3 elements", input: rowVariant({ label: ["a", "b", "c"] }), accept: false },
    {
      name: "label second element is a number",
      input: rowVariant({ label: ["a", 1] }),
      accept: false,
    },
    { name: "label is empty", input: rowVariant({ label: [] }), accept: false },
    { name: "point is not an array", input: rowVariant({ point: { 0: 1, 1: 2 } }), accept: false },
  ]);
  const probe = RowsZ3.parse(rows);
  const arkOut = ArkTupleRows(rows);
  assert.ok(!(arkOut instanceof ArkErrors));
  assert.deepStrictEqual(probe, TupleRows.parse(rows));
  assert.deepStrictEqual(arkOut, probe);
  console.log(
    `  S6 zod-cow: ${shareReport(probe, rows, "point")} · ArkType === input ${arkOut === rows ? "yes" : "no"}`,
  );

  const run = await runScenario(
    "S6 tuple",
    `${N.toLocaleString()} rows, [number, number] and [string, string | undefined] each`,
    [
      {
        column: "stock",
        label: "stock zod3 safeParse (new array per tuple)",
        run: stockRun(TupleRows, rows),
      },
      { column: "zc", label: "zod-cow-v3 safeParse (zero-copy)", run: zcRun(RowsZ3, rows) },
      { column: "ark", label: "ArkType Type(data) (tuples)", run: arkRun(ArkTupleRows, rows) },
    ],
  );
  printRatios(run);
  runs.push(run);

  // A dirty tuple: the second point coordinate carries a default and is undefined in half the rows
  const PointDefault = z.tuple([z.number(), z.number().default(0)]);
  const RowDefault = z.object({
    id: z.number().int(),
    point: PointDefault,
    label: TupleRows.element.shape.label,
  });
  const RowsDefault = z.array(RowDefault);
  const RowsDefaultZ3 = compile(RowsDefault);
  const dirtyRows = rows.map((r, i) =>
    i % 2 === 0 ? { ...r, point: [r.point[0], undefined] } : r,
  );
  {
    const stockOut = RowsDefault.parse(dirtyRows);
    const zcOut = RowsDefaultZ3.parse(dirtyRows);
    assert.deepStrictEqual(zcOut, stockOut);
    console.log(`  S6 dirty zod-cow: ${shareReport(zcOut, dirtyRows, "label")}`);
  }
  const runDirty = await runScenario(
    "S6 tuple, 50% dirty",
    `${N.toLocaleString()} rows, the second point slot is undefined and defaulted in every other row`,
    [
      {
        column: "stock",
        label: "stock zod3 safeParse (default in tuple slot)",
        run: stockRun(RowsDefault, dirtyRows),
      },
      {
        column: "zc",
        label: "zod-cow-v3 safeParse (50% zero-copy)",
        run: zcRun(RowsDefaultZ3, dirtyRows),
      },
      {
        column: "ark",
        label: "ArkType",
        na: "no default for a tuple slot in ArkType 2.2.3 (key defaults apply to object keys only)",
      },
    ],
  );
  printRatios(runDirty);
  runs.push(runDirty);
}

/* ─────────────────────────── S7: transforms ─────────────────────────── */

{
  // A sync string transform on one leaf plus a nested one. Two datasets on the same schema: one
  // where the transform changes every row (every row and the array are rebuilt by every
  // implementation), one where it is a no-op on the data (`trim` / `toLowerCase` of an already
  // clean string returns an equal primitive, so CoW keeps the input by reference).
  const Row = z.object({
    id: z.number().int(),
    email: z.string().transform((e) => e.toLowerCase()),
    score: z.number(),
    meta: z.object({ tag: z.string().transform((t) => t.trim()), note: z.string() }),
  });
  const Rows = z.array(Row);
  const RowsZ3 = compile(Rows);
  const ArkRows = type({
    id: "number.integer",
    email: type("string").pipe((e) => e.toLowerCase()),
    score: "number",
    meta: { tag: type("string").pipe((t) => t.trim()), note: "string" },
  }).array();
  type S7Row = { id: number; email: string; score: number; meta: { tag: string; note: string } };
  const dirty: S7Row[] = new Array(N);
  const clean: S7Row[] = new Array(N);
  for (let i = 0; i < N; i++) {
    dirty[i] = {
      id: i,
      email: `USER${i}@EXAMPLE.COM`,
      score: i % 100,
      meta: { tag: `  t${i % 7} `, note: "n" },
    };
    clean[i] = {
      id: i,
      email: `user${i}@example.com`,
      score: i % 100,
      meta: { tag: `t${i % 7}`, note: "n" },
    };
  }
  const s7Sample = dirty[3]!;
  await gate("S7", parseImpls(Rows, RowsZ3, ArkRows), [
    {
      name: "row with uppercase email and padded tag (transformed)",
      input: [s7Sample],
      accept: true,
    },
    { name: "row already lowercase and trimmed (no-op)", input: [clean[3]!], accept: true },
    { name: "non-integer id (1.5)", input: [{ ...s7Sample, id: 1.5 }], accept: false },
    { name: "email is a number", input: [{ ...s7Sample, email: 5 }], accept: false },
    { name: "score is a string", input: [{ ...s7Sample, score: "1" }], accept: false },
  ]);
  {
    const stockOut = Rows.parse(dirty);
    const zcOut = RowsZ3.parse(dirty);
    assert.deepStrictEqual(zcOut, stockOut);
    for (let i = 0; i < N; i++) assert.equal(zcOut[i]!.email, dirty[i]!.email.toLowerCase());
    assert.equal(dirty[3]!.email, s7Sample.email, "the input was mutated");
    console.log(
      `  S7 dirty zod-cow: ${shareReport(zcOut, dirty, "meta")} (every row is transformed)`,
    );
    const zcClean = RowsZ3.parse(clean);
    assert.deepStrictEqual(zcClean, Rows.parse(clean));
    console.log(
      `  S7 no-op zod-cow: ${shareReport(zcClean, clean, "meta")} (equal primitives are clean)`,
    );
  }
  const run = await runScenario(
    "S7 sync transform, every row changed",
    `${N.toLocaleString()} rows, lowercase email + trimmed nested tag, both change every row`,
    [
      { column: "stock", label: "stock zod3 safeParse (transform)", run: stockRun(Rows, dirty) },
      { column: "zc", label: "zod-cow-v3 safeParse (every row copied)", run: zcRun(RowsZ3, dirty) },
      { column: "ark", label: "ArkType Type(data) (morph)", run: arkRun(ArkRows, dirty) },
    ],
  );
  printRatios(run);
  runs.push(run);
  const runClean = await runScenario(
    "S7 sync transform, no-op on the data",
    `${N.toLocaleString()} rows already lowercase and trimmed: the transforms return equal primitives`,
    [
      {
        column: "stock",
        label: "stock zod3 safeParse (transform, no-op)",
        run: stockRun(Rows, clean),
      },
      { column: "zc", label: "zod-cow-v3 safeParse (zero-copy)", run: zcRun(RowsZ3, clean) },
      { column: "ark", label: "ArkType Type(data) (morph, no-op)", run: arkRun(ArkRows, clean) },
    ],
  );
  printRatios(runClean);
  runs.push(runClean);

  // Async: the zod3 line is a sync compiler and reports async refinements/transforms as
  // unsupported at parse time. Stock zod3 is measured alone for the record; ArkType 2.2.3 has no
  // async morph (proven, not assumed).
  const M = Math.ceil(N / 10);
  const AsyncRow = z.object({
    id: z.number().int(),
    email: z.string().transform(async (e) => e.toLowerCase()),
    score: z.number(),
  });
  const AsyncRows = z.array(AsyncRow);
  const asyncRows: { id: number; email: string; score: number }[] = new Array(M);
  for (let i = 0; i < M; i++)
    asyncRows[i] = { id: i, email: `USER${i}@EXAMPLE.COM`, score: i % 100 };
  const AsyncZ3 = compile(AsyncRows);
  let zcAsyncNA = "zod-cow-v3 accepted the async transform (unexpected)";
  try {
    AsyncZ3.parse(asyncRows);
  } catch (e) {
    zcAsyncNA = `zod-cow-v3 sync compiler (${(e as Error).constructor.name} at parse time)`;
  }
  const arkAsyncMorph = type("string").pipe(async (s) => s.toLowerCase());
  const arkAsyncOut = arkAsyncMorph("ABC");
  assert.ok(arkAsyncOut instanceof Promise, "ArkType now awaits async morphs: revisit the S7 N/A");
  await arkAsyncOut;
  const stockAsync = AsyncRows.safeParseAsync.bind(AsyncRows);
  const runAsync = await runScenario(
    "S7 async transform",
    `${M.toLocaleString()} rows, async lowercase transform on one leaf (stock zod3 only)`,
    [
      {
        column: "stock",
        label: "stock zod3 safeParseAsync",
        run: async () => {
          const r = await stockAsync(asyncRows);
          return r.success ? r.data : fail("stock async");
        },
      },
      { column: "zc", label: "zod-cow-v3", na: zcAsyncNA },
      {
        column: "ark",
        label: "ArkType",
        na: "native async morph unsupported",
        detail:
          "ArkType 2.2.3: a `.pipe(async fn)` morph returns an un-awaited Promise, so the parse result is a pending Promise; wrapping a sync morph in Promise.resolve() would not be the same workload.",
      },
    ],
  );
  runs.push(runAsync);
}

/* ─────────────────────────── S8: strip-unknown parity ─────────────────────────── */

{
  // Every row gets one undeclared top-level key and one undeclared nested key; `tags` is shared
  // with the S1 row so the reference report can show which nested references survive.
  const stripData: unknown[] = data.map((a, i) => ({
    ...a,
    legacyId: `L${i}`,
    address: { ...a.address, geo: `${i % 90},${i % 180}` },
  }));
  const ArkAccountsStrip = type(arkAccountShape).onDeepUndeclaredKey("delete").array();
  const impls = parseImpls(AccountsStock, Z3Stock, ArkAccountsStrip);
  impls[2]!.label = "ArkType Type(data) with onDeepUndeclaredKey('delete')";

  const one = (patch: Record<string, unknown>): unknown[] => [
    { ...structuredClone(sample), ...patch },
  ];
  const withNested = (patch: Record<string, unknown>): unknown[] =>
    one({ address: { ...sample.address, ...patch } });
  await gate("S8", impls, [
    { name: "clean account (no undeclared keys)", input: [sample], accept: true },
    { name: "one undeclared top-level key", input: one({ legacyId: "L1" }), accept: true },
    { name: "one undeclared nested key", input: withNested({ geo: "1,2" }), accept: true },
    {
      name: "undeclared keys at both levels",
      input: [
        { ...structuredClone(sample), legacyId: "L1", address: { ...sample.address, geo: "1,2" } },
      ],
      accept: true,
    },
    {
      name: "undeclared key next to an invalid field",
      input: one({ legacyId: "L1", id: 1.5 }),
      accept: false,
    },
    { name: `generated dataset (${N.toLocaleString()} rows)`, input: stripData, accept: true },
  ]);
  // Outputs deepStrictEqual (checked by the gate) and no input mutation
  const row0 = stripData[0] as RawAccount & { legacyId: string; address: { geo: string } };
  const stockOut = AccountsStock.parse(stripData);
  const zcOut = Z3Stock.parse(stripData);
  const arkOut = ArkAccountsStrip(stripData);
  assert.ok(!(arkOut instanceof ArkErrors));
  assert.deepStrictEqual(zcOut, stockOut);
  assert.deepStrictEqual(arkOut, stockOut);
  assert.equal(row0.legacyId, "L0");
  assert.equal(row0.address.geo, "0,0");
  assert.ok(!("legacyId" in zcOut[0]!) && !("geo" in zcOut[0]!.address));
  console.log(
    `  S8 undeclared keys removed ✓, input untouched ✓ · zod-cow: ${shareReport(zcOut, stripData, "tags")} (every row and address are copied, the untouched tags arrays are shared)`,
  );
  const run = await runScenario(
    "S8 strip-unknown parity",
    `${N.toLocaleString()} accounts, every row carries an undeclared top-level key and an undeclared nested key`,
    [
      {
        column: "stock",
        label: "stock zod3 safeParse (strip, rebuilt)",
        run: stockRun(AccountsStock, stripData),
      },
      {
        column: "zc",
        label: "zod-cow-v3 safeParse (strip: copy per dirty object)",
        run: zcRun(Z3Stock, stripData),
      },
      {
        column: "ark",
        label: "ArkType onDeepUndeclaredKey('delete') (morph)",
        run: arkRun(ArkAccountsStrip, stripData),
      },
    ],
  );
  printRatios(run);
  runs.push(run);
}

/* ─────────────────────────── calibration, S9 ─────────────────────────── */

runs.push(...(await runCalibration()));
runs.push(...(await runFailures()));

/* ─────────────────────────── Summary ─────────────────────────── */

printSummary(runs);
console.log(
  "\nNotes: alloc = heapUsed delta at the end of a timed call (before gc); retained = the delta still held after gc; hot-loop rows report ns per operation and no allocation.",
);
console.log(
  "  zod-cow-v3 returns the input reference on the clean path (0 allocated, 0 retained) and shallow-copies only the dirty path otherwise; validate() is the same runtime as parse().",
);
console.log(
  "  ArkType schemas carry the same constraints as the zod3 schemas (see the gate output: UTF-16 length bound, plain number, zod3's email/datetime patterns); its `Map`/`Set` and async morphs have no equivalent in 2.2.3, hence the S5/S7 N/A.",
);
