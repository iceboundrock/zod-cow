/**
 * External calibration: single-record hot loops on a simple object schema with ordinary primitive
 * fields and no morph or default, the shape most public Zod / ArkType benchmarks measure. Not a
 * product workload (S1 to S10 are): it is a sanity check that this harness reproduces the broad
 * shape seen elsewhere (ArkType far ahead of the Zod interpreter on pure validation; ArkType and
 * compiled Zod in the same class on validation-only work). A contradictory shape here would be a
 * harness problem to investigate before any zod-cow optimization.
 *
 * Every candidate writes its own loop (see harness.ts on monomorphic call sites) and counts the
 * verdicts, so a rejected record can never be timed as a success.
 */
import assert from "node:assert/strict";
import { ArkErrors, type } from "arktype";
import { z } from "zod";
import { compileFn, INVALID } from "zod/v4/core";
import { compile } from "zod-cow-v4";
import { type Fixture, gate, type Impl } from "./gates.js";
import { printRatios, runScenario, type ScenarioRun } from "./harness.js";
import { arkFinite, fail, N } from "./schemas.js";

/** Operations per timed round of a hot loop (`BENCH_ITERS`, default the record count) */
export const ITERS = Number(process.env.BENCH_ITERS ?? N);
if (!Number.isInteger(ITERS) || ITERS < 1) {
  throw new Error(
    `BENCH_ITERS must be a positive integer, got ${JSON.stringify(process.env.BENCH_ITERS)}`,
  );
}

