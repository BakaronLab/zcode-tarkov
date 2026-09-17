/**
 * The v0.2 host API: preferences, the media library, and byte-range streaming.
 *
 * These routes are registered alongside the v0.1 appearance routes and follow
 * the same trust model, with one addition. The v0.1 API is header-token only,
 * which works because every caller is the injected panel using `fetch`. Media is
 * different: `<audio>` and `<img>` cannot attach a header, so a second, strictly
 * weaker token is accepted **in the query string** for GET media routes. It is a
 * separate value, it authorises reads of the media directories and nothing else,
 * and no mutating route will accept it. That keeps the invariant that matters:
 * reaching the API from a web page still requires a secret that only the
 * injected client has.
 *
 * Path handling for streamed files lives entirely in `media/paths.ts`; nothing
 * here joins a request-supplied string to a directory itself.
 */

import fs from "node:fs";
import path from "node:path";
import type http from "node:http";
import { randomBytes } from "node:crypto";
import { APP_DIR_NAME, dataRoot, ensureDataRoot, mediaDir } from "../core/dataRoot.js";
import { BodyTooLargeError, readBodyToFile, readJsonBody } from "./body.js";
import { mediaSubdirs, validatePrefs } from "../prefs/prefs.js";
import type { MediaKind, Prefs } from "../prefs/types.js";
import { addMediaFile, deleteMediaFile, listPool, listTracks, mediaFileExists } from "../media/library.js";
import {
  contentTypeFor,
  isAllowedForKind,
  isMediaKind,
  UnsafePathError,
  resolveMediaFile,
} from "../media/paths.js";
import { sendFile } from "../media/stream.js";
import { resolvePool } from "../status/pool.js";

export interface HostContext {
  method: string;
  url: URL;
  req: http.IncomingMessage;
  res: http.ServerResponse;
  /** The full-access token; accepted from the `x-zb-token` header only. */
  token: string;
  /** Read-only token; accepted from the query string or the same header. */
  mediaToken: string;
  readPrefs(): Prefs;
  /**
   * Stores a new preferences document.
   *
   * Returns a promise because storing appearance settings is not finished when
   * the file is written: the band, the wallpaper and the palette are part of the
   * payload the service injects, so a write has to reach the live renderers
   * before the change is real. The caller awaits this so the response it sends
   * reflects a change that has actually been applied, rather than one that will
   * appear at some later tick.
   */
  writePrefs(prefs: Prefs): void | Promise<void>;
  /** Recovery/migration state from the last prefs load, surfaced in System. */
  prefsStatus(): { recovered?: { reason: string; backup?: string }; migratedFrom?: string };
  /** Plugin/CLI version, for the System section. */
  version: string;
  startedAt: number;
  sendJson(res: http.ServerResponse, code: number, body: unknown): void;
}

/** True when the request carries the full-access token. */
function hasFullToken(ctx: HostContext): boolean {
  const header = ctx.req.headers["x-zb-token"];
  return typeof header === "string" && header.length > 0 && header === ctx.token;
}

/**
 * True when the request may read media.
 *
 * Accepts the read-only media token from `?token=` or the header, and the full
 * token from the header. A query-string *full* token is deliberately not
 * accepted: the URL ends up in logs and history, and the full token can delete
 * files.
 */
function hasMediaAccess(ctx: HostContext): boolean {
  if (hasFullToken(ctx)) return true;
  const q = ctx.url.searchParams.get("token");
  if (typeof q === "string" && q.length > 0 && q === ctx.mediaToken) return true;
  const header = ctx.req.headers["x-zb-token"];
  return typeof header === "string" && header.length > 0 && header === ctx.mediaToken;
}

