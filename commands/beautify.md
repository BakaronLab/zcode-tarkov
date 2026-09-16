---
description: Set a ZCode desktop wallpaper and choose the UI color mode (Monet / Tarkov / Native)
argument-hint: "[image path or description] [theme: monet|tarkov|native]"
---

# ZCode Tarkov

The user wants to theme the ZCode desktop client. $ARGUMENTS

## Color modes

| Mode | Meaning |
|---|---|
| `monet` | UI colors derived from the wallpaper with Material Design 3 dynamic color |
| `tarkov` | Fixed Tarkov-inspired palette; **unaffected by the wallpaper**; shows the beta warning band |
| `native` | ZCode's own colors, untouched; the wallpaper is still visible through translucent surfaces |

## Steps

1. **Resolve the wallpaper image.** If a file path is given in the arguments,
   use it. Otherwise ask the user for an image path (absolute path works best).
2. **Resolve the color mode.** If the user named Tarkov, Monet or "original
   colors", map it to `tarkov` / `monet` / `native`. If they did not, leave it
   alone — `apply` keeps the currently stored mode, which is the least
   surprising behavior.
3. **Check CDP availability** by running `node <plugin-root>/dist/cli.js status`
   if available, or simply try the tool below and read the error.
4. **Apply the wallpaper** with the `set_background` MCP tool, passing the
   absolute image path plus any `blur` / `dim` / `color_mode` the user asked for.
   To change only the palette, use `apply_options` with `color_mode` instead —
   no need to re-send the image.
5. **If it fails with a CDP/port error**, the running ZCode instance was not
   started with the debug port. Tell the user to run:
   `node <plugin-root>/dist/cli.js launch`
   (this restarts ZCode with `--remote-debugging-port=9222` — ZCode sessions are
   persisted, but anything unsaved in ZCode is lost, so confirm first). Then
   retry. Note: if your own agent session is hosted by that same ZCode instance,
   the restart will end your session — tell the user to run it themselves.
6. **Fine-tune without changing the image** using the `apply_options` MCP tool
   (`blur` / `dim` / `color_mode` / `wallpaper_visible` / `fit`) when the user
   asks to adjust the look.
7. **Report the result** and mention:
   - `node <plugin-root>/dist/cli.js serve --detach` keeps a draggable settings
     panel inside ZCode for live tuning (UI Theme selector, blur/dim sliders,
     wallpaper swap, reset). Always pass `--detach`: a foreground `serve` dies
     with the shell that started it, and the panel then reports itself offline.
     Do not start a second `serve` — the CLI refuses a duplicate and names the
     pid that already owns the port;
   - switching between modes removes the Tarkov banner and the Tarkov skin
     cleanly, so no cleanup is needed;
   - `reset_appearance` restores the default look.
