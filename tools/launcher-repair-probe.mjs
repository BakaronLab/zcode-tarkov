// Dev/test harness for tools/test-launcher-repair.ps1 — not shipped (tools/ is
// not in package.json#files).
//
// It runs the real compiled repairLaunchers against the locations given on the
// command line and prints the RepairReport as JSON on stdout. The overrides are
// required on purpose: this probe exists to exercise a scratch tree under
// %TEMP%, and it must never be pointed at the real Desktop / Start Menu /
// pinned taskbar directories or at the real HKCU handlers. There is no default
// that could accidentally reach them.
//
// Usage:
//   node tools/launcher-repair-probe.mjs '{"port":9222,"dryRun":true,
//     "shortcutDirs":[{"path":"C:\\scratch\\Desktop","scope":"user"}],
//     "registryKeys":["HKCU:\\Software\\Classes\\__zct_test__\\command"]}'
//
// Exit codes: 0 the report was produced (read `error` inside it), 1 the repair
// reported an error, 2 the options were missing or malformed.

import { repairLaunchers } from "../.test-build/core/launchers.js";

const usage = "usage: node tools/launcher-repair-probe.mjs '<json options>'";

const raw = process.argv[2];
if (!raw) {
  console.error(usage);
  process.exit(2);
}

let opts;
try {
  opts = JSON.parse(raw);
} catch (err) {
  console.error(`launcher-repair-probe: the options are not valid JSON: ${err.message}`);
  process.exit(2);
}

if (typeof opts.port !== "number" || !Number.isFinite(opts.port)) {
  console.error("launcher-repair-probe: port must be a number");
  process.exit(2);
}
if (!Array.isArray(opts.shortcutDirs) || opts.shortcutDirs.length === 0) {
  console.error("launcher-repair-probe: shortcutDirs must be passed explicitly (this probe must not scan a real location)");
  process.exit(2);
}
if (!Array.isArray(opts.registryKeys)) {
  console.error("launcher-repair-probe: registryKeys must be passed explicitly (this probe must not read or write a real handler)");
  process.exit(2);
}

const report = await repairLaunchers({
  port: opts.port,
  dryRun: Boolean(opts.dryRun),
  shortcutDirs: opts.shortcutDirs,
  registryKeys: opts.registryKeys,
});

// stdout carries exactly one JSON document; everything else goes to stderr.
console.log(JSON.stringify(report));
process.exit(report.error ? 1 : 0);
