// Per-mode payload assembly, wallpaper visibility, and mode-switch residue.
import test from "node:test";
import assert from "node:assert/strict";
import { argbFromRgb, themeFromSourceColor } from "@material/material-color-utilities";

import { buildPayload, DEFAULT_CONFIG, resolveBanner, resolveColorMode } from "../.test-build/core/inject.js";
import { buildBootstrapScript, buildResetScript } from "../.test-build/core/cdp.js";

const SOURCE_ARGB = argbFromRgb(224, 121, 48);

/** Minimal stand-in for the wallpaper assets loadWallpaper() produces. */
function assets() {
  return {
    dataUri: "data:image/jpeg;base64,QUJD",
    sourceArgb: SOURCE_ARGB,
    theme: themeFromSourceColor(SOURCE_ARGB),
    focus: { x: 0.5, y: 0.5, fit: "cover" },
  };
}

function config(overrides = {}) {
  return { ...DEFAULT_CONFIG, ...overrides };
}

// --- resolveColorMode / resolveBanner ---------------------------------------

test("resolveColorMode honors colorMode and falls back to the legacy boolean", () => {
  assert.equal(resolveColorMode({ colorMode: "tarkov", monet: true }), "tarkov");
  assert.equal(resolveColorMode({ monet: true }), "monet");
  assert.equal(resolveColorMode({ monet: false }), "native");
});

test("the banner is Tarkov-only", () => {
  assert.equal(resolveBanner(config({ colorMode: "monet" })), null);
  assert.equal(resolveBanner(config({ colorMode: "native" })), null);
  assert.ok(resolveBanner(config({ colorMode: "tarkov" })));
});

test("the banner can be disabled from config", () => {
  const off = config({ colorMode: "tarkov", banner: { ...DEFAULT_CONFIG.banner, enabled: false } });
  assert.equal(resolveBanner(off), null);
});

// --- monet mode -------------------------------------------------------------

test("monet payload emits MD3 overrides and no Tarkov skin", () => {
  const payload = buildPayload(config({ colorMode: "monet" }), assets());
  assert.match(payload.css, /\.theme-zai-light/);
  assert.equal(payload.css.includes("--tarkov-accent"), false, "monet must not carry Tarkov tokens");
  assert.equal(payload.css.includes('[data-slot="card"]'), false, "monet must not carry the Tarkov skin");
  assert.equal(payload.banner, null);
});

test("monet without a wallpaper still produces a payload (no throw, no overrides)", () => {
  const payload = buildPayload(config({ colorMode: "monet" }), undefined);
  assert.equal(payload.css.includes(".theme-zai-light"), false);
  assert.equal(payload.wallpaperDataUri, undefined);
});

// --- native mode ------------------------------------------------------------

test("native payload applies transparency only, never a palette", () => {
  const payload = buildPayload(config({ colorMode: "native", wallpaperVisible: true }), assets());
  assert.match(payload.css, /--color-background:transparent/);
  // Transparency scrims must not touch foregrounds, accents or borders.
  assert.equal(payload.css.includes("--color-foreground:"), false, "native keeps ZCode foregrounds");
  assert.equal(payload.css.includes("--color-brand:"), false, "native keeps ZCode accents");
  assert.equal(payload.css.includes("--tarkov-accent"), false);
});

test("native with no wallpaper adds no color overrides at all", () => {
  const payload = buildPayload(config({ colorMode: "native" }), undefined);
  assert.equal(payload.css.includes("--color-background"), false);
});

// --- tarkov mode ------------------------------------------------------------

test("tarkov payload emits the fixed palette plus the component skin", () => {
  const payload = buildPayload(config({ colorMode: "tarkov" }), assets());
  assert.match(payload.css, /--color-primary:#e07930/);
  assert.match(payload.css, /--color-foreground:#e8d9c8/);
  assert.match(payload.css, /\[data-slot="card"\]/);
  assert.match(payload.css, /--tarkov-accent:#e07930/);
  assert.ok(payload.banner, "tarkov mode installs the banner");
});

test("tarkov payload does not depend on the wallpaper", () => {
  const withImage = buildPayload(config({ colorMode: "tarkov" }), assets());
  const withoutImage = buildPayload(config({ colorMode: "tarkov" }), undefined);
  // The palette block is byte-identical; only the wallpaper data URI differs.
  const strip = (css) => css.replace(/url\([^)]*\)/g, "url()");
  assert.equal(strip(withImage.css), strip(withoutImage.css));
});

test("swapping the wallpaper cannot change the Tarkov palette", () => {
  const warm = assets();
  const cool = { ...assets(), sourceArgb: argbFromRgb(20, 90, 200), theme: themeFromSourceColor(argbFromRgb(20, 90, 200)) };
  const a = buildPayload(config({ colorMode: "tarkov" }), warm);
  const b = buildPayload(config({ colorMode: "tarkov" }), cool);
  assert.equal(a.css, b.css);
});

// --- wallpaper visibility ---------------------------------------------------

test("wallpaperVisible controls both the wallpaper layer and the surface opacity", () => {
  const shown = buildPayload(config({ colorMode: "tarkov", wallpaperVisible: true }), assets());
  const hidden = buildPayload(config({ colorMode: "tarkov", wallpaperVisible: false }), assets());
  assert.ok(shown.wallpaperDataUri, "visible wallpaper is embedded");
  assert.equal(hidden.wallpaperDataUri, undefined, "hidden wallpaper is not embedded");
  assert.match(hidden.css, /--color-background:#1c1207/);
  assert.match(shown.css, /--color-background:transparent/);
});

test("blur and fit still drive the wallpaper layer", () => {
  const payload = buildPayload(config({ blur: 12, fit: "contain" }), assets());
  assert.match(payload.css, /filter: blur\(12px\)/);
  assert.equal(payload.fit, "contain");
});

// --- mode-switch residue ----------------------------------------------------

test("switching Tarkov -> Native leaves no Tarkov state in the new payload", () => {
  const tarkov = buildPayload(config({ colorMode: "tarkov" }), assets());
  assert.match(tarkov.css, /--tarkov-accent/);
  const native = buildPayload(config({ colorMode: "native" }), assets());
  assert.equal(native.css.includes("tarkov"), false, "no Tarkov token or rule may survive");
  assert.equal(native.banner, null);
});

test("switching Tarkov -> Monet leaves no Tarkov state in the new payload", () => {
  const monet = buildPayload(config({ colorMode: "monet" }), assets());
  assert.equal(monet.css.includes("tarkov"), false);
  assert.equal(monet.banner, null);
});

test("a non-Tarkov bootstrap tears the banner down instead of installing it", () => {
  const native = buildPayload(config({ colorMode: "native" }), assets());
  const script = buildBootstrapScript({
    css: native.css,
    wallpaperDataUri: native.wallpaperDataUri,
    fit: native.fit,
    banner: native.banner,
  });
  assert.match(script, /zcode-tarkov-banner/, "teardown must reference the banner id");
  assert.equal(script.includes("MutationObserver"), false, "no observer is installed outside Tarkov mode");
});

test("reset removes the banner along with the theme", () => {
  const reset = buildResetScript();
  assert.match(reset, /zcode-tarkov-banner/);
  // The theme ids are emitted as marker + suffix, so assert on both parts.
  assert.match(reset, /zcode-beautify/);
  assert.match(reset, /'-style'|'-wallpaper'/);
});
