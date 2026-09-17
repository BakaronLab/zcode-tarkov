// The settings layer: where appearance now lives, how the v0.1 flat file is
// migrated into it, and how the two files relate afterwards.
//
// v0.2 moved settings out of ZCode's plugin data directory (which an app update
// may replace) into a data root this project owns. These tests drive the real
// load/save path against throwaway directories, so neither the real user config
// nor the real plugin data directory is touched.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zct-settings-"));
const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), "zct-plugin-"));
// Both overrides have to be in place before the modules are imported: the store
// registers the legacy path once per process, on the first load.
process.env.ZCODE_TARKOV_DATA_DIR = dataRoot;
process.env.ZCODE_BEAUTIFY_DATA_DIR = pluginDir;

const { loadConfig, saveConfig, dataDir, legacyConfigFile, settingsFile, initSettings } = await import(
  "../.test-build/core/launch.js"
);
const { resetPrefsCache } = await import("../.test-build/prefs/store.js");
const { defaultPrefs } = await import("../.test-build/prefs/defaults.js");
const { loadPrefs } = await import("../.test-build/prefs/prefs.js");

function readPrefs() {
  return JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
}

function writePrefs(prefs) {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(prefs, null, 2));
  resetPrefsCache();
}

test("the plugin data directory still honours its own override", () => {
  assert.equal(dataDir(), pluginDir);
  assert.equal(legacyConfigFile(), path.join(pluginDir, "config.json"));
});

test("settings live in the user data root, not the plugin directory", () => {
  assert.equal(settingsFile(), path.join(dataRoot, "prefs.json"));
  assert.equal(settingsFile().startsWith(pluginDir), false);
});

test("with no stored settings the config is the defaults", () => {
  resetPrefsCache();
  const config = loadConfig();
  const d = defaultPrefs().appearance;
  assert.equal(config.blur, d.blur);
  assert.equal(config.dim, d.dim);
  assert.equal(config.colorMode, d.colorMode);
  assert.equal(config.wallpaperVisible, d.wallpaperVisible);
  assert.equal(config.fit, d.fit);
  assert.equal(config.banner.mode, "full");
  assert.equal(config.banner.enabled, true);
});

test("saving writes into prefs.json and leaves every other section alone", () => {
  const original = defaultPrefs();
  original.pet.scale = 123;
  original.audio.bgm.volume = 0.11;
  writePrefs(original);

  saveConfig({ blur: 9, dim: 40, colorMode: "monet", fit: "contain", wallpaperVisible: true });

  const stored = readPrefs();
  assert.equal(stored.appearance.blur, 9);
  assert.equal(stored.appearance.dim, 40);
  assert.equal(stored.appearance.colorMode, "monet");
  assert.equal(stored.appearance.fit, "contain");
  assert.equal(stored.appearance.wallpaperVisible, true);
  // A settings write must never clobber media preferences.
  assert.equal(stored.pet.scale, 123);
  assert.equal(stored.audio.bgm.volume, 0.11);
});

test("a partial save keeps the fields the caller did not mention", () => {
  writePrefs(defaultPrefs());
  saveConfig({ blur: 5 });
  let stored = readPrefs();
  assert.equal(stored.appearance.blur, 5);
  assert.equal(stored.appearance.dim, defaultPrefs().appearance.dim);

  saveConfig({ dim: 60 });
  stored = readPrefs();
  assert.equal(stored.appearance.blur, 5, "the earlier blur survives a later dim write");
  assert.equal(stored.appearance.dim, 60);
});

test("colorMode and the legacy monet boolean never disagree", () => {
  writePrefs(defaultPrefs());
  saveConfig({ colorMode: "monet" });
  assert.equal(readPrefs().appearance.colorMode, "monet");
  // Reading it back through the v0.1-shaped view keeps the boolean in step, so a
  // consumer that only understands `monet` still resolves the same appearance.
  assert.equal(loadConfig().monet, true);

  saveConfig({ colorMode: "tarkov" });
  assert.equal(loadConfig().monet, false);
  assert.equal(loadConfig().colorMode, "tarkov");
});

test("banner mode survives a round trip and drives the v0.1 enabled view", () => {
  writePrefs(defaultPrefs());
  saveConfig({ banner: { mode: "compact" } });
  assert.equal(readPrefs().appearance.banner.mode, "compact");
  // `enabled` is the derived view the rest of the tree still reads.
  assert.equal(loadConfig().banner.enabled, true);

  saveConfig({ banner: { mode: "off" } });
  assert.equal(readPrefs().appearance.banner.mode, "off");
  assert.equal(loadConfig().banner.enabled, false, "off must read as disabled");
});

