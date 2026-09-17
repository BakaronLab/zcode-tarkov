/**
 * `serve` mode: a localhost-only control API plus persistent injection
 * sessions.
 *
 * The injected settings panel (src/panel) talks to this API to read and change
 * the live configuration. Injection connections are held open so that
 * Page.addScriptToEvaluateOnNewDocument keeps re-running across renderer
 * reloads for as long as this process lives — no polling reinjection needed
 * while a session is healthy.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  CdpConnection,
  buildBootstrapScript,
  buildResetScript,
  listTargets,
  pickRendererTargets,
} from "./cdp.js";
import { buildPayload, DEFAULT_CONFIG, resolveColorMode, type BeautifyConfig } from "./inject.js";
import { isColorMode } from "./colorMode.js";
import { loadWallpaper, type WallpaperAssets } from "./monet.js";
import { buildPanelScript } from "../panel/panelScript.js";
import { dataDir, initSettings, isZcodeProcessRunning, loadConfig, readJsonFile, relaunchZcode, saveConfig } from "./launch.js";
import { ensureDataRoot } from "./dataRoot.js";
import { BANNER_MODES } from "../prefs/types.js";
import { resolvePalette } from "../themes/palette.js";
import { applyRecoveryMode, loadRecovery, normalizeMode } from "./recovery.js";
import { cliEntryPath, getAutostartStatus } from "./autostart.js";
import { getPrefs, prefsLoadInfo, setPrefs } from "../prefs/store.js";
import { handleHostRoute } from "../api/hostRoutes.js";
import { buildClientScript, CLIENT_BOOT_GLOBAL } from "../client/boot.js";
import { pluginVersion } from "./version.js";

const MAX_WALLPAPER_BYTES = 20 * 1024 * 1024;
const MAX_BODY_BYTES = MAX_WALLPAPER_BYTES + 1024 * 1024;
const POLL_MS = 1500;

/**
 * The service's own name, as reported by `/api/health` and by any log line that
 * identifies it.
 *
 * `zcode-beautify` was the v0.1 name and is still *accepted* on read, so a CLI
 * or launcher from an older install can recognise a running v0.2 service instead
 * of starting a second one on the same port; the reverse (a v0.2 CLI finding a
 * v0.1 service) is handled by the same list, which is exactly the upgrade path
 * that matters.
 */
export const SERVICE_ID = "zcode-tarkov";
export const LEGACY_SERVICE_IDS = ["zcode-beautify"];

/**
 * True when a `/api/health` payload came from this product.
 *
 * Both names count, in both directions: a v0.2 CLI must find a running v0.1
 * service (and refuse to start a second one on the same port), and a v0.1 CLI
 * must find a running v0.2 service. Anything that identified itself as ours is
 * ours, regardless of which release it came from.
 */
export function isOurService(name: unknown): boolean {
  return typeof name === "string" && (name === SERVICE_ID || LEGACY_SERVICE_IDS.includes(name));
}

export interface ServeOptions {
  cdpPort: number;
  apiPort: number;
}

interface HeldSession {
  conn: CdpConnection;
  themeScriptId?: string;
}

/**
 * What the last poll saw. The panel has to tell three situations apart — healthy,
 * "ZCode is running but its debug port is closed", and "ZCode is not running" —
 * because each one asks the user for something different.
 */
interface RuntimeState {
  cdpReachable: boolean;
  rendererCount: number;
  zcodeRunning: boolean;
  lastError?: string;
  updatedAt?: string;
}

let runtimeState: RuntimeState = { cdpReachable: false, rendererCount: 0, zcodeRunning: false };

/** Walking the process table on every failed poll would be wasteful. */
let nextProcessProbe = 0;

// One decoded image + extracted theme, reused across slider updates so the
// panel feels instant. Invalidated whenever the wallpaper file changes.
let cachedAssets: { file: string; mtimeMs: number; assets: WallpaperAssets } | undefined;

