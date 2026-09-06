/**
 * Smoke: the tuple CoW skeleton + the async schema channel (Task 6).
 * Item-by-item assertions on alignment with stock zod4 semantics + CoW reference-sharing behavior.
 */
import assert from "node:assert/strict";
import { z } from "zod";
import { compile } from "../src/index.js";

let group = "";
function head(s: string): void {
  group = s;
  console.log(`\n── ${s} ──`);
}
function ok(msg: string): void {
  console.log(`  ✓ ${group}: ${msg}`);
}

/* ═══════════════ tuple ═══════════════ */

head("tuple at full length and clean → original reference");
{
  const S = z.tuple([z.string(), z.number(), z.boolean()]);
  const C = compile(S);
  assert.ok(!C.stock);
  const input = ["a", 1, true] as unknown[];
  const r = C.safeParse(input);
  assert.ok(r.success);
  assert.ok(
    (r.data as unknown[]) === input,
    "full length, every reference unchanged → original reference",
  );
  ok("out === input");
}

head("tuple element dirty (transform) → slice and write back");
{
  const S = z.tuple([z.string(), z.string().transform((s) => s.toUpperCase())]);
  const C = compile(S);
  const input = ["a", "b"] as unknown[];
  const r = C.safeParse(input);
  assert.ok(r.success);
  const out = r.data as unknown[];
  assert.deepEqual(out, ["a", "B"]);
  assert.ok(out !== input, "value changed → new array");
  assert.equal(out[0], input[0], "unchanged elements keep their reference");
  assert.deepEqual(input, ["a", "b"], "zero input distortion");
  ok("out !== input and unchanged elements are shared");
}

head(
  "tuple short input with trailing optionals → truncation (truncation target = input length → original reference)",
);
{
  const S = z.tuple([z.string(), z.optional(z.string()), z.optional(z.string())]);
  const C = compile(S);
  const input = ["a"] as unknown[];
  const stock = S.safeParse(input as never);
  assert.ok(stock.success);
  const r = C.safeParse(input);
  assert.ok(r.success);
  assert.deepEqual(r.data, stock.data, "output matches stock");
  assert.equal((r.data as unknown[]).length, 1);
  assert.ok(
    (r.data as unknown[]) === input,
    "truncated to the input length with references unchanged → original reference",
  );
  // Both trailing optionals present → full length, original reference
  const full = ["a", "b", "c"] as unknown[];
  const r2 = C.safeParse(full);
  assert.ok(r2.success && (r2.data as unknown[]) === full);
  // Mid truncation: ["a", undefined] → slot 2 absent, truncated to 2 (references unchanged → original reference)
  const mid = ["a", undefined] as unknown[];
  const stockMid = S.safeParse(mid as never);
  const r3 = C.safeParse(mid);
  assert.ok(r3.success && stockMid.success);
  assert.deepEqual(r3.data, stockMid.data);
  ok("three truncation states + agreement with stock");
}

head("tuple trailing default slot absent → filled in (a structural extension always copies)");
{
  const S = z.tuple([z.string(), z.string().default("D")]);
  const C = compile(S);
  const input = ["a"] as unknown[];
  const stock = S.safeParse(input as never);
  const r = C.safeParse(input);
  assert.ok(r.success && stock.success);
  assert.deepEqual(r.data, stock.data, "fill matches stock");
  assert.deepEqual(r.data, ["a", "D"]);
  assert.ok((r.data as unknown[]) !== input, "output longer than input → must copy");
  // At full length the default slot is present → references unchanged → original reference
  const full = ["a", "x"] as unknown[];
  const r2 = C.safeParse(full);
  assert.ok(r2.success && (r2.data as unknown[]) === full);
  ok("default fill copies / full length keeps the original reference");
}

head("tuple too long with no rest → rejected (falls back to stock too_big)");
{
  const S = z.tuple([z.string(), z.optional(z.string())]);
  const C = compile(S);
  const input = ["a", "b", "c"] as unknown[];
  const stock = S.safeParse(input as never);
  const r = C.safeParse(input);
  assert.equal(r.success, stock.success);
  assert.ok(!r.success, "too long is rejected");
  ok("too_big agrees");
}