export async function runCalibration(): Promise<ScenarioRun[]> {
  const Simple = z.object({
    id: z.number().int(),
    name: z.string(),
    email: z.string(),
    age: z.number(),
    active: z.boolean(),
    tags: z.array(z.string()),
  });
  // Same constraints as the account schema: safe integer for `.int()`, the finite range for
  // `z.number()`; plain strings and booleans are the same keyword in both libraries.
  const ArkSimple = type({
    id: "number.integer & number.safe",
    name: "string",
    email: "string",
    age: arkFinite,
    active: "boolean",
    tags: "string[]",
  });
  const rec = {
    id: 42,
    name: "Ana Doe",
    email: "ana@example.com",
    age: 31,
    active: true,
    tags: ["a", "b"],
  };

  const Public = z.compile(Simple);
  assert.ok(Public !== Simple, "z.compile returned the schema uncompiled");
  const parser = compileFn(Simple) as (i: unknown) => unknown;
  const validator = compileFn(Simple, { assertOnly: true }) as (i: unknown) => unknown;
  const Z4 = compile(Simple);
  assert.ok(!Z4.stock);

  const v = (patch: Record<string, unknown>) => ({ ...rec, ...patch });
  const fixtures: Fixture[] = [
    { name: "valid record", input: rec, accept: true },
    {
      name: "valid record with an extra key",
      input: v({ extra: 1 }),
      accept: true,
      outputDiffers:
        "zod strips the undeclared key into a copy, ArkType passes it through (S8 covers strip parity)",
    },
    { name: "non-integer id (1.5)", input: v({ id: 1.5 }), accept: false },
    { name: "name is a number", input: v({ name: 1 }), accept: false },
    { name: "age is Infinity", input: v({ age: Number.POSITIVE_INFINITY }), accept: false },
    { name: "tags holds a number", input: v({ tags: ["a", 1] }), accept: false },
    {
      name: "missing active",
      input: (() => {
        const { active: _a, ...rest } = rec;
        return rest;
      })(),
      accept: false,
    },
  ];
  const parseImpls: Impl[] = [
    {
      column: "stock",
      label: "stock safeParse",
      accepts: (i) => Simple.safeParse(i).success,
      output: (i) => Simple.parse(i),
    },
    {
      column: "public",
      label: "z.compile() safeParse",
      accepts: (i) => Public.safeParse(i).success,
      output: (i) => Public.parse(i),
    },
    {
      column: "official",
      label: "internal compileFn parser",
      accepts: (i) => parser(i) !== INVALID,
      output: (i) => parser(i),
    },
    {
      column: "zc",
      label: "zod-cow safeParse",
      accepts: (i) => Z4.safeParse(i).success,
      output: (i) => Z4.parse(i),
    },
    {
      column: "ark",
      label: "ArkType Type(data)",
      accepts: (i) => !(ArkSimple(i) instanceof ArkErrors),
      output: (i) => ArkSimple(i),
    },
  ];
  await gate("calibration parse", parseImpls, fixtures);
  const validateImpls: Impl[] = [
    { column: "public", label: "z.validate(compiled)", accepts: (i) => z.validate(Public, i) },
    {
      column: "official",
      label: "internal assertOnly validator",
      accepts: (i) => validator(i) === true,
    },
    { column: "zc", label: "zod-cow validate", accepts: (i) => Z4.validate(i) === i },
    { column: "ark", label: "ArkType allows", accepts: (i) => ArkSimple.allows(i) },
  ];
  await gate(
    "calibration validate",
    validateImpls,
    fixtures.map((f) => ({ ...f, outputDiffers: undefined })),
  );
  console.log(
    `  calibration output reference: zod-cow === input ${Z4.parse(rec) === rec ? "yes" : "no"} · ArkType === input ${ArkSimple(rec) === rec ? "yes" : "no"} · z.compile() === input ${Public.parse(rec) === rec ? "yes" : "no (rebuilt)"}`,
  );

  const K = ITERS;
  const parseRun = await runScenario(
    "calibration parse (single record)",
    `one 6-field primitive object parsed ${K.toLocaleString()} times per round`,
    [
      {
        column: "stock",
        label: "stock zod4 safeParse",
        run: () => {
          let ok = 0;
          for (let i = 0; i < K; i++) if (Simple.safeParse(rec).success) ok++;
          return ok === K ? ok : fail("stock");
        },
      },
      {
        column: "public",
        label: "z.compile() safeParse",
        run: () => {
          let ok = 0;
          for (let i = 0; i < K; i++) if (Public.safeParse(rec).success) ok++;
          return ok === K ? ok : fail("z.compile()");
        },
      },
      {
        column: "official",
        label: "internal compileFn parser",
        run: () => {
          let ok = 0;
          for (let i = 0; i < K; i++) if (parser(rec) !== INVALID) ok++;
          return ok === K ? ok : fail("internal parser");
        },
      },
      {
        column: "zc",
        label: "zod-cow-v4 safeParse",
        run: () => {
          let ok = 0;
          for (let i = 0; i < K; i++) if (Z4.safeParse(rec).success) ok++;
          return ok === K ? ok : fail("zod-cow");
        },
      },
      {
        column: "ark",
        label: "ArkType Type(data)",
        run: () => {
          let ok = 0;
          for (let i = 0; i < K; i++) if (!(ArkSimple(rec) instanceof ArkErrors)) ok++;
          return ok === K ? ok : fail("ArkType");
        },
      },
    ],
    { iterations: K },
  );
  printRatios(parseRun);

  // The opt-in that drops the own-symbol probe of strip-mode objects (#43), measured as its own
  // clearly labelled row: the zod-cow-v4 column of every other scenario keeps the default, because
  // the option is a semantic choice of the caller and not a benchmark setting. Only the columns the
  // option can change are runnable here; the others are the default row above.
  const Z4Lax = compile(Simple, { ownSymbolKeys: "ignore" });
  assert.ok(!Z4Lax.stock);
  const symbolKey = Symbol("undeclared");
  const laxImpls: Impl[] = [
    parseImpls[0]!,
    parseImpls[1]!,
    {
      column: "zc",
      label: 'zod-cow safeParse, ownSymbolKeys: "ignore"',
      accepts: (i) => Z4Lax.safeParse(i).success,
      output: (i) => Z4Lax.parse(i),
    },
  ];
  const withSymbolKey = { ...rec, [symbolKey]: 1 };
  await gate('calibration parse, ownSymbolKeys "ignore"', laxImpls, [
    ...fixtures,
    {
      name: "valid record with an own symbol key",
      input: withSymbolKey,
      accept: true,
      outputDiffers:
        'zod strips the undeclared own symbol key into a copy; ownSymbolKeys: "ignore" returns the input by reference with the symbol kept (the documented divergence of the option)',
    },
  ]);
  // The declared divergence, stated and asserted per implementation (an `outputDiffers` fixture
  // skips the output comparison, so the shape of the difference is pinned here, as S8 does):
  // every zod parser strips the symbol, the opt-in alone keeps it, and it does so by reference.
  {
    const has = (o: unknown) => Object.getOwnPropertySymbols(o as object).length > 0;
    const outputs = laxImpls.map((i) => [i, i.output!(withSymbolKey)] as const);
    console.log(
      `  calibration own symbol key → ${outputs.map(([i, o]) => `${i.label}: ${has(o) ? "kept" : "stripped"}`).join(" · ")}`,
    );
    for (const [i, o] of outputs) {
      if (i.column === "zc")
        assert.equal(o, withSymbolKey, `${i.label} must return the input by reference`);
      else assert.ok(!has(o), `${i.label} must strip the undeclared symbol key`);
    }
    assert.ok(has(withSymbolKey), "the symbol-key fixture was mutated");
  }
  const laxRun = await runScenario(
    'calibration parse, ownSymbolKeys "ignore" (opt-in)',
    `the same record parsed ${K.toLocaleString()} times per round by zod-cow-v4 compiled with the opt-in that skips the own-symbol probe`,
    [
      {
        column: "stock",
        label: "stock zod4 safeParse",
        na: "unchanged from the default row above",
      },
      {
        column: "public",
        label: "z.compile() safeParse",
        run: () => {
          let ok = 0;
          for (let i = 0; i < K; i++) if (Public.safeParse(rec).success) ok++;
          return ok === K ? ok : fail("z.compile()");
        },
      },
      {
        column: "official",
        label: "internal compileFn parser",
        na: "unchanged from the default row above",
      },
      {
        column: "zc",
        label: 'zod-cow-v4 safeParse, ownSymbolKeys: "ignore"',
        run: () => {
          let ok = 0;
          for (let i = 0; i < K; i++) if (Z4Lax.safeParse(rec).success) ok++;
          return ok === K ? ok : fail("zod-cow ownSymbolKeys ignore");
        },
      },
      { column: "ark", label: "ArkType Type(data)", na: "unchanged from the default row above" },
    ],
    { iterations: K },
  );
  printRatios(laxRun);

  const validateRun = await runScenario(
    "calibration validate (single record)",
    `the same record validated ${K.toLocaleString()} times per round, boolean verdict only`,
    [
      { column: "stock", label: "stock zod4", na: "no validation-only API" },
      {
        column: "public",
        label: "z.validate(compiled, data)",
        run: () => {
          let ok = 0;
          for (let i = 0; i < K; i++) if (z.validate(Public, rec)) ok++;
          return ok === K ? ok : fail("z.validate");
        },
      },
      {
        column: "official",
        label: "internal assertOnly validator",
        run: () => {
          let ok = 0;
          for (let i = 0; i < K; i++) if (validator(rec) === true) ok++;
          return ok === K ? ok : fail("internal validator");
        },
      },
      {
        column: "zc",
        label: "zod-cow-v4 validate",
        run: () => {
          let ok = 0;
          for (let i = 0; i < K; i++) if (Z4.validate(rec) === rec) ok++;
          return ok === K ? ok : fail("zod-cow validate");
        },
      },
      {
        column: "ark",
        label: "ArkType allows",
        run: () => {
          let ok = 0;
          for (let i = 0; i < K; i++) if (ArkSimple.allows(rec)) ok++;
          return ok === K ? ok : fail("ArkType allows");
        },
      },
    ],
    { iterations: K },
  );
  printRatios(validateRun);
  return [parseRun, laxRun, validateRun];
}
