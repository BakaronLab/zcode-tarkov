// File-level config behavior: legacy on-disk configs must migrate on load and
// be rewritten in a form both old and new builds can read.
//
// These tests drive loadConfig()/saveConfig() against a throwaway data dir, so
// the real user config is never touched.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zct-config-"));
process.env.ZCODE_BEAUTIFY_DATA_DIR = dir;

const { loadConfig, saveConfig, configFile, dataDir } = await import("../.test-build/core/launch.js");
const { migrateColorMode } = await import("../.test-build/core/colorMode.js");

/** Writes the raw config bytes exactly as given (so a BOM can be tested). */
function writeRaw(text) {
  fs.writeFileSync(configFile(), text);
}

function readRaw() {
  return fs.readFileSync(configFile(), "utf8");
}

test("the data dir honors the override", () => {
  assert.equal(dataDir(), dir);
  assert.equal(configFile(), path.join(dir, "config.json"));
});

test("a legacy monet:true config loads as monet", () => {
  writeRaw(JSON.stringify({ monet: true, blur: 4, dim: 25, fit: "cover", port: 9222 }));
  const c = loadConfig();
  assert.equal(c.colorMode, "monet");
  assert.equal(c.blur, 4, "unrelated fields must survive");
});

test("a legacy monet:false config loads as native", () => {
  writeRaw(JSON.stringify({ monet: false, blur: 6 }));
  const c = loadConfig();
  assert.equal(c.colorMode, "native");
  assert.equal(c.blur, 6);
});

test("a config with no mode fields loads as the default", () => {
  writeRaw(JSON.stringify({ port: 9222 }));
  assert.equal(loadConfig().colorMode, "monet");
});

test("a malformed colorMode falls back rather than throwing", () => {
  writeRaw(JSON.stringify({ colorMode: "nonsense", monet: false }));
  assert.equal(loadConfig().colorMode, "native", "should fall back to the legacy flag");
});

test("an unreadable or corrupt config yields empty defaults instead of throwing", () => {
  writeRaw("{ this is not json");
  assert.deepEqual(loadConfig(), {});
  writeRaw("");
  assert.deepEqual(loadConfig(), {});
});

test("a UTF-8 BOM does not hide the config", () => {
  // Notepad writes a BOM by default when saving as UTF-8, and JSON.parse
  // rejects it — a hand-edited config would otherwise be silently ignored.
  writeRaw("\uFEFF" + JSON.stringify({ monet: false, blur: 9 }));
  const c = loadConfig();
  assert.equal(c.colorMode, "native");
  assert.equal(c.blur, 9);
});

test("saving writes both fields and they never disagree", () => {
  saveConfig({ colorMode: "tarkov", monet: true, blur: 1 });
  const onDisk = JSON.parse(readRaw());
  assert.equal(onDisk.colorMode, "tarkov");
  assert.equal(onDisk.monet, false, "monet must be re-derived, not taken from input");
});

test("a round trip through save and load is stable", () => {
  saveConfig({ colorMode: "native", blur: 12, dim: 30, wallpaperVisible: false, fit: "contain" });
  const once = loadConfig();
  saveConfig(once);
  const twice = loadConfig();
  assert.deepEqual(twice, once);
});

test("saveConfig writes without a BOM so older JSON.parse callers still work", () => {
  saveConfig({ colorMode: "monet" });
  assert.equal(readRaw().charCodeAt(0) === 0xfeff, false);
  assert.equal(readRaw().trimStart().startsWith("{"), true);
});

test("every stored config after migration reports a usable mode", () => {
  for (const legacy of [{ monet: true }, { monet: false }, {}, { colorMode: "tarkov" }, { colorMode: null }]) {
    saveConfig(legacy);
    const mode = migrateColorMode(JSON.parse(readRaw()));
    assert.ok(["monet", "tarkov", "native"].includes(mode), `unexpected mode ${mode}`);
  }
});

test.after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.ZCODE_BEAUTIFY_DATA_DIR;
});
