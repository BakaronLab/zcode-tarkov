# ZCode DOM notes

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
| `--color-primary` | `#e07930` |
| `--color-foreground` | `#e8d9c8` |
| `--color-input-border-focused` | `#e07930` |
| `--tarkov-accent` | `#e07930` |
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

