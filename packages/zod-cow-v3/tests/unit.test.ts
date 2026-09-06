/**
 * Unit tests — explicitly verify every promise of the CoW semantics.
 * Reference sharing / copy on demand / lossless input / key-set semantics aligned with stock zod / edge cases.
 */
import assert from "node:assert/strict";
import { z } from "zod";
import type { ZcError as ZcErrorType } from "../src/index.js";
import { summary, test } from "./harness.js";

// `--no-codegen` runs the same tests through the closure skeletons (the fallback used where
// `new Function` is unavailable); the flag must be set before the compiler module loads
const noCodegen = process.argv.includes("--no-codegen");
if (noCodegen) process.env.ZC_V3_CODEGEN = "0";
const { compile, ZcError, ZcNotSupportedError } = await import("../src/index.js");

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
  assert.equal(Object.isFrozen(roIn), false); // of a copy, the caller's input is untouched (#27)

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

test("__proto__ as a declared key: validated, never written, dropped from the output like stock", () => {
  // `{ ["__proto__"]: … }` creates an own shape key (a literal `__proto__:` would set the prototype)
  const shape = { ["__proto__"]: z.object({ p: z.number() }).default({ p: 1 }), a: z.string() };
  for (const S of [z.object(shape), z.object(shape).strict(), z.object(shape).passthrough()]) {
    const C = compile(S);
    // Own "__proto__" on the input (JSON): stock validates it and leaves it out of its output
    const json = JSON.parse('{"a":"x","__proto__":{"p":2}}');
    const out = C.parse(json) as any;
    assert.deepEqual(S.parse(json), { a: "x" });
    assert.notEqual(out, json);
    assert.deepEqual(Object.keys(out), ["a"]);
    assert.equal(Object.hasOwn(out, "__proto__"), false);
    assert.equal(Object.getPrototypeOf(out), Object.prototype);
    assert.equal(Object.hasOwn(json, "__proto__"), true); // input lossless
    // The default fires on a null-prototype input (no accessor, so the key reads as undefined):
    // the value is validated, the copy must not get it as its prototype
    const bare = Object.assign(Object.create(null), { a: "x" });
    const out2 = C.parse(bare) as any;
    assert.deepEqual(S.parse(bare), { a: "x" });
    assert.deepEqual(Object.keys(out2), ["a"]);
    assert.equal(out2.p, undefined);
    assert.equal(Object.getPrototypeOf(out2), Object.prototype);
    assert.equal(Object.hasOwn(out2, "__proto__"), false);
    // An invalid value under the key is reported at its path, as stock does
    const bad = JSON.parse('{"a":"x","__proto__":{"p":"no"}}');
    assert.deepEqual(C.safeParse(bad).success, false);
    assert.deepEqual(
      (C.safeParse(bad) as any).error.issues.map((i: any) => i.path),
      S.safeParse(bad).error!.issues.map((i) => i.path),
    );
  }
  // The strip copy path (an undeclared key next to the declared "__proto__") builds from the
  // shape keys and skips it as well
  const C = compile(z.object({ ["__proto__"]: z.string(), a: z.string() }));
  const inp = JSON.parse('{"a":"x","__proto__":"q","extra":1}');
  const out = C.parse(inp) as any;
  assert.deepEqual(Object.keys(out), ["a"]);
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  // Passthrough mode: an undeclared own "__proto__" is dropped too (stock's assembly skips it)
  const P = compile(z.object({ a: z.string() }).passthrough());
  const pin = JSON.parse('{"a":"x","__proto__":{"p":1},"b":2}');
  assert.deepEqual(P.parse(pin), { a: "x", b: 2 });
  assert.equal(Object.hasOwn(P.parse(pin) as object, "__proto__"), false);
  assert.equal(({} as any).p, undefined);
});

test("object copy path: stock's output assembly from the validated values (non-enumerable declared key kept, own symbol dropped, getter read once, shape order, presence rule)", () => {
  const S = z.object({ a: z.string(), b: z.string().default("d"), c: z.string().optional() });
  for (const M of [S, S.strict(), S.passthrough()]) {
    const C = compile(M);
    // A declared key the input defines as non-enumerable: stock reads it by name and writes it
    const ne: any = { b: undefined };
    Object.defineProperty(ne, "a", { value: "x", enumerable: false });
    const out = C.parse(ne) as any;
    assert.notEqual(out, ne);
    assert.deepEqual(Object.keys(out), ["a", "b"]);
    assert.deepEqual(out, M.parse(ne));
    // Presence rule of the copy: an absent optional key stays absent, a present undefined is written
    const presentUndef = { a: "x", c: undefined };
    assert.deepEqual(Object.keys(C.parse(presentUndef) as any), ["a", "b", "c"]);
    assert.deepEqual(Object.keys(M.parse(presentUndef) as any), ["a", "b", "c"]);
    assert.deepEqual(Object.keys(C.parse({ a: "x" }) as any), ["a", "b"]);
    // An undeclared own symbol key is dropped by the copy like stock (the clean path keeps it by reference)
    const sym = Symbol("s");
    const withSym: any = { a: "x", [sym]: 1 };
    assert.deepEqual(Object.getOwnPropertySymbols(C.parse(withSym) as any), []);
    assert.deepEqual(Object.getOwnPropertySymbols(M.parse(withSym) as any), []);
    const cleanSym: any = { a: "x", b: "y", [sym]: 1 };
    assert.equal(C.parse(cleanSym), cleanSym);
    // A getter is read once on the copy path, as stock reads each shape key once
    let reads = 0;
    const g: any = {
      get a() {
        reads++;
        return "x";
      },
    };
    const outG = C.parse(g) as any;
    assert.notEqual(outG, g);
    assert.equal(reads, 1);
    assert.deepEqual(outG, { a: "x", b: "d" });
    // The copy follows shape order, whatever the input's order
    const reordered = { c: "z", a: "x" };
    assert.deepEqual(Object.keys(C.parse(reordered) as any), ["a", "b", "c"]);
    assert.deepEqual(Object.keys(M.parse(reordered) as any), ["a", "b", "c"]);
  }
});

