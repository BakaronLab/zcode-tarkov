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

---

## 2. dsh-theme-tarkov — the visual language

- **Upstream:** https://github.com/ZHIGENGNIAO258/dsh-theme-tarkov
- **Copyright:** Copyright (c) 2026 dsh-theme-tarkov contributors
- **License:** MIT — reproduced in [`licenses/dsh-theme-tarkov.LICENSE`](licenses/dsh-theme-tarkov.LICENSE)
- **Pinned revision referenced:** `be1123c1c158e58ba0aa1c311c22d793b09f9c0d` (v0.2.0)

This upstream targets a **different application** (DeepSeek Harness / Cordis).
It was consulted as a **read-only visual reference**. It is *not* vendored,
nested, or merged into this repository, and no DSH-specific host, Cordis, or
runtime code was copied.

### What was adapted from dsh-theme-tarkov

- The **color palette**: accent orange `#e07930`, deep brown `#1c1207`,
  panel tones `rgba(26,18,10,…)` / `rgba(30,20,10,…)`, text `#e8d9c8`,
  highlights `#ffd7ae` / `#ffb27a`, muted `#8b877c`.
- The **beta warning banner design ideas**: a translucent orange band, a dark
  hexagonal `!` badge, two lines of text, a `MutationObserver`-driven
  re-attachment, guarded DOM writes, and fail-soft behavior.

### What was deliberately NOT taken

- **Selectors.** DSH anchors its banner on `[class*="_heroWorkspaceRow"]`, which
  is a DSH/Cordis class and does not exist in ZCode. `zcode-tarkov` uses its own
  anchor, derived from the shipped ZCode renderer — see
  [`docs/zcode-dom-notes.md`](docs/zcode-dom-notes.md).
- **Banner text.** The DSH banner text is not reused; `zcode-tarkov` ships its
  own wording.
- **Game-derived assets.** DSH bundles Altyn desktop-pet imagery, Scav voice
  clips and sound effects. To avoid redistributing assets of unclear or
  game-derived provenance, **none of these are included** in `zcode-tarkov`.
  The assets below exist in the DSH upstream and were intentionally excluded:

  `assets/pet/altyn.png`, `assets/pet/voice/*.mp3`, `assets/sfx/*`,
  `assets/status/*`, `docs/screenshots/*`.

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

- `INSTALL-FOR-AI.md` — an agent-targeted install guide for the
  `zcode-beautify` plugin, pointing at the upstream repository. Installation for
  this project is covered in `README.md`.
- `README.zh-CN.md` — rewritten for this project rather than removed.

Both remain available in this repository's git history and upstream.

Note that `dist/cli.js` and `dist/mcp/server.js` are builds **of this
repository's `src/`**, which is itself derived from zcode-beautify; they embed
that upstream's code under the terms above.

