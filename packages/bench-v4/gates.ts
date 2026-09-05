/**
 * Equivalence gates for the cross-library scenarios.
 *
 * Before a scenario is timed, every implementation is run over a small fixture set holding both
 * accepted and deliberately invalid inputs. The run aborts (throws) as soon as one implementation
 * accepts an input the others reject, or produces a different output for an accepted input,
 * unless the fixture declares that divergence up front. Declared divergences are printed as
 * `known divergence` lines so they stay visible in every benchmark log.
 *
 * The gates check semantics only; nothing here is timed.
 */
import assert from "node:assert/strict";
import type { Column } from "./harness.js";

export interface Impl {
  column: Column;
  label: string;
  /** true when the input is accepted */
  accepts: (input: unknown) => boolean | Promise<boolean>;
  /** Output for an accepted input (omit when the implementation has no output, e.g. `allows`) */
  output?: (input: unknown) => unknown;
}

export interface Fixture {
  name: string;
  input: unknown;
  /**
   * `true` / `false`: every implementation must agree. A per-column object declares a known
   * semantic divergence; `divergence` must then say why.
   */
  accept: boolean | Partial<Record<Column, boolean>>;
  divergence?: string;
  /** Both accept, but the outputs legitimately differ (e.g. strip vs pass-through of extra keys) */
  outputDiffers?: string;
}

export async function gate(scenario: string, impls: Impl[], fixtures: Fixture[]): Promise<void> {
  console.log(`  equivalence gate (${fixtures.length} fixtures):`);
  for (const f of fixtures) {
    const verdicts = new Map<Impl, boolean>();
    for (const impl of impls) verdicts.set(impl, await impl.accepts(f.input));

    for (const impl of impls) {
      const expected =
        typeof f.accept === "boolean"
          ? f.accept
          : (f.accept[impl.column] ??
            (() => {
              throw new Error(
                `${scenario}: fixture "${f.name}" has no expectation for ${impl.label}`,
              );
            })());
      const got = verdicts.get(impl)!;
      if (got !== expected) {
        throw new Error(
          `${scenario}: fixture "${f.name}": ${impl.label} ${got ? "accepted" : "rejected"} an input the scenario expects to be ${expected ? "accepted" : "rejected"}`,
        );
      }
    }

    if (typeof f.accept !== "boolean") {
      if (!f.divergence)
        throw new Error(`${scenario}: fixture "${f.name}" declares a divergence without a reason`);
      const who = impls
        .map((i) => `${i.column}=${verdicts.get(i) ? "accept" : "reject"}`)
        .join(" ");
      console.log(`    ~ ${f.name}: known divergence (${who}): ${f.divergence}`);
      continue;
    }

    if (!f.accept) {
      console.log(`    ✓ ${f.name}: rejected by all`);
      continue;
    }

    // Accepted by all: outputs must match the first implementation (stock zod), unless declared
    const withOutput = impls.filter((i) => i.output);
    const reference = withOutput[0];
    if (reference && !f.outputDiffers) {
      const expectedOut = await reference.output!(f.input);
      for (const impl of withOutput.slice(1)) {
        const out = await impl.output!(f.input);
        try {
          assert.deepStrictEqual(out, expectedOut);
        } catch (e) {
          throw new Error(
            `${scenario}: fixture "${f.name}": ${impl.label} output differs from ${reference.label}: ${(e as Error).message}`,
          );
        }
      }
      console.log(`    ✓ ${f.name}: accepted by all, outputs deepStrictEqual`);
    } else {
      console.log(
        `    ✓ ${f.name}: accepted by all${f.outputDiffers ? ` (outputs differ: ${f.outputDiffers})` : ""}`,
      );
    }
  }
}
