# Owner playtest — deployment evidence

Preparation record for the first owner-visible playtest of `zcode-tarkov` v0.1.

## Status

```
CURRENT ZCODE WAS NOT RESTARTED BY AGENT
OWNER PLAYTEST NOT YET PERFORMED
GATE: READY_FOR_OWNER_RESTART
```

The running ZCode instance was never closed, killed, or relaunched. The agent
session is itself hosted by that instance, so a restart would have terminated
the task and discarded unsaved state. Anything that needs a restart is left for
the owner to do.

## Candidate

| | |
|---|---|
| Repository | `F:\WSL\workspace\zcode-tarkov` |
| Branch | `main` |
| HEAD | `c5099b286195ca79c36227c1544084d810143e18` |
| Upstream base | `8639446a4534be667a8fa76ea7757c139ee9df71` (zcode-beautify v0.3.1) |
| Reference | `be1123c1c158e58ba0aa1c311c22d793b09f9c0d` (dsh-theme-tarkov v0.2.0) |
| Repo status at freeze | clean (`repo-status.txt`) |
| Build / tests / bundle | `tsc` clean; 71/71 unit tests pass; bundles regenerated to identical hashes, so `dist/` provably matches `src/` |
| `dist/cli.js` | 3 916 931 bytes, sha256 `339798F558444E35…` |
| `dist/mcp/server.js` | 4 897 308 bytes, sha256 `EB5FE52F292A798D…` |

## What was changed on this machine

All changes are **user-level only**. No elevation, no UAC, no ZCode
installation files, no `app.asar`, no machine-wide shortcuts, no global npm
installs.

### 1. Plugin registration (real ZCode plugin environment)

