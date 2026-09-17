# Roadmap

## v0.2 (current) — a Tarkov interface layer

Shipped. Changelog entry: [`CHANGELOG.md`](CHANGELOG.md#v020).

Built on v0.1:

- Event sound effects (`start`, `approval`, `done`, `error`, `tool`), synthesized
  at play time, overridable per event from `data\sounds\`.
- An event state machine that turns a noisy renderer into a bounded number of
  sounds, with per-turn latches and entry/exit debouncing.
- Background music from `data\music\`, streamed with byte-range seeking, with a
  dock, shuffle, repeat, and per-track switches.
- A single-leader rule so only one renderer plays, with command forwarding and
  failover.
- A draggable pet with an original SVG default, a persisted position, and a
  right-click menu.
- A random pet voice from `data\voice\`, with a bounded decoded-buffer cache.
- Randomized running-status text from `data\status\`, falling back to bundled
  original phrases.
- A settings centre (Appearance / Audio / Pet / Status / System).
- A versioned preferences schema at `%LOCALAPPDATA%\zcode-tarkov\data\prefs.json`
  with per-field clamping, atomic writes, and v0.1 migration.
- An uninstaller that preserves user media unless `-PurgeUserData` is given.
- Three band modes (`off` / `compact` / `full`) and a brighter centralized accent.

Two things are deliberately **not** at full strength in v0.2, and both are
documented rather than hidden:

- The **status-text takeover ships off**. ZCode 3.12.3 exposes no stable handle on
  the element that carries the running status text, so it is opt-in. The
  investigation and the one measurement that would close the gap are in
  `docs/dev/zcode-runtime-signals.md` §3.6 and §6.
- The **error sound has no verified trigger**. `error` / interrupted was never
  reached during the signal investigation, so its selectors are unconfirmed; the
  sound simply never plays on a build where they do not match.

## Candidates for v0.3

Roughly in order of value per unit of risk.

### 1. Close the two v0.2 gaps (do this first)

- **Find the status-line container.** One mid-run structural dump of the strip
  above the composer is all that is missing; §6 of
  `docs/dev/zcode-runtime-signals.md` records the command that would produce it.
  Once the container is known, replace the structural locator in
  `src/client/status/anchor.ts` with the measured handle and switch
  `status.enabled` to `true` by default.
- **Observe an error turn** — a failed request, an interrupted generation, a
  refused tool call — and confirm or replace `ERROR_SELECTORS` in
  `src/client/signals/detect.ts`.

### 2. A regression guard on the DOM contract

The theme, the banner, the run-state signals and the status line all match
ZCode's DOM. Today a ZCode upgrade that renames a token or drops a `data-slot`
degrades silently. `tools/probe-signals.mjs` and `tools/measure-layout.mjs`
already know how to check; what is missing is turning them into a single
`npm run check:dom` that fails loudly and names what changed.

### 3. More first-party palettes

The palette is one fixed set. Natural extensions, all cheap now that the accent
lives in `src/themes/palette.ts`:

- Variants per map or trader (a cooler "Interchange", a desaturated "Woods"),
  selected through `colorMode` plus a `palette` field.
- A high-contrast / accessibility variant with widened contrast ratios.
- A user-supplied palette in config, validated against the same token contract.

### 4. Settings panel polish

- Segmented control instead of a `<select>` for the three colour modes.
- Per-mode preview thumbnails.
- A drag handle that is not also the title bar, so the window can be moved
  without a text-selection hazard.

### 5. Theme and settings export / import

Export the active palette and preferences as one JSON file, import someone
else's. The cheapest path to community palettes without building a marketplace.

## Explicitly out of scope

Deliberately not implemented, so that a reader does not mistake an omission for
an oversight.

### Bundled game media

Still forbidden, for the same reason as in v0.1. No BGM, Scav voice lines,
official sound effects, screenshots, logos, Altyn artwork or extracted game
assets ship with this project, and none ever will. v0.2 exists precisely to show
that the *capability* does not require the assets: the sound effects are
synthesized, the pet is an original drawing, and the music and voice libraries
ship empty for the user to fill.

### Animated backgrounds

Video or wallpaper-engine integration conflicts with the "one image in the
renderer" design and its memory budget.

### A standalone theme marketplace

Needs hosting, signing, moderation and a versioning contract. Export/import
(above) gets most of the benefit.

### Replacing the CDP injection layer

The existing zcode-beautify infrastructure works. Replacing it would be churn,
and v0.2 added a client on top of it rather than beside it.

### A React rewrite of the settings panel

The panel is deliberately plain DOM so it stays one self-contained injected
program with no runtime dependency inside the renderer. v0.2 kept that property
while moving the client from template strings to real TypeScript — which is the
useful half of the idea.

### A large configuration-system refactor

The v0.2 schema (`src/prefs/`) closed the real gap: it is versioned, validated
per field, atomically written and migratable. Further abstraction would not earn
its complexity.
