# ZCode DOM notes

> Developer/verification material, not user documentation. The user guide is `README.md` in the repository root.

Investigation record for the selectors `zcode-tarkov` depends on: the semantic
token scopes, the stable component-selector vocabulary, and the banner anchor.

- **ZCode version:** `3.11.2.6792` (`C:\Program Files\ZCode\ZCode.exe`, ProductVersion 3.11.2.6792)
- **Investigation date:** 2026-09-16
- **Method:** read-only inspection of the shipped renderer inside
  `C:\Program Files\ZCode\resources\app.asar`
  (`out/renderer/index.html`, `out/renderer/assets/styles-t2tKjMWX.css`, and the
  renderer JS bundles), plus `Get-NetTCPConnection` / process inspection to
  establish the live CDP situation.

## How a live CDP session was obtained

The first attempts could not reach a live DOM, and the reasons are worth
recording because they are the same constraints anyone else will hit:

1. **The running ZCode has no CDP port.** 16 `ZCode.exe` processes were live and
   no listening port in the 9200–9300 range belonged to any of them
   (`Get-NetTCPConnection -State Listen`). ZCode only appends
   `--remote-debugging-port=9229` when `!app.isPackaged`, so a packaged install
   never opens one by itself.
2. **`zcode-beautify launch` refuses while it runs**, correctly: ZCode holds a
   single-instance lock, so a newly spawned process forwards its args and exits,
   closing the port again.
3. **`--user-data-dir` does not create a second instance.** Launching with
   `--user-data-dir=… --remote-debugging-port=9222` produced only a stub
   `rum-electron-store` directory and exited. The reason is in the shipped main
   bundle: ZCode calls
   `app.setPath("userData", Kd); app.setPath("sessionData", Qx)`, overriding
   Chromium's `--user-data-dir`. The lock therefore has the same scope.
4. **Killing the running ZCode was not acceptable**: this work was itself
   performed inside that instance (the shell's ancestry is
   `ZCode.exe → ZCode.exe → ZCode.exe (zcode.cjs app-server) → bash`), so a
   relaunch would have terminated the session and discarded the user's unsaved
   state.

### The way through: ZCode's own runtime-data env overrides

The same bundle that overrides the paths also exposes environment overrides for
them:

```js
const Yx = isTruthyRuntimeEnvOverride("ZCODE_DESKTOP_USE_ELECTRON_DEFAULT_USER_DATA");
const Kd = readRuntimeEnvOverride("ZCODE_DESKTOP_USER_DATA_DIR") ?? (Yx ? undefined : path(appData, appName));
const Qx = readRuntimeEnvOverride("ZCODE_DESKTOP_SESSION_DATA_DIR") ?? (Kd ? path(Kd, "session") : undefined);
if (!Yx) { app.setPath("userData", Kd); app.setPath("sessionData", Qx); }
```

Setting `ZCODE_DESKTOP_USER_DATA_DIR` (and the session dir) to a scratch path
gives that process its **own** userData, hence its own single-instance lock, so a
second instance can run alongside the user's without touching it:

```powershell
$env:ZCODE_DESKTOP_USER_DATA_DIR    = 'F:\scratch\userdata'
$env:ZCODE_DESKTOP_SESSION_DATA_DIR = 'F:\scratch\session'
& 'C:\Program Files\ZCode\ZCode.exe' --remote-debugging-port=9222
```

That instance served as the test subject for all live verification below. It was
closed afterwards with `Browser.close` on its own CDP browser endpoint (never by
image-name kill), and its scratch directories were removed.

### Consequence

Everything in sections 1–4 below was **confirmed against a live renderer**, not
only read out of the shipped bundle. Section 5 records the live results.

---

## 1. Semantic token scopes (highest-confidence finding)

ZCode's renderer toggles theme classes on `document.documentElement`. From the
renderer bundle:

```js
document.documentElement.classList.toggle('dark',            t === 'dark')
document.documentElement.classList.toggle('theme-zai-light', n === 'zai-light')
document.documentElement.classList.toggle('theme-zai-dark',  n === 'zai-dark')
```

In `out/renderer/assets/styles-t2tKjMWX.css` there are three token scopes:

| Scope | Selector | Cascade layer |
|---|---|---|
| default | `:root,:host` | inside `@layer theme` |
| dark mode | `.dark` | **unlayered** |
| named theme | `.theme-zai-light` / `.theme-zai-dark` | **unlayered** |

Two consequences drove the implementation:

1. ZCode's *base* tokens live in `@layer theme`. Injected CSS is unlayered, and
   unlayered declarations beat layered ones regardless of order or specificity.
   That is why the upstream injection approach is reliable.