test("passthrough copy path: undeclared keys appended like stock's for...in (undefined value dropped, inherited enumerable key written as own, __proto__ skipped)", () => {
  const S = z.object({ a: z.string().default("d") }).passthrough();
  const C = compile(S);
  const proto = { inh: 1 };
  const input: any = Object.create(proto);
  input.a = undefined;
  input.x = undefined;
  input.y = 2;
  const out = C.parse(input) as any;
  const stock = S.parse(input) as any;
  assert.deepEqual(Object.keys(stock), ["a", "y", "inh"]);
  assert.deepEqual(Object.keys(out), ["a", "y", "inh"]);
  assert.equal(Object.hasOwn(out, "inh"), true);
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  assert.deepEqual(out, stock);
  const json = JSON.parse('{"__proto__":{"p":1}}');
  assert.deepEqual(Object.keys(C.parse(json) as any), ["a"]);
  assert.equal(Object.getPrototypeOf(C.parse(json)), Object.prototype);
  // The clean path returns the input as it is (documented: keys stay where the input holds them)
  const clean: any = Object.create(proto);
  clean.a = "x";
  clean.x = undefined;
  assert.equal(C.parse(clean), clean);
});

test("strip / strict probe: an inherited enumerable key counts as undeclared, as in stock's for...in", () => {
  const input = Object.assign(Object.create({ inh: 1 }), { a: "x" });
  const strict = z.object({ a: z.string() }).strict();
  const r = compile(strict).safeParse(input);
  assert.equal(strict.safeParse(input).success, false);
  assert.equal(r.success, false);
  if (!r.success) {
    assert.equal(r.error.issues.length, 1);
    assert.equal(r.error.issues[0]!.code, "unrecognized_keys");
    assert.deepEqual((r.error.issues[0] as any).keys, ["inh"]);
  }
  const strip = z.object({ a: z.string() });
  const out = compile(strip).parse(input) as any;
  assert.notEqual(out, input);
  assert.deepEqual(Object.keys(out), ["a"]);
  assert.equal("inh" in out, false);
  assert.deepEqual(out, strip.parse(input));
});

test("readonly .pure: a union whose branch decides the provenance at run time is not pure, and both branches behave like stock", () => {
  const S = z.union([z.object({ a: z.string() }), z.any()]).readonly();
  const C = compile(S);
  assert.equal(C.pure, false);
  // Object branch: a frozen copy, the input untouched (stock builds the copy and freezes that)
  const obj = { a: "x" };
  const stockObj = { a: "x" };
  const out = C.parse(obj);
  assert.notEqual(out, obj);
  assert.equal(Object.isFrozen(out), true);
  assert.equal(Object.isFrozen(obj), false);
  assert.notEqual(S.parse(stockObj), stockObj);
  assert.equal(Object.isFrozen(stockObj), false);
  // `any` branch: the input itself, frozen in place, as stock does
  const leaf = { n: 1 };
  const stockLeaf = { n: 1 };
  assert.equal(C.parse(leaf), leaf);
  assert.equal(Object.isFrozen(leaf), true);
  assert.equal(S.parse(stockLeaf), stockLeaf);
  assert.equal(Object.isFrozen(stockLeaf), true);
  // Static answers stay static
  assert.equal(compile(z.union([z.any(), z.unknown()]).readonly()).pure, true);
  assert.equal(
    compile(z.union([z.object({ a: z.string() }), z.array(z.string())]).readonly()).pure,
    false,
  );
  assert.equal(compile(z.object({ a: z.string() }).catch({ a: "d" }).readonly()).pure, false);
});

test("object / record / discriminated union reject a Date, Map, Set or promise-like input like stock (invalid_type, received date / map / set / promise)", () => {
  const schemas = [
    z.object({}),
    z.record(z.string(), z.unknown()),
    z.discriminatedUnion("k", [z.object({ k: z.literal("a") })]),
  ];
  // biome-ignore lint/suspicious/noThenProperty: an intentional thenable, which stock's detector (`instanceof Promise`) does not treat as async
  const inputs = [new Date(0), new Map(), new Set(), { then() {}, catch() {} }];
  for (const S of schemas) {
    const C = compile(S);
    for (const input of inputs) {
      const s = S.safeParse(input);
      const c = C.safeParse(input);
      assert.equal(s.success, false);
      assert.equal(c.success, false);
      assert.deepEqual((c as any).error.issues, s.error!.issues);
    }
  }
});

console.log("── effects: stock's issue and status semantics ──");

/** An issue list as plain data: a union's nested errors (ZodError / ZcError) by their own issue lists */
function issueShape(issues: readonly any[]): unknown[] {
  return issues.map((i) =>
    i.unionErrors === undefined
      ? i
      : { ...i, unionErrors: i.unionErrors.map((e: any) => issueShape(e.issues)) },
  );
}

/** Stock's issue list and the compiled one must be identical, in order, every property included */
function issuesMatchStock(S: z.ZodTypeAny, input: unknown): void {
  const s = S.safeParse(input);
  const c = compile(S).safeParse(input);
  assert.equal(s.success, false, "stock must reject");
  assert.equal(c.success, false, "compiled must reject");
  assert.deepEqual(issueShape((c as any).error.issues), issueShape(s.error!.issues));
}

test("preprocess: runs its inner schema even when an earlier sibling left an issue (only its own fatal issue aborts)", () => {
  // The whole-context issue count is not the preprocess node's status
  issuesMatchStock(z.object({ a: z.string().min(3), b: z.preprocess((v) => v, z.string()) }), {
    a: "x",
    b: 1,
  });
  // A non-fatal issue from the callback: the inner schema still runs on the mapped value
  issuesMatchStock(
    z.preprocess((v, ctx) => {
      ctx.addIssue({ code: "custom", message: "pp" });
      return v;
    }, z.string()),
    1,
  );
  const dirty = z.preprocess((v, ctx) => {
    ctx.addIssue({ code: "custom", message: "pp" });
    return v;
  }, z.string());
  issuesMatchStock(dirty, "x");
  // A fatal issue aborts: the inner schema does not run
  let ran = 0;
  const fatal = z.preprocess(
    (v, ctx) => {
      ctx.addIssue({ code: "custom", message: "pp", fatal: true });
      return v;
    },
    z.string().refine(() => {
      ran++;
      return true;
    }),
  );
  issuesMatchStock(fatal, "x");
  assert.equal(ran, 0); // neither side reaches the inner schema
  // A fatal issue in a union option: that option is aborted, not the dirty result
  issuesMatchStock(z.union([fatal, z.number()]), "x");
  assert.equal(compile(z.union([dirty, z.number()])).safeParse("x").success, false);
});

