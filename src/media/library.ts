/**
 * The media library: what is in the user's media directories, and the
 * operations the settings panel performs on it.
 *
 * There is no index file and no database. The library *is* the directory
 * listing, which is the only design that survives a user dropping a file into
 * `music/` with Explorer: the next listing shows it, with nothing to refresh
 * and no way for the two to disagree. The only persisted state is the opt-out
 * list of disabled tracks in `prefs.json`.
 *
 * Track identity is the basename, so it is stable across restarts, survives
 * re-uploading the same file, and is directly meaningful in the API and in the
 * URL the audio element fetches.
 */

import fs from "node:fs";
import path from "node:path";
import { mediaDir } from "../core/dataRoot.js";
import type { Prefs } from "../prefs/types.js";
import { listMediaFiles, extensionOf, isAllowedForKind, sanitizeFilename, UnsafePathError, resolveMediaFile } from "./paths.js";
import { MAX_UPLOAD_BYTES } from "./stream.js";

export interface TrackEntry {
  /** Stable identity: the basename of the file inside `music/`. */
  id: string;
  filename: string;
  /** The basename without its extension — what the dock shows. */
  displayName: string;
  enabled: boolean;
  size: number;
  /** Unix ms of the last modification, so the panel can show "added" order. */
  mtimeMs: number;
  /** Length in seconds, when the container makes it cheap to read. */
  durationSeconds?: number;
}

export interface PoolEntry {
  id: string;
  filename: string;
  size: number;
}

function displayName(filename: string): string {
  const ext = path.extname(filename);
  return (ext ? filename.slice(0, -ext.length) : filename) || filename;
}

// --- duration probing --------------------------------------------------------
//
// Only the containers whose length is a header field are probed. Decoding the
// audio to measure it would mean shipping a codec, and reporting a wrong number
// is worse than reporting none: the dock reads "unknown length" as a dash.

function readChunk(file: string, start: number, length: number): Buffer | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(length);
    const read = fs.readSync(fd, buf, 0, length, start);
    return read === length ? buf : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* nothing to do */
      }
    }
  }
}

/** Exact duration of a RIFF/WAVE file, from its `fmt ` byte rate and `data` size. */
function wavDuration(file: string, size: number): number | undefined {
  const head = readChunk(file, 0, Math.min(size, 4096));
  if (!head || head.length < 12) return undefined;
  if (head.toString("ascii", 0, 4) !== "RIFF" || head.toString("ascii", 8, 12) !== "WAVE") return undefined;

  let offset = 12;
  let byteRate: number | undefined;
  let dataSize: number | undefined;
  while (offset + 8 <= head.length) {
    const id = head.toString("ascii", offset, offset + 4);
    const chunkSize = head.readUInt32LE(offset + 4);
    if (id === "fmt " && offset + 8 + 16 <= head.length) {
      byteRate = head.readUInt32LE(offset + 8 + 8);
    } else if (id === "data") {
      dataSize = chunkSize;
      break;
    }
    // Chunks are word-aligned; a zero size would loop forever.
    if (chunkSize <= 0) break;
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  if (!byteRate || byteRate <= 0 || dataSize === undefined) return undefined;
  return dataSize / byteRate;
}

/** Exact duration of a FLAC stream, from the STREAMINFO block. */
function flacDuration(file: string): number | undefined {
  // "fLaC" + 4-byte block header + 34-byte STREAMINFO.
  const head = readChunk(file, 0, 42);
  if (!head || head.length < 42) return undefined;
  if (head.toString("ascii", 0, 4) !== "fLaC") return undefined;

  // STREAMINFO payload starts at 8. Sample rate is 20 bits at byte 10,
  // total samples is 36 bits starting at bit 4 of byte 13.
  const b = head.subarray(8);
  const sampleRate = ((b[10] << 12) | (b[11] << 4) | (b[12] >> 4)) & 0xfffff;
  const totalSamples =
    (b[13] & 0x0f) * 2 ** 32 + b[14] * 2 ** 24 + b[15] * 2 ** 16 + b[16] * 2 ** 8 + b[17];
  if (!sampleRate || !totalSamples) return undefined;
  return totalSamples / sampleRate;
}

const MPEG_SAMPLE_RATES = [44100, 48000, 32000];

/**
 * Duration of an MP3, from its Xing/Info frame count when the encoder wrote one.
 *
 * CBR files usually carry a Xing header (LAME writes "Info" for CBR), so this
 * covers the common case exactly without decoding anything. Files without one
 * report no duration rather than a bitrate guess that would be wrong for VBR.
 */
function mp3Duration(file: string, size: number): number | undefined {
  const head = readChunk(file, 0, Math.min(size, 8192));
  if (!head || head.length < 4) return undefined;

  let offset = 0;
  // Skip an ID3v2 tag when present.
  if (head.toString("ascii", 0, 3) === "ID3" && head.length >= 10) {
    const tagSize =
      ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f);
    offset = 10 + tagSize;
  }

  // Find the first frame sync (11 set bits) and decode its header.
  let scan = offset;
  while (scan + 4 <= head.length) {
    if (head[scan] === 0xff && (head[scan + 1] & 0xe0) === 0xe0) break;
    scan += 1;
  }
  if (scan + 4 > head.length) return undefined;

  const versionBits = (head[scan + 1] >> 3) & 0x03; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
  const channelMode = (head[scan + 3] >> 6) & 0x03;
  const sampleRate = MPEG_SAMPLE_RATES[(head[scan + 2] >> 2) & 0x03];
  if (versionBits === 1 || !sampleRate) return undefined;

  // The Xing/Info tag sits after the side-information block, whose size depends
  // on the MPEG version and whether the frame is mono.
  const sideInfo = versionBits === 3 ? (channelMode === 3 ? 17 : 32) : channelMode === 3 ? 9 : 17;
  const tag = scan + 4 + sideInfo;
  if (tag + 12 > head.length) return undefined;

  const marker = head.toString("ascii", tag, tag + 4);
  if (marker !== "Xing" && marker !== "Info") return undefined;

  const flags = head.readUInt32BE(tag + 4);
  if ((flags & 0x01) === 0) return undefined; // no frame count
  const frames = head.readUInt32BE(tag + 8);
  if (frames <= 0) return undefined;

  const samplesPerFrame = versionBits === 3 ? 1152 : 576;
  return (frames * samplesPerFrame) / sampleRate;
}

