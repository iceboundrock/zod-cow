/**
 * Single-record hot loops and scaling sweeps.
 *
 *   calibration      a simple object schema with ordinary primitive fields and no transform or
 *                    default, parsed and validated one record at a time (the shape most public
 *                    Zod / ArkType benchmarks measure). `validate()` is the same runtime as
 *                    `parse()` in the zod3 line, so its row is a documentation row; ArkType
 *                    `.allows()` is a real validation-only entry point.
 *   scaling sweeps   root-cause microbenchmarks, one line per configuration: primitive leaves
 *                    (bare string, one check, a format, several checks; bare number, int + finite),
 *                    object width (1 to 50 keys), nesting depth (1 to 5), array length (1 to 100)
 *                    and tuple length (1 to 10). They answer whether runtime scales with the number
 *                    of schema nodes, what a nested validator costs, and where the closure tree
 *                    stops scaling linearly. They run at a fifth of the hot-loop iteration count.
 *
 * Every candidate writes its own loop (see harness.ts on monomorphic call sites) and counts the
 * verdicts, so a rejected record can never be timed as a success.
 */
import assert from "node:assert/strict";
import { ArkErrors, type } from "arktype";
import { z } from "zod";
import { type Compiled, compile } from "zod-cow-v3";
import { type Fixture, gate, type Impl } from "./gates.js";
import { printRatios, runScenario, type ScenarioRun } from "./harness.js";
import { emailPattern, fail, N } from "./schemas.js";

/** Operations per timed round of a hot loop (`BENCH_ITERS`, default the record count) */
export const ITERS = Number(process.env.BENCH_ITERS ?? N);
if (!Number.isInteger(ITERS) || ITERS < 1) {
  throw new Error(
    `BENCH_ITERS must be a positive integer, got ${JSON.stringify(process.env.BENCH_ITERS)}`,
  );
}
const SCALE_ITERS = Math.max(1, Math.ceil(ITERS / 5));

type ArkType = ((i: unknown) => unknown) & { allows: (i: unknown) => boolean };

/** The three hot loops of one configuration; every loop counts its verdicts */
function loops(
  schema: z.ZodTypeAny,
  zc: Compiled<z.ZodTypeAny>,
  ark: ArkType,
  input: unknown,
  K: number,
) {
  return {
    stock: () => {
      let ok = 0;
      for (let i = 0; i < K; i++) if (schema.safeParse(input).success) ok++;
      return ok === K ? ok : fail("stock");
    },
    zc: () => {
      let ok = 0;
      for (let i = 0; i < K; i++) if (zc.safeParse(input).success) ok++;
      return ok === K ? ok : fail("zod-cow");
    },
    ark: () => {
      let ok = 0;
      for (let i = 0; i < K; i++) if (!(ark(input) instanceof ArkErrors)) ok++;
      return ok === K ? ok : fail("ArkType");
    },
  };
}

