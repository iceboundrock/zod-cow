/**
 * Smoke test: behavior and code dump for z4 (official codegen + CoW decoration).
 */
import assert from "node:assert/strict";
import { z } from "zod4";
import { compile } from "../src/index-z4.js";

/* ── 1. basic object: a clean input returns the original reference ── */
{
  const S = z.object({ a: z.string().max(4), b: z.email(), c: z.enum(["x", "y"]) });
  const C = compile(S);
  const input = { a: "abc", b: "u@e.com", c: "x" };
  const out = C.parse(input);
  console.log("── basic object ──");
  console.log(
    `  skeleton source:\n${C.code!.split("\n")
      .map((l) => `    ${l}`)
      .join("\n")}`,
  );
  console.log("  clean input out === input:", out === input, "(expected true)");
  assert.equal(out, input);

  // Failure path: stock semantics (ZodError + issues)
  const bad = C.safeParse({ a: "toolong", b: "u@e.com", c: "x" });
  assert.equal(bad.success, false);
  if (!bad.success) {
    console.log(
      "  failure path issues:",
      bad.error.issues.length,
      "path:",
      JSON.stringify(bad.error.issues[0]!.path),
    );
  }

  // validate: the official assertOnly whole-tree product
  console.log("  validate(input) === input:", C.validate(input) === input);
}

/* ── 2. strip: extra keys → stripped by a shallow copy ── */
{
  const S = z.object({ a: z.string(), b: z.number() });
  const C = compile(S);
  const input = { a: "x", b: 1, extra: true, more: 2 };
  const out = C.parse(input) as typeof input;
  console.log("\n── strip extra keys ──");
  console.log("  out === input:", out === input, "(expected false, the extra keys force a copy)");
  console.log("  out keys:", Object.keys(out).join(","), "(expected a,b)");
  console.log("  input undistorted:", "extra" in input && "more" in input);
  assert.notEqual(out, input);
  assert.deepEqual(Object.keys(out).sort(), ["a", "b"]);
  assert.ok("extra" in input && "more" in input);

  // strict: extra keys → failure
  const Strict = z.strictObject({ a: z.string() });
  const CS = compile(Strict);
  assert.equal(CS.safeParse({ a: "x", extra: 1 }).success, false);
  assert.deepEqual(CS.parse({ a: "x" }), { a: "x" });
  console.log("  strict: extra keys rejected ✓  clean input passes ✓");
}

/* ── 3. dirty payload: default injection → single-key shallow copy ── */
{
  const S = z.object({ name: z.string(), role: z.enum(["a", "b"]).default("b") });
  const C = compile(S);
  const clean = { name: "n", role: "a" };
  const dirty = { name: "n" }; // role missing → default injected
  const outClean = C.parse(clean);
  const outDirty = C.parse(dirty) as { name: string; role: string };
  console.log("\n── default injection ──");
  console.log("  clean out === clean:", outClean === clean, "(expected true)");
  console.log(
    "  dirty out.role:",
    outDirty.role,
    " out === dirty:",
    outDirty === dirty,
    "(expected false)",
  );
  console.log("  dirty undistorted:", !("role" in dirty));
  assert.equal(outClean, clean);
  assert.equal(outDirty.role, "b");
  assert.notEqual(outDirty, dirty);
  assert.ok(!("role" in dirty));
}

/* ── 4. transform → reference comparison marks dirty automatically ── */
{
  const S = z.object({ n: z.string(), len: z.string().transform((s) => s.length) });
  const C = compile(S);
  const input: Record<string, unknown> = { n: "x", len: "abcd" };
  const out = C.parse(input) as { n: string; len: number };
  console.log("\n── transform (pipe) ──");
  console.log("  out:", JSON.stringify(out), " out === input:", out === input, "(expected false)");
  console.log("  input undistorted:", input.len === "abcd");
  assert.deepEqual(out, { n: "x", len: 4 });
  assert.notEqual(out, input);
  assert.equal(input.len, "abcd");
}