test("transform: a fatal issue from the callback aborts (an ancestor refine does not run), a non-fatal one is dirty", () => {
  let refined = 0;
  const S = z
    .string()
    .transform((v, ctx) => {
      ctx.addIssue({ code: "custom", message: "t", fatal: true });
      return v;
    })
    .refine(() => {
      refined++;
      return false;
    }, "r");
  issuesMatchStock(S, "x");
  assert.equal(refined, 0);
  const D = z
    .string()
    .transform((v, ctx) => {
      ctx.addIssue({ code: "custom", message: "t" });
      return v;
    })
    .refine(() => false, "r");
  issuesMatchStock(D, "x");
});

test("effects: an ordinary thenable is a sync result (stock's detector is `instanceof Promise`); a Promise throws ZcNotSupportedError", () => {
  // biome-ignore lint/suspicious/noThenProperty: an intentional thenable, which stock's detector (`instanceof Promise`) does not treat as async
  const thenable = { then() {} };
  assert.deepEqual(compile(z.string().transform(() => thenable)).parse("x"), thenable);
  assert.equal(compile(z.string().refine(() => thenable as any)).parse("x"), "x");
  assert.equal(compile(z.preprocess(() => thenable, z.any())).parse("x"), thenable);
  assert.throws(
    () => compile(z.string().transform(async (v) => v)).parse("x"),
    ZcNotSupportedError,
  );
  assert.throws(() => compile(z.string().refine(async () => true)).parse("x"), ZcNotSupportedError);
  assert.throws(
    () => compile(z.preprocess(async (v) => v, z.any())).parse("x"),
    ZcNotSupportedError,
  );
});

test("effects: a callback that re-enters its own compiled parser keeps the outer invocation's context (issues, fatal flag, path)", () => {
  // Stock hands every callback a fresh ctx object; the compiled effect node reuses one holder per
  // node, so a nested parse through the same schema (direct or through a compiled parser) must
  // restore the outer invocation's ctx, data and fatal flag before it returns, or the outer
  // `addIssue` lands in the finished nested context and the parse succeeds where stock rejects
  type Parser = { safeParse(v: unknown): { success: boolean; data?: unknown; error?: any } };
  const pair = <T extends z.ZodTypeAny>(make: (self: () => Parser) => T) => {
    let s!: Parser;
    const stock = make(() => s);
    s = stock;
    let c!: Parser;
    const schema = make(() => c);
    c = compile(schema); // a second compile() of the same schema shares the cached validator, holder included
    return { stock, compiled: compile(schema) as Parser };
  };
  const same = (p: { stock: Parser; compiled: Parser }, input: unknown) => {
    const s = p.stock.safeParse(input);
    const c = p.compiled.safeParse(input);
    assert.equal(c.success, s.success);
    if (s.success) assert.deepEqual(c.data, s.data);
    else assert.deepEqual(issueShape(c.error.issues), issueShape(s.error.issues));
  };

  // superRefine: the nested parses complete, then the outer issue must reach the outer list at the outer path
  const paths: unknown[][] = [];
  const refine = pair((self) =>
    z.object({
      k: z.string().superRefine((v, ctx) => {
        if (v !== "outer") return;
        assert.equal(self().safeParse({ k: "inner" }).success, true);
        assert.equal(self().safeParse({ k: 1 }).success, false); // the nested issues stay in the nested context
        paths.push(ctx.path.slice());
        ctx.addIssue({ code: "custom", message: "outer issue" });
      }),
    }),
  );
  same(refine, { k: "outer" });
  assert.deepEqual(paths, [["k"], ["k"]]); // stock's path, then the compiled path after re-entry
  same(refine, { k: "inner" });

  // A fatal issue raised before the nested parse still aborts (the ancestor refine does not run)
  const fatal = pair((self) =>
    z
      .object({
        k: z.string().superRefine((v, ctx) => {
          if (v !== "outer") return;
          ctx.addIssue({ code: "custom", message: "stop", fatal: true });
          self().safeParse({ k: "inner" });
        }),
      })
      .refine(() => false, "never reached"),
  );
  same(fatal, { k: "outer" });

  // transform and preprocess go through the same wrapper
  const transform = pair((self) =>
    z.string().transform((v, ctx) => {
      if (v === "outer") {
        self().safeParse("inner");
        ctx.addIssue({ code: "custom", message: "outer transform" });
      }
      return v.toUpperCase();
    }),
  );
  same(transform, "outer");
  same(transform, "inner");
  const preprocess = pair((self) =>
    z.preprocess((v, ctx) => {
      if (v === "outer") {
        self().safeParse("inner");
        ctx.addIssue({ code: "custom", message: "outer preprocess", fatal: true });
      }
      return v;
    }, z.string()),
  );
  same(preprocess, "outer");
  same(preprocess, "inner");

  // A nested callback that throws and is caught by the outer callback must not leave a stale context behind
  const caught = pair((self) =>
    z.string().superRefine((v, ctx) => {
      if (v === "inner") throw new Error("inner throws");
      if (v !== "outer") return;
      assert.throws(() => self().safeParse("inner"), /inner throws/);
      ctx.addIssue({ code: "custom", message: "after the caught throw" });
    }),
  );
  same(caught, "outer");
});

console.log("── readonly: what stock freezes ──");

