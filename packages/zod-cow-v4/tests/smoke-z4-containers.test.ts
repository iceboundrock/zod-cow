/**
 * Smoke: CoW skeleton behavior for record/map/set.
 */
import assert from "node:assert/strict";
import { z } from "zod";
import { compile } from "../src/index.js";

/* ── record: bare-string keys ── */
{
  const S = z.record(z.string(), z.number());
  const C = compile(S);
  const input = { a: 1, b: 2 };
  console.log("── record bare-string ──");
  console.log("  clean out === input:", C.parse(input) === input);
  assert.equal(C.parse(input), input);

  const S2 = z.record(z.string(), z.object({ n: z.number(), flag: z.boolean() }));
  const C2 = compile(S2);
  const inner = { n: 1, flag: true };
  const input2 = { a: inner, b: { n: 2, flag: false } };
  const out2 = C2.parse(input2) as typeof input2;
  console.log(
    "  nested object value: out === input:",
    out2 === input2,
    " out.a === inner:",
    out2.a === inner,
  );
  assert.equal(out2, input2);
  assert.equal(out2.a, inner);

  // Value contains a default → dirty
  const S3 = z.record(z.string(), z.object({ n: z.number(), tag: z.string().default("x") }));
  const C3 = compile(S3);
  const input3 = { a: { n: 1 } };
  const out3 = C3.parse(input3) as any;
  console.log(
    "  default injected into a value: out.a.tag =",
    out3.a.tag,
    " input undistorted:",
    !("tag" in input3.a),
  );
  assert.equal(out3.a.tag, "x");
  assert.ok(!("tag" in input3.a));
}

/* ── record: numeric-key retry (key-name conversion) ── */
{
  const S = z.record(z.number(), z.string());
  const C = compile(S);
  const input = { 1: "a", 2: "b" }; // JS object keys are always the strings "1","2"
  const out = C.parse(input) as Record<string, string>;
  console.log("\n── record numeric keys (key-name conversion) ──");
  console.log(
    "  out:",
    JSON.stringify(out),
    " out === input:",
    out === input,
    "(stock stringifies numeric keys too)",
  );
  assert.deepEqual(out, input);
  // Stock comparison: stock also outputs stringified keys
  const stockOut = (S as any).parse(input);
  assert.deepEqual(out, stockOut);
}

/* ── record: enum keys are declaration-driven ── */
{
  const S = z.record(z.enum(["a", "b"]), z.number());
  const C = compile(S);
  const input = { a: 1, b: 2 };
  const out = C.parse(input) as typeof input;
  console.log("\n── record enum keys (declaration-driven) ──");
  console.log("  clean out === input:", out === input);
  assert.equal(out, input);

  const input2 = { a: 1, b: 2, extra: 3 }; // unknown key → stock strict rejects it
  assert.equal(C.safeParse(input2).success, false);
  const input3 = { a: 1 }; // declared key b missing → stock rejects (required)
  assert.equal(C.safeParse(input3).success, false);
  // Missing but the value is optional → stock materializes undefined → dirty
  const S2 = z.record(z.enum(["a", "b"]), z.number().optional());
  const C2 = compile(S2);
  const input4 = { a: 1 };
  const out4 = C2.parse(input4) as any;
  console.log(
    "  b missing + optional value: out.b =",
    out4.b,
    " out === input:",
    out4 === input,
    "(stock materializes undefined → always dirty)",
  );
  assert.equal(out4.b, undefined);
  assert.notEqual(out4, input4);
  assert.ok(!("b" in input4));
}

