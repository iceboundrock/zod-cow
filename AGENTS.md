# AGENTS.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A prototype **Copy-on-Write (CoW) compilation layer for Zod schemas**. `compile(schema)` returns a fast parser whose output is `===` the input reference when nothing was forced to change (no default/transform/strip/etc. fired), and otherwise copies only the dirty path from leaf to root. The README is the authoritative narrative; `docs/ARCHITECTURE-v2.md` is the deep dive on the current engine.

Git repository with GitHub Actions CI (`.github/workflows/ci.yml`: typecheck + both test lines on a Node 22/24/26 matrix, plus a separate `lint` job). A second workflow, `.github/workflows/bench.yml`, runs `bench:v2` and `bench` on `workflow_dispatch` / weekly schedule only (never on push/PR) with a reduced `BENCH_N` and writes the output to the job summary; treat those as smoke results, not reference numbers. Linting and formatting use Biome (`biome.json`: recommended rules with `noExplicitAny` and `noNonNullAssertion` off); `pnpm run lint` must pass before a PR is opened.

**Language:** all code comments, test/bench output strings, and non-code artifacts (docs, issues, PR text, plans, reviews) are written in English. Much of the existing code and documentation is still in Chinese; that migration is tracked in #6 (code comments and test/bench output) and #7 (README, architecture doc, CHANGELOG). When you edit an existing file, write new or changed comments in English and do not mass-translate unrelated lines in the same change. Purely mechanical edits inside an existing Chinese line (swapping a command or identifier, fixing a path) do not by themselves require translating that line.

## Commands

Use Node.js >= 22.13.0 with pnpm 11.24.0.

`pnpm install` first (tsx/tsc are local devDependencies; nothing works without it).

| Task | Command |
|---|---|
| Typecheck | `pnpm run typecheck` |
| Lint + format check (read-only, fails on warnings) | `pnpm run lint` |
| Apply safe lint fixes and formatting | `pnpm run lint:fix` |
| Format only | `pnpm run format` |
| Tests, zod3 line (v1), plus the `tests/harness.ts` self-test | `pnpm test` |
| Tests, zod4 **v2 line (current work)** | `pnpm run test:v2` |
| Run one test file | `pnpm exec tsx tests/<file>.ts` (e.g. `pnpm exec tsx tests/smoke-v2.ts`) |
| Benchmarks | `pnpm run bench` / `pnpm run bench:v2` (need `--expose-gc`, already in scripts) |
| Probe stock zod behavior | `pnpm run probe` / `pnpm run probe:z4` |
| 60-second demo | `pnpm exec tsx examples/demo.ts` |

There is no test runner. Test files are plain `tsx` scripts: unit/smoke tests use `tests/harness.ts` (`test()` + `summary()`, sets `process.exitCode = 1` on failure); differential tests are standalone fuzzers that compare against stock zod and share only the `deepEqual` comparator from `tests/harness.ts`.

Environment knobs:

- `SEEDS` / `CASES` — differential fuzz size; code defaults are 200 × 100 = 20 000 cases (the 50 000-case figures in README/docs were larger runs). Use `SEEDS=20 CASES=50 pnpm exec tsx tests/differential-z4-v2.test.ts` for a quick pass.
- `REPRO=seed:case` — re-run exactly one failing differential case and dump the schema/input/generated code (zod4 tests only, e.g. `REPRO=112:80 pnpm exec tsx tests/differential-z4-v2.test.ts`).
- `BENCH_N` — benchmark record count (default 500 000; the CI bench workflow uses 50 000).

## Architecture