2. `.dark` and `.theme-zai-*` are **unlayered**, so injected rules win over them
   only by document order (both are `(0,1,0)` specificity). `zcode-tarkov`
   matches the real `.theme-zai-*` selectors explicitly rather than relying on
   ordering alone — see `src/core/tokenScopes.ts`.

Both the light and dark blocks match `<html>`, so the dark block is always
emitted last; equal specificity means order decides.

### Verified semantic tokens

The Tarkov mapping in `src/themes/tarkov.ts` was written against the token names
that actually exist in `styles-t2tKjMWX.css`, including several the upstream
mapping did not cover: `--color-header`, `--color-hover`, `--color-selected`,
`--color-menu`, `--color-menu-hover`, `--color-tab`, `--color-tab-active`,
`--color-tab-border`, `--color-popover-border`, `--color-popover-foreground`,
`--color-popover-header`, `--color-tag`, `--color-markdown-inline-code`,
`--color-tooltip`, `--color-toast`, `--color-terminal-bg`, `--color-terminal-fg`,
`--color-bg`.

Functional tokens that carry meaning were confirmed present and are deliberately
**not** overridden: `--color-success`, `--color-warning`, `--color-danger`,
`--color-destructive`, `--color-git-*`, `--color-diff-*`, `--color-terminal-*`
(ANSI set), and the data-visualisation palettes
(`--color-context-breakdown-1..7`, `--color-usage-chart-1..6`,
`--color-usage-heatmap-0..4`, `--color-trajectory-*`).

## 2. Stable component-selector vocabulary

ZCode's UI is shadcn/ui on React + Tailwind v4. Components carry `data-slot`
attributes, which are a stable contract of the component library (unlike hashed
class names). 130 distinct values were enumerated, including:

`card`, `card-header`, `card-content`, `dialog-content`, `alert-dialog-content`,
`popover-content`, `dropdown-menu-content`, `dropdown-menu-sub-content`,
`context-menu-content`, `select-content`, `hover-card-content`, `command`,
`tooltip-content`, `input`, `textarea`, `select-trigger`, `input-group`,
`button`, `switch`, `progress-indicator`, `tabs-list`, `tabs-trigger`,
`dropdown-menu-item`, `select-item`, `context-menu-item`, `command-item`.

`src/themes/tarkov.ts` builds its component skin exclusively from these
attributes plus Radix state attributes (`data-state`, `data-highlighted`,
`data-selected`, `aria-selected`). The single class selector used anywhere is
`:not(.rounded-full)` on buttons, which exists only to *exclude* deliberately
circular buttons from the squaring-off rule.

Note: the 557 `data-testid` values found in the asar belong to bundled
Playwright, not to ZCode's own UI, and were not used.

## 3. Banner anchor

### Candidates considered

| Candidate | Verdict |
|---|---|
| `[class*="_heroWorkspaceRow"]` (used by dsh-theme-tarkov) | **Rejected.** Zero occurrences in ZCode's asar; it is a DSH/Cordis class. |
| `#loading` | Rejected. It is the startup splash, removed from the visual flow once `body.zcode-startup-ready` is set; wrong semantic anchor. |
| A `data-slot` element near the top of the shell | Rejected. Every `data-slot` value is a component-level slot; none is a shell/top-of-layout landmark. |
| `#root` | **Chosen.** |

### Final selector

```js
document.getElementById('root')   // presence + non-empty childElementCount
document.body.insertBefore(banner, document.body.firstChild)
```

The shipped `out/renderer/index.html` body is exactly:

```html
<body>
  <div id="root"></div>
  <div id="loading" class="[app-region:drag]" role="status" aria-busy="true" aria-label="Loading..."> … </div>
</body>
```

### Why `#root`

1. **Guaranteed to exist** in the shipped HTML of the exact installed version —
   it is the React mount point, so it is present for the entire app lifetime.
2. **It is the app-mounted signal.** `#root.childElementCount > 0` means React
   has rendered; before that the banner stays out of the way.
3. **It keeps the banner outside React.** The band is inserted into `<body>`,
   *before* `#root` — it is a sibling of the React root, not a child. React only
   reconciles the `#root` subtree, so it can never fight the banner or re-render
   over it. This was the main reason to avoid an inline anchor inside the React
   tree, which is exactly the fragile part of the DSH approach.
