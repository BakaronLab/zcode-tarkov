# Release evidence — zcode-tarkov v0.2.0

What was run to justify this release, what it produced, and what it did **not**
cover. Every claim below is a pointer to a command whose output is reproducible
on this machine, or to a file in this repository.

- **Version:** `0.2.0`
- **Base commit:** `ad0c4bfd3ed0fa0f7b1a23247f3114a192d53884`
- **Verified against:** ZCode `3.12.3.7463`, Windows, Node `24.19.0`
- **Evidence date:** 2026-09-17

---

## 1. Gate results

| Gate | Command | Result |
|---|---|---|
| Type check | `npx tsc -p tsconfig.json --noEmit` | clean, exit 0 |
| Unit / integration tests | `npm test` | **309 passed, 0 failed** |
| Lifecycle acceptance | `npm run test:lifecycle` | **59 assertions passed, 0 failed** |
| v0.2 client in a live renderer | `tools\verify-v02.ps1` | **151 checks passed, 0 failed, 0 not tested** |
| Multi-renderer BGM leadership | `node tools/verify-leader.mjs` | **14 checks passed, 0 failed** (5 consecutive green runs) |
| Independent review | see §3 | **BLOCK** twice, then **ACCEPT**; every finding fixed and re-verified |
| Release packages | `npm run package` | two zips built, client bundle included |
| Whitespace / conflict markers | `git diff --check` | clean |
| PowerShell syntax + ASCII | parser check on 7 scripts | all parse, no BOM, 0 non-ASCII bytes |

Artifacts: `docs/images/v02/verify-v02-evidence.json` (per-check observed values),
`docs/images/clean-install-evidence.json` (v0.1 journey, still passing),
`packages/*.zip`.

---

## 2. What each gate actually exercises

### 2.1 Tests — 309 across 22 files

`tests/` covers preferences (defaults, per-field clamping, malformed JSON
quarantine, v0.1 migration), path safety (23 hostile filenames), the byte-range
parser and `sendFile` over a real server, the media library including a
generated WAV whose duration is asserted, the **host API driven over real HTTP**
(authorisation, upload caps, traversal negatives, content types), the event state
machine, the status phrase pool, the byte-bounded LRU, the leader lease with an
injected clock and store, and the synthesized SFX sequences.

### 2.2 Lifecycle — 59 assertions on the real scripts

A scratch tree under `%TEMP`, with `APPDATA`, `USERPROFILE`, `ZCODE_BEAUTIFY_DATA_DIR`
and `ZCODE_TARKOV_DATA_DIR` all redirected, exercising: clean install, install
idempotency, refusal of a foreign `settings.json` (and `-Force` adoption), repair
merging shortcut directories, uninstall `-DryRun` changing nothing, a real
uninstall that **keeps the data root and the media inside it**, `-PurgeUserData`
deleting this project's own files and **nothing else in the root** (asserted by
placing a foreign folder in a shared root and proving it survives, with the root
kept while it holds it), a second uninstall reporting `[absent]` instead of
failing, and the real profile unchanged.

### 2.3 The v0.2 client in a real renderer — 151 checks

Against a **credential-copied, fully isolated** ZCode instance (its own Chromium
profile, its own `ZCODE_HOME`, its own data root), with the real `~/.zcode` under
a size+mtime tripwire that came back clean and all 13 baseline ZCode processes
surviving. It asserts injection and idempotent re-injection, clean teardown and
recovery across a `Page.reload`, the three band modes with **live geometry**
(off: computed `0px` and no reserved space; compact: 28 px; full: band + `#root`
== viewport), the accent token, mock-free byte-range streaming with a generated
WAV fixture, the library, the dock, the pet (including a `resize` clamp and
exact-set geometry proving the default corner clears the account row), and the
five-tab settings centre with keyboard and click navigation.

Screenshots `docs/images/v02/01..07.png` are real captures from that instance at
a real `SetWindowPos` 1440×900 CSS viewport (dpr 1.75 → 2520×1575 px). Every
capture ran a page-side scan for tokens and for a denylist of the machine
owner's private project names, and the seeded `setting.json` had its
`recentProjects` and `lastWorkspaceSession` lists cleared before launch; a
capture that hit anything would have been withheld.

### 2.4 Multi-renderer leadership — 14 checks

