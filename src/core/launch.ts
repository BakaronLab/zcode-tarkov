/**
 * Config persistence + ZCode launcher.
 *
 * Production ZCode builds have no built-in CDP port, so the launcher starts
 * ZCode.exe with --remote-debugging-port. ZCode enforces a single instance via
 * requestSingleInstanceLock, so we detect an already-running instance first.
 */

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listTargets } from "./cdp.js";
import { withColorMode } from "./colorMode.js";
import { prefsFile } from "./dataRoot.js";
import { getPrefs, setLegacyConfigPath, setPrefs } from "../prefs/store.js";
import type { AppearancePrefs, BannerMode } from "../prefs/types.js";
import { BANNER_MODES } from "../prefs/types.js";

export interface StoredConfig extends Partial<Omit<import("./inject.js").BeautifyConfig, "port">> {
  port?: number;
}

/** Previous plugin directory names, newest first. */
const LEGACY_DATA_DIRS = ["zcode-beautify@zcode-beautify", "zcode-beautify"];

export function dataDir(): string {
  // Env override kept under its original name: existing installs and scripts
  // already set this, and renaming it would silently orphan their config.
  const override = process.env.ZCODE_BEAUTIFY_DATA_DIR;
  if (override) return override;

  const root = path.join(os.homedir(), ".zcode", "cli", "plugins", "data");
  // ZCode resolves ${ZCODE_PLUGIN_DATA} to "<name>@<marketplace>", so a plugin
  // install and a manually run CLI would otherwise write two different configs.
  // Prefer the plugin-scoped directory when it exists.
  const pluginScoped = path.join(root, "zcode-tarkov@zcode-tarkov");
  if (fs.existsSync(pluginScoped)) return pluginScoped;

  const own = path.join(root, "zcode-tarkov");
  if (fs.existsSync(own)) return own;

  // Fall back to a previous zcode-beautify install so an existing config (which
  // may still hold only the legacy `monet` flag) is found and upgraded on the
  // next save, instead of silently starting from defaults.
  for (const legacy of LEGACY_DATA_DIRS) {
    const dir = path.join(root, legacy);
    if (fs.existsSync(dir)) return dir;
  }

  return own;
}

/**
 * The v0.1 appearance file.
 *
 * v0.2 stopped writing this: settings moved to `prefs.json` in the user data
 * root, which a ZCode update cannot replace. The old file is still *read*, once,
 * to migrate its contents, and it is left on disk untouched afterwards so a
 * user can roll back to a v0.1 build without losing their appearance.
 */
export function legacyConfigFile(): string {
  return path.join(dataDir(), "config.json");
}

/** The v0.2 settings file (`prefs.json`). */
export function settingsFile(): string {
  return prefsFile();
}

/** True once the legacy path has been registered with the store. */
let legacyRegistered = false;

/** Points the prefs store at the v0.1 file exactly once per process. */
function registerLegacyPath(): void {
  if (legacyRegistered) return;
  legacyRegistered = true;
  setLegacyConfigPath(legacyConfigFile());
}

/**
 * Prepares the settings store before anything can serve a request.
 *
 * Exported so a long-running process (`serve`) can pay the migration cost at
 * start-up rather than inside the first HTTP request, where a slow disk would
 * look like a slow panel.
 */
export function initSettings(): void {
  registerLegacyPath();
  getPrefs();
}

/**
 * Reads a JSON file, returning undefined instead of throwing.
 *
 * A leading UTF-8 BOM is stripped first: `JSON.parse` rejects it, and Windows
 * editors (Notepad in particular) write one by default, so a hand-edited config
 * would otherwise be silently discarded as unreadable.
 */
