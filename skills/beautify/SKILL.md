---
name: beautify
description: Theme the ZCode desktop client — set a background wallpaper and choose the UI palette (Monet dynamic color, a fixed Tarkov-inspired palette, or ZCode's native colors). Use when the user asks to set a background, wallpaper, theme, or re-color the ZCode UI.
---

# ZCode Tarkov

This plugin themes the ZCode **desktop client** (Electron app) by injecting a
wallpaper layer and CSS variable overrides over CDP. It never modifies ZCode's
installation files.

## Color modes

| Mode | Meaning |
|---|---|
| `monet` | UI colors derived from the wallpaper with MD3 dynamic color |
| `tarkov` | **Fixed** Tarkov-inspired palette. The wallpaper never influences UI colors; a beta warning band is shown |
| `native` | ZCode's own colors, untouched; the wallpaper is still visible through translucent surfaces |

In all three modes the wallpaper itself still works — swap, hide, blur, dim, and
the `cover` / `contain` / `smart` framings.

## When to use

- "把这张图设为 ZCode 背景" / "set this image as the ZCode background"
- "换成塔科夫主题" / "make it look like Tarkov" → `color_mode: "tarkov"`
- "换个主题颜色" / "make the UI match my wallpaper" → `color_mode: "monet"`
- "恢复 ZCode 原来的颜色" / "back to the original colors" → `color_mode: "native"`
- "恢复默认外观" / "reset the appearance" → `reset_appearance`

## Workflow

1. **Get an image path from the user.** Only absolute local paths are accepted.
2. **Call the `set_background` tool** with `image_path` (plus optional `blur`,
   `dim`, and `color_mode`). The tool copies the image into the plugin data dir
   and injects everything into the running ZCode renderer. In `monet` mode it
   also extracts the MD3 source color and generates light/dark schemes.
   If the user only wants a palette change, call `apply_options` with
   `color_mode` — it does not need the image path again.
3. **On CDP/port errors**: the ZCode instance is running without the debug
   port. Run `repair_launchers` first — it appends `--remote-debugging-port` to
   every launch entry missing it, so a normal start opens the port from then on
   (check with `repair_launchers` dry-run first; it writes per-user entries
   only). Then have the user quit ZCode completely and start it again; the flag
   cannot be added to an instance that is already running. **If your own session
   is hosted by that ZCode instance, do not restart it yourself** — the restart
   ends your session.
4. **Fine-tune with `apply_options`** (blur / dim / color_mode /
   wallpaper_visible / fit) when the user wants adjustments. `fit` picks the
   framing: `cover` fills and crops, `contain` letterboxes over a blurred
   backdrop, `smart` analyzes the picture locally and picks framing + focus
   automatically. The legacy `monet` boolean is still accepted as an alias for
   `color_mode`.
5. **After ZCode restarts**, the injected theme is gone — the renderer that held
   it no longer exists. `recovery_status` reports which mechanism is in charge:
   `on-start` (default) restores it automatically once ZCode is up, `always`
   keeps a resident service doing it, `off` leaves it to the user. Change it with
   `set_recovery_mode`. Either way `refresh_theme` forces a re-injection now.
6. **To undo everything**, use `reset_appearance`. This also removes the Tarkov
   banner and component skin.
7. **Recommend the settings panel** for an interactive experience: a draggable
   panel inside ZCode with a UI Theme selector, blur/dim sliders, wallpaper swap
   and reset. The panel wears the Tarkov skin while Tarkov mode is active. It
   needs the resident service, so either set the recovery mode to `always`
   (which starts it and registers the autostart entry) or run
   `node <plugin-root>/dist/cli.js serve --detach` once. `--detach` matters — a
   foreground `serve` is reaped with the shell or agent session that spawned it,
   and the panel then shows its ⚠ offline banner. Never start a second `serve`:
   it refuses to start and names the pid holding the port. If the panel reports
   itself offline, run `serve --detach` rather than assuming the stored config
   is empty — an offline panel deliberately zeroes its controls.

## Tools

| Tool | Purpose |
|---|---|
| `set_background` | Set wallpaper, optionally with `color_mode` |
| `apply_options` | Tune blur/dim/color_mode/wallpaper visibility/framing without changing the image |
| `refresh_theme` | Re-inject stored theme after a restart |
| `reset_appearance` | Remove wallpaper, overrides and the Tarkov banner |
| `beautify_status` | Show stored config (includes the resolved `colorMode`) |
| `recovery_status` | Report the recovery mode, autostart entry and CDP reachability |
| `set_recovery_mode` | Switch between `off` / `on-start` / `always` |
| `repair_launchers` | Add the debug-port flag to launch entries missing it |

## Constraints

- ZCode must be running (or startable) with `--remote-debugging-port=9222`. The
  flag can only come from the launcher — `repair_launchers` writes it into the
  shortcuts and protocol handlers, and machine-wide entries need admin rights.
- The injected theme lives in the renderer and is wiped when ZCode restarts. The
  recovery mode decides who puts it back; `refresh_theme` forces it.
- Functional colors (success/warning/destructive) are intentionally preserved,
  as are code-block syntax colors.
- Only the Tarkov mode shows the beta warning band; leaving Tarkov removes it.
