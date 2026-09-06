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
  // slot): the copy keeps a hole where the index is not own, so the rest loop materializes it; `slice` (#86) read the
  // inherited value through `HasProperty` and made it own, and the clean path returned the input with the hole
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
  // Code pin: a rest tuple's sync skeleton copies the rest by hand once (#87: `slice` pays a fixed builtin cost);
  // a fixed tuple allocates nothing on its clean path
  const restCode = compile(z.tuple([z.string()], z.string())).code ?? "";
  assert.ok(
    /new Array\(/.test(restCode) && !/\.slice\(/.test(restCode),
    "the sync rest layout copies by hand",
  );
  const fixedCode = compile(z.tuple([z.string(), z.number().optional()])).code ?? "";
  assert.ok(!/new Array\(|\.slice\(/.test(fixedCode), "a tuple without a rest takes no copy");
  ok("the rest copy is emitted for a rest tuple only");
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
  // hand the parse to stock `safeParseAsync`, whose output and issues are stock's. The sync entries throw stock's class.
  type Case = {
    name: string;
    make: (ok: boolean) => z.ZodType;
    input: () => unknown;
    validateThrows: boolean;
  };
  const plain = (ok: boolean) => () => Promise.resolve(ok);
  const cases: Case[] = [
    {
      name: "top-level array refine",
      make: (ok) => z.array(z.string()).refine(plain(ok)),
      input: () => ["x"],
      validateThrows: true,
    },
    {
      name: "leaf refine under an object key",
      make: (ok) => z.object({ a: z.string().refine(plain(ok)) }),
      input: () => ({ a: "x" }),
      validateThrows: true,
    },
    {
      name: "refine on optional(object)",
      make: (ok) => z.object({ a: z.string() }).optional().refine(plain(ok)),
      input: () => ({ a: "x" }),
      validateThrows: true,
    },
    {
      name: "custom check returning a Promise",
      make: (ok) =>
        z.array(z.string()).check((ctx) => {
          if (!ok) ctx.issues.push({ code: "custom", input: ctx.value, message: "no" });
          return Promise.resolve();
        }),
      input: () => ["x"],
      validateThrows: true,
    },
    {
      name: "transform returning a Promise",
      make: () => z.array(z.string()).transform((v) => Promise.resolve([...v, "t"])),
      input: () => ["x"],
      validateThrows: false, // the official assertOnly product answers INVALID for a Promise from a transform, so `validate` gives null
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
      if (c.validateThrows) {
        assert.throws(
          () => C.validate(c.input()),
          $ZodAsyncError,
          `${c.name}: validate throws stock's class`,
        );
      } else {
        assert.equal(C.validate(c.input()), null);
      }
    }
    ok(c.name);
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

  // Residual: a callback that stock's generated code calls (a leaf refine, a custom check or a superRefine inside
  // an official product) reports its Promise signal with the same class from a throw site this layer cannot mark,
  // so a `$ZodAsyncError` such a callback throws is handed to stock's async runtime like the signal: a callback that
  // throws on every call rejects with the same error after running twice (the documented failure-path duplicate),
  // one that throws on the first call only passes on the rerun where stock rejects. Pinned here; tracked in #80.
  {
    const always = (log: string[]) => () => {
      log.push("c");
      nested.parse("x");
      return true;
    };
    const leafCases: [string, (fn: () => boolean) => z.ZodType, unknown][] = [
      [
        "leaf refine under an object key",
        (fn) => z.object({ a: z.string().refine(fn) }),
        { a: "x" },
      ],
      ["top-level leaf refine", (fn) => z.string().refine(fn), "x"],
    ];
    for (const [name, make, input] of leafCases) {
      const stockLog: string[] = [];
      await assert.rejects(make(always(stockLog)).safeParseAsync(input), $ZodAsyncError);
      assert.equal(stockLog.length, 1);
      const log: string[] = [];
      const C = compile(make(always(log)));
      assert.ok(!C.async && !C.stock);
      await assert.rejects(C.safeParseAsync(input), $ZodAsyncError, `${name}: the same rejection`);
      assert.equal(
        log.length,
        2,
        `${name}: the fast path and stock's async runtime each ran the callback`,
      );
      const onceLog: string[] = [];
      const CO = compile(make(once(onceLog, () => nested.parse("x"))));
      const r = await CO.safeParseAsync(input);
      assert.ok(r.success, `${name}: a first-call-only throw passes on the rerun (known, #80)`);
      assert.equal(onceLog.length, 2);
    }
    ok(
      "inside an official product the callback's $ZodAsyncError still takes the fallback (pinned, #80)",
    );
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
  // `subtreeHasAsync`, the same answer the `lazy` case already takes.
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
}

console.log("\nAll tuple + async smoke assertions passed ✓");
