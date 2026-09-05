/**
 * Smoke test: behavior and code dump for z4 (official codegen + CoW decoration).
 */
import assert from "node:assert/strict";
import { z } from "zod";
import { compile } from "../src/index.js";

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

  const extraSymbol = Symbol("extra");
  const symbolInput = { a: "x", b: 1, [extraSymbol]: true };
  const symbolOut = C.parse(symbolInput);
  assert.notEqual(symbolOut, symbolInput);
  assert.deepEqual(symbolOut, S.parse(symbolInput));
  assert.ok(extraSymbol in symbolInput && !(extraSymbol in symbolOut));

  const largeShape: Record<string, z.ZodString> = {};
  const largeInput: Record<string, string> = {};
  for (let i = 0; i < 17; i++) {
    largeShape[`k${i}`] = z.string();
    largeInput[`k${i}`] = "x";
  }
  const Large = compile(z.object(largeShape));
  assert.equal(Large.parse(largeInput), largeInput);
  const largeExtra = { ...largeInput, extra: "x" };
  assert.deepEqual(Large.parse(largeExtra), largeInput);

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

/* ── readonly: the zod4 line freezes exactly what stock freezes (#28) ── */
{
  console.log("\n── readonly ──");
  // Container: the official parser builds a new object and freezes the copy; the input stays unfrozen.
  const RO = compile(z.object({ a: z.string() }).readonly());
  const roIn = { a: "x" };
  const roOut = RO.parse(roIn);
  assert.notEqual(roOut, roIn);
  assert.equal(Object.isFrozen(roIn), false);
  assert.equal(Object.isFrozen(roOut), true);
  console.log("  object().readonly(): output is a frozen copy, input stays unfrozen ✓");

  // Pass-through leaf: stock readonly freezes whatever the inner parser hands back, which for any/unknown
  // is the input itself. The zod4 line hands the subtree to the official parser and so does the same.
  for (const [name, S] of [
    ["any", z.any().readonly()],
    ["unknown", z.unknown().readonly()],
  ] as const) {
    const stockIn = { a: "x" };
    const stockOut = S.parse(stockIn);
    assert.equal(stockOut, stockIn);
    assert.equal(Object.isFrozen(stockIn), true);
    const cowIn = { a: "x" };
    const cowOut = compile(S).parse(cowIn);
    assert.equal(cowOut, cowIn);
    assert.equal(Object.isFrozen(cowIn), true);
    console.log(`  ${name}().readonly(): input frozen in place, same as stock ✓`);
  }

  // Nested: the pass-through leaf freezes only its own value; the clean parent is still returned by reference.
  const Nested = compile(z.object({ n: z.unknown().readonly() }));
  const nIn = { n: { b: 1 } };
  const nOut = Nested.parse(nIn);
  assert.equal(nOut, nIn);
  assert.equal(Object.isFrozen(nIn), false);
  assert.equal(Object.isFrozen(nIn.n), true);
  console.log(
    "  object({ n: unknown().readonly() }): parent shared, nested value frozen in place ✓",
  );
}

/* ── copy path: stock's output assembly from the captured locals ── */
{
  console.log("\n── copy path ──");
  // A getter is read exactly once, on the copy path too (#36): the copy is assembled from the
  // locals captured while validating, never from a second read through a spread.
  let reads = 0;
  const G = z.object({ a: z.string(), b: z.string().default("d") });
  const getterInput = {
    get a() {
      reads++;
      return "x";
    },
  };
  const gOut = compile(G).parse(getterInput);
  assert.deepEqual(gOut, { a: "x", b: "d" });
  assert.equal(reads, 1);
  reads = 0;
  G.parse(getterInput);
  assert.equal(reads, 1);
  console.log("  getter read once on the copy path (stock reads once too) ✓");

  // The copy follows stock's key order (shape order), not the input's
  const O = z.object({ a: z.string(), b: z.number().default(1), c: z.boolean() });
  const oOut = compile(O).parse({ c: true, a: "x", extra: 1 });
  assert.deepEqual(Object.keys(oOut), Object.keys(O.parse({ c: true, a: "x", extra: 1 })));
  assert.deepEqual(Object.keys(oOut), ["a", "b", "c"]);
  console.log("  copy path key order = shape order, same as stock ✓");

  // Optional keys on the copy path: absent stays absent, present-undefined stays present (stock rules)
  const P = z.object({
    a: z.string().optional(),
    b: z.string().default("d"),
    c: z.string().optional(),
  });
  const pIn = { c: undefined };
  const pOut = compile(P).parse(pIn) as Record<string, unknown>;
  assert.deepEqual(pOut, P.parse(pIn));
  assert.ok(!("a" in pOut) && "c" in pOut && pOut.c === undefined && pOut.b === "d");
  console.log("  optional keys: absent not materialized, present-undefined kept ✓");

  // Strip shape declaring only symbol keys still probes for undeclared string keys (#35)
  const sym = Symbol("declared");
  const SymOnly = compile(z.object({ [sym]: z.string() }));
  const symClean = { [sym]: "x" };
  assert.equal(SymOnly.parse(symClean), symClean);
  const symExtra = { [sym]: "x", extra: 1 };
  const symOut = SymOnly.parse(symExtra);
  assert.notEqual(symOut, symExtra);
  assert.deepEqual(symOut, z.object({ [sym]: z.string() }).parse(symExtra));
  assert.ok(!("extra" in symOut));
  console.log("  symbol-only strip shape strips undeclared string keys ✓");

  // Loose copy: undeclared string keys follow the shape keys, as in stock's rebuild
  const L = z.looseObject({ a: z.string(), b: z.number().default(1) });
  const lIn = { extra: 1, a: "x" };
  const lOut = compile(L).parse(lIn);
  assert.deepEqual(lOut, L.parse(lIn));
  assert.deepEqual(Object.keys(lOut), ["a", "b", "extra"]);
  console.log("  loose copy keeps undeclared keys after the shape keys ✓");
}

