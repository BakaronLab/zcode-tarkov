# ZCode runtime signals

> Developer/verification material, not user documentation. The user guide is `README.md` in the repository root.

The DOM signals that tell a CDP-injected client **what the ZCode agent is doing
right now**: idle or working, finished, waiting for an approval, showing a tool
call, streaming reasoning, and where the pieces of that UI actually live.

- **ZCode version:** `3.12.3.7463` (`C:\Program Files\ZCode\ZCode.exe`, FileVersion 3.12.3.7463)
- **Investigation date:** 2026-09-17
- **Method:** live CDP observation of an isolated ZCode instance that ran real
  prompts, driven by `tools/probe-signals.mjs`. Selector candidates from the
  shipped renderer bundle (`resources/app.asar`) were confirmed or discarded
  against the live tree; every signal below carries the state pair it was
  observed to move between. Nothing here is inferred from a class name.
- **Companion files:** `tools/probe-signals.mjs` (the probe used for every
  observation, reusable), `docs/dev/zcode-dom-notes.md` (theme/layout selectors).

Everything in this document was observed on a **live renderer**, except where a
line is explicitly marked `NOT OBSERVED` or `STATIC ONLY`. Those two labels are
used exactly as follows:

| Label | Meaning |
|---|---|
| *(none)* | Observed live on 3.12.3, in the state pair stated. |
| `PARTIAL` | Some part of the item was observed live, the rest was not. |
| `NOT OBSERVED` | The state was never reached during this investigation. No claim is made. |
| `STATIC ONLY` | The attribute/selector was found in the shipped bundle but never rendered in a live session. |
| `TEXT_BASED (weak)` | The only handle is visible text. Usable for humans; never as a sole machine signal. |

---

## 1. How the observations were made

### 1.1 The isolated instance (and why it can run a task)

The user's real ZCode instance is running without `--remote-debugging-port`, so
it cannot be inspected and must never be restarted. A second instance is safe
only if it has its own Chromium user-data directory **and** its own ZCode home:

```powershell
# all scratch paths under %TEMP%, never the real ~/.zcode
$env:APPDATA                            = '<scratch>\appdata'
$env:USERPROFILE                        = '<scratch>\userhome'
$env:HOME                               = '<scratch>\home'
$env:ZCODE_HOME                         = '<scratch>\home\.zcode'
$env:ZCODE_DATA_BASE_DIR                = '<scratch>\home'
$env:ZCODE_DESKTOP_HOME_DIR             = '<scratch>\home\.zcode'
$env:ZCODE_DESKTOP_USER_DATA_DIR        = '<scratch>\zcode-profile'
$env:ZCODE_DESKTOP_SESSION_DATA_DIR     = '<scratch>\zcode-session'
& 'C:\Program Files\ZCode\ZCode.exe' --remote-debugging-port=9463 --user-data-dir=<scratch>\zcode-profile
```

`ZCODE_HOME`, `HOME/.zcode` and `ZCODE_DATA_BASE_DIR/.zcode` are all pointed at
the **same** scratch directory on purpose: ZCode resolves its home through
whichever of those it finds first on a given code path, and one of them
(`ZCODE_DATA_BASE_DIR`) would otherwise fall back to the real `HOME`.

With a scratch `ZCODE_HOME` the instance boots to the login screen and cannot
run a task. Copying six files from the real `~/.zcode/v2/` into
`<scratch>/home/.zcode/v2/` **before** launching fixes that without touching the
real store, because the agent's provider credentials are enough to run a turn
even when the desktop account row still reads "connect to use":

```
credentials.json  provider_config.json  config.json
setting.json      model-provider-display-order.json  coding-plan-cache.json
```

`tools/probe-signals.mjs` performs this copy, refuses any scratch path outside
`$TEMP` or inside the repository, refuses a busy CDP port, and trips a wire on
the real store (mtimes/sizes read before and after; the contents are never read,
printed or written anywhere but the scratch tree). `launch` writes those
pre-launch stamps into `<scratch>/session.json` and `close` re-reads them, so the
comparison happens in the process that removes the tree; `session` does the same
inside one process.

Observed for this investigation — and stated exactly, because one file moved:

| Real `~/.zcode/v2/` file | Before (start of run) | After (end of run) |
|---|---|---|
| `credentials.json` | 2026-09-17 20:58, 904 B | unchanged |
| `config.json` | 2026-09-17 18:31, 20619 B | unchanged |
| `provider_config.json` | 2026-09-17 18:38, 12280 B | unchanged |
| `coding-plan-cache.json` | 2026-09-17 01:17, 606 B | unchanged |
| `model-provider-display-order.json` | 2026-09-15 20:36, 714 B | unchanged |
| `setting.json` | 2026-09-17 21:02, 5549 B | **2026-09-17 21:08, 5946 B** |

