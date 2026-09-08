/**
 * Unit test of the version resolution behind the scheduled drift check (#30,
 * `.github/workflows/zod-drift.yml`): which stable zod releases the published peer range admits,
 * and which release just above the range's upper bound the informational step targets. Every
 * range shape ADR 0001 §3 can produce is covered: the normal one-minor range, a patch upper bound
 * after an emergency narrowing, a disjoint range after a re-admission, a `<=` or caret bound, and
 * a range with no upper bound.
 */
import assert from "node:assert/strict";
import {
  exclusiveUpperBound,
  nextTarget,
  peerRange,
  resolveDriftTargets,
  stableVersions,
  versionsInRange,
} from "../scripts/drift-versions.js";
import { summary, test } from "./harness.js";

const PUBLISHED = [
  "3.25.76",
  "4.5.0-canary.20260828T171753",
  "4.5.0",
  "4.5.1",
  "4.5.2",
  "4.5.3",
  "4.5.4",
];

test("stableVersions drops pre-releases and sorts ascending", () => {
  assert.deepEqual(stableVersions(["4.5.4", "4.6.0-beta.1", "4.5.0", "3.25.76", "4.5.2"]), [
    "3.25.76",
    "4.5.0",
    "4.5.2",
    "4.5.4",
  ]);
  assert.deepEqual(stableVersions(["not a version", "4.5.4"]), ["4.5.4"]);
});

test("versionsInRange: the normal range admits the anchored patch and every later one", () => {
  assert.deepEqual(versionsInRange(">=4.5.4 <4.6.0", stableVersions(PUBLISHED)), ["4.5.4"]);
  assert.deepEqual(
    versionsInRange(">=4.5.4 <4.6.0", ["4.5.3", "4.5.4", "4.5.5", "4.5.6", "4.6.0"]),
    ["4.5.4", "4.5.5", "4.5.6"],
  );
});

test("versionsInRange: a disjoint range after a re-admission skips exactly the excluded release", () => {
  assert.deepEqual(
    versionsInRange(">=4.5.4 <4.5.5 || >=4.5.6 <4.6.0", ["4.5.4", "4.5.5", "4.5.6", "4.5.7"]),
    ["4.5.4", "4.5.6", "4.5.7"],
  );
});

test("exclusiveUpperBound: the highest `<` bound across the alternatives, `<=` moved one patch up", () => {
  assert.equal(exclusiveUpperBound(">=4.5.4 <4.6.0")?.version, "4.6.0");
  assert.equal(exclusiveUpperBound(">=4.5.4 <4.5.5")?.version, "4.5.5");
  assert.equal(exclusiveUpperBound(">=4.5.4 <4.5.5 || >=4.5.6 <4.6.0")?.version, "4.6.0");
  assert.equal(exclusiveUpperBound(">=4.5.4 <=4.5.5")?.version, "4.5.6");
  // node-semver desugars a caret range to `<5.0.0-0`; the bound's release part is what matters.
  assert.equal(exclusiveUpperBound("^4.5.4")?.version, "5.0.0-0");
  assert.equal(exclusiveUpperBound(">=4.5.4"), null);
  // An unbounded alternative admits every later release already, so nothing sits just above the
  // range: no target, even though the other alternative has a bound.
  assert.equal(exclusiveUpperBound(">=4.5.4 <4.6.0 || >=4.7.0"), null);
});

test("peerRange: a missing, empty or invalid declaration is an error naming what was found", () => {
  assert.equal(peerRange(">=4.5.4 <4.6.0"), ">=4.5.4 <4.6.0");
  assert.throws(() => peerRange(undefined), /declares no zod peer range \(got undefined\)/);
  assert.throws(() => peerRange(" "), /declares no zod peer range \(got " "\)/);
  assert.throws(() => peerRange({ zod: "4" }), /declares no zod peer range/);
  assert.throws(
    () => peerRange("garbage"),
    (error: unknown) =>
      error instanceof Error &&
      /invalid zod peer range "garbage"/.test(error.message) &&
      error.cause instanceof TypeError,
  );
});

