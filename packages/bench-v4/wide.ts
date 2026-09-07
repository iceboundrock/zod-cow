/**
 * S11 wide objects: single-record hot loops over flat objects of 16, 32 and 64 string keys, the
 * widths around the object skeleton's inline key-comparison cap (`MAX_INLINE_KEY_COMPARISONS`,
 * #34). The account schema of S1 to S10 has 10 keys, so no other scenario reaches the cap.
 *
 * Four rows per width:
 *   strip clean       every declared key present, nothing undeclared: the skeleton runs its
 *                     undeclared-key probe over every key and returns the input by reference
 *   strip extra key   one undeclared key after the declared ones: the probe finds it and the
 *                     copy path assembles the output from the validated values
 *   strip dirty       the last key carries a default and is missing: no probe (a dirty object is
 *                     rebuilt from its declared keys anyway), the copy path only
 *   strict clean      the same clean input through `z.strictObject`, whose undeclared-key loop
 *                     runs on every path (the official template, uncapped in stock's compiler)
 *
 * Inputs are built with `JSON.parse`, the way a validated payload usually arrives. ArkType carries
 * the same rules: `onUndeclaredKey("delete")` for the strip extra-key row (its default keeps the
 * key by reference, the declared divergence of the S1 fixture), `onUndeclaredKey("reject")` for
 * the strict row, a key default for the dirty row (with the present-`undefined` divergence S2
 * declares). Every candidate writes its own loop and counts the verdicts (see harness.ts).
 */
import assert from "node:assert/strict";
import { ArkErrors, type } from "arktype";
import { z } from "zod";
import { compileFn, INVALID } from "zod/v4/core";
import { compile } from "zod-cow-v4";
import { ITERS } from "./calibration.js";
import { type Fixture, gate, type Impl } from "./gates.js";
import { printRatios, runScenario, type ScenarioRun } from "./harness.js";
import { fail } from "./schemas.js";

export const WIDTHS = [16, 32, 64] as const;

/**
 * Operations per timed round, scaled down with the width so a round costs about the same at every
 * width (a 64-key parse costs four times a 16-key one): `BENCH_ITERS` at 16 keys, a quarter of it
 * at 64. The rows where ArkType morphs (its undeclared-key deletion and its key default rebuild
 * the object at 10 to 50 µs per operation, a hundred times the other columns) run a quarter of
 * that again, the same trade the detailed-error loops make with `ERROR_ITERS`. Each scenario
 * header prints the count it ran.
 */
export const wideIters = (width: number, morph: boolean): number =>
  Math.max(1, Math.ceil((ITERS * (morph ? 4 : 16)) / width));

type Parser = (input: unknown) => unknown;

interface Row {
  id: string;
  what: string;
  stock: z.ZodType;
  input: Record<string, string>;
  ark: (input: unknown) => unknown;
  fixtures: Fixture[];
  /** true when zod-cow must return the input by reference */
  byReference: boolean;
  /** true when the ArkType column is a morph (a rebuilt object per parse): fewer operations per round */
  morph: boolean;
}

/** `{ key0: "v0", … }` for `width` keys, then `patch`, round-tripped through JSON */
function record(width: number, patch: Record<string, string> = {}): Record<string, string> {
  const o: Record<string, string> = {};
  for (let i = 0; i < width; i++) o[`key${i}`] = `v${i}`;
  return JSON.parse(JSON.stringify({ ...o, ...patch }));
}