A runtime harness running two complete `LeaderController` instances in one
process, sharing one storage facade. Over ~3.4 M samples per run: **at most one
live leader at every sample, zero samples with two leaders**, every observed
lease well-formed and backed by its own unexpired lease, promotion strictly
after the stale lease expires, and prompt promotion on a clean step-down. The
harness proves its own non-vacuity by running a deliberately mutated build
(which fails 8 checks and produces 2 simultaneous leaders).

---

## 3. Independent review

**Requested capability:** the designated independent-reviewer products configured
on this machine. **Not obtained**: every one of them refused to start
(`No reasoning level selected` for the GPT reviewer and its backups; `Provider
unavailable` for the heterogeneous secondary auditor). Per the routing rules this
is `CAPABILITY_UNAVAILABLE` / `VERDICT_NOT_PRODUCED`, not a candidate BLOCK or
ACCEPT.

**Substitution used:** one fresh agent with no part in the build, running the
review brief against repository truth (the routing rules permit "another
explicitly suitable or authorized independent reviewer" when the designated
capability is unavailable). **This substitution is recorded here rather than
presented as the designated capability.** Its findings and verdict are in
§3.1.

### 3.1 The palette and greeting review (later, on the added features)

A recolourable palette and editable welcome text were added after the first
review, and were reviewed separately. That review returned **BLOCK twice** before
the fixes held. Both rounds are recorded, because they are the clearest evidence
here that the review was doing work rather than agreeing:

**Round 1.** The palette's two load-bearing promises failed for one-click
choices. Ink was chosen by a light/dark **luminance threshold**, and the dark
branch's ink was light, so a mid-grey background — the first thing anyone tries in
a colour picker — rendered **1.7:1** body text and 1.10:1 muted text. The band's
ink was fixed near-black whatever the accent, so a dark accent left the beta
warning at 1.06–1.33:1, defeating its only purpose. Three surfaces still painted
the shipped orange, and the client's inline accent override leaked into Monet and
Native.

**Round 2.** The first round of fixes was still wrong in the same *way*: each ink
was measured against one surface and painted on several. A mid-dark grey put
2.86:1 text on the popover while the panel measured fine, and a single `bandInk`
derived at the notice's 0.62 was reused on the top band's 0.92, measuring 1.90:1.
Both reproduced by execution.

**What the final implementation does**, all of it measured:

- Every ink is chosen by **WCAG contrast against each surface it is actually
  painted on**, never by a threshold. `readableInkAll` / `ensureContrastAll`
  optimise the worst case across a list of surfaces.
- `--color-popover-foreground` and `--color-tooltip-foreground` take their own
  ink. One shared ink cannot serve the whole ramp: for `#484848` the best shared
  choice measured 2.65:1 on one surface while white measured 7.94:1 on another.
- The **ramp is clamped** into the luminance band a single ink can cover — a light
  ink needs every surface at or below ~0.183, a dark ink at or above ~0.175 — by
  bisecting the blend factor toward the background. A mid-tone background
  therefore yields flatter surfaces rather than unreadable text: a deliberate
  trade, and a visible change for those backgrounds.
- The top band's ink is derived from `accent` composited over the background **at
  `banner.opacity`**, the number that actually drives it, inside `resolveBanner`.
- `ensureContrast*` aim at `target × 1.01`: the channels are rounded to integers
  on the way out, and a colour measuring exactly 4.50:1 printed as 4.50 while
  actually being 4.486:1.
- The palette path returns the shipped constants **untouched** when nothing is
  customised. Verified: `resolvePalette` returns the `DEFAULT_PALETTE` object
  itself for `{}`, for the shipped values in any spelling, and for invalid input —
  and the emitted default payload still carries `#ee8a3a`, `#1c1207`, `#e8d9c8`,
  `#140d04` and a `#1c1207` band ink.

`tests/paletteCustom.test.mjs` sweeps **every shade of grey** and a 60-colour hue
spread: ≥4.5:1 for body text and the popover ink on every surface each is painted
on, ≥3:1 for muted text, ≥4.5:1 for the emphasis tones, ≥4.5:1 for text on a
filled accent, ≥4.5:1 for the notice's band ink, and ≥4.5:1 for the top band's
ink at every opacity the slider can produce.

**Its own findings, all fixed:** the `color-mix()` fallback could not work as
documented, because custom properties are not parse-validated and the later
declaration always wins — the derived values now live in their own `@supports`
block, so a browser without `color-mix()` keeps the literals instead of losing a
border. The default band ink had drifted from `#1c1207` to `#111111`; the top band
takes the shipped ink as its near-black candidate again. And the v0.1 panel's
accent was a snapshot, because `pushConfigToSessions` re-pushed only the theme
bootstrap; it now re-evaluates the panel script too, which is idempotent.