Two compiler front-ends live in `src/`; they share no code (`internal.ts` is the zod3 line's protocol module — the v2 engine never imported it). Know which line you are editing:

| Line | Entry | Engine | Status |
|---|---|---|---|
| zod3 v1 | `src/index.ts` → `src/compile.ts` | Hand-written closure-tree compiler; string regexes copied verbatim into `src/regexes.ts` from zod 3.24.1 | Frozen reference |
| zod4 **v2** | `src/index-z4-v2.ts` → `src/cow4-v2.ts` | Reuses zod4's **official JIT codegen** as the semantic backend, adds CoW container skeletons | **Active line** — new work goes here |

zod 3 and zod 4 are installed side by side: `import { z } from "zod"` is 3.24.1, `import { z } from "zod4"` is the npm alias for zod@4.5.4.

### The CoW invariant (all lines)

Every compiled node is `(input) => output | FAILED-sentinel`. Dirtiness needs no protocol: a child returning the same reference means "unchanged"; a parent does its first shallow copy (`{...input}` / `slice()` / `new Map(input)`) only at the first changed child, then writes further dirty children into that copy. Primitives compare by value (`'x'.trim() === 'x'` is clean). Consequences that constrain every change:

- Never mutate input. Strip must never `delete` on the input object.
- Output may alias input, so refines must not mutate, and `readonly` freezing is applied to shared structure.
- Failure paths carry no issue data of their own: they return the sentinel and the caller falls back to stock `safeParse` for the full `ZodError`.

### v2 engine (`src/cow4-v2.ts`) — how the pieces fit

1. **Official products as leaves/subtrees.** Imports `compileFn`, `INVALID`, `ZodCompileUnsupportedError`, `ZodCompileAsyncError`, `$ZodAsyncError` from the *internal* namespace `zod4/v4/core`. `compileFn(schema)` gives a stock-semantics parser; `compileFn(schema, {assertOnly:true})` gives a validator that skips output construction.
2. **Purity analysis** (`isPure`, `leafChecksArePure`, `checksAreCowSafe`, ~lines 219–340): a conservative whitelist deciding "validation passes ⇒ output === input". Pure subtrees get the official *validator*; impure subtrees get the official *parser* plus a reference comparison. Three documented traps, each caught by the differential fuzzer: `overwrite` checks (`.trim()` etc.) rewrite values and are impure; length/size checks carry a default `when` (`WHEN_DEFAULTED_CHECKS`, copied from zod) and must not be rejected as custom-`when`; `optional/nullable` wrappers must be unwrapped before deciding whether a container gets a skeleton.
3. **Container skeletons** (`emitCoWObject/Array/Tuple/Record/Map/Set`): string-templated codegen that mirrors zod's own `generate*` functions line by line, then rewrites the unconditional `const out = {...}` into "compare refs, copy on first dirt, `return input` when clean". Container-level checks (`min/max/refine`) run via `containerChecksFn` on the final output in both clean and copied paths. Wiring goes through `childProduct` / `cowSafeContainerForChild` / `emitBoxedContainer`; extend those when adding a container or wrapper combination.
4. **Async**: official `ZodCompileAsyncError` is used as the detector. Async subtrees become async islands (marked with the `ZC_ASYNC` symbol), every product call site emits `await`, and the skeleton becomes an async function. `subtreeHasAsync` statically covers `lazy(async…)` which the official compiler misses. Sync API on an async product throws `$ZodAsyncError`, same as stock.
5. **Degradation chain**, per subtree, never trading correctness: CoW skeleton → official validator (pure leaf) → official parser (impure subtree) → runtime island (`_zod.run` black box) → whole-tree stock `safeParse` (`compiled.stock === true`). `compiled.code` exposes the generated skeleton source for debugging.

### Version anchoring

The v2 line depends on zod4 internals and on hand-copied predicates (`WHEN_DEFAULTED_CHECKS`, `getTupleOptStart`, `mayOutputUndefined`, `acceptsAbsence`). Anchored to **zod 4.5.4**. `src/probe-z4-flags.ts` encodes the stock behaviors the compilers assume (default short-circuits, catch does not swallow throws, optional hands undefined to a defaulted inner, etc.), and `tests/canary-z4.test.ts` (first step of `test:v2`) asserts them so an upgrade turns tests red instead of drifting silently. After bumping zod: rerun probes, then the full differential suites.

### Known unsupported (throws at compile time or degrades to stock)

`intersection`; zod3 `catchall`/tuple rest/`ZodPromise`; zod4 `file`/`templateLiteral`/`promise`, `string_format` without a `pattern` (e.g. `url`), recursive top-level and schema-level `catchall` in v2. Do not silently widen support: either add a differential-verified path, or keep the explicit failure (the zod3 v1 line throws `ZcNotSupportedError` at compile time; v2 lets the official `ZodCompileUnsupportedError` degrade the tree to stock).

## Working conventions

- Any change to purity rules or a container skeleton must be validated with the differential fuzzer for that line (`tests/differential-z4-v2.test.ts` for v2), not only the smoke tests. Report the reference-sharing rate it prints; a drop indicates a lost CoW path.
- Benchmarks in the README/docs were measured on node v24 with 3-run medians; update the tables when re-measuring rather than adding new ones.
- Architecture changes to v2 belong in `docs/ARCHITECTURE-v2.md`; `docs/upstream-issue-draft.md` is a draft issue for zod upstream asking to make `compileFn`/`assertOnly`/`INVALID` public.

## Non-code artifacts

Anything a task produces that is not code (design docs, specs, plans, research notes, assessments) must end up on GitHub, not just on disk.

- Write non-code artifacts in English (see the Language rule above).
- Post the artifact as a comment on the relevant issue. If the work has no issue yet, create one first; if the artifact is about changes already under review, post it to the PR instead.
- Post the full content, not a summary or a file path. Several child repos keep planning notes in gitignored local directories (for example `__ref__/plan/` in `ltbase.api`, see #497); a local working copy is fine, but it is invisible to everyone else and does not survive the branch.
- Do not force-add gitignored planning files to make them shareable. The issue comment is the sharing mechanism.
- Say in the comment which artifact it is and where the working copy lives, so a later reader knows whether they are looking at a plan, a spec, or a review.
- Anything that must become a durable repository convention still belongs in that repo's `docs/` (an ADR, runbook, or reference page). The issue comment records the thinking; `docs/` records the decision.

## PR rules

- Do not merge a PR unless I explicitly ask you to.
- When reviewing a PR, post everything (findings, spec and standards checks, assessment, observations, verification, summary) as one comment on the PR.
- When I ask you to merge a PR, squash-merge by default unless I ask for something else.
- After a PR is merged, clean up local branches and worktrees, fast-forward main, then update and close related issues.

## Git conventions

Never include AI attribution in commit messages, PR titles, or PR descriptions, in any form. That means no

- `Co-Authored-By: Claude`
- `Generated with ...` footers
- sign-offs or footers naming an LLM or AI agent (OpenAI, GPT, Claude, Anthropic, and the like)

When squash-merging, write a clean commit message that describes only the change itself.
