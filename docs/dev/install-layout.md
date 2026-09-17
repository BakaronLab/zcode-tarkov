# zcode-tarkov install layout (Windows)

This file is the layout contract for the user-level lifecycle scripts: the
installer (`install.ps1`), the repair tool (`repair.ps1`), the uninstaller
(`uninstall.ps1`), the launcher (`launcher/zcode-tarkov-launch.ps1`), the
shortcut trampoline (`launcher/zcode-tarkov-launch.vbs`) and the shared helpers
they all load (`launcher/zcode-tarkov-shortcuts.ps1`,
`launcher/zcode-tarkov-discovery.ps1`). It describes what is installed, the
`settings.json` schema, the ZCode discovery order, the exit codes, what each
script may destroy, and which external interfaces a ZCode update can invalidate.

Everything described here is user-level. No script elevates, writes to
`C:\Program Files`, `%ProgramData%`, the public desktop or `HKLM`, changes
`PATH` or any persistent environment variable, modifies ZCode's installation
files, or creates/changes/deletes an official ZCode shortcut. The only files
written outside `-InstallDir` are the shortcut named `ZCode Tarkov.lnk` in the
directories given by `-ShortcutDir`, and the per-user autostart entry that the
plugin's own CLI registers.

All PowerShell files in this contract are ASCII only (comments included), have
no BOM, and are Windows PowerShell 5.1 compatible.

## 1. Installed tree

```
<InstallDir>\                                  default: %LOCALAPPDATA%\Programs\zcode-tarkov
  settings.json                                written by install.ps1, read by the launcher
  dist\cli.js                                  bundled CLI (serve, apply, theme, recovery, ...)
  dist\mcp\server.js                           MCP server used by the plugin host
  launcher\zcode-tarkov-discovery.ps1          shared read-only discovery (Find-ZcodeExe, ...)
  launcher\zcode-tarkov-shortcuts.ps1          shared shortcut/identity helpers (see section 5)
  launcher\zcode-tarkov-launch.ps1             the launcher itself
  launcher\zcode-tarkov-launch.vbs             hidden trampoline, the shortcut target
  LICENSE
  THIRD_PARTY_NOTICES.md
  licenses\<name>.LICENSE                      all files of the source licenses\ directory
  repair.ps1                                   optional: copied when the source ships it
  uninstall.ps1                                optional: copied when the source ships it
  README.md, README.zh-CN.md, CHANGELOG.md     optional: copied when the source ships them
  launcher.log                                 one line per launch: in settings.dataDir when set,
                                               otherwise here; a run that cannot read settings.json
                                               always logs here
```

With `-DataDir <path>` the child processes get `ZCODE_BEAUTIFY_DATA_DIR=<path>`,
and `launcher.log`, `serve.log`, `config.json` and `recovery.json` land there
instead. Without it, the CLI resolves its own data directory (in this order):
`ZCODE_BEAUTIFY_DATA_DIR`, `%USERPROFILE%\.zcode\cli\plugins\data\zcode-tarkov@zcode-tarkov`,
`%USERPROFILE%\.zcode\cli\plugins\data\zcode-tarkov`, then the legacy
`zcode-beautify` directories.

The sign-in autostart entry carries the same variable: when
`ZCODE_BEAUTIFY_DATA_DIR` is set in the environment that runs
`recovery always` / `autostart install`, the written entry exports it to the
service it starts (Windows VBScript process environment / launchd
`EnvironmentVariables` / `env` prefix in the Linux `.desktop` `Exec` line), so a
service started at sign-in serves the same config the launcher expects. Without
the variable the entry is unchanged and the CLI's own resolution above applies.

`install.ps1` itself is not part of the payload: the installed tree contains no
installer, only the launcher, the CLI and (when the source ships them) the
`repair.ps1` / `uninstall.ps1` helpers. `repair.ps1` and `uninstall.ps1` load
their helpers from `<repo>\launcher\...` when they are run from a source tree
and from `<InstallDir>\launcher\...` when they are run from an installed tree;
without those helpers they refuse every step that needs to identify something
instead of guessing.

## 2. settings.json schema

Exactly these keys, in this order, BOM-free UTF-8 with 2-space indentation:

