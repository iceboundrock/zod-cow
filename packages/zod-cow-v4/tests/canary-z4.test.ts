/**
 * zod version canary — the stock zod4 behaviors the CoW layer is built on.
 *
 * `src/probe-z4-flags.ts` measures these behaviors against the installed zod4
 * at import time; this suite asserts that every one of them still holds. A zod
 * upgrade that changes one of these implicit contracts turns this test red
 * instead of silently drifting the compiled semantics away from stock.
 *
 * Anchored to zod 4.5.4. After bumping zod: run `pnpm run probe:z4`, re-read
 * the assumptions, then run the differential suite.
 *
 * These assertions previously lived in `tests/unit-z4.test.ts`, which was
 * removed together with the zod4 v1 compiler line.
 */
import assert from "node:assert/strict";
import { test, summary } from "./harness.js";
import { PROBE4 } from "../src/probe-z4-flags.js";

test(`PROBE4: stock zod4 semantics match the compiler's assumptions (zod ${PROBE4.zodVersion})`, () => {
  assert.equal(
    PROBE4.absentOptionalNotMaterialized,
    true,
    "an absent optional key must not be materialized",
  );
  assert.equal(PROBE4.presentUndefKept, true, "a present-undefined key must be kept");
  assert.equal(PROBE4.outputFollowsShapeOrder, true, "output key order must follow the shape");
  assert.equal(PROBE4.strictViaCatchallNever, true, "strict must be modelled as catchall never");
  assert.equal(PROBE4.looseViaCatchallUnknown, true, "loose must be modelled as catchall unknown");
  assert.equal(PROBE4.recordRebuilds, true, "stock record must rebuild its output");
  assert.equal(PROBE4.defaultShortCircuits, true, "z4 default must short-circuit (no inner check)");
  assert.equal(PROBE4.catchThrowsPropagate, true, "z4 catch must not swallow thrown errors");
  assert.equal(PROBE4.cleanParseClones, true, "a clean stock parse must produce a new object");
  assert.equal(
    PROBE4.readonlyFreezesPassThroughInput,
    true,
    "stock readonly over a pass-through leaf must freeze the input in place (#28)",
  );
  assert.equal(
    PROBE4.readonlyContainerFreezesCopy,
    true,
    "stock readonly over a container must freeze a copy and leave the input unfrozen",
  );
  assert.equal(
    PROBE4.compilerThrowsOnWrapperLengthShortcut,
    true,
    "stock's compiler must still throw on the shortcut for a wrapper length check while the runtime passes it (#69: revisit the runtime-island route when this changes)",
  );
  assert.equal(
    PROBE4.compilerPassesWrapperRangeShortcut,
    true,
    "stock's compiler must still pass the shortcut for a wrapper range check while the runtime fails it (#69: revisit the runtime-island route when this changes)",
  );
});

summary("canary-z4");