4. **Layout is reserved without touching the app.** `html,body,#root{height:100%}`
   in the shipped HTML means `#root` resolves percentage heights against the
   body content box. With `box-sizing: border-box` (Tailwind preflight), a
   `body { padding-top }` set only while `html[data-zct-banner="1"]` is present
   reserves exactly the band height with no overflow. Percentage-based `h-full`
   is the dominant pattern in the app (226 occurrences); literal `h-screen` /
   `100vh` did not appear in ZCode's own layout code.
5. **Window dragging is preserved.** The band sets `-webkit-app-region: drag`, so
   the strip that covers the top of the window still drags it.

### Behavior when the selector is not found

Fail-soft, in this order (`src/core/banner.ts`):

- `document.body` missing → return; nothing is inserted, nothing throws.
- `#root` missing, or `#root` has no element children (app not mounted yet) →
  any existing banner is removed and the function returns. The theme CSS is
  applied by a separate block and is unaffected.
- The banner is never re-inserted more than once: the node is looked up by id
  and only re-parented if it is not already `body.firstChild`.
- Text is written only when it actually differs. An unconditional `textContent`
  assignment replaces the text node, mutates the tree, and re-triggers the
  `MutationObserver` that called the handler — a feedback loop that can wedge
  page boot. Writes are conditional and the observer callback is debounced
  behind a `scheduled` flag.
- If `MutationObserver` is unavailable, a bounded poll (60 × 1 s) is used
  instead, and it clears itself.
- Every DOM step is wrapped in `try/catch`; the script cannot throw into the
  page.

No fatal error is raised, ZCode's loading is never blocked, and no other theme
CSS depends on the banner succeeding.

## 4. Reproducing this investigation

The single-instance-safe way to get a testable instance (see the section above).
Do **not** restart the user's own ZCode if your session is hosted by it:

```powershell
$env:ZCODE_DESKTOP_USER_DATA_DIR    = 'F:\scratch\userdata'
$env:ZCODE_DESKTOP_SESSION_DATA_DIR = 'F:\scratch\session'
& 'C:\Program Files\ZCode\ZCode.exe' --remote-debugging-port=9222

# then drive it like any other instance, isolating the plugin config too:
$env:ZCODE_BEAUTIFY_DATA_DIR = 'F:\scratch\plugin-data'
node dist/cli.js theme tarkov --port 9222
```

Close that instance with `Browser.close` on its own browser endpoint, not with a
process-name kill, so the user's instance can never be caught by it:

```js
const { webSocketDebuggerUrl } = await (await fetch('http://127.0.0.1:9222/json/version')).json();
const ws = new WebSocket(webSocketDebuggerUrl);
ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
```

## 5. Live verification results

Ran against a real ZCode 3.11.2, driven through the real `dist/cli.js` bundle
with a scratch `ZCODE_BEAUTIFY_DATA_DIR`. 67 assertions, all passing.

### Confirmed live

- `<html>` carries `dark theme-zai-dark platform-windows-desktop`, and `<body>`
  carries `zcode-startup-ready` — exactly the classes the token-scope selectors
  were built around.
- `document.body` has **one** element child, `#root` (React `rootChildElementCount: 2`).
  The startup `#loading` splash is removed from the body once the app is ready.
- Cascade layers: 4 layered `:root` blocks vs 36 unlayered `.dark` rules and 18
  unlayered `.theme-zai-*` rules — so the unlayered-beats-layered reasoning and
  the need to match `.theme-zai-*` explicitly both hold in the live tree.
- Live token values in dark mode: `--color-background: #161616`,
  `--color-panel: #202020`, `--color-card: #2b2b2b`, `--color-hover: #ffffff0d`,
  `--color-tag: #363636`, `--color-terminal-bg: #161616`.
- `data-slot` is present in the live tree: 1029 elements, 17 distinct values.
  The most common are `collapsible`/`collapsible-trigger`/`collapsible-content`
  (≈320 each, the message list), plus `tooltip-trigger`, `button`,
  `dropdown-menu-trigger`, `tabs-trigger`, `dialog-header`/`dialog-title`,
  `tabs-list`, `context-menu-trigger`, `avatar`, `popover-trigger`.
  **Note:** the container/item slots the Tarkov skin targets (`card`,
  `dialog-content`, `popover-content`, `dropdown-menu-content`, `select-item`,
  `input`, …) are Radix portals and only mount when opened, so they were not
  observable in a resting tree. The skin's selectors are therefore exercised
  when those surfaces are opened, not on page load.

### Tarkov mode, measured from the live document

| Check | Result |
|---|---|
| `--color-primary` | `#ee8a3a` |
| `--color-foreground` | `#e8d9c8` |
| `--color-input-border-focused` | `#ee8a3a` |
| `--tarkov-accent` | `#ee8a3a` |
| `--color-success` / `--color-danger` | unchanged from native |
| component skin present in the injected CSS | yes |

