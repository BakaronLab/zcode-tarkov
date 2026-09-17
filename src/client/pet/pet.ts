/**
 * The pet: a small draggable companion with a random voice.
 *
 * It is the one injected surface the user is allowed to push around, and that
 * shapes the module:
 *
 *  - **It is a plain fixed-position element in the injected UI root.** The pet
 *    has to paint above the app but below every settings surface, take a pointer
 *    drag, and survive the app re-rendering the whole window. A `<div>` in the
 *    shared root does all three, inherits the skin's custom properties, and
 *    costs no request of its own.
 *  - **The user's image wins, the built-in drawing is the floor.** A file in
 *    `pet/` is shown through an `<img>`; if it fails to load the pet falls back
 *    to its own drawing, because a broken-image icon is the opposite of what a
 *    companion is for.
 *  - **The position is a preference, and it is clamped.** The stored top-left is
 *    re-clamped against the viewport on mount, on resize and after every drag,
 *    so a pet placed on a large monitor is not stranded off-screen when the
 *    window is later resized to a laptop's height. The top clamp honours the
 *    banner's reserved height, so the pet cannot park under the band.
 *  - **A second injection destroys the first.** The host re-evaluates the
 *    injected script without necessarily reloading the renderer, so the live
 *    handle lives on a window global and the old copy is torn down before a new
 *    one draws anything.
 */

import type { ClientContext } from "../core/context.js";
import type { PetControl } from "../contracts.js";
import type { Prefs } from "../../prefs/types.js";
import { TARKOV_ACCENT, TARKOV_ACCENT_RGB, TARKOV_INK } from "../../themes/palette.js";
import { UI_ROOT_ID } from "../ui/skin.js";
import { PetVoice } from "./voice.js";

const PET_ID = "zct-pet";
const PET_MENU_ID = "zct-pet-menu";
/** The global a re-injection looks for; named here so both sides cannot drift. */
const PET_STATE_KEY = "__zcodeTarkovPet";
/** The class every interactive injected surface carries (`skin.ts`). */
const SURFACE_CLASS = "zct-surface";
/** Gap kept between the pet and the viewport edge, matching the dock's inset. */
const EDGE_MARGIN = 18;
/**
 * How much of the bottom edge the *default corner* leaves free.
 *
 * Larger than `EDGE_MARGIN` on purpose: ZCode's own bottom-left account row
 * lives there, and a pet parked hard against the bottom edge sits on top of it.
 * That row measures about 64 px on 3.12.3, so the default clears it with room to
 * spare. This affects only where the pet starts — a user who drags it into the
 * bottom corner keeps it there, because the clamp below deliberately allows the
 * full viewport height rather than reserving this strip.
 */
const DEFAULT_BOTTOM_CLEARANCE = 84;
/**
 * How far the pointer must travel before a press is a drag.
 *
 * Below this it is a click, because a touchpad tap moves the pointer a pixel or
 * two and a pet that treated that as a drag would never speak on a tap.
 */
const DRAG_THRESHOLD_PX = 5;
/** Image types a pet may be, most specific first. */
const IMAGE_EXTENSIONS = [".png", ".webp", ".gif", ".jpg", ".jpeg"] as const;

/**
 * The built-in pet, drawn as inline SVG.
 *
 * Original work, deliberately generic: a stylised helmet blob with a visor and
 * one antenna, not a reproduction of any game's asset or of the Altyn helmet.
 * Keeping it inline rather than as a shipped file means the default pet costs no
 * request, cannot 404, and needs no binary in a repository whose whole media
 * story is that the user supplies it. Colours come from the shared palette so
 * the pet tracks the accent the rest of the client uses.
 */
