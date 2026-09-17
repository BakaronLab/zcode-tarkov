// The user-chosen palette and the editable greeting.
//
// The property these tests exist to protect is stated once and asserted from
// several directions: **an install that customises nothing must render exactly
// what it rendered before.** The palette resolver returns the shipped constants
// untouched rather than re-deriving them, because a derivation — however
// principled — would have shifted the colours of every existing install on
// upgrade. Everything else here is the customised path.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "zct-palette-"));
process.env.ZCODE_TARKOV_DATA_DIR = root;

const {
  DEFAULT_PALETTE,
  TARKOV_ACCENT,
  TARKOV_BACKGROUND,
  compositeOver,
  contrastRatio,
  isDefaultPalette,
  parseHex,
  resolvePalette,
  toHex,
  toTriple,
  luminance,
} = await import("../.test-build/themes/palette.js");
const { buildPayload, resolveBanner, DEFAULT_CONFIG } = await import("../.test-build/core/inject.js");
const { DEFAULT_GREETING } = await import("../.test-build/themes/tarkov.js");
const { validatePrefs, migrateV01Appearance } = await import("../.test-build/prefs/prefs.js");
const { defaultPrefs } = await import("../.test-build/prefs/defaults.js");

// --- colour parsing ----------------------------------------------------------

test("hex parsing accepts both spellings and rejects everything else", () => {
  assert.deepEqual(parseHex("#abc"), { r: 170, g: 187, b: 204 });
  assert.deepEqual(parseHex("#AABBCC"), { r: 170, g: 187, b: 204 });
  assert.deepEqual(parseHex("aabbcc"), { r: 170, g: 187, b: 204 });
  assert.deepEqual(parseHex("  #1c1207 "), { r: 28, g: 18, b: 7 });
  for (const bad of ["", "#12", "#12345", "#1234567", "rgb(1,2,3)", "red", "#gggggg", null, undefined, 7, {}]) {
    assert.equal(parseHex(bad), undefined, `${JSON.stringify(bad)} must not parse`);
  }
});

test("a colour normalises to one spelling, so two spellings compare equal", () => {
  assert.equal(toHex(parseHex("#ABC")), "#aabbcc");
  assert.equal(toHex(parseHex("#aabbcc")), "#aabbcc");
  assert.equal(toTriple(parseHex("#010203")), "1, 2, 3");
  // Out-of-range channels are clamped rather than wrapped, which is what stops a
  // near-white background turning into a dark one.
  assert.equal(toHex({ r: 300, g: -20, b: 128 }), "#ff0080");
});

test("luminance separates light from dark", () => {
  assert.ok(luminance(parseHex("#000000")) < 0.01);
  assert.ok(luminance(parseHex("#ffffff")) > 0.99);
  assert.ok(luminance(parseHex(TARKOV_BACKGROUND)) < 0.05, "the shipped background is dark");
});

// --- the "unchanged means unchanged" property --------------------------------

test("an unmodified palette is the shipped object, not a derived copy", () => {
  // Identity, not equality: returning a recomputed object with the same numbers
  // would be indistinguishable today and could drift tomorrow.
  assert.equal(resolvePalette(), DEFAULT_PALETTE);
  assert.equal(resolvePalette({}), DEFAULT_PALETTE);
  assert.equal(resolvePalette({ background: TARKOV_BACKGROUND }), DEFAULT_PALETTE);
  assert.equal(resolvePalette({ accent: TARKOV_ACCENT }), DEFAULT_PALETTE);
  assert.equal(resolvePalette({ background: "#1C1207", accent: "#EE8A3A" }), DEFAULT_PALETTE);
});

test("isDefaultPalette treats an absent and a matching colour alike", () => {
  assert.equal(isDefaultPalette({}), true);
  assert.equal(isDefaultPalette({ background: TARKOV_BACKGROUND, accent: TARKOV_ACCENT }), true);
  assert.equal(isDefaultPalette({ background: "#000000" }), false);
  // Invalid input is not a customisation: it falls back, so the defaults apply.
  assert.equal(isDefaultPalette({ background: "not a colour" }), true);
});

