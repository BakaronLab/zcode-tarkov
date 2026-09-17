/**
 * Leader election across ZCode's renderers.
 *
 * ZCode can have more than one renderer live at once — a second window, a
 * detached panel — and every one of them runs the injected client. If each one
 * played its own copy of the background music the user would hear the same
 * track twice, slightly out of phase. Exactly one renderer must own playback.
 *
 * The mechanism is a lease in `localStorage`, announced over a
 * `BroadcastChannel`, because those are the only two primitives every renderer
 * of the same origin shares:
 *
 *  - A single key (`zct:leader`) holds `{ id, expiresAt }`. Whoever's id is in
 *    it and unexpired is the leader.
 *  - The leader renews the lease on a heartbeat well inside its lifetime.
 *  - A follower that finds the lease expired, or missing, may claim it — after a
 *    jittered delay, so that two followers waking at the same instant do not
 *    both write.
 *  - A claim is only believed after a re-read: the writer waits a short moment
 *    and confirms its own id survived. Two renderers that raced are resolved by
 *    whoever's id is in the key, and the loser simply stays a follower.
 *
 * Two failure modes are the reason for the re-read and the expiry:
 *
 *  - **A stale leader must not lock the room.** If a renderer is killed without
 *    releasing, its lease expires on its own and the survivors elect a new one.
 *  - **A partition must not produce two leaders.** Two renderers that cannot see
 *    each other's writes both read an expired lease and both claim; the re-read
 *    makes the second writer observe the first writer's id and stand down.
 *
 * This module is written as a pure core (`LeaderCore`, no globals, injected
 * clock and store) plus a thin controller that binds it to the browser's
 * `localStorage`, `BroadcastChannel` and timers. The core is what the tests
 * drive, so the lease arithmetic is verified without a browser.
 */

export interface LeaderLease {
  id: string;
  expiresAt: number;
}

/** Persistence for the lease. Only one key is ever used. */
export interface LeaseStore {
  read(): string | undefined;
  write(value: string): void;
}

export const LEADER_KEY = "zct:leader";
export const LEADER_CHANNEL = "zcode-tarkov";

/** How long a lease is good for. Comfortably longer than a heartbeat. */
export const LEASE_MS = 12_000;
/** How often the leader renews, and followers look for an opening. */
export const HEARTBEAT_MS = 4_000;
/** Upper bound on the random delay before claiming, to break ties. */
export const CLAIM_JITTER_MS = 250;

export function parseLease(raw: string | undefined): LeaderLease | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<LeaderLease>;
    if (typeof parsed?.id !== "string" || parsed.id.length === 0) return undefined;
    if (typeof parsed?.expiresAt !== "number" || !Number.isFinite(parsed.expiresAt)) return undefined;
    return { id: parsed.id, expiresAt: parsed.expiresAt };
  } catch {
    return undefined;
  }
}

export class LeaderCore {
  private leader = false;

  constructor(
    readonly id: string,
    private readonly store: LeaseStore,
    private readonly now: () => number,
    private readonly leaseMs: number = LEASE_MS
  ) {}

  /** The current lease, or undefined when there is none or it is malformed. */
  current(): LeaderLease | undefined {
    return parseLease(this.store.read());
  }

  /** True when the stored lease names us and has not expired. */
  private holdsLease(): boolean {
    const lease = this.current();
    return lease !== undefined && lease.id === this.id && lease.expiresAt > this.now();
  }

  /** True when nobody holds a live lease. */
  private isFree(): boolean {
    const lease = this.current();
    return lease === undefined || lease.expiresAt <= this.now();
  }

  isLeader(): boolean {
    // The local flag is an optimisation; the lease is the truth, so a lease
    // that was taken away by a racing writer is noticed on the next call.
    if (this.leader && !this.holdsLease()) this.leader = false;
    return this.leader;
  }

