/**
 * The background-music dock: a launcher button in the bottom-right corner and a
 * small transport panel above it.
 *
 * Deliberately small. The reference project's dock is a compact strip, and the
 * temptation to grow it into a full media manager is what makes these things
 * annoying: it lives on top of the user's work, so it shows one line of track
 * title, five transport buttons, a progress bar and a volume slider, and the
 * library and its management live in the settings centre instead.
 *
 * Positioning contract: this dock and the settings centre both want the
 * bottom-right corner, and the app's own controls already live there. The dock's
 * launcher sits *beside* the settings launcher rather than on top of it, and the
 * two panels are mutually exclusive — opening one closes the other — so nothing
 * ever covers the theme trigger the v0.1 plugin already put in that corner.
 *
 * Collapsed/expanded is remembered in `localStorage` rather than in `prefs.json`
 * on purpose: it is a per-window UI state, not a user preference, and it should
 * not be pushed to every other renderer over the settings sync.
 */

import type { BgmControl, BgmState } from "../contracts.js";
import type { ClientContext } from "../core/context.js";
import { UI_ROOT_ID } from "../ui/skin.js";

const COLLAPSED_KEY = "zct:dock-collapsed";

export interface BgmDockOptions {
  /** Called when the user asks for the full settings centre. */
  onOpenSettings(): void;
  /** Closes the settings centre when this dock opens. */
  onRequestExclusive(): void;
}

export class BgmDock {
  private fab: HTMLButtonElement | undefined;
  private panel: HTMLElement | undefined;
  private unsubState: (() => void) | undefined;
  private unsubPrefs: (() => void) | undefined;
  private last: BgmState | undefined;
  private seeking = false;

  constructor(
    private readonly ctx: ClientContext,
    private readonly bgm: BgmControl,
    private readonly options: BgmDockOptions
  ) {}

  mount(): void {
    // Idempotent by removal: a re-injection must not stack a second dock, and
    // the v0.1 panel had exactly that bug.
    document.getElementById("zct-dock-fab")?.remove();
    document.getElementById("zct-dock")?.remove();

    const root = this.ctx.uiRoot();

    const fab = document.createElement("button");
    fab.id = "zct-dock-fab";
    fab.type = "button";
    fab.className = "zct-surface";
    fab.title = "Background music";
    fab.setAttribute("aria-label", "Background music");
    fab.setAttribute("aria-expanded", "false");
    fab.textContent = "\u266b";
    fab.addEventListener("click", () => this.toggle());
    root.appendChild(fab);
    this.fab = fab;

    const panel = document.createElement("div");
    panel.id = "zct-dock";
    panel.className = "zct-card zct-surface";
    panel.hidden = true;
    panel.setAttribute("role", "region");
    panel.setAttribute("aria-label", "Background music");
    panel.innerHTML = this.panelMarkup();
    root.appendChild(panel);
    this.panel = panel;

    this.wirePanel(panel);

    this.unsubState = this.bgm.onState((state) => this.render(state));
    this.unsubPrefs = this.ctx.onPrefs(() => this.render(this.bgm.state()));
    this.render(this.bgm.state());
  }

  destroy(): void {
    this.unsubState?.();
    this.unsubState = undefined;
    this.unsubPrefs?.();
    this.unsubPrefs = undefined;
    this.fab?.remove();
    this.fab = undefined;
    this.panel?.remove();
    this.panel = undefined;
    this.last = undefined;
  }

  isOpen(): boolean {
    return this.panel !== undefined && !this.panel.hidden;
  }

  open(): void {
    if (!this.panel) return;
    this.options.onRequestExclusive();
    this.panel.hidden = false;
    this.fab?.setAttribute("aria-expanded", "true");
    this.writeCollapsed(false);
    this.render(this.bgm.state());
    // The first open is where the library is most likely to have changed under
    // us — the user has just dropped files into the folder.
    void this.bgm.refresh().catch(() => {});
  }

  close(): void {
    if (!this.panel) return;
    this.panel.hidden = true;
    this.fab?.setAttribute("aria-expanded", "false");
    this.writeCollapsed(true);
  }

  toggle(): void {
    if (this.isOpen()) this.close();
    else this.open();
  }

  /** Closes the dock without recording that as the user's remembered choice. */
  hideForExclusive(): void {
    if (!this.panel) return;
    this.panel.hidden = true;
    this.fab?.setAttribute("aria-expanded", "false");
  }

  // --- markup and wiring --------------------------------------------------