### Banner, measured from the live DOM

```json
{
  "id": "zcode-tarkov-banner",
  "role": "status",
  "line1": "ATTENTION! ZCODE TACTICAL INTERFACE ACTIVE",
  "line2": "Experimental interface. Verify your task, tool calls and working tree before deployment.",
  "icon": "!",
  "isFirstBodyChild": true,
  "parentIsBody": true,
  "hexCorner": "polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%)",
  "bandBg": "rgba(224, 121, 48, 0.92)"
}
```

- `body { padding-top }` resolves to `56px` while mounted and `0px` when not.
- Injecting DOM churn into `#root` and removing it leaves **exactly one** banner,
  still `body.firstChild` — the guarded-write/debounce logic holds.
- No `tarkov-beta-banner` (the DSH id) ever appears.

### Mode switching, measured live

- `tarkov → native`: banner, banner style, `data-zct-banner` and the reserved
  padding all disappear; `--tarkov-accent` resolves to nothing; the string
  `tarkov` no longer appears anywhere in the injected stylesheet.
- `tarkov → monet` and `native → monet`: no Tarkov token, rule or banner survives.
- `reset`: theme style removed, banner gone, accent token cleared, primary and
  foreground back to ZCode's own values, padding released.
- Swapping the wallpaper while in Tarkov mode leaves the palette byte-identical.
- Re-entering Tarkov produces exactly one banner, never two.

### Settings panel, measured live

- Panel injects, offers exactly `monet | tarkov | native`, and drives the page:
  selecting Tarkov through the real `<select>` changed `--color-primary` to
  `#e07930` and re-skinned the panel (`data-zb-theme="tarkov"`, deep-brown
  `--zb-bg`, `--zb-accent: #e07930`, `--zb-radius: 4px`).
- Selecting Native reverted the panel to the neutral skin
  (`--zb-accent: #7aa2f7`, `--zb-radius: 12px`) and removed the banner.
- The choice persisted to `config.json` as `colorMode` with `monet` kept in sync.

### Restart / recovery, measured live

The isolated instance was closed via its own `Browser.close` and relaunched with
the CDP port. The user's instance (16 processes) was untouched throughout.

- A **new** renderer target id appeared, and the background service re-injected
  into it: Tarkov palette restored, warm foreground restored, exactly one banner
  restored, panel re-injected with the Tarkov skin, reserved padding back to
  `56px`.

### Fail-soft behavior, exercised live

The "anchor missing" branches were driven directly in the live renderer by
stubbing the anchor lookup, so the paths are empirically exercised rather than
merely asserted to exist. 19 assertions, all passing:

- **`#root` missing**: the script does not throw, sets no banner, sets no
  `data-zct-banner` and reserves no padding — and still installs its handle, so
  the observer stays armed and a later appearance of the anchor is picked up.
- **`#root` present but empty** (app not mounted): same — no throw, no banner,
  no reserved padding.
- **anchor restored** (positive control): the banner appears exactly once, is
  `body.firstChild`, reserves `56px`, and renders the shipped wording, the
  hexagon (`clip-path: polygon(...)`) and the orange band `rgba(224,121,48,0.92)`.
- **teardown**: removes the node, the attribute, the style element and the
  handle.

No fatal error is raised, nothing blocks ZCode's loading, the theme CSS is
independent of the banner succeeding, and the fallback poll is bounded.

## 6. Known pre-existing behavior: a bare renderer reload drops the theme

Reloading the renderer (`Page.reload`) without restarting the app loses the
injected theme, and the held session does **not** put it back — the service
considers the target still held, so it never re-injects. This was verified to be
**pre-existing upstream behavior, not a regression**:

- Against `zcode-tarkov`: after reload, no theme style, no panel, palette back
  to ZCode's `#fff`.
- Against pristine upstream `zcode-beautify` at `8639446`, same instance, same
  reload method, same result: `themeStyle: false` after reload.

A control probe confirmed the CDP mechanism itself is fine — a script registered
with `Page.addScriptToEvaluateOnNewDocument` on an open session *did* survive a
subsequent reload. So the loss is about the long-lived session's registration
surviving this Electron build's reload path, not about the API.

This is why the recovery modes exist: upstream's documented model is that the
theme dies with the renderer, and `on-start` / `always` restore it after an app
restart. The restart path (above) works. Making a bare reload self-heal would be
an upstream behavior change and is out of scope for v0.1; it is recorded here
rather than fixed.

