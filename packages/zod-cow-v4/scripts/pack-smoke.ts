/**
 * Packed-tarball smoke for zod-cow-v4. Run from the package directory after a build:
 *   pnpm run smoke:pack        (builds first, then runs this script)
 *
 * What it proves, in order (every step prints one line, the first failure aborts with exit 1):
 *   1. `npm pack` listing: dist/, package.json, README.md and LICENSE ship; nothing from src/, tests/,
 *      scripts/ or the probes does.
 *   2. The shipped package.json declares engines.node ">=22.13.0" (the exact floor the CI lane pins)
 *      and an exports map with exactly "." and "./package.json".
 *   3. A temporary consumer project installs the tarball together with the zod the package was
 *      verified against (packed from this workspace's own node_modules, so no registry is needed),
 *      with npm's strict peer check on.
 *   4. `import("zod-cow-v4")` parses a schema with CoW semantics and resolves "zod-cow-v4/package.json";
 *      a deep import is refused by the exports map.
 *   5. `require("zod-cow-v4")` does the same (require(esm) on the Node floor).
 *   6. A TypeScript consumer typechecks against the tarball's declarations (module NodeNext), from
 *      an ESM file and from a CommonJS file.
 * The temporary project is removed afterwards, also on failure.
 */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
const EXPECTED_ENGINE = ">=22.13.0";

function ok(msg: string): void {
  console.log(`  ok  ${msg}`);
}
function fail(msg: string): never {
  console.error(`  FAIL ${msg}`);
  process.exit(1);
}
function run(cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): string {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
}
function npm(args: string[], cwd: string): string {
  // npm is invoked through the shell wrapper on every platform pnpm supports; --no-* keeps it quiet and offline.
  return run(process.platform === "win32" ? "npm.cmd" : "npm", args, cwd, { NO_COLOR: "1" });
}

console.log(
  `zod-cow-v4 packed-tarball smoke (node ${process.version}, package ${manifest.version})`,
);
if (!existsSync(join(pkgDir, "dist", "index.js")))
  fail("dist/index.js is missing; run the build first");

