/**
 * Byte-range streaming for user media.
 *
 * A `<audio>` element does not download a track — it issues `Range` requests to
 * seek, and Chromium treats a server that ignores `Range` as unseekable. The
 * range parser is therefore not a nicety: without it, dragging the BGM dock's
 * progress bar would restart the track from zero.
 *
 * The rules implemented here are the ones Chromium actually depends on:
 *  - `Accept-Ranges: bytes` on every response, so seeking is advertised at all.
 *  - `206` with a correct `Content-Range` and a `Content-Length` matching the
 *    bytes actually sent.
 *  - `416` with `Content-Range: bytes *\/<size>` for an unsatisfiable range, so
 *    the element stops asking instead of retrying forever.
 *  - A single range is honoured; a multi-range request falls back to `200` with
 *    the whole file, which RFC 7233 explicitly permits ("a server MAY ignore
 *    the Range header field") and which no media element ever asks for.
 *
 * Nothing here ever buffers the whole file: `fs.createReadStream` with an
 * explicit `start`/`end` reads only the requested window, so a 200 MB track
 * costs a few hundred kilobytes of memory per seek.
 */

import fs from "node:fs";
import type http from "node:http";
import type { Readable } from "node:stream";

/** Files above this size are refused at upload; streaming has no such limit. */
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

export interface ByteRange {
  start: number;
  end: number;
}

/**
 * Parses a single-range `Range` header against a known size.
 *
 * Returns:
 *  - `undefined` when there is no range, or the syntax is one we decline to
 *    interpret (multi-range, unknown unit) — the caller sends the whole file;
 *  - `null` when the range is syntactically valid but unsatisfiable, which is a
 *    `416`, not a silent `200`: a media element that asked for bytes past the
 *    end must be told so.
 */
export function parseRange(header: unknown, size: number): ByteRange | undefined | null {
  if (typeof header !== "string" || header.length === 0) return undefined;
  const match = /^bytes=(.*)$/i.exec(header.trim());
  if (!match) return undefined;
  const spec = match[1].trim();

  // Multi-range: declined (answered with the full file).
  if (spec.includes(",")) return undefined;

  const m = /^(\d*)-(\d*)$/.exec(spec);
  if (!m) return undefined;
  const [, rawStart, rawEnd] = m;
  if (rawStart === "" && rawEnd === "") return undefined;

  // A zero-length file cannot satisfy any byte range.
  if (size === 0) return null;

  if (rawStart === "") {
    // Suffix range: the last N bytes. "bytes=-0" is unsatisfiable.
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    const start = Math.max(0, size - suffix);
    return { start, end: size - 1 };
  }

  const start = Number(rawStart);
  if (!Number.isFinite(start) || start >= size) return null;

  let end: number;
  if (rawEnd === "") {
    end = size - 1;
  } else {
    const parsedEnd = Number(rawEnd);
    if (!Number.isFinite(parsedEnd)) return undefined;
    if (parsedEnd < start) return null;
    end = Math.min(parsedEnd, size - 1);
  }
  return { start, end };
}

export interface StreamHeaders {
  [key: string]: string | number;
}

/** Headers common to every media response we send. */
export function baseMediaHeaders(contentType: string, size: number): StreamHeaders {
  return {
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
    // Media is user content fetched by the renderer from a localhost origin.
    // It is never a document: forbidding sniffing and framing keeps a crafted
    // media file from being interpreted as markup.
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": "inline",
    // Required, not optional. The renderer is a `file://` document, so every
    // request it makes to this service is cross-origin, and the player sets
    // `crossOrigin = "anonymous"` on the audio element so that
    // `createMediaElementSource` can route it through the gain graph without
    // silencing it. An audio element in that mode rejects a response that
    // carries no `Access-Control-Allow-Origin`, which would make every track
    // fail to load — the difference between "music plays" and "nothing plays".
    //
    // `*` is safe here because this is not the authorisation boundary: the only
    // way to reach this route is the media token in the query string, which a
    // hostile page cannot know. Adding the header lets the *legitimate*
    // requester read a response it already had to authenticate for; it does not
    // let anyone else read one. The JSON API sends the same header for the same
    // reason.
    "Access-Control-Allow-Origin": "*",
    // A track's bytes never change under the same name in practice, but a
    // stale cached copy after a re-upload would be confusing; require
    // revalidation and let the 304 path handle it.
    "Cache-Control": "private, max-age=0, must-revalidate",
    "Content-Length": size,
  };
}

export interface SendFileOptions {
  /** Absolute path proven safe by `resolveMediaFile`. */
  file: string;
  contentType: string;
  /** The request's `Range` header, if any. */
  rangeHeader?: unknown;
  /** `HEAD` sends the headers only. */
  headOnly?: boolean;
}

export interface SendFileResult {
  status: number;
  /** Bytes actually sent (0 for HEAD and for 416). */
  sent: number;
  error?: string;
}

/**
 * Writes a file (or the requested slice of it) to an HTTP response.
 *
 * Never throws for a request-level problem: a malformed or unsatisfiable range
 * is a status code, not an exception. A stream error after the headers are out
 * can only end the response, since the status line is already committed.
 */
export function sendFile(res: http.ServerResponse, opts: SendFileOptions): SendFileResult {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(opts.file);
  } catch {
    return fail(res, 404, "not found");
  }
  if (!stat.isFile()) return fail(res, 404, "not found");

  const size = stat.size;
  const range = parseRange(opts.rangeHeader, size);

  if (range === null) {
    // Unsatisfiable: tell the client the real size so it can recover.
    try {
      res.writeHead(416, {
        "Content-Type": "text/plain; charset=utf-8",
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes */${size}`,
      });
      res.end();
    } catch {
      /* socket gone */
    }
    return { status: 416, sent: 0, error: "range not satisfiable" };
  }

  const headers = baseMediaHeaders(opts.contentType, size);

  if (!range) {
    try {
      res.writeHead(200, headers);
    } catch {
      return { status: 200, sent: 0 };
    }
    if (opts.headOnly) {
      res.end();
      return { status: 200, sent: 0 };
    }
    return pump(res, opts.file, undefined, undefined, headers["Content-Length"] as number);
  }

  const length = range.end - range.start + 1;
  try {
    res.writeHead(206, {
      ...headers,
      "Content-Length": length,
      "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
    });
  } catch {
    return { status: 206, sent: 0 };
  }
  if (opts.headOnly) {
    res.end();
    return { status: 206, sent: 0 };
  }
  return pump(res, opts.file, range.start, range.end, length);
}

/**
 * Streams the file window, keeping the process alive if the client vanishes.
 *
 * An aborted download (the element seeks away, the renderer reloads) surfaces as
 * an `error` on the read stream; the response is already committed, so the only
 * correct handling is to stop reading and destroy what is left.
 */
function pump(
  res: http.ServerResponse,
  file: string,
  start: number | undefined,
  end: number | undefined,
  expected: number
): SendFileResult {
  const stream: Readable = fs.createReadStream(file, start === undefined ? {} : { start, end });
  stream.on("error", () => {
    try {
      res.destroy();
    } catch {
      /* already gone */
    }
  });
  res.on("close", () => {
    if (!stream.destroyed) stream.destroy();
  });
  stream.pipe(res);
  return { status: start === undefined ? 200 : 206, sent: expected };
}

function fail(res: http.ServerResponse, status: number, message: string): SendFileResult {
  try {
    res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(message);
  } catch {
    /* socket gone */
  }
  return { status, sent: 0, error: message };
}
