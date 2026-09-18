// The v0.2.0 freeze: every manifest has to agree on one product name and one
// version. Four files carry a copy of it (package.json, the plugin manifest,
// the marketplace entry twice, plus the lockfile), and a release that ships
// three of them updated is worse than one that fails here.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(repoRoot, rel), "utf8"));

const pkg = readJson("package.json");
const plugin = readJson(".zcode-plugin/plugin.json");
const marketplace = readJson("marketplace.json");
const lock = readJson("package-lock.json");

const PRODUCT_NAME = "zcode-tarkov";
const PRODUCT_VERSION = "0.2.3";

test("package.json carries the frozen product identity", () => {
  assert.equal(pkg.name, PRODUCT_NAME);
  assert.equal(pkg.version, PRODUCT_VERSION);
});

test("the plugin manifest agrees with package.json", () => {
  assert.equal(plugin.name, pkg.name);
  assert.equal(plugin.version, pkg.version);
});

test("the marketplace entry agrees with package.json", () => {
  assert.equal(marketplace.name, pkg.name);
  assert.equal(marketplace.version, pkg.version);
  const entry = marketplace.plugins.find((p) => p.name === pkg.name);
  assert.ok(entry, "marketplace.json must list the plugin it ships");
  assert.equal(entry.version, pkg.version);
  assert.equal(entry.license, pkg.license);
});

// A stale lockfile name is how the upstream name survived a rename once already.
test("the lockfile agrees with package.json", () => {
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[""].name, pkg.name);
  assert.equal(lock.packages[""].version, pkg.version);
});

test("every path the manifests point at exists", () => {
  const targets = [
    pkg.bin[PRODUCT_NAME],
    plugin.mcpServers[PRODUCT_NAME].args.find((a) => a.endsWith(".js")).replace("${CLAUDE_PLUGIN_ROOT}/", ""),
    plugin.commands,
    plugin.skills,
  ];
  for (const rel of targets) {
    assert.ok(fs.existsSync(path.join(repoRoot, rel)), `${rel} is referenced by a manifest but missing`);
  }
});

// The bundles are committed so users never build. That only works if they were
// rebuilt after the last source change, so pin the version the bundler bakes in.
test("the committed MCP bundle was built from this version", () => {
  const bundle = fs.readFileSync(path.join(repoRoot, "dist/mcp/server.js"), "utf8");
  assert.match(bundle, new RegExp(`version: "${PRODUCT_VERSION.replace(/\./g, "\\.")}"`));
});

test("attribution stays in the shipped file set", () => {
  for (const rel of ["LICENSE", "THIRD_PARTY_NOTICES.md", "licenses/zcode-beautify.LICENSE", "licenses/dsh-theme-tarkov.LICENSE"]) {
    assert.ok(fs.existsSync(path.join(repoRoot, rel)), `${rel} is missing`);
    assert.ok(pkg.files.some((f) => rel === f || rel.startsWith(`${f}/`)), `${rel} is not in package.json#files`);
  }
});