async function getAssets(wallpaperPath?: string): Promise<WallpaperAssets | undefined> {
  if (!wallpaperPath || !fs.existsSync(wallpaperPath)) return undefined;
  const mtimeMs = fs.statSync(wallpaperPath).mtimeMs;
  if (cachedAssets?.file === wallpaperPath && cachedAssets.mtimeMs === mtimeMs) {
    return cachedAssets.assets;
  }
  const assets = await loadWallpaper(wallpaperPath);
  cachedAssets = { file: wallpaperPath, mtimeMs, assets };
  return assets;
}

function currentConfig(): BeautifyConfig {
  return { ...DEFAULT_CONFIG, ...loadConfig() };
}

function backupFile(): string {
  return path.join(dataDir(), "config.backup.json");
}

function hasBackup(): boolean {
  return fs.existsSync(backupFile());
}

function publicConfig(config: BeautifyConfig) {
  return {
    blur: config.blur,
    dim: config.dim,
    monet: config.monet,
    colorMode: resolveColorMode(config),
    banner: config.banner ?? DEFAULT_CONFIG.banner,
    wallpaperVisible: config.wallpaperVisible,
    fit: config.fit,
    wallpaperSet: Boolean(config.wallpaperPath && fs.existsSync(config.wallpaperPath)),
    hasBackup: hasBackup(),
    cdpPort: config.port,
  };
}

function sanitize(body: any): Partial<BeautifyConfig> {
  const out: Partial<BeautifyConfig> = {};
  if (typeof body?.blur === "number" && body.blur >= 0 && body.blur <= 100) out.blur = body.blur;
  if (typeof body?.dim === "number" && body.dim >= 0 && body.dim <= 100) out.dim = body.dim;
  // `colorMode` is authoritative; a bare `monet` boolean is still accepted so
  // existing callers (and the old panel) keep working.
  if (isColorMode(body?.colorMode)) out.colorMode = body.colorMode;
  else if (typeof body?.monet === "boolean") out.colorMode = body.monet ? "monet" : "native";
  if (typeof body?.wallpaperVisible === "boolean") out.wallpaperVisible = body.wallpaperVisible;
  if (body?.fit === "cover" || body?.fit === "contain" || body?.fit === "smart") out.fit = body.fit;

  const banner = sanitizeBanner(body?.banner);
  if (banner) out.banner = banner;
  return out;
}

/**
 * Banner overrides are additive: unspecified fields keep their current value.
 *
 * The v0.1 body carried `enabled: boolean`; v0.2 replaced it with a three-valued
 * `mode`. `enabled` is still honored because a v0.1 caller — an older panel left
 * open across an upgrade — sends it and nothing else, and a request that asks
 * for the band to be switched off must switch it off. `mode` wins when both are
 * present, since it is the field the v0.2 UI actually reads.
 */
function sanitizeBanner(raw: any): BeautifyConfig["banner"] | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out = { ...DEFAULT_CONFIG.banner };
  let touched = false;
  if (typeof raw.mode === "string" && (BANNER_MODES as readonly string[]).includes(raw.mode)) {
    out.mode = raw.mode as (typeof BANNER_MODES)[number];
    out.enabled = out.mode !== "off";
    touched = true;
  } else if (typeof raw.enabled === "boolean") {
    out.enabled = raw.enabled;
    out.mode = raw.enabled ? "full" : "off";
    touched = true;
  }
  if (typeof raw.text1 === "string" && raw.text1.length > 0 && raw.text1.length <= 240) {
    out.text1 = raw.text1;
    touched = true;
  }
  if (typeof raw.text2 === "string" && raw.text2.length > 0 && raw.text2.length <= 400) {
    out.text2 = raw.text2;
    touched = true;
  }
  if (typeof raw.opacity === "number" && raw.opacity >= 0 && raw.opacity <= 1) {
    out.opacity = raw.opacity;
    touched = true;
  }
  if (typeof raw.height === "number" && raw.height >= 24 && raw.height <= 160) {
    out.height = Math.round(raw.height);
    touched = true;
  }
  return touched ? out : undefined;
}