test("a write without a banner leaves the stored mode alone", () => {
  writePrefs(defaultPrefs());
  saveConfig({ banner: { mode: "off" } });
  saveConfig({ blur: 12 });
  assert.equal(readPrefs().appearance.banner.mode, "off");
});

test("an out-of-range value is clamped on the way to disk", () => {
  writePrefs(defaultPrefs());
  saveConfig({ blur: 9999, dim: -20 });
  const stored = readPrefs();
  assert.equal(stored.appearance.blur, 100);
  assert.equal(stored.appearance.dim, 0);
});

test("clearing the wallpaper is an explicit operation, not an omission", () => {
  writePrefs(defaultPrefs());
  saveConfig({ wallpaperPath: "C:\\wall\\a.png" });
  assert.equal(readPrefs().appearance.wallpaperPath, "C:\\wall\\a.png");
  saveConfig({ wallpaperPath: undefined });
  assert.equal("wallpaperPath" in readPrefs().appearance, false);
});

test("a v0.1 flat config migrates on first load and is left on disk", () => {
  const freshRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zct-mig-root-"));
  const freshPlugin = fs.mkdtempSync(path.join(os.tmpdir(), "zct-mig-plugin-"));
  const legacy = path.join(freshPlugin, "config.json");
  fs.writeFileSync(
    legacy,
    JSON.stringify({ blur: 14, dim: 55, monet: true, wallpaperVisible: true, banner: { enabled: false } })
  );

  const previousRoot = process.env.ZCODE_TARKOV_DATA_DIR;
  process.env.ZCODE_TARKOV_DATA_DIR = freshRoot;
  try {
    // No prefs.json exists in the fresh root, so the legacy file is the source.
    const result = loadPrefs(legacy);
    assert.equal(result.migratedFrom, legacy);
    assert.equal(result.prefs.appearance.blur, 14);
    assert.equal(result.prefs.appearance.dim, 55);
    assert.equal(result.prefs.appearance.colorMode, "monet");
    assert.equal(result.prefs.appearance.wallpaperVisible, true);
    assert.equal(result.prefs.appearance.banner.mode, "off");
    // Sections the v0.1 file never had come from the defaults.
    assert.equal(result.prefs.pet.enabled, defaultPrefs().pet.enabled);
    assert.equal(result.prefs.audio.enabled, defaultPrefs().audio.enabled);
    // The v0.1 file is preserved so a rollback to a v0.1 build still works.
    assert.equal(fs.existsSync(legacy), true);
  } finally {
    process.env.ZCODE_TARKOV_DATA_DIR = previousRoot;
  }
});

test("a v0.2 file outranks a leftover v0.1 config", () => {
  const freshRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zct-mig2-root-"));
  const freshPlugin = fs.mkdtempSync(path.join(os.tmpdir(), "zct-mig2-plugin-"));
  const legacy = path.join(freshPlugin, "config.json");
  fs.writeFileSync(legacy, JSON.stringify({ blur: 99 }));
  fs.writeFileSync(
    path.join(freshRoot, "prefs.json"),
    JSON.stringify({ ...defaultPrefs(), appearance: { ...defaultPrefs().appearance, blur: 2 } })
  );

  const previousRoot = process.env.ZCODE_TARKOV_DATA_DIR;
  process.env.ZCODE_TARKOV_DATA_DIR = freshRoot;
  try {
    const result = loadPrefs(legacy);
    assert.equal(result.migratedFrom, undefined);
    assert.equal(result.prefs.appearance.blur, 2);
  } finally {
    process.env.ZCODE_TARKOV_DATA_DIR = previousRoot;
  }
});

test("saving creates the file with a trailing newline and no BOM", () => {
  writePrefs(defaultPrefs());
  saveConfig({ blur: 1 });
  const bytes = fs.readFileSync(settingsFile());
  assert.equal(bytes[0] === 0xef && bytes[1] === 0xbb, false, "no UTF-8 BOM");
  assert.equal(bytes.toString("utf8").endsWith("\n"), true);
});

test("initSettings is safe to call repeatedly", () => {
  initSettings();
  initSettings();
  assert.equal(fs.existsSync(settingsFile()), true);
});