/** Length of a media file in seconds, when its header states it. */
export function probeDuration(file: string, size: number): number | undefined {
  const ext = extensionOf(file);
  try {
    if (ext === ".wav") return wavDuration(file, size);
    if (ext === ".flac") return flacDuration(file);
    if (ext === ".mp3") return mp3Duration(file, size);
  } catch {
    return undefined;
  }
  return undefined;
}

// --- library -----------------------------------------------------------------

/** The full track list, including tracks the user switched off. */
export function listTracks(prefs: Prefs): TrackEntry[] {
  const disabled = new Set(prefs.audio.bgm.disabledTracks);
  return listMediaFiles("music").map((filename) => {
    const full = path.join(mediaDir("music"), filename);
    let size = 0;
    let mtimeMs = 0;
    try {
      const stat = fs.statSync(full);
      size = stat.size;
      mtimeMs = stat.mtimeMs;
    } catch {
      /* raced with a delete; report what we know */
    }
    return {
      id: filename,
      filename,
      displayName: displayName(filename),
      enabled: !disabled.has(filename),
      size,
      mtimeMs,
      durationSeconds: size > 0 ? probeDuration(full, size) : undefined,
    };
  });
}

/** The playable subset — what the dock's next/previous walk. */
export function enabledTracks(prefs: Prefs): TrackEntry[] {
  return listTracks(prefs).filter((t) => t.enabled);
}

/** A simple pool listing for `sounds/`, `voice/`, `pet/` and `status/`. */
export function listPool(kind: "sounds" | "voice" | "pet" | "status"): PoolEntry[] {
  return listMediaFiles(kind).map((filename) => {
    let size = 0;
    try {
      size = fs.statSync(path.join(mediaDir(kind), filename)).size;
    } catch {
      /* raced */
    }
    return { id: filename, filename, size };
  });
}

export interface AddResult {
  ok: true;
  filename: string;
  size: number;
  /** True when an existing file of the same name was replaced. */
  replaced: boolean;
}

export type AddError = { ok: false; status: number; error: string };

/**
 * Moves an already-written temporary file into a media directory.
 *
 * The body arrives as a *path* rather than a buffer on purpose: uploads are
 * allowed to be large, and the route already streamed them to disk. Reading the
 * file back just to write it again would cost a second full-size allocation for
 * no gain, so this validates the name and extension, then renames the temp file
 * into place — an atomic move on every platform we ship on.
 *
 * Validation is deliberately redundant with the browser's: the client checks the
 * size before sending, and this checks it again, because a hand-rolled request
 * is not the client. An empty, oversized, or wrong-type-for-the-kind file is
 * rejected with a status that says which. A name that cannot be reduced to a
 * safe basename is rejected before it reaches the filesystem.
 *
 * An existing file of the same name is replaced — the alternative (suffix
 * numbering) would silently create a second entry the user did not ask for.
 */
export function addMediaFile(
  kind: "music" | "sounds" | "voice" | "pet",
  originalName: unknown,
  source: { path: string; size: number }
): AddResult | AddError {
  if (source.size === 0) return { ok: false, status: 400, error: "file is empty" };
  if (source.size > MAX_UPLOAD_BYTES) {
    return { ok: false, status: 413, error: `file is larger than ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB` };
  }

  const filename = sanitizeFilename(originalName);
  if (!isAllowedForKind(filename, kind)) {
    return { ok: false, status: 415, error: `unsupported file type for ${kind}/` };
  }

  const dir = mediaDir(kind);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, filename);

  // Refuse to replace a file reached through a link: writing through it would
  // put the bytes outside the media directory entirely.
  try {
    if (fs.existsSync(dest) && fs.lstatSync(dest).isSymbolicLink()) {
      return { ok: false, status: 409, error: "refusing to replace a linked file" };
    }
  } catch {
    /* fall through to the rename, which will report its own failure */
  }

  const replaced = fs.existsSync(dest);
  try {
    fs.renameSync(source.path, dest);
  } catch {
    // A cross-device rename cannot work; fall back to a copy plus removal.
    fs.copyFileSync(source.path, dest);
    fs.rmSync(source.path, { force: true });
  }
  return { ok: true, filename, size: source.size, replaced };
}

/** Deletes one media file. Returns the size removed, or throws for a bad name. */
export function deleteMediaFile(kind: "music" | "sounds" | "voice" | "pet", basename: unknown): number {
  const full = resolveMediaFile(kind, basename);
  const size = fs.statSync(full).size;
  fs.rmSync(full);
  return size;
}

/** True when `basename` names an existing file in the kind's directory. */
export function mediaFileExists(kind: "music" | "sounds" | "voice" | "pet", basename: unknown): boolean {
  try {
    resolveMediaFile(kind, basename);
    return true;
  } catch (err) {
    if (err instanceof UnsafePathError) return false;
    return false;
  }
}
