/**
 * Tarkov beta-warning banner.
 *
 * Design language adapted from dsh-theme-tarkov (MIT): translucent orange band,
 * dark hexagonal "!" badge, two lines of text. The *engineering* contract is
 * our own, because DSH's anchor (`[class*="_heroWorkspaceRow"]`) does not exist
 * in ZCode:
 *
 *  - The band is a child of `<body>`, inserted before `#root`. React only owns
 *    the `#root` subtree, so nothing here can collide with reconciliation.
 *  - Its height is exposed as `--zcode-tarkov-banner-height` and reserved by a
 *    `margin-top` on `#root` plus `height: calc(100dvh - <band>)` on `#root`
 *    and on the app's own `100dvh` shells (`.h-dvh`), so band + app root add up
 *    to the viewport exactly.
 *  - It is `position: fixed` + `-webkit-app-region: drag`, so the strip stays
 *    under the same window-drag behaviour the app's own title area has.
 *
 * Three modes, and the third is the one with a layout contract:
 *
 *  - `full`    — the v0.1 band: badge plus both lines, `opts.height` tall.
 *  - `compact` — one line, a fixed thin strip, for users who want the warning
 *                but not the footprint.
 *  - `off`     — **nothing is rendered and nothing is reserved.** The band is
 *                removed, the `data-zct-banner` attribute comes off `<html>`, so
 *                every reservation rule stops matching, and the height variable
 *                is explicitly pinned to `0px` rather than merely unset: an
 *                unset variable inside `calc()` is invalid at computed-value
 *                time, and a rule that silently keeps a stale length is exactly
 *                the "reserved but invisible" bug this mode has to avoid. With
 *                `0px` the app root, its `100dvh` shells, the composer and the
 *                bottom-left account area return to the no-banner geometry.
 *
 * Fail-soft rules: every DOM step is guarded, text writes are conditional (an
 * unconditional write mutates the tree and can re-trigger the observer in a
 * loop), the observer callback is debounced, and a missing anchor simply means
 * "no banner" — never a thrown error, never a blocked page.
 */

import { TARKOV_ACCENT, TARKOV_ACCENT_RGB, TARKOV_INK, TARKOV_INK_RGB } from "../themes/palette.js";
import { BANNER_MODES, type BannerMode } from "../prefs/types.js";

export const BANNER_ID = "zcode-tarkov-banner";
export const BANNER_STYLE_ID = "zcode-tarkov-banner-style";
/** Window-global holding the live banner handle, so re-injection is idempotent. */
export const BANNER_STATE_KEY = "__zcodeTarkovBanner";

/** The height of the `compact` strip. Fixed: it is a status bar, not a band. */
export const COMPACT_BANNER_HEIGHT = 28;

export interface BannerOptions {
  /** Whether the band is shown at all. Always false when `mode` is `off`. */
  enabled: boolean;
  /**
   * The accent to paint the band with, as `#rrggbb`, and the same value as an
   * `r, g, b` triple.
   *
   * Filled in from the resolved palette by `resolveBanner`. They are optional so
   * a caller that only cares about the band's shape (a test, the v0.1 routes)
   * gets the shipped accent without having to know about the palette at all.
   */
  accent?: string;
  accentRgb?: string;
  /**
   * Ink for the band's text. The band is the accent composited over the page, so
   * the readable ink depends on both colours and is measured by the palette;
   * without it the shipped ink is used.
   */
  accentInk?: string;
  /** `off`, `compact` or `full`. Authoritative over `enabled`. */
  mode: BannerMode;
  text1: string;
  text2: string;
  /** Reserved band height in px, used by `full`. */
  height: number;
  /** Band background alpha, 0-1. */
  opacity: number;
}

export const DEFAULT_BANNER_TEXT = {
  line1: "ATTENTION! ZCODE TACTICAL INTERFACE ACTIVE",
  line2:
    "Experimental interface. Verify your task, tool calls and working tree before deployment.",
};

export const DEFAULT_BANNER: BannerOptions = {
  enabled: true,
  mode: "full",
  text1: DEFAULT_BANNER_TEXT.line1,
  text2: DEFAULT_BANNER_TEXT.line2,
  height: 56,
  opacity: 0.92,
};

/** The band height a mode actually reserves. `off` reserves nothing. */
export function bannerHeight(opts: BannerOptions): number {
  if (opts.mode === "off") return 0;
  if (opts.mode === "compact") return COMPACT_BANNER_HEIGHT;
  return opts.height;
}

/**
 * Normalises anything to a known mode.
 *
 * **Any signal to hide the band wins.** The two fields are not a precedence
 * chain where the newer one always beats the older; they are two ways of saying
 * the same thing, and "off" from either is authoritative:
 *
 *  - a v0.1 caller sets `enabled: false` and knows nothing about `mode`, so
 *    honouring a `mode` that happens to sit alongside it would silently ignore
 *    the only field that caller set;
 *  - a v0.2 caller sets `mode: "off"` and may leave `enabled` at whatever the
 *    defaults put there.
 *
 * Treating them as a precedence chain in either direction gets one of those two
 * cases wrong. Contradictory input (`enabled: false` with `mode: "compact"`)
 * resolves to `off`, which is the reading that cannot surprise the user with a
 * band they asked to hide.
 */
