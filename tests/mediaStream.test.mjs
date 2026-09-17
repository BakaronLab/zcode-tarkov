// Byte-range streaming: what the parser accepts and what a media element
// actually receives over a real socket.
//
// A <audio> element treats a server that ignores Range as unseekable, so the
// 206 headers, the 416 body and the parser's declined forms are the feature,
// not polish. The cases here are the ones Chromium actually sends.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "zct-stream-"));
process.env.ZCODE_TARKOV_DATA_DIR = root;

const { parseRange, sendFile, MAX_UPLOAD_BYTES } = await import("../.test-build/media/stream.js");

const BODY = "0123456789abcdef";

function scratch(name, contents) {
  const file = path.join(root, name);
  fs.writeFileSync(file, contents);
  return file;
}

async function closeServer(server) {
  await new Promise((resolve) => {
    server.close(() => resolve());
    // The client agent is disabled below, so there is nothing to linger; this
    // is only a belt-and-braces guard against a half-open socket hanging the run.
    server.closeAllConnections();
  });
}

/** Serves one file through a real socket, and closes it whatever the test does. */
async function withServer(file, run) {
  const server = http.createServer((req, res) => {
    sendFile(res, {
      file,
      contentType: "audio/mpeg",
      rangeHeader: req.headers.range,
      headOnly: req.method === "HEAD",
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await closeServer(server);
  }
}

/** One request with no client keep-alive, so no socket outlives the test. */
function request(base, pathname, options = {}) {
  const method = options.method ?? "GET";
  const headers = { ...(options.headers ?? {}) };
  const payload =
    options.body === undefined ? undefined : Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body);
  if (payload !== undefined) headers["content-length"] = payload.length;
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(pathname, base), { method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

// --- parseRange --------------------------------------------------------------

test("the upload cap is the shared 200 MB constant", () => {
  assert.equal(MAX_UPLOAD_BYTES, 200 * 1024 * 1024, "the library's size guard must agree with the route's body cap");
});

test("no header, an empty header and a non-string are all declined", () => {
  assert.equal(parseRange(undefined, 1000), undefined);
  assert.equal(parseRange("", 1000), undefined);
  assert.equal(parseRange(7, 1000), undefined);
});

test("a closed or open byte range is parsed against the size", () => {
  assert.deepEqual(parseRange("bytes=0-", 1000), { start: 0, end: 999 }, "an open range runs to the last byte");
  assert.deepEqual(parseRange("bytes=0-499", 1000), { start: 0, end: 499 });
  assert.deepEqual(parseRange("bytes=500-999", 1000), { start: 500, end: 999 });
  assert.deepEqual(parseRange("bytes=0-0", 1000), { start: 0, end: 0 }, "one byte is a valid range");
  assert.deepEqual(parseRange("bytes=500-99999", 1000), { start: 500, end: 999 }, "an end past EOF is clamped, not rejected");
});

test("a suffix range means the last N bytes", () => {
  assert.deepEqual(parseRange("bytes=-500", 1000), { start: 500, end: 999 });
  assert.deepEqual(parseRange("bytes=-2000", 1000), { start: 0, end: 999 }, "a suffix longer than the file is the whole file");
  assert.equal(parseRange("bytes=-0", 1000), null, "a zero-length suffix asks for bytes that do not exist");
  assert.equal(parseRange("bytes=-", 1000), undefined, "an empty spec is not a range at all");
});

test("an unsatisfiable range is null, which is a 416 rather than a silent 200", () => {
  assert.equal(parseRange("bytes=1000-1200", 1000), null, "a start at EOF can never be satisfied");
  assert.equal(parseRange("bytes=10-5", 1000), null, "an inverted range is unsatisfiable, not reversed");
  assert.equal(parseRange("bytes=0-", 0), null, "a zero-byte file cannot satisfy any range");
});

test("a multi-range or unparseable header is declined so the whole file is sent", () => {
  assert.equal(parseRange("bytes=0-1,5-6", 1000), undefined, "RFC 7233 lets a server ignore a multi-range request");
  assert.equal(parseRange("items=0-1", 1000), undefined, "only the bytes unit is understood");
  assert.equal(parseRange("banana", 1000), undefined);
  assert.equal(parseRange("bytes=abc-def", 1000), undefined);
  assert.equal(parseRange("bytes=", 1000), undefined);
});

// --- over a socket -----------------------------------------------------------

test("a ranged GET answers 206 with the exact window", async () => {
  const file = scratch("range.mp3", BODY);
  await withServer(file, async (base) => {
    const res = await request(base, "/track", { headers: { range: "bytes=4-7" } });
    assert.equal(res.status, 206, "a satisfiable range must not be answered with the whole file");
    assert.equal(res.headers["content-range"], `bytes 4-7/${BODY.length}`);
    assert.equal(res.headers["content-length"], "4", "the length must be the window, not the file");
    assert.equal(res.body.toString(), BODY.slice(4, 8));
    assert.equal(res.headers["accept-ranges"], "bytes", "seeking is advertised on every response");
  });
});

test("a GET without a range answers 200 with the whole file", async () => {
  const file = scratch("whole.mp3", BODY);
  await withServer(file, async (base) => {
    const res = await request(base, "/track");
    assert.equal(res.status, 200);
    assert.equal(res.headers["content-length"], String(BODY.length));
    assert.equal(res.headers["accept-ranges"], "bytes");
    assert.equal(res.body.toString(), BODY);
  });
});

test("an unsatisfiable range is 416 and carries the real size", async () => {
  const file = scratch("unsat.mp3", BODY);
  await withServer(file, async (base) => {
    const res = await request(base, "/track", { headers: { range: "bytes=999-1000" } });
    assert.equal(res.status, 416, "a range past EOF must be told so instead of silently restarting the file");
    assert.equal(res.headers["content-range"], `bytes */${BODY.length}`, "the client recovers from the advertised size");
    assert.equal(res.body.length, 0);
  });
});

test("HEAD answers with headers and no body", async () => {
  const file = scratch("head.mp3", BODY);
  await withServer(file, async (base) => {
    const full = await request(base, "/track", { method: "HEAD" });
    assert.equal(full.status, 200);
    assert.equal(full.headers["content-length"], String(BODY.length), "the size must be known before playing");
    assert.equal(full.body.length, 0, "HEAD must not send the file");

    const ranged = await request(base, "/track", { method: "HEAD", headers: { range: "bytes=0-3" } });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers["content-length"], "4");
    assert.equal(ranged.headers["content-range"], `bytes 0-3/${BODY.length}`);
    assert.equal(ranged.body.length, 0);
  });
});

test("a zero-byte file is a sane empty 200 and any range against it is 416", async () => {
  const file = scratch("empty.mp3", "");
  await withServer(file, async (base) => {
    const res = await request(base, "/track");
    assert.equal(res.status, 200);
    assert.equal(res.headers["content-length"], "0");
    assert.equal(res.body.length, 0);

    const ranged = await request(base, "/track", { headers: { range: "bytes=0-" } });
    assert.equal(ranged.status, 416, "there is no first byte to serve");
    assert.equal(ranged.headers["content-range"], "bytes */0");
  });
});

test("a file that vanished before the stream is a 404, not a crash", () => {
  const seen = { status: 0, ended: false };
  const fake = {
    writeHead(code) {
      seen.status = code;
    },
    end() {
      seen.ended = true;
    },
  };
  const result = sendFile(fake, { file: path.join(root, "gone.mp3"), contentType: "audio/mpeg" });
  assert.equal(result.status, 404);
  assert.equal(result.sent, 0);
  assert.equal(seen.status, 404, "the response must carry the status the return value reports");
  assert.equal(seen.ended, true);
});
