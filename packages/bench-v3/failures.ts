/**
 * S9 failure paths. The zod3 line builds its own `ZcError` and issue list during traversal (no
 * fallback to stock), so its failure performance is its own and is measured explicitly:
 *
 *   (a) issue-semantics parity   before anything is timed, every failure fixture is parsed by stock
 *                                zod3 and zod-cow-v3 and the issue lists are compared (code, path,
 *                                message per issue, and the issue count); differences are printed
 *                                as `known divergence` lines, never hidden, because a faster
 *                                failure path that collects fewer issues would not be a win;
 *   (b) datasets                 per-row `safeParse` over datasets with 1% / 10% / 50% / 100%
 *                                invalid rows (batch);
 *   (c) failure position         single-record hot loops: first key, last key, nested key, three
 *                                sibling errors, an array element, a tuple element, a Map member,
 *                                a Set member and a refine.
 *
 * ArkType returns `ArkErrors` with its own error model; it is gated on the verdict only.
 */
import assert from "node:assert/strict";
import { ArkErrors, type } from "arktype";
import { z } from "zod";
import { type Compiled, compile } from "zod-cow-v3";
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
  sample,
  TupleRow,
  variantOne,
  Z3Account,
} from "./schemas.js";

interface IssueView {
  code: string;
  path: (string | number)[];
  message: string;
}

