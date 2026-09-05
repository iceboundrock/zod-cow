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

  // ... through every container skeleton, not only object and array: a strip object under a tuple,
  // a record, a map and a set is shared under "ignore" and copied by default. Nested skeletons are
  // separate Function builds, so this is pinned by behavior, not by inspecting `code`
  const Inner = z.object({ v: z.string() });
  const Containers = z.object({
    tup: z.tuple([Inner]),
    rec: z.record(z.string(), Inner),
    map: z.map(z.string(), Inner),
    set: z.set(Inner),
  });
  const cIn = {
    tup: [{ v: "x", [sym]: 1 }] as const,
    rec: { k: { v: "x", [sym]: 1 } },
    map: new Map([["k", { v: "x", [sym]: 1 }]]),
    set: new Set([{ v: "x", [sym]: 1 }]),
  };
  assert.equal(compile(Containers, { ownSymbolKeys: "ignore" }).parse(cIn), cIn);
  const cOut = compile(Containers).parse(cIn) as z.output<typeof Containers>;
  assert.notEqual(cOut, cIn);
  assert.notEqual(cOut.tup[0], cIn.tup[0]);
  assert.notEqual(cOut.rec.k, cIn.rec.k);
  assert.notEqual(cOut.map.get("k"), cIn.map.get("k"));
  assert.notEqual([...cOut.set][0], [...cIn.set][0]);
  assert.deepEqual(cOut, Containers.parse(cIn));
  console.log('  "ignore": propagates through tuple, record, map and set skeletons ✓');

  // The probe covers every own symbol, non-enumerable ones included (`Object.getOwnPropertySymbols`
  // lists them all, and stock's rebuild drops them all): the default copies, "ignore" shares
  const hidden = Symbol("hidden");
  const withHidden = Object.defineProperty({ a: "x", b: 2 }, hidden, {
    value: 1,
    enumerable: false,
  });
  assert.ok(!(hidden in S.parse(withHidden)), "stock drops a non-enumerable undeclared symbol");
  const hiddenOut = compile(S).parse(withHidden);
  assert.notEqual(hiddenOut, withHidden);
  assert.ok(!(hidden in hiddenOut));
  assert.equal(I.parse(withHidden), withHidden);
  console.log('  non-enumerable undeclared symbol: default copies, "ignore" shares ✓');

  // An unknown value is a programming error, reported at compile time
  assert.throws(() => compile(S, { ownSymbolKeys: "drop" as never }), TypeError);
  assert.throws(() => compile(S, [] as never), TypeError);
  assert.throws(() => compile(S, null as never), TypeError);
  console.log("  unknown value, array or null options throw TypeError ✓");

  // An explicit `undefined` is an absent property (the default); an explicit `null` is a value
  // other than the two strings and throws like any other unknown value
  assert.equal(compile(S, { ownSymbolKeys: undefined }).code, compile(S).code);
  assert.throws(() => compile(S, { ownSymbolKeys: null as never }), TypeError);
  console.log("  explicit undefined is the default, explicit null throws TypeError ✓");

  // Only a plain object (Object.prototype or null prototype) is an options argument: a class
  // instance, a Date or an object inheriting `ownSymbolKeys` from its prototype is rejected
  class Opts {
    ownSymbolKeys = "ignore" as const;
  }
  assert.throws(() => compile(S, new Opts()), TypeError);
  assert.throws(() => compile(S, new Date() as never), TypeError);
  assert.throws(() => compile(S, Object.create({ ownSymbolKeys: "ignore" })), TypeError);
  const nullProto = Object.assign(Object.create(null), { ownSymbolKeys: "ignore" as const });
  assert.ok(!compile(S, nullProto).code!.includes("getOwnPropertySymbols"));
  console.log("  non-plain options object throws TypeError, null-prototype object accepted ✓");

  // The rejection stays a TypeError whatever the rejected object does when inspected: the
  // diagnostic reads `constructor` and `name` through property descriptors, so a throwing accessor
  // never runs, and a Proxy whose `getPrototypeOf` trap throws counts as a non-plain object
  const throwingCtor = Object.create(null, {
    constructor: {
      get() {
        throw new Error("constructor getter ran");
      },
    },
  });
  assert.throws(() => compile(S, Object.create(throwingCtor)), TypeError);
  class ThrowingName {}
  Object.defineProperty(ThrowingName, "name", {
    get() {
      throw new Error("name getter ran");
    },
  });
  assert.throws(() => compile(S, new ThrowingName() as never), TypeError);
  const throwingTrap = new Proxy(
    {},
    {
      getPrototypeOf() {
        throw new Error("getPrototypeOf trap ran");
      },
    },
  );
  assert.throws(() => compile(S, throwingTrap), TypeError);
  assert.throws(() => compile(S, new Date() as never), {
    name: "TypeError",
    message: /an instance of Date/,
  });
  console.log(
    "  a throwing accessor or Proxy trap on a rejected options object still gives TypeError ✓",
  );

  // Only an own `ownSymbolKeys` property is read: a value inherited from `Object.prototype`
  // (prototype pollution) does not turn `compile(S, {})` into the opt-in, so `compile(S)` and
  // `compile(S, {})` stay equivalent whatever the prototype carries
  const proto = Object.prototype as { ownSymbolKeys?: unknown };
  proto.ownSymbolKeys = "ignore";
  try {
    assert.equal(compile(S, {}).code, compile(S).code);
    assert.ok(compile(S, {}).code!.includes("getOwnPropertySymbols"));
    assert.ok(!compile(S, { ownSymbolKeys: "ignore" }).code!.includes("getOwnPropertySymbols"));
  } finally {
    delete proto.ownSymbolKeys;
  }
  console.log("  ownSymbolKeys inherited from Object.prototype is ignored ✓");

  // The same holds for a rejected *value*: its description never runs the value's own code
  // (no `JSON.stringify`, which would call a `toJSON` or a Proxy `get` trap), and every kind of
  // value has a description of its own instead of JSON's throw or "undefined"
  const throwingToJSON = {
    toJSON() {
      throw new Error("toJSON ran");
    },
  };
  assert.throws(() => compile(S, { ownSymbolKeys: throwingToJSON as never }), {
    name: "TypeError",
    message: /got a plain object$/,
  });
  const throwingGet = new Proxy(
    {},
    {
      get() {
        throw new Error("get trap ran");
      },
    },
  );
  assert.throws(() => compile(S, { ownSymbolKeys: throwingGet as never }), TypeError);
  const circular: { self?: unknown } = {};
  circular.self = circular;
  assert.throws(() => compile(S, { ownSymbolKeys: circular as never }), {
    name: "TypeError",
    message: /got a plain object$/,
  });
  assert.throws(() => compile(S, { ownSymbolKeys: 1n as never }), {
    name: "TypeError",
    message: /got 1n$/,
  });
  assert.throws(() => compile(S, { ownSymbolKeys: Symbol("s") as never }), {
    name: "TypeError",
    message: /got a symbol$/,
  });
  assert.throws(() => compile(S, { ownSymbolKeys: (() => "probe") as never }), {
    name: "TypeError",
    message: /got a function$/,
  });
  assert.throws(() => compile(S, { ownSymbolKeys: new Date() as never }), {
    name: "TypeError",
    message: /got an instance of Date$/,
  });
  assert.throws(() => compile(S, { ownSymbolKeys: "drop" as never }), {
    name: "TypeError",
    message: /got "drop"$/,
  });
  console.log("  a rejected value is described without running its code ✓");

  // Reading the option off a Proxy options object runs its traps (that read is the caller's own
  // object doing what it was built to do); a trap that throws still surfaces as the promised
  // TypeError, with the trap's error as `cause`, and a Proxy that behaves is an ordinary options object
  const proxied = new Proxy({ ownSymbolKeys: "ignore" as const }, {});
  assert.ok(!compile(S, proxied).code!.includes("getOwnPropertySymbols"));
  const throwingDescriptorTrap = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        throw new Error("getOwnPropertyDescriptor trap ran");
      },
    },
  );
  assert.throws(
    () => compile(S, throwingDescriptorTrap),
    (e: unknown) =>
      e instanceof TypeError && (e.cause as Error).message === "getOwnPropertyDescriptor trap ran",
  );
  const throwingGetTrap = new Proxy(
    { ownSymbolKeys: "ignore" as const },
    {
      get() {
        throw new Error("get trap ran");
      },
    },
  );
  assert.throws(
    () => compile(S, throwingGetTrap),
    (e: unknown) => e instanceof TypeError && (e.cause as Error).message === "get trap ran",
  );
  const revocable = Proxy.revocable({}, {});
  revocable.revoke();
  assert.throws(() => compile(S, revocable.proxy), {
    name: "TypeError",
    message: /got a revoked Proxy$/,
  });
  console.log("  a Proxy options object whose trap throws still gives TypeError ✓");
}