test("readonly over a union freezes the winning option's output: the input in place through a pass-through option, a copy through a container option", () => {
  const S = z.union([z.any(), z.object({ a: z.string() })]).readonly();
  const C = compile(S);
  const stockIn = { a: "x" };
  assert.equal(S.parse(stockIn), stockIn);
  assert.equal(Object.isFrozen(stockIn), true);
  const input = { a: "x" };
  assert.equal(C.parse(input), input);
  assert.equal(Object.isFrozen(input), true);
  // Container option first: stock freezes its fresh output, the input stays unfrozen
  const T = z.union([z.object({ a: z.string() }), z.any()]).readonly();
  const stockIn2 = { a: "x" };
  assert.notEqual(T.parse(stockIn2), stockIn2);
  assert.equal(Object.isFrozen(stockIn2), false);
  const input2 = { a: "x" };
  const out2 = compile(T).parse(input2);
  assert.notEqual(out2, input2);
  assert.equal(Object.isFrozen(out2), true);
  assert.equal(Object.isFrozen(input2), false);
  // The pass-through option wins for a non-object shape, the container option for an object:
  // one compiled union, both provenances
  const U = z.union([z.object({ a: z.string() }), z.unknown()]).readonly();
  const CU = compile(U);
  const arr = [1];
  assert.equal(CU.parse(arr), arr);
  assert.equal(Object.isFrozen(arr), true);
  const obj = { a: "x" };
  assert.notEqual(CU.parse(obj), obj);
  assert.equal(Object.isFrozen(obj), false);
  // Discriminated union with a pass-through option (`passthrough` objects still rebuild in stock)
  const V = z
    .discriminatedUnion("k", [
      z.object({ k: z.literal("a") }),
      z.object({ k: z.literal("b") }).passthrough(),
    ])
    .readonly();
  const vin = { k: "b", extra: 1 };
  assert.notEqual(compile(V).parse(vin), vin);
  assert.equal(Object.isFrozen(vin), false);
});

test("readonly over a transform / catch / pipeline follows the reference the callback handed back", () => {
  // Identity transform over a pass-through leaf: stock freezes the input in place
  const I = z
    .any()
    .transform((x) => x)
    .readonly();
  const sin = { a: 1 };
  assert.equal(I.parse(sin), sin);
  assert.equal(Object.isFrozen(sin), true);
  const input = { a: 1 };
  assert.equal(compile(I).parse(input), input);
  assert.equal(Object.isFrozen(input), true);
  // Identity transform over a container: stock's callback saw a fresh object, the input stays unfrozen
  const O = z
    .object({ a: z.number() })
    .transform((x) => x)
    .readonly();
  const input2 = { a: 1 };
  const out2 = compile(O).parse(input2);
  assert.notEqual(out2, input2);
  assert.equal(Object.isFrozen(out2), true);
  assert.equal(Object.isFrozen(input2), false);
  // A transform returning a new reference: frozen in place, as stock freezes what it is handed
  const N = z
    .object({ a: z.number() })
    .transform((x) => ({ ...x }))
    .readonly();
  assert.equal(Object.isFrozen(compile(N).parse({ a: 1 })), true);
  // catch handing back the raw input: stock freezes the input in place; the success path copies
  const K = z
    .object({ a: z.string() })
    .catch(({ input }) => input)
    .readonly();
  const bad = { a: 1 };
  assert.equal(K.parse(bad), bad);
  assert.equal(Object.isFrozen(bad), true);
  const bad2 = { a: 1 };
  assert.equal(compile(K).parse(bad2), bad2);
  assert.equal(Object.isFrozen(bad2), true);
  const good = { a: "x" };
  assert.notEqual(compile(K).parse(good), good);
  assert.equal(Object.isFrozen(good), false);
  // pipeline: a rebuilt `in` side stays fresh through a pass-through `out` side
  const P = z
    .union([z.object({ a: z.string() }), z.unknown()])
    .pipe(z.union([z.string(), z.unknown()]))
    .readonly();
  const pin = { a: "x" };
  assert.notEqual(compile(P).parse(pin), pin);
  assert.equal(Object.isFrozen(pin), false);
  const parr = [1];
  assert.equal(compile(P).parse(parr), parr);
  assert.equal(Object.isFrozen(parr), true);
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

console.log("── readonly (#27) ──");

test("readonly freezes a copy where stock builds a new container, and the input in place where stock passes it through", () => {
  for (const [S, input] of [
    [z.object({ a: z.string() }).readonly(), { a: "x" }],
    [z.array(z.number()).readonly(), [1, 2]],
    [z.tuple([z.string()]).readonly(), ["a"]],
    [z.record(z.string(), z.number()).readonly(), { k: 1 }],
    [z.map(z.string(), z.number()).readonly(), new Map([["k", 1]])],
    [z.set(z.number()).readonly(), new Set([1])],
    [z.date().readonly(), new Date(0)],
    [z.object({ a: z.string() }).optional().readonly(), { a: "x" }],
  ] as const) {
    const stockOut = S.parse(input as never) as object;
    const out = compile(S as z.ZodTypeAny).parse(input) as object;
    assert.equal(Object.isFrozen(input), false, `input frozen for ${S.constructor.name}`);
    assert.equal(Object.isFrozen(out), true);
    assert.notEqual(out, input);
    assert.deepEqual(out, stockOut);
  }
  // Pass-through leaf: stock returns the input itself and freezes it in place; so does the compiled line
  const anyIn = { a: 1 };
  const stockIn = { a: 1 };
  z.any().readonly().parse(stockIn);
  compile(z.any().readonly()).parse(anyIn);
  assert.equal(Object.isFrozen(stockIn), true);
  assert.equal(Object.isFrozen(anyIn), true);
  // A dirty value is not frozen (stock freezes valid results only)
  const D = compile(z.object({ a: z.string().min(3) }).readonly());
  assert.equal(D.safeParse({ a: "x" }).success, false);
  assert.equal(compile(z.object({ a: z.string() }).readonly()).pure, false);
});

console.log("── failure semantics against stock (issue lists) ──");

/** code, path and message of every issue, sorted */
function issuesOf(r: { success: boolean; error?: { issues: any[] } }): string[] {
  assert.equal(r.success, false);
  return r.error!.issues.map((i: any) => `${i.code}@${JSON.stringify(i.path)}:${i.message}`).sort();
}
function sameIssues(S: z.ZodTypeAny, input: unknown): void {
  assert.deepEqual(issuesOf(compile(S).safeParse(input)), issuesOf(S.safeParse(input)));
}

test("a failed check is dirty: later checks still run and every issue is collected, as in stock", () => {
  sameIssues(z.string().min(3).email(), "ab");
  sameIssues(z.number().int().max(1), 1.5);
  sameIssues(z.array(z.number()).max(1), [1, "x", 3]);
  sameIssues(z.set(z.number()).max(1), new Set([1, 2, "x"]));
  sameIssues(z.tuple([z.number(), z.number()]), [1, "x", 3]);
  const two = compile(z.string().min(3).email()).safeParse("ab");
  assert.equal(two.success ? 0 : two.error.issues.length, 2);
});

test("a refinement runs on a dirty value and its issue joins the list; a fatal issue aborts", () => {
  let calls = 0;
  const S = z.object({ a: z.string().min(3) }).refine(() => {
    calls++;
    return false;
  }, "obj refine");
  sameIssues(S, { a: "x" });
  assert.equal(calls, 2); // stock and compiled both ran it once on the dirty object
  const F = z.string().superRefine((_v, ctx) => {
    ctx.addIssue({ code: "custom", message: "stop", fatal: true });
  });
  sameIssues(
    z.object({ a: F }).refine(() => false, "never reached"),
    { a: "x" },
  );
});

test("union: a dirty option is the result and its issues stay; otherwise invalid_union carries every option's errors", () => {
  sameIssues(z.union([z.string().min(3), z.number()]), "ab");
  sameIssues(z.union([z.string(), z.number()]), true);
  const r = compile(z.object({ u: z.union([z.string(), z.number()]) })).safeParse({ u: true });
  assert.equal(r.success, false);
  const issue = r.error!.issues[0]! as any;
  assert.equal(issue.code, "invalid_union");
  assert.deepEqual(issue.path, ["u"]);
  assert.deepEqual(
    issue.unionErrors.map((e: any) => e.issues[0].path),
    [["u"], ["u"]],
  ); // nested issues carry the absolute path, as stock's ZodErrors do
});

test("discriminated union: the option's own issues pass through; a bad discriminator is invalid_union_discriminator", () => {
  const S = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("a"), x: z.number() }),
    z.object({ kind: z.literal("b"), y: z.string() }),
  ]);
  sameIssues(S, { kind: "a", x: "no" });
  sameIssues(S, { kind: "c" });
  sameIssues(z.object({ d: S }), { d: { kind: "c" } });
});

