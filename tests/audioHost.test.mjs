// The v0.2 host API end to end: the real request handler, over a real socket.
//
// This is the surface a hostile local page can reach, so the assertions are as
// much about what must be refused (tokens, traversal, content types) as about
// what is served. The server context is assembled exactly as src/core/server.ts
// assembles it, so nothing here tests a private copy of the logic.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "zct-host-"));
process.env.ZCODE_TARKOV_DATA_DIR = root;

const { handleHostRoute } = await import("../.test-build/api/hostRoutes.js");
const { getPrefs, setPrefs, prefsLoadInfo } = await import("../.test-build/prefs/store.js");
const { defaultPrefs } = await import("../.test-build/prefs/defaults.js");
const { mediaDir } = await import("../.test-build/core/dataRoot.js");
const { defaultPool } = await import("../.test-build/status/pool.js");

const TOKEN = "full-token-0123456789";
const MEDIA_TOKEN = "media-token-0123456789";
const FULL = { "x-zb-token": TOKEN };
const STARTED_AT = Date.now();

// Each test starts from the default document so the ones that write prefs
// cannot leak into the ones that read them.
beforeEach(() => {
  setPrefs(defaultPrefs());
});

/** The same response helper src/core/server.ts passes into the handler. */
function sendJson(res, code, body) {
  try {
    res.writeHead(code, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end(JSON.stringify(body));
  } catch {
    /* response already finished or socket gone */
  }
}

async function closeServer(server) {
  await new Promise((resolve) => {
    server.close(() => resolve());
    // The client agent is disabled below; this only guards against a half-open
    // socket keeping the test runner alive.
    server.closeAllConnections();
  });
}

async function withHost(run) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    handleHostRoute({
      method: req.method ?? "GET",
      url,
      req,
      res,
      token: TOKEN,
      mediaToken: MEDIA_TOKEN,
      readPrefs: getPrefs,
      writePrefs: (next) => setPrefs(next),
      prefsStatus: prefsLoadInfo,
      version: "0.0.0-test",
      startedAt: STARTED_AT,
      sendJson,
    })
      .then((handled) => {
        if (!handled) sendJson(res, 404, { error: "not found" });
      })
      .catch(() => {
        try {
          res.destroy();
        } catch {
          /* socket gone */
        }
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

function json(res) {
  return JSON.parse(res.body.toString("utf8"));
}

function resetDir(kind) {
  fs.rmSync(mediaDir(kind), { recursive: true, force: true });
  fs.mkdirSync(mediaDir(kind), { recursive: true });
}

function put(kind, name, contents) {
  fs.mkdirSync(mediaDir(kind), { recursive: true });
  fs.writeFileSync(path.join(mediaDir(kind), name), contents);
}

function leftoverUploads() {
  return fs.readdirSync(mediaDir("music")).filter((name) => name.startsWith(".upload."));
}

// --- authorisation -----------------------------------------------------------

test("a JSON route needs the full token in the header", async () => {
  await withHost(async (base) => {
    const missing = await request(base, "/api/prefs");
    assert.equal(missing.status, 403, "an unauthenticated read of preferences must be refused");
    const wrong = await request(base, "/api/prefs", { headers: { "x-zb-token": "not-the-token" } });
    assert.equal(wrong.status, 403, "a near-miss token is still a wrong token");
    const ok = await request(base, "/api/prefs", { headers: FULL });
    assert.equal(ok.status, 200);
    assert.equal(json(ok).prefs.appearance.colorMode, "tarkov");
  });
});

test("a media read accepts the media token from the query string", async () => {
  resetDir("music");
  put("music", "song.mp3", "0123456789");
  await withHost(async (base) => {
    const query = await request(base, `/api/media/music/song.mp3?token=${MEDIA_TOKEN}`);
    assert.equal(query.status, 200, "an <audio> element cannot attach a header, so the query token is the point");
    assert.equal(query.body.toString(), "0123456789");

    const header = await request(base, "/api/media/music/song.mp3", { headers: { "x-zb-token": MEDIA_TOKEN } });
    assert.equal(header.status, 200, "the same token in the header is equivalent");

    const wrong = await request(base, "/api/media/music/song.mp3?token=wrong");
    assert.equal(wrong.status, 403);
  });
});

test("a media read with no token at all is refused", async () => {
  resetDir("music");
  put("music", "song.mp3", "0123456789");
  await withHost(async (base) => {
    const res = await request(base, "/api/media/music/song.mp3");
    assert.equal(res.status, 403);
  });
});

test("a mutating route never accepts the media token", async () => {
  resetDir("music");
  put("music", "song.mp3", "0123456789");
  await withHost(async (base) => {
    const noToken = await request(base, "/api/prefs", { method: "POST" });
    assert.equal(noToken.status, 403);

    const mediaHeader = await request(base, "/api/prefs", { method: "POST", headers: { "x-zb-token": MEDIA_TOKEN } });
    assert.equal(mediaHeader.status, 403, "the read-only token authorises media reads and nothing else");

    const fullInQuery = await request(base, `/api/prefs?token=${TOKEN}`, { method: "POST" });
    assert.equal(fullInQuery.status, 403, "the full token is header-only, so a URL that leaks into logs is useless");

    const refusedDelete = await request(base, "/api/library/music/delete", {
      method: "POST",
      headers: { "x-zb-token": MEDIA_TOKEN },
      body: JSON.stringify({ name: "song.mp3" }),
    });
    assert.equal(refusedDelete.status, 403);
    assert.equal(fs.existsSync(path.join(mediaDir("music"), "song.mp3")), true, "the refused delete must not have run");
  });
});

// --- preferences -------------------------------------------------------------

test("GET /api/prefs returns the document and the load status", async () => {
  await withHost(async (base) => {
    const res = await request(base, "/api/prefs", { headers: FULL });
    assert.equal(res.status, 200);
    const body = json(res);
    assert.equal(body.prefs.appearance.colorMode, "tarkov");
    assert.equal(body.prefs.audio.bgm.volume, defaultPrefs().audio.bgm.volume);
    assert.deepEqual(body.status, {}, "a clean load reports neither a recovery nor a migration");
  });
});

test("POST /api/prefs merges a patch, clamps it, and leaves unrelated sections alone", async () => {
  await withHost(async (base) => {
    const res = await request(base, "/api/prefs", {
      method: "POST",
      headers: FULL,
      body: JSON.stringify({ appearance: { blur: 1e9 }, pet: { scale: 99999 } }),
    });
    assert.equal(res.status, 200);
    const body = json(res);
    assert.equal(body.ok, true);
    assert.equal(body.prefs.appearance.blur, 100, "every write is re-validated, so out-of-range values clamp");
    assert.equal(body.prefs.pet.scale, 320);
    assert.equal(body.prefs.appearance.dim, defaultPrefs().appearance.dim, "a patch only touches the keys it names");
    assert.equal(body.prefs.audio.bgm.volume, defaultPrefs().audio.bgm.volume);
    assert.equal(body.prefs.status.language, defaultPrefs().status.language);

    const read = json(await request(base, "/api/prefs", { headers: FULL }));
    assert.equal(read.prefs.appearance.blur, 100, "the merged document is what is stored, not just what is returned");
  });
});

// --- music library -----------------------------------------------------------

test("the library listing is empty on a fresh data root", async () => {
  resetDir("music");
  await withHost(async (base) => {
    const body = json(await request(base, "/api/library/music", { headers: FULL }));
    assert.deepEqual(body.tracks, []);
    assert.equal(body.empty, true, "the panel shows an empty state rather than an error");
    assert.equal(body.current, null, "no track is selected before one exists");
  });
});

test("the library listing reports every track and its enabled flag", async () => {
  resetDir("music");
  put("music", "b.mp3", "bb");
  put("music", "a.mp3", "aa");
  await withHost(async (base) => {
    const body = json(await request(base, "/api/library/music", { headers: FULL }));
    assert.deepEqual(
      body.tracks.map((t) => t.id),
      ["a.mp3", "b.mp3"],
      "the order is stable for the dock"
    );
    assert.equal(body.empty, false);
    assert.ok(body.tracks.every((t) => t.enabled));
  });
});

test("an upload stores the body under the sanitised name", async () => {
  resetDir("music");
  await withHost(async (base) => {
    const res = await request(base, "/api/library/music/add?name=" + encodeURIComponent("Field Track.mp3"), {
      method: "POST",
      headers: FULL,
      body: Buffer.alloc(64, 7),
    });
    assert.equal(res.status, 200);
    const body = json(res);
    assert.equal(body.ok, true);
    assert.equal(body.filename, "Field Track.mp3");
    assert.equal(body.size, 64);
    assert.equal(fs.readFileSync(path.join(mediaDir("music"), "Field Track.mp3")).length, 64);
    assert.deepEqual(leftoverUploads(), [], "the temp file is renamed into place, not left behind");
  });
});

test("an upload rejects an empty body and a type the kind does not serve", async () => {
  resetDir("music");
  await withHost(async (base) => {
    const empty = await request(base, "/api/library/music/add?name=empty.mp3", {
      method: "POST",
      headers: FULL,
      body: Buffer.alloc(0),
    });
    assert.equal(empty.status, 400, "a zero-byte upload is not a track");
    assert.equal(json(empty).error, "file is empty");

    const wrongType = await request(base, "/api/library/music/add?name=" + encodeURIComponent("notes.txt"), {
      method: "POST",
      headers: FULL,
      body: Buffer.from("some text"),
    });
    assert.equal(wrongType.status, 415, "text is a status pool, never music");
    assert.deepEqual(fs.readdirSync(mediaDir("music")), [], "a rejected upload leaves no temp file to be listed later");
  });
});

test("an upload name is reduced to a basename instead of escaping the library", async () => {
  resetDir("music");
  await withHost(async (base) => {
    const res = await request(base, "/api/library/music/add?name=" + encodeURIComponent("../../escape.mp3"), {
      method: "POST",
      headers: FULL,
      body: Buffer.from("audio"),
    });
    assert.equal(res.status, 200);
    assert.equal(json(res).filename, "escape.mp3", "the name is sanitised rather than rejected");
    assert.equal(fs.existsSync(path.join(mediaDir("music"), "escape.mp3")), true);
    assert.equal(fs.existsSync(path.join(root, "escape.mp3")), false, "the traversal must not have written at the data root");
  });
});

test("delete removes the file and rejects names it cannot resolve", async () => {
  resetDir("music");
  put("music", "gone.mp3", "12345");
  await withHost(async (base) => {
    const ok = await request(base, "/api/library/music/delete", {
      method: "POST",
      headers: FULL,
      body: JSON.stringify({ name: "gone.mp3" }),
    });
    assert.equal(ok.status, 200);
    assert.equal(json(ok).removed, 5);
    assert.equal(fs.existsSync(path.join(mediaDir("music"), "gone.mp3")), false);

    for (const name of ["nope.mp3", "../prefs.json", undefined]) {
      const res = await request(base, "/api/library/music/delete", {
        method: "POST",
        headers: FULL,
        body: JSON.stringify(name === undefined ? {} : { name }),
      });
      assert.equal(res.status, 400, `deleting ${JSON.stringify(name)} must be a client error`);
    }
  });
});

test("toggle sets a track's state and the next listing shows it", async () => {
  resetDir("music");
  put("music", "flip.mp3", "aa");
  await withHost(async (base) => {
    // The injected panel always sends the checkbox's new state alongside the
    // name, so the two explicit directions are the path the product uses.
    const off = await request(base, "/api/library/music/toggle", {
      method: "POST",
      headers: FULL,
      body: JSON.stringify({ name: "flip.mp3", enabled: false }),
    });
    assert.equal(off.status, 200);
    assert.deepEqual(json(off), { ok: true, name: "flip.mp3", enabled: false });
    let body = json(await request(base, "/api/library/music", { headers: FULL }));
    assert.equal(body.tracks[0].enabled, false, "the listing reflects the opt-out list that was just written");

    const on = await request(base, "/api/library/music/toggle", {
      method: "POST",
      headers: FULL,
      body: JSON.stringify({ name: "flip.mp3", enabled: true }),
    });
    assert.deepEqual(json(on), { ok: true, name: "flip.mp3", enabled: true });
    body = json(await request(base, "/api/library/music", { headers: FULL }));
    assert.equal(body.tracks[0].enabled, true);

    const unknown = await request(base, "/api/library/music/toggle", {
      method: "POST",
      headers: FULL,
      body: JSON.stringify({ name: "nope.mp3", enabled: true }),
    });
    assert.equal(unknown.status, 404, "a track that is not there cannot be switched");
  });
});

// --- streaming and pools -----------------------------------------------------

test("media is served with its own content type and honours Range", async () => {
  resetDir("music");
  put("music", "song.mp3", "0123456789");
  put("music", "other.wav", "wavbytes");
  await withHost(async (base) => {
    const whole = await request(base, `/api/media/music/song.mp3?token=${MEDIA_TOKEN}`);
    assert.equal(whole.status, 200);
    assert.equal(whole.headers["content-type"], "audio/mpeg", "the type comes from the extension, never a declaration");
    assert.equal(whole.headers["accept-ranges"], "bytes");

    const wav = await request(base, `/api/media/music/other.wav?token=${MEDIA_TOKEN}`);
    assert.equal(wav.headers["content-type"], "audio/wav");

    const ranged = await request(base, `/api/media/music/song.mp3?token=${MEDIA_TOKEN}`, {
      headers: { range: "bytes=2-5" },
    });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers["content-range"], "bytes 2-5/10");
    assert.equal(ranged.body.toString(), "2345");

    const head = await request(base, `/api/media/music/song.mp3?token=${MEDIA_TOKEN}`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers["content-length"], "10");
    assert.equal(head.body.length, 0, "HEAD must not send the file");

    const missing = await request(base, `/api/media/music/missing.mp3?token=${MEDIA_TOKEN}`);
    assert.equal(missing.status, 404);
  });
});

test("a traversal name and an unsupported type are refused before streaming", async () => {
  resetDir("music");
  put("music", "song.mp3", "0123456789");
  await withHost(async (base) => {
    for (const name of ["..%2Fsecret.mp3", "..%5Csecret.mp3"]) {
      const res = await request(base, `/api/media/music/${name}?token=${MEDIA_TOKEN}`);
      assert.equal(res.status, 404, `${name} must not resolve to anything`);
    }

    const wrongType = await request(base, `/api/media/music/notes.txt?token=${MEDIA_TOKEN}`);
    assert.equal(wrongType.status, 415, "a type the kind does not serve is not a media read");

    const fullInQuery = await request(base, `/api/media/music/song.mp3?token=${TOKEN}`);
    assert.equal(fullInQuery.status, 403, "the full token must not travel in a URL that ends up in logs");
  });
});

test("the status pool is bundled until the user supplies a file", async () => {
  resetDir("status");
  await withHost(async (base) => {
    const body = json(await request(base, "/api/status/phrases", { headers: FULL }));
    assert.equal(body.source, "bundled", "a user with no file gets the project's own pool");
    assert.equal(body.language, "zh", "the language comes from the preferences when the query does not say otherwise");
    assert.equal(body.count, body.phrases.length);
    assert.deepEqual(body.phrases, defaultPool("zh"));
  });
});

test("the user's status file wins, for either language", async (t) => {
  resetDir("status");
  const zhFile = path.join(mediaDir("status"), "texts.zh.txt");
  const enFile = path.join(mediaDir("status"), "texts.en.txt");
  fs.writeFileSync(zhFile, "# my lines\nHold the line\nMove up\n");
  fs.writeFileSync(enFile, "Fall back\n");
  t.after(() => {
    fs.rmSync(zhFile, { force: true });
    fs.rmSync(enFile, { force: true });
  });
  await withHost(async (base) => {
    const zh = json(await request(base, "/api/status/phrases", { headers: FULL }));
    assert.equal(zh.source, "user", "a user file that parses to phrases replaces the bundled pool");
    assert.deepEqual(zh.phrases, ["Hold the line", "Move up"], "comments and blank lines are not phrases");

    const en = json(await request(base, "/api/status/phrases?lang=en", { headers: FULL }));
    assert.equal(en.language, "en", "an explicit language overrides the preference");
    assert.equal(en.source, "user");
    assert.deepEqual(en.phrases, ["Fall back"]);

    const unknown = json(await request(base, "/api/status/phrases?lang=fr", { headers: FULL }));
    assert.equal(unknown.language, "zh", "an unknown language falls back to the preference");
  });
});

test("system reports the data root and every media directory", async () => {
  await withHost(async (base) => {
    const body = json(await request(base, "/api/system", { headers: FULL }));
    assert.equal(body.dataRoot, root, "the user needs to see which directory is actually in use");
    assert.deepEqual(
      body.mediaDirs.map((entry) => entry.kind),
      ["music", "sounds", "voice", "pet", "status"],
      "every kind the library can serve must be listed"
    );
    for (const entry of body.mediaDirs) {
      assert.ok(entry.path.startsWith(root), `${entry.path} must live under the data root`);
    }
    assert.equal(body.version, "0.0.0-test");
    assert.equal(body.service, "zcode-tarkov");
    assert.ok(body.uptimeSeconds >= 0);
  });
});
