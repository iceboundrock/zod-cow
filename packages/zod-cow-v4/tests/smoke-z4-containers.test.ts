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

console.log("\nAll record/map/set smoke assertions passed ✓");
