/**
 * The stylesheet for every piece of UI this project injects into the renderer.
 *
 * One stylesheet, one root element, one set of custom properties. The dock, the
 * pet, its context menu, the toast and the settings centre are all painted from
 * the variables declared here, and switching between the neutral skin and the
 * Tarkov skin is a single `data-zct-theme="tarkov"` attribute on the root —
 * the same trick the v0.1 panel used, kept because it is what makes "leave
 * Tarkov mode" restore the neutral look with no leftover state.
 *
 * Two hard rules, both learned from v0.1 bugs:
 *
 *  1. **Nothing lives in normal flow.** Every surface is `position: fixed`. The
 *     v0.1 status toast was the only in-flow child of a fixed root, so the root
 *     shrink-wrapped it and the whole thing landed off-screen; a fixed-position
 *     child of a fixed root has the same problem, which is why the toast is
 *     itself fixed.
 *  2. **The app's own layout is never touched.** No global element selectors, no
 *     `body { … }` rules. The one exception is the banner's reservation, which
 *     lives in `core/banner.ts` and is scoped to an attribute the banner sets.
 *
 * Stacking order, from the bottom: wallpaper (-2147483646), banner (…483000),
 * pet (…483100), dock (…483200), context menu (…483300), toast (…483400),
 * settings centre (2147483647).
 */

import { TARKOV_ACCENT, TARKOV_ACCENT_RGB, TARKOV_INK, TARKOV_INK_RGB } from "../../themes/palette.js";

/** The single root element every injected v0.2 surface is parented to. */
export const UI_ROOT_ID = "zct-ui-root";
export const UI_STYLE_ID = "zct-ui-style";

export const Z_TOAST = 2147483400;
export const Z_MENU = 2147483300;
export const Z_DOCK = 2147483200;
export const Z_PET = 2147483100;