**One earlier defect the new tests caught:** `rgba(p.deep, …)` interpolated a
*hex* into `rgba()`, producing `rgba(#140d04, 0.5)` for `--color-input` — an
invalid token stream that a `var()` consumer resolves to nothing rather than to a
colour. It was pre-existing and invisible until the palette gained a test that
inspected the emitted CSS. `--color-input` is now a valid `rgb(20, 13, 4)`.

**Coverage limits of the substitution, as the reviewer stated them:** it had no
live renderer, so the cascade behaviour of `skin.ts`, `pet.ts` and `panel.ts`, the
`color-mix()` result, and the pet's neutral-mode colour were read-verified plus
emitted-CSS inspection, not observed. It also noted that `panel.ts`, `main.ts` and
`skin.ts` have no DOM-level tests, and judged that acceptable for this release on
the condition that the contrast guarantee hold *by construction* rather than by
the live checks alone — which is what the sweeps above exist for.

### 3.2 Final verdict on that review, and its last follow-up

The second review's final verdict was **ACCEPT**, on an **independent 4660-colour
sweep** (256 greys, a 16³ grid, and a 10°×9 hue spread) measured against the
emitted, rounded strings: zero pairs below their bar for body text, the popover
ink, text on a filled accent, the notice's band ink, or the top band's ink at
every opacity the slider can reach. Worst observed: 4.50–4.54:1 against a 4.5 bar.

It also found a real quality defect in my own fix, which is why it is recorded
here rather than quietly repaired: the ramp clamp moved surfaces toward the
**background**, and for a page just outside the band no blend fits — so the clamp
returned the page colour for every surface, and for **65 of 256 greys** the panel,
card and popover tones became literally identical. Text stayed readable, which is
why it was not a blocker, but a quarter of grey choices produced a theme with no
surface structure at all.

The root cause was the same mistake the whole review had been circling: the ink
family was still chosen by a **luminance threshold** (`> 0.4`). At L≈0.3 that
calls the page "dark" and picks the light ink, when black actually measures 7.9:1
there and white 2.7:1 — and it then aims the ramp away from the band that ink
needs. Choosing the family by measurement, and moving surfaces *deeper into* the
band rather than away from the background, fixes both:

| | before | after |
|---|---|---|
| Greys where all four surfaces are identical | 65 / 256 | **4 / 256** |
| Worst body-text contrast over all greys and surfaces | — | **4.55:1** |
| `#737373` (one of the named cases) | 115/115/115/115, ink unreadable on the panel | `109 / 90 / 83` surfaces, text 4.69–6.98:1 |

The four that remain are `#000000`, `#010101`, `#fefefe` and `#ffffff` — a
background already at the extreme, where there is nowhere for a surface to go.

One follow-up is recorded rather than fixed, because it is out of the claimed
scope and bounded by ZCode's own token mapping: the accent **washes**
(`--color-hover`, `--color-selected`, `--color-card-selected`, `--tarkov-hover`,
drawn at 0.14–0.26 alpha) are the one surface class the ink search does not
enumerate, and the 0.22–0.26 selected states measure ≈2.5–3.6:1 for extreme
accent choices. It is state-dependent and only reachable by a user who picks an
unusual accent; it is on the roadmap rather than in this release.

### 3.3 The core review (earlier, on the release as it then stood) — **BLOCK**, then resolved

The substituted reviewer returned **BLOCK** with two reproduced HIGH findings.
Both were real defects in what would have shipped, and both are now fixed with
regression tests. Its findings and dispositions:

| # | Severity | Finding | Disposition |
|---|---|---|---|
| R1 | **HIGH** | The BGM failure cap could never engage. `advance()` cleared the consecutive-failure counter on its way to the next track, so it was always zero by the time the next load could fail; `MAX_TRACK_FAILURES` was unreachable and a folder of undecodable files became an endless load-error-skip loop that still reported itself as playing. Reproduced by execution: 12 synthetic `error` events produced 12 track changes and no stop | **Fixed.** The counter is cleared only on a successful load (`loadeddata`) and on an explicit track choice, never in `advance()`. The cap now stops the player and says why. `tests/bgmFailureCap.test.mjs` — and the test was proven non-vacuous by reintroducing the bug in the build output and watching it fail |
| R2 | **HIGH** | `uninstall.ps1 -PurgeUserData` deleted the whole relocatable root rather than this project's own files. With the documented "media on another drive" setup (`ZCODE_TARKOV_DATA_DIR=D:\Media`) it removed everything there. Reproduced by execution: dry runs accepted `%USERPROFILE%\Desktop` and `%TEMP%` as targets | **Fixed.** The purge now removes `music\`, `sounds\`, `voice\`, `pet\`, `status\` and `prefs.json` only, removes the root only when it is empty afterwards, and reports by name anything it did not create. Six lifecycle assertions added, including one that puts a foreign folder in a shared root and proves it survives |
| R3 | MEDIUM | Media responses carried no `Access-Control-Allow-Origin` while the player sets `crossOrigin = "anonymous"` on the audio element. On a renderer that enforces CORS the element rejects the response, which would mean no music at all — and R1 would then loop on every track | **Fixed.** The header is sent on every media response. It is not the authorisation boundary — the media token in the query string is — and the JSON API already sent the same header |
| R4 | LOW | An `off` banner could still install itself from a payload of `enabled: true, mode: "off"`: a zero-height band with a one-pixel accent border and the reservation attribute set. Not reachable through the UI | **Fixed.** `resolveBanner` decides on the mode, and `off` from *either* field wins — in the payload builder and in the settings store. The precedence matters in both directions: a v0.1 caller sets only `enabled: false`, and a v0.2 caller may leave `enabled` at its default |
| R5 | LOW | `README` never mentioned the `repair-launchers` verb, which rewrites the user's own ZCode launch shortcuts and three `HKCU` handler values | **Fixed.** Both READMEs and `INSTALL-FOR-AI.md` now document it as the one operation that writes outside the user profile, say what it touches, and note that `uninstall.ps1` reverses it |

**Claims the reviewer verified independently** (by execution where it could):
"never edits ZCode" with the R5 caveat; the uninstall keeps media — confirmed in
mechanism, contradicted in blast radius by R2, now fixed; no bundled game assets,
by a repository-wide magic-byte and base64 scan; localhost + token scopes, driven
over a real `http.createServer`, including that a *full* token in a query string
is refused; v0.1 migration lossless, with the legacy file byte-identical; the
`off` mode releasing the space; `dist/client.js` byte-identical to a fresh build
and present in the zip; the test suite honest, by injecting nine behaviour
mutations into a scratch copy of the compiled tree (8 caught, the 9th an
equivalent mutant); and all five version carriers agreeing.

**Coverage limit of the substitution, stated by the reviewer itself:** it had no
live ZCode/CDP session, so every DOM-rendering behaviour was reviewed by reading;
R3's impact chain through a real audio element was inferred from the code plus a
Node reproduction, not observed. It also noted that `bgm/player.ts`, `dock.ts`,
`pet.ts`, `panel.ts`, `signals/detect.ts` and `status/` have no unit tests — which
is where R1 lived, and which is why R1 now has one.

---

## 4. Internal adversarial audit (before the review)

A separate read-only audit challenged the security-critical surface and the
stateful subsystems. Five findings, **all fixed before review**:

| # | Severity | Finding | Fix |
|---|---|---|---|
| A1 | **HIGH** | The event machine's once-per-turn latches never reset: `taskKey` is never produced by the signal layer (ZCode exposes no stable task id), so `start`/`done` fired only during the **first turn of a renderer session**, and the status roller stopped with them | A settled run following a finished turn now begins a new turn. An error is only treated as a turn boundary once it has cleared, so a persisting failure cannot replay the start sound. Two regression tests added |
| A2 | MEDIUM | Upload temp path was `pid + Date.now()`, so two files picked in one multi-select collided: the second overwrote the first's bytes and then failed to find its own file | Random suffix per request; a throwing library call now clears the temp file and returns a status instead of dropping the socket |
| A3 | MEDIUM | The banner teardown pinned an **inline** `--zcode-tarkov-banner-height: 0px`, which outranks the author rule and would keep the reservation at zero after re-enabling — a band painting over the app | The teardown clears inline values instead of writing one, and the install script defensively clears a stale one. In `off` mode the variable is now a defined `0px` from the stylesheet, not an absent value |
| A4 | LOW | A throwing `addMediaFile` left the temp file behind | Same fix as A2 |
| A5 | LOW | Legacy `banner.enabled: false` sent to the v0.1 `/api/config` route was ignored | `sanitizeBanner` honours `enabled` again, mapping to `mode: "off"`, with `mode` winning when both are present |