/* ── 12. ownSymbolKeys: the opt-in that skips the own-symbol probe of strip-mode objects (#43) ── */
{
  console.log("\n── ownSymbolKeys option ──");
  const S = z.object({ a: z.string(), b: z.number().default(1) });
  const sym = Symbol("undeclared");
  const withSymbol = { a: "x", b: 2, [sym]: true };

  // Default and explicit "probe": stock semantics, the undeclared symbol forces a copy that drops it
  for (const C of [compile(S), compile(S, {}), compile(S, { ownSymbolKeys: "probe" })]) {
    const out = C.parse(withSymbol);
    assert.notEqual(out, withSymbol);
    assert.ok(!(sym in out));
    assert.ok(C.code!.includes("getOwnPropertySymbols"));
  }
  console.log('  default / "probe": undeclared symbol still forces a copy ✓');

  // "ignore": no probe in the generated code; a clean input keeps its own symbol by reference (the
  // documented divergence from stock, the same one strict and loose objects have, #42)
  const I = compile(S, { ownSymbolKeys: "ignore" });
  assert.ok(!I.stock);
  assert.ok(!I.code!.includes("getOwnPropertySymbols"));
  assert.equal(I.parse(withSymbol), withSymbol);
  assert.ok(sym in S.parse(withSymbol) === false, "stock drops the undeclared symbol");
  console.log('  "ignore": clean input with an own symbol returned by reference ✓');

  // Still strip semantics for string keys, and the copy path still drops the symbol like stock
  const extraString = { a: "x", b: 2, extra: 1, [sym]: true };
  const stripped = I.parse(extraString);
  assert.notEqual(stripped, extraString);
  assert.deepEqual(stripped, S.parse(extraString));
  assert.ok(!("extra" in stripped) && !(sym in stripped));
  const defaulted = { a: "x", [sym]: true };
  const copied = I.parse(defaulted);
  assert.notEqual(copied, defaulted);
  assert.deepEqual(copied, S.parse(defaulted));
  assert.ok(!(sym in copied));
  console.log('  "ignore": undeclared string keys and the copy path unchanged ✓');

  // Declared symbol keys are still validated and copied
  const declared = Symbol("declared");
  const D = compile(z.object({ a: z.string(), [declared]: z.number() }), {
    ownSymbolKeys: "ignore",
  });
  const dIn = { a: "x", [declared]: 1 };
  assert.equal(D.parse(dIn), dIn);
  assert.equal(D.safeParse({ a: "x", [declared]: "no" }).success, false);
  const dCopy = D.parse({ a: "x", [declared]: 1, extra: 1 });
  assert.equal((dCopy as Record<symbol, unknown>)[declared], 1);
  console.log('  "ignore": declared symbol keys still validated and written ✓');

  // The option reaches nested sub-skeletons: a clean nested object with an own symbol is shared
  const Nested = z.object({
    inner: z.object({ v: z.string() }),
    list: z.array(z.object({ w: z.number() })),
  });
  const NI = compile(Nested, { ownSymbolKeys: "ignore" });
  const nIn = { inner: { v: "x", [sym]: 1 }, list: [{ w: 1, [sym]: 2 }] };
  assert.equal(NI.parse(nIn), nIn);
  const NP = compile(Nested);
  const nOut = NP.parse(nIn) as typeof nIn;
  assert.notEqual(nOut, nIn);
  assert.notEqual(nOut.inner, nIn.inner);
  assert.notEqual(nOut.list[0], nIn.list[0]);
  console.log('  "ignore": propagates into nested object skeletons ✓');

  // An unknown value is a programming error, reported at compile time
  assert.throws(() => compile(S, { ownSymbolKeys: "drop" as never }), TypeError);
  console.log("  unknown value throws TypeError ✓");
}

console.log("\nAll smoke assertions passed ✓");
