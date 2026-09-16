// Config-migration behavior for the `monet: boolean` -> `colorMode` change.
// A pre-0.1 config must keep working; reading it must never throw.
import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_COLOR_MODE,
  COLOR_MODES,
  isColorMode,
  legacyMonetFlag,
  migrateColorMode,
  withColorMode,
} from "../.test-build/core/colorMode.js";

test("legacy monet:true migrates to monet", () => {
  assert.equal(migrateColorMode({ monet: true }), "monet");
});

test("legacy monet:false migrates to native", () => {
  assert.equal(migrateColorMode({ monet: false }), "native");
});

test("explicit colorMode wins over the legacy flag", () => {
  assert.equal(migrateColorMode({ colorMode: "tarkov", monet: true }), "tarkov");
  assert.equal(migrateColorMode({ colorMode: "native", monet: true }), "native");
});

test("empty, null and malformed configs fall back to the default without throwing", () => {
  for (const input of [undefined, null, {}, { monet: "yes" }, { colorMode: "nope" }, { colorMode: 7 }]) {
    assert.equal(migrateColorMode(input), DEFAULT_COLOR_MODE);
  }
});

test("all three documented modes are recognized", () => {
  for (const mode of COLOR_MODES) assert.ok(isColorMode(mode), `${mode} should be valid`);
  assert.deepEqual([...COLOR_MODES], ["monet", "tarkov", "native"]);
});

test("isColorMode rejects non-strings and unknown values", () => {
  for (const bad of [undefined, null, true, 1, {}, [], "taRkov", ""]) assert.equal(isColorMode(bad), false);
});

test("withColorMode fills colorMode and keeps monet consistent both ways", () => {
  const migrated = withColorMode({ monet: false, blur: 5 });
  assert.equal(migrated.colorMode, "native");
  assert.equal(migrated.monet, false);
  // Unrelated fields survive migration untouched.
  assert.equal(migrated.blur, 5);
});

test("withColorMode re-derives monet from colorMode so the pair never disagrees", () => {
  const fixed = withColorMode({ colorMode: "tarkov", monet: true });
  assert.equal(fixed.colorMode, "tarkov");
  assert.equal(fixed.monet, false, "monet must not claim true for a non-monet mode");
});

test("legacyMonetFlag is true only for monet", () => {
  assert.equal(legacyMonetFlag("monet"), true);
  assert.equal(legacyMonetFlag("tarkov"), false);
  assert.equal(legacyMonetFlag("native"), false);
});
