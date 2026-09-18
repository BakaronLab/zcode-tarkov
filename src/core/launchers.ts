/**
 * Launcher repair.
 *
 * ZCode only opens its CDP port when it is started with
 * `--remote-debugging-port=<port>`, and that argument has to come from whatever
 * launches it — the app cannot add it to itself once it is running, and its
 * updater rebuilds the Start Menu shortcut without the flag. A typical machine
 * has several entry points (desktop shortcut, Start Menu shortcut, the pinned
 * taskbar shortcut, the machine-wide Public Desktop / ProgramData Start Menu
 * shortcuts, the `zcode://` protocol handler and the Explorer context-menu
 * verbs) and usually only some of them carry the flag.
 *
 * This module finds the ones that don't and adds it. All writes are per-user:
 * shortcuts in the user's own Desktop, Start Menu and pinned taskbar folder
 * (ordinary `.lnk` files under
 * `%APPDATA%\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar`),
 * plus ZCode's HKCU protocol and shell handlers. Machine-wide entries are
 * reported as failures but never written at all — they need administrator
 * rights, and this project never elevates.
 *
 * The scanned locations are overridable so tests and dev harnesses can run the
 * whole thing against a scratch tree; production callers use the defaults.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type LauncherKind = "shortcut" | "registry";

export interface LauncherFix {
  kind: LauncherKind;
  path: string;
  before: string;
  after: string;
  status: "updated" | "already-ok" | "failed";
  reason?: string;
}

export interface RepairOptions {
  port: number;
  /** Report what would change without writing anything. */
  dryRun?: boolean;
  /**
   * Overrides for tests/dev harnesses; defaults to the production locations.
   *
   * A trust boundary rather than an input: no CLI argument or MCP tool argument
   * reaches these. The caller owns whatever it names — `registryKeys` is still
   * forced under `HKCU:`, but a `shortcutDirs` path is embedded as given, and
   * only the exact string `"machine"` marks an entry as non-writable, so any
   * other value (a typo included) is treated as writable user scope.
   */
  shortcutDirs?: ReadonlyArray<{ path: string; scope: "user" | "machine" }>;
  registryKeys?: string[];
}

export interface RepairReport {
  supported: boolean;
  dryRun: boolean;
  fixes: LauncherFix[];
  /** Set when the platform is unsupported or PowerShell could not be run. */
  error?: string;
}

/**
 * The production shortcut directories, as PowerShell expressions so the script
 * resolves them inside the user's own session. The pinned taskbar folder sits
 * between the user Start Menu and the machine-wide entries on purpose: it is a
 * user-scope location and the shortcuts there are what a user actually clicks.
 */
const DEFAULT_SHORTCUT_DIRS: ReadonlyArray<{
  expr: string;
  scope: "user" | "machine";
}> = [
  { expr: "(Join-Path $env:USERPROFILE 'Desktop')", scope: "user" },
  { expr: "(Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs')", scope: "user" },
  {
    expr: "(Join-Path $env:APPDATA 'Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar')",
    scope: "user",
  },
  { expr: "(Join-Path $env:PUBLIC 'Desktop')", scope: "machine" },
  { expr: "(Join-Path $env:ProgramData 'Microsoft\\Windows\\Start Menu\\Programs')", scope: "machine" },
];

/** ZCode's own HKCU handlers. These are the only registry keys that may be written. */
const DEFAULT_REGISTRY_KEYS = [
  "HKCU:\\Software\\Classes\\zcode\\shell\\open\\command",
  "HKCU:\\Software\\Classes\\Directory\\shell\\ZCode.OpenInZCode\\command",
  "HKCU:\\Software\\Classes\\Drive\\shell\\ZCode.OpenInZCode\\command",
];

/** A single-quoted PowerShell literal. A quote in the value is doubled, not escaped. */
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Builds the PowerShell script that scans and repairs the launch entries.
 *
 * Exported so tests can assert on the generated source without running it. The
 * caller-supplied locations are embedded as single-quoted literals, and a
 * registry key outside `HKCU:` is rejected outright — there is no HKLM path in
 * this project, and machine-wide entries are never written.
 */
