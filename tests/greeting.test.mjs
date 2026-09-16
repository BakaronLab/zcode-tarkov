// Tarkov-mode replacement of the empty-chat greeting.
//
// The replacement is pure CSS on a semantic data attribute: the DOM text is
// never rewritten, so leaving Tarkov mode restores the original greeting by
// simply not matching any more. These tests pin that contract down.
import test from "node:test";
import assert from "node:assert/strict";
import { argbFromRgb, themeFromSourceColor } from "@material/material-color-utilities";

import {
  TARKOV_GREETING,
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
  return css.slice(open + 1, close);
}

const GREETING_SEL = 'p[data-v4-draft-greeting="true"]';

// --- the wording ------------------------------------------------------------

test("greeting line 1 is the required beta notice", () => {
  assert.equal(TARKOV_GREETING.line1, "注意！这是“ZCode”的Beta测试版本。");
});

test("greeting line 2 is the required beta notice", () => {
  assert.equal(
    TARKOV_GREETING.line2,
    "Beta 测试版本不代表本产品的最终质量。感谢您的理解和支持，祝你好运！"
  );
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

  assert.ok(selectors.length >= 3, `expected the greeting rules, got ${selectors.length}`);
  for (const sel of selectors) {
    assert.ok(
      sel.startsWith("p[data-v4-draft-greeting="),
      `greeting rule is not anchored to the greeting element: ${sel}`
    );
  }
  assert.equal(/^\s*body\s*\{/m.test(css), false, "must not restyle body");
});

test("the original text is not rewritten, only made non-painting", () => {
  const span = blockFor(`${GREETING_SEL} > span`);
  assert.match(span, /visibility:\s*hidden/, "spans are hidden visually");
  // display:none would zero the measurement span ZCode keeps for layout.
  assert.equal(/display:\s*none/.test(span), false, "must not remove the span from layout");
  assert.match(blockFor(GREETING_SEL), /font-size:\s*0/);
});

// --- typographic hierarchy --------------------------------------------------

test("line 1 is the larger, bolder title", () => {
  const before = blockFor(`${GREETING_SEL}::before`);
  const after = blockFor(`${GREETING_SEL}::after`);

  // font-size: calc(var(--v4-draft-greeting-font-size, 30px) * 0.85);
  // [^;]* rather than [^)]* because the var() fallback contains parens.
  const sizeOf = (b) => Number(/font-size:\s*calc\([^;]*\*\s*([0-9.]+)\)/.exec(b)?.[1]);
  const weightOf = (b) => Number(/font-weight:\s*(\d+)/.exec(b)?.[1]);

  const s1 = sizeOf(before);
  const s2 = sizeOf(after);
  assert.ok(Number.isFinite(s1) && Number.isFinite(s2), "both sizes should be parseable");
  assert.ok(s1 > s2, `line 1 (${s1}) must be larger than line 2 (${s2})`);
  assert.ok(weightOf(before) > weightOf(after), "line 1 must be bolder than line 2");
});

test("both lines scale with ZCode's own greeting font-size variable", () => {
  assert.match(css, /--v4-draft-greeting-font-size/);
  // Every size derives from that variable, so a ZCode change is followed.
  const sizes = css.match(/font-size:\s*calc\(var\(--v4-draft-greeting-font-size/g) ?? [];
  assert.ok(sizes.length >= 2, "expected both lines to be variable-derived");
});

test("line 1 and line 2 render as separate blocks", () => {
  assert.match(blockFor(`${GREETING_SEL}::before`), /display:\s*block/);
  assert.match(blockFor(`${GREETING_SEL}::after`), /display:\s*block/);
});

// --- palette ----------------------------------------------------------------

test("both lines still take their colours from the existing Tarkov tokens", () => {
  assert.match(blockFor(`${GREETING_SEL}::before`), /var\(--color-foreground,/);
  assert.match(blockFor(`${GREETING_SEL}::after`), /var\(--color-foreground-subtle,/);
});

// --- the announcement panel -------------------------------------------------

test("the greeting element becomes a framed, padded announcement panel", () => {
  const panel = blockFor(GREETING_SEL);
  assert.match(panel, /border:\s*1px solid rgba\(224, 121, 48, 0\.35\)/, "thin warm border");
  assert.match(panel, /border-left:\s*4px solid/, "left accent bar");
  assert.match(panel, /border-radius:\s*3px/, "hard-edged, not the app's rounded look");
  assert.match(panel, /padding:/, "panel padding");
  assert.match(panel, /backdrop-filter:\s*blur\(6px\)/, "backdrop blur");
  assert.match(panel, /box-shadow:/, "shadow for layering");
});

test("the panel is centred, content-sized, and capped in width", () => {
  const panel = blockFor(GREETING_SEL);
  assert.match(panel, /display:\s*flex/);
  assert.match(panel, /flex-direction:\s*column/);
  assert.match(panel, /align-items:\s*center/);
  assert.match(panel, /justify-content:\s*center/);
  assert.match(panel, /width:\s*fit-content/);
  assert.match(panel, /max-width:\s*min\(100%,\s*36rem\)/);
  assert.match(panel, /margin-inline:\s*auto/);
});

test("the plate is dark and translucent, never a bright orange block", () => {
  const panel = blockFor(GREETING_SEL);
  const gradient = /background:\s*linear-gradient\(([^;]*)\)/.exec(panel);
  assert.ok(gradient, "expected a gradient plate");

  const stops = [...gradient[1].matchAll(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([0-9.]+)\)/g)].map((m) => ({
    r: +m[1],
    g: +m[2],
    b: +m[3],
    a: +m[4],
  }));
  assert.ok(stops.length >= 2, "gradient should have at least two stops");
  for (const s of stops) {
    assert.ok(s.a > 0 && s.a < 0.75, `plate alpha ${s.a} must stay translucent so the Z shows through`);
    assert.ok(s.r + s.g + s.b < 120, `plate colour ${s.r},${s.g},${s.b} must be dark`);
  }
  assert.equal(
    /background:\s*rgba\(224, 121, 48/.test(panel),
    false,
    "the orange must not become a solid fill"
  );
});

test("every colour in the panel stays within the Tarkov palette", () => {
  const panel = blockFor(GREETING_SEL);
  const allowed = new Set(["224,121,48", "48,33,17", "28,19,10", "255,215,174", "0,0,0"]);
  for (const m of panel.matchAll(/rgba\((\d+),\s*(\d+),\s*(\d+)/g)) {
    const key = `${m[1]},${m[2]},${m[3]}`;
    assert.ok(allowed.has(key), `unexpected colour ${key} in the notice panel`);
  }
});

test("the plate reads as a block against the default background", () => {
  // With no wallpaper the page background is --color-background (#1c1207 =
  // rgb(28,18,7)). A plate of that same tone would be invisible, leaving the
  // notice as bare text, so the top stop must be measurably lighter.
  const gradient = /background:\s*linear-gradient\(([^;]*)\)/.exec(blockFor(GREETING_SEL))[1];
  const first = /rgba\((\d+),\s*(\d+),\s*(\d+)/.exec(gradient);
  const [r, g, b] = [+first[1], +first[2], +first[3]];
  const plate = r + g + b;
  const background = 28 + 18 + 7; // #1c1207
  assert.ok(plate > background + 20, `plate rgb(${r},${g},${b}) is too close to the background to show as a block`);
  assert.ok(plate < 160, `plate rgb(${r},${g},${b}) is too light for a dark Tarkov surface`);
  // Still a warm brown: red-dominant, blue-lightest.
  assert.ok(r > g && g > b, `plate rgb(${r},${g},${b}) must stay a warm brown`);
});

test("nothing opaque is painted over the backdrop, so the Z graphic stays visible", () => {
  const panel = blockFor(GREETING_SEL);
  assert.equal(/background(-color)?:\s*(#|rgb\()/.test(panel), false, "no opaque fill");
  assert.equal(/background(-color)?:\s*[a-z-]+\s*;/.test(panel), false, "plate must be a gradient, not a solid keyword");
});

test("the panel does not capture pointer events away from the page", () => {
  // It is an in-flow block, not an overlay: no fixed/absolute positioning that
  // could sit on top of the prompt box.
  const panel = blockFor(GREETING_SEL);
  assert.equal(/position:\s*(fixed|absolute)/.test(panel), false, "must stay in flow");
  assert.match(panel, /position:\s*relative/);
});

test("the two lines are slightly tighter than a plain block gap", () => {
  const margin = /margin-top:\s*calc\([^;]*\*\s*([0-9.]+)\)/.exec(blockFor(`${GREETING_SEL}::after`));
  assert.ok(margin, "expected a derived margin-top");
  assert.ok(Number(margin[1]) < 0.26, `spacing ${margin[1]} should be tighter than the previous 0.26`);
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

test("tarkov token overrides still cover the tokens the notice relies on", () => {
  const tokens = buildTarkovVariableOverrides({ wallpaperVisible: false, dim: 0 });
  assert.match(tokens, /--color-foreground:/);
  assert.match(tokens, /--color-foreground-subtle:/);
});
