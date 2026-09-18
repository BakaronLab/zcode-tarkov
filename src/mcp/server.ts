/**
 * MCP server exposing zcode-tarkov to the ZCode agent:
 * the model can set a wallpaper / re-theme / reset on the user's behalf.
 */

import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { applyColorsOnly, applyWallpaper, reapplyStored, resetAppearance } from "../core/session.js";
import { isZcodeProcessRunning, loadConfig } from "../core/launch.js";
import { DEFAULT_CONFIG } from "../core/inject.js";
import { migrateColorMode } from "../core/colorMode.js";
import { listTargets, pickRendererTargets } from "../core/cdp.js";
import { getAutostartStatus, installAutostart, uninstallAutostart } from "../core/autostart.js";
import { loadRecovery, setRecoveryMode } from "../core/recovery.js";
import { repairLaunchers } from "../core/launchers.js";
import { describeStartupRepair, repairLaunchersIfZcodeLostTheFlag } from "../core/startupRepair.js";

// Substituted at bundle time by scripts/bundle.mjs from package.json.
declare const __PLUGIN_VERSION__: string;

const server = new McpServer({
  name: "zcode-tarkov",
  version: __PLUGIN_VERSION__,
});

server.registerTool(
  "set_background",
  {
    title: "Set ZCode wallpaper",
    description:
      "Set the ZCode desktop client's background wallpaper image. The UI palette follows the current color mode: monet (Material Design 3 dynamic color from the wallpaper), tarkov (fixed Tarkov-inspired palette, unaffected by the wallpaper), or native (ZCode's own colors). ZCode must be running with the CDP debug port (see zcode-tarkov launch).",
    inputSchema: {
      image_path: z.string().describe("Absolute path of the image to use as wallpaper"),
      blur: z.number().min(0).max(100).optional().describe("Wallpaper blur radius in px (default 0)"),
      dim: z.number().min(0).max(100).optional().describe("Wallpaper darkening 0-100 (default 25)"),
      color_mode: z
        .enum(["monet", "tarkov", "native"])
        .optional()
        .describe("Palette to use; omit to keep the current mode"),
    },
  },
  async ({ image_path, blur, dim, color_mode }) => {
    try {
      const { windows, config } = await applyWallpaper(image_path, {
        blur,
        dim,
        colorMode: color_mode,
      });
      return {
        content: [{ type: "text", text: `Wallpaper applied to ${windows} window(s) with the "${config.colorMode}" palette.` }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Failed: ${(err as Error).message}` }], isError: true };
    }
  }
);

server.registerTool(
  "apply_options",
  {
    title: "Tune ZCode appearance",
    description:
      "Adjust the live ZCode appearance without changing the wallpaper: blur radius, dim level, color mode (monet | tarkov | native), and wallpaper visibility (translucent vs opaque surfaces). Only the provided values change; the rest keep their current setting.",
    inputSchema: {
      blur: z.number().min(0).max(100).optional().describe("Wallpaper blur radius in px"),
      dim: z.number().min(0).max(100).optional().describe("Wallpaper darkening 0-100"),
      color_mode: z
        .enum(["monet", "tarkov", "native"])
        .optional()
        .describe(
          "monet: derive UI colors from the wallpaper; tarkov: fixed Tarkov palette; native: keep ZCode's original colors"
        ),
      monet: z
        .boolean()
        .optional()
        .describe("Legacy alias for color_mode (true = monet, false = native); ignored when color_mode is given"),
      wallpaper_visible: z.boolean().optional().describe("Translucent surfaces showing the wallpaper (true) or opaque surfaces (false)"),
      fit: z.enum(["cover", "contain", "smart"]).optional().describe("Framing: cover fills and crops, contain letterboxes with a blurred backdrop, smart analyzes the picture locally and picks the best framing + focus point"),
    },
  },
  async ({ blur, dim, color_mode, monet, wallpaper_visible, fit }) => {
    try {
      const windows = await applyColorsOnly({
        blur,
        dim,
        colorMode: color_mode,
        monet,
        wallpaperVisible: wallpaper_visible,
        fit,
      });
      return { content: [{ type: "text", text: `Appearance updated in ${windows} window(s).` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Failed: ${(err as Error).message}` }], isError: true };
    }
  }
);

