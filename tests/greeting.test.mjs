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

test("both lines use existing Tarkov tokens, adding no new colors", () => {
  assert.match(blockFor(`${GREETING_SEL}::before`), /var\(--color-foreground,/);
  assert.match(blockFor(`${GREETING_SEL}::after`), /var\(--color-foreground-subtle,/);
  // The only literal colors allowed are the palette fallbacks already used
  // elsewhere in the theme; no new large surfaces are introduced.
  const greetingOnly = css.slice(css.indexOf("empty-chat beta notice"));
  assert.equal(/background/.test(greetingOnly), false, "the notice must not paint a panel");
  assert.equal(/border/.test(greetingOnly), false, "the notice must not add a border");
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
