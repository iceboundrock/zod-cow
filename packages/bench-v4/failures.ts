/**
 * Failure-path scenarios. Two APIs answer two different questions and are never mixed:
 *
 *   S9 validation-only failures   boolean verdict on an invalid record, no error object:
 *                                 `z.validate(compiled, v)`, zod-cow `validate()`, ArkType `.allows()`
 *                                 (single-record hot loops, one per failure kind)
 *   S10 full parse failures       the normal parse API with detailed failure information:
 *                                 stock `safeParse`, `z.compile().safeParse`, zod-cow `safeParse`,
 *                                 ArkType `Type(data)` returning `ArkErrors`.
 *                                 (a) per-row parses over datasets with 1% / 10% / 50% / 100%
 *                                     invalid rows (batch), (b) single-record hot loops with the
 *                                     failure at the first key, the last key, a nested key and a
 *                                     refine
 *
 * Both compiled zod paths (public and zod-cow) run their fast path first and fall back to the
 * runtime parser for the error, so an invalid record costs the partial fast path plus the full
 * runtime parse; the refine scenario counts how often the predicate ran per implementation so
 * that double work is visible, not inferred.
 */
import assert from "node:assert/strict";
import { ArkErrors, type } from "arktype";
import { z } from "zod";
import { compileFn, INVALID } from "zod/v4/core";
import { compile } from "zod-cow-v4";
import { ITERS } from "./calibration.js";
import { gate, type Impl } from "./gates.js";
import { printRatios, runScenario, type ScenarioRun } from "./harness.js";
import {
  AccountStock,
  ArkAccount,
  arkAccountShape,
  ArkTupleRow,
  data,
  fail,
  N,
  PublicAccount,
  type RawAccount,
  sample,
  TupleRow,
  variantOne,
  Z4Account,
} from "./schemas.js";

type Validator = (i: unknown) => unknown;