server.registerTool(
  "refresh_theme",
  {
    title: "Refresh ZCode theme",
    description:
      "Re-inject the stored wallpaper and color mode into the running ZCode client (e.g. after the app was restarted).",
    inputSchema: {},
  },
  async () => {
    try {
      const windows = await reapplyStored();
      return { content: [{ type: "text", text: `Theme re-injected into ${windows} window(s).` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Failed: ${(err as Error).message}` }], isError: true };
    }
  }
);

server.registerTool(
  "reset_appearance",
  {
    title: "Reset ZCode appearance",
    description: "Remove the wallpaper and color overrides, restoring ZCode's default appearance.",
    inputSchema: {},
  },
  async () => {
    try {
      await resetAppearance();
      return { content: [{ type: "text", text: "Appearance restored to default." }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Failed: ${(err as Error).message}` }], isError: true };
    }
  }
);

server.registerTool(
  "beautify_status",
  {
    title: "Beautify status",
    description: "Report the stored zcode-beautify configuration.",
    inputSchema: {},
  },
  async () => {
    const cfg = loadConfig();
    return { content: [{ type: "text", text: JSON.stringify(cfg, null, 2) }] };
  }
);

server.registerTool(
  "recovery_status",
  {
    title: "How the theme comes back",
    description:
      "Report what happens to the wallpaper and colors after ZCode restarts, whether the autostart entry is in place, " +
      "and whether the CDP port is currently reachable.",
    inputSchema: {},
  },
  async () => {
    const stored = loadConfig();
    const port = stored.port ?? DEFAULT_CONFIG.port;
    const autostart = getAutostartStatus();

    let cdp: { reachable: boolean; renderers: number; error?: string };
    try {
      const targets = pickRendererTargets(await listTargets(port));
      cdp = { reachable: true, renderers: targets.length };
    } catch (err) {
      cdp = { reachable: false, renderers: 0, error: (err as Error).message };
    }

    const report = {
      mode: loadRecovery().mode,
      modes: {
        off: "nothing automatic; re-apply manually with /beautify",
        "on-start": "the MCP host restores the theme once when ZCode starts — no resident process",
        always: "an autostarted service keeps the theme and the settings panel alive (costs ~60 MB)",
      },
      autostart: {
        supported: autostart.supported,
        installed: autostart.installed,
        entry: autostart.entryPath,
        note: autostart.note,
      },
      cdp,
      theme: {
        wallpaperSet: Boolean(stored.wallpaperPath),
        blur: stored.blur,
        dim: stored.dim,
        colorMode: migrateColorMode(stored),
        monet: stored.monet,
        fit: stored.fit,
      },
    };
    return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
  }
);

server.registerTool(
  "set_recovery_mode",
  {
    title: "Choose how the theme is restored",
    description:
      "The injected theme is lost every time ZCode restarts, so pick who brings it back. " +
      "'off': nothing automatic. 'on-start' (default): restore once when ZCode starts, no resident process. " +
      "'always': also install an autostart entry for the resident service, so the theme AND the settings panel stay " +
      "available at the cost of a background node process (~60 MB, 0.3% of one core). Setting 'always' registers the " +
      "autostart entry; any other mode removes it.",
    inputSchema: {
      mode: z.enum(["off", "on-start", "always"]).describe("Recovery mode to store"),
    },
  },
  async ({ mode }) => {
    const stored = loadConfig();
    const cdpPort = stored.port ?? DEFAULT_CONFIG.port;
    setRecoveryMode(mode);

    let note = "";
    if (mode === "always") {
      const cliPath = fileURLToPath(new URL("../cli.js", import.meta.url));
      const status = installAutostart({ nodePath: process.execPath, cliPath, cdpPort, apiPort: 9223 });
      note = status.installed
        ? ` Autostart registered at ${status.entryPath} (it takes effect from the next sign-in).`
        : ` Could not register autostart${status.note ? `: ${status.note}` : ""}.`;
    } else if (getAutostartStatus().installed) {
      uninstallAutostart();
      note = " Removed the autostart entry.";
    }
    return { content: [{ type: "text", text: `Recovery mode is now "${mode}".${note}` }] };
  }
);

