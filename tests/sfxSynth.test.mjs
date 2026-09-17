// The synthesized event sounds: the shape of every sequence, asserted without
// an AudioContext.
//
// playSfx needs a running context and is deliberately never called here. What
// can be verified in Node is the data: bounded duration, bounded frequencies,
// audible levels, ordered steps, and that no audio asset is bundled or fetched.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const { SFX_SEQUENCES, sequenceDuration, MIN_TONE_HZ, MAX_TONE_HZ, MAX_EVENT_SECONDS } =
  await import("../.test-build/client/sfx/synth.js");

const EVENTS = ["start", "approval", "done", "error", "tool"];

test("every sfx event has a non-empty sequence", () => {
  assert.deepEqual(
    Object.keys(SFX_SEQUENCES).sort(),
    [...EVENTS].sort(),
    "the five switchable events and the five sequences must be the same set"
  );
  for (const event of EVENTS) {
    assert.ok(SFX_SEQUENCES[event].length > 0, `${event} must have at least one step`);
  }
});

test("no sequence outlives MAX_EVENT_SECONDS", () => {
  for (const event of EVENTS) {
    const seconds = sequenceDuration(SFX_SEQUENCES[event]);
    assert.ok(seconds > 0, `${event} must actually sound`);
    assert.ok(seconds <= MAX_EVENT_SECONDS, `${event} runs ${seconds}s; a sound that outlives its event is noise`);
  }
});

test("every frequency is inside the documented band", () => {
  for (const event of EVENTS) {
    for (const step of SFX_SEQUENCES[event]) {
      assert.ok(step.from >= MIN_TONE_HZ && step.from <= MAX_TONE_HZ, `${event} starts at ${step.from} Hz`);
      assert.ok(step.to >= MIN_TONE_HZ && step.to <= MAX_TONE_HZ, `${event} ends at ${step.to} Hz`);
    }
  }
});

test("steps are ordered in time, positive in length, and audible", () => {
  for (const event of EVENTS) {
    const steps = SFX_SEQUENCES[event];
    for (const step of steps) {
      assert.ok(step.duration > 0, `${event} must not schedule a zero-length step`);
      assert.ok(step.level > 0 && step.level <= 1, `${event} step level ${step.level} must be inside (0, 1]`);
      assert.ok(
        step.type === "sine" || step.type === "triangle",
        `${event} uses ${step.type}; only the two soft carriers belong here`
      );
    }
    for (let i = 1; i < steps.length; i += 1) {
      assert.ok(steps[i].at >= steps[i - 1].at, `${event} steps must be non-decreasing in time`);
      assert.ok(
        steps[i].at >= steps[i - 1].at + steps[i - 1].duration,
        `${event} steps must not overlap, which is what keeps an envelope from being cut off`
      );
    }
  }
});

test("the five sequences are distinct", () => {
  const shapes = EVENTS.map((event) => JSON.stringify(SFX_SEQUENCES[event]));
  assert.equal(new Set(shapes).size, EVENTS.length, "two events sounding the same would be indistinguishable");
});

test("error descends and done resolves", () => {
  const error = SFX_SEQUENCES.error;
  assert.ok(error[error.length - 1].to < error[0].from, "error must end below where it began");
  assert.ok(
    error[error.length - 1].to < error[error.length - 1].from,
    "the final error tone is a downward glide, so it reads as wrong rather than as an alarm"
  );

  const done = SFX_SEQUENCES.done;
  assert.ok(done[done.length - 1].to < done[0].from, "done drops to its lower interval");
  for (const step of done) {
    assert.equal(step.from, step.to, "done is an interval marker, not a sweep");
  }
});

test("the module bundles no audio file and fetches none", () => {
  const source = fs.readFileSync(new URL("../.test-build/client/sfx/synth.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /data:audio/, "a data URI would be bundled audio in a repository that ships none");
  assert.doesNotMatch(source, /new Audio\(/, "the sounds are oscillators, never media elements");
  assert.doesNotMatch(source, /base64/i, "a base64 blob is an audio file by another name");
  assert.doesNotMatch(source, /fetch\(/, "there is no download in this module");
});