/* ── record: numeric enum keys and loose enum records share references (#37) ── */
{
  console.log("\n── record numeric enum keys / loose enum records (#37) ──");
  // for...in yields strings, so the known-key probe must compare against the stringified enum values
  const S = z.record(z.enum({ A: 1, B: 2 }), z.string());
  const C = compile(S);
  const input = { "1": "x", "2": "y" };
  assert.equal(C.stock, false);
  assert.equal(C.parse(input), input);
  console.log("  numeric enum, clean out === input:", C.parse(input) === input);
  assert.equal(C.safeParse({ "1": "x", "2": "y", "3": "z" }).success, false); // undeclared key: strict
  assert.equal(C.safeParse({ "1": "x" }).success, false); // declared key missing, value required
  // A dirty value copies once; the copy carries stock's key set and order and leaves the input alone
  const T = z.record(z.enum({ A: 1, B: 2 }), z.string().trim());
  const dirtyIn = { "2": " y", "1": "x" };
  const out = compile(T).parse(dirtyIn);
  assert.notEqual(out, dirtyIn);
  assert.deepEqual(out, T.parse(dirtyIn));
  assert.deepEqual(dirtyIn, { "2": " y", "1": "x" });

  // loose: undeclared keys pass through (stock skips only "__proto__"), so a clean input is shared
  const L = z.looseRecord(z.enum(["b", "a"]), z.string());
  const LC = compile(L);
  const looseIn = { a: "x", b: "y", extra: "z" };
  assert.equal(LC.stock, false);
  assert.equal(LC.parse(looseIn), looseIn);
  console.log(
    "  loose enum record with an undeclared key, clean out === input:",
    LC.parse(looseIn) === looseIn,
  );
  const LT = z.looseRecord(z.enum(["b", "a"]), z.string().trim());
  const looseDirty = { extra: "z", a: " x", b: "y" };
  const looseOut = compile(LT).parse(looseDirty) as Record<string, string>;
  assert.notEqual(looseOut, looseDirty);
  assert.deepEqual(looseOut, { b: "y", a: "x", extra: "z" });
  // declaration order first, then the undeclared keys in input order: the same order stock builds
  assert.deepEqual(Object.keys(looseOut), Object.keys(LT.parse(looseDirty)));
  assert.deepEqual(Object.keys(looseOut), ["b", "a", "extra"]);
  assert.deepEqual(looseDirty, { extra: "z", a: " x", b: "y" });
  // A missing declared key with an optional value is materialized in loose mode as well
  const LO = compile(z.looseRecord(z.enum(["a", "b"]), z.number().optional()));
  const looseMissing = { a: 1, extra: 2 };
  const looseMissingOut = LO.parse(looseMissing) as Record<string, unknown>;
  assert.notEqual(looseMissingOut, looseMissing);
  assert.ok("b" in looseMissingOut);
  assert.deepEqual(Object.keys(looseMissingOut), ["a", "b", "extra"]);

  // Getters are read once on both paths (the copy is assembled from the captured locals, #36)
  let reads = 0;
  const withGetter = Object.defineProperty({ "2": "y" }, "1", {
    get: () => {
      reads++;
      return " x";
    },
    enumerable: true,
  });
  assert.deepEqual(compile(T).parse(withGetter), { "1": "x", "2": "y" });
  assert.equal(reads, 1);

  // Above MAX_INLINE_KEY_COMPARISONS declared keys the probe is the hoisted Set, below it the comparison chain
  const many = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`K${i}`, i + 1]));
  const M = compile(z.record(z.enum(many), z.number()));
  const manyIn = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [String(i + 1), i]));
  assert.equal(M.parse(manyIn), manyIn);
  assert.equal(M.safeParse({ ...manyIn, "18": 0 }).success, false);
  assert.ok(M.code!.includes(".has(k)"));
  assert.ok(!C.code!.includes(".has(k)"));
  console.log("  17 declared keys probe through the Set, 2 through the comparison chain ✓");
}

/* ── record: string-format keys (general path, key names unchanged) ── */
{
  const S = z.record(z.email(), z.number());
  const C = compile(S);
  const input = { "a@b.co": 1, "c@d.co": 2 };
  const out = C.parse(input) as typeof input;
  console.log("\n── record email keys (general, key names unchanged) ──");
  console.log("  out === input:", out === input);
  assert.equal(out, input);
}