export function readJsonFile<T>(file: string): T | undefined {
  try {
    const raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/** Maps the stored appearance section onto the flat config the rest of the tree uses. */
function appearanceToConfig(appearance: AppearancePrefs): StoredConfig {
  return {
    wallpaperPath: appearance.wallpaperPath,
    blur: appearance.blur,
    dim: appearance.dim,
    fit: appearance.fit,
    colorMode: appearance.colorMode,
    // Kept in sync on read as well as on write: a v0.1 consumer reading an
    // in-memory config still resolves an equivalent appearance from the boolean.
    monet: appearance.colorMode === "monet",
    wallpaperVisible: appearance.wallpaperVisible,
    banner: { enabled: appearance.banner.mode !== "off", ...appearance.banner },
    // The palette and the greeting are what the payload builder paints with, so
    // they have to travel with every read — not only through the v0.2 prefs
    // route. Leaving them out here would render the shipped colours no matter
    // what the user chose.
    background: appearance.background,
    accent: appearance.accent,
    greeting: appearance.greeting,
  };
}

/**
 * Folds a flat config back into the appearance section.
 *
 * `base` supplies anything the caller did not mention, so a partial write (the
 * panel sending only `blur`) cannot reset the rest of the appearance. The
 * reverse mapping of the banner's `enabled` boolean is what lets a v0.1 caller
 * — the old panel, the CLI's `--no-banner` equivalent — keep working: it becomes
 * `mode: "off"`, which is exactly what it meant.
 */
function configToAppearance(config: StoredConfig, base: AppearancePrefs): AppearancePrefs {
  const banner = config.banner ?? { ...base.banner, enabled: base.banner.mode !== "off" };
  // Same precedence as `resolveBannerMode`, and for the same reason: a v0.1
  // caller that sets `enabled: false` must be able to turn the band off even
  // though the object also carries whatever `mode` was already stored. Reading
  // `mode` first would let a stored "full" silently override the only field that
  // caller set.
  const mode: BannerMode =
    banner.enabled === false
      ? "off"
      : banner.mode && (BANNER_MODES as readonly string[]).includes(banner.mode)
        ? banner.mode
        : base.banner.mode;
  return {
    colorMode: config.colorMode ?? base.colorMode,
    wallpaperVisible: config.wallpaperVisible ?? base.wallpaperVisible,
    blur: config.blur ?? base.blur,
    dim: config.dim ?? base.dim,
    fit: config.fit ?? base.fit,
    // Not `?? base`: clearing the wallpaper is a real operation (`/api/reset`),
    // and an absent key is how the caller says so.
    wallpaperPath: config.wallpaperPath,
    banner: {
      mode,
      text1: banner.text1 ?? base.banner.text1,
      text2: banner.text2 ?? base.banner.text2,
      height: banner.height ?? base.banner.height,
      opacity: banner.opacity ?? base.banner.opacity,
    },
    // Carried through from the stored appearance: the v0.1 `/api/config` route
    // has no concept of these, and a config write (blur, dim, wallpaper) must
    // not reset a palette or greeting the user chose in the v0.2 panel.
    background: base.background,
    accent: base.accent,
    greeting: base.greeting,
  };
}

export function loadConfig(): StoredConfig {
  registerLegacyPath();
  // Normalizing on read is what makes pre-0.1 configs (only `monet: true`)
  // and v0.1 configs (a flat `config.json`) work unchanged: the store migrates
  // the latter into `prefs.json` on first load, and every consumer downstream
  // sees a fully-populated appearance either way.
  return appearanceToConfig(getPrefs().appearance);
}

export function saveConfig(config: StoredConfig): void {
  registerLegacyPath();
  const prefs = getPrefs();
  setPrefs({ ...prefs, appearance: configToAppearance(config, prefs.appearance) });
}

const ZCODE_EXE_CANDIDATES =
  process.platform === "win32"
    ? [
        process.env.ZCODE_WINDOWS_APP_INSTALL_DIR
          ? path.join(process.env.ZCODE_WINDOWS_APP_INSTALL_DIR, "ZCode.exe")
          : undefined,
        "C:\\Program Files\\ZCode\\ZCode.exe",
        path.join(os.homedir(), "AppData", "Local", "Programs", "ZCode", "ZCode.exe"),
      ].filter(Boolean)
    : process.platform === "darwin"
      ? ["/Applications/ZCode.app/Contents/MacOS/ZCode"]
      : ["/usr/bin/zcode", "/opt/ZCode/zcode"];

export function findZcodeExecutable(): string | undefined {
  return ZCODE_EXE_CANDIDATES.map((p) => p!).find((p) => {
    try {
      return fs.statSync(p!).isFile();
    } catch {
      return false;
    }
  });
}

const execFileAsync = promisify(execFile);

/**
 * Detects a live ZCode process. A running instance without the debug port
 * triggers the Electron single-instance lock: a newly spawned ZCode binds the
 * CDP port, forwards its args to the existing instance, then exits — closing
 * the port again. Launching must refuse upfront instead of racing that window.
 */
export async function isZcodeProcessRunning(): Promise<boolean> {
  try {
    if (process.platform === "win32") {
      // windowsHide is not decoration: without it Windows opens a console window
      // for `tasklist`, and the resident service calls this on a timer whenever
      // CDP is unreachable — i.e. exactly while the user is waiting for the
      // theme to appear, so the window flashes every few seconds.
      const { stdout } = await execFileAsync("tasklist", ["/NH", "/FI", "IMAGENAME eq ZCode.exe"], {
        windowsHide: true,
      });
      return stdout.toLowerCase().includes("zcode.exe");
    }
    const name = process.platform === "darwin" ? "ZCode" : "zcode";
    const { stdout } = await execFileAsync("pgrep", ["-x", name]);
    return stdout.trim().length > 0;
  } catch {
    return false; // pgrep exits non-zero when no process matches
  }
}

export interface LaunchResult {
  started: boolean;
  reason?: string;
}

/**
 * Starts ZCode with the CDP port enabled. If a CDP endpoint is already
 * reachable we are done; if a ZCode instance is running *without* CDP, the
 * single-instance lock blocks us and the user must restart ZCode themselves.
 */
export async function launchZcode(port: number): Promise<LaunchResult> {
  try {
    await listTargets(port);
    return { started: false, reason: "already-running-with-cdp" };
  } catch {
    /* not reachable yet */
  }

  const exe = findZcodeExecutable();
  if (!exe) throw new Error("ZCode executable not found; set ZCODE_WINDOWS_APP_INSTALL_DIR or install ZCode to the default path.");

  if (await isZcodeProcessRunning()) {
    return { started: false, reason: "running-without-cdp" };
  }

  const child = spawn(exe, [`--remote-debugging-port=${port}`], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();

  // Wait for the CDP endpoint to come up.
  let up = false;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      await listTargets(port);
      up = true;
      break;
    } catch {
      /* keep waiting */
    }
  }
  if (!up) {
    throw new Error(
      "ZCode was started but no CDP endpoint appeared. Another instance may already be running without the debug port — quit ZCode completely and run `zcode-beautify launch` again."
    );
  }

  // Confirm the endpoint stays up: a second instance racing the single-instance
  // lock binds the port briefly and then quits, which would look like success.
  await new Promise((r) => setTimeout(r, 2000));
  try {
    await listTargets(port);
  } catch {
    throw new Error(
      "CDP came up but closed again immediately — a running ZCode instance took over via the single-instance lock. Quit ZCode completely and run `zcode-beautify launch` again."
    );
  }
  return { started: true };
}

async function killZcode(): Promise<boolean> {
  try {
    if (process.platform === "win32") {
      await execFileAsync("taskkill", ["/F", "/IM", "ZCode.exe"], { windowsHide: true });
    } else {
      await execFileAsync("pkill", ["-x", process.platform === "darwin" ? "ZCode" : "zcode"]);
    }
    return true;
  } catch {
    return false; // nothing was running
  }
}

/**
 * Replaces a running ZCode with a fresh instance that has the CDP port open.
 *
 * `--remote-debugging-port` is read once at process startup, so an instance that
 * came up without it can never grow the port. ZCode keeps its window in the tray
 * (`closeToTrayOnWindows`), which is why closing the window is not enough and
 * the processes have to be terminated outright — callers must ask the user
 * first, since anything unsaved in a conversation is lost.
 */
export async function relaunchZcode(port: number): Promise<{ killed: boolean; started: boolean }> {
  const killed = await killZcode();

  // The single-instance lock is released asynchronously.
  for (let i = 0; i < 20 && (await isZcodeProcessRunning()); i++) {
    await new Promise((r) => setTimeout(r, 500));
  }

  const result = await launchZcode(port);
  return { killed, started: result.started || result.reason === "already-running-with-cdp" };
}