  private panelMarkup(): string {
    // Static markup only: every value that reaches this panel comes from the
    // network or from prefs and is written with textContent in render().
    return `
      <div id="zct-dock-head">
        <span id="zct-dock-title">Background music</span>
        <button class="zct-btn" id="zct-dock-settings" type="button" title="Open settings">\u2699</button>
        <button class="zct-btn" id="zct-dock-collapse" type="button" title="Collapse">\u2715</button>
      </div>
      <div id="zct-dock-sub"></div>
      <div id="zct-dock-locked" hidden>音频已锁定,点击启用</div>
      <div id="zct-dock-empty" hidden>
        还没有音乐。把音频文件放进 <code></code> ,或
        <button class="zct-btn" id="zct-dock-add-inline" type="button">添加音乐</button>
      </div>
      <div id="zct-dock-controls">
        <button class="zct-btn" id="zct-dock-prev" type="button" title="上一首">\u23ee</button>
        <button class="zct-btn" id="zct-dock-play" type="button" data-variant="primary" title="播放 / 暂停">\u25b6</button>
        <button class="zct-btn" id="zct-dock-next" type="button" title="下一首">\u23ed</button>
        <button class="zct-btn" id="zct-dock-shuffle" type="button" title="随机播放">\u21c4</button>
        <button class="zct-btn" id="zct-dock-repeat" type="button" title="重复">\u21bb</button>
        <button class="zct-btn" id="zct-dock-mute" type="button" title="静音">\ud83d\udd07</button>
      </div>
      <div id="zct-dock-progress">
        <span id="zct-dock-time">0:00</span>
        <input type="range" id="zct-dock-seek" min="0" max="1000" step="1" value="0" aria-label="Seek">
        <span id="zct-dock-total">0:00</span>
      </div>
      <div class="zct-row" style="margin:8px 0 0">
        <label for="zct-dock-volume">音量</label>
        <input type="range" id="zct-dock-volume" min="0" max="100" step="1" value="35" aria-label="Volume">
      </div>
      <input type="file" id="zct-dock-file" accept="audio/*" hidden multiple>`;
  }

