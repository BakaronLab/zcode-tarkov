/**
 * Background music: the library, the transport, and the single-leader rule.
 *
 * Playback goes through an `HTMLAudioElement` pointed at the host service's
 * stream URL, not through `decodeAudioData`. That decision is what makes seeking
 * work: the element issues `Range` requests against the endpoint, so a
 * five-minute track starts after a few hundred kilobytes and a drag on the
 * progress bar moves to that byte offset. Decoding first would download and
 * expand the whole file before making a sound — for a 200 MB lossless track,
 * that is several hundred megabytes of buffers before the user hears anything.
 *
 * Volume is routed through the shared `bgm` gain bus when the audio graph is
 * available, so the master slider affects music that is already playing. When
 * the graph is not available — the autoplay policy holding the context, or a
 * renderer without Web Audio — the element's own `volume` is used instead, which
 * cannot be master-scaled but does play. That fallback is deliberate: silence
 * because the graph is missing would be a worse failure than a master slider
 * that temporarily does not reach the music.
 *
 * Only the leader plays. A follower keeps a fully live dock — it shows the
 * track, the position and the library, and every control works — but its
 * commands are broadcast to the leader rather than acted on locally. Follower
 * commands are optimistic in the UI and authoritative in the leader: the
 * leader's state is broadcast back and the follower adopts it, so two renderers
 * cannot drift.
 */

import type { HostApi, TrackInfo } from "../core/api.js";
import type { AudioEngine } from "../core/audio.js";
import type { ClientContext } from "../core/context.js";
import type { BgmState, BgmTrack } from "../contracts.js";
import type { Prefs } from "../../prefs/types.js";

export interface BgmPlayerOptions {
  ctx: ClientContext;
  /** The audio engine, for the music bus and the lock state. */
  audio: AudioEngine;
  /** The leader election; music is played by exactly one renderer. */
  leader: {
    isLeader(): boolean;
    broadcast(message: unknown): void;
    onMessage(handler: (message: unknown) => void): void;
  };
}

/** A message a follower sends to the leader, or the leader broadcasts back. */
interface BgmMessage {
  type: "bgm-command" | "bgm-state";
  command?: string;
  value?: unknown;
  state?: BgmState;
}

export const MAX_TRACK_FAILURES = 3;

export class BgmPlayer {
  private el: HTMLAudioElement | undefined;
  private mediaSource: MediaElementAudioSourceNode | undefined;
  private mediaConnected = false;
  private tracks: TrackInfo[] = [];
  private currentId: string | undefined;
  private playing = false;
  private shuffleOrder: string[] = [];
  private shuffleCursor = 0;
  private consecutiveFailures = 0;
  private listeners = new Set<(state: BgmState) => void>();
  private persistTimer: number | null = null;
  private unsubPrefs: (() => void) | undefined;
  private disposed = false;

  constructor(private readonly opts: BgmPlayerOptions) {}

  /** The host API, reached through the context the player was built with. */
  private get api(): HostApi {
    return this.opts.ctx.api;
  }

  // --- lifecycle ----------------------------------------------------------

  start(): void {
    this.unsubPrefs = this.opts.ctx.onPrefs((prefs) => this.onPrefs(prefs));
    this.opts.leader.onMessage((message) => this.onMessage(message));
    void this.refresh();

    // A track that fails to load must not wedge the player: skip on, but stop
    // after a few in a row so a directory of corrupt files cannot turn into an
    // endless skip loop.
    this.audioEl()?.addEventListener("error", () => this.onTrackError());
  }

  dispose(): void {
    this.disposed = true;
    this.unsubPrefs?.();
    this.unsubPrefs = undefined;
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.listeners.clear();
    try {
      this.el?.pause();
    } catch {
      /* nothing playing */
    }
    try {
      this.mediaSource?.disconnect();
    } catch {
      /* not connected */
    }
    this.mediaSource = undefined;
    this.mediaConnected = false;
    this.el = undefined;
    this.playing = false;
  }

  // --- public transport ---------------------------------------------------

