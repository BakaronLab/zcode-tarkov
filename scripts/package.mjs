// Packages the two distributable bundles into packages/:
//   zcode-tarkov-plugin-v<version>.zip  — ready-made plugin for ZCode users
//                                         (README.md is the install guide)
//   skill-pack-v<version>.zip           — AI skill for building the same capability
//                                         for any Electron app
// Run via `npm run package`. Zip entry names use forward slashes only (ZCode
// rejects backslashes/absolute paths in plugin zips).
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const AdmZip = require("adm-zip");

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const version = pkg.version;
const outDir = "packages";
fs.mkdirSync(outDir, { recursive: true });

// --- plugin zip: single wrapping folder, minimal installable set -------------
const pluginFiles = [
  "THIRD_PARTY_NOTICES.md",
  "marketplace.json",
  ".zcode-plugin/plugin.json",
  "commands/beautify.md",
  "skills/beautify/SKILL.md",
  "dist/cli.js",
  "dist/mcp/server.js",
  // The injected client. Without it the theme still applies but audio, the dock,
  // the pet, the status text and the settings centre are all missing, so it is
  // part of the installable set rather than an optional extra.
  "dist/client.js",
  "README.md",
  "README.zh-CN.md",
  "LICENSE",
  "package.json",
];

const pluginZip = new AdmZip();
for (const rel of pluginFiles) {
  const full = path.resolve(rel);
  if (!fs.existsSync(full)) {
    throw new Error(`missing file for plugin package: ${rel}`);
  }
  const zipPath = `zcode-tarkov-plugin-v${version}/${rel.split(path.sep).join("/")}`;
  pluginZip.addFile(zipPath, fs.readFileSync(full));
}
const pluginOut = path.join(outDir, `zcode-tarkov-plugin-v${version}.zip`);
fs.writeFileSync(pluginOut, pluginZip.toBuffer());

// --- skill pack zip: the skill-pack/ folder as-is -----------------------------
const skillZip = new AdmZip();
for (const rel of listFiles("skill-pack")) {
  // listFiles already returns paths under skill-pack/ — do not prefix again.
  const zipPath = rel.split(path.sep).join("/");
  skillZip.addFile(zipPath, fs.readFileSync(rel));
}
const skillOut = path.join(outDir, `skill-pack-v${version}.zip`);
fs.writeFileSync(skillOut, skillZip.toBuffer());

console.log(`packages/${path.basename(pluginOut)} (${pluginZip.toBuffer().length} bytes)`);
console.log(`packages/${path.basename(skillOut)} (${skillZip.toBuffer().length} bytes)`);

function listFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}
