// The byte-bounded LRU cache used for decoded audio.
//
// The contract is small but easy to get subtly wrong (which entry is oldest, how
// the byte total behaves on replace, what happens to an entry that can never
// fit), so each clause is asserted against a cache whose budget makes the
// eviction order externally visible.
import test from "node:test";
import assert from "node:assert/strict";

const { LruCache } = await import("../.test-build/client/core/lru.js");

test("get promotes an entry, so the least recently used is evicted first", () => {
  const cache = new LruCache(2);
  cache.set("a", "A", 1);
  cache.set("b", "B", 1);
  assert.equal(cache.get("a"), "A");
  cache.set("c", "C", 1);
  assert.equal(cache.has("b"), false, "b became the least recently used when a was read");
  assert.equal(cache.has("a"), true, "reading an entry must protect it from eviction");
  assert.equal(cache.bytes, 2, "the total must track what actually remains");
});

test("keys are ordered from least to most recently used", () => {
  const cache = new LruCache(10);
  cache.set("a", 1, 1);
  cache.set("b", 2, 1);
  cache.set("c", 3, 1);
  assert.deepEqual(cache.keys(), ["a", "b", "c"]);
  cache.get("a");
  assert.deepEqual(cache.keys(), ["b", "c", "a"], "a read moves the entry to the most-recent end");
});

test("eviction stops as soon as the total fits", () => {
  const cache = new LruCache(4);
  cache.set("a", "A", 2);
  cache.set("b", "B", 2);
  assert.deepEqual(cache.keys(), ["a", "b"], "an exactly-full cache evicts nothing");
  cache.set("c", "C", 2);
  assert.deepEqual(cache.keys(), ["b", "c"], "only as many entries as needed are dropped");
  assert.equal(cache.bytes, 4);
});

test("an entry larger than the whole budget clears the cache and is not stored", () => {
  const cache = new LruCache(4);
  cache.set("a", "A", 2);
  cache.set("b", "B", 2);
  cache.set("huge", "H", 5);
  assert.equal(cache.size, 0, "storing it would leave the cache permanently over budget");
  assert.equal(cache.bytes, 0);
  assert.equal(cache.get("huge"), undefined);
  assert.equal(cache.has("a"), false, "the oversized entry takes everything with it");
});

test("bytes accounting is exact across set, get, delete and clear", () => {
  const cache = new LruCache(10);
  cache.set("a", "A", 3);
  assert.equal(cache.bytes, 3);
  assert.equal(cache.get("a"), "A");
  assert.equal(cache.bytes, 3, "a read must not change the accounting");
  assert.equal(cache.get("missing"), undefined);
  assert.equal(cache.bytes, 3);

  cache.set("b", "B", 2);
  assert.equal(cache.bytes, 5);
  cache.delete("a");
  assert.equal(cache.bytes, 2);
  assert.equal(cache.size, 1);
  cache.delete("missing");
  assert.equal(cache.bytes, 2, "deleting an absent key is a no-op");

  cache.clear();
  assert.equal(cache.bytes, 0);
  assert.equal(cache.size, 0);
  assert.deepEqual(cache.keys(), []);
});

test("set on an existing key replaces its size instead of double-counting", () => {
  const cache = new LruCache(10);
  cache.set("k", "small", 2);
  cache.set("k", "large", 7);
  assert.equal(cache.size, 1);
  assert.equal(cache.bytes, 7, "the old size must be subtracted before the new one is added");
  assert.equal(cache.get("k"), "large");
});

test("delete frees exactly the bytes it held, so a later insert needs no eviction", () => {
  const cache = new LruCache(4);
  cache.set("a", "A", 2);
  cache.set("b", "B", 2);
  cache.delete("a");
  cache.set("c", "C", 2);
  assert.deepEqual(cache.keys(), ["b", "c"], "the freed budget is reusable");
});

test("peek does not promote the entry it read", () => {
  const cache = new LruCache(2);
  cache.set("a", "A", 1);
  cache.set("b", "B", 1);
  assert.equal(cache.peek("a"), "A");
  cache.set("c", "C", 1);
  assert.equal(cache.has("a"), false, "peek is the 'can I avoid a fetch?' check, not a use");
  assert.equal(cache.has("b"), true);
});