## 7. Empty-chat greeting anchor (Tarkov beta notice)

Investigated live on ZCode 3.11.2, on the empty-chat / new-task screen.

### The DOM as rendered

```html
<div data-testid="chat-empty" class="w-full">
  <div>
    <div aria-hidden="true">
      <svg width="400" height="320" … stroke="currentColor">   <!-- display:none in practice -->
      <img data-v4-draft-logo="dark" …>                        <!-- the visible Z graphic, 400x320 -->
    </div>
    <p data-v4-draft-greeting="true" style="--v4-draft-greeting-font-size: 30px;">
      <span aria-hidden="true" class="… invisible absolute whitespace-nowrap text-3xl/[1.2]">…</span>
      <span>…</span>                                           <!-- the visible greeting text -->
    </p>
  </div>
</div>
```

Notes that shaped the implementation:

- The greeting is **time-dependent** — observed as `上午好呀，有什么想让我帮忙的吗`
  and later `中午好呀，要不要先休息一下`. Anything that rewrites the text would
  have to survive that, and would have to restore the right variant on the way
  out. CSS never touches the text, so this problem disappears entirely.
- There are **two** spans with the same text. The first is `aria-hidden`,
  `visibility: hidden` and `position: absolute` — ZCode keeps it purely to
  measure the greeting's width. Hiding it with `display: none` would make that
  measurement read zero, so the theme only makes it non-painting and leaves the
  box in place.
- The Z graphic is the `<img data-v4-draft-logo>` (400×320), **not** the sibling
  `<svg>`, which is `display: none` in both themed and unthemed states. It
  inherits `currentColor`, so it takes on the Tarkov foreground tone like every
  other foreground element; its box and visibility are unchanged.

### Candidates considered

| Candidate | Verdict |
|---|---|
| A hashed/utility class from the rendered markup | Rejected. Would be guesswork against minified Tailwind classes. |
| The greeting's own text content | Rejected. Time-dependent, so it is not a stable handle. |
| `[data-testid="chat-empty"]` (the screen) | Kept as context, but it is the whole empty state, not the greeting. |
| `p[data-v4-draft-greeting="true"]` | **Chosen.** |

### Final selector

```css
p[data-v4-draft-greeting="true"]
```

### Why

1. It is a **semantic `data-*` attribute** emitted by ZCode's own empty-chat
   component — a deliberate hook, not a generated class name.
2. It is the narrowest element that contains exactly the greeting, so the
   replacement cannot bleed into the Z graphic or the prompt box.
3. It carries `--v4-draft-greeting-font-size`, so the notice's type scale can
   derive from ZCode's own value instead of hardcoding pixels.

### Behavior when the selector does not match

The replacement lives entirely in the Tarkov stylesheet as attribute-qualified
rules:

- On any screen without the empty-chat element (a real session open, a workspace
  with no draft, a future ZCode that renames the attribute) **nothing matches**;
  the stock greeting is shown and the rest of the theme is unaffected.
- The original text is never rewritten — it is only made non-painting and
  zero-sized — so leaving Tarkov mode removes the rules and the greeting returns
  byte for byte. There is no restore path that can fail, and no risk of a
  permanent DOM edit.
- Nothing in the block is global: every rule starts with the `p[data-v4-draft-…]`
  anchor.

### Live verification (first iteration)

At the time of the first pass the notice was two plain text lines in the
greeting's place. Verified on an isolated ZCode 3.11.2 instance driven through
the real `dist/cli.js`, cycling **Tarkov → Native → Monet → Tarkov** and then
reset: 32 assertions, all passing. Specifically — the `::before` / `::after`
content matched the intended wording exactly; both lines derived from ZCode's own
30px variable; the rendered greeting box grew from 36px to 61px and stayed inside
its 672px container; the span text was byte-identical after every switch; the Z
graphic kept its 400×320 box in all states; and the injected stylesheet carried
no greeting rule at all in Native and Monet. The sizes quoted here are the ones
that pass shipped at the time; the current ones are in the next section.

### Beta band (v0.1 visual pass, second iteration)

The notice now reproduces the reference project's own beta banner rather than a
design of our own. Everything below is dsh-theme-tarkov's `#tarkov-beta-banner`
from `lib/client.js` (MIT), re-expressed against ZCode's greeting scale:

