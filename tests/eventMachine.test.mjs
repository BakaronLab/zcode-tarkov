// The event state machine, driven observation by observation.
//
// The contract in the module header is the specification, and the point of the
// machine is quietness: most updates must produce nothing, every once-per-turn
// latch must hold, and only the approval edge re-arms. Each test below pins one
// of those clauses.
import test from "node:test";
import assert from "node:assert/strict";

const { EventMachine, EMPTY_OBSERVATION, DEFAULT_ENTRY_TICKS, DEFAULT_EXIT_TICKS } =
  await import("../.test-build/client/signals/machine.js");

function obs(overrides = {}) {
  return { ...EMPTY_OBSERVATION, ...overrides };
}

/** Feeds several readings and flattens the events they produced. */
function feed(machine, ...readings) {
  return readings.flatMap((reading) => machine.update(reading));
}

test("the debounces default to two consecutive observations", () => {
  assert.equal(DEFAULT_ENTRY_TICKS, 2, "one frame is a render artifact, not a turn");
  assert.equal(DEFAULT_EXIT_TICKS, 2, "one quiet frame is the gap between tool calls");
});

test("a settled run fires start exactly once", () => {
  const machine = new EventMachine();
  assert.deepEqual(feed(machine, obs({ running: true })), [], "a single running frame is not yet a turn");
  assert.deepEqual(feed(machine, obs({ running: true })), ["start"]);
  assert.deepEqual(
    feed(machine, obs({ running: true }), obs({ running: true }), obs({ running: true })),
    [],
    "re-rendering a running turn adds no event"
  );
  assert.equal(machine.current, "running");
  assert.equal(machine.state().startFired, true);
});

test("a quiet frame in the middle resets the entry debounce", () => {
  const machine = new EventMachine();
  assert.deepEqual(feed(machine, obs({ running: true }), obs({ running: true })), ["start"]);
  const restarted = new EventMachine();
  assert.deepEqual(
    feed(restarted, obs({ running: true }), obs(), obs({ running: true }), obs({ running: true })),
    ["start"],
    "the two running frames that fire start must be consecutive"
  );
  assert.equal(restarted.state().phase, "running");
});

test("done fires once after the exit debounce", () => {
  const machine = new EventMachine();
  feed(machine, obs({ running: true }), obs({ running: true }));
  assert.deepEqual(feed(machine, obs()), [], "one quiet frame is not yet the end of the turn");
  assert.deepEqual(feed(machine, obs()), ["done"]);
  assert.deepEqual(feed(machine, obs(), obs()), [], "done cannot fire twice");
  assert.equal(machine.current, "done");
});

test("a settled run after a finished turn begins a new turn", () => {
  // The regression this guards: the machine's only reset used to be a changed
  // taskKey, and the signal layer can never produce one — ZCode exposes no
  // stable task id. A machine that kept its latches sounded once per renderer
  // session and then went silent for every later turn, which is the whole
  // feature failing quietly rather than loudly.
  const machine = new EventMachine();
  assert.deepEqual(feed(machine, obs({ running: true }), obs({ running: true })), ["start"]);
  assert.deepEqual(feed(machine, obs(), obs()), ["done"]);
  assert.deepEqual(
    feed(machine, obs({ running: true }), obs({ running: true })),
    ["start"],
    "turn two must sound"
  );
  assert.deepEqual(feed(machine, obs(), obs()), ["done"], "and its completion must sound too");
  assert.deepEqual(
    feed(machine, obs({ running: true }), obs({ running: true }), obs(), obs()),
    ["start", "done"],
    "and so must turn three"
  );
});

test("a named task that differs is a hard boundary", () => {
  // The boundary needs two *known* identities to compare. A first sighting of a
  // key is not a change — the machine will not guess that a newly-named task is
  // a different one, because that would fire a start sound on every renderer
  // where the app began exposing an id it had not shown before.
  const machine = new EventMachine();
  feed(machine, obs({ running: true, taskKey: "a" }), obs({ running: true, taskKey: "a" }));
  feed(machine, obs(), obs());
  assert.deepEqual(
    feed(machine, obs({ running: true, taskKey: "b" }), obs({ running: true, taskKey: "b" })),
    ["start"],
    "a different task identity resets the turn"
  );
});

test("an error still on screen is not a new turn", () => {
  // The error ends the turn only once it has cleared. Re-firing `start` while
  // the failure is still displayed would replay the start sound underneath it.
  const machine = new EventMachine();
  feed(machine, obs({ running: true }), obs({ running: true }));
  assert.deepEqual(feed(machine, obs({ running: true, error: true })), ["error"]);
  assert.deepEqual(
    feed(machine, obs({ running: true, error: true }), obs({ running: true, error: true })),
    [],
    "a persisting error must not restart the turn"
  );
  assert.deepEqual(
    feed(machine, obs({ running: true }), obs({ running: true })),
    ["start"],
    "once the error clears, the next turn sounds normally"
  );
});

