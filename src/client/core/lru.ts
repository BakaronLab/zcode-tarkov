/**
 * A size-bounded least-recently-used cache.
 *
 * Decoded audio is the only thing this is used for, and the reason it is
 * bounded by *bytes* rather than by entry count is that audio entries are not
 * comparable: a decoded scav voice clip is ~40 KB and a decoded five-minute
 * track is ~50 MB. Counting entries would either cap the pool far too early or
 * let a handful of tracks consume hundreds of megabytes.
 *
 * The contract, stated so it can be tested:
 *  - `get` marks an entry as most recently used;
 *  - inserting an entry that alone exceeds the budget evicts everything else and
 *    is then *not* stored (it could never be kept, and storing it would leave
 *    the cache permanently over budget);
 *  - eviction is oldest-first until the total fits, never evicting the entry
 *    just inserted.
 */

export interface LruEntry<T> {
  value: T;
  bytes: number;
}

export class LruCache<T> {
  private readonly map = new Map<string, LruEntry<T>>();
  private totalBytes = 0;

  constructor(private readonly maxBytes: number) {}

  get size(): number {
    return this.map.size;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  /**
   * Reads an entry, promoting it to most-recently-used.
   *
   * `Map` iterates in insertion order, so the cheapest way to mark recency is to
   * delete and re-insert; that keeps the first key the least recently used
   * without a separate ordering structure.
   */
  get(key: string): T | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  /** Reads without promoting; for "can I avoid a fetch?" checks. */
  peek(key: string): T | undefined {
    return this.map.get(key)?.value;
  }

  set(key: string, value: T, bytes: number): void {
    if (this.map.has(key)) {
      const existing = this.map.get(key)!;
      this.totalBytes -= existing.bytes;
      this.map.delete(key);
    }
    // An entry larger than the whole budget can never be cached: the only
    // alternatives are to hold it and be permanently over budget, or to evict
    // everything else for one entry. Neither is worth it, so it is dropped and
    // the caller simply decodes it again next time.
    if (bytes > this.maxBytes) {
      this.map.clear();
      this.totalBytes = 0;
      return;
    }
    this.map.set(key, { value, bytes });
    this.totalBytes += bytes;
    this.evict();
  }

  delete(key: string): void {
    const entry = this.map.get(key);
    if (!entry) return;
    this.map.delete(key);
    this.totalBytes -= entry.bytes;
  }

  clear(): void {
    this.map.clear();
    this.totalBytes = 0;
  }

  /** Keys from least to most recently used. */
  keys(): string[] {
    return [...this.map.keys()];
  }

  private evict(): void {
    while (this.totalBytes > this.maxBytes && this.map.size > 0) {
      const oldest = this.map.keys().next();
      if (oldest.done) return;
      this.delete(oldest.value);
    }
  }
}
