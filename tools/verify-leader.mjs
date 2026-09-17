#!/usr/bin/env node
/**
 * verify-leader.mjs - simulated multi-renderer verification of the leader lease.
 *
 * WHAT THIS VERIFIES
 *   src/client/core/leader.ts is the specification: when more than one ZCode
 *   renderer of the same origin is alive, exactly one of them owns background
 *   playback, through a lease in localStorage announced over a BroadcastChannel.
 *   tests/leader.test.mjs drives the pure LeaderCore; the controller that binds
 *   it to localStorage, BroadcastChannel and timers was only exercised in a real
 *   client. This harness drives two complete LeaderController instances at once
 *   against one fake machine, so the integration behaviour is exercised:
 *     - election: one leader, one follower, lease named and unexpired
 *     - only the leader applies a forwarded command (observed on the leader's
 *       own state, not on the sender)
 *     - a killed renderer stops renewing; its stale lease expires; the survivor
 *       takes over on its own within one lease term
 *     - a leader stepping down frees the lease so the survivor promotes without
 *       waiting out the leftover term
 *     - at no sampled instant do two live clients report isLeader() === true,
 *       and no two leader intervals from the transition log overlap - the
 *       overlap check is independent of sampling resolution
 *
 * THIS IS A SIMULATION, NOT A LIVE OBSERVATION
 *   Two controller instances in one Node process are not two Electron
 *   renderers. Node has a single global `window`, so the harness installs one
 *   `window` whose `localStorage` is a facade over one shared Map - the same
 *   view two renderers of one origin have - and each simulated client gets its
 *   own id, timer, channel and playback callback. The channel is a real
 *   BroadcastChannel (verified below to deliver between channel objects in this
 *   process and, like the browser, never to the sender); a minimal in-process
 *   bus is available as a fallback and as a selectable mode. Nothing here
 *   proves delivery across a real Chromium process boundary: this is a
 *   simulated multi-renderer check and must be described as such, never as a
 *   live two-window ZCode observation.
 *
 * CLOCK CHOICE
 *   Real timers with a short lease. The controller binds Date.now() internally
 *   (createCore) and its lease arithmetic is wall-clock, so a virtual clock
 *   would mean stubbing Date.now plus every timer, and the harness would then
 *   verify the stub more than the client. leaseMs=900 / heartbeatMs=100 are
 *   passed through the documented constructor options instead of waiting out
 *   the 12s/4s defaults, keeping the 3:1 heartbeat-to-lease relationship the
 *   shipped values have while a whole run stays a few seconds. The claim jitter
 *   is a module constant, not an option, so every timing bound below is sized
 *   around it and read from the built module rather than copied.
 *
 * LIMITS THE HARNESS DOES NOT HIDE
 *   - Node clamps millisecond timers to roughly 16 ms on Windows, so the
 *     sampler is driven by setImmediate (dense, no timer starvation) rather than
 *     a 1 ms interval; the observed sample count and the largest gap between two
 *     samples are printed. The transition log closes what sampling could leave:
 *     two leader intervals that overlap in the log are an overlap by themselves,
 *     whatever the sample rate.
 *   - A renderer whose event loop stalls for longer than leaseMs would still
 *     report isLeader() === true until its next tick (the controller's role is
 *     a cached flag; the lease is the truth). That window is bounded by the
 *     tick cadence and is not exercised here: a killed renderer is removed from
 *     the live set, because a dead process cannot report at all, and the stale
 *     flag of a dead process is reported but never counted as a second leader.
 *
 * Exit codes: 0 every check passed, 1 any check failed or could not be tested.
 *
 * ZCT_LEADER_BUILD points the harness at another compiled leader.js. It exists
 * only so the checks can be shown to fail against a deliberately mutated build
 * kept outside this repository; the repository build is the default and the
 * module under test is printed in the output.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const BUILD = process.env.ZCT_LEADER_BUILD
  ? path.resolve(process.env.ZCT_LEADER_BUILD)
  : path.join(REPO, '.test-build', 'client', 'core', 'leader.js');

// Short, but keeping the shipped relationship (the lease outlives several
// heartbeats) so a stall that would break the ratio is not masked.
const LEASE_MS = 900;
const HEARTBEAT_MS = 100;
// Absorbs one scheduling hiccup on a loaded machine. It does not hide the
// failures these checks exist for: a lease that is never released or never
// expires misses the bound by a far wider margin or never promotes at all.
const SLACK_MS = 400;
const TAKEOVER_WAIT_MS = 6000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- reporting --

const checks = [];
function printCheck(c) {
  const tag = c.tested === false ? '[NOT TESTED]' : c.pass ? '[PASS]' : '[FAIL]';
  console.log(tag.padEnd(13) + c.id.padEnd(40) + ' expected=' + JSON.stringify(c.expected) + ' observed=' + JSON.stringify(c.observed));
}
function decide(id, expected, observed, ok, tested = true) {
  const c = { id, expected, observed, pass: ok === true && tested, tested };
  checks.push(c);
  printCheck(c);
  return c;
}
function notTested(id, expected, reason) {
  return decide(id, expected, { notTested: reason }, false, false);
}
function phase(title) {
  console.log('--- ' + title);
}

// ------------------------------------------------------------ fake machine ---

const machine = {
  store: new Map(), // one origin: both simulated clients see this Map
  clients: [],
  spans: [], // closed leader intervals in the order they closed; the overlap check sorts them
  seq: 0,
  // A total order over every role change: wall-clock milliseconds cannot order
  // two events in the same millisecond, and the overlap check needs that order.
  nextSeq() {
    const seq = machine.seq;
    machine.seq += 1;
    return seq;
  },
};

let LEADER_KEY = '';
let CLAIM_JITTER_MS = 0;
// Filled from the compiled module inside run(); module scope so the client
// factory below can construct controllers.
let leader = null;

/** Shape rule of parseLease, without its non-empty-id rule (release writes ""). */
function leaseShapeProblem(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return 'not a non-empty string';
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'not JSON';
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'not an object';
  if (typeof parsed.id !== 'string') return 'id is not a string';
  if (typeof parsed.expiresAt !== 'number' || !Number.isFinite(parsed.expiresAt)) return 'expiresAt is not a finite number';
  return null;
}

