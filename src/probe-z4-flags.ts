/**
 * zod4 behavior probe flags — the "version canary" for the semantics the compiler hard-codes.
 *
 * The zod4 engine (src/cow4/) assumes the stock behaviors below (all measured on zod 4.5.4
 * via probe-z4.ts).
 * The canary-z4 test asserts these flags still match the compiler's assumptions: when a zod
 * upgrade changes the implicit contract the test goes red instead of drifting silently.
 */
import { z } from "zod4";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export interface Probe4Flags {
  /** strip mode: an absent optional key is not materialized (the compiler skips that key on this basis) */
  absentOptionalNotMaterialized: boolean;
  /** strip mode: a present-undefined key is kept (CoW pass-through aligns with it naturally) */
  presentUndefKept: boolean;
  /** Output key order follows the shape declaration order */
  outputFollowsShapeOrder: boolean;
  /** strict = catchall never / loose = catchall unknown */
  strictViaCatchallNever: boolean;
  looseViaCatchallUnknown: boolean;
  /** record: stock always rebuilds (the CoW clean path returning the original reference is a legal superset) */
  recordRebuilds: boolean;
  /** default short-circuits: the default value does not go through the inner validation (z4 is the opposite of z3) */
  defaultShortCircuits: boolean;
  /** catch does not swallow throws (z4 is the opposite of z3) */
  catchThrowsPropagate: boolean;
  /** a clean parse always produces a new object (the baseline fact for the memory comparison) */
  cleanParseClones: boolean;
  /**
   * readonly over a pass-through leaf (any/unknown/custom) returns the caller's input and freezes it in
   * place: stock readonly freezes whatever the inner parser hands back. The zod4 line reproduces this (#28)
   */
  readonlyFreezesPassThroughInput: boolean;
  /** readonly over a container freezes a fresh copy and leaves the input unfrozen */
  readonlyContainerFreezesCopy: boolean;
  zodVersion: string;
}

function computeFlags(): Probe4Flags {
  const S = z.object({ a: z.string().optional(), b: z.string() });

  const absentOptionalNotMaterialized = !("a" in (S.parse({ b: "x" }) as object));
  const presentUndefKept = "a" in (S.parse({ b: "x", a: undefined }) as object);

  const O = z.object({ x: z.string(), y: z.string() });
  const outputFollowsShapeOrder = Object.keys(O.parse({ y: "1", x: "2" })).join("") === "xy";

  const strictObj = z.strictObject({ a: z.string() }) as any;
  const looseObj = z.looseObject({ a: z.string() }) as any;
  const t = (s: any) => s._zod.def.catchall?._zod?.def?.type;
  const strictViaCatchallNever = t(strictObj) === "never";
  const looseViaCatchallUnknown = t(looseObj) === "unknown";

  const rin = { k: 1 };
  const rout: any = z.record(z.string(), z.number()).parse(rin);
  const recordRebuilds = rout !== rin;

  let defaultShortCircuits: boolean;
  try {
    defaultShortCircuits = z
      .number()
      .int()
      .default(1.5 as never)
      .safeParse(undefined).success;
  } catch {
    defaultShortCircuits = false;
  }

  let catchThrowsPropagate: boolean;
  try {
    const thrower: any = z
      .string()
      .refine(() => {
        throw new Error("boom");
      })
      .catch("fb");
    const r = thrower.safeParse("x");
    catchThrowsPropagate = false; // swallowed
    void r;
  } catch {
    catchThrowsPropagate = true; // the throw propagates upwards (z4 semantics)
  }

  const cleanIn = { a: "x", b: 1 };
  const cleanOut: any = z.object({ a: z.string(), b: z.number() }).parse(cleanIn);
  const cleanParseClones = cleanOut !== cleanIn;

  const roLeafIn = { a: "x" };
  const roLeafOut: any = z.any().readonly().parse(roLeafIn);
  const readonlyFreezesPassThroughInput = roLeafOut === roLeafIn && Object.isFrozen(roLeafIn);

  const roObjIn = { a: "x" };
  const roObjOut: any = z.object({ a: z.string() }).readonly().parse(roObjIn);
  const readonlyContainerFreezesCopy =
    roObjOut !== roObjIn && !Object.isFrozen(roObjIn) && Object.isFrozen(roObjOut);

  let zodVersion = "unknown";
  try {
    zodVersion = require("zod4/package.json").version as string;
  } catch {
    /* keep */
  }

  return {
    absentOptionalNotMaterialized,
    presentUndefKept,
    outputFollowsShapeOrder,
    strictViaCatchallNever,
    looseViaCatchallUnknown,
    recordRebuilds,
    defaultShortCircuits,
    catchThrowsPropagate,
    cleanParseClones,
    readonlyFreezesPassThroughInput,
    readonlyContainerFreezesCopy,
    zodVersion,
  };
}

export const PROBE4: Probe4Flags = computeFlags();
