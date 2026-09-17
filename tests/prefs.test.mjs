// Preferences: defaults, clamping, malformed input, and v0.1 migration.
//
// Every test here points ZCODE_TARKOV_DATA_DIR at a throwaway directory, so no
// test can read or write a real user's settings.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "zct-prefs-"));
process.env.ZCODE_TARKOV_DATA_DIR = root;

const { defaultPrefs } = await import("../.test-build/prefs/defaults.js");
const { validatePrefs, migrateV01Appearance, loadPrefs, savePrefs, serializePrefs, clampNumber } =
  await import("../.test-build/prefs/prefs.js");
const { dataRoot, prefsFile, mediaDir, ensureDataRoot } = await import("../.test-build/core/dataRoot.js");
const { MEDIA_KINDS, PREFS_VERSION } = await import("../.test-build/prefs/types.js");

function writeRaw(text) {
  fs.mkdirSync(path.dirname(prefsFile()), { recursive: true });
  fs.writeFileSync(prefsFile(), text);
}

test("the data root is the override, and prefs.json lives directly in it", () => {
  assert.equal(dataRoot(), root);
  assert.equal(prefsFile(), path.join(root, "prefs.json"));
  assert.equal(mediaDir("music"), path.join(root, "music"));
});

test("defaults cover every media directory and every sfx event", () => {
  assert.deepEqual([...MEDIA_KINDS], ["music", "sounds", "voice", "pet", "status"]);
  const d = defaultPrefs();
  assert.equal(d.version, PREFS_VERSION);
  assert.deepEqual(Object.keys(d.audio.sfx.events).sort(), ["approval", "done", "error", "start", "tool"]);
  assert.equal(d.pet.enabled, true);
  // The status takeover is the one subsystem that ships off: ZCode exposes no
  // stable anchor for the status line, so it is opt-in (see defaults.ts).
  assert.equal(d.status.enabled, false);
  // Nothing is loud by default, and nothing is bundled.
  assert.ok(d.audio.masterVolume <= 0.8);
  assert.ok(d.audio.bgm.volume <= 0.5);
  assert.equal(d.appearance.banner.mode, "full");
});

test("a missing file loads as defaults", () => {
  fs.rmSync(prefsFile(), { force: true });
  const { prefs, recovered } = loadPrefs();
  assert.deepEqual(prefs, defaultPrefs());
  assert.equal(recovered, undefined);
});

test("malformed JSON is quarantined and defaults are restored", () => {
  writeRaw("{ this is not json");
  const { prefs, recovered } = loadPrefs();
  assert.deepEqual(prefs, defaultPrefs());
  assert.ok(recovered, "the failure must be reported");
  assert.match(recovered.reason, /could not be parsed/);
  assert.ok(recovered.backup, "the bad file must be preserved");
  assert.equal(fs.readFileSync(recovered.backup, "utf8"), "{ this is not json");
});

test("a UTF-8 BOM does not make the file unreadable", () => {
  writeRaw("\uFEFF" + JSON.stringify({ ...defaultPrefs(), pet: { enabled: false } }));
  const { prefs } = loadPrefs();
  assert.equal(prefs.pet.enabled, false);
});

test("wrong types fall back per field instead of discarding the file", () => {
  writeRaw(
    JSON.stringify({
      version: 2,
      appearance: { blur: "not a number", dim: 30, colorMode: "nonsense" },
      audio: { masterVolume: "loud", sfx: { events: { done: "yes" } } },
      pet: { scale: {}, opacity: 2 },
      status: { language: "fr" },
    })
  );
  const { prefs } = loadPrefs();
  const d = defaultPrefs();
  assert.equal(prefs.appearance.blur, d.appearance.blur, "a non-numeric blur falls back");
  assert.equal(prefs.appearance.dim, 30, "a valid neighbour still loads");
  assert.equal(prefs.appearance.colorMode, d.appearance.colorMode);
  assert.equal(prefs.audio.masterVolume, d.audio.masterVolume);
  assert.equal(prefs.audio.sfx.events.done, true, "a non-boolean switch keeps its default");
  assert.equal(prefs.pet.scale, d.pet.scale);
  assert.equal(prefs.pet.opacity, 1, "out-of-range values are clamped, not rejected");
  assert.equal(prefs.status.language, d.status.language);
});