| Key | Type | Meaning |
|---|---|---|
| `product` | string | always `"zcode-tarkov"` |
| `version` | string | `version` from `<SourceDir>\.zcode-plugin\plugin.json` at install time |
| `installDir` | string | absolute install directory |
| `nodePath` | string | absolute node.exe used for every child process |
| `cliPath` | string | `<installDir>\dist\cli.js` |
| `cdpPort` | number | port ZCode is started with (`--remote-debugging-port`) |
| `apiPort` | number | port of the resident service control API |
| `dataDir` | string or null | `ZCODE_BEAUTIFY_DATA_DIR` for every child process |
| `zcodeExe` | string | absolute ZCode.exe resolved at install time |
| `zcodeInstallDir` | string | directory containing `zcodeExe` |
| `zcodeResolvedBy` | string | which discovery step found ZCode (see below) |
| `launcherKind` | string | `"vbs"` or `"powershell"`: what the shortcut targets |
| `shortcuts` | string[] | every shortcut path that is ours (created, updated or kept) |
| `installedAt` | string | ISO 8601 UTC, preserved across re-installs |
| `updatedAt` | string | ISO 8601 UTC, refreshed on every write |

### The v0.2 user data root is deliberately not in this file

v0.2 added a second data directory: the user media root at
`%LOCALAPPDATA%\zcode-tarkov\data` (`music`, `sounds`, `voice`, `pet`, `status`,
`prefs.json`), relocatable with `ZCODE_TARKOV_DATA_DIR`. It is **not** recorded
here, and that is a decision rather than an omission:

- `settings.json` describes how to *start* the service. The media root is
  resolved by `src/core/dataRoot.ts` from the platform default, and the launcher
  inherits an overridden `ZCODE_TARKOV_DATA_DIR` from the environment that
  launched it.
- A second copy of the path could only ever disagree with the first. The one
  place a copy is genuinely needed is the *sign-in* entry, which is written by no
  shell that has the variable — so `src/core/autostart.ts` bakes
  `ZCODE_TARKOV_DATA_DIR` into that entry directly (VBScript process
  environment, launchd `EnvironmentVariables`, or an `env` prefix in the Linux
  `.desktop` `Exec`), exactly as it already did for `ZCODE_BEAUTIFY_DATA_DIR`.

`install.ps1` and `repair.ps1` do create the root and its five subdirectories,
and both report the resolved absolute path in their output and in their
`-DryRun`/result JSON under `userDataDir`.

Three writers implement this schema byte-compatibly: `install.ps1` (initial
write and every re-install), the launcher (a best-effort refresh of `zcodeExe`,
`zcodeInstallDir`, `zcodeResolvedBy` and `updatedAt` when the resolution moved)
and `repair.ps1` (the same refresh, plus `nodePath` and `shortcuts`). Values
added to the file by hand are not preserved by a rewrite.

Re-install behaviour: `installedAt` is preserved, `zcodeExe` from the previous
file is kept while that file still exists and `-ZcodeExe` was not given
(`zcodeResolvedBy` then becomes `settings-cache`), `dataDir` is preserved while
`-DataDir` is not given, and the remaining keys are recomputed. A re-run
therefore converges: only `updatedAt` changes.

`repair.ps1` never rewrites `cdpPort` or `apiPort`: its `-CdpPort` / `-ApiPort`
parameters only decide which port is probed and which port a fresh service is
started on. Changing the recorded ports is an `install.ps1` decision.

## 3. Shortcut ("ZCode Tarkov.lnk")

| `launcherKind` | Target | Arguments |
|---|---|---|
| `vbs` (default) | `%SystemRoot%\System32\wscript.exe` | `"<InstallDir>\launcher\zcode-tarkov-launch.vbs"` |
| `powershell` (VBScript unavailable) | `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` | `-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "<InstallDir>\launcher\zcode-tarkov-launch.ps1"` |

Both kinds set `WorkingDirectory = <InstallDir>`,
`Description = "ZCode with the Tarkov theme (zcode-tarkov launcher)"` and
`IconLocation = "<zcodeExe>,0"`.

`vbs` is chosen when a probe (`cscript.exe //nologo //E:vbscript` on a scratch
file in `%TEMP%`, deleted afterwards) succeeds; on any doubt the installer picks
`powershell`. The trampoline exists so a double-click never flashes a console
window (window style 0 hides it at process creation).