A sixth defect — the settings tab strip had a keyboard handler and **no click
handler**, making the tabs inert under the mouse — was found by the v0.2 harness
rather than by the audit, and was fixed with a delegated click listener.

---

## 5. Provenance

- **Upstream `dsh-theme-tarkov` reference pinned at `be1123c1c158e58ba0aa1c311c22d793b09f9c0d`** (v0.2.0), MIT, inspected directly. It is a read-only reference for the visual language and the feature set. `THIRD_PARTY_NOTICES.md` records the boundary, including the precise list of assets that upstream ships and this project does not (361 Scav voice clips, an Altyn helmet PNG, three game sound effects).
  - **Correction, added after v0.2.0 shipped.** This entry originally read "**No code and no media were taken from it**". The media half is true and unchanged; the code half was wrong. The beta notice's text is reproduced from the upstream — line 2 byte-for-byte, line 1 with only the product name changed — together with its presentation values, and the record of that is in `THIRD_PARTY_NOTICES.md` §2.1 with file and line references. The upstream is MIT and its notice is retained in `licenses/`, so the use was always permitted; the disclosure is what was inaccurate. The v0.2.0 tag and its release assets are **not** modified by this correction.
- **Upstream `zcode-beautify` at `8639446a4534be667a8fa76ea7757c139ee9df71`** (v0.3.1), MIT, is the code base this repository is a derivative of, with its git history retained.
- **No game assets are bundled.** A repository-wide scan for audio, raster images and base64 blobs returns only this project's own screenshots under `docs/images/`. There is no `assets/` directory. The default sound effects are synthesized at play time from oscillators and one noise burst; the default pet is an original inline SVG; the music and voice libraries ship empty.
- **`~/.zcode/v2/setting.json` changed by ~400 bytes during the signal investigation.** The investigating worker reported this unattributed, and the launch recipe's tripwire reproduced it as a fact about the machine rather than proof of a write by this project — the owner's own live ZCode client was running throughout and rewrites that file. It is recorded here rather than explained away, because a released artifact should not quietly omit an unexplained change to the tester's profile.

---

## 6. Known limitations, stated plainly

These are **not** test failures. They are the boundary of what v0.2.0 claims.

1. **The status-text takeover ships off by default.** ZCode 3.12.3 exposes no
   stable attribute on the element that carries the running status text, so the
   takeover resolves it structurally and cannot be proven safe on every build.
   It is opt-in from the settings centre; when it cannot find the line it does
   nothing, and the native text is never modified in the DOM.
2. **The autoplay policy was not exercised.** This Electron build allowed
   `AudioContext.resume()` without user activation, so the classic Chromium block
   did not reproduce here. The unlock path is verified (the context really
   reached `running`, evidenced by the `AudioEngine` chain, not by a repaint), but
   the branch where a stricter build keeps the context suspended remains untested.
3. **The error sound has no verified trigger.** An error or interrupted turn was
   never reached during the DOM investigation, so `ERROR_SELECTORS` is
   unconfirmed; on a build where they do not match, the sound simply never plays.
4. **The multi-renderer gate is a simulation.** Two controllers in one Node
   process, not two live ZCode windows. The harness says so in its own output.
5. **The launcher's start path is untested by the lifecycle suite** — the
   end-to-end run happened while a ZCode instance was already live, so the
   launcher correctly refused and the harness reproduced the window with a direct
   `ZCode.exe` start. Recorded as `notTested` in `clean-install-evidence.json`.
6. **A ZCode update can break DOM-dependent behaviour.** Every DOM-dependent
   feature fails soft rather than erroring, and
   `docs/dev/zcode-runtime-signals.md` records each signal with the state
   transition it was observed to move between — including the items that could
   not be observed.

---

## 7. Reproducing this

```powershell
git clone https://github.com/BakaronLab/zcode-tarkov
cd zcode-tarkov
npm install
npm run bundle            # tsc + esbuild -> dist/cli.js, dist/client.js, dist/mcp/server.js
npm test                  # 309 tests
npm run test:lifecycle    # 59 assertions, scratch tree, ~4 min
powershell -NoProfile -ExecutionPolicy Bypass -File tools\verify-v02.ps1   # 151 checks + screenshots
node tools/verify-leader.mjs                                              # 14 checks
```

The two live harnesses refuse to run unless every path they write is under
`%TEMP%`, refuse a busy CDP port, and stop only processes provably their own.
