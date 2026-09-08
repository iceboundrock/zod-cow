/**
 * Version resolution for the scheduled drift check (#30, `.github/workflows/zod-drift.yml`).
 *
 * Run from the package directory, it reads the published peer range of `zod-cow-v4` from
 * `package.json`, lists every zod release from the registry and prints one JSON object:
 *
 *   - `range`: the peer range as published;
 *   - `inRange`: every stable release the range admits, ascending, the job's matrix. Pre-releases
 *     are excluded; a release the ADR's widening procedure already verified is listed again, since
 *     re-running it keeps the job free of bookkeeping; a disjoint range after a re-admission
 *     (`>=4.5.4 <4.5.5 || >=4.5.6 <4.6.0`, ADR 0001 §3) skips the excluded release through
 *     `satisfies` without a special case. A range that admits no stable release is an error.
 *   - `next`: the newest stable release just above the range's upper bound, the informational
 *     target, or `null` when no such release exists yet (`nextReason` says which series was
 *     looked at). The target is derived from the bound, never from `zod@latest`, which can be a
 *     later minor or major and stop exercising the version the next widening release would admit.
 *   - `published`: the registry's publish time of every listed release, for the job summary.
 *
 * The pure functions are exported for `tests/drift-versions.test.ts`; only the `main` at the
 * bottom touches the registry.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Range, SemVer, gte, inc, prerelease, satisfies, sort, valid } from "semver";

export interface DriftTargets {
  range: string;
  inRange: string[];
  next: string | null;
  nextSeries: string | null;
  nextReason: string;
  published: Record<string, string>;
}

export interface NextTarget {
  version: string | null;
  /** The `major.minor.x` series the target was looked for in (the fall-through's, if it ran). */
  series: string | null;
  reason: string;
}

/** Valid, non-prerelease versions, ascending. */
export function stableVersions(all: readonly string[]): string[] {
  return sort(all.filter((v) => valid(v) !== null && prerelease(v) === null));
}

/** The stable releases the range admits, ascending. */
export function versionsInRange(range: string, stable: readonly string[]): string[] {
  return sort(stable.filter((v) => satisfies(v, range)));
}

/**
 * The highest upper bound across the `||` alternatives of the range, as an exclusive bound
 * (`<=x` is read as `<` the next patch). `null` when some alternative has no upper bound: a range
 * such as `>=4.5.4 <4.6.0 || >=4.7.0` admits every later release already, so no single release
 * sits "just above" it and the informational step has nothing to target.
 */
export function exclusiveUpperBound(range: string): SemVer | null {
  let highest: SemVer | null = null;
  for (const comparators of new Range(range).set) {
    let bound: SemVer | null = null;
    for (const c of comparators) {
      if (c.operator === "<") bound = c.semver;
      else if (c.operator === "<=") bound = new SemVer(inc(c.semver, "patch")!);
    }
    if (bound === null) return null;
    if (highest === null || gte(bound, highest)) highest = bound;
  }
  return highest;
}

function newestInSeries(
  stable: readonly string[],
  major: number,
  minor: number,
  atOrAbove?: SemVer,
): string | null {
  const hits = stable.filter((v) => {
    const s = new SemVer(v);
    return s.major === major && s.minor === minor && (atOrAbove === undefined || gte(s, atOrAbove));
  });
  return hits.length === 0 ? null : sort(hits)[hits.length - 1]!;
}

/**
 * The informational target: the newest stable release just above the range's upper bound.
 *
 * - Bound at a minor boundary (`<4.6.0`, the normal case): the newest `4.6.x`.
 * - Bound at a patch, after an emergency narrowing (`<4.5.5`): the newest `4.5.x` at or above
 *   the bound, since a fix release would re-admit that series first; when no such patch exists
 *   yet, the newest `4.6.x`.
 * - No upper bound: no target.
 */
export function nextTarget(range: string, stable: readonly string[]): NextTarget {
  const bound = exclusiveUpperBound(range);
  if (bound === null) {
    return {
      version: null,
      series: null,
      reason: `the peer range ${range} has no upper bound, so there is no release just above it`,
    };
  }
  const label = `${bound.major}.${bound.minor}.${bound.patch}`;
  if (bound.patch > 0) {
    const sameMinor = newestInSeries(stable, bound.major, bound.minor, bound);
    const series = `${bound.major}.${bound.minor}.x`;
    if (sameMinor !== null) {
      return {
        version: sameMinor,
        series,
        reason: `newest stable ${series} release at or above the patch upper bound ${label}`,
      };
    }
    const nextMinor = `${bound.major}.${bound.minor + 1}.x`;
    const fallThrough = newestInSeries(stable, bound.major, bound.minor + 1);
    return {
      version: fallThrough,
      series: nextMinor,
      reason:
        fallThrough === null
          ? `no stable ${series} release at or above ${label} and no stable ${nextMinor} release exists yet`
          : `no stable ${series} release at or above ${label}; newest stable ${nextMinor} release instead`,
    };
  }
  const series = `${bound.major}.${bound.minor}.x`;
  const version = newestInSeries(stable, bound.major, bound.minor);
  return {
    version,
    series,
    reason:
      version === null
        ? `no stable ${series} release exists yet above the upper bound ${label}`
        : `newest stable ${series} release above the upper bound ${label}`,
  };
}

export function resolveDriftTargets(
  range: string,
  allVersions: readonly string[],
  times: Readonly<Record<string, string>>,
): DriftTargets {
  const stable = stableVersions(allVersions);
  const inRange = versionsInRange(range, stable);
  if (inRange.length === 0) {
    throw new Error(`the peer range ${range} admits no stable zod release out of ${stable.length}`);
  }
  const next = nextTarget(range, stable);
  const published: Record<string, string> = {};
  for (const v of next.version === null ? inRange : [...inRange, next.version]) {
    if (times[v] !== undefined) published[v] = times[v];
  }
  return {
    range,
    inRange,
    next: next.version,
    nextSeries: next.series,
    nextReason: next.reason,
    published,
  };
}

function npmView(field: string): unknown {
  // npm is invoked through the shell wrapper on every platform pnpm supports.
  const out = execFileSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["view", "zod", field, "--json"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
      env: { ...process.env, NO_COLOR: "1" },
    },
  );
  return JSON.parse(out);
}

/** The declared peer range, or an error naming what `package.json` holds instead. */
export function peerRange(declared: unknown): string {
  if (typeof declared !== "string" || declared.trim() === "") {
    throw new Error(`package.json declares no zod peer range (got ${JSON.stringify(declared)})`);
  }
  try {
    new Range(declared);
  } catch (error) {
    throw new Error(`package.json declares an invalid zod peer range ${JSON.stringify(declared)}`, {
      cause: error,
    });
  }
  return declared;
}

function main(): void {
  const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  const range = peerRange(manifest.peerDependencies?.zod);
  const versions = npmView("versions") as string[];
  const times = npmView("time") as Record<string, string>;
  const targets = resolveDriftTargets(range, versions, times);
  process.stdout.write(`${JSON.stringify(targets, null, 2)}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
