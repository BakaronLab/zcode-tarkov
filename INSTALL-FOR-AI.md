# Installing zcode-tarkov — instructions for an AI agent

You are installing a **theming plugin for the ZCode desktop client**. Read this
whole file before you touch anything; the rules in "Never do these" are the
difference between a helpful install and damaging someone's machine.

Version this guide covers: **v0.2.3**.

---

## 0. Choose the path

| The user… | Path | Time |
|---|---|---|
| wants it installed in *their* ZCode, and you have **no** shell access | **Path A — marketplace UI.** Walk them through it. | ~30 s |
| wants it installed, and you **do** have shell access, or asked you to do it for them | **Path B — installer script** | ~2 min |
| asked what it is / is deciding | Don't install. Point them at `README.md`. | — |

**The default user is non-technical.** If they said "make my ZCode look like
Tarkov" and nothing more, prefer Path A unless they asked you to do it yourself.
Path A needs no terminal, no Node, and nothing to trust but the plugin itself.

---

## Path A — marketplace UI (no shell)

Tell the user to do exactly this:

1. Open ZCode → **插件市场** (Plugin Marketplace).
2. Add this repository as a marketplace:
   `https://github.com/BakaronLab/zcode-tarkov`
3. Install **zcode-tarkov** from the list.
4. Restart ZCode when prompted.

Then explain the one thing that surprises people: **the plugin alone changes
nothing until ZCode is started with the debug port**, because the plugin injects
into the running app rather than patching it. Tell them to launch ZCode from the
**"ZCode Tarkov"** shortcut the installer creates — or, if they only used the
marketplace path, that they should run the installer once to get that shortcut
and the resident service:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

---

## Path B — installer script

### Prerequisites

- **Node.js 20 or newer** on `PATH` (`node --version`).
- ZCode installed at one of: `%ProgramFiles%\ZCode\ZCode.exe`,
  `%LOCALAPPDATA%\Programs\ZCode\ZCode.exe`, or `%ZCODE_WINDOWS_APP_INSTALL_DIR%`.
- Windows PowerShell 5.1 (present on every supported Windows).

### Run it

From a clone of this repository:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

Useful flags: `-InstallDir <path>` (default
`%LOCALAPPDATA%\Programs\zcode-tarkov`), `-DataDir <path>` (the plugin's *own*
state directory), `-ShortcutDir <dir>` (default: the user Desktop and Start Menu),
`-NoService`, `-Force`.

What it does, and what it deliberately does not:

| Does | Does not |
|---|---|
| Copies the payload into `-InstallDir` | Touch `C:\Program Files\ZCode` or any ZCode file |
| Creates `%LOCALAPPDATA%\zcode-tarkov\data\` and its five media subdirectories | Write anything into an existing media directory |
| Writes `settings.json` recording where it installed | Modify `PATH` or any persistent environment variable |
| Creates a **separate** `ZCode Tarkov` shortcut | Create, change, or delete the official ZCode shortcut |
| Registers a per-user sign-in entry (unless `-NoService`) | Elevate, or write to `%ProgramData%` or `HKLM` |

It never needs administrator rights. If it asks for them, something is wrong —
stop and report that.

### Then

1. Tell the user to **quit ZCode completely** (including the tray icon) and
   relaunch it **from the "ZCode Tarkov" shortcut**. This is required once:
   ZCode reads `--remote-debugging-port` only at startup, so an instance that is
   already running cannot grow the ability to be injected into.
2. Verify:

```powershell
node "$env:LOCALAPPDATA\Programs\zcode-tarkov\dist\cli.js" status
```

Expect `CDP reachable on port 9222; 1 renderer target(s)`. If it says
`CDP not reachable`, the app was launched from the official shortcut rather than
the Tarkov one — say so plainly rather than reinstalling.

### Repair instead, if it is already installed

Use repair, not install, when the program is present but something is missing
(the launcher, the service, a media directory, or — with `-SourceDir` — the
installed program files). It re-detects ZCode and recreates the launcher
shortcuts, but it does not write the per-user autostart entry (it reports it:
re-run `install.ps1` if that is missing) and it does not re-register the plugin
with ZCode's marketplace.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\repair.ps1
```

Repair recreates only what is **missing**. It never overwrites existing media.

---

## Where the user's files live

Tell the user this address, because it is the answer to "where do I put my
music":

```
%LOCALAPPDATA%\zcode-tarkov\data\
├─ music\      background music (mp3, wav, ogg, m4a, aac, flac, webm)
├─ sounds\     override the built-in sound effects: start.*   approval.*
│              done.*   error.*   tool.*   (basename match, any supported extension)
├─ voice\      clips the pet plays when clicked
├─ pet\        pet.png / pet.webp / pet.gif / pet.jpg / pet.jpeg
├─ status\     texts.zh.txt, texts.en.txt — one phrase per line, '#' comments
└─ prefs.json  every setting
```