/* ── 13. ownSymbolKeys in strict and loose objects: the own-symbol probe runs in every mode (#42) ── */
{
  console.log("\n── ownSymbolKeys in strict and loose objects ──");
  const sym = Symbol("undeclared");
  const hidden = Symbol("hidden");
  const shape = { a: z.string(), b: z.number().default(1) };
  const modes = [
    ["strict", z.strictObject(shape)],
    ["loose", z.looseObject(shape)],
  ] as const;
  for (const [label, S] of modes) {
    const clean = { a: "x", b: 2, [sym]: true };
    assert.ok(!(sym in S.parse(clean)), `stock ${label} drops the undeclared symbol`);
    // Default and explicit "probe": stock semantics, the undeclared own symbol forces a copy that
    // drops it; the same input without the symbol is still returned by reference
    for (const C of [compile(S), compile(S, { ownSymbolKeys: "probe" })]) {
      assert.ok(!C.stock);
      assert.ok(C.code!.includes("getOwnPropertySymbols"));
      const out = C.parse(clean);
      assert.notEqual(out, clean);
      assert.ok(!(sym in out));
      assert.deepEqual(out, S.parse(clean));
      const plain = { a: "x", b: 2 };
      assert.equal(C.parse(plain), plain);
      // Non-enumerable undeclared symbols are dropped by stock too, so they force a copy as well
      const withHidden = Object.defineProperty({ a: "x", b: 2 }, hidden, {
        value: 1,
        enumerable: false,
      });
      assert.ok(!(hidden in S.parse(withHidden)));
      const hiddenOut = C.parse(withHidden);
      assert.notEqual(hiddenOut, withHidden);
      assert.ok(!(hidden in hiddenOut));
    }
    // "ignore": no probe in the generated code, the clean input keeps its symbol by reference
    const I = compile(S, { ownSymbolKeys: "ignore" });
    assert.ok(!I.stock);
    assert.ok(!I.code!.includes("getOwnPropertySymbols"));
    assert.equal(I.parse(clean), clean);
    // The copy path drops the symbol under both settings, as it did before the probe
    const defaulted = { a: "x", [sym]: true };
    for (const C of [compile(S), I]) {
      const copied = C.parse(defaulted);
      assert.notEqual(copied, defaulted);
      assert.deepEqual(copied, S.parse(defaulted));
      assert.ok(!(sym in copied));
    }
    console.log(`  ${label}: default copies on an undeclared symbol, "ignore" shares ✓`);
  }

  // Strict still rejects an undeclared string key on every path (a symbol never counts as one)
  const Strict = compile(z.strictObject(shape));
  assert.equal(Strict.safeParse({ a: "x", b: 2, extra: 1 }).success, false);
  assert.equal(Strict.safeParse({ a: "x", b: 2, extra: 1, [sym]: true }).success, false);
  // Loose keeps an undeclared string key by reference when clean, and in the copy when the symbol
  // forces one; the copy drops the symbol like stock
  const LooseSchema = z.looseObject(shape);
  const Loose = compile(LooseSchema);
  const looseClean = { a: "x", b: 2, extra: 1 };
  assert.equal(Loose.parse(looseClean), looseClean);
  const looseIn = { a: "x", b: 2, extra: 1, [sym]: true };
  const looseOut = Loose.parse(looseIn) as Record<string | symbol, unknown>;
  assert.notEqual(looseOut, looseIn);
  assert.deepEqual(looseOut, LooseSchema.parse(looseIn));
  assert.ok("extra" in looseOut && !(sym in looseOut));
  console.log("  strict rejects undeclared string keys, loose keeps them and drops the symbol ✓");

  // A declared symbol key is known, not extra: the input is shared; an undeclared one next to it still copies
  const declared = Symbol("declared");
  const D = compile(z.strictObject({ a: z.string(), [declared]: z.number() }));
  const dIn = { a: "x", [declared]: 1 };
  assert.equal(D.parse(dIn), dIn);
  const dExtra = { a: "x", [declared]: 1, [sym]: true };
  const dOut = D.parse(dExtra) as Record<symbol, unknown>;
  assert.notEqual(dOut, dExtra);
  assert.equal(dOut[declared], 1);
  assert.ok(!(sym in dOut));
  console.log("  declared symbol keys are known keys in strict mode ✓");

  // The probe reaches a nested loose object under a strip object, and "ignore" switches it off there too
  const Nested = z.object({ inner: z.looseObject({ v: z.string() }) });
  const nIn = { inner: { v: "x", [sym]: 1 } };
  const nOut = compile(Nested).parse(nIn);
  assert.notEqual(nOut, nIn);
  assert.notEqual(nOut.inner, nIn.inner);
  assert.ok(!(sym in nOut.inner));
  assert.deepEqual(nOut, Nested.parse(nIn));
  assert.equal(compile(Nested, { ownSymbolKeys: "ignore" }).parse(nIn), nIn);
  console.log('  nested loose object: default copies, "ignore" shares ✓');
}

