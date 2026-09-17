/**
 * The injected client's entry point.
 *
 * This is the one place where the subsystem graph is assembled, and the one
 * place that knows how to tear it down again. Everything below it receives a
 * `ClientContext` and never reaches for a global, so the only shared mutable
 * state in the client is the object built here.
 *
 * Life cycle. The service injects this script both as a new-document script and
 * as an immediate evaluation, on every renderer it finds, and it re-injects
 * after a config change. Two consequences drive the shape of `start()`:
 *
 *  - It must be **idempotent**: a second evaluation destroys the first client
 *    completely before building a new one, so a reload or a re-injection cannot
 *    leave two docks, two pets or two observers running.
 *  - It must **never throw into the page**. Every step is guarded; a failure in
 *    the pet must not stop the music, and a failure to read prefs must not leave
 *    a half-mounted UI behind. If the very first step fails, the client reports
 *    it once and stays out of the way.
 *
 * The client also waits for a body. `Page.addScriptToEvaluateOnNewDocument` runs
 * before the document exists — measured on ZCode 3.11.2, `document.body` is null
 * and `readyState` is "loading" — which is exactly the bug that silently removed
 * the v0.1 panel from every document created after the service attached.
 */

import { AudioEngine } from "./core/audio.js";
import { HostApi } from "./core/api.js";
import { LeaderController } from "./core/leader.js";
import { BgmPlayer } from "./bgm/player.js";
import { BgmDock } from "./bgm/dock.js";
import { StatusRoller } from "./status/runtime.js";
import { createStatusAnchor } from "./status/anchor.js";
import { createSignalWatcher } from "./signals/detect.js";
import { EventMachine } from "./signals/machine.js";
import { playSfx } from "./sfx/synth.js";
import type { SfxEvent } from "../prefs/types.js";
import { Pet } from "./pet/pet.js";
import { PetVoice } from "./pet/voice.js";
import { SettingsPanel } from "./ui/panel.js";
import { buildUiCss, UI_ROOT_ID, UI_STYLE_ID } from "./ui/skin.js";
import type { ClientBoot } from "./core/api.js";
import type { ClientContext, ClientTheme } from "./core/context.js";
import { errorMessage } from "./core/context.js";
import { defaultPrefs } from "../prefs/defaults.js";
import type { Prefs } from "../prefs/types.js";

/** Window global holding the live client, so a re-injection can replace it. */
const STATE_KEY = "__zcodeTarkov";
const BOOT_KEY = "__ZCT_BOOT__";

interface LiveClient {
  destroy(): void;
}

/**
 * The previously installed client, tracked separately from the window global so
 * a client that failed to assign its own global still gets torn down.
 */
let live: LiveClient | undefined;

function destroyPrevious(): void {
  try {
    const previous = (window as unknown as Record<string, unknown>)[STATE_KEY] as LiveClient | undefined;
    if (previous && typeof previous.destroy === "function") previous.destroy();
  } catch {
    /* a broken previous client must not stop the new one */
  }
  try {
    live?.destroy();
  } catch {
    /* already gone */
  }
  live = undefined;
}

/** Reads the boot object the service wrote immediately before this script. */
function readBoot(): ClientBoot | undefined {
  const raw = (window as unknown as Record<string, unknown>)[BOOT_KEY] as Partial<ClientBoot> | undefined;
  if (!raw || typeof raw !== "object") return undefined;
  if (typeof raw.apiPort !== "number" || typeof raw.token !== "string" || typeof raw.mediaToken !== "string") {
    return undefined;
  }
  return {
    apiPort: raw.apiPort,
    token: raw.token,
    mediaToken: raw.mediaToken,
    version: typeof raw.version === "string" ? raw.version : "0.0.0-dev",
  };
}

/** Creates the stylesheet and the shared root, or returns the existing ones. */
function ensureUiRoot(): HTMLElement {
  let style = document.getElementById(UI_STYLE_ID);
  if (!style) {
    style = document.createElement("style");
    style.id = UI_STYLE_ID;
    (document.head ?? document.documentElement).appendChild(style);
  }
  const css = buildUiCss();
  // Conditional write: assigning unconditionally mutates the tree, and a
  // MutationObserver anywhere in the page would see it every injection.
  if (style.textContent !== css) style.textContent = css;

  let root = document.getElementById(UI_ROOT_ID);
  if (!root) {
    root = document.createElement("div");
    root.id = UI_ROOT_ID;
    (document.body ?? document.documentElement).appendChild(root);
  }
  return root;
}

/** Removes everything this client added to the document. */
function removeUiRoot(): void {
  document.getElementById(UI_ROOT_ID)?.remove();
  document.getElementById(UI_STYLE_ID)?.remove();
}

