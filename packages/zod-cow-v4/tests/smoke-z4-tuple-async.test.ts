/**
 * Smoke: the tuple CoW skeleton + the async schema channel (Task 6).
 * Item-by-item assertions on alignment with stock zod4 semantics + CoW reference-sharing behavior.
 */
import assert from "node:assert/strict";
import { z } from "zod";
import { $ZodAsyncError } from "zod/v4/core";
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

head("an aborting sync failure before any promise: the later checks are not started");
{
  // stock's runChecks tracks `isAborted` synchronously until a check returns a Promise: an
  // `abort: true` predicate that fails synchronously while no promise has started skips every later
  // check without a `when` (a length / size check carries one and still runs, side-effect free). The
  // subroutine returns INVALID at that point instead of starting the later predicates, so a predicate
  // stock never calls is never called here either; the fallback then runs stock, which skips it too.
  const log: string[] = [];
  const S = z
    .array(z.string())
    .refine(
      () => {
        log.push("A");
        return false;
      },
      { abort: true },
    )
    .refine(async () => {
      log.push("B");
      throw new Error("should-not-run");
    });
  const C = compile(S);
  assert.ok(!/_zod/.test(C.code ?? ""), "the container keeps its skeleton");
  const stock = await S.safeParseAsync(["x"]);
  assert.ok(!stock.success);
  assert.deepEqual(log, ["A"], "stock skips B after the aborting failure");
  log.length = 0;
  const r = await C.safeParseAsync(["x"]);
  assert.ok(!r.success, "a failure result, not a rejection");
  assert.deepEqual(log, ["A", "A"], "A by the subroutine, A by the fallback, B never");
  assert.deepEqual(r.error.issues, stock.error.issues, "issues from stock");
  ok("abort: true + sync false → the async predicate is not started, safeParseAsync resolves");

  // the same with a sync predicate and an async one after the aborting failure: neither is called
  log.length = 0;
  const S2 = z
    .array(z.string())
    .refine(
      () => {
        log.push("A");
        return false;
      },
      { abort: true },
    )
    .refine(() => {
      log.push("B");
      return true;
    })
    .refine(async () => {
      log.push("C");
      return true;
    });
  const C2 = compile(S2);
  await S2.safeParseAsync(["x"]);
  assert.deepEqual(log, ["A"]);
  log.length = 0;
  await C2.safeParseAsync(["x"]);
  assert.deepEqual(log, ["A", "A"], "B and C are skipped like stock");
  ok("every later check is skipped, sync or async");

  // an optional wrapper above a container runs the same subroutine (#56)
  log.length = 0;
  const W = z
    .object({ a: z.string() })
    .optional()
    .refine(
      () => {
        log.push("A");
        return false;
      },
      { abort: true },
    )
    .refine(async () => {
      log.push("B");
      return true;
    });
  const CW = compile(W);
  assert.ok(!/_zod/.test(CW.code ?? ""), "the wrapper keeps its nested skeleton");
  await W.safeParseAsync({ a: "x" });
  assert.deepEqual(log, ["A"]);
  log.length = 0;
  await CW.safeParseAsync({ a: "x" });
  assert.deepEqual(log, ["A", "A"], "the wrapper's subroutine skips B too");
  ok("optional(object): the aborting failure skips the async predicate");

  // an aborting predicate that passes does not abort: B runs and the clean input is shared
  log.length = 0;
  const P = z
    .array(z.string())
    .refine(
      () => {
        log.push("A");
        return true;
      },
      { abort: true },
    )
    .refine(async () => {
      log.push("B");
      return true;
    });
  const CP = compile(P);
  const input = ["x"];
  const rp = await CP.safeParseAsync(input);
  assert.ok(rp.success);
  assert.strictEqual(rp.data, input);
  assert.deepEqual(log, ["A", "B"]);
  ok("abort: true on a passing predicate changes nothing");

  // once a check has returned a Promise the abort state is updated inside stock's chain, after the
  // loop: an aborting sync failure declared after an async predicate skips nothing, and neither does
  // one declared after a plain function that returned a Promise (decided at runtime, not from the
  // predicate's declaration), so the later predicate is started as stock starts it
  for (const [label, first] of [
    ["an async function", async () => true],
    ["a plain function returning a Promise", () => Promise.resolve(true)],
  ] as const) {
    log.length = 0;
    const D = z
      .array(z.string())
      .refine(() => {
        log.push("A");
        return first();
      })
      .refine(
        () => {
          log.push("B");
          return false;
        },
        { abort: true },
      )
      .refine(async () => {
        log.push("C");
        return true;
      });
    const CD = compile(D);
    const sd = await D.safeParseAsync(["x"]);
    assert.ok(!sd.success);
    assert.deepEqual(log, ["A", "B", "C"], `${label}: stock still starts C`);
    log.length = 0;
    const rd = await CD.safeParseAsync(["x"]);
    assert.ok(!rd.success);
    assert.deepEqual(
      log,
      ["A", "B", "C", "A", "B", "C"],
      `${label}: the subroutine starts C like stock, then the fallback runs the three again`,
    );
    assert.deepEqual(rd.error.issues, sd.error.issues);
  }
  ok("after a started promise an aborting sync failure defers like stock");
}

head(
  "async array / tuple copy paths use the reads captured before the await, not the live input (#77)",
);
{
  // A child may mutate the input before its promise settles (a violation of the CoW premise, but
  // stock is unaffected by it: it reads every element once before any promise settles). The copy
  // path must then carry the captured reads like stock; the clean path still returns the input as
  // it then is, since the output may alias the input.
  type Mut = (input: unknown[]) => void;
  /** An element whose first call mutates the parent through `holder` after an await and returns its value unchanged; every later call appends "!" */
  const mutating = (holder: { input: unknown[] }, mutate: Mut, calls = { n: 0 }) =>
    z.string().transform(async (v) => {
      if (calls.n++ === 0) {
        await Promise.resolve();
        mutate(holder.input);
        return v;
      }
      return `${v}!`;
    });
  /** Parses a fresh input on both sides and compares with stock, or with `expected` where stock's own answer is the
   *  quirk the README declines to match (an async rest element: stock's runtime writes every rest result to the last
   *  index, so its output is sparse and loses elements, while the skeleton outputs the dense array) */
  const run = async (
    build: (holder: { input: unknown[] }, calls: { n: number }) => z.ZodType,
    make: () => unknown[],
    label: string,
    expected?: unknown[],
  ) => {
    const holder = { input: [] as unknown[] };
    const calls = { n: 0 };
    const S = build(holder, calls);
    const C = compile(S);
    assert.ok(!/_zod/.test(C.code ?? ""), `${label}: the container keeps its skeleton`);
    calls.n = 0;
    holder.input = make();
    const stock = expected ?? (await S.parseAsync(holder.input));
    calls.n = 0;
    holder.input = make();
    const cow = await C.parseAsync(holder.input);
    assert.deepEqual(cow, stock, label);
    assert.equal((cow as unknown[]).length, (stock as unknown[]).length, `${label}: length`);
    for (let i = 0; i < (stock as unknown[]).length; i++) {
      assert.equal(
        Object.hasOwn(cow as object, i),
        Object.hasOwn(stock as object, i),
        `${label}: slot ${i} ownership`,
      );
    }
    ok(label);
  };

  // array: the clean element 0 is overwritten while element 1 is dirty → the prefix rebuild must carry "a"
  await run(
    (h, c) =>
      z.array(
        mutating(
          h,
          (a) => {
            a[0] = "MUT";
          },
          c,
        ),
      ),
    () => ["a", "b"],
    "array: prefix rebuild carries the captured read",
  );
  // array: the input grows before settlement → stock's output keeps the length it read before the await
  await run(
    (h, c) =>
      z.array(
        mutating(
          h,
          (a) => {
            a.push("c");
          },
          c,
        ),
      ),
    () => ["a", "b"],
    "array: a pushed element after the await is not in the output",
  );
  // array: the input shrinks before settlement → every element read before the await is still written
  await run(
    (h, c) =>
      z.array(
        mutating(
          h,
          (a) => {
            a.length = 1;
          },
          c,
        ),
      ),
    () => ["a", "b"],
    "array: a truncation after the await loses nothing",
  );
  // array: a hole read before the await is a hole even when the child fills it before settling
  {
    const holder = { input: [] as unknown[] };
    let calls = 0;
    const S = z.array(
      z
        .string()
        .optional()
        .transform(async (v) => {
          if (calls++ === 0) {
            await Promise.resolve();
            holder.input[0] = "filled";
          }
          return v;
        }),
    );
    const C = compile(S);
    assert.ok(!/_zod/.test(C.code ?? ""));
    const make = () => {
      const a: unknown[] = [];
      a[1] = "b";
      return a;
    };
    calls = 0;
    holder.input = make();
    const stock = await S.parseAsync(holder.input);
    calls = 0;
    holder.input = make();
    const cow = await C.parseAsync(holder.input);
    assert.deepEqual(cow, stock);
    assert.ok(
      Object.hasOwn(cow as object, 0) && (cow as unknown[])[0] === undefined,
      "the hole is an own undefined slot like stock",
    );
    ok("array: a hole filled after the await stays a hole");
  }

  // tuple, fixed slots: same prefix rebuild
  await run(
    (h, c) => {
      const e = mutating(
        h,
        (a) => {
          a[0] = "MUT";
        },
        c,
      );
      return z.tuple([e, e]);
    },
    () => ["a", "b"],
    "tuple: prefix rebuild carries the captured slot read",
  );
  // tuple with an async rest: the rest element mutates a fixed slot and the earlier rest slot
  await run(
    (h, c) =>
      z.tuple(
        [z.string()],
        mutating(
          h,
          (a) => {
            a[0] = "MUT0";
            a[1] = "MUT1";
          },
          c,
        ),
      ),
    () => ["h", "a", "b"],
    "tuple: the rest prefix and the fixed slots come from the captured reads",
    ["h", "a", "b!"],
  );
  // tuple with an async rest: the input grows before settlement → only the sliced rest elements are in the output
  await run(
    (h, c) =>
      z.tuple(
        [z.string()],
        mutating(
          h,
          (a) => {
            a.push("c");
          },
          c,
        ),
      ),
    () => ["h", "a", "b"],
    "tuple: a pushed rest element after the await is not in the output",
    ["h", "a", "b!"],
  );
  // tuple: a hole in a fixed slot filled after the await stays a hole
  {
    const holder = { input: [] as unknown[] };
    let calls = 0;
    const S = z.tuple([
      z
        .string()
        .optional()
        .transform(async (v) => {
          if (calls++ === 0) {
            await Promise.resolve();
            holder.input[0] = "filled";
          }
          return v;
        }),
      z.string(),
    ]);
    const C = compile(S);
    assert.ok(!/_zod/.test(C.code ?? ""));
    const make = () => {
      const a: unknown[] = [];
      a[1] = "b";
      return a;
    };
    calls = 0;
    holder.input = make();
    const stock = await S.parseAsync(holder.input);
    calls = 0;
    holder.input = make();
    const cow = await C.parseAsync(holder.input);
    assert.deepEqual(cow, stock);
    assert.ok(
      Object.hasOwn(cow as object, 0) && (cow as unknown[])[0] === undefined,
      "the hole is an own undefined slot like stock",
    );
    ok("tuple: a hole filled after the await stays a hole");
  }

  // tuple rest under the async layout: stock takes `input.slice(items.length)` after it started the fixed slots
  // and before it runs any rest element, so a sync rest callback that mutates a later rest slot is not observed
  // by stock (second review of #76); a fixed slot's callback that mutates a rest slot before the slice is.
  /** A sync rest element whose first call mutates the parent through `holder` and returns its value unchanged; every later call appends "!" */
  const mutatingSync = (holder: { input: unknown[] }, mutate: Mut, calls: { n: number }) =>
    z.string().transform((v) => {
      if (calls.n++ === 0) {
        mutate(holder.input);
        return v;
      }
      return `${v}!`;
    });
  const asyncId = z.string().transform(async (v) => {
    await Promise.resolve();
    return v;
  });
  await run(
    (h, c) =>
      z.tuple(
        [asyncId],
        mutatingSync(
          h,
          (a) => {
            a[2] = "MUT";
          },
          c,
        ),
      ),
    () => ["h", "a", "b"],
    "tuple: a sync rest element that overwrites a later rest slot is read from the slice, like stock",
  );
  await run(
    (h) =>
      z.tuple(
        [
          z.string().transform(async (v) => {
            h.input[1] = "MUT";
            await Promise.resolve();
            return v;
          }),
        ],
        z.string().transform((v) => `${v}!`),
      ),
    () => ["h", "a", "b"],
    "tuple: a fixed slot that overwrites a rest slot before the slice is observed, like stock",
  );
  await run(
    (h, c) =>
      z.tuple(
        [asyncId],
        z
          .string()
          .optional()
          .transform((v) => {
            if (c.n++ === 0) h.input[2] = "filled";
            return v;
          }),
      ),
    () => {
      const a: unknown[] = ["h", "a"];
      a.length = 3;
      return a;
    },
    "tuple: a rest hole filled by an earlier rest element stays a hole, like stock",
  );
}