// --- injection session management -------------------------------------------

const held = new Map<string, HeldSession>();

async function registerScript(
  session: HeldSession,
  source: string
): Promise<string> {
  const { identifier } = await session.conn.send("Page.addScriptToEvaluateOnNewDocument", { source });
  return identifier;
}

async function holdSession(
  target: { id: string; webSocketDebuggerUrl?: string },
  config: BeautifyConfig,
  apiPort: number,
  token: string,
  mediaToken: string
): Promise<void> {
  if (!target.webSocketDebuggerUrl) return;
  const conn = await CdpConnection.connect(target.webSocketDebuggerUrl);
  // Anything that fails once the socket is up has to close it: the caller
  // retries every tick, so a connection dropped on the floor here would leave
  // one orphaned WebSocket per tick for as long as the failure lasts.
  try {
    await conn.send("Page.enable");
    const session: HeldSession = { conn };

    const assets = await getAssets(config.wallpaperPath);
    const payload = buildPayload(config, assets);
    const bootstrap = buildBootstrapScript({
      css: payload.css,
      wallpaperDataUri: payload.wallpaperDataUri,
      fit: payload.fit,
      banner: payload.banner,
    });
    const { identifier } = await conn.send("Page.addScriptToEvaluateOnNewDocument", {
      source: bootstrap,
    });
    session.themeScriptId = identifier;
    await conn.send("Runtime.evaluate", { expression: bootstrap, returnByValue: true });

    const panelScript = buildPanelScript(
      apiPort,
      token,
      resolvePalette({ background: config.background, accent: config.accent })
    );
    await conn.send("Page.addScriptToEvaluateOnNewDocument", { source: panelScript });
    await conn.send("Runtime.evaluate", { expression: panelScript, returnByValue: true });

    // The v0.2 client (audio, dock, pet, status, settings centre). A missing
    // bundle is a build problem, not a renderer problem: it is reported once and
    // the theme and the v0.1 panel stay working, which is the right blast radius
    // for a packaging mistake.
    try {
      const clientScript = buildClientScript({ apiPort, token, mediaToken, version: pluginVersion() });
      await conn.send("Page.addScriptToEvaluateOnNewDocument", { source: clientScript });
      await conn.send("Runtime.evaluate", { expression: clientScript, returnByValue: true });
    } catch (err) {
      if (!warnedAboutClientBundle) {
        warnedAboutClientBundle = true;
        console.error(`serve: the v0.2 client was not injected — ${(err as Error).message}`);
      }
    }

    held.set(target.id, session);
  } catch (err) {
    conn.close();
    throw err;
  }
}

/** Set when the bundle warning has already been logged, so it is said once. */
let warnedAboutClientBundle = false;

/** Re-evaluates the theme bootstrap in every live session after a config change. */
async function pushConfigToSessions(
  config: BeautifyConfig,
  apiPort: number,
  token: string
): Promise<number> {
  const assets = await getAssets(config.wallpaperPath);
  const payload = buildPayload(config, assets);
  const bootstrap = buildBootstrapScript({
    css: payload.css,
    wallpaperDataUri: payload.wallpaperDataUri,
    fit: payload.fit,
    banner: payload.banner,
  });
  // The v0.1 panel carries its own Tarkov skin, accent included, built from the
  // palette at injection time. Re-pushing only the theme bootstrap would leave
  // that panel on the colour it was first injected with — a stale accent in the
  // one surface a user is most likely to be looking at while they change it.
  // Re-evaluating the panel script is idempotent: it removes any previous copy
  // of itself before installing.
  const panelScript = buildPanelScript(
    apiPort,
    token,
    resolvePalette({ background: config.background, accent: config.accent })
  );
  let ok = 0;
  for (const [id, session] of held) {
    try {
      if (session.themeScriptId) {
        await session.conn
          .send("Page.removeScriptToEvaluateOnNewDocument", { identifier: session.themeScriptId })
          .catch(() => {});
      }
      session.themeScriptId = await registerScript(session, bootstrap);
      await session.conn.send("Runtime.evaluate", { expression: bootstrap, returnByValue: true });
      await session.conn
        .send("Runtime.evaluate", { expression: panelScript, returnByValue: true })
        .catch(() => {});
      ok++;
    } catch {
      session.conn.close();
      held.delete(id);
    }
  }
  return ok;
}

