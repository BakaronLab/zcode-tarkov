// Bundles the injected client (`src/client/`) into a single IIFE at
// `dist/client.js`. Run via `npm run build` (or `npm run bundle`).
//
// Why a separate bundle rather than a string template like the v0.1 panel: the
// v0.2 client is a few thousand lines of real logic — a leader election, an
// event state machine, a bounded LRU, an audio graph — and expressing that as
// nested template literals would mean no type checking, no unit tests against
// the real functions, and escaping bugs that only appear in a live renderer.
// esbuild compiles it as ordinary browser TypeScript, so `tsc` type-checks it
// and `node --test` can import the pure parts.
//
// The output is an IIFE with no imports: `Page.addScriptToEvaluateOnNewDocument`
// evaluates a single script in the page, so the client must be one self-contained
// program. Nothing is fetched at run time and no module loader is involved.
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";

const outfile = path.join("dist", "client.js");
fs.mkdirSync("dist", { recursive: true });

const result = await build({
  entryPoints: ["src/client/main.ts"],
  outfile,
  bundle: true,
  format: "iife",
  // Electron ships a current Chromium; targeting it (rather than ES5) keeps the
  // output readable and small, and avoids the helper noise that lowering would
  // add. The client never runs anywhere else.
  target: "chrome120",
  platform: "browser",
  legalComments: "inline",
  // A minified client would be unusable in a `Runtime.evaluate` stack trace, and
  // the size saved is irrelevant for a local file. Keep it legible.
  minify: false,
  sourcemap: false,
  charset: "utf8",
  logLevel: "warning",
});

if (result.errors.length > 0) {
  for (const err of result.errors) console.error(err);
  process.exit(1);
}

const bytes = fs.statSync(outfile).size;
console.log(`client bundle written to ${outfile} (${bytes} bytes)`);
