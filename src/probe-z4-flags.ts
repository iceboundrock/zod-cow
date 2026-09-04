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
  /** strip 模式：缺席 optional 键不物化（编译器据此跳过该键） */
  absentOptionalNotMaterialized: boolean;
  /** strip 模式：present-undefined 键保留（CoW 透传天然对齐） */
  presentUndefKept: boolean;
  /** 输出键序按 shape 声明序 */
  outputFollowsShapeOrder: boolean;
  /** strict = catchall never / loose = catchall unknown */
  strictViaCatchallNever: boolean;
  looseViaCatchallUnknown: boolean;
  /** record：stock 恒重建（CoW 干净路径返回原引用是合法超集） */
  recordRebuilds: boolean;
  /** default 短路：默认值不过内层校验（z4 与 z3 相反） */
  defaultShortCircuits: boolean;
  /** catch 不吞异常（z4 与 z3 相反） */
  catchThrowsPropagate: boolean;
  /** clean parse 恒产生新对象（内存对比的基线事实） */
  cleanParseClones: boolean;
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
    catchThrowsPropagate = false; // 被吞了
    void r;
  } catch {
    catchThrowsPropagate = true; // 异常向上传播（z4 语义）
  }

  const cleanIn = { a: "x", b: 1 };
  const cleanOut: any = z.object({ a: z.string(), b: z.number() }).parse(cleanIn);
  const cleanParseClones = cleanOut !== cleanIn;

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
    zodVersion,
  };
}

export const PROBE4: Probe4Flags = computeFlags();
