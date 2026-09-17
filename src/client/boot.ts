/**
 * Assembles the script that boots the v0.2 client inside a ZCode renderer.
 *
 * The client is real TypeScript under `src/client/`, bundled by esbuild into a
 * single IIFE at `dist/client.js`, and injected as a string. It is not read from
 * the plugin data directory and it is not fetched: `Page.addScriptToEvaluateOnNewDocument`
 * needs the whole program up front, so it is read from disk once per service
 * process and cached.
 *
 * The bundle path is resolved relative to *this module*, which is correct in
 * both arrangements that matter: bundled (`dist/cli.js` → `dist/client.js`) and
 * unbundled (`dist/core/boot.js` → `dist/client.js`). The compiled test tree is
 * the one case where the neighbour is missing, so `ZCODE_TARKOV_CLIENT_BUNDLE`
 * exists for the harness and for tests to point at a built bundle.
 *
 * The boot global is a separate, tiny script rather than an interpolation into
 * the bundle. That matters because the token and ports must never be baked into
 * a file on disk — the bundle is a static asset, the boot object is per-run
 * secret.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Window global carrying the per-run boot parameters. */
export const CLIENT_BOOT_GLOBAL = "__ZCT_BOOT__";

/** Environment override for the bundle location (tests, harness, packaging). */
export const CLIENT_BUNDLE_ENV = "ZCODE_TARKOV_CLIENT_BUNDLE";

export interface ClientBootParams {
  apiPort: number;
  token: string;
  mediaToken: string;
  version: string;
}

let cachedBundle: string | undefined;

/** Candidate locations, most specific first. */
function bundleCandidates(): string[] {
  const override = process.env[CLIENT_BUNDLE_ENV];
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates: string[] = [];
  if (override && override.trim().length > 0) candidates.push(path.resolve(override.trim()));
  // Sibling of the running module: dist/core/boot.js and dist/cli.js both sit
  // one level below the directory holding client.js.
  candidates.push(path.join(here, "client.js"));
  candidates.push(path.join(here, "..", "client.js"));
  return candidates;
}

export class ClientBundleMissingError extends Error {
  constructor(readonly tried: string[]) {
    super(
      `the injected client bundle was not found. Looked in: ${tried.join(", ")}. ` +
        `Run \`npm run build\` to produce dist/client.js, or set ${CLIENT_BUNDLE_ENV}.`
    );
  }
}

/** Reads the client bundle, caching it for the life of the process. */
export function loadClientBundle(): string {
  if (cachedBundle !== undefined) return cachedBundle;
  const tried = bundleCandidates();
  for (const candidate of tried) {
    try {
      const source = fs.readFileSync(candidate, "utf8");
      if (source.trim().length > 0) {
        cachedBundle = source;
        return source;
      }
    } catch {
      /* try the next candidate */
    }
  }
  throw new ClientBundleMissingError(tried);
}

/** Drops the cache. Only for tests. */
export function resetClientBundleCache(): void {
  cachedBundle = undefined;
}

/**
 * The complete script to evaluate in the renderer.
 *
 * A `bundle` may be passed explicitly, which is what the tests do so they never
 * depend on a build having run.
 */
export function buildClientScript(params: ClientBootParams, bundle?: string): string {
  const source = bundle ?? loadClientBundle();
  // JSON.stringify, not template interpolation: the tokens are hex today but a
  // future change to base64 or a different alphabet must not be able to break
  // out of the literal.
  const boot = {
    apiPort: params.apiPort,
    token: params.token,
    mediaToken: params.mediaToken,
    version: params.version,
  };
  return `window[${JSON.stringify(CLIENT_BOOT_GLOBAL)}] = ${JSON.stringify(boot)};\n${source}`;
}

/** The small script that only clears the boot object, for teardown. */
export function buildClientTeardownScript(): string {
  return `(function(){
  try {
    var boot = window[${JSON.stringify(CLIENT_BOOT_GLOBAL)}];
    if (boot) {
      // Clear the tokens before anything else: they are the only secret this
      // script carries, and a torn-down page must not keep them reachable.
      boot.token = null;
      boot.mediaToken = null;
    }
    window[${JSON.stringify(CLIENT_BOOT_GLOBAL)}] = null;
  } catch (e) { /* fail soft */ }
  try {
    if (window.__zcodeTarkov && typeof window.__zcodeTarkov.destroy === 'function') {
      window.__zcodeTarkov.destroy();
    }
  } catch (e) { /* fail soft */ }
})();`;
}
