# Third-Party Notices

`zcode-tarkov` is an independent project built on two MIT-licensed upstreams.
Both are reproduced in `licenses/` and summarized here.

This project is **not affiliated with, endorsed by, or sponsored by** Battlestate
Games, the developers or publishers of *Escape from Tarkov*. No artwork, audio,
logos, textures, or other assets from the game are included in this repository.

---

## 1. zcode-beautify — the code base

- **Upstream:** https://github.com/Logocceai/zcode-beautify
- **Copyright:** Copyright (c) 2026 Logocceai
- **License:** MIT — reproduced in [`licenses/zcode-beautify.LICENSE`](licenses/zcode-beautify.LICENSE)
- **Pinned revision used as the base:** `8639446a4534be667a8fa76ea7757c139ee9df71` (v0.3.1)

`zcode-tarkov` is a **derivative work**: this repository began as a clone of
zcode-beautify with its full git history retained (the original remote is kept as
`upstream-beautify`).

### What was taken from zcode-beautify

Used essentially unchanged, and not re-implemented:

- The CDP injection layer — `src/core/cdp.ts` (websocket client, target
  discovery, `Page.addScriptToEvaluateOnNewDocument` bootstrapping).
- The wallpaper layer and its payload framing — `src/core/inject.ts`
  (wallpaper/backdrop elements, blur, dim, `cover`/`contain`/`smart`).
- Material Design 3 dynamic color extraction — `src/core/monet.ts`
  (jimp decode, Celebi quantization, MD3 scoring, saliency-based focus).
- The MD3 → ZCode semantic-token mapping — `src/core/tokens.ts`.
- The persistent injection session + localhost control API — `src/core/server.ts`.
- Config persistence, the ZCode launcher, single-instance handling, recovery
  modes and autostart — `src/core/launch.ts`, `src/core/recovery.ts`,
  `src/core/autostart.ts`.
- Launcher repair — `src/core/launchers.ts`.
- The MCP tool surface — `src/mcp/server.ts`.
- The plugin/marketplace manifests, `commands/`, `skills/`, and the build
  tooling — `scripts/bundle.mjs`, `scripts/package.mjs`.

### What `zcode-tarkov` changed

- Added the `colorMode: "monet" | "tarkov" | "native"` model replacing the
  original `monet: boolean` (with backward-compatible migration).
- Added `src/themes/tarkov.ts` (fixed palette + component skin) and
  `src/core/banner.ts` (beta warning banner).
- Extended `src/panel/panelScript.ts` with a UI Theme selector and a Tarkov
  panel skin.
- Made the injected token scopes cover ZCode's real `.theme-zai-*` selectors
  (`src/core/tokenScopes.ts`).
- **v0.2** added the interface layer — `src/prefs/`, `src/media/`, `src/api/`,
  `src/status/` and `src/client/` — plus `src/themes/palette.ts`, which took the
  accent out of four independent literals and into one token. The build gained
  `scripts/bundle-client.mjs`. Nothing in this list came from either upstream;
  both are original to this project, written against ZCode's own runtime.

---

## 2. dsh-theme-tarkov — the visual language and the feature set

- **Upstream:** https://github.com/ZHIGENGNIAO258/dsh-theme-tarkov
- **Copyright:** Copyright (c) 2026 dsh-theme-tarkov contributors
- **License:** MIT — reproduced in [`licenses/dsh-theme-tarkov.LICENSE`](licenses/dsh-theme-tarkov.LICENSE)
- **Pinned revision referenced:** `be1123c1c158e58ba0aa1c311c22d793b09f9c0d` (v0.2.0,
  "Altyn desktop pet, randomized status line, and settings hint fix")

This upstream targets a **different application** (DeepSeek Harness / Cordis).
It was consulted as a **read-only reference** for both the visual language and,
from v0.2, the product feature set. It is *not* vendored, nested, or merged into
this repository, and no DSH-specific host, Cordis, or runtime code was copied.

### What was adapted from dsh-theme-tarkov

- The **color palette direction**: a warm orange accent, deep brown surfaces
  (`#1c1207`, `rgba(26,18,10,…)`, `rgba(30,20,10,…)`), warm text `#e8d9c8`,
  highlights `#ffd7ae` / `#ffb27a`, muted `#8b877c`. This project's own accent is
  `#ee8a3a` (see `src/themes/palette.ts`); the DSH value is `#e07930`.
- The **beta warning banner design ideas**: a translucent accent band, a dark
  hexagonal `!` badge, two lines of text, a `MutationObserver`-driven
  re-attachment, guarded DOM writes, and fail-soft behavior.
