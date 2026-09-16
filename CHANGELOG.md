# Changelog

`zcode-tarkov` starts at v0.1.0. Entries from v0.3.1 downward are the retained
history of the upstream project this repository was forked from,
[zcode-beautify](https://github.com/Logocceai/zcode-beautify) (MIT).

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
