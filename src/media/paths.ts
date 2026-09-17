/**
 * Path handling for user media.
 *
 * Everything the service reads off disk for audio, pet images and status pools
 * arrives from an HTTP request or from a filename the user dropped into a media
 * directory, so path handling is the place where a theme plugin could otherwise
 * turn into an arbitrary-file-read primitive. The rules below are the whole
 * defence and are deliberately expressed as small pure functions so they can be
 * tested directly:
 *
 *  1. **Containment.** A request names a media *kind* and a basename — never a
 *     path. The basename is resolved against the kind's directory and the result
 *     must still be inside it.
 *  2. **No separators, no traversal.** A basename containing `/`, `\`, a drive
 *     letter or `..` is rejected outright rather than normalised, because the
 *     only legitimate names are flat filenames.
 *  3. **No reparse points.** A symlink or NTFS junction inside a media
 *     directory could point anywhere; the real path is resolved and checked
 *     against the real media root, so a link that escapes is rejected even when
 *     its name looks harmless.
 *  4. **Allowlisted extensions.** Only formats a Chromium `<audio>`/`<img>` can
 *     actually decode are considered media at all.
 *
 * `Content-Type` follows from the extension, never from a declared type, so an
 * uploaded `.mp3` cannot claim to be HTML.
 */

import fs from "node:fs";
import path from "node:path";
import { mediaDir } from "../core/dataRoot.js";
import { MEDIA_KINDS, type MediaKind } from "../prefs/types.js";

/** Extensions accepted for every media kind, mapped to their MIME type. */
export const MEDIA_CONTENT_TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".webm": "audio/webm",
  ".opus": "audio/ogg",
};

/** Image extensions accepted for the pet. */
export const IMAGE_CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

/** Extensions accepted for status text pools. */
export const TEXT_CONTENT_TYPES: Record<string, string> = {
  ".txt": "text/plain",
};

export function isMediaKind(value: unknown): value is MediaKind {
  return typeof value === "string" && (MEDIA_KINDS as readonly string[]).includes(value);
}

/** Every extension the service will serve, in any media kind. */
export function allAllowedExtensions(): string[] {
  return [...Object.keys(MEDIA_CONTENT_TYPES), ...Object.keys(IMAGE_CONTENT_TYPES), ...Object.keys(TEXT_CONTENT_TYPES)];
}

/**
 * True when a filename is a flat name that can be joined to a directory.
 *
 * Deliberately strict: anything that could change *which* directory a name
 * resolves to is refused before touching the filesystem.
 */
export function isSafeBasename(name: unknown): name is string {
  if (typeof name !== "string") return false;
  if (name.length === 0 || name.length > 200) return false;
  if (name === "." || name === "..") return false;
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) return false;
  // A drive-relative name ("C:foo") or a UNC-looking name is not a basename.
  if (name.includes(":")) return false;
  // Windows strips trailing dots/spaces, which can make two names collide.
  if (/[. ]$/.test(name)) return false;
  // Control characters have no place in a filename.
  /* eslint-disable-next-line no-control-regex */
  if (/[\u0000-\u001f\u007f]/.test(name)) return false;
  return true;
}

/**
 * Reduces an arbitrary user-supplied filename to a safe basename.
 *
 * Used on the upload path, where the browser sends whatever the user's disk had
 * — including full paths from browsers that report them, and names that differ
 * only by characters Windows will not store.
 */
export function sanitizeFilename(input: unknown, fallback = "track"): string {
  let raw = typeof input === "string" ? input : "";
  // Take the last segment of anything path-like, on either separator.
  raw = raw.split(/[\\/]/).pop() ?? "";
  raw = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  // Windows-forbidden characters plus the separators we already split on.
  raw = raw.replace(/[<>:"|?*]/g, "_");
  raw = raw.replace(/^\.+/, "").replace(/[. ]+$/, "");
  if (raw.length === 0) raw = fallback;
  if (raw.length > 160) {
    const ext = path.extname(raw).slice(0, 16);
    raw = raw.slice(0, 160 - ext.length) + ext;
  }
  return raw;
}

export function extensionOf(name: string): string {
  return path.extname(name).toLowerCase();
}

/** The MIME type for a filename, or undefined when it is not a served type. */
export function contentTypeFor(name: string, kind?: MediaKind): string | undefined {
  const ext = extensionOf(name);
  if (kind === "pet") return IMAGE_CONTENT_TYPES[ext];
  if (kind === "status") return TEXT_CONTENT_TYPES[ext];
  if (kind === "music" || kind === "sounds" || kind === "voice") return MEDIA_CONTENT_TYPES[ext];
  return MEDIA_CONTENT_TYPES[ext] ?? IMAGE_CONTENT_TYPES[ext] ?? TEXT_CONTENT_TYPES[ext];
}

/** True when the extension is servable for the given kind. */
export function isAllowedForKind(name: string, kind: MediaKind): boolean {
  return contentTypeFor(name, kind) !== undefined;
}

/** A rejected path, with a reason that is safe to log and to return. */
export class UnsafePathError extends Error {}

/**
 * Resolves `basename` inside `kind`'s directory, proving the result stays there.
 *
 * Returns the absolute path of an existing, regular file. Throws
 * `UnsafePathError` for anything else — a bad name, an escape, a directory, a
 * missing file, or a symlink whose real target is outside the media root.
 *
 * The symlink check runs on the **real** path of both sides: comparing a
 * resolved child against an unresolved root would accept a link into a
 * directory that is itself linked out of the tree.
 */
export function resolveMediaFile(kind: MediaKind, basename: unknown): string {
  if (!isSafeBasename(basename)) {
    throw new UnsafePathError("invalid file name");
  }
  const dir = mediaDir(kind);
  const candidate = path.join(dir, basename);

  // A name that is a symlink is only acceptable when its real target is still
  // inside the real media directory.
  let realDir: string;
  let realFile: string;
  try {
    realDir = fs.realpathSync(dir);
    realFile = fs.realpathSync(candidate);
  } catch {
    throw new UnsafePathError("file not found");
  }

  const rel = path.relative(realDir, realFile);
  if (rel.length === 0 || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new UnsafePathError("file is outside the media directory");
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(realFile);
  } catch {
    throw new UnsafePathError("file not found");
  }
  if (!stat.isFile()) throw new UnsafePathError("not a regular file");

  // The name resolved must still be the one asked for: a case-insensitive
  // filesystem can otherwise alias two names onto one file.
  if (path.basename(realFile).toLowerCase() !== basename.toLowerCase()) {
    throw new UnsafePathError("file name does not resolve to itself");
  }

  return realFile;
}

/** True when the media kind's directory exists and is a real directory. */
export function mediaDirExists(kind: MediaKind): boolean {
  try {
    return fs.statSync(mediaDir(kind)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Lists the servable files of a media kind, sorted for a stable order.
 *
 * Only regular files with an allowed extension are returned; the caller gets
 * basenames, never paths. A missing directory is an empty list, not an error.
 */
export function listMediaFiles(kind: MediaKind): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(mediaDir(kind));
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    if (!isSafeBasename(name)) continue;
    if (!isAllowedForKind(name, kind)) continue;
    try {
      if (!fs.lstatSync(path.join(mediaDir(kind), name)).isFile()) continue;
    } catch {
      continue;
    }
    out.push(name);
  }
  out.sort((a, b) => a.localeCompare(b, "en"));
  return out;
}