  state(): BgmState {
    const prefs = this.opts.ctx.prefs();
    const el = this.el;
    const current = this.tracks.find((t) => t.id === this.currentId);
    return {
      trackId: this.currentId,
      title: current?.displayName ?? "",
      playing: this.playing,
      locked: !this.opts.audio.unlocked,
      leader: this.opts.leader.isLeader(),
      positionSeconds: el && Number.isFinite(el.currentTime) ? el.currentTime : 0,
      durationSeconds:
        el && Number.isFinite(el.duration) && el.duration > 0
          ? el.duration
          : (current?.durationSeconds ?? 0),
      volume: prefs.audio.bgm.volume,
      shuffle: prefs.audio.bgm.shuffle,
      repeat: prefs.audio.bgm.repeat,
      tracks: this.tracks.map(toBgmTrack),
      empty: this.playable().length === 0,
    };
  }

  onState(listener: (state: BgmState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  play(): void {
    if (!this.opts.leader.isLeader()) {
      this.send("play");
      return;
    }
    // Playback before the first gesture is what the autoplay policy forbids, so
    // asking here would produce a promise that never settles into sound. The
    // engine is unlocked by a gesture listener; until then the dock shows the
    // locked state and the user's next click starts the music.
    if (!this.opts.audio.unlocked) {
      void this.opts.audio.tryUnlock().then((ok) => {
        if (ok && !this.disposed) this.startPlayback();
      });
      return;
    }
    this.startPlayback();
  }

  pause(): void {
    if (!this.opts.leader.isLeader()) {
      this.send("pause");
      return;
    }
    this.stopPlayback();
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  next(): void {
    if (!this.opts.leader.isLeader()) {
      this.send("next");
      return;
    }
    this.advance("next");
  }

  prev(): void {
    if (!this.opts.leader.isLeader()) {
      this.send("prev");
      return;
    }
    this.advance("prev");
  }

  select(id: string): void {
    if (!this.opts.leader.isLeader()) {
      this.send("select", id);
      // Optimistic locally so the dock responds instantly; the leader's state
      // broadcast corrects it if the file is not playable there.
      this.currentId = id;
      this.emit();
      return;
    }
    const wasPlaying = this.playing;
    this.currentId = id;
    this.consecutiveFailures = 0;
    this.persistTrack(id);
    this.loadCurrent();
    if (wasPlaying) this.startPlayback();
    else this.emit();
  }

  setVolume(volume: number): void {
    if (!this.opts.leader.isLeader()) this.send("volume", volume);
    void this.opts.ctx
      .patchPrefs({ audio: { bgm: { volume } } })
      .catch(() => this.opts.ctx.toastError(new Error("volume"), "无法保存音量"));
    this.applyVolume(volume);
    this.emit();
  }

  setShuffle(on: boolean): void {
    if (!this.opts.leader.isLeader()) this.send("shuffle", on);
    this.shuffleOrder = [];
    void this.opts.ctx.patchPrefs({ audio: { bgm: { shuffle: on } } }).catch(() => {});
    this.emit();
  }

  setRepeat(repeat: "all" | "one"): void {
    if (!this.opts.leader.isLeader()) this.send("repeat", repeat);
    void this.opts.ctx.patchPrefs({ audio: { bgm: { repeat } } }).catch(() => {});
    this.emit();
  }

  seek(fraction: number): void {
    if (!this.opts.leader.isLeader()) {
      this.send("seek", fraction);
      return;
    }
    const el = this.el;
    if (!el || !Number.isFinite(el.duration) || el.duration <= 0) return;
    const target = Math.min(1, Math.max(0, fraction)) * el.duration;
    try {
      el.currentTime = target;
    } catch {
      /* not seekable yet */
    }
    this.emit();
  }

  async refresh(): Promise<void> {
    try {
      const library = await this.api.getLibrary();
      this.tracks = library.tracks;
    } catch {
      // A dead service must not clear the list the user is looking at; the
      // panel's offline state is what reports the failure.
      this.emit();
      return;
    }
    const prefs = this.opts.ctx.prefs();
    const wanted = prefs.audio.bgm.trackId;
    if (!this.currentId && wanted && this.tracks.some((t) => t.id === wanted)) {
      this.currentId = wanted;
      this.loadCurrent();
    }
    if (!this.currentId) {
      const first = this.playable()[0];
      if (first) this.currentId = first.id;
    }
    this.applyVolume(prefs.audio.bgm.volume);
    this.emit();
  }

  async upload(file: File, onProgress?: (fraction: number) => void): Promise<void> {
    await this.api.uploadTrack(file, onProgress);
    await this.refresh();
    this.opts.ctx.toast(`已添加 ${file.name}`);
  }

  async remove(name: string): Promise<void> {
    await this.api.deleteTrack(name);
    if (this.currentId === name) {
      this.stopPlayback();
      this.currentId = undefined;
    }
    await this.refresh();
  }

  async toggleTrack(name: string, enabled?: boolean): Promise<void> {
    await this.api.toggleTrack(name, enabled);
    await this.refresh();
  }

  // --- internals ----------------------------------------------------------

  private playable(): TrackInfo[] {
    return this.tracks.filter((t) => t.enabled);
  }

  private audioEl(): HTMLAudioElement | undefined {
    if (this.el) return this.el;
    if (typeof Audio === "undefined") return undefined;
    try {
      const el = new Audio();
      el.preload = "metadata";
      el.crossOrigin = "anonymous";
      el.addEventListener("timeupdate", () => this.emit());
      el.addEventListener("durationchange", () => this.emit());
      el.addEventListener("play", () => {
        this.playing = true;
        this.emit();
      });
      el.addEventListener("pause", () => {
        this.playing = false;
        this.emit();
      });
      el.addEventListener("ended", () => this.onEnded());
      // A track that actually produced data ends the failure streak, so the cap
      // counts *consecutive* failures rather than every failure in a session.
      el.addEventListener("loadeddata", () => {
        this.consecutiveFailures = 0;
      });
      this.el = el;
      this.connectGraph(el);
      return el;
    } catch {
      return undefined;
    }
  }

  /**
   * Routes the element through the music bus, once.
   *
   * `createMediaElementSource` may be called only once per element and, once
   * called, the element's audio only reaches the speakers through the graph — so
   * it is attempted only when the context is already running. Trying it while
   * the context is suspended would silence the track rather than fall back.
   */
  private connectGraph(el: HTMLAudioElement): void {
    if (this.mediaConnected) return;
    const ctx = this.opts.audio.context;
    if (!ctx) return;
    const bus = this.opts.audio.bus("bgm");
    if (!bus) return;
    try {
      this.mediaSource = ctx.createMediaElementSource(el);
      this.mediaSource.connect(bus);
      this.mediaConnected = true;
      el.volume = 1;
    } catch {
      this.mediaSource = undefined;
      this.mediaConnected = false;
    }
  }

  private loadCurrent(): void {
    const el = this.audioEl();
    if (!el || !this.currentId) return;
    const url = this.api.mediaUrl("music", this.currentId);
    if (el.src !== url) {
      el.src = url;
      // The graph can only be built once the context exists; a track started
      // before the first gesture gets the fallback volume path instead.
      this.connectGraph(el);
    }
    this.applyVolume(this.opts.ctx.prefs().audio.bgm.volume);
  }

  private startPlayback(): void {
    const prefs = this.opts.ctx.prefs();
    if (!prefs.audio.enabled || !prefs.audio.bgm.enabled) return;
    const playable = this.playable();
    if (playable.length === 0) {
      this.emit();
      return;
    }
    if (!this.currentId || !playable.some((t) => t.id === this.currentId)) {
      this.currentId = this.pickNext() ?? playable[0].id;
    }
    this.loadCurrent();
    const el = this.el;
    if (!el) return;
    const attempt = el.play();
    if (attempt && typeof attempt.catch === "function") {
      // A rejected play() is the autoplay policy, or a torn-down element. Both
      // are reported through `locked`, not as an error toast.
      attempt.catch(() => {
        this.playing = false;
        this.emit();
      });
    }
    this.playing = true;
    this.emit();
  }

  private stopPlayback(): void {
    try {
      this.el?.pause();
    } catch {
      /* nothing playing */
    }
    this.playing = false;
    this.emit();
  }

  private onEnded(): void {
    const prefs = this.opts.ctx.prefs();
    if (prefs.audio.bgm.repeat === "one") {
      const el = this.el;
      if (el) {
        try {
          el.currentTime = 0;
          void el.play();
          return;
        } catch {
          /* fall through to advancing */
        }
      }
    }
    this.advance("next");
  }

  /**
   * The current track could not be loaded.
   *
   * After a few consecutive failures the player stops rather than continuing to
   * skip: a directory of undecodable files must not become an endless
   * load-error-skip loop that churns the dock title and re-requests the same
   * bytes forever while reporting itself as playing. The counter is cleared on a
   * successful load and on an explicit track choice — never here, and never in
   * `advance()`, which is what previously made the cap unreachable.
   */
  private onTrackError(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures > MAX_TRACK_FAILURES) {
      this.stopPlayback();
      this.opts.ctx.toast(`连续 ${MAX_TRACK_FAILURES + 1} 首曲目无法播放,已停止。请检查 music/ 中的文件`);
      return;
    }
    // Move on rather than retrying the same broken file.
    this.advance("next");
  }

  /**
   * Moves the transport. `direction` is which way, and the repeat mode decides
   * whether the end of the list wraps.
   */
  private advance(direction: "next" | "prev"): void {
    const prefs = this.opts.ctx.prefs();
    const playable = this.playable();
    if (playable.length === 0) {
      this.stopPlayback();
      return;
    }
    let target: string | undefined;
    if (prefs.audio.bgm.shuffle && direction === "next") {
      target = this.pickNext();
    } else {
      const ids = playable.map((t) => t.id);
      const index = this.currentId ? ids.indexOf(this.currentId) : -1;
      const step = direction === "next" ? 1 : -1;
      let next = index + step;
      if (next >= ids.length) {
        if (prefs.audio.bgm.repeat === "all") next = 0;
        else {
          this.stopPlayback();
          return;
        }
      }
      if (next < 0) next = ids.length - 1;
      target = ids[next];
    }
    if (!target) target = playable[0].id;

    const wasPlaying = this.playing;
    this.currentId = target;
    // NOT reset here. Clearing the failure counter on the way to the next
    // track is what made MAX_TRACK_FAILURES unreachable: it was zeroed before
    // the next load could fail, so a directory of undecodable files became an
    // endless skip loop that reported itself as playing. It is cleared in
    // `select()` (the user picked this track) and on a successful load.
    this.persistTrack(target);
    this.loadCurrent();
    if (wasPlaying) this.startPlayback();
    else this.emit();
  }

  /**
   * The next track in shuffle order.
   *
   * A shuffled bag rather than an independent random draw: with a small library
   * a random draw repeats tracks long before it has played them all, which reads
   * as a bug. The bag is refilled and re-shuffled once exhausted, and never
   * starts with the track that just finished.
   */
  private pickNext(): string | undefined {
    const ids = this.playable().map((t) => t.id);
    if (ids.length === 0) return undefined;
    if (ids.length === 1) return ids[0];
    const order = this.shuffleOrder.filter((id) => ids.includes(id));
    if (order.length !== ids.length || this.shuffleCursor >= order.length) {
      this.shuffleOrder = shuffleArray(ids);
      this.shuffleCursor = 0;
      // Do not start the new bag with the track that just ended.
      if (this.shuffleOrder[0] === this.currentId && this.shuffleOrder.length > 1) {
        [this.shuffleOrder[0], this.shuffleOrder[1]] = [this.shuffleOrder[1], this.shuffleOrder[0]];
      }
    }
    const next = this.shuffleOrder[this.shuffleCursor];
    this.shuffleCursor += 1;
    return next;
  }

  private applyVolume(bgmVolume: number): void {
    const prefs = this.opts.ctx.prefs();
    const el = this.el;
    if (!el) return;
    if (this.mediaConnected) {
      // The bus owns the level; the element must stay at unity or the two
      // would multiply and the slider would feel quadratic.
      el.volume = 1;
      this.opts.audio.applyVolumes({
        master: prefs.audio.masterVolume,
        sfx: prefs.audio.sfx.volume,
        bgm: bgmVolume,
        voice: prefs.audio.voice.volume,
      });
    } else {
      el.volume = clamp01(bgmVolume * prefs.audio.masterVolume);
    }
  }

  private onPrefs(prefs: Prefs): void {
    const el = this.el;
    if (!el) {
      this.applyVolume(prefs.audio.bgm.volume);
      this.emit();
      return;
    }
    this.applyVolume(prefs.audio.bgm.volume);
    if (!prefs.audio.enabled || !prefs.audio.bgm.enabled) {
      if (this.playing) this.stopPlayback();
    }
    this.emit();
  }

  /** Writes the current track back, debounced: skipping quickly is one write. */
  private persistTrack(id: string | undefined): void {
    if (this.persistTimer !== null) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.opts.ctx.patchPrefs({ audio: { bgm: { trackId: id } } }).catch(() => {});
    }, 1000) as unknown as number;
  }

