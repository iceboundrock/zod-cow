/**
 * Unit tests — explicitly verify every promise of the CoW semantics.
 * Reference sharing / copy on demand / lossless input / key-set semantics aligned with stock zod / edge cases.
 */
import assert from "node:assert/strict";
import { z } from "zod";
import { compile, ZcError, ZcNotSupportedError } from "../src/index.js";
import { test, summary } from "./harness.js";

console.log("── CoW semantics ──");

test("pure schema: parse returns the input reference itself (zero copy)", () => {
  const C = compile(z.object({ a: z.string(), b: z.number().int(), c: z.array(z.string()) }));
  const input = { a: "x", b: 1, c: ["p", "q"] };
  assert.equal(C.parse(input), input);
  assert.equal(C.validate(input), input);
  assert.equal(C.pure, true);
});

test("pure schema: parsing the same input twice returns the same reference (structural sharing, documented behavior)", () => {
  const C = compile(z.object({ a: z.string() }));
  const input = { a: "x" };
  assert.equal(C.parse(input), C.parse(input));
});

test("default injection: one shallow copy only when the key is missing, sibling fields stay shared", () => {
  const C = compile(z.object({ a: z.string(), role: z.string().default("viewer") }));
  const input = { a: "x" };
  const out = C.parse(input);
  assert.notEqual(out, input); // something was injected → new object
  assert.equal(out.role, "viewer");
  assert.equal("role" in input, false); // input is lossless
  // zero copy when role is already present
  const input2 = { a: "x", role: "admin" };
  assert.equal(C.parse(input2), input2);
});

test("transform: returning a new value → the parent is marked dirty automatically", () => {
  const C = compile(z.object({ name: z.string().transform((s) => s.toUpperCase()) }));
  const input = { name: "ab" };
  const out = C.parse(input);
  assert.deepEqual(out, { name: "AB" });
  assert.notEqual(out, input);
});

test("trim marks dirty only when the value actually changes (the power of primitive value comparison)", () => {
  const C = compile(z.object({ v: z.string().trim() }));
  const dirtyIn = { v: "  ab  " };
  const cleanIn = { v: "ab" };
  assert.notEqual(C.parse(dirtyIn), dirtyIn);
  assert.equal(C.parse(cleanIn), cleanIn); // same value after trim → not dirty → zero copy
  assert.deepEqual(C.parse(dirtyIn), { v: "ab" });
});

test("deep path copy: leaf default → ancestor chain rebuilt, sibling subtrees shared, input lossless", () => {
  const C = compile(
    z.object({
      meta: z.object({
        deep: z.object({ v: z.number().default(7), keep: z.string() }),
        keep: z.string(),
      }),
      sib: z.object({ k: z.string() }),
    }),
  );
  const input = { meta: { deep: { keep: "kk" }, keep: "k" }, sib: { k: "s" } } as any;
  const out = C.parse(input) as any;
  assert.notEqual(out, input);
  assert.notEqual(out.meta, input.meta);
  assert.notEqual(out.meta.deep, input.meta.deep);
  assert.equal(out.meta.deep.v, 7);
  assert.equal(out.meta.deep.keep, "kk");
  assert.equal(out.meta.keep, "k");
  assert.equal(out.sib, input.sib); // sibling subtree is shared
  assert.equal("v" in input.meta.deep, false); // input is lossless
});

test("strip: zero copy without extra keys; a clean copy only when extra keys exist, and never an in-place delete (Numeric footgun fix)", () => {
  const C = compile(z.object({ a: z.string() }));
  const clean = { a: "x" };
  assert.equal(C.parse(clean), clean);

  const dirty = { a: "x", extra: 1 } as Record<string, unknown>;
  const snapshot = JSON.stringify(dirty);
  const out = C.parse(dirty) as Record<string, unknown>;
  assert.equal("extra" in out, false); // output is clean
  assert.equal(JSON.stringify(dirty), snapshot); // input is untouched
  assert.equal(dirty.extra, 1);
});

test("strict: extra keys → unrecognized_keys failure", () => {
  const C = compile(z.object({ a: z.string() }).strict());
  const okIn = { a: "x" };
  assert.equal(C.parse(okIn), okIn); // no extra keys → zero copy
  const r = C.safeParse({ a: "x", b: 1 } as never);
  assert.equal(r.success, false);
  if (!r.success) {
    assert.equal(r.error.issues[0]!.code, "unrecognized_keys");
    assert.deepEqual(r.error.issues[0]!.keys, ["b"]);
  }
});