export function buildRepairScript(
  port: number,
  dryRun: boolean,
  options: Pick<RepairOptions, "shortcutDirs" | "registryKeys"> = {}
): string {
  const dirs = (
    options.shortcutDirs
      ? options.shortcutDirs.map((d) => ({
          expr: psQuote(d.path),
          scope: d.scope === "machine" ? ("machine" as const) : ("user" as const),
        }))
      : DEFAULT_SHORTCUT_DIRS
  ).map((d) => `  @{ path = ${d.expr}; scope = ${psQuote(d.scope)} }`);

  const keys = (options.registryKeys ?? DEFAULT_REGISTRY_KEYS).map((key) => {
    if (!key.startsWith("HKCU:")) {
      throw new Error(`launcher repair only supports HKCU registry keys (got "${key}")`);
    }
    return `  ${psQuote(key)}`;
  });

  return `
$ErrorActionPreference = 'Continue'
# Without this, Chinese Windows error strings come back as mojibake through
# Node's UTF-8 stdout decoding.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$port = ${port}
$dryRun = $${dryRun ? "true" : "false"}
$flag = ' --remote-debugging-port=' + $port
$results = New-Object System.Collections.ArrayList

function Add-Result($kind, $p, $before, $after, $status, $reason) {
  [void]$results.Add([pscustomobject]@{
    kind = $kind; path = $p; before = $before; after = $after
    status = $status; reason = $reason
  })
}

# --- shortcuts -------------------------------------------------------------
# Each entry carries the scope that owns it. "user" entries are written when
# the flag is missing; "machine" entries would need administrator rights, so
# they are reported as failed and the file is left exactly as it is.
$dirs = @(
${dirs.join(",\n")}
)

$wsh = New-Object -ComObject WScript.Shell
foreach ($d in $dirs) {
  $dirPath = [string]$d.path
  $scope = [string]$d.scope
  if (-not $dirPath -or -not (Test-Path -LiteralPath $dirPath)) { continue }
  foreach ($item in @(Get-ChildItem -LiteralPath $dirPath -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue)) {
    try { $sc = $wsh.CreateShortcut($item.FullName) } catch { continue }
    $target = [string]$sc.TargetPath
    # Identity must be proven before any write: the executable's file name has to
    # be exactly ZCode.exe. A leading-wildcard match would also accept an
    # unrelated MyZCode.exe, and the automatic startup repair would then edit
    # that shortcut.
    if ([System.IO.Path]::GetFileName($target) -ne 'ZCode.exe') { continue }

    $before = [string]$sc.Arguments
    if ($before -match 'remote-debugging-port') {
      Add-Result 'shortcut' $item.FullName $before $before 'already-ok' $null
      continue
    }

    $after = ($before.Trim() + $flag).Trim()
    if ($scope -eq 'machine') {
      Add-Result 'shortcut' $item.FullName $before $before 'failed' 'machine-wide entry needs administrator rights; not modified'
      continue
    }
    if ($dryRun) {
      Add-Result 'shortcut' $item.FullName $before $after 'updated' 'dry-run'
      continue
    }
    try {
      $sc.Arguments = $after
      $sc.Save()
      Add-Result 'shortcut' $item.FullName $before $after 'updated' $null
    } catch {
      Add-Result 'shortcut' $item.FullName $before $after 'failed' $_.Exception.Message
    }
  }
}

# --- HKCU protocol / shell handlers ----------------------------------------
# Only HKCU keys ever reach this list; buildRepairScript rejects anything else.
$keys = @(
${keys.join(",\n")}
)

foreach ($k in $keys) {
  if (-not (Test-Path -LiteralPath $k)) { continue }
  try {
    $key = Get-Item -LiteralPath $k
    $before = [string]$key.GetValue('')
    # The value is '<exe>' followed by arguments. Take the first token and prove
    # it is ZCode.exe itself, rather than merely mentioning it somewhere.
    $exe = ''
    if ($before -match '^\\s*"([^"]+)"') { $exe = $matches[1] }
    elseif ($before -match '^\\s*(\\S+)') { $exe = $matches[1] }
    if ([System.IO.Path]::GetFileName($exe) -ne 'ZCode.exe') { continue }
    if ($before -match 'remote-debugging-port') {
      Add-Result 'registry' $k $before $before 'already-ok' $null
      continue
    }
    # Insert the flag directly after the executable token, keeping any
    # placeholders ("%1") and quoting untouched.
    $after = $before -replace '^(\\s*("[^"]+"|\\S+))', ('$1' + $flag)
    if ($dryRun) {
      Add-Result 'registry' $k $before $after 'updated' 'dry-run'
      continue
    }
    try {
      # Get-Item hands back a read-only handle, so the default value can only be
      # changed through a .NET key opened with write access.
      $sub = $k -replace '^HKCU:\\\\', ''
      $writable = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($sub, $true)
      if (-not $writable) { throw 'cannot open the key for writing' }
      $writable.SetValue('', $after, [Microsoft.Win32.RegistryValueKind]::String)
      $writable.Close()
      Add-Result 'registry' $k $before $after 'updated' $null
    } catch {
      Add-Result 'registry' $k $before $after 'failed' $_.Exception.Message
    }
  } catch {
    Add-Result 'registry' $k '' '' 'failed' $_.Exception.Message
  }
}

@($results) | ConvertTo-Json -Depth 4 -Compress
`;
}

interface RawResult {
  kind: string;
  path: string;
  before: string;
  after: string;
  status: string;
  reason: string | null;
}

/**
 * Scans every ZCode launcher and adds the CDP flag where it is missing.
 * Never throws: a platform without these mechanisms, a missing PowerShell, or
 * an invalid custom target comes back as a report with `error` set.
 */
export async function repairLaunchers(opts: RepairOptions): Promise<RepairReport> {
  const dryRun = opts.dryRun ?? false;
  if (process.platform !== "win32") {
    return {
      supported: false,
      dryRun,
      fixes: [],
      error: "launcher repair is only implemented for Windows; on other platforms edit your app shortcut manually",
    };
  }

  let script: string;
  try {
    script = buildRepairScript(opts.port, dryRun, opts);
  } catch (err) {
    return { supported: true, dryRun, fixes: [], error: (err as Error).message };
  }

  const encoded = Buffer.from(script, "utf16le").toString("base64");
  try {
    const { stdout } = await execFileAsync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      { maxBuffer: 8 * 1024 * 1024, timeout: 120_000, windowsHide: true }
    );
    const trimmed = stdout.trim();
    if (!trimmed) return { supported: true, dryRun, fixes: [] };
    const raw = JSON.parse(trimmed) as RawResult | RawResult[];
    const list = Array.isArray(raw) ? raw : [raw];
    return {
      supported: true,
      dryRun,
      fixes: list.map((r) => ({
        kind: (r.kind === "registry" ? "registry" : "shortcut") as LauncherKind,
        path: r.path,
        before: r.before,
        after: r.after,
        status: r.status === "updated" || r.status === "already-ok" ? r.status : "failed",
        reason: r.reason ?? undefined,
      })),
    };
  } catch (err) {
    return { supported: true, dryRun, fixes: [], error: (err as Error).message };
  }
}