test("strict object: unrecognized_keys is reported next to the children's issues", () => {
  sameIssues(z.object({ a: z.string() }).strict(), { a: 1, b: 2, c: 3 });
  sameIssues(z.object({ a: z.string().min(3) }).strict(), { a: "x", b: 2 });
});

test("paths: Map [index, key|value], Set [index], nested containers, lazy and eager subtrees agree with stock", () => {
  sameIssues(
    z.map(z.string(), z.number()),
    new Map<unknown, unknown>([
      ["a", "x"],
      [1, 2],
    ]),
  );
  sameIssues(z.set(z.number()), new Set([1, "x"]));
  sameIssues(z.object({ list: z.array(z.object({ v: z.number() })) }), {
    list: [{ v: 1 }, { v: "x" }],
  });
  // eager (an effect below) and lazy (none) variants of the same failure
  sameIssues(z.object({ n: z.object({ m: z.string().refine(() => true) }) }), { n: { m: 1 } });
  sameIssues(z.object({ n: z.object({ m: z.string() }) }), { n: { m: 1 } });
  sameIssues(z.record(z.string().min(2), z.number()), { a: "x" });
});

test("messages and params follow stock: Required, integer received float, enum options, literal received, error maps", () => {
  sameIssues(z.object({ a: z.string() }), {});
  sameIssues(z.number().int(), 1.5);
  sameIssues(z.enum(["a", "b"]), "c");
  sameIssues(z.enum(["a", "b"]), 1);
  sameIssues(z.nativeEnum({ A: 1, B: 2 } as const), 3);
  sameIssues(z.literal("x"), 7);
  sameIssues(z.string({ required_error: "need it", invalid_type_error: "text please" }), undefined);
  sameIssues(z.string({ required_error: "need it", invalid_type_error: "text please" }), 5);
  sameIssues(z.string().min(2, "custom min"), "a");
  sameIssues(z.number().multipleOf(0.1), 0.35);
  assert.equal(compile(z.number().multipleOf(0.1)).safeParse(0.3).success, true); // float-safe remainder
  sameIssues(z.string().length(3), "ab");
  sameIssues(z.string().includes("q", { position: 2 }), "abc");
  sameIssues(z.date().min(new Date(1000)), new Date(0));
  const stockInt = z.number().int().safeParse(1.5);
  const ourInt = compile(z.number().int()).safeParse(1.5);
  assert.ok(!stockInt.success && !ourInt.success);
  if (!stockInt.success && !ourInt.success)
    assert.deepEqual(ourInt.error.issues[0], stockInt.error.issues[0]); // params included (exact, received)
});

test("coerce, bigint checks, jwt alg: supported like stock", () => {
  assert.equal(compile(z.coerce.string()).parse(5), "5");
  assert.equal(compile(z.coerce.number()).parse("5"), 5);
  assert.equal(compile(z.coerce.boolean()).parse(""), false);
  assert.equal(compile(z.coerce.bigint()).parse("5"), 5n);
  assert.equal(compile(z.coerce.date()).parse(0).getTime(), 0);
  assert.equal(compile(z.coerce.string()).pure, false);
  sameIssues(z.bigint().min(5n), 1n);
  sameIssues(z.bigint().multipleOf(2n), 3n);
  const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.x";
  assert.equal(
    compile(z.string().jwt()).safeParse(jwt).success,
    z.string().jwt().safeParse(jwt).success,
  );
  assert.equal(
    compile(z.string().jwt({ alg: "RS256" })).safeParse(jwt).success,
    z.string().jwt({ alg: "RS256" }).safeParse(jwt).success,
  );
});

