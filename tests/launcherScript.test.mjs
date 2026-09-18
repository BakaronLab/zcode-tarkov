// The generated PowerShell is the only thing that decides whether a launch
// entry gets --remote-debugging-port, so these assertions read it directly
// (no execution): the identity gates, the scope of every scanned directory,
// the HKCU-only registry list, and the promise that no elevation mechanism is
// ever emitted. The scan locations are injectable, which is what lets the
// PowerShell harness point the same script at a scratch tree.
import test from "node:test";
import assert from "node:assert/strict";

import { buildRepairScript } from "../.test-build/core/launchers.js";

const PORT = 9222;

/** The slice of the script between two markers; the markers are asserted. */
function section(script, start, end) {
  const from = script.indexOf(start);
  assert.ok(from >= 0, `the script must contain ${start}`);
  const to = script.indexOf(end, from);
  assert.ok(to > from, `the script must contain ${end} after ${start}`);
  return script.slice(from + start.length, to);
}

/** The `$dirs` entries as trimmed lines. */
function dirLines(script) {
  return section(script, "$dirs = @(", "\n)")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

const PROD = buildRepairScript(PORT, false);
const PROD_DIRS = dirLines(PROD);

test("the pinned taskbar directory is scanned as a user entry", () => {
  const line = PROD_DIRS.find((l) => l.includes("Quick Launch\\User Pinned\\TaskBar"));
  assert.ok(line, "the pinned taskbar directory must be part of the scan");
  assert.match(line, /scope = 'user'/, "the pinned taskbar holds ordinary user shortcuts");

  // Position matters: after the user Start Menu, before the machine-wide
  // entries. The pinned taskbar is a user location and must not be treated as
  // machine scope just because it lives under a Microsoft directory.
  const taskbar = PROD_DIRS.findIndex((l) => l.includes("User Pinned\\TaskBar"));
  const userStartMenu = PROD_DIRS.findIndex((l) => l.includes("$env:APPDATA") && l.includes("Start Menu"));
  const machineFirst = PROD_DIRS.findIndex((l) => l.includes("scope = 'machine'"));
  assert.ok(userStartMenu >= 0 && machineFirst >= 0, "both neighbours must exist");
  assert.ok(userStartMenu < taskbar && taskbar < machineFirst, "the pinned taskbar entry is out of order");
});

test("the machine-wide directories are present and marked machine scope", () => {
  const machine = PROD_DIRS.filter((l) => l.includes("scope = 'machine'"));
  assert.equal(machine.length, 2, "Public Desktop and ProgramData Start Menu are the machine-wide entries");
  assert.ok(machine.some((l) => l.includes("$env:PUBLIC 'Desktop'")), "the Public Desktop entry is missing");
  assert.ok(machine.some((l) => l.includes("$env:ProgramData") && l.includes("Start Menu")), "the ProgramData Start Menu entry is missing");
});

test("all three HKCU handlers are scanned", () => {
  for (const key of [
    "HKCU:\\Software\\Classes\\zcode\\shell\\open\\command",
    "HKCU:\\Software\\Classes\\Directory\\shell\\ZCode.OpenInZCode\\command",
    "HKCU:\\Software\\Classes\\Drive\\shell\\ZCode.OpenInZCode\\command",
  ]) {
    assert.ok(PROD.includes(`'${key}'`), `the generated script must scan ${key}`);
  }
});

test("no HKLM path and no elevation mechanism can appear", () => {
  assert.equal(PROD.includes("HKLM"), false, "this project never embeds a machine-wide registry hive");
  for (const forbidden of ["RunAs", "-Verb ", "RunAsAdministrator", "Start-Process"]) {
    assert.equal(PROD.includes(forbidden), false, `the script must not contain ${forbidden}`);
  }
  // A machine-wide entry is reported, not attempted.
  assert.ok(PROD.includes("machine-wide entry needs administrator rights; not modified"));
});

test("the identity gates are present for both entry kinds", () => {
  assert.ok(PROD.includes("'*ZCode.exe'"), "shortcuts must be filtered by TargetPath");
  assert.ok(PROD.includes("'ZCode\\.exe'"), "registry values must be filtered by the command they hold");
});

test("custom shortcut directories replace the production locations", () => {
  const script = buildRepairScript(PORT, true, {
    shortcutDirs: [
      { path: "C:\\scratch\\Desktop", scope: "user" },
      { path: "C:\\scratch\\Public Desktop", scope: "machine" },
    ],
    registryKeys: ["HKCU:\\Software\\Classes\\__zct_launcher_repair_test__\\zcode\\shell\\open\\command"],
  });

  const lines = dirLines(script);
  assert.equal(lines.length, 2, "only the injected directories may be scanned");
  assert.ok(lines[0].includes("'C:\\scratch\\Desktop'") && lines[0].includes("scope = 'user'"));
  assert.ok(lines[1].includes("'C:\\scratch\\Public Desktop'") && lines[1].includes("scope = 'machine'"));
  assert.equal(script.includes("$env:USERPROFILE"), false, "production locations must not leak into an override run");
  assert.ok(script.includes("__zct_launcher_repair_test__"), "the injected registry key must be used");
});

test("injected strings are quoted as PowerShell literals, not interpolated", () => {
  const script = buildRepairScript(PORT, true, {
    shortcutDirs: [{ path: "C:\\it's here\\Desktop", scope: "user" }],
    registryKeys: ["HKCU:\\Software\\Classes\\__zct__\\it's\\command"],
  });
  assert.ok(script.includes("'C:\\it''s here\\Desktop'"), "a quote in a path must be doubled inside the literal");
  assert.ok(script.includes("'HKCU:\\Software\\Classes\\__zct__\\it''s\\command'"), "a quote in a registry key must be doubled");
});

test("a registry key outside HKCU is rejected instead of embedded", () => {
  assert.throws(
    () =>
      buildRepairScript(PORT, false, {
        registryKeys: ["HKLM:\\Software\\Classes\\zcode\\shell\\open\\command"],
      }),
    /HKCU/,
    "only HKCU keys may reach the script"
  );
  assert.throws(
    () => buildRepairScript(PORT, false, { registryKeys: ["SOFTWARE\\Classes\\zcode"] }),
    /HKCU/,
    "a key without a hive prefix is rejected too"
  );
});

test("the dry-run switch is still embedded in the generated script", () => {
  assert.ok(buildRepairScript(PORT, true).includes("$dryRun = $true"));
  assert.ok(buildRepairScript(PORT, false).includes("$dryRun = $false"));
  assert.ok(buildRepairScript(9333, false).includes("$port = 9333"));
});
