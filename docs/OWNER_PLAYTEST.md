# Owner playtest — zcode-tarkov v0.1

Eyeball check only. No commands to run. Just restart ZCode and walk down the list.

**Candidate:** `c5099b286195ca79c36227c1544084d810143e18`

## Before you start

Fully quit ZCode (including the tray icon), then start it again using **either**:

- the **"ZCode Tarkov"** icon on the Desktop, **or**
- the **ZCode** entry in the Start Menu.

> Both carry `--remote-debugging-port=9222`, which the theme needs. The old
> **"ZCode"** icon on the Desktop belongs to the machine-wide install and could
> not be given that flag without administrator rights — starting from it will
> show ZCode **without** the theme.

## Checklist

| # | Check | Result |
|---|---|---|
| 1 | ZCode starts normally (no error, no blank window) | |
| 2 | The UI is the **Tarkov palette**: dark brown surfaces, orange accents, warm off-white text | |
| 3 | A **settings panel** button (🎨) sits in the bottom-right corner | |
| 4 | A two-line **orange warning band** is pinned across the top | |
| 5 | Open the panel; a **UI Theme** dropdown shows Monet / Tarkov / Native | |
| 6 | Switch to **Monet** → panel turns neutral, band disappears, colors re-derive from the wallpaper | |
| 7 | Switch to **Native** → ZCode's own colors return | |
| 8 | Switch back to **Tarkov** → Tarkov palette + band return. Band appears **once** (not twice) | |
| 9 | Drag the **background blur** slider → background visibly blurs | |
| 10 | Drag the **background dim** slider → background visibly darkens | |
| 11 | Click **更换图片…** and pick any image → it becomes the background; UI colors stay Tarkov | |
| 12 | Toggle **显示壁纸** off/on → background hides and returns | |
| 13 | Text is clearly readable throughout: chat, sidebar, code blocks, menus/popovers | |
| 14 | Use the agent normally (send one real request) → the theme does not interfere | |
| 15 | Quit ZCode completely, reopen it → theme, band and panel come back **by themselves** | |

## Notes on a few items

- **Item 8** — the band must never stack into two. If you ever see two, that is a bug.
- **Item 11** — this is the first time a wallpaper is set. Until then the theme is
  deliberately opaque (there was no image to show through).
- **Item 14** — the point is that theming is cosmetic only; nothing about tool
  calls, file edits, or the working tree should change.
- **Item 15** — this is the real test of auto-recovery. If the theme does *not*
  return, the debug port is the likely cause: check you launched from
  "ZCode Tarkov" or the Start Menu.

## Recording results

Copy this and fill it in:

```
1  ZCode starts normally ............ PASS / FAIL / NOTE
2  Tarkov palette ................... PASS / FAIL / NOTE
3  settings panel present ........... PASS / FAIL / NOTE
4  beta band present ................ PASS / FAIL / NOTE
5  UI Theme dropdown ................ PASS / FAIL / NOTE
6  -> Monet ......................... PASS / FAIL / NOTE
7  -> Native ........................ PASS / FAIL / NOTE
8  -> back to Tarkov (one band) ..... PASS / FAIL / NOTE
9  blur slider ...................... PASS / FAIL / NOTE
10 dim slider ....................... PASS / FAIL / NOTE
11 change wallpaper ................. PASS / FAIL / NOTE
12 hide / show wallpaper ............ PASS / FAIL / NOTE
13 text readable (code/menu/sidebar)  PASS / FAIL / NOTE
14 agent still works normally ....... PASS / FAIL / NOTE
15 restart restores the theme ....... PASS / FAIL / NOTE

NOTE (anything that looked wrong, felt off, or you liked):
```

## If something looks wrong

Useful facts for the report, not steps to perform:

- The theme is applied by a small background service (`serve`) over the debug
  port. If it cannot reach the port, the panel shows an explicit ⚠ offline
  banner instead of silently rendering wrong values — that message is the single
  most useful clue.
- **Reset to default look:** the panel's **还原默认外观** button. It removes the
  wallpaper, colors and the orange band; ZCode returns to stock.
- **Undo the launcher changes:** run
  `evidence\owner-playtest-prep\launcher-revert.ps1`. It removes the flag from
  the user-level shortcuts and deletes the "ZCode Tarkov" desktop icon.
- The desktop icon "ZCode Tarkov" and the Start Menu flag are the only launcher
  changes. Machine-wide shortcuts were deliberately left alone.