/* ── 14. a union with a container option is impure: it takes the official parser and strips like stock (#47) ── */
{
  console.log("\n── union with a container option (#47) ──");
  const U = z.union([z.object({ a: z.string() }), z.number()]);
  const C = compile(U);
  const input = { a: "x", extra: 1 };
  const out = C.parse(input);
  assert.deepEqual(out, { a: "x" });
  assert.deepEqual(out, U.parse(input));
  assert.notEqual(out, input);
  assert.equal(C.parse(3), 3);
  // White-box pin on the current codegen shape: a top-level assertOnly validator emits `return input;`, the
  // official parser path returns its own local (`return x0;`). Update the pin if the emitted shape changes.
  assert.ok(
    !C.code!.includes("return input;"),
    "the union is not handed to the assertOnly validator",
  );
  console.log("  strip-object option: undeclared key dropped like stock ✓");

  // Nested position: the parent copies because the union rebuilt its value; siblings keep sharing
  const N = z.object({ u: U, keep: z.object({ n: z.number() }) });
  const nIn = { u: input, keep: { n: 1 } };
  const nOut = compile(N).parse(nIn);
  assert.deepEqual(nOut, N.parse(nIn));
  assert.notEqual(nOut, nIn);
  assert.equal(nOut.keep, nIn.keep);
  console.log("  nested union: parent copies, sibling stays shared ✓");

  // A strict option with an undeclared own symbol key: stock drops the symbol in every mode (#42)
  const sym = Symbol("extra");
  const S = z.union([z.strictObject({ a: z.string() }), z.number()]);
  const sIn = { a: "x", [sym]: 1 };
  assert.ok(!(sym in (compile(S).parse(sIn) as object)));
  console.log("  strict option: undeclared own symbol dropped like stock ✓");

  // Container options under a wrapper, inside an array and in a discriminated union
  const W = z.union([z.object({ a: z.string() }).optional(), z.number()]);
  assert.deepEqual(compile(W).parse(input), { a: "x" });
  const A = z.union([z.array(z.object({ a: z.string() })), z.number()]);
  assert.deepEqual(compile(A).parse([input]), [{ a: "x" }]);
  const D = z.discriminatedUnion("k", [
    z.object({ k: z.literal("a"), v: z.string() }),
    z.object({ k: z.literal("b") }),
  ]);
  assert.deepEqual(compile(D).parse({ k: "b", extra: 1 }), { k: "b" });
  console.log(
    "  optional(object), array(object) and discriminatedUnion options strip like stock ✓",
  );

  // A union of leaves stays pure: the official validator answers and the parent keeps sharing
  const P = z.object({ v: z.union([z.string().optional(), z.literal(1)]) });
  const pIn = { v: 1 };
  assert.equal(compile(P).parse(pIn), pIn);
  assert.equal(compile(P).parse({ v: "s" }).v, "s");
  console.log("  leaf-only union keeps the validator, parent shares ✓");
}