head("tuple + rest → per-slot reference comparison");
{
  const S = z.tuple([z.string()], z.number());
  const C = compile(S);
  assert.ok(!C.stock);
  const input = ["a", 1, 2] as unknown[];
  const r = C.safeParse(input);
  assert.ok(
    r.success && (r.data as unknown[]) === input,
    "rest entirely clean → original reference",
  );
  // Transforming rest elements (the number → string key retry does not apply; use a rest schema transform)
  const S2 = z.tuple(
    [z.string()],
    z.string().transform((s) => s.length),
  );
  const C2 = compile(S2);
  const input2 = ["a", "bb", "ccc"] as unknown[];
  const stock2 = S2.safeParse(input2 as never);
  const r2 = C2.safeParse(input2);
  assert.ok(r2.success && stock2.success);
  assert.deepEqual(r2.data, stock2.data);
  assert.deepEqual(r2.data, ["a", 2, 3]);
  assert.ok((r2.data as unknown[]) !== input2, "rest element changed → copy");
  assert.equal((r2.data as unknown[])[0], input2[0]);
  // rest element fails
  const bad = ["a", "bb", 42] as unknown[];
  const rb = C2.safeParse(bad);
  const stockB = S2.safeParse(bad as never);
  assert.equal(rb.success, stockB.success);
  assert.ok(!rb.success);
  ok("three rest states agree");
}

head("tuple + refine (both paths of the container's own checks)");
{
  const S = z.tuple([z.string(), z.string()]).refine((t) => t[0] === t[1], { error: "mismatch" });
  const C = compile(S);
  assert.ok(!C.stock);
  const good = ["a", "a"] as unknown[];
  const r = C.safeParse(good);
  assert.ok(
    r.success && (r.data as unknown[]) === good,
    "clean + checks pass → original reference",
  );
  const bad = ["a", "b"] as unknown[];
  const rb = C.safeParse(bad);
  const stockB = S.safeParse(bad as never);
  assert.equal(rb.success, stockB.success, "checks failure agrees");
  assert.ok(!rb.success);
  // Element dirty + checks run on the rebuilt output
  const S2 = z
    .tuple([z.string(), z.string().transform((s) => `${s}!`)])
    .refine((t) => (t[1] as string).endsWith("!"), { error: "need bang" });
  const C2 = compile(S2);
  const r2 = C2.safeParse(["x", "y"] as unknown[]);
  assert.ok(r2.success);
  assert.deepEqual(r2.data, ["x", "y!"]);
  ok("both check paths agree");
}

head("nesting: an object inside a tuple (CoW sub-skeleton) + a tuple wrapped in optional");
{
  const S = z.tuple([z.object({ a: z.string(), b: z.number() }), z.string()]);
  const C = compile(S);
  const inner = { a: "x", b: 1 };
  const input = [inner, "s"] as unknown[];
  const r = C.safeParse(input);
  assert.ok(r.success);
  const out = r.data as unknown[];
  assert.ok(out === input, "entirely clean → original reference");
  assert.ok((out[0] as unknown) === inner, "inner value is shared");
  // Inner strip triggers
  const S2 = z.tuple([z.object({ a: z.string() }), z.string()]);
  const C2 = compile(S2);
  const dirty = [{ a: "x", extra: true }, "s"] as unknown[];
  const r2 = C2.safeParse(dirty);
  assert.ok(r2.success);
  assert.deepEqual(r2.data, [{ a: "x" }, "s"]);
  assert.ok((r2.data as unknown[]) !== dirty, "strip triggers a copy");
  // optional(tuple)
  const S3 = z.optional(z.tuple([z.string()]));
  const C3 = compile(S3);
  const r3 = C3.safeParse(["a"] as unknown);
  assert.ok(r3.success && Array.isArray(r3.data));
  const r4 = C3.safeParse(undefined);
  assert.ok(r4.success && r4.data === undefined);
  ok("nested strip / unwrapping agree");
}