test("the shipped palette still paints the documented tokens", () => {
  const payload = buildPayload(
    { ...DEFAULT_CONFIG, colorMode: "tarkov", wallpaperVisible: false },
    undefined
  );
  assert.match(payload.css, /--color-primary:#ee8a3a/);
  assert.match(payload.css, /--color-background:#1c1207/, "the opaque background is the shipped tone");
  assert.match(payload.css, /--tarkov-accent:#ee8a3a/);
  assert.equal(payload.css.includes("--color-primary:#ff0000"), false);
});

// --- the customised path -----------------------------------------------------

test("a custom accent reaches every accent surface, including the band", () => {
  const payload = buildPayload(
    { ...DEFAULT_CONFIG, colorMode: "tarkov", accent: "#3ba7ff" },
    undefined
  );
  assert.match(payload.css, /--color-primary:#3ba7ff/);
  assert.match(payload.css, /--tarkov-accent:#3ba7ff/);
  assert.match(payload.css, /--color-input-border-focused:#3ba7ff/);
  // The band takes the same accent, so a custom colour does not leave an orange
  // strip above a blue interface.
  assert.ok(payload.banner, "tarkov mode installs the band");
  assert.equal(payload.banner.accent, "#3ba7ff");
  assert.equal(payload.banner.accentRgb, "59, 167, 255");
  assert.equal(payload.css.includes("#ee8a3a"), false, "the shipped accent is gone from the page CSS");
});

test("a custom background reaches the base surface and the derived panels", () => {
  const payload = buildPayload(
    { ...DEFAULT_CONFIG, colorMode: "tarkov", background: "#0b1020", wallpaperVisible: false },
    undefined
  );
  assert.match(payload.css, /--color-background:#0b1020/);
  // With the wallpaper layer off the input surface is opaque, so the deep tone
  // is emitted as `rgb(...)` rather than `rgba(..., 1)` — the helper collapses
  // full opacity. The point of the assertion is that the tone is *derived from
  // the chosen background* and not left at the shipped one.
  assert.match(payload.css, /--color-input:rgb\(8, 11, 22\)/);
  assert.equal(payload.css.includes("20, 13, 4"), false, "the shipped deep tone is gone");
  assert.equal(payload.css.includes("#1c1207"), false, "the shipped background is gone");
  // Panels move away from the background so a surface is still distinguishable.
  const palette = resolvePalette({ background: "#0b1020" });
  assert.notEqual(palette.raisedRgb, toTriple(parseHex("#0b1020")));
});

test("the deep tone is emitted as a triple wherever rgba() composes it", () => {
  // `rgba()` takes an "r, g, b" triple. Interpolating the hex form produced
  // `rgba(#140d04, 0.5)` — an invalid token stream that a var() consumer
  // resolves to nothing rather than to a colour, so the input surface silently
  // inherited instead of being themed.
  const payload = buildPayload({ ...DEFAULT_CONFIG, colorMode: "tarkov" }, undefined);
  assert.equal(/rgba\(#/.test(payload.css), false, "no rgba() may take a hex");
  assert.match(payload.css, /--color-input:rgba\(20, 13, 4, 0\.5\)/);
  assert.match(payload.css, /--color-terminal-bg:#140d04/, "the direct value stays a hex");
});

test("a light background gets dark text rather than unreadable light text", () => {
  const palette = resolvePalette({ background: "#f2ece0" });
  assert.match(palette.text, /^#[0-9a-f]{6}$/);
  const text = parseHex(palette.text);
  assert.ok(luminance(text) < 0.2, `text must be dark on a light background, got ${palette.text}`);
  assert.ok(luminance(parseHex(palette.muted)) < 0.5);
});

test("a dark background keeps the warm light text", () => {
  const palette = resolvePalette({ background: "#05070a" });
  assert.ok(luminance(parseHex(palette.text)) > 0.5, "text must be light on a dark background");
});

test("an invalid colour falls back instead of rendering something broken", () => {
  const palette = resolvePalette({ background: "nonsense", accent: "#zzz" });
  assert.equal(palette, DEFAULT_PALETTE, "an unparseable value is not a customisation");
});

// --- the greeting ------------------------------------------------------------

test("the greeting is on by default and carries the shipped wording", () => {
  const payload = buildPayload({ ...DEFAULT_CONFIG, colorMode: "tarkov" }, undefined);
  assert.match(payload.css, /data-v4-draft-greeting/);
  assert.ok(payload.css.includes(DEFAULT_GREETING.line1));
  assert.ok(payload.css.includes(DEFAULT_GREETING.line2));
});

test("custom greeting text is rendered, and the shipped wording is absent", () => {
  const payload = buildPayload(
    {
      ...DEFAULT_CONFIG,
      colorMode: "tarkov",
      greeting: { enabled: true, line1: "CUSTOM LINE ONE", line2: "CUSTOM LINE TWO" },
    },
    undefined
  );
  assert.ok(payload.css.includes("CUSTOM LINE ONE"));
  assert.ok(payload.css.includes("CUSTOM LINE TWO"));
  assert.equal(payload.css.includes(DEFAULT_GREETING.line1), false);
});

test("disabling the greeting omits the rules entirely", () => {
  const payload = buildPayload(
    { ...DEFAULT_CONFIG, colorMode: "tarkov", greeting: { ...DEFAULT_GREETING, enabled: false } },
    undefined
  );
  // Omitted, not hidden: with no rule there is nothing to unwind, and ZCode's
  // own greeting is what the element shows.
  assert.equal(payload.css.includes("data-v4-draft-greeting"), false);
});

test("greeting text is embedded as a CSS string literal, so quotes cannot break out", () => {
  const nasty = 'he said "hi" \\ and \'bye\'';
  const payload = buildPayload(
    { ...DEFAULT_CONFIG, colorMode: "tarkov", greeting: { enabled: true, line1: nasty, line2: "x" } },
    undefined
  );
  assert.ok(payload.css.includes('\\"hi\\"'), "the quote must be escaped in the content value");
  assert.equal(/content: "he said "hi"/.test(payload.css), false);
});

test("the greeting and the palette do not leak into the other colour modes", () => {
  for (const mode of ["monet", "native"]) {
    const payload = buildPayload(
      {
        ...DEFAULT_CONFIG,
        colorMode: mode,
        accent: "#3ba7ff",
        greeting: { enabled: true, line1: "CUSTOM", line2: "CUSTOM" },
      },
      undefined
    );
    assert.equal(payload.css.includes("#3ba7ff"), false, `${mode} must not take the Tarkov accent`);
    assert.equal(payload.css.includes("data-v4-draft-greeting"), false, `${mode} must not take the notice`);
  }
});

// --- validation and migration ------------------------------------------------

test("appearance validation normalises the colours and bounds the greeting", () => {
  const p = validatePrefs({
    appearance: {
      background: "#ABC",
      accent: "#00ff00",
      greeting: { enabled: false, line1: "x".repeat(500), line2: "ok" },
    },
  });
  assert.equal(p.appearance.background, "#aabbcc", "the short spelling normalises");
  assert.equal(p.appearance.accent, "#00ff00");
  assert.equal(p.appearance.greeting.enabled, false);
  assert.equal(p.appearance.greeting.line1.length, 240, "line 1 is capped");
  assert.equal(p.appearance.greeting.line2, "ok");
});

test("garbage colours fall back to the shipped values rather than black", () => {
  const p = validatePrefs({ appearance: { background: "not-a-colour", accent: 12345 } });
  assert.equal(p.appearance.background, DEFAULT_PALETTE.background);
  assert.equal(p.appearance.accent, DEFAULT_PALETTE.accent);
});

test("an empty greeting line reverts to the default instead of blanking the notice", () => {
  const p = validatePrefs({ appearance: { greeting: { line1: "   ", line2: "" } } });
  assert.equal(p.appearance.greeting.line1, DEFAULT_GREETING.line1);
  assert.equal(p.appearance.greeting.line2, DEFAULT_GREETING.line2);
});

test("the defaults carry the shipped palette and greeting", () => {
  const d = defaultPrefs().appearance;
  assert.equal(d.background, TARKOV_BACKGROUND);
  assert.equal(d.accent, TARKOV_ACCENT);
  assert.equal(d.greeting.enabled, true);
  assert.equal(d.greeting.line1, DEFAULT_GREETING.line1);
});

// --- contrast -----------------------------------------------------------------
//
// The regression these guard was a HIGH finding from an independent review: the
// derived text colour used to be chosen by a light/dark *threshold* on the
// background, and the dark branch's ink was light. At a mid-grey background the
// threshold still chose the light ink, and a grey — the first thing anyone tries
// in a colour picker — measured 1.7:1. The fix measures the candidates against
// the surface instead of guessing, so the sweep below is the actual test: it
// walks the whole lightness range rather than sampling far-from-threshold
// colours, which is what let the defect through.

/** "r, g, b" back to channels — the palette emits triples, not hex. */
/** The panel-side surfaces the panel ink is painted on. */
function paletteSurfaces(palette) {
  return [
    ["panel", palette.panelRgb],
    ["panel-alt", palette.panelAltRgb],
    ["raised", palette.raisedRgb],
  ];
}

/** The popover and tooltip surfaces, which have their own ink. */
function popoverSurfaces(palette) {
  return [["popover", palette.popoverRgb]];
}

function rgbFromTriple(triple) {
  const [r, g, b] = triple.split(",").map((v) => Number(v.trim()));
  return { r, g, b };
}

/** Every shade of grey, which is where a threshold-based choice fails hardest. */
function greySweep(step = 8) {
  const out = [];
  for (let v = 0; v <= 255; v += step) out.push(toHex({ r: v, g: v, b: v }));
  return out;
}

/** A spread of saturated hues at several lightnesses. */
function hueSweep() {
  const out = [];
  for (let h = 0; h < 360; h += 30) {
    for (const l of [0.2, 0.4, 0.5, 0.6, 0.8]) {
      // Cheap HSL→RGB; exactness does not matter, coverage does.
      const c = (1 - Math.abs(2 * l - 1)) * 0.9;
      const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
      const m = l - c / 2;
      const seg = Math.floor(h / 60) % 6;
      const rgb = [
        [c, x, 0],
        [x, c, 0],
        [0, c, x],
        [0, x, c],
        [x, 0, c],
        [c, 0, x],
      ][seg];
      out.push(toHex({ r: (rgb[0] + m) * 255, g: (rgb[1] + m) * 255, b: (rgb[2] + m) * 255 }));
    }
  }
  return out;
}

test("derived body text clears 4.5:1 against EVERY surface it is painted on", () => {
  const failures = [];
  for (const background of [...greySweep(), ...hueSweep()]) {
    const palette = resolvePalette({ background });
    for (const [name, triple] of paletteSurfaces(palette)) {
      const ratio = contrastRatio(parseHex(palette.text), rgbFromTriple(triple));
      if (ratio < 4.5) failures.push(`${background} -> text ${palette.text} on ${name} ${triple} = ${ratio.toFixed(2)}:1`);
    }
    for (const [name, triple] of popoverSurfaces(palette)) {
      const ratio = contrastRatio(parseHex(palette.popoverText), rgbFromTriple(triple));
      if (ratio < 4.5) failures.push(`${background} -> popoverText ${palette.popoverText} on ${name} ${triple} = ${ratio.toFixed(2)}:1`);
    }
  }
  assert.deepEqual(failures, [], `body text must clear 4.5:1 everywhere:\n${failures.join("\n")}`);
});

test("derived muted text clears 3:1 against its panel for every background", () => {
  const failures = [];
  for (const background of [...greySweep(), ...hueSweep()]) {
    const palette = resolvePalette({ background });
    for (const [name, triple] of paletteSurfaces(palette)) {
      const surface = rgbFromTriple(triple);
      const muted = contrastRatio(parseHex(palette.muted), surface);
      if (muted < 3) failures.push(`${background} -> muted ${palette.muted} on ${name} = ${muted.toFixed(2)}:1`);
      for (const [token, value] of [["highlight", palette.highlight], ["warning", palette.warning]]) {
        const ratio = contrastRatio(parseHex(value), surface);
        if (ratio < 4.5) failures.push(`${background} -> ${token} ${value} on ${name} = ${ratio.toFixed(2)}:1`);
      }
    }
  }
  assert.deepEqual(failures, [], `muted and emphasis text must stay readable:\n${failures.join("\n")}`);
});

test("the ink on a filled accent clears 4.5:1 for every accent", () => {
  const failures = [];
  for (const accent of [...greySweep(), ...hueSweep()]) {
    const palette = resolvePalette({ accent });
    const ratio = contrastRatio(parseHex(palette.onAccent), parseHex(palette.accent));
    if (ratio < 4.5) failures.push(`${accent} -> onAccent ${palette.onAccent} = ${ratio.toFixed(2)}:1`);
  }
  assert.deepEqual(failures, [], `text on the accent must be readable:\n${failures.join("\n")}`);
});

test("the band's ink clears 3:1 against the band it is painted on", () => {
  // The band is the accent *composited over the background*, not the accent, so
  // the pair that has to be readable is a different one from `onAccent`. A dark
  // accent used to leave near-black text on a near-black band — the beta warning
  // unreadable, which defeats its only purpose.
  const failures = [];
  for (const accent of [...greySweep(), ...hueSweep()]) {
    for (const background of ["#0b1020", "#1c1207", "#f2ece0"]) {
      const palette = resolvePalette({ accent, background });
      const band = compositeOver(parseHex(palette.accent), parseHex(palette.background), 0.62);
      const ratio = contrastRatio(parseHex(palette.bandInk), band);
      if (ratio < 3) failures.push(`accent ${accent} on ${background} -> bandInk ${palette.bandInk} = ${ratio.toFixed(2)}:1`);
    }
  }
  assert.deepEqual(failures, [], `the beta band must stay readable:\n${failures.join("\n")}`);
});

test("the top band's ink clears 4.5:1 at every opacity the band can be set to", () => {
  // `banner.opacity` is a user-adjustable slider, so the ink has to hold across
  // the whole range rather than at the default alone. This drives the real
  // resolver, which is where the ink is derived, because the two bands are
  // painted at different alphas and reusing one ink for both measured 1.90:1 on
  // the top band for a dark accent over a light background.
  const failures = [];
  for (const opacity of [0.45, 0.62, 0.92, 1]) {
    for (const accent of ["#2f2f2f", "#3a3a3a", "#b0b0b0", "#ee8a3a", "#0b3d91"]) {
      for (const background of ["#ffffff", "#f2ece0", "#1c1207", "#0b1020"]) {
        const banner = resolveBanner({
          ...DEFAULT_CONFIG,
          colorMode: "tarkov",
          accent,
          background,
          banner: { ...DEFAULT_CONFIG.banner, opacity },
        });
        const surface = compositeOver(parseHex(accent), parseHex(background), opacity);
        const ratio = contrastRatio(parseHex(banner.accentInk), surface);
        if (ratio < 4.5) {
          failures.push(`opacity ${opacity}: ${accent} on ${background} -> ${banner.accentInk} = ${ratio.toFixed(2)}:1`);
        }
      }
    }
  }
  assert.deepEqual(failures, [], `the top band must stay readable at every opacity:\n${failures.join("\n")}`);
});

test("the shipped palette is exempt, so the reference design is preserved", () => {
  // The default band ink is #111111 by design — it matches the reference
  // project and measures 3.9:1 on the shipped band, above the large-text bar but
  // below what the derivation would choose. The exemption is the point: the
  // contrast logic runs only once a colour has actually been chosen.
  assert.equal(DEFAULT_PALETTE.bandInk, "#111111");
  assert.equal(DEFAULT_PALETTE.onAccent, "#1c1207");
  const band = compositeOver(parseHex(TARKOV_ACCENT), parseHex(TARKOV_BACKGROUND), 0.62);
  assert.ok(contrastRatio(parseHex(DEFAULT_PALETTE.bandInk), band) >= 3);
});

test("a mid-grey background gets the readable ink, not the threshold's choice", () => {
  // The exact case that was broken, named so a regression is obvious.
  for (const grey of ["#808080", "#9a9a9a", "#a0a0a0", "#a9a9a9", "#b0b0b0"]) {
    const palette = resolvePalette({ background: grey });
    const panel = rgbFromTriple(palette.panelAltRgb);
    assert.ok(
      contrastRatio(parseHex(palette.text), panel) >= 4.5,
      `${grey} must yield readable text, got ${palette.text}`
    );
  }
});

test("a v0.1 config migrates with the shipped colours and no custom greeting", () => {
  const migrated = migrateV01Appearance({ blur: 5, monet: true });
  assert.equal(migrated.background, TARKOV_BACKGROUND);
  assert.equal(migrated.accent, TARKOV_ACCENT);
  assert.equal(migrated.greeting.enabled, true);
  assert.equal(migrated.greeting.line1, DEFAULT_GREETING.line1);
});