  private wirePanel(panel: HTMLElement): void {
    const $ = <T extends HTMLElement>(id: string): T | null => panel.querySelector<T>(`#${id}`);

    $("zct-dock-settings")?.addEventListener("click", () => {
      this.hideForExclusive();
      this.options.onOpenSettings();
    });
    $("zct-dock-collapse")?.addEventListener("click", () => this.close());
    $("zct-dock-play")?.addEventListener("click", () => {
      // The click is a user gesture, which is the only moment the autoplay
      // policy will let the context start.
      if (!this.ctx.audio.unlocked) void this.ctx.audio.tryUnlock().then(() => this.bgm.play());
      else this.bgm.toggle();
    });
    $("zct-dock-prev")?.addEventListener("click", () => this.bgm.prev());
    $("zct-dock-next")?.addEventListener("click", () => this.bgm.next());
    $("zct-dock-shuffle")?.addEventListener("click", () => {
      const state = this.bgm.state();
      this.bgm.setShuffle(!state.shuffle);
    });
    $("zct-dock-repeat")?.addEventListener("click", () => {
      const state = this.bgm.state();
      this.bgm.setRepeat(state.repeat === "all" ? "one" : "all");
    });
    $("zct-dock-mute")?.addEventListener("click", () => {
      const state = this.bgm.state();
      this.bgm.setVolume(state.volume > 0 ? 0 : this.ctx.prefs().audio.bgm.volume || 0.35);
    });

    const seek = $<HTMLInputElement>("zct-dock-seek");
    if (seek) {
      // While the thumb is held, timeupdate must not fight the user for it.
      seek.addEventListener("pointerdown", () => {
        this.seeking = true;
      });
      seek.addEventListener("pointerup", () => {
        this.seeking = false;
      });
      seek.addEventListener("input", () => this.bgm.seek(Number(seek.value) / 1000));
    }

    const volume = $<HTMLInputElement>("zct-dock-volume");
    volume?.addEventListener("input", () => this.bgm.setVolume(Number(volume.value) / 100));
    volume?.addEventListener("change", () => this.bgm.setVolume(Number(volume.value) / 100));

    const file = $<HTMLInputElement>("zct-dock-file");
    const pick = () => file?.click();
    $("zct-dock-add-inline")?.addEventListener("click", pick);
    file?.addEventListener("change", () => {
      const files = file.files ? Array.from(file.files) : [];
      file.value = "";
      for (const f of files) {
        void this.bgm.upload(f).catch((err: unknown) => this.ctx.toastError(err, "添加音乐失败"));
      }
    });

    // Escape closes the dock, matching the settings centre and the pet menu.
    panel.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") this.close();
    });
  }

  // --- rendering ----------------------------------------------------------

  private render(state: BgmState): void {
    this.last = state;
    const panel = this.panel;
    const fab = this.fab;
    if (!panel || !fab) return;

    const prefs = this.ctx.prefs();
    const enabled = prefs.audio.enabled && prefs.audio.bgm.enabled;

    // The launcher disappears entirely when music is off, which is what "hidden
    // when BGM disabled" has to mean: not a disabled button taking up the
    // corner the user reclaimed.
    fab.hidden = !enabled;
    if (!enabled) {
      panel.hidden = true;
      return;
    }

    fab.dataset.playing = state.playing ? "1" : "0";
    fab.dataset.locked = state.locked ? "1" : "0";
    fab.title = state.empty
      ? "Background music — no tracks yet"
      : `${state.playing ? "Playing" : "Paused"}: ${state.title}`;

    const $ = <T extends HTMLElement>(id: string): T | null => panel.querySelector<T>(`#${id}`);

    const title = $("zct-dock-title");
    if (title) title.textContent = state.title || "Background music";

    const sub = $("zct-dock-sub");
    if (sub) {
      sub.textContent = state.empty
        ? ""
        : state.tracks.length === 1
          ? "1 track"
          : `${state.tracks.length} tracks${state.shuffle ? " · shuffle" : ""}`;
    }

    const locked = $("zct-dock-locked");
    if (locked) locked.hidden = !state.locked || !state.playing;
    $("zct-dock-empty")!.hidden = !state.empty;

    const dir = $("zct-dock-empty")?.querySelector("code");
    if (dir && !dir.textContent) {
      // The path is only fetched when the message is first needed, so a user
      // with a populated library never pays for it.
      void this.ctx.api
        .getSystem()
        .then((sys) => {
          const music = sys.mediaDirs.find((d) => d.kind === "music");
          if (music && dir) dir.textContent = music.path;
        })
        .catch(() => {});
    }

    const play = $("zct-dock-play");
    if (play) {
      play.textContent = state.playing ? "\u23f8" : "\u25b6";
      play.title = state.playing ? "Pause" : state.locked ? "Click to enable audio" : "Play";
    }
    const shuffle = $("zct-dock-shuffle");
    if (shuffle) shuffle.dataset.state = state.shuffle ? "on" : "off";
    const repeat = $("zct-dock-repeat");
    if (repeat) {
      repeat.dataset.state = state.repeat === "one" ? "on" : "off";
      repeat.title = state.repeat === "one" ? "Repeat one" : "Repeat all";
    }

    const seek = $<HTMLInputElement>("zct-dock-seek");
    if (seek && !this.seeking) {
      const fraction = state.durationSeconds > 0 ? state.positionSeconds / state.durationSeconds : 0;
      seek.value = String(Math.round(Math.min(1, Math.max(0, fraction)) * 1000));
    }
    const time = $("zct-dock-time");
    if (time) time.textContent = formatTime(state.positionSeconds);
    const total = $("zct-dock-total");
    if (total) total.textContent = state.durationSeconds > 0 ? formatTime(state.durationSeconds) : "--:--";

    const volume = $<HTMLInputElement>("zct-dock-volume");
    if (volume && document.activeElement !== volume) volume.value = String(Math.round(state.volume * 100));

    // A follower's transport is fully live — the commands are forwarded — but an
    // empty library has nothing to forward, so the buttons are disabled there.
    const empty = state.empty;
    for (const id of ["zct-dock-prev", "zct-dock-next", "zct-dock-play", "zct-dock-shuffle", "zct-dock-repeat"]) {
      const btn = $(id) as HTMLButtonElement | null;
      if (btn) btn.disabled = empty;
    }
  }

  private readCollapsed(): boolean {
    try {
      return window.localStorage.getItem(COLLAPSED_KEY) !== "false";
    } catch {
      return true;
    }
  }

  private writeCollapsed(collapsed: boolean): void {
    try {
      window.localStorage.setItem(COLLAPSED_KEY, collapsed ? "true" : "false");
    } catch {
      /* storage disabled; the dock simply starts collapsed next time */
    }
  }

  /** Applies the remembered collapsed state on first mount. */
  applyRememberedState(): void {
    if (!this.readCollapsed()) this.open();
  }
}

/** `m:ss` for a duration in seconds. */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

export { UI_ROOT_ID };
