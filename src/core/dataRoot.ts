/**
 * The v0.2 user data root.
 *
 * User media must not live in the program's install directory or in ZCode's
 * plugin data directory: the first is replaced on every upgrade, the second can
 * be replaced by ZCode itself. Both would silently delete a user's music. The
 * data root is therefore a directory this project owns outright, beside the
 * per-user application data of the operating system:
 *
 *   Windows  %LOCALAPPDATA%\zcode-tarkov\data
 *   macOS    ~/Library/Application Support/zcode-tarkov/data
 *   Linux    $XDG_DATA_HOME/zcode-tarkov/data  (else ~/.local/share/zcode-tarkov/data)
 *
 * `ZCODE_TARKOV_DATA_DIR` overrides the whole root. The test harness and the CDP
 * verification tools point it at a scratch directory so no test can write into
 * a real user's library; `install.ps1`/`repair.ps1` create the same tree.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MEDIA_KINDS, type MediaKind } from "../prefs/types.js";

/** Environment variable that relocates the whole user data root. */
export const DATA_DIR_ENV = "ZCODE_TARKOV_DATA_DIR";

/** The application directory name used under the platform's data location. */
export const APP_DIR_NAME = "zcode-tarkov";

/** Where the process was started with an explicit root, if it was. */
export function dataRootOverride(): string | undefined {
  const raw = process.env[DATA_DIR_ENV];
  return raw && raw.trim().length > 0 ? path.resolve(raw.trim()) : undefined;
}

function platformBase(): string {
  const home = os.homedir();
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    return local && local.trim().length > 0 ? local : path.join(home, "AppData", "Local");
  }
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support");
  const xdg = process.env.XDG_DATA_HOME;
  return xdg && xdg.trim().length > 0 ? xdg : path.join(home, ".local", "share");
}

/**
 * The user data root. Absolute, but not necessarily existing — callers that
 * write go through `ensureDataRoot`.
 */
export function dataRoot(): string {
  return dataRootOverride() ?? path.join(platformBase(), APP_DIR_NAME, "data");
}

/** Absolute path of a media subdirectory. */
export function mediaDir(kind: MediaKind): string {
  return path.join(dataRoot(), kind);
}

/** Absolute path of `prefs.json`. */
export function prefsFile(): string {
  return path.join(dataRoot(), "prefs.json");
}

/** Creates the data root and every media subdirectory. Idempotent. */
export function ensureDataRoot(): string {
  const root = dataRoot();
  fs.mkdirSync(root, { recursive: true });
  for (const kind of MEDIA_KINDS) fs.mkdirSync(path.join(root, kind), { recursive: true });
  return root;
}

/**
 * The media directories that actually exist, as absolute paths.
 *
 * Directory scanning must not create directories as a side effect: a listing
 * request against a fresh install should report an empty library, not quietly
 * materialise five folders.
 */
export function existingMediaDirs(): { kind: MediaKind; dir: string }[] {
  return MEDIA_KINDS.map((kind) => ({ kind, dir: mediaDir(kind) })).filter((e) => {
    try {
      return fs.statSync(e.dir).isDirectory();
    } catch {
      return false;
    }
  });
}
