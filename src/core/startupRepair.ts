/**
 * Startup launcher repair.
 *
 * ZCode cannot add `--remote-debugging-port` to itself once it is running, and
 * its updater rebuilds the Start Menu shortcut without the flag, so a machine
 * can end up with ZCode running and the CDP port closed even though the user
 * repaired the entries before. The plugin host starts the MCP server right
 * after the app comes up, and the resident service polls it — both are natural
 * places to notice "the app is running but the port never opened" and repair
 * the launch entries so the *next* start is healthy.
 *
 * Every dependency is injected, which keeps the decision order testable without
 * PowerShell, a live app or a network. The function never throws: a probe that
 * fails is reported as a failed outcome.
 */

import type { RepairOptions, RepairReport } from "./launchers.js";

export type StartupRepairSkipReason =
  | "unsupported-platform"
  | "cdp-reachable"
  | "zcode-not-running";

export type StartupRepairOutcome =
  | { kind: "skipped"; reason: StartupRepairSkipReason }
  | { kind: "repaired"; port: number; updated: string[] }
  | { kind: "no-op"; port: number; scanned: number }
  | { kind: "failed"; port: number; error: string };

export interface StartupRepairDeps {
  port: number;
  /** True when the CDP endpoint answers. */
  probeCdp: () => Promise<boolean>;
  /** True when a ZCode process exists. */
  probeZcode: () => Promise<boolean>;
  repair: (opts: RepairOptions) => Promise<RepairReport>;
  platform?: NodeJS.Platform; // defaults to process.platform
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Repairs the launch entries when — and only when — ZCode is running with its
 * CDP port closed, which is the symptom of an entry that lost the flag.
 *
 * The order matters and is pinned by tests:
 *   1. non-Windows platforms are skipped without probing anything;
 *   2. a reachable CDP endpoint means the flag is present, so the launchers are
 *      never touched (a healthy ZCode must produce zero writes);
 *   3. a closed port while ZCode is not running is just a shut-down app, not a
 *      lost flag;
 *   4. only then is the repair run, and a report with no `updated` fix is a
 *      no-op rather than a repair.
 */
export async function repairLaunchersIfZcodeLostTheFlag(
  deps: StartupRepairDeps
): Promise<StartupRepairOutcome> {
  const platform = deps.platform ?? process.platform;
  if (platform !== "win32") {
    return { kind: "skipped", reason: "unsupported-platform" };
  }

  try {
    if (await deps.probeCdp()) {
      return { kind: "skipped", reason: "cdp-reachable" };
    }
    if (!(await deps.probeZcode())) {
      return { kind: "skipped", reason: "zcode-not-running" };
    }

    const report = await deps.repair({ port: deps.port });
    if (report.error) {
      return { kind: "failed", port: deps.port, error: report.error };
    }
    const updated = report.fixes.filter((f) => f.status === "updated").map((f) => f.path);
    if (updated.length > 0) {
      return { kind: "repaired", port: deps.port, updated };
    }
    return { kind: "no-op", port: deps.port, scanned: report.fixes.length };
  } catch (err) {
    return { kind: "failed", port: deps.port, error: errorMessage(err) };
  }
}

/**
 * The lines a caller should log for an outcome, one per line and without a
 * trailing newline.
 *
 * A healthy or uneventful outcome returns no lines at all: callers run this at
 * startup, so silence on the happy path is intentional. A repair names the
 * entries it changed, because the user has to restart ZCode from one of them
 * for the flag to take effect.
 */
export function describeStartupRepair(outcome: StartupRepairOutcome): string[] {
  switch (outcome.kind) {
    case "repaired":
      return [
        `ZCode is running without --remote-debugging-port=${outcome.port}, and its launch entries were missing the flag.`,
        `Added the flag to ${outcome.updated.length} launch entry(ies):`,
        ...outcome.updated,
        "Quit ZCode completely (including the tray icon), then start it again from one of these entries — the flag is read only at startup.",
      ];
    case "failed":
      return [`Could not repair ZCode's launch entries: ${outcome.error}`];
    case "no-op":
    case "skipped":
      return [];
  }
}