/* ── 15. `code` is the whole dump: the top-level skeleton followed by every nested skeleton it built (#46) ── */
{
  console.log("\n── nested skeleton dump (#46) ──");
  const inner = z.object({ n: z.number() });
  const S = z.object({
    o: inner,
    a: z.array(inner),
    t: z.tuple([inner]),
    r: z.record(z.string(), inner),
    m: z.map(z.string(), inner),
    s: z.set(inner),
  });
  const C = compile(S);
  assert.ok(!C.stock);
  // Each nested container builds its own skeleton, so the dump holds a header per nested skeleton
  const headers = C.code!.match(/^\/\/ ── nested skeleton #\d+ ──$/gm) ?? [];
  assert.ok(
    headers.length >= 6,
    `dump holds ${headers.length} nested skeletons, expected at least 6`,
  );
  // The top-level source comes first, before any nested header
  assert.ok(C.code!.indexOf("nested skeleton #1") > C.code!.indexOf("return input;"));
  // Every object skeleton in the dump probes by default; none does under "ignore", at any depth
  const probes = (code: string) => code.split("getOwnPropertySymbols").length - 1;
  assert.ok(
    probes(C.code!) >= 7,
    `default dump carries ${probes(C.code!)} probes, expected at least 7`,
  );
  const I = compile(S, { ownSymbolKeys: "ignore" });
  assert.equal(probes(I.code!), 0);
  assert.equal(headers.length, (I.code!.match(/^\/\/ ── nested skeleton #\d+ ──$/gm) ?? []).length);
  // A schema whose only skeleton is the top-level one has no header at all
  assert.ok(!compile(inner).code!.includes("nested skeleton"));
  console.log(
    `  dump holds ${headers.length} nested skeletons; ${probes(C.code!)} probes by default, 0 under "ignore" ✓`,
  );
}

/* ── 16. ownSymbolKeys in records: enum-keyed records probe on the clean path, iterating records mark a non-enumerable symbol dirty (#51) ── */
{
  console.log("\n── ownSymbolKeys in records (#51) ──");
  const sym = Symbol("undeclared");
  const hidden = Symbol("hidden");
  const withHidden = <T extends object>(o: T): T =>
    Object.defineProperty(o, hidden, { value: 1, enumerable: false });
  /** Stock drops the undeclared own symbol on every path; the skeleton must copy and drop it too */
  const copiesAndDrops = (
    S: z.ZodType,
    C: { parse: (i: unknown) => unknown },
    input: object,
    label: string,
  ) => {
    const stockOut = S.parse(input) as object;
    assert.ok(!(sym in stockOut) && !(hidden in stockOut), `stock ${label} drops the symbol`);
    const out = C.parse(input) as object;
    assert.notEqual(out, input, `${label}: the undeclared own symbol forces a copy`);
    assert.ok(!(sym in out) && !(hidden in out), `${label}: the copy drops the symbol`);
    assert.deepEqual(out, stockOut);
    assert.deepEqual(Object.keys(out), Object.keys(stockOut), `${label}: key order`);
  };

  // Path A (enum keys), strict and loose: the clean path probes with `Object.getOwnPropertySymbols`
  // like the object skeleton (#42), so an undeclared own symbol, enumerable or not, forces a copy
  const enumKeys = z.enum(["a", "b"]);
  const pathA = [
    ["strict enum record", z.record(enumKeys, z.number()), { a: 1, b: 2 }],
    ["loose enum record", z.looseRecord(enumKeys, z.number()), { a: 1, b: 2, extra: 3 }],
  ] as const;
  for (const [label, S, plain] of pathA) {
    for (const C of [compile(S), compile(S, { ownSymbolKeys: "probe" })]) {
      assert.ok(!C.stock);
      assert.ok(C.code!.includes("getOwnPropertySymbols"), `${label}: the probe is emitted`);
      const clean = { ...plain };
      assert.equal(C.parse(clean), clean, `${label}: without the symbol the input is shared`);
      copiesAndDrops(S, C, { ...plain, [sym]: true }, `${label} (enumerable)`);
      copiesAndDrops(S, C, withHidden({ ...plain }), `${label} (non-enumerable)`);
    }
    // "ignore": no probe, the clean input keeps its symbol by reference, enumerable or not
    const I = compile(S, { ownSymbolKeys: "ignore" });
    assert.ok(!I.code!.includes("getOwnPropertySymbols"));
    const kept = { ...plain, [sym]: true };
    assert.equal(I.parse(kept), kept, `${label}: "ignore" shares`);
    const keptHidden = withHidden({ ...plain });
    assert.equal(I.parse(keptHidden), keptHidden, `${label}: "ignore" shares (non-enumerable)`);
    console.log(`  ${label}: default copies on an undeclared symbol, "ignore" shares ✓`);
  }
  // Path A copy path drops the symbol under both settings (a missing declared key is dirty)
  const Defaulted = z.record(enumKeys, z.number().default(0));
  for (const C of [compile(Defaulted), compile(Defaulted, { ownSymbolKeys: "ignore" })]) {
    const dirty = { a: 1, [sym]: true };
    const out = C.parse(dirty) as Record<string | symbol, unknown>;
    assert.notEqual(out, dirty);
    assert.deepEqual(out, Defaulted.parse(dirty));
    assert.ok(!(sym in out) && out.b === 0);
  }
  // Strict still rejects an undeclared string key on every path, symbol or not
  const Strict = compile(z.record(enumKeys, z.number()));
  assert.equal(Strict.safeParse({ a: 1, b: 2, extra: 3 }).success, false);
  assert.equal(Strict.safeParse({ a: 1, b: 2, extra: 3, [sym]: true }).success, false);
  console.log("  enum record: copy path drops the symbol, strict rejects string keys ✓");

  // Path C (bare string keys): stock validates an enumerable symbol as a key and rejects it, and
  // skips a non-enumerable one, which its rebuild then drops. The loop already sees both, so the
  // non-enumerable one marks the record dirty inside the existing skip; no probe call is added
  const StringKeys = z.record(z.string(), z.number());
  const pathBC = [
    ["string-keyed record", StringKeys],
    ["checked string-keyed record", z.record(z.string().min(1), z.number())],
    ["number-keyed record", z.record(z.number(), z.number())],
  ] as const;
  for (const [label, S] of pathBC) {
    for (const C of [compile(S), compile(S, { ownSymbolKeys: "probe" })]) {
      assert.ok(!C.stock);
      assert.ok(!C.code!.includes("getOwnPropertySymbols"), `${label}: no probe call`);
      const plain = { 1: 1, 2: 2 };
      assert.equal(C.parse(plain), plain);
      const enumerable = { 1: 1, 2: 2, [sym]: true };
      assert.equal(S.safeParse(enumerable).success, false, `stock ${label} rejects the symbol key`);
      assert.equal(C.safeParse(enumerable).success, false, `${label} rejects the symbol key`);
      copiesAndDrops(S, C, withHidden({ 1: 1, 2: 2 }), `${label} (non-enumerable)`);
    }
    const I = compile(S, { ownSymbolKeys: "ignore" });
    const keptHidden = withHidden({ 1: 1, 2: 2 });
    assert.equal(I.parse(keptHidden), keptHidden, `${label}: "ignore" shares (non-enumerable)`);
    assert.equal(
      I.safeParse({ 1: 1, [sym]: true }).success,
      false,
      `${label}: "ignore" still rejects`,
    );
    console.log(`  ${label}: non-enumerable symbol copies by default, "ignore" shares ✓`);
  }
  // A dirty value next to a non-enumerable symbol: one copy, the symbol dropped, under both settings
  const Transformed = z.record(
    z.string(),
    z.number().transform((n) => n + 1),
  );
  for (const C of [compile(Transformed), compile(Transformed, { ownSymbolKeys: "ignore" })]) {
    const input = withHidden({ a: 1 });
    const out = C.parse(input) as Record<string | symbol, unknown>;
    assert.notEqual(out, input);
    assert.deepEqual(out, Transformed.parse(input));
    assert.ok(!(hidden in out) && out.a === 2);
  }

  // Path B with a key schema that admits symbols keeps an enumerable symbol key like stock, and
  // a loose record keeps a key its schema rejects: both stay shared (parity, no divergence)
  const SymbolKeys = z.record(z.union([z.string(), z.symbol()]), z.number());
  const symIn = { a: 1, [sym]: 2 };
  assert.ok(sym in (SymbolKeys.parse(symIn) as object), "stock keeps an accepted symbol key");
  assert.equal(compile(SymbolKeys).parse(symIn), symIn);
  const LooseChecked = z.looseRecord(z.string().min(1), z.number());
  assert.ok(sym in (LooseChecked.parse(symIn) as object), "stock loose keeps a rejected key");
  assert.equal(compile(LooseChecked).parse(symIn), symIn);
  console.log(
    "  a key schema that admits symbols, and a loose record, keep the symbol like stock ✓",
  );

  // Nested: an enum record under a strip object; the default copies the path, "ignore" shares
  const Nested = z.object({ rec: z.record(enumKeys, z.number()) });
  const nIn = { rec: { a: 1, b: 2, [sym]: true } };
  const nOut = compile(Nested).parse(nIn);
  assert.notEqual(nOut, nIn);
  assert.notEqual(nOut.rec, nIn.rec);
  assert.ok(!(sym in nOut.rec));
  assert.deepEqual(nOut, Nested.parse(nIn));
  assert.equal(compile(Nested, { ownSymbolKeys: "ignore" }).parse(nIn), nIn);
  console.log('  nested enum record: default copies, "ignore" shares ✓');

  // Declared keys come back as the input defines them (the #48 family, documented, no probe): the
  // own-symbol probe asks only whether an undeclared symbol exists, so a clean record or object whose
  // declared key, symbol or string, is a non-enumerable property is returned by reference as it is,
  // where stock's rebuild writes an enumerable data property. The copy path writes it like stock.
  const declared = Symbol("declared");
  const nonEnumerable = <T extends object>(o: T, key: PropertyKey, value: unknown): T =>
    Object.defineProperty(o, key, { value, enumerable: false });
  const enumerableOf = (o: unknown, key: PropertyKey) =>
    Object.getOwnPropertyDescriptor(o as object, key)?.enumerable;
  const Literal = z.record(z.literal(declared as never), z.number());
  const plainDeclared = { [declared]: 1 };
  assert.deepEqual(Literal.parse(plainDeclared), plainDeclared);
  assert.equal(compile(Literal).parse(plainDeclared), plainDeclared, "a declared symbol is known");
  const declaredKeyed = [
    ["symbol-literal record", Literal, declared],
    ["enum record", z.record(z.enum(["a"]), z.number()), "a"],
    ["object, symbol key", z.object({ [declared]: z.number() }), declared],
    ["object, string key", z.object({ a: z.number() }), "a"],
  ] as const;
  for (const [label, S, key] of declaredKeyed) {
    const hiddenDeclared = nonEnumerable({}, key, 1);
    assert.equal(enumerableOf(S.parse(hiddenDeclared), key), true, `stock ${label}: enumerable`);
    assert.equal(
      compile(S).parse(hiddenDeclared),
      hiddenDeclared,
      `${label}: a declared non-enumerable key is returned as it is (#48)`,
    );
  }
  const LiteralT = z.record(
    z.literal(declared as never),
    z.number().transform((n) => n + 1),
  );
  const tOut = compile(LiteralT).parse(nonEnumerable({}, declared, 1)) as Record<symbol, unknown>;
  assert.equal(enumerableOf(tOut, declared), true, "the copy path writes it enumerable like stock");
  assert.equal(tOut[declared], 2);
  console.log("  declared keys come back as the input defines them, enumerable or not (#48) ✓");
}

/* ── 17. clean path keeps what stock's rebuild normalizes (#48) ── */
{
  console.log("\n── clean path keeps what stock's rebuild normalizes (#48) ──");
  // The two undeclared-key probes prove only what they look at (`for...in`: enumerable string keys;
  // `Object.getOwnPropertySymbols`: own symbols), and nothing on the clean path reads a property
  // descriptor or the prototype, so a clean input comes back with everything stock's rebuild would
  // normalize away. Documented under known limitations, not probed; the copy path is the official
  // assembly and matches stock. These assertions pin the documented behavior next to stock's, so a
  // future probe is a deliberate change. Group 16 pins the declared-key descriptor member.
  const hide = <T extends object>(o: T, key: PropertyKey, value: unknown): T =>
    Object.defineProperty(o, key, { value, enumerable: false });
  const ownNames = (o: unknown) => Object.getOwnPropertyNames(o as object);
  const bump = z.number().transform((n) => n + 1);
  const objectModes = [
    ["strip", z.object({ a: z.number() }), z.object({ a: bump })],
    ["strict", z.strictObject({ a: z.number() }), z.strictObject({ a: bump })],
    ["loose", z.looseObject({ a: z.number() }), z.looseObject({ a: bump })],
  ] as const;
  const [[, Strip], [, Strict], [, Loose]] = objectModes;
  const recordPaths = [
    ["enum record", z.record(z.enum(["a"]), z.number()), z.record(z.enum(["a"]), bump)],
    [
      "loose enum record",
      z.looseRecord(z.enum(["a"]), z.number()),
      z.looseRecord(z.enum(["a"]), bump),
    ],
    ["string record", z.record(z.string(), z.number()), z.record(z.string(), bump)],
    [
      "checked-string record",
      z.record(z.string().min(1), z.number()),
      z.record(z.string().min(1), bump),
    ],
  ] as const;

  // 1. A non-enumerable undeclared string key: stock's rebuild drops it on every path, the clean
  // path returns the input with it (the `for...in` probe and the record key loop skip it)
  for (const [label, S, T] of [...objectModes, ...recordPaths]) {
    const input = hide({ a: 1 }, "hidden", 2);
    assert.deepEqual(ownNames(S.parse(input)), ["a"], `stock ${label}: the hidden key is dropped`);
    assert.equal(compile(S).parse(input), input, `${label}: clean input returned as it is (#48)`);
    assert.deepEqual(ownNames(input), ["a", "hidden"], `${label}: the input is not mutated`);
    const dirty = hide({ a: 1 }, "hidden", 2);
    const out = compile(T).parse(dirty) as Record<string, unknown>;
    assert.notEqual(out, dirty);
    assert.deepEqual(ownNames(out), ["a"], `${label}: the copy path drops it like stock`);
    assert.equal(out.a, 2);
  }
  const NumberRecord = z.record(z.coerce.number(), z.number());
  const numberIn = hide({ 1: 1 }, "hidden", 2);
  assert.deepEqual(ownNames(NumberRecord.parse(numberIn)), ["1"]);
  assert.equal(compile(NumberRecord).parse(numberIn), numberIn, "number record: returned as it is");
  console.log(
    "  a non-enumerable undeclared string key survives the clean path, the copy drops it ✓",
  );

  // 2. The input's prototype: a class instance comes back as that instance where stock returns a
  // plain object; the copy path is a plain object like stock
  class Row {
    a = 1;
  }
  for (const [label, S, T] of objectModes) {
    const row = new Row();
    assert.equal(Object.getPrototypeOf(S.parse(row)), Object.prototype, `stock ${label}: plain`);
    assert.equal(compile(S).parse(row), row, `${label}: the instance is returned as it is (#48)`);
    const copy = compile(T).parse(new Row());
    assert.equal(Object.getPrototypeOf(copy), Object.prototype, `${label}: the copy is plain`);
    assert.deepEqual(copy, { a: 2 });
  }
  // Records are not affected: stock rejects a class instance (not a plain object) and so do we
  for (const [label, S] of recordPaths) {
    assert.equal(S.safeParse(new Row()).success, false, `stock ${label}: rejects a class instance`);
    assert.equal(
      compile(S).safeParse(new Row()).success,
      false,
      `${label}: rejects a class instance`,
    );
  }
  // An inherited enumerable key: strip's `for...in` probe sees it and copies (a plain object with the
  // declared keys, like stock); strict rejects it on both sides; loose does not enumerate on its clean
  // path and keeps the key inherited, where stock's `for...in` append writes it as an own key
  const withInherited = () => Object.assign(Object.create({ inherited: 1 }), { a: 1 });
  {
    const input = withInherited();
    const ours = compile(Strip).parse(input);
    assert.notEqual(ours, input, "strip: an inherited enumerable key takes the copy path");
    assert.equal(Object.getPrototypeOf(ours), Object.prototype);
    assert.deepEqual(ours, Strip.parse(input));
    assert.deepEqual(ownNames(ours), ["a"]);
  }
  assert.equal(Strict.safeParse(withInherited()).success, false, "stock strict: rejects it");
  assert.equal(compile(Strict).safeParse(withInherited()).success, false, "strict: rejects it");
  {
    const input = withInherited();
    assert.deepEqual(
      ownNames(Loose.parse(input)),
      ["a", "inherited"],
      "stock loose: written as own",
    );
    assert.equal(
      compile(Loose).parse(input),
      input,
      "loose: returned with the key inherited (#48)",
    );
    const copy = compile(z.looseObject({ a: bump })).parse(withInherited());
    assert.deepEqual(
      ownNames(copy),
      ["a", "inherited"],
      "loose copy: the append writes it like stock",
    );
  }
  console.log("  a class instance and an inherited key come back as passed on the clean path ✓");

  // 3. Proxy traps: strip's `for...in` probe consults `ownKeys` and `getOwnPropertyDescriptor` where
  // stock's strip template enumerates nothing; loose consults `ownKeys` alone (the own-symbol probe,
  // parity with stock's `for...in` append there since #42) and nothing under `"ignore"`, where stock's
  // append consults both; strict runs the official unknown-key loop on both sides
  class TrapError extends Error {}
  const trapped = (trap: "ownKeys" | "getOwnPropertyDescriptor") => {
    const boom = () => {
      throw new TrapError(trap);
    };
    return new Proxy(
      { a: 1 },
      trap === "ownKeys" ? { ownKeys: boom } : { getOwnPropertyDescriptor: boom },
    );
  };
  const throwsTrap = (f: () => unknown) => {
    try {
      f();
      return false;
    } catch (e) {
      assert.ok(e instanceof TrapError, "the trap's own error propagates, not a ZodError");
      return true;
    }
  };
  for (const trap of ["ownKeys", "getOwnPropertyDescriptor"] as const) {
    assert.equal(
      throwsTrap(() => Strip.parse(trapped(trap))),
      false,
      `stock strip: no ${trap}`,
    );
    assert.equal(
      throwsTrap(() => compile(Strip).parse(trapped(trap))),
      true,
      `strip: ${trap} (#48)`,
    );
    assert.equal(
      throwsTrap(() => compile(Strip, { ownSymbolKeys: "ignore" }).parse(trapped(trap))),
      true,
      `strip under "ignore": the for...in probe still consults ${trap}`,
    );
    assert.equal(
      throwsTrap(() => Strict.parse(trapped(trap))),
      true,
      `stock strict: ${trap}`,
    );
    assert.equal(
      throwsTrap(() => compile(Strict).parse(trapped(trap))),
      true,
      `strict: ${trap}`,
    );
    assert.equal(
      throwsTrap(() => Loose.parse(trapped(trap))),
      true,
      `stock loose: ${trap}`,
    );
  }
  assert.equal(
    throwsTrap(() => compile(Loose).parse(trapped("ownKeys"))),
    true,
    "loose: ownKeys",
  );
  const descriptorTrap = trapped("getOwnPropertyDescriptor");
  assert.equal(
    compile(Loose).parse(descriptorTrap),
    descriptorTrap,
    "loose: getOwnPropertyDescriptor is not consulted, the proxy is returned as it is (#48)",
  );
  const keysTrap = trapped("ownKeys");
  assert.equal(
    compile(Loose, { ownSymbolKeys: "ignore" }).parse(keysTrap),
    keysTrap,
    'loose under "ignore": nothing is enumerated, the proxy is returned as it is (#48)',
  );
  console.log("  Proxy traps: strip enumerates where stock does not, loose less than stock ✓");

  // No probe for any of it: the object skeleton reads neither descriptors nor the prototype
  for (const [label, S] of objectModes) {
    for (const C of [compile(S), compile(S, { ownSymbolKeys: "ignore" })]) {
      for (const probe of [
        "getOwnPropertyNames",
        "Reflect.ownKeys",
        "getPrototypeOf",
        "propertyIsEnumerable",
        "getOwnPropertyDescriptor",
      ]) {
        assert.ok(!C.code!.includes(probe), `${label}: no ${probe} probe in the skeleton`);
      }
    }
  }
  console.log("  no descriptor or prototype probe in the object skeleton ✓");
}

console.log("\nAll smoke assertions passed ✓");
