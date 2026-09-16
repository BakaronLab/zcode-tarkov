// Banner script generation: install, teardown, and the fail-soft contract.
import test from "node:test";
import assert from "node:assert/strict";

import {
  BANNER_ID,
  BANNER_STYLE_ID,
  BANNER_STATE_KEY,
  DEFAULT_BANNER,
  DEFAULT_BANNER_TEXT,
  buildBannerCss,
  buildBannerScript,
  buildBannerTeardownScript,
} from "../.test-build/core/banner.js";
import { buildBootstrapScript } from "../.test-build/core/cdp.js";
import { DEFAULT_CONFIG } from "../.test-build/core/inject.js";

test("default banner text is the project's own, not the DSH copy", () => {
  assert.equal(DEFAULT_BANNER_TEXT.line1, "ATTENTION! ZCODE TACTICAL INTERFACE ACTIVE");
  assert.equal(
    DEFAULT_BANNER_TEXT.line2,
    "Experimental interface. Verify your task, tool calls and working tree before deployment."
  );
  assert.equal(DEFAULT_BANNER.enabled, true);
});

test("banner text is configurable rather than baked into the markup", () => {
  const script = buildBannerScript({ ...DEFAULT_BANNER, text1: "CUSTOM ONE", text2: "CUSTOM TWO" });
  assert.match(script, /CUSTOM ONE/);
  assert.match(script, /CUSTOM TWO/);
  assert.equal(script.includes(DEFAULT_BANNER_TEXT.line1), false);
});

test("text is supplied as a JSON literal, so quotes cannot break the injected script", () => {
  const nasty = `He said "hi" \\ and 'bye'`;
  const script = buildBannerScript({ ...DEFAULT_BANNER, text1: nasty });
  // The text must appear in escaped JSON form — a raw interpolation would let a
  // quote in the configured text terminate the string and break the script.
  assert.ok(script.includes(JSON.stringify(nasty)), "text must be embedded as a JSON literal");
});

test("banner CSS carries the Tarkov band design", () => {
  const css = buildBannerCss(DEFAULT_BANNER);
  assert.match(css, new RegExp(`#${BANNER_ID}`));
  assert.match(css, /224, 121, 48/, "translucent orange band");
  assert.match(css, /clip-path:\s*polygon\(25% 0%,\s*75% 0%/, "hexagonal badge");
  assert.match(css, /-webkit-app-region: drag/, "the strip stays draggable");
});

test("banner CSS reserves space only while the banner is mounted", () => {
  const css = buildBannerCss(DEFAULT_BANNER);
  assert.match(css, /html\[data-zct-banner="1"\] body \{ padding-top: 56px; \}/);
  assert.equal(css.includes("body { padding-top:"), true);
  // Scoped to the attribute, so removing the banner restores the layout.
  assert.equal(/^body \{ padding-top/m.test(css), false);
});

test("install script uses a MutationObserver over the app root", () => {
  const script = buildBannerScript(DEFAULT_BANNER);
  assert.match(script, /new MutationObserver/);
  assert.match(script, /observer\.observe\(document\.documentElement/);
  assert.match(script, /childList: true, subtree: true/);
});

test("install script anchors on #root and inserts before it as a body child", () => {
  const script = buildBannerScript(DEFAULT_BANNER);
  assert.match(script, /getElementById\('root'\)/);
  assert.match(script, /childElementCount === 0/);
  assert.match(script, /body\.insertBefore\(node, body\.firstChild\)/);
  // React owns #root; the banner must never be inserted inside it.
  assert.equal(/root\.appendChild/.test(script), false);
});

test("text writes are guarded so the observer cannot feed back into itself", () => {
  const script = buildBannerScript(DEFAULT_BANNER);
  assert.match(script, /if \(l1 && l1\.textContent !== T1\) l1\.textContent = T1;/);
  assert.match(script, /if \(l2 && l2\.textContent !== T2\) l2\.textContent = T2;/);
  // The observer callback is debounced rather than re-entrant.
  assert.match(script, /if \(scheduled\) return;/);
});

test("install script is idempotent: a previous instance is destroyed first", () => {
  const script = buildBannerScript(DEFAULT_BANNER);
  assert.match(script, new RegExp(BANNER_STATE_KEY));
  assert.match(script, /previous\.destroy/);
  assert.match(script, /var node = document\.getElementById\(ID\);/);
});

test("install script fails soft: no anchor means no banner, never a throw", () => {
  const script = buildBannerScript(DEFAULT_BANNER);
  assert.match(script, /if \(!body\) return;/);
  assert.match(script, /if \(!root \|\| root\.childElementCount === 0\) \{ remove\(\); return; \}/);
  // Every DOM step is wrapped.
  assert.ok((script.match(/catch \(e\)/g) ?? []).length >= 5, "expected broad try/catch coverage");
});

test("the fallback poll is bounded so it cannot run forever", () => {
  const script = buildBannerScript(DEFAULT_BANNER);
  assert.match(script, /attempts > 60/);
  assert.match(script, /clearInterval/);
});

test("teardown removes the node, the style, the attribute and the observer", () => {
  const script = buildBannerTeardownScript();
  assert.match(script, new RegExp(BANNER_ID));
  assert.match(script, new RegExp(BANNER_STYLE_ID));
  assert.match(script, /removeAttribute\('data-zct-banner'\)/);
  assert.match(script, /st\.destroy\(\)/);
});

test("bootstrap installs the banner only when one is configured", () => {
  const common = { css: "/*css*/", wallpaperDataUri: undefined, fit: "cover" };

  const withBanner = buildBootstrapScript({ ...common, banner: DEFAULT_BANNER });
  assert.match(withBanner, /new MutationObserver/);
  assert.match(withBanner, /ATTENTION! ZCODE TACTICAL INTERFACE ACTIVE/);

  const without = buildBootstrapScript({ ...common, banner: null });
  assert.equal(without.includes("MutationObserver"), false);
  assert.match(without, new RegExp(BANNER_ID), "must still tear down a stale banner");
});

test("the banner survives the theme early-return that skips identical CSS", () => {
  const script = buildBootstrapScript({ css: "/*css*/", banner: DEFAULT_BANNER });
  // The theme block returns early when the CSS is unchanged (the CSS is inlined
  // as a literal, so the guard compares against that literal)...
  assert.match(script, /if \(window\.__zcodeBeautify\.cssText === .*\) return;/);
  // ...and the banner block runs after it, so it is still evaluated.
  assert.ok(
    script.indexOf("new MutationObserver") > script.indexOf("window.__zcodeBeautify.cssText ==="),
    "banner must be emitted after the early-returning theme block"
  );
});

test("banner defaults stay in sync with the shipped config default", () => {
  assert.deepEqual(DEFAULT_CONFIG.banner, DEFAULT_BANNER);
});