| reference declaration | here |
|---|---|
| `display:flex; align-items:center; gap:16px` | unchanged |
| `width:min(94%,720px); margin:18px auto 10px` | unchanged |
| `padding:15px 22px 15px 16px; border-radius:6px` | unchanged |
| `background:rgba(224,121,48,var(--tarkov-banner-opacity,.55))` | same, variable renamed `--zct-banner-opacity` |
| icon `42×36`, `#1c1207` on `#e07930`, `font:800 24px/1` | `× 1.45` / `× 1.25` / `× 0.8` of `--v4-draft-greeting-font-size`, i.e. 43.5×37.5 and 24px at its 30px default |
| `line1 #111111 18px 700; line2 #111111 15px 400`, `letter-spacing:1.5px`, `gap:5px` | `× 0.6` / `× 0.5` of the same variable (exactly 18px/15px at 30px), same colours, spacing and gap |
| `clip-path:polygon(25% 0%,75% 0%,100% 50%,75% 100%,25% 100%,0% 50%)` | unchanged |

Structure, without adding any DOM:

- the band **is** `p[data-v4-draft-greeting="true"]`;
- the hexagonal `!` badge is `::before` on that element (pure CSS clip-path, no
  image and no game asset);
- ZCode's own visible greeting span — the last child, the one without
  `aria-hidden` — becomes the text column, and its `::before` / `::after` draw
  the two lines. Its own text is collapsed with `font-size: 0`, never rewritten,
  so the real greeting is still in the DOM to return to.
- every rule is also gated on that structure with
  `:has(> span:not([aria-hidden]):last-child)` and targets only the last span, so
  a future markup change reverts to the stock greeting instead of drawing half a
  banner, and no rule can match twice.

Measurement note: the browser does **not** composite this translucent band with
straight sRGB alpha math — with the band at `opacity: 1` the painted pixel is
exactly `rgb(224,121,48)` and at `opacity: 0` exactly the backdrop, but at 0.62
the painted pixel is `rgb(171,94,37)`, which is `rgb(151,82,34)` under straight
alpha (implied alpha 0.72; the window runs at `devicePixelRatio` 1.75 on a
wide-gamut display). Contrast figures here are therefore taken from painted
pixels, not from a formula.

Measured live on ZCode 3.11.2, isolated instance, `dist/cli.js` from this build:

- geometry at a 1363px viewport: band 632×107 (94% of its 672px container,
  capped at 720px) centred with 20px on both sides, `padding 15px 22px 15px 16px`,
  radius 6px; badge 43.5×37.5; line 1 18px/700, line 2 15px/400, line gap 5px;
- `#111111` on the painted band is **3.46:1** at the shipped 0.55 — clearing the
  3:1 large-text bar — and 3.92:1 at 0.62;
- translucency proven by pixel, not by declaration: with the knob at 1 the band
  paints `rgb(224,121,48)` exactly, at 0 it paints the backdrop
  `rgb(31,19,10)`, and at 0.55 it paints `rgb(160,86,35)`, between the two;
- the badge core is `rgb(28,18,7)` and its clipped corners show the band, so the
  hexagon really is cut;
- the band bottom sits at y=470 with the prompt input at y=577 — no overlap, and
  the band is in flow;
- the Z graphic keeps its 400×320 box and its strokes stay visible in the strip
  the band does not cover (luminance 0.0076 → 0.0353). It moves down by 56px,
  because the notice is taller than one line of greeting text and the empty-chat
  column is vertically centred;
- at an 820px viewport the container narrows to 507px, the band to 477px, the
  copy wraps inside the column (`scrollWidth` 379 = `clientWidth`), the badge
  keeps its size and there is still no overlap with the prompt input;
- Tarkov → Native → Monet → Tarkov leaves no greeting rule and no band in
  Native or Monet, restores the stock greeting text and size in both, and redraws
  exactly one band on return; `reset` removes the stylesheet and the notice.

Verification: 55 assertions, all passing, run by `.tools/verify-dsh-band.mjs`
(launches its own instance, its own scratch profile, and closes it again). One
honest caveat: the test window refused `SetWindowPos` (client rect unchanged at
1362×909), so the narrow case was measured through an emulated layout viewport
of 820px rather than a real window resize; the reflow itself is real.

Earlier caveat, still true: a minimized Chromium window stops producing frames
and `Page.captureScreenshot` then hangs rather than erroring, and this model
cannot accept image input — so the render was verified by reading computed styles
and sampling pixels through CDP clip rectangles, and the screenshots are kept for
human review.

---

## 8. Banner band reservation and the settings-panel status line

This section records the layout work on the Tarkov top banner, the settings-panel
status line, and the panel's injection timing. All numbers were measured over CDP
on isolated scratch instances of ZCode 3.11.2 (never the running user instance);
raw evidence lives in `docs/images/layout/` (`before-*`, `after-*`, `cycle-*`,
`control-simulated-prefix-960x720.json`) and in
`docs/images/clean-install-evidence.json`.