/* ── map ── */
{
  const S = z.map(z.string(), z.number());
  const C = compile(S);
  const input = new Map([
    ["a", 1],
    ["b", 2],
  ]);
  const out = C.parse(input) as Map<string, number>;
  console.log("\n── map ──");
  console.log("  clean out === input:", out === input);
  assert.equal(out, input);

  const S2 = z.map(z.string(), z.object({ n: z.number(), tag: z.string().default("t") }));
  const C2 = compile(S2);
  const input2 = new Map([["a", { n: 1 }]]);
  const out2 = C2.parse(input2) as Map<string, any>;
  console.log(
    "  default injected into a value: out.get('a').tag =",
    out2.get("a")!.tag,
    " input undistorted:",
    !("tag" in input2.get("a")!),
  );
  assert.equal(out2.get("a")!.tag, "t");
  assert.notEqual(out2, input2);
  assert.ok(!("tag" in input2.get("a")!));

  // Checks on the Map itself
  const S3 = z.map(z.string(), z.number()).min(1);
  const C3 = compile(S3);
  assert.equal(C3.parse(input) === input, true);
  assert.equal(C3.safeParse(new Map()).success, false);
  console.log("  .min(1) size check ✓");
}

/* ── set ── */
{
  const S = z.set(z.number());
  const C = compile(S);
  const input = new Set([1, 2, 3]);
  const out = C.parse(input) as Set<number>;
  console.log("\n── set ──");
  console.log("  clean out === input:", out === input);
  assert.equal(out, input);

  const S2 = z.set(z.object({ n: z.number(), tag: z.string().default("s") }));
  const C2 = compile(S2);
  const item = { n: 1 };
  const input2 = new Set([item]);
  const out2 = C2.parse(input2) as Set<any>;
  console.log(
    "  default injected into a member: out.size =",
    out2.size,
    " input undistorted:",
    !("tag" in item),
  );
  assert.equal(out2.size, 1);
  assert.equal([...out2][0]!.tag, "s");
  assert.notEqual(out2, input2);
  assert.ok(!("tag" in item));

  const S3 = z.set(z.string()).max(2);
  const C3 = compile(S3);
  const s3in = new Set(["a"]);
  assert.equal(C3.parse(s3in), s3in);
  assert.equal(C3.safeParse(new Set(["a", "b", "c"])).success, false);
  console.log("  .max(2) size check ✓");
}

/* ── container combinations at the top level / key position / element position ── */
{
  const S = z.object({
    dict: z.record(z.string(), z.number()).optional(),
    lookup: z.map(z.string(), z.boolean()).nullable(),
    tags: z.set(z.string()),
  });
  const C = compile(S);
  const input = {
    dict: { a: 1 },
    lookup: new Map([["k", true]]),
    tags: new Set(["x"]),
  };
  const out = C.parse(input) as typeof input;
  console.log("\n── container combinations (optional record / nullable map / set) ──");
  console.log("  out === input:", out === input);
  console.log("  out.dict === input.dict:", out.dict === input.dict);
  console.log("  out.lookup === input.lookup:", out.lookup === input.lookup);
  assert.equal(out, input);
  assert.equal(out.dict, input.dict);
  assert.equal(out.lookup, input.lookup);
}

