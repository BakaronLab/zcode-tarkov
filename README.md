# zcode-tarkov

**A Tarkov-inspired interface layer for ZCode Desktop** — a warm tactical palette,
a beta-warning band, background music with a dock, event sound effects, a draggable
desktop companion, and a randomized running-status line, all driven from a settings
centre inside the app.

[![version](https://img.shields.io/badge/version-0.2.2-informational)](#)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![ZCode](https://img.shields.io/badge/ZCode-3.12.x-informational)](#zcode-updates--compatibility)
[![bundled game assets](https://img.shields.io/badge/bundled%20game%20assets-none-success)](#disclaimer)

![The Tarkov interface layer running in ZCode](docs/images/v02/01-tarkov-main.png)

> **Unofficial.** Not affiliated with ZCode, and not affiliated with Battlestate
> Games. *Escape from Tarkov* is referenced only as a visual influence. **No game
> artwork, audio, or other assets are bundled with this project** — see
> [Disclaimer](#disclaimer).

---

## What is zcode-tarkov

ZCode Desktop is an Electron app, so its UI can be reached from outside without
touching a single file of the installation. This project uses the DevTools
protocol to inject a stylesheet and a small client program into the running
renderer, and a local service to hold the settings, stream your audio, and
remember your choices.

v0.1 was a **theme**: a fixed Tarkov palette, component styling, a wallpaper, and
a beta-warning band. v0.2 is an **interface layer**: the theme plus audio, a
companion, a status voice, and a settings centre that drives all of it.

It never edits ZCode. Every byte it writes lives in your own user directories, and
removing it is one command that leaves your media and settings alone by default.

## Features

- **Tarkov visual theme** — a fixed warm palette mapped onto ZCode's own semantic
  tokens, plus a light component skin (squared-off containers, thin accent
  borders, accent active-row indicators). Independent of the wallpaper, so
  changing your background never changes your UI colours.
- **Three colour modes** — `Tarkov` (the fixed palette), `Monet` (ZCode recoloured
  from your wallpaper), `Native` (ZCode untouched). Switchable live.
- **Wallpaper layer** with blur, dim, and `cover` / `contain` / `smart` framing.
- **Top tactical band** — the beta warning, in three modes: `full`, a 28 px
  `compact` strip, or `off`. Off removes it *and* releases the space it reserved.
- **Event sound effects** — `start`, `approval`, `done`, `error`, `tool`. Bundled
  as *synthesized tones*, replaceable file by file.
- **Background music** — your own files, streamed with byte-range seeking, with a
  small dock, shuffle, repeat, and per-track on/off.
- **A draggable companion** with a random voice on click, an original SVG default,
  and any image you drop in.
- **Randomized running-status text** drawn from an editable phrase pool.
- **A palette you can recolour** — pick a background and an accent; panels,
  surfaces and the text colour are derived from them so the result stays
  coherent, and a light background gets dark text rather than an unreadable one.
- **Editable welcome-screen text** — the beta notice over ZCode's empty chat is
  your copy, with an on/off switch.
- **A settings centre** with Appearance / Audio / Pet / Status / System.

## Screenshots

| | |
|---|---|
| ![Settings — Appearance](docs/images/v02/02-settings-appearance.png) | ![Settings — Audio](docs/images/v02/03-settings-audio.png) |
| **Settings · Appearance** — colour mode, wallpaper, and the band switch | **Settings · Audio** — master, BGM, per-event SFX, voice |
| ![BGM dock](docs/images/v02/04-bgm-dock.png) | ![The pet](docs/images/v02/05-pet.png) |
| **The BGM dock** — one line of title, transport, and volume | **The pet** — draggable, right-click for its menu |
| ![Compact band](docs/images/v02/06-status-banner-compact.png) | ![Band off](docs/images/v02/07-banner-off.png) |
| **Compact band** — the warning without the footprint | **Band off** — the app gets its full height back |
| ![A custom palette](docs/images/v02/08-palette-custom.png) | ![Custom greeting text](docs/images/v02/09-greeting-custom.png) |
| **A custom palette** — the band and the injected UI follow the accent | **Custom welcome text** — the notice in your own words |

*All screenshots are real captures from an isolated ZCode instance, not mockups —
see [Development](#development).*

## Installation

**The short version:** add this repository as a marketplace in ZCode's plugin
marketplace, install **zcode-tarkov**, then run the installer once to get the
launcher and the resident service.

```powershell
git clone https://github.com/BakaronLab/zcode-tarkov
cd zcode-tarkov
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

Then **quit ZCode completely** (including the tray icon) and relaunch it from the
new **"ZCode Tarkov"** shortcut. That restart is required exactly once: ZCode reads
`--remote-debugging-port` only at startup, so an already-running instance cannot
grow the ability to be injected into.

Requirements: Node.js 20+, and ZCode installed in a standard location. The
installer needs no administrator rights.

If you are an AI agent installing this for someone else, read
[`INSTALL-FOR-AI.md`](INSTALL-FOR-AI.md) instead — it has the safety rules and the
non-technical-user path.

## Daily usage

Launch ZCode from the **ZCode Tarkov** shortcut as usual. The resident service
brings the theme back automatically, so nothing after the first launch needs
doing. Inside the app you have two controls in the bottom-right corner:

- the **⚙ button** opens the settings centre;
- the **♫ button** opens the BGM dock.

Both are movable: the settings window can be dragged by its header, and the pet by
itself.

From a terminal:

```powershell
$cli = "$env:LOCALAPPDATA\Programs\zcode-tarkov\dist\cli.js"
node $cli status            # is the debug port reachable?
node $cli theme tarkov      # switch palette without opening the panel
node $cli recovery always   # keep the resident service at sign-in
```

## Where files go

This is the answer to "where do I put my music". Everything below is yours, and
**none of it is touched by an uninstall** unless you ask for it.

| Path | What goes there |
|---|---|
| `%LOCALAPPDATA%\zcode-tarkov\data\music\` | **Background music.** `mp3`, `wav`, `ogg`, `m4a`, `aac`, `flac`, `webm` |
| `…\data\sounds\` | **Override the built-in sound effects.** Name a file after the event to replace it: `start.*`, `approval.*`, `done.*`, `error.*`, `tool.*` — any supported extension, matched by basename |
| `…\data\voice\` | **Clips the pet plays when clicked.** One is chosen at random |
| `…\data\pet\` | **The pet's image.** `pet.png`, `pet.webp`, `pet.gif`, `pet.jpg`, `pet.jpeg` — first match wins, in that order |
| `…\data\status\` | **Your own status phrases.** `texts.zh.txt` and/or `texts.en.txt`, one phrase per line, `#` for comments |
| `…\data\prefs.json` | **Every setting.** Hand-editable; a malformed file is set aside and defaults are restored |

Just drop files in with Explorer or Finder — there is no import step, no index to
rebuild, and no restart needed. The library *is* the folder listing.

On macOS and Linux the root is
`~/Library/Application Support/zcode-tarkov/data` and
`~/.local/share/zcode-tarkov/data` respectively.

## Audio

### Sound effects

Five events, each with its own switch, volume, and optional override file:

| Event | When it fires |
|---|---|
| `start` | A turn begins |
| `approval` | ZCode needs you to approve something |
| `done` | A turn finishes |
| `error` | A turn fails or is interrupted |
| `tool` | A tool call is rendered (the noisy one — its switch is in the panel) |

**Nothing is bundled.** The default effects are synthesized at play time from
oscillators and one short noise burst — deliberately short, muted and
non-musical, because a sound that outlives the event it announces is just noise.
To use your own, drop a file into `data\sounds\` named after the event.

### Autoplay, and why audio starts locked

Chromium forbids starting audio before you have interacted with the page, and an
injected script gets no exemption. Until your first click the dock shows a lock
and the settings centre offers an **Enable audio** button. Your first click
*anywhere* in the window unlocks it for the session, so in practice the first
click on the dock or the pet is enough. There is deliberately no retry loop,
because a retry loop is exactly what the policy exists to defeat.

## BGM

The dock shows one line of title, the transport, a scrub bar, and a volume
slider; everything else lives in **Settings → Audio**, because a dock that grows
into a media manager is a dock that covers your work.

- **Seeking works.** Tracks are streamed with HTTP byte ranges rather than
  decoded up front, so a five-minute file starts after a few hundred kilobytes
  and the scrub bar moves to a byte offset.
- **Shuffle** draws from a shuffled bag, not an independent random pick, so a
  small library does not repeat a track before it has played them all.
- **One renderer plays.** ZCode can have several windows; an election decides
  which one owns playback, and the others keep a fully working dock whose
  commands are forwarded. If the player dies, another takes over on its own.

## Pet

A small companion you can drag anywhere. The default is an **original inline
SVG helmet**, drawn for this project. Drop your own image into `data\pet\` to
replace it — `png`, `webp`, `gif` or `jpg`.

- Drag it with the mouse. A click (under a 5 px threshold) is a *click*, not a
  drag, and plays a random clip from `data\voice\` if you have any.
- It remembers where you put it, clamped to stay on screen.
- **Right-click** for a small menu: mute the voice, hide the pet, reset the
  position, or open its settings.
- An empty voice folder means silence, not an error.

## Status text

While a turn is running, the status line can show a tarkov-flavoured phrase
instead of ZCode's own, re-rolling as the turn progresses. Write your own pool in
`data\status\texts.zh.txt` or `texts.en.txt`:

```
# lines starting with # are comments
正在检查撤离路线……
正在整理战术背包……
```

**This one ships off.** ZCode 3.12.3 exposes no stable attribute on the element
that carries the running-status text — the investigation is recorded in
[`docs/dev/zcode-runtime-signals.md`](docs/dev/zcode-runtime-signals.md) — so the
takeover locates it structurally and cannot be proven safe on every build. Rather
than ship a selector that silently matches nothing, the feature is opt-in from
**Settings → Status**, where it is labelled accordingly. When it cannot find the
line it does nothing at all, and your native status text is never modified in the
DOM — only drawn over.

## Settings

| Tab | What is in it |
|---|---|
| **Appearance** | Colour mode, wallpaper, blur, dim, fit, the top band's mode and opacity, **the palette** (background and accent), and **the welcome-screen text** |
| **Audio** | Master enable/volume, an audio-unlock button, BGM transport and library (add, delete, enable/disable, upload progress), per-event SFX switches with test buttons, and the voice pool |
| **Pet** | Enable, size, opacity, voice-on-click, reset position |
| **Status** | Enable, language, which events re-roll the phrase, reload the pool |
| **System** | Service and CDP status, version, data directory, media directories, repair hint — with PID and uptime behind *Advanced diagnostics* |

## How it works

```
ZCode Tarkov shortcut
  └─ launcher (VBS -> PowerShell)  starts ZCode with --remote-debugging-port
       └─ resident service (node, 127.0.0.1:9223)
            ├─ injects CSS + client into every renderer over CDP
            ├─ serves the control API (settings, library, streaming)
            └─ re-injects whenever ZCode restarts
```

- **Injection, not patching.** `Page.addScriptToEvaluateOnNewDocument` plus an
  immediate `Runtime.evaluate`, so a renderer reload comes back themed.
- **The client is real TypeScript.** `src/client/` is bundled by esbuild into one
  self-contained `dist/client.js` and injected as a string — type-checked, and
  with its pure parts (the event machine, the leader lease, the LRU, the phrase
  pool) unit-tested.
- **Theming is CSS custom properties** mapped onto ZCode's own semantic tokens.
  Functional colours (`success`, `warning`, `danger`, git/diff) are deliberately
  never overridden: they carry meaning, and re-tinting them for looks makes states
  unreadable.
- **Localhost only.** The control API binds `127.0.0.1` and requires a token that
  only the injected client carries. Media reads accept a second, strictly weaker
  token in the query string, because `<audio>` cannot send headers — and no
  mutating route will accept it.

## Architecture

| Area | Modules |
|---|---|
| Injection + CDP | `src/core/cdp.ts`, `src/core/inject.ts`, `src/core/server.ts` |
| Theme | `src/themes/palette.ts` (the one accent token), `tarkov.ts`, `src/core/tokens.ts`, `tokenScopes.ts`, `monet.ts` |
| Band + layout | `src/core/banner.ts` |
| Settings | `src/prefs/` — `types.ts`, `defaults.ts`, `prefs.ts` (validate/migrate), `store.ts` |
| Media | `src/media/` — `paths.ts` (containment, symlinks, extensions), `library.ts`, `stream.ts` (byte ranges) |
| Host API | `src/api/hostRoutes.ts`, `src/api/body.ts` |
| Status phrases | `src/status/pool.ts` |
| Client | `src/client/` — `main.ts`, `boot.ts`, `core/` (api, audio, leader, lru, context), `signals/` (detect, machine), `sfx/`, `bgm/`, `pet/`, `status/`, `ui/` (panel, skin) |
| Lifecycle | `install.ps1`, `repair.ps1`, `uninstall.ps1`, `launcher/` |

## Project structure

```
src/                     TypeScript sources (CLI, service, and injected client)
dist/                    Prebuilt bundles, committed: cli.js, client.js, mcp/server.js
launcher/                VBS trampoline + PowerShell launcher and discovery helpers
tests/                   Node test suites
tools/                   Verification harnesses (CDP, layout, lifecycle, leader)
docs/dev/                Developer/verification material
docs/images/             Screenshots and layout evidence
install.ps1              Installer
repair.ps1               Repair tool
uninstall.ps1            Uninstaller (-PurgeUserData to delete user media)
INSTALL-FOR-AI.md        Install guide written for AI agents
CHANGELOG.md             Release notes
THIRD_PARTY_NOTICES.md   Upstream attribution and the asset boundary
LICENSE                  MIT
README.md, README.zh-CN.md
```

There is no `assets/` directory: this project ships no media. `dist/` is committed
on purpose, so users install it without a build step and without `npm install`.

## ZCode updates / compatibility

Verified against **ZCode 3.12.3.7463** on Windows.

**File-level, a ZCode update cannot overwrite or conflict with zcode-tarkov
because this project never modifies the ZCode installation.** Runtime
integrations are version-sensitive, however: a future ZCode release may change
DOM structure, semantic tokens, runtime signals, or launch entries used by the
injected interface. These integrations fail soft and can be repaired or updated
without patching ZCode itself.

The theme works by matching ZCode's own DOM, so a ZCode update *can* break parts
of it. The design anticipates that rather than pretending otherwise:

- The palette is built on **semantic CSS custom properties** and stable
  `data-slot` / Radix `data-state` attributes, not hashed class names.
- Every DOM-dependent behaviour **fails soft**: a missing anchor means "no
  banner" / "no status text" / "no sound for that event", never an error and
  never a blocked page.
- The run-state signals are documented, with their observed state transitions and
  the items that could *not* be observed, in
  [`docs/dev/zcode-runtime-signals.md`](docs/dev/zcode-runtime-signals.md). That
  file is the place to start when a ZCode update changes something.

After a ZCode update, relaunch from the **ZCode Tarkov** shortcut, and run
`repair.ps1` if the shortcut is gone. If ZCode came up without the debug port,
the plugin repairs the launch entries by itself — see
[If ZCode opens without the debug port](#if-zcode-opens-without-the-debug-port).

## Repair

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\repair.ps1
```

It re-detects ZCode, recreates the launcher shortcuts and any missing media
directory, verifies the installed payload — including the injected client
bundle, which `-SourceDir` also restores — and checks or starts the resident
service. The per-user autostart entry is reported but never written: re-run
`install.ps1` if it is missing. The plugin registration itself belongs to ZCode's
marketplace and is not touched here. It creates what is missing and refreshes
the launcher shortcuts (with `-SourceDir`, the installed program files too), and
it never overwrites your media or settings.

### If ZCode opens without the debug port

The theme needs ZCode to start with `--remote-debugging-port`, and that flag can
only come from whatever launches ZCode — the running app cannot add it to itself.
ZCode's updater rebuilds the Start Menu shortcut without the flag, and the app
re-registers its own `zcode://` protocol handler and context-menu verbs on every
start, restoring those values; shortcut copies are the durable entries. The
repair therefore covers the desktop, the Start Menu and the pinned taskbar,
plus the `zcode://` handler and the context-menu verbs.

**The plugin also performs this repair by itself at startup.** When it finds
ZCode running with the CDP port closed, it runs the same scan and logs what it
changed, so the normal post-update case no longer needs a manual command. Then
quit ZCode completely (including the tray icon) and start it again from a
repaired shortcut: the flag is read only at startup, so the running instance
cannot be fixed in place.

The command is still there when you want to see or do it yourself:

```powershell
node "$env:LOCALAPPDATA\Programs\zcode-tarkov\dist\cli.js" repair-launchers
```

Add `--dry-run` first to see exactly which entries would change and which are
already correct.

What this repair can write, in full: your own ZCode launch shortcuts on the
desktop, in the Start Menu and in the pinned taskbar, and the three per-user
handler values under `HKCU`. Machine-wide entries — the shared desktop and the
shared Start Menu — are reported but never written, because they would need
administrator rights; `HKLM` is never touched, and no file of ZCode's is ever
touched. It also never touches the official shortcuts' identity, only the
arguments they pass. Every change it makes is reversed by running
`uninstall.ps1` — and the startup repair performs the same writes by itself when
it finds ZCode running without the port.

## Uninstall

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall.ps1
```

Removes the program, the shortcuts, the service, the autostart entry, and the
plugin registration — and **keeps your media and settings**, printing what it
preserved and where.

To delete your data too, ask for it explicitly:

```powershell
# Deletes %LOCALAPPDATA%\zcode-tarkov\data, including your music. Confirm first.
powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall.ps1 -PurgeUserData
```

## Development

```bash
npm install
npm run build          # tsc + bundle the injected client -> dist/client.js
npm run bundle         # build, then bundle the CLI and MCP server
npm test               # type-check + the full test suite
npm run test:lifecycle # install/repair/uninstall acceptance (scratch tree)
npm run package        # release zips
```

Verification harnesses, all of which run against an **isolated** ZCode instance
with its own profile and its own data root, never the running user's:

| Tool | What it proves |
|---|---|
| `tools/verify-v02.ps1` | The v0.2 client end to end in a live renderer, plus the screenshots above |
| `tools/verify-clean-install.ps1` | Install → launch → themed → uninstall, on the real scripts |
| `tools/test-lifecycle.ps1` | Install/repair/uninstall, idempotency, and user-data preservation |
| `tools/measure-layout.mjs` | The band's layout invariant across viewports and modes |
| `tools/probe-signals.mjs` | Rediscovers the DOM run-state signals after a ZCode update |
| `tools/verify-leader.mjs` | Multi-renderer BGM leadership (simulated, not two live windows) |

## Credits

Built on two MIT-licensed upstreams. The full license texts and the exact
boundary of what was taken from each are in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

### zcode-beautify

- **Repository:** https://github.com/Logocceai/zcode-beautify
- **Role:** the code base — the CDP injection foundation, the persistent service
  and settings architecture, the wallpaper layer, and Monet dynamic color.
- **License:** MIT.

This repository is a derivative work with its git history retained; the original
remote is kept as `upstream-beautify`. Those files are used essentially
unchanged rather than re-implemented, and the notices list them one by one.

### dsh-theme-tarkov

- **Repository:** https://github.com/ZHIGENGNIAO258/dsh-theme-tarkov
- **Original author:** [@ZHIGENGNIAO258](https://github.com/ZHIGENGNIAO258)
- **Role:** the major visual and product-design reference.
- **License:** MIT, referenced at commit
  `be1123c1c158e58ba0aa1c311c22d793b09f9c0d`.

`zcode-tarkov` was heavily inspired by
[`ZHIGENGNIAO258/dsh-theme-tarkov`](https://github.com/ZHIGENGNIAO258/dsh-theme-tarkov),
created by [`@ZHIGENGNIAO258`](https://github.com/ZHIGENGNIAO258).

Its Tarkov visual language and several product concepts directly informed this
project's:

- Tarkov palette direction
- Beta warning banner
- BGM dock concept
- event SFX concept
- draggable companion / pet interaction
- random voice playback
- randomized status text
- unified theme settings experience

These features were rebuilt for ZCode's runtime rather than copied as
DSH-specific host/runtime integrations — there is no Cordis, DSH host or
`schemastery` code here. **One exception is disclosed rather than glossed:** the
beta notice's own wording and its presentation values are reproduced from the
upstream banner rather than re-invented.
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) names the exact files and
segments. **None of the game-derived media the upstream ships is redistributed
here.**

## Acknowledgements

Thanks first to [`@ZHIGENGNIAO258`](https://github.com/ZHIGENGNIAO258). Their
[`dsh-theme-tarkov`](https://github.com/ZHIGENGNIAO258/dsh-theme-tarkov) worked
out what a Tarkov interface should look like and how it should behave — the warm
palette, the beta band, the dock, the companion — before this project existed.
Most of the product ideas here are theirs; this repository's own contribution is
porting them to a different host.

Thanks equally to the
[`zcode-beautify`](https://github.com/Logocceai/zcode-beautify) authors, whose
CDP injection, wallpaper and Monet layers this project is built directly on top
of.

And thanks to the ZCode maintainers, for shipping a client whose renderer can be
reached this way without patching a single file of the installation.

## License

[MIT](LICENSE).

## Disclaimer

- This project is **unofficial** and is **not affiliated with ZCode**.
- It is **not affiliated with, endorsed by, or sponsored by Battlestate Games**.
  *Escape from Tarkov* is referenced only as a **visual inspiration**.
- **No official game assets are bundled.** No BGM, Scav voice files, official
  sound effects, screenshots, logos, or artwork from any game are included. The
  default sound effects are synthesized, the default pet is an original drawing,
  and the music and voice libraries ship empty.
- **You are responsible for the media you add.** If you supply audio or images,
  make sure you have the right to use them.
- **ZCode updates may break DOM-dependent integration.** The theme fails soft
  rather than damaging the app, but a future ZCode release can still change
  something this project relies on. See
  [ZCode updates / compatibility](#zcode-updates--compatibility).
