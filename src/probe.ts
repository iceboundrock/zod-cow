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
  /** In strip mode, whether the output keeps an explicit `key: undefined` when an optional key is absent from the input */
  absentOptionalKeptStrip: boolean;
  /** Same as above, in passthrough mode */
  absentOptionalKeptPassthrough: boolean;
  /** In strip mode, whether the output keeps a key that is present with value undefined (the schema accepts undefined) */
  presentUndefKeptStrip: boolean;
  /** Same as above, in passthrough mode */
  presentUndefKeptPassthrough: boolean;
  /** In strip mode, whether the output keeps a key that is present with value undefined (the schema is z.any(), which must accept) */
  presentUndefKeptAnyStrip: boolean;
  /** Output object key order: reordered to the shape declaration order (true) or the input order kept (false) */
  outputFollowsShapeOrder: boolean;
  /** Whether strict-mode extras also cause alwaysValid keys to be materialized (informational only) */
  strictExtraIssuePath: string;
  /** zod record: whether the output is the original reference when no value changed (informational only) */
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

  // The path of unrecognized_keys in strict mode (informational)
  let strictPath = "";
  {
    const r = z
      .object({ a: z.string() })
      .strict()
      .safeParse({ b: 1 } as never);
    if (!r.success) strictPath = JSON.stringify(r.error.issues[0]?.path ?? []);
  }

  // Whether record rebuilds (informational)
  const recIn = { k: 1 };
  const recOut = z.record(z.string(), z.number()).parse(recIn) as Record<string, unknown>;

  const version = (() => {
    try {
      // zod does not export a version, so read it from its package.json
      // biome-ignore lint/security/noGlobalEval: probe script; borrows CJS require from an ESM entry to read zod/package.json
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
