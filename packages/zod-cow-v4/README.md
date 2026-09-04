# zod-cow-v4

A Copy-on-Write (CoW) compilation layer for [zod](https://zod.dev) 4 schemas.

`compile(schema)` returns a fast parser whose output is `===` the input reference whenever nothing was forced to change: no default, transform, strip, coerce, catch, preprocess or pipe fired. When something did change, only the path from that leaf to the root is copied; every sibling subtree keeps sharing the input. Nothing is deleted or rewritten on the input object.

The layer does not fork zod and does not change the Zod API. Schemas are consumed as they are, type inference stays `z.infer`, and validation semantics come from zod's own JIT compiler, which this package reuses as its semantic backend. The failure path is stock `safeParse`, so issues and `ZodError` are the official ones.

This README is the consumer document for the published package: install, usage, API and the zod peer policy. The repository README covers what the layer is, the CoW invariant, the benchmark tables, the correctness evidence and the known limitations; see [Further reading](#further-reading).

## Requirements

- Node.js `>=22.13.0`.
- zod `>=4.5.4 <4.6.0`, installed by you (it is a peer dependency, see [Peer policy](#peer-policy-for-zod)).

## Install

```bash
pnpm add zod-cow-v4 zod
# or: npm install zod-cow-v4 zod
```

## Usage

```ts
import { z } from "zod";
import { compile } from "zod-cow-v4";

const User = z.object({
  id: z.number().int(),
  name: z.string(),
  role: z.enum(["admin", "member", "viewer"]).default("viewer"),
});

const fast = compile(User);

fast.parse(data);           // CoW: === the input reference when clean, otherwise only the dirty path is copied
fast.safeParse(data);       // non-throwing; the failure path is stock safeParse, so issues/ZodError are official
fast.validate(data);        // validation only (official whole-tree assertOnly product): the input reference on success, null on failure
await fast.parseAsync(data);     // async variants; the only usable entry when the schema holds an async refine/transform
await fast.safeParseAsync(data);
fast.async;                 // true = the skeleton holds an async subtree; the sync API then throws $ZodAsyncError, as stock does
fast.stock;                 // true = this layer gave up on the whole tree and everything goes through stock (never a semantic loss)
fast.code;                  // generated CoW skeleton source, for debugging (null when degraded to stock)
```

Two consequences of structural sharing to keep in mind:

- The output may alias the input. Parsing the same input twice returns the same reference, and modifying the output modifies the input. Treat parse results as read-only, or copy them yourself before mutating.
- Refinements and transforms must not mutate their argument, because it may be the caller's object.

## API

### `compile(schema)`

`compile<T extends z.ZodType>(schema: T): Compiled<T>`

Compiles once and returns a `Compiled<T>`. Compilation never throws for a supported-or-degradable schema: subtrees the JIT cannot compile fall back to a runtime island, and a whole tree it refuses falls back to stock parsing (`stock === true`). The only errors that escape `compile` are errors that are not zod compile errors (a bug in the schema's own code, for example).

### `Compiled<T>`

| Member | Type | Behavior |
|---|---|---|
| `parse(data)` | `(data: unknown) => z.output<T>` | Returns the input reference when nothing changed, otherwise a copy along the dirty path only. Throws the stock `ZodError` on failure. Throws `$ZodAsyncError` when `async` is true. |
| `safeParse(data)` | `(data: unknown) => { success: true; data: z.output<T> } \| { success: false; error: z.ZodError }` | Non-throwing `parse`. The failure branch is stock `safeParse`, so `error` is the official `ZodError` with the official issues. Throws `$ZodAsyncError` when `async` is true. |
| `parseAsync(data)` | `(data: unknown) => Promise<z.output<T>>` | Async `parse`; works for sync and async schemas. |
| `safeParseAsync(data)` | `(data: unknown) => Promise<…>` | Async `safeParse`. |
| `validate(data)` | `(data: unknown) => unknown` | Validation only, no output construction: returns the input reference when the schema accepts it, `null` when it does not. Typed `unknown` on purpose: the result is the caller's own object. Throws `$ZodAsyncError` when `async` is true. |
| `schema` | `T` | The schema that was compiled. |
| `stock` | `boolean` | `true` when this layer gave up on the whole tree and every call goes through stock zod (same results, no CoW benefit). |
| `async` | `boolean` | `true` when the schema holds an async refine or transform; then only the `*Async` methods are usable, and the sync ones throw `$ZodAsyncError` exactly as stock does. |
| `code` | `string \| null` | The generated CoW skeleton source, for debugging. `null` when `stock` is true. |

### What is supported

Every zod 4 schema type that zod's own JIT compiler accepts, plus CoW skeletons for `object`, `array`, `tuple`, `record`, `map` and `set`, and async refine/transform anywhere in the tree. What the JIT refuses (`intersection`, `file`, `templateLiteral`, `promise`, a `string_format` without a `pattern` such as `url`, recursive schemas, schema-level `catchall`) never produces wrong results: a refused leaf becomes a runtime island that calls zod's interpreter for that subtree while the containers around it keep their CoW behavior, and a refused container degrades the whole tree to stock parsing with `stock === true`. The list with the reasons is in the repository README under [Known limitations](https://github.com/iceboundrock/zod-cow/blob/main/README.md#known-limitations-prototype-scope).

## Module format

The package ships ESM only, with TypeScript declarations next to every module. The `exports` map has two entries: `.` (the API) and `./package.json`.

CommonJS consumers on the supported Node range can `require("zod-cow-v4")` directly: Node.js 22.12 and later load ES modules through `require()`, and the package's Node floor (`>=22.13.0`) is above that line. Both entry styles are exercised by the packed-tarball smoke in the repository's CI on the exact floor version.

## Peer policy for zod

`zod-cow-v4` declares `zod` as a peer dependency whose range is limited to the minors its test suites have verified. The current range is `>=4.5.4 <4.6.0`.

Why so narrow: the layer builds on zod's compiler exports (`compileFn`, `assertOnly`, `INVALID` and the artifact protocol behind them), which zod re-exports from the public `zod/v4/core` permalink subpath but does not document or support under semver. A zod minor may change them without notice, and the only signal would be this repository's own canary tests, which do not run in your project. The peer range states what has actually been verified rather than promising compatibility with releases that have not been tested.

What that means for you:

- Patch releases inside a verified minor install without a warning (`4.5.5` would). They are trusted rather than verified: semver reserves patches for bug fixes, every `4.5.x` published so far passes the suites unchanged, and a scheduled job in the repository re-runs the suites against every release the range admits. If a patch ever breaks the engine, a `zod-cow-v4` release narrows the range to exclude it. Pin `zod` yourself if you want exactly the verified version.
- A new zod minor is admitted only by a `zod-cow-v4` release: the predicates copied from zod are re-synced, the suites and the packed-tarball smoke run against every release of that minor, and the range is widened. Until then, installing that minor produces an unmet-peer warning, or an install failure where peers are strict (npm `--strict-peer-deps`, pnpm `strict-peer-dependencies`).
- A caret range (`^4.5.4`) is deliberately not used; it would hide exactly the drift the range exists to surface.

The full decision, including how a broken patch is excluded and later re-admitted, is [ADR 0001](https://github.com/iceboundrock/zod-cow/blob/main/docs/adr/0001-package-layout.md) in the repository.

## Further reading

- [Repository README](https://github.com/iceboundrock/zod-cow/blob/main/README.md): what the layer is, the [CoW invariant](https://github.com/iceboundrock/zod-cow/blob/main/README.md#the-cow-invariant), the [benchmarks](https://github.com/iceboundrock/zod-cow/blob/main/README.md#benchmarks), the [correctness evidence](https://github.com/iceboundrock/zod-cow/blob/main/README.md#correctness-evidence) and the [known limitations](https://github.com/iceboundrock/zod-cow/blob/main/README.md#known-limitations-prototype-scope).
- [docs/ARCHITECTURE-z4.md](https://github.com/iceboundrock/zod-cow/blob/main/docs/ARCHITECTURE-z4.md): how the CoW skeletons decorate zod's official compiler output, the purity analysis, the async channel and the degradation chain.
- [CHANGELOG.md](https://github.com/iceboundrock/zod-cow/blob/main/CHANGELOG.md): the whole workspace's history; `zod-cow-v4` carries the project version.

## License

[MIT](https://github.com/iceboundrock/zod-cow/blob/main/LICENSE)
