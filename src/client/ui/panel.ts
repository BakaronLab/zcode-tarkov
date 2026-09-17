/**
 * The v0.2 settings centre: one floating window that drives five subsystems the
 * panel does not own: the v0.1 appearance service (colour mode, wallpaper,
 * blur/dim), the audio engine, the pet, the status roller and the host itself.
 * The seams are the control objects declared in `contracts.ts`, so the panel is
 * constructible with a stubbed transport and never reaches for a global.
 *
 * Three rules shape the code:
 *
 *  - **Nothing the network said is ever markup.** Track names, media paths and
 *    error strings are all written with `textContent`; `innerHTML` is not used
 *    at all, so a hostile file name cannot become script.
 *  - **Every async path fails visibly.** A rejected call flips the panel into
 *    its offline state, and the 4 s poll (which runs only while the panel is
 *    open or while it is offline) notices when the service comes back.
 *  - **A refresh never fights the user.** A control that is being dragged or
 *    that holds focus is skipped by the render functions, which is what keeps a
 *    round-trip from snapping a thumb back to a stale value.
 */

import { errorMessage } from "../core/context.js";
import type { ClientContext } from "../core/context.js";
import type { BgmControl, BgmState, DeepPartial, PetControl, StatusControl } from "../contracts.js";
import type { SystemInfo } from "../core/api.js";
import { defaultBanner, defaultPrefs } from "../../prefs/defaults.js";
import { DEFAULT_PALETTE } from "../../themes/palette.js";
import { DEFAULT_GREETING } from "../../themes/tarkov.js";
import {
  BANNER_MODES,
  COLOR_MODES,
  SFX_EVENTS,
  STATUS_LANGUAGES,
  STATUS_TRIGGERS,
  WALLPAPER_FITS,
  type BannerMode,
  type ColorModeName,
  type Prefs,
  type SfxEvent,
  type StatusLanguage,
  type WallpaperFitName,
} from "../../prefs/types.js";

const PANEL_ID = "zct-panel";
const FAB_ID = "zct-panel-fab";
const PANEL_BODY_ID = "zct-panel-body";
/** The stack top, matching `skin.ts`: the settings centre sits above everything. */
const Z_PANEL = 2147483647;
/** Slider writes are spaced at least this far apart; `change` always writes. */
const SLIDER_WRITE_MS = 250;
/** The service answers this quickly; a recovery is noticed within a few seconds. */
const POLL_MS = 4_000;
const MAX_WALLPAPER_BYTES = 20 * 1024 * 1024;
const OFFLINE_FALLBACK = "无法连接 ZCode Tarkov 服务";
/** The `validateGreeting` caps in `prefs/prefs.ts`; a field must not hold more. */
const GREETING_LINE1_MAX = 240;
const GREETING_LINE2_MAX = 400;

type TabId = "appearance" | "audio" | "pet" | "status" | "system";

const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: "appearance", label: "外观" },
  { id: "audio", label: "音频" },
  { id: "pet", label: "宠物" },
  { id: "status", label: "状态" },
  { id: "system", label: "系统" },
];

const COLOR_MODE_LABELS: Record<ColorModeName, string> = {
  monet: "Monet · 壁纸取色",
  tarkov: "Tarkov · 战术界面",
  native: "Native · ZCode 原生",
};

const BANNER_LABELS: Record<BannerMode, string> = {
  off: "关闭",
  compact: "细状态条",
  full: "完整警告条",
};

const FIT_LABELS: Record<WallpaperFitName, string> = {
  cover: "填满裁剪",
  contain: "完整显示",
  smart: "智能适配",
};

const LANGUAGE_LABELS: Record<StatusLanguage, string> = {
  zh: "中文",
  en: "English",
};

const SFX_LABELS: Record<SfxEvent, string> = {
  start: "任务开始",
  approval: "等待批准",
  done: "任务完成",
  error: "发生错误",
  tool: "工具调用",
};

const TRIGGER_LABELS: Record<string, string> = {
  reasoning: "推理中",
  tool: "工具调用",
  progress: "进度更新",
};

// --- small DOM and value helpers --------------------------------------------

let idSeq = 0;

/** A per-instance id, so two panels can never share a label target. */
function uid(prefix: string): string {
  idSeq += 1;
  return `${prefix}-${idSeq}`;
}

function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  content?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

function button(label: string, variant?: "primary" | "icon"): HTMLButtonElement {
  const node = make("button", "zct-btn");
  node.type = "button";
  if (variant !== undefined) node.dataset.variant = variant;
  node.textContent = label;
  return node;
}

function makeSection(title: string): { root: HTMLDivElement; body: HTMLDivElement } {
  const root = make("div", "zct-section");
  const body = make("div");
  root.append(make("h4", undefined, title), body);
  return { root, body };
}

interface SliderRow {
  root: HTMLDivElement;
  input: HTMLInputElement;
  readout: HTMLSpanElement;
}

function sliderRow(
  labelText: string,
  min: number,
  max: number,
  step: number,
  initial: number,
  format: (value: number) => string
): SliderRow {
  const id = uid("zct-slider");
  const root = make("div");
  const head = make("div", "zct-row");
  const label = make("label", undefined, labelText);
  label.htmlFor = id;
  const readout = make("span", "zct-value", format(initial));
  head.append(label, readout);
  const line = make("div", "zct-row");
  const input = make("input");
  input.type = "range";
  input.id = id;
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(initial);
  line.appendChild(input);
  root.append(head, line);
  return { root, input, readout };
}

interface ColorRow {
  root: HTMLDivElement;
  input: HTMLInputElement;
  readout: HTMLSpanElement;
}

/**
 * A native colour picker and the value it holds, side by side.
 *
 * `<input type="color">` normalises on read to `#rrggbb`, which is exactly the
 * form the preferences validator stores, so the picker and the document cannot
 * disagree about what a colour is.
 */
function colorRow(labelText: string, initial: string): ColorRow {
  const id = uid("zct-color");
  const root = make("div", "zct-row");
  const label = make("label", undefined, labelText);
  label.htmlFor = id;
  const readout = make("span", "zct-value", initial);
  const input = make("input");
  input.type = "color";
  input.id = id;
  input.value = initial;
  input.style.width = "44px";
  input.style.height = "22px";
  input.style.padding = "0";
  input.style.flex = "none";
  input.style.background = "var(--zct-ctl-bg)";
  input.style.border = "1px solid var(--zct-ctl-border)";
  input.style.borderRadius = "var(--zct-radius-sm)";
  root.append(label, readout, input);
  return { root, input, readout };
}

interface TextRow {
  root: HTMLDivElement;
  input: HTMLInputElement;
  counter: HTMLSpanElement;
}

/** A text field carrying the validator's cap, with its live character count. */
function textRow(labelText: string, initial: string, maxLength: number): TextRow {
  const id = uid("zct-text");
  const root = make("div");
  const head = make("div", "zct-row");
  const label = make("label", undefined, labelText);
  label.htmlFor = id;
  const counter = make("span", "zct-value", asCount(initial, maxLength));
  head.append(label, counter);
  const input = make("input");
  input.type = "text";
  input.id = id;
  input.maxLength = maxLength;
  input.value = initial;
  root.append(head, input);
  return { root, input, counter };
}

interface CheckboxRow {
  root: HTMLDivElement;
  input: HTMLInputElement;
}

function checkboxRow(labelText: string, checked: boolean, title?: string): CheckboxRow {
  const id = uid("zct-check");
  const root = make("div", "zct-row");
  const input = make("input");
  input.type = "checkbox";
  input.id = id;
  input.checked = checked;
  if (title !== undefined) input.title = title;
  const label = make("label", undefined, labelText);
  label.htmlFor = id;
  root.append(label, input);
  return { root, input };
}

interface SelectRow {
  root: HTMLDivElement;
  select: HTMLSelectElement;
}

function selectRow<T extends string>(
  labelText: string,
  options: ReadonlyArray<{ value: T; label: string }>,
  selected: T
): SelectRow {
  const id = uid("zct-select");
  const root = make("div");
  const head = make("div", "zct-row");
  const label = make("label", undefined, labelText);
  label.htmlFor = id;
  head.appendChild(label);
  const line = make("div", "zct-row");
  const select = make("select");
  select.id = id;
  for (const option of options) {
    const node = make("option", undefined, option.label);
    node.value = option.value;
    select.appendChild(node);
  }
  select.value = selected;
  line.appendChild(select);
  root.append(head, line);
  return { root, select };
}

function asPixels(value: number): string {
  return `${Math.round(value)} px`;
}

function asPercent(value: number): string {
  return `${Math.round(value * 100)} %`;
}

function asCount(value: string, maxLength: number): string {
  return `${value.length} / ${maxLength}`;
}

