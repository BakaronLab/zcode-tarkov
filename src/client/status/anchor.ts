/**
 * The DOM half of the status-text takeover.
 *
 * ZCode's status line is React-owned. Writing to it would be overwritten on the
 * next render, and the write itself mutates the tree — which any page-level
 * `MutationObserver` sees, including the one this client installs to detect tool
 * calls. So the takeover is presentational only:
 *
 *   1. an attribute is set on the element, and
 *   2. a stylesheet rule hides the element's own glyphs without removing them
 *      from the DOM, while drawing the phrase over them from a CSS custom
 *      property.
 *
 * Nothing React owns is touched: the native text stays in the DOM (so anything
 * reading it, including assistive technology, still sees ZCode's real state),
 * the element keeps its size because the original text is made transparent
 * rather than `display: none`, and restoring is removing the attribute. There is
 * no state to unwind and no way to leave the app in a state it did not start in.
 *
 * ## Why this anchor is conservative, and why the feature is opt-in
 *
 * The line that carries the running status ("正在思考", the queue hint) was
 * investigated on a live ZCode 3.12.3 renderer and **its container has no stable
 * handle**: the leaves have no attributes at all, and the container above them
 * carries only hashed utility classes. The two obvious structural guesses are
 * both wrong, and the documentation records them as negative results —
 *
 *   - there is **no `aria-live` region** anywhere in the document except two
 *     1×1 px drag-and-drop announcers, so any `[aria-live="polite"]` selector
 *     matches nothing;
 *   - the two `role="status"` elements that do exist are `chat-loading` and
 *     those announcers, neither of which is the status line.
 *
 * A selector that silently matches nothing looks exactly like a selector that
 * works, which is the worst property a signal can have. So rather than ship a
 * plausible-looking guess, this anchor resolves the strip **structurally from
 * the one ancestor that is verified** — the composer — and refuses to act unless
 * the shape it expects is actually there. If ZCode changes, the takeover stops
 * happening; nothing else breaks.
 *
 * Because that structural resolution has never been confirmed end to end on a
 * real renderer, the status takeover ships **off by default** and is clearly
 * labelled in the settings centre. See `docs/dev/zcode-runtime-signals.md` §3.6
 * and §6 for the observation, and for the one command that would close the gap.
 */

import type { StatusAnchor } from "./runtime.js";

/** Attribute marking an element as carrying the takeover. */
export const STATUS_ATTR = "data-zct-status";
export const STATUS_STYLE_ID = "zct-status-style";

/**
 * The verified ancestor the strip is reached from.
 *
 * `[data-testid="v4-composer"]` is confirmed present in every observed state,
 * and the status strip is a descendant of it (the strip's text appears inside
 * the composer's subtree while a turn is running).
 */
export const COMPOSER_ANCHOR = '[data-testid="v4-composer"]';

/**
 * The largest amount of text a candidate may hold and still be the strip.
 *
 * The strip shows one short phrase. Its ancestors also hold the action row
 * ("停止生成") and the model selector, so a length bound is what separates "the
 * element that exists to show the status" from "an element that happens to
 * contain it". Measured on 3.12.3 the strip held 11 characters while its parent
 * held 38.
 */
export const MAX_STRIP_TEXT = 60;

/**
 * Attributes a candidate must NOT have to be a valid host.
 *
 * Every entry is a negative result from the live investigation, or a guard
 * against shadowing one of our own surfaces.
 */
function isUsableHost(el: HTMLElement, composer: Element): boolean {
  // Our own UI is injected into the same document and must never be a target.
  if (el.closest("#zct-ui-root")) return false;
  if (el.closest("#zcode-tarkov-banner")) return false;
  if (el.closest("#zcode-beautify-panel-root")) return false;
  // The composer's editable surface and its buttons are not status text.
  if (el.closest('input, textarea, button, [contenteditable="true"]')) return false;
  // The drag-and-drop announcers are the document's only aria-live regions and
  // are permanently empty; they are never the status line.
  if (el.id.startsWith("DndLiveRegion")) return false;
  // The app's boot spinner is also a role="status"; shadowing it would replace
  // the loading indicator with a tactical phrase.
  if (el.id === "loading") return false;
  // The candidate must be an ancestor-or-self of nothing outside the composer:
  // the strip lives inside the composer dock, so anything containing the
  // composer is too high in the tree.
  if (el.contains(composer)) return false;
  const text = (el.textContent ?? "").trim();
  if (text.length === 0 || text.length > MAX_STRIP_TEXT) return false;
  return true;
}