head("tuple short input landing in the defaulted slot range (optinStart < L < optoutStart)");
{
  // z.tuple([z.string().default("D")]): optinStart=0, optoutStart=1
  const S = z.tuple([z.string().default("D")]);
  const C = compile(S);
  const stockEmpty = S.safeParse([] as never);
  const rEmpty = C.safeParse([] as unknown[]);
  assert.ok(rEmpty.success && stockEmpty.success);
  assert.deepEqual(rEmpty.data, stockEmpty.data, "empty input → default fill matches stock");
  assert.deepEqual(rEmpty.data, ["D"]);
  // Mixed: [optional, defaulted]: optinStart=0, optoutStart=2
  const S2 = z.tuple([z.string().optional(), z.string().default("D")]);
  const C2 = compile(S2);
  for (const inp of [[], ["a"], ["a", "b"]] as unknown[][]) {
    const stock = S2.safeParse(inp as never);
    const r = C2.safeParse(inp);
    assert.equal(r.success, stock.success, `L=${inp.length} success/failure agrees`);
    if (r.success && stock.success)
      assert.deepEqual(r.data, stock.data, `L=${inp.length} output agrees`);
  }
  ok("four states in the defaulted slot range agree");
}

head(
  "tuple combined with union/discriminated + a stock-alignment spot check outside the differential",
);
{
  const S = z.object({
    pair: z.tuple([z.string(), z.number()]),
    list: z.array(z.tuple([z.string(), z.optional(z.string())])),
  });
  const C = compile(S);
  const input = { pair: ["a", 1], list: [["x"], ["y", "z"]] } as never;
  const r = C.safeParse(input);
  assert.ok(r.success);
  assert.ok((r.data as never) === input, "combination entirely clean → original reference");
  ok("a tuple nested in an object shares references");
}

/* ═══════════════ async ═══════════════ */

head("async refine on an object key (the other keys stay CoW)");
{
  const S = z.object({
    keep: z.object({ n: z.number() }), // pure container → CoW sub-skeleton
    check: z.string().refine(async (s) => s.length > 2),
  });
  const C = compile(S);
  assert.ok(!C.stock, "no more whole-tree degradation");
  assert.ok(C.async, "async skeleton");
  // The sync API throws $ZodAsyncError
  let threw = false;
  try {
    C.parse({ keep: { n: 1 }, check: "abc" });
  } catch (e: any) {
    threw = e.constructor.name === "$ZodAsyncError";
  }
  assert.ok(threw);
  const input = { keep: { n: 1 }, check: "abc" };
  const r = await C.safeParseAsync(input);
  assert.ok(r.success);
  assert.ok((r.data as never) === input, "async skeleton clean → original reference");
  assert.ok((r.data as { keep: object }).keep === input.keep, "inner value is shared");
  const bad = await C.safeParseAsync({ keep: { n: 1 }, check: "x" });
  const stockBad = await S.safeParseAsync({ keep: { n: 1 }, check: "x" } as never);
  assert.equal(bad.success, stockBad.success);
  assert.ok(!bad.success, "async refine failure agrees");
  ok("mixed async skeleton + CoW");
}

head("async transform → dirtiness decided by reference comparison");
{
  const S = z.object({
    name: z.string().transform(async (s) => s.toUpperCase()),
    tag: z.string(),
  });
  const C = compile(S);
  assert.ok(C.async);
  const input = { name: "a", tag: "t" };
  const r = await C.safeParseAsync(input);
  assert.ok(r.success);
  assert.deepEqual(r.data, { name: "A", tag: "t" });
  assert.ok((r.data as never) !== input, "async transform changed the value → copy");
  assert.equal((r.data as { tag: string }).tag, input.tag, "unchanged keys are shared");
  // async transform inside an array
  const S2 = z.array(z.string().transform(async (s) => `${s}!`));
  const C2 = compile(S2);
  const in2 = ["a", "b"];
  const r2 = await C2.safeParseAsync(in2);
  assert.ok(r2.success);
  assert.deepEqual(r2.data, ["a!", "b!"]);
  assert.ok(r2.data !== in2);
  ok("async value dirty → conditional copy");
}

head("lazy(async) detected statically → async island");
{
  const S = z.object({ v: z.lazy(() => z.string().transform(async (s) => `${s}?`)) });
  const C = compile(S);
  assert.ok(C.async, "lazy(async) is seen through statically");
  const r = await C.safeParseAsync({ v: "x" });
  assert.ok(r.success);
  assert.deepEqual(r.data, { v: "x?" });
  assert.ok((r.data as never) !== undefined, "output is correct");
  ok("lazy(async) no longer fails silently");
}