test("passthrough: extra keys are kept, zero copy when nothing is dirty", () => {
  const C = compile(z.object({ a: z.string() }).passthrough());
  const input = { a: "x", extra: 1 };
  assert.equal(C.parse(input), input); // the original reference is passed through
});

test("aligned with stock: an absent optional key is not materialized, present-undefined is kept", () => {
  const S = z.object({ a: z.string().optional(), b: z.string() });
  const C = compile(S);
  // Direct comparison against stock (the behavior probe confirmed 3.24.1's behavior)
  const stockAbsent = S.parse({ b: "x" }) as Record<string, unknown>;
  const stockPresent = S.parse({ b: "x", a: undefined }) as Record<string, unknown>;

  const cowAbsent = C.parse({ b: "x" }) as Record<string, unknown>;
  const cowPresent = C.parse({ b: "x", a: undefined }) as Record<string, unknown>;

  assert.equal("a" in cowAbsent, "a" in stockAbsent);
  assert.equal("a" in cowPresent, "a" in stockPresent);
});

test("array: slice once when an element is dirty, the other elements stay shared", () => {
  const C = compile(z.array(z.object({ v: z.number().default(1), n: z.string() })));
  const input = [{ n: "a" }, { n: "b", v: 2 }] as any[];
  const out = C.parse(input) as any[];
  assert.notEqual(out, input);
  assert.notEqual(out[0], input[0]);
  assert.equal(out[0].v, 1);
  assert.equal(out[1], input[1]); // clean element is shared
});

test("array length checks: min/max/exact", () => {
  const C = compile(z.array(z.string()).min(1).max(2));
  assert.equal(C.parse(["a"])[0], "a");
  assert.equal(C.safeParse([]).success, false);
  assert.equal(C.safeParse(["a", "b", "c"]).success, false);
  const E = compile(z.array(z.string()).length(2));
  assert.equal(E.safeParse(["a"]).success, false);
  assert.equal(E.safeParse(["a", "b", "c"]).success, false);
});

console.log("── validation semantics (spot check against stock) ──");

test("string checks: min/max/regex/email/uuid/datetime/startsWith/endsWith", () => {
  const C = compile(
    z
      .string()
      .min(3)
      .max(8)
      .regex(/^[a-z]+$/)
      .startsWith("a")
      .endsWith("z"),
  );
  assert.equal(C.parse("abz"), "abz");
  assert.equal(C.safeParse("ab").success, false); // < min(3)
  assert.equal(C.safeParse("ab1z").success, false); // regex
  assert.equal(C.safeParse("xz").success, false); // startsWith
  assert.equal(C.safeParse("aaaaaaaaz").success, false); // > max(8)
  assert.equal(C.safeParse("a1").success, false); // regex + startsWith + min

  const E = compile(z.string().email());
  assert.equal(E.parse("a@b.co"), "a@b.co");
  assert.equal(E.safeParse("nope").success, false);

  const U = compile(z.string().uuid());
  assert.equal(
    U.parse("00000000-0000-4000-8000-000000000000"),
    "00000000-0000-4000-8000-000000000000",
  );
  assert.equal(U.safeParse("xxx").success, false);

  const D = compile(z.string().datetime());
  assert.equal(D.parse("2025-03-14T12:34:56.789Z"), "2025-03-14T12:34:56.789Z");
  assert.equal(D.safeParse("2025-03-14").success, false);
});

test("number checks: int/min/max/multipleOf/finite/NaN", () => {
  const C = compile(z.number().int().min(2).max(10));
  assert.equal(C.parse(4), 4);
  assert.equal(C.safeParse(4.5).success, false);
  assert.equal(C.safeParse(1).success, false);
  assert.equal(C.safeParse(11).success, false);
  assert.equal(C.safeParse("4").success, false);

  const M = compile(z.number().multipleOf(3));
  assert.equal(M.parse(9), 9);
  assert.equal(M.safeParse(10).success, false);

  const F = compile(z.number().finite());
  assert.equal(F.safeParse(Infinity).success, false);

  const N = compile(z.number());
  assert.equal(N.safeParse(NaN).success, false); // received 'nan'
});