test("catch receives the inner issues and does not swallow a throwing callback", () => {
  let seen: unknown[] = [];
  const C = compile(
    z
      .string()
      .min(3)
      .catch((c) => {
        seen = c.error.issues;
        return `fallback:${String(c.input)}`;
      }),
  );
  assert.equal(C.parse("x" as never), "fallback:x");
  assert.equal((seen[0] as any).code, "too_small");
  const T = compile(
    z
      .string()
      .refine(() => {
        throw new Error("boom");
      })
      .catch("safe"),
  );
  assert.throws(() => T.parse("x" as never), /boom/);
});

test("safeParse builds the error lazily; async transform is rejected like an async refinement", () => {
  const C = compile(z.object({ a: z.string() }));
  const r = C.safeParse({ a: 1 });
  assert.equal(r.success, false);
  if (!r.success) {
    assert.ok(r.error instanceof ZcError);
    assert.equal(r.error, r.error); // memoized
  }
  const A = compile(z.string().transform(async (s) => s));
  assert.throws(() => A.parse("x" as never), ZcNotSupportedError);
});

test("ZcError carries issues", () => {
  const C = compile(z.object({ a: z.string() }));
  try {
    C.parse({ a: 1 } as never);
    assert.fail("should throw");
  } catch (e) {
    assert.ok(e instanceof ZcError);
    assert.equal((e as ZcErrorType).issues[0]!.code, "invalid_type");
  }
});

console.log(
  "── third review round of #63: rebuild order, compile-time effects, holes, record keys ──",
);

test("record/map/set: a transformed key or member that collides with a later entry is overwritten by it, in stock's order", () => {
  // Stock rebuilds from the parsed entries in iteration order, so the later (unchanged) entry wins
  const key = z.string().transform((k) => (k === "a" ? "b" : k));
  const R = z.record(key, z.number());
  assert.deepEqual(compile(R).parse({ a: 1, b: 2 }), R.parse({ a: 1, b: 2 }));
  assert.deepEqual(compile(R).parse({ a: 1, b: 2 }), { b: 2 });
  assert.deepEqual(Object.keys(compile(R).parse({ b: 2, a: 1 }) as object), ["b"]);
  assert.deepEqual(compile(R).parse({ b: 2, a: 1 }), { b: 1 }); // the transformed entry comes later here

  const M = z.map(key, z.number());
  const mIn = new Map([
    ["a", 1],
    ["b", 2],
  ]);
  assert.deepEqual([...compile(M).parse(mIn)], [...M.parse(mIn)]);
  assert.deepEqual([...compile(M).parse(mIn)], [["b", 2]]);
  assert.deepEqual(
    [...mIn],
    [
      ["a", 1],
      ["b", 2],
    ],
  ); // input lossless

  const S = z.set(z.number().transform((n) => (n === 1 ? 2 : 1)));
  const sIn = new Set([1, 2]);
  assert.deepEqual([...compile(S).parse(sIn)], [...S.parse(sIn)]);
  assert.deepEqual([...compile(S).parse(sIn)], [2, 1]);
  assert.deepEqual([...sIn], [1, 2]);

  // A change in the middle keeps the clean prefix and the clean suffix in order
  const R2 = z.record(
    z.string(),
    z.number().transform((n) => (n === 2 ? 20 : n)),
  );
  const out = compile(R2).parse({ a: 1, b: 2, c: 3 }) as Record<string, number>;
  assert.deepEqual(Object.keys(out), ["a", "b", "c"]);
  assert.deepEqual(out, { a: 1, b: 20, c: 3 });
  const M2 = z.map(
    z.string(),
    z.number().transform((n) => (n === 2 ? 20 : n)),
  );
  assert.deepEqual(
    [
      ...compile(M2).parse(
        new Map([
          ["a", 1],
          ["b", 2],
          ["c", 3],
        ]),
      ),
    ],
    [
      ["a", 1],
      ["b", 20],
      ["c", 3],
    ],
  );
  const S2 = z.set(z.number().transform((n) => (n === 2 ? 20 : n)));
  assert.deepEqual([...compile(S2).parse(new Set([1, 2, 3]))], [1, 20, 3]);
});

test("object: compile() runs no user callback, and a child that adds an issue at run time is always consulted", () => {
  let calls = 0;
  let armed = false;
  const child = z.preprocess((v, ctx) => {
    calls++;
    if (armed) ctx.addIssue({ code: "custom", message: "armed" });
    return v;
  }, z.unknown());
  const tr = z.unknown().transform((v) => {
    calls++;
    return v;
  });
  const rf = z.unknown().refine(() => {
    calls++;
    return true;
  });
  const df = z.string().default(() => {
    calls++;
    return "d";
  });
  const C = compile(z.object({ a: child, b: tr, c: rf, d: df }));
  assert.equal(calls, 0); // no safeParse(undefined) probe of the children at compile time
  assert.equal(C.safeParse({}).success, true);
  armed = true;
  const r = C.safeParse({});
  assert.equal(r.success, false);
  assert.deepEqual(r.success ? [] : r.error.issues.map((i) => i.path), [["a"]]);
  assert.equal(C.safeParse({ a: undefined }).success, false);

  // The structural shortcut still holds where stock never reaches the child: optional / any / unknown /
  // undefined / void / nullable(optional) skip an absent key and return the input by reference
  const P = compile(
    z.object({
      a: z.string().optional(),
      b: z.any(),
      c: z.unknown(),
      d: z.undefined(),
      e: z.void(),
      f: z.string().optional().nullable(),
    }),
  );
  const empty = {};
  assert.equal(P.parse(empty), empty);
  // A preprocess under optional is short-circuited by the optional on undefined (stock too)
  let under = 0;
  const O = compile(
    z.object({
      a: z
        .preprocess((v) => {
          under++;
          return v;
        }, z.string())
        .optional(),
    }),
  );
  assert.equal(O.parse(empty), empty);
  assert.equal(under, 0);
});

