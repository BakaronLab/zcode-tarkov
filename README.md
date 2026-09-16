# zcode-tarkov

An unofficial, Tarkov-inspired theme for the **ZCode desktop client**: three switchable color modes plus a wallpaper layer, installed per user and started from its own **ZCode Tarkov** shortcut. It never modifies ZCode's files.

![The ZCode desktop client with the Tarkov theme applied](docs/images/homepage-tarkov.png)

> **Unofficial.** `zcode-tarkov` is a community project. It is **not affiliated with, endorsed by, or sponsored by** Battlestate Games, the developers or publishers of *Escape from Tarkov*, nor by the ZCode vendors. No game art, audio, logos, textures or screenshots are bundled — see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## What it does

The theme is applied to the running ZCode window by injecting CSS over a local debug port (the Chrome DevTools Protocol). ZCode's installation files are never modified, and nothing about the theme is written into them.

Three color modes, switchable at any time from the in-app settings panel:

| Mode | Where the UI colors come from | Wallpaper |
|---|---|---|
| **Monet** | Your wallpaper, via Material Design 3 dynamic color | Still visible |
| **Tarkov** | A fixed Tarkov-inspired palette: `#e07930` accent on deep-brown surfaces, warm `#e8d9c8` text | Still visible; the wallpaper never changes the UI colors |
| **Native** | ZCode's own colors, untouched | Still visible, through translucency |

All three modes keep the wallpaper layer: import your own image, blur it, dim it, hide or show it, and choose how it fills the window.

Tarkov mode also adds the visual language this project exists for: a two-line beta warning band pinned across the top of the window, and — on the empty homepage — a beta notice that replaces the greeting (translucent orange band, dark hexagonal `!` badge) while leaving the page's own graphic in place.

What stays untouched in every mode: ZCode's functional colors (`success`, `warning`, `danger`, `git-*`, `diff-*`) and the code-block syntax colors. State colors stay meaningful and code stays legible.

## Requirements

- **Windows.** The installer, the launcher and the shortcuts are Windows-only.
- **ZCode Desktop installed.** Verified against ZCode 3.11.2.
- **Node.js 20 or newer.** The installer looks for `node.exe` on `PATH`, in `C:\Program Files\nodejs` and in `%LOCALAPPDATA%\Programs\nodejs`, and refuses to install when it cannot find one.

You do not need to build anything: the bundles in `dist/` are committed.

## Install