head("the sync tuple layout slices the rest before running any rest element, like stock (#78)");
{
  // Stock's `$ZodTuple` runtime takes `input.slice(items.length)` after it ran every fixed slot and before it runs
  // any rest element, so a sync rest callback that mutates a later rest slot is not observed by stock, while a
  // fixed slot's callback that mutates a rest slot before the slice is. The sync layout read each rest element
  // right before running it until #78; it now takes the same slice. (The mutation violates the CoW premise, but
  // stock is unaffected by it.)
  type Mut = (input: unknown[]) => void;
  const holder = { input: [] as unknown[] };
  const calls = { n: 0 };
  /** A sync rest element whose first call mutates the parent through `holder` and returns its value unchanged; every later call appends "!" */
  const mutatingSync = (mutate: Mut) =>
    z.string().transform((v) => {
      if (calls.n++ === 0) {
        mutate(holder.input);
        return v;
      }
      return `${v}!`;
    });
  /** Parses a fresh input on both sides with the sync API and compares the outputs, slot ownership included */
  const run = (S: z.ZodType, make: () => unknown[], label: string) => {
    const C = compile(S);
    assert.ok(!C.async && !C.stock, `${label}: sync skeleton`);
    assert.ok(!/_zod/.test(C.code ?? ""), `${label}: the container keeps its skeleton`);
    calls.n = 0;
    holder.input = make();
    const stock = S.parse(holder.input) as unknown[];
    calls.n = 0;
    holder.input = make();
    const cow = C.parse(holder.input) as unknown[];
    assert.deepEqual(cow, stock, label);
    assert.equal(cow.length, stock.length, `${label}: length`);
    for (let i = 0; i < stock.length; i++) {
      assert.equal(Object.hasOwn(cow, i), Object.hasOwn(stock, i), `${label}: slot ${i} ownership`);
    }
    ok(label);
  };

  /** The async twin of a rest tuple (#94): its first fixed slot carries an async refine, so the skeleton takes the
   *  async layout, whose rest source and presence decision are the sync layout's; the rest stays sync, since stock's
   *  own async rest writes every result to the last index (the quirk the #77 group pins). Stock's answer is the same
   *  on both layouts, through `parseAsync` */
  const asyncTwin = (S: z.ZodType): z.ZodType => {
    const def = S._zod.def as unknown as { items: z.ZodType[]; rest?: z.ZodType };
    const [first, ...others] = def.items;
    return z.tuple([first!.refine(async () => true), ...others], def.rest as never);
  };
  /** The async twin's compiled product: the async layout, never stock, the container's own skeleton */
  const compileTwin = (S: z.ZodType, label: string) => {
    const C = compile(asyncTwin(S));
    assert.ok(C.async && !C.stock && !/_zod/.test(C.code ?? ""), `${label}: the async layout`);
    return C;
  };

  // The reproduction of #78: the first rest element overwrites the second rest slot
  run(
    z.tuple(
      [z.string()],
      mutatingSync((a) => {
        a[2] = "MUT";
      }),
    ),
    () => ["h", "a", "b"],
    "a rest element that overwrites a later rest slot is not observed, like stock",
  );
  // A rest element that fills a later rest hole: stock's slice kept the hole, so the output has an own undefined there
  run(
    z.tuple(
      [z.string()],
      z
        .string()
        .optional()
        .transform((v) => {
          if (calls.n++ === 0) holder.input[2] = "filled";
          return v;
        }),
    ),
    () => {
      const a: unknown[] = ["h", "a"];
      a.length = 3;
      return a;
    },
    "a rest hole filled by an earlier rest element stays a hole, like stock",
  );
  // The order pin: a fixed slot's callback runs before the slice, so its write to a rest slot is observed by both sides
  run(
    z.tuple(
      [
        z.string().transform((v) => {
          holder.input[1] = "MUT";
          return v;
        }),
      ],
      z.string().transform((v) => `${v}!`),
    ),
    () => ["h", "a", "b"],
    "a fixed slot that overwrites a rest slot before the slice is observed, like stock",
  );
  // A rest element that pushes: stock's slice bounds the rest loop, so the pushed element is neither validated nor output
  run(
    z.tuple(
      [z.string()],
      mutatingSync((a) => {
        a.push(42);
      }),
    ),
    () => ["h", "a", "b"],
    "an element pushed by a rest element is outside the slice, like stock",
  );
  // A validator-shaped rest (a pure leaf with a `.refine` predicate) runs on the sliced values too: the predicate
  // sees the value stock's slice holds, not the one an earlier rest element wrote. The clean output is the input
  // by reference, as it then is (the output may alias the input), so only the verdict is compared
  {
    const S = z.tuple(
      [z.string()],
      z.string().refine((v) => {
        if (calls.n++ === 0) holder.input[2] = "";
        return v.length > 0;
      }),
    );
    const C = compile(S);
    assert.ok(!C.async && !C.stock && !/_zod/.test(C.code ?? ""));
    calls.n = 0;
    holder.input = ["h", "a", "b"];
    assert.ok(S.safeParse(holder.input).success, "stock validates the sliced value");
    calls.n = 0;
    holder.input = ["h", "a", "b"];
    const r = C.safeParse(holder.input);
    assert.ok(r.success, "the skeleton validates the sliced value too");
    assert.equal(r.data, holder.input, "the clean output is still the input by reference");
    ok("a refine predicate on the rest sees the sliced value, like stock");
  }
  // A short input under an optional tail: the copy is empty (stock's slice is), never a `new Array(negative)`
  {
    const S = z.tuple([z.string(), z.string().optional()], z.number());
    const C = compile(S);
    assert.ok(!C.async && !C.stock && !/_zod/.test(C.code ?? ""));
    const short = ["a"];
    assert.deepEqual(S.parse(short), ["a"]);
    assert.equal(C.parse(short), short, "a short input with an empty rest is clean");
    const full = ["a", "b", 1, 2];
    assert.equal(C.parse(full), full);
    assert.deepEqual(C.safeParse(["a", "b", "x"]).success, false);
    ok("a short input under an optional tail has an empty rest copy, like stock's slice");
  }
  // A rest hole over an inherited undefined is an own slot in stock's output (finding 5 of the #70 review for a rest
  // slot): the copy reads the inherited value through `in`-then-read as slice's `HasProperty` then `Get` does, and the
  // rest loop judges the `undefined` dirty without asking whether it is own (#95), so it is materialized; `slice`
  // (#86) made it own on the copy and the clean path returned the input with the hole
  {
    const S = z.tuple([z.string()], z.number().optional());
    const C = compile(S);
    const make = () => {
      const a: unknown[] = ["h"];
      a.length = 2;
      Object.setPrototypeOf(a, Object.assign(Object.create(Array.prototype), { 1: undefined }));
      return a;
    };
    const stock = S.parse(make()) as unknown[];
    assert.ok(Object.hasOwn(stock, 1) && stock.length === 2, "stock materializes the rest hole");
    const cow = C.parse(make()) as unknown[];
    assert.deepEqual(cow, stock);
    assert.ok(Object.hasOwn(cow, 1) && cow.length === 2, "the skeleton materializes it too");
    ok("a rest hole over an inherited undefined is materialized, like stock");
  }
  // An input whose `slice` is not the native one (review of #88): stock's runtime calls `input.slice(items.length)`
  // and assembles its output from what came back, so the hand copy runs only when `input.slice` is the native
  // function; otherwise the skeleton makes the same call and forces the copy, since a validator-shaped rest
  // compares nothing against the live input and the clean path would return the input (as #86's slice did)
  {
    const overridden = () => {
      const a: unknown[] = ["h", "a", "b"];
      (a as { slice: unknown }).slice = () => ["CUSTOM"];
      return a;
    };
    const emptied = () => {
      const a: unknown[] = ["h", "a", "b"];
      (a as { slice: unknown }).slice = () => [];
      return a;
    };
    class Sliced extends Array<unknown> {
      override slice(): unknown[] {
        return ["SUB"];
      }
    }
    const subclassed = () => {
      const a = new Sliced();
      a.push("h", "a");
      return a;
    };
    const cases: [string, z.ZodType, () => unknown[]][] = [
      ["an own slice under a validator rest", z.tuple([z.string()], z.string()), overridden],
      [
        "an own slice under a transform rest",
        z.tuple(
          [z.string()],
          z.string().transform((v) => `${v}!`),
        ),
        overridden,
      ],
      ["an own slice that returns nothing", z.tuple([z.string()], z.string()), emptied],
      ["a subclass override", z.tuple([z.string()], z.string()), subclassed],
      // A short input under an optional tail: stock runs the slice's elements and its truncation drops them
      [
        "an own slice on a short input under an optional tail",
        z.tuple([z.string(), z.string().optional()], z.string()),
        () => {
          const a: unknown[] = ["h"];
          (a as { slice: unknown }).slice = () => ["R"];
          return a;
        },
      ],
    ];
    for (const [label, S, make] of cases) {
      const C = compile(S);
      assert.ok(!C.async && !C.stock && !/_zod/.test(C.code ?? ""), `${label}: sync skeleton`);
      const stock = S.parse(make()) as unknown[];
      const input = make();
      const cow = C.parse(input) as unknown[];
      assert.deepEqual(cow, stock, label);
      assert.equal(cow.length, stock.length, `${label}: length`);
      assert.notEqual(
        cow,
        input,
        `${label}: the output is assembled from the slice, not the input`,
      );
      assert.ok(
        Array.isArray(cow) && Object.getPrototypeOf(cow) === Array.prototype,
        `${label}: a plain array`,
      );
      // The async layout (#94): the same slice called once, the output assembled from what it answered after the
      // await, a truncated prefix dropping the yielded elements; the head returned the input by reference under a
      // validator rest and wrote the yields past a truncation
      const SA = asyncTwin(S);
      const CA = compileTwin(S, label);
      const stockAsync = (await SA.parseAsync(make())) as unknown[];
      assert.deepEqual(stockAsync, stock, `${label}: stock's async answer is its sync one`);
      const inputAsync = make();
      const cowAsync = (await CA.parseAsync(inputAsync)) as unknown[];
      assert.deepEqual(cowAsync, stock, `${label}: the async layout`);
      assert.equal(cowAsync.length, stock.length, `${label}: the async layout's length`);
      assert.notEqual(cowAsync, inputAsync, `${label}: the async layout assembles from the slice`);
      assert.ok(
        Array.isArray(cowAsync) && Object.getPrototypeOf(cowAsync) === Array.prototype,
        `${label}: the async layout's plain array`,
      );
    }
    // The dropped elements are still validated, like stock's
    {
      const S = z.tuple([z.string(), z.string().optional()], z.string());
      const bad = () => {
        const a: unknown[] = ["h"];
        (a as { slice: unknown }).slice = () => [1];
        return a;
      };
      assert.equal(S.safeParse(bad()).success, false, "stock validates the dropped elements");
      assert.equal(compile(S).safeParse(bad()).success, false, "the skeleton validates them too");
      assert.equal(
        (await asyncTwin(S).safeParseAsync(bad())).success,
        false,
        "stock's async parse validates them",
      );
      assert.equal(
        (await compileTwin(S, "dropped").safeParseAsync(bad())).success,
        false,
        "the async layout validates them too",
      );
    }
    ok("an input whose slice is not the native one is sliced by that slice, like stock");
  }
  // The hand copy reads `length` once, like `slice` (review of #88): a Proxy whose `length` grows on the read after
  // the fixed slot ran shows the copy's read count in the output. Stock's slice reads it once, so the second value
  // is seen only by `handleTupleResults`, which decides presence with it; a copy that read it twice would size
  // itself from the second value and hand an extra `undefined` to the rest
  {
    let phase = 0;
    const S = z.tuple(
      [
        z.string().transform((v) => {
          phase = 1;
          return v;
        }),
      ],
      z
        .string()
        .optional()
        .transform((v) => (v === undefined ? "U" : `${v}!`)),
    );
    const C = compile(S);
    assert.ok(!C.async && !C.stock && !/_zod/.test(C.code ?? ""));
    const make = () =>
      new Proxy(["h", "a", "b"], {
        get(target, key, receiver) {
          if (key === "length") {
            if (phase === 1) {
              phase = 2;
              return 3;
            }
            if (phase === 2) return 4;
          }
          return Reflect.get(target, key, receiver);
        },
      });
    phase = 0;
    const stock = S.parse(make()) as unknown[];
    assert.deepEqual(stock, ["h", "a!", "b!"], "stock sizes the rest from its one length read");
    phase = 0;
    const cow = C.parse(make()) as unknown[];
    assert.deepEqual(cow, stock, "the hand copy sizes the rest from its one length read");
    ok("the hand copy reads the length once, like slice");
  }
  // The hand copy asks for presence before it reads (second review of #88): `Array.prototype.slice` runs `HasProperty`
  // then `Get` per index, so a Proxy whose `has` trap denies a rest index gives stock a hole there, which the rest
  // element then sees as `undefined`; a copy that read first held the value. The copy now tests `in` first and reads
  // only what is present, in slice's order
  {
    const T = z.tuple(
      [z.string()],
      z
        .string()
        .optional()
        .transform((v) => (v === undefined ? "U" : `${v}!`)),
    );
    const V = z.tuple([z.string()], z.string().optional());
    const denying = () =>
      new Proxy(["h", "a", "b"], {
        has(target, key) {
          if (typeof key === "string" && /^[0-9]+$/.test(key) && Number(key) >= 1) return false;
          return Reflect.has(target, key);
        },
      });
    const cases: [string, z.ZodType, unknown[]][] = [
      ["transform rest", T, ["h", "U", "U"]],
      ["validator rest", V, ["h", undefined, undefined]],
    ];
    for (const [label, S, expected] of cases) {
      const C = compile(S);
      assert.ok(!C.async && !C.stock && !/_zod/.test(C.code ?? ""), `${label}: sync skeleton`);
      const stock = S.parse(denying()) as unknown[];
      assert.deepEqual(stock, expected, `${label}: stock sees a hole where has denies`);
      const input = denying();
      const cow = C.parse(input) as unknown[];
      assert.deepEqual(cow, stock, `${label}: the copy asks has before it reads, like slice`);
      assert.notEqual(cow, input, `${label}: copied`);
      assert.ok(Object.hasOwn(cow, 1) && Object.hasOwn(cow, 2), `${label}: own slots`);
    }
    // The per-element trap sequence is slice's: `has` then `get`, in index order
    {
      const log: string[] = [];
      const p = new Proxy(["h", "a", "b"], {
        has(t, k) {
          log.push(`has:${String(k)}`);
          return Reflect.has(t, k);
        },
        get(t, k, r) {
          if (typeof k === "string" && /^[0-9]+$/.test(k)) log.push(`get:${k}`);
          return Reflect.get(t, k, r);
        },
      });
      compile(V).parse(p);
      assert.deepEqual(
        log.filter((e) => /:[12]$/.test(e)),
        ["has:1", "get:1", "has:2", "get:2"],
        "has then get per rest index, like slice",
      );
    }
    ok("a Proxy whose has trap denies a rest index gives a hole there, like slice");
  }
  // `slice` is read once (second review of #88): stock's `input.slice(items.length)` reads the property once and calls
  // what it got, so a getter that answers a custom function on its first read and the native one after decides with
  // the first; the guard read it twice and the fallback called the second answer
  {
    const T = z.tuple(
      [z.string()],
      z.string().transform((v) => `${v}!`),
    );
    const V = z.tuple([z.string()], z.string());
    const make = () => {
      const a: unknown[] = ["h", "a", "b"];
      let reads = 0;
      Object.defineProperty(a, "slice", {
        get() {
          reads++;
          return reads === 1 ? () => ["CUSTOM"] : Array.prototype.slice;
        },
      });
      return [a, () => reads] as const;
    };
    for (const [label, S, expected] of [
      ["transform rest", T, ["h", "CUSTOM!"]],
      ["validator rest", V, ["h", "CUSTOM"]],
    ] as [string, z.ZodType, unknown[]][]) {
      const [forStock, stockReads] = make();
      assert.deepEqual(S.parse(forStock), expected, `${label}: stock calls the first answer`);
      assert.equal(stockReads(), 1, `${label}: stock reads slice once`);
      const [input, reads] = make();
      const cow = compile(S).parse(input) as unknown[];
      assert.deepEqual(cow, expected, `${label}: the skeleton calls the first answer`);
      assert.equal(reads(), 1, `${label}: the skeleton reads slice once`);
      assert.notEqual(cow, input, `${label}: copied`);
      const [inputAsync, readsAsync] = make();
      const cowAsync = (await compileTwin(S, label).parseAsync(inputAsync)) as unknown[];
      assert.deepEqual(cowAsync, expected, `${label}: the async layout calls the first answer`);
      assert.equal(readsAsync(), 1, `${label}: the async layout reads slice once`);
      assert.notEqual(cowAsync, inputAsync, `${label}: the async layout copied`);
    }
    ok("slice is read once and the first answer is called, like stock");
  }
  // The fallback consumes what the custom `slice` returned the way stock does (second review of #88): `for...of`, the
  // rest element run on each yielded value in turn, so a Set, a generator or any other iterable is validated element
  // by element and written in yield order, its yields interleaved with the rest element's runs like under stock
  {
    const log: string[] = [];
    const T = z.tuple(
      [z.string()],
      z.string().transform((v) => {
        log.push(`run:${v}`);
        return `${v}!`;
      }),
    );
    const V = z.tuple([z.string()], z.string());
    const setSliced = () => {
      const a: unknown[] = ["h", "a", "b"];
      (a as { slice: unknown }).slice = () => new Set(["x", "y"]);
      return a;
    };
    const generated = () => {
      const a: unknown[] = ["h", "a", "b"];
      (a as { slice: unknown }).slice = function* () {
        log.push("yield:x");
        yield "x";
        log.push("yield:y");
        yield "y";
      };
      return a;
    };
    for (const [label, S, make, expected] of [
      ["a Set under a transform rest", T, setSliced, ["h", "x!", "y!"]],
      ["a Set under a validator rest", V, setSliced, ["h", "x", "y"]],
      ["a generator under a transform rest", T, generated, ["h", "x!", "y!"]],
      ["a generator under a validator rest", V, generated, ["h", "x", "y"]],
    ] as [string, z.ZodType, () => unknown[], unknown[]][]) {
      log.length = 0;
      assert.deepEqual(S.parse(make()), expected, `${label}: stock iterates the result`);
      const stockLog = log.splice(0);
      const input = make();
      const cow = compile(S).parse(input) as unknown[];
      assert.deepEqual(cow, expected, `${label}: the fallback iterates it too`);
      assert.deepEqual(log.splice(0), stockLog, `${label}: yields and runs interleave like stock`);
      assert.notEqual(cow, input, `${label}: copied`);
      assert.ok(Object.getPrototypeOf(cow) === Array.prototype, `${label}: a plain array`);
      // The async layout (#94) starts one rest product per yield inside the iteration, before its await; the head
      // indexed the result by `length`, so a Set or a generator gave it no rest element at all
      log.length = 0;
      assert.deepEqual(
        await asyncTwin(S).parseAsync(make()),
        expected,
        `${label}: stock's async parse iterates the result`,
      );
      assert.deepEqual(log.splice(0), stockLog, `${label}: stock's async parse interleaves alike`);
      const inputAsync = make();
      const cowAsync = (await compileTwin(S, label).parseAsync(inputAsync)) as unknown[];
      assert.deepEqual(cowAsync, expected, `${label}: the async layout iterates it too`);
      assert.deepEqual(
        log.splice(0),
        stockLog,
        `${label}: the async layout interleaves like stock`,
      );
      assert.notEqual(cowAsync, inputAsync, `${label}: the async layout copied`);
      assert.ok(
        Object.getPrototypeOf(cowAsync) === Array.prototype,
        `${label}: the async layout's plain array`,
      );
    }
    assert.deepEqual(
      (() => {
        log.length = 0;
        compile(T).parse(generated());
        return log;
      })(),
      ["yield:x", "run:x", "yield:y", "run:y"],
      "each yield is run before the next is pulled",
    );
    // A yielded element that fails: the parse fails on both sides
    {
      const a: unknown[] = ["h", "a"];
      (a as { slice: unknown }).slice = () => new Set([1]);
      assert.equal(V.safeParse(a).success, false, "stock validates the yielded element");
      assert.equal(compile(V).safeParse(a).success, false, "the fallback validates it too");
      assert.equal(
        (await compileTwin(V, "yielded").safeParseAsync(a)).success,
        false,
        "the async layout validates it too",
      );
    }
    // A result that is not iterable: stock's `for...of` throws a TypeError, and so does the fallback's (the async
    // layout's `for...of` throws it before the first await, so the async entries reject with it, as stock's do)
    {
      const a: unknown[] = ["h"];
      (a as { slice: unknown }).slice = () => 5;
      assert.throws(() => V.parse(a), TypeError, "stock throws on a non-iterable rest");
      assert.throws(() => compile(V).parse(a), TypeError, "the fallback throws too");
      await assert.rejects(asyncTwin(V).parseAsync(a), TypeError, "stock's async parse rejects");
      await assert.rejects(
        compileTwin(V, "non-iterable").parseAsync(a),
        TypeError,
        "the async layout rejects too",
      );
      await assert.rejects(
        compileTwin(V, "non-iterable").safeParseAsync(a),
        TypeError,
        "through safeParseAsync too",
      );
    }
    // A result with more elements than the input holds past the fixed slots: stock's `handleTupleResults` walks
    // `items` past its end there and throws a TypeError from `parse` and `safeParse` alike; the fallback hands such a
    // parse to stock, so the throw is stock's
    {
      const make = () => {
        const a: unknown[] = ["h", "a"];
        (a as { slice: unknown }).slice = () => ["x", "y"];
        return a;
      };
      assert.throws(() => V.parse(make()), TypeError, "stock throws on an over-long rest");
      assert.throws(() => V.safeParse(make()), TypeError, "stock's safeParse throws too");
      assert.throws(
        () => compile(V).parse(make()),
        TypeError,
        "the skeleton hands it to stock, which throws",
      );
      assert.throws(() => compile(V).safeParse(make()), TypeError, "through safeParse too");
      // The async layout's presence decision makes the same read past `items` after the await (#94); the head
      // returned the input by reference
      await assert.rejects(
        asyncTwin(V).parseAsync(make()),
        TypeError,
        "stock's async parse rejects",
      );
      await assert.rejects(
        compileTwin(V, "over-long").parseAsync(make()),
        TypeError,
        "the async layout rejects too",
      );
      await assert.rejects(
        compileTwin(V, "over-long").safeParseAsync(make()),
        TypeError,
        "through safeParseAsync too",
      );
    }
    ok("a custom slice's result is consumed with for...of, like stock");
  }
  // A subclass instance whose `slice` is the native one (second review of #88): the native slice constructs its result
  // through the instance's species constructor, so stock runs the subclass constructor; the guard also asks for
  // `constructor === Array`, so such an instance takes the real call and its constructor runs like under stock
  {
    const ctorArgs: unknown[][] = [];
    class Logged extends Array<unknown> {
      constructor(...args: unknown[]) {
        super(...(args as []));
        ctorArgs.push(args);
      }
    }
    const S = z.tuple(
      [z.string()],
      z.string().transform((v) => `${v}!`),
    );
    const make = () => {
      const a = new Logged();
      a.push("h", "a", "b");
      return a;
    };
    ctorArgs.length = 0;
    const stock = S.parse(make());
    const stockCtors = ctorArgs.splice(0);
    assert.deepEqual(
      stockCtors,
      [[], [2]],
      "stock's slice constructs the rest through the subclass",
    );
    const input = make();
    const cow = compile(S).parse(input) as unknown[];
    assert.deepEqual(cow, stock);
    assert.deepEqual(
      ctorArgs.splice(0),
      stockCtors,
      "the subclass constructor runs like under stock",
    );
    assert.ok(Object.getPrototypeOf(cow) === Array.prototype, "a plain array, like stock's");
    // A plain array's constructor is Array: the hand copy runs and nothing is constructed
    ok("a subclass instance with the native slice takes the real call, like stock");
  }
  // The native slice constructs its result through `ArraySpeciesCreate` (third review of #88): with `constructor ===
  // Array` it still reads `Array[Symbol.species]`, so a replaced species constructor runs under stock and builds the
  // result stock's `for...of` then consumes. The guard also asks `Array[Symbol.species] === Array`; a swapped species
  // takes the real call, like a subclass instance does (the compiler itself is not exercised under the swap: its own
  // `slice` calls would build through it too, so the products are compiled first)
  {
    const T = z.tuple(
      [z.string()],
      z.string().transform((v) => `${v}!`),
    );
    const V = z.tuple([z.string()], z.string());
    const CT = compile(T);
    const CV = compile(V);
    const ctorArgs: unknown[][] = [];
    // `splice` would construct through the swapped species too: a spread takes the log
    const take = (): unknown[][] => {
      const c = [...ctorArgs];
      ctorArgs.length = 0;
      return c;
    };
    const desc = Object.getOwnPropertyDescriptor(Array, Symbol.species)!;
    const seen: {
      label: string;
      stock: unknown;
      stockCtors: unknown[][];
      cow: unknown;
      cowCtors: unknown[][];
      fresh: boolean;
      plain: boolean;
    }[] = [];
    let underUndefined: [unknown, unknown] | null = null;
    try {
      Object.defineProperty(Array, Symbol.species, {
        configurable: true,
        get() {
          return function Custom(...args: unknown[]) {
            ctorArgs.push(args);
            const o: Record<PropertyKey, unknown> = { length: 0 };
            o[Symbol.iterator] = function* () {
              yield "CUSTOM";
            };
            return o;
          };
        },
      });
      for (const [label, S, C] of [
        ["transform rest", T, CT],
        ["validator rest", V, CV],
      ] as [string, z.ZodType, ReturnType<typeof compile>][]) {
        ctorArgs.length = 0;
        const stock = S.parse(["h", "a", "b"]);
        const stockCtors = take();
        const input = ["h", "a", "b"];
        const cow = C.parse(input);
        const cowCtors = take();
        seen.push({
          label,
          stock,
          stockCtors,
          cow,
          cowCtors,
          fresh: cow !== input,
          plain: Object.getPrototypeOf(cow) === Array.prototype,
        });
      }
      // A species of `undefined` makes the native slice build a plain array (`ArrayCreate`): the real call, the same output
      Object.defineProperty(Array, Symbol.species, { configurable: true, value: undefined });
      underUndefined = [T.parse(["h", "a", "b"]), CT.parse(["h", "a", "b"])];
    } finally {
      Object.defineProperty(Array, Symbol.species, desc);
    }
    for (const s of seen) {
      assert.deepEqual(
        s.stock,
        s.label === "transform rest" ? ["h", "CUSTOM!"] : ["h", "CUSTOM"],
        `${s.label}: stock consumes what the species constructor built`,
      );
      assert.deepEqual(
        s.stockCtors,
        [[2]],
        `${s.label}: stock's slice constructs through the species`,
      );
      assert.deepEqual(s.cow, s.stock, `${s.label}: a swapped species takes the real call`);
      assert.deepEqual(
        s.cowCtors,
        s.stockCtors,
        `${s.label}: the species constructor runs like under stock`,
      );
      assert.ok(s.fresh && s.plain, `${s.label}: a fresh plain array, like stock's`);
    }
    assert.deepEqual(
      underUndefined![1],
      underUndefined![0],
      "an undefined species: the same output",
    );
    assert.deepEqual(underUndefined![0], ["h", "a!", "b!"]);
    assert.deepEqual(CT.parse(["h", "a", "b"]), ["h", "a!", "b!"], "restored: the hand copy again");
    ok("a replaced Array[Symbol.species] takes the real call, like stock");
  }
  // The copy is slice's `HasProperty` then `Get` per index and nothing else (third review of #88). An `undefined` the
  // copy holds (an own `undefined` of the input, a hole, a hole over an inherited `undefined`: slice's `in`-then-read
  // makes them the same slot) is judged dirty by the rest loop without asking the input whether it owns the index
  // (#95), so no `getOwnPropertyDescriptor` trap runs on either side; a validator rest copies to stock's output, a
  // transform rest that maps `undefined` to a value copies through the comparison. The #95 group at the end of this
  // file pins the same decision for the array skeleton and the fixed slots
  {
    const T = z.tuple(
      [z.string()],
      z
        .string()
        .optional()
        .transform((v) => (v === undefined ? "U" : `${v}!`)),
    );
    const V = z.tuple([z.string()], z.string().optional());
    const log: string[] = [];
    const mutating = () =>
      new Proxy(["h", undefined, "b"] as unknown[], {
        getOwnPropertyDescriptor(t, k) {
          log.push(`gopd:${String(k)}`);
          if (k === "1") t[2] = "MUT";
          return Reflect.getOwnPropertyDescriptor(t, k);
        },
      });
    const throwing = () =>
      new Proxy(["h", undefined, "b"] as unknown[], {
        getOwnPropertyDescriptor(t, k) {
          if (k === "1") throw new Error("gopd trap");
          return Reflect.getOwnPropertyDescriptor(t, k);
        },
      });
    for (const [label, S, expected] of [
      ["transform rest", T, ["h", "U", "b!"]],
      ["validator rest", V, ["h", undefined, "b"]],
    ] as [string, z.ZodType, unknown[]][]) {
      const stock = S.parse(mutating());
      assert.deepEqual(
        stock,
        expected,
        `${label}: stock reads every index before anything else runs`,
      );
      log.length = 0;
      const input = mutating();
      const cow = compile(S).parse(input);
      assert.deepEqual(cow, stock, `${label}: the copy holds slice's values`);
      assert.notEqual(cow, input, `${label}: an undefined rest element copies`);
      assert.deepEqual(log, [], `${label}: no descriptor consulted`);
      assert.equal(input[2], "b", `${label}: the trap's effect never happens`);
      assert.deepEqual(
        compile(S).parse(throwing()),
        stock,
        `${label}: a throwing descriptor trap is never reached`,
      );
    }
    ok("the rest copy asks no own-ness question (#95)");
  }
  // The one length read is coerced as slice's `LengthOfArrayLike` coerces it (third review of #88): `ToLength`, so a
  // Proxy answering a fraction, a negative, a string or a non-number gives the count slice gives and never a
  // `new Array(fraction)`; a BigInt or a Symbol throws the TypeError `ToNumber` throws on both sides, an infinite
  // length the RangeError slice's allocation throws; an object is converted once, as `ToLength` converts it once
  {
    const T = z.tuple(
      [z.string()],
      z.string().transform((v) => `${v}!`),
    );
    const V = z.tuple([z.string()], z.string());
    const withLength = (len: unknown) =>
      new Proxy(["h", "a", "b"], {
        get(t, k, r) {
          return k === "length" ? len : Reflect.get(t, k, r);
        },
      });
    // The count ToLength gives: 2.9 and "2" → 2 (one rest element), true and 1.5 → 1 (none), NaN and "x" → 0
    // (none; both pass the skeleton's length guard, `NaN < 1` being false, as they pass stock's), -1 and null → 0
    // (the guard hands them to stock). A rest element the transform rewrites copies (the output equals stock's); no
    // rest element, or a validator rest, keeps the clean path and returns the input, on `main` alike (a Proxy
    // under-reporting its length is the clean path's known limitation: stock's fresh output is the truncated one).
    // A length that converts to NaN (NaN, "x") is never `===` itself, so the presence decision after the rest (fourth
    // review of #88) reads it as moved and re-runs stock's algorithm over the held results: stock's fresh output
    // there, where the other under-reported lengths keep the clean path
    for (const [len, asInt, transform, validator] of [
      [2.9, 2, "stock", "input"],
      ["2", 2, "stock", "input"],
      [true, 1, "input", "input"],
      [1.5, 1, "input", "input"],
      [Number.NaN, 0, "stock", "stock"],
      ["x", 0, "stock", "stock"],
      [-1, 0, "stock", "stock"],
      [null, 0, "stock", "stock"],
    ] as [unknown, number, "stock" | "input", "stock" | "input"][]) {
      for (const [label, S, expect] of [
        ["transform", T, transform],
        ["validator", V, validator],
      ] as [string, z.ZodType, "stock" | "input"][]) {
        const stock = S.parse(withLength(len));
        assert.deepEqual(
          stock,
          S.parse(withLength(asInt)),
          `${label}: stock sees ToLength(${String(len)})`,
        );
        const input = withLength(len);
        const cow = compile(S).parse(input);
        if (expect === "input") {
          assert.equal(
            cow,
            input,
            `${label}: length ${String(len)} takes the clean path (${asInt} rest slots, none rewritten)`,
          );
        } else {
          assert.deepEqual(cow, stock, `${label}: length ${String(len)} gives stock's output`);
          assert.notEqual(cow, input);
        }
      }
    }
    assert.throws(() => T.parse(withLength(Number.POSITIVE_INFINITY)), RangeError);
    assert.throws(
      () => compile(T).parse(withLength(Number.POSITIVE_INFINITY)),
      RangeError,
      "an infinite length: slice's RangeError",
    );
    for (const bad of [1n, Symbol("len")]) {
      assert.throws(() => T.parse(withLength(bad)), TypeError);
      assert.throws(
        () => compile(T).parse(withLength(bad)),
        TypeError,
        `${typeof bad}: ToNumber's TypeError, like stock`,
      );
    }
    {
      let stockCalls = 0;
      let cowCalls = 0;
      const counted = (counter: () => void) =>
        withLength({
          valueOf() {
            counter();
            return 2;
          },
        });
      const stock = T.parse(counted(() => stockCalls++));
      const cow = compile(T).parse(counted(() => cowCalls++));
      assert.deepEqual(cow, stock);
      assert.deepEqual(stock, ["h", "a!"]);
      // The skeleton converts it three times in all: its length guard's comparison (stock's compiled check), the
      // copy's one conversion (as slice converts it once) and the presence decision after the rest, which compares
      // the live length as a number with the copy's. Stock's runtime converts it three times too (its slice, then
      // the two presence loops of `handleTupleResults`)
      assert.equal(cowCalls, 3, "the copy converts an object length once, like slice");
      assert.ok(stockCalls >= cowCalls);
    }
    ok("the length read is coerced with ToLength, like slice");
  }
  // The fast path reads the length before the constructor and the species, in the order `Array.prototype.slice`
  // reads them (`LengthOfArrayLike`, then `ArraySpeciesCreate`), so a species getter with a side effect meets the
  // same state as under stock: the length it changes was read already, and the copy then asks `in` and reads each
  // index like slice's `HasProperty` then `Get` (fourth review of #88). The head read the species first, so a getter
  // that grew the input made the copy longer than slice's
  {
    const S = z.tuple(
      [z.string()],
      z
        .string()
        .optional()
        .transform((v) => (v === undefined ? "U" : `${v}!`)),
    );
    const C = compile(S);
    const desc = Object.getOwnPropertyDescriptor(Array, Symbol.species)!;
    const log: string[] = [];
    let active: unknown[] | null = null;
    const observed = (): unknown[] =>
      new Proxy(["h", "a"] as unknown[], {
        get(t, k, r) {
          if (typeof k === "string" && k !== "0") log.push(`get:${k}`);
          return Reflect.get(t, k, r);
        },
        has(t, k) {
          log.push(`has:${String(k)}`);
          return Reflect.has(t, k);
        },
      });
    let stock: unknown;
    let cow: unknown;
    let stockOrder: string[] = [];
    let cowOrder: string[] = [];
    try {
      Object.defineProperty(Array, Symbol.species, {
        configurable: true,
        get() {
          log.push("species");
          if (active) active.length = 3;
          return Array;
        },
      });
      active = ["h", "a"];
      stock = S.parse(active);
      active = ["h", "a"];
      cow = C.parse(active);
      active = null;
      // The reads from `slice` on: stock's slice reads the length, the constructor and the species, then asks `in`
      // and reads the one rest index; the hand copy makes the same reads in the same order
      log.length = 0;
      S.parse(observed());
      stockOrder = log.slice(log.indexOf("get:slice"), log.indexOf("get:slice") + 6);
      log.length = 0;
      C.parse(observed());
      cowOrder = log.slice(log.indexOf("get:slice"), log.indexOf("get:slice") + 6);
    } finally {
      Object.defineProperty(Array, Symbol.species, desc);
    }
    assert.deepEqual(
      stock,
      ["h", "a!"],
      "stock's slice fixed its count before the getter grew the input",
    );
    assert.deepEqual(cow, stock, "the copy's count is fixed before the species read, like slice's");
    assert.deepEqual(
      stockOrder,
      ["get:slice", "get:length", "get:constructor", "species", "has:1", "get:1"],
      "stock's slice: length, constructor, species, then HasProperty and Get",
    );
    assert.deepEqual(cowOrder, stockOrder, "the hand copy reads in slice's order");
    ok("a species getter with a side effect meets the length already read, like under slice");
  }
  // The fallback assembles the fixed prefix from the results the fixed slots produced, as stock's `handleTupleResults`
  // assembles from `itemResults`, never from the input after the call: a `slice` getter runs between the fixed slots
  // and the rest under stock too, and what it writes to a fixed slot is not in stock's output (fourth review of #88).
  // The head copied the prefix from the input after reading `slice`, so the getter's write was
  {
    const S = z.tuple([z.string()], z.string());
    const make = (rest: unknown[]) => {
      const input: unknown[] = ["h", "a"];
      Object.defineProperty(input, "slice", {
        configurable: true,
        get() {
          input[0] = "M";
          return () => rest;
        },
      });
      return input;
    };
    for (const rest of [[], ["a"]]) {
      const stock = S.parse(make(rest));
      assert.deepEqual(
        stock,
        ["h", ...rest],
        "stock's output holds the slot's result, not the getter's write",
      );
      const input = make(rest);
      const cow = compile(S).parse(input);
      assert.deepEqual(
        cow,
        stock,
        `rest ${JSON.stringify(rest)}: the prefix is the fixed slots' results`,
      );
      assert.ok(cow !== input, "a custom slice forces the copy");
      assert.equal(input[0], "M", "the getter ran once, on the input");
    }
    ok("a slice getter that writes a fixed slot is not in the output, like stock");
  }
  // Stock's `handleTupleResults` decides each fixed slot's presence from the live length after the rest ran, so a
  // custom slice that moves the length over a fixed slot changes stock's assembly: a shrink truncates at the first
  // optional slot the new length excludes, a growth materializes what an absent slot's run on `undefined` gave. The
  // sync rest layout holds every slot's result and runs that decision after the rest itself, from the held results
  // (fourth review of #88; the timeline group below covers every other source of such a move). The head before it
  // kept the decisions the slots made as they ran, answering `["h", "x"]` where stock truncates to `["h"]`, and a
  // later head handed such a parse to stock, whose run repeated the slice on the input it had left
  {
    const S = z.tuple([z.string(), z.string().optional()], z.string());
    const C = compile(S);
    const CA = compileTwin(S, "moved length");
    let sliceCalls = 0;
    const make = (values: unknown[], effect: (a: unknown[]) => unknown[]) => {
      const input: unknown[] = values;
      (input as { slice: unknown }).slice = function (this: unknown[]) {
        sliceCalls++;
        return effect(this);
      };
      return input;
    };
    // Shrunk past the optional slot: stock truncates at it, dropping the value it validated
    {
      const shrink = (a: unknown[]) => {
        a.length = 1;
        return [];
      };
      const stock = S.parse(make(["h", "x", "r"], shrink));
      assert.deepEqual(stock, ["h"], "stock decides presence after the slice");
      sliceCalls = 0;
      const input = make(["h", "x", "r"], shrink);
      const cow = C.parse(input);
      assert.deepEqual(cow, stock, "truncated from the held results, like stock");
      assert.equal(sliceCalls, 1, "one call: the parse never reached stock");
      assert.ok(cow !== input, "a fresh array");
      sliceCalls = 0;
      const inputAsync = make(["h", "x", "r"], shrink);
      const cowAsync = await CA.parseAsync(inputAsync);
      assert.deepEqual(cowAsync, stock, "the async layout truncates from the held results too");
      assert.equal(sliceCalls, 1, "one call under the async layout");
      assert.ok(cowAsync !== inputAsync, "a fresh array under the async layout");
    }
    // Grown past the optional slot: stock materializes the `undefined` its run on the absent slot gave
    {
      const grow = (a: unknown[]) => {
        a.length = 4;
        return [];
      };
      const stock = S.parse(make(["h"], grow));
      assert.deepEqual(
        stock,
        ["h", undefined],
        "stock materializes the absent slot the growth made present",
      );
      sliceCalls = 0;
      const input = make(["h"], grow);
      const cow = C.parse(input);
      assert.deepEqual(cow, stock, "materialized from the held result, like stock");
      assert.equal(sliceCalls, 1, "one call: the parse never reached stock");
      assert.ok(cow !== input, "a fresh array");
      // The async layout started the absent slot on `undefined` before its await and holds what settled (#94)
      sliceCalls = 0;
      const inputAsync = make(["h"], grow);
      const cowAsync = await CA.parseAsync(inputAsync);
      assert.deepEqual(cowAsync, stock, "the async layout materializes the held result too");
      assert.equal(sliceCalls, 1, "one call under the async layout");
      assert.ok(cowAsync !== inputAsync, "a fresh array under the async layout");
    }
    // Grown past the rest only: every fixed slot's presence stands, the rest results follow them
    {
      const append = (a: unknown[]) => {
        a.push("z");
        return ["r"];
      };
      const T = z.tuple(
        [z.string()],
        z.string().transform((v) => `${v}!`),
      );
      const stock = T.parse(make(["h", "r"], append));
      assert.deepEqual(stock, ["h", "r!"]);
      sliceCalls = 0;
      const input = make(["h", "r"], append);
      const cow = compile(T).parse(input);
      assert.deepEqual(cow, stock, "assembled from the held results");
      assert.equal(sliceCalls, 1, "one call: the parse never reached stock");
      assert.ok(cow !== input);
    }
    ok(
      "a custom slice that moves the length over a fixed slot: stock's presence decision, from the held results",
    );
  }
  // Code pin: a rest tuple's sync skeleton holds the guard's length read, reads `slice` once and, on the native one,
  // makes slice's reads in slice's order (the length once, converted; the constructor; the species off `Array`),
  // copies by hand (#87: `slice` pays a fixed builtin cost) with `in` then a store per index and nothing else, then
  // makes the two reads stock's `for...of` makes with stock's receivers (`Symbol.iterator` off the copy, `next` off
  // the iterator the native one creates; nothing is read off a prototype, sixth review of #88) and runs the inline
  // index loop only when both answered the captured natives, closing the iterator through `return` when the rest
  // element throws; every other case is a continuation over an iterable named `rest` (a `for...of` continued from
  // the method or the `next` that was read, the native builtin finished on the facade with the reads already made,
  // or what the custom `slice` answered, called through the hoisted `Reflect.apply`, never a second `.slice`), and
  // the live length read after the rest is compared with every read before it. An `undefined` rest element copies
  // from the read alone, with no own-ness probe on the copy or the input (#95). A fixed tuple reads no `slice` and
  // allocates nothing on its clean path
  const restCode = compile(z.tuple([z.string()], z.string())).code ?? "";
  assert.ok(
    /const (x\d+) = input\.length;\s*if \(\1 < 1\) return INVALID;/.test(restCode) &&
      /const (x\d+) = input\.slice;\s*let [x\d, ]+ = null, x\d+ = false;\s*if \(\1 === c\d+\) \{\s*(x\d+) = \+input\.length;\s*(x\d+) = input\.constructor;\s*if \(\3 === Array && \((x\d+) = Array\[Symbol\.species\]\) === Array\) \{/.test(
        restCode,
      ) &&
      /= new Array\((x\d+) > 1 \? Math\.floor\(\1\) - 1 : 0\);\s*for \(let j = 0; j < (x\d+)\.length; j\+\+\) \{\s*if \(\(1 \+ j\) in input\) \2\[j\] = input\[1 \+ j\];\s*\}\s*const (x\d+) = \2\[Symbol\.iterator\];\s*if \(\3 === c\d+\) \{\s*const (x\d+) = c\d+\(\2\);\s*const (x\d+) = \4\.next;\s*if \(\5 === c\d+\) \{\s*x\d+ = true;\s*try \{\s*for \(let i = 1; i < 1 \+ \2\.length; i\+\+\) \{/.test(
        restCode,
      ) &&
      /\} catch \(err\) \{\s*c\d+\((x\d+)\);\s*throw err;\s*\}\s*\} else \{\s*x\d+ = c\d+\(\1, x\d+\);\s*\}\s*\} else \{\s*x\d+ = c\d+\(x\d+, x\d+\);/.test(
        restCode,
      ) &&
      !/Array\.prototype|getOwnPropertyDescriptor|hasOwn/.test(restCode) &&
      /else if \(e === undefined\) \{\s*if \(x\d+ === input\) \{ x\d+ = \[x\d+\]; for \(let j = 1; j < i; j\+\+\) x\d+\[j\] = x\d+\[j - 1\]; \}\s*x\d+\[i\] = undefined;/.test(
        restCode,
      ) &&
      /= c\d+\(input, x\d+, x\d+ === Array \? \{ \[Symbol\.species\]: x\d+ \} : x\d+, 1\);/.test(
        restCode,
      ) &&
      /= c\d+\(x\d+, input, \[1\]\);/.test(restCode) &&
      (restCode.match(/for \(const e of rest\) \{/g) ?? []).length === 1 &&
      /const rest = x\d+;\s*for \(const e of rest\) \{/.test(restCode) &&
      /const (x\d+) = input\.length;\s*if \(x\d+ !== null \|\| !\(\1 === x\d+ && \+\1 === x\d+\)\) \{/.test(
        restCode,
      ) &&
      !/\.slice\(/.test(restCode),
    "the sync rest layout: slice's reads, the hand copy, the continuations and the presence decision after the rest",
  );
  const fixedCode = compile(z.tuple([z.string(), z.number().optional()])).code ?? "";
  assert.ok(
    !/new Array\(|\.slice\(|input\.slice/.test(fixedCode),
    "a tuple without a rest takes no copy and reads no slice",
  );
  // Code pin, the async layout (#94): the guard's length read held, every fixed slot started on its read, `slice`
  // read once and the same source (the hand copy, the two iterator reads, the continuations), one rest product
  // started per copy element inside the try that closes the iterator, a continuation consumed with `for...of` over
  // `rest` before the await with each yield kept and its product started, then the one live length read after the
  // `Promise.all`, the gates on it, and the presence decision after the rest loop comparing it with the guard's read
  // and the copy's; no `.slice(` call anywhere
  const asyncRest = compile(z.tuple([z.string().refine(async () => true)], z.string()));
  const asyncCode = asyncRest.code ?? "";
  assert.ok(
    asyncRest.async &&
      /const (x\d+) = input\.length;\s*if \(\1 < 1\) return INVALID;/.test(asyncCode) &&
      /const (x\d+) = input\[0\];\s*const (x\d+) = c\d+\(\1\);\s*const (x\d+) = \[\];\s*const (x\d+) = input\.slice;\s*let [x\d, ]+ = null, x\d+ = false;\s*if \(\4 === c\d+\) \{\s*(x\d+) = \+input\.length;/.test(
        asyncCode,
      ) &&
      /x\d+ = true;\s*try \{\s*for \(let j = 0; j < (x\d+)\.length; j\+\+\) \{\s*(x\d+)\.push\(c\d+\(\1\[j\]\)\);\s*\}\s*\} catch \(err\) \{\s*c\d+\(x\d+\);\s*throw err;/.test(
        asyncCode,
      ) &&
      /if \(!(x\d+)\) \{\s*(x\d+) = \[\];\s*const rest = x\d+;\s*for \(const e of rest\) \{\s*\2\.push\(e\);\s*x\d+\.push\(c\d+\(e\)\);\s*\}\s*\}\s*let (x\d+) = (x\d+);\s*if \(\4 instanceof Promise\) \[\3\] = yield Promise\.all\(\[\4\]\);\s*const x\d+ = x\d+;\s*const (x\d+) = input\.length;/.test(
        asyncCode,
      ) &&
      (asyncCode.match(/for \(const e of rest\) \{/g) ?? []).length === 1 &&
      (asyncCode.match(/input\.length/g) ?? []).length === 3 &&
      /if \(!(x\d+) \|\| !\((x\d+) === (x\d+) && \+\2 === (x\d+)\)\) \{\s*const x\d+ = \[x\d+\];/.test(
        asyncCode,
      ) &&
      !/\.slice\(|Array\.prototype|getOwnPropertyDescriptor|hasOwn/.test(asyncCode),
    "the async layout: the sync layout's rest source before the await, one live length read after it, the presence decision after the rest loop",
  );
  ok("the rest copy is emitted for a rest tuple only");
}

head(
  "the rest layouts follow stock's runtime timeline: results held, one slice, presence decided after the rest (fourth review of #88, #96; the async layout #94)",
);
{
  // Stock's `$ZodTuple` runtime, in order: it runs every fixed item and keeps each result (`itemResults`); reads
  // `input.slice` once and calls it once (the native slice reads the length, then the constructor, then the species
  // off it, then asks `HasProperty` and `Get` per index and builds its result through the species); iterates what
  // came back with `for...of`, running the rest element per yield; and only then decides each fixed slot's presence
  // from the live `input.length` (`handleTupleResults`), assembling from the results it holds. Every hook an accepted
  // input or a global offers between two of those steps (a fixed slot's callback, a `slice` getter, a custom `slice`,
  // a species getter or constructor, an iterator, a rest callback, a Proxy trap) can move the length or rewrite a
  // slot; the skeleton meets each at the same point and holds the same state, so the value, the throw and the hook
  // calls are stock's. The matrix below runs one mutation per source and target on a fresh input for both sides.
  // (No helper here calls an array method that constructs through the species: a getter on it is under test.)
  const snap = (v: unknown): unknown => {
    if (!Array.isArray(v)) return v;
    // Index loops, no spread or `for...of`: the array iterator may be under test (group 9)
    const keys = Object.keys(v);
    const values: unknown[] = [];
    for (let i = 0; i < keys.length; i++) values.push(snap(v[Number(keys[i])]));
    return { length: v.length, keys, values };
  };
  type Err = { name: string; message: string };
  type Run = { value?: unknown; error?: Err; safeError?: Err; log: string[]; ref: boolean };
  const errOf = (e: unknown): Err => ({
    name: (e as Error).constructor.name,
    message: (e as Error).message,
  });
  const run = (
    parse: (v: unknown) => unknown,
    safe: (v: unknown) => unknown,
    make: (log: string[]) => unknown,
  ): Run => {
    const log: string[] = [];
    const input = make(log);
    const taken = (): string[] => {
      const out: string[] = [];
      for (let i = 0; i < log.length; i++) out.push(log[i]!);
      return out;
    };
    try {
      const value = parse(input);
      return { value: snap(value), log: taken(), ref: value === input };
    } catch (e) {
      const r: Run = { error: errOf(e), log: taken(), ref: false };
      try {
        safe(make([]));
        r.safeError = { name: "none", message: "" };
      } catch (e2) {
        r.safeError = errOf(e2);
      }
      return r;
    }
  };
  /** The async analog of `run`, through the async entries: a rejection is the error stock's `.then` chain throws */
  const runAsync = async (
    parse: (v: unknown) => Promise<unknown>,
    safe: (v: unknown) => Promise<unknown>,
    make: (log: string[]) => unknown,
  ): Promise<Run> => {
    const log: string[] = [];
    const input = make(log);
    const taken = (): string[] => {
      const out: string[] = [];
      for (let i = 0; i < log.length; i++) out.push(log[i]!);
      return out;
    };
    try {
      const value = await parse(input);
      return { value: snap(value), log: taken(), ref: value === input };
    } catch (e) {
      const r: Run = { error: errOf(e), log: taken(), ref: false };
      try {
        await safe(make([]));
        r.safeError = { name: "none", message: "" };
      } catch (e2) {
        r.safeError = errOf(e2);
      }
      return r;
    }
  };
  /** The async twin of a case's tuple (#94): its first fixed slot carries an async refine, so the skeleton takes the
   *  async layout, whose rest source and presence decision are the sync layout's; the rest stays sync (stock's own
   *  async rest writes every result to the last index, the quirk the #77 group pins). Every hook of the case meets
   *  the same point of stock's async runtime as of its sync one, so stock's value, error and hook calls are the
   *  sync case's, and the twin is checked against them through the async entries */
  const asyncTwin = (S: z.ZodType): z.ZodType => {
    const def = S._zod.def as unknown as { items: z.ZodType[]; rest?: z.ZodType };
    const [first, ...others] = def.items;
    return z.tuple([first!.refine(async () => true), ...others], def.rest as never);
  };
  type Case = {
    label: string;
    S: z.ZodType;
    /** A fresh input; the hooks it carries log into `log` */
    make: (log: string[]) => unknown;
    /** Stock's literal value, pinned so both sides cannot agree on a wrong one */
    expect?: unknown;
    /** The class stock throws, from `parse` and `safeParse` alike */
    throws?: string;
    /** A global swapped for the two parses (the products are compiled before it), undone by the returned function */
    setup?: (log: string[]) => () => void;
    /** Whether the skeleton's output is the input by reference (stock's is always a fresh array) */
    ref?: boolean;
    /** A failing parse: the skeleton hands it to stock, whose run repeats every hook (the failure model), so the
     *  hook calls are not compared */
    rerun?: boolean;
    /** The global under test is consumed by stock's async runtime outside the tuple's timeline (`Promise.all` over
     *  its promise list iterates with the array iterator and its `next`), so the async twin is not run: the async
     *  layout's rest source is the sync layout's emitted code, and the code pin of the #78 group holds it to the
     *  same two reads */
    syncOnly?: boolean;
  };
  const check = async ({
    label,
    S,
    make,
    expect,
    throws,
    setup,
    ref,
    rerun,
    syncOnly,
  }: Case): Promise<void> => {
    const C = compile(S);
    assert.ok(!C.stock, `${label}: on the CoW path`);
    const SA = asyncTwin(S);
    const CA = compile(SA);
    assert.ok(CA.async && !CA.stock, `${label}: the async twin on the CoW path`);
    // Stock's memoizer walks the items with `for...of` on a schema's first parse (`isRecursive`), a read of the
    // array iterator outside the tuple's timeline: taken here, before any global under test is swapped
    S.safeParse(null);
    SA.safeParse(null);
    let undo = setup?.([]);
    let stock: Run;
    let cow: Run;
    try {
      stock = run(
        (v) => S.parse(v),
        (v) => S.safeParse(v),
        make,
      );
      cow = run(
        (v) => C.parse(v),
        (v) => C.safeParse(v),
        make,
      );
    } finally {
      undo?.();
    }
    assert.deepEqual(cow.value, stock.value, `${label}: value`);
    assert.deepEqual(cow.error, stock.error, `${label}: error`);
    assert.deepEqual(cow.safeError, stock.safeError, `${label}: safeParse error`);
    if (!rerun) assert.deepEqual(cow.log, stock.log, `${label}: hook calls, in order`);
    if (expect !== undefined)
      assert.deepEqual(stock.value, snap(expect), `${label}: stock's value`);
    if (throws !== undefined) {
      assert.equal(stock.error?.name, throws, `${label}: stock throws ${throws}`);
      assert.equal(stock.safeError?.name, throws, `${label}: stock's safeParse throws too`);
    }
    if (ref !== undefined)
      assert.equal(cow.ref, ref, `${label}: ${ref ? "the input by reference" : "a fresh array"}`);
    if (syncOnly) {
      ok(label);
      return;
    }
    // The async layout (#94), against stock's async runtime on the twin, whose answer is the sync case's; the
    // global under test is swapped again for the two async parses, which settle before it is restored
    undo = setup?.([]);
    let stockAsync: Run;
    let cowAsync: Run;
    try {
      stockAsync = await runAsync(
        (v) => SA.parseAsync(v),
        (v) => SA.safeParseAsync(v),
        make,
      );
      cowAsync = await runAsync(
        (v) => CA.parseAsync(v),
        (v) => CA.safeParseAsync(v),
        make,
      );
    } finally {
      undo?.();
    }
    assert.deepEqual(
      stockAsync.value,
      stock.value,
      `${label}: stock's async value is its sync one`,
    );
    assert.deepEqual(
      stockAsync.error,
      stock.error,
      `${label}: stock's async error is its sync one`,
    );
    if (!rerun)
      assert.deepEqual(
        stockAsync.log,
        stock.log,
        `${label}: stock's async hook calls are its sync ones`,
      );
    assert.deepEqual(cowAsync.value, stockAsync.value, `${label}: async layout, value`);
    assert.deepEqual(cowAsync.error, stockAsync.error, `${label}: async layout, error`);
    assert.deepEqual(
      cowAsync.safeError,
      stockAsync.safeError,
      `${label}: async layout, safeParseAsync error`,
    );
    if (!rerun)
      assert.deepEqual(
        cowAsync.log,
        stockAsync.log,
        `${label}: async layout, hook calls, in order`,
      );
    if (ref !== undefined)
      assert.equal(
        cowAsync.ref,
        ref,
        `${label}: async layout, ${ref ? "the input by reference" : "a fresh array"}`,
      );
    ok(label);
  };
  const HOLE = Symbol("hole");
  /** An array literal with `HOLE` marking a hole */
  const arr = (...xs: unknown[]): unknown[] => {
    const a: unknown[] = new Array(xs.length);
    xs.forEach((x, i) => {
      if (x !== HOLE) a[i] = x;
    });
    return a;
  };
  /** The input under parse, for a hook that lives in the schema or on a global */
  const holder: { input: unknown[] | null } = { input: null };
  /** A fresh copy of `values` (a spread, never `slice`), registered in `holder` */
  const held = (values: unknown[]) => (): unknown[] => {
    const a = [...values];
    holder.input = a;
    return a;
  };
  const opt = z.string().optional();
  const restT = z.string().transform((v) => `${v}!`);
  const restO = z
    .string()
    .optional()
    .transform((v) => (v === undefined ? "U" : `${v}!`));
  /** `[string, string?, ...rest]`: the shape whose optional slot stock may truncate or materialize after the rest ran */
  const SO = (rest: z.ZodType) => z.tuple([z.string(), opt], rest);
  /** `[string, ...rest]` */
  const S1 = (rest: z.ZodType) => z.tuple([z.string()], rest);
  /** A transform on a fixed slot whose callback runs `effect` on the input under parse */
  const slotCb = (effect: (a: unknown[]) => void) =>
    z.string().transform((v) => {
      effect(holder.input!);
      return `${v}!`;
    });
  /** An own `slice` on a fresh input, its call logged */
  const withSlice =
    (values: unknown[], slice: (this: unknown[], log: string[]) => unknown) => (log: string[]) => {
      const a = [...values];
      Object.defineProperty(a, "slice", {
        configurable: true,
        value: function (this: unknown[]) {
          log.push("slice");
          return slice.call(this, log);
        },
      });
      return a;
    };
  /** A `slice` getter on a fresh input, its read logged */
  const withSliceGetter =
    (values: unknown[], get: (a: unknown[], log: string[]) => unknown) => (log: string[]) => {
      const a = [...values];
      Object.defineProperty(a, "slice", {
        configurable: true,
        get() {
          log.push("get:slice");
          return get(a, log);
        },
      });
      return a;
    };
  /** A getter on `Array[Symbol.species]` for the two parses, its call logged; `effect` sees the input under parse */
  const species =
    (effect: (a: unknown[]) => void, answer: () => unknown = () => Array) =>
    () => {
      const desc = Object.getOwnPropertyDescriptor(Array, Symbol.species)!;
      Object.defineProperty(Array, Symbol.species, {
        configurable: true,
        get() {
          if (holder.input) effect(holder.input);
          return answer();
        },
      });
      return () => {
        Object.defineProperty(Array, Symbol.species, desc);
        holder.input = null;
      };
    };
  const plainSlice = Array.prototype.slice;

  // 1. A fixed slot's callback (a premise violation the layout still meets at stock's point): stock runs the later
  // slots on what the callback left and decides presence at the end; the skeleton reads each later slot live,
  // holds every result and decides presence after the rest from the live length, so a shrink truncates and a
  // growth materializes like stock
  {
    const cases: [string, z.ZodType, unknown[], unknown][] = [
      [
        "writes the optional slot",
        z.tuple([slotCb((a) => (a[1] = "M")), opt], z.string()),
        ["h", "x", "r"],
        ["h!", "M", "r"],
      ],
      [
        "writes a rest slot",
        z.tuple([slotCb((a) => (a[2] = "M")), opt], z.string()),
        ["h", "x", "r"],
        ["h!", "x", "M"],
      ],
      [
        "shrinks the length below the optional slot",
        z.tuple([slotCb((a) => (a.length = 1)), opt], z.string()),
        ["h", "x", "r"],
        ["h!"],
      ],
      [
        "grows the length past the optional slot",
        z.tuple([slotCb((a) => (a.length = 3)), opt], opt),
        ["h"],
        ["h!", undefined, undefined],
      ],
      [
        "shrinks the length below the rest",
        z.tuple([slotCb((a) => (a.length = 2)), opt], restT),
        ["h", "x", "r", "s"],
        ["h!", "x"],
      ],
      // The slot after the callback's rewrites an earlier slot: stock holds the earlier result; the copy path assembles
      // the prefix from the held results, never from the input a second time
      [
        "rewrites the slot before it",
        z.tuple([z.string(), slotCb((a) => (a[0] = "M"))], z.string()),
        ["h", "x", "r"],
        ["h", "x!", "r"],
      ],
    ];
    for (const [label, S, values, expect] of cases)
      await check({ label: `a fixed slot's callback ${label}`, S, make: held(values), expect });
  }

  // 2. A `slice` getter: runs after every fixed result is held and before the call, on both sides
  await check({
    label:
      "a slice getter rewrites the fixed slot and answers a custom function (fourth review of #88, P1-B)",
    S: S1(z.string()),
    make: withSliceGetter(["h", "a"], (a) => {
      a[0] = "M";
      return () => [];
    }),
    expect: ["h"],
  });
  await check({
    label: "a slice getter rewrites the fixed slot and answers a custom function that yields",
    S: S1(z.string()),
    make: withSliceGetter(["h", "a"], (a) => {
      a[0] = "M";
      return () => ["a"];
    }),
    expect: ["h", "a"],
  });
  await check({
    label: "a slice getter rewrites the optional slot: the held result is assembled",
    S: SO(z.string()),
    make: withSliceGetter(["h", "x", "r"], (a) => {
      a[1] = "M";
      return () => ["r"];
    }),
    expect: ["h", "x", "r"],
  });
  await check({
    label: "a slice getter shrinks the length below the optional slot",
    S: SO(z.string()),
    make: withSliceGetter(["h", "x", "r"], (a) => {
      a.length = 1;
      return () => [];
    }),
    expect: ["h"],
  });
  await check({
    label: "a slice getter grows the length past the optional slot",
    S: SO(z.string()),
    make: withSliceGetter(["h"], (a) => {
      a.length = 4;
      return () => [];
    }),
    expect: ["h", undefined],
  });
  // The getter answers the native slice: the copy runs on the state the getter left, as the native call would
  await check({
    label: "a slice getter shrinks the length and answers the native slice",
    S: SO(z.string()),
    make: withSliceGetter(["h", "x", "r"], (a) => {
      a.length = 1;
      return plainSlice;
    }),
    expect: ["h"],
  });
  await check({
    label: "a slice getter grows the length and answers the native slice",
    S: SO(opt),
    make: withSliceGetter(["h"], (a) => {
      a.length = 3;
      return plainSlice;
    }),
    expect: ["h", undefined, undefined],
  });
  await check({
    label:
      "a slice getter rewrites a rest slot and answers the native slice: read after it, like slice",
    S: S1(restT),
    make: withSliceGetter(["h", "a"], (a) => {
      a[1] = "M";
      return plainSlice;
    }),
    expect: ["h", "M!"],
  });

  // 3. A custom `slice` body and the result it answers: called once, iterated like stock, and the length it left
  // decides presence
  await check({
    label:
      "a custom slice shrinks the length below the optional slot and yields nothing (fourth review of #88, P1-C)",
    S: SO(z.string()),
    make: withSlice(["h", "x", "r"], function () {
      this.length = 1;
      return [];
    }),
    expect: ["h"],
  });
  await check({
    label:
      "a custom slice shrinks the length below the optional slot and yields an element (dropped with the truncation)",
    S: SO(z.string()),
    make: withSlice(["h", "x", "r"], function () {
      this.length = 1;
      return ["q"];
    }),
    expect: ["h"],
  });
  await check({
    label:
      "a custom slice shrinks the length below the rest with no optional slot: stock's trailing loop walks past the items",
    S: S1(z.string()),
    make: withSlice(["h", "x", "r"], function () {
      this.length = 1;
      return ["q"];
    }),
    throws: "TypeError",
  });
  await check({
    label: "a custom slice shrinks the length below the rest and yields nothing",
    S: S1(z.string()),
    make: withSlice(["h", "x", "r"], function () {
      this.length = 1;
      return [];
    }),
    expect: ["h"],
  });
  await check({
    label: "a custom slice grows the length past the optional slot and yields nothing",
    S: SO(z.string()),
    make: withSlice(["h"], function () {
      this.length = 4;
      return [];
    }),
    expect: ["h", undefined],
  });
  await check({
    label: "a custom slice grows the length past the optional slot and yields an element",
    S: SO(z.string()),
    make: withSlice(["h"], function () {
      this.length = 4;
      return ["q"];
    }),
    expect: ["h", undefined, "q"],
  });
  await check({
    label: "a custom slice rewrites the fixed slot and shrinks (#96 row 2)",
    S: SO(z.string()),
    make: withSlice(["h", "x", "r"], function () {
      this[0] += "!";
      this.length = 1;
      return [];
    }),
    expect: ["h"],
  });
  await check({
    label: "a custom slice rewrites the optional slot",
    S: SO(z.string()),
    make: withSlice(["h", "x", "r"], function () {
      this[1] = "M";
      return ["r"];
    }),
    expect: ["h", "x", "r"],
  });
  await check({
    label: "a custom slice yields more than the input holds past the fixed slots",
    S: S1(z.string()),
    make: withSlice(["h", "a"], () => ["p", "q", "r"]),
    throws: "TypeError",
  });
  await check({
    label: "a custom slice yields exactly what the input holds",
    S: S1(restT),
    make: withSlice(["h", "a"], () => ["p"]),
    expect: ["h", "p!"],
  });
  await check({
    label: "a custom slice answers a non-iterable",
    S: S1(z.string()),
    make: withSlice(["h", "a"], () => 5),
    throws: "TypeError",
  });
  await check({
    label: "a custom slice answers an iterable that throws before its first value",
    S: S1(z.string()),
    make: withSlice(["h", "a"], () => ({
      [Symbol.iterator]() {
        throw new RangeError("first");
      },
    })),
    throws: "RangeError",
  });
  await check({
    label:
      "a custom slice answers an iterator that throws after one value, which ran the rest element",
    S: S1(
      z.string().transform((v) => {
        holder.input?.push(`ran:${v}`);
        return `${v}!`;
      }),
    ),
    make: withSlice(["h", "a"], (log) => {
      holder.input = log as unknown[];
      return {
        [Symbol.iterator]() {
          let n = 0;
          return {
            next() {
              log.push(`next:${n}`);
              if (n++ === 0) return { value: "p", done: false };
              throw new RangeError("second");
            },
          };
        },
      };
    }),
    throws: "RangeError",
  });
  // The result's iterator getter and its `next` run between the call and the presence decision
  await check({
    label: "the result's Symbol.iterator getter shrinks the length below the optional slot",
    S: SO(z.string()),
    make: withSlice(["h", "x", "r"], function (this: unknown[], log) {
      const a = this;
      return {
        get [Symbol.iterator]() {
          log.push("iter");
          a.length = 1;
          return function* () {
            yield "q";
          };
        },
      };
    }),
    expect: ["h"],
  });
  await check({
    label: "the result's Symbol.iterator getter shrinks the length below the rest",
    S: S1(z.string()),
    make: withSlice(["h", "x", "r"], function (this: unknown[], log) {
      const a = this;
      return {
        get [Symbol.iterator]() {
          log.push("iter");
          a.length = 1;
          return function* () {
            yield "q";
          };
        },
      };
    }),
    throws: "TypeError",
  });
  await check({
    label: "the iterator's next rewrites the fixed slot and grows the length after one value",
    S: SO(restT),
    make: withSlice(["h", "x", "r"], function (this: unknown[], log) {
      const a = this;
      let n = 0;
      return {
        [Symbol.iterator]: () => ({
          next() {
            log.push(`next:${n}`);
            if (n === 1) {
              a[0] = "M";
              a.length = 5;
            }
            return n < 2
              ? { value: ["p", "q"][n++], done: false }
              : { value: undefined, done: true };
          },
        }),
      };
    }),
    expect: ["h", "x", "p!", "q!"],
  });
  await check({
    label: "an empty custom result under a truncated prefix",
    S: SO(restT),
    make: withSlice(["h"], () => []),
    expect: ["h"],
  });
  await check({
    label:
      "a one-element custom result under a truncated prefix: run, then dropped by the truncation",
    S: SO(
      z.string().transform((v) => {
        holder.input?.push(`ran:${v}`);
        return `${v}!`;
      }),
    ),
    make: withSlice(["h"], (log) => {
      holder.input = log as unknown[];
      return ["q"];
    }),
    expect: ["h"],
  });
  await check({
    label:
      "a failing element in a custom result under a truncated prefix: stock reports it, the truncation notwithstanding",
    S: SO(z.string()),
    make: withSlice(["h"], () => [1]),
    rerun: true,
  });
  holder.input = null;

  // 4. A species getter that answers `Array`: the native slice reads the length before it and the indices after
  // it, and the copy does the same; the length it moves is met by the presence decision after the rest
  await check({
    label:
      "a species getter grows the length: the copy's count was fixed before it (fourth review of #88, P1-A)",
    S: S1(restO),
    make: held(["h", "a"]),
    setup: species((a) => {
      a.length = 3;
    }),
    expect: ["h", "a!"],
  });
  await check({
    label:
      "a species getter grows the length past the optional slot: materialized after the rest (#96 row 1)",
    S: SO(z.string()),
    make: held(["h"]),
    setup: species((a) => {
      a.length = 3;
    }),
    expect: ["h", undefined],
  });
  await check({
    label: "a species getter shrinks the length below the optional slot",
    S: SO(opt),
    make: held(["h", "x", "r"]),
    setup: species((a) => {
      a.length = 1;
    }),
    expect: ["h"],
  });
  await check({
    label: "a species getter rewrites a rest slot: read after it, like slice",
    S: S1(z.string()),
    make: held(["h", "a"]),
    setup: species((a) => {
      a[1] = "M";
    }),
    expect: ["h", "M"],
    ref: true,
  });
  await check({
    label:
      "a species getter rewrites the fixed slot under a transform rest: the held result is assembled",
    S: S1(restT),
    make: held(["h", "a"]),
    setup: species((a) => {
      a[0] = "M";
    }),
    expect: ["h", "a!"],
  });
  await check({
    label: "a species getter installs an own slice: read already, like under slice",
    S: S1(restT),
    make: held(["h", "a"]),
    setup: species((a) => {
      Object.defineProperty(a, "slice", { value: () => ["Z"] });
    }),
    expect: ["h", "a!"],
  });
  // The getter answers something else: the native slice constructs through it, on the state it left
  await check({
    label: "a species getter answers a constructor after growing the input",
    S: S1(restT),
    make: held(["h", "a"]),
    setup: species(
      (a) => {
        a.length = 3;
        a[2] = "c";
      },
      () =>
        function Ctor(this: unknown, n: number) {
          return new Array(n);
        },
    ),
    expect: ["h", "a!"],
  });
  await check({
    label: "a species getter answers null: a plain array",
    S: S1(restT),
    make: held(["h", "a"]),
    setup: species(
      () => {},
      () => null,
    ),
    expect: ["h", "a!"],
  });
  await check({
    label: "a species getter answers a non-constructor: slice's TypeError",
    S: S1(restT),
    make: held(["h", "a"]),
    setup: species(
      () => {},
      () => 5,
    ),
    throws: "TypeError",
  });
  // The species constructor: runs inside the native slice on both sides, after the length was read
  {
    const ctor = (effect: (a: unknown[]) => void) =>
      species(
        () => {},
        () =>
          function Ctor(this: unknown, n: number) {
            if (holder.input) effect(holder.input);
            return new Array(n);
          },
      );
    await check({
      label: "a species constructor rewrites a rest slot: read after it",
      S: S1(z.string()),
      make: held(["h", "a", "b"]),
      setup: ctor((a) => {
        a[2] = "M";
      }),
      expect: ["h", "a", "M"],
    });
    await check({
      label: "a species constructor rewrites the fixed slot: the held result is assembled",
      S: S1(z.string()),
      make: held(["h", "a"]),
      setup: ctor((a) => {
        a[0] = "M";
      }),
      expect: ["h", "a"],
    });
    await check({
      label: "a species constructor shrinks the length below the optional slot",
      S: SO(opt),
      make: held(["h", "x", "r"]),
      setup: ctor((a) => {
        a.length = 1;
      }),
      expect: ["h"],
    });
    await check({
      label: "a species constructor grows the length past the optional slot",
      S: SO(z.string()),
      make: held(["h"]),
      setup: ctor((a) => {
        a.length = 3;
      }),
      expect: ["h", undefined],
    });
  }

  // 5. The input's own `constructor`: the native slice reads it after the length and the species off it
  {
    const withCtor =
      (values: unknown[], get: (a: unknown[], log: string[]) => unknown) => (log: string[]) => {
        const a = [...values];
        Object.defineProperty(a, "constructor", {
          configurable: true,
          get() {
            log.push("get:constructor");
            return get(a, log);
          },
        });
        return a;
      };
    await check({
      label:
        "a constructor getter grows the length and answers Array: the count was fixed before it",
      S: S1(restO),
      make: withCtor(["h", "a"], (a) => {
        a.length = 3;
        return Array;
      }),
      expect: ["h", "a!"],
    });
    await check({
      label:
        "a constructor getter answers a plain function: slice reads its species (none) and builds a plain array",
      S: S1(restT),
      make: withCtor(["h", "a"], (_a, log) => {
        const f = () => {};
        Object.defineProperty(f, Symbol.species, {
          get() {
            log.push("ctor.species");
            return undefined;
          },
        });
        return f;
      }),
      expect: ["h", "a!"],
    });
    await check({
      label:
        "a constructor getter answers a function whose species getter rewrites the fixed slot and constructs",
      S: S1(restT),
      make: withCtor(["h", "a"], (a, log) => {
        const f = () => {};
        Object.defineProperty(f, Symbol.species, {
          get() {
            log.push("ctor.species");
            a[0] = "M";
            return function Ctor(this: unknown, n: number) {
              log.push(`construct:${n}`);
              return new Array(n);
            };
          },
        });
        return f;
      }),
      expect: ["h", "a!"],
    });
    await check({
      label: "an own constructor of undefined: a plain array",
      S: S1(restT),
      make: () => {
        const a: unknown[] = ["h", "a"];
        Object.defineProperty(a, "constructor", { configurable: true, value: undefined });
        return a;
      },
      expect: ["h", "a!"],
    });
    await check({
      label: "an own constructor of null: slice's TypeError",
      S: S1(restT),
      make: () => {
        const a: unknown[] = ["h", "a"];
        Object.defineProperty(a, "constructor", { configurable: true, value: null });
        return a;
      },
      throws: "TypeError",
    });
    await check({
      label:
        "a subclass instance whose constructor shrinks the length: the species constructor runs inside slice",
      S: SO(opt),
      make: (log) => {
        class Sub extends Array<unknown> {
          constructor(n?: number) {
            super(n ?? 0);
            log.push(`sub:${n}`);
            if (holder.input) holder.input.length = 1;
          }
        }
        const a = new Sub();
        a.push("h", "x", "r");
        holder.input = a;
        return a;
      },
      expect: ["h"],
    });
    holder.input = null;
  }

  // 6. A rest element's callback (a premise violation): the slice holds the rest, the fixed results are held, and
  // the length the callback leaves decides presence
  {
    const restCb = z.string().transform((v) => {
      if (v === "r") {
        const a = holder.input!;
        const e = (a as { effect?: (b: unknown[]) => void }).effect;
        e?.(a);
      }
      return `${v}!`;
    });
    const withEffect = (values: unknown[], effect: (a: unknown[]) => void) => () => {
      const a = held(values)();
      Object.defineProperty(a, "effect", { value: effect });
      return a;
    };
    await check({
      label:
        "a rest callback shrinks the length below the rest: stock's trailing loop walks past the items",
      S: S1(restCb),
      make: withEffect(["h", "r", "s"], (a) => {
        a.length = 1;
      }),
      throws: "TypeError",
    });
    await check({
      label: "a rest callback shrinks the length below the optional slot",
      S: SO(restCb),
      make: withEffect(["h", "x", "r"], (a) => {
        a.length = 1;
      }),
      expect: ["h"],
    });
    await check({
      label: "a rest callback grows the length",
      S: SO(restCb),
      make: withEffect(["h", "x", "r"], (a) => {
        a.length = 5;
      }),
      expect: ["h", "x", "r!"],
    });
    await check({
      label: "a rest callback writes a later rest slot: the slice held it",
      S: SO(restCb),
      make: withEffect(["h", "x", "r", "s"], (a) => {
        a[3] = "M";
      }),
      expect: ["h", "x", "r!", "s!"],
    });
    holder.input = null;
  }

  // 7. Proxy traps on the input: `has` then `get` per rest index in slice's order (the `length` reads are not
  // compared: stock's runtime reads it per presence decision, the skeleton once, §7 of the deep dive)
  {
    const proxied =
      (values: unknown[], traps: (log: string[]) => ProxyHandler<unknown[]>) => (log: string[]) =>
        new Proxy([...values], traps(log));
    const indexLog = (log: string[]) => (kind: string, k: PropertyKey) => {
      if (typeof k === "string" && k !== "length") log.push(`${kind}:${k}`);
    };
    await check({
      label: "a get trap for a rest index rewrites a later rest slot: read after it, like slice",
      S: S1(restT),
      make: proxied(["h", "a", "b"], (log) => {
        const at = indexLog(log);
        return {
          get(t, k, r) {
            if (k === "1") t[2] = "M";
            at("get", k);
            return Reflect.get(t, k, r);
          },
          has(t, k) {
            at("has", k);
            return Reflect.has(t, k);
          },
        };
      }),
      expect: ["h", "a!", "M!"],
    });
    await check({
      label: "a has trap that denies a rest index: a hole under both",
      S: S1(restO),
      make: proxied(["h", "a", "b"], (log) => {
        const at = indexLog(log);
        return {
          has(t, k) {
            at("has", k);
            return k === "1" ? false : Reflect.has(t, k);
          },
        };
      }),
      expect: ["h", "U", "b!"],
    });
    await check({
      label:
        "a length that grows once the first slot was read: the slice and the presence decision see the grown one",
      S: SO(opt),
      make: proxied(["h"], () => {
        let grown = false;
        return {
          get(t, k, r) {
            if (k === "0") grown = true;
            if (k === "length") return grown ? 3 : 1;
            return Reflect.get(t, k, r);
          },
        };
      }),
      expect: ["h", undefined, undefined],
    });
  }

  // 8. Holes and explicit `undefined` in the rest under the copy, and the reference on the clean path
  await check({
    label: "a rest hole comes out as an own undefined",
    S: S1(restO),
    make: () => arr("h", "a", HOLE, "c"),
    expect: ["h", "a!", "U", "c!"],
  });
  await check({
    label: "a rest hole under a validator rest",
    S: S1(opt),
    make: () => arr("h", HOLE),
    expect: ["h", undefined],
  });
  await check({
    label: "an explicit own undefined in the rest copies, like a hole (#95)",
    S: S1(opt),
    make: () => ["h", undefined],
    expect: ["h", undefined],
  });
  await check({
    label: "a dense rest keeps the reference",
    S: S1(z.string()),
    make: () => ["h", "a", "b"],
    ref: true,
  });
  await check({
    label: "a short input under the optional slot keeps the reference",
    S: SO(z.string()),
    make: () => ["h"],
    expect: ["h"],
    ref: true,
  });

  // 9. The array iterator and its `next` on the prototypes (sixth review of #88): stock's `for...of` over the
  // slice result reads `Symbol.iterator` once with the result as receiver, calls it, reads `next` once with the
  // iterator as receiver, calls it per step and closes through `return` when the rest element throws. The skeleton
  // makes the two reads on its copy with the same receivers (the copy is a plain array holding what the native
  // slice would hold, which is all an accessor can tell about its receiver), runs the index loop when both answered
  // the natives, and continues through a real `for...of` from what they answered otherwise, so a data or accessor
  // replacement of either, receiver-sensitive or not, meets the same reads, calls and engine errors
  {
    const ARRAY_ITERATOR_PROTOTYPE = Object.getPrototypeOf([][Symbol.iterator]()) as {
      next: () => IteratorResult<unknown>;
    };
    /** The log of the run under way, for a hook that lives on a prototype */
    const logOf: { log: string[] } = { log: [] };
    /** A fresh copy of `values` by index (the array iterator is under test), registered in `holder` */
    const logged = (values: unknown[]) => (log: string[]) => {
      logOf.log = log;
      const a: unknown[] = [];
      for (let i = 0; i < values.length; i++) a.push(values[i]);
      holder.input = a;
      return a;
    };
    const kindOf = (receiver: unknown): string =>
      receiver === Array.prototype
        ? "proto"
        : receiver === holder.input
          ? "input"
          : Array.isArray(receiver)
            ? "rest"
            : "other";
    /** `Array.prototype[Symbol.iterator]` redefined for the two parses from `define(native)`, restored from its
     *  descriptor; `define` gets the native iterator function */
    const arrayIterator =
      (define: (native: (this: unknown[]) => IterableIterator<unknown>) => PropertyDescriptor) =>
      () => {
        const desc = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator)!;
        Object.defineProperty(Array.prototype, Symbol.iterator, {
          configurable: true,
          ...define(desc.value),
        });
        return () => {
          Object.defineProperty(Array.prototype, Symbol.iterator, desc);
          holder.input = null;
        };
      };
    /** `%ArrayIteratorPrototype%.next` redefined the same way */
    const arrayNext =
      (define: (native: () => IteratorResult<unknown>) => PropertyDescriptor) => () => {
        const desc = Object.getOwnPropertyDescriptor(ARRAY_ITERATOR_PROTOTYPE, "next")!;
        Object.defineProperty(ARRAY_ITERATOR_PROTOTYPE, "next", {
          configurable: true,
          ...define(desc.value),
        });
        return () => {
          Object.defineProperty(ARRAY_ITERATOR_PROTOTYPE, "next", desc);
          holder.input = null;
        };
      };
    await check({
      syncOnly: true,
      label: "a data-property array iterator that yields something else",
      S: S1(z.string()),
      make: logged(["a", "b"]),
      setup: arrayIterator(() => ({
        value: function* (this: unknown[]) {
          logOf.log.push(`iter:${kindOf(this)}`);
          yield "changed";
        },
      })),
      expect: ["a", "changed"],
    });
    await check({
      syncOnly: true,
      label:
        "an accessor array iterator that answers the native one to the prototype and another to an array (the review's repro)",
      S: S1(z.string()),
      make: logged(["a", "b"]),
      setup: arrayIterator((native) => ({
        get(this: unknown) {
          logOf.log.push(`get:iterator:${kindOf(this)}`);
          return this === Array.prototype
            ? native
            : function* () {
                yield "changed";
              };
        },
      })),
      expect: ["a", "changed"],
    });
    await check({
      syncOnly: true,
      label: "an accessor array iterator under a transform rest",
      S: S1(restT),
      make: logged(["a", "b"]),
      setup: arrayIterator((native) => ({
        get(this: unknown) {
          logOf.log.push(`get:iterator:${kindOf(this)}`);
          return this === Array.prototype
            ? native
            : function* () {
                yield "changed";
              };
        },
      })),
      expect: ["a", "changed!"],
    });
    await check({
      syncOnly: true,
      label:
        "an accessor array iterator that answers the native one: read once, the input by reference",
      S: S1(z.string()),
      make: logged(["a", "b"]),
      setup: arrayIterator((native) => ({
        get(this: unknown) {
          logOf.log.push(`get:iterator:${kindOf(this)}`);
          return native;
        },
      })),
      expect: ["a", "b"],
      ref: true,
    });
    await check({
      syncOnly: true,
      label: "an array iterator that stops after the first element",
      S: S1(restT),
      make: logged(["a", "b", "c"]),
      setup: arrayIterator((native) => ({
        get(this: unknown) {
          logOf.log.push(`get:iterator:${kindOf(this)}`);
          return this === Array.prototype
            ? native
            : function* (this: unknown[]) {
                yield this[0];
              };
        },
      })),
      expect: ["a", "b!"],
    });
    await check({
      syncOnly: true,
      label:
        "an array iterator that yields one element more: stock's trailing loop walks past the items",
      S: S1(z.string()),
      make: logged(["a", "b"]),
      setup: arrayIterator((native) => ({
        get(this: unknown) {
          logOf.log.push(`get:iterator:${kindOf(this)}`);
          return this === Array.prototype
            ? native
            : function* (this: unknown[]) {
                yield* native.call(this);
                yield "extra";
              };
        },
      })),
      throws: "TypeError",
    });
    await check({
      syncOnly: true,
      label:
        "an array iterator that yields the copy's elements and then rewrites the fixed slot and the length",
      S: SO(restT),
      make: logged(["h", "x", "r"]),
      setup: arrayIterator((native) => ({
        get(this: unknown) {
          logOf.log.push(`get:iterator:${kindOf(this)}`);
          return this === Array.prototype
            ? native
            : function* (this: unknown[]) {
                yield* native.call(this);
                holder.input![0] = "M";
                holder.input!.length = 1;
              };
        },
      })),
      expect: ["h"],
    });
    await check({
      syncOnly: true,
      label: "a data-property next that rewrites every value",
      S: S1(z.string()),
      make: logged(["a", "b"]),
      setup: arrayNext((native) => ({
        value: function (this: unknown) {
          const r = native.call(this);
          logOf.log.push(`next:${r.done}`);
          return r.done ? r : { value: "changed", done: false };
        },
      })),
      expect: ["a", "changed"],
    });
    await check({
      syncOnly: true,
      label:
        "an accessor next that answers the native one to the prototype and another to an iterator (the review's second case)",
      S: S1(z.string()),
      make: logged(["a", "b"]),
      setup: arrayNext((native) => ({
        get(this: unknown) {
          logOf.log.push(`get:next:${this === ARRAY_ITERATOR_PROTOTYPE ? "proto" : "iterator"}`);
          return this === ARRAY_ITERATOR_PROTOTYPE
            ? native
            : function (this: unknown) {
                const r = native.call(this);
                return r.done ? r : { value: "changed", done: false };
              };
        },
      })),
      expect: ["a", "changed"],
    });
    await check({
      syncOnly: true,
      label: "an accessor next that answers the native one: read once, the input by reference",
      S: S1(z.string()),
      make: logged(["a", "b"]),
      setup: arrayNext((native) => ({
        get(this: unknown) {
          logOf.log.push(`get:next:${this === ARRAY_ITERATOR_PROTOTYPE ? "proto" : "iterator"}`);
          return native;
        },
      })),
      expect: ["a", "b"],
      ref: true,
    });
    await check({
      syncOnly: true,
      label:
        "an accessor next whose function shrinks the length below the optional slot after the rest",
      S: SO(restT),
      make: logged(["h", "x", "r"]),
      setup: arrayNext((native) => ({
        get(this: unknown) {
          return this === ARRAY_ITERATOR_PROTOTYPE
            ? native
            : function (this: unknown) {
                const r = native.call(this);
                if (r.done) holder.input!.length = 1;
                return r;
              };
        },
      })),
      expect: ["h"],
    });
    // The protocol's errors, the engine's own on both sides
    await check({
      syncOnly: true,
      label: "an accessor array iterator that answers a number: not iterable",
      S: S1(z.string()),
      make: logged(["a", "b"]),
      setup: arrayIterator((native) => ({
        get(this: unknown) {
          logOf.log.push(`get:iterator:${kindOf(this)}`);
          return this === Array.prototype ? native : 5;
        },
      })),
      throws: "TypeError",
    });
    await check({
      syncOnly: true,
      label: "an array iterator that answers a non-object: the engine's TypeError",
      S: S1(z.string()),
      make: logged(["a", "b"]),
      setup: arrayIterator((native) => ({
        get(this: unknown) {
          logOf.log.push(`get:iterator:${kindOf(this)}`);
          return this === Array.prototype ? native : () => 5;
        },
      })),
      throws: "TypeError",
    });
    await check({
      syncOnly: true,
      label: "an array iterator that is a class: the engine's TypeError on the call",
      S: S1(z.string()),
      make: logged(["a", "b"]),
      setup: arrayIterator((native) => ({
        get(this: unknown) {
          logOf.log.push(`get:iterator:${kindOf(this)}`);
          return this === Array.prototype ? native : class {};
        },
      })),
      throws: "TypeError",
    });
    await check({
      syncOnly: true,
      label: "an accessor next that answers a number: the engine's TypeError",
      S: S1(z.string()),
      make: logged(["a", "b"]),
      setup: arrayNext((native) => ({
        get(this: unknown) {
          logOf.log.push(`get:next:${this === ARRAY_ITERATOR_PROTOTYPE ? "proto" : "iterator"}`);
          return this === ARRAY_ITERATOR_PROTOTYPE ? native : 5;
        },
      })),
      throws: "TypeError",
    });
    await check({
      syncOnly: true,
      label: "a next that answers a non-object result after one value: the engine's TypeError",
      S: S1(restT),
      make: logged(["a", "b", "c"]),
      setup: arrayNext((native) => ({
        get(this: unknown) {
          logOf.log.push(`get:next:${this === ARRAY_ITERATOR_PROTOTYPE ? "proto" : "iterator"}`);
          let n = 0;
          return this === ARRAY_ITERATOR_PROTOTYPE
            ? native
            : function (this: unknown) {
                logOf.log.push(`next:${n}`);
                return n++ === 0 ? native.call(this) : null;
              };
        },
      })),
      throws: "TypeError",
    });
    // `return` on the iterator prototype: stock's `for...of` reads it off the iterator when the rest element throws
    {
      const withReturn = (setup: () => () => void) => () => {
        const undo = setup();
        Object.defineProperty(ARRAY_ITERATOR_PROTOTYPE, "return", {
          configurable: true,
          get(this: unknown) {
            logOf.log.push(
              `get:return:${this === ARRAY_ITERATOR_PROTOTYPE ? "proto" : "iterator"}`,
            );
            return function (this: unknown) {
              logOf.log.push("return");
              return { done: true, value: undefined };
            };
          },
        });
        return () => {
          delete (ARRAY_ITERATOR_PROTOTYPE as { return?: unknown }).return;
          undo();
        };
      };
      const throwing = z.string().transform((v) => {
        if (v === "b") throw new RangeError("rest");
        return `${v}!`;
      });
      await check({
        syncOnly: true,
        label:
          "a return on the array iterator prototype under the native iteration: read and called on the throw",
        S: S1(throwing),
        make: logged(["a", "b"]),
        setup: withReturn(() => () => {}),
        throws: "RangeError",
      });
      await check({
        syncOnly: true,
        label:
          "a return on the array iterator prototype under a replaced next: read and called on the throw",
        S: S1(throwing),
        make: logged(["a", "b"]),
        setup: withReturn(
          arrayNext((native) => ({
            get(this: unknown) {
              logOf.log.push(
                `get:next:${this === ARRAY_ITERATOR_PROTOTYPE ? "proto" : "iterator"}`,
              );
              return this === ARRAY_ITERATOR_PROTOTYPE
                ? native
                : function (this: unknown) {
                    return native.call(this);
                  };
            },
          })),
        ),
        throws: "RangeError",
      });
      await check({
        syncOnly: true,
        label: "a return on the array iterator prototype is not read when nothing throws",
        S: S1(restT),
        make: logged(["a", "b"]),
        setup: withReturn(() => () => {}),
        expect: ["a", "b!"],
      });
    }
  }
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

head(
  "a plain function returning a Promise: the async entries run that parse on stock's async runtime (fourth review of #76)",
);
{
  // Neither zod's compiler nor this layer detects a plain function that returns a Promise statically (both test
  // `AsyncFunction`), so the schema compiles as sync (`async === false`) and the fast path meets the Promise at
  // runtime, where the official code throws `$ZodAsyncError`. Stock's own `z.compile()` never runs its fast path on
  // an async parse; here the async entries catch that throw (or the INVALID a plain-Promise transform answers) and
  // hand the parse to stock `safeParseAsync`, whose output and issues are stock's. The sync entries throw stock's
  // class, `validate` included: the official assertOnly product answers INVALID for a Promise from a transform, so a
  // tree holding a plain transform consults stock's sync parse before answering null, and the throw surfaces (#79).
  // A transform inside a `lazy` used to be the residual (`validate` threw a `TypeError` there, #90); the lazy
  // group below pins it at every position since an official subtree holding a `lazy` takes an island.
  type Case = {
    name: string;
    make: (ok: boolean) => z.ZodType;
    input: () => unknown;
  };
  const plain = (ok: boolean) => () => Promise.resolve(ok);
  const cases: Case[] = [
    {
      name: "top-level array refine",
      make: (ok) => z.array(z.string()).refine(plain(ok)),
      input: () => ["x"],
    },
    {
      name: "leaf refine under an object key",
      make: (ok) => z.object({ a: z.string().refine(plain(ok)) }),
      input: () => ({ a: "x" }),
    },
    {
      name: "refine on optional(object)",
      make: (ok) => z.object({ a: z.string() }).optional().refine(plain(ok)),
      input: () => ({ a: "x" }),
    },
    {
      name: "custom check returning a Promise",
      make: (ok) =>
        z.array(z.string()).check((ctx) => {
          if (!ok) ctx.issues.push({ code: "custom", input: ctx.value, message: "no" });
          return Promise.resolve();
        }),
      input: () => ["x"],
    },
    {
      name: "transform returning a Promise",
      make: () => z.array(z.string()).transform((v) => Promise.resolve([...v, "t"])),
      input: () => ["x"],
    },
    {
      name: "pipe into a transform returning a Promise",
      make: () => z.array(z.string()).pipe(z.transform((v) => Promise.resolve(v.length))),
      input: () => ["x"],
    },
    {
      name: "preprocess returning a Promise",
      make: () => z.preprocess((v) => Promise.resolve(v), z.array(z.string())),
      input: () => ["x"],
    },
    {
      // a codec is a `pipe` node whose decode function sits on the pipe def itself, not in a child transform node
      name: "codec decode returning a Promise",
      make: () =>
        z.codec(z.string(), z.number(), {
          decode: (v) => Promise.resolve(Number(v)),
          encode: String,
        }),
      input: () => "1",
    },
    {
      name: "codec decode returning a Promise under an array",
      make: () =>
        z.array(
          z.codec(z.string(), z.number(), {
            decode: (v) => Promise.resolve(Number(v)),
            encode: String,
          }),
        ),
      input: () => ["1"],
    },
    {
      name: "transform returning a Promise inside a union option",
      make: () => z.union([z.number(), z.array(z.string()).transform((v) => Promise.resolve(v))]),
      input: () => ["x"],
    },
    {
      name: "transform returning a Promise under a wrapper the runtime answers (#69)",
      // zod's typings reject `.check(z.minLength(n))` on a wrapper; the runtime accepts it (as in the #69 smoke)
      make: () =>
        z.object({
          a: (
            z
              .array(z.string())
              .transform((v) => Promise.resolve(v))
              .optional() as any
          ).check(z.minLength(1)) as z.ZodType,
        }),
      input: () => ({ a: ["x"] }),
    },
  ];
  for (const c of cases) {
    for (const okCase of [true, false]) {
      const S = c.make(okCase);
      const C = compile(S);
      assert.equal(C.async, false, `${c.name}: not detected statically`);
      assert.equal(C.stock, false, `${c.name}: not degraded`);
      const stock = await S.safeParseAsync(c.input());
      const r = await C.safeParseAsync(c.input());
      assert.equal(r.success, stock.success, `${c.name} ok=${okCase}: same verdict as stock`);
      if (r.success && stock.success) {
        assert.deepEqual(r.data, stock.data, `${c.name}: stock's output`);
        assert.deepEqual(await C.parseAsync(c.input()), stock.data, `${c.name}: parseAsync too`);
      } else if (!r.success && !stock.success) {
        assert.deepEqual(r.error.issues, stock.error.issues, `${c.name}: stock's issues`);
        await assert.rejects(
          C.parseAsync(c.input()),
          (e) => e instanceof z.ZodError,
          `${c.name}: parseAsync rejects with the ZodError`,
        );
      }
      assert.throws(
        () => S.safeParse(c.input()),
        $ZodAsyncError,
        `${c.name}: stock's sync API throws $ZodAsyncError`,
      );
      assert.throws(
        () => C.safeParse(c.input()),
        $ZodAsyncError,
        `${c.name}: safeParse throws stock's class`,
      );
      assert.throws(
        () => C.parse(c.input()),
        $ZodAsyncError,
        `${c.name}: parse throws stock's class`,
      );
      assert.throws(
        () => C.validate(c.input()),
        $ZodAsyncError,
        `${c.name}: validate throws stock's class`,
      );
    }
    ok(c.name);
  }

  // The consultation is stock's sync parse, so a rejected input of a transform-holding schema still answers null,
  // and the callbacks the validator ran before the rejection run again there (the failure-path duplicate of the
  // README); a transform-free schema keeps the one validator run
  {
    let calls = 0;
    const T = z
      .array(z.string())
      .refine(() => {
        calls++;
        return false;
      })
      .transform((v) => Promise.resolve(v));
    const CT = compile(T);
    assert.ok(!CT.async && !CT.stock);
    assert.equal(CT.validate(["x"]), null, "a rejected input answers null");
    assert.equal(calls, 2, "the validator and stock's parse each ran the predicate");
    calls = 0;
    assert.equal(CT.validate(5), null, "a type mismatch answers null");
    assert.equal(calls, 0);
    calls = 0;
    const F = z.array(z.string()).refine(() => {
      calls++;
      return false;
    });
    const CF = compile(F);
    assert.equal(CF.validate(["x"]), null);
    assert.equal(calls, 1, "a transform-free schema runs the validator only");
    // An async-function transform is detected statically: the tree is async and every sync entry throws
    const A = z.array(z.string()).transform(async (v) => v);
    const CA = compile(A);
    assert.ok(CA.async);
    assert.throws(() => CA.validate(["x"]), $ZodAsyncError);
    ok(
      "validate: a rejected input of a transform-holding schema answers null through stock's parse",
    );
  }

  // The predicate runs on the fast path up to the throw and again in stock: the failure-path duplicate of the README
  const log: string[] = [];
  const S = z
    .array(z.string())
    .refine((v) => {
      log.push(`A${v.length}`);
      return true;
    })
    .refine(() => {
      log.push("B");
      return Promise.resolve(true);
    });
  const C = compile(S);
  assert.ok(!C.async && !C.stock);
  await S.safeParseAsync(["x"]);
  assert.deepEqual(log, ["A1", "B"]);
  log.length = 0;
  const r = await C.safeParseAsync(["x"]);
  assert.ok(r.success);
  assert.deepEqual(
    log,
    ["A1", "B", "A1", "B"],
    "the fast path ran both predicates before the throw, then stock ran them",
  );
  assert.ok(!C.code?.includes("_zod"), "the skeleton is still the CoW skeleton");
  ok(
    "callbacks called before the throw run again in stock (the documented failure-path duplicate)",
  );

  // Inside an async skeleton the same leaf reaches the official validator, which throws too; the async entry catches it there as well
  const M = z.object({ a: z.string().refine(plain(true)), b: z.string().refine(async () => true) });
  const MC = compile(M);
  assert.ok(MC.async && !MC.stock);
  const stockM = await M.safeParseAsync({ a: "x", b: "y" });
  const rM = await MC.safeParseAsync({ a: "x", b: "y" });
  assert.ok(rM.success && stockM.success);
  assert.deepEqual(rM.data, stockM.data);
  const badM = await MC.safeParseAsync({ a: 1, b: "y" });
  const stockBadM = await M.safeParseAsync({ a: 1, b: "y" });
  assert.ok(!badM.success && !stockBadM.success);
  assert.deepEqual(badM.error.issues, stockBadM.error.issues);
  ok("a plain-Promise leaf inside an async skeleton");

  // A sync schema failing the ordinary way through the async entries still answers stock's issues
  const F = z.object({ a: z.string().min(2) });
  const FC = compile(F);
  const rF = await FC.safeParseAsync({ a: "x" });
  const stockF = await F.safeParseAsync({ a: "x" });
  assert.ok(!rF.success && !stockF.success);
  assert.deepEqual(rF.error.issues, stockF.error.issues);
  ok("the async entries of a sync skeleton keep stock's issues on an ordinary failure");
}

head(
  "a $ZodAsyncError a callback throws is the caller's, not the fast path's Promise signal (fifth review of #76)",
);
{
  // The async entries hand a parse to stock's async runtime when the fast path met a Promise a plain function
  // returned, which the official code and this layer's `throwAsync` report by throwing `$ZodAsyncError`, stock's
  // public class. A callback can throw the same class itself (a nested sync parse of an async schema does), and
  // that throw is the caller's: stock rejects with it after one call. Every call site of this layer that runs a
  // callback (the checks subroutine of the containers, the wrappers and the unions) or awaits one (the settlement
  // of an async predicate, an async island) records a `$ZodAsyncError` the callback threw or rejected with, and the
  // async entries rethrow a recorded one instead of rerunning the parse.
  const nested = z.string().refine(async () => true);
  const throwers: [string, () => void][] = [
    ["a nested sync parse of an async schema", () => nested.parse("x")],
    [
      "an explicit throw",
      () => {
        throw new $ZodAsyncError();
      },
    ],
  ];
  // Throws on the first call only, so a rerun would pass: the review's reproduction
  const once = (log: string[], thrower: () => void) => () => {
    log.push("c");
    if (log.length === 1) thrower();
    return true;
  };
  type Case = {
    name: string;
    make: (fn: () => boolean) => z.ZodType;
    input: () => unknown;
    async: boolean;
  };
  const cases: Case[] = [
    {
      name: "array refine",
      make: (fn) => z.array(z.string()).refine(fn),
      input: () => ["x"],
      async: false,
    },
    {
      name: "record refine",
      make: (fn) => z.record(z.string(), z.number()).refine(fn),
      input: () => ({ a: 1 }),
      async: false,
    },
    {
      name: "refine on optional(object)",
      make: (fn) => z.object({ a: z.string() }).optional().refine(fn),
      input: () => ({ a: "x" }),
      async: false,
    },
    {
      name: "refine on a union's container option",
      make: (fn) => z.union([z.array(z.string()).refine(fn), z.number()]),
      input: () => ["x"],
      async: false,
    },
    {
      name: "sync container refine inside an async skeleton",
      make: (fn) =>
        z.object({ a: z.string().refine(async () => true), b: z.array(z.string()).refine(fn) }),
      input: () => ({ a: "x", b: ["y"] }),
      async: true,
    },
    {
      name: "a plain predicate before an async one in the same subroutine",
      make: (fn) =>
        z
          .array(z.string())
          .refine(fn)
          .refine(async () => true),
      input: () => ["x"],
      async: true,
    },
    {
      name: "an async predicate rejecting",
      make: (fn) => z.array(z.string()).refine(async () => fn()),
      input: () => ["x"],
      async: true,
    },
    {
      name: "an async island rejecting (lazy over an async refine)",
      make: (fn) => z.object({ a: z.lazy(() => z.string().refine(async () => fn())) }),
      input: () => ({ a: "x" }),
      async: true,
    },
    // The interpreter calls the callback before the island's run has come back, so the throw leaves
    // `_zod.run` synchronously, never as a rejection (sixth review of #76). A bare `lazy` is this layer's
    // island whether or not its subtree is async (stock's own product for it is a runtime island too).
    {
      name: "a lazy island inside an async skeleton (the sixth review's reproduction)",
      make: (fn) =>
        z.object({
          a: z.lazy(() => z.string().refine(fn)),
          b: z.string().refine(async () => true),
        }),
      input: () => ({ a: "x", b: "y" }),
      async: true,
    },
    {
      name: "a lazy island in a sync skeleton",
      make: (fn) => z.object({ a: z.lazy(() => z.string().refine(fn)) }),
      input: () => ({ a: "x" }),
      async: false,
    },
    {
      name: "a lazy island at the top level",
      make: (fn) => z.lazy(() => z.string().refine(fn)),
      input: () => "x",
      async: false,
    },
    {
      name: "an async island throwing synchronously (a sync predicate before an async one under a lazy)",
      make: (fn) =>
        z.object({
          a: z.lazy(() =>
            z
              .string()
              .refine(fn)
              .refine(async () => true),
          ),
        }),
      input: () => ({ a: "x" }),
      async: true,
    },
    // A sync island: a subtree stock's compiler declines for a non-async reason (an exclusive union)
    {
      name: "a sync island in a sync skeleton (a refine on an xor)",
      make: (fn) => z.object({ a: z.xor([z.string(), z.number()]).refine(fn) }),
      input: () => ({ a: "x" }),
      async: false,
    },
    {
      name: "a sync island inside an async skeleton",
      make: (fn) =>
        z.object({
          a: z.xor([z.string(), z.number()]).refine(fn),
          b: z.string().refine(async () => true),
        }),
      input: () => ({ a: "x", b: "y" }),
      async: true,
    },
    {
      name: "a sync island at the top level",
      make: (fn) => z.xor([z.string(), z.number()]).refine(fn),
      input: () => "x",
      async: false,
    },
  ];
  for (const c of cases) {
    for (const [tname, thrower] of throwers) {
      const label = `${c.name}, ${tname}`;
      const stockLog: string[] = [];
      const S = c.make(once(stockLog, thrower));
      await assert.rejects(S.safeParseAsync(c.input()), $ZodAsyncError, `${label}: stock rejects`);
      assert.equal(stockLog.length, 1, `${label}: stock calls the callback once`);

      const log: string[] = [];
      const C = compile(c.make(once(log, thrower)));
      assert.equal(C.async, c.async, `${label}: async flag`);
      assert.equal(C.stock, false, `${label}: not degraded`);
      await assert.rejects(
        C.safeParseAsync(c.input()),
        $ZodAsyncError,
        `${label}: safeParseAsync rejects with the callback's error`,
      );
      assert.equal(log.length, 1, `${label}: the callback ran once, no rerun in stock`);
      log.length = 0;
      await assert.rejects(C.parseAsync(c.input()), $ZodAsyncError, `${label}: parseAsync too`);
      assert.equal(log.length, 1, `${label}: parseAsync ran the callback once`);
      if (!c.async) {
        // The sync entries throw the callback's error like stock's sync API, unchanged
        log.length = 0;
        assert.throws(() => C.parse(c.input()), $ZodAsyncError, `${label}: parse throws it`);
        assert.equal(log.length, 1);
      }
    }
    ok(c.name);
  }

  // The thrown object itself comes back, not a fresh error
  {
    const mine = new $ZodAsyncError();
    const C = compile(
      z.array(z.string()).refine(() => {
        throw mine;
      }),
    );
    await assert.rejects(
      C.safeParseAsync(["x"]),
      (e) => e === mine,
      "the callback's own error object",
    );
    ok("the caller's error object is the one rejected with");
  }

  // The Promise signal still falls back: a plain function returning a Promise in the same positions
  {
    const C = compile(z.array(z.string()).refine(() => Promise.resolve(true)));
    const r = await C.safeParseAsync(["x"]);
    assert.ok(
      r.success,
      "a plain Promise from the checks subroutine still reaches stock's async runtime",
    );
    const M = compile(
      z.object({
        a: z.string().refine(async () => true),
        b: z.array(z.string()).refine(() => Promise.resolve(true)),
      }),
    );
    const rM = await M.safeParseAsync({ a: "x", b: ["y"] });
    assert.ok(rM.success, "the same inside an async skeleton");
    // Through a sync island the interpreter chains the Promise and the island throws the signal on the thenable
    // it gets back, so a plain Promise there still reaches stock's async runtime, whereas a throw that leaves
    // `_zod.run` synchronously is the callback's (sixth review of #76)
    const islandCases: [string, z.ZodType, unknown, boolean][] = [
      [
        "a plain-Promise refine on an xor under an object key",
        z.object({ a: z.xor([z.string(), z.number()]).refine(() => Promise.resolve(true)) }),
        { a: "x" },
        false,
      ],
      [
        "a plain-Promise transform on an xor under an object key",
        z.object({ a: z.xor([z.string(), z.number()]).transform((v) => Promise.resolve(v)) }),
        { a: "x" },
        false,
      ],
      [
        "a plain-Promise refine on a top-level xor",
        z.xor([z.string(), z.number()]).refine(() => Promise.resolve(true)),
        "x",
        false,
      ],
      // Stock's own product for a lazy reads `.issues` off the thenable and throws a TypeError here
      [
        "a plain-Promise refine under a lazy",
        z.object({ a: z.lazy(() => z.string().refine(() => Promise.resolve(true))) }),
        { a: "x" },
        false,
      ],
      [
        "a plain-Promise refine under a lazy inside an async skeleton",
        z.object({
          a: z.lazy(() => z.string().refine(() => Promise.resolve(true))),
          b: z.string().refine(async () => true),
        }),
        { a: "x", b: "y" },
        true,
      ],
    ];
    for (const [name, S, input, isAsync] of islandCases) {
      const stock = await S.safeParseAsync(input);
      assert.ok(stock.success, `${name}: stock`);
      const CI = compile(S);
      assert.equal(CI.async, isAsync, `${name}: async flag`);
      assert.equal(CI.stock, false, `${name}: not degraded`);
      const rI = await CI.safeParseAsync(input);
      assert.ok(rI.success, `${name}: still reaches stock's async runtime`);
      assert.deepEqual(rI.data, stock.data, `${name}: stock's output`);
      assert.throws(
        () => CI.parse(input),
        $ZodAsyncError,
        `${name}: the sync API throws stock's class`,
      );
    }
    ok("the fast path's own Promise signal still reaches stock's async runtime");
  }

  // #80: a callback stock's generated code calls (a leaf `.refine`, `.check`, `.superRefine`, `z.custom`
  // predicate, a custom string format's predicate, `overwrite` or `transform` inside an official product) reports
  // its Promise signal from stock's own
  // hoisted `throwAsync`, so a `$ZodAsyncError` such a callback throws used to be indistinguishable from the fast
  // path's signal and took the fallback: the callback ran twice, and one that throws on the first call only passed
  // on the rerun where stock rejects. It is recorded now. Stock's compiler reads those callbacks off writable `def`
  // slots at compile time only (it hoists the reference into the generated closure), so `officialFn` /
  // `compileAssertOnlyRecording` wrap each non-async callback for the duration of the compile: the generated code
  // captures the recording wrapper as a constant and the slot is restored at once, leaving the caller's schema
  // untouched. A callback stock would run inside a runtime island (an islandable refusal at or above it, e.g. a
  // coercion sibling) cannot be reached that way, so the whole subtree is routed to this layer's island, whose
  // `runIsland` records the throw. Both a throw on every call and a throw on the first call only now reject after
  // one call, like stock.
  {
    const always = (log: string[]) => () => {
      log.push("c");
      nested.parse("x");
      return true;
    };
    const superRefineOnce = (log: string[]) => (_v: unknown) => {
      log.push("c");
      if (log.length === 1) nested.parse("x");
    };
    // Every position: the callback is inlined into an official product (compiled fast path) or, for the coercion
    // case, run inside a runtime island of one. The last row is the one position stock runtime-islands the
    // callback (`z.coerce.string()` refuses islandable), so it exercises the `wouldRuntimeIslandCallback` route.
    const leafCases: [string, (fn: () => boolean) => z.ZodType, unknown][] = [
      ["top-level leaf refine", (fn) => z.string().refine(fn), "x"],
      [
        "leaf refine under an object key",
        (fn) => z.object({ a: z.string().refine(fn) }),
        { a: "x" },
      ],
      ["leaf refine in an array", (fn) => z.array(z.string().refine(fn)), ["x"]],
      [
        "leaf refine in a union of leaves",
        (fn) => z.union([z.string().refine(fn), z.number()]),
        "x",
      ],
      [
        "leaf overwrite (tx) that throws",
        (fn) =>
          z.string().overwrite((v) => {
            fn();
            return v;
          }),
        "x",
      ],
      [
        "leaf transform that throws",
        (fn) =>
          z.string().transform((v) => {
            fn();
            return v;
          }),
        "x",
      ],
      ["z.custom predicate that throws", (fn) => z.custom<unknown>((v) => fn() && v === "x"), "x"],
      // A custom string format is a `string` schema carrying its predicate on its own `def.fn` (third review of #112).
      [
        "custom string format (z.stringFormat) at the top level",
        (fn) => z.stringFormat("fmt", (v) => fn() && v.length > 0),
        "x",
      ],
      [
        "custom string format under an object key",
        (fn) => z.object({ a: z.stringFormat("fmt", (v) => fn() && v.length > 0) }),
        { a: "x" },
      ],
      [
        "custom string format in an array",
        (fn) => z.array(z.stringFormat("fmt", (v) => fn() && v.length > 0)),
        ["x"],
      ],
      [
        "custom string format used as a check",
        (fn) => z.string().check(z.stringFormat("fmt", (v) => fn() && v.length > 0)),
        "x",
      ],
      [
        "leaf refine under a coercion (stock runtime-islands it)",
        (fn) =>
          z.object({ a: z.coerce.string().refine(fn) as unknown as z.ZodType }).overwrite((v) => v),
        { a: "x" },
      ],
    ];
    for (const [name, make, input] of leafCases) {
      // throws on every call → both sides reject after one call
      const stockAlways: string[] = [];
      await assert.rejects(make(always(stockAlways)).safeParseAsync(input), $ZodAsyncError);
      assert.equal(stockAlways.length, 1, `${name}: stock runs the callback once`);
      const log: string[] = [];
      const C = compile(make(always(log)));
      assert.ok(!C.async && !C.stock, `${name}: sync compiled product`);
      await assert.rejects(C.safeParseAsync(input), $ZodAsyncError, `${name}: the same rejection`);
      assert.equal(log.length, 1, `${name}: the callback ran once, no rerun (#80)`);
      // throws on the first call only → the parse rejects, not the pre-#80 success on the rerun
      const onceLog: string[] = [];
      const CO = compile(make(once(onceLog, () => nested.parse("x"))));
      await assert.rejects(
        CO.safeParseAsync(input),
        $ZodAsyncError,
        `${name}: a first-call-only throw rejects, no rerun (#80)`,
      );
      assert.equal(onceLog.length, 1, `${name}: one call`);
    }
    // superRefine carries its callback on `_zod.check`, not `def.fn`; pinned separately
    {
      const stockLog: string[] = [];
      await assert.rejects(
        z.string().superRefine(superRefineOnce(stockLog)).safeParseAsync("x"),
        $ZodAsyncError,
      );
      assert.equal(stockLog.length, 1);
      const log: string[] = [];
      const C = compile(z.string().superRefine(superRefineOnce(log)));
      assert.ok(!C.async && !C.stock);
      await assert.rejects(
        C.safeParseAsync("x"),
        $ZodAsyncError,
        "superRefine: the same rejection",
      );
      assert.equal(log.length, 1, "superRefine: one call, no rerun (#80)");
    }
    // The wrappers live for the duration of the compile only: every slot stock's compiler reads (`def.fn`,
    // `_zod.check`, `def.tx`, `def.transform`) reads back as the caller's own function once `compile()` returned,
    // while the compiled product keeps recording through the wrapper it captured (review of #112).
    {
      const f = (v: string) => v.length > 0;
      const g = (_v: unknown) => {};
      const tx = (v: string) => v;
      const tr = (v: string) => v;
      const cust = (v: unknown) => typeof v === "string";
      const S = z.object({
        a: z.string().refine(f).superRefine(g).overwrite(tx),
        b: z.string().transform(tr),
        c: z.custom<string>(cust),
      });
      const slotsOf = (): unknown[] => {
        const a = (S.shape.a as any)._zod.def.checks;
        return [
          a[0]._zod.def.fn,
          a[1]._zod.check,
          a[2]._zod.def.tx,
          (S.shape.b as any)._zod.def.out._zod.def.transform,
          (S.shape.c as any)._zod.def.fn,
        ];
      };
      const before = slotsOf();
      // superRefine stores a closure of its own around `g` on `_zod.check`; the other slots hold the functions as given
      assert.ok(before.every((x) => typeof x === "function"));
      assert.ok(before[0] === f && before[2] === tx && before[3] === tr && before[4] === cust);
      const C = compile(S);
      assert.ok(!C.async && !C.stock);
      assert.deepEqual(C.parse({ a: "x", b: "x", c: "x" }), { a: "x", b: "x", c: "x" });
      assert.deepEqual(C.validate({ a: "x", b: "x", c: "x" }), { a: "x", b: "x", c: "x" });
      const after = slotsOf();
      for (let i = 0; i < before.length; i++)
        assert.ok(
          after[i] === before[i],
          `slot ${i} reads back as the caller's function after compile`,
        );
    }
    // The install is all or none (review of #112): a slot that refuses the wrapper (a frozen `def`, which stock's
    // `compileFn` never writes, so such a schema parses on stock) undoes the slots already wrapped, nothing leaks
    // into the caller's schema, `compile()` does not throw, and the subtree takes this layer's island, whose
    // `runIsland` records the callback's own throw. Both orders: the frozen slot after a writable one (the
    // writable one is wrapped, then undone) and before it (nothing was wrapped).
    {
      const keep = (v: string) => v.length > 0;
      const frozenPair = (cb: () => boolean, frozenAt: 0 | 1): z.ZodType => {
        const s =
          frozenAt === 0 ? z.string().refine(cb).refine(keep) : z.string().refine(keep).refine(cb);
        Object.freeze((s as any)._zod.def.checks[frozenAt]._zod.def);
        return s;
      };
      for (const frozenAt of [0, 1] as const) {
        const plain = frozenPair(() => true, frozenAt);
        const fns = (plain as any)._zod.def.checks.map((c: any) => c._zod.def.fn);
        const C = compile(plain);
        assert.ok(!C.async && !C.stock, `frozen def at ${frozenAt}: compiles like stock`);
        assert.deepEqual(
          (plain as any)._zod.def.checks.map((c: any) => c._zod.def.fn),
          fns,
          `frozen def at ${frozenAt}: no wrapper leaks into the schema`,
        );
        assert.equal(C.parse("x"), "x");
        assert.equal(C.validate("x"), "x");
        assert.equal(plain.parse("x"), "x", "stock parses the frozen schema too");
        const positions: [string, (s: z.ZodType) => z.ZodType, unknown][] = [
          ["top level", (s) => s, "x"],
          ["under an object key", (s) => z.object({ a: s }), { a: "x" }],
          ["in an array", (s) => z.array(s), ["x"]],
        ];
        for (const [name, make, input] of positions) {
          const log: string[] = [];
          const CA = compile(make(frozenPair(always(log), frozenAt)));
          await assert.rejects(
            CA.safeParseAsync(input),
            $ZodAsyncError,
            `${name}: the same rejection`,
          );
          assert.equal(
            log.length,
            1,
            `${name}, frozen def at ${frozenAt}: one call through the island`,
          );
          const onceLog: string[] = [];
          const CO = compile(
            make(
              frozenPair(
                once(onceLog, () => nested.parse("x")),
                frozenAt,
              ),
            ),
          );
          await assert.rejects(CO.safeParseAsync(input), $ZodAsyncError);
          assert.equal(
            onceLog.length,
            1,
            `${name}, frozen def at ${frozenAt}: a first-call-only throw rejects`,
          );
        }
      }
      // The container above a frozen leaf keeps its skeleton and the CoW reference.
      const CK = compile(z.object({ a: frozenPair(() => true, 1), b: z.number() }));
      const input = { a: "x", b: 1 };
      assert.ok(
        CK.parse(input) === input,
        "the object above a frozen leaf keeps the CoW reference",
      );
      assert.throws(
        () => CK.parse({ a: "", b: 1 }),
        "the frozen leaf still validates through the island",
      );
    }
    // The install refuses a slot that fights the write in any way, with nothing leaked, and the restore puts every
    // slot back as it was, not only its value (third review of #112). Proxy traps on the second check's `def`: a
    // `set` that throws, a `set` that swallows the write, a `get` that throws on the read verifying the write, a
    // `getOwnPropertyDescriptor` that throws. The first check's `def` is plain, so a leak would show there.
    {
      const keep = (v: string) => v.length > 0;
      const zodOf = (s: z.ZodType, i: number): any => (s as any)._zod.def.checks[i]._zod;
      const refusals: [string, () => ProxyHandler<any>][] = [
        [
          "a set trap that throws",
          () => ({
            set: () => {
              throw new Error("no write");
            },
          }),
        ],
        ["a set trap that swallows the write", () => ({ set: () => true })],
        [
          "a get trap that throws on the read after the write",
          () => {
            let armed = false;
            return {
              set: (t, k, v) => {
                t[k] = v;
                if (k === "fn") armed = true;
                return true;
              },
              get: (t, k) => {
                if (k === "fn" && armed) {
                  armed = false;
                  throw new Error("no read");
                }
                return t[k];
              },
            };
          },
        ],
        [
          "a getOwnPropertyDescriptor trap that throws",
          () => ({
            getOwnPropertyDescriptor: () => {
              throw new Error("no descriptor");
            },
          }),
        ],
      ];
      for (const [name, handler] of refusals) {
        const make = (cb: () => boolean): z.ZodType => {
          const s = z.string().refine(keep).refine(cb);
          const z1 = zodOf(s, 1);
          z1.def = new Proxy(z1.def, handler());
          return s;
        };
        const plain = make(() => true);
        const f0 = zodOf(plain, 0).def.fn;
        assert.equal(plain.parse("x"), "x", `${name}: stock parses the schema`);
        const C = compile(plain);
        assert.ok(!C.async && !C.stock, `${name}: compiles`);
        assert.ok(
          zodOf(plain, 0).def.fn === f0,
          `${name}: the plain slot reads back as the caller's function`,
        );
        assert.equal(C.parse("x"), "x");
        assert.throws(
          () => C.parse(""),
          `${name}: the refined leaf still validates through the island`,
        );
        const log: string[] = [];
        const CA = compile(make(always(log)));
        await assert.rejects(CA.safeParseAsync("x"), $ZodAsyncError, `${name}: the same rejection`);
        assert.equal(log.length, 1, `${name}: one call through the island`);
        const onceLog: string[] = [];
        const CO = compile(make(once(onceLog, () => nested.parse("x"))));
        await assert.rejects(CO.safeParseAsync("x"), $ZodAsyncError);
        assert.equal(onceLog.length, 1, `${name}: a first-call-only throw rejects`);
      }
      // An inherited slot is inherited again after the compile, not an own property; the wrapper was in force.
      {
        const inherit = (cust: z.ZodType): { def: any; fn: unknown } => {
          const def = (cust as any)._zod.def;
          const fn = def.fn;
          delete def.fn;
          Object.setPrototypeOf(def, { fn });
          return { def, fn };
        };
        const cust = z.custom<string>((v) => typeof v === "string");
        const { def, fn } = inherit(cust);
        assert.ok(
          cust.safeParse("x").success && !cust.safeParse(1).success,
          "stock reads the inherited slot",
        );
        const C = compile(cust);
        assert.ok(!C.stock);
        assert.equal(C.parse("x"), "x");
        assert.throws(() => C.parse(1));
        assert.ok(
          !Object.hasOwn(def, "fn") && def.fn === fn,
          "an inherited slot is inherited again after compile, not an own property",
        );
        const onceLog: string[] = [];
        const custOnce = z.custom<unknown>(once(onceLog, () => nested.parse("x")));
        inherit(custOnce);
        await assert.rejects(compile(custOnce).safeParseAsync("x"), $ZodAsyncError);
        assert.equal(
          onceLog.length,
          1,
          "inherited slot: a first-call-only throw rejects after one call",
        );
      }
      // An accessor slot keeps its getter and setter and answers the caller's function; a non-enumerable data slot
      // keeps its attributes.
      {
        const accessor = (
          s: z.ZodType,
        ): { def: any; get: () => unknown; set: (v: unknown) => void } => {
          const def = zodOf(s, 0).def;
          let store: unknown = def.fn;
          const get = (): unknown => store;
          const set = (v: unknown): void => {
            store = v;
          };
          Object.defineProperty(def, "fn", { get, set, configurable: true, enumerable: true });
          return { def, get, set };
        };
        const s = z.string().refine(keep);
        const { def, get, set } = accessor(s);
        const C = compile(s);
        assert.ok(!C.stock);
        assert.equal(C.parse("x"), "x");
        assert.throws(() => C.parse(""));
        const d = Object.getOwnPropertyDescriptor(def, "fn")!;
        assert.ok(
          d.get === get && d.set === set && def.fn === keep,
          "an accessor slot keeps its getter and setter and answers the caller's function",
        );
        const onceLog: string[] = [];
        const sOnce = z.string().refine(once(onceLog, () => nested.parse("x")));
        accessor(sOnce);
        await assert.rejects(compile(sOnce).safeParseAsync("x"), $ZodAsyncError);
        assert.equal(
          onceLog.length,
          1,
          "accessor slot: a first-call-only throw rejects after one call",
        );

        const t = z.string().refine(keep);
        const tdef = zodOf(t, 0).def;
        Object.defineProperty(tdef, "fn", {
          value: keep,
          writable: true,
          enumerable: false,
          configurable: true,
        });
        const CT = compile(t);
        assert.equal(CT.parse("x"), "x");
        assert.deepEqual(
          Object.getOwnPropertyDescriptor(tdef, "fn"),
          { value: keep, writable: true, enumerable: false, configurable: true },
          "a non-enumerable data slot keeps its attributes",
        );
      }
      // A slot whose install write fails holds no wrapper, so its restore must not write it again (fourth review of
      // #112): an own accessor without a setter (the review's row), an inherited one whose getter answers a fresh
      // function per read, and a Proxy whose `set` and `defineProperty` traps both refuse. Each compiles, takes the
      // island, keeps its descriptor and records a callback's own throw once; the plain sibling slot is restored.
      {
        const getterOnly = (def: any): (() => unknown) => {
          const orig = def.fn;
          const get = (): unknown => orig;
          Object.defineProperty(def, "fn", { get, configurable: true, enumerable: true });
          return get;
        };
        const inheritedFresh = (def: any): void => {
          const orig = def.fn;
          delete def.fn;
          const proto = {};
          Object.defineProperty(proto, "fn", { get: () => orig.bind(null), configurable: true });
          Object.setPrototypeOf(def, proto);
        };
        const refuseBoth = (cz: any): void => {
          cz.def = new Proxy(cz.def, {
            set: () => {
              throw new Error("no write");
            },
            defineProperty: () => {
              throw new Error("no define");
            },
          });
        };
        const refuseBothSilently = (cz: any): void => {
          cz.def = new Proxy(cz.def, {
            set: () => false,
            defineProperty: () => {
              throw new Error("no define");
            },
          });
        };
        const rows: [string, (s: z.ZodType) => void, boolean][] = [
          ["an own getter-only accessor", (s) => void getterOnly(zodOf(s, 1).def), true],
          [
            "an inherited getter-only accessor answering a fresh function per read",
            (s) => inheritedFresh(zodOf(s, 1).def),
            false,
          ],
          [
            "a set trap that throws beside a defineProperty trap that throws",
            (s) => refuseBoth(zodOf(s, 1)),
            false,
          ],
          [
            "a set trap that answers false beside a defineProperty trap that throws",
            (s) => refuseBothSilently(zodOf(s, 1)),
            false,
          ],
        ];
        for (const [name, shape, ownAccessor] of rows) {
          const make = (cb: () => boolean): z.ZodType => {
            const s = z.string().refine(keep).refine(cb);
            shape(s);
            return s;
          };
          const plain = make(() => true);
          const f0 = zodOf(plain, 0).def.fn;
          const before = Object.getOwnPropertyDescriptor(zodOf(plain, 1).def, "fn");
          assert.equal(plain.parse("x"), "x", `${name}: stock parses the schema`);
          const C = compile(plain);
          assert.ok(!C.async && !C.stock, `${name}: compiles`);
          assert.equal(C.parse("x"), "x");
          assert.throws(
            () => C.parse(""),
            `${name}: the refined leaf still validates through the island`,
          );
          assert.ok(
            zodOf(plain, 0).def.fn === f0,
            `${name}: the plain slot reads back as the caller's function`,
          );
          assert.deepEqual(
            Object.getOwnPropertyDescriptor(zodOf(plain, 1).def, "fn"),
            before,
            `${name}: the refusing slot keeps its descriptor`,
          );
          if (ownAccessor)
            assert.ok(
              before?.get !== undefined && before.set === undefined,
              `${name}: the fixture is a getter-only accessor`,
            );
          const log: string[] = [];
          const CA = compile(make(always(log)));
          await assert.rejects(
            CA.safeParseAsync("x"),
            $ZodAsyncError,
            `${name}: the same rejection`,
          );
          assert.equal(log.length, 1, `${name}: one call through the island`);
          const onceLog: string[] = [];
          const CO = compile(make(once(onceLog, () => nested.parse("x"))));
          await assert.rejects(CO.safeParseAsync("x"), $ZodAsyncError);
          assert.equal(onceLog.length, 1, `${name}: a first-call-only throw rejects`);
        }
        // A getter-only accessor on a `z.custom` node's own `def.fn` is the same case at the schema level.
        {
          const cust = z.custom<string>((v) => typeof v === "string");
          const get = getterOnly((cust as any)._zod.def);
          const C = compile(cust);
          assert.ok(!C.stock);
          assert.equal(C.parse("x"), "x");
          assert.throws(() => C.parse(1));
          const d = Object.getOwnPropertyDescriptor((cust as any)._zod.def, "fn");
          assert.ok(
            d?.get === get && d.set === undefined,
            "z.custom: a getter-only slot keeps its descriptor",
          );
        }
        // A set trap that stores the wrapper and then throws, beside a defineProperty trap that throws: the slot
        // holds the wrapper, so the write-back failure still surfaces (the refusal below is the same rule).
        {
          const s = z
            .string()
            .refine(keep)
            .refine(() => true);
          const z1 = zodOf(s, 1);
          const refused = new Error("no define");
          z1.def = new Proxy(z1.def, {
            set: (t, k, v) => {
              t[k] = v;
              throw new Error("stored, then refused");
            },
            defineProperty: () => {
              throw refused;
            },
          });
          const f0 = zodOf(s, 0).def.fn;
          assert.throws(
            () => compile(s),
            (e: unknown) => e instanceof TypeError && (e as { cause?: unknown }).cause === refused,
            "a set trap that stored the wrapper before throwing still surfaces the write-back failure",
          );
          assert.ok(zodOf(s, 0).def.fn === f0, "the plain slot was restored first");
        }
      }
      // A trap that accepted the wrapper but refuses the write back: the other slots are restored first, then a
      // `TypeError` with the trap's error as `cause` surfaces from `compile()` (the slot it guards still holds the
      // transparent wrapper, and a second install would read it as the caller's function).
      {
        const s = z
          .string()
          .refine(keep)
          .refine(() => true);
        const z1 = zodOf(s, 1);
        const refused = new Error("restore refused");
        let n = 0;
        z1.def = new Proxy(z1.def, {
          defineProperty: (t, k, d) => {
            if (k === "fn" && ++n === 2) throw refused;
            return Reflect.defineProperty(t, k, d);
          },
        });
        const f0 = zodOf(s, 0).def.fn;
        assert.throws(
          () => compile(s),
          (e: unknown) =>
            e instanceof TypeError &&
            (e as { cause?: unknown }).cause === refused &&
            /refused the write back/.test(e.message),
          "a trap that refuses the write back surfaces a TypeError with its error as cause from compile()",
        );
        assert.ok(
          zodOf(s, 0).def.fn === f0,
          "the other slot was restored before the error surfaced",
        );
        assert.equal(
          s.parse("x"),
          "x",
          "the schema still parses on stock (the wrapper is transparent)",
        );
      }
    }
    // A plain function that returns a Promise is still the fast path's own signal (unrecorded), so it reaches
    // stock's async runtime and the parse succeeds; the callback runs on the fast path and again in stock's
    // runtime (the documented failure-path duplicate), which is deliberately unchanged.
    {
      const log: string[] = [];
      const C = compile(
        z.string().refine((v) => {
          log.push("c");
          return Promise.resolve(v === "x") as unknown as boolean;
        }),
      );
      const r = await C.safeParseAsync("x");
      assert.ok(r.success, "a returned Promise still reaches stock's async runtime");
      assert.equal(log.length, 2, "a returned Promise runs the callback on both paths (unchanged)");
    }
    ok(
      "a callback's own $ZodAsyncError inside an official product rejects after one call, like stock (#80)",
    );
  }

  // The one residual left, tracked in #80: a `.default()` / `.prefault()` value factory is a getter, not a
  // writable slot, so this layer cannot wrap it. A factory that throws `$ZodAsyncError` on the shortcut still
  // takes the fallback and runs twice, and a first-call-only throw passes on the rerun where stock rejects.
  {
    const stockLog: string[] = [];
    let sn = 0;
    await assert.rejects(
      z
        .object({
          a: z.string().default(() => {
            sn++;
            if (sn === 1) nested.parse("x");
            return "d";
          }),
        })
        .safeParseAsync({}),
      $ZodAsyncError,
    );
    assert.equal(stockLog.length + sn, 1, "stock runs the default factory once and rejects");
    let n = 0;
    const C = compile(
      z.object({
        a: z.string().default(() => {
          n++;
          if (n === 1) nested.parse("x");
          return "d";
        }),
      }),
    );
    assert.ok(!C.async && !C.stock);
    const r = await C.safeParseAsync({});
    assert.ok(
      r.success,
      "a first-call-only throw in a default factory passes on the rerun (known residual, #80)",
    );
    assert.equal(n, 2, "the default factory ran on the fast path and again in stock's runtime");
    ok(
      "a .default() value factory's $ZodAsyncError is the one residual (getter, not a writable slot, #80)",
    );
  }
}

head(
  "an official subtree holding a lazy runs in this layer's islands: a Promise a plain function returns inside the lazy reaches every entry as stock's class (#81, #90, #91)",
);
{
  // Stock's compiled product for a `lazy` is `generateLazyCheck`, a runtime island of stock's own generated code: it
  // runs the getter's `_zod.run` under an empty context and reads `.issues` off whatever came back, without the
  // thenable check stock's `runtimeRun` has. A plain function that returns a `Promise` inside the lazy (a transform,
  // #90 / #91; a refine, #81), which no static detector sees, makes that result a thenable and the read a `TypeError`.
  // A bare `lazy` has gone through this layer's islands since the sixth review of #76; a `lazy` under a wrapper, in a
  // union of leaves, in a pipe, or under an object key through one of those was part of a larger official subtree
  // stock compiled, so the sync entries let the `TypeError` out and the async entries had nothing to catch, and the
  // whole-tree validator behind `validate` was that product for every position. Now any official subtree holding a
  // `lazy` takes an island (`subtreeFollowsRuntime`), whose `throwAsync` throws `$ZodAsyncError` on the thenable,
  // the Promise signal the async entries hand to stock's async runtime, and `validate` runs the skeleton, whose
  // lazy is the same island, instead of the whole-tree validator.
  const transformLazy = () => z.lazy(() => z.string().transform((v) => Promise.resolve(v)));
  const refineLazy = () => z.lazy(() => z.string().refine(() => Promise.resolve(true)));
  type Pos = {
    name: string;
    make: (l: z.ZodType<unknown, string>) => z.ZodType;
    input: unknown;
    // stock's runtime meets the thenable in the generated parser of `$ZodObject`, which reads `.issues.length` off
    // it (a TypeError), where the check chain of the refine variant throws `$ZodAsyncError`: a stock quirk this
    // layer does not match (the skeleton calls the lazy as an island and throws stock's class), pinned as such
    stockQuirkOnTransform?: true;
  };
  const positions: Pos[] = [
    { name: "bare lazy", make: (l) => l, input: "x" },
    { name: "array(lazy)", make: (l) => z.array(l), input: ["x"] },
    { name: "union([lazy, number])", make: (l) => z.union([l, z.number()]), input: "x" },
    { name: "lazy.optional()", make: (l) => l.optional(), input: "x" },
    { name: "lazy.nullable()", make: (l) => l.nullable(), input: "x" },
    { name: "string.pipe(lazy)", make: (l) => z.string().pipe(l), input: "x" },
    { name: "lazy.pipe(string)", make: (l) => l.pipe(z.string()), input: "x" },
    {
      name: "object({ a: lazy })",
      make: (l) => z.object({ a: l }),
      input: { a: "x" },
      stockQuirkOnTransform: true,
    },
    {
      name: "object({ a: lazy.optional() })",
      make: (l) => z.object({ a: l.optional() }),
      input: { a: "x" },
      stockQuirkOnTransform: true,
    },
    {
      name: "object({ a: lazy.transform(identity) })",
      make: (l) => z.object({ a: l.transform((v) => v) }),
      input: { a: "x" },
      stockQuirkOnTransform: true,
    },
    {
      name: "object({ a: union([lazy, number]) })",
      make: (l) => z.object({ a: z.union([l, z.number()]) }),
      input: { a: "x" },
      stockQuirkOnTransform: true,
    },
  ];
  const variants: [string, () => z.ZodType<unknown, string>, boolean][] = [
    ["transform returning a Promise (#90, #91)", transformLazy, true],
    ["refine returning a Promise (#81)", refineLazy, false],
  ];
  for (const [variant, lazy, isTransform] of variants) {
    for (const pos of positions) {
      const S = pos.make(lazy());
      const C = compile(S);
      const tag = `${pos.name}, ${variant}`;
      assert.ok(
        !C.stock && !C.async,
        `${tag}: a sync skeleton (a plain function passes every static detector)`,
      );
      const stockClass = isTransform && pos.stockQuirkOnTransform ? TypeError : $ZodAsyncError;
      assert.throws(() => S.safeParse(pos.input), stockClass, `${tag}: stock's sync parse`);
      assert.throws(
        () => C.safeParse(pos.input),
        $ZodAsyncError,
        `${tag}: safeParse throws stock's class`,
      );
      assert.throws(() => C.parse(pos.input), $ZodAsyncError, `${tag}: parse throws stock's class`);
      assert.throws(
        () => C.validate(pos.input),
        $ZodAsyncError,
        `${tag}: validate throws stock's class`,
      );
      const stockAsync = await S.safeParseAsync(pos.input);
      assert.ok(stockAsync.success, `${tag}: stock's async parse succeeds`);
      const r = await C.safeParseAsync(pos.input);
      assert.ok(r.success, `${tag}: safeParseAsync hands the parse to stock's async runtime`);
      assert.deepEqual(r.data, stockAsync.data, `${tag}: stock's output`);
      assert.deepEqual(await C.parseAsync(pos.input), stockAsync.data, `${tag}: parseAsync too`);
    }
  }
  ok(
    "safeParse, parse and validate throw $ZodAsyncError and the async entries answer stock's output at every position",
  );

  // The #80 residual at the lazy positions goes with it: a callback's own `$ZodAsyncError` inside the lazy (a nested
  // sync parse of an async schema) used to be thrown by stock's generated code, which this layer cannot mark, so it
  // took the fallback and a first-call-only throw passed on the rerun; the island's `runIsland` records it now, and
  // the parse rejects after one call like stock.
  {
    const nested = z.string().refine(async () => true);
    const once = (log: string[]) => () => {
      log.push("c");
      if (log.length === 1) nested.parse("x");
      return true;
    };
    const wraps: [string, (l: z.ZodType<unknown, string>) => z.ZodType, unknown][] = [
      ["lazy.optional() under an object key", (l) => z.object({ a: l.optional() }), { a: "x" }],
      ["string.pipe(lazy)", (l) => z.string().pipe(l), "x"],
      ["union([lazy, number])", (l) => z.union([l, z.number()]), "x"],
    ];
    for (const [name, make, input] of wraps) {
      const stockLog: string[] = [];
      await assert.rejects(
        make(z.lazy(() => z.string().refine(once(stockLog)))).safeParseAsync(input),
        $ZodAsyncError,
      );
      assert.equal(stockLog.length, 1);
      const log: string[] = [];
      const C = compile(make(z.lazy(() => z.string().refine(once(log)))));
      assert.ok(!C.async && !C.stock);
      await assert.rejects(C.safeParseAsync(input), $ZodAsyncError, `${name}: the same rejection`);
      assert.equal(
        log.length,
        1,
        `${name}: one call, no rerun (the #80 residual does not reach a lazy position)`,
      );
    }
    ok(
      "a callback's own $ZodAsyncError inside a lazy under a wrapper, in a pipe or in a union rejects after one call",
    );
  }

  // The cost: `validate` on a tree holding a `lazy` runs the skeleton instead of the whole-tree validator (a
  // recursive schema included), still answering the input reference on a pass and null on a rejection.
  {
    type Tree = { v: number; kids: Tree[] };
    const Tree: z.ZodType<Tree> = z.object({ v: z.number(), kids: z.array(z.lazy(() => Tree)) });
    const C = compile(Tree);
    assert.ok(!C.stock);
    const input = { v: 1, kids: [{ v: 2, kids: [] }] };
    assert.equal(C.validate(input), input, "a pass answers the input reference");
    assert.equal(
      C.validate({ v: 1, kids: [{ v: "2", kids: [] }] }),
      null,
      "a rejection answers null",
    );
    const W = compile(z.object({ a: z.lazy(() => z.string()).optional(), b: z.number() }));
    const wIn = { a: "x", b: 1 };
    assert.equal(W.validate(wIn), wIn);
    const wAbsent = { b: 1 };
    assert.equal(W.validate(wAbsent), wAbsent, "an absent optional lazy key passes by reference");
    assert.equal(W.validate({ a: 1, b: 1 }), null);
    const wr = W.safeParse(wIn);
    assert.ok(wr.success && wr.data === wIn, "the parse entries keep the CoW reference");
    ok("validate on a tree holding a lazy runs the skeleton and keeps its contract");
  }
}

head(
  "a subtree stock's compileFn refuses for a non-async reason takes the async island when its checks are async (#75)",
);
{
  // `officialFn` used to read `ZodCompileAsyncError` as the only async signal: a subtree whose stock compile
  // failed with any other error (a symbol literal, a `catch` callback, coercion, `z.xor`) fell to the sync island
  // without asking whether it holds an async check. The sync island then met the Promise at parse time; since
  // #76 the async entries catch that throw and rerun the parse in stock's async runtime, so the answer was right
  // but `.async` reported false, the predicate ran twice and the CoW reference was lost. The fallback now asks
  // `inspectSubtree`, the same answer the `lazy` case already takes.
  const sym = Symbol("k");
  // [name, schema builder, clean value, a value the leaf does not accept]: one row per reason stock's compileFn
  // refuses a subtree before its checks are reached. A symbol literal has no failing fixture: stock's own error
  // map stringifies the expected symbol and throws on every mismatch.
  type Shape = [string, (log: number[]) => z.ZodType, unknown, unknown?];
  const shapes: Shape[] = [
    [
      "symbol literal with an async refine",
      (log) =>
        z.literal(sym as never).refine(async () => {
          log.push(1);
          return true;
        }),
      sym,
    ],
    [
      "a catch callback over an async refine",
      (log) =>
        z
          .string()
          .refine(async () => {
            log.push(1);
            return true;
          })
          .catch((c) => String(c.error.issues.length)),
      "ab",
      42,
    ],
    [
      "a coerced string with an async refine",
      (log) =>
        z.coerce
          .string()
          .min(3)
          .refine(async () => {
            log.push(1);
            return true;
          }),
      "abc",
      "ab",
    ],
    [
      "an xor with an async refine",
      (log) =>
        z.xor([z.string(), z.number()]).refine(async () => {
          log.push(1);
          return true;
        }),
      "ab",
      true,
    ],
  ];
  type Pos = [string, (leaf: z.ZodType) => z.ZodType, (v: unknown) => unknown];
  const positions: Pos[] = [
    ["top level", (leaf) => leaf, (v) => v],
    ["tuple slot", (leaf) => z.tuple([leaf, z.string()]), (v) => [v, "s"]],
    ["array element", (leaf) => z.array(leaf), (v) => [v]],
    ["object key", (leaf) => z.object({ a: leaf }), (v) => ({ a: v })],
  ];
  for (const [shapeName, mk, value, badValue] of shapes) {
    for (const [posName, wrap, place] of positions) {
      const name = `${shapeName} at ${posName}`;
      const log: number[] = [];
      const S = wrap(mk(log));
      const C = compile(S);
      assert.ok(!C.stock, `${name}: compiled`);
      assert.ok(C.async, `${name}: judged an async product`);
      const input = place(value);
      const stock = await S.safeParseAsync(input);
      assert.ok(stock.success, `${name}: stock accepts`);
      log.length = 0;
      const r = await C.safeParseAsync(input);
      assert.ok(r.success, `${name}: accepted`);
      assert.equal(log.length, 1, `${name}: the predicate ran once (no stock rerun)`);
      if (posName !== "top level") {
        assert.equal(r.data, input, `${name}: clean input returns the input reference`);
      }
      assert.throws(
        () => C.safeParse(input),
        $ZodAsyncError,
        `${name}: the sync API throws like stock`,
      );
      assert.throws(() => S.safeParse(input as never), $ZodAsyncError);
      if (badValue === undefined) continue;
      // a rejected leaf answers like stock: here the catch callback turns the failure into its value
      const bad = place(badValue);
      const rBad = await C.safeParseAsync(bad);
      const stockBad = await S.safeParseAsync(bad);
      assert.equal(
        rBad.success,
        stockBad.success,
        `${name}: same verdict as stock on a rejected leaf`,
      );
      if (rBad.success && stockBad.success) assert.deepEqual(rBad.data, stockBad.data);
      else if (!rBad.success && !stockBad.success)
        assert.deepEqual(rBad.error.issues, stockBad.error.issues);
    }
  }
  ok("the four positions of every shape answer once, share the reference and report async");

  // The issue's own shape: a loose record with a symbol-literal key and an async refine. The record skeleton
  // has covered a declared symbol key since then, so the refine runs in the checks subroutine of #76 and no
  // island is involved; pinned so a change to that skeleton's gate cannot reopen the symptom.
  const rec = z.looseRecord(z.literal(sym as never), z.string()).refine(async () => true);
  const T = z.tuple([rec, z.string()]);
  const TC = compile(T);
  assert.ok(TC.async && !TC.stock);
  const tIn = [{ [sym]: "ab" }, "s"];
  const tR = await TC.safeParseAsync(tIn);
  assert.ok(tR.success && tR.data === tIn);
  assert.ok(compile(rec).async);
  ok(
    "the issue's loose record with a symbol-literal key and an async refine stays on the CoW path",
  );

  // A shape getter that throws while the walk classifies a refused subtree (review of #82). Stock reads an
  // object's shape only at parse time (`$ZodObject` copies the caller's shape on the first read of `def.shape`,
  // so a getter may reference a schema still under construction) and its compile of the refused subtree never
  // reached the shape, so the throw is contained: `compile()` does not throw, the subtree takes the sync island,
  // and the getter's error surfaces at parse time where stock's does. The object option comes first so the
  // walk reads the shape before it meets the async refine.
  const throwingShape = Object.create(null, {
    a: {
      enumerable: true,
      get: () => {
        throw new Error("shape getter");
      },
    },
  });
  const X = z.xor([z.object(throwingShape), z.string().refine(async () => true)]);
  const isShapeError = (e: unknown): boolean =>
    e instanceof Error && !(e instanceof $ZodAsyncError) && e.message === "shape getter";
  for (const [posName, wrap, place] of positions) {
    const name = `throwing shape getter at ${posName}`;
    const S = wrap(X);
    const input = place("x");
    const C = compile(S);
    assert.ok(!C.stock && !C.async, `${name}: compiled to a sync product`);
    assert.throws(() => S.safeParse(input as never), isShapeError);
    assert.throws(
      () => C.safeParse(input),
      isShapeError,
      `${name}: the sync API throws stock's error`,
    );
    await assert.rejects(S.safeParseAsync(input), isShapeError);
    await assert.rejects(
      C.safeParseAsync(input),
      isShapeError,
      `${name}: the async API rejects with stock's error`,
    );
  }
  ok(
    "a shape getter that throws during the walk is contained: the sync island surfaces its error at parse time like stock",
  );

  // The same getter resolving by parse time (a schema declared later in the module): the sync island meets the
  // Promise of the async option, and the async entries hand the parse to stock's async runtime, the #76 route.
  let lateInner: z.ZodType | undefined;
  const lateShape = Object.create(null, {
    a: {
      enumerable: true,
      get: () => {
        if (lateInner === undefined) throw new Error("not yet");
        return lateInner;
      },
    },
  });
  const lateLog: number[] = [];
  const L = z.tuple([
    z.xor([
      z.object(lateShape),
      z.string().refine(async () => {
        lateLog.push(1);
        return true;
      }),
    ]),
    z.string(),
  ]);
  const LC = compile(L);
  assert.ok(!LC.stock && !LC.async);
  lateInner = z.string();
  const lIn = ["x", "s"];
  assert.throws(() => LC.safeParse(lIn), $ZodAsyncError);
  assert.throws(() => L.safeParse(lIn as never), $ZodAsyncError);
  lateLog.length = 0;
  const lR = await LC.safeParseAsync(lIn);
  assert.equal(
    lateLog.length,
    2,
    "the predicate ran in the island and again in stock's async runtime",
  );
  const lStock = await L.safeParseAsync(lIn as never);
  assert.ok(lR.success && lStock.success);
  assert.deepEqual(lR.data, lStock.data);
  ok("a shape getter that resolves by parse time answers like stock through the #76 fallback");

  // The same getter inside a subtree stock's compiler accepts (review of #100). `compileFn` reads the shape in its
  // cycle check before any codegen and counts a read that throws as a reference cycle, so the subtree, refused or
  // not, fails stock's compile before its codegen and takes the sync island; `compile()` does not throw and the
  // getter's error surfaces at parse time where stock's does.
  const Y = z.object(throwingShape).transform((v) => v);
  for (const [posName, wrap, place] of positions) {
    const name = `throwing shape getter in a compilable official subtree at ${posName}`;
    const S = wrap(Y);
    const input = place({ a: "x" });
    const C = compile(S);
    assert.ok(!C.stock && !C.async, `${name}: compiled to a sync product`);
    assert.throws(() => S.safeParse(input as never), isShapeError);
    assert.throws(
      () => C.safeParse(input),
      isShapeError,
      `${name}: the sync API throws stock's error`,
    );
    await assert.rejects(S.safeParseAsync(input), isShapeError);
    await assert.rejects(
      C.safeParseAsync(input),
      isShapeError,
      `${name}: the async API rejects with stock's error`,
    );
  }
  ok(
    "a shape getter that throws inside a subtree stock's compiler accepts is contained the same way (review of #100)",
  );
}

head(
  "a lazy getter that throws at compile time is opaque: sync island, no read through stock's memo (#83)",
);
{
  // Stock never calls a `lazy` getter at compile time (`generateLazyCheck` is a runtime island), so a getter
  // that throws while `inspectSubtree` expands it says nothing about the subtree's asyncness. It used to count
  // as async: the subtree took the async island, `.async` reported true and the sync API threw `$ZodAsyncError`
  // where stock ran the getter at parse time and answered. The realistic case is a temporal dead zone: a lazy
  // that reads a binding declared later in the module, with `compile()` called between the two declarations.
  //
  // The sync island alone would not do: `$ZodLazy` memoizes its inner type through `util.defineLazy`, which
  // marks the cell before calling the getter and never resets it when the getter throws, so one read through
  // `_zod.innerType` while the getter throws makes every later read answer `undefined` and every parse of the
  // schema, stock's own `safeParse` included, end in a `TypeError`. Stock's `compileFn` makes that read
  // (`isRecursiveSchema`), and so do the presence rules the object and tuple skeletons decide at compile time
  // (`optin` / `optout` forward through the memo). So a subtree holding such a lazy is never handed to
  // `compileFn`, the whole-tree validator is skipped, and a container whose skeleton would read the lazy's
  // presence declines the skeleton and takes the runtime island instead, where the read happens at parse time.
  // A container that never reads it (an array, a record; a tuple whose tail scan stops before the slot) keeps
  // its skeleton and the CoW reference. `ref` below says which.
  type Pos = [
    name: string,
    wrap: (leaf: z.ZodType) => z.ZodType,
    place: (v: unknown) => unknown,
    ref: boolean,
  ];
  const positions: Pos[] = [
    ["top level", (leaf) => leaf, (v) => v, true],
    ["first tuple slot", (leaf) => z.tuple([leaf, z.string()]), (v) => [v, "s"], true],
    ["last tuple slot", (leaf) => z.tuple([z.string(), leaf]), (v) => ["s", v], false],
    ["array element", (leaf) => z.array(leaf), (v) => [v], true],
    ["record value", (leaf) => z.record(z.string(), leaf), (v) => ({ k: v }), true],
    ["object key", (leaf) => z.object({ a: leaf }), (v) => ({ a: v }), false],
    ["optional object key", (leaf) => z.object({ a: leaf.optional() }), (v) => ({ a: v }), false],
  ];
  const tdz = (read: () => z.ZodType | undefined): z.ZodType =>
    z.lazy(() => {
      const inner = read();
      if (inner === undefined) throw new Error("tdz");
      return inner;
    });
  const expectRef = (name: string, ref: boolean, out: unknown, input: unknown): void => {
    if (ref) assert.equal(out, input, `${name}: the clean input comes back by reference`);
    else {
      assert.notEqual(
        out,
        input,
        `${name}: the container declined its skeleton, stock's runtime built the output`,
      );
      assert.deepEqual(out, input, `${name}: stock's output`);
    }
  };

  // 1. The getter resolves to a sync subtree by parse time: sync island, the sync API answers like stock. The
  //    same schema object serves both sides, so a read through stock's memo at compile time would show as a
  //    `TypeError` from stock's own `safeParse` here.
  for (const [posName, wrap, place, ref] of positions) {
    const name = `sync inner at ${posName}`;
    let inner: z.ZodType | undefined;
    const S = wrap(tdz(() => inner));
    const C = compile(S);
    assert.ok(!C.stock && !C.async, `${name}: compiled to a sync product`);
    inner = z.string();
    const input = place("a");
    const stock = S.safeParse(input as never);
    assert.ok(stock.success, `${name}: compile() left stock's memo untouched`);
    const r = C.safeParse(input);
    assert.ok(r.success, `${name}: the sync API accepts like stock`);
    expectRef(name, ref, r.data, input);
    assert.deepEqual(r.data, stock.data);
    assert.equal(C.validate(input), input, `${name}: validate answers the input`);
    const bad = place(1);
    assert.equal(S.safeParse(bad as never).success, false);
    assert.equal(C.safeParse(bad).success, false, `${name}: the sync API rejects like stock`);
    assert.equal(C.validate(bad), null, `${name}: validate rejects like stock`);
    const ra = await C.safeParseAsync(input);
    assert.ok(ra.success, `${name}: the async API accepts too`);
    expectRef(`${name} (async API)`, ref, ra.data, input);
  }
  ok(
    "a getter that resolves to a sync subtree by parse time takes the sync island and answers like stock, stock's memo untouched",
  );

  // 2. The getter resolves to an async subtree by parse time: the sync island meets the Promise, the sync API
  //    throws `$ZodAsyncError` where stock's does, and the async entries hand the parse to stock's async runtime
  //    (the #76 route: stock's answer, `.async` false, the predicate run twice, no CoW reference).
  for (const [posName, wrap, place] of positions) {
    const name = `async inner at ${posName}`;
    let inner: z.ZodType | undefined;
    const log: number[] = [];
    const S = wrap(tdz(() => inner));
    const C = compile(S);
    assert.ok(!C.stock && !C.async, `${name}: compiled to a sync product`);
    inner = z.string().refine(async () => {
      log.push(1);
      return true;
    });
    const input = place("a");
    assert.throws(() => S.safeParse(input as never), $ZodAsyncError);
    assert.throws(
      () => C.safeParse(input),
      $ZodAsyncError,
      `${name}: the sync API throws stock's class`,
    );
    log.length = 0;
    const r = await C.safeParseAsync(input);
    assert.equal(
      log.length,
      2,
      `${name}: the predicate ran in the island and again in stock's async runtime`,
    );
    const stock = await S.safeParseAsync(input as never);
    assert.ok(r.success && stock.success, `${name}: both sides accept`);
    assert.deepEqual(r.data, stock.data, `${name}: stock's answer`);
    assert.equal(
      (await C.safeParseAsync(place(1))).success,
      false,
      `${name}: the async API rejects like stock`,
    );
  }
  ok("a getter that resolves to an async subtree by parse time meets the Promise on the #76 route");

  // 3. The getter always throws: the sync island runs `_zod.run` under the empty context, the getter's error
  //    leaves the run synchronously and `runIsland` rethrows it, so the sync API throws stock's error instead of
  //    `$ZodAsyncError`. Stock's memo then answers `undefined` for every later read (the poisoned cell above),
  //    which ends in the `TypeError` of reading `_zod` off it: a compiled product is one more caller of the same
  //    schema, so the same calls in the same order give the same sequence on both sides.
  const isGetterError = (e: unknown): boolean =>
    e instanceof Error && !(e instanceof $ZodAsyncError) && e.message === "getter";
  for (const [posName, wrap, place] of positions) {
    const name = `always throwing getter at ${posName}`;
    const mk = (): z.ZodType =>
      wrap(
        z.lazy(() => {
          throw new Error("getter");
        }),
      );
    const input = place("a");
    const S = mk();
    const C = compile(mk());
    assert.ok(!C.stock && !C.async, `${name}: compiled to a sync product`);
    assert.throws(() => S.safeParse(input as never), isGetterError);
    assert.throws(
      () => C.safeParse(input),
      isGetterError,
      `${name}: the sync API throws stock's error`,
    );
    assert.throws(() => S.parse(input as never), TypeError);
    assert.throws(
      () => C.parse(input),
      TypeError,
      `${name}: the second call meets stock's memo like stock`,
    );
    await assert.rejects(S.safeParseAsync(input as never), TypeError);
    await assert.rejects(
      C.safeParseAsync(input),
      TypeError,
      `${name}: the async API rejects like stock`,
    );
    // The shared instance: compile() made no read through the memo, so stock's first call is still the getter's
    const shared = mk();
    compile(shared);
    assert.throws(
      () => shared.safeParse(input as never),
      isGetterError,
      `${name}: stock's first parse after compile() still runs the getter`,
    );
  }
  ok("a getter that always throws surfaces its error from the sync API like stock");
}

head(
  "an undefined element is judged dirty without an own-ness probe; an under-reported Proxy length keeps the clean path (#95)",
);
{
  // Item 1 of #95: stock's array and tuple runtimes read each element (`input[i]`, or `HasProperty` then `Get` inside
  // `input.slice(items.length)`) and never ask whether the index is own, and their output holds an own `undefined`
  // slot wherever the read gave `undefined` (an own `undefined`, a hole, a hole over an inherited `undefined`, a Proxy
  // whose `get` answers it). The skeletons asked `Object.hasOwn` on such a value to keep the reference for an own
  // `undefined`, a `getOwnPropertyDescriptor` trap stock never runs. They now judge the value dirty without asking:
  // the copy is stock's output, and the reference is lost for an input holding an explicit `undefined` member, the
  // class of `z.nan()` (never `===` itself). The differential fuzzer put that loss at 0.1 point of its top-level
  // sharing rate. Item 2: a Proxy under-reporting its `length` keeps the clean path (below).
  const asyncOpt = z
    .string()
    .optional()
    .refine(async () => true);
  const sync: [string, z.ZodType][] = [
    ["array", z.array(z.string().optional())],
    ["fixed tuple", z.tuple([z.string(), z.string().optional(), z.string()])],
    ["rest tuple", z.tuple([z.string()], z.string().optional())],
    ["array of any", z.array(z.any())],
    ["array of undefined", z.array(z.undefined())],
  ];
  const asyncs: [string, z.ZodType][] = [
    ["async array", z.array(asyncOpt)],
    ["async fixed tuple", z.tuple([z.string(), asyncOpt, z.string()])],
    ["async rest tuple", z.tuple([z.string()], asyncOpt)],
  ];
  const noProbe = /hasOwn|getOwnPropertyDescriptor|propertyIsEnumerable|ownKeys/;
  /** The async rest row: stock's runtime hands back a sparse array there and loses the value (the quirk the README
   *  lists as deliberately not matched, for `null` in a nullable slot), where the skeleton writes the own slot */
  const sparseRest = "async rest tuple";
  // 1. The code pin: no own-ness probe in any array-shaped skeleton, sync or async, at any depth (`code` dumps every
  //    nested skeleton, #46)
  for (const [label, S] of [...sync, ...asyncs]) {
    const C = compile(S);
    assert.equal(C.stock, false, `${label}: a skeleton`);
    assert.ok(!noProbe.test(C.code ?? ""), `${label}: no own-ness probe in the generated code`);
  }
  {
    const nested = z.object({
      rows: z.array(z.tuple([z.string(), z.array(z.string().optional()).optional()])),
    });
    const C = compile(nested);
    assert.ok(!noProbe.test(C.code ?? ""), "nested: no own-ness probe at any depth");
  }
  ok("no array-shaped skeleton carries an own-ness probe");
  // 2. An explicit `undefined` member copies: stock's output, an own slot, a fresh array; an input without one keeps
  //    the reference (the loss is bounded to inputs holding a present `undefined`)
  {
    const withUndefined = () => ["h", undefined, "b"];
    const without = () => ["h", "a", "b"];
    for (const [label, S] of sync) {
      const C = compile(S);
      const allUndefined = label === "array of undefined";
      const input = allUndefined ? [undefined, undefined] : withUndefined();
      const stock = S.parse(input) as unknown[];
      assert.deepEqual(stock, allUndefined ? [undefined, undefined] : ["h", undefined, "b"]);
      const cow = C.parse(input) as unknown[];
      assert.deepEqual(cow, stock, `${label}: stock's output`);
      assert.notEqual(cow, input, `${label}: an explicit undefined member copies`);
      assert.ok(Object.hasOwn(cow, 1), `${label}: an own slot`);
      if (allUndefined) continue;
      const clean = without();
      assert.equal(C.parse(clean), clean, `${label}: no undefined member, the reference`);
    }
    // The async layouts: the array and the fixed slots give stock's dense output, the rest row the dense output
    // stock's sparse quirk withholds
    for (const [label, S] of asyncs) {
      const C = compile(S);
      assert.equal(C.async, true, `${label}: the async layout`);
      const input = withUndefined();
      const stock = (await S.parseAsync(input)) as unknown[];
      if (label !== sparseRest) assert.deepEqual(stock, ["h", undefined, "b"]);
      else assert.deepEqual(Object.keys(stock), ["0", "2"], "stock's async rest loses the slot");
      const cow = (await C.parseAsync(input)) as unknown[];
      assert.deepEqual(cow, ["h", undefined, "b"], `${label}: the dense output`);
      assert.notEqual(cow, input, `${label}: an explicit undefined member copies`);
      assert.ok(Object.hasOwn(cow, 1), `${label}: an own slot`);
      const clean = without();
      assert.equal(
        await C.parseAsync(clean),
        clean,
        `${label}: no undefined member, the reference`,
      );
    }
    // The array skeleton's copy holds the prefix and every later element from the loop's single read
    const A = z.array(z.string().optional());
    const long = ["a", "b", undefined, "d", undefined];
    const cowLong = compile(A).parse(long) as unknown[];
    assert.deepEqual(cowLong, long);
    assert.notEqual(cowLong, long);
    assert.equal(Object.keys(cowLong).length, 5, "every index own");
    ok(
      "an explicit undefined member copies to stock's output; an input without one keeps the reference",
    );
  }
  // 3. A hole and a hole over an inherited `undefined` copy like stock, an own slot in the output (the #67 / #70
  //    rows, now decided from the read alone)
  {
    const HOLE = Symbol("hole");
    const arr = (...vs: unknown[]): unknown[] => {
      const a: unknown[] = [];
      for (let i = 0; i < vs.length; i++) if (vs[i] !== HOLE) a[i] = vs[i];
      a.length = vs.length;
      return a;
    };
    const inherited = (...vs: unknown[]): unknown[] => {
      const a = arr(...vs);
      const proto = Object.create(Array.prototype) as Record<number, unknown>;
      for (let i = 0; i < vs.length; i++) if (vs[i] === HOLE) proto[i] = undefined;
      Object.setPrototypeOf(a, proto);
      return a;
    };
    for (const [label, S] of sync) {
      if (label === "array of undefined") continue;
      const C = compile(S);
      for (const [kind, make] of [
        ["a hole", () => arr("h", HOLE, "b")],
        ["a hole over an inherited undefined", () => inherited("h", HOLE, "b")],
      ] as [string, () => unknown[]][]) {
        const stock = S.parse(make()) as unknown[];
        assert.ok(Object.hasOwn(stock, 1) && stock.length === 3, `${label}: stock owns the slot`);
        const input = make();
        const cow = C.parse(input) as unknown[];
        assert.deepEqual(cow, stock, `${label}, ${kind}: stock's output`);
        assert.notEqual(cow, input, `${label}, ${kind}: copied`);
        assert.ok(Object.hasOwn(cow, 1), `${label}, ${kind}: an own slot`);
      }
    }
    for (const [label, S] of asyncs) {
      const C = compile(S);
      for (const [kind, make] of [
        ["a hole", () => arr("h", HOLE, "b")],
        ["a hole over an inherited undefined", () => inherited("h", HOLE, "b")],
      ] as [string, () => unknown[]][]) {
        const stock = (await S.parseAsync(make())) as unknown[];
        if (label !== sparseRest) assert.deepEqual(stock, ["h", undefined, "b"]);
        const input = make();
        const cow = (await C.parseAsync(input)) as unknown[];
        assert.deepEqual(cow, ["h", undefined, "b"], `${label}, ${kind}: the dense output`);
        assert.notEqual(cow, input, `${label}, ${kind}: copied`);
        assert.ok(Object.hasOwn(cow, 1), `${label}, ${kind}: an own slot`);
      }
    }
    ok("a hole and a hole over an inherited undefined are own slots, like stock, in every layout");
  }
  // 4. The issue's Proxies: a `getOwnPropertyDescriptor` trap that writes to a later index, and one that throws.
  //    Neither runs on either side: the compiled output is stock's and the input's later index is untouched
  {
    const mutating = (log: string[]) =>
      new Proxy(["h", undefined, "b"] as unknown[], {
        getOwnPropertyDescriptor(t, k) {
          log.push(`gopd:${String(k)}`);
          if (k === "1") t[2] = "MUT";
          return Reflect.getOwnPropertyDescriptor(t, k);
        },
      });
    const throwing = () =>
      new Proxy(["h", undefined, "b"] as unknown[], {
        getOwnPropertyDescriptor(t, k) {
          if (k === "1") throw new Error("gopd trap");
          return Reflect.getOwnPropertyDescriptor(t, k);
        },
      });
    for (const [label, S] of sync) {
      if (label === "array of undefined") continue;
      const C = compile(S);
      const stockLog: string[] = [];
      const stock = S.parse(mutating(stockLog)) as unknown[];
      assert.deepEqual(stock, ["h", undefined, "b"]);
      assert.deepEqual(stockLog, [], `${label}: stock consults no descriptor`);
      const log: string[] = [];
      const input = mutating(log);
      const cow = C.parse(input) as unknown[];
      assert.deepEqual(cow, stock, `${label}: stock's output`);
      assert.deepEqual(log, [], `${label}: the skeleton consults no descriptor either`);
      assert.equal(input[2], "b", `${label}: the trap's effect never happens`);
      assert.deepEqual(C.parse(throwing()), stock, `${label}: a throwing trap is never reached`);
    }
    for (const [label, S] of asyncs) {
      const C = compile(S);
      const stockLog: string[] = [];
      await S.parseAsync(mutating(stockLog));
      assert.deepEqual(stockLog, [], `${label}: stock consults no descriptor`);
      const log: string[] = [];
      const input = mutating(log);
      const cow = (await C.parseAsync(input)) as unknown[];
      assert.deepEqual(cow, ["h", undefined, "b"], `${label}: the dense output`);
      assert.deepEqual(log, [], `${label}: no descriptor consulted before the await`);
      assert.equal(input[2], "b");
      assert.deepEqual(
        await C.parseAsync(throwing()),
        ["h", undefined, "b"],
        `${label}: a throwing trap is never reached`,
      );
    }
    ok("a getOwnPropertyDescriptor trap is never consulted, like stock");
  }
  // Item 2 of #95: the skeletons size their walk from `input.length` as stock does and return the input by reference
  // when every element the reported length covers is unchanged. A Proxy under-reporting its length (only a Proxy
  // can: a plain array's length is exact) gets stock a fresh truncated output and the compiled parser the input
  // itself, whose further elements stock never saw: the clean path's known limitation, the class of the
  // non-enumerable undeclared key and the prototype (#48), since proving the length costs an allocation
  // (`Reflect.ownKeys`) or a trap per clean array. The array skeleton walks `i < length` like stock's runtime and
  // allocates nothing on its clean path, where stock's runtime sizes its output with `Array(length)` first: a length
  // that allocation rejects (a fraction, `NaN`, a negative) throws stock's `RangeError` from
  // the skeleton's copy path only, when the walk reached an element a rewrite changed. The tuple rows sit in the
  // #78 group (its presence decision after the rest re-runs stock's algorithm for a length converting to NaN, the
  // one exception). A rewrite forces the copy, which is stock's truncated output
  {
    const withLength = (len: unknown) =>
      new Proxy(["h", "a", "b"], {
        get(t, k, r) {
          return k === "length" ? len : Reflect.get(t, k, r);
        },
      });
    const V = z.array(z.string());
    const T = z.array(z.string().transform((v) => `${v}!`));
    const CV = compile(V);
    const CT = compile(T);
    // Lengths stock's `Array(length)` accepts: the walk stock makes, the input by reference
    for (const [len, asInt] of [
      [1, 1],
      [2, 2],
      ["2", 2],
      [true, 1],
    ] as [unknown, number][]) {
      const stock = V.parse(withLength(len));
      assert.deepEqual(
        stock,
        ["h", "a", "b"].slice(0, asInt),
        `stock walks ${String(len)} as ${asInt}`,
      );
      const input = withLength(len);
      assert.equal(CV.parse(input), input, `length ${String(len)}: the input by reference`);
      const stockT = T.parse(withLength(len));
      assert.deepEqual(stockT, ["h!", "a!", "b!"].slice(0, asInt));
      assert.deepEqual(
        CT.parse(withLength(len)),
        stockT,
        `length ${String(len)}: the rewrite copies to stock's output`,
      );
    }
    // Lengths that allocation rejects: stock throws before it reads an element; the clean path walks what
    // `i < length` covers (a fraction some elements, NaN or a negative none) and returns the input; the copy path
    // allocates as stock does and throws the same RangeError, so a rewrite under a fraction throws
    for (const [len, walks] of [
      [2.9, true],
      [1.5, true],
      [Number.NaN, false],
      [-1, false],
    ] as [unknown, boolean][]) {
      assert.throws(
        () => V.parse(withLength(len)),
        RangeError,
        `stock's Array(${String(len)}) throws`,
      );
      const input = withLength(len);
      assert.equal(
        CV.parse(input),
        input,
        `length ${String(len)}: the clean path returns the input`,
      );
      if (walks) {
        assert.throws(
          () => CT.parse(withLength(len)),
          RangeError,
          `length ${String(len)}: the copy path throws stock's RangeError`,
        );
      } else {
        const t = withLength(len);
        assert.equal(CT.parse(t), t, `length ${String(len)}: an empty walk, the input`);
      }
    }
    // The fixed tuple: a length below the required slots is stock's failure (the guard hands it to stock), a length
    // that lands in the optional range is the truncation, on the clean path
    const F = z.tuple([z.string(), z.string().optional()]);
    const CF = compile(F);
    const one = withLength(1);
    assert.deepEqual(F.parse(one), ["h"]);
    assert.equal(CF.parse(one), one, "the fixed tuple truncates on the clean path");
    const F3 = z.tuple([z.string(), z.string(), z.string()]);
    assert.equal(F3.safeParse(withLength(1)).success, false);
    assert.equal(compile(F3).safeParse(withLength(1)).success, false, "stock's failure");
    // The async array layout: the same clean path for an integer under-report
    const CA = compile(z.array(z.string().refine(async () => true)));
    const p = withLength(1);
    assert.equal(await CA.parseAsync(p), p, "the async layout: the input by reference");
    ok(
      "an under-reported Proxy length keeps the clean path (the known limitation), a rewrite copies to stock's output",
    );
  }
}

console.log("\nAll tuple + async smoke assertions passed ✓");