export function resolveBannerMode(opts: Pick<BannerOptions, "mode" | "enabled">): BannerMode {
  if (opts.enabled === false) return "off";
  if (opts.mode && (BANNER_MODES as readonly string[]).includes(opts.mode)) return opts.mode;
  return "full";
}

export function buildBannerCss(opts: BannerOptions): string {
  const mode = resolveBannerMode(opts);
  const accentHex = opts.accent ?? TARKOV_ACCENT;
  const bandInk = opts.accentInk ?? TARKOV_INK;
  const accentTriple = opts.accentRgb ?? TARKOV_ACCENT_RGB;
  const height = bannerHeight(opts);
  return `
/* Single source of truth for the reserved band: BannerOptions.height. */
html[data-zct-banner="1"] { --zcode-tarkov-banner-height: ${height}px; }
/* Off means zero, not absent: an unset property would make every calc() below
   invalid rather than zero, which is how a band leaves a stale gap behind. */
html:not([data-zct-banner="1"]) { --zcode-tarkov-banner-height: 0px; }
/* flow-root keeps #root's margin-top from collapsing through the body; without
   it the whole body box moves down by the band and the document keeps the band
   height of scrollable overflow (measured on 3.11.2). */
html[data-zct-banner="1"] body { display: flow-root; }
/* #root is position: static in ZCode, so its space is reserved with a margin
   and its 100dvh height is reduced by the same band height. */
html[data-zct-banner="1"] #root {
  margin-top: var(--zcode-tarkov-banner-height);
  height: calc(100dvh - var(--zcode-tarkov-banner-height));
}
/* ZCode's app shells size themselves with the 100dvh utility, which does not
   shrink when #root does; without this they stay a full viewport tall and the
   bottom band of the UI (account area, composer) is clipped again. */
html[data-zct-banner="1"] .h-dvh {
  height: calc(100dvh - var(--zcode-tarkov-banner-height));
}
#${BANNER_ID} {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: ${height}px;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: ${mode === "compact" ? "10px" : "14px"};
  padding: 0 16px;
  background: rgba(${accentTriple}, ${opts.opacity});
  border-bottom: 1px solid rgba(${TARKOV_INK_RGB}, 0.45);
  z-index: 2147483000;
  overflow: hidden;
  user-select: none;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  /* Keeps the strip draggable, matching the app's own title region. */
  -webkit-app-region: drag;
}
#${BANNER_ID} .zct-banner-icon {
  width: ${mode === "compact" ? "22px" : "34px"};
  height: ${mode === "compact" ? "18px" : "28px"};
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  background: ${bandInk};
  color: ${accentHex};
  font: 800 ${mode === "compact" ? "12px" : "18px"}/1 system-ui, sans-serif;
  clip-path: polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%);
}
#${BANNER_ID} .zct-banner-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
#${BANNER_ID} .zct-banner-line1 {
  color: ${bandInk};
  font-weight: 700;
  font-size: ${mode === "compact" ? "11px" : "13px"};
  line-height: 1.35;
  letter-spacing: ${mode === "compact" ? "0.9px" : "1.2px"};
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
#${BANNER_ID} .zct-banner-line2 {
  color: ${bandInk};
  font-size: 12px;
  line-height: 1.35;
  letter-spacing: 0.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
`.trim();
}