The isolated instance's own home was provably scratch: its renderer booted with
`initialWorkspacePath=…\zct-probe1\home\.zcode\workspace\default`, and the other
five files were not written. `setting.json` is the file ZCode's *own running
client* persists window/session state into, and the user's real instance was live
throughout, so the most likely writer is the real instance — but that was **not**
proven, and an unattributed write is recorded here rather than explained away.
Anyone re-running this should use the `launch`/`close` pair (which now compares
the stamps) or `session` (which reports `realStoreTouched`) rather than a bare
`launch` followed by a manual kill.

The instance is closed only through its own CDP `Browser.close`, then — and only
if it survived — by stopping processes whose command line carries **both** the
scratch profile path and the scratch CDP port. Never by image name.

### 1.2 What was run

Seven short real prompts against the isolated instance (the account is real even
though the storage is scratch):

| # | Prompt | States it produced |
|---|---|---|
| 1 | `reply with the single word OK` | idle → running → finished |
| 2 | `Count from 1 to 40, one number per line, no commentary.` | running, streaming heartbeat, row counters |
| 3 | `Write a 900-word essay about the history of container runtimes, with 6 numbered section headings.` | reasoning streaming, status line, long run |
| 4 | `Use your terminal tool to run exactly this command: echo probe-signal-ok …` | tool call rendered, tool status `completed` |
| 5 | `Create a file named zct-probe-note.txt … Then run the shell command zct-nonexistent-cmd-12345 …` | **approval requested, approval decided**, tool in flight |
| 6–7 | `Count from 1 to 80 / 1 to 30, one number per line.` | attempted; no approval, and the interrupt was not caught |

Not reached: an error turn, and an interrupt/abort (see §4).

### 1.3 Evidence artifacts