const PET_SVG = `<svg viewBox="0 0 96 96" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Tactical companion">
  <path d="M57 30 L68 11" fill="none" stroke="${TARKOV_ACCENT}" class="zct-pet-accent-stroke" stroke-width="3.4" stroke-linecap="round"/>
  <circle cx="70" cy="9" r="4.6" fill="${TARKOV_ACCENT}" class="zct-pet-accent"/>
  <path d="M12 57 C12 30 28 15 48 15 C68 15 84 30 84 57 Z" fill="${TARKOV_ACCENT}" class="zct-pet-accent zct-pet-ink-stroke" stroke="${TARKOV_INK}" stroke-opacity=".45" stroke-width="2"/>
  <path d="M23 35 C29 24 38 19 49 19" fill="none" stroke="${TARKOV_INK}" class="zct-pet-ink-stroke" stroke-opacity=".28" stroke-width="3" stroke-linecap="round"/>
  <path d="M20 56 L76 56 L70 78 C68 85 59 89 48 89 C37 89 28 85 26 78 Z" fill="${TARKOV_INK}" class="zct-pet-ink zct-pet-accent-stroke" stroke="${TARKOV_ACCENT}" stroke-opacity=".45" stroke-width="2"/>
  <rect x="20" y="37" width="56" height="18" rx="9" fill="${TARKOV_INK}" class="zct-pet-ink"/>
  <path d="M28 47 C35 41 43 39 52 39" fill="none" stroke="rgba(${TARKOV_ACCENT_RGB}, .55)" class="zct-pet-accent-soft-stroke" stroke-width="3" stroke-linecap="round"/>
  <circle cx="35" cy="70" r="3.2" fill="${TARKOV_ACCENT}" class="zct-pet-accent"/>
  <path d="M56 68 L68 68 M56 74 L64 74" fill="none" stroke="rgba(${TARKOV_ACCENT_RGB}, .5)" class="zct-pet-accent-soft-stroke" stroke-width="2.4" stroke-linecap="round"/>
</svg>`;

interface PetOptions {
  onOpenSettings?: () => void;
}

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
  moved: boolean;
}

type MenuEntry = { separator: true } | { label: string; action: string };

export class Pet implements PetControl {
  private el: HTMLElement | undefined;
  private menu: HTMLElement | undefined;
  private pos: { x: number; y: number } | undefined;
  private imageName: string | undefined;
  private brokenImage: string | undefined;
  private drag: DragState | undefined;
  private suppressClick = false;
  private unsubscribePrefs: (() => void) | undefined;
  private readonly injectedVoice: PetVoice | undefined;
  private voiceInstance: PetVoice | undefined;
  private petImageCheck: Promise<void> | undefined;
  private readonly disposers: Array<() => void> = [];
  private readonly menuDisposers: Array<() => void> = [];

  /**
   * `voice` is an injection seam, not a copy of the context: a caller that
   * already owns a voice hands it in so one implementation is shared, and it is
   * checked rather than trusted because the wiring that passes it is not typed.
   * `opts` is third so a caller can reach it without naming a voice.
   */
  constructor(
    private readonly ctx: ClientContext,
    voice?: PetVoice,
    private readonly opts: PetOptions = {}
  ) {
    this.injectedVoice = isPetVoice(voice) ? voice : undefined;
  }

  /**
   * Creates the DOM and subscribes to prefs. Idempotent.
   *
   * The stale-node sweep runs even when this instance was never mounted: an
   * injection that died before it could clean up leaves its nodes behind, and
   * the global it would have been found through is gone.
   */
  mount(): void {
    const previous = petGlobal();
    if (isDestroyable(previous) && previous !== this) {
      try {
        previous.destroy();
      } catch {
        /* a broken stale copy is removed by id below regardless */
      }
    }
    setPetGlobal(this);
    if (this.el?.isConnected) {
      this.applyPrefs(this.ctx.prefs());
      return;
    }
    document.getElementById(PET_ID)?.remove();
    document.getElementById(PET_MENU_ID)?.remove();

    const el = document.createElement("div");
    el.id = PET_ID;
    el.className = SURFACE_CLASS;
    this.listen(el, "pointerdown", this.onPointerDown);
    this.listen(el, "pointermove", this.onPointerMove);
    this.listen(el, "pointerup", this.onPointerUp);
    this.listen(el, "pointercancel", this.onPointerCancel);
    this.listen(el, "lostpointercapture", this.onLostPointerCapture);
    this.listen(el, "contextmenu", this.onContextMenu);
    this.listen(el, "click", this.onClick);
    this.host().appendChild(el);
    this.el = el;

    this.render();
    this.applyPrefs(this.ctx.prefs());
    this.unsubscribePrefs = this.ctx.onPrefs((prefs) => {
      this.applyPrefs(prefs);
      void this.refreshPetImage();
    });
    this.listenWindow("resize", this.onWindowResize);
    void this.refreshPetImage();
  }