  private send(command: string, value?: unknown): void {
    this.opts.leader.broadcast({ type: "bgm-command", command, value } satisfies BgmMessage);
  }

  private onMessage(message: unknown): void {
    if (!message || typeof message !== "object") return;
    const msg = message as BgmMessage;
    if (msg.type === "bgm-command" && this.opts.leader.isLeader()) {
      this.applyCommand(msg.command, msg.value);
      return;
    }
    if (msg.type === "bgm-state" && !this.opts.leader.isLeader() && msg.state) {
      // Followers adopt the leader's state wholesale, so the two docks cannot
      // show different tracks.
      this.tracks = msg.state.tracks.map(toTrackInfo);
      this.currentId = msg.state.trackId;
      this.playing = msg.state.playing;
      this.emit();
    }
  }

  private applyCommand(command: string | undefined, value: unknown): void {
    switch (command) {
      case "play":
        this.play();
        break;
      case "pause":
        this.pause();
        break;
      case "next":
        this.next();
        break;
      case "prev":
        this.prev();
        break;
      case "select":
        if (typeof value === "string") this.select(value);
        break;
      case "volume":
        if (typeof value === "number") this.setVolume(value);
        break;
      case "shuffle":
        if (typeof value === "boolean") this.setShuffle(value);
        break;
      case "repeat":
        if (value === "all" || value === "one") this.setRepeat(value);
        break;
      case "seek":
        if (typeof value === "number") this.seek(value);
        break;
      default:
        break;
    }
  }

  /** Tells the other renderers what is playing, so their docks agree. */
  broadcastState(): void {
    if (!this.opts.leader.isLeader()) return;
    this.opts.leader.broadcast({ type: "bgm-state", state: this.state() } satisfies BgmMessage);
  }

  private emit(): void {
    if (this.disposed) return;
    const state = this.state();
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch {
        /* a listener must not break the player */
      }
    }
  }
}

function toBgmTrack(track: TrackInfo): BgmTrack {
  return {
    id: track.id,
    displayName: track.displayName,
    enabled: track.enabled,
    size: track.size,
    durationSeconds: track.durationSeconds,
  };
}

/** Rebuilds a `TrackInfo` from a broadcast state entry. */
function toTrackInfo(track: BgmTrack): TrackInfo {
  return {
    id: track.id,
    filename: track.id,
    displayName: track.displayName,
    enabled: track.enabled,
    size: track.size,
    mtimeMs: 0,
    durationSeconds: track.durationSeconds,
  };
}

function shuffleArray<T>(input: T[]): T[] {
  const out = [...input];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
