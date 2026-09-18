# Changelog

`zcode-tarkov` starts at v0.1.0. Entries from v0.3.1 downward are the retained
history of the upstream project this repository was forked from,
[zcode-beautify](https://github.com/Logocceai/zcode-beautify) (MIT).

## v0.2.3

Documentation accuracy. An adversarial review of v0.2.2 checked the promises the
repair section makes against what the code actually does, and two of them did not
hold. No behaviour changed in this release — `dist/` differs only by the version
string — but the README is what ships inside the plugin zip, so the correction is
published rather than left on `main`.

**`uninstall.ps1` does not reverse every change the repair makes.** The repair
section said "every change it makes is reversed by running `uninstall.ps1`". It
is not: `uninstall.ps1` strips the flag from exactly two shortcuts — `ZCode.lnk`
in the user's own Desktop and Start Menu — and from the three `HKCU` handler
values, and only when the argument names the configured port or the historical
default `9222`. The repair, meanwhile, scans those directories *recursively* and
now includes the pinned taskbar, so it can legitimately fix a taskbar pin or a
renamed shortcut that the uninstaller will never revisit. Both READMEs and
`INSTALL-FOR-AI.md` now say what is reversed, what is not, and how to remove the
argument by hand. `v0.2.1` is what made this worth correcting: adding the pinned
taskbar to the repair widened the gap between the promise and the code.

**A mixed custom-port configuration fails silently.** If a shortcut already
carries `--remote-debugging-port` naming a *different* port than the plugin is
configured to use, the repair treats that entry as already correct — it never
rewrites a port the user chose — and reports `no-op` without logging anything.
When ZCode was started that way the theme cannot reach it, and nothing said so.
This is now documented in both READMEs as a known limitation with the fix (make
the two ports agree, or drop the argument); the code is deliberately unchanged,
because rewriting a user-selected port is worse than reporting the state.

**The machine-wide refusal is now pinned structurally.** `npm test` previously
checked that behaviour only through the reason string, the absence of `HKLM` and
the absence of any elevation mechanism — all of which a regression can satisfy
while still writing a machine-wide entry, since the only thing that would have
caught it was the Windows-only PowerShell harness. The generated script is now
asserted to contain exactly one shortcut write and one registry write, and the
machine-scope branch is sliced from its test to its `continue` and asserted to
contain no write at all. Verified by mutation: adding a machine-wide save while
leaving every prose assertion intact fails both new guards. `npm test` is 331
tests.

## v0.2.2

A hardening release for the automatic launcher repair introduced in v0.2.1. An
adversarial review of that release found the identity gate it relied on was too
loose.

**Identity is now proven before any write.** The repair decided a shortcut
belonged to ZCode with `$target -notlike '*ZCode.exe'`, which matches any target
whose path merely *ends* in `ZCode.exe` — an unrelated `C:\tools\MyZCode.exe` or
`NotZCode.exe` passed the gate and would have had the debug flag appended to its
shortcut. The registry check had the same looseness: it accepted any command
value that mentioned `ZCode.exe` anywhere. Both now compare the executable's
**file name** for exact equality (`[System.IO.Path]::GetFileName(...) -ne
'ZCode.exe'`), and the registry value is resolved to its executable token first.
The gate itself was inherited unchanged from upstream — this release is the first
time the project runs it automatically, which is what made the looseness
mattering.

**Two new decoys pin it.** `tools/test-launcher-repair.ps1` now carries a
shortcut decoy whose executable is named `NotZCode.exe` and a matching registry
decoy, and asserts both are left byte-identical and never reported. Against the
old gate those assertions fail loudly — the decoy shortcut acquired
`--remote-debugging-port=9222` and the decoy registry value was rewritten — so
the suite now pins the exact behaviour that was wrong. The suite grew from 51 to
61 assertions.

**Nothing else changed.** A shortcut whose executable really is `ZCode.exe` is
still repaired wherever it lives, a shortcut that already carries a
`remote-debugging-port` value is still left alone, machine-wide entries are still
reported but never written, and there is still no `HKLM` write and no elevation
path anywhere in the generated script.

## v0.2.1

Launcher resilience for the post-update case, ported from the upstream review
through v0.3.3.

**The plugin repairs its launch entries by itself.** When it finds ZCode running
with the CDP port closed, it runs the same repair the `repair-launchers` command
performs and logs what it changed — via stderr in the MCP host, and to the
service log in the resident service: the desktop, Start Menu and pinned-taskbar
shortcuts, plus the `zcode://` protocol handler and the Explorer context-menu
verbs. The guarded decision lives in `src/core/startupRepair.ts` and is shared by
`src/mcp/server.ts`, which calls it after the theme-restore retries are
exhausted (the normal post-update path), and by `src/core/server.ts`, once per
process, on the first poll that sees a running ZCode with no CDP endpoint. A
healthy endpoint produces zero launcher writes, a shut-down app is not mistaken
for a lost flag, and the function never throws. The repair cannot take effect
in place — ZCode reads the flag only at startup — so repairing now makes the
*next* start healthy. It is needed because ZCode's updater rebuilds the Start
Menu shortcut without the flag, and the app re-registers its own `zcode://`
protocol and context-menu registry handlers on every start, restoring those
values; shortcut copies are the durable entries.

**The pinned taskbar is now covered.** The repair scans
`%APPDATA%\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar` as a
user-scope location — where a user who pinned the app actually clicks — in
addition to the desktop and Start Menu shortcuts.

**Machine-wide entries are reported, never written.** The shared desktop and the
shared Start Menu are returned as `failed` with "machine-wide entry needs
administrator rights; not modified", and no write is ever attempted. This is a
deliberate divergence from upstream, which attempts the write and reports the OS
error: this project does not elevate, so it refuses the path outright rather than
leave a half-applied change behind.

**The CLI says what to do.** When a command reports the CDP port unreachable, the
message now names `repair-launchers` (with `--dry-run` for a preview) and the
full quit-and-relaunch, because the flag is read only at startup.

**The shipped CDP snippet hides its child console.**
`skill-pack/references/cdp-minimal.mjs` now passes `windowsHide: true` to its
`tasklist` probe, matching the three product spawn sites (`src/core/launch.ts`,
`src/core/launchers.ts`) where the option was already present. Without it,
probing for the ZCode process could flash a console window.

**Tests.** `tests/startupRepair.test.mjs` pins the decision order with fake
dependencies — a healthy endpoint and a shut-down app both produce zero repair
calls, and only "running with the port closed" repairs.
`tests/launcherScript.test.mjs` asserts the generated PowerShell directly: the
scanned locations and their scopes, the `HKCU`-only registry list, the identity
gates and the promise that no elevation mechanism is ever emitted.
`tools/test-launcher-repair.ps1`, run by `npm run test:launcher-repair`, drives
the real repair against a scratch tree below `%TEMP%` with real `.lnk` files and
a scratch `HKCU` prefix: 51 assertions covering the pinned-taskbar fix,
machine-wide entries reported with their files byte-identical, a decoy
executable untouched, a malformed shortcut that does not abort the run, and an
idempotent second pass. Nothing real is read or written.

**Documentation.** The update-compatibility section now separates file-level
safety from runtime version sensitivity: a ZCode update cannot overwrite or
conflict with this project because it never modifies the installation, while DOM
structure, semantic tokens, runtime signals and launch entries stay
version-sensitive and are handled by fail-soft behaviour and automatic repair.
The repair sections now say exactly what the manual command and the startup
repair can write, where machine-wide entries stop, and that the per-user
autostart entry is reported rather than written. The upstream review this port
came from is recorded in `docs/dev/UPSTREAM_SYNC.md`.

**Maintenance.** The repository now watches its own upstreams: a weekly
`upstream-radar` workflow compares the revisions recorded in the ledger with the
code upstream's latest release tag and default-branch head and with the design
reference's default-branch head, and opens or updates a single
`Upstream update available` issue when something moved. It only reads — it never
merges, pulls, pushes or writes to the repository, and a ledger it cannot parse
is reported instead of turning into a bogus issue.

## v0.2.0

v0.1 was a Tarkov *theme*. v0.2 is a Tarkov *interface layer*: the theme plus
audio, a companion, and a randomized status line, with a settings centre to
drive all of it. Feature parity is with
[dsh-theme-tarkov](https://github.com/ZHIGENGNIAO258/dsh-theme-tarkov) v0.2.0 at
`be1123c1c158e58ba0aa1c311c22d793b09f9c0d` — the same product capabilities,
rebuilt on ZCode's own runtime signals rather than DSH's Cordis host API.

The one deliberate departure is content. DSH ships 361 Scav voice clips, an
official Altyn helmet PNG and three game sound effects; none of that may be
redistributed. v0.2 therefore ships **no bundled media at all** — the effects are
synthesized with the Web Audio API, the pet is an original SVG, and the voice
pool is empty until the user fills it. See THIRD_PARTY_NOTICES.md.

### Added

- **Event sound effects.** `start`, `approval`, `done`, `error` and `tool`,
  each with its own switch and volume. The defaults are synthesized from
  oscillators and one noise burst — nothing is downloaded and no audio file
  ships — and any of them can be overridden by dropping `start.mp3`,
  `approval.wav`, `done.ogg`, … into `data\sounds\`.
- **An event state machine** (`src/client/signals/machine.ts`) that turns a noisy
  renderer into a small number of sounds: entry and exit debouncing, one sound
  per event per turn, approval edge-triggered and re-armed only after the ask is
  answered, and `error` outranking `done`. Re-rendering never re-fires.
- **BGM.** A library read straight from `data\music\`, byte-range streaming so
  seeking works, shuffle as a bag rather than an independent draw, repeat
  all/one, per-track enable/disable, upload with progress, and an empty state
  that names the folder to use.
- **A single-leader rule for playback.** ZCode can have several renderers alive;
  a `BroadcastChannel` plus a `localStorage` lease of 12 s elects one of them to
  own the music, while every other renderer keeps a fully working dock whose
  commands are forwarded. A stale leader cannot lock the room (the lease
  expires) and a race cannot produce two (a claim is only believed after a
  re-read).
- **A BGM dock** in the bottom-right corner, beside the settings launcher rather
  than on top of it, with a remembered collapsed state.
- **A draggable pet** with an original inline-SVG helmet as its default
  appearance, overridable from `data\pet\`. Pointer capture, a 5 px
  click-versus-drag threshold, viewport clamping that accounts for the banner,
  position persisted, and a right-click menu (mute voice, hide, reset position,
  open settings).
- **Pet voice.** Clicking the pet plays a random clip from `data\voice\`, with
  no immediate repeat, a configurable chance, decoded buffers in a 24 MB
  byte-bounded LRU, and no preloading.
- **Randomized running-status text** drawn from `data\status\texts.zh.txt` /
  `texts.en.txt`, falling back to a bundled pool of original phrases. The
  takeover is presentational only — the native text stays in the DOM, so
  `aria-live`, the elapsed timer and the task state are untouched, and restoring
  is removing one attribute.
- **A settings centre** replacing the v0.1 theme panel: Appearance, Audio, Pet,
  Status and System, as a real keyboard-navigable tab list, with an offline
  state that dims the controls instead of showing values it never read.
- **A palette you can recolour.** The Tarkov theme's base surface colour and its
  accent are both editable from **Settings → Appearance**, with the rest of the
  ramp — panels, raised surfaces, popovers, the deep input tone — derived from
  the background so a chosen colour stays coherent instead of leaving warm-brown
  panels under something they no longer match. Every ink (body text, muted text,
  the emphasis tones, text on a filled accent, text on the band) is chosen by
  **measured contrast** against the surface it sits on rather than by a
  light/dark threshold, so a mid-tone background gets the readable of the two
  inks instead of the one a threshold happened to select — and the injected
  dock, settings centre and pet take the accent from the theme's own tokens, so
  a recolour reaches them too and cannot leak into Monet or Native mode.
  The shipped colours are returned **untouched** while they are unchanged: the
  resolver hands back the constant palette rather than re-deriving equal-looking
  values, so an install that customises nothing renders exactly what it rendered
  before this feature existed. (The accent itself did change in v0.2, from
  `#e07930` to `#ee8a3a` — see "Changed" below.)
- **Editable welcome-screen text.** The beta notice drawn over ZCode's empty-chat
  screen is now the user's own copy: two lines plus an on/off switch, in
  **Settings → Appearance**. Turning it off omits the rules entirely rather than
  hiding the band, so ZCode's own greeting comes back with nothing to unwind.
- **A versioned preferences schema** at `%LOCALAPPDATA%\zcode-tarkov\data\prefs.json`,
  with per-field clamping, a closed key set, atomic writes, and quarantine of an
  unparseable file. A v0.1 flat `config.json` is migrated field by field on first
  load and left on disk untouched.
- **A user data root this project owns.** Settings and media moved out of
  ZCode's plugin data directory, which an app update may replace. Relocatable
  with `ZCODE_TARKOV_DATA_DIR`.
- **`--PurgeUserData` on the uninstaller.** Uninstalling removes the program, the
  shortcuts, the service, the autostart entry and the plugin registration and
  **keeps every byte of user media and settings** unless that switch is given.
  `install.ps1` and `repair.ps1` create the data root and only ever create
  missing directories.
- **`dist/client.js`**, the injected client, bundled by esbuild from real
  TypeScript in `src/client/` rather than assembled from template strings, so it
  is type-checked and its pure parts are unit-tested.
- **Tests** for preferences, path safety, range parsing, the media library, the
  host API over real HTTP, the event machine, the status pool, the LRU, the
  leader lease and the synthesized sequences — 167 and counting, including the
  negative cases (traversal, unsatisfiable ranges, oversized uploads, a racing
  leader pair, a malformed lease).

### Changed

- **The Tarkov accent is brighter.** `#e07930` → `#ee8a3a`, with the same hue.
  On the deep surface ink `#1c1207` that is 7.3:1 instead of 6.1:1, so the band
  is brighter *and* its black text is more legible. It is not an "official EFT
  orange" — no such published palette exists — and the value now lives in one
  module (`src/themes/palette.ts`) instead of four independent literals.
- **The top banner has three modes.** `off` removes the band *and* releases the
  space it reserved, `compact` is a 28 px single-line strip, `full` is the v0.1
  band. Off pins the compensation variable to `0px` rather than leaving it
  unset, because an unset property makes every `calc()` that reads it invalid
  instead of zero.
- **Service identity is `zcode-tarkov`.** `/api/health` reports the new name and
  both the new and legacy names are accepted when detecting an already-running
  service, so a v0.1 CLI and a v0.2 service can still find each other.
- Appearance settings now live in `prefs.json`; `/api/config` continues to serve
  the same shape, and the legacy `monet` boolean is still kept in step on read.

### Fixed

- The v0.1 panel and the v0.2 surfaces are torn down and rebuilt on every
  injection, so a stale panel, dock or pet can no longer accumulate across
  renderer reloads.
- **`uninstall.ps1 -PurgeUserData` removes only this project's own files.** It
  deletes `music\`, `sounds\`, `voice\`, `pet\`, `status\` and `prefs.json`, and
  removes the root itself only when nothing else is left in it. The media root is
  relocatable through `ZCODE_TARKOV_DATA_DIR`, and the documented reason to
  relocate it is to keep media on a drive that already holds a library — so a
  recursive delete of the root could have taken files this project never created.
  Anything it did not create is now reported by name and left alone.
- **Background music stops instead of skipping forever** when tracks cannot be
  decoded. The consecutive-failure counter was reset on the way to the next
  track, which made its cap unreachable and turned a folder of undecodable files
  into an endless load-error-skip loop that still reported itself as playing.
- **Media responses send `Access-Control-Allow-Origin`.** The renderer is a
  `file://` document and the audio element requests its track in CORS mode, so a
  response without that header is rejected — which would have meant no music at
  all on a build that enforces it.
- The settings centre's tab strip responds to clicks. It shipped with a keyboard
  handler and no click handler, so the tabs were inert under the mouse.
- A legacy caller sending `banner.enabled: false` to the v0.1 `/api/config` route
  disables the band again, and `off` from either field now wins over a co-present
  mode, in both the payload builder and the settings store.
- The pet's **default** corner clears ZCode's bottom-left account row instead of
  sitting on top of it. A position the user drags it to is unaffected.

## v0.1.0

Frozen and verified 2026-09-16.

First release. Adds a Tarkov UI preset to the zcode-beautify infrastructure
without reimplementing any of it.

### Added

- **`colorMode: "monet" | "tarkov" | "native"`** replacing the single
  `monet` boolean, which could not express a third state.
- **Fixed Tarkov palette** (`src/themes/tarkov.ts`) mapped onto ZCode's semantic
  `--color-*` tokens: accent orange `#e07930`, deep-brown surfaces, warm
  `#e8d9c8` text, `#ffd7ae` / `#ffb27a` highlights, `#8b877c` muted text. The
  palette is independent of the wallpaper, so swapping wallpaper cannot change
  UI colors.
- **Limited Tarkov component skin** built on stable shadcn `data-slot`
  attributes and Radix state attributes: squared-off containers, thin warm
  borders, warm hover washes, orange active indicators, clearer input focus.
- **Beta warning banner** for Tarkov mode: translucent orange band, dark
  hexagonal `!` badge, two configurable text lines, `MutationObserver`
  re-attachment, guarded DOM writes, fail-soft on a missing anchor, clean
  removal when leaving Tarkov mode.
- **Settings-panel `UI Theme` selector** (Monet / Tarkov / Native) and a Tarkov
  skin for the panel itself. Switching mode applies immediately and persists.
- **`theme` CLI command** and `--theme` flags; `--no-monet` remains as an alias
  for `--theme native`.
- **`color_mode`** in the MCP tools, with `monet` kept as a legacy alias.
- **60 automated tests** covering migration, per-mode payloads, palette output,
  wallpaper visibility, banner generation/teardown, and mode-switch residue.
- **A user-level lifecycle** — `install.ps1`, `repair.ps1` and `uninstall.ps1`.
  `install.ps1` copies the payload into `%LOCALAPPDATA%\Programs\zcode-tarkov`,
  writes `settings.json`, creates the "ZCode Tarkov" shortcut on the user
  Desktop and Start Menu, registers the per-user sign-in entry and starts the
  resident service; `repair.ps1` re-detects ZCode after it moved, re-resolves
  node, verifies — or with `-SourceDir` restores — the payload, rewrites the
  shortcut and reports the three interfaces a ZCode update can break;
  `uninstall.ps1` reverses all of it. No elevation, no machine-wide writes,
  ZCode's installation files and official shortcuts untouched.
- **A project-owned launcher** (`launcher/`): resolves ZCode dynamically
  (ZCode's own environment variable, `App Paths`, known paths, bounded scan),
  starts it with `--remote-debugging-port`, keeps the resident service healthy
  and appends one line to `launcher.log`. The shortcut reaches it through a VBS
  trampoline (`zcode-tarkov-launch.vbs`) so a double-click never flashes a
  console window. When ZCode already runs without the debug port, the launcher
  asks before restarting the app and changes nothing if the user declines.

### Changed

- Injected token overrides now also target ZCode's real `.theme-zai-light` /
  `.theme-zai-dark` scopes (verified against ZCode 3.11.2), instead of relying
  on cascade order alone.
- `apply` no longer forces Monet: it keeps the stored color mode unless
  `--theme` is given.
- Config resolution prefers a `zcode-tarkov` data directory and falls back to an
  existing `zcode-beautify` one, so an old config is migrated rather than
  ignored.
- The appearance commands (`theme`, `apply`, `colors`, `reset`) now wait for
  the first renderer target only in the cold-start case ("endpoint reachable,
  zero targets"), bounded to 5 s, instead of failing with "No ZCode renderer
  target found" when one runs immediately after ZCode starts. An unreachable
  endpoint still fails on the first attempt, so `status`, `watch` and `serve`
  keep their latency.
- The autostart entry the CLI registers now carries the configured data
  directory (`ZCODE_BEAUTIFY_DATA_DIR`) when one is set, so the service started
  at sign-in serves the same config file the launcher and the panel expect.

### Security

- No game assets are bundled. Altyn imagery, Scav voice clips and sound effects
  present in the visual reference upstream were deliberately excluded.

### Fixed

- The resident service flashed a console window every ~15s on Windows. While it
  cannot reach the CDP port — i.e. whenever ZCode is running without the debug
  flag, which is the normal state until the app is relaunched through a repaired
  entry — `poll()` asks `tasklist` whether ZCode is alive. The spawn omitted
  `windowsHide`, and because `serve --detach` starts the service with no console
  of its own, Windows allocated a fresh, visible console for each probe:
  measured A/B in that same topology, 1 visible window without the flag and 0
  with it. `tasklist`, `taskkill` and the launcher-repair `powershell` spawn now
  pass `windowsHide: true`.
- The settings panel's offline text no longer tells the user to run a terminal
  command: it names the "ZCode Tarkov" shortcut and says that relaunching ZCode
  that way restores the service, which is what actually fixes it.
- `recovery` now honours `--api-port`: a non-default API port is written into
  the autostart entry instead of the historical default, so the sign-in service
  and the launcher agree on one port.
- **The Tarkov banner no longer clips the app.** It reserved its 56 px band
  with `body { padding-top }` while `#root` kept `height: 100dvh`, so the app
  shell hung 56.14 px below the window — measured on a real window resize, 49
  painted elements outside the viewport, the sidebar bottom, the composer and
  the bottom-left account area (`连接使用…`) among them, with no scroll
  container able to reach them (`html.scrollHeight == clientHeight`). The band
  is now exposed as `--zcode-tarkov-banner-height` on
  `html[data-zct-banner="1"]`, `#root` carries `margin-top: var(...)` plus
  `height: calc(100dvh - var(...))` (the `.h-dvh` app shells the same height),
  and `#root`'s bottom edge equals `innerHeight` with 0 painted elements outside
  at 1366×768, 1440×900 and 960×720 in Tarkov, Native and Monet. The A/B
  control (`docs/images/layout/control-simulated-prefix-960x720.json`)
  reproduces the old 56.14 px footer overflow.
- **The settings panel's status line is visible again.** `#zb-status` was the
  only in-flow child of the `position: fixed; inset: auto` panel root, so the
  root shrink-wrapped to 24×14 px and took its static position at the end of
  `document.body`: every `status(msg)` message was painted 14 px below the
  viewport (measured `bottom` 835.14 at `innerHeight` 821, and 782 at 768) in
  Tarkov and Native alike, and had never been on screen. It is now a
  viewport-pinned toast next to the FAB (`position: fixed; right: 62px;
  bottom: 24px`) on the panel's own surface (`--zb-bg`, `--zb-border`,
  `--zb-radius-sm`, `--zb-text`) and hidden while empty (`:empty`), so the root
  contributes no in-flow box at all.
- **The panel now survives a renderer reload.** The panel script is registered
  for document-start, where `documentElement`, `head` and `body` are all still
  null; the old unconditional `document.body.appendChild(root)` threw
  (`TypeError: Cannot read properties of null`) and the panel was missing from
  every document created after the service attached. The build now runs from
  `install()` — immediately when a body exists, otherwise on
  `DOMContentLoaded`.

### Hardening

From the internal audit of the lifecycle scripts:

- **A CDP endpoint must identify itself.** An open TCP port no longer counts:
  the already-running path, the "did the port come up" wait and the
  single-instance race check require `GET /json/version` to parse, carry
  `webSocketDebuggerUrl` and report a `Chrome|Electron|ZCode` browser. A
  foreign listener on 9222 can no longer fake success or silently swallow a
  launch.
- **An existing install directory is only adopted when its content is ours.**
  `settings.json` must carry `"product": "zcode-tarkov"` (or the directory must
  be empty); otherwise the installer refuses without `-Force`, naming the file
  and what it found. A foreign file never supplies the re-install continuity
  values (`installedAt`, `dataDir`, cached `zcodeExe`).
- **Debug-flag removal is port-scoped.** Uninstall strips a
  `--remote-debugging-port` token from an official shortcut or handler value
  only for the configured cdp port or the historical 9222; a token naming any
  other port stays.
- **Process handling is identity-verified.** A pid is stopped only when it is
  `node.exe`, runs this install's `cliPath` and carries the `serve`/`watch`
  token; a port number alone never identifies a process. When the process list
  cannot be read at all, the step reports "could not inspect", never "none
  found".
- **Reparse points are never traversed.** Recursive payload sweeps and the
  uninstall delete skip junctions/symlinks and report them, so a link target is
  never read or deleted through the link.

### Tests

- The frozen tree's `npm test` suite: 109 tests, all passing at the v0.1.0
  freeze.
- `tools/test-lifecycle.ps1` (`npm run test:lifecycle`): bounded, temp-only
  regression suite for `install.ps1` / `repair.ps1` / `uninstall.ps1` — a clean
  install, install idempotency, refusal of a foreign `settings.json` (and
  `-Force` adoption), `-ShortcutDir` merging, uninstall `-DryRun`, a real
  uninstall that keeps the data directory, a second uninstall reporting
  `[absent]`, and the real profile unchanged.
- `tools/verify-clean-install.ps1` (with the CDP driver
  `tools/verify-clean-install.mjs`): isolated end-to-end harness — clean
  install, isolated launch, the live theme in the renderer, screenshots,
  uninstall (dry run, real, idempotency). Evidence from its last run:
  `docs/images/clean-install-evidence.json`.

### Documentation

- `README.md` and `README.zh-CN.md` rewritten as end-user documentation:
  install, day-to-day use, updates, uninstall, troubleshooting, limits and
  attribution. The CLI-first quick start (open a debug port, run
  `node dist/cli.js launch`) is no longer the entry path.
- New developer index `docs/dev/README.md`; `docs/zcode-dom-notes.md` and
  `docs/OWNER_PLAYTEST.md` moved to `docs/dev/` as developer/verification
  material.
- `docs/dev/install-layout.md`: the layout and behavior contract behind the
  lifecycle scripts.

### Verified

Checked live against ZCode 3.11.2 (Windows), driving the real `dist/cli.js`
bundle against an isolated instance started with its own runtime-data directory,
so the user's running ZCode was never restarted or modified. 67 live assertions
plus 71 unit tests, all passing. Coverage and the one pre-existing upstream
limitation found (a bare renderer reload drops the theme) are recorded in
`docs/dev/zcode-dom-notes.md`.

The productionization path was verified end to end on an isolated scratch tree:
clean install -> isolated launch -> theme visible in the live renderer (30/30
assertions) -> uninstall -> idempotency, with the real profile provably
unchanged. Evidence: `docs/images/clean-install-evidence.json`.

## v0.3.1

Fixes the autostart entry behind recovery mode `always` on Windows. The script
it wrote was not valid VBScript, so Windows Script Host never ran it: the entry
was present and enabled, yet the resident service never started and the theme
was gone after every reboot.

### Fixed

- `autostart install` (and selecting `always`) assembled the command line out of
  separately quoted fragments, leaving everything after the first path outside a
  string literal — a parse error, not a concatenation. The whole command is now
  one VBScript string literal, with the paths quoted for Windows inside it.
  Re-run `zcode-beautify autostart install` (or re-select `always` in the
  settings panel) to rewrite an existing entry; it only matters from the next
  sign-in, since a running service keeps working either way.

## v0.3.0

The theme now restores itself. This release fixes the "the plugin stopped
working" report that followed every ZCode restart, and closes a security gap in
the local control API.

### Added

- **Recovery modes** (`recovery_status`, `set_recovery_mode`). The injected
  theme dies with the renderer on every restart, so something has to put it
  back. Three modes, chosen by the user:
  - `on-start` (default) — the MCP host ZCode spawns at startup restores it
    once. No resident process, no settings panel.
  - `always` — registers an autostart entry for the resident `serve` daemon, so
    both the theme and the settings panel survive a reboot. Costs a background
    node process (~60 MB, ~0.3% of one core).
  - `off` — nothing automatic.
  The settings panel carries a picker with the same three options and a
  plain-language note about what each costs.
- **`repair-launchers`** — scans desktop and Start Menu shortcuts, the
  `zcode://` protocol handler and the Explorer context-menu verbs, and appends
  the missing `--remote-debugging-port`. ZCode cannot open the port on its own:
  the flag has to come from whatever launches it, and a machine typically has
  several launch entries with only some of them carrying it.
- The settings panel now reports when ZCode is running with its debug port
  closed — the one case no background process can fix — and offers a button
  that restarts the app properly.

### Fixed

- The CLI and the plugin host wrote **two different `config.json` files**: the
  CLI fell back to `plugins/data/zcode-beautify/` while the host points
  `ZCODE_BEAUTIFY_DATA_DIR` at the `…@zcode-beautify` form it derives from
  `${ZCODE_PLUGIN_DATA}`. Settings changed through one path were invisible to
  the other. They now resolve to the same directory.
- The control API answered any request that could reach localhost, including
  from any web page open in a local browser, and could replace the wallpaper or
  reset the appearance. It now requires a token that only the injected panel
  carries; `/api/health` stays open since it exposes nothing but the service
  identity.
- `holdSession` leaked its WebSocket when a step after the connect failed, and
  held sessions were never dropped while CDP was unreachable. Both accumulated
  connections over long runs.
- The MCP server reported a hard-coded version that had drifted from the
  manifest. It is now injected at bundle time from `package.json`.

## v0.2.1

- The settings panel is honest when `serve` is not running: an explicit offline
  banner, zeroed and non-interactive controls, and a retry button, instead of
  rendering plausible-looking defaults it never read.
- `serve --detach` backgrounds the service so the panel outlives the shell that
  started it; a second `serve` refuses to start and names the pid that already
  owns the port.
- `/api/health` identifies the service and its pid.

## v0.2.0

- Settings panel with live tuning (blur, dim, Monet colors, wallpaper
  visibility, framing), wallpaper import, and reset/restore.
- `/beautify` slash command and MCP tools.
- Platform-agnostic skill pack for beautifying any Electron app over CDP.