### 8.1 The geometry chain the banner has to live in

ZCode's renderer ships

```html
<html style="height: 100%"> <body style="height: 100%"> <div id="root" style="height: 100%">
```

plus the renderer stylesheet's `#root { height: 100dvh; overflow: hidden }` and
the app shells that carry `.h-dvh`. `html`, `body` and `#root` are all exactly
the viewport tall, and nothing above them scrolls: `html.scrollHeight ==
html.clientHeight`, `#root` is `overflow: hidden`. There is therefore **no
scroll container that could absorb an extra band**. Anything that adds height to
the document (or moves `#root` down without shortening it) pushes app content out
of the window permanently — the clipped content cannot be scrolled into view.

### 8.2 Why the old `body { padding-top: 56px }` reservation clipped the app

The first banner implementation reserved the band with
`body { padding-top: 56px }`. Because `body` is `height: 100%` with
`box-sizing: border-box` (ZCode sets `box-sizing` globally), the padding eats
into the body box, but `#root` still carries `height: 100dvh` — i.e. the full
viewport height *below* the 56 px band. Measured on a real window resize:

| measurement (Tarkov, 1366×768 request, client 1367.43×769.14) | value |
|---|---|
| viewport (`innerHeight`) | 769.14 |
| `#root` rect | `[0, 56, 1367.43, 769.14]`, bottom **825.14** |
| overflow of `#root` below the window | **56.14 px** |
| elements painted outside the viewport | **49** |
| sidebar `aside` | `[0, 56, 264, 769.14]`, bottom 825.14 |
| account label (bottom-left) | top 782.64 — fully below the fold |
| composer | pushed 56 px down with the shell |

The A/B control is `control-simulated-prefix-960x720.json`: the same build with
*only* the old reservation mechanism present, at 961×721. It reproduces the
owner's reported symptom exactly — ZCode's own `footer` reading
`连接使用移动端远程控制` at `[0, 721.14, 264, 56]`, painted **56.14 px below the
viewport**, together with the sidebar, the composer column and the account area.
That footer overflow is the visible symptom of the reservation, not a ZCode
defect.

### 8.3 The fix and the invariant it preserves

`src/core/banner.ts` no longer touches `body`:

- `html[data-zct-banner="1"]` exposes `--zcode-tarkov-banner-height: <band>px`;
- `body` becomes `display: flow-root` (it carries no offset);
- `#root { margin-top: var(--zcode-tarkov-banner-height); height: calc(100dvh - var(--zcode-tarkov-banner-height)) }`;
- `.h-dvh` app shells get the same `calc(100dvh - var(--...))` height.

The invariant: **band height + app root height == viewport height, and `#root`'s
bottom edge equals `innerHeight`**. Measured after the fix:

| Tarkov, 1366×768 | before | after |
|---|---|---|
| `#root` bottom | 825.14 (viewport 769.14) | 768 (viewport 768) |
| painted outside the viewport | 49 | 0 |
| sidebar bottom | 825.14 | 768 |
| account label | top 782.64, off-screen | `[56, 725.5, 56, 21]`, inside |
| composer | 56 px low | fully inside |
| `html.scrollHeight` vs `clientHeight` | n/a | 768 vs 768 |

The same result holds at 1440×900 and 960×720, in Tarkov, Native and Monet; the
Native/Monet geometry is byte-identical to the pre-banner baselines (recorded by
`tools/measure-layout.mjs --compare`, all rect comparisons within 0.5 px), and
the Tarkov → Native → Monet → Tarkov cycle leaves exactly one banner in Tarkov,
none in Native/Monet, with identical `#root`/sidebar/composer/account geometry
across the cycle.

### 8.4 The settings-panel status line (pre-existing defect, fixed)

The panel is a `position: fixed; inset: auto` root that contains `#zb-fab` and
`#zb-panel` — both `position: fixed` — and `#zb-status`, the transient status
line written by `status(msg)`. The status element was the **only in-flow child**
of that root, so the root shrink-wrapped to it (24×14 px) and, because a fixed
box with `inset: auto` takes its static position, landed at the end of
`document.body` — exactly at the document bottom, i.e. exactly at the window
edge. Measured:

| measurement | value |
|---|---|
| Tarkov, harness instance, `innerHeight` 821 | `#zcode-beautify-panel-root` and `#zb-status` both `[0, 821.14, 24, 14]`, painted bottom **835.14** → **14.14 px below the viewport** |
| Native, scratch instance, 1366×768 | the same two elements `[0, 768, 24, 14]` → painted bottom **782**, **14 px below** |
| every `status(msg)` message | written into an element that was never on screen |