  /** Renews our lease if we hold it. Returns true when we still hold it. */
  renew(): boolean {
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
  claimIfFree(): boolean {
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
  confirm(): boolean {
    this.leader = this.holdsLease();
    return this.leader;
  }

  /** Gives up the lease so a follower can take over immediately. */
  release(): void {
    if (this.holdsLease()) {
      this.store.write(JSON.stringify({ id: "", expiresAt: 0 }));
    }
    this.leader = false;
  }

  private write(): void {
    this.store.write(JSON.stringify({ id: this.id, expiresAt: this.now() + this.leaseMs }));
  }
}

export type LeaderRole = "leader" | "follower";

export interface LeaderControllerOptions {
  /** Called whenever the role changes, so the caller can start/stop playback. */
  onRole(role: LeaderRole): void;
  leaseMs?: number;
  heartbeatMs?: number;
  random?: () => number;
}

/**
 * Binds `LeaderCore` to the browser: timer, `localStorage`, `BroadcastChannel`.
 *
 * Everything is guarded. A renderer with storage disabled (private mode, a
 * quota-exceeded profile) gets a single-renderer fallback — it becomes its own
 * leader — rather than a broken client, because the common case really is one
 * renderer and refusing to play music there would be a worse failure than the
 * duplicate-playback problem this module exists to solve.
 */
export class LeaderController {
  private readonly core: LeaderCore | undefined;
  private timer: number | null = null;
  private channel: BroadcastChannel | null = null;
  private role: LeaderRole = "follower";
  private readonly random: () => number;

  constructor(
    private readonly options: LeaderControllerOptions,
    private readonly id: string = randomId()
  ) {
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
      // No storage: this renderer cannot coordinate, so it leads alone.
      this.role = "leader";
    }
  }

  start(): void {
    if (this.timer !== null) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.options.heartbeatMs ?? HEARTBEAT_MS) as unknown as number;
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    try {
      this.core?.release();
    } catch {
      /* storage gone */
    }
    this.setRole("follower");
    try {
      this.channel?.close();
    } catch {
      /* already closed */
    }
    this.channel = null;
  }

  isLeader(): boolean {
    return this.role === "leader";
  }

  /** Sends a message to the other renderers; used to forward dock commands. */
  broadcast(message: unknown): void {
    try {
      this.channel?.postMessage(message);
    } catch {
      /* channel closed */
    }
  }

  onMessage(handler: (message: unknown) => void): void {
    this.messageHandlers.push(handler);
  }

  private readonly messageHandlers: Array<(message: unknown) => void> = [];

  private dispatch(data: unknown): void {
    if (data && typeof data === "object" && (data as { type?: unknown }).type === "release") {
      // A leader stepping down frees the lease early, so the next tick can
      // promote a follower instead of waiting out the expiry.
      this.tick();
      return;
    }
    for (const handler of this.messageHandlers) {
      try {
        handler(data);
      } catch {
        /* a handler must not break the election */
      }
    }
  }

  private tick(): void {
    if (!this.core) return;
    if (this.core.isLeader()) {
      if (!this.core.renew()) this.setRole("follower");
      else this.setRole("leader");
      return;
    }
    // Followers only try when the lease looks free, and then wait a jittered
    // moment before confirming — the delay is what serialises simultaneous
    // claims.
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

  private setRole(role: LeaderRole): void {
    if (this.role === role) return;
    this.role = role;
    try {
      this.options.onRole(role);
    } catch {
      /* a listener must not break the election */
    }
  }
}

function createCore(id: string, leaseMs?: number): LeaderCore | undefined {
  try {
    // Touch the API, not just the reference: a disabled-storage profile throws
    // on the first write, and that must be discovered now rather than on a
    // heartbeat in the middle of playback.
    const probe = "__zct_probe__";
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    const store: LeaseStore = {
      read: () => {
        try {
          return window.localStorage.getItem(LEADER_KEY) ?? undefined;
        } catch {
          return undefined;
        }
      },
      write: (value: string) => {
        try {
          window.localStorage.setItem(LEADER_KEY, value);
        } catch {
          /* quota or disabled; the core's re-read will notice */
        }
      },
    };
    return new LeaderCore(id, store, () => Date.now(), leaseMs);
  } catch {
    return undefined;
  }
}

/** A per-renderer identity. Random, not persisted: a reload is a new claimant. */
export function randomId(): string {
  try {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return Math.random().toString(16).slice(2, 18);
  }
}
