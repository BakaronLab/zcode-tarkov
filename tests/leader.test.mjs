// Leader election, driven through the pure core with an injected store and
// clock.
//
// The scenarios are the two the design exists for: a stale leader must not lock
// the room, and two renderers that raced must not both win. Everything is
// synchronous here because the module's timers live in the controller, not in
// the core.
import test from "node:test";
import assert from "node:assert/strict";

const { LeaderCore, parseLease, LEASE_MS, CLAIM_JITTER_MS, LEADER_KEY } = await import("../.test-build/client/core/leader.js");

function memoryStore() {
  let value;
  return {
    read: () => value,
    write: (next) => {
      value = next;
    },
    raw: () => value,
  };
}

function fakeClock(start = 1000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms) => {
      now += ms;
    },
  };
}

test("the lease key and the timing relationship are pinned", () => {
  assert.equal(LEADER_KEY, "zct:leader", "changing the key would orphan a lease written by an older renderer");
  assert.ok(CLAIM_JITTER_MS > 0, "simultaneous claims need a delay to serialise them");
  assert.ok(LEASE_MS > CLAIM_JITTER_MS, "the claim jitter must fit inside the lease");
});

test("parseLease accepts only a complete, finite lease", () => {
  assert.deepEqual(parseLease('{"id":"one","expiresAt":50}'), { id: "one", expiresAt: 50 });
  assert.equal(parseLease(undefined), undefined);
  assert.equal(parseLease(7), undefined);
  assert.equal(parseLease('{"id":"one","expiresAt":1e999}'), undefined, "a non-finite expiry is not a time");
});

test("the first claim succeeds and writes a lease for the full term", () => {
  const store = memoryStore();
  const clock = fakeClock(1000);
  const core = new LeaderCore("one", store, clock.now);
  assert.equal(core.isLeader(), false, "nobody leads before claiming");
  assert.equal(core.claimIfFree(), true);
  assert.equal(core.isLeader(), true);
  const lease = parseLease(store.raw());
  assert.equal(lease.id, "one");
  assert.equal(lease.expiresAt, 1000 + LEASE_MS, "the lease must expire so a dead renderer cannot lock the room");
});

test("a second core cannot claim while the lease is live", () => {
  const store = memoryStore();
  const clock = fakeClock();
  const first = new LeaderCore("one", store, clock.now);
  const second = new LeaderCore("two", store, clock.now);
  first.claimIfFree();
  assert.equal(second.claimIfFree(), false);
  assert.equal(second.isLeader(), false, "a refused claim leaves the core a follower");
  assert.equal(second.confirm(), false, "confirming a claim that never happened must not make a leader");
});

test("the lease expires and a second core takes over", () => {
  const store = memoryStore();
  const clock = fakeClock(1000);
  const first = new LeaderCore("one", store, clock.now);
  const second = new LeaderCore("two", store, clock.now);
  first.claimIfFree();

  clock.advance(LEASE_MS - 1);
  assert.equal(first.isLeader(), true, "the lease is live up to, but not including, its expiry instant");
  assert.equal(second.claimIfFree(), false);

  clock.advance(1);
  assert.equal(first.isLeader(), false, "an expired lease is no longer leadership");
  assert.equal(second.claimIfFree(), true);
  assert.equal(second.confirm(), true, "a claim is only believed after the re-read");
});

test("renew extends a held lease and fails once it has lapsed", () => {
  const store = memoryStore();
  const clock = fakeClock(0);
  const core = new LeaderCore("one", store, clock.now);
  core.claimIfFree();

  clock.advance(5000);
  assert.equal(core.renew(), true);
  assert.equal(parseLease(store.raw()).expiresAt, 5000 + LEASE_MS, "renewal restarts the term from now");

  clock.advance(LEASE_MS);
  assert.equal(core.renew(), false, "a lease at its expiry instant cannot be renewed");
  assert.equal(core.isLeader(), false);
});

test("re-claiming a held lease refreshes it", () => {
  const store = memoryStore();
  const clock = fakeClock(0);
  const core = new LeaderCore("one", store, clock.now);
  core.claimIfFree();
  clock.advance(1000);
  assert.equal(core.claimIfFree(), true);
  assert.equal(parseLease(store.raw()).expiresAt, 1000 + LEASE_MS);
});

test("leadership is re-derived from the lease, not from a stale local flag", () => {
  const store = memoryStore();
  const clock = fakeClock(0);
  const one = new LeaderCore("one", store, clock.now);
  one.claimIfFree();
  store.write(JSON.stringify({ id: "two", expiresAt: 60000 }));
  assert.equal(one.isLeader(), false, "a lease taken away by a racing writer must be noticed");
});

test("release frees the lease immediately", () => {
  const store = memoryStore();
  const clock = fakeClock();
  const first = new LeaderCore("one", store, clock.now);
  const second = new LeaderCore("two", store, clock.now);
  first.claimIfFree();
  first.release();
  assert.equal(first.isLeader(), false);
  assert.equal(parseLease(store.raw()), undefined, "release writes an empty id, which is not a lease");
  assert.equal(JSON.parse(store.raw()).id, "", "the freed marker is explicit, not a deletion a racing read could miss");
  assert.equal(second.claimIfFree(), true, "a follower takes over without waiting out the expiry");
});

test("a racing pair resolves to exactly one leader", () => {
  // The store buffers writes until sync(), modelling the window in which two
  // renderers both read a free lease before either write landed.
  let visible;
  let pending;
  const store = {
    read: () => visible,
    write: (value) => {
      pending = value;
    },
    sync: () => {
      if (pending !== undefined) visible = pending;
    },
  };
  const clock = fakeClock(0);
  const one = new LeaderCore("one", store, clock.now);
  const two = new LeaderCore("two", store, clock.now);

  assert.equal(one.claimIfFree(), true, "both cores read the same free lease");
  assert.equal(two.claimIfFree(), true);
  store.sync();

  assert.equal(one.confirm(), false, "the writer whose id did not survive stands down");
  assert.equal(two.confirm(), true);
  assert.equal(
    [one, two].filter((core) => core.isLeader()).length,
    1,
    "two renderers playing the same track would be the bug this module exists to prevent"
  );
  assert.equal(parseLease(store.read()).id, "two", "the last write is what both renderers now read");
});

test("a malformed or truncated stored lease is treated as absent, not fatal", () => {
  const malformed = [
    "{",
    '{"id":"one"}',
    '{"expiresAt":5}',
    "null",
    '"one"',
    "123",
    "",
    '{"id":"","expiresAt":9e15}',
    '{"id":"one","expiresAt":1e999}',
  ];
  for (const raw of malformed) {
    const store = memoryStore();
    store.write(raw);
    const clock = fakeClock(0);
    const core = new LeaderCore("one", store, clock.now);
    assert.equal(core.current(), undefined, `${JSON.stringify(raw)} must not parse as a lease`);
    assert.equal(core.claimIfFree(), true, `${JSON.stringify(raw)} must read as a free lease`);
  }
});

test("the lease term is the injected one", () => {
  const store = memoryStore();
  const clock = fakeClock(0);
  const core = new LeaderCore("one", store, clock.now, 1000);
  core.claimIfFree();
  assert.equal(parseLease(store.raw()).expiresAt, 1000);
  clock.advance(1000);
  assert.equal(core.isLeader(), false);
});
