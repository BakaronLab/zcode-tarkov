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

export function configFile(): string {
  return path.join(dataDir(), "config.json");
}

/**
 * Reads and parses a JSON file, returning undefined instead of throwing.
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

export function loadConfig(): StoredConfig {
  // Normalizing on read is what makes pre-0.1 configs (only `monet: true`)
  // work unchanged: every consumer downstream sees a `colorMode`.
  const stored = readJsonFile<StoredConfig>(configFile());
  return stored ? withColorMode(stored) : {};
}

export function saveConfig(config: StoredConfig): void {
  fs.mkdirSync(dataDir(), { recursive: true });
  // Persist both the new mode and the legacy flag so an older build of the
  // plugin reading the same file still resolves to an equivalent appearance.
  fs.writeFileSync(configFile(), JSON.stringify(withColorMode(config), null, 2));
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
      const { stdout } = await execFileAsync("tasklist", ["/NH", "/FI", "IMAGENAME eq ZCode.exe"]);
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
      await execFileAsync("taskkill", ["/F", "/IM", "ZCode.exe"]);
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