async function poll(
  config: BeautifyConfig,
  apiPort: number,
  token: string,
  mediaToken: string
): Promise<void> {
  try {
    const targets = pickRendererTargets(await listTargets(config.port));
    const current = new Set(targets.map((t) => t.id));
    for (const t of targets) {
      if (!held.has(t.id)) {
        try {
          await holdSession(t, config, apiPort, token, mediaToken);
          console.log(`serve: panel + theme injected into "${t.title}" (${t.id})`);
        } catch {
          /* retry next tick */
        }
      }
    }
    for (const id of [...held.keys()]) {
      if (!current.has(id)) {
        held.get(id)!.conn.close();
        held.delete(id);
      }
    }
    runtimeState = {
      cdpReachable: true,
      rendererCount: targets.length,
      zcodeRunning: true,
      updatedAt: new Date().toISOString(),
    };
  } catch (err) {
    // No CDP endpoint: either ZCode is closed, or it is running without the
    // debug port. Either way the held sockets are dead weight — drop them so a
    // later restart injects afresh instead of matching a stale target id.
    for (const [id, session] of held) {
      session.conn.close();
      held.delete(id);
    }
    if (Date.now() > nextProcessProbe) {
      nextProcessProbe = Date.now() + 15_000;
      runtimeState = {
        cdpReachable: false,
        rendererCount: 0,
        zcodeRunning: await isZcodeProcessRunning(),
        lastError: (err as Error).message,
        updatedAt: new Date().toISOString(),
      };
    }
  }
}

// --- HTTP API ----------------------------------------------------------------