/** Deep-merges a patch over the current prefs for plain objects only. */
function mergePatch<T>(base: T, patch: unknown): T {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
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

function errorStatus(err: unknown): { status: number; error: string } {
  if (err instanceof UnsafePathError) return { status: 400, error: err.message };
  const message = err instanceof Error ? err.message : String(err);
  if (/too large|exceeds/i.test(message)) return { status: 413, error: message };
  return { status: 400, error: message };
}

/** Reads a status text file for a language, if the user supplied one. */
function userStatusText(language: "zh" | "en"): string | undefined {
  try {
    return fs.readFileSync(resolveMediaFile("status", `texts.${language}.txt`), "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Handles one host-API request. Returns true when the route matched, so the
 * caller can fall through to its own table or a 404.
 */
export async function handleHostRoute(ctx: HostContext): Promise<boolean> {
  const { method, url, res } = ctx;
  const p = url.pathname;

  // --- preferences --------------------------------------------------------
  if (p === "/api/prefs") {
    if (!hasFullToken(ctx)) {
      ctx.sendJson(res, 403, { error: "missing or invalid token" });
      return true;
    }
    if (method === "GET") {
      ctx.sendJson(res, 200, { prefs: ctx.readPrefs(), status: ctx.prefsStatus() });
      return true;
    }
    if (method === "POST") {
      const patch = await readJsonBody(ctx.req);
      const merged = mergePatch(ctx.readPrefs(), patch);
      // Every write is re-validated, so a patch cannot introduce a value the
      // schema would not have accepted from disk.
      const next = validatePrefs(merged);
      await ctx.writePrefs(next);
      ctx.sendJson(res, 200, { ok: true, prefs: next });
      return true;
    }
    ctx.sendJson(res, 405, { error: "method not allowed" });
    return true;
  }

  // --- system -------------------------------------------------------------
  if (p === "/api/system" && method === "GET") {
    if (!hasFullToken(ctx)) {
      ctx.sendJson(res, 403, { error: "missing or invalid token" });
      return true;
    }
    const status = ctx.prefsStatus();
    ctx.sendJson(res, 200, {
      version: ctx.version,
      service: APP_DIR_NAME,
      pid: process.pid,
      startedAt: new Date(ctx.startedAt).toISOString(),
      uptimeSeconds: Math.round((Date.now() - ctx.startedAt) / 1000),
      dataRoot: dataRoot(),
      mediaDirs: mediaSubdirs(),
      prefs: { migratedFrom: status.migratedFrom, recovered: status.recovered },
    });
    return true;
  }

  // --- music library ------------------------------------------------------
  if (p === "/api/library/music" && method === "GET") {
    if (!hasFullToken(ctx)) {
      ctx.sendJson(res, 403, { error: "missing or invalid token" });
      return true;
    }
    const prefs = ctx.readPrefs();
    ctx.sendJson(res, 200, {
      tracks: listTracks(prefs),
      current: prefs.audio.bgm.trackId ?? null,
      empty: listTracks(prefs).length === 0,
    });
    return true;
  }

  if (p === "/api/library/music/add" && method === "POST") {
    if (!hasFullToken(ctx)) {
      ctx.sendJson(res, 403, { error: "missing or invalid token" });
      return true;
    }
    ensureDataRoot();
    const dir = mediaDir("music");
    // The suffix is random, not just a timestamp: two files picked in one
    // multi-select arrive as two concurrent requests, and on loopback they can
    // reach this line in the same millisecond. A timestamp-only name made them
    // stream into one temp file, so the second upload overwrote the first's
    // bytes and then failed to find its own file to rename.
    const tmp = path.join(dir, `.upload.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
    let written;
    try {
      written = await readBodyToFile(ctx.req, tmp);
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* best effort */
      }
      const status = err instanceof BodyTooLargeError ? 413 : 400;
      ctx.sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
      return true;
    }
    // The temp file is handed to the library, which renames it into place; it
    // is never read back into memory.
    let result;
    try {
      result = addMediaFile("music", url.searchParams.get("name"), { path: tmp, size: written.bytes });
    } catch (err) {
      // A filesystem refusal (a destination that is a directory, a locked file,
      // a full disk) must become a status and must not leave the temp file
      // behind for the next listing to trip over.
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* best effort */
      }
      ctx.sendJson(res, 500, { error: `could not store the upload: ${(err as Error).message}` });
      return true;
    }
    if (!result.ok) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* best effort */
      }
      ctx.sendJson(res, result.status, { error: result.error });
      return true;
    }
    ctx.sendJson(res, 200, { ...result });
    return true;
  }

  if (p === "/api/library/music/delete" && method === "POST") {
    if (!hasFullToken(ctx)) {
      ctx.sendJson(res, 403, { error: "missing or invalid token" });
      return true;
    }
    const body = (await readJsonBody(ctx.req)) as { name?: unknown } | undefined;
    const name = body?.name;
    try {
      const removed = deleteMediaFile("music", name);
      // Leaving a deleted track selected would make the dock offer to resume a
      // file that is gone, so the reference is cleared with the file.
      const prefs = ctx.readPrefs();
      if (prefs.audio.bgm.trackId === name) {
        await ctx.writePrefs({ ...prefs, audio: { ...prefs.audio, bgm: { ...prefs.audio.bgm, trackId: undefined } } });
      }
      ctx.sendJson(res, 200, { ok: true, removed });
    } catch (err) {
      const { status, error } = errorStatus(err);
      ctx.sendJson(res, status, { error });
    }
    return true;
  }

  if (p === "/api/library/music/toggle" && method === "POST") {
    if (!hasFullToken(ctx)) {
      ctx.sendJson(res, 403, { error: "missing or invalid token" });
      return true;
    }
    const body = (await readJsonBody(ctx.req)) as { name?: unknown; enabled?: unknown } | undefined;
    const name = typeof body?.name === "string" ? body.name : "";
    if (!mediaFileExists("music", name)) {
      ctx.sendJson(res, 404, { error: "unknown track" });
      return true;
    }
    const prefs = ctx.readPrefs();
    const disabled = new Set(prefs.audio.bgm.disabledTracks);
    // A request that names no state means "flip it": `disabled.has(name)` is the
    // state to move *to*, which is the opposite of the current one. It is easy
    // to write this as `!disabled.has(name)` and get a route that silently
    // returns the unchanged state while reporting success.
    const enabled = body?.enabled === undefined ? disabled.has(name) : body.enabled === true;
    if (enabled) disabled.delete(name);
    else disabled.add(name);
    await ctx.writePrefs({
      ...prefs,
      audio: { ...prefs.audio, bgm: { ...prefs.audio.bgm, disabledTracks: [...disabled] } },
    });
    ctx.sendJson(res, 200, { ok: true, name, enabled });
    return true;
  }

  // --- pools --------------------------------------------------------------
  const poolMatch = /^\/api\/pool\/(sounds|voice|pet|status)$/.exec(p);
  if (poolMatch && method === "GET") {
    if (!hasFullToken(ctx)) {
      ctx.sendJson(res, 403, { error: "missing or invalid token" });
      return true;
    }
    const kind = poolMatch[1] as "sounds" | "voice" | "pet" | "status";
    ctx.sendJson(res, 200, { kind, entries: listPool(kind) });
    return true;
  }

  const poolFileMatch = /^\/api\/pool\/(sounds|voice|pet|status)\/delete$/.exec(p);
  if (poolFileMatch && method === "POST") {
    if (!hasFullToken(ctx)) {
      ctx.sendJson(res, 403, { error: "missing or invalid token" });
      return true;
    }
    const body = (await readJsonBody(ctx.req)) as { name?: unknown } | undefined;
    try {
      const removed = deleteMediaFile(poolFileMatch[1] as "sounds" | "voice" | "pet", body?.name);
      ctx.sendJson(res, 200, { ok: true, removed });
    } catch (err) {
      const { status, error } = errorStatus(err);
      ctx.sendJson(res, status, { error });
    }
    return true;
  }

  // --- status phrase pool -------------------------------------------------
  if (p === "/api/status/phrases" && method === "GET") {
    if (!hasFullToken(ctx)) {
      ctx.sendJson(res, 403, { error: "missing or invalid token" });
      return true;
    }
    const prefs = ctx.readPrefs();
    const lang = url.searchParams.get("lang") === "en" ? "en" : prefs.status.language;
    const resolved = resolvePool(lang, userStatusText(lang));
    ctx.sendJson(res, 200, { language: lang, source: resolved.source, count: resolved.phrases.length, phrases: resolved.phrases });
    return true;
  }

  // --- media streaming ----------------------------------------------------
  const mediaMatch = /^\/api\/media\/([^/]+)\/([^/]+)$/.exec(p);
  if (mediaMatch && (method === "GET" || method === "HEAD")) {
    if (!hasMediaAccess(ctx)) {
      ctx.sendJson(res, 403, { error: "missing or invalid media token" });
      return true;
    }
    const kindRaw = mediaMatch[1];
    const name = decodeURIComponent(mediaMatch[2]);
    if (!isMediaKind(kindRaw)) {
      ctx.sendJson(res, 404, { error: "unknown media kind" });
      return true;
    }
    const kind = kindRaw as MediaKind;
    if (!isAllowedForKind(name, kind)) {
      ctx.sendJson(res, 415, { error: "unsupported media type" });
      return true;
    }
    const contentType = contentTypeFor(name, kind);
    if (!contentType) {
      ctx.sendJson(res, 415, { error: "unsupported media type" });
      return true;
    }
    let file: string;
    try {
      file = resolveMediaFile(kind, name);
    } catch (err) {
      if (err instanceof UnsafePathError) {
        ctx.sendJson(res, 404, { error: err.message });
        return true;
      }
      throw err;
    }
    sendFile(res, {
      file,
      contentType,
      rangeHeader: ctx.req.headers.range,
      headOnly: method === "HEAD",
    });
    return true;
  }

  return false;
}

/** The music streaming URL the client should use for a track. */
export function mediaUrl(apiPort: number, kind: MediaKind, name: string, token: string): string {
  return `http://127.0.0.1:${apiPort}/api/media/${kind}/${encodeURIComponent(name)}?token=${encodeURIComponent(token)}`;
}