From a checkout of this repository:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
```

A real install does all of this:

- copies the payload (the CLI bundle, the launcher scripts, `LICENSE`, `THIRD_PARTY_NOTICES.md` and `licenses/`) into `%LOCALAPPDATA%\Programs\zcode-tarkov`;
- locates `ZCode.exe` automatically (settings cache, ZCode's environment variable, the `App Paths` registry entries, known paths, then a bounded scan — the disk is never scanned recursively);
- creates one new shortcut, **"ZCode Tarkov"**, on your Desktop and in your Start Menu;
- registers the per-user sign-in entry that brings the resident theme service back after you sign in, and starts that service now;
- writes `settings.json` into the install directory, which the launcher reads.

Everything is **user-level**. The installer never elevates, never asks for administrator rights and never writes to `C:\Program Files`, `%ProgramData%`, the public desktop or machine-wide registry locations. It never modifies ZCode's installation files and never creates, changes or deletes an official ZCode shortcut. What it writes is the install directory, the shortcut named `ZCode Tarkov.lnk`, and the per-user sign-in entry.

Useful options: `-DryRun` reports what it would do and writes nothing; `-CdpPort` / `-ApiPort` change the two local ports (defaults `9222` / `9223`); `-DataDir` keeps the theme data in a directory you choose; `-InstallDir`, `-ShortcutDir`, `-NoShortcuts`, `-NoService`, `-Force` and `-Json` are also available. Exit code `0` means installed (warnings are allowed); `1` means refused or failed and nothing was installed.

The repository also carries ZCode plugin/marketplace packaging (`marketplace.json`, `.zcode-plugin/plugin.json`). That path has not been verified for this fork, which has not been published to a marketplace; `install.ps1` is the supported, verified way to install it.

## Using it day to day

**Always start ZCode from the "ZCode Tarkov" shortcut** (Desktop or Start Menu). ZCode can only be themed when it is started with the local debug port, and the shortcut is what arranges that.

The shortcut runs a hidden launcher, so no console window flashes. On each start it:

1. resolves ZCode, using the cached path first, so a ZCode update that moves the app is noticed and the cached path refreshed;
2. leaves ZCode alone when it is already running with the debug port;
3. when ZCode is running **without** the theme, asks whether it may restart ZCode (unsaved conversation content would be lost). If you say no — or a non-interactive caller passes `-NoPrompt` — it changes nothing and tells you to quit ZCode fully and start it again from the shortcut;
4. otherwise starts ZCode with the debug port;
5. makes sure the resident theme service is healthy, and writes one line to `launcher.log`.

The only process the launcher may terminate is ZCode itself, and only after an explicit Yes in that dialog. It fails soft: the worst case is ZCode starting without the theme. Exit codes: `0` healthy, `2` degraded (ZCode runs, the theme cannot be applied), `3` ZCode is running without the debug port, `4` the installation or `settings.json` is unusable, `1` unexpected error.

### Switching themes

Once the service is running, a 🎨 button sits in the bottom-right corner of the ZCode window. Click it to open the panel. It controls:

- **UI Theme** — Monet / Tarkov / Native. Switching applies immediately and is remembered.
- **Background blur** and **background dim** sliders.
- **Show wallpaper** on/off, the **background fit** mode (fill and crop / contain / smart), and a button to pick a new wallpaper image.
- **Reset to default appearance** — removes the wallpaper and the color overrides.
- **Automatic restore** — whether ZCode restores the theme by itself at start, runs the resident service, or does nothing.

The panel labels are in Chinese in this build.

If the panel cannot reach the theme service it shows an explicit offline banner with a retry button instead of rendering values it never read. If ZCode is running without the debug port, the panel says a restart is needed and offers a button that restarts ZCode properly.

![The settings panel with the UI Theme selector](docs/images/panel-theme-selector.png)

## Keep it updated

- **Re-run `install.ps1` from the checkout** to refresh an existing install. It is idempotent: it preserves `installedAt`, the recorded data directory and the cached ZCode path, and it removes only the payload files it owns that the current source no longer ships.
- **After a ZCode update, run `repair.ps1`.** It re-detects `ZCode.exe` (a ZCode update can change the install path), re-resolves `node.exe`, verifies the payload, rewrites the "ZCode Tarkov" shortcut in the directories it recorded, and checks the resident service. It also reports the three things a ZCode update can break: the launcher, the DOM selectors and the CSS tokens.
- **`repair.ps1 -SourceDir <tree>`** copies the payload from another checkout — the in-place upgrade path when you have a newer version. `-RestartService` stops and restarts the resident service so a freshly copied bundle reaches the running app; `-NoService`, `-NoShortcuts`, `-ZcodeExe`, `-ShortcutDir`, `-DryRun`, `-Force` and `-Json` are also available.
- `repair.ps1` never rewrites the recorded ports; use `install.ps1 -CdpPort ...` to change them.
- `repair.ps1` exits `0` when everything is healthy or was repaired, `2` when something is still degraded, `1` when it is blocked.

## Uninstall

Run `uninstall.ps1`, either from the installed tree (`%LOCALAPPDATA%\Programs\zcode-tarkov\uninstall.ps1`) or from the checkout:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File uninstall.ps1
```

It stops the resident service of this installation, removes the sign-in entry the CLI registered, deletes the "ZCode Tarkov" shortcuts it wrote, and removes the install directory. It is idempotent: a second run reports `[absent]` for what is already gone and still exits `0`.

