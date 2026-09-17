/**
 * Request-body readers with hard caps.
 *
 * Two shapes are needed and they are not interchangeable:
 *
 *  - `readJsonBody` for control requests. These are tiny, so the body is capped
 *    at a few hundred kilobytes and read into memory; the cap exists so a
 *    malformed or hostile request cannot make the service allocate without
 *    limit.
 *  - `readBodyToFile` for media uploads, which are allowed to be large. The
 *    body is streamed straight to a temporary file and never held in memory —
 *    a 200 MB upload costs a 200 MB file, not a 200 MB allocation — and the
 *    moment the byte count exceeds the cap the request is destroyed and the
 *    partial file removed.
 *
 * Both destroy the request on overflow rather than draining it: a client that
 * cannot be told "too large" until it has finished sending is a client that can
 * hold a connection open by design.
 */

import fs from "node:fs";
import type http from "node:http";
import { MAX_UPLOAD_BYTES } from "../media/stream.js";

/** Ceiling for the small JSON control requests. */
export const MAX_JSON_BODY_BYTES = 256 * 1024;

export class BodyTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`request body exceeds ${limit} bytes`);
  }
}

/** Reads a JSON body into memory, capped. Returns undefined for an empty body. */
export function readJsonBody(req: http.IncomingMessage, limit = MAX_JSON_BODY_BYTES): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new BodyTooLargeError(limit));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/, "").trim();
      if (raw.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error(`invalid JSON body: ${(err as Error).message}`));
      }
    });
    req.on("error", reject);
  });
}

export interface WrittenBody {
  bytes: number;
  /** Filename the client claimed, taken from the query string. */
  name?: string;
}

/**
 * Streams a request body to `dest`, enforcing `limit` as it goes.
 *
 * On overflow the temporary file is removed, so a rejected upload leaves
 * nothing behind for the next listing to pick up as a track.
 */
export function readBodyToFile(
  req: http.IncomingMessage,
  dest: string,
  limit = MAX_UPLOAD_BYTES
): Promise<WrittenBody> {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    let done = false;
    const out = fs.createWriteStream(dest);

    const cleanup = (err: Error) => {
      if (done) return;
      done = true;
      out.destroy();
      try {
        fs.rmSync(dest, { force: true });
      } catch {
        /* best effort */
      }
      reject(err);
    };

    req.on("data", (chunk: Buffer) => {
      if (done) return;
      bytes += chunk.length;
      if (bytes > limit) {
        req.destroy();
        cleanup(new BodyTooLargeError(limit));
      }
    });
    req.on("error", cleanup);
    out.on("error", cleanup);
    req.pipe(out);
    out.on("finish", () => {
      if (done) return;
      done = true;
      resolve({ bytes });
    });
  });
}