const tmp = mkdtempSync(join(tmpdir(), "zod-cow-v4-smoke-"));
try {
  /* 1. pack and check the listing both ways */
  const packJson = JSON.parse(npm(["pack", "--json", "--pack-destination", tmp], pkgDir));
  const packed = packJson[0] as { filename: string; files: { path: string }[] };
  const listing = packed.files.map((f) => f.path);
  const cowTgz = join(tmp, packed.filename);
  for (const must of ["package.json", "README.md", "LICENSE", "dist/index.js", "dist/index.d.ts"]) {
    if (!listing.includes(must)) fail(`tarball listing lacks ${must}`);
  }
  const leaked = listing.filter(
    (p) =>
      p.startsWith("src/") ||
      p.startsWith("tests/") ||
      p.startsWith("scripts/") ||
      p.includes("probe") ||
      (p.endsWith(".ts") && !p.endsWith(".d.ts")),
  );
  if (leaked.length > 0) fail(`tarball ships files it must not: ${leaked.join(", ")}`);
  ok(
    `listing: ${listing.length} files, build output + package.json + README.md + LICENSE, no sources/tests/probes`,
  );

  /* 2. the shipped manifest */
  const shipped = JSON.parse(run("tar", ["-xOzf", cowTgz, "package/package.json"], tmp));
  if (shipped.name !== "zod-cow-v4") fail(`shipped name is ${shipped.name}`);
  if (shipped.engines?.node !== EXPECTED_ENGINE) {
    fail(
      `shipped engines.node is ${JSON.stringify(shipped.engines?.node)}, expected "${EXPECTED_ENGINE}"`,
    );
  }
  const exportKeys = Object.keys(shipped.exports ?? {}).sort();
  if (exportKeys.join(",") !== ".,./package.json") fail(`exports keys are ${exportKeys.join(",")}`);
  if (!shipped.peerDependencies?.zod) fail("shipped manifest declares no zod peer");
  ok(
    `manifest: engines.node "${EXPECTED_ENGINE}", exports [".", "./package.json"], zod peer ${shipped.peerDependencies.zod}`,
  );

  /* 3. a temporary consumer project, installed offline from two tarballs */
  const zodDir = dirname(realpathSync(require.resolve("zod/package.json")));
  const zodVersion = JSON.parse(readFileSync(join(zodDir, "package.json"), "utf8"))
    .version as string;
  // npm pack refuses a path inside node_modules ("Exit handler never called"), so pack a copy.
  const zodCopy = join(tmp, "zod-src");
  cpSync(zodDir, zodCopy, { recursive: true, dereference: true });
  const zodPack = JSON.parse(
    npm(["pack", "--json", "--ignore-scripts", "--pack-destination", tmp], zodCopy),
  );
  const zodTgz = join(tmp, zodPack[0].filename);
  const consumer = join(tmp, "consumer");
  mkdirSync(consumer);
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ name: "zod-cow-v4-smoke", private: true, type: "commonjs" }, null, 2),
  );
  npm(
    [
      "install",
      "--no-audit",
      "--no-fund",
      "--ignore-scripts",
      "--no-package-lock",
      "--strict-peer-deps",
      zodTgz,
      cowTgz,
    ],
    consumer,
  );
  const installed = JSON.parse(
    readFileSync(join(consumer, "node_modules", "zod-cow-v4", "package.json"), "utf8"),
  );
  ok(
    `consumer install: zod-cow-v4@${installed.version} + zod@${zodVersion} from tarballs, strict peer check passed`,
  );

  /* 4 + 5. runtime through both entry styles */
  const body = `
  const User = z.object({
    id: z.number().int(),
    name: z.string(),
    role: z.enum(["admin", "member", "viewer"]).default("viewer"),
    address: z.object({ city: z.string() }),
  });
  const fast = compile(User);
  assert.equal(fast.stock, false, "compile must not degrade to stock");
  assert.equal(typeof fast.code, "string", "code must be the skeleton source");
  const clean = { id: 1, name: "Ana", role: "admin", address: { city: "NYC" } };
  assert.equal(fast.parse(clean), clean, "clean input must come back as the same reference");
  assert.equal(fast.validate(clean), clean, "validate must return the input reference");
  assert.equal(fast.validate({ id: "x" }), null, "validate must return null on failure");
  const dirty = { id: 2, name: "Bob", address: { city: "SFO" } };
  const out = fast.parse(dirty);
  assert.notEqual(out, dirty, "a default must force a copy at the top level");
  assert.equal(out.role, "viewer", "the default must be injected");
  assert.equal(out.address, dirty.address, "the clean subtree must be shared");
  assert.equal("role" in dirty, false, "the input must not be mutated");
  const r = fast.safeParse({ id: "x" });
  assert.equal(r.success, false);
  assert.ok(r.error instanceof z.ZodError, "the failure path must yield the consumer's ZodError");
  assert.equal(pkg.name, "zod-cow-v4", "./package.json export must resolve");
  `;
  writeFileSync(
    join(consumer, "esm.mjs"),
    `import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { z } from "zod";
import { compile } from "zod-cow-v4";
const pkgUrl = import.meta.resolve("zod-cow-v4/package.json");
const pkg = createRequire(import.meta.url)(new URL(pkgUrl).pathname);
${body}
await assert.rejects(() => import("zod-cow-v4/dist/index.js"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
console.log("esm ok");
`,
  );
  writeFileSync(
    join(consumer, "cjs.cjs"),
    `const assert = require("node:assert/strict");
const { z } = require("zod");
const { compile } = require("zod-cow-v4");
const pkg = require("zod-cow-v4/package.json");
${body}
assert.throws(() => require("zod-cow-v4/dist/index.js"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
console.log("cjs ok");
`,
  );
  const esmOut = run(process.execPath, ["esm.mjs"], consumer).trim();
  if (esmOut !== "esm ok") fail(`esm run printed ${esmOut}`);
  ok(
    'import("zod-cow-v4"): CoW parse, validate, ZodError, ./package.json export, deep import refused',
  );
  const cjsOut = run(process.execPath, ["cjs.cjs"], consumer).trim();
  if (cjsOut !== "cjs ok") fail(`cjs run printed ${cjsOut}`);
  ok('require("zod-cow-v4"): same checks through require(esm)');

  /* 6. consumer typecheck against the declarations */
  const typeBody = `
const User = z.object({ id: z.number().int(), name: z.string().optional() });
const fast: Compiled<typeof User> = compile(User);
const out = fast.parse({ id: 1 });
const id: number = out.id;
const name: string | undefined = out.name;
// @ts-expect-error out.id is a number; this line fails to compile if the declarations resolved to any
const wrong: string = out.id;
const validated: unknown = fast.validate({ id: 1 });
const code: string | null = fast.code;
const safe = fast.safeParse({ id: 1 });
if (!safe.success) {
  const issues: number = safe.error.issues.length;
  void issues;
}
void [id, name, wrong, validated, code];
`;
  writeFileSync(
    join(consumer, "types.mts"),
    `import { z } from "zod";\nimport { compile, type Compiled } from "zod-cow-v4";\n${typeBody}`,
  );
  writeFileSync(
    join(consumer, "types.cts"),
    `import { z } from "zod";\nimport { compile, type Compiled } from "zod-cow-v4";\n${typeBody}`,
  );
  writeFileSync(
    join(consumer, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          target: "ES2022",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          types: [],
        },
        files: ["types.mts", "types.cts"],
      },
      null,
      2,
    ),
  );
  const tsc = require.resolve("typescript/bin/tsc");
  const tsVersion = require("typescript/package.json").version as string;
  try {
    run(process.execPath, [tsc, "-p", join(consumer, "tsconfig.json")], consumer);
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    fail(`consumer typecheck failed:\n${err.stdout ?? ""}${err.stderr ?? ""}`);
  }
  ok(
    `consumer typecheck (typescript ${tsVersion}, module NodeNext, .mts and .cts): declarations resolve`,
  );

  console.log("packed-tarball smoke passed");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
