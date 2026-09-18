# zcode-tarkov — developer notes

Everything under `docs/dev/`, `tools/` and `evidence/` is developer and
verification material. It is not user documentation; the user guide is
`README.md` / `README.zh-CN.md` in the repository root.

## What lives here

| Path | What it is |
|---|---|
| `install-layout.md` | The authoritative lifecycle contract: the installed tree, the `settings.json` schema, the ZCode discovery order, the exit codes, what each script may destroy, and the interfaces a ZCode update can invalidate. |
| `zcode-dom-notes.md` | The live DOM/CSS facts the theme depends on — token scopes, the stable `data-slot` / Radix vocabulary, the banner anchor — plus the isolated-instance recipe used to observe a running ZCode without disturbing the user's own instance. |
| `zcode-runtime-signals.md` | The **run-state** signals — is the agent working, finished, waiting for an approval, rendering a tool call — with the state transition each was observed to move between and, just as importantly, the items that could **not** be observed. Start here when a ZCode update breaks something behavioural. |
| `UPSTREAM_SYNC.md` | The upstream review ledger: which `zcode-beautify` revisions have been reviewed, how each commit was classified, what was ported, and which divergences from upstream are deliberate. |
| `OWNER_PLAYTEST.md` | The owner checklist for the v0.1.0 playtest: eyeball checks, no commands. |
| `../tools/` | The re-runnable verification harnesses (below). |
| `../evidence/` | Historical deployment evidence, including the owner-playtest preparation record with its before/after hashes. |
| `../../RELEASE_EVIDENCE.md` | The release gate record for v0.2.0: what was run, what it produced, and what was not tested. |
| `../ROADMAP.md` | What is deliberately not part of the current release, and the candidates for the next one. |

## Build, test, bundle

```powershell
npm run build            # tsc -> dist, then esbuild -> dist/client.js
npm test                 # compiles to .test-build/ and runs node --test
npm run bundle           # build, then esbuild -> the three committed dist bundles
npm run test:lifecycle   # the lifecycle regression suite (PowerShell, temp-only)
npm run test:launcher-repair # the launcher-repair regression suite (PowerShell, temp-only)
```

Three bundles are committed and users never build them: `dist/cli.js`,
`dist/mcp/server.js`, and — new in v0.2 — `dist/client.js`, the program injected
into the renderer. After any change under `src/`, run `npm run bundle` and commit
the result: `npm test` fails when a committed bundle does not carry the current
version (`tests/manifest.test.mjs`).

`src/client/` is real TypeScript rather than generated script strings, so it is
type-checked by the same `tsc` run and its pure modules (the event machine, the
leader lease, the LRU, the phrase pool) are unit-tested directly. The bundle step
is only what turns it into the single self-contained program the injector needs.

## The two live harnesses

Both harnesses are fail-closed: they refuse to run unless every path they write
is below `%TEMP%`, and the end-to-end harness additionally refuses to stop a
process that is not provably its scratch instance (`ZCode.exe` whose command
line carries the scratch CDP port).

| Harness | What it proves |
|---|---|
| `tools/verify-v02.ps1` (with the CDP driver `tools/verify-v02.mjs`) | The **v0.2 client** in a live renderer: injection and idempotent re-injection, clean teardown and recovery across a reload, the band's three modes with their real geometry, the accent token, byte-range streaming, the library, the dock, the pet, the settings centre — and the README screenshots. Evidence: `docs/images/v02/verify-v02-evidence.json`. |
| `tools/verify-leader.mjs` | The multi-renderer BGM leadership rule: two complete clients in one process, one leader, forwarded commands, and failover when the leader dies. **Simulated** — it is a runtime harness, not two live ZCode windows, and it says so in its own output. |
| `tools/probe-signals.mjs` | Rediscovery of the DOM run-state signals after a ZCode update. Subcommands `launch / snapshot / watch / send / eval / click / close / session`. |
| `tools/verify-clean-install.ps1` (with the CDP driver `tools/verify-clean-install.mjs`) | The full end-to-end journey on an isolated scratch tree: clean `install.ps1` -> isolated launch -> the Tarkov theme visible in the live renderer (30 renderer assertions) -> screenshots -> uninstall (dry run, real run, idempotency) -> the real profile provably unchanged. Result: `docs/images/clean-install-evidence.json`. |
| `tools/test-lifecycle.ps1` | The bounded, temp-only regression suite for `install.ps1` / `repair.ps1` / `uninstall.ps1`: clean install, install idempotency, refusal of a foreign `settings.json` (and `-Force` adoption), `repair.ps1` merging `-ShortcutDir` into the recorded list, uninstall `-DryRun` changing nothing, a real uninstall that keeps the data directory **and the user's media**, `-PurgeUserData` deleting exactly the root it was aimed at, a second uninstall reporting `[absent]`, and the real profile unchanged. It runs with `-NoService` and `-KeepOfficialShortcuts`, so no real service, shortcut or registry value is touched. |
| `tools/test-launcher-repair.ps1` | The bounded, temp-only regression suite for `repair-launchers`: it builds real `.lnk` files and a scratch `HKCU` prefix below `$TEMP` and drives the compiled repair with `USERPROFILE`, `APPDATA`, `PUBLIC` and `ProgramData` redirected into the scratch tree. 51 assertions: the pinned taskbar is repaired as a user entry, machine-wide entries are reported `failed` and proven byte-identical, a decoy executable is untouched, a malformed shortcut does not abort the run, and a second run changes nothing. |

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

### v0.2 adds three more variables to that recipe

Redirecting `userData` is **not** enough for a v0.2 run, and the missing piece is
not obvious from the outside: ZCode resolves its own home directory through
`Electron.app.getPath('home')`, which ignores `USERPROFILE`. An instance with only
`userData` redirected therefore still reads the **real** `~/.zcode` — projects,
conversations and credentials included. Two consequences:

```powershell
$env:ZCODE_HOME                 = '<scratch>\home\.zcode'   # the real one is otherwise used
$env:ZCODE_DESKTOP_HOME_DIR     = '<scratch>\home\.zcode'
$env:ZCODE_DATA_BASE_DIR        = '<scratch>\home'
$env:ZCODE_TARKOV_DATA_DIR      = '<scratch>\userdata'      # the v0.2 user media root
```

- With `ZCODE_HOME` pointed at a scratch directory the instance is fully
  isolated, but it boots to the login screen and **cannot run a task**. To
  observe run-state behaviour you must also copy six credential files from the
  real `~/.zcode/v2/` into `<scratch>/home/.zcode/v2/` *before* launching:
  `credentials.json`, `provider_config.json`, `config.json`, `setting.json`,
  `model-provider-display-order.json`, `coding-plan-cache.json`. They are
  secrets: they belong under `$TEMP`, never in this repository and never in a
  screenshot. `tools/probe-signals.mjs` does this copy and tripwires the real
  files (mtime/size, contents never read) so a stray write is reported.
- `ZCODE_TARKOV_DATA_DIR` moves the v0.2 media root. Every harness that runs the
  installers **must** set it into the scratch tree: without it, `install.ps1`
  and `repair.ps1` would create — and `uninstall.ps1 -PurgeUserData` would
  delete — the real `%LOCALAPPDATA%\zcode-tarkov\data`.

Nothing in this directory is user documentation, and nothing here is part of
the installed payload.