An existing `ZCode Tarkov.lnk` is only overwritten when its target is
`ZCode.exe`, or `wscript.exe`/`powershell.exe` together with an argument that
names our launcher script under this exact `-InstallDir`. Any other target is
kept and reported; `-Force` replaces it. A `-ShortcutDir` that does not exist is
reported and skipped: the installer never creates directories outside
`-InstallDir`.

The trampoline starts the launcher and exits immediately (`Run ..., 0, False`),
so the launcher's exit code is not visible to the shell that started the
shortcut. `launcher.log` is the record of what happened.

`uninstall.ps1` deletes a `ZCode Tarkov.lnk` only when
`Test-ZctShortcutIsOurs` proves it targets our launcher under this
`-InstallDir`. The one separate case is the entry the project's own playtest
tooling wrote: a `ZCode Tarkov.lnk` whose target is `ZCode.exe` and whose
arguments carry `--remote-debugging-port=`. That entry is reported and removed
unless `-KeepLegacyShortcut` is given.

## 4. ZCode discovery order

`Find-ZcodeExe [-Cached <path>]` returns
`@{ Path; InstallDir; ResolvedBy; Candidates }` or `$null`. First existing file
wins:

1. `-Cached <path>` -> `settings-cache` (the launcher passes `settings.zcodeExe`)
2. `%ZCODE_WINDOWS_APP_INSTALL_DIR%\ZCode.exe` -> `env`. On machines where the
   plugin host already exports this variable, this step normally wins.
3. `HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\ZCode.exe`,
   default value -> `registry-hkcu`. A quoted value may carry arguments; only the
   executable token is used.
4. The same key under `HKLM:` -> `registry-hklm` (read-only access).
5. `C:\Program Files\ZCode\ZCode.exe`, `%LOCALAPPDATA%\Programs\ZCode\ZCode.exe`
   -> `known-path`
6. Bounded scan of `C:\Program Files`, `%LOCALAPPDATA%\Programs` and
   `%ProgramFiles(x86)%` -> `scan`. For every immediate `ZCode*` child it probes
   `<child>\ZCode.exe`, `<child>\current\ZCode.exe` and
   `<child>\app-<version>\ZCode.exe` (depth 3). With several hits the highest
   `[version]`-parsable directory name wins; without any, the newest
   `LastWriteTimeUtc` wins. The disk is never scanned recursively.

`Candidates` lists every location probed, in probe order, including the ones
that did not exist, so `repair.ps1` can print where ZCode was looked for.

Also exported: `Test-PortOpen -Port <n> [-TimeoutMs 400]` (TCP connect to
`127.0.0.1`, never throws), `Get-CdpIdentity -Port <n> [-TimeoutMs 700]` (GET
`http://127.0.0.1:<n>/json/version`; returns the parsed object only when the
body parses as JSON, carries `webSocketDebuggerUrl` and its `Browser` matches
`Chrome|Electron|ZCode`, otherwise `$null` - an open port alone proves nothing)
and `Get-ServiceHealth -ApiPort <n>` (GET `/api/health`; returns the parsed
object only when it carries `"service":"zcode-beautify"`, otherwise `$null`).

## 5. Shared helper: launcher/zcode-tarkov-shortcuts.ps1

Dot-sourced by all three lifecycle scripts so they cannot drift on what "ours"
means. Loading it has no side effects (nothing is written, created, started or
stopped).