test("literal/enum/nativeEnum/date/bigint/boolean/null", () => {
  assert.equal(compile(z.literal("x")).parse("x"), "x");
  assert.equal(compile(z.literal("x")).safeParse("y").success, false);

  const E = compile(z.enum(["a", "b", "c"]));
  assert.equal(E.parse("b"), "b");
  assert.equal(E.safeParse("d").success, false);

  const NE = compile(z.nativeEnum({ A: 1, B: 2 } as const));
  assert.equal(NE.parse(2), 2);
  assert.equal(NE.safeParse(3).success, false);

  const D = compile(z.date());
  const d = new Date();
  assert.equal(D.parse(d), d);
  assert.equal(D.safeParse("no").success, false);
  assert.equal(D.safeParse(new Date(NaN)).success, false);

  const B = compile(z.bigint());
  assert.equal(B.parse(10n), 10n);
  assert.equal(B.safeParse(10).success, false);

  const Bo = compile(z.boolean());
  assert.equal(Bo.parse(true), true);
  assert.equal(Bo.safeParse("true").success, false);

  assert.equal(compile(z.null()).parse(null), null);
  assert.equal(compile(z.null()).safeParse(0).success, false);
});

test("record/map/set: CoW behavior", () => {
  const R = compile(z.record(z.string(), z.object({ v: z.number().default(1) })));
  const rin = { a: { v: 5 }, b: {} } as any;
  const rout = R.parse(rin) as any;
  assert.notEqual(rout, rin);
  assert.equal(rout.a, rin.a); // value unchanged → shared
  assert.notEqual(rout.b, rin.b); // default injected → new
  assert.equal(rout.b.v, 1);
  assert.equal("v" in rin.b, false);

  const M = compile(z.map(z.string(), z.number()));
  const min = new Map([["a", 1]]);
  assert.equal(M.parse(min), min); // pure → zero copy
  const MD = compile(z.map(z.string(), z.object({ v: z.number().default(1) })));
  const mIn = new Map<string, any>([["a", {}]]);
  const mOut = MD.parse(mIn);
  assert.notEqual(mOut, mIn); // a default was injected into the value → new Map
  assert.equal(mOut.get("a")!.v, 1);
  assert.equal(mIn.get("a")!.v, undefined); // input is lossless

  const S = compile(z.set(z.number()));
  const sin = new Set([1, 2]);
  assert.equal(S.parse(sin), sin);
});

console.log("── wrappers and composition ──");

test("union: returns on the first match; dirty branches propagate", () => {
  const C = compile(z.union([z.string(), z.number().int()]));
  assert.equal(C.parse("hi"), "hi");
  assert.equal(C.parse(3), 3);
  assert.equal(C.safeParse(3.5).success, false);
  assert.equal(C.safeParse(true).success, false);

  const D = compile(z.union([z.object({ v: z.number().default(1) }), z.string()]));
  const out = D.parse({}) as any;
  assert.equal(out.v, 1);
});

test("discriminated union: fast dispatch + error on a missing discriminator value", () => {
  const S = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("a"), x: z.number() }),
    z.object({ kind: z.literal("b"), y: z.string() }),
  ]);
  const C = compile(S);
  const input = { kind: "a" as const, x: 1 };
  assert.equal(C.parse(input), input); // branch is pure → zero copy
  const r = C.safeParse({ kind: "c" } as never);
  assert.equal(r.success, false);
  assert.equal(r.success ? "" : r.error.issues[0]!.code, "invalid_union_discriminator");
});

test("z.lazy recursive schema", () => {
  const Cat: z.ZodType<any> = z.object({
    name: z.string(),
    kittens: z.array(z.lazy(() => Cat)),
  });
  const C = compile(Cat);
  const input = { name: "a", kittens: [{ name: "b", kittens: [] }] };
  const out = C.parse(input) as any;
  assert.equal(out, input); // pure recursion → zero copy
  assert.equal(out.kittens[0], input.kittens[0]);
});

test("catch: falls back to the default on failure, passes through on success", () => {
  const C = compile(z.object({ v: z.number().catch(-1) }));
  const okIn = { v: 5 };
  assert.equal(C.parse(okIn), okIn);
  const badIn = { v: "x" as never };
  const out = C.parse(badIn) as any;
  assert.equal(out.v, -1);
  assert.notEqual(out, badIn);
});