/* ── 5. array/object nesting: a clean inner value stays shared ── */
{
  const S = z.object({
    name: z.string(),
    tags: z.array(z.string()),
    addr: z.object({ city: z.string(), zip: z.string() }),
  });
  const C = compile(S);
  const addr = { city: "NYC", zip: "10001" };
  const input = { name: "n", tags: ["a", "b"], addr };
  const out = C.parse(input) as typeof input;
  console.log("\n── nested sharing ──");
  console.log("  out === input:", out === input);
  console.log("  out.addr === addr:", out.addr === addr, "(nested original reference)");
  assert.equal(out, input);
  assert.equal(out.addr, addr);

  // Inner value turns dirty: addr carries an extra key → only addr is shallow-copied, the top level is copied, tags stays shared
  const input2 = { name: "n", tags: ["a", "b"], addr: { city: "NYC", zip: "10001", extra: 1 } };
  const S2 = z.object({
    name: z.string(),
    tags: z.array(z.string()),
    addr: z.object({ city: z.string(), zip: z.string() }),
  });
  const C2 = compile(S2);
  const out2 = C2.parse(input2) as typeof input2;
  console.log("  dirty addr: out2 === input2:", out2 === input2, "(expected false)");
  console.log(
    "  out2.addr === input2.addr:",
    out2.addr === input2.addr,
    "(expected false, it was copied)",
  );
  console.log("  out2.addr extra keys stripped:", !("extra" in out2.addr));
  assert.notEqual(out2, input2);
  assert.notEqual(out2.addr, input2.addr);
  assert.ok(!("extra" in out2.addr));
}

/* ── 6. array element CoW ── */
{
  const S = z.array(z.object({ id: z.number(), name: z.string() }));
  const C = compile(S);
  const items = [
    { id: 1, name: "a" },
    { id: 2, name: "b" },
  ];
  const out = C.parse(items) as typeof items;
  console.log("\n── array elements ──");
  console.log("  out === items:", out === items);
  assert.equal(out, items);

  const S2 = z.array(z.object({ id: z.number().int(), n: z.number().default(0) }));
  const C2 = compile(S2);
  const items2 = [{ id: 1, n: 5 }, { id: 2 }];
  const out2 = C2.parse(items2) as { id: number; n: number }[];
  console.log("  dirty array: out2 === items2:", out2 === items2, "(expected false)");
  console.log(
    "  out2[1]:",
    JSON.stringify(out2[1]),
    " items2[1] undistorted:",
    !("n" in items2[1]!),
  );
  assert.notEqual(out2, items2);
  assert.deepEqual(out2[1], { id: 2, n: 0 });
  assert.ok(!("n" in items2[1]!));
}

/* ── 7. optional/nullable/union clean keys ── */
{
  const S = z.object({
    a: z.string().optional(),
    b: z.number().nullable(),
    c: z.union([z.string(), z.number()]),
  });
  const C = compile(S);
  const i1 = { b: null, c: "s" }; // a is absent
  const o1 = C.parse(i1);
  console.log("\n── optional/nullable/union ──");
  console.log("  absent optional: out === input:", o1 === i1);
  assert.equal(o1, i1);
  const i2 = { a: undefined, b: 1, c: 2 };
  const o2 = C.parse(i2) as typeof i2;
  assert.equal(o2, i2);
  console.log("  present-undefined kept:", "a" in o2);
}

/* ── 8. top-level array + impure element transform ── */
{
  const S = z.array(z.string().transform((s) => s.toUpperCase()));
  const C = compile(S);
  const out = C.parse(["a", "b"]) as string[];
  console.log("\n── array element transform ──");
  console.log("  out:", JSON.stringify(out));
  assert.deepEqual(out, ["A", "B"]);
}

/* ── 9. degradation: schema catchall / recursion / async ── */
{
  const Catchall = z.object({ a: z.string() }).catchall(z.number());
  const CC = compile(Catchall);
  console.log("\n── degradation ──");
  console.log("  catchall schema → stock:", CC.stock, "(expected true)");
  assert.equal(CC.stock, true);

  type Tree = { v: string; children?: Tree[] };
  const Tree: any = z.object({ v: z.string(), children: z.array(z.lazy(() => Tree)).optional() });
  const CT = compile(Tree);
  console.log("  recursion → stock:", CT.stock);
  const treeInput: Tree = { v: "root", children: [{ v: "leaf" }] };
  const treeOut = CT.safeParse(treeInput);
  assert.ok(treeOut.success);
  console.log("  recursive stock semantics work ✓");

  const Async = z.string().refine(async (s) => s.length > 0);
  const CA = compile(Async);
  console.log(
    "  async refine → stock:",
    CA.stock,
    "async channel:",
    CA.async,
    "(since Task 6 there is no whole-tree degradation, expected stock=false async=true)",
  );
  assert.equal(CA.stock, false);
  assert.equal(CA.async, true);
  // The sync API throws $ZodAsyncError on an async skeleton (the same semantics as official)
  let syncThrew = false;
  try {
    CA.parse("hello");
  } catch (e: any) {
    syncThrew = e.constructor.name === "$ZodAsyncError";
  }
  assert.ok(syncThrew, "sync parse should throw $ZodAsyncError");
  const asyncOut = await CA.parseAsync("hello");
  assert.equal(asyncOut, "hello"); // pure subtree output = the original input reference
  console.log(
    "  async parseAsync returns the original reference ✓  sync API throws $ZodAsyncError ✓",
  );
}

console.log("\nAll smoke assertions passed ✓");
