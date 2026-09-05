/**
 * S8 strip-unknown parse parity: every row carries undeclared keys, at the top level and inside
 * the nested address, and every implementation must accept the row, drop the undeclared keys and
 * leave the input untouched. This is the semantics of the public `parseSafe` comparisons (an
 * object with extra keys parsed into a clean copy), which S1 does not exercise: its fixture has no
 * undeclared keys, so ArkType's default pass-through and zod's default strip coincide there.
 *
 * ArkType is configured through its own API, `onDeepUndeclaredKey("delete")`: the nested address
 * strips too, as zod's nested object does. Deleting is a morph in ArkType, so every row is rebuilt
 * even when it carries nothing undeclared (the reference report below shows it).
 */
import assert from "node:assert/strict";
import { type } from "arktype";
import { type Fixture, gate } from "./gates.js";
import { printRatios, runScenario, type ScenarioRun } from "./harness.js";
import {
  AccountsStock,
  arkAccountShape,
  arkRun,
  data,
  N,
  officialParser,
  officialRun,
  parseImpls,
  PublicAccountsStock,
  publicRun,
  type RawAccount,
  sample,
  stockRun,
  Z4Stock,
  zcRun,
} from "./schemas.js";

export async function runStripParity(): Promise<ScenarioRun> {
  // Every row gets one undeclared top-level key and one undeclared nested key; `tags` is shared
  // with the S1 row so the reference report can show which nested references survive.
  const stripData: unknown[] = data.map((a, i) => ({
    ...a,
    legacyId: `L${i}`,
    address: { ...a.address, geo: `${i % 90},${i % 180}` },
  }));

  const ArkAccountsStrip = type(arkAccountShape).onDeepUndeclaredKey("delete").array();

  const impls = parseImpls(
    AccountsStock,
    PublicAccountsStock,
    officialParser,
    Z4Stock,
    ArkAccountsStrip,
  );
  impls[4]!.label = "ArkType Type(data) with onDeepUndeclaredKey('delete')";

  const one = (patch: Record<string, unknown>): unknown[] => [
    { ...structuredClone(sample), ...patch },
  ];
  const symbolKey = Symbol("undeclared");
  const withSymbol: unknown[] = [{ ...structuredClone(sample), [symbolKey]: 1 }];
  const fixtures: Fixture[] = [
    { name: "clean account without extras", input: [sample], accept: true },
    { name: "top-level extra key", input: one({ legacyId: "L1" }), accept: true },
    {
      name: "nested extra key (address.geo)",
      input: one({ address: { ...sample.address, geo: "0,0" } }),
      accept: true,
    },
    {
      name: "multiple extras, top-level and nested",
      input: one({
        legacyId: "L1",
        note: null,
        address: { ...sample.address, geo: "0,0", zone: 2 },
      }),
      accept: true,
    },
    {
      name: "undeclared symbol key",
      input: withSymbol,
      accept: true,
      outputDiffers:
        "zod strips own symbol keys (its strip mode keeps declared keys only), ArkType's undeclared-key deletion sees string keys only and keeps the symbol",
    },
    {
      name: "extra key next to an invalid field",
      input: one({ legacyId: "L1", id: 1.5 }),
      accept: false,
    },
    {
      name: `generated dataset (${N.toLocaleString()} rows, every row with extras)`,
      input: stripData,
      accept: true,
    },
  ];
  await gate("S8", impls, fixtures);

  // Symbol behavior, stated per implementation (declared above as an output difference)
  {
    const has = (o: unknown) => Object.getOwnPropertySymbols(o as object).length > 0;
    const parts = impls.map(
      (i) => `${i.label}: ${has((i.output!(withSymbol) as unknown[])[0]) ? "kept" : "stripped"}`,
    );
    console.log(`  S8 undeclared symbol key → ${parts.join(" · ")}`);
    assert.ok(has(withSymbol[0]), "the symbol-key fixture was mutated");
  }

  // Input never mutated: a deep snapshot (structuredClone keeps the string keys, which is all the
  // dataset has) must still equal the input after every implementation parsed it, and the extras
  // must still be present on the input.
  const snapshot = structuredClone(stripData);
  const outputs = impls.map((i) => i.output!(stripData) as RawAccount[]);
  assert.deepStrictEqual(stripData, snapshot, "an implementation mutated the S8 input");
  assert.ok(
    "legacyId" in (stripData[0] as object) && "geo" in (stripData[0] as RawAccount).address,
  );
  for (const out of outputs) {
    assert.ok(
      !("legacyId" in out[0]!) && !("geo" in out[0]!.address),
      "extras survived in an output",
    );
  }

  // Reference report: does the output share the root, the rows, the untouched nested references?
  const row0 = stripData[0] as RawAccount;
  for (let k = 0; k < impls.length; k++) {
    const out = outputs[k]!;
    const root = (out as unknown) === stripData ? "input reference" : "new root";
    const rowRef = out[0] === row0 ? "row reference kept" : "new row";
    const tags = out[0]!.tags === row0.tags ? "tags shared" : "tags copied";
    const addr =
      out[0]!.address === row0.address ? "address shared" : "address copied (it carried an extra)";
    console.log(`  S8 references · ${impls[k]!.label}: ${root}, ${rowRef}, ${tags}, ${addr}`);
  }
  // zod-cow: the array and every row are copied (each row carried an extra), the untouched `tags` array is shared
  const zcOut = outputs[3]!;
  assert.ok((zcOut as unknown) !== stripData && zcOut[0] !== row0 && zcOut[0]!.tags === row0.tags);

  const run = await runScenario(
    "S8 strip-unknown parse parity",
    `${N.toLocaleString()} accounts, one undeclared key per row and per address; outputs deepStrictEqual, inputs untouched`,
    [
      {
        column: "stock",
        label: "stock zod4 safeParse (strip)",
        run: stockRun(AccountsStock, stripData),
      },
      {
        column: "public",
        label: "z.compile() safeParse (strip)",
        run: publicRun(PublicAccountsStock, stripData),
      },
      {
        column: "official",
        label: "internal compileFn parser (strip)",
        run: officialRun(officialParser, stripData),
      },
      {
        column: "zc",
        label: "zod-cow-v4 safeParse (copy the dirty path)",
        run: zcRun(Z4Stock, stripData),
      },
      {
        column: "ark",
        label: "ArkType Type(data), onDeepUndeclaredKey('delete')",
        run: arkRun(ArkAccountsStrip, stripData),
      },
    ],
  );
  printRatios(run);
  return run;
}