head("union with an async branch → async island");
{
  const S = z.union([z.string().refine(async (s) => s.length > 2), z.number()]);
  const C = compile(S);
  assert.ok(C.async);
  const r1 = await C.safeParseAsync("hello");
  assert.ok(r1.success && r1.data === "hello");
  const r2 = await C.safeParseAsync(42);
  assert.ok(r2.success && r2.data === 42);
  const r3 = await C.safeParseAsync("x");
  const stock3 = await S.safeParseAsync("x" as never);
  assert.equal(r3.success, stock3.success, "both branches fail, in agreement with stock");
  ok("three states for a union async branch");
}

head("async refine attached to array/map/set/record/tuple (async container checks)");
{
  const S = z.array(z.string()).refine(async (a) => a.length > 1);
  const C = compile(S);
  assert.ok(C.async, "async container checks → async skeleton");
  const input1 = ["a", "b"];
  const r1 = await C.safeParseAsync(input1);
  assert.ok(r1.success, "async container refine passes");
  assert.strictEqual(r1.data, input1, "async container refine keeps the input by reference (#13)");
  assert.ok(!C.code!.includes("_zod"), "the container keeps its skeleton, no runtime island");
  const r2 = await C.safeParseAsync(["a"]);
  assert.ok(!r2.success, "async min predicate fails");
  // async map value
  const S3 = z.map(
    z.string(),
    z.number().transform(async (n) => n * 2),
  );
  const C3 = compile(S3);
  const m = new Map([["k", 21]]);
  const r3 = await C3.safeParseAsync(m);
  assert.ok(r3.success);
  assert.deepEqual([...(r3.data as Map<string, number>)], [["k", 42]]);
  assert.ok((r3.data as Map<unknown, unknown>) !== m, "value changed → copy");
  // async set member
  const S4 = z.set(z.string().transform(async (s) => s.toUpperCase()));
  const C4 = compile(S4);
  const st = new Set(["a"]);
  const r4 = await C4.safeParseAsync(st);
  assert.ok(r4.success);
  assert.deepEqual([...(r4.data as Set<string>)], ["A"]);
  // async record value
  const S5 = z.record(
    z.string(),
    z.number().transform(async (n) => n + 1),
  );
  const C5 = compile(S5);
  const rec = { a: 1 };
  const r5 = await C5.safeParseAsync(rec);
  assert.ok(r5.success);
  assert.deepEqual(r5.data, { a: 2 });
  // async tuple slot
  const S6 = z.tuple([z.string(), z.string().transform(async (s) => `${s}!`)]);
  const C6 = compile(S6);
  const r6 = await C6.safeParseAsync(["a", "b"]);
  assert.ok(r6.success);
  assert.deepEqual(r6.data, ["a", "b!"]);
  assert.ok((r6.data as unknown[]) !== undefined && (r6.data as unknown[])[0] === "a");
  ok("all five containers + tuple async channels");
}

