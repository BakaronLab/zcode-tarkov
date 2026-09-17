/**
 * The injected client's view of the host API.
 *
 * Two tokens, because there are two kinds of caller:
 *
 *  - `token` authenticates every JSON request, in the `x-zb-token` header. Only
 *    the injected script has it.
 *  - `mediaToken` may appear in a query string, because `<audio>` and `<img>`
 *    cannot set headers. It only authorises reading media.
 *
 * Every method resolves or rejects with a plain `Error` carrying the server's
 * own message, and nothing here retries: the caller (a dock button, a poller)
 * decides what a failure means, and a hidden retry loop under a click handler is
 * how a UI ends up reporting success for something that never happened.
 */

export interface ClientBoot {
  /** Port of the host service. */
  apiPort: number;
  /** Full-access token, header only. */
  token: string;
  /** Read-only token, usable in a query string. */
  mediaToken: string;
  /** Plugin version, for the System section. */
  version: string;
}

export interface TrackInfo {
  id: string;
  filename: string;
  displayName: string;
  enabled: boolean;
  size: number;
  mtimeMs: number;
  durationSeconds?: number;
}

export interface PoolEntryInfo {
  id: string;
  filename: string;
  size: number;
}

export interface SystemInfo {
  version: string;
  service: string;
  pid: number;
  startedAt: string;
  uptimeSeconds: number;
  dataRoot: string;
  mediaDirs: { kind: string; path: string }[];
  prefs: { migratedFrom?: string; recovered?: { reason: string; backup?: string } };
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

export class HostApi {
  private readonly base: string;

  constructor(private readonly boot: ClientBoot) {
    this.base = `http://127.0.0.1:${boot.apiPort}`;
  }

  get mediaToken(): string {
    return this.boot.mediaToken;
  }

  get version(): string {
    return this.boot.version;
  }

  /** The URL an `<audio>`/`<img>` element can load directly. */
  mediaUrl(kind: string, name: string): string {
    return `${this.base}/api/media/${encodeURIComponent(kind)}/${encodeURIComponent(name)}?token=${encodeURIComponent(this.boot.mediaToken)}`;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers);
    headers.set("x-zb-token", this.boot.token);
    const res = await fetch(`${this.base}${path}`, { ...init, headers });
    const text = await res.text();
    let parsed: unknown;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }
    if (!res.ok) {
      const message =
        parsed && typeof parsed === "object" && typeof (parsed as { error?: unknown }).error === "string"
          ? (parsed as { error: string }).error
          : `request failed (${res.status})`;
      throw new ApiError(message, res.status);
    }
    return parsed as T;
  }

  private post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
  }

  // --- prefs --------------------------------------------------------------
  getPrefs(): Promise<{ prefs: unknown; status: { migratedFrom?: string; recovered?: { reason: string } } }> {
    return this.request("/api/prefs");
  }

  patchPrefs(patch: unknown): Promise<{ ok: true; prefs: unknown }> {
    return this.post("/api/prefs", patch);
  }

  // --- library ------------------------------------------------------------
  getLibrary(): Promise<{ tracks: TrackInfo[]; current: string | null; empty: boolean }> {
    return this.request("/api/library/music");
  }

  /**
   * Uploads a track.
   *
   * Uses `XMLHttpRequest` rather than `fetch` for one reason: it reports upload
   * progress, and a 200 MB file with no progress bar reads as a hung panel.
   */
  uploadTrack(
    file: File,
    onProgress?: (fraction: number) => void
  ): Promise<{ ok: true; filename: string; size: number; replaced: boolean }> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${this.base}/api/library/music/add?name=${encodeURIComponent(file.name)}`);
      xhr.setRequestHeader("x-zb-token", this.boot.token);
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.upload.onprogress = (ev) => {
        if (onProgress && ev.lengthComputable && ev.total > 0) onProgress(ev.loaded / ev.total);
      };
      xhr.onload = () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(xhr.responseText);
        } catch {
          parsed = undefined;
        }
        if (xhr.status >= 200 && xhr.status < 300) resolve(parsed as { ok: true; filename: string; size: number; replaced: boolean });
        else {
          const message =
            parsed && typeof parsed === "object" && typeof (parsed as { error?: unknown }).error === "string"
              ? (parsed as { error: string }).error
              : `upload failed (${xhr.status})`;
          reject(new ApiError(message, xhr.status));
        }
      };
      xhr.onerror = () => reject(new ApiError("upload failed: the service is unreachable", 0));
      xhr.send(file);
    });
  }

  deleteTrack(name: string): Promise<{ ok: true; removed: number }> {
    return this.post("/api/library/music/delete", { name });
  }

  toggleTrack(name: string, enabled?: boolean): Promise<{ ok: true; name: string; enabled: boolean }> {
    return this.post("/api/library/music/toggle", { name, enabled });
  }

  // --- pools --------------------------------------------------------------
  getPool(kind: "sounds" | "voice" | "pet" | "status"): Promise<{ kind: string; entries: PoolEntryInfo[] }> {
    return this.request(`/api/pool/${kind}`);
  }

  deletePoolFile(kind: "sounds" | "voice" | "pet", name: string): Promise<{ ok: true; removed: number }> {
    return this.post(`/api/pool/${kind}/delete`, { name });
  }

  getStatusPhrases(language?: "zh" | "en"): Promise<{
    language: string;
    source: "user" | "bundled";
    count: number;
    phrases: string[];
  }> {
    return this.request(`/api/status/phrases${language ? `?lang=${language}` : ""}`);
  }

  getSystem(): Promise<SystemInfo> {
    return this.request("/api/system");
  }

  // --- v0.1 appearance routes (kept; the panel still drives them) ----------
  getConfig(): Promise<Record<string, unknown>> {
    return this.request("/api/config");
  }

  setConfig(patch: unknown): Promise<Record<string, unknown>> {
    return this.post("/api/config", patch);
  }

  getStatus(): Promise<Record<string, unknown>> {
    return this.request("/api/status");
  }

  reset(): Promise<Record<string, unknown>> {
    return this.post("/api/reset", {});
  }

  restore(): Promise<Record<string, unknown>> {
    return this.post("/api/restore", {});
  }

  setRecovery(mode: string): Promise<Record<string, unknown>> {
    return this.post("/api/recovery", { mode });
  }

  relaunch(): Promise<Record<string, unknown>> {
    return this.post("/api/relaunch", {});
  }

  setWallpaper(dataUri: string, name: string): Promise<Record<string, unknown>> {
    return this.post("/api/wallpaper", { dataUri, name });
  }
}