function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "未知";
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟`;
  if (minutes > 0) return `${minutes} 分 ${total % 60} 秒`;
  return `${total} 秒`;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * A blank greeting line is not storable: the validator silently falls back to
 * the default, so the UI has to mean the same thing when it sends one.
 */
function orDefault(value: string, fallback: string): string {
  return value.trim().length > 0 ? value : fallback;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

function readNumber(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" ? value : undefined;
}

function readBoolean(source: Record<string, unknown>, key: string): boolean | undefined {
  const value = source[key];
  return typeof value === "boolean" ? value : undefined;
}

/** The window handle a re-injection uses to retire the previous panel. */
interface PanelWindow extends Window {
  __zcodeTarkovPanel?: { destroy(): void };
}

function panelWindow(): PanelWindow {
  return window as PanelWindow;
}

// --- node registry ----------------------------------------------------------

interface AppearanceNodes {
  colorMode: HTMLSelectElement;
  blur: HTMLInputElement;
  blurValue: HTMLSpanElement;
  dim: HTMLInputElement;
  dimValue: HTMLSpanElement;
  wallpaperVisible: HTMLInputElement;
  wallpaperFile: HTMLInputElement;
  fit: HTMLButtonElement;
  reset: HTMLButtonElement;
  bannerMode: HTMLSelectElement;
  bannerOpacity: HTMLInputElement;
  bannerOpacityValue: HTMLSpanElement;
  colorBackground: HTMLInputElement;
  colorBackgroundValue: HTMLSpanElement;
  colorAccent: HTMLInputElement;
  colorAccentValue: HTMLSpanElement;
  paletteReset: HTMLButtonElement;
  greetingEnabled: HTMLInputElement;
  greetingLine1: HTMLInputElement;
  greetingLine1Count: HTMLSpanElement;
  greetingLine2: HTMLInputElement;
  greetingLine2Count: HTMLSpanElement;
  greetingReset: HTMLButtonElement;
}

interface AudioNodes {
  audioEnabled: HTMLInputElement;
  masterVolume: HTMLInputElement;
  masterVolumeValue: HTMLSpanElement;
  unlockSection: HTMLDivElement;
  unlockState: HTMLDivElement;
  unlockBtn: HTMLButtonElement;
  bgmEnabled: HTMLInputElement;
  bgmVolume: HTMLInputElement;
  bgmVolumeValue: HTMLSpanElement;
  bgmShuffle: HTMLButtonElement;
  bgmRepeat: HTMLButtonElement;
  bgmPrev: HTMLButtonElement;
  bgmPlay: HTMLButtonElement;
  bgmNext: HTMLButtonElement;
  bgmTitle: HTMLDivElement;
  bgmPosition: HTMLDivElement;
  tracks: HTMLDivElement;
  emptyNote: HTMLDivElement;
  uploadBar: HTMLDivElement;
  uploadFill: HTMLElement;
  addMusic: HTMLButtonElement;
  musicFile: HTMLInputElement;
  sfxEnabled: HTMLInputElement;
  sfxVolume: HTMLInputElement;
  sfxVolumeValue: HTMLSpanElement;
  sfxEventInputs: Map<string, HTMLInputElement>;
  voiceEnabled: HTMLInputElement;
  voiceVolume: HTMLInputElement;
  voiceVolumeValue: HTMLSpanElement;
  voiceChance: HTMLInputElement;
  voiceChanceValue: HTMLSpanElement;
  voiceTest: HTMLButtonElement;
  voicePool: HTMLSpanElement;
  voiceRefresh: HTMLButtonElement;
}

interface PetNodes {
  petEnabled: HTMLInputElement;
  petScale: HTMLInputElement;
  petScaleValue: HTMLSpanElement;
  petOpacity: HTMLInputElement;
  petOpacityValue: HTMLSpanElement;
  petVoiceOnClick: HTMLInputElement;
  petReset: HTMLButtonElement;
}

interface StatusNodes {
  statusEnabled: HTMLInputElement;
  statusLanguage: HTMLSelectElement;
  statusTriggerInputs: Map<string, HTMLInputElement>;
  statusReload: HTMLButtonElement;
  statusReloadInfo: HTMLSpanElement;
  statusPool: HTMLSpanElement;
  statusPhrase: HTMLDivElement;
}

interface SystemNodes {
  systemDl: HTMLDListElement;
  systemAdvanced: HTMLDListElement;
}

interface PanelNodes extends AppearanceNodes, AudioNodes, PetNodes, StatusNodes, SystemNodes {
  fab: HTMLButtonElement;
  panel: HTMLDivElement;
  head: HTMLDivElement;
  tabs: HTMLDivElement;
  tabButtons: Map<TabId, HTMLButtonElement>;
  body: HTMLDivElement;
  sections: Map<TabId, HTMLElement>;
  footState: HTMLSpanElement;
  offline: HTMLDivElement;
  offlineMsg: HTMLDivElement;
  retry: HTMLButtonElement;
}

export interface SettingsPanelOptions {
  /** Plays one SFX event. When absent the Test buttons do nothing on purpose. */
  onTestSfx?: (event: string) => void;
  /** Plays one sample from the voice pool. */
  onTestVoice?: () => void;
}

/**
 * The settings centre. `mount()` attaches it, `destroy()` removes it, and the
 * window handle in `mount()` guarantees a re-injection retires the previous
 * instance instead of stacking a second FAB.
 */
export class SettingsPanel {
  private readonly defaults = defaultPrefs();
  private nodes: PanelNodes | undefined;
  private readonly disposers: Array<() => void> = [];
  /** Listeners on elements a track-list rebuild discards, released on rebuild. */
  private readonly transientDisposers: Array<() => void> = [];
  private alive = false;
  private offline = false;
  private pollTimer: number | null = null;
  private writeTimer: number | null = null;
  private pendingWrite: (() => void) | undefined;
  private lastWriteAt = 0;
  /** The slider a pointer or key is currently driving; refreshes skip it. */
  private activeInput: HTMLInputElement | undefined;
  private activeTab: TabId = "appearance";
  private lastBgm: BgmState | undefined;
  private lastSystem: SystemInfo | undefined;
  private lastStatus: Record<string, unknown> | undefined;
  private trackFingerprint = "";
  private emptyNoteKey = "";
  private drag: { pointerId: number; dx: number; dy: number } | undefined;

  constructor(
    private readonly ctx: ClientContext,
    private readonly controls: { bgm: BgmControl; pet: PetControl; status: StatusControl },
    private readonly opts: SettingsPanelOptions = {}
  ) {}

  // --- lifecycle ------------------------------------------------------------

  mount(): void {
    this.removeStale();
    if (this.nodes) return;
    const previous = panelWindow().__zcodeTarkovPanel;
    if (previous && previous !== this) {
      try {
        previous.destroy();
      } catch {
        /* a broken previous panel must not block this one */
      }
    }
    const root = this.uiRoot();
    if (!root) return;

    this.alive = true;
    const nodes = this.build();
    this.nodes = nodes;
    root.appendChild(nodes.fab);
    root.appendChild(nodes.panel);

    this.disposers.push(
      this.ctx.onPrefs((prefs) => {
        if (!this.alive) return;
        try {
          this.applyPrefs(prefs);
        } catch (err) {
          this.ctx.toastError(err, "界面刷新失败");
        }
      })
    );
    this.disposers.push(
      this.controls.bgm.onState((state) => {
        if (!this.alive) return;
        try {
          this.applyBgm(state);
        } catch (err) {
          this.ctx.toastError(err, "界面刷新失败");
        }
      })
    );
    this.disposers.push(
      this.ctx.audio.onUnlock(() => {
        if (this.alive) this.syncAudio();
      })
    );

    const prefs = this.readPrefs();
    if (prefs) this.applyPrefs(prefs);
    const bgm = this.readBgmState();
    if (bgm) this.applyBgm(bgm);
    this.selectTab(this.activeTab);
    this.syncAudio();
    this.syncStatus();
    this.renderSystem();
    panelWindow().__zcodeTarkovPanel = this;
  }

  destroy(): void {
    this.alive = false;
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose();
      } catch {
        /* a listener that was already detached must not stop the teardown */
      }
    }
    this.stopPolling();
    this.clearTransient();
    if (this.writeTimer !== null) {
      window.clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    this.pendingWrite = undefined;
    this.activeInput = undefined;
    this.drag = undefined;
    this.offline = false;
    this.lastBgm = undefined;
    this.lastSystem = undefined;
    this.lastStatus = undefined;
    this.trackFingerprint = "";
    this.emptyNoteKey = "";

    const nodes = this.nodes;
    this.nodes = undefined;
    if (nodes) {
      nodes.fab.remove();
      nodes.panel.remove();
    }
    if (panelWindow().__zcodeTarkovPanel === this) panelWindow().__zcodeTarkovPanel = undefined;
  }

  open(): void {
    if (!this.nodes) this.mount();
    const u = this.nodes;
    if (!u) return;
    this.setOpen(true);
    const prefs = this.readPrefs();
    if (prefs) this.applyPrefs(prefs);
    const bgm = this.readBgmState();
    if (bgm) this.applyBgm(bgm);
    this.syncAudio();
    this.syncStatus();
    void this.refreshConfig();
    void this.refreshSystem();
    this.refreshLibrary();
    this.updatePolling();
  }

  close(): void {
    if (!this.nodes) return;
    this.setOpen(false);
    this.updatePolling();
  }

  toggle(): void {
    if (this.isOpen()) this.close();
    else this.open();
  }

  isOpen(): boolean {
    const u = this.nodes;
    return u !== undefined && !u.panel.hidden;
  }

  // --- shell ----------------------------------------------------------------

  private build(): PanelNodes {
    const fab = button("设置");
    fab.id = FAB_ID;
    fab.className = "zct-card zct-surface zct-btn";
    // The FAB keeps the v0.1 geometry; skin.ts styles the dock's FAB by id and
    // this one must not steal that id, so the shape lives here as inline style.
    fab.style.position = "fixed";
    fab.style.right = "18px";
    fab.style.bottom = "18px";
    fab.style.zIndex = String(Z_PANEL);
    fab.style.width = "38px";
    fab.style.height = "38px";
    fab.style.padding = "0";
    fab.style.borderRadius = "var(--zct-radius-pill)";
    fab.style.fontWeight = "600";
    fab.setAttribute("aria-label", "打开 ZCode Tarkov 设置");
    fab.setAttribute("aria-expanded", "false");
    fab.title = "ZCode Tarkov 设置";

    const panel = make("div", "zct-card zct-surface");
    panel.id = PANEL_ID;
    panel.hidden = true;

    const head = make("div");
    head.id = "zct-panel-head";
    // Without this a touch pointer scrolls the page instead of dragging.
    head.style.touchAction = "none";
    const headTitle = make("strong", undefined, "ZCode Tarkov 设置");
    const closeBtn = button("X", "icon");
    closeBtn.setAttribute("aria-label", "关闭设置面板");
    closeBtn.title = "关闭";
    head.append(headTitle, closeBtn);

    const tabs = make("div");
    tabs.id = "zct-panel-tabs";
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "设置分类");
    const tabButtons = new Map<TabId, HTMLButtonElement>();
    for (const tab of TABS) {
      const tabButton = make("button");
      tabButton.type = "button";
      tabButton.id = `zct-tab-${tab.id}`;
      tabButton.dataset.tab = tab.id;
      tabButton.setAttribute("role", "tab");
      tabButton.setAttribute("aria-controls", PANEL_BODY_ID);
      tabButton.setAttribute("aria-selected", "false");
      tabButton.tabIndex = -1;
      tabButton.textContent = tab.label;
      tabs.appendChild(tabButton);
      tabButtons.set(tab.id, tabButton);
    }

    const offline = make("div");
    offline.id = "zct-panel-offline";
    offline.hidden = true;
    const offlineMsg = make("div", undefined, OFFLINE_FALLBACK);
    const offlineHint = make(
      "div",
      "zct-empty-note",
      "请从 ZCode Tarkov 快捷方式重新启动 ZCode,服务会随之恢复"
    );
    const retry = button("重试连接", "primary");
    offline.append(offlineMsg, offlineHint, retry);

    const body = make("div");
    body.id = PANEL_BODY_ID;
    body.setAttribute("role", "tabpanel");

    const footState = make("span", undefined, "已连接");
    const foot = make("div");
    foot.id = "zct-panel-foot";
    foot.append(make("span", undefined, `ZCode Tarkov v${this.apiVersion()}`), footState);

    panel.append(head, tabs, offline, body, foot);

    const panes: Record<TabId, HTMLDivElement> = {
      appearance: make("div"),
      audio: make("div"),
      pet: make("div"),
      status: make("div"),
      system: make("div"),
    };
    const appearance = this.buildAppearance(panes.appearance);
    const audio = this.buildAudio(panes.audio);
    const pet = this.buildPet(panes.pet);
    const status = this.buildStatus(panes.status);
    const system = this.buildSystem(panes.system);
    body.append(panes.appearance, panes.audio, panes.pet, panes.status, panes.system);
    const sections = new Map<TabId, HTMLElement>([
      ["appearance", panes.appearance],
      ["audio", panes.audio],
      ["pet", panes.pet],
      ["status", panes.status],
      ["system", panes.system],
    ]);

    this.listen(fab, "click", () => this.toggle());
    this.listen(closeBtn, "click", () => this.close());
    this.listen(tabs, "keydown", (ev) => this.onTabsKeyDown(ev as KeyboardEvent));
    this.listen(tabs, "click", (ev) => this.onTabsClick(ev));
    this.listen(retry, "click", () => void this.retry());
    this.listen(head, "pointerdown", (ev) => this.onDragStart(ev as PointerEvent));
    this.listen(head, "pointermove", (ev) => this.onDragMove(ev as PointerEvent));
    this.listen(head, "pointerup", (ev) => this.onDragEnd(ev as PointerEvent));
    this.listen(head, "pointercancel", (ev) => this.onDragEnd(ev as PointerEvent));
    this.listen(window, "resize", () => this.clampIntoView());
    this.listen(document, "keydown", (ev) => this.onDocumentKeyDown(ev as KeyboardEvent));

    return {
      fab,
      panel,
      head,
      tabs,
      tabButtons,
      body,
      sections,
      footState,
      offline,
      offlineMsg,
      retry,
      ...appearance,
      ...audio,
      ...pet,
      ...status,
      ...system,
    };
  }

  private setOpen(open: boolean): void {
    const u = this.nodes;
    if (!u) return;
    u.panel.hidden = !open;
    u.fab.setAttribute("aria-expanded", open ? "true" : "false");
  }

  /** Removes a panel or FAB this instance does not own, e.g. from an old build. */
  private removeStale(): void {
    for (const id of [PANEL_ID, FAB_ID]) {
      const stale = document.getElementById(id);
      if (!stale) continue;
      if (stale === this.nodes?.panel || stale === this.nodes?.fab) continue;
      try {
        stale.remove();
      } catch {
        /* already detached */
      }
    }
  }

  private uiRoot(): HTMLElement | undefined {
    try {
      return this.ctx.uiRoot();
    } catch {
      return undefined;
    }
  }

  private apiVersion(): string {
    try {
      return this.ctx.api.version || "未知";
    } catch {
      return "未知";
    }
  }

  private readPrefs(): Prefs | undefined {
    try {
      return this.ctx.prefs();
    } catch {
      return undefined;
    }
  }

  private readBgmState(): BgmState | undefined {
    try {
      return this.controls.bgm.state();
    } catch {
      return undefined;
    }
  }

  // --- appearance -----------------------------------------------------------

  private buildAppearance(pane: HTMLDivElement): AppearanceNodes {
    const screen = makeSection("界面与壁纸");
    const color = selectRow(
      "UI 配色",
      COLOR_MODES.map((mode) => ({ value: mode, label: COLOR_MODE_LABELS[mode] })),
      this.defaults.appearance.colorMode
    );
    const blur = sliderRow("背景模糊", 0, 30, 1, 0, asPixels);
    const dim = sliderRow("背景压暗", 0, 80, 1, 25, asPixels);
    const wallpaperVisible = checkboxRow("显示壁纸", true);
    const pickRow = make("div", "zct-row");
    const pick = button("更换图片...");
    const wallpaperFile = make("input");
    wallpaperFile.type = "file";
    wallpaperFile.accept = "image/*";
    wallpaperFile.hidden = true;
    pickRow.append(pick, wallpaperFile);
    const fitRow = make("div", "zct-row");
    const fit = button(`背景填充: ${FIT_LABELS.cover}`);
    fit.dataset.fit = "cover";
    fitRow.appendChild(fit);
    const resetRow = make("div", "zct-row");
    const reset = button("还原默认外观");
    reset.dataset.mode = "reset";
    reset.disabled = true;
    resetRow.appendChild(reset);
    screen.body.append(color.root, blur.root, dim.root, wallpaperVisible.root, pickRow, fitRow, resetRow);

    const bannerDefaults = defaultBanner();
    const banner = makeSection("顶部状态条");
    const bannerMode = selectRow(
      "状态条模式",
      BANNER_MODES.map((mode) => ({ value: mode, label: BANNER_LABELS[mode] })),
      bannerDefaults.mode
    );
    const bannerOpacity = sliderRow(
      "状态条不透明度",
      0,
      1,
      0.01,
      bannerDefaults.opacity,
      asPercent
    );
    banner.body.append(bannerMode.root, bannerOpacity.root);

    const palette = makeSection("调色盘");
    const paletteHint = make(
      "div",
      "zct-empty-note",
      "仅影响 Tarkov 配色模式;Monet / Native 模式保持各自的外观。"
    );
    const background = colorRow("背景颜色", this.defaults.appearance.background);
    const accent = colorRow("强调色", this.defaults.appearance.accent);
    const paletteResetRow = make("div", "zct-row");
    const paletteReset = button("恢复默认颜色");
    paletteResetRow.appendChild(paletteReset);
    palette.body.append(paletteHint, background.root, accent.root, paletteResetRow);

    const greeting = makeSection("欢迎界面文字");
    const greetingEnabled = checkboxRow(
      "显示欢迎界面提示",
      this.defaults.appearance.greeting.enabled
    );
    const greetingHint = make(
      "div",
      "zct-empty-note",
      "关闭后 ZCode 会显示它自己的问候语;内容留空会还原为默认文字。"
    );
    const greetingLine1 = textRow(
      "第一行",
      this.defaults.appearance.greeting.line1,
      GREETING_LINE1_MAX
    );
    const greetingLine2 = textRow(
      "第二行",
      this.defaults.appearance.greeting.line2,
      GREETING_LINE2_MAX
    );
    const greetingResetRow = make("div", "zct-row");
    const greetingReset = button("恢复默认文字");
    // Nothing to restore until a field differs from the shipped text.
    greetingReset.disabled = true;
    greetingResetRow.appendChild(greetingReset);
    greeting.body.append(
      greetingEnabled.root,
      greetingHint,
      greetingLine1.root,
      greetingLine2.root,
      greetingResetRow
    );

    pane.append(screen.root, banner.root, palette.root, greeting.root);

    this.listen(color.select, "change", () => {
      const mode = oneOf(color.select.value, COLOR_MODES);
      if (!mode) return;
      void this.api(() => this.ctx.api.setConfig({ colorMode: mode })).then((result) => {
        if (result) this.applyConfig(result);
      });
    });
    this.bindSlider(
      blur.input,
      (value) => {
        blur.readout.textContent = asPixels(value);
      },
      (value) => this.writeConfig({ blur: value })
    );
    this.bindSlider(
      dim.input,
      (value) => {
        dim.readout.textContent = asPixels(value);
      },
      (value) => this.writeConfig({ dim: value })
    );
    this.listen(wallpaperVisible.input, "change", () => {
      const visible = wallpaperVisible.input.checked;
      void this.api(() => this.ctx.api.setConfig({ wallpaperVisible: visible })).then((result) => {
        if (result) this.applyConfig(result);
      });
    });
    this.listen(pick, "click", () => {
      try {
        wallpaperFile.click();
      } catch {
        /* the picker is unavailable in this renderer */
      }
    });
    this.listen(wallpaperFile, "change", () => this.onWallpaperChosen(wallpaperFile));
    this.listen(fit, "click", () => {
      const current = oneOf(fit.dataset.fit, WALLPAPER_FITS) ?? "cover";
      const next = WALLPAPER_FITS[(WALLPAPER_FITS.indexOf(current) + 1) % WALLPAPER_FITS.length];
      void this.api(() => this.ctx.api.setConfig({ fit: next })).then((result) => {
        if (result) this.applyConfig(result);
        else this.applyFit(next);
      });
    });
    this.listen(reset, "click", () => void this.onReset());

    this.listen(bannerMode.select, "change", () => {
      const mode = oneOf(bannerMode.select.value, BANNER_MODES);
      if (mode) this.writePrefs({ appearance: { banner: { mode } } });
    });
    this.bindSlider(
      bannerOpacity.input,
      (value) => {
        bannerOpacity.readout.textContent = asPercent(value);
      },
      (value) => this.writePrefs({ appearance: { banner: { opacity: value } } })
    );

    this.bindLive(
      background.input,
      (value) => {
        background.readout.textContent = value;
      },
      (value) => this.writePrefs({ appearance: { background: value } })
    );
    this.bindLive(
      accent.input,
      (value) => {
        accent.readout.textContent = value;
      },
      (value) => this.writePrefs({ appearance: { accent: value } })
    );
    this.listen(paletteReset, "click", () => {
      // The write is fire-and-forget, so the controls are put back now and the
      // service push then repeats the same values.
      background.input.value = DEFAULT_PALETTE.background;
      background.readout.textContent = DEFAULT_PALETTE.background;
      accent.input.value = DEFAULT_PALETTE.accent;
      accent.readout.textContent = DEFAULT_PALETTE.accent;
      this.writePrefs({
        appearance: { background: DEFAULT_PALETTE.background, accent: DEFAULT_PALETTE.accent },
      });
    });
    this.listen(greetingEnabled.input, "change", () =>
      this.writePrefs({ appearance: { greeting: { enabled: greetingEnabled.input.checked } } })
    );
    this.bindLive(
      greetingLine1.input,
      (value) => {
        greetingLine1.counter.textContent = asCount(value, GREETING_LINE1_MAX);
        this.syncGreetingReset();
      },
      (value) =>
        this.writePrefs({
          appearance: { greeting: { line1: orDefault(value, DEFAULT_GREETING.line1) } },
        }),
      (value) => orDefault(value, DEFAULT_GREETING.line1)
    );
    this.bindLive(
      greetingLine2.input,
      (value) => {
        greetingLine2.counter.textContent = asCount(value, GREETING_LINE2_MAX);
        this.syncGreetingReset();
      },
      (value) =>
        this.writePrefs({
          appearance: { greeting: { line2: orDefault(value, DEFAULT_GREETING.line2) } },
        }),
      (value) => orDefault(value, DEFAULT_GREETING.line2)
    );
    this.listen(greetingReset, "click", () => {
      greetingLine1.input.value = DEFAULT_GREETING.line1;
      greetingLine1.counter.textContent = asCount(DEFAULT_GREETING.line1, GREETING_LINE1_MAX);
      greetingLine2.input.value = DEFAULT_GREETING.line2;
      greetingLine2.counter.textContent = asCount(DEFAULT_GREETING.line2, GREETING_LINE2_MAX);
      this.syncGreetingReset();
      this.writePrefs({
        appearance: {
          greeting: { line1: DEFAULT_GREETING.line1, line2: DEFAULT_GREETING.line2 },
        },
      });
    });

    return {
      colorMode: color.select,
      blur: blur.input,
      blurValue: blur.readout,
      dim: dim.input,
      dimValue: dim.readout,
      wallpaperVisible: wallpaperVisible.input,
      wallpaperFile,
      fit,
      reset,
      bannerMode: bannerMode.select,
      bannerOpacity: bannerOpacity.input,
      bannerOpacityValue: bannerOpacity.readout,
      colorBackground: background.input,
      colorBackgroundValue: background.readout,
      colorAccent: accent.input,
      colorAccentValue: accent.readout,
      paletteReset,
      greetingEnabled: greetingEnabled.input,
      greetingLine1: greetingLine1.input,
      greetingLine1Count: greetingLine1.counter,
      greetingLine2: greetingLine2.input,
      greetingLine2Count: greetingLine2.counter,
      greetingReset,
    };
  }

  private applyConfig(config: Record<string, unknown>): void {
    const u = this.nodes;
    if (!u) return;

    const mode =
      oneOf(readString(config, "colorMode"), COLOR_MODES) ??
      (readBoolean(config, "monet") === true ? "monet" : undefined);
    if (mode && !this.held(u.colorMode)) u.colorMode.value = mode;

    const blur = readNumber(config, "blur");
    if (blur !== undefined && !this.held(u.blur)) {
      u.blur.value = String(clamp(blur, 0, 30));
      u.blurValue.textContent = asPixels(Number(u.blur.value));
    }
    const dim = readNumber(config, "dim");
    if (dim !== undefined && !this.held(u.dim)) {
      u.dim.value = String(clamp(dim, 0, 80));
      u.dimValue.textContent = asPixels(Number(u.dim.value));
    }
    const visible = readBoolean(config, "wallpaperVisible");
    if (visible !== undefined && !this.held(u.wallpaperVisible)) u.wallpaperVisible.checked = visible;
    this.applyFit(oneOf(readString(config, "fit"), WALLPAPER_FITS));

    const wallpaperSet = config.wallpaperSet === true;
    const hasBackup = config.hasBackup === true;
    if (wallpaperSet) {
      u.reset.disabled = false;
      u.reset.textContent = "还原默认外观";
      u.reset.dataset.mode = "reset";
      u.reset.title = "移除壁纸与配色,还原 ZCode 默认外观(壁纸会被记住,可再次恢复)";
    } else if (hasBackup) {
      u.reset.disabled = false;
      u.reset.textContent = "恢复我的壁纸";
      u.reset.dataset.mode = "restore";
      u.reset.title = "从备份恢复你之前的壁纸与配色";
    } else {
      u.reset.disabled = true;
      u.reset.textContent = "还原默认外观";
      u.reset.dataset.mode = "reset";
      u.reset.title = "当前已是默认外观";
    }
  }

  private applyFit(fit: WallpaperFitName | undefined): void {
    const u = this.nodes;
    if (!u || !fit) return;
    u.fit.textContent = `背景填充: ${FIT_LABELS[fit]}`;
    u.fit.dataset.fit = fit;
  }

  /**
   * The restore button only means something while the fields differ from the
   * shipped text. It reads the live fields rather than the stored prefs so the
   * button agrees with what the user is looking at, including mid-edit.
   */
  private syncGreetingReset(): void {
    const u = this.nodes;
    if (!u) return;
    u.greetingReset.disabled =
      u.greetingLine1.value === DEFAULT_GREETING.line1 &&
      u.greetingLine2.value === DEFAULT_GREETING.line2;
  }

  private writeConfig(patch: Record<string, unknown>): void {
    void this.api(() => this.ctx.api.setConfig(patch)).then((result) => {
      if (result) this.applyConfig(result);
    });
  }

  private onWallpaperChosen(input: HTMLInputElement): void {
    const file = input.files && input.files[0];
    input.value = "";
    if (!file) return;
    if (file.size > MAX_WALLPAPER_BYTES) {
      this.ctx.toast("图片过大,上限 20 MB");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUri = typeof reader.result === "string" ? reader.result : "";
      if (dataUri.length === 0) {
        this.ctx.toastError(reader.error, "读取图片失败");
        return;
      }
      void this.api(() => this.ctx.api.setWallpaper(dataUri, file.name)).then((result) => {
        if (!result) return;
        this.applyConfig(result);
        this.ctx.toast("壁纸已更新");
      });
    };
    reader.onerror = () => this.ctx.toastError(reader.error, "读取图片失败");
    reader.readAsDataURL(file);
  }

  private async onReset(): Promise<void> {
    const u = this.nodes;
    if (!u) return;
    const restore = u.reset.dataset.mode === "restore";
    try {
      const result = restore ? await this.ctx.api.restore() : await this.ctx.api.reset();
      if (!this.alive) return;
      this.setOffline(false);
      this.applyConfig(result);
      this.ctx.toast(restore ? "已恢复你的壁纸" : "已还原默认外观");
      void this.refreshConfig();
    } catch (err) {
      if (this.alive) this.setOffline(true, err);
    }
  }

  // --- audio ----------------------------------------------------------------

  private buildAudio(pane: HTMLDivElement): AudioNodes {
    const master = makeSection("总开关");
    const audioEnabled = checkboxRow("启用音频", this.defaults.audio.enabled);
    const masterVolume = sliderRow(
      "主音量",
      0,
      1,
      0.01,
      this.defaults.audio.masterVolume,
      asPercent
    );
    master.body.append(audioEnabled.root, masterVolume.root);

    const unlockSection = make("div", "zct-section");
    const unlockState = make("div", "zct-empty-note", "浏览器尚未授权音频播放");
    const unlockBtn = button("启用音频", "primary");
    unlockSection.append(make("h4", undefined, "音频授权"), unlockState, unlockBtn);

    const bgm = makeSection("背景音乐");
    const bgmEnabled = checkboxRow("启用背景音乐", this.defaults.audio.bgm.enabled);
    const bgmVolume = sliderRow("音乐音量", 0, 1, 0.01, this.defaults.audio.bgm.volume, asPercent);
    const transport = make("div", "zct-row");
    const bgmPrev = button("上一首");
    const bgmPlay = button("播放");
    const bgmNext = button("下一首");
    transport.append(bgmPrev, bgmPlay, bgmNext);
    const options = make("div", "zct-row");
    const bgmShuffle = button("随机播放");
    const bgmRepeat = button("循环: 列表");
    options.append(bgmShuffle, bgmRepeat);
    const bgmTitle = make("div", "zct-value", "未在播放");
    const bgmPosition = make("div", "zct-empty-note", "0:00 / 0:00");
    const tracks = make("div");
    tracks.id = "zct-tracks";
    const emptyNote = make("div", "zct-empty-note");
    emptyNote.id = "zct-empty-note";
    emptyNote.hidden = true;
    const uploadBar = make("div");
    uploadBar.id = "zct-upload-bar";
    const uploadFill = make("i");
    uploadBar.appendChild(uploadFill);
    uploadBar.hidden = true;
    const addRow = make("div", "zct-row");
    const addMusic = button("添加音乐...", "primary");
    const musicFile = make("input");
    musicFile.type = "file";
    musicFile.accept = "audio/*";
    musicFile.hidden = true;
    addRow.append(addMusic, musicFile);
    bgm.body.append(
      bgmEnabled.root,
      bgmVolume.root,
      transport,
      options,
      bgmTitle,
      bgmPosition,
      tracks,
      emptyNote,
      uploadBar,
      addRow
    );

    const sfx = makeSection("音效");
    const sfxEnabled = checkboxRow("启用音效", this.defaults.audio.sfx.enabled);
    const sfxVolume = sliderRow("音效音量", 0, 1, 0.01, this.defaults.audio.sfx.volume, asPercent);
    sfx.body.append(sfxEnabled.root, sfxVolume.root);
    const sfxEventInputs = new Map<string, HTMLInputElement>();
    for (const event of SFX_EVENTS) {
      const row = checkboxRow(SFX_LABELS[event], true);
      const test = button("试听", "icon");
      test.title = "播放该事件的音效";
      row.root.appendChild(test);
      sfx.body.appendChild(row.root);
      sfxEventInputs.set(event, row.input);
      this.listen(test, "click", () => {
        // No callback means no player exists yet; doing nothing beats faking it.
        this.opts.onTestSfx?.(event);
      });
    }

    const voice = makeSection("宠物语音");
    const voiceEnabled = checkboxRow("启用宠物语音", this.defaults.audio.voice.enabled);
    const voiceVolume = sliderRow(
      "语音音量",
      0,
      1,
      0.01,
      this.defaults.audio.voice.volume,
      asPercent
    );
    const voiceChance = sliderRow(
      "点击触发概率",
      0,
      1,
      0.05,
      this.defaults.audio.voice.chance,
      asPercent
    );
    const voiceTestRow = make("div", "zct-row");
    const voiceTest = button("试听语音");
    voiceTestRow.appendChild(voiceTest);
    const poolRow = make("div", "zct-row");
    const voicePool = make("span", "zct-value", "0 个片段");
    const voiceRefresh = button("刷新", "icon");
    poolRow.append(make("label", undefined, "语音池"), voicePool, voiceRefresh);
    voice.body.append(
      voiceEnabled.root,
      voiceVolume.root,
      voiceChance.root,
      voiceTestRow,
      poolRow
    );

    pane.append(master.root, unlockSection, bgm.root, sfx.root, voice.root);

    this.listen(audioEnabled.input, "change", () =>
      this.writePrefs({ audio: { enabled: audioEnabled.input.checked } })
    );
    this.bindSlider(
      masterVolume.input,
      (value) => {
        masterVolume.readout.textContent = asPercent(value);
      },
      (value) => this.writePrefs({ audio: { masterVolume: value } })
    );
    this.listen(unlockBtn, "click", () => void this.unlockAudio());
    this.listen(bgmEnabled.input, "change", () =>
      this.writePrefs({ audio: { bgm: { enabled: bgmEnabled.input.checked } } })
    );
    this.bindSlider(
      bgmVolume.input,
      (value) => {
        bgmVolume.readout.textContent = asPercent(value);
      },
      (value) => this.writePrefs({ audio: { bgm: { volume: value } } })
    );
    this.listen(bgmPrev, "click", () =>
      this.controlCall(() => this.controls.bgm.prev(), "切换曲目失败")
    );
    this.listen(bgmPlay, "click", () =>
      this.controlCall(() => this.controls.bgm.toggle(), "播放控制失败")
    );
    this.listen(bgmNext, "click", () =>
      this.controlCall(() => this.controls.bgm.next(), "切换曲目失败")
    );
    this.listen(bgmShuffle, "click", () =>
      this.controlCall(
        () => this.controls.bgm.setShuffle(!(this.lastBgm?.shuffle ?? false)),
        "切换随机播放失败"
      )
    );
    this.listen(bgmRepeat, "click", () =>
      this.controlCall(
        () => this.controls.bgm.setRepeat(this.lastBgm?.repeat === "one" ? "all" : "one"),
        "切换循环模式失败"
      )
    );
    this.listen(addMusic, "click", () => {
      try {
        musicFile.click();
      } catch {
        /* the picker is unavailable in this renderer */
      }
    });
    this.listen(musicFile, "change", () => this.onMusicChosen(musicFile));
    this.listen(sfxEnabled.input, "change", () =>
      this.writePrefs({ audio: { sfx: { enabled: sfxEnabled.input.checked } } })
    );
    this.bindSlider(
      sfxVolume.input,
      (value) => {
        sfxVolume.readout.textContent = asPercent(value);
      },
      (value) => this.writePrefs({ audio: { sfx: { volume: value } } })
    );
    for (const [event, input] of sfxEventInputs) {
      this.listen(input, "change", () =>
        this.writePrefs({ audio: { sfx: { events: { [event]: input.checked } } } })
      );
    }
    this.listen(voiceEnabled.input, "change", () =>
      this.writePrefs({ audio: { voice: { enabled: voiceEnabled.input.checked } } })
    );
    this.bindSlider(
      voiceVolume.input,
      (value) => {
        voiceVolume.readout.textContent = asPercent(value);
      },
      (value) => this.writePrefs({ audio: { voice: { volume: value } } })
    );
    this.bindSlider(
      voiceChance.input,
      (value) => {
        voiceChance.readout.textContent = asPercent(value);
      },
      (value) => this.writePrefs({ audio: { voice: { chance: value } } })
    );
    this.listen(voiceTest, "click", () => this.opts.onTestVoice?.());
    this.listen(voiceRefresh, "click", () => void this.refreshVoicePool());

    return {
      audioEnabled: audioEnabled.input,
      masterVolume: masterVolume.input,
      masterVolumeValue: masterVolume.readout,
      unlockSection,
      unlockState,
      unlockBtn,
      bgmEnabled: bgmEnabled.input,
      bgmVolume: bgmVolume.input,
      bgmVolumeValue: bgmVolume.readout,
      bgmShuffle,
      bgmRepeat,
      bgmPrev,
      bgmPlay,
      bgmNext,
      bgmTitle,
      bgmPosition,
      tracks,
      emptyNote,
      uploadBar,
      uploadFill,
      addMusic,
      musicFile,
      sfxEnabled: sfxEnabled.input,
      sfxVolume: sfxVolume.input,
      sfxVolumeValue: sfxVolume.readout,
      sfxEventInputs,
      voiceEnabled: voiceEnabled.input,
      voiceVolume: voiceVolume.input,
      voiceVolumeValue: voiceVolume.readout,
      voiceChance: voiceChance.input,
      voiceChanceValue: voiceChance.readout,
      voiceTest,
      voicePool,
      voiceRefresh,
    };
  }

  private applyBgm(state: BgmState): void {
    const u = this.nodes;
    if (!u) return;
    this.lastBgm = state;
    u.bgmTitle.textContent = state.title.length > 0 ? state.title : "未在播放";
    u.bgmPosition.textContent = `${formatClock(state.positionSeconds)} / ${formatClock(state.durationSeconds)}`;
    u.bgmPlay.textContent = state.playing ? "暂停" : "播放";
    u.bgmShuffle.dataset.state = state.shuffle ? "on" : "off";
    u.bgmRepeat.textContent = state.repeat === "one" ? "循环: 单曲" : "循环: 列表";
    u.bgmRepeat.dataset.state = state.repeat === "one" ? "on" : "off";
    this.renderTracks(state);
  }

  /**
   * Rebuilds the library list only when it actually changed.
   *
   * The player emits on every `timeupdate`, so an unguarded rebuild would
   * discard the row the user is tabbing through four times a second. The
   * fingerprint includes the current track so the highlight still follows.
   */
  private renderTracks(state: BgmState): void {
    const u = this.nodes;
    if (!u) return;
    this.syncEmptyNote();
    const fingerprint = `${state.trackId ?? ""}\u0000${state.tracks
      .map((track) => `${track.id}\u0000${track.enabled ? "1" : "0"}\u0000${track.durationSeconds ?? ""}`)
      .join("\u0001")}`;
    if (fingerprint === this.trackFingerprint) return;
    this.trackFingerprint = fingerprint;
    this.clearTransient();
    u.tracks.replaceChildren();
    for (const track of state.tracks) {
      const row = make("div", "zct-track");
      row.dataset.current = state.trackId === track.id ? "1" : "0";
      row.dataset.disabled = track.enabled ? "0" : "1";

      const toggle = make("input");
      toggle.type = "checkbox";
      toggle.checked = track.enabled;
      toggle.title = track.enabled ? "停用该曲目" : "启用该曲目";
      toggle.setAttribute("aria-label", `${track.displayName} 启用`);
      this.listenTransient(toggle, "change", () => void this.toggleTrack(track.id, toggle.checked));

      const name = make("span", "zct-track-name", track.displayName);
      name.setAttribute("role", "button");
      name.tabIndex = 0;
      name.title = "设为当前曲目";
      const select = () => this.controlCall(() => this.controls.bgm.select(track.id), "选择曲目失败");
      this.listenTransient(name, "click", select);
      this.listenTransient(name, "keydown", (ev) => {
        const key = (ev as KeyboardEvent).key;
        if (key !== "Enter" && key !== " ") return;
        ev.preventDefault();
        select();
      });

      const meta = make(
        "span",
        "zct-track-meta",
        track.durationSeconds !== undefined && track.durationSeconds > 0
          ? formatClock(track.durationSeconds)
          : ""
      );
      const remove = button("删除", "icon");
      remove.title = "从 music 文件夹删除该文件";
      this.listenTransient(remove, "click", () => void this.removeTrack(track.id));

      row.append(toggle, name, meta, remove);
      u.tracks.appendChild(row);
    }
  }

  private syncEmptyNote(): void {
    const u = this.nodes;
    if (!u) return;
    const state = this.lastBgm;
    const empty = state === undefined || state.empty || state.tracks.length === 0;
    u.tracks.hidden = empty;
    u.emptyNote.hidden = !empty;
    // The playhead emits four times a second, so the note is rebuilt only when
    // what it says actually changed (its text carries the resolved path).
    const musicDir = empty ? this.musicDir() : undefined;
    const key = empty ? `empty:${musicDir ?? ""}` : "tracks";
    if (key === this.emptyNoteKey) return;
    this.emptyNoteKey = key;
    if (!empty) {
      u.emptyNote.replaceChildren();
      return;
    }
    const parts: Node[] = [
      document.createTextNode("音乐库为空,把音频文件放进 music 文件夹即可自动收录:"),
    ];
    if (musicDir) parts.push(make("br"), make("code", undefined, musicDir));
    parts.push(make("br"), document.createTextNode("也可以点击下方的添加音乐按钮上传"));
    u.emptyNote.replaceChildren(...parts);
  }

  private musicDir(): string | undefined {
    const sys = this.lastSystem;
    if (!sys) return undefined;
    const raw = sys as unknown as Record<string, unknown>;
    const dirs = Array.isArray(raw.mediaDirs) ? raw.mediaDirs : [];
    for (const entry of dirs) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      if (readString(record, "kind") !== "music") continue;
      const path = readString(record, "path");
      if (path && path.length > 0) return path;
    }
    return undefined;
  }

  private syncAudio(): void {
    const u = this.nodes;
    if (!u) return;
    const unlocked = this.audioFlag("unlocked");
    u.unlockSection.hidden = unlocked;
    if (!unlocked) {
      u.unlockState.textContent = this.audioFlag("locked")
        ? "音频已锁定,点击启用"
        : "浏览器尚未授权音频播放,点击下方按钮启用";
    }
    u.voicePool.textContent = `${this.voicePoolSize()} 个片段`;
  }

  private audioFlag(key: "unlocked" | "locked"): boolean {
    try {
      return key === "unlocked" ? this.ctx.audio.unlocked : this.ctx.audio.locked;
    } catch {
      return false;
    }
  }

  private voicePoolSize(): number {
    try {
      return this.controls.pet.voicePoolSize();
    } catch {
      return 0;
    }
  }

  private async unlockAudio(): Promise<void> {
    const u = this.nodes;
    if (!u) return;
    u.unlockBtn.disabled = true;
    try {
      const ok = await this.ctx.audio.tryUnlock();
      if (!this.alive) return;
      this.ctx.toast(ok ? "音频已启用" : "浏览器仍阻止音频播放,请先点击页面任意位置");
    } catch (err) {
      if (this.alive) this.ctx.toastError(err, "启用音频失败");
    } finally {
      const nodes = this.nodes;
      if (nodes) nodes.unlockBtn.disabled = false;
    }
    this.syncAudio();
  }

  private onMusicChosen(input: HTMLInputElement): void {
    const file = input.files && input.files[0];
    input.value = "";
    if (!file) return;
    void this.uploadTrack(file);
  }

  private async uploadTrack(file: File): Promise<void> {
    const u = this.nodes;
    if (!u) return;
    u.uploadBar.hidden = false;
    u.uploadFill.style.width = "0%";
    try {
      await this.controls.bgm.upload(file, (fraction) => {
        const nodes = this.nodes;
        if (!nodes) return;
        nodes.uploadFill.style.width = `${Math.round(clamp(fraction, 0, 1) * 100)}%`;
      });
      if (!this.alive) return;
      u.uploadFill.style.width = "100%";
      this.ctx.toast("音乐已添加");
    } catch (err) {
      if (this.alive) this.ctx.toastError(err, "上传失败");
    } finally {
      const nodes = this.nodes;
      if (nodes) {
        nodes.uploadBar.hidden = true;
        nodes.uploadFill.style.width = "0%";
      }
    }
  }

  private async toggleTrack(name: string, enabled: boolean): Promise<void> {
    try {
      await this.controls.bgm.toggleTrack(name, enabled);
    } catch (err) {
      if (this.alive) this.ctx.toastError(err, "切换曲目失败");
    }
  }

  private async removeTrack(name: string): Promise<void> {
    try {
      await this.controls.bgm.remove(name);
      if (this.alive) this.ctx.toast(`已删除 ${name}`);
    } catch (err) {
      if (this.alive) this.ctx.toastError(err, "删除曲目失败");
    }
  }

  private async refreshVoicePool(): Promise<void> {
    const u = this.nodes;
    if (!u) return;
    u.voiceRefresh.disabled = true;
    try {
      const size = await this.controls.pet.refreshVoicePool();
      if (!this.alive) return;
      u.voicePool.textContent = `${size} 个片段`;
      this.ctx.toast(`语音池已刷新: ${size} 个片段`);
    } catch (err) {
      if (this.alive) this.ctx.toastError(err, "刷新语音池失败");
    } finally {
      const nodes = this.nodes;
      if (nodes) nodes.voiceRefresh.disabled = false;
    }
  }

  // --- pet ------------------------------------------------------------------

  private buildPet(pane: HTMLDivElement): PetNodes {
    const pet = makeSection("宠物");
    const petEnabled = checkboxRow("启用宠物", this.defaults.pet.enabled);
    const petScale = sliderRow("大小", 24, 320, 1, this.defaults.pet.scale, asPixels);
    const petOpacity = sliderRow("不透明度", 0.1, 1, 0.05, this.defaults.pet.opacity, asPercent);
    const petVoiceOnClick = checkboxRow("点击时播放语音", this.defaults.pet.voiceOnClick);
    const resetRow = make("div", "zct-row");
    const petReset = button("重置宠物位置");
    resetRow.appendChild(petReset);
    pet.body.append(
      petEnabled.root,
      petScale.root,
      petOpacity.root,
      petVoiceOnClick.root,
      resetRow
    );
    pane.appendChild(pet.root);

    this.listen(petEnabled.input, "change", () =>
      this.writePrefs({ pet: { enabled: petEnabled.input.checked } })
    );
    this.bindSlider(
      petScale.input,
      (value) => {
        petScale.readout.textContent = asPixels(value);
      },
      (value) => this.writePrefs({ pet: { scale: value } })
    );
    this.bindSlider(
      petOpacity.input,
      (value) => {
        petOpacity.readout.textContent = asPercent(value);
      },
      (value) => this.writePrefs({ pet: { opacity: value } })
    );
    this.listen(petVoiceOnClick.input, "change", () =>
      this.writePrefs({ pet: { voiceOnClick: petVoiceOnClick.input.checked } })
    );
    this.listen(petReset, "click", () =>
      this.controlCall(() => this.controls.pet.resetPosition(), "重置宠物位置失败")
    );

    return {
      petEnabled: petEnabled.input,
      petScale: petScale.input,
      petScaleValue: petScale.readout,
      petOpacity: petOpacity.input,
      petOpacityValue: petOpacity.readout,
      petVoiceOnClick: petVoiceOnClick.input,
      petReset,
    };
  }

  // --- status ---------------------------------------------------------------

  private buildStatus(pane: HTMLDivElement): StatusNodes {
    const status = makeSection("状态文案");
    const statusEnabled = checkboxRow("启用状态文案", this.defaults.status.enabled);
    const statusLanguage = selectRow(
      "语言",
      STATUS_LANGUAGES.map((language) => ({
        value: language,
        label: LANGUAGE_LABELS[language],
      })),
      this.defaults.status.language
    );
    const triggers = make("div");
    const statusTriggerInputs = new Map<string, HTMLInputElement>();
    for (const trigger of STATUS_TRIGGERS) {
      const row = checkboxRow(TRIGGER_LABELS[trigger] ?? trigger, true);
      triggers.appendChild(row.root);
      statusTriggerInputs.set(trigger, row.input);
    }
    const reloadRow = make("div", "zct-row");
    const statusReload = button("重新加载文案池");
    const statusReloadInfo = make("span", "zct-value", "");
    reloadRow.append(statusReload, statusReloadInfo);
    const sourceRow = make("div", "zct-row");
    const statusPool = make("span", "zct-value", "未知");
    sourceRow.append(make("label", undefined, "文案来源"), statusPool);
    const previewRow = make("div", "zct-row");
    previewRow.appendChild(make("label", undefined, "当前文案预览"));
    const statusPhrase = make("div", "zct-empty-note", "当前没有正在显示的状态文案");
    status.body.append(
      statusEnabled.root,
      statusLanguage.root,
      triggers,
      reloadRow,
      sourceRow,
      previewRow,
      statusPhrase
    );
    pane.appendChild(status.root);

    this.listen(statusEnabled.input, "change", () =>
      this.writePrefs({ status: { enabled: statusEnabled.input.checked } })
    );
    this.listen(statusLanguage.select, "change", () => {
      const language = oneOf(statusLanguage.select.value, STATUS_LANGUAGES);
      if (language) this.writePrefs({ status: { language } });
    });
    for (const [trigger, input] of statusTriggerInputs) {
      this.listen(input, "change", () =>
        this.writePrefs({ status: { triggers: { [trigger]: input.checked } } })
      );
    }
    this.listen(statusReload, "click", () => void this.reloadStatusPool());

    return {
      statusEnabled: statusEnabled.input,
      statusLanguage: statusLanguage.select,
      statusTriggerInputs,
      statusReload,
      statusReloadInfo,
      statusPool,
      statusPhrase,
    };
  }

  private async reloadStatusPool(): Promise<void> {
    const u = this.nodes;
    if (!u) return;
    u.statusReload.disabled = true;
    try {
      const count = await this.controls.status.reload();
      if (!this.alive) return;
      u.statusReloadInfo.textContent = `${count} 条`;
      this.syncStatus();
      this.ctx.toast(`文案池已重新加载: ${count} 条`);
    } catch (err) {
      if (this.alive) this.ctx.toastError(err, "重新加载文案池失败");
    } finally {
      const nodes = this.nodes;
      if (nodes) nodes.statusReload.disabled = false;
    }
  }

  private syncStatus(): void {
    const u = this.nodes;
    if (!u) return;
    let source = "未知";
    try {
      const value = this.controls.status.poolSource();
      source = value === "user" ? "自定义文案池" : value === "bundled" ? "内置文案池" : "未知来源";
    } catch {
      /* the roller is not running; keep the unknown label */
    }
    u.statusPool.textContent = source;
    let phrase: string | undefined;
    try {
      phrase = this.controls.status.currentPhrase();
    } catch {
      phrase = undefined;
    }
    u.statusPhrase.textContent =
      phrase !== undefined && phrase.length > 0 ? phrase : "当前没有正在显示的状态文案";
  }

  // --- system ---------------------------------------------------------------

  private buildSystem(pane: HTMLDivElement): SystemNodes {
    pane.id = "zct-system";
    pane.className = "zct-section";
    const systemDl = make("dl");
    const warn = make(
      "div",
      "zct-warn",
      "服务不可达或 CDP 未连接时,请从 ZCode Tarkov 快捷方式重新启动 ZCode"
    );
    const details = make("details");
    const systemAdvanced = make("dl");
    details.append(make("summary", undefined, "高级诊断"), systemAdvanced);
    pane.append(make("h4", undefined, "系统"), systemDl, warn, details);
    return { systemDl, systemAdvanced };
  }

  private applySystem(system: SystemInfo): void {
    this.lastSystem = system;
    this.renderSystem();
    this.syncEmptyNote();
  }

  private applyStatusInfo(status: Record<string, unknown>): void {
    this.lastStatus = status;
    this.renderSystem();
  }

  private renderSystem(): void {
    const u = this.nodes;
    if (!u) return;
    const rows: Array<[string, string]> = [];
    const system = this.lastSystem;
    if (!system) {
      rows.push(["插件版本", this.apiVersion()]);
      rows.push(["后台服务", this.offline ? "不可达" : "读取中..."]);
      u.systemDl.replaceChildren(...this.definition(rows));
      u.systemAdvanced.replaceChildren();
      return;
    }
    const raw = system as unknown as Record<string, unknown>;
    rows.push(["插件版本", readString(raw, "version") ?? this.apiVersion()]);
    rows.push(["后台服务", this.offline ? "不可达" : "运行中"]);
    const status = this.lastStatus;
    if (this.offline) {
      rows.push(["ZCode 连接", "不可达"]);
    } else if (status) {
      const cdp = status.cdpReachable === true;
      const renderers = readNumber(status, "rendererCount") ?? 0;
      const running = status.zcodeRunning === true;
      rows.push([
        "ZCode 连接",
        cdp
          ? `CDP 已连接 (${renderers} 个渲染器)`
          : running
            ? "ZCode 运行中,CDP 未连接"
            : "ZCode 未运行",
      ]);
    } else {
      rows.push(["ZCode 连接", "读取中..."]);
    }
    const dataRoot = readString(raw, "dataRoot");
    rows.push(["数据目录", dataRoot && dataRoot.length > 0 ? dataRoot : "未知"]);
    const dirs = Array.isArray(raw.mediaDirs) ? raw.mediaDirs : [];
    for (const entry of dirs) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const kind = readString(record, "kind") ?? "media";
      const path = readString(record, "path") ?? "";
      rows.push([`素材目录 (${kind})`, path]);
    }
    u.systemDl.replaceChildren(...this.definition(rows));

    const pid = readNumber(raw, "pid");
    const uptime = readNumber(raw, "uptimeSeconds");
    const startedAt = readString(raw, "startedAt");
    const advanced: Array<[string, string]> = [
      ["PID", pid !== undefined ? String(pid) : "未知"],
      ["运行时长", uptime !== undefined ? formatUptime(uptime) : "未知"],
    ];
    if (startedAt && startedAt.length > 0) advanced.push(["启动时间", startedAt]);
    u.systemAdvanced.replaceChildren(...this.definition(advanced));
  }

  private definition(rows: Array<[string, string]>): HTMLElement[] {
    return rows.flatMap(([term, value]) => [
      make("dt", undefined, term),
      make("dd", undefined, value),
    ]);
  }

  // --- data flow ------------------------------------------------------------

  private async api<T>(work: () => Promise<T>): Promise<T | undefined> {
    try {
      const result = await work();
      if (!this.alive) return undefined;
      this.setOffline(false);
      return result;
    } catch (err) {
      if (this.alive) this.setOffline(true, err);
      return undefined;
    }
  }

  private writePrefs(patch: DeepPartial<Prefs>): void {
    void this.api(() => this.ctx.patchPrefs(patch));
  }

  private controlCall<T>(work: () => T, fallback: string): T | undefined {
    try {
      return work();
    } catch (err) {
      this.ctx.toastError(err, fallback);
      return undefined;
    }
  }

  private async refreshConfig(): Promise<void> {
    if (!this.alive) return;
    const wasOffline = this.offline;
    try {
      const config = await this.ctx.api.getConfig();
      if (!this.alive) return;
      this.applyConfig(config);
      this.syncStatus();
      this.setOffline(false);
      if (wasOffline) {
        void this.refreshSystem();
        this.refreshLibrary();
      }
    } catch (err) {
      if (this.alive) this.setOffline(true, err);
    }
  }

  private async refreshSystem(): Promise<void> {
    if (!this.alive) return;
    const [system, status] = await Promise.all([
      this.ctx.api.getSystem().catch((): undefined => undefined),
      this.ctx.api.getStatus().catch((): undefined => undefined),
    ]);
    if (!this.alive) return;
    if (system) this.applySystem(system);
    if (status) this.applyStatusInfo(status);
    if (!system && !status) this.setOffline(true);
    else this.setOffline(false);
  }

  /** The library refresh is background work; the config poll already reports service health. */
  private refreshLibrary(): void {
    void this.controls.bgm.refresh().catch((): void => undefined);
  }

  private async retry(): Promise<void> {
    const u = this.nodes;
    if (!u) return;
    u.retry.disabled = true;
    u.retry.textContent = "正在重试...";
    await this.refreshConfig();
    const nodes = this.nodes;
    if (!nodes) return;
    nodes.retry.disabled = false;
    nodes.retry.textContent = "重试连接";
    if (!this.offline) {
      void this.refreshSystem();
      this.refreshLibrary();
    }
  }

  private setOffline(offline: boolean, err?: unknown): void {
    const u = this.nodes;
    if (!u) return;
    this.offline = offline;
    if (offline) {
      u.panel.setAttribute("data-offline", "1");
      u.offlineMsg.textContent = err !== undefined ? errorMessage(err, OFFLINE_FALLBACK) : OFFLINE_FALLBACK;
    } else {
      u.panel.removeAttribute("data-offline");
    }
    u.offline.hidden = !offline;
    u.footState.textContent = offline ? "服务离线" : "已连接";
    u.fab.title = offline ? "ZCode Tarkov 设置 - 服务离线" : "ZCode Tarkov 设置";
    this.renderSystem();
    this.updatePolling();
  }

  /** Polling exists only while the panel is visible or the service is down. */
  private updatePolling(): void {
    if (!this.alive) {
      this.stopPolling();
      return;
    }
    const shouldPoll = this.isOpen() || this.offline;
    if (shouldPoll && this.pollTimer === null) {
      this.pollTimer = window.setInterval(() => void this.refreshConfig(), POLL_MS);
    } else if (!shouldPoll) {
      this.stopPolling();
    }
  }

  private stopPolling(): void {
    if (this.pollTimer === null) return;
    window.clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  // --- interaction ----------------------------------------------------------

  private listen(target: EventTarget, type: string, handler: EventListener): void {
    target.addEventListener(type, handler);
    this.disposers.push(() => target.removeEventListener(type, handler));
  }

  private listenTransient(target: EventTarget, type: string, handler: EventListener): void {
    target.addEventListener(type, handler);
    this.transientDisposers.push(() => target.removeEventListener(type, handler));
  }

  private clearTransient(): void {
    for (const dispose of this.transientDisposers.splice(0)) {
      try {
        dispose();
      } catch {
        /* the row it belonged to is already detached */
      }
    }
  }

  /**
   * Wires one slider.
   *
   * `input` updates the readout and the shared in-memory copy immediately and
   * requests a throttled write; `change` always writes the final value, so a
   * drag that ends between two throttle windows is never lost.
   */
  private bindSlider(
    input: HTMLInputElement,
    readout: (value: number) => void,
    write: (value: number) => void
  ): void {
    this.listen(input, "input", () => {
      this.activeInput = input;
      const value = Number(input.value);
      readout(value);
      this.queueWrite(() => write(value), false);
    });
    this.listen(input, "change", () => {
      this.activeInput = undefined;
      const value = Number(input.value);
      readout(value);
      this.queueWrite(() => write(value), true);
    });
  }

  /**
   * Wires one live value control: a colour picker or a text field.
   *
   * `input` fires on every keystroke and continuously while an OS colour picker
   * is open, so the write goes through the shared throttle; `change` is the
   * commit and always writes. Holding the element in `activeInput` between the
   * two is what keeps a refresh from rewriting a field still being edited.
   * `normalize` runs on the commit, which is where a blank text field turns back
   * into something the validator would store rather than silently reject.
   */
  private bindLive(
    input: HTMLInputElement,
    onValue: (value: string) => void,
    write: (value: string) => void,
    normalize?: (value: string) => string
  ): void {
    this.listen(input, "input", () => {
      this.activeInput = input;
      const value = input.value;
      onValue(value);
      this.queueWrite(() => write(value), false);
    });
    this.listen(input, "change", () => {
      this.activeInput = undefined;
      const value = normalize !== undefined ? normalize(input.value) : input.value;
      if (value !== input.value) input.value = value;
      onValue(value);
      this.queueWrite(() => write(value), true);
    });
  }

  private queueWrite(write: () => void, immediate: boolean): void {
    if (!this.alive) return;
    const now = Date.now();
    const earliest = this.lastWriteAt + SLIDER_WRITE_MS;
    if (immediate || now >= earliest) {
      if (this.writeTimer !== null) {
        window.clearTimeout(this.writeTimer);
        this.writeTimer = null;
      }
      this.pendingWrite = undefined;
      this.lastWriteAt = now;
      write();
      return;
    }
    this.pendingWrite = write;
    if (this.writeTimer === null) {
      this.writeTimer = window.setTimeout(() => {
        this.writeTimer = null;
        const pending = this.pendingWrite;
        this.pendingWrite = undefined;
        this.lastWriteAt = Date.now();
        try {
          pending?.();
        } catch {
          /* the write path reports its own failures */
        }
      }, earliest - now);
    }
  }

  /** True when a refresh must not touch this control: focused or mid-drag. */
  private held(element: HTMLElement): boolean {
    return element === this.activeInput || element === document.activeElement;
  }

  private selectTab(id: TabId, focus = false): void {
    this.activeTab = id;
    const u = this.nodes;
    if (!u) return;
    for (const [tabId, tabButton] of u.tabButtons) {
      const selected = tabId === id;
      tabButton.setAttribute("aria-selected", selected ? "true" : "false");
      tabButton.tabIndex = selected ? 0 : -1;
    }
    for (const [tabId, pane] of u.sections) pane.hidden = tabId !== id;
    u.body.setAttribute("aria-labelledby", `zct-tab-${id}`);
    if (focus) u.tabButtons.get(id)?.focus();
    if (id === "system") void this.refreshSystem();
    if (id === "status") this.syncStatus();
    if (id === "audio") this.syncAudio();
  }

  /**
   * Switches tabs on a click anywhere in the strip.
   *
   * Delegated from the container rather than bound per button, because the
   * buttons are rebuilt whenever the panel is remounted and a per-button
   * listener would have to be re-attached with them. The tab id comes from
   * `data-tab` rather than being parsed out of the element id, so a change to
   * the id scheme cannot silently stop the strip from working.
   *
   * This exists because the strip briefly shipped with a keyboard handler and
   * no click handler: the tabs were reachable with the arrow keys and inert
   * under the mouse, which a user reads as a frozen panel rather than as a
   * missing binding.
   */
  private onTabsClick(ev: Event): void {
    const target = ev.target;
    if (!(target instanceof Element)) return;
    const button = target.closest("[data-tab]");
    if (!button) return;
    const id = button.getAttribute("data-tab") as TabId | null;
    if (id && TABS.some((tab) => tab.id === id)) this.selectTab(id);
  }

  private onTabsKeyDown(ev: KeyboardEvent): void {
    const order = TABS.map((tab) => tab.id);
    const index = order.indexOf(this.activeTab);
    let next: number;
    switch (ev.key) {
      case "ArrowRight":
        next = (index + 1) % order.length;
        break;
      case "ArrowLeft":
        next = (index - 1 + order.length) % order.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = order.length - 1;
        break;
      default:
        return;
    }
    ev.preventDefault();
    this.selectTab(order[next], true);
  }

  private onDocumentKeyDown(ev: KeyboardEvent): void {
    if (ev.key !== "Escape" || !this.isOpen()) return;
    this.close();
  }

  private onDragStart(ev: PointerEvent): void {
    const u = this.nodes;
    if (!u || ev.button !== 0) return;
    const target = ev.target;
    // The head hosts the close button; a click there must not start a drag.
    if (target instanceof Element && target.closest("button")) return;
    const rect = u.panel.getBoundingClientRect();
    this.drag = { pointerId: ev.pointerId, dx: ev.clientX - rect.left, dy: ev.clientY - rect.top };
    u.panel.style.right = "auto";
    u.panel.style.bottom = "auto";
    u.panel.style.left = `${rect.left}px`;
    u.panel.style.top = `${rect.top}px`;
    try {
      u.head.setPointerCapture(ev.pointerId);
    } catch {
      /* capture is best-effort; the move handler still tracks the pointer */
    }
    // Suppresses the text selection a press-drag would otherwise start.
    ev.preventDefault();
  }

  private onDragMove(ev: PointerEvent): void {
    const u = this.nodes;
    if (!u || !this.drag || ev.pointerId !== this.drag.pointerId) return;
    const x = clamp(ev.clientX - this.drag.dx, 4, Math.max(4, window.innerWidth - 60));
    const y = clamp(ev.clientY - this.drag.dy, 4, Math.max(4, window.innerHeight - 36));
    u.panel.style.left = `${x}px`;
    u.panel.style.top = `${y}px`;
  }

  private onDragEnd(ev: PointerEvent): void {
    const u = this.nodes;
    if (!this.drag || ev.pointerId !== this.drag.pointerId) return;
    this.drag = undefined;
    try {
      u?.head.releasePointerCapture(ev.pointerId);
    } catch {
      /* already released */
    }
  }

  private clampIntoView(): void {
    const u = this.nodes;
    if (!u || u.panel.hidden) return;
    // An untouched panel keeps the stylesheet's corner; only a dragged one moves.
    if (u.panel.style.left.length === 0) return;
    const rect = u.panel.getBoundingClientRect();
    u.panel.style.left = `${clamp(rect.left, 4, Math.max(4, window.innerWidth - 60))}px`;
    u.panel.style.top = `${clamp(rect.top, 4, Math.max(4, window.innerHeight - 36))}px`;
  }

  // --- preference rendering -------------------------------------------------

  private applyPrefs(prefs: Prefs): void {
    const u = this.nodes;
    if (!u) return;
    const appearance = prefs.appearance;
    if (!this.held(u.bannerMode)) u.bannerMode.value = appearance.banner.mode;
    if (!this.held(u.bannerOpacity)) {
      u.bannerOpacity.value = String(appearance.banner.opacity);
      u.bannerOpacityValue.textContent = asPercent(Number(u.bannerOpacity.value));
    }
    if (!this.held(u.colorBackground)) {
      u.colorBackground.value = appearance.background;
      u.colorBackgroundValue.textContent = appearance.background;
    }
    if (!this.held(u.colorAccent)) {
      u.colorAccent.value = appearance.accent;
      u.colorAccentValue.textContent = appearance.accent;
    }
    const greeting = appearance.greeting;
    if (!this.held(u.greetingEnabled)) u.greetingEnabled.checked = greeting.enabled;
    if (!this.held(u.greetingLine1)) {
      u.greetingLine1.value = greeting.line1;
      u.greetingLine1Count.textContent = asCount(greeting.line1, GREETING_LINE1_MAX);
    }
    if (!this.held(u.greetingLine2)) {
      u.greetingLine2.value = greeting.line2;
      u.greetingLine2Count.textContent = asCount(greeting.line2, GREETING_LINE2_MAX);
    }
    this.syncGreetingReset();

    const audio = prefs.audio;
    if (!this.held(u.audioEnabled)) u.audioEnabled.checked = audio.enabled;
    if (!this.held(u.masterVolume)) {
      u.masterVolume.value = String(audio.masterVolume);
      u.masterVolumeValue.textContent = asPercent(Number(u.masterVolume.value));
    }
    if (!this.held(u.bgmEnabled)) u.bgmEnabled.checked = audio.bgm.enabled;
    if (!this.held(u.bgmVolume)) {
      u.bgmVolume.value = String(audio.bgm.volume);
      u.bgmVolumeValue.textContent = asPercent(Number(u.bgmVolume.value));
    }
    if (!this.held(u.sfxEnabled)) u.sfxEnabled.checked = audio.sfx.enabled;
    if (!this.held(u.sfxVolume)) {
      u.sfxVolume.value = String(audio.sfx.volume);
      u.sfxVolumeValue.textContent = asPercent(Number(u.sfxVolume.value));
    }
    for (const [event, input] of u.sfxEventInputs) {
      if (!this.held(input)) input.checked = audio.sfx.events[event] !== false;
    }
    if (!this.held(u.voiceEnabled)) u.voiceEnabled.checked = audio.voice.enabled;
    if (!this.held(u.voiceVolume)) {
      u.voiceVolume.value = String(audio.voice.volume);
      u.voiceVolumeValue.textContent = asPercent(Number(u.voiceVolume.value));
    }
    if (!this.held(u.voiceChance)) {
      u.voiceChance.value = String(audio.voice.chance);
      u.voiceChanceValue.textContent = asPercent(Number(u.voiceChance.value));
    }

    const pet = prefs.pet;
    if (!this.held(u.petEnabled)) u.petEnabled.checked = pet.enabled;
    if (!this.held(u.petScale)) {
      u.petScale.value = String(pet.scale);
      u.petScaleValue.textContent = asPixels(Number(u.petScale.value));
    }
    if (!this.held(u.petOpacity)) {
      u.petOpacity.value = String(pet.opacity);
      u.petOpacityValue.textContent = asPercent(Number(u.petOpacity.value));
    }
    if (!this.held(u.petVoiceOnClick)) u.petVoiceOnClick.checked = pet.voiceOnClick;

    const status = prefs.status;
    if (!this.held(u.statusEnabled)) u.statusEnabled.checked = status.enabled;
    if (!this.held(u.statusLanguage)) u.statusLanguage.value = status.language;
    for (const [trigger, input] of u.statusTriggerInputs) {
      if (!this.held(input)) input.checked = status.triggers[trigger] !== false;
    }
  }
}