head("async container-level refine keeps the CoW path on every container (#13)");
{
  // Before #13 `checksAreCowSafe` rejected an async predicate, so a container carrying one became a
  // runtime island and always came back as a copy; a sync predicate on the same container shared.
  const nonEmpty = async (v: { size?: number; length?: number } | object) =>
    (v as { size?: number }).size !== 0 && (v as { length?: number }).length !== 0;
  const cases: { name: string; schema: z.ZodType; input: unknown }[] = [
    { name: "object", schema: z.object({ a: z.string() }).refine(nonEmpty), input: { a: "x" } },
    {
      name: "array",
      schema: z.array(z.string()).min(1).refine(nonEmpty),
      input: ["a", "b"],
    },
    {
      name: "tuple",
      schema: z.tuple([z.string(), z.number()]).refine(nonEmpty),
      input: ["a", 1],
    },
    {
      name: "record",
      schema: z.record(z.string(), z.number()).refine(nonEmpty),
      input: { k: 1 },
    },
    {
      name: "enum-keyed record",
      schema: z.record(z.enum(["k"]), z.number()).refine(nonEmpty),
      input: { k: 1 },
    },
    {
      name: "map",
      schema: z.map(z.string(), z.number()).max(5).refine(nonEmpty),
      input: new Map([["k", 1]]),
    },
    { name: "set", schema: z.set(z.string()).refine(nonEmpty), input: new Set(["a"]) },
    {
      name: "optional(object) wrapper",
      schema: z
        .object({ a: z.string() })
        .optional()
        .refine(async (v) => v === undefined || v.a !== "no"),
      input: { a: "x" },
    },
    {
      name: "union with a container option",
      schema: z.union([z.object({ a: z.string() }), z.string()]).refine(nonEmpty),
      input: { a: "x" },
    },
  ];
  for (const c of cases) {
    const C = compile(c.schema);
    assert.ok(!C.stock, `${c.name}: no whole-tree degradation`);
    assert.ok(C.async, `${c.name}: async skeleton`);
    assert.ok(!C.code!.includes("_zod"), `${c.name}: no runtime island in the generated code`);
    const r = await C.safeParseAsync(c.input);
    assert.ok(r.success, `${c.name}: passes`);
    assert.strictEqual(r.data, c.input, `${c.name}: clean input shared by reference`);
    const stock = await c.schema.safeParseAsync(c.input);
    assert.deepEqual(r.data, stock.data, `${c.name}: same value as stock`);
  }
  ok("object / array / tuple / record / map / set / wrapper / union share the clean input");

  // The dirty path: the predicate sees the copy, as stock hands it the rebuilt output
  const seen: unknown[] = [];
  const D = z.object({ a: z.string(), n: z.number().default(7) }).refine(async (o) => {
    seen.push(o);
    return o.n === 7;
  });
  const CD = compile(D);
  const dIn = { a: "x" };
  const rd = await CD.safeParseAsync(dIn);
  assert.ok(rd.success);
  assert.notStrictEqual(rd.data, dIn, "defaulted key → copy");
  assert.deepEqual(rd.data, { a: "x", n: 7 });
  assert.strictEqual(seen[0], rd.data, "the predicate ran on the output copy");
  assert.deepEqual(dIn, { a: "x" }, "input untouched");
  ok("dirty path: predicate runs on the copy");

  // Failure parity with stock, the issue structure coming from stock's safeParseAsync
  const F = z.array(z.string()).refine(async (a) => a.length > 1, { error: "too short" });
  const CF = compile(F);
  const rf = await CF.safeParseAsync(["a"]);
  const sf = await F.safeParseAsync(["a"]);
  assert.ok(!rf.success && !sf.success);
  assert.deepEqual(rf.error.issues, sf.error.issues, "issues from stock");
  ok("failure parity");

  // A sync parse of an async skeleton throws like stock
  assert.throws(
    () => CF.parse(["a", "b"]),
    (e: any) => e.constructor.name === "$ZodAsyncError",
  );
  ok("sync API throws $ZodAsyncError");
}

head("async container checks follow stock's schedule (every check started before the first await)");
{
  // stock's runChecks calls every check synchronously in order and only chains the awaits: both
  // predicates start before either settles, and a sync predicate declared after an async one runs
  // before the async one settles
  const log: string[] = [];
  const S = z
    .array(z.string())
    .refine(async (a) => {
      log.push("A start");
      await new Promise((r) => setTimeout(r, 5));
      log.push("A end");
      return a.length > 0;
    })
    .refine((a) => {
      log.push("B sync");
      return a.length > 0;
    })
    .refine(async (a) => {
      log.push("C start");
      log.push("C end");
      return a.length > 0;
    });
  const input = ["x"];
  await S.safeParseAsync(input);
  const stockLog = [...log];
  log.length = 0;
  const C = compile(S);
  const r = await C.safeParseAsync(input);
  assert.ok(r.success);
  assert.strictEqual(r.data, input);
  assert.deepEqual(log, stockLog, "predicate start / settle order as stock");
  assert.deepEqual(log, ["A start", "B sync", "C start", "C end", "A end"]);
  ok("A, B, C all start before A settles, in declaration order");

  // A length check failing after a predicate started: the started promise is settled before INVALID
  // (no unhandled rejection), and a rejecting predicate surfaces as the thrown error like stock
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    const R = z
      .array(z.string())
      .refine(async () => false)
      .refine(async () => {
        await null;
        throw new Error("boom");
      });
    const CR = compile(R);
    await assert.rejects(() => CR.safeParseAsync(["a"]), /boom/);
    await assert.rejects(() => R.safeParseAsync(["a"] as never), /boom/);
    const L = z
      .array(z.string())
      .refine(async () => {
        await null;
        throw new Error("late");
      })
      .min(3);
    const CL = compile(L);
    await assert.rejects(() => CL.safeParseAsync(["a"]), /late/);
    await assert.rejects(() => L.safeParseAsync(["a"] as never), /late/);
    await new Promise((r) => setTimeout(r, 10));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  assert.deepEqual(unhandled, [], "no promise left unattached");
  ok("rejections surface like stock, nothing dangles");
}