export function buildUiCss(): string {
  return `
#${UI_ROOT_ID}, #${UI_ROOT_ID} * { box-sizing: border-box; }

#${UI_ROOT_ID} {
  /* --- neutral skin (Monet / Native) --- */
  --zct-bg: rgba(24, 24, 30, .9);
  --zct-bg-solid: rgb(26, 26, 32);
  --zct-border: rgba(255, 255, 255, .12);
  --zct-radius: 10px;
  --zct-radius-sm: 6px;
  --zct-radius-pill: 999px;
  --zct-text: #e8e8ea;
  --zct-subtle: rgba(255, 255, 255, .62);
  --zct-ctl-bg: rgba(255, 255, 255, .09);
  --zct-ctl-border: rgba(255, 255, 255, .14);
  --zct-ctl-hover: rgba(255, 255, 255, .16);
  --zct-accent: #7aa2f7;
  --zct-accent-soft: rgba(122, 162, 247, .22);
  --zct-on-accent: #14161c;
  --zct-shadow: 0 10px 34px rgba(0, 0, 0, .5);
  --zct-font: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  --zct-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;

  position: fixed;
  inset: auto;
  z-index: ${Z_DOCK};
  font-family: var(--zct-font);
  font-size: 12px;
  color: var(--zct-text);
  line-height: 1.45;
  /* The root is a positioning context only; it must never intercept clicks. */
  pointer-events: none;
}

#${UI_ROOT_ID}[data-zct-theme="tarkov"] {
  --zct-bg: rgba(26, 18, 10, .95);
  --zct-bg-solid: rgb(28, 20, 11);
  --zct-border: rgba(${TARKOV_ACCENT_RGB}, .45);
  --zct-radius: 4px;
  --zct-radius-sm: 3px;
  --zct-radius-pill: 3px;
  --zct-text: #e8d9c8;
  --zct-subtle: rgba(232, 217, 200, .58);
  --zct-ctl-bg: rgba(${TARKOV_ACCENT_RGB}, .14);
  --zct-ctl-border: rgba(${TARKOV_ACCENT_RGB}, .36);
  --zct-ctl-hover: rgba(${TARKOV_ACCENT_RGB}, .27);
  --zct-accent: ${TARKOV_ACCENT};
  --zct-accent-soft: rgba(${TARKOV_ACCENT_RGB}, .24);
  --zct-on-accent: ${TARKOV_INK};
  --zct-shadow: 0 10px 30px rgba(0, 0, 0, .66);
}

/* The Tarkov block re-reads the accent from the theme's own tokens rather than
   repeating the hex.
 *
 * The injected theme stylesheet publishes --tarkov-accent,
   --tarkov-accent-soft and --color-primary-foreground on <html>, and the service
   re-pushes it whenever the configuration changes. Deriving from those means a
   recoloured palette reaches the dock, the settings centre and the pet's menu
   with no JavaScript at all, and — just as importantly — that this block simply
   does not apply in Monet or Native mode, so a custom accent cannot leak into a
   mode that is not meant to have one.
 *
 * The accent itself needs no feature detection: it is a plain var() with a
 * literal fallback, so it follows a recolour wherever custom properties work at
 * all. The four *derived* values use color-mix(), and those live in their own
 * @supports block rather than as a second declaration beside the literal. That
 * distinction matters and is easy to get wrong: custom properties are not
 * parse-validated, so a later color-mix() declaration would win even in a
 * browser that cannot evaluate it, and the border shorthand that reads the
 * variable would then be invalid at computed-value time and the border would
 * vanish — a worse outcome than keeping the shipped colour. Inside @supports the
 * block is skipped entirely and the literals above stand. */
#${UI_ROOT_ID}[data-zct-theme="tarkov"] {
  --zct-accent: var(--tarkov-accent, ${TARKOV_ACCENT});
  --zct-accent-soft: var(--tarkov-accent-soft, rgba(${TARKOV_ACCENT_RGB}, .24));
  --zct-on-accent: var(--color-primary-foreground, ${TARKOV_INK});
}

@supports (color: color-mix(in srgb, red, blue)) {
  #${UI_ROOT_ID}[data-zct-theme="tarkov"] {
    --zct-border: color-mix(in srgb, var(--zct-accent) 45%, transparent);
    --zct-ctl-bg: color-mix(in srgb, var(--zct-accent) 14%, transparent);
    --zct-ctl-border: color-mix(in srgb, var(--zct-accent) 36%, transparent);
    --zct-ctl-hover: color-mix(in srgb, var(--zct-accent) 27%, transparent);
  }
}

#${UI_ROOT_ID} [hidden] { display: none !important; }

/* Every interactive surface opts back into pointer events. */
#${UI_ROOT_ID} .zct-surface { pointer-events: auto; }

#${UI_ROOT_ID} .zct-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  min-height: 24px;
  padding: 4px 11px;
  border-radius: var(--zct-radius-pill);
  background: var(--zct-ctl-bg);
  border: 1px solid var(--zct-ctl-border);
  color: inherit;
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
  white-space: nowrap;
  transition: background .12s ease, border-color .12s ease;
}
#${UI_ROOT_ID} .zct-btn:hover:not(:disabled) { background: var(--zct-ctl-hover); }
#${UI_ROOT_ID} .zct-btn:disabled { opacity: .45; cursor: default; }
#${UI_ROOT_ID} .zct-btn[data-variant="primary"] {
  background: var(--zct-accent);
  border-color: var(--zct-accent);
  color: var(--zct-on-accent);
  font-weight: 600;
}
#${UI_ROOT_ID} .zct-btn[data-variant="icon"] { padding: 3px 7px; min-width: 26px; }
#${UI_ROOT_ID} .zct-btn[data-state="on"] { border-color: var(--zct-accent); color: var(--zct-accent); }
#${UI_ROOT_ID} button:focus-visible,
#${UI_ROOT_ID} input:focus-visible,
#${UI_ROOT_ID} select:focus-visible,
#${UI_ROOT_ID} [tabindex]:focus-visible {
  outline: 2px solid var(--zct-accent);
  outline-offset: 1px;
}

#${UI_ROOT_ID} .zct-row { display: flex; align-items: center; gap: 8px; margin-bottom: 9px; }
#${UI_ROOT_ID} .zct-row > label { flex: 1; min-width: 0; color: var(--zct-subtle); }
#${UI_ROOT_ID} .zct-row .zct-value { color: var(--zct-text); font-variant-numeric: tabular-nums; }

#${UI_ROOT_ID} input[type="range"] {
  width: 100%; margin: 0; height: 16px; cursor: pointer;
  accent-color: var(--zct-accent);
  background: transparent;
}
#${UI_ROOT_ID} input[type="checkbox"] { accent-color: var(--zct-accent); cursor: pointer; }
#${UI_ROOT_ID} select,
#${UI_ROOT_ID} input[type="text"] {
  width: 100%; padding: 4px 6px; border-radius: var(--zct-radius-sm);
  background: var(--zct-ctl-bg); border: 1px solid var(--zct-ctl-border);
  color: inherit; font: inherit; font-size: 11.5px;
}
#${UI_ROOT_ID} select option { color: #111; }

/* --- sections ----------------------------------------------------------- */
#${UI_ROOT_ID} .zct-section { margin-bottom: 12px; }
#${UI_ROOT_ID} .zct-section > h4 {
  margin: 0 0 7px; font-size: 10.5px; font-weight: 700;
  letter-spacing: 1.1px; text-transform: uppercase; color: var(--zct-accent);
}

/* --- surfaces ----------------------------------------------------------- */
#${UI_ROOT_ID} .zct-card {
  background: var(--zct-bg);
  border: 1px solid var(--zct-border);
  border-radius: var(--zct-radius);
  box-shadow: var(--zct-shadow);
  backdrop-filter: blur(16px);
}

/* --- toast -------------------------------------------------------------- */
#zct-toast {
  position: fixed; right: 62px; bottom: 24px; z-index: ${Z_TOAST};
  max-width: min(360px, calc(100vw - 110px));
  padding: 5px 11px; border-radius: var(--zct-radius-sm);
  background: var(--zct-bg); border: 1px solid var(--zct-border);
  color: var(--zct-text); box-shadow: var(--zct-shadow);
  backdrop-filter: blur(10px);
  font-size: 11px; overflow-wrap: anywhere;
  pointer-events: none; opacity: .97;
}
#zct-toast:empty { display: none; }

/* --- BGM dock ----------------------------------------------------------- */
#zct-dock-fab {
  position: fixed; right: 58px; bottom: 18px; z-index: ${Z_DOCK};
  width: 34px; height: 34px;
  display: flex; align-items: center; justify-content: center;
  border-radius: var(--zct-radius-pill);
  background: var(--zct-bg); border: 1px solid var(--zct-border);
  color: var(--zct-text); cursor: pointer; font-size: 15px; line-height: 1;
  box-shadow: 0 2px 12px rgba(0, 0, 0, .35);
  backdrop-filter: blur(10px);
  user-select: none;
}
#zct-dock-fab:hover { background: var(--zct-ctl-hover); }
#zct-dock-fab[data-playing="1"] { border-color: var(--zct-accent); color: var(--zct-accent); }
#zct-dock-fab[data-locked="1"]::after {
  content: "🔒"; position: absolute; right: -3px; bottom: -3px; font-size: 9px;
}

/* The settings centre's launcher is styled by the panel itself (#zct-panel-fab),
   not here. It sits in the corner the v0.1 panel's button used and keeps that
   button's 38 px geometry, while this dock's launcher is deliberately smaller
   and offset beside it — so the two shapes are defined where each is owned
   rather than forced through one shared rule. */

#zct-dock {
  position: fixed; right: 18px; bottom: 60px; z-index: ${Z_DOCK};
  width: 268px; padding: 10px 12px 11px;
}
#zct-dock-head { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
#zct-dock-title {
  flex: 1; min-width: 0; font-weight: 600; font-size: 12px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
#zct-dock-sub { color: var(--zct-subtle); font-size: 10.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#zct-dock-controls { display: flex; align-items: center; justify-content: center; gap: 6px; margin: 8px 0 6px; }
#zct-dock-progress { display: flex; align-items: center; gap: 7px; color: var(--zct-subtle); font-size: 10px; font-variant-numeric: tabular-nums; }
#zct-dock-progress input[type="range"] { flex: 1; }
#zct-dock-empty { color: var(--zct-subtle); font-size: 11px; line-height: 1.5; text-align: center; padding: 6px 0 2px; }
#zct-dock-empty code { font-family: var(--zct-mono); font-size: 10px; background: var(--zct-ctl-bg); padding: 1px 4px; border-radius: 3px; user-select: text; }
#zct-dock-locked { color: var(--zct-accent); font-size: 11px; text-align: center; padding: 4px 0 2px; }

/* --- pet ---------------------------------------------------------------- */
#zct-pet {
  position: fixed; z-index: ${Z_PET};
  width: 84px; cursor: grab; user-select: none;
  -webkit-user-select: none; touch-action: none;
  filter: drop-shadow(0 6px 14px rgba(0, 0, 0, .55));
  transition: transform .12s ease;
}
#zct-pet:hover { transform: translateY(-2px); }
#zct-pet[data-dragging="1"] { cursor: grabbing; transition: none; }
#zct-pet img, #zct-pet svg { display: block; width: 100%; height: auto; pointer-events: none; }

/* The built-in SVG carries the shipped colours as presentation attributes and
   these classes on top. A CSS rule beats a presentation attribute, so the pet
   takes the live palette whenever the stylesheet is present and still renders
   sensibly if it is not — which is what lets a recoloured accent reach an
   inline illustration without shipping a second copy of it. */
#zct-pet .zct-pet-accent { fill: var(--zct-accent); }
#zct-pet .zct-pet-accent-stroke { stroke: var(--zct-accent); }
#zct-pet .zct-pet-ink { fill: var(--zct-on-accent); }
#zct-pet .zct-pet-ink-stroke { stroke: var(--zct-on-accent); }
#zct-pet .zct-pet-accent-soft-stroke { stroke: var(--zct-accent-soft); }

#zct-pet-menu {
  position: fixed; z-index: ${Z_MENU};
  min-width: 172px; padding: 4px;
  background: var(--zct-bg-solid);
  border: 1px solid var(--zct-border);
  border-radius: var(--zct-radius);
  box-shadow: var(--zct-shadow);
}
#zct-pet-menu .zct-menu-item {
  display: block; width: 100%; padding: 5px 9px;
  border: 0; background: transparent; color: inherit;
  font: inherit; font-size: 11.5px; text-align: left; cursor: pointer;
  border-radius: var(--zct-radius-sm);
}
#zct-pet-menu .zct-menu-item:hover,
#zct-pet-menu .zct-menu-item:focus-visible { background: var(--zct-ctl-hover); outline: none; }
#zct-pet-menu .zct-menu-sep { height: 1px; margin: 4px 2px; background: var(--zct-border); }

/* --- settings centre ---------------------------------------------------- */
#zct-panel {
  position: fixed; right: 18px; bottom: 60px; z-index: 2147483647;
  width: 316px; max-height: min(78vh, 660px);
  display: flex; flex-direction: column;
  padding: 0; overflow: hidden;
}
#zct-panel-head {
  display: flex; align-items: center; gap: 8px;
  padding: 9px 11px; border-bottom: 1px solid var(--zct-border);
  cursor: move; user-select: none; flex: none;
}
#zct-panel-head strong { flex: 1; font-size: 12px; font-weight: 600; letter-spacing: .3px; }
#zct-panel-tabs { display: flex; gap: 2px; padding: 6px 8px 0; flex: none; flex-wrap: wrap; }
#zct-panel-tabs button {
  flex: 1; min-width: 54px; padding: 5px 4px;
  border: 0; border-bottom: 2px solid transparent; background: transparent;
  color: var(--zct-subtle); font: inherit; font-size: 11px; cursor: pointer;
  border-radius: var(--zct-radius-sm) var(--zct-radius-sm) 0 0;
}
#zct-panel-tabs button:hover { color: var(--zct-text); }
#zct-panel-tabs button[aria-selected="true"] {
  color: var(--zct-text); font-weight: 600;
  border-bottom-color: var(--zct-accent);
  background: var(--zct-accent-soft);
}
#zct-panel-body { padding: 11px 12px 12px; overflow-y: auto; flex: 1 1 auto; min-height: 0; }
#zct-panel-body::-webkit-scrollbar { width: 8px; }
#zct-panel-body::-webkit-scrollbar-thumb { background: var(--zct-ctl-border); border-radius: 4px; }
#zct-panel-foot {
  flex: none; padding: 7px 11px; border-top: 1px solid var(--zct-border);
  color: var(--zct-subtle); font-size: 10px;
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
}
#zct-panel-offline {
  display: flex; flex-direction: column; gap: 6px; align-items: center;
  margin: 11px 12px; padding: 10px 12px; text-align: center;
  background: rgba(120, 53, 15, .5); border-radius: var(--zct-radius-sm);
  font-size: 11px; line-height: 1.5;
}
#zct-panel[data-offline="1"] #zct-panel-body { opacity: .45; pointer-events: none; }
#zct-panel[data-offline="1"] #zct-panel-foot { opacity: .5; }

/* --- library list ------------------------------------------------------- */
#zct-tracks { display: flex; flex-direction: column; gap: 2px; max-height: 208px; overflow-y: auto; margin-bottom: 8px; }
#zct-tracks .zct-track {
  display: flex; align-items: center; gap: 6px;
  padding: 3px 5px; border-radius: var(--zct-radius-sm);
}
#zct-tracks .zct-track:hover { background: var(--zct-accent-soft); }
#zct-tracks .zct-track[data-current="1"] { box-shadow: inset 2px 0 0 var(--zct-accent); }
#zct-tracks .zct-track-name {
  flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  cursor: pointer; font-size: 11.5px;
}
#zct-tracks .zct-track[data-disabled="1"] .zct-track-name { opacity: .45; text-decoration: line-through; }
#zct-tracks .zct-track-meta { color: var(--zct-subtle); font-size: 10px; font-variant-numeric: tabular-nums; }
#zct-empty-note { color: var(--zct-subtle); font-size: 11px; line-height: 1.55; margin-bottom: 8px; }
#zct-empty-note code { font-family: var(--zct-mono); font-size: 10px; background: var(--zct-ctl-bg); padding: 1px 3px; border-radius: 3px; user-select: text; }

#zct-upload-bar { height: 3px; border-radius: 2px; background: var(--zct-ctl-bg); overflow: hidden; margin-bottom: 7px; }
#zct-upload-bar > i { display: block; height: 100%; width: 0; background: var(--zct-accent); transition: width .15s ease; }

/* --- system ------------------------------------------------------------- */
#zct-system dl { display: grid; grid-template-columns: auto 1fr; gap: 3px 9px; margin: 0 0 8px; }
#zct-system dt { color: var(--zct-subtle); }
#zct-system dd { margin: 0; overflow-wrap: anywhere; font-family: var(--zct-mono); font-size: 10px; user-select: text; }
#zct-system .zct-warn { color: var(--zct-accent); font-size: 11px; line-height: 1.5; margin-bottom: 7px; }
`.trim();
}