Registered as a local marketplace and installed plugin, using the shapes ZCode
itself writes. Files touched (all under `%USERPROFILE%\.zcode\cli\`):

| File | Before | After |
|---|---|---|
| `config.json` | sha256 `DFE5DE75…` — only `github@zcode-plugins-official` enabled | sha256 `0A0BDE37…` — adds `zcode-tarkov@zcode-tarkov: true` |
| `plugins/known_marketplaces.json` | sha256 `631714AF…` — 2 marketplaces | sha256 `02630E44…` — adds `zcode-tarkov` as a `directory` source |
| `plugins/installed_plugins.json` | **absent** | sha256 `DB6447D8…` — records the installed plugin |
| `plugins/marketplaces/zcode-tarkov/marketplace.json` | absent | created (cached manifest) |
| `plugins/cache/zcode-tarkov/zcode-tarkov/0.1.0/` | absent | created (plugin content: `dist`, `commands`, `skills`, `.zcode-plugin`) |

Verified with ZCode's own resolver — `zcode plugins list` now reports **9**
plugins (was 8), including:

```
- zcode-tarkov@zcode-tarkov [enabled]
  cache/zcode-tarkov: …\plugins\cache\zcode-tarkov\zcode-tarkov\0.1.0
  skills: 1, commands: 1, hooks: 0, mcp: plugin:zcode-tarkov:zcode-tarkov
```

No diagnostics. The command, skill and MCP server all resolve. The plugin
manifest points at version `0.1.0` and the name `zcode-tarkov`; the MCP env var
keeps its original `ZCODE_BEAUTIFY_DATA_DIR` name deliberately, for
compatibility with existing installs.

Evidence: `before-config.json`, `before-known_marketplaces.json`,
`after-config.json`, `after-known_marketplaces.json`,
`after-installed_plugins.json`, `after-plugin-registration.json`,
`after-plugins-list.json`, `after-plugins-list.txt`.

### 2. Launcher repair (user-level entries only)

`repair-launchers --dry-run` proposed 6 changes, 2 of which are machine-wide and
therefore out of scope:

```
[dry-run] user Start Menu\Programs\ZCode.lnk ............... USER
[dry-run] C:\Users\Public\Desktop\ZCode.lnk ................ MACHINE-WIDE (skipped)
[dry-run] C:\ProgramData\...\Programs\ZCode.lnk ............ MACHINE-WIDE (skipped)
[dry-run] HKCU:\Software\Classes\zcode\shell\open\command .. USER
[dry-run] HKCU:\...\Directory\shell\ZCode.OpenInZCode\... .. USER
[dry-run] HKCU:\...\Drive\shell\ZCode.OpenInZCode\command .. USER
```

The upstream command has no user-only filter, so the repair was performed with a
minimal explicit script (`launcher-apply.ps1`) rather than by changing product
source. Applied:

| Entry | Before | After |
|---|---|---|
| user Start Menu `ZCode.lnk` | `''` | `--remote-debugging-port=9222` |
| user Desktop `ZCode Tarkov.lnk` | *(absent)* | created, `--remote-debugging-port=9222` |
| `HKCU…\zcode\shell\open\command` | `"…\ZCode.exe" "%1"` | `"…\ZCode.exe" --remote-debugging-port=9222 "%1"` |
| `HKCU…\Directory\shell\ZCode.OpenInZCode\command` | `"…\ZCode.exe" --open-workspace "%1"` | `"…\ZCode.exe" --remote-debugging-port=9222 --open-workspace "%1"` |
| `HKCU…\Drive\shell\ZCode.OpenInZCode\command` | `"…\ZCode.exe" --open-workspace "%1"` | same insertion |

**Not modified** (verified unchanged in `launcher-after.txt`):
`C:\Users\Public\Desktop\ZCode.lnk`, `C:\ProgramData\…\Programs\ZCode.lnk`.

A same-named user Desktop shortcut was tried first and produced **two identical
"ZCode" icons** (Windows merges rather than shadows them), so it was replaced
with a distinctly-named one. The desktop now shows `ZCode Tarkov` (with the
flag) and the untouched `ZCode` (without).

Revert: `launcher-revert.ps1` (removes the flag, deletes the desktop shortcut).

Evidence: `launcher-dry-run.txt`, `launcher-before.txt`, `launcher-after.txt`,
`launcher-revert.ps1`.

### 3. Recovery and background service

- Recovery mode: `on-start` → **`always`**.
- Autostart entry written:
  `…\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\zcode-beautify.vbs`
  running `node …\zcode-tarkov\dist\cli.js serve --port 9222 --api-port 9223 --detach`.
- Resident service started now (detached) so the theme applies as soon as the
  owner restarts ZCode — no sign-out needed. PID 25912, control API on
  `127.0.0.1:9223`, healthy.

Evidence: `recovery.txt`, `recovery-and-service.txt`.

### 4. Theme configuration

There was **no pre-existing `zcode-beautify` configuration** on this machine, so
nothing had to be migrated or preserved. Recorded rather than assumed: the
directories `zcode-beautify`, `zcode-beautify@zcode-beautify` and
`zcode-tarkov` do not exist; only `zcode-tarkov@zcode-tarkov` does, and it was
empty before this step.

Final config, at
`…\.zcode\cli\plugins\data\zcode-tarkov@zcode-tarkov\config.json`
(the path the plugin-scoped `${ZCODE_PLUGIN_DATA}` resolves to, so the plugin and
the resident service agree on one file):

```json
{
  "port": 9222,
  "colorMode": "tarkov",
  "monet": false,
  "blur": 0,
  "dim": 25,
  "wallpaperVisible": false,
  "fit": "cover",
  "banner": { "enabled": true, "height": 56, "opacity": 0.92, "text1": "…", "text2": "…" }
}
```

`wallpaperVisible: false` because no wallpaper image exists yet: in Tarkov mode
the window background is transparent *only while a wallpaper is actually
showing*, so with none set this yields the fully opaque Tarkov theme instead of
a transparent window. No wallpaper was downloaded, generated, or bundled; the
wallpaper feature stays available via the panel.

Config backup: none needed (nothing pre-existed). The writer backs up to
`config.json.pre-playtest.bak` if a config ever is present.

Final config hash: sha256
`E5F64A1BAE4548F74712908D6EF484FAE3077A7534D24A9AAD6E0BD688ABF871`.

Evidence: `final-config.json`.

## Not done, by design

- The currently running ZCode was **not** restarted, so it is **not** yet
  showing the theme. That is the expected state, not a failure.
- No verification was performed against the live main instance, because it has
  no debug port and gaining one requires the restart that would end this task.
- No product source was modified for deployment.

## Known cosmetic leftovers (not blocking)

These are upstream naming artifacts kept deliberately, since renaming them would
require a source change and would orphan existing entries:

- The autostart file is named `zcode-beautify.vbs`.
- The local control API identifies itself as `"service": "zcode-beautify"` on
  `/api/health`.
- The autostart script's comment header still describes the upstream plugin.

## Contents

| File | What it is |
|---|---|
| `candidate-sha.txt` | frozen HEAD |
| `repo-status.txt` | repo cleanliness at freeze |
| `before-config.json`, `before-known_marketplaces.json` | ZCode plugin config before the install |
| `after-config.json`, `after-known_marketplaces.json`, `after-installed_plugins.json` | after the install |
| `after-plugin-registration.json` | the resolved `zcode-tarkov` plugin record |
| `after-plugins-list.json`, `after-plugins-list.txt` | ZCode's own plugin listing (9 plugins) |
| `launcher-dry-run.txt` | upstream dry-run output |
| `launcher-before.txt`, `launcher-after.txt` | user-level launcher state, before/after |
| `launcher-revert.ps1` | undoes the launcher changes |
| `recovery.txt` | recovery mode before/after + autostart entry |
| `recovery-and-service.txt` | service health, config echo, restart check |
| `final-config.json` | the playtest theme config |

No credentials, API keys, or session tokens are included in any of these files.