server.registerTool(
  "repair_launchers",
  {
    title: "Fix ZCode launch entries",
    description:
      "ZCode only opens its CDP port when it is started with --remote-debugging-port, and that flag has to come from the " +
      "shortcut or handler that launches it. A machine usually has several launch entries and only some carry the flag. " +
      "This scans the desktop, Start Menu and pinned taskbar shortcuts plus the zcode:// protocol and Explorer " +
      "context-menu verbs, and adds the flag where it is missing. Shortcuts are the durable entries: ZCode's updater " +
      "rebuilds the Start Menu shortcut without the flag, while the app re-registers its registry handlers on every " +
      "start. Machine-wide entries that need administrator rights are reported, not modified.",
    inputSchema: {
      dry_run: z.boolean().optional().describe("Only report what would change; write nothing"),
    },
  },
  async ({ dry_run }) => {
    const stored = loadConfig();
    const port = stored.port ?? DEFAULT_CONFIG.port;
    const report = await repairLaunchers({ port, dryRun: dry_run });

    if (report.error) {
      return { content: [{ type: "text", text: `Could not scan launch entries: ${report.error}` }], isError: true };
    }

    const updated = report.fixes.filter((f) => f.status === "updated");
    const failed = report.fixes.filter((f) => f.status === "failed");
    const lines = [
      report.dryRun
        ? `Dry run on port ${port}: ${updated.length} of ${report.fixes.length} entry(ies) would be updated.`
        : `Updated ${updated.length} of ${report.fixes.length} launch entry(ies) to include --remote-debugging-port=${port}.`,
      ...report.fixes.map((f) => `  [${f.status}] ${f.path}${f.reason ? ` — ${f.reason}` : ""}`),
    ];
    if (failed.length > 0) {
      lines.push(
        "Entries marked failed are machine-wide and need administrator rights; launch ZCode from one of the updated shortcuts instead."
      );
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

/**
 * ZCode recreates its renderer on every restart, which drops the injected theme.
 * The plugin host spawns this server right after the app comes up, so it is the
 * one place that can put the theme back without a resident daemon. Runs after
 * the MCP handshake so tool calls are never delayed by it.
 */
async function restoreAfterStart(): Promise<void> {
  if (loadRecovery().mode !== "on-start") return;
  if (!loadConfig().wallpaperPath) return;

  // The renderer may not exist yet when the plugin host first calls us.
  for (let attempt = 0; attempt < 6; attempt++) {
    await new Promise((r) => setTimeout(r, attempt === 0 ? 8000 : 5000));
    try {
      if ((await reapplyStored()) > 0) return;
    } catch {
      /* CDP not up yet, or ZCode started without the debug port */
    }
  }

  // The theme never came back. If ZCode is running but its CDP port is closed,
  // the entry that started it probably lost --remote-debugging-port: the app
  // cannot add the flag to itself, and its updater rebuilds the Start Menu
  // shortcut without it. Repair the entries once so the next start is healthy.
  try {
    const port = loadConfig().port ?? DEFAULT_CONFIG.port;
    const outcome = await repairLaunchersIfZcodeLostTheFlag({
      port,
      probeCdp: async () => {
        try {
          await listTargets(port);
          return true;
        } catch {
          return false;
        }
      },
      probeZcode: isZcodeProcessRunning,
      repair: repairLaunchers,
    });
    // stdout carries the MCP protocol; the launcher-repair lines go to stderr.
    for (const line of describeStartupRepair(outcome)) console.error(line);
  } catch {
    /* a startup repair must never take the MCP server down */
  }
}

await server.connect(new StdioServerTransport());
void restoreAfterStart();