function sendJson(res: http.ServerResponse, code: number, body: unknown): void {
  // The client can vanish mid-request (panel closed, renderer reloaded); a
  // write to a dead socket must not escape as a rejection.
  try {
    res.writeHead(code, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end(JSON.stringify(body));
  } catch {
    /* response already finished or socket gone */
  }
}

/** Only the injected panel carries the token; nothing else on the machine has it. */
function authorized(req: http.IncomingMessage, token: string): boolean {
  const header = req.headers["x-zb-token"];
  return typeof header === "string" && header.length > 0 && header === token;
}

/** True when another `serve` of this plugin already owns the port. */
export async function existingServePid(apiPort: number): Promise<number | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${apiPort}/api/health`, {
      signal: AbortSignal.timeout(1000),
    });
    const body = (await res.json()) as { service?: string; pid?: number };
    return isOurService(body?.service) ? body.pid : undefined;
  } catch {
    return undefined;
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const IMAGE_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/bmp": ".bmp",
};

export async function startServe(opts: ServeOptions): Promise<void> {
  const { cdpPort, apiPort } = opts;

  // Load (and migrate) the settings before the first request can arrive, so a
  // slow disk shows up at start-up rather than as a panel that hangs once.
  initSettings();

  // Materialise the data tree at start-up rather than lazily on the first
  // settings write. The README tells users to drop their music into these
  // folders, and a folder that only appears after they change a setting is a
  // folder they will conclude does not exist.
  try {
    ensureDataRoot();
  } catch (err) {
    // A read-only or full disk must not stop the service: the theme and the
    // panel are still useful, and the first write that fails will report it.
    console.error(`serve: could not create the user data directory — ${(err as Error).message}`);
  }

  // Recorded once so `/api/system` can report uptime without a second clock.
  const startedAt = Date.now();

  // This API can replace the user's wallpaper and even relaunch ZCode, and it
  // answers anything that can reach localhost. The token only ever travels
  // inside the injected panel script, so a random web page cannot drive it.
  const token = randomBytes(16).toString("hex");

  // A second, strictly weaker secret for media reads. `<audio>` and `<img>`
  // cannot attach a header, so this one is allowed in a query string — and it
  // authorises nothing but reading media, because a URL ends up in logs and
  // history where a full-access token must never appear.
  const mediaToken = randomBytes(16).toString("hex");

  // `serve --port N` must win over the port stored in the config file: reading
  // the merged config alone silently dialed the stored port while still
  // printing the flag's value.
  const runtimeConfig = (): BeautifyConfig => ({ ...currentConfig(), port: cdpPort });
  /** What actually goes to disk — the CLI's --port is not a persisted setting. */
  const persisted = (config: BeautifyConfig): BeautifyConfig => ({
    ...config,
    port: currentConfig().port,
  });

  const already = await existingServePid(apiPort);
  if (already !== undefined) {
    throw new Error(
      `a beautify service is already running on http://127.0.0.1:${apiPort} (pid ${already}) — ` +
        `open its panel, or stop that process first`
    );
  }

  // A request handler that rejects would otherwise take the whole process down
  // (unhandled rejection), killing every held injection session with it.
  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch(() => {
      try {
        res.destroy();
      } catch {
        /* socket gone */
      }
    });
  });

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    try {
      if (req.method === "OPTIONS") {
        sendJson(res, 204, {});
        return;
      }

      // The v0.2 surface (prefs, media library, byte-range streaming) carries
      // its own authorisation, because media reads accept the weaker query
      // token and the v0.1 check below would reject them.
      const handled = await handleHostRoute({
        method: req.method ?? "GET",
        url,
        req,
        res,
        token,
        mediaToken,
        readPrefs: getPrefs,
        writePrefs: async (next) => {
          setPrefs(next);
          // The band, the wallpaper and the palette are not merely stored — they
          // are part of the payload the service injects. Writing the file and
          // stopping there would make the settings panel's band switch look like
          // it worked while the band on screen did not move until something else
          // happened to trigger a push. The route awaits this, so the panel's
          // confirmation is sent only after the renderer has the new payload.
          await pushConfigToSessions(runtimeConfig(), apiPort, token).catch(() => 0);
        },
        prefsStatus: prefsLoadInfo,
        version: pluginVersion(),
        startedAt,
        sendJson,
      });
      if (handled) return;

      // /api/health stays open: it identifies the service but exposes nothing,
      // and the CLI relies on it to detect an already-running instance.
      if (url.pathname !== "/api/health" && !authorized(req, token)) {
        sendJson(res, 403, { error: "missing or invalid token" });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/config") {
        sendJson(res, 200, publicConfig(runtimeConfig()));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/config") {
        const patch = sanitize(JSON.parse(await readBody(req)));
        const config = { ...runtimeConfig(), ...patch };
        saveConfig(persisted(config));
        const windows = await pushConfigToSessions(config, apiPort, token).catch(() => 0);
        sendJson(res, 200, { ok: true, windows, ...publicConfig(config) });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/wallpaper") {
        const body = JSON.parse(await readBody(req));
        const dataUri = typeof body?.dataUri === "string" ? body.dataUri : "";
        const m = /^data:(image\/(?:jpeg|png|webp|gif|bmp));base64,(.+)$/.exec(dataUri);
        if (!m) throw new Error("dataUri must be a base64 image data URI");
        const bytes = Buffer.from(m[2], "base64");
        if (bytes.length > MAX_WALLPAPER_BYTES) {
          throw new Error(`image too large (max ${MAX_WALLPAPER_BYTES / 1024 / 1024} MB)`);
        }
        const config = runtimeConfig();
        fs.mkdirSync(dataDir(), { recursive: true });
        const dest = path.join(dataDir(), "wallpaper" + IMAGE_EXT[m[1]]);
        fs.writeFileSync(dest, bytes);
        cachedAssets = { file: dest, mtimeMs: fs.statSync(dest).mtimeMs, assets: await loadWallpaper(dest) };
        saveConfig(persisted({ ...config, wallpaperPath: dest }));
        const windows = await pushConfigToSessions({ ...config, wallpaperPath: dest }, apiPort, token).catch(() => 0);
        sendJson(res, 200, { ok: true, windows, ...publicConfig({ ...config, wallpaperPath: dest }) });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/reset") {
        const stored = loadConfig();
        // Back up the wallpaper config so /api/restore can bring it back
        // without re-importing the image.
        if (stored.wallpaperPath && fs.existsSync(stored.wallpaperPath)) {
          fs.mkdirSync(dataDir(), { recursive: true });
          fs.writeFileSync(backupFile(), JSON.stringify(stored));
        }
        for (const [id, session] of held) {
          try {
            if (session.themeScriptId) {
              await session.conn
                .send("Page.removeScriptToEvaluateOnNewDocument", { identifier: session.themeScriptId })
                .catch(() => {});
              session.themeScriptId = undefined;
            }
            await session.conn.send("Runtime.evaluate", { expression: buildResetScript() });
          } catch {
            session.conn.close();
            held.delete(id);
          }
        }
        saveConfig({ ...stored, wallpaperPath: undefined });
        cachedAssets = undefined;
        sendJson(res, 200, { ok: true, hasBackup: true });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/restore") {
        const saved = readJsonFile<Partial<BeautifyConfig>>(backupFile());
        if (!saved) throw new Error("no wallpaper backup available");
        const config: BeautifyConfig = { ...DEFAULT_CONFIG, ...saved };
        saveConfig(config);
        const windows = await pushConfigToSessions(config, apiPort, token).catch(() => 0);
        sendJson(res, 200, { ok: true, windows, ...publicConfig(config) });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/status") {
        sendJson(res, 200, {
          ...runtimeState,
          recovery: loadRecovery(),
          autostart: getAutostartStatus(),
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/relaunch") {
        const result = await relaunchZcode(cdpPort);
        sendJson(res, 200, { ok: true, ...result });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/recovery") {
        const body = JSON.parse(await readBody(req));
        const mode = normalizeMode(body?.mode);
        if (!mode) throw new Error("mode must be one of: off, on-start, always");
        const status = applyRecoveryMode(mode, {
          nodePath: process.execPath,
          cliPath: cliEntryPath(),
          cdpPort,
          apiPort,
        });
        sendJson(res, 200, {
          ok: true,
          recovery: { mode: status.mode, updatedAt: status.updatedAt },
          autostart: status.autostart,
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/health") {
        sendJson(res, 200, { ok: true, service: SERVICE_ID, pid: process.pid });
        return;
      }

      sendJson(res, 404, { error: "not found" });
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message });
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(apiPort, "127.0.0.1", resolve);
  });

  // The listen-time listener above is one-shot; without a permanent one, any
  // later server error would be an unhandled 'error' event and crash serve.
  server.on("error", (err) => {
    console.error(`serve: http server error — ${(err as Error).message}`);
  });

  console.log(`serve: control API on http://127.0.0.1:${apiPort} — Ctrl+C to stop`);
  console.log(`serve: injecting into ZCode renderers on CDP port ${cdpPort}`);

  // Initial pass, then keep polling so restarts of the app get re-injected.
  await poll(runtimeConfig(), apiPort, token, mediaToken);
  for (;;) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    await poll(runtimeConfig(), apiPort, token, mediaToken);
  }
}
