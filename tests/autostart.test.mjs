// The sign-in autostart entry has to carry the same data directory the
// installer and the launcher pin (ZCODE_BEAUTIFY_DATA_DIR). Without it a
// service started at sign-in resolves the CLI's own default data directory, so
// after a reboot the resident service would serve a different config than the
// launcher expects.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { installAutostart } from "../.test-build/core/autostart.js";

const onWindows = process.platform === "win32";

const ENTRY_NAME = "zcode-beautify.vbs";
const DATA_DIR = "C:\\Users\\Example\\zcode-data";

/** Runs `fn` with APPDATA pointing at a fresh temp directory, then cleans up. */
function withTempAppData(fn) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "zct-autostart-"));
  const previous = process.env.APPDATA;
  process.env.APPDATA = temp;
  try {
    return fn(temp);
  } finally {
    if (previous === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = previous;
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

/** The Startup directory the redirected APPDATA puts the entry in. */
function startupDir(temp) {
  return path.join(temp, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
}

/**
 * The command the emitted entry runs, unescaped from its VBS string literal.
 * Parsing it back out (instead of asserting on a substring) is what proves the
 * entry still is the expected `serve` invocation.
 */
function runCommandOf(script) {
  const match = script.match(/CreateObject\("WScript\.Shell"\)\.Run ("(?:[^"]|"")*"), 0, False/);
  assert.ok(match, `the entry must carry the expected WScript.Shell.Run line:\n${script}`);
  return match[1].slice(1, -1).replace(/""/g, '"');
}

/** The spec shape the CLI builds; distinct ports make both visible in the line. */
function spec(dataDir) {
  const base = {
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    cliPath: "C:\\Users\\Example\\zcode-tarkov\\dist\\cli.js",
    cdpPort: 9444,
    apiPort: 9333,
  };
  return dataDir === undefined ? base : { ...base, dataDir };
}

const EXPECTED_COMMAND =
  '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\Example\\zcode-tarkov\\dist\\cli.js" ' +
  "serve --port 9444 --api-port 9333 --detach";

test("installAutostart embeds the data directory in the sign-in entry", { skip: !onWindows }, () => {
  withTempAppData((temp) => {
    const status = installAutostart(spec(DATA_DIR));
    const expectedPath = path.join(startupDir(temp), ENTRY_NAME);
    assert.equal(status.installed, true);
    assert.equal(status.entryPath, expectedPath);

    const script = fs.readFileSync(expectedPath, "utf8");
    assert.ok(
      script.includes(
        `CreateObject("WScript.Shell").Environment("PROCESS")("ZCODE_BEAUTIFY_DATA_DIR") = "${DATA_DIR}"`
      ),
      `the entry must set ZCODE_BEAUTIFY_DATA_DIR:\n${script}`
    );
    // Environment first, Run second: the child inherits the process
    // environment only if the variable was set before the launch.
    assert.ok(script.indexOf('Environment("PROCESS")') < script.indexOf(".Run "));
    assert.equal(runCommandOf(script), EXPECTED_COMMAND);
  });
});

test("installAutostart without a data directory emits no environment line", { skip: !onWindows }, () => {
  withTempAppData((temp) => {
    const status = installAutostart(spec(undefined));
    const expectedPath = path.join(startupDir(temp), ENTRY_NAME);
    assert.equal(status.installed, true);
    assert.equal(status.entryPath, expectedPath);

    const script = fs.readFileSync(expectedPath, "utf8");
    assert.equal(script.includes("ZCODE_BEAUTIFY_DATA_DIR"), false);
    assert.equal(script.includes('Environment("'), false);
    assert.equal(runCommandOf(script), EXPECTED_COMMAND);
  });
});