test("array / tuple: a hole is materialized as an own undefined slot like stock", () => {
  const A = z.array(z.unknown());
  const hole = new Array(1);
  const out = compile(A).parse(hole) as unknown[];
  assert.notEqual(out, hole);
  assert.equal(Object.hasOwn(out, 0), true);
  assert.deepEqual(out, A.parse(hole));
  assert.equal(Object.hasOwn(hole, 0), false); // input lossless

  // A hole next to a default and a plain value: every slot is own afterwards, values as stock
  const D = z.array(z.string().default("d"));
  const sparse = new Array(3);
  sparse[1] = "x";
  const dout = compile(D).parse(sparse) as string[];
  assert.deepEqual(dout, ["d", "x", "d"]);
  assert.deepEqual(
    [0, 1, 2].map((i) => Object.hasOwn(dout, i)),
    [true, true, true],
  );
  // A hole after the first copy is still materialized
  const late = ["x", "y"];
  late.length = 4;
  late[2] = undefined as never;
  const lout = compile(z.array(z.string().optional())).parse(late) as unknown[];
  assert.deepEqual(
    [0, 1, 2, 3].map((i) => Object.hasOwn(lout, i)),
    [true, true, true, true],
  );
  assert.deepEqual(lout, z.array(z.string().optional()).parse(late));
  // Dense arrays keep the reference
  const dense = [undefined, "x"];
  assert.equal(compile(z.array(z.string().optional())).parse(dense), dense);
  const empty: unknown[] = [];
  assert.equal(compile(A).parse(empty), empty);

  const T = z.tuple([z.string().optional(), z.number().optional()]);
  const th = new Array(2);
  const tout = compile(T).parse(th) as unknown[];
  assert.notEqual(tout, th);
  assert.deepEqual(
    [0, 1].map((i) => Object.hasOwn(tout, i)),
    [true, true],
  );
  assert.deepEqual(tout, T.parse(th));
  // A hole in the truncated part of an oversized tuple and a hole in a declared slot
  const tbig = new Array(3);
  tbig[1] = 2;
  const tb = compile(T).safeParse(tbig);
  assert.equal(tb.success, false); // too_big is an issue, as in stock
  const tdense = [undefined, 1];
  assert.equal(compile(T).parse(tdense), tdense);
});

test("record: an own __proto__ is dropped, a key transformed to __proto__ is skipped, an inherited enumerable key is written as own", () => {
  const R = z.record(z.string(), z.number());
  const proto = JSON.parse('{"__proto__":1}');
  const out = compile(R).parse(proto) as object;
  assert.notEqual(out, proto);
  assert.equal(Object.hasOwn(out, "__proto__"), false);
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  assert.deepEqual(out, R.parse(proto));
  assert.equal(Object.hasOwn(proto, "__proto__"), true); // input lossless

  const mixed = JSON.parse('{"x":1,"__proto__":2,"y":3}');
  const RT = z.record(
    z.string(),
    z.number().transform((n) => n + 1),
  );
  const mout = compile(RT).parse(mixed) as object;
  assert.deepEqual(Object.keys(mout), ["x", "y"]);
  assert.deepEqual(mout, RT.parse(mixed));
  assert.equal(Object.hasOwn(mout, "__proto__"), false);

  // A key transform producing "__proto__": stock's assembly skips that pair
  const KP = z.record(
    z.string().transform((k) => (k === "a" ? "__proto__" : k)),
    z.number(),
  );
  const kout = compile(KP).parse({ a: 1, b: 2 }) as object;
  assert.deepEqual(Object.keys(kout), ["b"]);
  assert.equal(Object.hasOwn(kout, "__proto__"), false);
  assert.equal(Object.getPrototypeOf(kout), Object.prototype);
  assert.deepEqual(kout, KP.parse({ a: 1, b: 2 }));

  // Stock's record loop is `for...in` without an own check: an inherited enumerable key is parsed
  // and written as an own key of the output
  const inh = Object.create({ inh: 1 });
  inh.own = 2;
  const iout = compile(R).parse(inh) as object;
  assert.notEqual(iout, inh);
  assert.deepEqual(Object.keys(iout), ["own", "inh"]);
  assert.equal(Object.hasOwn(iout, "inh"), true);
  assert.deepEqual(iout, R.parse(inh));
  assert.equal(
    compile(R).safeParse(Object.assign(Object.create({ inh: "no" }), { own: 2 })).success,
    false,
  );
  const plain = { own: 2 };
  assert.equal(compile(R).parse(plain), plain);
});

/** Every object reachable from `v` (objects, arrays, Dates, Map keys and values, Set members) */
function reachable(v: unknown, out = new Set<object>()): Set<object> {
  if (v === null || (typeof v !== "object" && typeof v !== "function") || out.has(v)) return out;
  out.add(v);
  if (v instanceof Map) {
    for (const [k, x] of v) {
      reachable(k, out);
      reachable(x, out);
    }
  } else if (v instanceof Set) {
    for (const x of v) reachable(x, out);
  } else {
    for (const k of Reflect.ownKeys(v)) reachable((v as any)[k], out);
  }
  return out;
}