Nothing here is versioned with the program, so an update cannot delete it. Tell
the user to put their media in those folders rather than beside the plugin. If
they are migrating from v0.1, their old appearance settings are carried over
automatically on first run and the old file is left in place.

The root can be relocated by setting `ZCODE_TARKOV_DATA_DIR` **before** launching
the service; the installer and the CLI both honour it. Do not set it for a normal
user — it is for tests and for people who keep their media on another drive.

---

## Never do these

These are not style preferences. Each one has a concrete failure behind it.

1. **Never modify ZCode's installation.** No file under `C:\Program Files\ZCode`,
   no `resources/app.asar`, no plugin directory inside the app. The plugin works
   by injecting at runtime through the DevTools protocol and by writing only to
   the user's own profile. Editing the app breaks its signature and gets undone
   by the next update anyway.
2. **Never create, move, or delete the official ZCode shortcut.** The installer
   adds a *separate* "ZCode Tarkov" shortcut precisely so the official one stays
   exactly as the vendor shipped it.
3. **Never delete `%LOCALAPPDATA%\zcode-tarkov\data`** — not to "clean up", not
   to reinstall, not because an install failed. That directory is the user's
   music and settings. The only sanctioned deletion is
   `uninstall.ps1 -PurgeUserData`, run deliberately, by a user who has been told
   in plain words that it deletes their media.
4. **Never kill ZCode to "make it pick up the plugin."** A running ZCode may have
   unsaved work. Quitting is the user's decision. If they are mid-task, ask them
   to finish and restart when convenient.
5. **Never install Node or change the system to satisfy a prerequisite** without
   asking. Report the missing prerequisite instead.
6. **Never run the installers against a profile that is not yours** — no
   `-Force` on a directory you did not create, no writing into another user's
   `%LOCALAPPDATA%`.

---

## Uninstalling

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall.ps1
```

Removes the program, the shortcuts, the resident service, the autostart entry and
the plugin registration — and **keeps every byte of the user's media and
settings**. The output lists what it preserved and where.

Only add `-PurgeUserData` when the user has explicitly asked for their media and
settings to be deleted as well. Say what it will delete before running it:

```powershell
# deletes %LOCALAPPDATA%\zcode-tarkov\data — including their music. Confirm first.
powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall.ps1 -PurgeUserData
```

`-DryRun` prints what would happen without doing it.

---

## Troubleshooting

| Symptom | Cause | What to tell the user |
|---|---|---|
| Theme applies but no dock / pet / sound | `dist\client.js` is missing from the install | Run `repair.ps1 -SourceDir <the tree you installed from>`; it restores the injected client from the source tree. Without `-SourceDir` the repair reports the missing bundle instead of writing it |
| Nothing happens at all | ZCode was started without the debug port | Quit ZCode fully, relaunch from the **ZCode Tarkov** shortcut |
| Still nothing after relaunching correctly | ZCode's launch entries lost the debug-port argument (an update can recreate them) | First tell them to quit ZCode completely and relaunch from the **ZCode Tarkov** shortcut: the plugin now repairs the desktop, Start Menu and pinned-taskbar shortcuts plus the `zcode://` and context-menu entries by itself at startup, whenever it finds ZCode running with the port closed. If that does not take, run `node "<installDir>\dist\cli.js" repair-launchers --dry-run` first, then without `--dry-run`. This repair writes to the user's own launch shortcuts and three `HKCU` handler values (machine-wide entries are only reported, never written) — say what it will change before running it. `uninstall.ps1` reverses it on the two official shortcuts it knows (`ZCode.lnk` in the user's Desktop and Start Menu) and on the three handler values; a pinned-taskbar or renamed shortcut keeps the argument and has to be cleaned up by hand, so say that rather than promising a full reversal |
| "a service is already running" | The resident service is already up on 9223 | Open the settings panel in ZCode, or stop that process first |
| Dock shows a lock icon | Chromium's autoplay policy | Click anywhere in the window, or press the dock's play button — a click is the gesture that unlocks audio |
| No music | The user has not added any | Tell them the `music\` path above; the dock's empty state names it too |
| Music stops after a few tracks with a notice | The files could not be decoded | Check `music\` for truncated or mislabelled files; the player stops rather than skipping forever |
| The theme disappears after a ZCode update | The app was relaunched from the official shortcut | Quit it completely and relaunch from the Tarkov shortcut: the plugin now repairs launch entries by itself at startup when it finds ZCode running with the port closed. `repair.ps1` if the shortcut is gone |

When the user reports a bug, collect `dist\cli.js status` output and the service
log (`%LOCALAPPDATA%\zcode-tarkov\data\..\serve.log`, or the plugin data
directory's `serve.log`) before guessing.
