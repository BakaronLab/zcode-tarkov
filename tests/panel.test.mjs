// Settings-panel generation: the UI Theme selector and the Tarkov panel skin.
import test from "node:test";
import assert from "node:assert/strict";

import { buildPanelScript, PANEL_ROOT_ID } from "../.test-build/panel/panelScript.js";

const script = buildPanelScript(9223, "test-token");

test("the panel offers exactly the three documented theme modes", () => {
  assert.match(script, /id="zb-theme"/);
  for (const mode of ["monet", "tarkov", "native"]) {
    assert.match(script, new RegExp(`<option value="${mode}">`), `missing ${mode} option`);
  }
});

test("existing controls are preserved alongside the new selector", () => {
  for (const id of [
    "zb-blur",
    "zb-dim",
    "zb-vis",
    "zb-fit",
    "zb-file",
    "zb-reset",
    "zb-recovery",
    "zb-relaunch",
    "zb-retry",
    "zb-close",
    "zb-fab",
  ]) {
    assert.match(script, new RegExp(`id="${id}"`), `control ${id} was dropped`);
  }
});

test("the legacy monet checkbox is replaced, not duplicated", () => {
  assert.equal(script.includes('id="zb-monet"'), false);
  assert.equal(script.includes("zb-monet"), false);
});

test("theme changes are pushed to the API as colorMode", () => {
  assert.match(script, /colorMode: \$\('zb-theme'\)\.value/);
  assert.match(script, /\$\('zb-theme'\)\.addEventListener\('change'/);
});

test("panel skin is driven by one attribute on the root element", () => {
  assert.match(script, new RegExp(PANEL_ROOT_ID));
  assert.match(script, /root\.setAttribute\('data-zb-theme', 'tarkov'\)/);
  assert.match(script, /root\.removeAttribute\('data-zb-theme'\)/);
});

test("the Tarkov skin uses the deep-brown/orange palette and smaller radii", () => {
  assert.match(script, /\[data-zb-theme="tarkov"\] \{/);
  assert.match(script, /--zb-bg: rgba\(26,18,10,\.94\)/);
  assert.match(script, /--zb-accent: #e07930/);
  assert.match(script, /--zb-text: #e8d9c8/);
  assert.match(script, /--zb-radius: 4px/);
  assert.match(script, /--zb-radius-pill: 3px/);
});

test("the neutral skin remains the default so Monet/Native look unchanged", () => {
  assert.match(script, /--zb-accent: #7aa2f7/);
  assert.match(script, /--zb-radius: 12px/);
  assert.match(script, /--zb-radius-pill: 999px/);
});

test("panel refresh reports the served mode, tolerating an older service", () => {
  assert.match(script, /var mode = c\.colorMode \|\| \(c\.monet \? 'monet' : 'native'\);/);
  assert.match(script, /applyPanelSkin\(mode\)/);
});

test("going offline resets the selector instead of showing a stale mode", () => {
  assert.match(script, /\$\('zb-theme'\)\.value = 'monet';/);
  assert.match(script, /applyPanelSkin\('monet'\)/);
});

test("the panel always rebuilds itself, so a stale copy cannot shadow it", () => {
  assert.match(script, /var stale = document\.getElementById\(ROOT_ID\);/);
  assert.match(script, /if \(stale\) stale\.remove\(\);/);
});

test("blur/dim still drive the shared dim variable and local preview", () => {
  assert.match(script, /setProperty\('--zcode-beautify-dim'/);
});