function rowsFor(width: number): Row[] {
  const last = `key${width - 1}`;
  const shape: Record<string, z.ZodType> = {};
  const arkShape: Record<string, string> = {};
  for (let i = 0; i < width; i++) {
    shape[`key${i}`] = z.string();
    arkShape[`key${i}`] = "string";
  }
  const Strip = z.object(shape);
  const Strict = z.strictObject(shape);
  const Dirty = z.object({ ...shape, [last]: z.string().default("d") });
  const ArkStrip = type(arkShape);
  const ArkDelete = type(arkShape).onUndeclaredKey("delete");
  const ArkStrict = type(arkShape).onUndeclaredKey("reject");
  const ArkDirty = type({ ...arkShape, [last]: "string = 'd'" });

  const clean = record(width);
  const extra = record(width, { extra: "e" });
  const { [last]: _omitted, ...withoutLast } = clean;
  const dirty = JSON.parse(JSON.stringify(withoutLast)) as Record<string, string>;
  const invalid: Fixture[] = [
    { name: "first key is a number", input: record(width, { key0: 1 as never }), accept: false },
    { name: "last key is a number", input: record(width, { [last]: 1 as never }), accept: false },
    { name: "not an object", input: "x", accept: false },
  ];
  return [
    {
      id: `S11 ${width} keys, strip clean`,
      what: `${width} string keys, every key present, nothing undeclared`,
      stock: Strip,
      input: clean,
      ark: ArkStrip,
      byReference: true,
      morph: false,
      fixtures: [
        { name: "clean record", input: clean, accept: true },
        {
          name: "record with an extra key",
          input: extra,
          accept: true,
          outputDiffers: {
            ark: "zod strips the undeclared key into a copy, ArkType passes it through (the extra-key row configures deletion)",
          },
        },
        { name: `missing ${last}`, input: dirty, accept: false },
        ...invalid,
      ],
    },
    {
      id: `S11 ${width} keys, strip extra key`,
      what: `${width} string keys plus one undeclared key, stripped into a copy`,
      stock: Strip,
      input: extra,
      ark: ArkDelete,
      byReference: false,
      morph: true,
      fixtures: [
        { name: "clean record", input: clean, accept: true },
        { name: "record with an extra key", input: extra, accept: true },
        ...invalid,
      ],
    },
    {
      id: `S11 ${width} keys, strip dirty`,
      what: `${width} string keys, the last one defaulted and missing (a copy with the default)`,
      stock: Dirty,
      input: dirty,
      ark: ArkDirty,
      byReference: false,
      morph: true,
      fixtures: [
        { name: "clean record", input: clean, accept: true },
        { name: `missing ${last} → default`, input: dirty, accept: true },
        {
          name: `present-undefined ${last}`,
          input: { ...clean, [last]: undefined },
          accept: { stock: true, public: true, official: true, zc: true, ark: false },
          divergence:
            "zod applies the default to a present key holding undefined; ArkType key defaults apply to absent keys only (the row's input has the key absent)",
        },
        ...invalid,
      ],
    },
    {
      id: `S11 ${width} keys, strict clean`,
      what: `${width} string keys through z.strictObject, every key present, nothing undeclared`,
      stock: Strict,
      input: clean,
      ark: ArkStrict,
      byReference: true,
      morph: false,
      fixtures: [
        { name: "clean record", input: clean, accept: true },
        { name: "record with an extra key", input: extra, accept: false },
        { name: `missing ${last}`, input: dirty, accept: false },
        ...invalid,
      ],
    },
  ];
}

export async function runWideObjects(): Promise<ScenarioRun[]> {
  const runs: ScenarioRun[] = [];
  for (const width of WIDTHS) {
    for (const row of rowsFor(width)) {
      const K = wideIters(width, row.morph);
      const Public = z.compile(row.stock);
      assert.ok(Public !== row.stock, "z.compile returned the schema uncompiled");
      const parser = compileFn(row.stock) as Parser;
      const Z4 = compile(row.stock);
      assert.ok(!Z4.stock);
      const { ark, input } = row;

      const impls: Impl[] = [
        {
          column: "stock",
          label: "stock safeParse",
          accepts: (i) => row.stock.safeParse(i).success,
          output: (i) => row.stock.parse(i),
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
          accepts: (i) => !(ark(i) instanceof ArkErrors),
          output: (i) => ark(i),
        },
      ];
      console.log(`\n  ${row.id}: ${row.what}`);
      await gate(row.id, impls, row.fixtures);
      const out = Z4.parse(input);
      assert.equal(
        out === input,
        row.byReference,
        `${row.id}: zod-cow ${row.byReference ? "must" : "must not"} return the input by reference`,
      );
      const arkOut = ark(input);
      console.log(
        `  ${row.id} output reference: zod-cow === input ${out === input ? "yes" : "no (copy)"} · ArkType === input ${arkOut === input ? "yes" : "no"} · probe ${Z4.code?.includes(".has(k)") ? "Set.has" : "comparison chain"}`,
      );

      const run = await runScenario(
        row.id,
        `${row.what}, ${K.toLocaleString()} parses per round`,
        [
          {
            column: "stock",
            label: "stock zod4 safeParse",
            run: () => {
              let ok = 0;
              for (let i = 0; i < K; i++) if (row.stock.safeParse(input).success) ok++;
              return ok === K ? ok : fail("stock");
            },
          },
          {
            column: "public",
            label: "z.compile() safeParse",
            run: () => {
              let ok = 0;
              for (let i = 0; i < K; i++) if (Public.safeParse(input).success) ok++;
              return ok === K ? ok : fail("z.compile()");
            },
          },
          {
            column: "official",
            label: "internal compileFn parser",
            run: () => {
              let ok = 0;
              for (let i = 0; i < K; i++) if (parser(input) !== INVALID) ok++;
              return ok === K ? ok : fail("internal parser");
            },
          },
          {
            column: "zc",
            label: "zod-cow-v4 safeParse",
            run: () => {
              let ok = 0;
              for (let i = 0; i < K; i++) if (Z4.safeParse(input).success) ok++;
              return ok === K ? ok : fail("zod-cow");
            },
          },
          {
            column: "ark",
            label: "ArkType Type(data)",
            run: () => {
              let ok = 0;
              for (let i = 0; i < K; i++) if (!(ark(input) instanceof ArkErrors)) ok++;
              return ok === K ? ok : fail("ArkType");
            },
          },
        ],
        { iterations: K },
      );
      printRatios(run);
      runs.push(run);
    }
  }
  return runs;
}
