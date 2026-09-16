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

## Important limitation: the live CDP session could not be used

The original plan was to inspect the running ZCode DOM over CDP. That was **not
possible on this machine**, for a reason worth recording precisely:

1. **The running ZCode has no CDP port.** 16 `ZCode.exe` processes were live and
   no listening port in the 9200–9300 range belonged to any of them
   (`Get-NetTCPConnection -State Listen`).
2. **`zcode-tarkov launch` / `zcode-beautify launch` cannot help while it runs.**
   The launcher refuses (correctly) with `running-without-cdp`: ZCode holds a
   single-instance lock, so a newly spawned process forwards its args and exits,
   closing the port again.
3. **A second, isolated instance is also refused.** Launching
   `ZCode.exe --user-data-dir=F:\WSL\workspace\.zcode-test-profile
   --remote-debugging-port=9222` created only a stub `rum-electron-store`
   directory and then exited, with no new persistent `MAIN` process and no CDP
   port. The single-instance lock is therefore **not** scoped to
   `--user-data-dir` for this build.
4. **The only remaining lever — `zcode-beautify relaunch`, i.e. kill +
   restart ZCode with the debug port — was deliberately not used.** This agent
   session is itself hosted by that ZCode instance: the shell's process ancestry
   is `ZCode.exe (38928) → ZCode.exe (36712) → ZCode.exe (44784,
   zcode.cjs app-server) → bash → powershell`. Killing ZCode would have
   terminated the session running the task, and would have discarded the user's
   unsaved conversation state. That is a destructive, non-reversible action taken
   for a test convenience, so it was ruled out.

**Consequence:** selectors below were derived from the shipped renderer of the
exact installed version rather than from a live DOM snapshot. That is real
evidence of what ZCode renders (it is the same code the app executes), but it is
**not** the same as observing a live tree, and it has not been confirmed against
a running instance. This is recorded as `NOT TESTED` in the final report, and
`docs/zcode-dom-notes.md` should be re-verified over CDP once ZCode can be
started with `--remote-debugging-port`.

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

Once ZCode can be started with the debug port, the following re-checks the
findings against a live tree:

```powershell
# 1. Quit ZCode completely, then start it with CDP:
node dist/cli.js launch

# 2. Confirm the token scopes actually applied:
#    in the renderer DevTools console:
#    getComputedStyle(document.documentElement).getPropertyValue('--color-background')
#    document.documentElement.className

# 3. Confirm the banner anchor resolved:
#    document.getElementById('zcode-tarkov-banner')
#    document.body.firstChild.id
```

```js
// Or over CDP directly, from the project root:
const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
// Runtime.evaluate against the renderer target:
//   JSON.stringify({
//     htmlClasses: document.documentElement.className,
//     banner: !!document.getElementById('zcode-tarkov-banner'),
//     rootChildren: document.getElementById('root')?.childElementCount,
//     bannerPadding: getComputedStyle(document.body).paddingTop,
//   })
```
