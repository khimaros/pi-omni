// Packaging regression tests for the standalone `pi-omni` bin.
//
// The deploy flow (persona VM, see ../persona/server/incant-user.sh) installs
// pi-coding-agent at the global top level first, then `npm -g install`s the
// pi-omni tarball. Because those are independent global installs, npm gives
// pi-omni its own nested copy of any pi-coding-agent it *depends on* -- and
// since pi-omni ships bundleDependencies (for the file: WASM apm), npm's reify
// drops part of that nested copy's transitive deps (chalk among them), crashing
// the bin with `Cannot find package 'chalk'`. Declaring pi-coding-agent as an
// OPTIONAL peer instead means npm never nests it, so the bin resolves the fully
// installed top-level copy. These tests lock in that shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIN_ENTRY = resolve(ROOT, "dist/server/index.js");
const PI_AGENT = "@earendil-works/pi-coding-agent";

const IMPORT_RE = /\b(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g;
const BARE_IMPORT_RE = /\bimport\s*['"]([^'"]+)['"]/g;

function specifiersOf(file) {
  const src = readFileSync(file, "utf8");
  const out = [];
  for (const re of [IMPORT_RE, BARE_IMPORT_RE]) {
    for (const m of src.matchAll(re)) out.push(m[1]);
  }
  return out;
}

// scoped packages keep the first two path segments (@scope/name), others the first.
function packageName(spec) {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

// walk relative imports from the bin entry, collecting every external (bare,
// non-builtin) package the standalone runtime reaches.
function externalClosure(entry) {
  const seen = new Set();
  const externals = new Set();
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of specifiersOf(file)) {
      if (spec.startsWith("node:")) continue;
      if (spec.startsWith(".")) stack.push(resolve(dirname(file), spec));
      else externals.add(packageName(spec));
    }
  }
  return externals;
}

const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));

test("every external the standalone bin imports is declared somewhere installable", () => {
  const declared = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...(pkg.bundleDependencies ?? []),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ]);
  const missing = [...externalClosure(BIN_ENTRY)].filter((p) => !declared.has(p));
  assert.deepEqual(missing, [], `bin imports undeclared packages: ${missing.join(", ")}`);
});

test("pi-coding-agent is an optional peer, never a regular dependency", () => {
  // a regular dependency forces npm to nest a second copy under pi-omni on the
  // global-install deploy path, which the bundleDependencies reify bug then
  // leaves incomplete (missing chalk). optional-peer avoids the nested copy.
  assert.ok(!(PI_AGENT in (pkg.dependencies ?? {})), `${PI_AGENT} must not be a dependency`);
  assert.ok(PI_AGENT in (pkg.peerDependencies ?? {}), `${PI_AGENT} must be a peerDependency`);
  assert.equal(
    pkg.peerDependenciesMeta?.[PI_AGENT]?.optional,
    true,
    `${PI_AGENT} peer must be marked optional`,
  );
});
