// The status phrase pool: parsing a hand-edited file, choosing a pool, and the
// no-repeat draw that re-rolls the status line.
//
// The parser is the only place user text enters the status line, so the tests
// treat it as a hostile-input boundary: bounded length, bounded count, no
// control characters, no duplicates.
import test from "node:test";
import assert from "node:assert/strict";

const { parsePhrasePool, resolvePool, nextIndex, defaultPool, MAX_PHRASES, MAX_PHRASE_LENGTH } =
  await import("../.test-build/status/pool.js");

// --- parsePhrasePool ---------------------------------------------------------

test("blank lines, comments and surrounding whitespace are dropped", () => {
  const text = "\n  \n# a comment\n   Hold position   \n\t\n";
  assert.deepEqual(parsePhrasePool(text), ["Hold position"]);
});

test("comments are recognised after leading whitespace", () => {
  assert.deepEqual(parsePhrasePool("   # not a phrase\nReal phrase"), ["Real phrase"], "the '#' rule is on the first non-space character");
  assert.deepEqual(parsePhrasePool("#"), [], "a bare hash is a comment, not an empty phrase");
});

test("duplicates collapse, keeping the first occurrence", () => {
  assert.deepEqual(parsePhrasePool("alpha\nbeta\nalpha\nbeta\ngamma"), ["alpha", "beta", "gamma"]);
});

test("the pool is capped at MAX_PHRASES", () => {
  const lines = Array.from({ length: MAX_PHRASES + 50 }, (_, i) => `phrase ${i}`);
  assert.equal(parsePhrasePool(lines.join("\n")).length, MAX_PHRASES, "a runaway file must not become unbounded injected data");
});

test("each phrase is capped at MAX_PHRASE_LENGTH", () => {
  const phrase = parsePhrasePool("x".repeat(MAX_PHRASE_LENGTH + 40))[0];
  assert.equal(phrase.length, MAX_PHRASE_LENGTH);
});

test("the cap applies before deduplication, so two long lines can collapse", () => {
  const long = "y".repeat(MAX_PHRASE_LENGTH);
  assert.deepEqual(parsePhrasePool(`${long}A\n${long}B`), [long], "the compared value is the capped phrase");
});

test("a BOM is stripped instead of attaching itself to the first phrase", () => {
  assert.deepEqual(parsePhrasePool("\uFEFFFirst line\nSecond line"), ["First line", "Second line"]);
});

test("control characters are removed", () => {
  assert.deepEqual(parsePhrasePool("a\u0000b\u0007c\u007fd"), ["abcd"], "a binary byte in a text file must not reach the status line");
});

test("CRLF line endings parse like LF", () => {
  assert.deepEqual(parsePhrasePool("one\r\ntwo\r\n"), ["one", "two"]);
});

test("anything that is not a non-empty string is an empty pool", () => {
  for (const value of [undefined, null, 7, {}, [], true]) {
    assert.deepEqual(parsePhrasePool(value), [], String(value));
  }
  assert.deepEqual(parsePhrasePool(""), []);
});

// --- resolvePool -------------------------------------------------------------

test("a user file with phrases wins and is reported as user", () => {
  const resolved = resolvePool("zh", "  First  \n# note\nSecond\n");
  assert.deepEqual(resolved.phrases, ["First", "Second"]);
  assert.equal(resolved.source, "user");
});

test("a user file that parses to nothing falls back to the bundled pool", () => {
  for (const text of ["", "\n\n", "# only comments\n", "   \n", "\uFEFF\n"]) {
    const resolved = resolvePool("en", text);
    assert.equal(resolved.source, "bundled", JSON.stringify(text));
    assert.deepEqual(resolved.phrases, defaultPool("en"));
  }
});

test("having no file is the bundled pool", () => {
  const resolved = resolvePool("zh", undefined);
  assert.equal(resolved.source, "bundled");
  assert.deepEqual(resolved.phrases, defaultPool("zh"));
});

test("the bundled pool is returned as a fresh array", () => {
  const first = defaultPool("zh");
  first.push("mutated");
  const second = defaultPool("zh");
  assert.equal(second.includes("mutated"), false, "a caller must not be able to corrupt the bundled pool");
  assert.ok(second.length > 0);
});

// --- nextIndex ---------------------------------------------------------------

test("nextIndex never repeats the previous index and stays in range", () => {
  const length = 5;
  for (const previous of [0, 1, 2, 3, 4]) {
    const seen = new Set();
    for (let i = 0; i < 100; i += 1) {
      const value = nextIndex(previous, length, () => i / 100);
      assert.ok(Number.isInteger(value) && value >= 0 && value < length, `index ${value} must be inside the pool`);
      assert.notEqual(value, previous, "the same phrase must not be drawn twice in a row");
      seen.add(value);
    }
    assert.equal(seen.size, length - 1, "every index except the previous one must be reachable");
  }
});

test("a random double of exactly 0 or exactly 1 stays in range", () => {
  for (const edge of [0, 1]) {
    for (const previous of [0, 4]) {
      const value = nextIndex(previous, 5, () => edge);
      assert.ok(value >= 0 && value < 5, `random() === ${edge} gave ${value}`);
      assert.notEqual(value, previous);
    }
  }
});

test("an out-of-range previous index still yields an in-range draw", () => {
  // -1 is the status roller's initial sentinel and 99 models a pool that shrank
  // under the last index; neither may make the result invalid or a "repeat".
  for (const previous of [-1, 99]) {
    const value = nextIndex(previous, 5, () => 0);
    assert.ok(Number.isInteger(value) && value >= 0 && value < 5, `previous ${previous} gave ${value}`);
    assert.notEqual(value, previous);
  }
});

test("a pool of one returns its only index", () => {
  assert.equal(nextIndex(0, 1), 0);
  assert.equal(nextIndex(7, 1), 0);
  assert.equal(nextIndex(0, 0), 0, "there is nothing to avoid repeating in an empty pool");
  assert.equal(nextIndex(0, -3), 0);
});

// --- the bundled pools -------------------------------------------------------

test("both bundled pools are non-empty and free of duplicates", () => {
  for (const language of ["zh", "en"]) {
    const pool = defaultPool(language);
    assert.ok(pool.length > 0, `${language} must ship phrases; an empty default looks like a broken feature`);
    assert.equal(new Set(pool).size, pool.length, `${language} contains a duplicate line`);
  }
});

test("no bundled line appears in both languages", () => {
  const zh = new Set(defaultPool("zh"));
  const shared = defaultPool("en").filter((phrase) => zh.has(phrase));
  assert.deepEqual(shared, [], "a shared line would be untranslated content");
});
