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
 * The reservation shape is measured, not assumed. On ZCode 3.11.2 the shipped
 * renderer CSS sets `#root { height: 100dvh; overflow: hidden }` on top of the
 * inline `html, body, #root { height: 100% }`, and the app shells inside it are
 * `height: 100dvh` too. A plain `body { padding-top }` therefore did not
 * reserve anything: it moved the app down by the band height while the 100dvh
 * boxes kept their full height, so the sidebar bottom, the composer and the
 * bottom-left account area ended up below the window and `#root` overflowed by
 * exactly the band height (56px on every tested width). `display: flow-root` on
 * the body keeps the `#root` margin from collapsing through it, which would
 * otherwise move the body box down and keep the document overflowing.
 *
 * Fail-soft rules: every DOM step is guarded, text writes are conditional (an
 * unconditional write mutates the tree and can re-trigger the observer in a
 * loop), the observer callback is debounced, and a missing anchor simply means
 * "no banner" — never a thrown error, never a blocked page.
 */

export const BANNER_ID = "zcode-tarkov-banner";
export const BANNER_STYLE_ID = "zcode-tarkov-banner-style";
/** Window-global holding the live banner handle, so re-injection is idempotent. */
export const BANNER_STATE_KEY = "__zcodeTarkovBanner";

export interface BannerOptions {
  enabled: boolean;
  text1: string;
  text2: string;
  /** Reserved band height in px. */
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
  text1: DEFAULT_BANNER_TEXT.line1,
  text2: DEFAULT_BANNER_TEXT.line2,
  height: 56,
  opacity: 0.92,
};

const ACCENT_RGB = "224, 121, 48";
const ACCENT = "#e07930";
const INK = "#1c1207";

export function buildBannerCss(opts: BannerOptions): string {
  return `
/* Single source of truth for the reserved band: BannerOptions.height. */
html[data-zct-banner="1"] { --zcode-tarkov-banner-height: ${opts.height}px; }
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
  height: ${opts.height}px;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 0 16px;
  background: rgba(${ACCENT_RGB}, ${opts.opacity});
  border-bottom: 1px solid rgba(28, 18, 7, 0.45);
  z-index: 2147483000;
  overflow: hidden;
  user-select: none;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  /* Keeps the strip draggable, matching the app's own title region. */
  -webkit-app-region: drag;
}
#${BANNER_ID} .zct-banner-icon {
  width: 34px;
  height: 28px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  background: ${INK};
  color: ${ACCENT};
  font: 800 18px/1 system-ui, sans-serif;
  clip-path: polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%);
}
#${BANNER_ID} .zct-banner-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
#${BANNER_ID} .zct-banner-line1 {
  color: ${INK};
  font-weight: 700;
  font-size: 13px;
  line-height: 1.35;
  letter-spacing: 1.2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
#${BANNER_ID} .zct-banner-line2 {
  color: ${INK};
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
  return `(function(){
  var ID = ${JSON.stringify(BANNER_ID)};
  var STYLE_ID = ${JSON.stringify(BANNER_STYLE_ID)};
  var STATE_KEY = ${JSON.stringify(BANNER_STATE_KEY)};
  var CSS = ${JSON.stringify(buildBannerCss(opts))};
  var T1 = ${JSON.stringify(opts.text1)};
  var T2 = ${JSON.stringify(opts.text2)};

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
    var l2 = document.createElement('span');
    l2.className = 'zct-banner-line2';
    l1.textContent = T1;
    l2.textContent = T2;
    var text = document.createElement('span');
    text.className = 'zct-banner-text';
    text.appendChild(l1);
    text.appendChild(l2);
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

      // Conditional writes only: assigning textContent unconditionally
      // replaces the text node, which mutates the tree, which re-triggers the
      // observer that called us.
      var l1 = node.querySelector('.zct-banner-line1');
      if (l1 && l1.textContent !== T1) l1.textContent = T1;
      var l2 = node.querySelector('.zct-banner-line2');
      if (l2 && l2.textContent !== T2) l2.textContent = T2;
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

  window[STATE_KEY] = { refresh: tick, destroy: destroy };
  tick();
})();`;
}

/** Removes the banner and releases its observer/timers. */
export function buildBannerTeardownScript(): string {
  return `(function(){
  var STATE_KEY = ${JSON.stringify(BANNER_STATE_KEY)};
  var st = window[STATE_KEY];
  if (st && typeof st.destroy === 'function') {
    try { st.destroy(); } catch (e) {}
  }
  try {
    var n = document.getElementById(${JSON.stringify(BANNER_ID)});
    if (n && n.parentNode) n.parentNode.removeChild(n);
    var s = document.getElementById(${JSON.stringify(BANNER_STYLE_ID)});
    if (s && s.parentNode) s.parentNode.removeChild(s);
    document.documentElement.removeAttribute('data-zct-banner');
  } catch (e) {}
})();`;
}
