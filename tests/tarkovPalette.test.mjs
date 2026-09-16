// Tarkov palette output: the fixed semantic-token mapping.
import test from "node:test";
import assert from "node:assert/strict";

import { TARKOV_PALETTE, tarkovTokenRows, buildTarkovVariableOverrides } from "../.test-build/themes/tarkov.js";

const VISIBLE = { wallpaperVisible: true, dim: 0 };
const HIDDEN = { wallpaperVisible: false, dim: 0 };

function valueOf(rows, token) {
  const row = rows.find((r) => r.startsWith(`${token}:`));
  assert.ok(row, `${token} must be emitted`);
  return row.slice(token.length + 1).replace(/;$/, "");
}

test("palette matches the documented Tarkov base colors", () => {
  assert.equal(TARKOV_PALETTE.accent, "#e07930");
  assert.equal(TARKOV_PALETTE.background, "#1c1207");
  assert.equal(TARKOV_PALETTE.text, "#e8d9c8");
  assert.equal(TARKOV_PALETTE.highlight, "#ffd7ae");
  assert.equal(TARKOV_PALETTE.warning, "#ffb27a");
  assert.equal(TARKOV_PALETTE.muted, "#8b877c");
  assert.equal(TARKOV_PALETTE.panelRgb, "26, 18, 10");
  assert.equal(TARKOV_PALETTE.panelAltRgb, "30, 20, 10");
});

test("every semantic token required by the spec is emitted", () => {
  const required = [
    "--color-background",
    "--color-background-alt",
    "--color-background-win-alt",
    "--color-panel",
    "--color-sidebar",
    "--color-surface",
    "--color-surface-hover",
    "--color-card",
    "--color-card-selected",
    "--color-card-border",
    "--color-popover",
    "--color-input",
    "--color-input-focused",
    "--color-input-border",
    "--color-input-border-hover",
    "--color-input-border-focused",
    "--color-foreground",
    "--color-foreground-subtle",
    "--color-foreground-subtlest",
    "--color-primary",
    "--color-secondary",
    "--color-accent",
    "--color-brand",
    "--color-border",
    "--divider-color",
    "--color-border-color-interactive",
  ];
  const rows = tarkovTokenRows(VISIBLE);
  for (const token of required) valueOf(rows, token);
});

test("foreground and accent come from the fixed palette, not from a wallpaper", () => {
  const rows = tarkovTokenRows(VISIBLE);
  assert.equal(valueOf(rows, "--color-foreground"), "#e8d9c8");
  assert.equal(valueOf(rows, "--color-primary"), "#e07930");
  assert.equal(valueOf(rows, "--color-brand"), "#e07930");
  assert.equal(valueOf(rows, "--color-input-border-focused"), "#e07930");
});

test("functional colors are never overridden", () => {
  const keys = tarkovTokenRows(VISIBLE);
  for (const forbidden of [
    "--color-success",
    "--color-warning",
    "--color-danger",
    "--color-destructive",
    "--color-git-added",
    "--color-diff-added",
  ]) {
    assert.equal(
      keys.some((r) => r.startsWith(`${forbidden}:`)),
      false,
      `${forbidden} must stay native`
    );
  }
});

test("wallpaper visible: background is transparent and surfaces are translucent", () => {
  const rows = tarkovTokenRows(VISIBLE);
  assert.equal(valueOf(rows, "--color-background"), "transparent");
  const panel = valueOf(rows, "--color-panel");
  assert.match(panel, /^rgba\(26, 18, 10, 0\.62\)$/, `panel should be translucent, got ${panel}`);
});

test("wallpaper hidden: the theme becomes fully opaque", () => {
  const rows = tarkovTokenRows(HIDDEN);
  assert.equal(valueOf(rows, "--color-background"), "#1c1207");
  for (const token of ["--color-panel", "--color-sidebar", "--color-surface", "--color-card", "--color-input"]) {
    const value = valueOf(rows, token);
    assert.equal(/rgba\(/.test(value), false, `${token} must be opaque when no wallpaper shows, got ${value}`);
  }
});

test("menus and popovers stay more opaque than panels for legibility", () => {
  const visible = tarkovTokenRows(VISIBLE);
  assert.match(valueOf(visible, "--color-popover"), /0\.94\)$/);
  const hidden = tarkovTokenRows(HIDDEN);
  assert.match(valueOf(hidden, "--color-popover"), /^rgb\(/);
});

test("dim is forwarded as the shared dim variable the wallpaper layer uses", () => {
  const withDim = tarkovTokenRows({ wallpaperVisible: true, dim: 40 });
  assert.equal(valueOf(withDim, "--zcode-beautify-dim"), "0.4");
  const noDim = tarkovTokenRows({ wallpaperVisible: true, dim: 0 });
  assert.equal(noDim.some((r) => r.startsWith("--zcode-beautify-dim:")), false);
});

test("overrides target both the light and dark ZCode token scopes", () => {
  const css = buildTarkovVariableOverrides(VISIBLE);
  assert.match(css, /\.theme-zai-light/);
  assert.match(css, /\.dark/);
  assert.match(css, /\.theme-zai-dark/);
  // Dark block must come last: both scopes match <html>, so order decides.
  assert.ok(
    css.lastIndexOf(".dark,.theme-zai-dark") > css.indexOf(".theme-zai-light"),
    "dark scope must be emitted after the light scope"
  );
});