export async function runFailures(): Promise<ScenarioRun[]> {
  const runs: ScenarioRun[] = [];
  const K = ITERS;

  /* ─────────────────────────── S9: validation-only failures ─────────────────────────── */

  const accountValidator = compileFn(AccountStock, { assertOnly: true }) as Validator;
  const tupleValidator = compileFn(TupleRow, { assertOnly: true }) as Validator;
  const PublicTuple = z.compile(TupleRow);
  const Z4Tuple = compile(TupleRow);
  assert.ok(PublicTuple !== TupleRow && !Z4Tuple.stock);

  const validateImpls = (
    compiled: z.ZodType,
    validator: Validator,
    zc: { validate: (i: unknown) => unknown },
    ark: { allows: (i: unknown) => boolean },
  ): Impl[] => [
    { column: "public", label: "z.validate(compiled)", accepts: (i) => z.validate(compiled, i) },
    {
      column: "official",
      label: "internal assertOnly validator",
      accepts: (i) => validator(i) === true,
    },
    { column: "zc", label: "zod-cow validate", accepts: (i) => zc.validate(i) === i },
    { column: "ark", label: "ArkType allows", accepts: (i) => ark.allows(i) },
  ];

  const tupleRow = { id: 4, point: [4, 4], label: ["L4", "T4"] };
  const s9Fixtures: {
    id: string;
    what: string;
    input: unknown;
    compiled: z.ZodType;
    validator: Validator;
    zc: { validate: (i: unknown) => unknown };
    ark: { allows: (i: unknown) => boolean };
    valid: unknown;
  }[] = [
    {
      id: "S9 invalid first field",
      what: "id = 1.5 (the first declared key)",
      input: variantOne(sample, { id: 1.5 }),
      compiled: PublicAccount,
      validator: accountValidator,
      zc: Z4Account,
      ark: ArkAccount,
      valid: sample,
    },
    {
      id: "S9 invalid last field",
      what: 'active = "yes" (the last declared key)',
      input: variantOne(sample, { active: "yes" }),
      compiled: PublicAccount,
      validator: accountValidator,
      zc: Z4Account,
      ark: ArkAccount,
      valid: sample,
    },
    {
      id: "S9 invalid nested address",
      what: "address.zip = 12345 (nested object)",
      input: variantOne(sample, { address: { ...sample.address, zip: 12345 } }),
      compiled: PublicAccount,
      validator: accountValidator,
      zc: Z4Account,
      ark: ArkAccount,
      valid: sample,
    },
    {
      id: "S9 malformed email",
      what: 'email = "user@example" (regex format)',
      input: variantOne(sample, { email: "user@example" }),
      compiled: PublicAccount,
      validator: accountValidator,
      zc: Z4Account,
      ark: ArkAccount,
      valid: sample,
    },
    {
      id: "S9 invalid tuple element",
      what: 'point = [4, "4"] (tuple slot type)',
      input: { ...tupleRow, point: [4, "4"] },
      compiled: PublicTuple,
      validator: tupleValidator,
      zc: Z4Tuple,
      ark: ArkTupleRow,
      valid: tupleRow,
    },
  ];

  for (const f of s9Fixtures) {
    await gate(f.id, validateImpls(f.compiled, f.validator, f.zc, f.ark), [
      { name: "valid control", input: f.valid, accept: true },
      { name: f.what, input: f.input, accept: false },
    ]);
    const { compiled, validator, zc, ark, input } = f;
    const run = await runScenario(
      f.id,
      `${f.what}, boolean verdict only, ${K.toLocaleString()} validations per round`,
      [
        { column: "stock", label: "stock zod4", na: "no validation-only API" },
        {
          column: "public",
          label: "z.validate(compiled, data) (runtime fallback on failure)",
          run: () => {
            let rejected = 0;
            for (let i = 0; i < K; i++) if (!z.validate(compiled, input)) rejected++;
            return rejected === K ? rejected : fail("z.validate accepted");
          },
        },
        {
          column: "official",
          label: "internal assertOnly validator (sentinel only)",
          run: () => {
            let rejected = 0;
            for (let i = 0; i < K; i++) if (validator(input) === INVALID) rejected++;
            return rejected === K ? rejected : fail("internal validator accepted");
          },
        },
        {
          column: "zc",
          label: "zod-cow-v4 validate (null, no fallback)",
          run: () => {
            let rejected = 0;
            for (let i = 0; i < K; i++) if (zc.validate(input) === null) rejected++;
            return rejected === K ? rejected : fail("zod-cow validate accepted");
          },
        },
        {
          column: "ark",
          label: "ArkType allows",
          run: () => {
            let rejected = 0;
            for (let i = 0; i < K; i++) if (!ark.allows(input)) rejected++;
            return rejected === K ? rejected : fail("ArkType allows accepted");
          },
        },
      ],
      { iterations: K },
    );
    printRatios(run);
    runs.push(run);
  }

  /* ─────────────────────────── S10 (a): datasets with invalid rows ─────────────────────────── */

  const parseImpls = (
    schema: z.ZodType,
    compiled: z.ZodType,
    zc: { safeParse: (i: unknown) => { success: boolean } },
    ark: (i: unknown) => unknown,
  ): Impl[] => [
    { column: "stock", label: "stock safeParse", accepts: (i) => schema.safeParse(i).success },
    {
      column: "public",
      label: "z.compile() safeParse",
      accepts: (i) => compiled.safeParse(i).success,
    },
    { column: "zc", label: "zod-cow safeParse", accepts: (i) => zc.safeParse(i).success },
    { column: "ark", label: "ArkType Type(data)", accepts: (i) => !(ark(i) instanceof ArkErrors) },
  ];

  // Per-row parses: each row is an independent parse that succeeds or returns detailed errors
  // (a whole-array parse would stop being comparable, since one invalid row fails the array).
  // Invalid rows carry a malformed email, a mid-object regex failure.
  const badEmail = "user@example";
  for (const share of [0.01, 0.1, 0.5, 1]) {
    const every = Math.round(1 / share);
    const rows: unknown[] = new Array(N);
    const expected = new Uint8Array(N);
    let invalid = 0;
    for (let i = 0; i < N; i++) {
      if (i % every === 0) {
        rows[i] = { ...data[i]!, email: badEmail };
        invalid++;
      } else {
        rows[i] = data[i]!;
        expected[i] = 1;
      }
    }
    const pct = `${(share * 100).toFixed(0)}%`;
    await gate(
      `S10 ${pct} invalid`,
      parseImpls(AccountStock, PublicAccount, Z4Account, ArkAccount),
      [
        { name: "valid row", input: sample, accept: true },
        { name: "invalid row (malformed email)", input: rows[0], accept: false },
      ],
    );
    // Every timed call parses every row and checks the verdict against the expectation
    const stockLoop = () => {
      let ok = 0;
      for (let i = 0; i < N; i++)
        if (AccountStock.safeParse(rows[i]).success === (expected[i] === 1)) ok++;
      return ok === N ? ok : fail("stock verdict");
    };
    const publicLoop = () => {
      let ok = 0;
      for (let i = 0; i < N; i++)
        if (PublicAccount.safeParse(rows[i]).success === (expected[i] === 1)) ok++;
      return ok === N ? ok : fail("z.compile() verdict");
    };
    const zcLoop = () => {
      let ok = 0;
      for (let i = 0; i < N; i++)
        if (Z4Account.safeParse(rows[i]).success === (expected[i] === 1)) ok++;
      return ok === N ? ok : fail("zod-cow verdict");
    };
    const arkLoop = () => {
      let ok = 0;
      for (let i = 0; i < N; i++)
        if (!(ArkAccount(rows[i]) instanceof ArkErrors) === (expected[i] === 1)) ok++;
      return ok === N ? ok : fail("ArkType verdict");
    };
    const run = await runScenario(
      `S10 parse failures, ${pct} invalid rows`,
      `${N.toLocaleString()} per-row safeParse calls, ${invalid.toLocaleString()} rows with a malformed email; detailed errors built for every invalid row`,
      [
        { column: "stock", label: `stock zod4 safeParse per row (${pct} invalid)`, run: stockLoop },
        {
          column: "public",
          label: `z.compile() safeParse per row (${pct} invalid)`,
          run: publicLoop,
        },
        {
          column: "official",
          label: "internal compileFn parser",
          na: "returns a sentinel, builds no error (not the same question)",
        },
        { column: "zc", label: `zod-cow-v4 safeParse per row (${pct} invalid)`, run: zcLoop },
        { column: "ark", label: `ArkType Type(row) per row (${pct} invalid)`, run: arkLoop },
      ],
    );
    printRatios(run);
    runs.push(run);
  }

  /* ─────────────────────────── S10 (b): failure position ─────────────────────────── */

  // A refine on the account object, with a counter so the run can state how many times the
  // predicate executed per failed parse in each implementation.
  let refineCalls = 0;
  const AccountRefined = AccountStock.refine((a) => {
    refineCalls++;
    return a.balance >= 0;
  });
  const PublicRefined = z.compile(AccountRefined);
  const Z4Refined = compile(AccountRefined);
  const ArkRefined = type(arkAccountShape).narrow((a: { balance: number }) => {
    refineCalls++;
    return a.balance >= 0;
  });
  assert.ok(PublicRefined !== AccountRefined && !Z4Refined.stock);

  const positions: {
    id: string;
    what: string;
    input: unknown;
    schema: z.ZodType;
    compiled: z.ZodType;
    zc: { safeParse: (i: unknown) => { success: boolean } };
    ark: (i: unknown) => unknown;
  }[] = [
    {
      id: "S10 failure at the first key",
      what: "id = 1.5",
      input: variantOne(sample, { id: 1.5 }),
      schema: AccountStock,
      compiled: PublicAccount,
      zc: Z4Account,
      ark: ArkAccount,
    },
    {
      id: "S10 failure at the last key",
      what: 'active = "yes"',
      input: variantOne(sample, { active: "yes" }),
      schema: AccountStock,
      compiled: PublicAccount,
      zc: Z4Account,
      ark: ArkAccount,
    },
    {
      id: "S10 deep nested failure",
      what: "address.zip = 12345",
      input: variantOne(sample, { address: { ...sample.address, zip: 12345 } }),
      schema: AccountStock,
      compiled: PublicAccount,
      zc: Z4Account,
      ark: ArkAccount,
    },
    {
      id: "S10 refine failure",
      what: "balance = -1 against .refine(balance >= 0)",
      input: variantOne(sample, { balance: -1 }),
      schema: AccountRefined,
      compiled: PublicRefined,
      zc: Z4Refined,
      ark: ArkRefined,
    },
  ];

  for (const p of positions) {
    await gate(p.id, parseImpls(p.schema, p.compiled, p.zc, p.ark), [
      { name: "valid control", input: sample, accept: true },
      { name: p.what, input: p.input, accept: false },
    ]);
    if (p.schema === AccountRefined) {
      const count = (f: () => unknown) => {
        refineCalls = 0;
        f();
        return refineCalls;
      };
      const per = [
        `stock ${count(() => AccountRefined.safeParse(p.input))}`,
        `z.compile() ${count(() => PublicRefined.safeParse(p.input))}`,
        `zod-cow ${count(() => Z4Refined.safeParse(p.input))}`,
        `ArkType ${count(() => ArkRefined(p.input))}`,
      ];
      console.log(`  S10 refine predicate executions per failed parse: ${per.join(" · ")}`);
      const perValid = [
        `stock ${count(() => AccountRefined.safeParse(sample))}`,
        `z.compile() ${count(() => PublicRefined.safeParse(sample))}`,
        `zod-cow ${count(() => Z4Refined.safeParse(sample))}`,
        `ArkType ${count(() => ArkRefined(sample))}`,
      ];
      console.log(
        `  S10 refine predicate executions per successful parse: ${perValid.join(" · ")}`,
      );
    }
    const { schema, compiled, zc, ark, input } = p;
    const run = await runScenario(
      p.id,
      `${p.what}, detailed errors, ${K.toLocaleString()} parses per round`,
      [
        {
          column: "stock",
          label: "stock zod4 safeParse (ZodError)",
          run: () => {
            let rejected = 0;
            for (let i = 0; i < K; i++) if (!schema.safeParse(input).success) rejected++;
            return rejected === K ? rejected : fail("stock accepted");
          },
        },
        {
          column: "public",
          label: "z.compile() safeParse (fast path + runtime fallback)",
          run: () => {
            let rejected = 0;
            for (let i = 0; i < K; i++) if (!compiled.safeParse(input).success) rejected++;
            return rejected === K ? rejected : fail("z.compile() accepted");
          },
        },
        {
          column: "official",
          label: "internal compileFn parser",
          na: "returns a sentinel, builds no error (not the same question)",
        },
        {
          column: "zc",
          label: "zod-cow-v4 safeParse (skeleton + stock fallback)",
          run: () => {
            let rejected = 0;
            for (let i = 0; i < K; i++) if (!zc.safeParse(input).success) rejected++;
            return rejected === K ? rejected : fail("zod-cow accepted");
          },
        },
        {
          column: "ark",
          label: "ArkType Type(data) (ArkErrors)",
          run: () => {
            let rejected = 0;
            for (let i = 0; i < K; i++) if (ark(input) instanceof ArkErrors) rejected++;
            return rejected === K ? rejected : fail("ArkType accepted");
          },
        },
      ],
      { iterations: K },
    );
    printRatios(run);
    runs.push(run);
  }

  return runs;
}

// The failure datasets derive from the S1 rows; keep the row type visible for readers of this file
export type { RawAccount };