test("numeric ranges are clamped rather than rejected", () => {
  const p = validatePrefs({
    appearance: { blur: 1e9, dim: -50, banner: { opacity: 4, height: 100000 } },
    audio: { masterVolume: 12, bgm: { volume: -3 }, voice: { chance: 9 } },
    pet: { scale: 99999, opacity: -1 },
  });
  assert.equal(p.appearance.blur, 100);
  assert.equal(p.appearance.dim, 0);
  assert.equal(p.appearance.banner.opacity, 1);
  assert.equal(p.appearance.banner.height, 160);
  assert.equal(p.audio.masterVolume, 1);
  assert.equal(p.audio.bgm.volume, 0);
  assert.equal(p.audio.voice.chance, 1);
  assert.equal(p.pet.scale, 320);
  assert.equal(p.pet.opacity, 0.1);
});

test("clampNumber maps anything non-finite to the fallback", () => {
  assert.equal(clampNumber(Number.NaN, 0, 1, 0.5), 0.5);
  assert.equal(clampNumber(undefined, 0, 1, 0.5), 0.5);
  assert.equal(clampNumber(Infinity, 0, 1, 0.5), 0.5);
  assert.equal(clampNumber("0.25", 0, 1, 0.5), 0.25);
});

test("unknown keys are dropped: the schema is closed", () => {
  writeRaw(JSON.stringify({ ...defaultPrefs(), legacyLeftover: { a: 1 }, appearance: { madeUp: true } }));
  const { prefs } = loadPrefs();
  assert.equal("legacyLeftover" in prefs, false);
  assert.equal("madeUp" in prefs.appearance, false);
});

test("the disabled-track list is filtered to safe basenames", () => {
  const p = validatePrefs({ audio: { bgm: { disabledTracks: ["ok.mp3", "../../etc/passwd", "a/b.mp3", "ok.mp3", 7] } } });
  assert.deepEqual(p.audio.bgm.disabledTracks, ["ok.mp3"]);
});

test("banner text is length-bounded and stripped of control characters", () => {
  const long = "x".repeat(500);
  const p = validatePrefs({ appearance: { banner: { text1: long, text2: "a\u0000b\nc" } } });
  assert.equal(p.appearance.banner.text1.length, 240);
  assert.equal(p.appearance.banner.text2, "abc");
});

test("an empty string is not accepted as banner copy", () => {
  const p = validatePrefs({ appearance: { banner: { text1: "   " } } });
  assert.equal(p.appearance.banner.text1, defaultPrefs().appearance.banner.text1);
});

// --- v0.1 migration ----------------------------------------------------------

test("v0.1 appeared as a flat config and migrates field by field", () => {
  const migrated = migrateV01Appearance({
    blur: 7,
    dim: 44,
    colorMode: "monet",
    wallpaperVisible: true,
    fit: "contain",
    wallpaperPath: "C:\\wall\\a.png",
    banner: { enabled: true, text1: "ONE", text2: "TWO", height: 40, opacity: 0.5 },
  });
  assert.equal(migrated.blur, 7);
  assert.equal(migrated.dim, 44);
  assert.equal(migrated.colorMode, "monet");
  assert.equal(migrated.wallpaperVisible, true);
  assert.equal(migrated.fit, "contain");
  assert.equal(migrated.wallpaperPath, "C:\\wall\\a.png");
  assert.equal(migrated.banner.mode, "full");
  assert.equal(migrated.banner.text1, "ONE");
});

test("v0.1 banner.enabled:false becomes mode off", () => {
  const migrated = migrateV01Appearance({ banner: { enabled: false } });
  assert.equal(migrated.banner.mode, "off");
});