test("refine/superRefine: pure predicates do not break zero copy; failures carry a path", () => {
  const C = compile(z.object({ a: z.string().refine((s) => s.length > 2, "too short!") }));
  const ok = { a: "xyz" };
  assert.equal(C.parse(ok), ok);
  const r = C.safeParse({ a: "x" });
  assert.equal(r.success, false);
  if (!r.success) {
    assert.equal(r.error.issues[0]!.code, "custom");
    assert.deepEqual(r.error.issues[0]!.path, ["a"]);
  }

  const S = compile(
    z.object({ lo: z.number(), hi: z.number() }).superRefine((val, ctx) => {
      if (val.lo > val.hi) ctx.addIssue({ code: "custom", message: "lo>hi" });
    }),
  );
  const ok2 = { lo: 1, hi: 2 };
  assert.equal(S.parse(ok2), ok2);
  const r2 = S.safeParse({ lo: 5, hi: 2 });
  assert.equal(r2.success, false);
});

test("preprocess / pipe / readonly / branded / optional / nullable / tuple", () => {
  const P = compile(z.preprocess((v) => String(v), z.string()));
  assert.equal(P.parse(42 as never), "42");

  const Pipe = compile(
    z
      .string()
      .transform((s) => s.length)
      .pipe(z.number().int()),
  );
  assert.equal(Pipe.parse("abcd"), 4);
  const Pipe2 = compile(
    z
      .string()
      .transform((s) => s.length)
      .pipe(z.number().min(3)),
  );
  assert.equal(Pipe2.safeParse("ab").success, false);

  const RO = compile(z.object({ a: z.string() }).readonly());
  const roIn = { a: "x" };
  const roOut = RO.parse(roIn) as any;
  assert.equal(Object.isFrozen(roOut), true); // same as stock readonly: shallow freeze

  const BR = compile(z.object({ a: z.string() }).brand<"B">());
  const brIn = { a: "x" };
  assert.equal(BR.parse(brIn), brIn);

  const O = compile(z.object({ a: z.string().optional(), b: z.string().nullable() }));
  const mixed = { a: undefined, b: null };
  const outO = O.parse(mixed) as any;
  assert.equal("a" in outO, true); // same as stock: present-undefined is kept
  assert.equal(outO.b, null);

  const T = compile(z.tuple([z.string(), z.number()]));
  const tIn = ["a", 1];
  assert.equal(T.parse(tIn), tIn);
  assert.equal(T.safeParse(["a"]).success, false);
  assert.equal(T.safeParse(["a", 1, 2]).success, false);
});

console.log("── safety and edge cases ──");

test("__proto__ as an extra key: no prototype pollution, input lossless", () => {
  const C = compile(z.object({ a: z.string() }));
  const evil = JSON.parse('{"a":"x","__proto__":{"polluted":1}}');
  const out = C.parse(evil) as any;
  assert.equal("polluted" in out, false);
  assert.equal(({} as any).polluted, undefined);
  assert.equal("__proto__" in evil, true); // input is lossless (it still carries that own property)
});

test("failure path: nested issue paths are correct", () => {
  const C = compile(
    z.object({
      list: z.array(z.object({ v: z.number() })),
      n: z.object({ m: z.object({ s: z.string() }) }),
    }),
  );
  const r = C.safeParse({ list: [{ v: 1 }, { v: "x" }], n: { m: { s: 1 } } } as never);
  assert.equal(r.success, false);
  if (!r.success) {
    const paths = r.error.issues.map((i) => i.path.join(".")).sort();
    assert.deepEqual(paths, ["list.1.v", "n.m.s"]);
  }
});

test("unsupported features: an explicit compile-time error (rather than a silent runtime drift)", () => {
  assert.throws(
    () => compile(z.intersection(z.object({ a: z.string() }), z.object({ b: z.string() }))),
    ZcNotSupportedError,
  );
  assert.throws(
    () => compile(z.object({ a: z.string() }).catchall(z.string())),
    ZcNotSupportedError,
  );
});

test("async refine → explicit runtime error", () => {
  const C = compile(z.string().refine(async () => true));
  assert.throws(() => C.parse("x" as never), ZcNotSupportedError);
});

test("ZcError carries issues", () => {
  const C = compile(z.object({ a: z.string() }));
  try {
    C.parse({ a: 1 } as never);
    assert.fail("should throw");
  } catch (e) {
    assert.ok(e instanceof ZcError);
    assert.equal((e as ZcError).issues[0]!.code, "invalid_type");
  }
});

summary("unit");
