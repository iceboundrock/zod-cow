/**
 * Behavior probe — empirically pin down stock-zod edge semantics that the CoW
 * compiler must reproduce for differential parity.
 *
 * The compiler reads these flags at module load, so a zod version bump that
 * changes "hidden contract" behavior is automatically picked up instead of
 * silently diverging.
 */
import { z } from "zod";

export interface ProbeResult {
  /** strip 模式下，optional 键在输入中缺席时，输出是否保留显式 `key: undefined` */
  absentOptionalKeptStrip: boolean;
  /** passthrough 模式下同上 */
  absentOptionalKeptPassthrough: boolean;
  /** strip 模式下，键存在但值为 undefined（schema 接受 undefined）时，输出是否保留该键 */
  presentUndefKeptStrip: boolean;
  /** passthrough 模式下同上 */
  presentUndefKeptPassthrough: boolean;
  /** strip 模式下，键存在但值为 undefined（schema 是 z.any()，必接受）时，输出是否保留该键 */
  presentUndefKeptAnyStrip: boolean;
  /** 输出对象键序：是否按 shape 声明序重排（true）还是保留输入序（false） */
  outputFollowsShapeOrder: boolean;
  /** strict 模式 extras 是否也会让 alwaysValid 键被物化（仅信息性） */
  strictExtraIssuePath: string;
  /** zod record：值未变时输出是否为原引用（仅信息性） */
  recordRebuilds: boolean;
  zodVersion: string;
}

function computeProbe(): ProbeResult {
  const S = z.object({ a: z.string().optional(), b: z.string() });

  const stripAbsent = S.parse({ b: "x" }) as Record<string, unknown>;
  const passAbsent = S.passthrough().parse({ b: "x" }) as Record<string, unknown>;
  const stripPresent = S.parse({ b: "x", a: undefined }) as Record<string, unknown>;
  const passPresent = S.passthrough().parse({ b: "x", a: undefined }) as Record<string, unknown>;
  const anyPresent = z
    .object({ a: z.any(), b: z.string() })
    .parse({ b: "x", a: undefined }) as Record<string, unknown>;

  const orderSchema = z.object({ x: z.string(), y: z.string() });
  const ordered = orderSchema.parse({ y: "1", x: "2" }) as Record<string, unknown>;

  // strict 模式下 unrecognized_keys 的 path（信息性）
  let strictPath = "";
  {
    const r = z.object({ a: z.string() }).strict().safeParse({ b: 1 } as never);
    if (!r.success) strictPath = JSON.stringify(r.error.issues[0]?.path ?? []);
  }

  // record 是否重建（信息性）
  const recIn = { k: 1 };
  const recOut = z.record(z.string(), z.number()).parse(recIn) as Record<string, unknown>;

  const version = (() => {
    try {
      // zod 未导出 version，从其 package.json 读
      const req = eval("require") as NodeRequire;
      return req("zod/package.json").version as string;
    } catch {
      return "unknown";
    }
  })();

  return {
    absentOptionalKeptStrip: "a" in stripAbsent,
    absentOptionalKeptPassthrough: "a" in passAbsent,
    presentUndefKeptStrip: "a" in stripPresent,
    presentUndefKeptPassthrough: "a" in passPresent,
    presentUndefKeptAnyStrip: "a" in anyPresent,
    outputFollowsShapeOrder: Object.keys(ordered).join("") === "xy",
    strictExtraIssuePath: strictPath,
    recordRebuilds: recOut !== recIn,
    zodVersion: version,
  };
}

export const PROBE: ProbeResult = computeProbe();

if (process.argv[1]?.endsWith("probe.ts")) {
  console.log("stock zod behavior probe:");
  for (const [k, v] of Object.entries(PROBE)) console.log(`  ${k.padEnd(34)} = ${v}`);
}