const storageWrites = { count: 0, malformed: [] };
function installWindow(store) {
  const localStorage = {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      const text = String(value);
      if (key === LEADER_KEY) {
        storageWrites.count += 1;
        const problem = leaseShapeProblem(text);
        if (problem && storageWrites.malformed.length < 5) storageWrites.malformed.push({ text, problem });
      }
      store.set(key, text);
    },
    removeItem(key) {
      store.delete(key);
    },
  };
  globalThis.window = { localStorage };
}

function readRaw() {
  return globalThis.window.localStorage.getItem(LEADER_KEY);
}
function readLease() {
  const raw = readRaw();
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------- channel selection ---

class InProcessBus {
  static registry = new Map();
  constructor(name) {
    this.name = name;
    this.onmessage = null;
    this.closed = false;
    const set = InProcessBus.registry.get(name) ?? new Set();
    set.add(this);
    InProcessBus.registry.set(name, set);
  }
  postMessage(data) {
    if (this.closed) throw new Error('InvalidStateError: the channel is closed');
    const peers = [...(InProcessBus.registry.get(this.name) ?? [])].filter((c) => c !== this && !c.closed);
    // Asynchronous and never to the sender, like the real channel: a sender
    // must not observe its own message in the same turn.
    setTimeout(() => {
      for (const peer of peers) {
        if (peer.closed || typeof peer.onmessage !== 'function') continue;
        peer.onmessage({ data });
      }
    }, 0);
  }
  close() {
    this.closed = true;
    InProcessBus.registry.get(this.name)?.delete(this);
  }
}

async function probeChannel(Ctor) {
  const name = 'zct-leader-harness-probe-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
  let peerData = null;
  let selfData = null;
  const a = new Ctor(name);
  const b = new Ctor(name);
  a.onmessage = (ev) => {
    selfData = ev.data;
  };
  b.onmessage = (ev) => {
    peerData = ev.data;
  };
  a.postMessage({ probe: 1 });
  const deadline = Date.now() + 500;
  while (peerData === null && Date.now() < deadline) await sleep(5);
  try {
    a.close();
    b.close();
  } catch {
    /* already closed */
  }
  return { deliveredToPeer: peerData !== null, deliveredToSender: selfData !== null };
}

async function selectChannel() {
  if (process.env.ZCT_LEADER_CHANNEL === 'bus') {
    globalThis.BroadcastChannel = InProcessBus;
    const probe = await probeChannel(InProcessBus);
    return { name: 'in-process-bus (forced by ZCT_LEADER_CHANNEL=bus)', probe };
  }
  if (typeof globalThis.BroadcastChannel !== 'function') {
    return { name: 'none (no global BroadcastChannel)', probe: null };
  }
  const probe = await probeChannel(globalThis.BroadcastChannel);
  if (probe.deliveredToPeer && !probe.deliveredToSender) return { name: 'global BroadcastChannel', probe };
  globalThis.BroadcastChannel = InProcessBus;
  const busProbe = await probeChannel(InProcessBus);
  return {
    name: 'in-process-bus (real BroadcastChannel did not deliver correctly: peer=' + probe.deliveredToPeer + ' sender=' + probe.deliveredToSender + ')',
    probe: busProbe,
  };
}

// ----------------------------------------------------------------- sampling ---

const sampler = {
  running: false,
  samples: 0,
  leaderSamples: 0,
  maxLiveLeaders: 0,
  samplesWithTwo: 0,
  leaseViolations: [],
  violationCount: 0,
  violationsByKind: {},
  shapeViolations: 0,
  leaseChecks: 0,
  lastAt: 0,
  maxGapMs: 0,
};
// A broken build can violate the invariant on millions of samples; the report
// keeps a few witnesses and a count instead of every occurrence.
const VIOLATION_WITNESSES = 5;
function recordViolation(entry) {
  sampler.violationCount += 1;
  sampler.violationsByKind[entry.kind] = (sampler.violationsByKind[entry.kind] ?? 0) + 1;
  if (sampler.leaseViolations.length < VIOLATION_WITNESSES) sampler.leaseViolations.push(entry);
}
// The leader count is sampled on every iteration; the lease shape and the
// leader/lease agreement cannot be, at roughly one sample per microsecond. The
// sampler runs often enough that a lease write is caught within a fraction of a
// millisecond, and the storage facade validates every write as it happens, so a
// malformed value cannot hide between two samples.
const LEASE_CHECK_EVERY = 256;
function sampleOnce() {
  const now = Date.now();
  sampler.samples += 1;
  if (sampler.lastAt !== 0) {
    const gap = now - sampler.lastAt;
    if (gap > sampler.maxGapMs) sampler.maxGapMs = gap;
  }
  sampler.lastAt = now;
  let liveLeaders = 0;
  for (const client of machine.clients) {
    if (client.dead || !client.ctrl) continue;
    if (client.ctrl.isLeader()) liveLeaders += 1;
  }
  if (liveLeaders > sampler.maxLiveLeaders) sampler.maxLiveLeaders = liveLeaders;
  if (liveLeaders > 1) {
    sampler.samplesWithTwo += 1;
    recordViolation({
      kind: 'two-live-leaders',
      at: now,
      leaders: machine.clients.filter((c) => !c.dead && c.ctrl && c.ctrl.isLeader()).map((c) => c.label),
    });
  }
  if (liveLeaders > 0) sampler.leaderSamples += 1;
  if (sampler.samples % LEASE_CHECK_EVERY !== 0) {
    if (sampler.running) setImmediate(sampleOnce);
    return;
  }
  sampler.leaseChecks += 1;
  const raw = readRaw();
  const problem = raw === null ? null : leaseShapeProblem(raw);
  if (problem) {
    sampler.shapeViolations += 1;
    recordViolation({ kind: 'malformed-lease', at: now, raw, problem });
  } else if (liveLeaders === 1) {
    const lease = raw === null ? undefined : JSON.parse(raw);
    const leader = machine.clients.find((c) => !c.dead && c.ctrl && c.ctrl.isLeader());
    // The lease is the truth: whoever reports leading must be named by an
    // unexpired lease, and a released or absent lease may not back a leader.
    if (!lease || lease.id !== leader.id || !(lease.expiresAt > now)) {
      recordViolation({ kind: 'leader-without-lease', at: now, leader: leader.label, lease: lease ?? null, raw });
    }
  }
  if (sampler.running) setImmediate(sampleOnce);
}

// ---------------------------------------------------------------- clients ----

function closeSpan(client, seq) {
  if (client.leaderFromSeq === null) return;
  machine.spans.push({ label: client.label, from: client.leaderFromSeq, to: seq });
  client.leaderFromSeq = null;
}

function createClient(label, id) {
  const client = {
    label,
    id,
    ctrl: null,
    dead: false,
    roleEvents: [],
    playback: 'stopped', // the model of "only the leader plays"
    trackId: null,
    applied: [],
    sent: [],
    received: 0,
    leaderFromSeq: null,
    leaderSince: 0,
  };
  const ctrl = new leader.LeaderController(
    {
      leaseMs: LEASE_MS,
      heartbeatMs: HEARTBEAT_MS,
      onRole(role) {
        const seq = machine.nextSeq();
        client.roleEvents.push(role);
        if (role === 'leader') {
          client.leaderFromSeq = seq;
          client.leaderSince = Date.now();
          client.playback = 'playing';
        } else {
          closeSpan(client, seq);
          client.playback = 'stopped';
        }
      },
    },
    id
  );
  ctrl.onMessage((message) => {
    if (!message || typeof message !== 'object') return;
    client.received += 1;
    const msg = message;
    if (msg.type !== 'bgm-command') return;
    // Mirrors src/client/bgm/player.ts: a command is applied only by the
    // renderer that currently holds the lease; a follower drops it.
    if (!ctrl.isLeader()) return;
    client.applied.push({ command: msg.command, value: msg.value });
    if (msg.command === 'play') {
      client.trackId = msg.value;
      client.playback = 'playing';
    }
    if (msg.command === 'pause') client.playback = 'stopped';
  });
  client.ctrl = ctrl;
  machine.clients.push(client);
  return client;
}

function issueCommand(client, command, value) {
  client.sent.push({ command, value });
  client.ctrl.broadcast({ type: 'bgm-command', command, value });
}

function controllerHandles(client) {
  const ctrl = client.ctrl;
  const timer = ctrl ? ctrl.timer : undefined;
  const channel = ctrl ? ctrl.channel : undefined;
  return {
    timerReadable: timer !== undefined && timer !== null,
    channelReadable: channel !== undefined && channel !== null,
    timer: timer === null ? null : typeof timer,
  };
}

/**
 * Simulates a renderer that dies without releasing: its heartbeat stops, it
 * stops hearing the channel, and it never runs another callback. This reads the
 * handles the controller registered instead of stopping it through its own API,
 * because stop() would release the lease and the point here is the stale lease.
 */
function killClient(client, reason) {
  const ctrl = client.ctrl;
  const timer = ctrl.timer;
  if (timer === undefined || timer === null) return 'ctrl.timer is not readable after start() (' + reason + ')';
  clearInterval(timer);
  ctrl.timer = null;
  try {
    if (ctrl.channel) ctrl.channel.close();
  } catch {
    /* already closed */
  }
  ctrl.channel = null;
  client.dead = true;
  closeSpan(client, machine.nextSeq());
  return null;
}

function stopAll() {
  for (const client of machine.clients) {
    if (client.dead || !client.ctrl) continue;
    try {
      client.ctrl.stop();
    } catch {
      /* a stop must not mask the check result */
    }
  }
}

function liveLeaders() {
  return machine.clients.filter((c) => !c.dead && c.ctrl && c.ctrl.isLeader());
}

async function waitFor(predicate, timeoutMs, stepMs = 5) {
  const started = Date.now();
  for (;;) {
    if (predicate()) return { ok: true, elapsedMs: Date.now() - started, at: Date.now() };
    if (Date.now() - started >= timeoutMs) return { ok: false, elapsedMs: Date.now() - started, at: Date.now() };
    await sleep(stepMs);
  }
}

function spansAreDisjoint(spans) {
  const sorted = [...spans].sort((a, b) => a.from - b.from || a.to - b.to);
  let maxEnd = -1;
  let maxSpan = null;
  for (const span of sorted) {
    if (span.from < maxEnd) return { ok: false, previous: maxSpan, next: span };
    if (span.to > maxEnd) {
      maxEnd = span.to;
      maxSpan = span;
    }
  }
  return { ok: true, spans: sorted.length };
}

// ------------------------------------------------------------------- run -----

// Every check this harness can decide, so a blocked precondition can mark the
// rest NOT TESTED with one reason instead of silently shortening the report.
const ALL_CHECKS = [
  ['channel-delivers-in-process', 'peer receives the message, sender does not'],
  ['crash-simulation-instrumentation', 'ctrl.timer and ctrl.channel readable after start()'],
  ['a-leads-b-follows', 'A is the leader, B is the follower, the lease names A and is unexpired'],
  ['follower-command-applied-by-leader', "the leader's own state shows the follower's command"],
  ['leader-broadcast-dropped-by-follower', 'the follower hears the channel and still applies nothing'],
  ['stale-lease-does-not-lock-room', 'the survivor promotes after the stale lease expires, within one lease term'],
  ['takeover-respects-lease-expiry', 'the survivor does not promote before the stale lease expires'],
  ['killed-renderer-stays-dead', 'no renewal and no role change after the crash'],
  ['follower-playback-callbacks', "B's playback callback fires leader then follower"],
  ['stepdown-promotes-promptly', 'a released lease promotes the survivor without waiting out the leftover term'],
  ['simultaneous-claims-one-winner', 'two clients claiming in the same turn produce exactly one leader'],
  ['at-most-one-live-leader-per-sample', 'never two live leaders at a sampled instant'],
  ['leader-spans-disjoint', 'no two clients lead at overlapping moments'],
  ['lease-well-formed-and-truthful', 'lease shape and leader truthfulness'],
];

function notTestedRemaining(reason) {
  const seen = new Set(checks.map((c) => c.id));
  for (const [id, expected] of ALL_CHECKS) {
    if (!seen.has(id)) notTested(id, expected, reason);
  }
}

async function run() {
  if (!fs.existsSync(BUILD)) {
    notTestedRemaining('the compiled controller is missing (' + path.relative(REPO, BUILD) + '); run npx tsc -p tsconfig.test.json');
    return;
  }
  const channelMode = await selectChannel();
  const channelOk = channelMode.probe && channelMode.probe.deliveredToPeer && !channelMode.probe.deliveredToSender;
  decide(
    'channel-delivers-in-process',
    'peer receives the message, sender does not',
    { mode: channelMode.name, probe: channelMode.probe },
    channelOk
  );
  if (!channelOk) {
    notTestedRemaining('no working channel: ' + channelMode.name);
    return;
  }

  leader = await import(pathToFileURL(BUILD).href);
  LEADER_KEY = leader.LEADER_KEY;
  CLAIM_JITTER_MS = leader.CLAIM_JITTER_MS;
  installWindow(machine.store);
  sampler.running = true;
  sampleOnce();

  console.log('simulated multi-renderer verification: two LeaderController instances in one Node process,');
  console.log('module under test: ' + path.relative(REPO, BUILD).replace(/\\/g, '/'));
  console.log('one shared localStorage facade, channel=' + channelMode.name + ', leaseMs=' + LEASE_MS + ' heartbeatMs=' + HEARTBEAT_MS);
  console.log('this is NOT a live two-window ZCode observation.');

  // --- phase: election -----------------------------------------------------
  phase('election (A starts first, then B)');
  const A = createClient('A', 'renderer-a');
  A.ctrl.start();
  const handles = controllerHandles(A);
  decide(
    'crash-simulation-instrumentation',
    'ctrl.timer and ctrl.channel readable after start()',
    handles,
    handles.timerReadable && handles.channelReadable
  );
  const instrumentable = handles.timerReadable && handles.channelReadable;
  const aLead = await waitFor(() => A.ctrl.isLeader(), 2000);
  const B = createClient('B', 'renderer-b');
  B.ctrl.start();
  await sleep(4 * HEARTBEAT_MS);
  const electLease = readLease();
  decide(
    'a-leads-b-follows',
    'A is the leader, B is the follower, the lease names A and is unexpired',
    {
      aLeads: A.ctrl.isLeader(),
      bLeads: B.ctrl.isLeader(),
      aBecameLeaderMs: aLead.ok ? aLead.elapsedMs : null,
      lease: electLease ?? null,
      bRoleEvents: B.roleEvents,
      storageKeys: [...machine.store.keys()],
      note: 'B never leading while A holds the lease is enforced for the whole run by leader-spans-disjoint and at-most-one-live-leader-per-sample',
    },
    aLead.ok && A.ctrl.isLeader() && !B.ctrl.isLeader() && electLease && electLease.id === A.id && electLease.expiresAt > Date.now()
  );

  // --- phase: forwarding ---------------------------------------------------
  phase('follower command forwarding');
  issueCommand(B, 'play', 'tarkov-theme');
  const forwarded = await waitFor(() => A.applied.some((x) => x.command === 'play' && x.value === 'tarkov-theme'), 1500);
  decide(
    'follower-command-applied-by-leader',
    "the leader's own state shows the follower's command; the follower applied nothing",
    {
      leaderApplied: A.applied,
      leaderTrackId: A.trackId,
      leaderIsLeader: A.ctrl.isLeader(),
      followerApplied: B.applied,
      followerTrackId: B.trackId,
      followerSent: B.sent,
      leaderReceivedCount: A.received,
    },
    forwarded.ok && A.trackId === 'tarkov-theme' && A.ctrl.isLeader() && A.received >= 1 && B.applied.length === 0 && B.trackId === null
  );

  A.ctrl.broadcast({ type: 'bgm-command', command: 'shuffle', value: true });
  const heardByFollower = await waitFor(() => B.received >= 1, 1500);
  decide(
    'leader-broadcast-dropped-by-follower',
    'the follower hears the channel and still applies nothing',
    { followerReceived: B.received, followerApplied: B.applied, heardByFollowerMs: heardByFollower.ok ? heardByFollower.elapsedMs : null },
    heardByFollower.ok && B.received >= 1 && B.applied.length === 0
  );

  if (!instrumentable) {
    notTestedRemaining('ctrl.timer/ctrl.channel are not readable after start(): cannot simulate a crash');
    return;
  }

  // --- phase: the leader dies ---------------------------------------------
  phase('leader crash (timers stopped, channel closed, lease left behind)');
  await waitFor(() => Date.now() - A.leaderSince >= 3 * HEARTBEAT_MS, 3 * HEARTBEAT_MS + 300);
  const stale = readLease();
  const killAt = Date.now();
  const killProblem = killClient(A, 'simulated crash');
  let promoteAt = 0;
  let renewalsAfterKill = 0;
  const deadline = killAt + TAKEOVER_WAIT_MS;
  while (killProblem === null && Date.now() < deadline) {
    const lease = readLease();
    if (stale && lease && lease.id === A.id && lease.expiresAt > stale.expiresAt) renewalsAfterKill += 1;
    if (B.ctrl.isLeader()) {
      promoteAt = Date.now();
      break;
    }
    await sleep(10);
  }
  const takeoverMs = promoteAt === 0 ? null : promoteAt - killAt;
  const takeoverBoundMs = LEASE_MS + HEARTBEAT_MS + CLAIM_JITTER_MS + SLACK_MS;
  const staleWasLive = stale !== undefined && stale.id === A.id && stale.expiresAt > killAt;
  const leaseAtTakeover = readLease();
  decide(
    'stale-lease-does-not-lock-room',
    'B promotes on its own within ' + takeoverBoundMs + ' ms of the crash',
    {
      takeoverMs,
      boundMs: takeoverBoundMs,
      staleLeaseAtKill: stale ?? null,
      leaseAtTakeover: leaseAtTakeover ?? null,
      bIsLeader: B.ctrl.isLeader(),
    },
    killProblem === null &&
      staleWasLive &&
      takeoverMs !== null &&
      takeoverMs <= takeoverBoundMs &&
      B.ctrl.isLeader()
  );
  decide(
    'takeover-respects-lease-expiry',
    'promotion happens only after the stale lease expires (no shortcut around the lease)',
    {
      killAt,
      staleExpiresAt: stale ? stale.expiresAt : null,
      promoteAt: promoteAt || null,
      waitedPastExpiryMs: stale && promoteAt !== 0 ? promoteAt - stale.expiresAt : null,
    },
    killProblem === null && staleWasLive && promoteAt !== 0 && promoteAt >= stale.expiresAt
  );
  decide(
    'killed-renderer-stays-dead',
    'no lease renewal and no role event from the killed renderer',
    {
      renewalsAfterKill,
      roleEventsAfterKill: A.roleEvents.slice(1),
      staleRoleFlagAfterKill: A.ctrl.isLeader(),
      note: 'staleRoleFlagAfterKill is expected true: the flag is cached and nothing runs to clear it in a dead process; the lease and the interval are what stop',
    },
    killProblem === null && renewalsAfterKill === 0 && A.roleEvents.length === 1 && A.roleEvents[0] === 'leader'
  );

  // --- phase: step-down release -------------------------------------------
  phase('leader step-down (B releases; a new window A2 must promote promptly)');
  const A2 = createClient('A2', 'renderer-a2');
  A2.ctrl.start();
  await sleep(2 * HEARTBEAT_MS);
  const beforeStepdown = readLease();
  const renewed = await waitFor(() => {
    const lease = readLease();
    return lease !== undefined && lease.id === B.id && lease.expiresAt > beforeStepdown.expiresAt;
  }, 3 * HEARTBEAT_MS + 300);
  const atStepdown = readLease();
  const stepdownAt = Date.now();
  const remainingLeaseMs = atStepdown ? atStepdown.expiresAt - stepdownAt : 0;
  B.ctrl.stop();
  const a2Lead = await waitFor(() => A2.ctrl.isLeader(), 3000);
  const promoteDelayMs = a2Lead.ok ? a2Lead.at - stepdownAt : null;
  const stepdownBoundMs = HEARTBEAT_MS + CLAIM_JITTER_MS + SLACK_MS;
  const leaseAfterStepdown = readLease();
  decide(
    'stepdown-promotes-promptly',
    'promotion in <= ' + stepdownBoundMs + ' ms and before the leftover term of ' + remainingLeaseMs + ' ms would have elapsed',
    {
      promoteDelayMs,
      boundMs: stepdownBoundMs,
      remainingLeaseMsAtStepdown: remainingLeaseMs,
      bRoleEvents: B.roleEvents,
      bPlayback: B.playback,
      leaseAfterStepdown: leaseAfterStepdown ?? null,
      a2IsLeader: A2.ctrl.isLeader(),
    },
    renewed.ok &&
      a2Lead.ok &&
      remainingLeaseMs > 0 &&
      promoteDelayMs <= stepdownBoundMs &&
      promoteDelayMs < remainingLeaseMs &&
      leaseAfterStepdown !== undefined &&
      leaseAfterStepdown.id === A2.id &&
      leaseAfterStepdown.expiresAt > Date.now()
  );
  decide(
    'follower-playback-callbacks',
    "B played only while it led and stopped on stepping down ('leader' then 'follower')",
    { bRoleEvents: B.roleEvents, bPlayback: B.playback },
    B.roleEvents.includes('leader') && B.roleEvents.includes('follower') && B.playback === 'stopped'
  );

  // --- phase: simultaneous claims -----------------------------------------
  phase('two clients claim in the same turn');
  A2.ctrl.stop();
  await sleep(30);
  const C = createClient('C', 'renderer-c');
  const D = createClient('D', 'renderer-d');
  C.ctrl.start();
  D.ctrl.start(); // same synchronous turn: both see the released lease
  await sleep(1500);
  const winners = liveLeaders().map((c) => c.label);
  decide(
    'simultaneous-claims-one-winner',
    'exactly one of C/D leads after the jitter window',
    { cLeads: C.ctrl.isLeader(), dLeads: D.ctrl.isLeader(), liveLeaders: winners, cRoleEvents: C.roleEvents, dRoleEvents: D.roleEvents },
    winners.length === 1 && (C.ctrl.isLeader() !== D.ctrl.isLeader())
  );
}

let exitCode = 1;
try {
  await run();
} catch (err) {
  notTested('harness-completed', 'the harness runs to the summary', 'unhandled error: ' + String(err));
  console.log(String((err && err.stack) || err));
  notTestedRemaining('the harness aborted before this check ran: ' + String(err));
} finally {
  stopAll();
  sampler.running = false;
}

// Spans that never closed mean a client was still leading at the end of the
// run; the disjointness check must see that as an open interval, not as no
// interval at all.
for (const client of machine.clients) {
  if (client.leaderFromSeq !== null) {
    machine.spans.push({ label: client.label, from: client.leaderFromSeq, to: Number.POSITIVE_INFINITY });
    client.leaderFromSeq = null;
  }
}
const disjoint = spansAreDisjoint(machine.spans);
// The abort path may already have marked these NOT TESTED; never decide twice.
const notDecided = (id) => !checks.some((c) => c.id === id);
if (notDecided('leader-spans-disjoint')) {
  if (machine.spans.length === 0) {
    notTested('leader-spans-disjoint', 'no two clients lead at overlapping moments', 'no leader interval was ever recorded');
  } else {
    decide(
      'leader-spans-disjoint',
      'no two clients report leading at overlapping moments of the run',
      {
        spanCount: machine.spans.length,
        spans: machine.spans.slice(0, 12),
        truncated: machine.spans.length > 12,
        violation: disjoint.ok ? null : { previous: disjoint.previous, next: disjoint.next },
      },
      disjoint.ok
    );
  }
}
if (notDecided('at-most-one-live-leader-per-sample') && sampler.samples === 0) {
  notTested('at-most-one-live-leader-per-sample', 'never two live leaders at a sampled instant', 'the sampler never ran');
}
if (notDecided('lease-well-formed-and-truthful') && sampler.samples === 0) {
  notTested('lease-well-formed-and-truthful', 'lease shape and leader truthfulness', 'the sampler never ran');
}
if (notDecided('at-most-one-live-leader-per-sample')) {
  decide(
    'at-most-one-live-leader-per-sample',
    'max live leaders in any sample <= 1, with the sampler having observed a leader',
    {
      samples: sampler.samples,
      driver: 'setImmediate (dense; Node clamps ms timers to ~16 ms on Windows)',
      maxGapBetweenSamplesMs: sampler.maxGapMs,
      maxLiveLeaders: sampler.maxLiveLeaders,
      samplesWithTwoLeaders: sampler.samplesWithTwo,
      samplesWithALeader: sampler.leaderSamples,
      leaseChecks: sampler.leaseChecks,
      malformedObservedSamples: sampler.shapeViolations,
      malformedWrites: storageWrites.malformed,
      storageWrites: storageWrites.count,
      violationsByKind: sampler.violationsByKind,
      violationTotal: sampler.violationCount,
      witnessSample: sampler.leaseViolations,
      note: 'a killed renderer is removed from the live set: a dead process cannot report',
    },
    sampler.samples >= 20000 &&
      sampler.maxLiveLeaders <= 1 &&
      sampler.samplesWithTwo === 0 &&
      (sampler.violationsByKind['two-live-leaders'] ?? 0) === 0 &&
      sampler.leaderSamples > 0
  );
}
if (notDecided('lease-well-formed-and-truthful')) {
  decide(
    'lease-well-formed-and-truthful',
    'every observed lease is {id: string, expiresAt: finite number}, and every leader is backed by its own unexpired lease',
    {
      samples: sampler.samples,
      leaseChecks: sampler.leaseChecks,
      shapeViolations: sampler.shapeViolations,
      violationsByKind: sampler.violationsByKind,
      violationTotal: sampler.violationCount,
      witnessSample: sampler.leaseViolations,
    },
    sampler.leaseChecks > 0 &&
      sampler.shapeViolations === 0 &&
      (sampler.violationsByKind['malformed-lease'] ?? 0) === 0 &&
      (sampler.violationsByKind['leader-without-lease'] ?? 0) === 0
  );
}

// ------------------------------------------------------------------ summary --
console.log('=== summary ===');
console.log('simulation: two LeaderController instances in one Node process, shared localStorage facade, real BroadcastChannel unless stated above.');
console.log('this is a SIMULATED multi-renderer verification, not a live two-window ZCode observation.');
console.log('samples: ' + sampler.samples + ' (setImmediate-driven, max gap ' + sampler.maxGapMs + ' ms, lease checks ' + sampler.leaseChecks + '); max live leaders in one sample: ' + sampler.maxLiveLeaders + '; samples with two live leaders: ' + sampler.samplesWithTwo);
console.log('leader intervals: ' + JSON.stringify(machine.spans.map((s) => s.label + '[' + s.from + ',' + (s.to === Number.POSITIVE_INFINITY ? 'end' : s.to) + ')')));
const passed = checks.filter((c) => c.tested && c.pass).length;
const failed = checks.filter((c) => c.tested && !c.pass).length;
const untested = checks.filter((c) => !c.tested).length;
console.log('checks: ' + checks.length + ', passed: ' + passed + ', failed: ' + failed + ', not tested: ' + untested);
exitCode = failed === 0 && untested === 0 && checks.length > 0 ? 0 : 1;
console.log('exit code: ' + exitCode);

process.exitCode = exitCode;
// Safety net only: unref'd, so it cannot delay a clean exit, and a leaked timer
// or channel cannot hang the harness.
setTimeout(() => process.exit(exitCode), 500).unref();