test("error fires once and suppresses done for the same turn", () => {
  const machine = new EventMachine();
  feed(machine, obs({ running: true }), obs({ running: true }));
  assert.deepEqual(feed(machine, obs({ running: true, error: true })), ["error"]);
  assert.deepEqual(feed(machine, obs({ running: true, error: true })), [], "an error sounds once per turn");
  assert.deepEqual(
    feed(machine, obs(), obs(), obs({ error: true })),
    [],
    "a turn that errored must not also play the completion sound"
  );
  assert.equal(machine.state().doneFired, true, "done is suppressed by latching it, not by a separate flag");
});

test("approval is edge-triggered and re-arms when the ask goes away", () => {
  const machine = new EventMachine();
  feed(machine, obs({ running: true }), obs({ running: true }));
  assert.deepEqual(feed(machine, obs({ running: true, approval: true })), ["approval"]);
  assert.deepEqual(feed(machine, obs({ running: true, approval: true })), [], "an open approval UI does not repeat the sound");
  assert.deepEqual(feed(machine, obs({ running: true })), [], "the ask going away is not itself an event");
  assert.deepEqual(feed(machine, obs({ running: true, approval: true })), ["approval"], "a second ask in the same turn is heard");
});

test("a tool event fires on an increase, not on a decrease", () => {
  const machine = new EventMachine();
  assert.deepEqual(feed(machine, obs({ toolCalls: 3 })), [], "tool calls seen while idle are not an event");
  feed(machine, obs({ running: true }), obs({ running: true }));
  assert.deepEqual(feed(machine, obs({ running: true, toolCalls: 6 })), ["tool"], "a burst of three new calls is one sound");
  assert.deepEqual(feed(machine, obs({ running: true, toolCalls: 2 })), [], "a decrease means the transcript was swapped");
  assert.deepEqual(feed(machine, obs({ running: true, toolCalls: 4 })), ["tool"], "after the baseline reset, growth is heard again");
});

test("a switched-off event is silent without changing the lifecycle", () => {
  const noStart = new EventMachine({ enabled: { start: false } });
  assert.deepEqual(feed(noStart, obs({ running: true }), obs({ running: true })), [], "the start sound is switched off");
  assert.equal(noStart.current, "running", "the phase must still advance");
  assert.deepEqual(feed(noStart, obs(), obs()), ["done"], "the other events are unaffected by one switch");

  const noTool = new EventMachine({ enabled: { tool: false } });
  feed(noTool, obs({ running: true }), obs({ running: true }));
  assert.deepEqual(feed(noTool, obs({ running: true, toolCalls: 1 })), []);

  const noDone = new EventMachine({ enabled: { done: false } });
  feed(noDone, obs({ running: true }), obs({ running: true }));
  assert.deepEqual(feed(noDone, obs(), obs()), []);
  assert.equal(noDone.current, "done", "the switch mutes the sound, not the lifecycle");
});

test("a changed taskKey resets the latches", () => {
  const machine = new EventMachine();
  assert.deepEqual(feed(machine, obs({ running: true, taskKey: "a" })), []);
  assert.deepEqual(feed(machine, obs({ running: true, taskKey: "a" })), ["start"]);
  assert.deepEqual(feed(machine, obs({ running: true, taskKey: "b" })), [], "a new task needs its own entry debounce");
  assert.deepEqual(feed(machine, obs({ running: true, taskKey: "b" })), ["start"], "the new turn gets its own start sound");
});

test("learning a task id is not a new turn", () => {
  const machine = new EventMachine();
  feed(machine, obs({ running: true }), obs({ running: true }));
  assert.deepEqual(feed(machine, obs({ running: true, taskKey: "a" })), [], "an absent key means unknown, never different");
});

test("a taskKey change after done can start a new turn", () => {
  const machine = new EventMachine();
  feed(machine, obs({ running: true, taskKey: "a" }), obs({ running: true, taskKey: "a" }));
  feed(machine, obs({ taskKey: "a" }), obs({ taskKey: "a" }));
  assert.deepEqual(
    feed(machine, obs({ running: true, taskKey: "b" }), obs({ running: true, taskKey: "b" })),
    ["start"],
    "a named new task is the one signal that resets the once-per-turn latches"
  );
});

test("the entry and exit debounces are the injected tick counts", () => {
  const quick = new EventMachine({ entryTicks: 1, exitTicks: 3 });
  assert.deepEqual(feed(quick, obs({ running: true })), ["start"], "one tick is enough when the caller says so");
  assert.deepEqual(feed(quick, obs(), obs()), [], "three quiet ticks are required");
  assert.deepEqual(feed(quick, obs()), ["done"]);
});

test("reset returns the machine to a clean session", () => {
  const machine = new EventMachine();
  feed(machine, obs({ running: true }), obs({ running: true }));
  feed(machine, obs(), obs());
  machine.reset();
  assert.equal(machine.current, "idle");
  assert.deepEqual(feed(machine, obs({ running: true }), obs({ running: true }), obs(), obs()), ["start", "done"]);
});
