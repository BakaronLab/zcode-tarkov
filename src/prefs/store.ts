/**
 * The process-wide preferences store.
 *
 * One in-memory copy, one file, one funnel. Everything that reads or writes a
 * setting goes through here, for three reasons:
 *
 *  - **The file is the source of truth, but the cache is what is served.** The
 *    settings panel polls, the API answers per request, and the injected client
 *    asks for its prefs on every tab open; re-reading and re-validating a JSON
 *    file on each of those would be both slow and pointless when the only writer
 *    is this process.
 *  - **Writes are validated once.** Every path that stores a preference runs the
 *    whole document back through `validatePrefs`, so a patch cannot introduce a
 *    value that a later load would reject — the file on disk is always a
 *    document that loads cleanly.
 *  - **Migration happens exactly once, and is observable.** The result of the
 *    first load — whether it migrated, whether it had to recover — is retained
 *    so the System section of the panel can tell the user their v0.1 settings
 *    were carried over, or that a broken file was set aside.
 *
 * The legacy path is a parameter rather than an import, so this module does not
 * depend on the plugin's own data-directory resolution (which depends on it).
 */

import { loadPrefs, savePrefs, validatePrefs, type LoadPrefsResult } from "./prefs.js";
import type { Prefs } from "./types.js";

let cached: Prefs | undefined;
let loadInfo: LoadPrefsResult | undefined;
let legacyConfigPath: string | undefined;

/** Records where a v0.1 `config.json` may still be found, for migration. */
export function setLegacyConfigPath(file: string | undefined): void {
  legacyConfigPath = file;
  // A new legacy path invalidates a cache that was built with the old one.
  cached = undefined;
  loadInfo = undefined;
}

/** The current preferences, loading and migrating on first use. */
export function getPrefs(): Prefs {
  if (!cached) {
    loadInfo = loadPrefs(legacyConfigPath);
    cached = loadInfo.prefs;
  }
  return cached;
}

/** What the first load had to do, for the System section. */
export function prefsLoadInfo(): { recovered?: { reason: string; backup?: string }; migratedFrom?: string } {
  getPrefs();
  return { recovered: loadInfo?.recovered, migratedFrom: loadInfo?.migratedFrom };
}

/** Replaces the whole document, validating first. Returns what was stored. */
export function setPrefs(next: unknown): Prefs {
  const validated = validatePrefs(next);
  savePrefs(validated);
  cached = validated;
  return validated;
}

/**
 * Merges a patch into the current preferences and stores the result.
 *
 * Arrays replace wholesale rather than merging element-wise: the only array in
 * the schema is the disabled-track list, and a user turning one track back on
 * means the list they just produced, not a union with the old one.
 */
export function patchPrefs(patch: unknown): Prefs {
  return setPrefs(mergePatch(getPrefs(), patch));
}

/** Deep-merges plain objects; everything else (arrays, scalars) replaces. */
export function mergePatch<T>(base: T, patch: unknown): T {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    // `undefined` means "not mentioned" for a JSON patch; a caller that wants to
    // clear a value sends null, which the field validators turn into a default.
    if (value === undefined) continue;
    const current = out[key];
    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      typeof current === "object" &&
      current !== null &&
      !Array.isArray(current)
    ) {
      out[key] = mergePatch(current, value);
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

/** Drops the cache. Only for tests, and for a reload after a migration. */
export function resetPrefsCache(): void {
  cached = undefined;
  loadInfo = undefined;
}