The fix is confined to `src/panel/panelScript.ts`: `#zb-status` is now a
viewport-pinned toast next to the FAB — `position: fixed; right: 62px;
bottom: 24px` — wearing the panel surface (`background: var(--zb-bg)`,
`border: 1px solid var(--zb-border)`, `border-radius: var(--zb-radius-sm)`,
`color: var(--zb-text)`, `pointer-events: none`), with
`#zb-status:empty { display: none }` so an idle status paints nothing. The root
now has **no in-flow children at all** (all three are fixed) and measures 0×0 at
the document end. Measured with a message set: `[1181.82, 719.5, 123.6, 25.6]`
(Tarkov, 1367×769) and `[801.34, 670.36, 96.7, 25.6]` (960×720) — bottom
745.14 / 696, both fully inside the viewport, 62 px from the right edge as
declared.

### 8.5 A second injection defect found while verifying: document-start throws

The service registers the panel script with
`Page.addScriptToEvaluateOnNewDocument`. At document-start Chromium has not
created the document tree yet; measured through a document-start probe on
ZCode 3.11.2:

| moment | readyState | `document.documentElement` | `head` | `body` |
|---|---|---|---|---|
| document-start | `loading` | null | null | null |
| DOMContentLoaded | `interactive` | present | present | present |

The old script appended its `<style>` to
`document.head || document.documentElement` and the root to `document.body`, so
it threw `TypeError: Cannot read properties of null (reading 'appendChild')`
and the panel was **missing from every document created after the service
attached** — a renderer reload left the page without a panel (verified: after
`Page.reload`, `#zcode-beautify-panel-root` and `#zcode-beautify-panel-style`
were both absent). The fix wraps the whole build in `install()`: it runs
immediately when `document.body` exists and otherwise on `DOMContentLoaded`;
after the fix a reload keeps both the panel root and its stylesheet (verified).
The same document-start exception still fires for ZCode's *theme bootstrap*
script (recorded as an out-of-scope finding).

### 8.6 What the harness pins now

`tools/verify-clean-install.ps1` / `.mjs` carry 12 `layout.*` CDP assertions:
`layout.observation-present`, `layout.banner-count`, `layout.attribute-set`,
`layout.banner-band-height`, `layout.banner-inside-viewport`,
`layout.app-shell-below-banner`, `layout.root-bottom-at-viewport`,
`layout.composer-fully-visible`, `layout.sidebar-fully-visible`,
`layout.account-fully-visible`, `layout.no-clipped-elements`,
`layout.no-vertical-overflow`. The clipped-element rule intersects each
element's painted box with its clipping ancestors and treats `html`/`body` as
the window edge, so an app shell pushed below the fold is caught while an
element merely scrolled out of an inner list is not.

One honest caveat: the rule also counts elements that are *only* moved out of
the window by an animated transform. ZCode's own update toast
(`div.fixed bottom-4 left-4 z-[9999] ... translate-y-12`, text
`v3.12.3 已下载，重启即可安装`, no `data-slot`) parks itself 48 px below its
resting place, i.e. 32 px below the window edge, and made
`layout.no-clipped-elements` fail on three consecutive harness runs with
bit-identical geometry while every candidate-owned element — banner, app shell,
`#root`, composer, sidebar, account label and both panel elements — was inside
the viewport. The toast's geometry is identical in Native mode and its classes
come from ZCode's own renderer, so it is an app-owned transient element and a
measurement-timing hazard on this machine (a v3.12.3 update was downloaded and
waiting for a restart), not a defect of this repository.

### 8.7 Scratch-instance note: `--user-data-dir` is mandatory

`ZCODE_DESKTOP_USER_DATA_DIR` is applied by ZCode's own bundle *after* Chromium
has already taken the single-instance lock from the default user-data directory.
An isolated instance therefore needs an explicit

```
C:\Program Files\ZCode\ZCode.exe --remote-debugging-port=9455 --user-data-dir=<scratch profile>
```

with `APPDATA`, `USERPROFILE`, `ZCODE_DESKTOP_USER_DATA_DIR`,
`ZCODE_DESKTOP_SESSION_DATA_DIR` and `ZCODE_BEAUTIFY_DATA_DIR` redirected into
the same scratch tree. Without `--user-data-dir`, a second process can notify —
or take over — the user's real instance instead of running beside it (measured
on ZCode 3.11.2; the harness uses the same launch). Always close such an
instance through its own CDP `Browser.close`, and never by image name.