function start(): void {
  const boot = readBoot();
  if (!boot) {
    // No boot object means the service did not inject the parameters — a stale
    // new-document script from a previous service run, for instance. There is
    // nothing sensible to do and nothing worth logging repeatedly.
    return;
  }

  destroyPrevious();

  const api = new HostApi(boot);
  const seeded = defaultPrefs().audio;
  const audio = new AudioEngine({
    master: seeded.masterVolume,
    sfx: seeded.sfx.volume,
    bgm: seeded.bgm.volume,
    voice: seeded.voice.volume,
  });

  // Seeded from the shared defaults so the client renders something sane during
  // the round-trip that reads the real settings, and so the two cannot drift.
  let prefs: Prefs = defaultPrefs();
  const prefsListeners = new Set<(prefs: Prefs) => void>();
  const toastEl = { value: undefined as HTMLElement | undefined };
  let toastTimer: number | null = null;

  const uiRoot = ensureUiRoot();

  const listeners: Array<() => void> = [];

  const context: ClientContext = {
    api,
    audio,
    prefs: () => prefs,
    async patchPrefs(patch: unknown): Promise<Prefs> {
      const result = (await api.patchPrefs(patch)) as { prefs?: unknown };
      const next = (result?.prefs ?? prefs) as Prefs;
      applyPrefs(next);
      return next;
    },
    onPrefs(listener) {
      prefsListeners.add(listener);
      return () => prefsListeners.delete(listener);
    },
    theme: () => clientTheme,
    syncTheme() {
      uiRoot.dataset.zctTheme = clientTheme;
    },
    toast(message: string) {
      if (!toastEl.value) {
        toastEl.value = document.createElement("div");
        toastEl.value.id = "zct-toast";
        toastEl.value.setAttribute("role", "status");
        toastEl.value.setAttribute("aria-live", "polite");
        uiRoot.appendChild(toastEl.value);
      }
      const el = toastEl.value;
      if (el.textContent !== message) el.textContent = message;
      if (toastTimer !== null) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        toastTimer = null;
        if (el.textContent === message) el.textContent = "";
      }, 2400) as unknown as number;
    },
    toastError(err: unknown, fallback: string) {
      context.toast(errorMessage(err, fallback));
    },
    uiRoot: () => uiRoot,
  };

  let clientTheme: ClientTheme = "neutral";

  function applyPrefs(next: Prefs): void {
    prefs = next;
    const wanted: ClientTheme = next.appearance.colorMode === "tarkov" ? "tarkov" : "neutral";
    if (wanted !== clientTheme) {
      clientTheme = wanted;
      uiRoot.dataset.zctTheme = wanted;
    }
    audio.applyVolumes({
      master: next.audio.masterVolume,
      sfx: next.audio.sfx.volume,
      bgm: next.audio.bgm.volume,
      voice: next.audio.voice.volume,
    });
    for (const listener of prefsListeners) {
      try {
        listener(next);
      } catch (err) {
        // A surface that fails to react must not stop the others.
        console.warn("[zcode-tarkov] a preferences listener failed:", err);
      }
    }
  }

  // --- subsystems ---------------------------------------------------------

  const leader = new LeaderController({
    onRole: (role) => {
      // Only the leader keeps music running; a renderer that lost the lease
      // stops its own playback rather than doubling the track.
      if (role === "follower") bgm.pause();
    },
  });

  const bgm = new BgmPlayer({ ctx: context, audio, leader });

  // One voice instance, shared: the pet plays through it on a click and the
  // settings centre plays through it for its test button, so the decoded-buffer
  // cache and the no-immediate-repeat rule are common to both.
  const voice = new PetVoice(context);

  let panel: SettingsPanel | undefined;
  let dock: BgmDock | undefined;
  let pet: Pet | undefined;
  let roller: StatusRoller | undefined;
  let watcher: ReturnType<typeof createSignalWatcher> | undefined;
  let machine: EventMachine | undefined;

  try {
    dock = new BgmDock(context, bgm, {
      onOpenSettings: () => panel?.open(),
      onRequestExclusive: () => panel?.close(),
    });
    dock.mount();

    pet = new Pet(context, voice, { onOpenSettings: () => panel?.open() });
    pet.mount();

    roller = new StatusRoller(context, { anchor: createStatusAnchor() });
    roller.start();

    panel = new SettingsPanel(
      context,
      { bgm, pet, status: roller },
      {
        onTestSfx: (event) => {
          // The test button is a user gesture, so this is a legitimate place to
          // unlock: otherwise every test would be silent until the user clicked
          // something else first.
          void audio.tryUnlock().then((ok) => {
            if (ok) playSfx(event as SfxEvent, audio.context, audio.bus("sfx"));
          });
        },
        onTestVoice: () => {
          void audio.tryUnlock().then((ok) => {
            if (ok) void voice.speak();
          });
        },
      }
    );
    panel.mount();

    bgm.start();
    leader.start();

    // --- the event pipeline ------------------------------------------------
    //
    // Observation -> state machine -> sound. The machine owns the debouncing and
    // the once-per-turn latches; this wiring only feeds it and plays what it
    // returns, so the two concerns stay independently testable.
    machine = new EventMachine();
    watcher = createSignalWatcher({
      onObservation: (observation) => {
        const events = machine!.update(observation);
        for (const event of events) {
          const current = prefs;
          if (!current.audio.enabled || !current.audio.sfx.enabled) continue;
          if (current.audio.sfx.events[event] === false) continue;
          playSfx(event, audio.context, audio.bus("sfx"));
        }
        roller?.setPhase(machine!.current);
      },
      onProgress: (kind) => roller?.onProgress(kind),
    });
    watcher.start();

    // The first unlock has to happen inside a gesture; installing the listener
    // is all this does, and the user's first click anywhere does the rest.
    audio.installGestureUnlock();
    listeners.push(() => audio.removeGestureUnlock());

    // Preferences are loaded after the UI exists so the panel can show its own
    // offline state if the service is unreachable, instead of the client
    // silently rendering defaults that were never read.
    void api
      .getPrefs()
      .then((result) => applyPrefs((result?.prefs ?? defaultPrefs()) as Prefs))
      .catch(() => {
        applyPrefs(defaultPrefs());
        context.toast("无法读取设置,已使用默认值");
      });
  } catch (err) {
    // A failure while assembling the UI must not leave a half-built client.
    console.error("[zcode-tarkov] client start failed:", err);
    try {
      watcher?.stop();
    } catch {
      /* nothing to stop */
    }
    try {
      roller?.dispose();
    } catch {
      /* nothing to dispose */
    }
    try {
      dock?.destroy();
    } catch {
      /* nothing to destroy */
    }
    try {
      pet?.destroy();
    } catch {
      /* nothing to destroy */
    }
    try {
      panel?.destroy();
    } catch {
      /* nothing to destroy */
    }
    try {
      voice.dispose();
    } catch {
      /* nothing to dispose */
    }
    try {
      bgm.dispose();
    } catch {
      /* nothing to dispose */
    }
    try {
      leader.stop();
    } catch {
      /* nothing to stop */
    }
    audio.dispose();
    removeUiRoot();
    return;
  }

  const instance: LiveClient = {
    destroy() {
      for (const off of listeners) {
        try {
          off();
        } catch {
          /* already detached */
        }
      }
      listeners.length = 0;
      try {
        watcher?.stop();
      } catch {
        /* already stopped */
      }
      try {
        roller?.dispose();
      } catch {
        /* already disposed */
      }
      try {
        panel?.destroy();
      } catch {
        /* already destroyed */
      }
      try {
        dock?.destroy();
      } catch {
        /* already destroyed */
      }
      try {
        pet?.destroy();
      } catch {
        /* already destroyed */
      }
      try {
        voice.dispose();
      } catch {
        /* already disposed */
      }
      try {
        bgm.dispose();
      } catch {
        /* already disposed */
      }
      try {
        leader.stop();
      } catch {
        /* already stopped */
      }
      audio.dispose();
      prefsListeners.clear();
      // The boot object carries the two tokens. A torn-down client must not
      // leave them reachable on the page: the next injection writes its own,
      // and anything reading the global in between should find nothing.
      try {
        const boot = (window as unknown as Record<string, unknown>)[BOOT_KEY] as
          | { token?: unknown; mediaToken?: unknown }
          | undefined;
        if (boot) {
          boot.token = null;
          boot.mediaToken = null;
        }
      } catch {
        /* nothing to clear */
      }
      if (toastTimer !== null) clearTimeout(toastTimer);
      toastTimer = null;
      removeUiRoot();
      const g = window as unknown as Record<string, unknown>;
      if (g[STATE_KEY] === instance) g[STATE_KEY] = null;
    },
  };

  live = instance;
  (window as unknown as Record<string, unknown>)[STATE_KEY] = instance;
}

/**
 * Runs `start` once the document can carry injected UI.
 *
 * Registering this as a new-document script means it runs while `document.body`
 * is still null, so the mount has to be deferred. `DOMContentLoaded` is not
 * enough on its own: when the script is evaluated on an already-loaded document
 * (the service's immediate `Runtime.evaluate`) that event has already fired and
 * would never come again — the same trap that made the v0.1 panel vanish.
 */
function boot(): void {
  if (document.body) {
    start();
    return;
  }
  document.addEventListener("DOMContentLoaded", () => start(), { once: true });
}

try {
  boot();
} catch (err) {
  console.warn("[zcode-tarkov] client boot failed:", err);
}