/**
 * Resolves the status strip from the composer anchor.
 *
 * Walks up from the deepest text-bearing elements inside the composer and
 * returns the **first ancestor that still holds only the status phrase** — i.e.
 * the highest element before the action row joins in. Returning a lower element
 * would shadow only one of the strip's leaves; returning a higher one would
 * shadow the buttons too.
 */
export function resolveStatusStrip(scope: ParentNode = document): HTMLElement | undefined {
  const composer = scope.querySelector(COMPOSER_ANCHOR);
  if (!composer) return undefined;

  // Collect the composer's text-bearing leaves, deepest first, so the walk
  // starts as close to the phrase as possible.
  const leaves: HTMLElement[] = [];
  try {
    for (const el of Array.from(composer.querySelectorAll<HTMLElement>("*"))) {
      if (el.childElementCount > 0) continue;
      const text = (el.textContent ?? "").trim();
      if (text.length === 0) continue;
      if (el.closest('input, textarea, button, [contenteditable="true"]')) continue;
      leaves.push(el);
    }
  } catch {
    return undefined;
  }

  for (const leaf of leaves) {
    let node: HTMLElement | null = leaf;
    let candidate: HTMLElement | undefined;
    // Walk up while the ancestor still holds only strip-sized text; the last one
    // that qualifies is the strip container.
    for (let i = 0; i < 6 && node; i += 1) {
      if (isUsableHost(node, composer)) candidate = node;
      else break;
      node = node.parentElement;
    }
    if (candidate) return candidate;
  }
  return undefined;
}

/** The stylesheet the takeover uses. Installed once, removed on dispose. */
function buildCss(): string {
  return `
[${STATUS_ATTR}="1"] {
  /* The incoming text is made transparent, not removed: the live region keeps
     its size and its content, so nothing downstream can observe the swap. */
  color: transparent !important;
  position: relative;
}
[${STATUS_ATTR}="1"]::after {
  content: var(--zct-status-phrase, "");
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  color: var(--zct-status-color, inherit);
  font: inherit;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
}
`.trim();
}

class CssStatusAnchor implements StatusAnchor {
  private installed = false;

  find(): HTMLElement | undefined {
    return resolveStatusStrip(document);
  }

  show(element: HTMLElement, phrase: string): void {
    try {
      this.installStyle();
      // Conditional writes: assigning an identical value still counts as a
      // mutation to any observer watching attributes.
      if (element.getAttribute(STATUS_ATTR) !== "1") element.setAttribute(STATUS_ATTR, "1");
      const quoted = JSON.stringify(phrase);
      if (element.style.getPropertyValue("--zct-status-phrase") !== quoted) {
        // Quoted so a phrase containing a quote or parenthesis cannot break the
        // `content` value.
        element.style.setProperty("--zct-status-phrase", quoted);
      }
    } catch {
      /* fail soft: the status line simply keeps its native text */
    }
  }

  restore(element: HTMLElement): void {
    try {
      if (element.getAttribute(STATUS_ATTR) !== null) element.removeAttribute(STATUS_ATTR);
      element.style.removeProperty("--zct-status-phrase");
    } catch {
      /* fail soft */
    }
    this.removeStyleIfUnused();
  }

  dispose(): void {
    // Any element still carrying the attribute is restored first: a disposed
    // roller must not leave a transparent, phrase-less status line behind.
    try {
      for (const el of Array.from(document.querySelectorAll<HTMLElement>(`[${STATUS_ATTR}]`))) {
        el.removeAttribute(STATUS_ATTR);
        el.style.removeProperty("--zct-status-phrase");
      }
    } catch {
      /* fail soft */
    }
    document.getElementById(STATUS_STYLE_ID)?.remove();
    this.installed = false;
  }

  private installStyle(): void {
    if (this.installed && document.getElementById(STATUS_STYLE_ID)) return;
    let style = document.getElementById(STATUS_STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = STATUS_STYLE_ID;
      (document.head ?? document.documentElement).appendChild(style);
    }
    const css = buildCss();
    if (style.textContent !== css) style.textContent = css;
    this.installed = true;
  }

  /** Drops the stylesheet once nothing carries the attribute. */
  private removeStyleIfUnused(): void {
    try {
      if (document.querySelector(`[${STATUS_ATTR}]`)) return;
      document.getElementById(STATUS_STYLE_ID)?.remove();
      this.installed = false;
    } catch {
      /* fail soft */
    }
  }
}

/** The production anchor: a CSS takeover of ZCode's status line. */
export function createStatusAnchor(): StatusAnchor {
  return new CssStatusAnchor();
}