**Your data directory is kept by default** — it holds your wallpaper and settings. `uninstall.ps1` prints its path. `-RemoveData` additionally deletes the files the CLI owns there (`config.json`, `config.backup.json`, `recovery.json`, `wallpaper.*`, `serve.log`, `launcher.log`) and the directory itself only when nothing else remains in it.

`uninstall.ps1` never touches ZCode's installation or profile, ZCode's official shortcuts, the marketplace plugin cache (`%USERPROFILE%\.zcode\cli\plugins`), or any shortcut that is not ours. The only official-entry changes it can make are removing the `--remote-debugging-port` token that this project's earlier playtest tooling once injected from an official shortcut or one of ZCode's own HKCU handler values; the entries themselves are never deleted. `-DryRun` reports the whole plan without writing anything. Exit code `0` means the sweep completed, `1` means a step was refused or failed and needs your attention.

## Troubleshooting

| Symptom | What to do |
|---|---|
| The theme is not applied | Start ZCode from the **ZCode Tarkov** shortcut (Desktop or Start Menu), not from ZCode's own icon. |
| ZCode was already running when you used the shortcut | Quit ZCode completely — including the tray icon — then start it again from the shortcut. The debug port is fixed at process start, so an already-running instance cannot be themed. |
| The theme stopped working after a ZCode software update | Run `repair.ps1`; it re-detects ZCode and repairs the launcher. If the theme still does not apply, ZCode's DOM anchors or color tokens have probably changed and a newer zcode-tarkov is needed — `repair.ps1` reports these as `dom-selectors` / `css-tokens` and cannot repair them offline. |
| The launcher reports that the port is in use by another program | Reinstall with a different port: `powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -CdpPort 9333`. |
| You need the logs | `launcher.log` is written in the install directory (`%LOCALAPPDATA%\Programs\zcode-tarkov`), or in the data directory when the installation used `-DataDir`. `serve.log` sits in the data directory — `uninstall.ps1` prints the path it resolved; by default it is below `%USERPROFILE%\.zcode\cli\plugins\data\`. |

## Limits and honesty

- **Unofficial.** Not affiliated with, endorsed by or sponsored by Battlestate Games or the ZCode vendors. "Escape from Tarkov" and related marks belong to their owners.
- **No game assets.** The theme bundles no logos, textures, music, voice lines or other game material: it is CSS, a palette, and a wallpaper layer you fill with your own image.
- **CSS injection over a debug port.** This is not an official extension point, so a ZCode update can break the theme until this project catches up. `repair.ps1` is the first stop, and the panel's reset button always restores the default appearance.
- **Verified against ZCode 3.11.2.** Other ZCode versions are untested; the DOM anchors and color tokens the theme depends on are version-specific facts.
- **Windows only for the lifecycle scripts.** The CLI itself also runs on macOS and Linux, where none of the shortcut logic applies.

## Credits and license

MIT — see [LICENSE](LICENSE). This repository is a local fork of the upstream **zcode-beautify** project (MIT): the CDP injection layer, the Monet color extraction, the wallpaper layer, the settings panel and the MCP surface are its work, reused rather than reimplemented. The Tarkov palette and the beta-banner visual language are adapted from the **dsh-theme-tarkov** project (MIT) as a read-only reference — no DSH code, selectors or assets were copied.

Attribution and the explicit asset-exclusion list: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md); both upstream licenses are reproduced in [`licenses/`](licenses/).

## For contributors and verification

Developer documentation — the install-layout contract, the live DOM notes, the build/test/bundle commands and the verification harnesses — is in [docs/dev/README.md](docs/dev/README.md). What is deliberately not part of v0.1.0 is in [ROADMAP.md](ROADMAP.md). Everything under `docs/dev/`, `tools/` and `evidence/` is developer and verification material, not user documentation.
