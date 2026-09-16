# zcode-tarkov

An **Escape from Tarkov-inspired theme mode for the [ZCode](https://zcode.ai) desktop client**, with three switchable UI color modes and a live in-app settings panel. Applied by CDP injection — it never modifies ZCode's installation files.

> **Unofficial.** `zcode-tarkov` is a community project. It is **not affiliated with, endorsed by, or sponsored by Battlestate Games**, the developers or publishers of *Escape from Tarkov*. No game art, audio, logos, textures or screenshots are bundled — see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## The three color modes

The reason this fork exists: the original `monet: true/false` toggle could not express a third state. It is now an explicit `colorMode`.

| Mode | UI palette comes from | Wallpaper still works? |
|---|---|---|
| **Monet** | The wallpaper — MD3 dynamic color extraction (upstream behavior, unchanged) | Yes |
| **Tarkov** | A **fixed** Tarkov-inspired palette; the wallpaper never influences UI colors | Yes — swap, hide, blur, dim, cover/contain/smart all still work |
| **Native** | ZCode's own colors, untouched | Yes, via translucency overrides so the wallpaper stays visible |

In **Tarkov** mode the UI takes a fixed palette — accent orange `#e07930` on deep-brown surfaces, warm `#e8d9c8` text, thin warm-orange borders, near-square corners, orange active indicators — plus a two-line "beta interface" warning band pinned to the top of the window.

Functional colors (`success`, `warning`, `danger`, `destructive`, `git-*`, `diff-*`) and code-block syntax colors are **never** re-tinted: states stay readable and code stays legible.

## Where this comes from

- **Infrastructure: [zcode-beautify](https://github.com/Logocceai/zcode-beautify)** (MIT, © 2026 Logocceai). This project is a derivative of it. The CDP injection layer, MD3/Monet color extraction, the wallpaper layer, launcher/recovery/autostart machinery, the settings panel and the MCP surface are its work, reused rather than reimplemented. Git history is retained and the original remote is kept as `upstream-beautify`.
- **Visual language: [dsh-theme-tarkov](https://github.com/ZHIGENGNIAO258/dsh-theme-tarkov)** (MIT, © 2026 dsh-theme-tarkov contributors). Used as a **read-only reference** for the Tarkov palette and the beta-banner design ideas only. It targets a different application (DeepSeek Harness / Cordis): **no DSH code, selectors or assets were copied.**

The upstream platform-agnostic `skill-pack/` is retained as-is under its original MIT attribution; it is not part of the Tarkov theme itself.

Full attribution and the explicit asset-exclusion list: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Requirements

- **Windows** is the primary target (the launcher-repair path is Windows-only; the rest is cross-platform).
- **Node.js ≥ 20** to run the CLI/MCP server. **End users do not need to build** — `dist/cli.js` and `dist/mcp/server.js` are committed.
- **ZCode Desktop 3.11.x**, started once with `--remote-debugging-port` so theming can be injected.

## Quick start (Windows, from a clone)

```powershell
# 0) Quit ZCode completely, including the tray icon.

# 1) Start ZCode with the CDP debug port.
node dist/cli.js launch

# 2) Import a wallpaper. This keeps whatever color mode is stored.
node dist/cli.js apply "C:\path\to\wallpaper.jpg"

# 3) Switch to the Tarkov palette.
node dist/cli.js theme tarkov

# 4) Make the debug port survive normal launches, so starting ZCode the usual
#    way still opens CDP. Preview first: this writes per-user shortcuts and
#    HKCU handlers only, and never elevates.
node dist/cli.js repair-launchers --dry-run
node dist/cli.js repair-launchers

# 5) Start the resident service: settings panel + automatic restore.
node dist/cli.js serve --detach
```

With `serve` running, a 🎨 button appears in the bottom-right of ZCode. The panel itself takes on the Tarkov skin while Tarkov mode is active, and returns to its neutral look for Monet and Native.

## CLI reference

| Command | Purpose |
|---|---|
| `launch [--port N]` | Start ZCode with `--remote-debugging-port` (quit ZCode first) |
| `apply <image> [--blur] [--dim] [--fit] [--theme] [--no-monet]` | Set the wallpaper; **keeps the current color mode** unless `--theme` is given |
| `theme <monet\|tarkov\|native>` | Switch the UI palette without touching the wallpaper |
| `colors [--theme <mode>]` | Re-apply the stored theme, optionally changing mode |
| `serve [--detach] [--api-port M]` | Watch mode + settings panel + local control API (default API port 9223) |
| `watch` | Headless watch mode: re-inject whenever ZCode restarts |
| `recovery [off\|on-start\|always]` | How the theme comes back after a restart (default `on-start`) |
| `autostart [install\|uninstall]` | Register the resident service at sign-in (used by `always`) |
| `repair-launchers [--dry-run]` | Add `--remote-debugging-port` to launch entries missing it |
| `reset` | Remove wallpaper and color overrides |
| `status` | Show CDP reachability and renderer targets |

`--fit` accepts `cover` (fill and crop), `contain` (letterbox over a blurred backdrop), or `smart` (local saliency analysis picks framing and focus).

## MCP tools

The bundled MCP server (`dist/mcp/server.js`) exposes:

| Tool | Purpose |
|---|---|
| `set_background` | Set the wallpaper, optionally choosing `color_mode` |
| `apply_options` | Tune blur / dim / `color_mode` / wallpaper visibility / framing |
| `refresh_theme` | Re-inject the stored theme after a restart |
| `reset_appearance` | Remove wallpaper and overrides |
| `beautify_status` | Show the stored config |
| `recovery_status` | Report recovery mode, autostart entry, CDP reachability |
| `set_recovery_mode` | Switch between `off` / `on-start` / `always` |
| `repair_launchers` | Add the debug-port flag to launch entries missing it |

The legacy `monet` boolean is still accepted by `apply_options` as an alias for `color_mode` (`true` = `monet`, `false` = `native`).

## Configuration and migration

Config lives in `%USERPROFILE%\.zcode\cli\plugins\data\zcode-tarkov\config.json` — or the plugin-scoped `zcode-tarkov@zcode-tarkov` directory, or `ZCODE_BEAUTIFY_DATA_DIR` if that variable is set.

`colorMode` supersedes the old `monet` boolean:

| Stored config | Resolved mode |
|---|---|
| `{ "monet": true }` (a pre-0.1 config) | `monet` |
| `{ "monet": false }` | `native` |
| `{ "colorMode": "tarkov" }` | `tarkov` |
| missing, malformed or unknown | `monet` (the upstream default) |

Both fields are always written back, kept consistent, so an older build reading the same file still behaves sensibly. Reading a legacy config never throws. If an existing `zcode-beautify` data directory is present it is used as a fallback location, so an old config is picked up and upgraded on the next save rather than silently ignored.

## The beta warning banner

Shown **only** in Tarkov mode: a translucent orange band with a dark hexagonal `!` badge and two lines of text. Both lines are configurable (`banner.text1` / `banner.text2` / `banner.opacity` / `banner.height` via the config file or `POST /api/config`), so the wording is not hardcoded.

It is fail-soft by construction. It anchors on `#root` (guaranteed by ZCode's shipped HTML) and is inserted as a **sibling of the React root**, so React can never reconcile over it. If the anchor is missing, nothing is inserted and nothing throws. Text writes are conditional and the observer is debounced, so the banner cannot wedge page boot. Switching away from Tarkov mode removes it cleanly.

The selector investigation — including why no live CDP inspection was possible on the reference machine — is recorded in [docs/zcode-dom-notes.md](docs/zcode-dom-notes.md).

## Project structure

```
├─ src/
│  ├─ core/          CDP, injection, tokens, Monet, config, server, banner, launcher
│  │  ├─ colorMode.ts    the monet|tarkov|native model + legacy migration
│  │  ├─ tokenScopes.ts  verified ZCode token scopes
│  │  └─ banner.ts       the Tarkov beta warning banner
│  ├─ themes/        tarkov.ts — fixed palette + component skin
│  ├─ panel/         panelScript.ts — the injected settings panel
│  └─ mcp/           MCP server
├─ tests/            node:test suites for the new pure logic
├─ dist/             committed bundles (cli.js, mcp/server.js) — no build needed to use
├─ docs/             zcode-dom-notes.md — selector investigation record
├─ commands/ skills/ ZCode slash-command + skill definitions
└─ THIRD_PARTY_NOTICES.md  licenses/
```

## Development

```powershell
npm install
npm run build      # tsc -> dist (typecheck)
npm test           # compiles to .test-build/ and runs node --test
npm run bundle     # build + esbuild -> the two committed dist bundles
```

`npm test` covers the new pure logic: config migration, per-mode payload assembly, wallpaper-visible/opacity behavior, the Tarkov palette mapping, banner script generation and teardown, and mode-switch residue.

After changing anything under `src/`, run `npm run bundle` and commit the updated `dist/`. Users run the bundles directly and should never need to build.

## Limitations

- **Live in-app verification of the Tarkov skin has not been performed** on the reference machine. The running ZCode had no CDP port, a second isolated instance is refused by ZCode's single-instance lock, and relaunching would have terminated the session doing the work. Selectors were derived from the shipped renderer of the exact installed version — see [docs/zcode-dom-notes.md](docs/zcode-dom-notes.md) for the evidence trail and the commands to re-verify over CDP.
- The banner reserves its height with `body { padding-top }` while mounted. This relies on ZCode's `html,body,#root{height:100%}` plus border-box roots, which holds in 3.11.2.
- Tarkov mode is a dark palette by design; it does not follow ZCode's own light/dark switch.
- Injection is an **unofficial** mechanism. A future ZCode update may break it; `reset` always restores the default appearance.

## License

MIT — see [LICENSE](LICENSE). Derived from zcode-beautify; Tarkov styling partly adapted from dsh-theme-tarkov. Both upstream notices are preserved in [LICENSE](LICENSE) and [licenses/](licenses/).