test("default: a container default is rebuilt at every level like stock, so the output never aliases the schema's default value", () => {
  // Stock hands the default value to the inner schema, whose containers and dates build fresh
  // output; the compiled skeletons do the same below a default that fired (stock's rebuild mode)
  const fallback = {
    a: "x",
    n: { d: new Date(0), t: ["p", 1] as [string, number] },
    arr: [{ v: 1 }],
    rec: { k: { v: 2 } },
    m: new Map([["k", { v: 3 }]]),
    s: new Set([{ v: 4 }]),
  };
  const Inner = z.object({
    a: z.string(),
    n: z.object({ d: z.date(), t: z.tuple([z.string(), z.number()]) }),
    arr: z.array(z.object({ v: z.number() })),
    rec: z.record(z.string(), z.object({ v: z.number() })),
    m: z.map(z.string(), z.object({ v: z.number() })),
    s: z.set(z.object({ v: z.number() })),
  });
  const S = Inner.default(fallback);
  const owned = reachable(fallback);
  for (const out of [S.parse(undefined), compile(S).parse(undefined)]) {
    assert.deepEqual(out, fallback);
    for (const o of reachable(out)) assert.equal(owned.has(o), false, "output aliases the default");
    assert.equal(Object.isFrozen(out), false);
  }
  // Mutating the parsed result does not change the schema's state for later parses
  const C = compile(S);
  const first = C.parse(undefined);
  first.a = "mutated";
  first.n.d.setTime(1);
  first.arr[0]!.v = 99;
  assert.deepEqual(C.parse(undefined), fallback);
  assert.equal(fallback.a, "x");
  assert.equal(fallback.n.d.getTime(), 0);
  assert.equal(fallback.arr[0]!.v, 1);
  // A present value still takes the CoW path by reference
  const present = structuredClone(fallback);
  assert.equal(C.parse(present), present);
  // Nested position: only the defaulted subtree is rebuilt, the siblings stay shared
  const nestedFallback = { v: 1 };
  const N = z.object({
    keep: z.object({ q: z.string() }),
    n: z.object({ v: z.number() }).default(nestedFallback),
  });
  const nin = { keep: { q: "x" } };
  const nout = compile(N).parse(nin);
  assert.notEqual(nout, nin);
  assert.equal(nout.keep, nin.keep);
  assert.notEqual(nout.n, nestedFallback);
  assert.deepEqual(nout, N.parse(nin));
  // A pass-through leaf hands the default back as it is, like stock (`unknown` builds nothing)
  const raw = { v: 1 };
  const U = z.unknown().default(raw);
  assert.equal(U.parse(undefined), raw);
  assert.equal(compile(U).parse(undefined), raw);
  // A default function still runs per parse and its result is rebuilt like stock
  let calls = 0;
  const F = z.object({ v: z.number() }).default(() => ({ v: ++calls }));
  const CF = compile(F);
  assert.deepEqual(CF.parse(undefined), { v: 1 });
  assert.deepEqual(CF.parse(undefined), { v: 2 });
  // An invalid default fails like stock
  const bad = compile(z.object({ v: z.number() }).default({ v: "no" } as never)).safeParse(
    undefined,
  );
  assert.equal(bad.success, false);
  assert.equal(bad.error.issues[0]!.code, "invalid_type");
  assert.deepEqual(bad.error.issues[0]!.path, ["v"]);
});

test("readonly: the frozen copy is stock's output assembly (getter read once, own symbol dropped, nested containers and dates fresh and unfrozen)", () => {
  const S = z
    .object({ a: z.string(), d: z.date(), n: z.object({ v: z.number() }), l: z.array(z.number()) })
    .readonly();
  let reads = 0;
  const mk = () => ({
    get a() {
      return ++reads === 1 ? "first" : "later";
    },
    d: new Date(0),
    n: { v: 1 },
    l: [1],
  });
  const stockIn = mk();
  const stockOut = S.parse(stockIn);
  assert.equal(stockOut.a, "first");
  assert.equal(reads, 1);
  reads = 0;
  const input = mk();
  const out = compile(S).parse(input);
  assert.equal(out.a, "first");
  assert.equal(reads, 1);
  assert.equal(Object.isFrozen(out), true);
  assert.equal(Object.isFrozen(input), false);
  // Stock's freeze is shallow and its nested output is fresh: same here
  assert.notEqual(out.d, input.d);
  assert.notEqual(out.n, input.n);
  assert.notEqual(out.l, input.l);
  assert.equal(Object.isFrozen(out.n), false);
  assert.equal(Object.isFrozen(out.l), false);
  assert.equal(Object.isFrozen(input.n), false);
  assert.deepEqual(out, stockOut);
  // An undeclared own symbol key is dropped by the copy, as stock's assembly drops it
  const sym = Symbol("s");
  const T = z.object({ a: z.string() }).readonly();
  const symIn = { a: "x", [sym]: 1 };
  assert.deepEqual(Object.getOwnPropertySymbols(T.parse({ a: "x", [sym]: 1 })), []);
  assert.deepEqual(Object.getOwnPropertySymbols(compile(T).parse(symIn)), []);
  // The other containers: fresh copies with fresh members where stock rebuilds them
  const inner = { v: 1 };
  for (const [R, input2] of [
    [z.array(z.object({ v: z.number() })).readonly(), [inner]],
    [z.tuple([z.object({ v: z.number() })]).readonly(), [inner]],
    [z.record(z.string(), z.object({ v: z.number() })).readonly(), { k: inner }],
    [z.map(z.string(), z.object({ v: z.number() })).readonly(), new Map([["k", inner]])],
    [z.set(z.object({ v: z.number() })).readonly(), new Set([inner])],
  ] as const) {
    const o = compile(R as z.ZodTypeAny).parse(input2) as object;
    assert.equal(Object.isFrozen(o), true);
    assert.equal(reachable(o).has(inner), false, `member aliased for ${R.constructor.name}`);
    assert.deepEqual(o, (R as z.ZodTypeAny).parse(input2));
  }
  assert.equal(Object.isFrozen(inner), false);
});

test("z.lazy: the getter is resolved once, when the schema is compiled, and never during a parse", () => {
  // Stock calls the getter on every parse; a compiled parser resolves it once and every analysis
  // (`.pure`, effects below, rebuild) and every parse use that one schema (zod 4's own compiler
  // resolves it once as well, on the first parse). A getter that changes its answer is therefore
  // pinned to its first answer, which the documentation states.
  let calls = 0;
  const L = z.lazy(() => (++calls % 2 ? z.string() : z.number()));
  assert.deepEqual([L.safeParse("x").success, L.safeParse(1).success], [true, true]);
  calls = 0;
  const C = compile(L);
  assert.equal(calls, 1);
  assert.equal(C.pure, true);
  assert.equal(C.safeParse("x").success, true);
  assert.equal(C.safeParse(1).success, false);
  assert.equal(C.safeParse("y").success, true);
  assert.equal(calls, 1);
  // The resolution is shared: a second compile of the same lazy node resolves nothing again
  compile(z.object({ l: L }));
  assert.equal(calls, 1);
  // A lazy over a container is not pure and rebuilds under readonly like stock
  const R = z.lazy(() => z.object({ a: z.string() })).readonly();
  const CR = compile(R);
  assert.equal(CR.pure, false);
  const rin = { a: "x" };
  assert.notEqual(CR.parse(rin), rin);
  assert.equal(Object.isFrozen(rin), false);
});

summary(noCodegen ? "unit (closure skeletons, --no-codegen)" : "unit (generated skeletons)");