| Function | Purpose |
|---|---|
| `Get-ZctShortcutSpec -Kind -InstallDir [-ZcodeExe]` | the target/arguments/icon/description for a launcher kind |
| `Get-ZctLauncherShortcut -Path <lnk>` | read a shortcut, or `$null` when it does not exist |
| `Test-ZctShortcutIsOurs -Shortcut -InstallDir` | true only for wscript.exe + `<InstallDir>\launcher\zcode-tarkov-launch.vbs`, or powershell.exe + `<InstallDir>\launcher\zcode-tarkov-launch.ps1` |
| `Test-ZctShortcutAdoptable -Shortcut -InstallDir` | the above, plus a `ZCode.exe`-target entry under our name (the legacy playtest launcher). This is the predicate `install.ps1` uses to decide whether the file may be replaced; `uninstall.ps1` does not delete on it |
| `New-ZctLauncherShortcut -Path -Kind -InstallDir [-ZcodeExe] [-Force] [-DryRun]` | create/update/keep/refuse, returning `Status` (`created`, `updated`, `kept`, `refused`, `dry-run`, `failed`) plus `Before`/`After` |
| `Remove-ZctOfficialFlag -Path <lnk> [-Ports <int[]>] [-DryRun]` | strip one `--remote-debugging-port` token for one of `-Ports` (default 9222) from a shortcut whose target is `ZCode.exe`; never deletes the file |
| `Get-ZctOfficialHandlerKeys` | the three HKCU handler keys whose default value may carry the flag |
| `Remove-ZctOfficialHandlerFlag -Key <ps path> [-Ports <int[]>] [-DryRun]` | the same strip for a handler default value, additionally gated on the value naming `ZCode.exe`; never deletes a key or a value |
| `Remove-ZctDebugPortToken -Arguments <string> [-Ports <int[]>]` | the argument string without the flag token; only the `=` and the space-separated forms for one of `-Ports` are stripped |
| `Test-ZctProcessIsOurs -ProcessId -InstallDir [-CliPath] [-RequireServe]` | read-only identity check: `node.exe`, command line runs this install's `-CliPath` (the install directory string alone is not enough, and is only the fallback when no CLI path is known), and - for the service - carries the `serve` token. Stopping stays in the caller |
| `Get-ZctInstallProcesses -InstallDir [-CliPath] [-ExcludeProcessId]` | `@{ Ok; Reason; Processes }` for every `node.exe` that runs this install's `-CliPath` with a `serve` or `watch` token (read-only). `Ok = $false` means the list could not be read (WMI/CIM unavailable), so callers report "could not inspect", never "none found" |
| `Test-ZctIsReparsePoint -Path <p>` | `$true` when the path exists and carries the reparse-point attribute (junction/symlink) |
| `Get-ZctTreeFiles -Root <dir>` | `@{ Files; Skipped }`: files below a directory, never descending into a reparse point; `Skipped` is every reparse point that was not followed |
| `Remove-ZctTreeSafe -Root <dir>` | delete a tree without ever following a reparse point (files first, directories bottom-up); returns the paths that were left behind |

The official launcher key set is exactly:

```
HKCU:\Software\Classes\zcode\shell\open\command
HKCU:\Software\Classes\Directory\shell\ZCode.OpenInZCode\command
HKCU:\Software\Classes\Drive\shell\ZCode.OpenInZCode\command
```

which is where the project's `evidence/owner-playtest-prep/launcher-apply.ps1`
injected the flag, and what `uninstall.ps1` restores.

The strip is restricted to the ports this project could have injected: the
configured `cdpPort` plus the historical default 9222 (`-Ports`). Both handled
forms are covered - `--remote-debugging-port=<n>` and
`--remote-debugging-port <n>` - and nothing else is touched: a token naming any
other port, or a bare flag without a value, stays, because it did not come from
this project.

## 6. Lifecycle scripts

### install.ps1

```
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
  -InstallDir <dir>   default %LOCALAPPDATA%\Programs\zcode-tarkov
  -SourceDir <dir>    default: the directory holding install.ps1
  -DataDir <dir>      recorded and exported as ZCODE_BEAUTIFY_DATA_DIR
  -CdpPort 9222  -ApiPort 9223
  -ZcodeExe <exe>     explicit ZCode.exe; skips discovery
  -ShortcutDir <dir[]>  default: user Desktop and user Start Menu Programs
  -NoShortcuts  -NoService  -DryRun  -Force  -Json
```

Exit 0 when installed (warnings allowed), 1 when refused or failed (nothing was
installed). It may create `<InstallDir>`, the `ZCode Tarkov.lnk` files in
`-ShortcutDir`, the CLI's data directory, and the autostart entry the CLI
registers.