Raw JSON under `%TEMP%` (`C:\Users\<USER>\AppData\Local\Temp\`), not in the repo
(the per-tick watch traces were 1–13 MB each and were deleted after the numbers
above were extracted; the small structural dumps are kept as evidence):

| File | What it holds |
|---|---|
| `zct-snap-idle.json` | Full structural dump of the idle renderer (all 74 `data-*` attributes with counts and samples) |
| `zct-watch-count.json` | Transition timeline for prompt 2, including the `data-row-count` climb |
| `zct-eval-midrun.json` | Mid-run structure: `v4-stop`, `chat-loading`, `data-reasoning-streaming-text`, turn navigator |
| `zct-eval-statusline.json` | Status-strip leaves and the document-wide `aria-live` census (the negative result in §3.6) |
| `zct-eval-approval.json`, `zct-eval-dock.json`, `zct-eval-permcard.json`, `zct-click-allow.json` | Approval card: discovery, structure, and the decision experiment |
| `zct-eval-afterwrite.json` | Post-decision state (options gone, tool `data-status` back to `completed`) |
| `zct-eval-interrupted.json` | The missed interrupt: the sample that proves §4's `NOT OBSERVED` |
| `zct-eval-account.json` | Sidebar/footer/account geometry and the `ACTIVITY_ROOTS` census |
| `zct-send-*.json` | Typing/submit evidence for every prompt, including the Lexical-input finding |

---

## 2. Signal table

Confidence: **A** = semantic attribute or control the app itself toggles;
**B** = ARIA role/state or documented test id; **C** = structural inference;
**W** = text only (weak).

| # | Signal | Selector (primary) | Moves between | Conf | Observed |
|---|---|---|---|---|---|
| R1 | Agent running | `[data-testid="v4-stop"]` | absent → present → absent | A | yes |
| R2 | Agent running (attribute) | `[data-testid="v4-composer"][data-input-routing="enqueue"]` | `startNow` → `enqueue` → `startNow` | A | yes |
| R3 | Agent running (live region) | `[data-testid="chat-loading"][role="status"]` | absent → present → absent | B | yes |
| R4 | Turn running (per turn) | `[data-testid^="v4-turn-navigator-item-"][data-running="true"]` | count 0 → 1 → 0 | A | yes |
| R5 | Turn running (secondary) | `[data-testid="v4-composer-send"]` | present → absent → present | A | yes |
| R6 | Streaming heartbeat | `[data-testid="v4-session-pane-workspace-main"][data-projection-seq]` | monotonic increment while streaming | A | yes |
| F1 | Turn finished (composite) | R1 absent ∧ R3 absent ∧ R2 `startNow` ∧ R4 all `false` | running → finished | A | yes |
| F2 | Transcript rows | `[data-testid="v4-timeline"][data-row-count]` / `data-total-row-count` / `data-render-unit-count` | `0` → `n` → stable | A | yes |
| F3 | Assistant turn completed | `[data-testid^="chat-assistant-history-trigger-"][data-history-open]` | appears per completed turn | B | yes |
| A1 | **Approval requested** | `[data-permission-option-kind]` | absent → 3 present → absent | A | yes |
| A2 | Approval option set | `[data-permission-option-kind="allowOnce"｜"allowAlways"｜"rejectOnce"]` | static while the card is up | A | yes |
| A3 | Approval-pending tool | `[data-testid^="tool-summary-trigger-permission:perm_"]` | appears with the card, disappears on decision | A | yes |
| A4 | Approval decision control | `button[data-slot="button"]` inside the permission card | present → gone | B/C | yes |
| A5 | Approval option list host | `div[role="listbox"]` inside the permission card | present → gone | B | yes |
| T1 | Tool call rendered | `[data-testid^="chat-tool-call-block-"][data-tool-call-id]` | count increments per call | A | yes |
| T2 | Tool name / status | `[data-tool-name]`, `[data-status]` on T1 | `pending` → `completed` | A | yes |
| T3 | Tool detail trigger | `[data-testid^="tool-summary-trigger-"]` | appears with the block | B | yes |
| P1 | Reasoning streaming | `[data-reasoning-streaming-text="true"]` | absent → n spans → absent | A | yes (conditional) |
| P2 | Reasoning block header | `[data-testid="chat-reasoning-trigger"]` | appears when a reasoning block exists | B | yes |
| S1 | Status line (container) | — | — | — | **NOT OBSERVED** |
| S2 | Status line (thinking) | leaf `span`, no attributes, text `正在思考` | absent → present → absent | W | yes |
| S3 | Status line (queue hint) | leaf `div`, no attributes, text `继续输入以排队后续修改` | absent → present → absent | W | yes |
| G1 | Empty-chat greeting | `p[data-v4-draft-greeting="true"]` | present on a draft → gone after the first submit | A | yes |
| L1 | App shell / pane | `[data-testid="v4-pane-shell-workspace-main"][data-pane-id="workspace-main"]` | static anchor | B | yes |
| L2 | Sidebar | `aside[data-testid="sidebar"]` | static anchor | B | yes |
| L3 | Account area | `[data-testid="sidebar"] footer` → `[data-testid="login-trigger"]`, `[data-slot="avatar"]` | static anchor | B | yes |
| L4 | Composer | `[data-testid="v4-composer"]` | static anchor | B | yes |
| L5 | Composer editing surface | `[data-testid="v4-composer-input"][contenteditable="true"]` | static anchor | B | yes |
| E1 | Error / aborted | `[data-status="error"]`, `[data-state="error"]` | — | — | **NOT OBSERVED** |

---

## 3. The signals in detail

### 3.1 Running vs idle

#### R1 — the stop control (`[data-testid="v4-stop"]`)

The composer's action button **swaps** with the run state. This is the single
most reliable "working" signal in the tree, because the control only exists when
the app has something to interrupt.

Idle (empty composer):

```html
<button data-testid="v4-composer-send" type="submit" aria-label="发送"
        data-slot="tooltip-trigger" data-variant="default" data-size="icon-md"
        data-state="closed" disabled>
```

Running:

```html
<button data-testid="v4-stop" type="button" aria-label="停止生成" title="停止生成"
        data-slot="tooltip-trigger" data-variant="secondary" data-size="icon-md"
        data-state="closed">
```

- Observed transitions: absent (idle) → present within one 300 ms tick of the
  prompt being accepted → absent again on completion; after completion
  `[data-testid="v4-composer-send"]` is back in the same row position.
- Note the attribute that carries the identity is `data-testid="v4-stop"`, **not**
  `v4-composer-stop` (that selector matches nothing; verified).
- Fallback order when R1 is missing: R2 → R3 → R4 → infer from activity (the
  `ACTIVITY_WINDOW_MS` approach in `src/client/signals/detect.ts`).
- Fail-soft: absence of `[data-testid="v4-stop"]` must be read as "not running",
  never as an error. A build that renames it degrades to R2/R3/R4, then to
  mutation-based inference.

#### R2 — `data-input-routing` on the composer

```html
<div data-testid="v4-composer" data-input-routing="startNow">   <!-- idle  -->
<div data-testid="v4-composer" data-input-routing="enqueue">    <!-- running -->
```

Observed as a clean three-state cycle over prompts 1–4: `startNow` at rest,
`enqueue` for the whole duration of a turn (including while a tool call was in
flight and while the approval card was up), back to `startNow` once the turn
ended. The value family comes from ZCode's own delivery enum
(`startNow` / `queue` / `guide` in the app-server protocol); `enqueue` is the
value this element uses while a turn is active.

This is the best text-free attribute for "the agent owns the turn right now".
Fallback: R1/R3/R4. Fail-soft: any value other than the two observed ones must be
treated as "unknown" and fall through to the next candidate rather than being
guessed at.

#### R3 — the transcript live region (`[data-testid="chat-loading"]`)

```html
<div data-zcode-chat-loading-slot="true">
  <div data-testid="chat-loading" role="status" aria-label="加载中..."
       data-zcode-chat-loading-animate="true">
```

Rendered inside the timeline (`[data-testid="v4-timeline"]`) only while the turn
is live, and it is a `role="status"` region — so it is the one element in the
run-state vocabulary that assistive technology also sees. `aria-label` is
localised text (do not match on it); the attribute pair
`data-zcode-chat-loading-animate="true"` + `data-testid="chat-loading"` is the
handle.

#### R4 — per-turn `data-running`

Each user turn gets a navigator item, and exactly one of them carries
`data-running="true"` while that turn is in flight:

```html
<button data-testid="v4-turn-navigator-item-msg_…:query:msg_…"
        data-turn-id="msg_…" data-query-row-id="10"
        data-item-index="2" data-unit-index="2"
        data-active="false" data-running="true"
        data-visual-tone="idle" data-visual-color-tone="muted"
        data-visual-scale="1" aria-posinset="3" aria-setsize="5">
```

Observed: count of `[data-running="true"]` = 0 at rest, 1 during the turn,
0 again after. The `data-testid` suffix embeds a message id, so **always match on
the prefix** `[data-testid^="v4-turn-navigator-item-"]` together with
`[data-running="true"]`. `data-visual-tone` was `idle` in every state observed
(it drives a scrollbar mini-map, not run state) — do not use it for this.

This is the signal to prefer when a client needs to know *which* turn is running
rather than merely "something is running".

#### R5 — the send control, as the inverse

`[data-testid="v4-composer-send"]` is present exactly when no turn is in flight
(the composer can accept a new prompt). Its `disabled` attribute tracks the
composer's text, not the run: disabled with an empty composer, enabled once text
is typed, and it is removed from the tree entirely while the agent works. Useful
as a cheap cross-check for R1; never the sole signal.

#### R6 — the streaming heartbeat (`data-projection-seq`)

```html
<div data-testid="v4-session-pane-workspace-main"
     data-session-id="sess_a0d0ba5a-…" data-projection-seq="3138"
     data-running-subagent-ids="" data-running-subagent-work-ids=""
     data-v4-conversation-drop-target="true">
```

`data-projection-seq` is a monotonic counter of projection batches. Measured over
a 90 s essay run: 55 → 3169, advancing on essentially every ~300 ms poll while
text streamed, then freezing when the turn ended. It is a **liveness heartbeat,
not a state transition** — a watcher must treat "value changed since the last
tick" as "output is arriving", and must not treat every increment as a state
change (it will otherwise fire on every tick).

The same element carries `data-running-subagent-ids` and
`data-running-subagent-work-ids`, both `""` in every state observed here (no
subagents were spawned); their non-empty value is undocumented by observation and
must be treated as informational.

### 3.2 Turn finished

There is no single "finished" attribute. The turn is over when **R1 is absent and
R3 is absent and R2 is back to `startNow` and every R4 is `false`**. Observed
together in the same sample, repeatedly.

Supporting counters on the transcript element:

```html
<div data-testid="v4-timeline"
     data-row-count="12" data-total-row-count="12" data-window-row-count="12"
     data-render-unit-count="4" data-following="true" data-loading-older="false"
     data-v4-timeline-scroll="true" data-v4-timeline-scroll-locked="false"
     data-markdown-table-layout-root="true">
```

- `data-row-count` / `data-total-row-count` / `data-window-row-count`: `0` on an
  empty draft; observed climbing 4 → 6 → 7 → 8 → 11 → 12 as rows rendered, and
  stable after the turn ended. A row append is the sharpest "the transcript
  changed" event available.
- `data-render-unit-count`: `1` for a lone user row, `2`+ once an assistant
  reply exists.
- `data-following`: `true` while the view is pinned to the bottom.
- `data-v4-timeline-scroll-locked`: `false` in every state observed.
- `data-loading-older`: `false` in every state observed.
- Rows themselves: `div[data-testid^="v4-row-"]`, with indices observed as
  `v4-row-2`, `v4-row-4`, … (even numbers, gaps are normal).
- Completed assistant turns additionally expose
  `button[data-testid^="chat-assistant-history-trigger-"]` with
  `data-history-open="false"` whose label reads `已工作 N 秒` — `TEXT_BASED (weak)`.

Fail-soft: any of these attributes may be absent on a future build. The composite
in F1 does not depend on them, and the counters must only ever be used to *derive
events* (row added) — never to decide correctness.

### 3.3 Approval requested and decided

**Approval requested** is legible without any text:

```html
<div data-tool-call-id="call_9109c7e…" data-tool-name="Write"
     data-testid="chat-tool-call-block-call_9109c7e…"
     data-status="pending">正在写入zct-probe-note.txt+1</div>

<div data-slot="collapsible">
  <button data-testid="tool-summary-trigger-permission:perm_edfe49a3-…"
          title="Write" role="button" aria-expanded="false"
          aria-label="展开工具详情" data-state="closed"
          data-slot="collapsible-trigger">等待确认zct-probe-note.txt+1</button>
  <div role="listbox" aria-label="需要权限">
    <button data-permission-option-kind="allowOnce"   role="option" aria-selected="true"  aria-label="允许">…</button>
    <button data-permission-option-kind="allowAlways" role="option" aria-selected="false" aria-label="始终允许本项目">…</button>
    <button data-permission-option-kind="rejectOnce"  role="option" aria-selected="false" aria-label="拒绝">…</button>
  </div>
  <button data-slot="button" data-variant="default" data-size="lg" aria-label="确认">确认</button>
</div>
```

Observed live during prompt 5 (a file write), together with these facts:

1. **The permission card appears inline in the transcript/bottom-dock**, not as a
   modal: there was **no** `[role="dialog"]`, `[role="alertdialog"]`,
   `[data-slot="dialog-content"]` or `[data-state="open"]` dialog anywhere while
   the approval was pending. Any code that looks for an alert dialog for
   approvals will never fire on this build.
2. The tool block's own `data-status` stays `pending` for as long as the decision
   is outstanding, and its header testid switches from
   `tool-summary-trigger-call_<id>` to `tool-summary-trigger-permission:perm_<uuid>`.
3. **Selecting an option is not deciding.** Clicking
   `[data-permission-option-kind="allowOnce"]` left the card up, all three options
   present and `aria-selected` unchanged; the decision was applied only by
   clicking the card's confirm control. A client that wants to *observe* the
   decision does not need to click anything — it disappears.
4. **Approval decided** is observed as: `[data-permission-option-kind]` count 3 → 0,
   `[data-testid^="tool-summary-trigger-permission:"]` count 1 → 0, and the tool
   block's `data-status` moving `pending` → `completed` (one second later, with
   the block text changing from `正在写入…` to `写入…`). The `data-running` turn
   flag and `data-input-routing="enqueue"` stay set across the whole approval
   wait: **an approval wait is still a running turn.**

Fail-soft: treat `[data-permission-option-kind]` as the presence test; if a
future build drops it, the `tool-summary-trigger-permission:` prefix is the second
candidate. Neither may be inferred from dialog roles. A client must never click
anything on its own authority — the option set (`allowOnce`, `allowAlways`,
`rejectOnce`) is the user's decision surface.

### 3.4 Tool call rendered

```html
<div data-testid="chat-tool-call-block-call_9109c7e4324a40ba88da1114"
     data-tool-call-id="call_9109c7e4324a40ba88da1114"
     data-tool-name="Write" data-status="pending">正在写入zct-probe-note.txt+1</div>
```

- Container: `[data-testid^="chat-tool-call-block-"]`, also selectable as
  `[data-tool-call-id]`.
- `data-tool-name` was observed as `Bash` and `Write` (the value falls back to the
  call kind in the bundle).
- `data-status` was observed as `pending` (call in flight: `正在执行…` /
  `正在写入…`) and `completed`. **`error` was never observed on a tool block** —
  see §4.
- The block sits inside a transcript row (`div[data-testid^="v4-row-"]`) and its
  header is `button[data-testid^="tool-summary-trigger-"]` with
  `data-slot="collapsible-trigger"`, `aria-expanded`, `aria-label="展开工具详情"`.
- Counting `[data-tool-call-id]` is the correct way to detect "a call happened";
  `PROGRESS_SELECTORS`-style reasoning selectors do not fire for a tool call.

Fail-soft: a missing tool block must not stop the watcher; the composite in F1 and
the row counters still describe the turn.

### 3.5 Reasoning / progress steps

```html
<button data-testid="chat-reasoning-trigger" data-slot="collapsible-trigger"
        aria-expanded="false" data-state="closed">
  <span>…</span>
  <span data-reasoning-streaming-text="true">The user wants a 900-word essay about…</span>
</button>
```

- `[data-testid="chat-reasoning-trigger"]` is the reasoning block header
  (`data-slot="collapsible-trigger"`, collapsed by default).
- `[data-reasoning-streaming-text="true"]` is emitted **per streaming line** while
  the model writes reasoning: 10 such spans were live at once during the essay
  run. It is the only attribute-backed element of the status strip.
- **Conditional**: a run that produces no reasoning emits none of these. During
  prompts 6–7 (plain counting) `[data-reasoning-streaming-text]` never appeared
  even though the turn was running. Use it to detect *reasoning progress*, never
  as the running signal.

### 3.6 The status line — `PARTIAL`

What was observed live, mid-run, in the strip above the composer (leaf elements,
with their geometry in the composer's band):

```html
<span>正在思考</span>                                  <!-- no attributes  -->
<span>·</span>                                         <!-- separator       -->
<span data-reasoning-streaming-text="true">The user wants …</span>
<div>继续输入以排队后续修改</div>                        <!-- no attributes  -->
```

- `[data-reasoning-streaming-text="true"]` is the only structural handle in that
  line (it is also S3's sibling, not its container).
- `正在思考` ("thinking") and `继续输入以排队后续修改` ("keep typing to queue a
  follow-up") have **no attributes at all**: they are `TEXT_BASED (weak)` and
  must never be the sole signal.
- **The line's container element and its ARIA live attributes were NOT
  OBSERVED.** The run ended before the container could be captured. What can be
  said structurally is where the line is *not*: it is not inside
  `[data-testid="chat-loading"]`, and it is not an `aria-live` region.
- **Negative result that matters**: across every sample taken, the document's
  only `aria-live` regions were the two invisible drag-and-drop announcers
  `div#DndLiveRegion-0` / `div#DndLiveRegion-1`
  (`role="status" aria-live="assertive"`, 1×1 px, empty text). **There is no
  `[aria-live="polite"]` anywhere in the observed document**, and the two
  `role="status"` elements that carry run state are `chat-loading` (no
  `aria-live`) and those announcers. Any selector list that requires
  `[aria-live="polite"]` will match nothing on 3.12.3.
- Fail-soft for a status-line takeover: with the container unverified, the safe
  behaviour is to take over only an element that (a) matched one of the
  candidates, (b) is non-empty, and (c) was re-checked on the next tick — and to
  leave the native text in the DOM. If nothing matches, do nothing.

### 3.7 Empty-chat greeting — confirmed unchanged on 3.12.3

```html
<div data-testid="chat-empty" class="w-full">
  <div>
    <div aria-hidden="true">… <img data-v4-draft-logo="dark"> …</div>
    <p data-v4-draft-greeting="true" style="--v4-draft-greeting-font-size: 30px;">
      <span aria-hidden="true" class="… invisible absolute whitespace-nowrap …">晚上好呀，今天辛苦啦</span>
      <span>晚上好呀，今天辛苦啦</span>
    </p>
  </div>
</div>
<div data-v4-draft-suggested-prompts="true">…</div>
```

The `zcode-dom-notes.md` §7 findings all still hold on 3.12.3: the selector
matches, the two-span structure with the `aria-hidden` measuring twin is intact,
`--v4-draft-greeting-font-size` resolves to `30px`, the greeting text is
time-dependent (observed `晚上好呀，今天辛苦啦`), the visible Z graphic is
`img[data-v4-draft-logo]`, and the surrounding screen is
`[data-testid="chat-empty"]`. The user-turn rows are nearby helpers:
`p[data-v4-draft-greeting]` sits inside `[data-testid="chat-empty"]` at the same
672 px column width as the composer.

One new observation: the greeting **disappears on submit** — the transition
`greeting: true → false` was recorded in the same tick as
`editorTextLength: 87 → 0`. It is a draft-screen anchor only.

### 3.8 Layout anchors (composer, sidebar, account area)

Verified on the live tree, 1366×900 class window:

```
[data-testid="conversation-column"] > div > div[data-testid="_r_1e_"] > div[data-testid="conversation"]
  > div > section[data-workspace-conversation-frame="true"] > div > main
  > div[data-testid="v4-pane-shell-workspace-main"][data-pane-id="workspace-main"][data-focused="true"][data-restored-unvalidated="false"]
  > div[data-testid="v4-session-pane-workspace-main"][data-session-id="…"][data-projection-seq="…"]
  > div > div > div[data-testid="v4-timeline"]
  > … > div[data-testid="conversation-bottom-dock-transition"]
  > div[data-testid="conversation-bottom-dock-transition-layer"][data-conversation-bottom-dock-mode="chat"]
  > div[data-testid="v4-composer"][data-input-routing="startNow"]
     > div > form > … > div[data-testid="v4-composer-input"][contenteditable="true"][data-lexical-editor="true"][data-e2e-lexical-bridge="ready"]
     > … buttons: [data-testid="composer-workspace-trigger"] {aria-label="选择项目"}
                  [data-testid="chat-attachment-button"]
                  [data-testid="chat-mode-select-trigger"]
                  [data-testid="chat-model-select-trigger"][data-model-current-value="custom:…"]
                  [data-testid="chat-thought-level-select-trigger"]
                  [data-testid="chat-context-usage-trigger"]   (only while a turn exists)
                  [data-testid="v4-composer-send"] | [data-testid="v4-stop"]
```

- The composer form also carries `span[data-testid="v4-model-config"]` with
  `data-mode="build"`, `data-thought="max"`, `data-thought-levels="low,high,max"`,
  `data-plan-enabled="false"`, `data-provider`, `data-model`, `data-usage-used`,
  `data-usage-max` — mode/thinking/usage, useful for a status display.
- Simulated-prompt buttons on the draft screen:
  `span[data-draft-suggested-prompt-text="true"]` (plus `-icon`), inside
  `[data-v4-draft-suggested-prompts]`, and each has `data-draft-suggested-prompt="item-…"`.
- Sidebar: `aside[data-testid="sidebar"]` (264 px wide, full height) containing
  `[data-testid="task-new-button"]`, `[data-testid="conversation-section"]`,
  `[data-testid="conversation-new-task"]`, `[data-testid="task-list"]`,
  `[data-testid="task-empty"]`, `[data-testid="workspace-list"]` and
  `[data-testid="workspace-item-…"]`. The sidebar uses
  `data-purpose-section-list`, `data-purpose-section-chevron`, and
  `[data-slot="collapsible"][data-state="open"|"closed"]` per section.
- **Account area (bottom-left):** `aside[data-testid="sidebar"] > div > div > footer`
  measured `{top: 844, left: 0, w: 264, h: 56}` at a 900 px viewport, holding
  `button[data-testid="login-trigger"][aria-label="连接使用"]`
  (`{top: 852, left: 16, w: 158, h: 32}`, `data-slot="dropdown-menu-trigger"`,
  `data-state="closed"`) and `div[data-slot="avatar"][data-size="default"]`
  (32×32). The footer's own text is `连接使用移动端远程控制`, whose first part is the
  account control and whose second part is a mobile-remote-control entry.
  **Caveat:** this scratch instance is not signed in to a ZCode account (the row
  offers "connect to use"), so the *signed-in* variant of that row was not
  observed; the stable anchors are the `footer` under `[data-testid="sidebar"]`
  and `[data-testid="login-trigger"]` / `[data-slot="avatar"]`.

---

## 4. What was NOT observed

Stated plainly so nobody builds on an assumption:

| Item | Status | Notes |
|---|---|---|
| Error turn | `NOT OBSERVED` | A failing command (`zct-nonexistent-cmd-12345`) was run through the Bash tool; the block reported `data-status="completed"` and no error element appeared. The only `data-status` values ever seen live are `pending` and `completed`. |
| Interrupt / abort | `NOT OBSERVED` | The stop control was found and clicked at the moment the run had already ended (`{"clicked":false,"reason":"no stop control"}`). No aborted-state DOM sample exists. |
| `[data-state="error"]` | `NOT OBSERVED` | The complete set of `data-state` values observed over all samples: `inactive`, `active`, `closed`, `off`, `open`. |
| `[data-status="error"]` | `STATIC ONLY` | Present in the bundle on a *section* status component (`data-status` = `loading` / `error`), not on a tool block. No live match. |
| `[data-testid="chat-summary-panel"]` | `STATIC ONLY` | Bundle only: `data-state="collapsed"｜"expanded"`, `data-display-mode`, `data-goal-status`, `data-goal-objective`, `data-running-background-count`, `data-running-terminal-count`, `data-running-agent-count`. It never mounted in any session here (no background works). If a client wants a "background work running" signal, this is the element to verify first. |
| Status-line container and its ARIA live attributes | `NOT OBSERVED` | See §3.6. Only its leaf text elements were captured. |
| Subagent run state | `NOT OBSERVED` | `data-running-subagent-ids` / `data-running-subagent-work-ids` were `""` in every sample. |
| Signed-in account row | `NOT OBSERVED` | The scratch instance's account row is the signed-out variant. |
| Real-store isolation, post-hoc | `PARTIAL` | Five of six credential files were byte-identical before and after; `setting.json` gained ~400 B at 21:08 (see §1.1). The write is unattributed: the user's own client was live and is the likely writer, but this was not proven. |

---

## 5. Reconciliation with the selector tables now in `src/`

For every table currently shipped in `src/client/signals/detect.ts` and
`src/client/status/anchor.ts`, what the live renderer said. Entries are grouped
by verdict; nothing was edited in `src/` by this investigation.

### `ACTIVITY_ROOTS`

| Entry | Verdict |
|---|---|
| `[data-zct-transcript]` | **Never matched.** Not an attribute ZCode emits. |
| `[data-slot="message-list"]` | **Never matched.** No such slot value exists in the live tree. |
| `[role="log"]` | **Never matched.** Zero occurrences; the transcript is not a log region. |
| `main` | **Matched, 1 occurrence**, and it is a genuine ancestor of the transcript (`section > div > main > div > [data-testid="v4-pane-shell-workspace-main"]`). Coarse but real, and a safe fallback. |
| **(missing)** | `[data-testid="v4-timeline"]` — the actual transcript container, 1 occurrence, carries every row counter and the scroll flags. This should be first in the list. |

### `RUNNING_SELECTORS`

| Entry | Verdict |
|---|---|
| `[data-state="streaming"]` | **Never matched.** `streaming` was never a `data-state` value on any element. |
| `[data-zct-running="1"]` | **Never matched.** Invented attribute. |
| `[data-slot="stop-button"]` | **Never matched.** No such slot value. |
| `[aria-label="Stop"]` | **Never matched.** |
| `[aria-label="停止"]` | **Never matched** — the real control is `aria-label="停止生成"`, and matching localised text is the wrong handle anyway. |
| **(verified replacements)** | `[data-testid="v4-stop"]` (presence); `[data-testid="v4-composer"][data-input-routing="enqueue"]`; `[data-testid="chat-loading"]`; `[data-testid^="v4-turn-navigator-item-"][data-running="true"]`. |

### `APPROVAL_SELECTORS`

| Entry | Verdict |
|---|---|
| `[data-slot="approval-request"]` | **Never matched.** |
| `[data-zct-approval="1"]` | **Never matched.** |
| `[role="alertdialog"][data-state="open"]` | **Never matched** — and would not: the approval is inline, no dialog is opened. |
| `[data-slot="alert-dialog-content"][data-state="open"]` | **Never matched**, same reason. |
| **(verified replacements)** | `[data-permission-option-kind]` (presence, and the option set `allowOnce`/`allowAlways`/`rejectOnce`); `[data-testid^="tool-summary-trigger-permission:"]`; the card's `div[role="listbox"]`. |

### `ERROR_SELECTORS`

| Entry | Verdict |
|---|---|
| `[data-slot="error-banner"]` | **Never matched** (no error turn was produced; also no such slot value was ever rendered). |
| `[data-zct-error="1"]` | **Never matched.** |
| `[role="alert"][data-variant="destructive"]` | **Never matched** (no `role="alert"` element existed in any live sample). |
| `[data-state="error"]` | **Never matched.** |
| **(candidate to verify)** | `[data-status="error"]` exists in the bundle for a section status component (`STATIC ONLY`); tool blocks use `data-status` and could plausibly gain `error`, but that was not observed. Keep this table obviously unverified. |

### `TOOL_SELECTORS`

| Entry | Verdict |
|---|---|
| `[data-slot="tool-call"]` | **Never matched.** |
| `[data-zct-tool-call="1"]` | **Never matched.** |
| `[data-testid="tool-call"]` | **Never matched** (the real test id is prefixed and per call). |
| **(verified replacement)** | `[data-tool-call-id]` or `[data-testid^="chat-tool-call-block-"]`, with `data-tool-name` and `data-status` on the same element. |

### `PROGRESS_SELECTORS`

| Entry | Verdict |
|---|---|
| `[data-slot="reasoning"]` | **Never matched.** |
| `[data-zct-reasoning="1"]` | **Never matched.** |
| `[data-slot="thinking"]` | **Never matched.** |
| **(verified replacement)** | `[data-reasoning-streaming-text]` (present only while reasoning streams) and `[data-testid="chat-reasoning-trigger"]` (the reasoning block header). Because a run may produce reasoning never, both are conditional: counting them is fine for "progress happened", never for "running". |

### `STATUS_SELECTORS`

| Entry | Verdict |
|---|---|
| `[data-zct-status-host] [role="status"]` | **Never matched.** |
| `[data-slot="composer"] [role="status"][aria-live="polite"]` | **Never matched** — the composer is `[data-testid="v4-composer"]`, not a `data-slot`; and no `[aria-live="polite"]` exists in the document at all. |
| `[role="status"][aria-live="polite"]:not([id])` | **Never matched.** Document-wide there are exactly two `aria-live` elements (`#DndLiveRegion-0/1`, `assertive`, 1×1 px, empty), and the run-state `role="status"` elements carry no `aria-live`. |
| `[data-slot="composer"] [role="status"]` | **Never matched.** |
| **(observed substitutes)** | The status line's leaves: `[data-reasoning-streaming-text="true"]` plus unattributed `span`/`div` text (`TEXT_BASED (weak)`). The container is `NOT OBSERVED`. |

**Consequence for the status takeover:** on 3.12.3 no candidate in
`STATUS_SELECTORS` matches, so the takeover currently cannot engage — which is
the designed fail-soft outcome, not a defect. Before adding a selector, note that
the two `role="status"` elements that *do* exist in a live turn are the boot
loading overlay (`#loading`, correctly excluded) and `chat-loading` (an invisible
spinner inside the transcript, not a text line). The verify step is one command
(§6).

---

## 6. Reproducing this investigation

```bash
# 1. full cycle: launch an isolated instance, run one prompt, watch it, close, clean up
node tools/probe-signals.mjs session \
  --prompt "reply with the single word OK" --seconds 45 \
  --out "%TEMP%/zct-ok.json"

# 2. keep an instance alive and drive it step by step
node tools/probe-signals.mjs launch --port 9463 --scratch "%TEMP%/zct-probe"
node tools/probe-signals.mjs snapshot --port 9463 --out "%TEMP%/idle.json"
node tools/probe-signals.mjs watch --port 9463 --seconds 60 --out "%TEMP%/watch.json"
node tools/probe-signals.mjs send  --port 9463 --text "Count from 1 to 40, one number per line."
node tools/probe-signals.mjs eval  --port 9463 --expr "document.querySelector('[data-testid=\"v4-timeline\"]').outerHTML"
node tools/probe-signals.mjs close --port 9463 --scratch "%TEMP%/zct-probe"
```

The status-line container is the one open item; this is the command that closes
it (run while a turn is streaming, i.e. in the first seconds after a `send`):

```bash
node tools/probe-signals.mjs eval --port 9463 --expr "$(cat <<'JS'
(function(){
  var r = document.querySelector('[data-reasoning-streaming-text]');
  if (!r) return { found: false };
  var chain = [], c = r;
  for (var i = 0; i < 7 && c; i++) {
    var o = {}; for (var j = 0; j < c.attributes.length; j++) {
      var a = c.attributes[j]; if (a.name !== 'class') o[a.name] = String(a.value).slice(0,80);
    }
    chain.push({ tag: c.tagName.toLowerCase(), attrs: o }); c = c.parentElement;
  }
  return { found: true, chain: chain };
})()
JS
)"
```

Anything found there should be appended to §3.6 and to `STATUS_SELECTORS` with the
same fail-soft rules: prefer an attribute over text, never require
`aria-live="polite"`, and do nothing when nothing matches.

The same recipe re-verifies every table in §5 after a ZCode update: `session`
produces an idle snapshot, a transition timeline with timestamps, and the
post-turn snapshot in one run, and the report records the real-store tripwire
result so an isolation failure is visible rather than silent.