test("nextTarget: a minor-boundary bound targets the newest release of that minor", () => {
  const next = nextTarget(">=4.5.4 <4.6.0", ["4.5.4", "4.6.0", "4.6.2", "4.7.0"]);
  assert.equal(next.version, "4.6.2");
  assert.equal(next.series, "4.6.x");
});

test("nextTarget: the target is derived from the bound, never from the newest release", () => {
  // 4.7.0 exists but no 4.6.x does: the next widening release would still admit 4.6, so there is
  // nothing to test yet.
  const next = nextTarget(">=4.5.4 <4.6.0", ["4.5.4", "4.7.0", "5.0.0"]);
  assert.equal(next.version, null);
  assert.equal(next.series, "4.6.x");
  assert.match(next.reason, /no stable 4\.6\.x release/);
});

test("nextTarget: a patch bound after a narrowing targets the same minor's newest patch at or above it", () => {
  const next = nextTarget(">=4.5.4 <4.5.5", ["4.5.4", "4.5.5", "4.5.6", "4.6.0"]);
  assert.equal(next.version, "4.5.6");
  assert.equal(next.series, "4.5.x");
  // Only the broken release itself exists above the bound: it is the target, and is expected red.
  assert.equal(nextTarget(">=4.5.4 <4.5.5", ["4.5.4", "4.5.5", "4.6.0"]).version, "4.5.5");
});

test("nextTarget: a patch bound with no later patch falls through to the next minor", () => {
  const next = nextTarget(">=4.5.4 <4.5.5", ["4.5.4", "4.6.0", "4.6.1"]);
  assert.equal(next.version, "4.6.1");
  assert.equal(next.series, "4.6.x");
  assert.match(next.reason, /no stable 4\.5\.x release at or above 4\.5\.5/);
  const none = nextTarget(">=4.5.4 <4.5.5", ["4.5.4"]);
  assert.equal(none.version, null);
  assert.equal(none.series, "4.6.x");
});

test("nextTarget: a disjoint range after a re-admission is the normal case again", () => {
  const next = nextTarget(">=4.5.4 <4.5.5 || >=4.5.6 <4.6.0", ["4.5.4", "4.5.5", "4.5.6", "4.6.0"]);
  assert.equal(next.version, "4.6.0");
  assert.equal(next.series, "4.6.x");
});

test("nextTarget: `<=` and caret bounds follow the same rules", () => {
  assert.equal(
    nextTarget(">=4.5.4 <=4.5.5", ["4.5.5", "4.5.6", "4.5.7", "4.6.0"]).version,
    "4.5.7",
  );
  assert.equal(
    nextTarget("^4.5.4", ["4.5.4", "4.6.0", "5.0.0", "5.0.3", "5.1.0"]).version,
    "5.0.3",
  );
});

test("nextTarget: a range with no upper bound has no informational target", () => {
  const next = nextTarget(">=4.5.4", ["4.5.4", "4.6.0"]);
  assert.equal(next.version, null);
  assert.equal(next.series, null);
  assert.match(next.reason, /no upper bound/);
});

test("resolveDriftTargets: the matrix and the informational target for the published range", () => {
  const targets = resolveDriftTargets(">=4.5.4 <4.6.0", [...PUBLISHED, "4.6.0-beta.1", "4.6.0"], {
    "4.5.4": "2026-08-29T17:55:42.775Z",
    "4.6.0": "2026-10-01T00:00:00.000Z",
    "4.6.0-beta.1": "2026-09-20T00:00:00.000Z",
  });
  assert.deepEqual(targets, {
    range: ">=4.5.4 <4.6.0",
    inRange: ["4.5.4"],
    next: "4.6.0",
    nextSeries: "4.6.x",
    nextReason: "newest stable 4.6.x release above the upper bound 4.6.0",
    published: { "4.5.4": "2026-08-29T17:55:42.775Z", "4.6.0": "2026-10-01T00:00:00.000Z" },
  });
});

test("resolveDriftTargets: a range that admits no stable release is an error, not an empty matrix", () => {
  assert.throws(() => resolveDriftTargets(">=4.5.4 <4.6.0", ["4.5.3"], {}), /admits no stable/);
});

summary("drift-versions");