  /** Removes every node, listener, subscription and cache this instance owns. */
  destroy(): void {
    this.closeMenu();
    this.unsubscribePrefs?.();
    this.unsubscribePrefs = undefined;
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose();
      } catch {
        /* the node or window may already be gone */
      }
    }
    this.el?.remove();
    this.el = undefined;
    this.drag = undefined;
    this.suppressClick = false;
    this.pos = undefined;
    // An injected voice belongs to whoever handed it in; only the one this pet
    // created is released here.
    if (!this.injectedVoice) this.voiceInstance?.dispose();
    this.voiceInstance = undefined;
    clearPetGlobal(this);
  }

  resetPosition(): void {
    this.place(this.defaultPosition());
    void this.savePosition();
  }

  /**
   * Re-reads both pools the pet draws on.
   *
   * The image list is included because a user who just dropped a new picture
   * into `pet/` expects the pet to change, and this method is the only refresh
   * the settings panel has for either kind.
   */
  async refreshVoicePool(): Promise<number> {
    await this.refreshPetImage();
    return this.voice.refresh();
  }

  voicePoolSize(): number {
    return this.voiceInstance?.size ?? 0;
  }

  // --- appearance -----------------------------------------------------------

  private get voice(): PetVoice {
    this.voiceInstance ??= this.injectedVoice ?? new PetVoice(this.ctx);
    return this.voiceInstance;
  }

  /** The element the pet is parented to: the shared root, or a live stand-in. */
  private host(): HTMLElement {
    const root = this.ctx.uiRoot();
    // A detached root would swallow the pet silently; the id lookup finds the
    // live one when the app re-rendered around the reference we were handed.
    if (root.isConnected) return root;
    return document.getElementById(UI_ROOT_ID) ?? document.body;
  }

  private render(): void {
    const el = this.el;
    if (!el) return;
    const name = this.imageName && this.imageName !== this.brokenImage ? this.imageName : undefined;
    if (!name) {
      // A constant with no user input in it, so assigning markup is safe and is
      // less code than building a dozen nodes for the same drawing.
      el.innerHTML = PET_SVG;
      return;
    }
    const img = document.createElement("img");
    img.alt = "";
    // Without this a press-and-move drags the image as a file instead of the pet.
    img.draggable = false;
    // The image's size is unknown until it loads, so the first clamp after a
    // mount can be wrong by the image's height; both events re-run it.
    img.addEventListener("load", () => this.reclamp(), { once: true });
    img.addEventListener("error", () => this.onImageError(name), { once: true });
    img.src = this.ctx.api.mediaUrl("pet", name);
    el.replaceChildren(img);
  }

  /**
   * Marks a failed image and falls back to the drawing.
   *
   * The name is remembered so that a prefs event a second later does not retry
   * a request that is known to fail; a successful refresh clears it, which is
   * how a replaced file gets another chance.
   */
  private onImageError(name: string): void {
    if (this.imageName !== name) return;
    this.brokenImage = name;
    this.render();
  }

  /**
   * Reads the `pet/` pool and picks the user's image, if any.
   *
   * Coalesced: the prefs stream can fire many times in a row, and each check is
   * an HTTP round trip for a list that changes only when the user edits the
   * folder.
   */
  private refreshPetImage(): Promise<void> {
    this.petImageCheck ??= this.readPetPool().finally(() => {
      this.petImageCheck = undefined;
    });
    return this.petImageCheck;
  }

  private async readPetPool(): Promise<void> {
    try {
      const response: unknown = await this.ctx.api.getPool("pet");
      const entries = isRecord(response) ? response.entries : undefined;
      const next = pickPetImage(poolNames(entries));
      const wasBroken = this.brokenImage !== undefined;
      this.brokenImage = undefined;
      if (next !== this.imageName || wasBroken) {
        this.imageName = next;
        this.render();
      }
    } catch {
      // Keep whatever is on screen: an unreachable service must not replace the
      // user's pet with the built-in drawing, and must not erase a known failure.
    }
  }

  private applyPrefs(prefs: Prefs): void {
    const el = this.el;
    if (!el) return;
    const pet = prefs.pet;
    el.style.width = `${pet.scale}px`;
    el.style.opacity = String(pet.opacity);
    if (!pet.enabled) {
      this.closeMenu();
      el.hidden = true;
      return;
    }
    el.hidden = false;
    if (this.drag) return;
    const stored = pet.position;
    // A stored position that differs from ours came from somewhere else (the
    // settings panel's reset, or another renderer); a matching one is only
    // re-applied to re-clamp after a scale change.
    const external = stored !== undefined && (this.pos === undefined || stored.x !== this.pos.x || stored.y !== this.pos.y);
    if (external && stored !== undefined) this.place(stored);
    else this.place(this.pos ?? this.defaultPosition());
  }

  /** The built-in corner: bottom-left, which is the side the dock is not on. */
  private defaultPosition(): { x: number; y: number } {
    // No viewport means no corner to compute: the settings panel can call
    // `resetPosition` while the pet is unsupported, and a test runner has no
    // `window` at all, so the placeholder is never applied anywhere but still
    // keeps the call from throwing.
    if (typeof window === "undefined") return { x: EDGE_MARGIN, y: EDGE_MARGIN };
    const size = this.size();
    return { x: EDGE_MARGIN, y: window.innerHeight - size.height - DEFAULT_BOTTOM_CLEARANCE };
  }

  private size(): { width: number; height: number } {
    const width = this.el?.offsetWidth ?? 0;
    const height = this.el?.offsetHeight ?? 0;
    if (width > 0 && height > 0) return { width, height };
    // Before the image loads, or while the pet is hidden, it measures zero; the
    // configured width is a better first guess than nothing, and every path
    // that changes the real size re-clamps.
    const fallback = this.ctx.prefs().pet.scale;
    return { width: width > 0 ? width : fallback, height: height > 0 ? height : fallback };
  }

  /**
   * Moves the pet to a top-left, clamped so it stays fully visible.
   *
   * The clamp is asymmetric at the top: the banner is fixed over the top of the
   * window, so `--zcode-tarkov-banner-height` is a real inset and the pet's top
   * edge starts below it. A viewport smaller than the pet still resolves to the
   * margins rather than to a negative position, which is what keeps the pet
   * reachable on a tiny window.
   */
  private place(target: { x: number; y: number }): void {
    const el = this.el;
    if (!el || typeof window === "undefined") return;
    const size = this.size();
    const top = bannerInset() + EDGE_MARGIN;
    const x = Math.round(clamp(target.x, EDGE_MARGIN, window.innerWidth - size.width - EDGE_MARGIN));
    const y = Math.round(clamp(target.y, top, window.innerHeight - size.height - EDGE_MARGIN));
    this.pos = { x, y };
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }

  private reclamp(): void {
    if (!this.el || this.el.hidden) return;
    this.place(this.pos ?? this.defaultPosition());
  }

  private savePosition(): Promise<void> {
    const pos = this.pos;
    if (!pos) return Promise.resolve();
    return this.ctx
      .patchPrefs({ pet: { position: { x: pos.x, y: pos.y } } })
      .then(() => undefined)
      .catch(() => {
        // The drag itself succeeded, and a toast on every pointer release would
        // be noise for a preference the next successful write restores.
      });
  }

  // --- pointer --------------------------------------------------------------

  private readonly onPointerDown = (ev: PointerEvent): void => {
    this.suppressClick = false;
    if (ev.button === 2) {
      ev.preventDefault();
      this.openMenu(ev.clientX, ev.clientY);
      return;
    }
    if (ev.button !== 0 || !this.el) return;
    // The default action of pointerdown is what starts a text selection; the pet
    // is not text, and a selection that survives the press is what would let the
    // release land in the editor instead of the pet.
    ev.preventDefault();
    const origin = this.pos ?? this.defaultPosition();
    this.drag = {
      pointerId: ev.pointerId,
      startX: ev.clientX,
      startY: ev.clientY,
      originX: origin.x,
      originY: origin.y,
      moved: false,
    };
    try {
      this.el.setPointerCapture(ev.pointerId);
    } catch {
      // Capture is what lets a fast drag leave the element; without it the
      // gesture degrades to a click, and there is no recovery to attempt.
    }
  };

  private readonly onPointerMove = (ev: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || drag.pointerId !== ev.pointerId) return;
    const dx = ev.clientX - drag.startX;
    const dy = ev.clientY - drag.startY;
    if (!drag.moved) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      drag.moved = true;
      if (this.el) this.el.dataset.dragging = "1";
      // Defensive, at the moment the drag really starts: a selection that was
      // already live elsewhere would otherwise be extended by the moving
      // pointer, and the user would lose the content they were reading.
      window.getSelection()?.removeAllRanges();
    }
    this.place({ x: drag.originX + dx, y: drag.originY + dy });
  };

  private readonly onPointerUp = (ev: PointerEvent): void => {
    if (!this.drag || this.drag.pointerId !== ev.pointerId) return;
    this.endDrag();
  };

  private readonly onPointerCancel = (ev: PointerEvent): void => {
    if (!this.drag || this.drag.pointerId !== ev.pointerId) return;
    this.endDrag();
  };

  private readonly onLostPointerCapture = (ev: PointerEvent): void => {
    if (!this.drag || this.drag.pointerId !== ev.pointerId) return;
    this.endDrag();
  };

  /**
   * Ends the gesture from whichever event closed it.
   *
   * `pointerup`, `pointercancel` and `lostpointercapture` all run through here,
   * so the drag flag, the `data-dragging` marker and the capture are cleared
   * exactly once even when the browser fires two of them for one gesture.
   */
  private endDrag(): void {
    const drag = this.drag;
    if (!drag) return;
    this.drag = undefined;
    const el = this.el;
    if (el) {
      delete el.dataset.dragging;
      try {
        el.releasePointerCapture(drag.pointerId);
      } catch {
        /* capture already gone */
      }
    }
    if (!drag.moved) return;
    // A press that moved is a drag, so the click the browser will dispatch next
    // must not also be read as a tap and trigger the voice.
    this.suppressClick = true;
    void this.savePosition();
  }

  private readonly onClick = (ev: MouseEvent): void => {
    ev.preventDefault();
    if (this.suppressClick) {
      this.suppressClick = false;
      return;
    }
    void this.speakOnClick();
  };

  private readonly onContextMenu = (ev: MouseEvent): void => {
    // The app's own context menu is not the right menu for the pet; without this
    // both would appear, and on Windows the native one would cover ours.
    ev.preventDefault();
    if (!this.menu) this.openMenu(ev.clientX, ev.clientY);
  };

  private async speakOnClick(): Promise<void> {
    const prefs = this.ctx.prefs();
    if (!prefs.pet.voiceOnClick || !prefs.audio.enabled || !prefs.audio.voice.enabled) return;
    // A click is the user gesture the autoplay policy waits for; unlocking here
    // is why the first click is audible instead of the second.
    if (!this.ctx.audio.unlocked) await this.ctx.audio.tryUnlock();
    await this.voice.maybeSpeak();
  }

  // --- context menu ---------------------------------------------------------

  /**
   * Opens the pet menu at a viewport point.
   *
   * The menu is opened from `pointerdown`, not after `pointerup`: the pet
   * captures the pointer for a left drag, and anything that waited for the click
   * would be retargeted to the pet and lost. Its own listeners live on the menu
   * element and on the document, so no part of it depends on the pet's capture.
   */
  private openMenu(x: number, y: number): void {
    this.closeMenu();
    const menu = document.createElement("div");
    menu.id = PET_MENU_ID;
    menu.className = SURFACE_CLASS;
    menu.setAttribute("role", "menu");
    for (const entry of this.menuEntries()) {
      if ("separator" in entry) {
        const sep = document.createElement("div");
        sep.className = "zct-menu-sep";
        menu.appendChild(sep);
        continue;
      }
      const item = document.createElement("button");
      item.type = "button";
      item.className = "zct-menu-item";
      item.setAttribute("role", "menuitem");
      item.dataset.action = entry.action;
      item.textContent = entry.label;
      menu.appendChild(item);
    }
    this.host().appendChild(menu);
    // Measured after insertion, because the clamp needs the menu's real size;
    // it is placed at the pointer unless that would push it off the viewport.
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.round(clamp(x, EDGE_MARGIN, window.innerWidth - rect.width - EDGE_MARGIN))}px`;
    menu.style.top = `${Math.round(clamp(y, EDGE_MARGIN, window.innerHeight - rect.height - EDGE_MARGIN))}px`;
    this.menu = menu;

    menu.addEventListener("click", this.onMenuClick);
    this.menuDisposers.push(() => menu.removeEventListener("click", this.onMenuClick));
    // Capture phase: a press anywhere, including on the pet, closes the menu
    // before the target sees it, so a second right-click opens a fresh menu
    // rather than stacking another one.
    document.addEventListener("pointerdown", this.onMenuPointerDown, true);
    this.menuDisposers.push(() => document.removeEventListener("pointerdown", this.onMenuPointerDown, true));
    document.addEventListener("keydown", this.onMenuKeyDown, true);
    this.menuDisposers.push(() => document.removeEventListener("keydown", this.onMenuKeyDown, true));
  }

  private closeMenu(): void {
    for (const dispose of this.menuDisposers.splice(0)) {
      try {
        dispose();
      } catch {
        /* nothing left to remove */
      }
    }
    this.menu?.remove();
    this.menu = undefined;
  }

  private menuEntries(): MenuEntry[] {
    const voiceOn = this.ctx.prefs().pet.voiceOnClick;
    return [
      { label: voiceOn ? "Mute pet voice" : "Unmute pet voice", action: "voice" },
      { label: "Hide pet", action: "hide" },
      { label: "Reset position", action: "reset" },
      { separator: true },
      { label: "Open pet settings", action: "settings" },
    ];
  }

  private readonly onMenuClick = (ev: MouseEvent): void => {
    const target = ev.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLElement>(".zct-menu-item");
    const action = button?.dataset.action;
    if (!action) return;
    ev.preventDefault();
    this.closeMenu();
    if (action === "voice") void this.toggleVoice();
    else if (action === "hide") void this.hidePet();
    else if (action === "reset") this.resetPosition();
    else if (action === "settings") this.openSettings();
  };

  private readonly onMenuPointerDown = (ev: PointerEvent): void => {
    const target = ev.target;
    // A press inside the menu is the user choosing an item; closing on it would
    // remove the button before its click could fire.
    if (this.menu && target instanceof Node && this.menu.contains(target)) return;
    this.closeMenu();
  };

  private readonly onMenuKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key !== "Escape") return;
    ev.preventDefault();
    this.closeMenu();
  };

  private openSettings(): void {
    const open = this.opts.onOpenSettings;
    if (!open) return;
    try {
      open();
    } catch {
      /* a panel callback must not break the pet */
    }
  }

  private async toggleVoice(): Promise<void> {
    const next = !this.ctx.prefs().pet.voiceOnClick;
    try {
      await this.ctx.patchPrefs({ pet: { voiceOnClick: next } });
    } catch (err) {
      this.ctx.toastError(err, "Could not save the pet voice setting");
    }
  }

  private async hidePet(): Promise<void> {
    try {
      await this.ctx.patchPrefs({ pet: { enabled: false } });
    } catch (err) {
      this.ctx.toastError(err, "Could not hide the pet");
    }
  }

  private readonly onWindowResize = (): void => {
    // The menu is anchored to viewport pixels that just moved; reopening it in
    // place is not possible, so it closes rather than pointing at nothing.
    this.closeMenu();
    this.reclamp();
  };

  // --- plumbing -------------------------------------------------------------

  private listen<K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    handler: (ev: HTMLElementEventMap[K]) => void
  ): void {
    target.addEventListener(type, handler);
    this.disposers.push(() => target.removeEventListener(type, handler));
  }

  private listenWindow<K extends keyof WindowEventMap>(type: K, handler: (ev: WindowEventMap[K]) => void): void {
    window.addEventListener(type, handler);
    this.disposers.push(() => window.removeEventListener(type, handler));
  }
}

/**
 * The banner's reserved height, in px, or 0 when there is no band.
 *
 * Read from the document rather than from prefs: the band knows its own mode
 * (`off` pins this to 0), and the pet must not disagree with what is painted.
 */
function bannerInset(): number {
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue("--zcode-tarkov-banner-height");
    const value = Number.parseFloat(raw);
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  const ceiling = Math.max(min, max);
  return Math.min(Math.max(value, min), ceiling);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * True when a value can act as the pet's voice.
 *
 * Structural because the injection seam is untyped: a placeholder that cannot
 * speak must degrade to the built-in voice rather than throw from the click
 * handler that asked for a sound.
 */
function isPetVoice(value: unknown): value is PetVoice {
  if (!isRecord(value)) return false;
  return (
    typeof value.refresh === "function" &&
    typeof value.maybeSpeak === "function" &&
    typeof value.speak === "function" &&
    typeof value.dispose === "function"
  );
}

/** The servable pet names in a pool response, in the order the service listed them. */
function poolNames(entries: unknown): string[] {
  if (!Array.isArray(entries)) return [];
  const out: string[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const name = entry.filename;
    if (typeof name !== "string") continue;
    const lower = name.toLowerCase();
    if (IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext))) out.push(name);
  }
  return out;
}

/** The first image in preference order, so a user with several gets a fixed choice. */
function pickPetImage(names: string[]): string | undefined {
  for (const ext of IMAGE_EXTENSIONS) {
    const match = names.find((name) => name.toLowerCase().endsWith(ext));
    if (match) return match;
  }
  return undefined;
}

/**
 * The live pet handle, if a previous injection left one.
 *
 * Duck-typed rather than `instanceof`: a second injection in the same renderer
 * carries its own class identity, so a nominally identical `Pet` would fail the
 * check and the first copy would keep its nodes.
 */
function petGlobal(): unknown {
  try {
    return (window as unknown as Record<string, unknown>)[PET_STATE_KEY];
  } catch {
    return undefined;
  }
}

function setPetGlobal(value: unknown): void {
  try {
    (window as unknown as Record<string, unknown>)[PET_STATE_KEY] = value;
  } catch {
    /* a frozen window must not stop the pet from drawing */
  }
}

/** Clears the global only when it still names the given handle. */
function clearPetGlobal(value: unknown): void {
  try {
    const global = window as unknown as Record<string, unknown>;
    if (global[PET_STATE_KEY] === value) delete global[PET_STATE_KEY];
  } catch {
    /* nothing to clear */
  }
}

function isDestroyable(value: unknown): value is { destroy: () => void } {
  if (!isRecord(value)) return false;
  return typeof value.destroy === "function";
}