const parseImpls = (schema: z.ZodTypeAny, zc: Compiled<z.ZodTypeAny>, ark: ArkType): Impl[] => [
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

export async function runCalibration(): Promise<ScenarioRun[]> {
  const runs: ScenarioRun[] = [];

  /* ─────────────────────────── calibration: single record ─────────────────────────── */

  const Simple = z.object({
    id: z.number().int(),
    name: z.string(),
    email: z.string(),
    age: z.number(),
    active: z.boolean(),
    tags: z.array(z.string()),
  });
  const ArkSimple = type({
    id: "number.integer",
    name: "string",
    email: "string",
    age: "number",
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
  const Z3 = compile(Simple);
  assert.ok(Z3.pure);

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
    { name: "age is NaN", input: v({ age: Number.NaN }), accept: false },
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
  await gate("calibration parse", parseImpls(Simple, Z3, ArkSimple), fixtures);
  const validateImpls: Impl[] = [
    { column: "zc", label: "zod-cow validate", accepts: (i) => Z3.safeParse(i).success },
    { column: "ark", label: "ArkType allows", accepts: (i) => ArkSimple.allows(i) },
  ];
  await gate(
    "calibration validate",
    validateImpls,
    fixtures.map((f) => ({ ...f, outputDiffers: undefined })),
  );
  console.log(
    `  calibration output reference: zod-cow === input ${Z3.parse(rec) === rec ? "yes" : "no"} · ArkType === input ${ArkSimple(rec) === rec ? "yes" : "no"} · stock === input ${(Simple.parse(rec) as unknown) === rec ? "yes" : "no (rebuilt)"}`,
  );

  const K = ITERS;
  const l = loops(Simple, Z3, ArkSimple, rec, K);
  const parseRun = await runScenario(
    "calibration parse (single record)",
    `one 6-field primitive object parsed ${K.toLocaleString()} times per round`,
    [
      { column: "stock", label: "stock zod3 safeParse", run: l.stock },
      { column: "zc", label: "zod-cow-v3 safeParse", run: l.zc },
      { column: "ark", label: "ArkType Type(data)", run: l.ark },
    ],
    { iterations: K },
  );
  printRatios(parseRun);
  runs.push(parseRun);

  const validateRun = await runScenario(
    "calibration validate (single record)",
    `the same record ${K.toLocaleString()} times per round; zod-cow validate() is parse() with a DeepReadonly return type (same runtime), ArkType allows() is validation only`,
    [
      { column: "stock", label: "stock zod3", na: "no validation-only API" },
      {
        column: "zc",
        label: "zod-cow-v3 validate (same runtime as parse)",
        run: () => {
          let ok = 0;
          for (let i = 0; i < K; i++) if (Z3.validate(rec) === rec) ok++;
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
  runs.push(validateRun);

  /* ─────────────────────────── scaling sweeps ─────────────────────────── */

  const group = "scaling sweeps";
  const KS = SCALE_ITERS;
  console.log(
    `\n═══ scaling sweeps · ${KS.toLocaleString()} operations per round · median ns per operation (stock Zod 3 · zod-cow-v3 · ArkType) ═══`,
  );
  const sweep = async (
    id: string,
    schema: z.ZodTypeAny,
    ark: ArkType,
    input: unknown,
    invalid: unknown,
  ): Promise<void> => {
    const zc = compile(schema);
    // Gate silently: every implementation must accept the input and reject the invalid variant
    for (const impl of parseImpls(schema, zc, ark)) {
      assert.ok(await impl.accepts(input), `${id}: ${impl.label} rejected the sweep input`);
      assert.ok(
        !(await impl.accepts(invalid)),
        `${id}: ${impl.label} accepted the invalid variant`,
      );
    }
    assert.deepStrictEqual(zc.parse(input), schema.parse(input));
    const l = loops(schema, zc, ark, input, KS);
    runs.push(
      await runScenario(
        id,
        id,
        [
          { column: "stock", label: "stock", run: l.stock },
          { column: "zc", label: "zod-cow", run: l.zc },
          { column: "ark", label: "ArkType", run: l.ark },
        ],
        { iterations: KS, group, quiet: true },
      ),
    );
  };

  // primitive leaves: bare, one check, a format, several checks
  await sweep("leaf string", z.string(), type("string"), "hello", 1);
  await sweep(
    "leaf string.max(64)",
    z.string().max(64),
    type("string <= 64"),
    "hello",
    "x".repeat(65),
  );
  await sweep(
    "leaf string.email()",
    z.string().email(),
    type(emailPattern),
    "ana@example.com",
    "nope",
  );
  await sweep(
    "leaf string.min(1).max(64).email()",
    z.string().min(1).max(64).email(),
    type("1 <= string <= 64").and(emailPattern),
    "ana@example.com",
    "",
  );
  await sweep("leaf number", z.number(), type("number"), 42.5, "42");
  await sweep(
    "leaf number.int().finite()",
    z.number().int().finite(),
    type("number.integer"),
    42,
    42.5,
  );

  // object width: N string keys. The inputs go through JSON.parse so they are fast-mode objects
  // like a parsed payload: an object that gains more than a dozen properties one by one falls
  // into V8's dictionary mode, which costs every implementation several times more per key and
  // would measure the fixture, not the validators (checked with %HasFastProperties).
  for (const width of [1, 5, 10, 20, 50]) {
    const shape: Record<string, z.ZodString> = {};
    const arkShape: Record<string, "string"> = {};
    const built: Record<string, unknown> = {};
    for (let i = 0; i < width; i++) {
      shape[`k${i}`] = z.string();
      arkShape[`k${i}`] = "string";
      built[`k${i}`] = `v${i}`;
    }
    const input = JSON.parse(JSON.stringify(built));
    const invalid = JSON.parse(JSON.stringify({ ...built, k0: 1 }));
    await sweep(`object width ${width} keys`, z.object(shape), type(arkShape), input, invalid);
  }

  // nesting depth: { v: string, child: { v, child: ... } }
  for (const depth of [1, 2, 3, 5]) {
    let schema: z.ZodTypeAny = z.object({ v: z.string() });
    let ark: any = { v: "string" };
    let input: any = { v: "leaf" };
    let invalid: any = { v: 1 };
    for (let d = 1; d < depth; d++) {
      schema = z.object({ v: z.string(), child: schema });
      ark = { v: "string", child: ark };
      input = { v: `d${d}`, child: input };
      invalid = { v: `d${d}`, child: invalid };
    }
    await sweep(`nesting depth ${depth}`, schema, type(ark), input, invalid);
  }

  // arrays of strings
  for (const len of [1, 5, 20, 100]) {
    const input = Array.from({ length: len }, (_, i) => `s${i}`);
    await sweep(`array of ${len} strings`, z.array(z.string()), type("string[]"), input, [
      ...input.slice(0, -1),
      1,
    ]);
  }

  // tuples of numbers
  for (const len of [1, 2, 3, 5, 10]) {
    const items = Array.from({ length: len }, () => z.number());
    const arkItems = Array.from({ length: len }, () => "number" as const);
    const input = Array.from({ length: len }, (_, i) => i);
    await sweep(
      `tuple of ${len} numbers`,
      z.tuple(items as [z.ZodNumber, ...z.ZodNumber[]]),
      type(arkItems as never) as unknown as ArkType,
      input,
      [...input.slice(0, -1), "x"],
    );
  }

  return runs;
}