/** Installs (or refreshes) the banner. Safe to evaluate repeatedly. */
export function buildBannerScript(opts: BannerOptions): string {
  const mode = resolveBannerMode(opts);
  return `(function(){
  var ID = ${JSON.stringify(BANNER_ID)};
  var STYLE_ID = ${JSON.stringify(BANNER_STYLE_ID)};
  var STATE_KEY = ${JSON.stringify(BANNER_STATE_KEY)};
  var CSS = ${JSON.stringify(buildBannerCss(opts))};
  var T1 = ${JSON.stringify(opts.text1)};
  var T2 = ${JSON.stringify(mode === "compact" ? "" : opts.text2)};
  var MODE = ${JSON.stringify(mode)};

  var previous = window[STATE_KEY];
  if (previous && typeof previous.destroy === 'function') {
    try { previous.destroy(); } catch (e) {}
  }

  var observer = null;
  var pollTimer = null;
  var scheduled = false;

  function ensureStyle() {
    try {
      var s = document.getElementById(STYLE_ID);
      if (!s) {
        s = document.createElement('style');
        s.id = STYLE_ID;
        (document.head || document.documentElement).appendChild(s);
      }
      if (s.textContent !== CSS) s.textContent = CSS;
    } catch (e) { /* fail soft */ }
  }

  function build() {
    var icon = document.createElement('span');
    icon.className = 'zct-banner-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '!';
    var l1 = document.createElement('span');
    l1.className = 'zct-banner-line1';
    l1.textContent = T1;
    var text = document.createElement('span');
    text.className = 'zct-banner-text';
    text.appendChild(l1);
    // The compact strip is one line by definition: the second span is not
    // created at all, rather than created and hidden, so nothing measurable is
    // left in the band.
    if (T2) {
      var l2 = document.createElement('span');
      l2.className = 'zct-banner-line2';
      l2.textContent = T2;
      text.appendChild(l2);
    }
    var node = document.createElement('div');
    node.id = ID;
    node.setAttribute('role', 'status');
    node.appendChild(icon);
    node.appendChild(text);
    return node;
  }

  function tick() {
    try {
      var body = document.body;
      if (!body) return;
      // The app shell only exists once React has mounted into #root; before
      // that there is nothing to sit above, so stay out of the way.
      var root = document.getElementById('root');
      if (!root || root.childElementCount === 0) { remove(); return; }

      var node = document.getElementById(ID);
      if (!node) {
        node = build();
        body.insertBefore(node, body.firstChild);
      } else if (node.parentNode !== body || body.firstChild !== node) {
        body.insertBefore(node, body.firstChild);
      }
      document.documentElement.setAttribute('data-zct-banner', '1');
      // Clear any inline compensation an earlier build wrote. Inline outranks
      // the author rule below, so a stale "0px" left on <html> would keep the
      // reservation at zero while the band is showing — the band would then
      // paint over the app's top strip instead of above it.
      if (document.documentElement.style.getPropertyValue('--zcode-tarkov-banner-height') !== '') {
        document.documentElement.style.removeProperty('--zcode-tarkov-banner-height');
      }

      // Conditional writes only: assigning textContent unconditionally
      // replaces the text node, which mutates the tree, which re-triggers the
      // observer that called us.
      var l1 = node.querySelector('.zct-banner-line1');
      if (l1 && l1.textContent !== T1) l1.textContent = T1;
      var l2 = node.querySelector('.zct-banner-line2');
      if (l2 && T2 && l2.textContent !== T2) l2.textContent = T2;
    } catch (e) { /* fail soft */ }
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    var run = function () { scheduled = false; tick(); };
    if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(run);
    else window.setTimeout(run, 50);
  }

  function remove() {
    try {
      var existing = document.getElementById(ID);
      if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
      document.documentElement.removeAttribute('data-zct-banner');
    } catch (e) { /* fail soft */ }
  }

  function destroy() {
    try { if (observer) observer.disconnect(); } catch (e) {}
    if (pollTimer !== null) { try { window.clearInterval(pollTimer); } catch (e) {} pollTimer = null; }
    remove();
    try {
      var s = document.getElementById(STYLE_ID);
      if (s && s.parentNode) s.parentNode.removeChild(s);
    } catch (e) {}
    if (window[STATE_KEY] && window[STATE_KEY].destroy === destroy) window[STATE_KEY] = null;
  }

  ensureStyle();
  try {
    if (typeof MutationObserver === 'function') {
      observer = new MutationObserver(schedule);
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }
  } catch (e) { observer = null; }

  if (observer === null) {
    // Short-lived fallback poll; bounded so a page that never mounts cannot
    // leave a timer running forever.
    var attempts = 0;
    pollTimer = window.setInterval(function () {
      tick();
      attempts += 1;
      if (attempts > 60) { try { window.clearInterval(pollTimer); } catch (e) {} pollTimer = null; }
    }, 1000);
  }

  window[STATE_KEY] = { refresh: tick, destroy: destroy, mode: MODE };
  tick();
})();`;
}

/** Removes the banner and releases its observer/timers and its reserved space. */
export function buildBannerTeardownScript(): string {
  return `(function(){
  var STATE_KEY = ${JSON.stringify(BANNER_STATE_KEY)};
  var STYLE_ID = ${JSON.stringify(BANNER_STYLE_ID)};
  var st = window[STATE_KEY];
  if (st && typeof st.destroy === 'function') {
    try { st.destroy(); } catch (e) {}
  }
  try {
    var n = document.getElementById(${JSON.stringify(BANNER_ID)});
    if (n && n.parentNode) n.parentNode.removeChild(n);
    document.documentElement.removeAttribute('data-zct-banner');
    // Any inline value a previous build wrote is cleared: inline outranks the
    // author rule below, so a stale one would keep the reservation wrong.
    document.documentElement.style.removeProperty('--zcode-tarkov-banner-height');
    // The stylesheet is *not* removed. Removing it was what left the variable
    // undefined rather than zero, and "undefined" is not the same as "no space":
    // any remaining reader of the property — the pet, which keeps itself clear
    // of the band — gets an empty string and has to guess. A single rule keeps
    // the answer explicit while every reservation rule, being scoped to the
    // attribute just removed, stays inert.
    var s = document.getElementById(STYLE_ID);
    if (!s) {
      s = document.createElement('style');
      s.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(s);
    }
    var zero = 'html:not([data-zct-banner="1"]) { --zcode-tarkov-banner-height: 0px; }';
    if (s.textContent !== zero) s.textContent = zero;
  } catch (e) {}
})();`;
}