- **The v0.2 feature set**, at the level of *what the product does*: background
  music with a dock, event sound effects with per-event switches and volume, a
  draggable desktop pet with a random voice, a randomized running-status line
  drawn from an editable text pool, a data directory of `music/` `sounds/`
  `voice/` `pet/` with a `prefs.json` beside it, and a settings panel that drives
  all of it. The **abilities** were taken as the specification; each one is
  re-implemented against ZCode's own runtime, and none of the DSH implementation
  is reused. Notable differences in the result:
  - This project detects run state from ZCode's renderer DOM and passes it
    through its own debounced state machine; DSH uses its host's notification
    API, which ZCode does not expose.
  - This project elects a single playing renderer over `BroadcastChannel` and a
    `localStorage` lease, because ZCode can run several renderers; DSH is a web
    UI with one.
  - This project has five sound events (`start`, `approval`, `done`, `error`,
    `tool`) where DSH has three.

### What was deliberately NOT taken

- **Selectors.** DSH anchors its banner on `[class*="_heroWorkspaceRow"]`, which
  is a DSH/Cordis class and does not exist in ZCode. `zcode-tarkov` uses its own
  anchors, derived from the shipped ZCode renderer — see
  [`docs/dev/zcode-dom-notes.md`](docs/dev/zcode-dom-notes.md) and
  [`docs/dev/zcode-runtime-signals.md`](docs/dev/zcode-runtime-signals.md).
- **Banner text.** The DSH banner text is not reused; `zcode-tarkov` ships its
  own wording.
- **Host, locale and settings APIs.** DSH's `schemastery` config schema, its
  `Settings > Plugins` registration, its `dsh` manifest block and its Cordis
  patch file have no equivalent in ZCode and were not translated. This project's
  settings schema (`src/prefs/`) and settings panel (`src/client/ui/panel.ts`)
  are its own.
- **Every bundled media asset.** This is the substantive exclusion, and it is
  worth being precise about because these files are the reason the two products
  do not look identical out of the box. The DSH upstream ships, and this project
  does **not**:

  | DSH path | What it is | Count | Why excluded |
  |---|---|---|---|
  | `assets/pet/voice/scav*.mp3` | Scavenger voice lines | 361 files | Recorded dialogue from the game |
  | `assets/pet/altyn.png` | Altyn helmet artwork | 1 file | Game artwork |
  | `assets/sfx/{done,approval,error}.m4a` | Event sound effects | 3 files | Game sound effects |
  | `assets/status/*`, `docs/screenshots/*` | Status pools and screenshots | — | Consulted, not copied |

  Their absence is by design rather than an unfinished part of this project, and
  each has a replacement that is either original or user-supplied:

  | Capability | This project's default | Replacing it |
  |---|---|---|
  | Event sounds | Synthesized at play time from oscillators and one noise burst (`src/client/sfx/synth.ts`) | Drop `done.*`, `approval.*`, `error.*`, `start.*`, `tool.*` into `data\sounds\` |
  | Pet appearance | An original inline SVG helmet (`src/client/pet/pet.ts`) | Drop `pet.png` / `.webp` / `.gif` / `.jpg` into `data\pet\` |
  | Pet voice | **Empty** — clicking is silent | Drop clips into `data\voice\` |
  | Music | **Empty** — the dock shows an empty state naming the folder | Drop tracks into `data\music\` |
  | Status phrases | Original bundled pools in Chinese and English (`src/status/pool.ts`) | Edit `data\status\texts.zh.txt` / `texts.en.txt` |

  A user who owns a copy of the game may add their own clips; this project
  neither supplies them nor fetches them.

---

## Summary table

| Upstream | License | Relationship | Code copied? | Assets copied? |
|---|---|---|---|---|
| [zcode-beautify](https://github.com/Logocceai/zcode-beautify) | MIT | Code base (derivative work) | Yes, with attribution | No |
| [dsh-theme-tarkov](https://github.com/ZHIGENGNIAO258/dsh-theme-tarkov) | MIT | Visual reference only | No | No |

---

## Upstream files removed from this fork

For clarity, these files from zcode-beautify were deleted rather than carried
forward, because they document the *upstream* product (its name, its repository
URL, and its own installation flow) and would misdirect a reader:

- `INSTALL-FOR-AI.md` — the **upstream** agent-targeted install guide for the
  `zcode-beautify` plugin, pointing at the upstream repository. It was removed in
  v0.1 and a new `INSTALL-FOR-AI.md` describing *this* project was written for
  v0.2. The file at that path is this project's own.
- `README.zh-CN.md` — rewritten for this project rather than removed.

The upstream versions remain available in this repository's git history and
upstream.

Note that `dist/cli.js`, `dist/mcp/server.js` and `dist/client.js` are builds
**of this repository's `src/`**, which is itself derived from zcode-beautify;
they embed that upstream's code under the terms above.

