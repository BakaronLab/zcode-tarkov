// The startup repair decides whether the launcher entries are touched at all.
// A healthy ZCode must produce zero writes, a shut-down app must not be mistaken
// for a lost flag, and only "running with the port closed" may start a repair.
// These tests pin that decision order with fake dependencies, so they need no
// PowerShell, no ZCode and no network.
import test from "node:test";
import assert from "node:assert/strict";

import {
  describeStartupRepair,
  repairLaunchersIfZcodeLostTheFlag,
} from "../.test-build/core/startupRepair.js";

const PORT = 9222;

/** A LauncherFix as the repair would report it. */
function fix(status, path, reason) {
  return { kind: "shortcut", path, before: "", after: "", status, reason };
}

function reportOf(fixes = [], error) {
  return { supported: true, dryRun: false, fixes, error };
}

/**
 * Records every dependency call, so "repair was never called" is an assertion
 * about observed behaviour rather than about the code path one hopes ran.
 */
function recorder({ cdp = false, zcode = true, report = reportOf(), platform } = {}) {
  const calls = [];
  const deps = {
    port: PORT,
    probeCdp: async () => {
      calls.push("cdp");
      return cdp;
    },
    probeZcode: async () => {
      calls.push("zcode");
      return zcode;
    },
    repair: async () => {
      calls.push("repair");
      return report;
    },
  };
  if (platform !== undefined) deps.platform = platform;
  return { deps, calls };
}

test("a reachable CDP endpoint skips the repair without calling it", async () => {
  const { deps, calls } = recorder({ cdp: true });
  const outcome = await repairLaunchersIfZcodeLostTheFlag(deps);

  assert.deepEqual(outcome, { kind: "skipped", reason: "cdp-reachable" });
  assert.equal(calls.filter((c) => c === "repair").length, 0, "a healthy ZCode must produce zero launcher writes");
  assert.deepEqual(calls, ["cdp"], "the process probe must not even run once CDP answers");
});

test("a closed port with no ZCode process is not a lost flag", async () => {
  const { deps, calls } = recorder({ cdp: false, zcode: false });
  const outcome = await repairLaunchersIfZcodeLostTheFlag(deps);

  assert.deepEqual(outcome, { kind: "skipped", reason: "zcode-not-running" });
  assert.equal(calls.filter((c) => c === "repair").length, 0, "a shut-down app must not trigger a repair");
  assert.deepEqual(calls, ["cdp", "zcode"]);
});

test("running without the flag reports the updated entries in order", async () => {
  const desktop = "C:\\Users\\Example\\Desktop\\ZCode.lnk";
  const pinned = "C:\\Users\\Example\\AppData\\...\\TaskBar\\ZCode.lnk";
  const { deps, calls } = recorder({
    cdp: false,
    zcode: true,
    report: reportOf([fix("updated", desktop), fix("updated", pinned)]),
  });

  const outcome = await repairLaunchersIfZcodeLostTheFlag(deps);

  assert.deepEqual(outcome, { kind: "repaired", port: PORT, updated: [desktop, pinned] });
  assert.deepEqual(calls, ["cdp", "zcode", "repair"]);
});

test("already-ok and machine-wide failures are a no-op, not a repair", async () => {
  const { deps } = recorder({
    report: reportOf([
      fix("already-ok", "C:\\Users\\Example\\Desktop\\ZCode.lnk"),
      fix("failed", "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\ZCode.lnk", "machine-wide entry needs administrator rights; not modified"),
    ]),
  });

  const outcome = await repairLaunchersIfZcodeLostTheFlag(deps);

  assert.deepEqual(outcome, { kind: "no-op", port: PORT, scanned: 2 });
});

test("a repair error is a failed outcome, and error wins over any fixes", async () => {
  const plain = recorder({ report: reportOf([], "PowerShell is not available") });
  assert.deepEqual(await repairLaunchersIfZcodeLostTheFlag(plain.deps), {
    kind: "failed",
    port: PORT,
    error: "PowerShell is not available",
  });

  const contradictory = recorder({
    report: reportOf([fix("updated", "C:\\Users\\Example\\Desktop\\ZCode.lnk")], "PowerShell is not available"),
  });
  assert.deepEqual(await repairLaunchersIfZcodeLostTheFlag(contradictory.deps), {
    kind: "failed",
    port: PORT,
    error: "PowerShell is not available",
  });
});

test("throwing dependencies become a failed outcome instead of a rejection", async () => {
  const throwingProbe = {
    port: PORT,
    probeCdp: async () => {
      throw new Error("probe exploded");
    },
    probeZcode: async () => true,
    repair: async () => reportOf(),
  };
  await assert.doesNotReject(() => repairLaunchersIfZcodeLostTheFlag(throwingProbe));
  assert.deepEqual(await repairLaunchersIfZcodeLostTheFlag(throwingProbe), {
    kind: "failed",
    port: PORT,
    error: "probe exploded",
  });

  const throwingRepair = recorder();
  throwingRepair.deps.repair = async () => {
    throw new Error("powershell exited 1");
  };
  await assert.doesNotReject(() => repairLaunchersIfZcodeLostTheFlag(throwingRepair.deps));
  assert.deepEqual(await repairLaunchersIfZcodeLostTheFlag(throwingRepair.deps), {
    kind: "failed",
    port: PORT,
    error: "powershell exited 1",
  });
});

test("non-Windows platforms are skipped before any probe runs", async () => {
  const { deps, calls } = recorder({ cdp: false, zcode: true, platform: "linux" });
  const outcome = await repairLaunchersIfZcodeLostTheFlag(deps);

  assert.deepEqual(outcome, { kind: "skipped", reason: "unsupported-platform" });
  assert.deepEqual(calls, [], "the platform check must come first");
});

test("describeStartupRepair names every changed entry on a repair", () => {
  const paths = ["C:\\Users\\Example\\Desktop\\ZCode.lnk", "C:\\Users\\Example\\TaskBar\\ZCode Pinned.lnk"];
  const lines = describeStartupRepair({ kind: "repaired", port: PORT, updated: paths });
  const text = lines.join("\n");

  assert.ok(text.includes(String(PORT)), "the port has to be visible in the log lines");
  for (const p of paths) assert.ok(text.includes(p), `the changed path ${p} must be named`);
  for (const line of lines) assert.equal(line.includes("\n"), false, "each line must be a single line");
});

test("describeStartupRepair says nothing misleading for the other kinds", () => {
  const other = [
    { kind: "no-op", port: PORT, scanned: 3 },
    { kind: "skipped", reason: "cdp-reachable" },
    { kind: "skipped", reason: "zcode-not-running" },
    { kind: "skipped", reason: "unsupported-platform" },
  ];
  for (const outcome of other) {
    const lines = describeStartupRepair(outcome);
    assert.ok(Array.isArray(lines), "describeStartupRepair must always return an array");
    for (const line of lines) {
      assert.doesNotMatch(line, /added the flag|updated|repaired/i, `misleading line: ${line}`);
    }
  }

  // The one failure shape that must be reported carries the reason.
  const failed = describeStartupRepair({ kind: "failed", port: PORT, error: "PowerShell is not available" });
  assert.ok(
    failed.some((line) => line.includes("PowerShell is not available")),
    "a failed repair must say why"
  );
});
