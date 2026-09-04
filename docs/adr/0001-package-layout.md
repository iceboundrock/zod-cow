# ADR 0001: Package layout: one package per zod major in a pnpm workspace

- Status: accepted, 2026-09-04 (this record closes [#8](https://github.com/iceboundrock/zod-cow/issues/8) on merge)
- Decided in: [#8](https://github.com/iceboundrock/zod-cow/issues/8)
- Implementation tracked in: [#9](https://github.com/iceboundrock/zod-cow/issues/9)

## Context

The repository holds two compiler lines that share no code:

| Line | Source today | Size | Anchored to |
|---|---|---|---|
| zod4 (active) | `src/index-z4.ts`, `src/cow4/`, `src/probe-z4*.ts` | about 1 800 lines of engine (entry plus `cow4/`); the probes add about 630 | zod 4.5.4, through the internal `zod/v4/core` namespace (`compileFn`, `INVALID`, `ZodCompileAsyncError`, `ZodCompileUnsupportedError`, `$ZodAsyncError`, `regexes`, `util`) |
| zod3 (frozen reference) | `src/index.ts`, `src/compile.ts`, `src/internal.ts`, `src/regexes.ts`, `src/probe.ts` | about 1 600 lines including the probe | zod 3.24.1, with that version's format regexes copied verbatim |

After #4 removed the zod4 v1 line, the only candidate for "shared code" is `src/internal.ts`, a 141-line protocol module used solely by the zod3 line. The test harness (`tests/harness.ts`: `test`, `summary`, `deepEqual`, 117 lines) is shared, but it is test infrastructure, not runtime code. The two benchmarks share nothing by import; each carries its own copy of the account fixture and the `measure` / `report` / `median` helpers.

Two facts constrain the layout more than the line count does:

1. **A package resolves one `zod`.** The repository currently installs both majors side by side with an npm alias (`zod4` → `zod@4.5.4`) so that one `node_modules` can serve both lines. Published code cannot keep that alias: a consumer installs `zod`, so the shipped sources must import `zod` and `zod/v4/core` by their real specifiers. Whatever ships must therefore be typechecked and tested against a `node_modules/zod` of the right major, and a single package directory only has one.
2. **The zod4 line depends on zod internals.** Nothing in `zod/v4/core` carries a stability guarantee (see `docs/upstream-issue-draft.md`). `src/cow4/predicates.ts` and `WHEN_DEFAULTED_CHECKS` in `src/cow4/purity.ts` are hand-copied from zod's compiler, and `tests/canary-z4.test.ts` exists because a zod minor can change behavior the engine assumes.

The issue listed three layouts: a single package with subpath exports (`zod-cow`, `zod-cow/v3`), a two-package monorepo, and the three-package monorepo from the original TODO (shared / zod3 / zod4). It also asked for the npm names, the peer-dependency policy for zod, the workspace tool, and whether the zod3 line is published at all.

## Decision

### 1. Layout: pnpm workspace, one package per zod major

```
packages/zod-cow-v4/    published as `zod-cow-v4`: the zod4 line (entry, engine, probes, canary flags,
                        smoke and differential tests, its own copy of the test harness)
packages/zod-cow-v3/    private `zod-cow-v3`: the frozen zod3 line, its unit and differential tests,
                        its own copy of the test harness
packages/bench-v4/      private `bench-v4`: the zod4 benchmark and `examples/demo.ts`; depends on
                        `zod-cow-v4` (`workspace:*`), `zod@4.5.4` and the reference-line libraries (`arktype`)
packages/bench-v3/      private `bench-v3`: the zod3 benchmark; depends on `zod-cow-v3` (`workspace:*`),
                        `zod@3.24.1` and `arktype`
```

The repository root is a private workspace package holding `pnpm-workspace.yaml`, `biome.json`, the base `tsconfig.json`, the GitHub workflows, `docs/`, both READMEs and `CHANGELOG.md`. Root scripts fan out with `pnpm -r` (or `pnpm --filter`); no task runner (turbo, nx) is added for four packages.

There is **no shared package**, neither runtime nor development. The only code both lines use is the test harness and the benchmark scaffolding (account fixture, `measure` / `report` / `median`), and each package carries its own copy. Duplicating a few hundred lines of test scaffolding is cheaper than a fifth package whose only consumers are the other four, and it keeps the frozen zod3 line free of a dependency that could move under it. A shared package is added only when two published packages actually share code, which is not the case today.

Each package directory owns exactly one `zod` at the right major (a devDependency in the line packages, a dependency in the bench packages), so every package imports `zod` by its real specifier. The `zod4` alias and the `zod3`-vs-`zod4` naming in imports disappear.

The benchmarks are packages of their own for two reasons. The reference-line libraries they compare against (`arktype` today, possibly more later) never appear in the dependency list of a line package. And `bench-v4` imports `zod-cow-v4` through its real `exports` entry, so it measures the built artifact a consumer installs rather than the TypeScript source. `bench-v3` imports `zod-cow-v3` through the workspace link; that package is private and has no build, so its `exports` points at the TypeScript source and `tsx` transpiles it (a pnpm workspace link resolves to the real path under `packages/`, outside `node_modules`).

### 2. Names and entry points

- The published package is **`zod-cow-v4`**: the repository name plus the zod major it is built for. The name was unregistered on npm on 2026-09-04, as were `zod-cow-v3` and the bare `zod-cow` (`cow-zod` was also free and was rejected for not matching the repository). It is unscoped, and its directory is `packages/zod-cow-v4/`, so package names and directories match across the workspace. Carrying the major in the name says up front what the peer range in section 3 enforces: the package targets one zod major. It also makes the zod3 line and a future zod5 line sibling packages (`zod-cow-v3`, `zod-cow-v5`) instead of subpaths or renames.
- `zod-cow-v4` has a single entry: `import { compile } from "zod-cow-v4"`. There is no version subpath, because the major is in the package name and the package contains exactly one line; there is nothing for a subpath to disambiguate.
- The private packages are named `zod-cow-v3`, `bench-v4` and `bench-v3`, unscoped and matching their directories. Their names only matter inside the workspace.
- `zod-cow-v4` carries the project version and continues the existing 0.x sequence; `CHANGELOG.md` at the root covers the whole workspace.

### 3. Peer-dependency policy for zod

`zod-cow-v4` declares `zod` as a **peerDependency whose range covers only the minors the test suites have verified**. The initial range is `>=4.5.4 <4.6.0`. The package's own devDependency pins the exact version used in CI (`zod@4.5.4`).

Widening the range is a release, not a config edit. The steps, in order:

1. Bump the devDependency to the new zod version.
2. Diff `src/cow4/predicates.ts` and `WHEN_DEFAULTED_CHECKS` against the upstream compiler and update the copies.
3. Run `probe:z4`, the canary, the smoke tests and the full differential fuzzer; the reference-sharing rate must not drop.
4. Widen the peer range to include the verified minor and publish `zod-cow-v4`.

A caret range (`^4.5.4`) is rejected: it would let a zod minor change compiler internals under an installed `zod-cow-v4` with no signal on the consumer's side, since the canary only runs in this repository's CI. The peer range is the honest statement of what the engine depends on. The exit from this policy is upstream making `compileFn` / `assertOnly` / `INVALID` public (`docs/upstream-issue-draft.md`).

`zod-cow-v3` pins `zod@3.24.1` exactly as a devDependency and declares no peer, since it is not published.

### 4. The zod3 line is not published

`zod-cow-v3` is `private: true`. It stays in the repository as the frozen reference implementation, keeps its typecheck, unit tests and differential fuzzer in CI (its benchmark runs from `bench-v3`), but has no build and no npm release; its `exports` points at the TypeScript source so that `bench-v3` can import it through the workspace link. Reasons:

- It is anchored to one exact zod 3 patch release, with copied regexes; a peer range would have to be `3.24.1` exactly.
- It deviates from stock in a known way (`readonly` freezes the caller's input in place, #27) and its API differs from the zod4 line (`ZcError` instead of `ZodError`, `validate()` returns a `DeepReadonly` view instead of `unknown`). Publishing it would commit the project to supporting a second API surface.
- zod 3 is in maintenance upstream.

If it is ever published, it becomes a release of its own package under this layout; `zod-cow-v4` is untouched. That is the point of one package per major.

### 5. Build and artifact shape

- ESM only, plus `.d.ts` declarations, emitted by `tsc`. No CJS build: the engine floor is Node.js >= 22.13.0, which supports `require(esm)`, so CommonJS consumers on the supported Node range can still `require("zod-cow-v4")`.
- `exports` lists `.` and `./package.json` only. `files` restricts the tarball to the build output. npm adds `package.json`, `README` and `LICENSE` to every tarball regardless of `files`, but it takes them from the package directory, so `packages/zod-cow-v4/` carries its own README and a copy of the root `LICENSE`; the root copies are not in the tarball.
- Probes (`probe-z4.ts`), canary flags (`probe-z4-flags.ts`) and tests live in the package directory but stay outside the build's `include` and outside `files`. They are diagnostics, not API. The benchmark and the examples are not in the package at all; they live in `bench-v4`.

## Consequences

- #9 moves the sources into the four packages, adds the build, `exports`, `files` and the workspace wiring, moves `arktype` from the root `devDependencies` into the two bench packages, and reworks CI so typecheck, lint, both test lines and both benches run against the new layout. The command table and module map in `AGENTS.md`, the repository layout in both READMEs, and the `zod4/v4/core` references in the docs change in that PR.
- The Benchmarks workflow builds `zod-cow-v4` before running `bench-v4`, and the zod4 numbers in the README come from the built artifact from then on. `bench-v3` keeps measuring the zod3 source. The asymmetry is accepted: that line is frozen and its table is historical.
- The test harness exists twice. A fix to one copy is applied to the other in the same PR, the rule the two READMEs already follow.
- Every zod 4 minor requires a `zod-cow-v4` release before consumers on that minor can install without a peer warning. This cost is accepted; it is the cost of building on internal API.
- The differential suites run per package, so they keep their `SEEDS` / `CASES` / `REPRO` knobs unchanged.
- Nothing in the published artifact references the zod3 line, and nothing in the zod3 line references `zod-cow-v4`; the two packages can evolve on independent cadences if that ever matters.

## Rejected alternatives

- **Single package with subpath exports** (`zod-cow` and `zod-cow/v3`). Rejected because a package resolves one `zod`: the zod3 line could not be typechecked and tested against zod 3 in the same package without the npm alias, and the alias cannot ship. It would also have needed a peer range of `3.24.x || 4.5.x` in which the default entry fails at import time on zod 3. Mirroring zod's own `zod` / `zod/v3` / `zod/v4` shape only works because zod ships all of them from one codebase against one dependency tree; this project does not.
- **`zod-cow` as the published name.** Rejected because the bare name would claim the neutral name for a package that supports one zod major; the peer range says so, and the name should say the same. It would also make a later zod3 or zod5 release either a subpath of that package, which section 1 rules out, or a rename.
- **Three-package monorepo** (shared / zod3 / zod4). Rejected because the shared package would hold no runtime code: `internal.ts` is used only by the zod3 line, and the zod4 line never imported it. A development-only shared package (test harness, bench fixtures, measurement helpers) was considered as a fifth package and rejected as well; see section 1.
- **Benchmarks inside the line packages.** Rejected because the reference-line libraries would become devDependencies of the published package, and because the zod4 benchmark would keep measuring the TypeScript source instead of the shipped build.
- **One benchmark package for both lines.** Rejected because it would need both zod majors in one directory, which is the alias problem section 1 removes.
- **Publishing the zod3 line against zod 4's `zod/v3` compatibility entry.** Rejected as untested: the zod3 line reads the `_def` tree and copies regexes from 3.24.1, and `zod/v3` inside zod 4 tracks a later 3.x.
- **A task runner** (turbo, nx). Rejected for three packages; `pnpm -r` and `--filter` are enough.
- **Caret peer range** (`^4.5.4`). Rejected; see section 3.
