"use strict";
(() => {
  // src/client/core/audio.ts
  var AudioEngine = class {
    constructor(volumes) {
      this.volumes = volumes;
    }
    volumes;
    ctx;
    master;
    buses = /* @__PURE__ */ new Map();
    unlockedFlag = false;
    unlockAttempted = false;
    listeners = /* @__PURE__ */ new Set();
    detachGesture;
    /** True once a user gesture has let the context actually run. */
    get unlocked() {
      return this.unlockedFlag;
    }
    /** True when a context exists but the policy is still holding it suspended. */
    get locked() {
      return this.ctx !== void 0 && this.ctx.state !== "running";
    }
    get context() {
      return this.ctx;
    }
    onUnlock(listener) {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }
    /**
     * Returns the context, creating it on first use.
     *
     * Returns undefined when the platform has no `AudioContext` at all — an older
     * Electron, or a renderer with audio disabled — so every caller can degrade to
     * "no sound" without a thrown error.
     */
    ensureContext() {
      if (this.ctx) return this.ctx;
      try {
        const Ctor = window.AudioContext ?? window.webkitAudioContext;
        if (!Ctor) return void 0;
        const ctx = new Ctor();
        this.ctx = ctx;
        this.master = ctx.createGain();
        this.master.connect(ctx.destination);
        for (const bus of ["sfx", "bgm", "voice"]) {
          const gain = ctx.createGain();
          gain.connect(this.master);
          this.buses.set(bus, gain);
        }
        this.applyVolumes(this.volumes);
        if (contextState(ctx) === "running") this.markUnlocked(true);
        else ctx.onstatechange = () => this.markUnlocked(contextState(ctx) === "running");
        return ctx;
      } catch {
        return void 0;
      }
    }
    /** The gain node a bus feeds through, creating the graph if needed. */
    bus(bus) {
      this.ensureContext();
      return this.buses.get(bus);
    }
    /**
     * Attempts to resume the context. Must be called from a user-gesture handler
     * to have any effect; safe to call at other times (it simply fails).
     */
    async tryUnlock() {
      const ctx = this.ensureContext();
      if (!ctx) return false;
      if (ctx.state === "running") {
        this.markUnlocked(true);
        return true;
      }
      this.unlockAttempted = true;
      try {
        await ctx.resume();
      } catch {
        return false;
      }
      const ok = contextState(ctx) === "running";
      if (ok) this.markUnlocked(true);
      return ok;
    }
    /**
     * Installs the one-shot gesture listeners that unlock the engine.
     *
     * Capture phase and `once`-like behaviour: the first qualifying event wins,
     * the listeners remove themselves, and a gesture that fails to unlock is not
     * retried in a loop.
     */
    installGestureUnlock(target = document) {
      if (this.detachGesture) return;
      const events = ["pointerdown", "keydown", "touchstart"];
      let done = false;
      const handler = () => {
        if (done) return;
        done = true;
        void this.tryUnlock().then((ok) => {
          if (ok) this.removeGesture(target, events, handler);
        });
      };
      for (const name of events) target.addEventListener(name, handler, { capture: true, passive: true });
      this.detachGesture = () => {
        done = true;
        this.removeGesture(target, events, handler);
      };
    }
    /** Removes the gesture listeners; called on dispose. */
    removeGestureUnlock() {
      this.detachGesture?.();
      this.detachGesture = void 0;
    }
    /** Pushes new levels onto the live gain nodes. */
    applyVolumes(volumes) {
      Object.assign(this.volumes, volumes);
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      const ramp = (node, value) => {
        if (!node) return;
        try {
          node.gain.setTargetAtTime(clamp01(value), now, 0.02);
        } catch {
          node.gain.value = clamp01(value);
        }
      };
      ramp(this.master, this.volumes.master);
      ramp(this.buses.get("sfx"), this.volumes.sfx);
      ramp(this.buses.get("bgm"), this.volumes.bgm);
      ramp(this.buses.get("voice"), this.volumes.voice);
    }
    /** Releases the context. Called when the theme is torn down. */
    dispose() {
      this.removeGestureUnlock();
      this.listeners.clear();
      try {
        void this.ctx?.close();
      } catch {
      }
      this.ctx = void 0;
      this.master = void 0;
      this.buses.clear();
      this.unlockedFlag = false;
    }
    /** True when an unlock was tried and did not take, for the UI's hint text. */
    get unlockFailed() {
      return this.unlockAttempted && !this.unlockedFlag;
    }
    markUnlocked(value) {
      if (this.unlockedFlag === value) return;
      this.unlockedFlag = value;
      if (value) this.unlockAttempted = false;
      for (const listener of this.listeners) {
        try {
          listener(value);
        } catch {
        }
      }
    }
    removeGesture(target, events, handler) {
      for (const name of events) {
        try {
          target.removeEventListener(name, handler, { capture: true });
        } catch {
        }
      }
    }
  };
  function clamp01(value) {
    if (!Number.isFinite(value)) return 0;
    return Math.min(1, Math.max(0, value));
  }
  function contextState(ctx) {
    return ctx.state;
  }

  // src/client/core/api.ts
  var ApiError = class extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
    status;
  };
  var HostApi = class {
    constructor(boot2) {
      this.boot = boot2;
      this.base = `http://127.0.0.1:${boot2.apiPort}`;
    }
    boot;
    base;
    get mediaToken() {
      return this.boot.mediaToken;
    }
    get version() {
      return this.boot.version;
    }
    /** The URL an `<audio>`/`<img>` element can load directly. */
    mediaUrl(kind, name) {
      return `${this.base}/api/media/${encodeURIComponent(kind)}/${encodeURIComponent(name)}?token=${encodeURIComponent(this.boot.mediaToken)}`;
    }
    async request(path, init) {
      const headers = new Headers(init?.headers);
      headers.set("x-zb-token", this.boot.token);
      const res = await fetch(`${this.base}${path}`, { ...init, headers });
      const text = await res.text();
      let parsed;
      if (text.length > 0) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = void 0;
        }
      }
      if (!res.ok) {
        const message = parsed && typeof parsed === "object" && typeof parsed.error === "string" ? parsed.error : `request failed (${res.status})`;
        throw new ApiError(message, res.status);
      }
      return parsed;
    }
    post(path, body) {
      return this.request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {})
      });
    }
    // --- prefs --------------------------------------------------------------
    getPrefs() {
      return this.request("/api/prefs");
    }
    patchPrefs(patch) {
      return this.post("/api/prefs", patch);
    }
    // --- library ------------------------------------------------------------
    getLibrary() {
      return this.request("/api/library/music");
    }
    /**
     * Uploads a track.
     *
     * Uses `XMLHttpRequest` rather than `fetch` for one reason: it reports upload
     * progress, and a 200 MB file with no progress bar reads as a hung panel.
     */
    uploadTrack(file, onProgress) {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", `${this.base}/api/library/music/add?name=${encodeURIComponent(file.name)}`);
        xhr.setRequestHeader("x-zb-token", this.boot.token);
        xhr.setRequestHeader("Content-Type", "application/octet-stream");
        xhr.upload.onprogress = (ev) => {
          if (onProgress && ev.lengthComputable && ev.total > 0) onProgress(ev.loaded / ev.total);
        };
        xhr.onload = () => {
          let parsed;
          try {
            parsed = JSON.parse(xhr.responseText);
          } catch {
            parsed = void 0;
          }
          if (xhr.status >= 200 && xhr.status < 300) resolve(parsed);
          else {
            const message = parsed && typeof parsed === "object" && typeof parsed.error === "string" ? parsed.error : `upload failed (${xhr.status})`;
            reject(new ApiError(message, xhr.status));
          }
        };
        xhr.onerror = () => reject(new ApiError("upload failed: the service is unreachable", 0));
        xhr.send(file);
      });
    }
    deleteTrack(name) {
      return this.post("/api/library/music/delete", { name });
    }
    toggleTrack(name, enabled) {
      return this.post("/api/library/music/toggle", { name, enabled });
    }
    // --- pools --------------------------------------------------------------
    getPool(kind) {
      return this.request(`/api/pool/${kind}`);
    }
    deletePoolFile(kind, name) {
      return this.post(`/api/pool/${kind}/delete`, { name });
    }
    getStatusPhrases(language) {
      return this.request(`/api/status/phrases${language ? `?lang=${language}` : ""}`);
    }
    getSystem() {
      return this.request("/api/system");
    }
    // --- v0.1 appearance routes (kept; the panel still drives them) ----------
    getConfig() {
      return this.request("/api/config");
    }
    setConfig(patch) {
      return this.post("/api/config", patch);
    }
    getStatus() {
      return this.request("/api/status");
    }
    reset() {
      return this.post("/api/reset", {});
    }
    restore() {
      return this.post("/api/restore", {});
    }
    setRecovery(mode) {
      return this.post("/api/recovery", { mode });
    }
    relaunch() {
      return this.post("/api/relaunch", {});
    }
    setWallpaper(dataUri, name) {
      return this.post("/api/wallpaper", { dataUri, name });
    }
  };

  // src/client/core/leader.ts
  var LEADER_KEY = "zct:leader";
  var LEADER_CHANNEL = "zcode-tarkov";
  var LEASE_MS = 12e3;
  var HEARTBEAT_MS = 4e3;
  var CLAIM_JITTER_MS = 250;
  function parseLease(raw) {
    if (typeof raw !== "string" || raw.length === 0) return void 0;
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed?.id !== "string" || parsed.id.length === 0) return void 0;
      if (typeof parsed?.expiresAt !== "number" || !Number.isFinite(parsed.expiresAt)) return void 0;
      return { id: parsed.id, expiresAt: parsed.expiresAt };
    } catch {
      return void 0;
    }
  }
  var LeaderCore = class {
    constructor(id, store, now, leaseMs = LEASE_MS) {
      this.id = id;
      this.store = store;
      this.now = now;
      this.leaseMs = leaseMs;
    }
    id;
    store;
    now;
    leaseMs;
    leader = false;
    /** The current lease, or undefined when there is none or it is malformed. */
    current() {
      return parseLease(this.store.read());
    }
    /** True when the stored lease names us and has not expired. */
    holdsLease() {
      const lease = this.current();
      return lease !== void 0 && lease.id === this.id && lease.expiresAt > this.now();
    }
    /** True when nobody holds a live lease. */
    isFree() {
      const lease = this.current();
      return lease === void 0 || lease.expiresAt <= this.now();
    }
    isLeader() {
      if (this.leader && !this.holdsLease()) this.leader = false;
      return this.leader;
    }
    /** Renews our lease if we hold it. Returns true when we still hold it. */
    renew() {
      if (!this.holdsLease()) {
        this.leader = false;
        return false;
      }
      this.write();
      return true;
    }
    /**
     * Attempts to become the leader.
     *
     * Only claims a free lease, and only believes the claim after re-reading:
     * `confirm()` must be called afterwards, once the jitter has elapsed.
     */
    claimIfFree() {
      if (this.holdsLease()) {
        this.leader = true;
        this.write();
        return true;
      }
      if (!this.isFree()) return false;
      this.write();
      this.leader = true;
      return true;
    }
    /**
     * Re-reads the lease and keeps the leadership only if it is still ours.
     *
     * Called after the jitter window. A writer that lost a race sees the winner's
     * id here and stands down, which is what makes two simultaneous claims safe.
     */
    confirm() {
      this.leader = this.holdsLease();
      return this.leader;
    }
    /** Gives up the lease so a follower can take over immediately. */
    release() {
      if (this.holdsLease()) {
        this.store.write(JSON.stringify({ id: "", expiresAt: 0 }));
      }
      this.leader = false;
    }
    write() {
      this.store.write(JSON.stringify({ id: this.id, expiresAt: this.now() + this.leaseMs }));
    }
  };
  var LeaderController = class {
    constructor(options, id = randomId()) {
      this.options = options;
      this.id = id;
      this.random = options.random ?? Math.random;
      this.core = createCore(id, options.leaseMs);
      if (this.core) {
        try {
          this.channel = new BroadcastChannel(LEADER_CHANNEL);
          this.channel.onmessage = (ev) => this.dispatch(ev.data);
        } catch {
          this.channel = null;
        }
      } else {
        this.role = "leader";
      }
    }
    options;
    id;
    core;
    timer = null;
    channel = null;
    role = "follower";
    random;
    start() {
      if (this.timer !== null) return;
      this.tick();
      this.timer = setInterval(() => this.tick(), this.options.heartbeatMs ?? HEARTBEAT_MS);
    }
    stop() {
      if (this.timer !== null) {
        clearInterval(this.timer);
        this.timer = null;
      }
      try {
        this.core?.release();
      } catch {
      }
      this.setRole("follower");
      try {
        this.channel?.close();
      } catch {
      }
      this.channel = null;
    }
    isLeader() {
      return this.role === "leader";
    }
    /** Sends a message to the other renderers; used to forward dock commands. */
    broadcast(message) {
      try {
        this.channel?.postMessage(message);
      } catch {
      }
    }
    onMessage(handler) {
      this.messageHandlers.push(handler);
    }
    messageHandlers = [];
    dispatch(data) {
      if (data && typeof data === "object" && data.type === "release") {
        this.tick();
        return;
      }
      for (const handler of this.messageHandlers) {
        try {
          handler(data);
        } catch {
        }
      }
    }
    tick() {
      if (!this.core) return;
      if (this.core.isLeader()) {
        if (!this.core.renew()) this.setRole("follower");
        else this.setRole("leader");
        return;
      }
      if (!this.core.claimIfFree()) {
        this.setRole("follower");
        return;
      }
      const delay = Math.floor(this.random() * CLAIM_JITTER_MS);
      setTimeout(() => {
        const won = this.core ? this.core.confirm() : false;
        this.setRole(won ? "leader" : "follower");
      }, delay);
    }
    setRole(role) {
      if (this.role === role) return;
      this.role = role;
      try {
        this.options.onRole(role);
      } catch {
      }
    }
  };
  function createCore(id, leaseMs) {
    try {
      const probe = "__zct_probe__";
      window.localStorage.setItem(probe, "1");
      window.localStorage.removeItem(probe);
      const store = {
        read: () => {
          try {
            return window.localStorage.getItem(LEADER_KEY) ?? void 0;
          } catch {
            return void 0;
          }
        },
        write: (value) => {
          try {
            window.localStorage.setItem(LEADER_KEY, value);
          } catch {
          }
        }
      };
      return new LeaderCore(id, store, () => Date.now(), leaseMs);
    } catch {
      return void 0;
    }
  }
  function randomId() {
    try {
      const bytes = new Uint8Array(8);
      crypto.getRandomValues(bytes);
      return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    } catch {
      return Math.random().toString(16).slice(2, 18);
    }
  }

  // src/client/bgm/player.ts
  var MAX_TRACK_FAILURES = 3;
  var BgmPlayer = class {
    constructor(opts) {
      this.opts = opts;
    }
    opts;
    el;
    mediaSource;
    mediaConnected = false;
    tracks = [];
    currentId;
    playing = false;
    shuffleOrder = [];
    shuffleCursor = 0;
    consecutiveFailures = 0;
    listeners = /* @__PURE__ */ new Set();
    persistTimer = null;
    unsubPrefs;
    disposed = false;
    /** The host API, reached through the context the player was built with. */
    get api() {
      return this.opts.ctx.api;
    }
    // --- lifecycle ----------------------------------------------------------
    start() {
      this.unsubPrefs = this.opts.ctx.onPrefs((prefs) => this.onPrefs(prefs));
      this.opts.leader.onMessage((message) => this.onMessage(message));
      void this.refresh();
      this.audioEl()?.addEventListener("error", () => this.onTrackError());
    }
    dispose() {
      this.disposed = true;
      this.unsubPrefs?.();
      this.unsubPrefs = void 0;
      if (this.persistTimer !== null) {
        clearTimeout(this.persistTimer);
        this.persistTimer = null;
      }
      this.listeners.clear();
      try {
        this.el?.pause();
      } catch {
      }
      try {
        this.mediaSource?.disconnect();
      } catch {
      }
      this.mediaSource = void 0;
      this.mediaConnected = false;
      this.el = void 0;
      this.playing = false;
    }
    // --- public transport ---------------------------------------------------
    state() {
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
        durationSeconds: el && Number.isFinite(el.duration) && el.duration > 0 ? el.duration : current?.durationSeconds ?? 0,
        volume: prefs.audio.bgm.volume,
        shuffle: prefs.audio.bgm.shuffle,
        repeat: prefs.audio.bgm.repeat,
        tracks: this.tracks.map(toBgmTrack),
        empty: this.playable().length === 0
      };
    }
    onState(listener) {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }
    play() {
      if (!this.opts.leader.isLeader()) {
        this.send("play");
        return;
      }
      if (!this.opts.audio.unlocked) {
        void this.opts.audio.tryUnlock().then((ok) => {
          if (ok && !this.disposed) this.startPlayback();
        });
        return;
      }
      this.startPlayback();
    }
    pause() {
      if (!this.opts.leader.isLeader()) {
        this.send("pause");
        return;
      }
      this.stopPlayback();
    }
    toggle() {
      if (this.playing) this.pause();
      else this.play();
    }
    next() {
      if (!this.opts.leader.isLeader()) {
        this.send("next");
        return;
      }
      this.advance("next");
    }
    prev() {
      if (!this.opts.leader.isLeader()) {
        this.send("prev");
        return;
      }
      this.advance("prev");
    }
    select(id) {
      if (!this.opts.leader.isLeader()) {
        this.send("select", id);
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
    setVolume(volume) {
      if (!this.opts.leader.isLeader()) this.send("volume", volume);
      void this.opts.ctx.patchPrefs({ audio: { bgm: { volume } } }).catch(() => this.opts.ctx.toastError(new Error("volume"), "无法保存音量"));
      this.applyVolume(volume);
      this.emit();
    }
    setShuffle(on) {
      if (!this.opts.leader.isLeader()) this.send("shuffle", on);
      this.shuffleOrder = [];
      void this.opts.ctx.patchPrefs({ audio: { bgm: { shuffle: on } } }).catch(() => {
      });
      this.emit();
    }
    setRepeat(repeat) {
      if (!this.opts.leader.isLeader()) this.send("repeat", repeat);
      void this.opts.ctx.patchPrefs({ audio: { bgm: { repeat } } }).catch(() => {
      });
      this.emit();
    }
    seek(fraction) {
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
      }
      this.emit();
    }
    async refresh() {
      try {
        const library = await this.api.getLibrary();
        this.tracks = library.tracks;
      } catch {
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
    async upload(file, onProgress) {
      await this.api.uploadTrack(file, onProgress);
      await this.refresh();
      this.opts.ctx.toast(`已添加 ${file.name}`);
    }
    async remove(name) {
      await this.api.deleteTrack(name);
      if (this.currentId === name) {
        this.stopPlayback();
        this.currentId = void 0;
      }
      await this.refresh();
    }
    async toggleTrack(name, enabled) {
      await this.api.toggleTrack(name, enabled);
      await this.refresh();
    }
    // --- internals ----------------------------------------------------------
    playable() {
      return this.tracks.filter((t) => t.enabled);
    }
    audioEl() {
      if (this.el) return this.el;
      if (typeof Audio === "undefined") return void 0;
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
        el.addEventListener("loadeddata", () => {
          this.consecutiveFailures = 0;
        });
        this.el = el;
        this.connectGraph(el);
        return el;
      } catch {
        return void 0;
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
    connectGraph(el) {
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
        this.mediaSource = void 0;
        this.mediaConnected = false;
      }
    }
    loadCurrent() {
      const el = this.audioEl();
      if (!el || !this.currentId) return;
      const url = this.api.mediaUrl("music", this.currentId);
      if (el.src !== url) {
        el.src = url;
        this.connectGraph(el);
      }
      this.applyVolume(this.opts.ctx.prefs().audio.bgm.volume);
    }
    startPlayback() {
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
        attempt.catch(() => {
          this.playing = false;
          this.emit();
        });
      }
      this.playing = true;
      this.emit();
    }
    stopPlayback() {
      try {
        this.el?.pause();
      } catch {
      }
      this.playing = false;
      this.emit();
    }
    onEnded() {
      const prefs = this.opts.ctx.prefs();
      if (prefs.audio.bgm.repeat === "one") {
        const el = this.el;
        if (el) {
          try {
            el.currentTime = 0;
            void el.play();
            return;
          } catch {
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
    onTrackError() {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures > MAX_TRACK_FAILURES) {
        this.stopPlayback();
        this.opts.ctx.toast(`连续 ${MAX_TRACK_FAILURES + 1} 首曲目无法播放,已停止。请检查 music/ 中的文件`);
        return;
      }
      this.advance("next");
    }
    /**
     * Moves the transport. `direction` is which way, and the repeat mode decides
     * whether the end of the list wraps.
     */
    advance(direction) {
      const prefs = this.opts.ctx.prefs();
      const playable = this.playable();
      if (playable.length === 0) {
        this.stopPlayback();
        return;
      }
      let target;
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
    pickNext() {
      const ids = this.playable().map((t) => t.id);
      if (ids.length === 0) return void 0;
      if (ids.length === 1) return ids[0];
      const order = this.shuffleOrder.filter((id) => ids.includes(id));
      if (order.length !== ids.length || this.shuffleCursor >= order.length) {
        this.shuffleOrder = shuffleArray(ids);
        this.shuffleCursor = 0;
        if (this.shuffleOrder[0] === this.currentId && this.shuffleOrder.length > 1) {
          [this.shuffleOrder[0], this.shuffleOrder[1]] = [this.shuffleOrder[1], this.shuffleOrder[0]];
        }
      }
      const next = this.shuffleOrder[this.shuffleCursor];
      this.shuffleCursor += 1;
      return next;
    }
    applyVolume(bgmVolume) {
      const prefs = this.opts.ctx.prefs();
      const el = this.el;
      if (!el) return;
      if (this.mediaConnected) {
        el.volume = 1;
        this.opts.audio.applyVolumes({
          master: prefs.audio.masterVolume,
          sfx: prefs.audio.sfx.volume,
          bgm: bgmVolume,
          voice: prefs.audio.voice.volume
        });
      } else {
        el.volume = clamp012(bgmVolume * prefs.audio.masterVolume);
      }
    }
    onPrefs(prefs) {
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
    persistTrack(id) {
      if (this.persistTimer !== null) clearTimeout(this.persistTimer);
      this.persistTimer = setTimeout(() => {
        this.persistTimer = null;
        void this.opts.ctx.patchPrefs({ audio: { bgm: { trackId: id } } }).catch(() => {
        });
      }, 1e3);
    }
    send(command, value) {
      this.opts.leader.broadcast({ type: "bgm-command", command, value });
    }
    onMessage(message) {
      if (!message || typeof message !== "object") return;
      const msg = message;
      if (msg.type === "bgm-command" && this.opts.leader.isLeader()) {
        this.applyCommand(msg.command, msg.value);
        return;
      }
      if (msg.type === "bgm-state" && !this.opts.leader.isLeader() && msg.state) {
        this.tracks = msg.state.tracks.map(toTrackInfo);
        this.currentId = msg.state.trackId;
        this.playing = msg.state.playing;
        this.emit();
      }
    }
    applyCommand(command, value) {
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
    broadcastState() {
      if (!this.opts.leader.isLeader()) return;
      this.opts.leader.broadcast({ type: "bgm-state", state: this.state() });
    }
    emit() {
      if (this.disposed) return;
      const state = this.state();
      for (const listener of this.listeners) {
        try {
          listener(state);
        } catch {
        }
      }
    }
  };
  function toBgmTrack(track) {
    return {
      id: track.id,
      displayName: track.displayName,
      enabled: track.enabled,
      size: track.size,
      durationSeconds: track.durationSeconds
    };
  }
  function toTrackInfo(track) {
    return {
      id: track.id,
      filename: track.id,
      displayName: track.displayName,
      enabled: track.enabled,
      size: track.size,
      mtimeMs: 0,
      durationSeconds: track.durationSeconds
    };
  }
  function shuffleArray(input) {
    const out = [...input];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
  function clamp012(value) {
    if (!Number.isFinite(value)) return 0;
    return Math.min(1, Math.max(0, value));
  }

  // src/themes/palette.ts
  var TARKOV_ACCENT = "#ee8a3a";
  var TARKOV_ACCENT_RGB = "238, 138, 58";
  var TARKOV_INK = "#1c1207";
  var TARKOV_BACKGROUND = "#1c1207";
  var DEFAULT_PALETTE = {
    accent: TARKOV_ACCENT,
    accentRgb: TARKOV_ACCENT_RGB,
    deep: "#140d04",
    deepRgb: "20, 13, 4",
    background: TARKOV_BACKGROUND,
    panelRgb: "26, 18, 10",
    panelAltRgb: "30, 20, 10",
    raisedRgb: "42, 29, 16",
    popoverRgb: "46, 32, 18",
    text: "#e8d9c8",
    highlight: "#ffd7ae",
    warning: "#ffb27a",
    muted: "#8b877c",
    mutedRgb: "139, 135, 124",
    // Both match what the shipped theme already painted: dark ink on the accent,
    // and the reference project's #111111 on the band. They are held as constants
    // rather than recomputed so the default render stays byte-identical — the
    // contrast logic below only runs once a colour has actually been chosen.
    onAccent: "#1c1207",
    bandInk: "#111111",
    // Matches what the popover foreground already resolved to, so the shipped
    // render is unchanged.
    popoverText: "#e8d9c8"
  };

  // src/client/ui/skin.ts
  var UI_ROOT_ID = "zct-ui-root";
  var UI_STYLE_ID = "zct-ui-style";
  var Z_TOAST = 2147483400;
  var Z_MENU = 2147483300;
  var Z_DOCK = 2147483200;
  var Z_PET = 2147483100;
  function buildUiCss() {
    return `
#${UI_ROOT_ID}, #${UI_ROOT_ID} * { box-sizing: border-box; }

#${UI_ROOT_ID} {
  /* --- neutral skin (Monet / Native) --- */
  --zct-bg: rgba(24, 24, 30, .9);
  --zct-bg-solid: rgb(26, 26, 32);
  --zct-border: rgba(255, 255, 255, .12);
  --zct-radius: 10px;
  --zct-radius-sm: 6px;
  --zct-radius-pill: 999px;
  --zct-text: #e8e8ea;
  --zct-subtle: rgba(255, 255, 255, .62);
  --zct-ctl-bg: rgba(255, 255, 255, .09);
  --zct-ctl-border: rgba(255, 255, 255, .14);
  --zct-ctl-hover: rgba(255, 255, 255, .16);
  --zct-accent: #7aa2f7;
  --zct-accent-soft: rgba(122, 162, 247, .22);
  --zct-on-accent: #14161c;
  --zct-shadow: 0 10px 34px rgba(0, 0, 0, .5);
  --zct-font: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  --zct-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;

  position: fixed;
  inset: auto;
  z-index: ${Z_DOCK};
  font-family: var(--zct-font);
  font-size: 12px;
  color: var(--zct-text);
  line-height: 1.45;
  /* The root is a positioning context only; it must never intercept clicks. */
  pointer-events: none;
}

#${UI_ROOT_ID}[data-zct-theme="tarkov"] {
  --zct-bg: rgba(26, 18, 10, .95);
  --zct-bg-solid: rgb(28, 20, 11);
  --zct-border: rgba(${TARKOV_ACCENT_RGB}, .45);
  --zct-radius: 4px;
  --zct-radius-sm: 3px;
  --zct-radius-pill: 3px;
  --zct-text: #e8d9c8;
  --zct-subtle: rgba(232, 217, 200, .58);
  --zct-ctl-bg: rgba(${TARKOV_ACCENT_RGB}, .14);
  --zct-ctl-border: rgba(${TARKOV_ACCENT_RGB}, .36);
  --zct-ctl-hover: rgba(${TARKOV_ACCENT_RGB}, .27);
  --zct-accent: ${TARKOV_ACCENT};
  --zct-accent-soft: rgba(${TARKOV_ACCENT_RGB}, .24);
  --zct-on-accent: ${TARKOV_INK};
  --zct-shadow: 0 10px 30px rgba(0, 0, 0, .66);
}

/* The Tarkov block re-reads the accent from the theme's own tokens rather than
   repeating the hex.
 *
 * The injected theme stylesheet publishes --tarkov-accent,
   --tarkov-accent-soft and --color-primary-foreground on <html>, and the service
   re-pushes it whenever the configuration changes. Deriving from those means a
   recoloured palette reaches the dock, the settings centre and the pet's menu
   with no JavaScript at all, and — just as importantly — that this block simply
   does not apply in Monet or Native mode, so a custom accent cannot leak into a
   mode that is not meant to have one.
 *
 * The accent itself needs no feature detection: it is a plain var() with a
 * literal fallback, so it follows a recolour wherever custom properties work at
 * all. The four *derived* values use color-mix(), and those live in their own
 * @supports block rather than as a second declaration beside the literal. That
 * distinction matters and is easy to get wrong: custom properties are not
 * parse-validated, so a later color-mix() declaration would win even in a
 * browser that cannot evaluate it, and the border shorthand that reads the
 * variable would then be invalid at computed-value time and the border would
 * vanish — a worse outcome than keeping the shipped colour. Inside @supports the
 * block is skipped entirely and the literals above stand. */
#${UI_ROOT_ID}[data-zct-theme="tarkov"] {
  --zct-accent: var(--tarkov-accent, ${TARKOV_ACCENT});
  --zct-accent-soft: var(--tarkov-accent-soft, rgba(${TARKOV_ACCENT_RGB}, .24));
  --zct-on-accent: var(--color-primary-foreground, ${TARKOV_INK});
}

@supports (color: color-mix(in srgb, red, blue)) {
  #${UI_ROOT_ID}[data-zct-theme="tarkov"] {
    --zct-border: color-mix(in srgb, var(--zct-accent) 45%, transparent);
    --zct-ctl-bg: color-mix(in srgb, var(--zct-accent) 14%, transparent);
    --zct-ctl-border: color-mix(in srgb, var(--zct-accent) 36%, transparent);
    --zct-ctl-hover: color-mix(in srgb, var(--zct-accent) 27%, transparent);
  }
}

#${UI_ROOT_ID} [hidden] { display: none !important; }

/* Every interactive surface opts back into pointer events. */
#${UI_ROOT_ID} .zct-surface { pointer-events: auto; }

#${UI_ROOT_ID} .zct-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  min-height: 24px;
  padding: 4px 11px;
  border-radius: var(--zct-radius-pill);
  background: var(--zct-ctl-bg);
  border: 1px solid var(--zct-ctl-border);
  color: inherit;
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
  white-space: nowrap;
  transition: background .12s ease, border-color .12s ease;
}
#${UI_ROOT_ID} .zct-btn:hover:not(:disabled) { background: var(--zct-ctl-hover); }
#${UI_ROOT_ID} .zct-btn:disabled { opacity: .45; cursor: default; }
#${UI_ROOT_ID} .zct-btn[data-variant="primary"] {
  background: var(--zct-accent);
  border-color: var(--zct-accent);
  color: var(--zct-on-accent);
  font-weight: 600;
}
#${UI_ROOT_ID} .zct-btn[data-variant="icon"] { padding: 3px 7px; min-width: 26px; }
#${UI_ROOT_ID} .zct-btn[data-state="on"] { border-color: var(--zct-accent); color: var(--zct-accent); }
#${UI_ROOT_ID} button:focus-visible,
#${UI_ROOT_ID} input:focus-visible,
#${UI_ROOT_ID} select:focus-visible,
#${UI_ROOT_ID} [tabindex]:focus-visible {
  outline: 2px solid var(--zct-accent);
  outline-offset: 1px;
}

#${UI_ROOT_ID} .zct-row { display: flex; align-items: center; gap: 8px; margin-bottom: 9px; }
#${UI_ROOT_ID} .zct-row > label { flex: 1; min-width: 0; color: var(--zct-subtle); }
#${UI_ROOT_ID} .zct-row .zct-value { color: var(--zct-text); font-variant-numeric: tabular-nums; }

#${UI_ROOT_ID} input[type="range"] {
  width: 100%; margin: 0; height: 16px; cursor: pointer;
  accent-color: var(--zct-accent);
  background: transparent;
}
#${UI_ROOT_ID} input[type="checkbox"] { accent-color: var(--zct-accent); cursor: pointer; }
#${UI_ROOT_ID} select,
#${UI_ROOT_ID} input[type="text"] {
  width: 100%; padding: 4px 6px; border-radius: var(--zct-radius-sm);
  background: var(--zct-ctl-bg); border: 1px solid var(--zct-ctl-border);
  color: inherit; font: inherit; font-size: 11.5px;
}
#${UI_ROOT_ID} select option { color: #111; }

/* --- sections ----------------------------------------------------------- */
#${UI_ROOT_ID} .zct-section { margin-bottom: 12px; }
#${UI_ROOT_ID} .zct-section > h4 {
  margin: 0 0 7px; font-size: 10.5px; font-weight: 700;
  letter-spacing: 1.1px; text-transform: uppercase; color: var(--zct-accent);
}

/* --- surfaces ----------------------------------------------------------- */
#${UI_ROOT_ID} .zct-card {
  background: var(--zct-bg);
  border: 1px solid var(--zct-border);
  border-radius: var(--zct-radius);
  box-shadow: var(--zct-shadow);
  backdrop-filter: blur(16px);
}

/* --- toast -------------------------------------------------------------- */
#zct-toast {
  position: fixed; right: 62px; bottom: 24px; z-index: ${Z_TOAST};
  max-width: min(360px, calc(100vw - 110px));
  padding: 5px 11px; border-radius: var(--zct-radius-sm);
  background: var(--zct-bg); border: 1px solid var(--zct-border);
  color: var(--zct-text); box-shadow: var(--zct-shadow);
  backdrop-filter: blur(10px);
  font-size: 11px; overflow-wrap: anywhere;
  pointer-events: none; opacity: .97;
}
#zct-toast:empty { display: none; }

/* --- BGM dock ----------------------------------------------------------- */
#zct-dock-fab {
  position: fixed; right: 58px; bottom: 18px; z-index: ${Z_DOCK};
  width: 34px; height: 34px;
  display: flex; align-items: center; justify-content: center;
  border-radius: var(--zct-radius-pill);
  background: var(--zct-bg); border: 1px solid var(--zct-border);
  color: var(--zct-text); cursor: pointer; font-size: 15px; line-height: 1;
  box-shadow: 0 2px 12px rgba(0, 0, 0, .35);
  backdrop-filter: blur(10px);
  user-select: none;
}
#zct-dock-fab:hover { background: var(--zct-ctl-hover); }
#zct-dock-fab[data-playing="1"] { border-color: var(--zct-accent); color: var(--zct-accent); }
#zct-dock-fab[data-locked="1"]::after {
  content: "🔒"; position: absolute; right: -3px; bottom: -3px; font-size: 9px;
}

/* The settings centre's launcher is styled by the panel itself (#zct-panel-fab),
   not here. It sits in the corner the v0.1 panel's button used and keeps that
   button's 38 px geometry, while this dock's launcher is deliberately smaller
   and offset beside it — so the two shapes are defined where each is owned
   rather than forced through one shared rule. */

#zct-dock {
  position: fixed; right: 18px; bottom: 60px; z-index: ${Z_DOCK};
  width: 268px; padding: 10px 12px 11px;
}
#zct-dock-head { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
#zct-dock-title {
  flex: 1; min-width: 0; font-weight: 600; font-size: 12px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
#zct-dock-sub { color: var(--zct-subtle); font-size: 10.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#zct-dock-controls { display: flex; align-items: center; justify-content: center; gap: 6px; margin: 8px 0 6px; }
#zct-dock-progress { display: flex; align-items: center; gap: 7px; color: var(--zct-subtle); font-size: 10px; font-variant-numeric: tabular-nums; }
#zct-dock-progress input[type="range"] { flex: 1; }
#zct-dock-empty { color: var(--zct-subtle); font-size: 11px; line-height: 1.5; text-align: center; padding: 6px 0 2px; }
#zct-dock-empty code { font-family: var(--zct-mono); font-size: 10px; background: var(--zct-ctl-bg); padding: 1px 4px; border-radius: 3px; user-select: text; }
#zct-dock-locked { color: var(--zct-accent); font-size: 11px; text-align: center; padding: 4px 0 2px; }

/* --- pet ---------------------------------------------------------------- */
#zct-pet {
  position: fixed; z-index: ${Z_PET};
  width: 84px; cursor: grab; user-select: none;
  -webkit-user-select: none; touch-action: none;
  filter: drop-shadow(0 6px 14px rgba(0, 0, 0, .55));
  transition: transform .12s ease;
}
#zct-pet:hover { transform: translateY(-2px); }
#zct-pet[data-dragging="1"] { cursor: grabbing; transition: none; }
#zct-pet img, #zct-pet svg { display: block; width: 100%; height: auto; pointer-events: none; }

/* The built-in SVG carries the shipped colours as presentation attributes and
   these classes on top. A CSS rule beats a presentation attribute, so the pet
   takes the live palette whenever the stylesheet is present and still renders
   sensibly if it is not — which is what lets a recoloured accent reach an
   inline illustration without shipping a second copy of it. */
#zct-pet .zct-pet-accent { fill: var(--zct-accent); }
#zct-pet .zct-pet-accent-stroke { stroke: var(--zct-accent); }
#zct-pet .zct-pet-ink { fill: var(--zct-on-accent); }
#zct-pet .zct-pet-ink-stroke { stroke: var(--zct-on-accent); }
#zct-pet .zct-pet-accent-soft-stroke { stroke: var(--zct-accent-soft); }

#zct-pet-menu {
  position: fixed; z-index: ${Z_MENU};
  min-width: 172px; padding: 4px;
  background: var(--zct-bg-solid);
  border: 1px solid var(--zct-border);
  border-radius: var(--zct-radius);
  box-shadow: var(--zct-shadow);
}
#zct-pet-menu .zct-menu-item {
  display: block; width: 100%; padding: 5px 9px;
  border: 0; background: transparent; color: inherit;
  font: inherit; font-size: 11.5px; text-align: left; cursor: pointer;
  border-radius: var(--zct-radius-sm);
}
#zct-pet-menu .zct-menu-item:hover,
#zct-pet-menu .zct-menu-item:focus-visible { background: var(--zct-ctl-hover); outline: none; }
#zct-pet-menu .zct-menu-sep { height: 1px; margin: 4px 2px; background: var(--zct-border); }

/* --- settings centre ---------------------------------------------------- */
#zct-panel {
  position: fixed; right: 18px; bottom: 60px; z-index: 2147483647;
  width: 316px; max-height: min(78vh, 660px);
  display: flex; flex-direction: column;
  padding: 0; overflow: hidden;
}
#zct-panel-head {
  display: flex; align-items: center; gap: 8px;
  padding: 9px 11px; border-bottom: 1px solid var(--zct-border);
  cursor: move; user-select: none; flex: none;
}
#zct-panel-head strong { flex: 1; font-size: 12px; font-weight: 600; letter-spacing: .3px; }
#zct-panel-tabs { display: flex; gap: 2px; padding: 6px 8px 0; flex: none; flex-wrap: wrap; }
#zct-panel-tabs button {
  flex: 1; min-width: 54px; padding: 5px 4px;
  border: 0; border-bottom: 2px solid transparent; background: transparent;
  color: var(--zct-subtle); font: inherit; font-size: 11px; cursor: pointer;
  border-radius: var(--zct-radius-sm) var(--zct-radius-sm) 0 0;
}
#zct-panel-tabs button:hover { color: var(--zct-text); }
#zct-panel-tabs button[aria-selected="true"] {
  color: var(--zct-text); font-weight: 600;
  border-bottom-color: var(--zct-accent);
  background: var(--zct-accent-soft);
}
#zct-panel-body { padding: 11px 12px 12px; overflow-y: auto; flex: 1 1 auto; min-height: 0; }
#zct-panel-body::-webkit-scrollbar { width: 8px; }
#zct-panel-body::-webkit-scrollbar-thumb { background: var(--zct-ctl-border); border-radius: 4px; }
#zct-panel-foot {
  flex: none; padding: 7px 11px; border-top: 1px solid var(--zct-border);
  color: var(--zct-subtle); font-size: 10px;
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
}
#zct-panel-offline {
  display: flex; flex-direction: column; gap: 6px; align-items: center;
  margin: 11px 12px; padding: 10px 12px; text-align: center;
  background: rgba(120, 53, 15, .5); border-radius: var(--zct-radius-sm);
  font-size: 11px; line-height: 1.5;
}
#zct-panel[data-offline="1"] #zct-panel-body { opacity: .45; pointer-events: none; }
#zct-panel[data-offline="1"] #zct-panel-foot { opacity: .5; }

/* --- library list ------------------------------------------------------- */
#zct-tracks { display: flex; flex-direction: column; gap: 2px; max-height: 208px; overflow-y: auto; margin-bottom: 8px; }
#zct-tracks .zct-track {
  display: flex; align-items: center; gap: 6px;
  padding: 3px 5px; border-radius: var(--zct-radius-sm);
}
#zct-tracks .zct-track:hover { background: var(--zct-accent-soft); }
#zct-tracks .zct-track[data-current="1"] { box-shadow: inset 2px 0 0 var(--zct-accent); }
#zct-tracks .zct-track-name {
  flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  cursor: pointer; font-size: 11.5px;
}
#zct-tracks .zct-track[data-disabled="1"] .zct-track-name { opacity: .45; text-decoration: line-through; }
#zct-tracks .zct-track-meta { color: var(--zct-subtle); font-size: 10px; font-variant-numeric: tabular-nums; }
#zct-empty-note { color: var(--zct-subtle); font-size: 11px; line-height: 1.55; margin-bottom: 8px; }
#zct-empty-note code { font-family: var(--zct-mono); font-size: 10px; background: var(--zct-ctl-bg); padding: 1px 3px; border-radius: 3px; user-select: text; }

#zct-upload-bar { height: 3px; border-radius: 2px; background: var(--zct-ctl-bg); overflow: hidden; margin-bottom: 7px; }
#zct-upload-bar > i { display: block; height: 100%; width: 0; background: var(--zct-accent); transition: width .15s ease; }

/* --- system ------------------------------------------------------------- */
#zct-system dl { display: grid; grid-template-columns: auto 1fr; gap: 3px 9px; margin: 0 0 8px; }
#zct-system dt { color: var(--zct-subtle); }
#zct-system dd { margin: 0; overflow-wrap: anywhere; font-family: var(--zct-mono); font-size: 10px; user-select: text; }
#zct-system .zct-warn { color: var(--zct-accent); font-size: 11px; line-height: 1.5; margin-bottom: 7px; }
`.trim();
  }

  // src/client/bgm/dock.ts
  var COLLAPSED_KEY = "zct:dock-collapsed";
  var BgmDock = class {
    constructor(ctx, bgm, options) {
      this.ctx = ctx;
      this.bgm = bgm;
      this.options = options;
    }
    ctx;
    bgm;
    options;
    fab;
    panel;
    unsubState;
    unsubPrefs;
    last;
    seeking = false;
    mount() {
      document.getElementById("zct-dock-fab")?.remove();
      document.getElementById("zct-dock")?.remove();
      const root = this.ctx.uiRoot();
      const fab = document.createElement("button");
      fab.id = "zct-dock-fab";
      fab.type = "button";
      fab.className = "zct-surface";
      fab.title = "Background music";
      fab.setAttribute("aria-label", "Background music");
      fab.setAttribute("aria-expanded", "false");
      fab.textContent = "♫";
      fab.addEventListener("click", () => this.toggle());
      root.appendChild(fab);
      this.fab = fab;
      const panel = document.createElement("div");
      panel.id = "zct-dock";
      panel.className = "zct-card zct-surface";
      panel.hidden = true;
      panel.setAttribute("role", "region");
      panel.setAttribute("aria-label", "Background music");
      panel.innerHTML = this.panelMarkup();
      root.appendChild(panel);
      this.panel = panel;
      this.wirePanel(panel);
      this.unsubState = this.bgm.onState((state) => this.render(state));
      this.unsubPrefs = this.ctx.onPrefs(() => this.render(this.bgm.state()));
      this.render(this.bgm.state());
    }
    destroy() {
      this.unsubState?.();
      this.unsubState = void 0;
      this.unsubPrefs?.();
      this.unsubPrefs = void 0;
      this.fab?.remove();
      this.fab = void 0;
      this.panel?.remove();
      this.panel = void 0;
      this.last = void 0;
    }
    isOpen() {
      return this.panel !== void 0 && !this.panel.hidden;
    }
    open() {
      if (!this.panel) return;
      this.options.onRequestExclusive();
      this.panel.hidden = false;
      this.fab?.setAttribute("aria-expanded", "true");
      this.writeCollapsed(false);
      this.render(this.bgm.state());
      void this.bgm.refresh().catch(() => {
      });
    }
    close() {
      if (!this.panel) return;
      this.panel.hidden = true;
      this.fab?.setAttribute("aria-expanded", "false");
      this.writeCollapsed(true);
    }
    toggle() {
      if (this.isOpen()) this.close();
      else this.open();
    }
    /** Closes the dock without recording that as the user's remembered choice. */
    hideForExclusive() {
      if (!this.panel) return;
      this.panel.hidden = true;
      this.fab?.setAttribute("aria-expanded", "false");
    }
    // --- markup and wiring --------------------------------------------------
    panelMarkup() {
      return `
      <div id="zct-dock-head">
        <span id="zct-dock-title">Background music</span>
        <button class="zct-btn" id="zct-dock-settings" type="button" title="Open settings">⚙</button>
        <button class="zct-btn" id="zct-dock-collapse" type="button" title="Collapse">✕</button>
      </div>
      <div id="zct-dock-sub"></div>
      <div id="zct-dock-locked" hidden>音频已锁定,点击启用</div>
      <div id="zct-dock-empty" hidden>
        还没有音乐。把音频文件放进 <code></code> ,或
        <button class="zct-btn" id="zct-dock-add-inline" type="button">添加音乐</button>
      </div>
      <div id="zct-dock-controls">
        <button class="zct-btn" id="zct-dock-prev" type="button" title="上一首">⏮</button>
        <button class="zct-btn" id="zct-dock-play" type="button" data-variant="primary" title="播放 / 暂停">▶</button>
        <button class="zct-btn" id="zct-dock-next" type="button" title="下一首">⏭</button>
        <button class="zct-btn" id="zct-dock-shuffle" type="button" title="随机播放">⇄</button>
        <button class="zct-btn" id="zct-dock-repeat" type="button" title="重复">↻</button>
        <button class="zct-btn" id="zct-dock-mute" type="button" title="静音">🔇</button>
      </div>
      <div id="zct-dock-progress">
        <span id="zct-dock-time">0:00</span>
        <input type="range" id="zct-dock-seek" min="0" max="1000" step="1" value="0" aria-label="Seek">
        <span id="zct-dock-total">0:00</span>
      </div>
      <div class="zct-row" style="margin:8px 0 0">
        <label for="zct-dock-volume">音量</label>
        <input type="range" id="zct-dock-volume" min="0" max="100" step="1" value="35" aria-label="Volume">
      </div>
      <input type="file" id="zct-dock-file" accept="audio/*" hidden multiple>`;
    }
    wirePanel(panel) {
      const $ = (id) => panel.querySelector(`#${id}`);
      $("zct-dock-settings")?.addEventListener("click", () => {
        this.hideForExclusive();
        this.options.onOpenSettings();
      });
      $("zct-dock-collapse")?.addEventListener("click", () => this.close());
      $("zct-dock-play")?.addEventListener("click", () => {
        if (!this.ctx.audio.unlocked) void this.ctx.audio.tryUnlock().then(() => this.bgm.play());
        else this.bgm.toggle();
      });
      $("zct-dock-prev")?.addEventListener("click", () => this.bgm.prev());
      $("zct-dock-next")?.addEventListener("click", () => this.bgm.next());
      $("zct-dock-shuffle")?.addEventListener("click", () => {
        const state = this.bgm.state();
        this.bgm.setShuffle(!state.shuffle);
      });
      $("zct-dock-repeat")?.addEventListener("click", () => {
        const state = this.bgm.state();
        this.bgm.setRepeat(state.repeat === "all" ? "one" : "all");
      });
      $("zct-dock-mute")?.addEventListener("click", () => {
        const state = this.bgm.state();
        this.bgm.setVolume(state.volume > 0 ? 0 : this.ctx.prefs().audio.bgm.volume || 0.35);
      });
      const seek = $("zct-dock-seek");
      if (seek) {
        seek.addEventListener("pointerdown", () => {
          this.seeking = true;
        });
        seek.addEventListener("pointerup", () => {
          this.seeking = false;
        });
        seek.addEventListener("input", () => this.bgm.seek(Number(seek.value) / 1e3));
      }
      const volume = $("zct-dock-volume");
      volume?.addEventListener("input", () => this.bgm.setVolume(Number(volume.value) / 100));
      volume?.addEventListener("change", () => this.bgm.setVolume(Number(volume.value) / 100));
      const file = $("zct-dock-file");
      const pick = () => file?.click();
      $("zct-dock-add-inline")?.addEventListener("click", pick);
      file?.addEventListener("change", () => {
        const files = file.files ? Array.from(file.files) : [];
        file.value = "";
        for (const f of files) {
          void this.bgm.upload(f).catch((err) => this.ctx.toastError(err, "添加音乐失败"));
        }
      });
      panel.addEventListener("keydown", (ev) => {
        if (ev.key === "Escape") this.close();
      });
    }
    // --- rendering ----------------------------------------------------------
    render(state) {
      this.last = state;
      const panel = this.panel;
      const fab = this.fab;
      if (!panel || !fab) return;
      const prefs = this.ctx.prefs();
      const enabled = prefs.audio.enabled && prefs.audio.bgm.enabled;
      fab.hidden = !enabled;
      if (!enabled) {
        panel.hidden = true;
        return;
      }
      fab.dataset.playing = state.playing ? "1" : "0";
      fab.dataset.locked = state.locked ? "1" : "0";
      fab.title = state.empty ? "Background music — no tracks yet" : `${state.playing ? "Playing" : "Paused"}: ${state.title}`;
      const $ = (id) => panel.querySelector(`#${id}`);
      const title = $("zct-dock-title");
      if (title) title.textContent = state.title || "Background music";
      const sub = $("zct-dock-sub");
      if (sub) {
        sub.textContent = state.empty ? "" : state.tracks.length === 1 ? "1 track" : `${state.tracks.length} tracks${state.shuffle ? " · shuffle" : ""}`;
      }
      const locked = $("zct-dock-locked");
      if (locked) locked.hidden = !state.locked || !state.playing;
      $("zct-dock-empty").hidden = !state.empty;
      const dir = $("zct-dock-empty")?.querySelector("code");
      if (dir && !dir.textContent) {
        void this.ctx.api.getSystem().then((sys) => {
          const music = sys.mediaDirs.find((d) => d.kind === "music");
          if (music && dir) dir.textContent = music.path;
        }).catch(() => {
        });
      }
      const play = $("zct-dock-play");
      if (play) {
        play.textContent = state.playing ? "⏸" : "▶";
        play.title = state.playing ? "Pause" : state.locked ? "Click to enable audio" : "Play";
      }
      const shuffle = $("zct-dock-shuffle");
      if (shuffle) shuffle.dataset.state = state.shuffle ? "on" : "off";
      const repeat = $("zct-dock-repeat");
      if (repeat) {
        repeat.dataset.state = state.repeat === "one" ? "on" : "off";
        repeat.title = state.repeat === "one" ? "Repeat one" : "Repeat all";
      }
      const seek = $("zct-dock-seek");
      if (seek && !this.seeking) {
        const fraction = state.durationSeconds > 0 ? state.positionSeconds / state.durationSeconds : 0;
        seek.value = String(Math.round(Math.min(1, Math.max(0, fraction)) * 1e3));
      }
      const time = $("zct-dock-time");
      if (time) time.textContent = formatTime(state.positionSeconds);
      const total = $("zct-dock-total");
      if (total) total.textContent = state.durationSeconds > 0 ? formatTime(state.durationSeconds) : "--:--";
      const volume = $("zct-dock-volume");
      if (volume && document.activeElement !== volume) volume.value = String(Math.round(state.volume * 100));
      const empty = state.empty;
      for (const id of ["zct-dock-prev", "zct-dock-next", "zct-dock-play", "zct-dock-shuffle", "zct-dock-repeat"]) {
        const btn = $(id);
        if (btn) btn.disabled = empty;
      }
    }
    readCollapsed() {
      try {
        return window.localStorage.getItem(COLLAPSED_KEY) !== "false";
      } catch {
        return true;
      }
    }
    writeCollapsed(collapsed) {
      try {
        window.localStorage.setItem(COLLAPSED_KEY, collapsed ? "true" : "false");
      } catch {
      }
    }
    /** Applies the remembered collapsed state on first mount. */
    applyRememberedState() {
      if (!this.readCollapsed()) this.open();
    }
  };
  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
    const total = Math.floor(seconds);
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    return `${mins}:${String(secs).padStart(2, "0")}`;
  }

  // src/status/pool.ts
  var MAX_PHRASES = 500;
  var MAX_PHRASE_LENGTH = 120;
  var DEFAULT_PHRASES_EN = [
    "Checking the exfil route…",
    "Repacking the tactical rig…",
    "Confirming the supply manifest…",
    "Scanning the workspace…",
    "Trading intel…",
    "Sweeping the sector…",
    "Recalculating the route…",
    "Holding position…",
    "Relaying coordinates…",
    "Cross-checking the inventory…",
    "Assessing the approach…",
    "Warming up the optics…",
    "Sorting recovered items…",
    "Waiting on the next report…",
    "Verifying the perimeter…",
    "Logging the contact…"
  ];
  var DEFAULT_PHRASES_ZH = [
    "正在检查撤离路线……",
    "正在整理战术背包……",
    "正在确认补给清单……",
    "正在扫描工作区……",
    "正在交换情报……",
    "正在搜索区域……",
    "正在重新规划路线……",
    "正在原地待命……",
    "正在传递坐标……",
    "正在核对库存……",
    "正在评估接近路线……",
    "正在调试瞄具……",
    "正在清点回收物资……",
    "正在等待下一份报告……",
    "正在确认周边安全……",
    "正在记录接触情况……"
  ];
  var DEFAULT_POOLS = {
    zh: DEFAULT_PHRASES_ZH,
    en: DEFAULT_PHRASES_EN
  };
  function parsePhrasePool(text) {
    if (typeof text !== "string" || text.length === 0) return [];
    const out = [];
    const seen = /* @__PURE__ */ new Set();
    for (const rawLine of text.split(/\r?\n/)) {
      if (out.length >= MAX_PHRASES) break;
      const line = rawLine.replace(/\uFEFF/g, "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
      if (line.length === 0) continue;
      if (line.startsWith("#")) continue;
      const phrase = line.length > MAX_PHRASE_LENGTH ? line.slice(0, MAX_PHRASE_LENGTH) : line;
      if (seen.has(phrase)) continue;
      seen.add(phrase);
      out.push(phrase);
    }
    return out;
  }
  function defaultPool(language) {
    return [...DEFAULT_POOLS[language] ?? DEFAULT_POOLS.en];
  }
  function resolvePool(language, userFileText) {
    if (typeof userFileText === "string") {
      const parsed = parsePhrasePool(userFileText);
      if (parsed.length > 0) return { phrases: parsed, source: "user" };
    }
    return { phrases: defaultPool(language), source: "bundled" };
  }
  function nextIndex(previous, length, random = Math.random) {
    if (length <= 1) return 0;
    if (previous < 0 || previous >= length) return Math.floor(random() * length) % length;
    const raw = Math.floor(random() * (length - 1));
    const bounded = raw < 0 ? 0 : raw >= length - 1 ? length - 2 : raw;
    return bounded >= previous ? bounded + 1 : bounded;
  }

  // src/client/status/runtime.ts
  var DEFAULT_STATUS_INTERVAL_MS = 12e3;
  var StatusRoller = class {
    constructor(ctx, options) {
      this.ctx = ctx;
      this.options = options;
      this.random = options.random ?? Math.random;
    }
    ctx;
    options;
    phrases = [];
    source = "unknown";
    lastIndex = -1;
    current;
    phase = "idle";
    attached;
    timer = null;
    unsubPrefs;
    random;
    start() {
      this.unsubPrefs = this.ctx.onPrefs(() => this.sync());
      void this.reload().then(() => this.sync());
    }
    dispose() {
      this.unsubPrefs?.();
      this.unsubPrefs = void 0;
      this.detach();
      this.options.anchor.dispose();
      this.phrases = [];
      this.current = void 0;
      this.source = "unknown";
    }
    // --- StatusControl ------------------------------------------------------
    async reload() {
      const prefs = this.ctx.prefs();
      try {
        const result = await this.ctx.api.getStatusPhrases(prefs.status.language);
        const phrases = Array.isArray(result.phrases) ? result.phrases.filter((p) => typeof p === "string") : [];
        this.phrases = phrases;
        this.source = result.source === "user" ? "user" : phrases.length > 0 ? "bundled" : "unknown";
        if (this.phrases.length === 0) this.current = void 0;
        this.roll();
        return this.phrases.length;
      } catch {
        return this.phrases.length;
      }
    }
    poolSource() {
      return this.source;
    }
    currentPhrase() {
      return this.current;
    }
    /** Local fallback pool, used before the first successful fetch. */
    seedLocalPool(language) {
      if (this.phrases.length > 0) return;
      const resolved = resolvePool(language, void 0);
      this.phrases = resolved.phrases;
      this.source = "bundled";
    }
    // --- driven by the signal layer -----------------------------------------
    /** Called whenever the signal layer's phase changes. */
    setPhase(phase) {
      if (phase === this.phase) return;
      this.phase = phase;
      if (phase === "running" || phase === "approval") {
        this.roll();
        this.sync();
      } else {
        this.detach();
      }
    }
    /**
     * Called when the turn made progress (a reasoning step, a tool call).
     *
     * The trigger switches decide whether that is worth a new phrase; the default
     * is yes for all three, which is what makes the text feel alive rather than
     * static.
     */
    onProgress(kind) {
      const prefs = this.ctx.prefs();
      if (prefs.status.triggers[kind] === false) return;
      if (this.phase !== "running" && this.phase !== "approval") return;
      this.roll();
      this.sync();
    }
    // --- internals ----------------------------------------------------------
    /** True when the takeover is allowed right now. */
    active() {
      const prefs = this.ctx.prefs();
      if (!prefs.status.enabled) return false;
      if (this.phase !== "running" && this.phase !== "approval") return false;
      if (this.ctx.theme() !== "tarkov" && !prefs.status.anyTheme) return false;
      return true;
    }
    /** Picks the next phrase, never the one already showing. */
    roll() {
      if (this.phrases.length === 0) return;
      const index = nextIndex(this.lastIndex, this.phrases.length, this.random);
      this.lastIndex = index;
      this.current = this.phrases[index];
    }
    /** Applies or removes the takeover to match the current prefs and phase. */
    sync() {
      if (!this.active()) {
        this.detach();
        return;
      }
      const prefs = this.ctx.prefs();
      if (this.phrases.length === 0) this.seedLocalPool(prefs.status.language);
      if (this.phrases.length === 0 || !this.current) {
        this.detach();
        return;
      }
      const element = this.options.anchor.find();
      if (!element) {
        this.attached = void 0;
        return;
      }
      this.attached = element;
      this.options.anchor.show(element, this.current);
      this.ensureTimer();
    }
    detach() {
      if (this.attached) {
        this.options.anchor.restore(this.attached);
        this.attached = void 0;
      }
      this.clearTimer();
    }
    /**
     * A low-frequency re-roll while a turn is running.
     *
     * ZCode's own status text changes on its own schedule, and there are long
     * stretches — a slow model, a long tool call — where nothing observable
     * happens. Without this the phrase would sit unchanged for a minute and look
     * stuck. The interval is deliberately long: this must not be a poll loop.
     */
    ensureTimer() {
      if (this.timer !== null) return;
      this.timer = setInterval(() => {
        if (!this.active()) {
          this.detach();
          return;
        }
        this.roll();
        const element = this.attached ?? this.options.anchor.find();
        if (element && this.current) {
          this.attached = element;
          this.options.anchor.show(element, this.current);
        }
      }, this.options.intervalMs ?? DEFAULT_STATUS_INTERVAL_MS);
    }
    clearTimer() {
      if (this.timer === null) return;
      clearInterval(this.timer);
      this.timer = null;
    }
  };

  // src/client/status/anchor.ts
  var STATUS_ATTR = "data-zct-status";
  var STATUS_STYLE_ID = "zct-status-style";
  var COMPOSER_ANCHOR = '[data-testid="v4-composer"]';
  var MAX_STRIP_TEXT = 60;
  function isUsableHost(el, composer) {
    if (el.closest("#zct-ui-root")) return false;
    if (el.closest("#zcode-tarkov-banner")) return false;
    if (el.closest("#zcode-beautify-panel-root")) return false;
    if (el.closest('input, textarea, button, [contenteditable="true"]')) return false;
    if (el.id.startsWith("DndLiveRegion")) return false;
    if (el.id === "loading") return false;
    if (el.contains(composer)) return false;
    const text = (el.textContent ?? "").trim();
    if (text.length === 0 || text.length > MAX_STRIP_TEXT) return false;
    return true;
  }
  function resolveStatusStrip(scope = document) {
    const composer = scope.querySelector(COMPOSER_ANCHOR);
    if (!composer) return void 0;
    const leaves = [];
    try {
      for (const el of Array.from(composer.querySelectorAll("*"))) {
        if (el.childElementCount > 0) continue;
        const text = (el.textContent ?? "").trim();
        if (text.length === 0) continue;
        if (el.closest('input, textarea, button, [contenteditable="true"]')) continue;
        leaves.push(el);
      }
    } catch {
      return void 0;
    }
    for (const leaf of leaves) {
      let node = leaf;
      let candidate;
      for (let i = 0; i < 6 && node; i += 1) {
        if (isUsableHost(node, composer)) candidate = node;
        else break;
        node = node.parentElement;
      }
      if (candidate) return candidate;
    }
    return void 0;
  }
  function buildCss() {
    return `
[${STATUS_ATTR}="1"] {
  /* The incoming text is made transparent, not removed: the live region keeps
     its size and its content, so nothing downstream can observe the swap. */
  color: transparent !important;
  position: relative;
}
[${STATUS_ATTR}="1"]::after {
  content: var(--zct-status-phrase, "");
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  color: var(--zct-status-color, inherit);
  font: inherit;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
}
`.trim();
  }
  var CssStatusAnchor = class {
    installed = false;
    find() {
      return resolveStatusStrip(document);
    }
    show(element, phrase) {
      try {
        this.installStyle();
        if (element.getAttribute(STATUS_ATTR) !== "1") element.setAttribute(STATUS_ATTR, "1");
        const quoted = JSON.stringify(phrase);
        if (element.style.getPropertyValue("--zct-status-phrase") !== quoted) {
          element.style.setProperty("--zct-status-phrase", quoted);
        }
      } catch {
      }
    }
    restore(element) {
      try {
        if (element.getAttribute(STATUS_ATTR) !== null) element.removeAttribute(STATUS_ATTR);
        element.style.removeProperty("--zct-status-phrase");
      } catch {
      }
      this.removeStyleIfUnused();
    }
    dispose() {
      try {
        for (const el of Array.from(document.querySelectorAll(`[${STATUS_ATTR}]`))) {
          el.removeAttribute(STATUS_ATTR);
          el.style.removeProperty("--zct-status-phrase");
        }
      } catch {
      }
      document.getElementById(STATUS_STYLE_ID)?.remove();
      this.installed = false;
    }
    installStyle() {
      if (this.installed && document.getElementById(STATUS_STYLE_ID)) return;
      let style = document.getElementById(STATUS_STYLE_ID);
      if (!style) {
        style = document.createElement("style");
        style.id = STATUS_STYLE_ID;
        (document.head ?? document.documentElement).appendChild(style);
      }
      const css = buildCss();
      if (style.textContent !== css) style.textContent = css;
      this.installed = true;
    }
    /** Drops the stylesheet once nothing carries the attribute. */
    removeStyleIfUnused() {
      try {
        if (document.querySelector(`[${STATUS_ATTR}]`)) return;
        document.getElementById(STATUS_STYLE_ID)?.remove();
        this.installed = false;
      } catch {
      }
    }
  };
  function createStatusAnchor() {
    return new CssStatusAnchor();
  }

  // src/client/signals/detect.ts
  var TICK_MS = 400;
  var ACTIVITY_WINDOW_MS = 2500;
  var SAFETY_INTERVAL_MS = 2e3;
  var ACTIVITY_ROOTS = [
    '[data-testid="v4-timeline"]',
    '[data-testid="v4-pane-shell-workspace-main"]',
    "main"
  ];
  var RUNNING_SELECTORS = [
    '[data-testid="v4-stop"]',
    '[data-testid="v4-composer"][data-input-routing="enqueue"]',
    '[data-testid^="v4-turn-navigator-item-"][data-running="true"]',
    '[data-testid="chat-loading"][role="status"]'
  ];
  var APPROVAL_SELECTORS = [
    "[data-permission-option-kind]",
    '[data-testid^="tool-summary-trigger-permission:perm_"]'
  ];
  var ERROR_SELECTORS = [
    '[data-status="error"]',
    '[data-state="error"]',
    '[data-slot="error-banner"]'
  ];
  var TOOL_SELECTORS = ['[data-testid^="chat-tool-call-block-"][data-tool-call-id]'];
  var PROGRESS_SELECTORS = [
    '[data-reasoning-streaming-text="true"]',
    '[data-testid="chat-reasoning-trigger"]'
  ];
  function countMatches(selectors, scope) {
    for (const selector of selectors) {
      try {
        const found = scope.querySelectorAll(selector);
        if (found.length > 0) return found.length;
      } catch {
        continue;
      }
    }
    return 0;
  }
  function anyMatch(selectors, scope) {
    for (const selector of selectors) {
      try {
        if (scope.querySelector(selector)) return true;
      } catch {
        continue;
      }
    }
    return false;
  }
  function findActivityRoot() {
    for (const selector of ACTIVITY_ROOTS) {
      try {
        const el = document.querySelector(selector);
        if (el) return el;
      } catch {
        continue;
      }
    }
    return void 0;
  }
  function createSignalWatcher(options) {
    const tickMs = options.tickMs ?? TICK_MS;
    let observer;
    let timer = null;
    let dirty = true;
    let lastMutationAt = 0;
    let lastSafetySampleAt = 0;
    let lastToolCalls = 0;
    let lastProgress = 0;
    let running = false;
    function sample() {
      const root = document;
      const toolCalls = countMatches(TOOL_SELECTORS, root);
      const progress = countMatches(PROGRESS_SELECTORS, root);
      const approval = anyMatch(APPROVAL_SELECTORS, root);
      const error = anyMatch(ERROR_SELECTORS, root);
      const explicit = anyMatch(RUNNING_SELECTORS, root);
      const recentActivity = Date.now() - lastMutationAt < ACTIVITY_WINDOW_MS;
      running = explicit || recentActivity;
      const observation = {
        running,
        approval,
        error,
        toolCalls,
        progress
      };
      if (toolCalls > lastToolCalls) options.onProgress("tool");
      if (progress > lastProgress) options.onProgress("reasoning");
      lastToolCalls = toolCalls;
      lastProgress = progress;
      return observation;
    }
    function tick() {
      const now = Date.now();
      const due = now - lastSafetySampleAt >= SAFETY_INTERVAL_MS;
      if (!dirty && !due) return;
      dirty = false;
      lastSafetySampleAt = now;
      let observation;
      try {
        observation = sample();
      } catch {
        return;
      }
      try {
        options.onObservation(observation);
      } catch {
      }
    }
    return {
      start() {
        if (timer !== null) return;
        const root = findActivityRoot();
        try {
          if (typeof MutationObserver === "function") {
            observer = new MutationObserver(() => {
              dirty = true;
              lastMutationAt = Date.now();
            });
            observer.observe(root ?? document.documentElement, {
              childList: true,
              subtree: true,
              characterData: true
            });
          }
        } catch {
          observer = void 0;
        }
        timer = setInterval(tick, tickMs);
        tick();
      },
      stop() {
        try {
          observer?.disconnect();
        } catch {
        }
        observer = void 0;
        if (timer !== null) {
          clearInterval(timer);
          timer = null;
        }
      },
      sample
    };
  }

  // src/client/signals/machine.ts
  var DEFAULT_ENTRY_TICKS = 2;
  var DEFAULT_EXIT_TICKS = 2;
  var EventMachine = class {
    entryTicks;
    exitTicks;
    enabled;
    phase = "idle";
    runStreak = 0;
    quietStreak = 0;
    startFired = false;
    doneFired = false;
    errorFired = false;
    approvalLatched = false;
    sawApproval = false;
    taskKey;
    toolCalls = 0;
    progress = 0;
    constructor(options = {}) {
      this.entryTicks = Math.max(1, options.entryTicks ?? DEFAULT_ENTRY_TICKS);
      this.exitTicks = Math.max(1, options.exitTicks ?? DEFAULT_EXIT_TICKS);
      this.enabled = options.enabled ?? {};
    }
    /** The current phase, for the status roller and the settings panel. */
    get current() {
      return this.phase;
    }
    state() {
      return {
        phase: this.phase,
        startFired: this.startFired,
        doneFired: this.doneFired,
        errorFired: this.errorFired,
        approvalLatched: this.approvalLatched,
        taskKey: this.taskKey,
        toolCalls: this.toolCalls,
        progress: this.progress
      };
    }
    /** Resets every latch, as if the session had just loaded. */
    reset() {
      this.phase = "idle";
      this.runStreak = 0;
      this.quietStreak = 0;
      this.startFired = false;
      this.doneFired = false;
      this.errorFired = false;
      this.approvalLatched = false;
      this.sawApproval = false;
      this.taskKey = void 0;
      this.toolCalls = 0;
      this.progress = 0;
    }
    /**
     * Feeds one observation in and returns the events that should sound.
     *
     * Returns an empty array for the overwhelming majority of calls, which is the
     * point.
     */
    update(obs) {
      const events = [];
      if (obs.taskKey !== void 0 && this.taskKey !== void 0 && obs.taskKey !== this.taskKey) {
        this.resetTurnLatches();
      }
      if (obs.taskKey !== void 0) this.taskKey = obs.taskKey;
      if (obs.toolCalls < this.toolCalls) {
        this.toolCalls = obs.toolCalls;
      } else if (obs.toolCalls > this.toolCalls) {
        const delta = obs.toolCalls - this.toolCalls;
        this.toolCalls = obs.toolCalls;
        if (this.phase === "running" || this.phase === "approval") {
          if (delta > 0 && this.isEnabled("tool")) events.push("tool");
        }
      }
      if (obs.progress > this.progress) this.progress = obs.progress;
      if (obs.running) {
        this.runStreak += 1;
        this.quietStreak = 0;
      } else {
        this.quietStreak += 1;
        this.runStreak = 0;
      }
      if (obs.error && !this.errorFired) {
        this.errorFired = true;
        this.phase = "error";
        if (this.isEnabled("error")) events.push("error");
        this.doneFired = true;
        return events;
      }
      if (obs.approval) {
        this.sawApproval = true;
        if (!this.approvalLatched) {
          this.approvalLatched = true;
          this.phase = "approval";
          if (this.isEnabled("approval")) events.push("approval");
        } else if (this.phase === "running" && this.runStreak >= this.entryTicks) {
          this.phase = "approval";
        }
      } else if (this.sawApproval) {
        this.sawApproval = false;
        this.approvalLatched = false;
        if (this.phase === "approval") this.phase = this.runStreak > 0 ? "running" : this.phase;
      }
      if (this.runStreak >= this.entryTicks) {
        const previousTurnOver = !obs.error && (this.doneFired || this.errorFired);
        if (previousTurnOver) this.beginNewTurn();
        if (!this.startFired) {
          this.startFired = true;
          this.phase = "running";
          if (this.isEnabled("start")) events.push("start");
        } else if (this.phase !== "approval") {
          this.phase = "running";
        }
      }
      if (this.quietStreak >= this.exitTicks && this.startFired && !this.doneFired) {
        this.doneFired = true;
        this.phase = "done";
        if (this.isEnabled("done")) events.push("done");
      } else if (this.quietStreak >= this.exitTicks && !this.startFired) {
        this.phase = "idle";
      }
      return events;
    }
    /**
     * Clears the once-per-turn latches so a following turn can sound.
     *
     * The rendered-content counters are deliberately **not** reset. They count
     * elements that exist in the transcript for the rest of the session, so
     * zeroing them would make the very next sample look like a large increase and
     * fire a spurious event for work that had already been reported. A different
     * *task*, by contrast, replaces the transcript, which is why
     * `resetTurnLatches` does clear them.
     */
    beginNewTurn() {
      this.startFired = false;
      this.doneFired = false;
      this.errorFired = false;
      this.approvalLatched = false;
      this.sawApproval = false;
    }
    /** Clears the once-per-turn latches so an already-running task can re-fire. */
    resetTurnLatches() {
      this.startFired = false;
      this.doneFired = false;
      this.errorFired = false;
      this.approvalLatched = false;
      this.sawApproval = false;
      this.runStreak = 0;
      this.quietStreak = 0;
      this.toolCalls = 0;
      this.progress = 0;
      if (this.phase !== "idle") this.phase = "running";
    }
    isEnabled(event) {
      return this.enabled[event] !== false;
    }
  };

  // src/client/sfx/synth.ts
  var LEVELS = {
    start: 0.32,
    approval: 0.4,
    done: 0.34,
    error: 0.36,
    tool: 0.18
  };
  var SFX_SEQUENCES = {
    // Upward two-tone: "channel open".
    start: [
      { from: 587, to: 587, at: 0, duration: 0.055, type: "triangle", level: 1 },
      { from: 880, to: 880, at: 0.07, duration: 0.09, type: "triangle", level: 0.9 }
    ],
    // A repeat pair on one pitch: the universal "needs your attention" shape,
    // deliberately distinct from `start` so the two are never confused.
    approval: [
      { from: 988, to: 988, at: 0, duration: 0.07, type: "triangle", level: 1 },
      { from: 988, to: 988, at: 0.14, duration: 0.07, type: "triangle", level: 1 }
    ],
    // Downward resolution: "done".
    done: [
      { from: 880, to: 880, at: 0, duration: 0.06, type: "triangle", level: 1 },
      { from: 659, to: 659, at: 0.075, duration: 0.12, type: "triangle", level: 0.85 }
    ],
    // Low, slightly detuned descent: wrong, without being an alarm.
    error: [
      { from: 233, to: 208, at: 0, duration: 0.13, type: "triangle", level: 1 },
      { from: 175, to: 147, at: 0.13, duration: 0.16, type: "sine", level: 0.8 }
    ],
    // A single soft tick. The noisiest event and the quietest by design, because
    // it fires once per tool call and is the one users switch off.
    tool: [{ from: 1200, to: 900, at: 0, duration: 0.03, type: "sine", level: 1 }]
  };
  function tone(ctx, destination, step, peak) {
    const start2 = ctx.currentTime + step.at;
    const end = start2 + step.duration;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = step.type;
    osc.frequency.setValueAtTime(step.from, start2);
    if (step.to !== step.from) osc.frequency.linearRampToValueAtTime(step.to, end);
    const level = Math.max(1e-4, peak * step.level);
    gain.gain.setValueAtTime(1e-4, start2);
    gain.gain.linearRampToValueAtTime(level, start2 + 3e-3);
    gain.gain.exponentialRampToValueAtTime(1e-4, end);
    osc.connect(gain);
    gain.connect(destination);
    osc.start(start2);
    osc.stop(end + 0.01);
    osc.onended = () => {
      try {
        osc.disconnect();
        gain.disconnect();
      } catch {
      }
    };
  }
  function noiseTick(ctx, destination, peak, at = 0, duration = 0.03) {
    const frames = Math.max(1, Math.floor(ctx.sampleRate * duration));
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i += 1) {
      const t = i / frames;
      data[i] = (Math.random() * 2 - 1) * (1 - t);
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(2400, ctx.currentTime + at);
    const gain = ctx.createGain();
    const start2 = ctx.currentTime + at;
    const end = start2 + duration;
    gain.gain.setValueAtTime(1e-4, start2);
    gain.gain.linearRampToValueAtTime(Math.max(1e-4, peak), start2 + 2e-3);
    gain.gain.exponentialRampToValueAtTime(1e-4, end);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(destination);
    source.start(start2);
    source.stop(end + 0.01);
    source.onended = () => {
      try {
        source.disconnect();
        filter.disconnect();
        gain.disconnect();
      } catch {
      }
    };
  }
  function playSfx(event, ctx, destination) {
    if (!ctx || !destination) return false;
    if (ctx.state !== "running") return false;
    const steps = SFX_SEQUENCES[event];
    if (!steps || steps.length === 0) return false;
    const peak = LEVELS[event] ?? 0.3;
    try {
      if (event === "tool") noiseTick(ctx, destination, peak);
      for (const step of steps) tone(ctx, destination, step, peak);
      return true;
    } catch {
      return false;
    }
  }

  // src/client/core/lru.ts
  var LruCache = class {
    constructor(maxBytes) {
      this.maxBytes = maxBytes;
    }
    maxBytes;
    map = /* @__PURE__ */ new Map();
    totalBytes = 0;
    get size() {
      return this.map.size;
    }
    get bytes() {
      return this.totalBytes;
    }
    has(key) {
      return this.map.has(key);
    }
    /**
     * Reads an entry, promoting it to most-recently-used.
     *
     * `Map` iterates in insertion order, so the cheapest way to mark recency is to
     * delete and re-insert; that keeps the first key the least recently used
     * without a separate ordering structure.
     */
    get(key) {
      const entry = this.map.get(key);
      if (!entry) return void 0;
      this.map.delete(key);
      this.map.set(key, entry);
      return entry.value;
    }
    /** Reads without promoting; for "can I avoid a fetch?" checks. */
    peek(key) {
      return this.map.get(key)?.value;
    }
    set(key, value, bytes) {
      if (this.map.has(key)) {
        const existing = this.map.get(key);
        this.totalBytes -= existing.bytes;
        this.map.delete(key);
      }
      if (bytes > this.maxBytes) {
        this.map.clear();
        this.totalBytes = 0;
        return;
      }
      this.map.set(key, { value, bytes });
      this.totalBytes += bytes;
      this.evict();
    }
    delete(key) {
      const entry = this.map.get(key);
      if (!entry) return;
      this.map.delete(key);
      this.totalBytes -= entry.bytes;
    }
    clear() {
      this.map.clear();
      this.totalBytes = 0;
    }
    /** Keys from least to most recently used. */
    keys() {
      return [...this.map.keys()];
    }
    evict() {
      while (this.totalBytes > this.maxBytes && this.map.size > 0) {
        const oldest = this.map.keys().next();
        if (oldest.done) return;
        this.delete(oldest.value);
      }
    }
  };

  // src/client/pet/voice.ts
  var AUDIO_EXTENSION = /\.(?:mp3|wav|ogg|oga|m4a|aac|flac|webm|opus)$/i;
  var DECODED_BUDGET_BYTES = 24 * 1024 * 1024;
  var MAX_CONCURRENT_DECODES = 2;
  var MAX_SAME_CLIP_VOICES = 3;
  function pickIndex(previous, length, random = Math.random) {
    if (!Number.isInteger(length) || length <= 0) return -1;
    if (length === 1) return 0;
    const history = Number.isInteger(previous) && previous >= 0 && previous < length ? previous : -1;
    const draw = unitInterval(random());
    const offset = Math.floor(draw * (length - 1));
    return history >= 0 && offset >= history ? offset + 1 : offset;
  }
  var PetVoice = class {
    constructor(ctx) {
      this.ctx = ctx;
    }
    ctx;
    names = [];
    loaded = false;
    lastIndex = -1;
    disposed = false;
    abort = new AbortController();
    buffers = new LruCache(DECODED_BUDGET_BYTES);
    pending = /* @__PURE__ */ new Map();
    voices = /* @__PURE__ */ new Map();
    sources = /* @__PURE__ */ new Set();
    elements = /* @__PURE__ */ new Set();
    get size() {
      return this.names.length;
    }
    /** Re-reads the pool. An unreachable service keeps the last known list. */
    async refresh() {
      try {
        const response = await this.ctx.api.getPool("voice");
        const entries = isRecord(response) ? response.entries : void 0;
        this.names = voiceNames(entries);
        this.loaded = true;
      } catch {
      }
      return this.names.length;
    }
    async maybeSpeak() {
      const audio = this.ctx.prefs().audio;
      if (!audio.enabled || !audio.voice.enabled) return false;
      if (!(Math.random() < audio.voice.chance)) return false;
      return this.speak();
    }
    /**
     * Plays a clip without the chance roll, for the settings panel's test button.
     *
     * The enabled switches are the caller's business here: the point of the test
     * button is to prove the pool and the pipeline work, and a test that refuses
     * to run until every switch is on proves nothing.
     */
    async speak() {
      if (this.disposed) return false;
      const names = await this.ensurePool();
      if (names.length === 0) return false;
      const index = pickIndex(this.lastIndex, names.length);
      this.lastIndex = index;
      return this.play(names[index]);
    }
    /** Stops every voice this instance started and drops the caches. */
    dispose() {
      this.disposed = true;
      try {
        this.abort.abort();
      } catch {
      }
      for (const source of [...this.sources]) {
        try {
          source.stop();
        } catch {
        }
      }
      this.sources.clear();
      for (const element of [...this.elements]) {
        try {
          element.pause();
        } catch {
        }
      }
      this.elements.clear();
      this.voices.clear();
      this.pending.clear();
      this.buffers.clear();
      this.names = [];
      this.loaded = false;
      this.lastIndex = -1;
    }
    async ensurePool() {
      if (!this.loaded) await this.refresh();
      return this.names;
    }
    async play(name) {
      if (this.disposed) return false;
      const context = this.ctx.audio.unlocked ? this.ctx.audio.context : void 0;
      if (context && this.ctx.audio.bus("voice")) {
        const buffer = await this.load(name, context);
        if (!buffer || this.disposed) return false;
        if ((this.voices.get(name) ?? 0) >= MAX_SAME_CLIP_VOICES) return false;
        return this.startSource(name, buffer, context);
      }
      return this.playElement(name);
    }
    /**
     * Decodes a clip, reusing an in-flight decode of the same name.
     *
     * The pending map is also the concurrency limiter: one entry per running
     * decode, so two clicks on different clips can decode while a third waits for
     * the next click instead of piling on.
     */
    load(name, context) {
      const cached = this.buffers.get(name);
      if (cached) return Promise.resolve(cached);
      const inFlight = this.pending.get(name);
      if (inFlight) return inFlight;
      if (this.pending.size >= MAX_CONCURRENT_DECODES) return Promise.resolve(void 0);
      const job = this.decode(name, context).finally(() => {
        this.pending.delete(name);
      });
      this.pending.set(name, job);
      return job;
    }
    async decode(name, context) {
      try {
        const response = await fetch(this.ctx.api.mediaUrl("voice", name), { signal: this.abort.signal });
        if (!response.ok) return void 0;
        const bytes = await response.arrayBuffer();
        const buffer = await context.decodeAudioData(bytes);
        if (this.disposed) return void 0;
        this.buffers.set(name, buffer, buffer.length * buffer.numberOfChannels * 4);
        return buffer;
      } catch {
        return void 0;
      }
    }
    startSource(name, buffer, context) {
      const bus = this.ctx.audio.bus("voice");
      if (!bus) return false;
      if (!this.hold(name)) return false;
      let source;
      try {
        source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(bus);
        source.onended = () => {
          try {
            source.disconnect();
          } catch {
          }
          this.sources.delete(source);
          this.release(name);
        };
        source.start();
      } catch {
        this.release(name);
        return false;
      }
      this.sources.add(source);
      return true;
    }
    /**
     * Plays through an `<audio>` element when the engine has no running context.
     *
     * Still guarded rather than removed: the platform may expose no
     * `AudioContext` at all, and a pet that only clicks silently is worse than
     * one that uses the element path with the element's own volume.
     */
    async playElement(name) {
      let element;
      try {
        element = new Audio(this.ctx.api.mediaUrl("voice", name));
      } catch {
        return false;
      }
      if (!this.hold(name)) return false;
      const audio = this.ctx.prefs().audio;
      element.volume = clamp013(audio.voice.volume * audio.masterVolume);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        this.elements.delete(element);
        this.release(name);
      };
      element.addEventListener("ended", release, { once: true });
      element.addEventListener("error", release, { once: true });
      this.elements.add(element);
      try {
        await element.play();
        return true;
      } catch {
        release();
        return false;
      }
    }
    hold(name) {
      const active = this.voices.get(name) ?? 0;
      if (active >= MAX_SAME_CLIP_VOICES) return false;
      this.voices.set(name, active + 1);
      return true;
    }
    release(name) {
      const active = this.voices.get(name);
      if (active === void 0) return;
      if (active <= 1) this.voices.delete(name);
      else this.voices.set(name, active - 1);
    }
  };
  function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function voiceNames(entries) {
    if (!Array.isArray(entries)) return [];
    const out = [];
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      const name = entry.filename;
      if (typeof name === "string" && AUDIO_EXTENSION.test(name)) out.push(name);
    }
    return out;
  }
  function unitInterval(value) {
    if (!Number.isFinite(value)) return 0;
    return Math.min(0.9999999, Math.max(0, value));
  }
  function clamp013(value) {
    if (!Number.isFinite(value)) return 0;
    return Math.min(1, Math.max(0, value));
  }

  // src/client/pet/pet.ts
  var PET_ID = "zct-pet";
  var PET_MENU_ID = "zct-pet-menu";
  var PET_STATE_KEY = "__zcodeTarkovPet";
  var SURFACE_CLASS = "zct-surface";
  var EDGE_MARGIN = 18;
  var DEFAULT_BOTTOM_CLEARANCE = 84;
  var DRAG_THRESHOLD_PX = 5;
  var IMAGE_EXTENSIONS = [".png", ".webp", ".gif", ".jpg", ".jpeg"];
  var PET_SVG = `<svg viewBox="0 0 96 96" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Tactical companion">
  <path d="M57 30 L68 11" fill="none" stroke="${TARKOV_ACCENT}" class="zct-pet-accent-stroke" stroke-width="3.4" stroke-linecap="round"/>
  <circle cx="70" cy="9" r="4.6" fill="${TARKOV_ACCENT}" class="zct-pet-accent"/>
  <path d="M12 57 C12 30 28 15 48 15 C68 15 84 30 84 57 Z" fill="${TARKOV_ACCENT}" class="zct-pet-accent zct-pet-ink-stroke" stroke="${TARKOV_INK}" stroke-opacity=".45" stroke-width="2"/>
  <path d="M23 35 C29 24 38 19 49 19" fill="none" stroke="${TARKOV_INK}" class="zct-pet-ink-stroke" stroke-opacity=".28" stroke-width="3" stroke-linecap="round"/>
  <path d="M20 56 L76 56 L70 78 C68 85 59 89 48 89 C37 89 28 85 26 78 Z" fill="${TARKOV_INK}" class="zct-pet-ink zct-pet-accent-stroke" stroke="${TARKOV_ACCENT}" stroke-opacity=".45" stroke-width="2"/>
  <rect x="20" y="37" width="56" height="18" rx="9" fill="${TARKOV_INK}" class="zct-pet-ink"/>
  <path d="M28 47 C35 41 43 39 52 39" fill="none" stroke="rgba(${TARKOV_ACCENT_RGB}, .55)" class="zct-pet-accent-soft-stroke" stroke-width="3" stroke-linecap="round"/>
  <circle cx="35" cy="70" r="3.2" fill="${TARKOV_ACCENT}" class="zct-pet-accent"/>
  <path d="M56 68 L68 68 M56 74 L64 74" fill="none" stroke="rgba(${TARKOV_ACCENT_RGB}, .5)" class="zct-pet-accent-soft-stroke" stroke-width="2.4" stroke-linecap="round"/>
</svg>`;
  var Pet = class {
    /**
     * `voice` is an injection seam, not a copy of the context: a caller that
     * already owns a voice hands it in so one implementation is shared, and it is
     * checked rather than trusted because the wiring that passes it is not typed.
     * `opts` is third so a caller can reach it without naming a voice.
     */
    constructor(ctx, voice, opts = {}) {
      this.ctx = ctx;
      this.opts = opts;
      this.injectedVoice = isPetVoice(voice) ? voice : void 0;
    }
    ctx;
    opts;
    el;
    menu;
    pos;
    imageName;
    brokenImage;
    drag;
    suppressClick = false;
    unsubscribePrefs;
    injectedVoice;
    voiceInstance;
    petImageCheck;
    disposers = [];
    menuDisposers = [];
    /**
     * Creates the DOM and subscribes to prefs. Idempotent.
     *
     * The stale-node sweep runs even when this instance was never mounted: an
     * injection that died before it could clean up leaves its nodes behind, and
     * the global it would have been found through is gone.
     */
    mount() {
      const previous = petGlobal();
      if (isDestroyable(previous) && previous !== this) {
        try {
          previous.destroy();
        } catch {
        }
      }
      setPetGlobal(this);
      if (this.el?.isConnected) {
        this.applyPrefs(this.ctx.prefs());
        return;
      }
      document.getElementById(PET_ID)?.remove();
      document.getElementById(PET_MENU_ID)?.remove();
      const el = document.createElement("div");
      el.id = PET_ID;
      el.className = SURFACE_CLASS;
      this.listen(el, "pointerdown", this.onPointerDown);
      this.listen(el, "pointermove", this.onPointerMove);
      this.listen(el, "pointerup", this.onPointerUp);
      this.listen(el, "pointercancel", this.onPointerCancel);
      this.listen(el, "lostpointercapture", this.onLostPointerCapture);
      this.listen(el, "contextmenu", this.onContextMenu);
      this.listen(el, "click", this.onClick);
      this.host().appendChild(el);
      this.el = el;
      this.render();
      this.applyPrefs(this.ctx.prefs());
      this.unsubscribePrefs = this.ctx.onPrefs((prefs) => {
        this.applyPrefs(prefs);
        void this.refreshPetImage();
      });
      this.listenWindow("resize", this.onWindowResize);
      void this.refreshPetImage();
    }
    /** Removes every node, listener, subscription and cache this instance owns. */
    destroy() {
      this.closeMenu();
      this.unsubscribePrefs?.();
      this.unsubscribePrefs = void 0;
      for (const dispose of this.disposers.splice(0)) {
        try {
          dispose();
        } catch {
        }
      }
      this.el?.remove();
      this.el = void 0;
      this.drag = void 0;
      this.suppressClick = false;
      this.pos = void 0;
      if (!this.injectedVoice) this.voiceInstance?.dispose();
      this.voiceInstance = void 0;
      clearPetGlobal(this);
    }
    resetPosition() {
      this.place(this.defaultPosition());
      void this.savePosition();
    }
    /**
     * Re-reads both pools the pet draws on.
     *
     * The image list is included because a user who just dropped a new picture
     * into `pet/` expects the pet to change, and this method is the only refresh
     * the settings panel has for either kind.
     */
    async refreshVoicePool() {
      await this.refreshPetImage();
      return this.voice.refresh();
    }
    voicePoolSize() {
      return this.voiceInstance?.size ?? 0;
    }
    // --- appearance -----------------------------------------------------------
    get voice() {
      this.voiceInstance ??= this.injectedVoice ?? new PetVoice(this.ctx);
      return this.voiceInstance;
    }
    /** The element the pet is parented to: the shared root, or a live stand-in. */
    host() {
      const root = this.ctx.uiRoot();
      if (root.isConnected) return root;
      return document.getElementById(UI_ROOT_ID) ?? document.body;
    }
    render() {
      const el = this.el;
      if (!el) return;
      const name = this.imageName && this.imageName !== this.brokenImage ? this.imageName : void 0;
      if (!name) {
        el.innerHTML = PET_SVG;
        return;
      }
      const img = document.createElement("img");
      img.alt = "";
      img.draggable = false;
      img.addEventListener("load", () => this.reclamp(), { once: true });
      img.addEventListener("error", () => this.onImageError(name), { once: true });
      img.src = this.ctx.api.mediaUrl("pet", name);
      el.replaceChildren(img);
    }
    /**
     * Marks a failed image and falls back to the drawing.
     *
     * The name is remembered so that a prefs event a second later does not retry
     * a request that is known to fail; a successful refresh clears it, which is
     * how a replaced file gets another chance.
     */
    onImageError(name) {
      if (this.imageName !== name) return;
      this.brokenImage = name;
      this.render();
    }
    /**
     * Reads the `pet/` pool and picks the user's image, if any.
     *
     * Coalesced: the prefs stream can fire many times in a row, and each check is
     * an HTTP round trip for a list that changes only when the user edits the
     * folder.
     */
    refreshPetImage() {
      this.petImageCheck ??= this.readPetPool().finally(() => {
        this.petImageCheck = void 0;
      });
      return this.petImageCheck;
    }
    async readPetPool() {
      try {
        const response = await this.ctx.api.getPool("pet");
        const entries = isRecord2(response) ? response.entries : void 0;
        const next = pickPetImage(poolNames(entries));
        const wasBroken = this.brokenImage !== void 0;
        this.brokenImage = void 0;
        if (next !== this.imageName || wasBroken) {
          this.imageName = next;
          this.render();
        }
      } catch {
      }
    }
    applyPrefs(prefs) {
      const el = this.el;
      if (!el) return;
      const pet = prefs.pet;
      el.style.width = `${pet.scale}px`;
      el.style.opacity = String(pet.opacity);
      if (!pet.enabled) {
        this.closeMenu();
        el.hidden = true;
        return;
      }
      el.hidden = false;
      if (this.drag) return;
      const stored = pet.position;
      const external = stored !== void 0 && (this.pos === void 0 || stored.x !== this.pos.x || stored.y !== this.pos.y);
      if (external && stored !== void 0) this.place(stored);
      else this.place(this.pos ?? this.defaultPosition());
    }
    /** The built-in corner: bottom-left, which is the side the dock is not on. */
    defaultPosition() {
      if (typeof window === "undefined") return { x: EDGE_MARGIN, y: EDGE_MARGIN };
      const size = this.size();
      return { x: EDGE_MARGIN, y: window.innerHeight - size.height - DEFAULT_BOTTOM_CLEARANCE };
    }
    size() {
      const width = this.el?.offsetWidth ?? 0;
      const height = this.el?.offsetHeight ?? 0;
      if (width > 0 && height > 0) return { width, height };
      const fallback = this.ctx.prefs().pet.scale;
      return { width: width > 0 ? width : fallback, height: height > 0 ? height : fallback };
    }
    /**
     * Moves the pet to a top-left, clamped so it stays fully visible.
     *
     * The clamp is asymmetric at the top: the banner is fixed over the top of the
     * window, so `--zcode-tarkov-banner-height` is a real inset and the pet's top
     * edge starts below it. A viewport smaller than the pet still resolves to the
     * margins rather than to a negative position, which is what keeps the pet
     * reachable on a tiny window.
     */
    place(target) {
      const el = this.el;
      if (!el || typeof window === "undefined") return;
      const size = this.size();
      const top = bannerInset() + EDGE_MARGIN;
      const x = Math.round(clamp(target.x, EDGE_MARGIN, window.innerWidth - size.width - EDGE_MARGIN));
      const y = Math.round(clamp(target.y, top, window.innerHeight - size.height - EDGE_MARGIN));
      this.pos = { x, y };
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
    }
    reclamp() {
      if (!this.el || this.el.hidden) return;
      this.place(this.pos ?? this.defaultPosition());
    }
    savePosition() {
      const pos = this.pos;
      if (!pos) return Promise.resolve();
      return this.ctx.patchPrefs({ pet: { position: { x: pos.x, y: pos.y } } }).then(() => void 0).catch(() => {
      });
    }
    // --- pointer --------------------------------------------------------------
    onPointerDown = (ev) => {
      this.suppressClick = false;
      if (ev.button === 2) {
        ev.preventDefault();
        this.openMenu(ev.clientX, ev.clientY);
        return;
      }
      if (ev.button !== 0 || !this.el) return;
      ev.preventDefault();
      const origin = this.pos ?? this.defaultPosition();
      this.drag = {
        pointerId: ev.pointerId,
        startX: ev.clientX,
        startY: ev.clientY,
        originX: origin.x,
        originY: origin.y,
        moved: false
      };
      try {
        this.el.setPointerCapture(ev.pointerId);
      } catch {
      }
    };
    onPointerMove = (ev) => {
      const drag = this.drag;
      if (!drag || drag.pointerId !== ev.pointerId) return;
      const dx = ev.clientX - drag.startX;
      const dy = ev.clientY - drag.startY;
      if (!drag.moved) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        drag.moved = true;
        if (this.el) this.el.dataset.dragging = "1";
        window.getSelection()?.removeAllRanges();
      }
      this.place({ x: drag.originX + dx, y: drag.originY + dy });
    };
    onPointerUp = (ev) => {
      if (!this.drag || this.drag.pointerId !== ev.pointerId) return;
      this.endDrag();
    };
    onPointerCancel = (ev) => {
      if (!this.drag || this.drag.pointerId !== ev.pointerId) return;
      this.endDrag();
    };
    onLostPointerCapture = (ev) => {
      if (!this.drag || this.drag.pointerId !== ev.pointerId) return;
      this.endDrag();
    };
    /**
     * Ends the gesture from whichever event closed it.
     *
     * `pointerup`, `pointercancel` and `lostpointercapture` all run through here,
     * so the drag flag, the `data-dragging` marker and the capture are cleared
     * exactly once even when the browser fires two of them for one gesture.
     */
    endDrag() {
      const drag = this.drag;
      if (!drag) return;
      this.drag = void 0;
      const el = this.el;
      if (el) {
        delete el.dataset.dragging;
        try {
          el.releasePointerCapture(drag.pointerId);
        } catch {
        }
      }
      if (!drag.moved) return;
      this.suppressClick = true;
      void this.savePosition();
    }
    onClick = (ev) => {
      ev.preventDefault();
      if (this.suppressClick) {
        this.suppressClick = false;
        return;
      }
      void this.speakOnClick();
    };
    onContextMenu = (ev) => {
      ev.preventDefault();
      if (!this.menu) this.openMenu(ev.clientX, ev.clientY);
    };
    async speakOnClick() {
      const prefs = this.ctx.prefs();
      if (!prefs.pet.voiceOnClick || !prefs.audio.enabled || !prefs.audio.voice.enabled) return;
      if (!this.ctx.audio.unlocked) await this.ctx.audio.tryUnlock();
      await this.voice.maybeSpeak();
    }
    // --- context menu ---------------------------------------------------------
    /**
     * Opens the pet menu at a viewport point.
     *
     * The menu is opened from `pointerdown`, not after `pointerup`: the pet
     * captures the pointer for a left drag, and anything that waited for the click
     * would be retargeted to the pet and lost. Its own listeners live on the menu
     * element and on the document, so no part of it depends on the pet's capture.
     */
    openMenu(x, y) {
      this.closeMenu();
      const menu = document.createElement("div");
      menu.id = PET_MENU_ID;
      menu.className = SURFACE_CLASS;
      menu.setAttribute("role", "menu");
      for (const entry of this.menuEntries()) {
        if ("separator" in entry) {
          const sep = document.createElement("div");
          sep.className = "zct-menu-sep";
          menu.appendChild(sep);
          continue;
        }
        const item = document.createElement("button");
        item.type = "button";
        item.className = "zct-menu-item";
        item.setAttribute("role", "menuitem");
        item.dataset.action = entry.action;
        item.textContent = entry.label;
        menu.appendChild(item);
      }
      this.host().appendChild(menu);
      const rect = menu.getBoundingClientRect();
      menu.style.left = `${Math.round(clamp(x, EDGE_MARGIN, window.innerWidth - rect.width - EDGE_MARGIN))}px`;
      menu.style.top = `${Math.round(clamp(y, EDGE_MARGIN, window.innerHeight - rect.height - EDGE_MARGIN))}px`;
      this.menu = menu;
      menu.addEventListener("click", this.onMenuClick);
      this.menuDisposers.push(() => menu.removeEventListener("click", this.onMenuClick));
      document.addEventListener("pointerdown", this.onMenuPointerDown, true);
      this.menuDisposers.push(() => document.removeEventListener("pointerdown", this.onMenuPointerDown, true));
      document.addEventListener("keydown", this.onMenuKeyDown, true);
      this.menuDisposers.push(() => document.removeEventListener("keydown", this.onMenuKeyDown, true));
    }
    closeMenu() {
      for (const dispose of this.menuDisposers.splice(0)) {
        try {
          dispose();
        } catch {
        }
      }
      this.menu?.remove();
      this.menu = void 0;
    }
    menuEntries() {
      const voiceOn = this.ctx.prefs().pet.voiceOnClick;
      return [
        { label: voiceOn ? "Mute pet voice" : "Unmute pet voice", action: "voice" },
        { label: "Hide pet", action: "hide" },
        { label: "Reset position", action: "reset" },
        { separator: true },
        { label: "Open pet settings", action: "settings" }
      ];
    }
    onMenuClick = (ev) => {
      const target = ev.target;
      if (!(target instanceof Element)) return;
      const button2 = target.closest(".zct-menu-item");
      const action = button2?.dataset.action;
      if (!action) return;
      ev.preventDefault();
      this.closeMenu();
      if (action === "voice") void this.toggleVoice();
      else if (action === "hide") void this.hidePet();
      else if (action === "reset") this.resetPosition();
      else if (action === "settings") this.openSettings();
    };
    onMenuPointerDown = (ev) => {
      const target = ev.target;
      if (this.menu && target instanceof Node && this.menu.contains(target)) return;
      this.closeMenu();
    };
    onMenuKeyDown = (ev) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      this.closeMenu();
    };
    openSettings() {
      const open = this.opts.onOpenSettings;
      if (!open) return;
      try {
        open();
      } catch {
      }
    }
    async toggleVoice() {
      const next = !this.ctx.prefs().pet.voiceOnClick;
      try {
        await this.ctx.patchPrefs({ pet: { voiceOnClick: next } });
      } catch (err) {
        this.ctx.toastError(err, "Could not save the pet voice setting");
      }
    }
    async hidePet() {
      try {
        await this.ctx.patchPrefs({ pet: { enabled: false } });
      } catch (err) {
        this.ctx.toastError(err, "Could not hide the pet");
      }
    }
    onWindowResize = () => {
      this.closeMenu();
      this.reclamp();
    };
    // --- plumbing -------------------------------------------------------------
    listen(target, type, handler) {
      target.addEventListener(type, handler);
      this.disposers.push(() => target.removeEventListener(type, handler));
    }
    listenWindow(type, handler) {
      window.addEventListener(type, handler);
      this.disposers.push(() => window.removeEventListener(type, handler));
    }
  };
  function bannerInset() {
    try {
      const raw = getComputedStyle(document.documentElement).getPropertyValue("--zcode-tarkov-banner-height");
      const value = Number.parseFloat(raw);
      return Number.isFinite(value) && value > 0 ? value : 0;
    } catch {
      return 0;
    }
  }
  function clamp(value, min, max) {
    if (!Number.isFinite(value)) return min;
    const ceiling = Math.max(min, max);
    return Math.min(Math.max(value, min), ceiling);
  }
  function isRecord2(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function isPetVoice(value) {
    if (!isRecord2(value)) return false;
    return typeof value.refresh === "function" && typeof value.maybeSpeak === "function" && typeof value.speak === "function" && typeof value.dispose === "function";
  }
  function poolNames(entries) {
    if (!Array.isArray(entries)) return [];
    const out = [];
    for (const entry of entries) {
      if (!isRecord2(entry)) continue;
      const name = entry.filename;
      if (typeof name !== "string") continue;
      const lower = name.toLowerCase();
      if (IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext))) out.push(name);
    }
    return out;
  }
  function pickPetImage(names) {
    for (const ext of IMAGE_EXTENSIONS) {
      const match = names.find((name) => name.toLowerCase().endsWith(ext));
      if (match) return match;
    }
    return void 0;
  }
  function petGlobal() {
    try {
      return window[PET_STATE_KEY];
    } catch {
      return void 0;
    }
  }
  function setPetGlobal(value) {
    try {
      window[PET_STATE_KEY] = value;
    } catch {
    }
  }
  function clearPetGlobal(value) {
    try {
      const global = window;
      if (global[PET_STATE_KEY] === value) delete global[PET_STATE_KEY];
    } catch {
    }
  }
  function isDestroyable(value) {
    if (!isRecord2(value)) return false;
    return typeof value.destroy === "function";
  }

  // src/client/core/context.ts
  function errorMessage(err, fallback) {
    if (err instanceof Error && err.message) return err.message;
    if (typeof err === "string" && err.length > 0) return err;
    return fallback;
  }

  // src/themes/tarkov.ts
  var TARKOV_GREETING = {
    line1: "注意！这是“ZCode”的Beta测试版本。",
    line2: "Beta测试版本不代表本产品的最终质量。感谢您的理解和支持，祝你好运！"
  };
  var DEFAULT_GREETING = {
    line1: TARKOV_GREETING.line1,
    line2: TARKOV_GREETING.line2
  };

  // src/prefs/types.ts
  var SFX_EVENTS = ["start", "approval", "done", "error", "tool"];
  var BANNER_MODES = ["off", "compact", "full"];
  var COLOR_MODES = ["monet", "tarkov", "native"];
  var WALLPAPER_FITS = ["cover", "contain", "smart"];
  var STATUS_LANGUAGES = ["zh", "en"];
  var STATUS_TRIGGERS = ["reasoning", "tool", "progress"];
  var PREFS_VERSION = 2;

  // src/prefs/defaults.ts
  var DEFAULT_BANNER_TEXT = {
    line1: "ATTENTION! ZCODE TACTICAL INTERFACE ACTIVE",
    line2: "Experimental interface. Verify your task, tool calls and working tree before deployment."
  };
  function defaultBanner() {
    return {
      // v0.1 always showed the band; v0.2 keeps that as the default, and the
      // switch exists so a user who finds it noisy can remove it completely.
      mode: "full",
      text1: DEFAULT_BANNER_TEXT.line1,
      text2: DEFAULT_BANNER_TEXT.line2,
      height: 56,
      opacity: 0.92
    };
  }
  function defaultPrefs() {
    return {
      version: PREFS_VERSION,
      appearance: {
        colorMode: "tarkov",
        wallpaperVisible: false,
        blur: 0,
        dim: 22,
        fit: "cover",
        wallpaperPath: void 0,
        banner: defaultBanner(),
        // The shipped colours. While these two are unchanged the theme renders the
        // hand-tuned palette byte-for-byte; a derivation only runs once the user
        // actually picks a colour, so upgrading cannot shift anyone's theme.
        background: TARKOV_BACKGROUND,
        accent: TARKOV_ACCENT,
        greeting: {
          enabled: true,
          line1: DEFAULT_GREETING.line1,
          line2: DEFAULT_GREETING.line2
        }
      },
      audio: {
        enabled: true,
        masterVolume: 0.7,
        bgm: {
          enabled: true,
          volume: 0.35,
          shuffle: true,
          repeat: "all",
          trackId: void 0,
          disabledTracks: []
        },
        sfx: {
          enabled: true,
          volume: 0.55,
          // Every event starts on; `tool` is the noisy one and can be switched off
          // from the panel without touching the other four.
          events: { start: true, approval: true, done: true, error: true, tool: true }
        },
        voice: {
          enabled: true,
          volume: 0.75,
          chance: 1
        }
      },
      pet: {
        enabled: true,
        scale: 84,
        opacity: 0.95,
        position: void 0,
        voiceOnClick: true
      },
      status: {
        // Off by default, unlike every other subsystem, and for a specific
        // reason rather than caution in general: ZCode 3.12.3 exposes no stable
        // handle on the element that carries the running status text, so the
        // takeover resolves it structurally and cannot be proven safe on every
        // build. A feature that might not act is better shipped off, labelled in
        // the settings centre, and turned on deliberately — the alternative is a
        // silent no-op that users report as a bug. See
        // docs/dev/zcode-runtime-signals.md §3.6.
        enabled: false,
        language: "zh",
        triggers: { reasoning: true, tool: true, progress: true },
        anyTheme: false
      }
    };
  }

  // src/client/ui/panel.ts
  var PANEL_ID = "zct-panel";
  var FAB_ID = "zct-panel-fab";
  var PANEL_BODY_ID = "zct-panel-body";
  var Z_PANEL = 2147483647;
  var SLIDER_WRITE_MS = 250;
  var POLL_MS = 4e3;
  var MAX_WALLPAPER_BYTES = 20 * 1024 * 1024;
  var OFFLINE_FALLBACK = "无法连接 ZCode Tarkov 服务";
  var GREETING_LINE1_MAX = 240;
  var GREETING_LINE2_MAX = 400;
  var TABS = [
    { id: "appearance", label: "外观" },
    { id: "audio", label: "音频" },
    { id: "pet", label: "宠物" },
    { id: "status", label: "状态" },
    { id: "system", label: "系统" }
  ];
  var COLOR_MODE_LABELS = {
    monet: "Monet · 壁纸取色",
    tarkov: "Tarkov · 战术界面",
    native: "Native · ZCode 原生"
  };
  var BANNER_LABELS = {
    off: "关闭",
    compact: "细状态条",
    full: "完整警告条"
  };
  var FIT_LABELS = {
    cover: "填满裁剪",
    contain: "完整显示",
    smart: "智能适配"
  };
  var LANGUAGE_LABELS = {
    zh: "中文",
    en: "English"
  };
  var SFX_LABELS = {
    start: "任务开始",
    approval: "等待批准",
    done: "任务完成",
    error: "发生错误",
    tool: "工具调用"
  };
  var TRIGGER_LABELS = {
    reasoning: "推理中",
    tool: "工具调用",
    progress: "进度更新"
  };
  var idSeq = 0;
  function uid(prefix) {
    idSeq += 1;
    return `${prefix}-${idSeq}`;
  }
  function make(tag, className, content) {
    const node = document.createElement(tag);
    if (className !== void 0) node.className = className;
    if (content !== void 0) node.textContent = content;
    return node;
  }
  function button(label, variant) {
    const node = make("button", "zct-btn");
    node.type = "button";
    if (variant !== void 0) node.dataset.variant = variant;
    node.textContent = label;
    return node;
  }
  function makeSection(title) {
    const root = make("div", "zct-section");
    const body = make("div");
    root.append(make("h4", void 0, title), body);
    return { root, body };
  }
  function sliderRow(labelText, min, max, step, initial, format) {
    const id = uid("zct-slider");
    const root = make("div");
    const head = make("div", "zct-row");
    const label = make("label", void 0, labelText);
    label.htmlFor = id;
    const readout = make("span", "zct-value", format(initial));
    head.append(label, readout);
    const line = make("div", "zct-row");
    const input = make("input");
    input.type = "range";
    input.id = id;
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(initial);
    line.appendChild(input);
    root.append(head, line);
    return { root, input, readout };
  }
  function colorRow(labelText, initial) {
    const id = uid("zct-color");
    const root = make("div", "zct-row");
    const label = make("label", void 0, labelText);
    label.htmlFor = id;
    const readout = make("span", "zct-value", initial);
    const input = make("input");
    input.type = "color";
    input.id = id;
    input.value = initial;
    input.style.width = "44px";
    input.style.height = "22px";
    input.style.padding = "0";
    input.style.flex = "none";
    input.style.background = "var(--zct-ctl-bg)";
    input.style.border = "1px solid var(--zct-ctl-border)";
    input.style.borderRadius = "var(--zct-radius-sm)";
    root.append(label, readout, input);
    return { root, input, readout };
  }
  function textRow(labelText, initial, maxLength) {
    const id = uid("zct-text");
    const root = make("div");
    const head = make("div", "zct-row");
    const label = make("label", void 0, labelText);
    label.htmlFor = id;
    const counter = make("span", "zct-value", asCount(initial, maxLength));
    head.append(label, counter);
    const input = make("input");
    input.type = "text";
    input.id = id;
    input.maxLength = maxLength;
    input.value = initial;
    root.append(head, input);
    return { root, input, counter };
  }
  function checkboxRow(labelText, checked, title) {
    const id = uid("zct-check");
    const root = make("div", "zct-row");
    const input = make("input");
    input.type = "checkbox";
    input.id = id;
    input.checked = checked;
    if (title !== void 0) input.title = title;
    const label = make("label", void 0, labelText);
    label.htmlFor = id;
    root.append(label, input);
    return { root, input };
  }
  function selectRow(labelText, options, selected) {
    const id = uid("zct-select");
    const root = make("div");
    const head = make("div", "zct-row");
    const label = make("label", void 0, labelText);
    label.htmlFor = id;
    head.appendChild(label);
    const line = make("div", "zct-row");
    const select = make("select");
    select.id = id;
    for (const option of options) {
      const node = make("option", void 0, option.label);
      node.value = option.value;
      select.appendChild(node);
    }
    select.value = selected;
    line.appendChild(select);
    root.append(head, line);
    return { root, select };
  }
  function asPixels(value) {
    return `${Math.round(value)} px`;
  }
  function asPercent(value) {
    return `${Math.round(value * 100)} %`;
  }
  function asCount(value, maxLength) {
    return `${value.length} / ${maxLength}`;
  }
  function formatClock(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
    const total = Math.floor(seconds);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
  }
  function formatUptime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "未知";
    const total = Math.floor(seconds);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor(total % 3600 / 60);
    if (hours > 0) return `${hours} 小时 ${minutes} 分钟`;
    if (minutes > 0) return `${minutes} 分 ${total % 60} 秒`;
    return `${total} 秒`;
  }
  function clamp2(value, min, max) {
    if (!Number.isFinite(value)) return min;
    return Math.min(max, Math.max(min, value));
  }
  function orDefault(value, fallback) {
    return value.trim().length > 0 ? value : fallback;
  }
  function oneOf(value, allowed) {
    return typeof value === "string" && allowed.includes(value) ? value : void 0;
  }
  function readNumber(source, key) {
    const value = source[key];
    return typeof value === "number" && Number.isFinite(value) ? value : void 0;
  }
  function readString(source, key) {
    const value = source[key];
    return typeof value === "string" ? value : void 0;
  }
  function readBoolean(source, key) {
    const value = source[key];
    return typeof value === "boolean" ? value : void 0;
  }
  function panelWindow() {
    return window;
  }
  var SettingsPanel = class {
    constructor(ctx, controls, opts = {}) {
      this.ctx = ctx;
      this.controls = controls;
      this.opts = opts;
    }
    ctx;
    controls;
    opts;
    defaults = defaultPrefs();
    nodes;
    disposers = [];
    /** Listeners on elements a track-list rebuild discards, released on rebuild. */
    transientDisposers = [];
    alive = false;
    offline = false;
    pollTimer = null;
    writeTimer = null;
    pendingWrite;
    lastWriteAt = 0;
    /** The slider a pointer or key is currently driving; refreshes skip it. */
    activeInput;
    activeTab = "appearance";
    lastBgm;
    lastSystem;
    lastStatus;
    trackFingerprint = "";
    emptyNoteKey = "";
    drag;
    // --- lifecycle ------------------------------------------------------------
    mount() {
      this.removeStale();
      if (this.nodes) return;
      const previous = panelWindow().__zcodeTarkovPanel;
      if (previous && previous !== this) {
        try {
          previous.destroy();
        } catch {
        }
      }
      const root = this.uiRoot();
      if (!root) return;
      this.alive = true;
      const nodes = this.build();
      this.nodes = nodes;
      root.appendChild(nodes.fab);
      root.appendChild(nodes.panel);
      this.disposers.push(
        this.ctx.onPrefs((prefs2) => {
          if (!this.alive) return;
          try {
            this.applyPrefs(prefs2);
          } catch (err) {
            this.ctx.toastError(err, "界面刷新失败");
          }
        })
      );
      this.disposers.push(
        this.controls.bgm.onState((state) => {
          if (!this.alive) return;
          try {
            this.applyBgm(state);
          } catch (err) {
            this.ctx.toastError(err, "界面刷新失败");
          }
        })
      );
      this.disposers.push(
        this.ctx.audio.onUnlock(() => {
          if (this.alive) this.syncAudio();
        })
      );
      const prefs = this.readPrefs();
      if (prefs) this.applyPrefs(prefs);
      const bgm = this.readBgmState();
      if (bgm) this.applyBgm(bgm);
      this.selectTab(this.activeTab);
      this.syncAudio();
      this.syncStatus();
      this.renderSystem();
      panelWindow().__zcodeTarkovPanel = this;
    }
    destroy() {
      this.alive = false;
      for (const dispose of this.disposers.splice(0)) {
        try {
          dispose();
        } catch {
        }
      }
      this.stopPolling();
      this.clearTransient();
      if (this.writeTimer !== null) {
        window.clearTimeout(this.writeTimer);
        this.writeTimer = null;
      }
      this.pendingWrite = void 0;
      this.activeInput = void 0;
      this.drag = void 0;
      this.offline = false;
      this.lastBgm = void 0;
      this.lastSystem = void 0;
      this.lastStatus = void 0;
      this.trackFingerprint = "";
      this.emptyNoteKey = "";
      const nodes = this.nodes;
      this.nodes = void 0;
      if (nodes) {
        nodes.fab.remove();
        nodes.panel.remove();
      }
      if (panelWindow().__zcodeTarkovPanel === this) panelWindow().__zcodeTarkovPanel = void 0;
    }
    open() {
      if (!this.nodes) this.mount();
      const u = this.nodes;
      if (!u) return;
      this.setOpen(true);
      const prefs = this.readPrefs();
      if (prefs) this.applyPrefs(prefs);
      const bgm = this.readBgmState();
      if (bgm) this.applyBgm(bgm);
      this.syncAudio();
      this.syncStatus();
      void this.refreshConfig();
      void this.refreshSystem();
      this.refreshLibrary();
      this.updatePolling();
    }
    close() {
      if (!this.nodes) return;
      this.setOpen(false);
      this.updatePolling();
    }
    toggle() {
      if (this.isOpen()) this.close();
      else this.open();
    }
    isOpen() {
      const u = this.nodes;
      return u !== void 0 && !u.panel.hidden;
    }
    // --- shell ----------------------------------------------------------------
    build() {
      const fab = button("设置");
      fab.id = FAB_ID;
      fab.className = "zct-card zct-surface zct-btn";
      fab.style.position = "fixed";
      fab.style.right = "18px";
      fab.style.bottom = "18px";
      fab.style.zIndex = String(Z_PANEL);
      fab.style.width = "38px";
      fab.style.height = "38px";
      fab.style.padding = "0";
      fab.style.borderRadius = "var(--zct-radius-pill)";
      fab.style.fontWeight = "600";
      fab.setAttribute("aria-label", "打开 ZCode Tarkov 设置");
      fab.setAttribute("aria-expanded", "false");
      fab.title = "ZCode Tarkov 设置";
      const panel = make("div", "zct-card zct-surface");
      panel.id = PANEL_ID;
      panel.hidden = true;
      const head = make("div");
      head.id = "zct-panel-head";
      head.style.touchAction = "none";
      const headTitle = make("strong", void 0, "ZCode Tarkov 设置");
      const closeBtn = button("X", "icon");
      closeBtn.setAttribute("aria-label", "关闭设置面板");
      closeBtn.title = "关闭";
      head.append(headTitle, closeBtn);
      const tabs = make("div");
      tabs.id = "zct-panel-tabs";
      tabs.setAttribute("role", "tablist");
      tabs.setAttribute("aria-label", "设置分类");
      const tabButtons = /* @__PURE__ */ new Map();
      for (const tab of TABS) {
        const tabButton = make("button");
        tabButton.type = "button";
        tabButton.id = `zct-tab-${tab.id}`;
        tabButton.dataset.tab = tab.id;
        tabButton.setAttribute("role", "tab");
        tabButton.setAttribute("aria-controls", PANEL_BODY_ID);
        tabButton.setAttribute("aria-selected", "false");
        tabButton.tabIndex = -1;
        tabButton.textContent = tab.label;
        tabs.appendChild(tabButton);
        tabButtons.set(tab.id, tabButton);
      }
      const offline = make("div");
      offline.id = "zct-panel-offline";
      offline.hidden = true;
      const offlineMsg = make("div", void 0, OFFLINE_FALLBACK);
      const offlineHint = make(
        "div",
        "zct-empty-note",
        "请从 ZCode Tarkov 快捷方式重新启动 ZCode,服务会随之恢复"
      );
      const retry = button("重试连接", "primary");
      offline.append(offlineMsg, offlineHint, retry);
      const body = make("div");
      body.id = PANEL_BODY_ID;
      body.setAttribute("role", "tabpanel");
      const footState = make("span", void 0, "已连接");
      const foot = make("div");
      foot.id = "zct-panel-foot";
      foot.append(make("span", void 0, `ZCode Tarkov v${this.apiVersion()}`), footState);
      panel.append(head, tabs, offline, body, foot);
      const panes = {
        appearance: make("div"),
        audio: make("div"),
        pet: make("div"),
        status: make("div"),
        system: make("div")
      };
      const appearance = this.buildAppearance(panes.appearance);
      const audio = this.buildAudio(panes.audio);
      const pet = this.buildPet(panes.pet);
      const status = this.buildStatus(panes.status);
      const system = this.buildSystem(panes.system);
      body.append(panes.appearance, panes.audio, panes.pet, panes.status, panes.system);
      const sections = /* @__PURE__ */ new Map([
        ["appearance", panes.appearance],
        ["audio", panes.audio],
        ["pet", panes.pet],
        ["status", panes.status],
        ["system", panes.system]
      ]);
      this.listen(fab, "click", () => this.toggle());
      this.listen(closeBtn, "click", () => this.close());
      this.listen(tabs, "keydown", (ev) => this.onTabsKeyDown(ev));
      this.listen(tabs, "click", (ev) => this.onTabsClick(ev));
      this.listen(retry, "click", () => void this.retry());
      this.listen(head, "pointerdown", (ev) => this.onDragStart(ev));
      this.listen(head, "pointermove", (ev) => this.onDragMove(ev));
      this.listen(head, "pointerup", (ev) => this.onDragEnd(ev));
      this.listen(head, "pointercancel", (ev) => this.onDragEnd(ev));
      this.listen(window, "resize", () => this.clampIntoView());
      this.listen(document, "keydown", (ev) => this.onDocumentKeyDown(ev));
      return {
        fab,
        panel,
        head,
        tabs,
        tabButtons,
        body,
        sections,
        footState,
        offline,
        offlineMsg,
        retry,
        ...appearance,
        ...audio,
        ...pet,
        ...status,
        ...system
      };
    }
    setOpen(open) {
      const u = this.nodes;
      if (!u) return;
      u.panel.hidden = !open;
      u.fab.setAttribute("aria-expanded", open ? "true" : "false");
    }
    /** Removes a panel or FAB this instance does not own, e.g. from an old build. */
    removeStale() {
      for (const id of [PANEL_ID, FAB_ID]) {
        const stale = document.getElementById(id);
        if (!stale) continue;
        if (stale === this.nodes?.panel || stale === this.nodes?.fab) continue;
        try {
          stale.remove();
        } catch {
        }
      }
    }
    uiRoot() {
      try {
        return this.ctx.uiRoot();
      } catch {
        return void 0;
      }
    }
    apiVersion() {
      try {
        return this.ctx.api.version || "未知";
      } catch {
        return "未知";
      }
    }
    readPrefs() {
      try {
        return this.ctx.prefs();
      } catch {
        return void 0;
      }
    }
    readBgmState() {
      try {
        return this.controls.bgm.state();
      } catch {
        return void 0;
      }
    }
    // --- appearance -----------------------------------------------------------
    buildAppearance(pane) {
      const screen = makeSection("界面与壁纸");
      const color = selectRow(
        "UI 配色",
        COLOR_MODES.map((mode) => ({ value: mode, label: COLOR_MODE_LABELS[mode] })),
        this.defaults.appearance.colorMode
      );
      const blur = sliderRow("背景模糊", 0, 30, 1, 0, asPixels);
      const dim = sliderRow("背景压暗", 0, 80, 1, 25, asPixels);
      const wallpaperVisible = checkboxRow("显示壁纸", true);
      const pickRow = make("div", "zct-row");
      const pick = button("更换图片...");
      const wallpaperFile = make("input");
      wallpaperFile.type = "file";
      wallpaperFile.accept = "image/*";
      wallpaperFile.hidden = true;
      pickRow.append(pick, wallpaperFile);
      const fitRow = make("div", "zct-row");
      const fit = button(`背景填充: ${FIT_LABELS.cover}`);
      fit.dataset.fit = "cover";
      fitRow.appendChild(fit);
      const resetRow = make("div", "zct-row");
      const reset = button("还原默认外观");
      reset.dataset.mode = "reset";
      reset.disabled = true;
      resetRow.appendChild(reset);
      screen.body.append(color.root, blur.root, dim.root, wallpaperVisible.root, pickRow, fitRow, resetRow);
      const bannerDefaults = defaultBanner();
      const banner = makeSection("顶部状态条");
      const bannerMode = selectRow(
        "状态条模式",
        BANNER_MODES.map((mode) => ({ value: mode, label: BANNER_LABELS[mode] })),
        bannerDefaults.mode
      );
      const bannerOpacity = sliderRow(
        "状态条不透明度",
        0,
        1,
        0.01,
        bannerDefaults.opacity,
        asPercent
      );
      banner.body.append(bannerMode.root, bannerOpacity.root);
      const palette = makeSection("调色盘");
      const paletteHint = make(
        "div",
        "zct-empty-note",
        "仅影响 Tarkov 配色模式;Monet / Native 模式保持各自的外观。"
      );
      const background = colorRow("背景颜色", this.defaults.appearance.background);
      const accent = colorRow("强调色", this.defaults.appearance.accent);
      const paletteResetRow = make("div", "zct-row");
      const paletteReset = button("恢复默认颜色");
      paletteResetRow.appendChild(paletteReset);
      palette.body.append(paletteHint, background.root, accent.root, paletteResetRow);
      const greeting = makeSection("欢迎界面文字");
      const greetingEnabled = checkboxRow(
        "显示欢迎界面提示",
        this.defaults.appearance.greeting.enabled
      );
      const greetingHint = make(
        "div",
        "zct-empty-note",
        "关闭后 ZCode 会显示它自己的问候语;内容留空会还原为默认文字。"
      );
      const greetingLine1 = textRow(
        "第一行",
        this.defaults.appearance.greeting.line1,
        GREETING_LINE1_MAX
      );
      const greetingLine2 = textRow(
        "第二行",
        this.defaults.appearance.greeting.line2,
        GREETING_LINE2_MAX
      );
      const greetingResetRow = make("div", "zct-row");
      const greetingReset = button("恢复默认文字");
      greetingReset.disabled = true;
      greetingResetRow.appendChild(greetingReset);
      greeting.body.append(
        greetingEnabled.root,
        greetingHint,
        greetingLine1.root,
        greetingLine2.root,
        greetingResetRow
      );
      pane.append(screen.root, banner.root, palette.root, greeting.root);
      this.listen(color.select, "change", () => {
        const mode = oneOf(color.select.value, COLOR_MODES);
        if (!mode) return;
        void this.api(() => this.ctx.api.setConfig({ colorMode: mode })).then((result) => {
          if (result) this.applyConfig(result);
        });
      });
      this.bindSlider(
        blur.input,
        (value) => {
          blur.readout.textContent = asPixels(value);
        },
        (value) => this.writeConfig({ blur: value })
      );
      this.bindSlider(
        dim.input,
        (value) => {
          dim.readout.textContent = asPixels(value);
        },
        (value) => this.writeConfig({ dim: value })
      );
      this.listen(wallpaperVisible.input, "change", () => {
        const visible = wallpaperVisible.input.checked;
        void this.api(() => this.ctx.api.setConfig({ wallpaperVisible: visible })).then((result) => {
          if (result) this.applyConfig(result);
        });
      });
      this.listen(pick, "click", () => {
        try {
          wallpaperFile.click();
        } catch {
        }
      });
      this.listen(wallpaperFile, "change", () => this.onWallpaperChosen(wallpaperFile));
      this.listen(fit, "click", () => {
        const current = oneOf(fit.dataset.fit, WALLPAPER_FITS) ?? "cover";
        const next = WALLPAPER_FITS[(WALLPAPER_FITS.indexOf(current) + 1) % WALLPAPER_FITS.length];
        void this.api(() => this.ctx.api.setConfig({ fit: next })).then((result) => {
          if (result) this.applyConfig(result);
          else this.applyFit(next);
        });
      });
      this.listen(reset, "click", () => void this.onReset());
      this.listen(bannerMode.select, "change", () => {
        const mode = oneOf(bannerMode.select.value, BANNER_MODES);
        if (mode) this.writePrefs({ appearance: { banner: { mode } } });
      });
      this.bindSlider(
        bannerOpacity.input,
        (value) => {
          bannerOpacity.readout.textContent = asPercent(value);
        },
        (value) => this.writePrefs({ appearance: { banner: { opacity: value } } })
      );
      this.bindLive(
        background.input,
        (value) => {
          background.readout.textContent = value;
        },
        (value) => this.writePrefs({ appearance: { background: value } })
      );
      this.bindLive(
        accent.input,
        (value) => {
          accent.readout.textContent = value;
        },
        (value) => this.writePrefs({ appearance: { accent: value } })
      );
      this.listen(paletteReset, "click", () => {
        background.input.value = DEFAULT_PALETTE.background;
        background.readout.textContent = DEFAULT_PALETTE.background;
        accent.input.value = DEFAULT_PALETTE.accent;
        accent.readout.textContent = DEFAULT_PALETTE.accent;
        this.writePrefs({
          appearance: { background: DEFAULT_PALETTE.background, accent: DEFAULT_PALETTE.accent }
        });
      });
      this.listen(
        greetingEnabled.input,
        "change",
        () => this.writePrefs({ appearance: { greeting: { enabled: greetingEnabled.input.checked } } })
      );
      this.bindLive(
        greetingLine1.input,
        (value) => {
          greetingLine1.counter.textContent = asCount(value, GREETING_LINE1_MAX);
          this.syncGreetingReset();
        },
        (value) => this.writePrefs({
          appearance: { greeting: { line1: orDefault(value, DEFAULT_GREETING.line1) } }
        }),
        (value) => orDefault(value, DEFAULT_GREETING.line1)
      );
      this.bindLive(
        greetingLine2.input,
        (value) => {
          greetingLine2.counter.textContent = asCount(value, GREETING_LINE2_MAX);
          this.syncGreetingReset();
        },
        (value) => this.writePrefs({
          appearance: { greeting: { line2: orDefault(value, DEFAULT_GREETING.line2) } }
        }),
        (value) => orDefault(value, DEFAULT_GREETING.line2)
      );
      this.listen(greetingReset, "click", () => {
        greetingLine1.input.value = DEFAULT_GREETING.line1;
        greetingLine1.counter.textContent = asCount(DEFAULT_GREETING.line1, GREETING_LINE1_MAX);
        greetingLine2.input.value = DEFAULT_GREETING.line2;
        greetingLine2.counter.textContent = asCount(DEFAULT_GREETING.line2, GREETING_LINE2_MAX);
        this.syncGreetingReset();
        this.writePrefs({
          appearance: {
            greeting: { line1: DEFAULT_GREETING.line1, line2: DEFAULT_GREETING.line2 }
          }
        });
      });
      return {
        colorMode: color.select,
        blur: blur.input,
        blurValue: blur.readout,
        dim: dim.input,
        dimValue: dim.readout,
        wallpaperVisible: wallpaperVisible.input,
        wallpaperFile,
        fit,
        reset,
        bannerMode: bannerMode.select,
        bannerOpacity: bannerOpacity.input,
        bannerOpacityValue: bannerOpacity.readout,
        colorBackground: background.input,
        colorBackgroundValue: background.readout,
        colorAccent: accent.input,
        colorAccentValue: accent.readout,
        paletteReset,
        greetingEnabled: greetingEnabled.input,
        greetingLine1: greetingLine1.input,
        greetingLine1Count: greetingLine1.counter,
        greetingLine2: greetingLine2.input,
        greetingLine2Count: greetingLine2.counter,
        greetingReset
      };
    }
    applyConfig(config) {
      const u = this.nodes;
      if (!u) return;
      const mode = oneOf(readString(config, "colorMode"), COLOR_MODES) ?? (readBoolean(config, "monet") === true ? "monet" : void 0);
      if (mode && !this.held(u.colorMode)) u.colorMode.value = mode;
      const blur = readNumber(config, "blur");
      if (blur !== void 0 && !this.held(u.blur)) {
        u.blur.value = String(clamp2(blur, 0, 30));
        u.blurValue.textContent = asPixels(Number(u.blur.value));
      }
      const dim = readNumber(config, "dim");
      if (dim !== void 0 && !this.held(u.dim)) {
        u.dim.value = String(clamp2(dim, 0, 80));
        u.dimValue.textContent = asPixels(Number(u.dim.value));
      }
      const visible = readBoolean(config, "wallpaperVisible");
      if (visible !== void 0 && !this.held(u.wallpaperVisible)) u.wallpaperVisible.checked = visible;
      this.applyFit(oneOf(readString(config, "fit"), WALLPAPER_FITS));
      const wallpaperSet = config.wallpaperSet === true;
      const hasBackup = config.hasBackup === true;
      if (wallpaperSet) {
        u.reset.disabled = false;
        u.reset.textContent = "还原默认外观";
        u.reset.dataset.mode = "reset";
        u.reset.title = "移除壁纸与配色,还原 ZCode 默认外观(壁纸会被记住,可再次恢复)";
      } else if (hasBackup) {
        u.reset.disabled = false;
        u.reset.textContent = "恢复我的壁纸";
        u.reset.dataset.mode = "restore";
        u.reset.title = "从备份恢复你之前的壁纸与配色";
      } else {
        u.reset.disabled = true;
        u.reset.textContent = "还原默认外观";
        u.reset.dataset.mode = "reset";
        u.reset.title = "当前已是默认外观";
      }
    }
    applyFit(fit) {
      const u = this.nodes;
      if (!u || !fit) return;
      u.fit.textContent = `背景填充: ${FIT_LABELS[fit]}`;
      u.fit.dataset.fit = fit;
    }
    /**
     * The restore button only means something while the fields differ from the
     * shipped text. It reads the live fields rather than the stored prefs so the
     * button agrees with what the user is looking at, including mid-edit.
     */
    syncGreetingReset() {
      const u = this.nodes;
      if (!u) return;
      u.greetingReset.disabled = u.greetingLine1.value === DEFAULT_GREETING.line1 && u.greetingLine2.value === DEFAULT_GREETING.line2;
    }
    writeConfig(patch) {
      void this.api(() => this.ctx.api.setConfig(patch)).then((result) => {
        if (result) this.applyConfig(result);
      });
    }
    onWallpaperChosen(input) {
      const file = input.files && input.files[0];
      input.value = "";
      if (!file) return;
      if (file.size > MAX_WALLPAPER_BYTES) {
        this.ctx.toast("图片过大,上限 20 MB");
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const dataUri = typeof reader.result === "string" ? reader.result : "";
        if (dataUri.length === 0) {
          this.ctx.toastError(reader.error, "读取图片失败");
          return;
        }
        void this.api(() => this.ctx.api.setWallpaper(dataUri, file.name)).then((result) => {
          if (!result) return;
          this.applyConfig(result);
          this.ctx.toast("壁纸已更新");
        });
      };
      reader.onerror = () => this.ctx.toastError(reader.error, "读取图片失败");
      reader.readAsDataURL(file);
    }
    async onReset() {
      const u = this.nodes;
      if (!u) return;
      const restore = u.reset.dataset.mode === "restore";
      try {
        const result = restore ? await this.ctx.api.restore() : await this.ctx.api.reset();
        if (!this.alive) return;
        this.setOffline(false);
        this.applyConfig(result);
        this.ctx.toast(restore ? "已恢复你的壁纸" : "已还原默认外观");
        void this.refreshConfig();
      } catch (err) {
        if (this.alive) this.setOffline(true, err);
      }
    }
    // --- audio ----------------------------------------------------------------
    buildAudio(pane) {
      const master = makeSection("总开关");
      const audioEnabled = checkboxRow("启用音频", this.defaults.audio.enabled);
      const masterVolume = sliderRow(
        "主音量",
        0,
        1,
        0.01,
        this.defaults.audio.masterVolume,
        asPercent
      );
      master.body.append(audioEnabled.root, masterVolume.root);
      const unlockSection = make("div", "zct-section");
      const unlockState = make("div", "zct-empty-note", "浏览器尚未授权音频播放");
      const unlockBtn = button("启用音频", "primary");
      unlockSection.append(make("h4", void 0, "音频授权"), unlockState, unlockBtn);
      const bgm = makeSection("背景音乐");
      const bgmEnabled = checkboxRow("启用背景音乐", this.defaults.audio.bgm.enabled);
      const bgmVolume = sliderRow("音乐音量", 0, 1, 0.01, this.defaults.audio.bgm.volume, asPercent);
      const transport = make("div", "zct-row");
      const bgmPrev = button("上一首");
      const bgmPlay = button("播放");
      const bgmNext = button("下一首");
      transport.append(bgmPrev, bgmPlay, bgmNext);
      const options = make("div", "zct-row");
      const bgmShuffle = button("随机播放");
      const bgmRepeat = button("循环: 列表");
      options.append(bgmShuffle, bgmRepeat);
      const bgmTitle = make("div", "zct-value", "未在播放");
      const bgmPosition = make("div", "zct-empty-note", "0:00 / 0:00");
      const tracks = make("div");
      tracks.id = "zct-tracks";
      const emptyNote = make("div", "zct-empty-note");
      emptyNote.id = "zct-empty-note";
      emptyNote.hidden = true;
      const uploadBar = make("div");
      uploadBar.id = "zct-upload-bar";
      const uploadFill = make("i");
      uploadBar.appendChild(uploadFill);
      uploadBar.hidden = true;
      const addRow = make("div", "zct-row");
      const addMusic = button("添加音乐...", "primary");
      const musicFile = make("input");
      musicFile.type = "file";
      musicFile.accept = "audio/*";
      musicFile.hidden = true;
      addRow.append(addMusic, musicFile);
      bgm.body.append(
        bgmEnabled.root,
        bgmVolume.root,
        transport,
        options,
        bgmTitle,
        bgmPosition,
        tracks,
        emptyNote,
        uploadBar,
        addRow
      );
      const sfx = makeSection("音效");
      const sfxEnabled = checkboxRow("启用音效", this.defaults.audio.sfx.enabled);
      const sfxVolume = sliderRow("音效音量", 0, 1, 0.01, this.defaults.audio.sfx.volume, asPercent);
      sfx.body.append(sfxEnabled.root, sfxVolume.root);
      const sfxEventInputs = /* @__PURE__ */ new Map();
      for (const event of SFX_EVENTS) {
        const row = checkboxRow(SFX_LABELS[event], true);
        const test = button("试听", "icon");
        test.title = "播放该事件的音效";
        row.root.appendChild(test);
        sfx.body.appendChild(row.root);
        sfxEventInputs.set(event, row.input);
        this.listen(test, "click", () => {
          this.opts.onTestSfx?.(event);
        });
      }
      const voice = makeSection("宠物语音");
      const voiceEnabled = checkboxRow("启用宠物语音", this.defaults.audio.voice.enabled);
      const voiceVolume = sliderRow(
        "语音音量",
        0,
        1,
        0.01,
        this.defaults.audio.voice.volume,
        asPercent
      );
      const voiceChance = sliderRow(
        "点击触发概率",
        0,
        1,
        0.05,
        this.defaults.audio.voice.chance,
        asPercent
      );
      const voiceTestRow = make("div", "zct-row");
      const voiceTest = button("试听语音");
      voiceTestRow.appendChild(voiceTest);
      const poolRow = make("div", "zct-row");
      const voicePool = make("span", "zct-value", "0 个片段");
      const voiceRefresh = button("刷新", "icon");
      poolRow.append(make("label", void 0, "语音池"), voicePool, voiceRefresh);
      voice.body.append(
        voiceEnabled.root,
        voiceVolume.root,
        voiceChance.root,
        voiceTestRow,
        poolRow
      );
      pane.append(master.root, unlockSection, bgm.root, sfx.root, voice.root);
      this.listen(
        audioEnabled.input,
        "change",
        () => this.writePrefs({ audio: { enabled: audioEnabled.input.checked } })
      );
      this.bindSlider(
        masterVolume.input,
        (value) => {
          masterVolume.readout.textContent = asPercent(value);
        },
        (value) => this.writePrefs({ audio: { masterVolume: value } })
      );
      this.listen(unlockBtn, "click", () => void this.unlockAudio());
      this.listen(
        bgmEnabled.input,
        "change",
        () => this.writePrefs({ audio: { bgm: { enabled: bgmEnabled.input.checked } } })
      );
      this.bindSlider(
        bgmVolume.input,
        (value) => {
          bgmVolume.readout.textContent = asPercent(value);
        },
        (value) => this.writePrefs({ audio: { bgm: { volume: value } } })
      );
      this.listen(
        bgmPrev,
        "click",
        () => this.controlCall(() => this.controls.bgm.prev(), "切换曲目失败")
      );
      this.listen(
        bgmPlay,
        "click",
        () => this.controlCall(() => this.controls.bgm.toggle(), "播放控制失败")
      );
      this.listen(
        bgmNext,
        "click",
        () => this.controlCall(() => this.controls.bgm.next(), "切换曲目失败")
      );
      this.listen(
        bgmShuffle,
        "click",
        () => this.controlCall(
          () => this.controls.bgm.setShuffle(!(this.lastBgm?.shuffle ?? false)),
          "切换随机播放失败"
        )
      );
      this.listen(
        bgmRepeat,
        "click",
        () => this.controlCall(
          () => this.controls.bgm.setRepeat(this.lastBgm?.repeat === "one" ? "all" : "one"),
          "切换循环模式失败"
        )
      );
      this.listen(addMusic, "click", () => {
        try {
          musicFile.click();
        } catch {
        }
      });
      this.listen(musicFile, "change", () => this.onMusicChosen(musicFile));
      this.listen(
        sfxEnabled.input,
        "change",
        () => this.writePrefs({ audio: { sfx: { enabled: sfxEnabled.input.checked } } })
      );
      this.bindSlider(
        sfxVolume.input,
        (value) => {
          sfxVolume.readout.textContent = asPercent(value);
        },
        (value) => this.writePrefs({ audio: { sfx: { volume: value } } })
      );
      for (const [event, input] of sfxEventInputs) {
        this.listen(
          input,
          "change",
          () => this.writePrefs({ audio: { sfx: { events: { [event]: input.checked } } } })
        );
      }
      this.listen(
        voiceEnabled.input,
        "change",
        () => this.writePrefs({ audio: { voice: { enabled: voiceEnabled.input.checked } } })
      );
      this.bindSlider(
        voiceVolume.input,
        (value) => {
          voiceVolume.readout.textContent = asPercent(value);
        },
        (value) => this.writePrefs({ audio: { voice: { volume: value } } })
      );
      this.bindSlider(
        voiceChance.input,
        (value) => {
          voiceChance.readout.textContent = asPercent(value);
        },
        (value) => this.writePrefs({ audio: { voice: { chance: value } } })
      );
      this.listen(voiceTest, "click", () => this.opts.onTestVoice?.());
      this.listen(voiceRefresh, "click", () => void this.refreshVoicePool());
      return {
        audioEnabled: audioEnabled.input,
        masterVolume: masterVolume.input,
        masterVolumeValue: masterVolume.readout,
        unlockSection,
        unlockState,
        unlockBtn,
        bgmEnabled: bgmEnabled.input,
        bgmVolume: bgmVolume.input,
        bgmVolumeValue: bgmVolume.readout,
        bgmShuffle,
        bgmRepeat,
        bgmPrev,
        bgmPlay,
        bgmNext,
        bgmTitle,
        bgmPosition,
        tracks,
        emptyNote,
        uploadBar,
        uploadFill,
        addMusic,
        musicFile,
        sfxEnabled: sfxEnabled.input,
        sfxVolume: sfxVolume.input,
        sfxVolumeValue: sfxVolume.readout,
        sfxEventInputs,
        voiceEnabled: voiceEnabled.input,
        voiceVolume: voiceVolume.input,
        voiceVolumeValue: voiceVolume.readout,
        voiceChance: voiceChance.input,
        voiceChanceValue: voiceChance.readout,
        voiceTest,
        voicePool,
        voiceRefresh
      };
    }
    applyBgm(state) {
      const u = this.nodes;
      if (!u) return;
      this.lastBgm = state;
      u.bgmTitle.textContent = state.title.length > 0 ? state.title : "未在播放";
      u.bgmPosition.textContent = `${formatClock(state.positionSeconds)} / ${formatClock(state.durationSeconds)}`;
      u.bgmPlay.textContent = state.playing ? "暂停" : "播放";
      u.bgmShuffle.dataset.state = state.shuffle ? "on" : "off";
      u.bgmRepeat.textContent = state.repeat === "one" ? "循环: 单曲" : "循环: 列表";
      u.bgmRepeat.dataset.state = state.repeat === "one" ? "on" : "off";
      this.renderTracks(state);
    }
    /**
     * Rebuilds the library list only when it actually changed.
     *
     * The player emits on every `timeupdate`, so an unguarded rebuild would
     * discard the row the user is tabbing through four times a second. The
     * fingerprint includes the current track so the highlight still follows.
     */
    renderTracks(state) {
      const u = this.nodes;
      if (!u) return;
      this.syncEmptyNote();
      const fingerprint = `${state.trackId ?? ""}\0${state.tracks.map((track) => `${track.id}\0${track.enabled ? "1" : "0"}\0${track.durationSeconds ?? ""}`).join("")}`;
      if (fingerprint === this.trackFingerprint) return;
      this.trackFingerprint = fingerprint;
      this.clearTransient();
      u.tracks.replaceChildren();
      for (const track of state.tracks) {
        const row = make("div", "zct-track");
        row.dataset.current = state.trackId === track.id ? "1" : "0";
        row.dataset.disabled = track.enabled ? "0" : "1";
        const toggle = make("input");
        toggle.type = "checkbox";
        toggle.checked = track.enabled;
        toggle.title = track.enabled ? "停用该曲目" : "启用该曲目";
        toggle.setAttribute("aria-label", `${track.displayName} 启用`);
        this.listenTransient(toggle, "change", () => void this.toggleTrack(track.id, toggle.checked));
        const name = make("span", "zct-track-name", track.displayName);
        name.setAttribute("role", "button");
        name.tabIndex = 0;
        name.title = "设为当前曲目";
        const select = () => this.controlCall(() => this.controls.bgm.select(track.id), "选择曲目失败");
        this.listenTransient(name, "click", select);
        this.listenTransient(name, "keydown", (ev) => {
          const key = ev.key;
          if (key !== "Enter" && key !== " ") return;
          ev.preventDefault();
          select();
        });
        const meta = make(
          "span",
          "zct-track-meta",
          track.durationSeconds !== void 0 && track.durationSeconds > 0 ? formatClock(track.durationSeconds) : ""
        );
        const remove = button("删除", "icon");
        remove.title = "从 music 文件夹删除该文件";
        this.listenTransient(remove, "click", () => void this.removeTrack(track.id));
        row.append(toggle, name, meta, remove);
        u.tracks.appendChild(row);
      }
    }
    syncEmptyNote() {
      const u = this.nodes;
      if (!u) return;
      const state = this.lastBgm;
      const empty = state === void 0 || state.empty || state.tracks.length === 0;
      u.tracks.hidden = empty;
      u.emptyNote.hidden = !empty;
      const musicDir = empty ? this.musicDir() : void 0;
      const key = empty ? `empty:${musicDir ?? ""}` : "tracks";
      if (key === this.emptyNoteKey) return;
      this.emptyNoteKey = key;
      if (!empty) {
        u.emptyNote.replaceChildren();
        return;
      }
      const parts = [
        document.createTextNode("音乐库为空,把音频文件放进 music 文件夹即可自动收录:")
      ];
      if (musicDir) parts.push(make("br"), make("code", void 0, musicDir));
      parts.push(make("br"), document.createTextNode("也可以点击下方的添加音乐按钮上传"));
      u.emptyNote.replaceChildren(...parts);
    }
    musicDir() {
      const sys = this.lastSystem;
      if (!sys) return void 0;
      const raw = sys;
      const dirs = Array.isArray(raw.mediaDirs) ? raw.mediaDirs : [];
      for (const entry of dirs) {
        if (typeof entry !== "object" || entry === null) continue;
        const record = entry;
        if (readString(record, "kind") !== "music") continue;
        const path = readString(record, "path");
        if (path && path.length > 0) return path;
      }
      return void 0;
    }
    syncAudio() {
      const u = this.nodes;
      if (!u) return;
      const unlocked = this.audioFlag("unlocked");
      u.unlockSection.hidden = unlocked;
      if (!unlocked) {
        u.unlockState.textContent = this.audioFlag("locked") ? "音频已锁定,点击启用" : "浏览器尚未授权音频播放,点击下方按钮启用";
      }
      u.voicePool.textContent = `${this.voicePoolSize()} 个片段`;
    }
    audioFlag(key) {
      try {
        return key === "unlocked" ? this.ctx.audio.unlocked : this.ctx.audio.locked;
      } catch {
        return false;
      }
    }
    voicePoolSize() {
      try {
        return this.controls.pet.voicePoolSize();
      } catch {
        return 0;
      }
    }
    async unlockAudio() {
      const u = this.nodes;
      if (!u) return;
      u.unlockBtn.disabled = true;
      try {
        const ok = await this.ctx.audio.tryUnlock();
        if (!this.alive) return;
        this.ctx.toast(ok ? "音频已启用" : "浏览器仍阻止音频播放,请先点击页面任意位置");
      } catch (err) {
        if (this.alive) this.ctx.toastError(err, "启用音频失败");
      } finally {
        const nodes = this.nodes;
        if (nodes) nodes.unlockBtn.disabled = false;
      }
      this.syncAudio();
    }
    onMusicChosen(input) {
      const file = input.files && input.files[0];
      input.value = "";
      if (!file) return;
      void this.uploadTrack(file);
    }
    async uploadTrack(file) {
      const u = this.nodes;
      if (!u) return;
      u.uploadBar.hidden = false;
      u.uploadFill.style.width = "0%";
      try {
        await this.controls.bgm.upload(file, (fraction) => {
          const nodes = this.nodes;
          if (!nodes) return;
          nodes.uploadFill.style.width = `${Math.round(clamp2(fraction, 0, 1) * 100)}%`;
        });
        if (!this.alive) return;
        u.uploadFill.style.width = "100%";
        this.ctx.toast("音乐已添加");
      } catch (err) {
        if (this.alive) this.ctx.toastError(err, "上传失败");
      } finally {
        const nodes = this.nodes;
        if (nodes) {
          nodes.uploadBar.hidden = true;
          nodes.uploadFill.style.width = "0%";
        }
      }
    }
    async toggleTrack(name, enabled) {
      try {
        await this.controls.bgm.toggleTrack(name, enabled);
      } catch (err) {
        if (this.alive) this.ctx.toastError(err, "切换曲目失败");
      }
    }
    async removeTrack(name) {
      try {
        await this.controls.bgm.remove(name);
        if (this.alive) this.ctx.toast(`已删除 ${name}`);
      } catch (err) {
        if (this.alive) this.ctx.toastError(err, "删除曲目失败");
      }
    }
    async refreshVoicePool() {
      const u = this.nodes;
      if (!u) return;
      u.voiceRefresh.disabled = true;
      try {
        const size = await this.controls.pet.refreshVoicePool();
        if (!this.alive) return;
        u.voicePool.textContent = `${size} 个片段`;
        this.ctx.toast(`语音池已刷新: ${size} 个片段`);
      } catch (err) {
        if (this.alive) this.ctx.toastError(err, "刷新语音池失败");
      } finally {
        const nodes = this.nodes;
        if (nodes) nodes.voiceRefresh.disabled = false;
      }
    }
    // --- pet ------------------------------------------------------------------
    buildPet(pane) {
      const pet = makeSection("宠物");
      const petEnabled = checkboxRow("启用宠物", this.defaults.pet.enabled);
      const petScale = sliderRow("大小", 24, 320, 1, this.defaults.pet.scale, asPixels);
      const petOpacity = sliderRow("不透明度", 0.1, 1, 0.05, this.defaults.pet.opacity, asPercent);
      const petVoiceOnClick = checkboxRow("点击时播放语音", this.defaults.pet.voiceOnClick);
      const resetRow = make("div", "zct-row");
      const petReset = button("重置宠物位置");
      resetRow.appendChild(petReset);
      pet.body.append(
        petEnabled.root,
        petScale.root,
        petOpacity.root,
        petVoiceOnClick.root,
        resetRow
      );
      pane.appendChild(pet.root);
      this.listen(
        petEnabled.input,
        "change",
        () => this.writePrefs({ pet: { enabled: petEnabled.input.checked } })
      );
      this.bindSlider(
        petScale.input,
        (value) => {
          petScale.readout.textContent = asPixels(value);
        },
        (value) => this.writePrefs({ pet: { scale: value } })
      );
      this.bindSlider(
        petOpacity.input,
        (value) => {
          petOpacity.readout.textContent = asPercent(value);
        },
        (value) => this.writePrefs({ pet: { opacity: value } })
      );
      this.listen(
        petVoiceOnClick.input,
        "change",
        () => this.writePrefs({ pet: { voiceOnClick: petVoiceOnClick.input.checked } })
      );
      this.listen(
        petReset,
        "click",
        () => this.controlCall(() => this.controls.pet.resetPosition(), "重置宠物位置失败")
      );
      return {
        petEnabled: petEnabled.input,
        petScale: petScale.input,
        petScaleValue: petScale.readout,
        petOpacity: petOpacity.input,
        petOpacityValue: petOpacity.readout,
        petVoiceOnClick: petVoiceOnClick.input,
        petReset
      };
    }
    // --- status ---------------------------------------------------------------
    buildStatus(pane) {
      const status = makeSection("状态文案");
      const statusEnabled = checkboxRow("启用状态文案", this.defaults.status.enabled);
      const statusLanguage = selectRow(
        "语言",
        STATUS_LANGUAGES.map((language) => ({
          value: language,
          label: LANGUAGE_LABELS[language]
        })),
        this.defaults.status.language
      );
      const triggers = make("div");
      const statusTriggerInputs = /* @__PURE__ */ new Map();
      for (const trigger of STATUS_TRIGGERS) {
        const row = checkboxRow(TRIGGER_LABELS[trigger] ?? trigger, true);
        triggers.appendChild(row.root);
        statusTriggerInputs.set(trigger, row.input);
      }
      const reloadRow = make("div", "zct-row");
      const statusReload = button("重新加载文案池");
      const statusReloadInfo = make("span", "zct-value", "");
      reloadRow.append(statusReload, statusReloadInfo);
      const sourceRow = make("div", "zct-row");
      const statusPool = make("span", "zct-value", "未知");
      sourceRow.append(make("label", void 0, "文案来源"), statusPool);
      const previewRow = make("div", "zct-row");
      previewRow.appendChild(make("label", void 0, "当前文案预览"));
      const statusPhrase = make("div", "zct-empty-note", "当前没有正在显示的状态文案");
      status.body.append(
        statusEnabled.root,
        statusLanguage.root,
        triggers,
        reloadRow,
        sourceRow,
        previewRow,
        statusPhrase
      );
      pane.appendChild(status.root);
      this.listen(
        statusEnabled.input,
        "change",
        () => this.writePrefs({ status: { enabled: statusEnabled.input.checked } })
      );
      this.listen(statusLanguage.select, "change", () => {
        const language = oneOf(statusLanguage.select.value, STATUS_LANGUAGES);
        if (language) this.writePrefs({ status: { language } });
      });
      for (const [trigger, input] of statusTriggerInputs) {
        this.listen(
          input,
          "change",
          () => this.writePrefs({ status: { triggers: { [trigger]: input.checked } } })
        );
      }
      this.listen(statusReload, "click", () => void this.reloadStatusPool());
      return {
        statusEnabled: statusEnabled.input,
        statusLanguage: statusLanguage.select,
        statusTriggerInputs,
        statusReload,
        statusReloadInfo,
        statusPool,
        statusPhrase
      };
    }
    async reloadStatusPool() {
      const u = this.nodes;
      if (!u) return;
      u.statusReload.disabled = true;
      try {
        const count = await this.controls.status.reload();
        if (!this.alive) return;
        u.statusReloadInfo.textContent = `${count} 条`;
        this.syncStatus();
        this.ctx.toast(`文案池已重新加载: ${count} 条`);
      } catch (err) {
        if (this.alive) this.ctx.toastError(err, "重新加载文案池失败");
      } finally {
        const nodes = this.nodes;
        if (nodes) nodes.statusReload.disabled = false;
      }
    }
    syncStatus() {
      const u = this.nodes;
      if (!u) return;
      let source = "未知";
      try {
        const value = this.controls.status.poolSource();
        source = value === "user" ? "自定义文案池" : value === "bundled" ? "内置文案池" : "未知来源";
      } catch {
      }
      u.statusPool.textContent = source;
      let phrase;
      try {
        phrase = this.controls.status.currentPhrase();
      } catch {
        phrase = void 0;
      }
      u.statusPhrase.textContent = phrase !== void 0 && phrase.length > 0 ? phrase : "当前没有正在显示的状态文案";
    }
    // --- system ---------------------------------------------------------------
    buildSystem(pane) {
      pane.id = "zct-system";
      pane.className = "zct-section";
      const systemDl = make("dl");
      const warn = make(
        "div",
        "zct-warn",
        "服务不可达或 CDP 未连接时,请从 ZCode Tarkov 快捷方式重新启动 ZCode"
      );
      const details = make("details");
      const systemAdvanced = make("dl");
      details.append(make("summary", void 0, "高级诊断"), systemAdvanced);
      pane.append(make("h4", void 0, "系统"), systemDl, warn, details);
      return { systemDl, systemAdvanced };
    }
    applySystem(system) {
      this.lastSystem = system;
      this.renderSystem();
      this.syncEmptyNote();
    }
    applyStatusInfo(status) {
      this.lastStatus = status;
      this.renderSystem();
    }
    renderSystem() {
      const u = this.nodes;
      if (!u) return;
      const rows = [];
      const system = this.lastSystem;
      if (!system) {
        rows.push(["插件版本", this.apiVersion()]);
        rows.push(["后台服务", this.offline ? "不可达" : "读取中..."]);
        u.systemDl.replaceChildren(...this.definition(rows));
        u.systemAdvanced.replaceChildren();
        return;
      }
      const raw = system;
      rows.push(["插件版本", readString(raw, "version") ?? this.apiVersion()]);
      rows.push(["后台服务", this.offline ? "不可达" : "运行中"]);
      const status = this.lastStatus;
      if (this.offline) {
        rows.push(["ZCode 连接", "不可达"]);
      } else if (status) {
        const cdp = status.cdpReachable === true;
        const renderers = readNumber(status, "rendererCount") ?? 0;
        const running = status.zcodeRunning === true;
        rows.push([
          "ZCode 连接",
          cdp ? `CDP 已连接 (${renderers} 个渲染器)` : running ? "ZCode 运行中,CDP 未连接" : "ZCode 未运行"
        ]);
      } else {
        rows.push(["ZCode 连接", "读取中..."]);
      }
      const dataRoot = readString(raw, "dataRoot");
      rows.push(["数据目录", dataRoot && dataRoot.length > 0 ? dataRoot : "未知"]);
      const dirs = Array.isArray(raw.mediaDirs) ? raw.mediaDirs : [];
      for (const entry of dirs) {
        if (typeof entry !== "object" || entry === null) continue;
        const record = entry;
        const kind = readString(record, "kind") ?? "media";
        const path = readString(record, "path") ?? "";
        rows.push([`素材目录 (${kind})`, path]);
      }
      u.systemDl.replaceChildren(...this.definition(rows));
      const pid = readNumber(raw, "pid");
      const uptime = readNumber(raw, "uptimeSeconds");
      const startedAt = readString(raw, "startedAt");
      const advanced = [
        ["PID", pid !== void 0 ? String(pid) : "未知"],
        ["运行时长", uptime !== void 0 ? formatUptime(uptime) : "未知"]
      ];
      if (startedAt && startedAt.length > 0) advanced.push(["启动时间", startedAt]);
      u.systemAdvanced.replaceChildren(...this.definition(advanced));
    }
    definition(rows) {
      return rows.flatMap(([term, value]) => [
        make("dt", void 0, term),
        make("dd", void 0, value)
      ]);
    }
    // --- data flow ------------------------------------------------------------
    async api(work) {
      try {
        const result = await work();
        if (!this.alive) return void 0;
        this.setOffline(false);
        return result;
      } catch (err) {
        if (this.alive) this.setOffline(true, err);
        return void 0;
      }
    }
    writePrefs(patch) {
      void this.api(() => this.ctx.patchPrefs(patch));
    }
    controlCall(work, fallback) {
      try {
        return work();
      } catch (err) {
        this.ctx.toastError(err, fallback);
        return void 0;
      }
    }
    async refreshConfig() {
      if (!this.alive) return;
      const wasOffline = this.offline;
      try {
        const config = await this.ctx.api.getConfig();
        if (!this.alive) return;
        this.applyConfig(config);
        this.syncStatus();
        this.setOffline(false);
        if (wasOffline) {
          void this.refreshSystem();
          this.refreshLibrary();
        }
      } catch (err) {
        if (this.alive) this.setOffline(true, err);
      }
    }
    async refreshSystem() {
      if (!this.alive) return;
      const [system, status] = await Promise.all([
        this.ctx.api.getSystem().catch(() => void 0),
        this.ctx.api.getStatus().catch(() => void 0)
      ]);
      if (!this.alive) return;
      if (system) this.applySystem(system);
      if (status) this.applyStatusInfo(status);
      if (!system && !status) this.setOffline(true);
      else this.setOffline(false);
    }
    /** The library refresh is background work; the config poll already reports service health. */
    refreshLibrary() {
      void this.controls.bgm.refresh().catch(() => void 0);
    }
    async retry() {
      const u = this.nodes;
      if (!u) return;
      u.retry.disabled = true;
      u.retry.textContent = "正在重试...";
      await this.refreshConfig();
      const nodes = this.nodes;
      if (!nodes) return;
      nodes.retry.disabled = false;
      nodes.retry.textContent = "重试连接";
      if (!this.offline) {
        void this.refreshSystem();
        this.refreshLibrary();
      }
    }
    setOffline(offline, err) {
      const u = this.nodes;
      if (!u) return;
      this.offline = offline;
      if (offline) {
        u.panel.setAttribute("data-offline", "1");
        u.offlineMsg.textContent = err !== void 0 ? errorMessage(err, OFFLINE_FALLBACK) : OFFLINE_FALLBACK;
      } else {
        u.panel.removeAttribute("data-offline");
      }
      u.offline.hidden = !offline;
      u.footState.textContent = offline ? "服务离线" : "已连接";
      u.fab.title = offline ? "ZCode Tarkov 设置 - 服务离线" : "ZCode Tarkov 设置";
      this.renderSystem();
      this.updatePolling();
    }
    /** Polling exists only while the panel is visible or the service is down. */
    updatePolling() {
      if (!this.alive) {
        this.stopPolling();
        return;
      }
      const shouldPoll = this.isOpen() || this.offline;
      if (shouldPoll && this.pollTimer === null) {
        this.pollTimer = window.setInterval(() => void this.refreshConfig(), POLL_MS);
      } else if (!shouldPoll) {
        this.stopPolling();
      }
    }
    stopPolling() {
      if (this.pollTimer === null) return;
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    // --- interaction ----------------------------------------------------------
    listen(target, type, handler) {
      target.addEventListener(type, handler);
      this.disposers.push(() => target.removeEventListener(type, handler));
    }
    listenTransient(target, type, handler) {
      target.addEventListener(type, handler);
      this.transientDisposers.push(() => target.removeEventListener(type, handler));
    }
    clearTransient() {
      for (const dispose of this.transientDisposers.splice(0)) {
        try {
          dispose();
        } catch {
        }
      }
    }
    /**
     * Wires one slider.
     *
     * `input` updates the readout and the shared in-memory copy immediately and
     * requests a throttled write; `change` always writes the final value, so a
     * drag that ends between two throttle windows is never lost.
     */
    bindSlider(input, readout, write) {
      this.listen(input, "input", () => {
        this.activeInput = input;
        const value = Number(input.value);
        readout(value);
        this.queueWrite(() => write(value), false);
      });
      this.listen(input, "change", () => {
        this.activeInput = void 0;
        const value = Number(input.value);
        readout(value);
        this.queueWrite(() => write(value), true);
      });
    }
    /**
     * Wires one live value control: a colour picker or a text field.
     *
     * `input` fires on every keystroke and continuously while an OS colour picker
     * is open, so the write goes through the shared throttle; `change` is the
     * commit and always writes. Holding the element in `activeInput` between the
     * two is what keeps a refresh from rewriting a field still being edited.
     * `normalize` runs on the commit, which is where a blank text field turns back
     * into something the validator would store rather than silently reject.
     */
    bindLive(input, onValue, write, normalize) {
      this.listen(input, "input", () => {
        this.activeInput = input;
        const value = input.value;
        onValue(value);
        this.queueWrite(() => write(value), false);
      });
      this.listen(input, "change", () => {
        this.activeInput = void 0;
        const value = normalize !== void 0 ? normalize(input.value) : input.value;
        if (value !== input.value) input.value = value;
        onValue(value);
        this.queueWrite(() => write(value), true);
      });
    }
    queueWrite(write, immediate) {
      if (!this.alive) return;
      const now = Date.now();
      const earliest = this.lastWriteAt + SLIDER_WRITE_MS;
      if (immediate || now >= earliest) {
        if (this.writeTimer !== null) {
          window.clearTimeout(this.writeTimer);
          this.writeTimer = null;
        }
        this.pendingWrite = void 0;
        this.lastWriteAt = now;
        write();
        return;
      }
      this.pendingWrite = write;
      if (this.writeTimer === null) {
        this.writeTimer = window.setTimeout(() => {
          this.writeTimer = null;
          const pending = this.pendingWrite;
          this.pendingWrite = void 0;
          this.lastWriteAt = Date.now();
          try {
            pending?.();
          } catch {
          }
        }, earliest - now);
      }
    }
    /** True when a refresh must not touch this control: focused or mid-drag. */
    held(element) {
      return element === this.activeInput || element === document.activeElement;
    }
    selectTab(id, focus = false) {
      this.activeTab = id;
      const u = this.nodes;
      if (!u) return;
      for (const [tabId, tabButton] of u.tabButtons) {
        const selected = tabId === id;
        tabButton.setAttribute("aria-selected", selected ? "true" : "false");
        tabButton.tabIndex = selected ? 0 : -1;
      }
      for (const [tabId, pane] of u.sections) pane.hidden = tabId !== id;
      u.body.setAttribute("aria-labelledby", `zct-tab-${id}`);
      if (focus) u.tabButtons.get(id)?.focus();
      if (id === "system") void this.refreshSystem();
      if (id === "status") this.syncStatus();
      if (id === "audio") this.syncAudio();
    }
    /**
     * Switches tabs on a click anywhere in the strip.
     *
     * Delegated from the container rather than bound per button, because the
     * buttons are rebuilt whenever the panel is remounted and a per-button
     * listener would have to be re-attached with them. The tab id comes from
     * `data-tab` rather than being parsed out of the element id, so a change to
     * the id scheme cannot silently stop the strip from working.
     *
     * This exists because the strip briefly shipped with a keyboard handler and
     * no click handler: the tabs were reachable with the arrow keys and inert
     * under the mouse, which a user reads as a frozen panel rather than as a
     * missing binding.
     */
    onTabsClick(ev) {
      const target = ev.target;
      if (!(target instanceof Element)) return;
      const button2 = target.closest("[data-tab]");
      if (!button2) return;
      const id = button2.getAttribute("data-tab");
      if (id && TABS.some((tab) => tab.id === id)) this.selectTab(id);
    }
    onTabsKeyDown(ev) {
      const order = TABS.map((tab) => tab.id);
      const index = order.indexOf(this.activeTab);
      let next;
      switch (ev.key) {
        case "ArrowRight":
          next = (index + 1) % order.length;
          break;
        case "ArrowLeft":
          next = (index - 1 + order.length) % order.length;
          break;
        case "Home":
          next = 0;
          break;
        case "End":
          next = order.length - 1;
          break;
        default:
          return;
      }
      ev.preventDefault();
      this.selectTab(order[next], true);
    }
    onDocumentKeyDown(ev) {
      if (ev.key !== "Escape" || !this.isOpen()) return;
      this.close();
    }
    onDragStart(ev) {
      const u = this.nodes;
      if (!u || ev.button !== 0) return;
      const target = ev.target;
      if (target instanceof Element && target.closest("button")) return;
      const rect = u.panel.getBoundingClientRect();
      this.drag = { pointerId: ev.pointerId, dx: ev.clientX - rect.left, dy: ev.clientY - rect.top };
      u.panel.style.right = "auto";
      u.panel.style.bottom = "auto";
      u.panel.style.left = `${rect.left}px`;
      u.panel.style.top = `${rect.top}px`;
      try {
        u.head.setPointerCapture(ev.pointerId);
      } catch {
      }
      ev.preventDefault();
    }
    onDragMove(ev) {
      const u = this.nodes;
      if (!u || !this.drag || ev.pointerId !== this.drag.pointerId) return;
      const x = clamp2(ev.clientX - this.drag.dx, 4, Math.max(4, window.innerWidth - 60));
      const y = clamp2(ev.clientY - this.drag.dy, 4, Math.max(4, window.innerHeight - 36));
      u.panel.style.left = `${x}px`;
      u.panel.style.top = `${y}px`;
    }
    onDragEnd(ev) {
      const u = this.nodes;
      if (!this.drag || ev.pointerId !== this.drag.pointerId) return;
      this.drag = void 0;
      try {
        u?.head.releasePointerCapture(ev.pointerId);
      } catch {
      }
    }
    clampIntoView() {
      const u = this.nodes;
      if (!u || u.panel.hidden) return;
      if (u.panel.style.left.length === 0) return;
      const rect = u.panel.getBoundingClientRect();
      u.panel.style.left = `${clamp2(rect.left, 4, Math.max(4, window.innerWidth - 60))}px`;
      u.panel.style.top = `${clamp2(rect.top, 4, Math.max(4, window.innerHeight - 36))}px`;
    }
    // --- preference rendering -------------------------------------------------
    applyPrefs(prefs) {
      const u = this.nodes;
      if (!u) return;
      const appearance = prefs.appearance;
      if (!this.held(u.bannerMode)) u.bannerMode.value = appearance.banner.mode;
      if (!this.held(u.bannerOpacity)) {
        u.bannerOpacity.value = String(appearance.banner.opacity);
        u.bannerOpacityValue.textContent = asPercent(Number(u.bannerOpacity.value));
      }
      if (!this.held(u.colorBackground)) {
        u.colorBackground.value = appearance.background;
        u.colorBackgroundValue.textContent = appearance.background;
      }
      if (!this.held(u.colorAccent)) {
        u.colorAccent.value = appearance.accent;
        u.colorAccentValue.textContent = appearance.accent;
      }
      const greeting = appearance.greeting;
      if (!this.held(u.greetingEnabled)) u.greetingEnabled.checked = greeting.enabled;
      if (!this.held(u.greetingLine1)) {
        u.greetingLine1.value = greeting.line1;
        u.greetingLine1Count.textContent = asCount(greeting.line1, GREETING_LINE1_MAX);
      }
      if (!this.held(u.greetingLine2)) {
        u.greetingLine2.value = greeting.line2;
        u.greetingLine2Count.textContent = asCount(greeting.line2, GREETING_LINE2_MAX);
      }
      this.syncGreetingReset();
      const audio = prefs.audio;
      if (!this.held(u.audioEnabled)) u.audioEnabled.checked = audio.enabled;
      if (!this.held(u.masterVolume)) {
        u.masterVolume.value = String(audio.masterVolume);
        u.masterVolumeValue.textContent = asPercent(Number(u.masterVolume.value));
      }
      if (!this.held(u.bgmEnabled)) u.bgmEnabled.checked = audio.bgm.enabled;
      if (!this.held(u.bgmVolume)) {
        u.bgmVolume.value = String(audio.bgm.volume);
        u.bgmVolumeValue.textContent = asPercent(Number(u.bgmVolume.value));
      }
      if (!this.held(u.sfxEnabled)) u.sfxEnabled.checked = audio.sfx.enabled;
      if (!this.held(u.sfxVolume)) {
        u.sfxVolume.value = String(audio.sfx.volume);
        u.sfxVolumeValue.textContent = asPercent(Number(u.sfxVolume.value));
      }
      for (const [event, input] of u.sfxEventInputs) {
        if (!this.held(input)) input.checked = audio.sfx.events[event] !== false;
      }
      if (!this.held(u.voiceEnabled)) u.voiceEnabled.checked = audio.voice.enabled;
      if (!this.held(u.voiceVolume)) {
        u.voiceVolume.value = String(audio.voice.volume);
        u.voiceVolumeValue.textContent = asPercent(Number(u.voiceVolume.value));
      }
      if (!this.held(u.voiceChance)) {
        u.voiceChance.value = String(audio.voice.chance);
        u.voiceChanceValue.textContent = asPercent(Number(u.voiceChance.value));
      }
      const pet = prefs.pet;
      if (!this.held(u.petEnabled)) u.petEnabled.checked = pet.enabled;
      if (!this.held(u.petScale)) {
        u.petScale.value = String(pet.scale);
        u.petScaleValue.textContent = asPixels(Number(u.petScale.value));
      }
      if (!this.held(u.petOpacity)) {
        u.petOpacity.value = String(pet.opacity);
        u.petOpacityValue.textContent = asPercent(Number(u.petOpacity.value));
      }
      if (!this.held(u.petVoiceOnClick)) u.petVoiceOnClick.checked = pet.voiceOnClick;
      const status = prefs.status;
      if (!this.held(u.statusEnabled)) u.statusEnabled.checked = status.enabled;
      if (!this.held(u.statusLanguage)) u.statusLanguage.value = status.language;
      for (const [trigger, input] of u.statusTriggerInputs) {
        if (!this.held(input)) input.checked = status.triggers[trigger] !== false;
      }
    }
  };

  // src/client/main.ts
  var STATE_KEY = "__zcodeTarkov";
  var BOOT_KEY = "__ZCT_BOOT__";
  var live;
  function destroyPrevious() {
    try {
      const previous = window[STATE_KEY];
      if (previous && typeof previous.destroy === "function") previous.destroy();
    } catch {
    }
    try {
      live?.destroy();
    } catch {
    }
    live = void 0;
  }
  function readBoot() {
    const raw = window[BOOT_KEY];
    if (!raw || typeof raw !== "object") return void 0;
    if (typeof raw.apiPort !== "number" || typeof raw.token !== "string" || typeof raw.mediaToken !== "string") {
      return void 0;
    }
    return {
      apiPort: raw.apiPort,
      token: raw.token,
      mediaToken: raw.mediaToken,
      version: typeof raw.version === "string" ? raw.version : "0.0.0-dev"
    };
  }
  function ensureUiRoot() {
    let style = document.getElementById(UI_STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = UI_STYLE_ID;
      (document.head ?? document.documentElement).appendChild(style);
    }
    const css = buildUiCss();
    if (style.textContent !== css) style.textContent = css;
    let root = document.getElementById(UI_ROOT_ID);
    if (!root) {
      root = document.createElement("div");
      root.id = UI_ROOT_ID;
      (document.body ?? document.documentElement).appendChild(root);
    }
    return root;
  }
  function removeUiRoot() {
    document.getElementById(UI_ROOT_ID)?.remove();
    document.getElementById(UI_STYLE_ID)?.remove();
  }
  function start() {
    const boot2 = readBoot();
    if (!boot2) {
      return;
    }
    destroyPrevious();
    const api = new HostApi(boot2);
    const seeded = defaultPrefs().audio;
    const audio = new AudioEngine({
      master: seeded.masterVolume,
      sfx: seeded.sfx.volume,
      bgm: seeded.bgm.volume,
      voice: seeded.voice.volume
    });
    let prefs = defaultPrefs();
    const prefsListeners = /* @__PURE__ */ new Set();
    const toastEl = { value: void 0 };
    let toastTimer = null;
    const uiRoot = ensureUiRoot();
    const listeners = [];
    const context = {
      api,
      audio,
      prefs: () => prefs,
      async patchPrefs(patch) {
        const result = await api.patchPrefs(patch);
        const next = result?.prefs ?? prefs;
        applyPrefs(next);
        return next;
      },
      onPrefs(listener) {
        prefsListeners.add(listener);
        return () => prefsListeners.delete(listener);
      },
      theme: () => clientTheme,
      syncTheme() {
        uiRoot.dataset.zctTheme = clientTheme;
      },
      toast(message) {
        if (!toastEl.value) {
          toastEl.value = document.createElement("div");
          toastEl.value.id = "zct-toast";
          toastEl.value.setAttribute("role", "status");
          toastEl.value.setAttribute("aria-live", "polite");
          uiRoot.appendChild(toastEl.value);
        }
        const el = toastEl.value;
        if (el.textContent !== message) el.textContent = message;
        if (toastTimer !== null) clearTimeout(toastTimer);
        toastTimer = setTimeout(() => {
          toastTimer = null;
          if (el.textContent === message) el.textContent = "";
        }, 2400);
      },
      toastError(err, fallback) {
        context.toast(errorMessage(err, fallback));
      },
      uiRoot: () => uiRoot
    };
    let clientTheme = "neutral";
    function applyPrefs(next) {
      prefs = next;
      const wanted = next.appearance.colorMode === "tarkov" ? "tarkov" : "neutral";
      if (wanted !== clientTheme) {
        clientTheme = wanted;
        uiRoot.dataset.zctTheme = wanted;
      }
      audio.applyVolumes({
        master: next.audio.masterVolume,
        sfx: next.audio.sfx.volume,
        bgm: next.audio.bgm.volume,
        voice: next.audio.voice.volume
      });
      for (const listener of prefsListeners) {
        try {
          listener(next);
        } catch (err) {
          console.warn("[zcode-tarkov] a preferences listener failed:", err);
        }
      }
    }
    const leader = new LeaderController({
      onRole: (role) => {
        if (role === "follower") bgm.pause();
      }
    });
    const bgm = new BgmPlayer({ ctx: context, audio, leader });
    const voice = new PetVoice(context);
    let panel;
    let dock;
    let pet;
    let roller;
    let watcher;
    let machine;
    try {
      dock = new BgmDock(context, bgm, {
        onOpenSettings: () => panel?.open(),
        onRequestExclusive: () => panel?.close()
      });
      dock.mount();
      pet = new Pet(context, voice, { onOpenSettings: () => panel?.open() });
      pet.mount();
      roller = new StatusRoller(context, { anchor: createStatusAnchor() });
      roller.start();
      panel = new SettingsPanel(
        context,
        { bgm, pet, status: roller },
        {
          onTestSfx: (event) => {
            void audio.tryUnlock().then((ok) => {
              if (ok) playSfx(event, audio.context, audio.bus("sfx"));
            });
          },
          onTestVoice: () => {
            void audio.tryUnlock().then((ok) => {
              if (ok) void voice.speak();
            });
          }
        }
      );
      panel.mount();
      bgm.start();
      leader.start();
      machine = new EventMachine();
      watcher = createSignalWatcher({
        onObservation: (observation) => {
          const events = machine.update(observation);
          for (const event of events) {
            const current = prefs;
            if (!current.audio.enabled || !current.audio.sfx.enabled) continue;
            if (current.audio.sfx.events[event] === false) continue;
            playSfx(event, audio.context, audio.bus("sfx"));
          }
          roller?.setPhase(machine.current);
        },
        onProgress: (kind) => roller?.onProgress(kind)
      });
      watcher.start();
      audio.installGestureUnlock();
      listeners.push(() => audio.removeGestureUnlock());
      void api.getPrefs().then((result) => applyPrefs(result?.prefs ?? defaultPrefs())).catch(() => {
        applyPrefs(defaultPrefs());
        context.toast("无法读取设置,已使用默认值");
      });
    } catch (err) {
      console.error("[zcode-tarkov] client start failed:", err);
      try {
        watcher?.stop();
      } catch {
      }
      try {
        roller?.dispose();
      } catch {
      }
      try {
        dock?.destroy();
      } catch {
      }
      try {
        pet?.destroy();
      } catch {
      }
      try {
        panel?.destroy();
      } catch {
      }
      try {
        voice.dispose();
      } catch {
      }
      try {
        bgm.dispose();
      } catch {
      }
      try {
        leader.stop();
      } catch {
      }
      audio.dispose();
      removeUiRoot();
      return;
    }
    const instance = {
      destroy() {
        for (const off of listeners) {
          try {
            off();
          } catch {
          }
        }
        listeners.length = 0;
        try {
          watcher?.stop();
        } catch {
        }
        try {
          roller?.dispose();
        } catch {
        }
        try {
          panel?.destroy();
        } catch {
        }
        try {
          dock?.destroy();
        } catch {
        }
        try {
          pet?.destroy();
        } catch {
        }
        try {
          voice.dispose();
        } catch {
        }
        try {
          bgm.dispose();
        } catch {
        }
        try {
          leader.stop();
        } catch {
        }
        audio.dispose();
        prefsListeners.clear();
        try {
          const boot3 = window[BOOT_KEY];
          if (boot3) {
            boot3.token = null;
            boot3.mediaToken = null;
          }
        } catch {
        }
        if (toastTimer !== null) clearTimeout(toastTimer);
        toastTimer = null;
        removeUiRoot();
        const g = window;
        if (g[STATE_KEY] === instance) g[STATE_KEY] = null;
      }
    };
    live = instance;
    window[STATE_KEY] = instance;
  }
  function boot() {
    if (document.body) {
      start();
      return;
    }
    document.addEventListener("DOMContentLoaded", () => start(), { once: true });
  }
  try {
    boot();
  } catch (err) {
    console.warn("[zcode-tarkov] client boot failed:", err);
  }
})();
