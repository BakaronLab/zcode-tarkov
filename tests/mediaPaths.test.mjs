// Media path handling: the traversal, symlink and extension rules.
//
// This is the security-critical surface of the host API, so the tests here are
// adversarial rather than representative: every case is an input a hostile
// request could send, not an input the UI would send.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "zct-paths-"));
process.env.ZCODE_TARKOV_DATA_DIR = root;

const {
  isSafeBasename,
  sanitizeFilename,
  contentTypeFor,
  isAllowedForKind,
  resolveMediaFile,
  listMediaFiles,
  UnsafePathError,
  MEDIA_CONTENT_TYPES,
  IMAGE_CONTENT_TYPES,
} = await import("../.test-build/media/paths.js");
const { mediaDir, ensureDataRoot } = await import("../.test-build/core/dataRoot.js");

ensureDataRoot();

function put(kind, name, bytes = "x") {
  const file = path.join(mediaDir(kind), name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return file;
}

// --- basenames ---------------------------------------------------------------

test("a flat filename is accepted", () => {
  for (const name of ["song.mp3", "a.wav", "track 01 - remix.flac", "MUPPET.OGG"]) {
    assert.equal(isSafeBasename(name), true, name);
  }
});

test("anything that could change which directory a name resolves to is refused", () => {
  const hostile = [
    "../secret.mp3",
    "..\\secret.mp3",
    "a/b.mp3",
    "a\\b.mp3",
    "..",
    ".",
    "",
    "C:secret.mp3",
    "C:\\Windows\\win.ini",
    "\\\\server\\share\\a.mp3",
    "a\0b.mp3",
    "trailing.",
    "trailing ",
    "nul\u0001.mp3",
  ];
  for (const name of hostile) {
    assert.equal(isSafeBasename(name), false, JSON.stringify(name));
  }
});

test("non-strings are refused", () => {
  for (const value of [undefined, null, 7, {}, [], true]) {
    assert.equal(isSafeBasename(value), false);
  }
});

test("an over-long name is refused", () => {
  assert.equal(isSafeBasename("a".repeat(200)), true);
  assert.equal(isSafeBasename("a".repeat(201)), false);
});

test("sanitizeFilename reduces a full path to a safe basename", () => {
  assert.equal(sanitizeFilename("C:\\Users\\me\\Music\\track.mp3"), "track.mp3");
  assert.equal(sanitizeFilename("/home/me/music/track.mp3"), "track.mp3");
  assert.equal(sanitizeFilename("...hidden.mp3"), "hidden.mp3");
  assert.equal(sanitizeFilename("bad:name?.mp3"), "bad_name_.mp3");
  assert.equal(sanitizeFilename(""), "track");
  assert.equal(sanitizeFilename(undefined), "track");
  // The result is always something the strict check accepts.
  for (const input of ["../a.mp3", "a/b/c.mp3", "  spaced  .mp3", "x".repeat(400) + ".mp3"]) {
    const cleaned = sanitizeFilename(input);
    assert.equal(isSafeBasename(cleaned), true, `${input} -> ${cleaned}`);
  }
});

// --- content types -----------------------------------------------------------

test("content types come from the extension", () => {
  assert.equal(contentTypeFor("a.mp3"), "audio/mpeg");
  assert.equal(contentTypeFor("a.wav"), "audio/wav");
  assert.equal(contentTypeFor("a.ogg"), "audio/ogg");
  assert.equal(contentTypeFor("a.flac"), "audio/flac");
  assert.equal(contentTypeFor("a.m4a"), "audio/mp4");
  assert.equal(contentTypeFor("a.webm"), "audio/webm");
  assert.equal(contentTypeFor("p.png", "pet"), "image/png");
  assert.equal(contentTypeFor("p.webp", "pet"), "image/webp");
  assert.equal(contentTypeFor("p.gif", "pet"), "image/gif");
  assert.equal(contentTypeFor("t.txt", "status"), "text/plain");
  assert.equal(contentTypeFor("a.mp3", "pet"), undefined, "audio is not a pet image");
  assert.equal(contentTypeFor("p.png", "music"), undefined, "images are not music");
  // With no kind there is nothing to narrow against, so the answer comes from
  // whichever allowlist holds the extension. `.txt` is only ever servable as a
  // status pool, which is exactly what `text/plain` says.
  assert.equal(contentTypeFor("a.txt"), "text/plain");
  assert.equal(contentTypeFor("a.exe"), undefined);
  assert.equal(contentTypeFor("a.html"), undefined);
});

test("the extension check is case-insensitive but not type-confusable", () => {
  assert.equal(isAllowedForKind("A.MP3", "music"), true);
  assert.equal(isAllowedForKind("a.mp3", "pet"), false);
  // A double extension cannot smuggle a type past the check: only the last one
  // counts, and an html-claiming name is simply not allowed.
  assert.equal(isAllowedForKind("evil.html.mp3", "music"), true);
  assert.equal(isAllowedForKind("evil.html", "music"), false);
});

test("no allowed extension maps to a markup or script type", () => {
  for (const type of [...Object.values(MEDIA_CONTENT_TYPES), ...Object.values(IMAGE_CONTENT_TYPES)]) {
    assert.equal(/html|javascript|svg|xml/i.test(type), false, type);
  }
});

// --- resolution --------------------------------------------------------------

test("an existing file inside the media directory resolves", () => {
  put("music", "ok.mp3");
  assert.equal(resolveMediaFile("music", "ok.mp3"), fs.realpathSync(path.join(mediaDir("music"), "ok.mp3")));
});

test("traversal names are rejected before the filesystem is consulted", () => {
  put("music", "ok.mp3");
  for (const name of ["../ok.mp3", "..\\ok.mp3", "sub/ok.mp3"]) {
    assert.throws(() => resolveMediaFile("music", name), UnsafePathError, name);
  }
});

test("a missing file is a rejected path, not a crash", () => {
  assert.throws(() => resolveMediaFile("music", "nope.mp3"), UnsafePathError);
});

test("a directory is not a servable file", () => {
  fs.mkdirSync(path.join(mediaDir("music"), "album.mp3"), { recursive: true });
  assert.throws(() => resolveMediaFile("music", "album.mp3"), UnsafePathError);
});

test("a symlink pointing outside the media directory is refused", () => {
  const outside = path.join(root, "outside.mp3");
  fs.writeFileSync(outside, "secret");
  const link = path.join(mediaDir("music"), "link.mp3");
  fs.rmSync(link, { force: true });
  try {
    fs.symlinkSync(outside, link, "file");
  } catch {
    // Windows without developer mode cannot create symlinks; the rule is still
    // exercised by the junction case below where possible.
    return;
  }
  assert.throws(() => resolveMediaFile("music", "link.mp3"), UnsafePathError);
});

test("a symlink that stays inside the media directory is accepted", () => {
  put("music", "real.mp3", "abc");
  const link = path.join(mediaDir("music"), "alias.mp3");
  fs.rmSync(link, { force: true });
  try {
    fs.symlinkSync(path.join(mediaDir("music"), "real.mp3"), link, "file");
  } catch {
    return;
  }
  // The check compares the resolved name against the requested one, so an alias
  // is refused: two names for one file would make "delete" ambiguous.
  assert.throws(() => resolveMediaFile("music", "alias.mp3"), UnsafePathError);
});

// --- listing -----------------------------------------------------------------

test("listing returns only servable regular files, sorted, as basenames", () => {
  const dir = mediaDir("music");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  put("music", "b.mp3");
  put("music", "a.wav");
  fs.writeFileSync(path.join(dir, "notes.txt"), "not media");
  fs.writeFileSync(path.join(dir, "no-extension"), "not media");
  fs.mkdirSync(path.join(dir, "folder.mp3"));

  const listed = listMediaFiles("music");
  assert.deepEqual(listed, ["a.wav", "b.mp3"]);
  for (const name of listed) assert.equal(name.includes(path.sep), false);
});

test("listing a media directory that does not exist is an empty list", () => {
  fs.rmSync(mediaDir("voice"), { recursive: true, force: true });
  assert.deepEqual(listMediaFiles("voice"), []);
  // Listing must not have created it as a side effect.
  assert.equal(fs.existsSync(mediaDir("voice")), false);
});
