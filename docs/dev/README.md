# zcode-tarkov — developer notes

Everything under `docs/dev/`, `tools/` and `evidence/` is developer and
verification material. It is not user documentation; the user guide is
`README.md` / `README.zh-CN.md` in the repository root.

## What lives here

| Path | What it is |
|---|---|
| `install-layout.md` | The authoritative lifecycle contract: the installed tree, the `settings.json` schema, the ZCode discovery order, the exit codes, what each script may destroy, and the interfaces a ZCode update can invalidate. |
| `zcode-dom-notes.md` | The live DOM/CSS facts the theme depends on — token scopes, the stable `data-slot` / Radix vocabulary, the banner anchor — plus the isolated-instance recipe used to observe a running ZCode without disturbing the user's own instance. |
| `OWNER_PLAYTEST.md` | The owner checklist for the v0.1.0 playtest: eyeball checks, no commands. |
| `../tools/` | The re-runnable verification harnesses (below). |
| `../evidence/` | Historical deployment evidence, including the owner-playtest preparation record with its before/after hashes. |
| `../ROADMAP.md` | What is deliberately not part of v0.1.0, and the v0.2 candidates. |

## Build, test, bundle

```powershell
npm run build            # tsc -> dist (typecheck)
npm test                 # compiles to .test-build/ and runs node --test
npm run bundle           # build + esbuild -> the two committed dist bundles
npm run test:lifecycle   # the lifecycle regression suite (PowerShell, temp-only)
```

The `dist/` bundles are committed and users never build them. After any change
under `src/`, run `npm run bundle` and commit the result: `npm test` fails when
the committed MCP bundle does not carry the current version
(`tests/manifest.test.mjs`).

## The two live harnesses

Both harnesses are fail-closed: they refuse to run unless every path they write
is below `%TEMP%`, and the end-to-end harness additionally refuses to stop a
process that is not provably its scratch instance (`ZCode.exe` whose command
line carries the scratch CDP port).

| Harness | What it proves |
|---|---|
| `tools/verify-clean-install.ps1` (with the CDP driver `tools/verify-clean-install.mjs`) | The full end-to-end journey on an isolated scratch tree: clean `install.ps1` -> isolated launch -> the Tarkov theme visible in the live renderer (30 renderer assertions) -> screenshots -> uninstall (dry run, real run, idempotency) -> the real profile provably unchanged. Result: `docs/images/clean-install-evidence.json`. |
| `tools/test-lifecycle.ps1` | The bounded, temp-only regression suite for `install.ps1` / `repair.ps1` / `uninstall.ps1`: clean install, install idempotency, refusal of a foreign `settings.json` (and `-Force` adoption), `repair.ps1` merging `-ShortcutDir` into the recorded list, uninstall `-DryRun` changing nothing, a real uninstall that keeps the data directory, a second uninstall reporting `[absent]`, and the real profile unchanged. It runs with `-NoService` and `-KeepOfficialShortcuts`, so no real service, shortcut or registry value is touched. |

Known `NOT TESTED` branch: the launcher's start path (starting ZCode itself).
The end-to-end run happened while a ZCode instance was already live, so the
launcher exited 3 with "ZCode is already running without the debug port" and
the harness reproduced the themed window with a direct `ZCode.exe` start. See
`notTested` in `docs/images/clean-install-evidence.json` and `launcher.log` in
the same file for the exact output.

## Testing against a scratch ZCode profile

ZCode overrides Chromium's `--user-data-dir` and calls
`app.setPath("userData", ...)` / `app.setPath("sessionData", ...)` from its own
runtime-data environment variables, so an isolated instance is started by
setting these before launching `ZCode.exe`:

```powershell
$env:ZCODE_DESKTOP_USER_DATA_DIR    = 'F:\scratch\userdata'
$env:ZCODE_DESKTOP_SESSION_DATA_DIR = 'F:\scratch\session'
```

`ZCODE_WINDOWS_APP_INSTALL_DIR` points discovery at one specific ZCode install
(the lifecycle scripts export it to their child processes), and
`ZCODE_BEAUTIFY_DATA_DIR` redirects the CLI's data directory. The recipe and the
constraints that led to it are in `zcode-dom-notes.md`.

Nothing in this directory is user documentation, and nothing here is part of
the installed payload.