head("a failing length check between two predicates: the stock fallback re-runs the schema");
{
  // The schedule above is the success path's. On a failure the subroutine answers INVALID like every
  // other failure of this line: it does not reach B after the failing .min(), and the fallback to
  // stock safeParseAsync runs A and B from the start, so A runs twice (the README's known limitation;
  // stock's own z.compile() fast path bails at the same check and logs the same). Before #13 the
  // container was a runtime island whose failure fell back the same way (A, B, A, B).
  const log: string[] = [];
  const S = z
    .array(z.string())
    .refine(async () => {
      log.push("A");
      return true;
    })
    .min(3)
    .refine(async () => {
      log.push("B");
      return true;
    });
  const C = compile(S);
  assert.ok(!/_zod/.test(C.code ?? ""), "the container keeps its skeleton");
  const stock = await S.safeParseAsync(["x"]);
  assert.deepEqual(log, ["A", "B"], "stock's runChecks reaches B after the failing .min()");
  log.length = 0;
  const r = await C.safeParseAsync(["x"]);
  assert.deepEqual(
    log,
    ["A", "A", "B"],
    "A started by the subroutine, then A and B by the fallback",
  );
  assert.ok(!r.success && !stock.success);
  assert.deepEqual(r.error.issues, stock.error.issues, "issues from stock");
  ok("the subroutine bails at .min(), the fallback runs every check once more");
}

head("async failure path falls back to stock safeParseAsync (official issues structure)");
{
  const S = z.object({
    a: z.string().refine(async (s) => s.length > 5),
    b: z.number(),
  });
  const C = compile(S);
  const input = { a: "x", b: 1 };
  const r = await C.safeParseAsync(input);
  const stock = await S.safeParseAsync(input as never);
  assert.equal(r.success, stock.success);
  if (!r.success && !stock.success) {
    assert.equal(r.error.issues.length, stock.error.issues.length);
    assert.deepEqual(r.error.issues[0]!.path, stock.error.issues[0]!.path);
  }
  ok("official issues structure");
}

head("top-level async pipe (z.string().transform(async))");
{
  const S = z.string().transform(async (s) => s.trim());
  const C = compile(S);
  assert.ok(C.async && !C.stock);
  const r = await C.parseAsync("  hi  ");
  assert.equal(r, "hi");
  const rb = await C.safeParseAsync(42 as never);
  const stockB = await S.safeParseAsync(42 as never);
  assert.equal(rb.success, stockB.success);
  ok("top-level async pipe");
}

head("mixed tree: a large pure container + a deep async leaf (CoW and async coexist)");
{
  const S = z.object({
    users: z.array(z.object({ id: z.number(), name: z.string() })),
    meta: z.object({
      token: z.string().transform(async (t) => t.toLowerCase()),
      flags: z.record(z.string(), z.boolean()),
    }),
  });
  const C = compile(S);
  assert.ok(C.async && !C.stock);
  const input = {
    users: [
      { id: 1, name: "a" },
      { id: 2, name: "b" },
    ],
    meta: { token: "ABC", flags: { f1: true } },
  };
  const r = await C.safeParseAsync(input);
  assert.ok(r.success);
  const out = r.data as typeof input;
  assert.ok(out !== input, "the token async transform changed the value → dirty copy");
  assert.equal(out.meta.token, "abc");
  assert.ok(out.users === input.users, "unchanged subtree shares its reference");
  assert.ok(out.meta.flags === input.meta.flags, "pure record subtree is shared");
  assert.ok(out.users[0] === input.users[0], "element-level sharing");
  ok("CoW subtree sharing + async key dirtiness detection");
}

console.log("\nAll tuple + async smoke assertions passed ✓");
