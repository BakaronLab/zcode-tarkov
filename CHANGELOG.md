# Changelog

`zcode-tarkov` starts at v0.1.0. Entries from v0.3.1 downward are the retained
history of the upstream project this repository was forked from,
[zcode-beautify](https://github.com/Logocceai/zcode-beautify) (MIT).

## v0.1.0

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

### Changed

- Injected token overrides now also target ZCode's real `.theme-zai-light` /
  `.theme-zai-dark` scopes (verified against ZCode 3.11.2), instead of relying
  on cascade order alone.
- `apply` no longer forces Monet: it keeps the stored color mode unless
  `--theme` is given.
- Config resolution prefers a `zcode-tarkov` data directory and falls back to an
  existing `zcode-beautify` one, so an old config is migrated rather than
  ignored.

### Security

- No game assets are bundled. Altyn imagery, Scav voice clips and sound effects
  present in the visual reference upstream were deliberately excluded.

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
