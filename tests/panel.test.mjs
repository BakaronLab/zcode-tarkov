// Settings-panel generation: the UI Theme selector and the Tarkov panel skin.
import test from "node:test";
import assert from "node:assert/strict";

import { buildPanelScript, PANEL_ROOT_ID } from "../.test-build/panel/panelScript.js";

const script = buildPanelScript(9223, "test-token");

test("the panel offers exactly the three documented theme modes", () => {
  assert.match(script, /id="zb-theme"/);
  for (const mode of ["monet", "tarkov", "native"]) {
    assert.match(script, new RegExp(`<option value="${mode}">`), `missing ${mode} option`);
  }
});

test("existing controls are preserved alongside the new selector", () => {
  for (const id of [
    "zb-blur",
    "zb-dim",
    "zb-vis",
    "zb-fit",
    "zb-file",
    "zb-reset",
    "zb-recovery",
    "zb-relaunch",
    "zb-retry",
    "zb-close",
    "zb-fab",
  ]) {
    assert.match(script, new RegExp(`id="${id}"`), `control ${id} was dropped`);
  }
});

test("the legacy monet checkbox is replaced, not duplicated", () => {
  assert.equal(script.includes('id="zb-monet"'), false);
  assert.equal(script.includes("zb-monet"), false);
});

test("theme changes are pushed to the API as colorMode", () => {
  assert.match(script, /colorMode: \$\('zb-theme'\)\.value/);
  assert.match(script, /\$\('zb-theme'\)\.addEventListener\('change'/);
});

test("panel skin is driven by one attribute on the root element", () => {
  assert.match(script, new RegExp(PANEL_ROOT_ID));
  assert.match(script, /root\.setAttribute\('data-zb-theme', 'tarkov'\)/);
  assert.match(script, /root\.removeAttribute\('data-zb-theme'\)/);
});

test("the Tarkov skin uses the deep-brown/orange palette and smaller radii", () => {
  assert.match(script, /\[data-zb-theme="tarkov"\] \{/);
  assert.match(script, /--zb-bg: rgba\(26,18,10,\.94\)/);
  assert.match(script, /--zb-accent: #e07930/);
  assert.match(script, /--zb-text: #e8d9c8/);
  assert.match(script, /--zb-radius: 4px/);
  assert.match(script, /--zb-radius-pill: 3px/);
});

test("the neutral skin remains the default so Monet/Native look unchanged", () => {
  assert.match(script, /--zb-accent: #7aa2f7/);
  assert.match(script, /--zb-radius: 12px/);
  assert.match(script, /--zb-radius-pill: 999px/);
});

test("panel refresh reports the served mode, tolerating an older service", () => {
  assert.match(script, /var mode = c\.colorMode \|\| \(c\.monet \? 'monet' : 'native'\);/);
  assert.match(script, /applyPanelSkin\(mode\)/);
});

test("going offline resets the selector instead of showing a stale mode", () => {
  assert.match(script, /\$\('zb-theme'\)\.value = 'monet';/);
  assert.match(script, /applyPanelSkin\('monet'\)/);
});

test("the panel always rebuilds itself, so a stale copy cannot shadow it", () => {
  assert.match(script, /var stale = document\.getElementById\(ROOT_ID\);/);
  assert.match(script, /if \(stale\) stale\.remove\(\);/);
});

test("blur/dim still drive the shared dim variable and local preview", () => {
  assert.match(script, /setProperty\('--zcode-beautify-dim'/);
});

// The status line used to be the root's only in-flow child. With the root at
// `position: fixed; inset: auto` the root then shrink-wrapped to the 24x14
// status box and, as a fixed box with auto insets, took its static position at
// the very end of the document: measured 14px below the viewport (painted
// bottom 835.14 at innerHeight 821) in Tarkov and Native alike, so every
// `status(msg)` message was written to an invisible element. These tests pin
// the fix: the status is viewport-pinned on the panel surface, an empty status
// paints nothing, and every root child is positioned, so the root can no
// longer leave a painted box at the document end.
function cssRuleBody(source, selector, predicate) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(esc + "\\s*\\{([^}]*)\\}", "g");
  for (const match of source.matchAll(re)) {
    if (!predicate || predicate.test(match[1])) return match[1];
  }
  return null;
}

test("the status line is positioned inside the viewport, not left at the document end", () => {
  const body = cssRuleBody(script, "#zb-status", /position:/);
  assert.ok(body, "a #zb-status rule with a position declaration is missing");
  assert.match(body, /position:\s*fixed/, "#zb-status must be taken out of normal flow");
  assert.match(body, /right:\s*62px/, "#zb-status must be anchored to the viewport");
  assert.match(body, /bottom:\s*24px/, "#zb-status must be anchored to the viewport");
  assert.match(body, /background:\s*var\(--zb-bg\)/, "the status must wear the panel surface");
  assert.match(body, /border-radius:\s*var\(--zb-radius-sm\)/);
  assert.match(body, /color:\s*var\(--zb-text\)/);
  assert.match(body, /padding:\s*4px 10px/);
});

test("the panel root cannot leave a painted box at the document end", () => {
  const root = cssRuleBody(script, "#zcode-beautify-panel-root", /position:\s*fixed/);
  assert.ok(root, "the root must stay position: fixed");
  assert.match(root, /inset:\s*auto/);
  for (const id of ["zb-fab", "zb-panel", "zb-status"]) {
    const body = cssRuleBody(script, `#${id}`, /position:/);
    assert.ok(body, `#${id} has no position declaration`);
    assert.match(body, /position:\s*fixed/, `#${id} would flow inside the root and push its box to the document end`);
  }
});

test("an empty status line paints nothing", () => {
  assert.match(script, /#zb-status:empty\s*\{\s*display:\s*none/);
});

// The script is also registered with Page.addScriptToEvaluateOnNewDocument,
// where it runs before the document exists at all (measured on ZCode 3.11.2:
// readyState "loading", documentElement/head/body null). The old unconditional
// document.body.appendChild(root) threw there, so the panel was silently
// missing from every document created after the service attached. The build
// now lives in install(), which runs immediately when a body exists and on
// DOMContentLoaded otherwise.
test("the panel is built only once the document has a body", () => {
  assert.match(script, /function install\(\) \{/);
  assert.match(script, /if \(document\.body\) install\(\);/);
  assert.match(script, /document\.addEventListener\('DOMContentLoaded', function \(\) \{ install\(\); \}, \{ once: true \}\)/);
  const installAt = script.indexOf("function install() {");
  const styleAt = script.indexOf("var style = document.createElement('style');");
  const rootAppendAt = script.indexOf("document.body.appendChild(root);");
  assert.ok(installAt >= 0, "install() is missing");
  assert.ok(styleAt > installAt, "the panel build must live inside install()");
  assert.ok(rootAppendAt > styleAt, "the panel root mount must live inside install()");
});

test("the generated panel script parses as JavaScript", () => {
  assert.doesNotThrow(() => new Function(script), "the generated script must be syntactically valid");
});