An existing `<InstallDir>` is only extended when it is provably ours: when
`settings.json` exists its content must carry `"product": "zcode-tarkov"` (a
file that cannot be parsed, or names another product, is refused without
`-Force`, naming the file and what was found - the message matches
`uninstall.ps1`'s wording), and when `settings.json` is missing the directory
must be empty. `-Force` adopts either case. A `settings.json` that is not ours
never supplies the re-install continuity values (`installedAt`, `dataDir`,
`zcodeExe`).

Stale payload: it removes only files that this project created and the current
source no longer ships - inside `<InstallDir>`'s `dist`, `launcher` and
`licenses` directories, and the top-level optional files (`repair.ps1`,
`uninstall.ps1`, `README.md`, `README.zh-CN.md`, `CHANGELOG.md`) that a
previous source shipped and this one does not. `LICENSE` and
`THIRD_PARTY_NOTICES.md` are always part of the payload, so they are never
stale. Every recursive enumeration in `install.ps1` and `repair.ps1` is
reparse-point safe: a junction/symlink below those directories is reported and
not followed.

### repair.ps1

```
powershell -NoProfile -ExecutionPolicy Bypass -File repair.ps1
  -InstallDir <dir>   default %LOCALAPPDATA%\Programs\zcode-tarkov
  -SourceDir <dir>    optional: re-copy the payload from this tree (upgrade in place)
  -CdpPort / -ApiPort 0 = settings.json, then 9222 / 9223 (probing only, never rewritten)
  -ZcodeExe <exe>     explicit ZCode.exe; skips discovery
  -ShortcutDir <dir[]>  merged into the recorded shortcut directories
  -NoShortcuts  -NoService  -RestartService  -DryRun  -Json  -Force
```

Exit 0 when everything is healthy or was repaired, 2 when it repaired something
but the install is still degraded, 1 when it is blocked (no `settings.json` with
`"product": "zcode-tarkov"`, ZCode unresolvable, payload incomplete without
`-SourceDir`). It may rewrite `settings.json` (only the values it re-resolved),
re-copy the payload (which also deletes stale files in `dist`, `launcher` and
`licenses` that the source no longer ships, reparse-point safely), recreate the
launcher shortcuts, and start or - with `-RestartService` - stop and start the
resident service. The only process it may stop is this install's service, after
`Test-ZctProcessIsOurs` passed, which means its command line runs this install's
`cliPath` and carries the `serve` token. It does not write the autostart entry:
it reports whether it is present and, when it is missing, points at
`install.ps1` in the source checkout.

`-ShortcutDir` never erases what `settings.json` recorded: the given
directories are merged into the recorded list, which is preserved as-is
(directories that do not exist are reported and their recorded entries stay),
and the merge is reported. The script's "Next steps" only name
`<InstallDir>\uninstall.ps1` when it exists; the recovery path it prints is
"run `install.ps1` from the source checkout" (the installed tree deliberately
carries no installer).

### uninstall.ps1

```
powershell -NoProfile -ExecutionPolicy Bypass -File uninstall.ps1
  -InstallDir <dir>   default %LOCALAPPDATA%\Programs\zcode-tarkov
  -DataDir <dir>      default: settings.json, then the CLI's own location
  -CdpPort / -ApiPort 0 = settings.json, then 9222 / 9223
  -ShortcutDir <dir[]>  extra directories to sweep for "ZCode Tarkov.lnk"
  -RemoveData  -KeepLegacyShortcut  -KeepOfficialShortcuts  -DryRun  -Force  -Json
```

Exit 0 when the sweep completed (warnings allowed), 1 when a step refused or
failed and needs the user's attention. See section 7 for the removal contract.
`-Force` overrides the install-directory marker check, the
`%LOCALAPPDATA%`/`%TEMP%` location guard and the reparse-point refusal.

Every step reports one of `[removed]`, `[absent]`, `[kept]`, `[refused]` (plus
`[info]`/`[warn]`/`[fail]`); `-DryRun` reports the full plan and writes nothing.
With `-Json` the only output is
`{ ok, dryRun, removed, kept, refused, notTouched, dataDir, installDir, warnings, failures }`.

### launcher/zcode-tarkov-launch.ps1

```
powershell -NoProfile -ExecutionPolicy Bypass -File zcode-tarkov-launch.ps1 [-NoPrompt] [-Quiet]
```

Reads `settings.json`, resolves ZCode, starts it with
`--remote-debugging-port`, makes sure the service is healthy, appends one line
to `launcher.log`. Exit 0 healthy, 2 degraded (ZCode runs, theme cannot be
applied), 3 ZCode is running without an active debug port, 4 the installation or
settings are unusable, 1 unexpected error. It may terminate ZCode itself (never
another process) and only after an explicit Yes in the restart dialog; with
`-NoPrompt` it never terminates anything.

"Already running with the debug port" requires the CDP endpoint to identify
itself (`Get-CdpIdentity`) **and** a `ZCode` process to exist. A port that is
open but answers as something else (or has no ZCode behind it) is treated as
another program's: the launcher reports `port <n> is in use by another
program`, prints/dialogs the fix (reinstall with a different `-CdpPort`, e.g.
`install.ps1 -CdpPort 9333`; `repair.ps1 -CdpPort 9333` only probes another
port and does not rewrite the recorded one), still starts ZCode (fail-soft:
the user always gets the app) and exits 2 without claiming success. The
"did the debug port come up" wait and the single-instance-lock race check both
use the same identity probe, so a foreign listener cannot fake success; the
foreign-port case does not wait at all, because the outcome is already known.

### launcher/zcode-tarkov-shortcuts.ps1 / launcher/zcode-tarkov-discovery.ps1

Shared helpers (section 5 and section 4). Loading them writes nothing.

## 7. Uninstall removal contract

Removed, each after an identity check:

| Item | Identity check |
|---|---|
| the pid behind `-ApiPort` | answers `/api/health` as `zcode-beautify`, process name `node.exe`, command line runs this install's `cliPath` and carries the `serve` token. Otherwise: refused, naming the pid and the reason (never killed by port number, never `taskkill /IM node.exe`) |
| other `node.exe` processes of this install | command line runs this install's `cliPath` **and** carries a `serve` or `watch` token (the install directory string alone is not an identity); each command line is printed before it is stopped. When the process list cannot be read at all (WMI/CIM unavailable), the step is `[refused]` with "could not enumerate processes", never a claimed `[absent]` |
| `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\zcode-beautify.vbs` | content carries the `ZCode Beautify` header, or a `zcode-tarkov`/`zcode-beautify` CLI path. Otherwise kept, with the reason |
| `ZCode Tarkov.lnk` in the recorded directories, `-ShortcutDir`, the user Desktop and the user Start Menu | `Test-ZctShortcutIsOurs`; the legacy `ZCode.exe` + `--remote-debugging-port=` entry is removed unless `-KeepLegacyShortcut`; every other target is kept |
| `<InstallDir>` (recursively) | contains `settings.json` with `"product": "zcode-tarkov"`, and lives under `%LOCALAPPDATA%` or `%TEMP%`. Otherwise refused unless `-Force`. When `<InstallDir>` itself is a directory reparse point (junction/symlink), the delete is refused unless `-Force`: PowerShell 5.1 would otherwise follow the link and delete its target |
| `--remote-debugging-port` tokens in `ZCode.lnk` (user Desktop, user Start Menu) and in the three HKCU handler default values | target is `ZCode.exe`, or the value names `ZCode.exe`; only the token for the configured `cdpPort` or the historical 9222 is removed (both the `=` and the space-separated form), the entry survives; a token naming any other port stays |
| with `-RemoveData`: `config.json`, `config.backup.json`, `recovery.json`, `wallpaper.*`, `serve.log`, `launcher.log` in the data directory | exact file names; the directory is deleted only when it is empty afterwards, otherwise kept and the remaining items are listed |

The recursive delete never follows a reparse point: it deletes the files it
found by walking the tree itself (never descending into a junction/symlink) and
then the directories bottom-up, leaving the reparse points - and the directories
that contain them - in place. Those are reported as `[kept]`, so the target of a
link is never touched.

Left alone, provably:

- ZCode's installation directory and ZCode's own profile (read-only access).
- ZCode's official shortcuts and the three HKCU handler values as entries: at
  most the token we injected is removed.
- the marketplace plugin cache (`%USERPROFILE%\.zcode\cli\plugins`). A plugin
  installed from the marketplace is removed in ZCode's own plugin UI.
- every shortcut that is not ours.
- the data directory, unless `-RemoveData` is given (it holds the user's
  wallpaper and settings).
- anything above `-InstallDir` (the directory itself is the deletion unit).

Uninstall is idempotent: a second run over a half-removed install reports
`[absent]` for what is already gone and exits 0.

## 8. Exit codes

| Script | Code | Meaning |
|---|---|---|
| `install.ps1` | 0 | installed; warnings are allowed |
| | 1 | refused or failed; nothing was installed (includes a non-empty `<InstallDir>` that is not ours, or a `settings.json` that is unparseable or names another product, without `-Force`) |
| `repair.ps1` | 0 | healthy, or repaired |
| | 2 | repaired, but something is still degraded |
| | 1 | blocked: the installation could not be repaired |
| `uninstall.ps1` | 0 | the sweep completed; warnings are allowed |
| | 1 | a step refused or failed and needs the user's attention (includes a process list that could not be read, and a reparse-point install directory without `-Force`) |
| `launcher\zcode-tarkov-launch.ps1` | 0 | ZCode runs with the debug port and the service is healthy |
| | 2 | degraded: ZCode is running and usable, but the debug port did not come up (or is held by another program) or the service did not, so the theme cannot be applied |
| | 3 | ZCode is running (or was started) without an active debug port; quit it completely and start it again |
| | 4 | `settings.json` missing/unusable, or ZCode not found: re-run `repair.ps1` |
| | 1 | unexpected error (the launcher fails soft and never blocks ZCode) |
| `launcher\zcode-tarkov-launch.vbs` | 0 | always (fire and forget) |

The launcher only exits 3 before doing anything when its `-NoPrompt` switch is
set or the user declines the restart dialog. `-NoPrompt` never shows a dialog and
never terminates a process.

## 9. Interface diagnostics (repair.ps1, step 7)

These are the three things a ZCode software update can break. `repair.ps1`
always prints exactly these three rows (and the same three objects in its
`interfaces` JSON array):

| Interface | What is verified | Repairable offline | Failure mode after a ZCode update |
|---|---|---|---|
| `launcher` | ZCode resolution, shortcut integrity, the CDP/API port states | yes, in `repair.ps1` (with `-SourceDir` for the payload and `-RestartService` for the service) | ZCode is not found (exit 4 / blocked), the shortcut points at a moved install, or the API port belongs to something else |
| `dom-selectors` | nothing offline: when the CDP port is open, `/json/version` is read best-effort and `Browser`/`User-Agent` are reported; when the port is closed, that is stated and no sample is taken | no | the injected CSS stops matching ZCode's DOM; a newer zcode-tarkov is required |
| `css-tokens` | nothing offline: the palette and CSS variable names are fixed in the installed zcode-tarkov build | no | ZCode renames its CSS variables and the theme no longer applies; a newer zcode-tarkov is required |

Reading `/json/version` needs no WebSocket and changes nothing: it is a plain
HTTP GET on the local debug port. The same read, and its `webSocketDebuggerUrl`
plus `Browser` shape, is what `Get-CdpIdentity` uses to tell ZCode's endpoint
apart from any other listener.

The CLI's appearance commands (`theme`, `apply`, `colors`, `reset`) pick their
renderer targets through one shared helper that waits, bounded to 5 s, only in
the cold-start case "endpoint reachable, zero renderer targets": ZCode answers
`/json/version` about a second after start, but the first page target only
appears around 2.5 s in (measured), and a command run in that window would
otherwise fail with "No ZCode renderer target found on the CDP endpoint." An
unreachable endpoint still fails on the first attempt, so `status`, `watch` and
`serve` keep their current latency.

## 10. What a ZCode update can invalidate

| Interface | Used for | Failure mode when it changes |
|---|---|---|
| `ZCode.exe` receives `--remote-debugging-port=<n>`, Chromium then serves CDP on that port | the whole theming path | the launcher reports exit 2/3; ZCode itself still starts |
| `GET http://127.0.0.1:<cdpPort>/json/version` returning JSON with `webSocketDebuggerUrl` and a `Browser` value matching `Chrome\|Electron\|ZCode` | `Get-CdpIdentity`: "is this port really ZCode's DevTools endpoint?" in the launcher (and the DOM probe in `repair.ps1`) | the launcher stops recognising its own endpoint: it would report "port in use by another program" (exit 2) and not wait for the port; `repair.ps1` reports the build in view as unreadable |
| Electron single-instance lock: a second instance forwards its arguments and exits | detecting "port came up and closed again" | the launcher would report success while no CDP endpoint survives |
| ZCode.exe file name and install location (known paths, `ZCODE_WINDOWS_APP_INSTALL_DIR`, App Paths, Squirrel `app-<version>`/`current` layouts) | `Find-ZcodeExe` | exit 4 until `repair.ps1` re-detects the new location and rewrites `settings.json` |
| `GET http://127.0.0.1:<apiPort>/api/health` returning JSON with `service` and `pid` | health check and pid reporting | the launcher and installer treat the service as missing and try to start one; uninstall refuses to stop an unidentified pid |
| CLI verbs `serve --port --api-port --detach` and `recovery <mode> --port --api-port` | resident service and autostart | service does not start (exit 2), autostart verification fails at install time (exit 1) |
| Autostart entry name and location `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\zcode-beautify.vbs` | service after sign-in | `install.ps1` reports a failure; the launcher keeps working per session; `uninstall.ps1` finds nothing to remove |
| `recovery` accepts `--api-port` and bakes it into the autostart entry (fixed in this build) | custom `-ApiPort` | before the fix a non-default `-ApiPort` was honoured by the launcher but not by the sign-in entry; `repair.ps1` now reports the missing autostart entry as degraded |
| `ZCODE_BEAUTIFY_DATA_DIR` read by the CLI | the data directory of every child process | the autostart entry bakes the variable in when it is set at registration time (Windows process environment, launchd `EnvironmentVariables`, Linux `env` prefix); if a future CLI ignores it, the sign-in service would fall back to the CLI's own data directory and serve a different config than the launcher |
| the settings panel's offline hint no longer tells the user to run a terminal command (fixed in this build) | user-facing recovery | end users now get "relaunch ZCode from the ZCode Tarkov shortcut", which is what the launcher and the service actually need |
| VBScript/`wscript.exe` availability (deprecated Windows feature) | shortcut kind `vbs` | install time falls back to `launcherKind = "powershell"` |
| `%APPDATA%`-derived Startup path | autostart location | a redirected `%APPDATA%` redirects the entry (this is what tests use) |
| node.exe on `PATH`, in `C:\Program Files\nodejs` or `%LOCALAPPDATA%\Programs\nodejs` | every child process | install refuses (exit 1); the launcher warns and continues without the service; `repair.ps1` re-resolves and rewrites `nodePath` |
| `WScript.Shell` COM shortcut objects (`TargetPath`, `Arguments`, `WorkingDirectory`, `IconLocation`, `Description`) | creating, inspecting and repairing shortcuts | `New-ZctLauncherShortcut` reports `failed`; the install refuses to claim success |

The installed copy is self-contained: updating the ZCode plugin itself does not
change `<InstallDir>`; re-run `install.ps1` to refresh it, or `repair.ps1
-SourceDir <tree>` to upgrade in place.

## 11. Known gaps

- `dom-selectors` and `css-tokens` cannot be checked without a running ZCode on
  the CDP port; `repair.ps1` reports them as "not verifiable offline" instead of
  guessing.
- The data directory is intentionally kept by default; removing it loses the
  user's wallpaper and settings. `uninstall.ps1 -RemoveData` deletes only the
  file names listed in section 7.
- An uninstall run against an install whose port is owned by another
  zcode-tarkov install refuses the service step (exit 1) and points at the pid
  and command line it found; nothing else in the sweep is skipped.
- When the CDP port belongs to another program, the launcher cannot move the
  port itself: it starts ZCode anyway, reports the conflict and exits 2 with the
  `-CdpPort` fix (only `install.ps1` rewrites the recorded port).
- A directory reparse point inside `<InstallDir>` is never followed, so the
  uninstall leaves it (and its parent directories) in place and reports it as
  `[kept]`; the directory is then not fully removed by that run.
- Only Windows is supported by these scripts; the CLI itself also runs on macOS
  and Linux, where none of the shortcut/handler logic applies.
<!-- The PowerShell files are ASCII-only, BOM-free and Windows PowerShell 5.1
     compatible. Keep it that way: any non-ASCII character in install.ps1,
     repair.ps1, uninstall.ps1 or launcher\*.ps1 breaks loading on a console
     with a legacy code page. -->
