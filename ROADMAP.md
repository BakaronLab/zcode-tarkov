# Roadmap

## v0.1 (current) — a usable Tarkov UI preset

Shipped:

- `colorMode: "monet" | "tarkov" | "native"` with backward-compatible config migration.
- Fixed Tarkov palette mapped onto ZCode's semantic tokens (`src/themes/tarkov.ts`).
- Limited Tarkov component skin built on stable `data-slot` / Radix state selectors.
- Beta warning banner in Tarkov mode: orange band, hexagonal badge, fail-soft
  `MutationObserver` re-attachment, clean removal on mode switch.
- Settings-panel theme selector plus a Tarkov panel skin.
- Automated tests for the new pure logic.

Not yet verified live — see the "Limitations" section of the README and
`docs/dev/zcode-dom-notes.md`.

## Candidates for v0.2

Roughly in order of value per unit of risk.

### 1. Live verification and selector hardening (do this first)

The first pass of this is **done** — see the "Live verification results" section
of `docs/dev/zcode-dom-notes.md`. A live CDP session was obtained via ZCode's
`ZCODE_DESKTOP_USER_DATA_DIR` runtime override, and the token scopes, banner
anchor, mode switching, panel and restart recovery were all confirmed live.

What remains:

- Re-check token scopes and `data-slot` after any ZCode upgrade; `.theme-zai-*`,
  the `@layer theme` split and the portal slot names are version-specific facts,
  not guarantees.
- Exercise the styled portal surfaces directly (`dialog-content`,
  `dropdown-menu-content`, `select-content`, `select-item`, `input`, `command`)
  by opening them, since they do not exist in a resting tree.
- Add a regression guard so an upgrade that renames a token or drops `data-slot`
  fails loudly rather than silently half-theming.
- Decide whether to fix the pre-existing "bare renderer reload drops the theme"
  behavior, which is documented in `docs/dev/zcode-dom-notes.md` as upstream.

### 2. More first-party Tarkov palettes

The mode is currently one fixed palette. Natural extensions, all cheap once the
theme module is extracted:

- Variants per map or trader (e.g. a cooler "Interchange" palette, a
  desaturated "Woods" palette) selected through `colorMode` + a `palette` field.
- A high-contrast / accessibility variant with widened contrast ratios.
- Optional user-supplied palette via config, validated against the same token
  contract.

### 3. Banner content and behavior

- Panel controls for the banner text/opacity (the config path already exists;
  only the UI is missing).
- Optional dismiss button with a persisted "don't show again".
- A countdown / build-label line, since the band is already a status region.

### 4. Panel polish

- Segmented control instead of a `<select>` for the three modes.
- Per-mode preview thumbnails in the picker.
- Keyboard navigation and focus-visible styling for the panel.

### 5. Theme export / import

- Export the active palette as JSON, import someone else's.
- This is the cheapest path to community palettes without building a
  marketplace.

## Explicitly out of scope for v0.1

These were deliberately **not** implemented, mostly to keep the release a clean
UI-preset change rather than a media/asset project. They exist as ideas only.

### Audio and voice

- **BGM / a music library.** Would require bundling or sourcing audio with
  clear licensing, plus a playback lifecycle tied to ZCode's own state. It also
  needs an answer to "what happens when the user has Spotify open".
- **Scav voice lines / event sounds.** These are *game assets*. Redistributing
  them is exactly what this project's attribution rules forbid. Any future
  version would have to ship silence-by-default and let users point at their own
  files.
- **Approval / error / completion sound effects** (as `dsh-theme-tarkov` has).
  Same licensing problem as above.

### Assets and animation

- **Altyn desktop pet.** The upstream reference bundles an Altyn image of
  unclear provenance; it was excluded for that reason. A pet also needs a
  window-management and animation story that is a project of its own.
- **Animated backgrounds.** Video/wallpaper-engine integration conflicts with
  the current "one JPEG data URI in the renderer" design and its memory budget.
- **Any game screenshot crops, official logos or textures.**

### Text content

- **Randomized status-line quotes.** Cheap to build, but it is content
  authoring plus localisation, not theming — and the quotes are game-flavoured
  text of the same questionable provenance as the audio.

### Architecture

- **A standalone theme marketplace.** Requires hosting, signing, moderation and
  a versioning contract. Export/import (above) gets most of the benefit.
- **A new plugin framework or a new CDP injection framework.** The existing
  zcode-beautify infrastructure works; replacing it would be churn.
- **A React rewrite of the settings panel.** The panel is deliberately a plain
  DOM script so it stays a single injected string with no build/runtime
  dependency inside the renderer.
- **A large configuration-system refactor.** The current flat config plus
  `sanitize()` validation is adequate; the one real gap (mode modelling) is
  closed.