const view = (issues: readonly { code: string; path: (string | number)[]; message: string }[]) =>
  issues
    .map((i): IssueView => ({ code: i.code, path: [...i.path], message: i.message }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

/**
 * Compare the issue lists of stock and zod-cow for one rejected input. Returns undefined when they
 * agree on count, codes, paths and messages, otherwise a one-line description of the difference.
 */
function issueParity(
  schema: z.ZodTypeAny,
  zc: Compiled<z.ZodTypeAny>,
  input: unknown,
): string | undefined {
  const s = schema.safeParse(input);
  const c = zc.safeParse(input);
  assert.ok(!s.success && !c.success, "parity check needs a rejected input");
  const sv = view(s.error.issues);
  const cv = view(c.error.issues);
  if (JSON.stringify(sv) === JSON.stringify(cv)) return undefined;
  const fmt = (v: IssueView[]) =>
    v.map((i) => `${i.code}@${JSON.stringify(i.path)} "${i.message}"`).join(" ; ");
  return `stock ${sv.length} issue(s) [${fmt(sv)}] · zod-cow ${cv.length} issue(s) [${fmt(cv)}]`;
}

export async function runFailures(): Promise<ScenarioRun[]> {
  const runs: ScenarioRun[] = [];
  const K = ITERS;

  const parseImpls = (
    schema: z.ZodTypeAny,
    zc: Compiled<z.ZodTypeAny>,
    ark: ((i: unknown) => unknown) | undefined,
  ): Impl[] => {
    const impls: Impl[] = [
      { column: "stock", label: "stock safeParse", accepts: (i) => schema.safeParse(i).success },
      { column: "zc", label: "zod-cow safeParse", accepts: (i) => zc.safeParse(i).success },
    ];
    if (ark)
      impls.push({
        column: "ark",
        label: "ArkType Type(data)",
        accepts: (i) => !(ark(i) instanceof ArkErrors),
      });
    return impls;
  };

  /* ─────────────────────────── (c) fixtures, shared with (a) ─────────────────────────── */

  let refineCalls = 0;
  const AccountRefined = AccountStock.refine((a) => {
    refineCalls++;
    return a.balance >= 0;
  });
  const Z3Refined = compile(AccountRefined);
  const ArkRefined = type(arkAccountShape).narrow((a: { balance: number }) => {
    refineCalls++;
    return a.balance >= 0;
  });

  const Z3Tuple = compile(TupleRow);
  const tupleRow = { id: 4, point: [4, 4], label: ["L4", "T4"] };

  const Containers = z.object({
    id: z.number().int(),
    lookup: z.map(z.string(), z.number()),
    tags: z.set(z.number().int()),
  });
  const Z3Containers = compile(Containers);
  const containerRow = { id: 1, lookup: new Map([["k1", 1]]), tags: new Set([1, 2]) };

  const positions: {
    id: string;
    what: string;
    input: unknown;
    valid: unknown;
    schema: z.ZodTypeAny;
    zc: Compiled<z.ZodTypeAny>;
    ark?: (i: unknown) => unknown;
    arkNA?: string;
  }[] = [
    {
      id: "S9 failure at the first key",
      what: "id = 1.5 (the first declared key)",
      input: variantOne(sample, { id: 1.5 }),
      valid: sample,
      schema: AccountStock,
      zc: Z3Account,
      ark: ArkAccount,
    },
    {
      id: "S9 failure at the last key",
      what: 'active = "yes" (the last declared key)',
      input: variantOne(sample, { active: "yes" }),
      valid: sample,
      schema: AccountStock,
      zc: Z3Account,
      ark: ArkAccount,
    },
    {
      id: "S9 deep nested failure",
      what: "address.zip = 12345 (nested object)",
      input: variantOne(sample, { address: { ...sample.address, zip: 12345 } }),
      valid: sample,
      schema: AccountStock,
      zc: Z3Account,
      ark: ArkAccount,
    },
    {
      id: "S9 three sibling errors",
      what: 'id = 1.5, email = "nope", active = "yes" (three issues collected)',
      input: variantOne(sample, { id: 1.5, email: "nope", active: "yes" }),
      valid: sample,
      schema: AccountStock,
      zc: Z3Account,
      ark: ArkAccount,
    },
    {
      id: "S9 invalid array element",
      what: "tags[1] = 7 (array element type)",
      input: variantOne(sample, { tags: ["a", 7] }),
      valid: sample,
      schema: AccountStock,
      zc: Z3Account,
      ark: ArkAccount,
    },
    {
      id: "S9 invalid tuple element",
      what: 'point = [4, "4"] (tuple slot type)',
      input: { ...tupleRow, point: [4, "4"] },
      valid: tupleRow,
      schema: TupleRow,
      zc: Z3Tuple,
      ark: ArkTupleRow,
    },
    {
      id: "S9 invalid Map member",
      what: 'lookup value = "x" (Map value type)',
      input: { ...containerRow, lookup: new Map([["k1", "x"]]) },
      valid: containerRow,
      schema: Containers,
      zc: Z3Containers,
      arkNA: "no equivalent native typed Map traversal",
    },
    {
      id: "S9 invalid Set member",
      what: "tags member = 1.5 (Set member check)",
      input: { ...containerRow, tags: new Set([1, 1.5]) },
      valid: containerRow,
      schema: Containers,
      zc: Z3Containers,
      arkNA: "no equivalent native typed Set traversal",
    },
    {
      id: "S9 refine failure",
      what: "balance = -1 against .refine(balance >= 0)",
      input: variantOne(sample, { balance: -1 }),
      valid: sample,
      schema: AccountRefined,
      zc: Z3Refined,
      ark: ArkRefined,
    },
  ];

  /* ─────────────────────────── (a) issue-semantics parity ─────────────────────────── */

  console.log(
    "\n═══ S9 issue-semantics parity: stock zod3 ZodError issues against zod-cow-v3 ZcError issues ═══",
  );
  const parityCases: {
    name: string;
    schema: z.ZodTypeAny;
    zc: Compiled<z.ZodTypeAny>;
    input: unknown;
  }[] = [
    ...positions.map((p) => ({ name: p.what, schema: p.schema, zc: p.zc, input: p.input })),
    {
      name: 'email = "user@example" (regex format)',
      schema: AccountStock,
      zc: Z3Account,
      input: variantOne(sample, { email: "user@example" }),
    },
    {
      name: "oversized tags (9) with a bad element (array length + element)",
      schema: AccountStock,
      zc: Z3Account,
      input: variantOne(sample, { tags: ["a", "b", "c", "d", "e", "f", "g", "h", 9] }),
    },
    {
      name: 'firstName = 65 characters and email = "nope" (string checks on two keys)',
      schema: AccountStock,
      zc: Z3Account,
      input: variantOne(sample, { firstName: "x".repeat(65), email: "nope" }),
    },
    {
      name: "one string failing two checks (min(3).email() on 'ab')",
      schema: z.object({ s: z.string().min(3).email() }),
      zc: compile(z.object({ s: z.string().min(3).email() })),
      input: { s: "ab" },
    },
    {
      name: "strict object with two undeclared keys",
      schema: z.object({ a: z.string() }).strict(),
      zc: compile(z.object({ a: z.string() }).strict()),
      input: { a: "x", b: 1, c: 2 },
    },
    {
      name: "invalid enum value",
      schema: AccountStock,
      zc: Z3Account,
      input: variantOne(sample, { role: "root" }),
    },
    {
      name: "not an object",
      schema: AccountStock,
      zc: Z3Account,
      input: 42,
    },
  ];
  let agree = 0;
  for (const c of parityCases) {
    const diff = issueParity(c.schema, c.zc, c.input);
    if (diff === undefined) {
      agree++;
      console.log(`    ✓ ${c.name}: same issues (code, path, message)`);
    } else {
      console.log(`    ~ ${c.name}: known divergence: ${diff}`);
    }
  }
  console.log(
    `  ${agree} of ${parityCases.length} failure fixtures give the same issue list; the divergences above are the zod3 line's own failure semantics and are compared, not hidden, before the timings below`,
  );

  /* ─────────────────────────── (b) datasets with invalid rows ─────────────────────────── */

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
    await gate(`S9 ${pct} invalid`, parseImpls(AccountStock, Z3Account, ArkAccount), [
      { name: "valid row", input: sample, accept: true },
      { name: "invalid row (malformed email)", input: rows[0], accept: false },
    ]);
    const stockLoop = () => {
      let ok = 0;
      for (let i = 0; i < N; i++)
        if (AccountStock.safeParse(rows[i]).success === (expected[i] === 1)) ok++;
      return ok === N ? ok : fail("stock verdict");
    };
    const zcLoop = () => {
      let ok = 0;
      for (let i = 0; i < N; i++)
        if (Z3Account.safeParse(rows[i]).success === (expected[i] === 1)) ok++;
      return ok === N ? ok : fail("zod-cow verdict");
    };
    const arkLoop = () => {
      let ok = 0;
      for (let i = 0; i < N; i++)
        if (!(ArkAccount(rows[i]) instanceof ArkErrors) === (expected[i] === 1)) ok++;
      return ok === N ? ok : fail("ArkType verdict");
    };
    const run = await runScenario(
      `S9 parse failures, ${pct} invalid rows`,
      `${N.toLocaleString()} per-row safeParse calls, ${invalid.toLocaleString()} rows with a malformed email; detailed errors built for every invalid row`,
      [
        { column: "stock", label: `stock zod3 safeParse per row (${pct} invalid)`, run: stockLoop },
        { column: "zc", label: `zod-cow-v3 safeParse per row (${pct} invalid)`, run: zcLoop },
        { column: "ark", label: `ArkType Type(row) per row (${pct} invalid)`, run: arkLoop },
      ],
    );
    printRatios(run);
    runs.push(run);
  }

  /* ─────────────────────────── (c) failure position ─────────────────────────── */

  for (const p of positions) {
    await gate(p.id, parseImpls(p.schema, p.zc, p.ark), [
      { name: "valid control", input: p.valid, accept: true },
      { name: p.what, input: p.input, accept: false },
    ]);
    if (p.schema === AccountRefined) {
      const count = (f: () => unknown) => {
        refineCalls = 0;
        f();
        return refineCalls;
      };
      console.log(
        `  S9 refine predicate executions per failed parse: stock ${count(() => AccountRefined.safeParse(p.input))} · zod-cow ${count(() => Z3Refined.safeParse(p.input))} · ArkType ${count(() => ArkRefined(p.input))}; per successful parse: stock ${count(() => AccountRefined.safeParse(sample))} · zod-cow ${count(() => Z3Refined.safeParse(sample))} · ArkType ${count(() => ArkRefined(sample))}`,
      );
    }
    const { schema, zc, ark, input } = p;
    const run = await runScenario(
      p.id,
      `${p.what}, detailed errors, ${K.toLocaleString()} parses per round`,
      [
        {
          column: "stock",
          label: "stock zod3 safeParse (ZodError)",
          run: () => {
            let rejected = 0;
            for (let i = 0; i < K; i++) if (!schema.safeParse(input).success) rejected++;
            return rejected === K ? rejected : fail("stock accepted");
          },
        },
        {
          column: "zc",
          label: "zod-cow-v3 safeParse (ZcError, own issues)",
          run: () => {
            let rejected = 0;
            for (let i = 0; i < K; i++) if (!zc.safeParse(input).success) rejected++;
            return rejected === K ? rejected : fail("zod-cow accepted");
          },
        },
        ark
          ? {
              column: "ark",
              label: "ArkType Type(data) (ArkErrors)",
              run: () => {
                let rejected = 0;
                for (let i = 0; i < K; i++) if (ark(input) instanceof ArkErrors) rejected++;
                return rejected === K ? rejected : fail("ArkType accepted");
              },
            }
          : { column: "ark", label: "ArkType", na: p.arkNA! },
      ],
      { iterations: K, group: "S9 failure position hot loops" },
    );
    printRatios(run);
    runs.push(run);
  }

  return runs;
}