test("a pre-colorMode config resolves through the legacy monet boolean", () => {
  assert.equal(migrateV01Appearance({ monet: true }).colorMode, "monet");
  assert.equal(migrateV01Appearance({ monet: false }).colorMode, "native");
  // colorMode wins when both are present, exactly as the v0.1 resolver did.
  assert.equal(migrateV01Appearance({ monet: true, colorMode: "tarkov" }).colorMode, "tarkov");
});

test("migration from a real v0.1 file happens on first load and leaves a backup copy of nothing", () => {
  const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), "zct-legacy-"));
  const legacy = path.join(legacyDir, "config.json");
  fs.writeFileSync(legacy, JSON.stringify({ blur: 11, dim: 33, monet: true, banner: { enabled: false } }));
  fs.rmSync(prefsFile(), { force: true });

  const result = loadPrefs(legacy);
  assert.equal(result.migratedFrom, legacy);
  assert.equal(result.prefs.appearance.blur, 11);
  assert.equal(result.prefs.appearance.dim, 33);
  assert.equal(result.prefs.appearance.colorMode, "monet");
  assert.equal(result.prefs.appearance.banner.mode, "off");
  // The legacy file is preserved: rollback to a v0.1 build must still work.
  assert.equal(fs.existsSync(legacy), true);
});

test("a v0.2 file wins over the legacy one", () => {
  writeRaw(JSON.stringify({ ...defaultPrefs(), appearance: { ...defaultPrefs().appearance, blur: 5 } }));
  const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), "zct-legacy2-"));
  const legacy = path.join(legacyDir, "config.json");
  fs.writeFileSync(legacy, JSON.stringify({ blur: 99 }));
  const result = loadPrefs(legacy);
  assert.equal(result.migratedFrom, undefined);
  assert.equal(result.prefs.appearance.blur, 5);
});

// --- writing -----------------------------------------------------------------

test("savePrefs creates the data root and every media directory", () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "zct-save-"));
  const previous = process.env.ZCODE_TARKOV_DATA_DIR;
  process.env.ZCODE_TARKOV_DATA_DIR = fresh;
  try {
    savePrefs(defaultPrefs());
    assert.equal(fs.existsSync(path.join(fresh, "prefs.json")), true);
    for (const kind of MEDIA_KINDS) {
      assert.equal(fs.existsSync(path.join(fresh, kind)), true, `${kind}/ must exist`);
    }
  } finally {
    process.env.ZCODE_TARKOV_DATA_DIR = previous;
  }
});

test("savePrefs leaves no temporary file behind", () => {
  savePrefs(defaultPrefs());
  const leftovers = fs.readdirSync(root).filter((name) => name.startsWith(".prefs."));
  assert.deepEqual(leftovers, []);
});

test("a round trip through the file is lossless", () => {
  const original = validatePrefs({
    appearance: { blur: 3, dim: 12, banner: { mode: "compact", opacity: 0.4 } },
    audio: { bgm: { shuffle: false, repeat: "one", disabledTracks: ["b.mp3"] } },
    pet: { position: { x: 40, y: 80 } },
    status: { language: "en", anyTheme: true },
  });
  savePrefs(original);
  const { prefs } = loadPrefs();
  assert.deepEqual(prefs, original);
});

test("serializePrefs is stable, so a rewrite is a no-op diff", () => {
  // Written first: the previous test in this file leaves a non-default document
  // on disk, and this test is about the serialiser, not about that.
  savePrefs(defaultPrefs());
  const a = serializePrefs(defaultPrefs());
  const b = serializePrefs(loadPrefs().prefs);
  assert.equal(a, b);
  assert.ok(a.endsWith("\n"), "the file ends with a newline");
});

test("ensureDataRoot is idempotent", () => {
  ensureDataRoot();
  ensureDataRoot();
  assert.equal(fs.existsSync(mediaDir("voice")), true);
});
