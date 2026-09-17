// Tarkov-mode replacement of the empty-chat greeting.
//
// The replacement is pure CSS on a semantic data attribute: the DOM text is
// never rewritten, so leaving Tarkov mode restores the original greeting by
// simply not matching any more. These tests pin that contract down, along with
// the visual language it borrows from dsh-theme-tarkov's beta banner.
import test from "node:test";
import assert from "node:assert/strict";
import { argbFromRgb, themeFromSourceColor } from "@material/material-color-utilities";

import {
  TARKOV_GREETING,
  TARKOV_PALETTE,
  buildTarkovComponentCss,
  buildTarkovVariableOverrides,
} from "../.test-build/themes/tarkov.js";
import { buildPayload, DEFAULT_CONFIG } from "../.test-build/core/inject.js";

const css = buildTarkovComponentCss();

/** Extract a declaration block for a selector, from the generated stylesheet. */
function blockFor(selector) {
  const i = css.indexOf(selector);
  assert.ok(i >= 0, `selector not found: ${selector}`);
  const open = css.indexOf("{", i);
  const close = css.indexOf("}", open);
  // Comments carry prose — including words like "border" and "display: none" —
  // so they are stripped before anything is asserted about declarations.
  return css.slice(open + 1, close).replace(/\/\*[\s\S]*?\*\//g, "");
}

const GREETING_SEL = 'p[data-v4-draft-greeting="true"]';
/** The band rule: the anchor plus the structure guard every rule carries. */
const BAND_SEL = `${GREETING_SEL}:has(> span:not([aria-hidden]):last-child)`;
/** The text column: ZCode's own visible greeting span. */
const COLUMN_SEL = `${BAND_SEL} > span:not([aria-hidden]):last-child`;

// --- the wording ------------------------------------------------------------

test("greeting line 1 is the required beta notice", () => {
  assert.equal(TARKOV_GREETING.line1, "注意！这是“ZCode”的Beta测试版本。");
});

test("greeting line 2 is the required beta notice", () => {
  assert.equal(
    TARKOV_GREETING.line2,
    "Beta测试版本不代表本产品的最终质量。感谢您的理解和支持，祝你好运！"
  );
});

test("the wording follows the reference copy, including its punctuation", () => {
  // dsh-theme-tarkov ships these two lines verbatim for its own beta banner;
  // line 1 only swaps the product name. The missing space after "Beta" is part
  // of that copy, not a typo introduced here.
  assert.equal(TARKOV_GREETING.line2.startsWith("Beta测试版本"), true);
  assert.equal(/Beta\s/.test(TARKOV_GREETING.line2), false, "the reference has no space after Beta");
  assert.equal(TARKOV_GREETING.line2.endsWith("祝你好运！"), true);
  assert.equal(/[“”]ZCode[“”]/.test(TARKOV_GREETING.line1), true, "curly quotes are kept");
});

test("the copy is adapted to ZCode, not copied from the reference project", () => {
  assert.match(TARKOV_GREETING.line1, /ZCode/);
  assert.equal(/Deepseek|DeepSeek|Harness/i.test(TARKOV_GREETING.line1 + TARKOV_GREETING.line2), false);
});

// --- anchor stability -------------------------------------------------------

test("the anchor is a semantic data attribute, not a hashed class", () => {
  assert.match(css, /p\[data-v4-draft-greeting="true"\]/);
  // A hash-style class selector would look like _greeting_ab12cd
  assert.equal(/_\w+-[0-9a-f]{5,}/.test(css), false, "no CSS-module hash class may appear");
});

test("every greeting rule is scoped to the greeting element", () => {
  // Collect the selectors of the rules that mention the greeting, and require
  // each to be qualified by the anchor rather than styling anything globally.
  const selectors = css
    .split("}")
    .map((chunk) => chunk.slice(chunk.lastIndexOf("\n", chunk.lastIndexOf("{")) + 1))
    .filter((s) => s.includes("{") && s.includes("v4-draft-greeting"))
    .map((s) => s.slice(0, s.indexOf("{")).trim());

  assert.ok(selectors.length >= 4, `expected the greeting rules, got ${selectors.length}`);
  for (const sel of selectors) {
    assert.ok(
      sel.startsWith("p[data-v4-draft-greeting="),
      `greeting rule is not anchored to the greeting element: ${sel}`
    );
  }
  assert.equal(/^\s*body\s*\{/m.test(css), false, "must not restyle body");
});

test("every greeting rule requires ZCode's two-span structure", () => {
  // The notice reuses ZCode's own greeting spans, so each rule is gated on that
  // structure: if the markup changes, nothing matches and the stock greeting is
  // drawn instead of a half-painted band.
  const guarded = css
    .split("}")
    .map((chunk) => chunk.slice(chunk.lastIndexOf("\n", chunk.lastIndexOf("{")) + 1))
    .filter((s) => s.includes("{") && s.includes("v4-draft-greeting"))
    .map((s) => s.slice(0, s.indexOf("{")).trim())
    .filter((sel) => sel.includes("span"))
    // The rule that keeps the measuring span non-painting is not part of the
    // painted structure, so it needs no guard: it is a no-op on its own.
    .filter((sel) => !sel.includes('[aria-hidden="true"]'));

  assert.ok(guarded.length >= 4, `expected guarded greeting rules, got ${guarded.length}`);
  for (const sel of guarded) {
    assert.match(sel, /:has\(> span:not\(\[aria-hidden\]\):last-child\)/, `unguarded rule: ${sel}`);
  }
});

// --- the reference band -----------------------------------------------------

test("the notice is the reference warning band, not a dark plate", () => {
  const band = blockFor(BAND_SEL);
  assert.match(band, /background:\s*rgba\(238, 138, 58, var\(--zct-banner-opacity, [0-9.]+\)\)/);
  // The previous iteration's self-designed treatment is gone for good.
  assert.equal(/linear-gradient/.test(band), false, "no gradient plate");
  // The only border-ish declaration left is the reference's corner radius:
  // `box-sizing: border-box` is not a border, hence the declaration match.
  assert.deepEqual(
    [...band.matchAll(/(?:^|[\s;])border[a-z-]*\s*:/g)].map((m) => m[0].trim()),
    ["border-radius:"],
    "no frame and no accent bar"
  );
  assert.equal(/box-shadow/.test(band), false, "no glow");
  assert.equal(/backdrop-filter/.test(band), false, "no blur");
});

test("the band keeps the reference's translucent, adjustable strength", () => {
  const band = blockFor(BAND_SEL);
  const alpha = Number(/--zct-banner-opacity,\s*([0-9.]+)\)/.exec(band)[1]);
  assert.ok(alpha >= 0.45 && alpha <= 0.62, `band alpha ${alpha} is outside the agreed 0.45-0.62 range`);
  // A solid band would hide the page and stop being a warning band.
  assert.ok(alpha < 1, "the band must stay translucent");
});

test("the band's hue is the Tarkov accent, so it reads orange", () => {
  const band = blockFor(BAND_SEL);
  const [r, g, b] = /rgba\((\d+),\s*(\d+),\s*(\d+)/.exec(band).slice(1).map(Number);
  assert.deepEqual([r, g, b], [238, 138, 58], "the band must be rgba(238,138,58,…), the v0.2 accent");
  assert.equal(`#${r.toString(16)}${g.toString(16)}${b.toString(16)}`, TARKOV_PALETTE.accent);
});

test("black text on the band is legible at the shipped alpha", () => {
  // This is a conservative proxy: it blends in sRGB, which is the darkest of the
  // plausible models, so a pass here cannot flatter the design. The real rendered
  // contrast is measured from screenshots during live verification (3.5:1 at
  // 0.55, 3.9:1 at 0.62) and is better than this bound.
  const band = blockFor(BAND_SEL);
  // The alpha is the variable's fallback, so it is parsed out of the var().
  const [r, g, b, a] = /rgba\((\d+),\s*(\d+),\s*(\d+),\s*var\([^)]*,\s*([0-9.]+)\)\)/.exec(band).slice(1).map(Number);
  const page = [0x1c, 0x12, 0x07]; // --color-background, the darkest plausible backdrop
  const composited = [r, g, b].map((c, i) => c * a + page[i] * (1 - a));

  const luminance = (rgb) => {
    const [R, G, B] = rgb.map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * R + 0.7152 * G + 0.0722 * B;
  };

  const bandL = luminance(composited);
  const textL = luminance([0x11, 0x11, 0x11]);
  const ratio = (bandL + 0.05) / (textL + 0.05);
  assert.ok(ratio >= 2.6, `black on the band is only ${ratio.toFixed(2)}:1 even on this optimistic model`);
  assert.ok(ratio < 12, `${ratio.toFixed(2)}:1 looks like the band is no longer orange`);
});

// --- layout -----------------------------------------------------------------

test("the band is laid out like the reference banner", () => {
  const band = blockFor(BAND_SEL);
  assert.match(band, /display:\s*flex/);
  assert.match(band, /align-items:\s*center/);
  assert.match(band, /gap:\s*16px/);
  assert.match(band, /box-sizing:\s*border-box/);
  assert.match(band, /width:\s*min\(94%,\s*720px\)/);
  assert.match(band, /margin:\s*18px auto 10px/);
  assert.match(band, /padding:\s*15px 22px 15px 16px/);
  assert.match(band, /border-radius:\s*6px/);
  assert.match(band, /text-align:\s*left/);
});

test("the band stays in flow, so it cannot cover the prompt box", () => {
  const band = blockFor(BAND_SEL);
  assert.equal(/position:\s*(fixed|absolute)/.test(band), false, "must stay in flow");
});

test("the warning badge is the reference hexagon", () => {
  const badge = blockFor(`${BAND_SEL}::before`);
  assert.match(badge, /content:\s*"!"/, "the badge is a text glyph");
  assert.match(
    badge,
    /clip-path:\s*polygon\(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%\)/
  );
  assert.match(badge, /background:\s*#1c1207/);
  assert.match(badge, /color:\s*#ee8a3a/);
  assert.match(badge, /flex:\s*none/, "the badge must not be squeezed by long copy");
  assert.match(badge, /font-weight:\s*800/);
  // No image asset is used for the badge: no game art, no SVG data URI.
  assert.equal(/url\(|background-image/.test(badge), false);
});

test("the badge scales with ZCode's greeting scale and lands in the agreed range", () => {
  const badge = blockFor(`${BAND_SEL}::before`);
  const sizeOf = (prop) => Number(new RegExp(`${prop}:\\s*calc\\([^;]*\\*\\s*([0-9.]+)\\)`).exec(badge)[1]);
  // Both are written against --v4-draft-greeting-font-size, whose default is 30px.
  assert.match(badge, /1\.45|1\.25/, "sizes derive from the greeting font-size variable");
  const w = sizeOf("width") * 30;
  const h = sizeOf("height") * 30;
  assert.ok(w >= 42 && w <= 48, `badge width ${w}px is outside the agreed 42-48px`);
  assert.ok(h >= 36 && h <= 42, `badge height ${h}px is outside the agreed 36-42px`);
});

// --- typographic hierarchy --------------------------------------------------

test("the text column is ZCode's own greeting span, not a new element", () => {
  const column = blockFor(COLUMN_SEL);
  assert.match(column, /display:\s*flex/);
  assert.match(column, /flex-direction:\s*column/, "the two lines stack beside the badge");
  assert.match(column, /min-width:\s*0/, "the copy must be allowed to wrap");
  assert.match(column, /font-size:\s*0/, "the original greeting text is collapsed, not removed");
});

test("the original text is not rewritten, only made non-painting", () => {
  const hidden = blockFor('p[data-v4-draft-greeting="true"] > span[aria-hidden="true"]');
  assert.match(hidden, /visibility:\s*hidden/, "the measuring span is hidden visually");
  // display:none would zero the measurement span ZCode keeps for layout.
  assert.equal(/display:\s*none/.test(hidden), false, "must not remove the span from layout");
  // Nothing in the notice writes to the DOM: the copy lives in CSS content only.
  assert.equal(/textContent|innerHTML|appendChild/.test(css), false);
});

test("line 1 is the larger, bolder title", () => {
  const before = blockFor(`${COLUMN_SEL}::before`);
  const after = blockFor(`${COLUMN_SEL}::after`);

  // font-size: calc(var(--v4-draft-greeting-font-size, 30px) * 0.6);
  // [^;]* rather than [^)]* because the var() fallback contains parens.
  const sizeOf = (b) => Number(/font-size:\s*calc\([^;]*\*\s*([0-9.]+)\)/.exec(b)?.[1]);
  const weightOf = (b) => Number(/font-weight:\s*(\d+)/.exec(b)?.[1]);

  const s1 = sizeOf(before);
  const s2 = sizeOf(after);
  assert.ok(Number.isFinite(s1) && Number.isFinite(s2), "both sizes should be parseable");
  assert.ok(s1 > s2, `line 1 (${s1}) must be larger than line 2 (${s2})`);
  assert.ok(weightOf(before) > weightOf(after), "line 1 must be bolder than line 2");
  // At ZCode's default 30px scale these resolve to the reference's 18px/15px.
  assert.equal(s1 * 30, 18, "line 1 should land on the reference size");
  assert.equal(s2 * 30, 15, "line 2 should land on the reference size");
});

test("both lines scale with ZCode's own greeting font-size variable", () => {
  assert.match(css, /--v4-draft-greeting-font-size/);
  // Every size derives from that variable, so a ZCode change is followed.
  const sizes = css.match(/font-size:\s*calc\(var\(--v4-draft-greeting-font-size/g) ?? [];
  assert.ok(sizes.length >= 3, "expected the lines and the badge to be variable-derived");
});

test("line 1 and line 2 render as separate blocks", () => {
  assert.match(blockFor(`${COLUMN_SEL}::before`), /display:\s*block/);
  assert.match(blockFor(`${COLUMN_SEL}::after`), /display:\s*block/);
});

test("both lines use the reference's black text, not the warm theme colours", () => {
  assert.match(blockFor(`${COLUMN_SEL}::before`), /color:\s*#111111/);
  assert.match(blockFor(`${COLUMN_SEL}::after`), /color:\s*#111111/);
  const notice = css.slice(css.indexOf("empty-chat beta notice"));
  assert.equal(
    /color:\s*var\(--color-foreground/.test(notice),
    false,
    "the previous light-on-dark text colours must be gone"
  );
});

test("the two lines carry the reference's letter-spacing and line gap", () => {
  const before = blockFor(`${COLUMN_SEL}::before`);
  const after = blockFor(`${COLUMN_SEL}::after`);
  assert.match(before, /letter-spacing:\s*1\.5px/);
  assert.match(after, /letter-spacing:\s*1\.5px/);
  // The reference's 5px gap between the two lines, at ZCode's scale.
  const gap = Number(/margin-top:\s*calc\([^;]*\*\s*([0-9.]+)\)/.exec(after)?.[1]);
  assert.ok(Math.abs(gap * 30 - 5) < 0.1, `line gap ${gap * 30}px should match the reference's 5px`);
});

// --- emitted content --------------------------------------------------------

test("the exact wording reaches the stylesheet as a quoted CSS string", () => {
  assert.ok(
    css.includes(`content: "${TARKOV_GREETING.line1}";`),
    "line 1 must appear verbatim in a content declaration"
  );
  assert.ok(
    css.includes(`content: "${TARKOV_GREETING.line2}";`),
    "line 2 must appear verbatim in a content declaration"
  );
});

test("the content literals are balanced, so nothing leaks out of the string", () => {
  for (const line of [TARKOV_GREETING.line1, TARKOV_GREETING.line2]) {
    const decl = `content: "${line}";`;
    assert.ok(css.includes(decl));
    // An unescaped quote would have terminated the literal early.
    assert.equal(line.includes('"'), false, "test text should not contain ASCII quotes");
  }
});

// --- mode scoping -----------------------------------------------------------

function payloadFor(colorMode) {
  const assets = {
    dataUri: "data:image/jpeg;base64,QUJD",
    sourceArgb: argbFromRgb(224, 121, 48),
    theme: themeFromSourceColor(argbFromRgb(224, 121, 48)),
    focus: { x: 0.5, y: 0.5, fit: "cover" },
  };
  return buildPayload({ ...DEFAULT_CONFIG, colorMode }, assets);
}

test("only the Tarkov payload carries the greeting replacement", () => {
  const tarkov = payloadFor("tarkov");
  assert.match(tarkov.css, /data-v4-draft-greeting/);
  assert.ok(tarkov.css.includes(TARKOV_GREETING.line1));

  for (const mode of ["monet", "native"]) {
    const other = payloadFor(mode);
    assert.equal(
      other.css.includes("data-v4-draft-greeting"),
      false,
      `${mode} must leave the original greeting alone`
    );
    assert.equal(other.css.includes(TARKOV_GREETING.line1), false);
    assert.equal(other.css.includes("zct-banner-opacity"), false);
  }
});

test("switching out of Tarkov removes the rule entirely, so the greeting returns", () => {
  const tarkov = payloadFor("tarkov").css;
  const native = payloadFor("native").css;
  // Recovery is implicit: the replacement lives only in the Tarkov stylesheet,
  // which is replaced wholesale on a mode switch. Nothing has to be undone.
  assert.match(tarkov, /data-v4-draft-greeting/);
  assert.equal(native.includes("data-v4-draft-greeting"), false);
});

// --- fail-soft --------------------------------------------------------------

test("if the anchor is absent nothing matches, so other theming is unaffected", () => {
  // Every greeting rule is attribute-qualified; a page without the empty-chat
  // screen has no matching element and the rest of the stylesheet still applies.
  const greetingRules = css
    .split("\n")
    .filter((l) => l.includes("{") && l.includes("v4-draft"));
  for (const rule of greetingRules) {
    assert.match(rule, /v4-draft-greeting/, `unqualified greeting rule: ${rule.trim()}`);
  }
  // The rest of the skin is independent of it.
  assert.match(css, /\[data-slot="card"\]/);
  assert.match(css, /--tarkov-accent/);
});

test("the replacement introduces no script or DOM mutation", () => {
  const greetingOnly = css.slice(css.indexOf("empty-chat beta notice"));
  assert.equal(/javascript:|expression\(|url\(/.test(greetingOnly), false);
});

test("the band is composed from palette values only", () => {
  // Comments carry prose that quotes colours (e.g. the measured renders), so the
  // declarations are what gets checked.
  const notice = css.slice(css.indexOf("empty-chat beta notice")).replace(/\/\*[\s\S]*?\*\//g, "");
  const allowed = new Set(["238,138,58", "28,18,7", "17,17,17"]);
  for (const m of notice.matchAll(/rgba?\((\d+),\s*(\d+),\s*(\d+)/g)) {
    const key = `${m[1]},${m[2]},${m[3]}`;
    assert.ok(allowed.has(key), `unexpected colour ${key} in the beta notice`);
  }
  for (const hex of notice.matchAll(/#([0-9a-f]{6})/g)) {
    assert.ok(
      [TARKOV_PALETTE.accent, TARKOV_PALETTE.background, "#111111"].includes(`#${hex[1]}`),
      `unexpected colour #${hex[1]} in the beta notice`
    );
  }
});
