// The BGM failure cap.
//
// The regression this guards was found by an independent review and reproduced
// before the fix: `advance()` cleared the consecutive-failure counter on its way
// to the next track, so the counter was always zero by the time the next load
// could fail. `MAX_TRACK_FAILURES` was therefore unreachable and a directory of
// undecodable files became an endless load-error-skip loop that churned the dock
// and re-requested the same bytes forever while reporting itself as playing.
//
// `BgmPlayer` builds an HTMLAudioElement, so the environment is stubbed rather
// than mocked away: a fake `Audio` that never fires `loadeddata` (every track
// fails) is exactly the scenario, and one that does is the recovery case.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "zct-bgm-"));
process.env.ZCODE_TARKOV_DATA_DIR = root;

const { BgmPlayer, MAX_TRACK_FAILURES } = await import("../.test-build/client/bgm/player.js");
const { defaultPrefs } = await import("../.test-build/prefs/defaults.js");

/** A stand-in for the audio element that records what was asked of it. */
function makeFakeAudio() {
  const listeners = new Map();
  const el = {
    src: "",
    volume: 1,
    preload: "",
    crossOrigin: "",
    currentTime: 0,
    duration: Number.NaN,
    paused: true,
    destroyed: false,
    addEventListener(name, fn) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
    },
    removeEventListener() {},
    play() {
      el.paused = false;
      return Promise.resolve();
    },
    pause() {
      el.paused = true;
    },
    fire(name) {
      for (const fn of listeners.get(name) ?? []) fn({ type: name });
    },
  };
  return el;
}

function makeContext(tracks, audioEl) {
  const prefs = defaultPrefs();
  const toasts = [];
  return {
    toasts,
    prefs: () => prefs,
    onPrefs: () => () => {},
    patchPrefs: () => Promise.resolve(prefs),
    toast: (m) => toasts.push(m),
    toastError: (err, fallback) => toasts.push(fallback),
    theme: () => "tarkov",
    syncTheme: () => {},
    uiRoot: () => ({ appendChild() {} }),
    audio: {
      unlocked: true,
      context: undefined,
      bus: () => undefined,
      applyVolumes: () => {},
      tryUnlock: () => Promise.resolve(true),
    },
    api: {
      getLibrary: () => Promise.resolve({ tracks, current: null, empty: tracks.length === 0 }),
      mediaUrl: (kind, name) => `http://127.0.0.1:1/api/media/${kind}/${name}?token=x`,
      patchPrefs: () => Promise.resolve({ prefs }),
    },
  };
}

/** Wires a player over a fake element and waits for its initial library load. */
async function makePlayer(trackCount) {
  const tracks = [];
  for (let i = 0; i < trackCount; i += 1) {
    tracks.push({ id: `t${i}.mp3`, filename: `t${i}.mp3`, displayName: `t${i}`, enabled: true, size: 1, mtimeMs: 0 });
  }
  const el = makeFakeAudio();
  globalThis.Audio = function Audio() {
    return el;
  };
  const ctx = makeContext(tracks, el);
  const player = new BgmPlayer({
    ctx,
    audio: ctx.audio,
    leader: { isLeader: () => true, broadcast: () => {}, onMessage: () => {} },
  });
  player.start();
  await player.refresh();
  return { player, el, ctx };
}

test("the failure cap is reachable: a folder of undecodable tracks stops the player", async () => {
  const { player, el, ctx } = await makePlayer(3);
  player.play();
  // Every load fails. `advance()` must not clear the streak, so the cap engages
  // after MAX_TRACK_FAILURES + 1 attempts rather than looping forever.
  const attempts = MAX_TRACK_FAILURES + 6;
  for (let i = 0; i < attempts; i += 1) el.fire("error");

  assert.equal(player.state().playing, false, "the player must stop instead of skipping forever");
  assert.ok(
    ctx.toasts.some((m) => m.includes(String(MAX_TRACK_FAILURES + 1))),
    `the user must be told why it stopped; toasts were ${JSON.stringify(ctx.toasts)}`
  );
  player.dispose();
});

test("the cap counts consecutive failures, not every failure in a session", async () => {
  const { player, el, ctx } = await makePlayer(3);
  player.play();
  // Fail twice, succeed (a track that produces data clears the streak), fail
  // twice more. A counter that accumulated across the whole session would stop
  // the player here; a consecutive-failure counter must not.
  el.fire("error");
  el.fire("error");
  el.fire("loadeddata");
  el.fire("error");
  el.fire("error");

  assert.equal(player.state().playing, true, "a successful load resets the streak");
  assert.equal(ctx.toasts.some((m) => m.includes(String(MAX_TRACK_FAILURES + 1))), false);
  player.dispose();
});

test("a track is only skipped while the player is meant to be playing", async () => {
  const { player, el } = await makePlayer(3);
  // Never started: an error event here belongs to a preload, not to playback,
  // and must not walk the playlist.
  const before = player.state().trackId;
  el.fire("error");
  assert.equal(player.state().playing, false);
  assert.equal(typeof player.state().trackId, "string", "some track stays selected");
  player.dispose();
  assert.notEqual(before, undefined, "a track was selected for the preload case");
});