/* ── ordered copies, __proto__ and holes: stock rebuilds every container in iteration order (#67) ── */
{
  console.log("\n── ordered copies, __proto__ and holes (#67) ──");
  const same = (schema: z.ZodType, input: unknown) => {
    const stock = schema.parse(input);
    const ours = compile(schema).parse(input);
    const view = (v: unknown) =>
      v instanceof Map || v instanceof Set ? [...(v as Iterable<unknown>)] : v;
    assert.deepEqual(view(ours), view(stock));
    return ours;
  };

  // Set: a member transform that lands on a later member, or changes the order
  same(z.set(z.number().transform((n) => (n === 1 ? 2 : n))), new Set([1, 3])); // [2, 3]
  same(z.set(z.number().transform((n) => (n === 1 ? 2 : 1))), new Set([1, 2])); // [2, 1]
  console.log("  set: transformed members keep stock's order and lose to a later member ✓");

  // Map: a key transform that renames, or collides with a later key
  same(
    z.map(z.string().transform((k) => (k === "a" ? "c" : k)), z.number()),
    new Map([
      ["a", 1],
      ["b", 2],
    ]),
  ); // [["c", 1], ["b", 2]]
  same(
    z.map(z.string().transform((k) => (k === "a" ? "b" : k)), z.number()),
    new Map([
      ["a", 1],
      ["b", 2],
    ]),
  ); // [["b", 2]]
  // a value transform alone keeps the order too
  same(
    z.map(z.string(), z.number().transform((n) => n + 1)),
    new Map([
      ["a", 1],
      ["b", 2],
    ]),
  ); // [["a", 2], ["b", 3]]
  console.log("  map: transformed keys keep stock's order and lose to a later entry ✓");

  // Record: a key transform that collides with a later key (the value is pure, so the key
  // comparison must run on its own), one that produces "__proto__", and an own "__proto__"
  const collide = z.string().transform((k) => (k === "a" ? "b" : k));
  same(z.record(collide, z.number()), { a: 1, b: 2 }); // { b: 2 }
  same(z.record(collide, z.number().transform((n) => n)), { a: 1, b: 2 }); // { b: 2 }
  same(z.record(collide, z.number()), { b: 2, a: 1 }); // { b: 1 }
  same(z.record(z.string().transform((k) => (k === "a" ? "__proto__" : k)), z.number()), {
    a: 1,
    b: 2,
  }); // { b: 2 }
  const withProto = () => JSON.parse('{"a":1,"__proto__":1}') as object;
  const rp = same(z.record(z.string(), z.number()), withProto()) as object;
  assert.equal(Object.hasOwn(rp, "__proto__"), false);
  const rl = same(z.looseRecord(z.enum(["a"]), z.number()), withProto()) as object;
  assert.equal(Object.hasOwn(rl, "__proto__"), false);
  // strict enum records reject it on both sides
  assert.equal(z.record(z.enum(["a"]), z.number()).safeParse(withProto()).success, false);
  assert.equal(compile(z.record(z.enum(["a"]), z.number())).safeParse(withProto()).success, false);
  // a loose iterating record keeps a rejected key in its position on the copy path
  same(z.looseRecord(z.string().min(2), z.number().transform((n) => n + 1)), {
    ab: 1,
    x: 2,
    cd: 3,
  }); // { ab: 2, x: 2, cd: 4 }
  console.log("  record: colliding and __proto__ keys follow stock's assembly ✓");

  // Array / tuple: a hole is an own undefined slot in stock's output
  const a = same(z.array(z.unknown()), new Array(1)) as unknown[];
  assert.equal(Object.hasOwn(a, 0), true);
  const a2 = same(z.array(z.number().optional()), [1, , 3]) as unknown[];
  assert.equal(Object.hasOwn(a2, 1), true);
  const t = same(z.tuple([z.string().optional(), z.number()]), [, 2]) as unknown[];
  assert.equal(Object.hasOwn(t, 0), true);
  const t2 = same(z.tuple([z.number()], z.string().optional()), [1, , "x"]) as unknown[];
  assert.equal(Object.hasOwn(t2, 1), true);
  // a dense clean input still comes back by reference
  const dense = [1, 2];
  assert.equal(compile(z.array(z.number().optional())).parse(dense), dense);
  console.log("  array / tuple: holes are materialized, dense inputs stay by reference ✓");
}

console.log("\nAll record/map/set smoke assertions passed ✓");
