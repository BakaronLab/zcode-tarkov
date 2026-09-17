#!/usr/bin/env node
/**
 * probe-signals.mjs - discover and record ZCode client run-state DOM signals.
 *
 * The zcode-tarkov plugin only ever touches pixels, so it has never needed to
 * know whether the agent is idle, working, waiting for an approval or has just
 * failed. Anything that wants to react to run state does need that, and the
 * answer lives in the renderer DOM of the ZCode desktop client, not in any
 * published contract. This tool is the evidence source for the signal table in
 * docs/dev/zcode-runtime-signals.md: it launches an isolated ZCode instance,
 * dumps a structural snapshot of the renderer, drives a prompt into the
 * composer, and polls a compact state vector while the task runs, recording
 * every transition with a timestamp.
 *
 * Design rules it follows:
 *   - Signal discovery is generic, not a hardcoded selector list: the snapshot
 *     enumerates every data-* attribute, every ARIA live region and every
 *     noteworthy attribute-driven element in the tree, so a signal that exists
 *     on a newer build shows up without editing this file.
 *   - Text is recorded for humans only and is always labelled as weak. The
 *     vector keys elements on tag + data-* / aria-* attributes, never on text.
 *   - Everything is bounded: list lengths and string lengths are capped so a
 *     poll cannot grow the output with the app's own log volume.
 *
 * Requirements: Node >= 22 (global fetch and WebSocket; Node 24 here). No
 * dependencies, nothing is installed. Windows only.
 *
 * Isolation (this is the part that matters for the user's real client):
 *   - The launched instance gets a scratch ZCODE_HOME with a COPY of the real
 *     credential files, so it can authenticate and run a task while writing
 *     nothing into the user's store. The copies live under $TEMP, are never
 *     printed, and are deleted with the scratch tree.
 *   - Every scratch path must be under $TEMP and outside this repository.
 *   - The CDP port must be provably free before launching.
 *   - The real store is tripwired: mtimes/sizes of the six copied files are
 *     stamped before launch and re-read after cleanup; a change is reported.
 *   - The instance is closed only through its own CDP Browser.close, then by
 *     stopping only processes whose command line carries BOTH the scratch
 *     profile path and the scratch CDP port. Never by image name.
 *
 * Usage:
 *   node tools/probe-signals.mjs launch --port 9463 [--scratch DIR]
 *   node tools/probe-signals.mjs snapshot --port 9463 [--out FILE]
 *   node tools/probe-signals.mjs watch --port 9463 [--seconds 60] [--out FILE]
 *   node tools/probe-signals.mjs send --port 9463 --text "reply with OK"
 *   node tools/probe-signals.mjs close --port 9463 [--scratch DIR]
 *   node tools/probe-signals.mjs session --prompt "reply with the single word OK"
 *   node tools/probe-signals.mjs session --prompt "..." --prompt "..." --out FILE
 *
 * Flags:
 *   --port N          CDP port (default 9463). Refused when already listening.
 *   --scratch DIR     scratch root (default <TEMP>/zct-signals-<stamp>-<port>)
 *   --profile DIR     scratch Chromium profile (default <scratch>/zcode-profile)
 *   --zcode-home DIR  scratch ZCODE_HOME (default <scratch>/zcode-home)
 *   --exe FILE        ZCode.exe (default C:\Program Files\ZCode\ZCode.exe)
 *   --out FILE        write the JSON result to this file
 *   --out-dir DIR     directory for session artifacts (default <scratch>)
 *   --seconds N       watch budget in seconds (default 60; session: per prompt)
 *   --interval-ms N   poll interval (default 250)
 *   --timeout-ms N    renderer boot budget (default 90000)
 *   --text TEXT       prompt text for `send`
 *   --prompt TEXT     prompt for `session`; repeatable, one model call each
 *   --settle-ms N     wait after a prompt before the first poll (default 300)
 *   --stop-after-ms N during `session`, click the composer stop control after
 *                     this many ms of a prompt (drives the interrupted state)
 *   --no-copy-creds   launch without copying credentials (login screen only)
 *   --keep-scratch    do not delete the scratch tree on cleanup
 *   --allow-port-kill fall back to killing by port match when the scratch
 *                     profile match finds nothing (off by default)
 *   --verbose         print every poll tick instead of only transitions
 *   --help            this text
 *
 * Exit codes: 0 ok, 1 ran with a recorded problem (cleanup, real-store trip,
 * or a prompt that could not be submitted), 2 refused before doing anything.
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const DEFAULT_PORT = 9463;
const DEFAULT_EXE = 'C:\\Program Files\\ZCode\\ZCode.exe';

// The six files the desktop client needs to authenticate and run a task with
// the user's real account. Copied under $TEMP, never printed, deleted with the
// scratch tree. Keep this list in sync with docs/dev/zcode-runtime-signals.md.
const CRED_FILES = [
  'credentials.json',
  'provider_config.json',
  'config.json',
  'setting.json',
  'model-provider-display-order.json',
  'coding-plan-cache.json',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------- args --
function parseArgs(argv) {
  const out = {
    cmd: argv[0] && !argv[0].startsWith('-') ? argv[0] : 'help',
    port: DEFAULT_PORT, scratch: '', profile: '', zcodeHome: '', exe: DEFAULT_EXE,
    out: '', outDir: '', seconds: 0, intervalMs: 250, timeoutMs: 90000,
    text: '', expr: '', file: '', prompts: [], settleMs: 300, stopAfterMs: 0, copyCreds: true,
    keepScratch: false, allowPortKill: false, verbose: false,
  };
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => { i += 1; if (i >= argv.length) throw new Error('missing value for ' + a); return argv[i]; };
    if (a === '--port') out.port = Number(next());
    else if (a === '--scratch') out.scratch = String(next());
    else if (a === '--profile') out.profile = String(next());
    else if (a === '--zcode-home') out.zcodeHome = String(next());
    else if (a === '--exe') out.exe = String(next());
    else if (a === '--out') out.out = String(next());
    else if (a === '--out-dir') out.outDir = String(next());
    else if (a === '--seconds') out.seconds = Number(next());
    else if (a === '--interval-ms') out.intervalMs = Number(next());
    else if (a === '--timeout-ms') out.timeoutMs = Number(next());
    else if (a === '--text') out.text = String(next());
    else if (a === '--expr') out.text = String(next());
    else if (a === '--file') out.file = String(next());
    else if (a === '--prompt') out.prompts.push(String(next()));
    else if (a === '--settle-ms') out.settleMs = Number(next());
    else if (a === '--stop-after-ms') out.stopAfterMs = Number(next());
    else if (a === '--no-copy-creds') out.copyCreds = false;
    else if (a === '--keep-scratch') out.keepScratch = true;
    else if (a === '--allow-port-kill') out.allowPortKill = true;
    else if (a === '--verbose') out.verbose = true;
    else if (a === '--help' || a === '-h') out.cmd = 'help';
    else throw new Error('unknown argument: ' + a);
  }
  return out;
}

// ----------------------------------------------------------------- safety --
function isUnder(candidate, root) {
  const p = path.resolve(candidate).toLowerCase();
  const r = path.resolve(root).toLowerCase().replace(/[\\/]+$/, '');
  return p === r || p.startsWith(r + path.sep);
}

function tempRoot() {
  return path.resolve(process.env.TEMP || process.env.TMP || os.tmpdir());
}

function realZcodeHome() {
  const explicit = (process.env.ZCODE_HOME || '').trim();
  if (explicit) return path.resolve(explicit);
  const home = process.env.USERPROFILE || os.homedir();
  return path.join(home, '.zcode');
}

// The real profile locations the scratch tree must never overlap. Same list
// measure-layout.mjs uses, for the same reason.
function blockedRealPaths() {
  const list = [];
  const home = process.env.USERPROFILE || '';
  const appdata = process.env.APPDATA || '';
  const local = process.env.LOCALAPPDATA || '';
  if (home) { list.push(path.join(home, 'Desktop')); list.push(path.join(home, '.zcode')); }
  if (appdata) list.push(path.join(appdata, 'Microsoft', 'Windows', 'Start Menu'));
  if (local) list.push(path.join(local, 'Programs', 'zcode-tarkov'));
  return list;
}

// Returns a refusal reason, or null when the scratch path is acceptable.
function scratchPathProblem(dir, label) {
  const t = tempRoot();
  if (!isUnder(dir, t)) return label + ' ' + dir + ' is not under TEMP (' + t + ')';
  if (isUnder(dir, REPO)) return label + ' ' + dir + ' is inside the repository (' + REPO + ')';
  for (const blocked of blockedRealPaths()) {
    if (isUnder(dir, blocked)) return label + ' ' + dir + ' is inside a real profile location (' + blocked + ')';
  }
  return null;
}

function stamp() {
  const iso = new Date().toISOString();
  return iso.slice(0, 10).replace(/-/g, '') + '-' + iso.slice(11, 19).replace(/:/g, '');
}

function pad(s, n) { return (String(s) + ' '.repeat(n)).slice(0, n); }

// A plain TCP connect is the only honest "is someone listening" test.
function tcpProbe(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port: port });
    let settled = false;
    const done = (state) => { if (settled) return; settled = true; try { sock.destroy(); } catch (e) {} resolve(state); };
    sock.setTimeout(1500);
    sock.once('connect', () => done('listening'));
    sock.once('timeout', () => done('unknown'));
    sock.once('error', (err) => done(err && err.code === 'ECONNREFUSED' ? 'free' : 'unknown'));
  });
}

async function portListening(port) {
  return (await tcpProbe(port)) === 'listening';
}

// -------------------------------------------------------------- powershell --
function run(file, args, timeoutMs = 30000) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve({
        code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0,
        stdout: String(stdout || ''), stderr: String(stderr || ''),
      });
    });
  });
}

function psQuote(text) { return "'" + String(text).replace(/'/g, "''") + "'"; }

// Processes that carry BOTH the scratch profile path and the scratch CDP port
// in their command line. Either match alone is not identity; both together are,
// because this run's scratch profile path is unique.
async function psListScratch(profile, port) {
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    '$needle = ' + psQuote(profile),
    '$flag = ' + psQuote('--remote-debugging-port=' + port),
    "$procs = @(Get-CimInstance Win32_Process -Filter \"Name = 'ZCode.exe'\")",
    "$hit = @($procs | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($needle) -and $_.CommandLine.Contains($flag) })",
    "if ($hit.Count -eq 0) { Write-Output '[]' } else { $hit | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId } } | ConvertTo-Json -Compress -Depth 3 }"
  ].join('; ');
  const r = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script]);
  const text = (r.stdout || '').replace(/^\uFEFF/, '').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.map((p) => p.pid).filter((n) => Number.isFinite(n) && n > 0);
  } catch (e) { return []; }
}

async function psListByPort(port) {
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    '$flag = ' + psQuote('--remote-debugging-port=' + port),
    "$procs = @(Get-CimInstance Win32_Process -Filter \"Name = 'ZCode.exe'\")",
    "$hit = @($procs | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($flag) })",
    "if ($hit.Count -eq 0) { Write-Output '[]' } else { $hit | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId } } | ConvertTo-Json -Compress -Depth 3 }"
  ].join('; ');
  const r = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script]);
  const text = (r.stdout || '').replace(/^\uFEFF/, '').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.map((p) => p.pid).filter((n) => Number.isFinite(n) && n > 0);
  } catch (e) { return []; }
}

async function psStop(pids) {
  if (!pids.length) return [];
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    '$stopped = New-Object System.Collections.ArrayList',
    pids.map((p) => 'if (Get-Process -Id ' + p + ' -ErrorAction SilentlyContinue) { Stop-Process -Id ' + p + ' -Force -ErrorAction SilentlyContinue; [void]$stopped.Add(' + p + ') }').join('; '),
    "$stopped -join ','"
  ].join('; ');
  const r = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script]);
  const text = (r.stdout || '').replace(/^\uFEFF/, '').trim();
  return text ? text.split(',').map(Number).filter((n) => Number.isFinite(n) && n > 0) : [];
}

// --------------------------------------------------------- real-store trip --
// Sizes and mtimes only. The contents of these files are never read here, never
// copied to stdout, and never written anywhere except the scratch tree.
function storeStamps() {
  const home = path.join(realZcodeHome(), 'v2');
  const out = { home: home, files: {}, missing: [] };
  for (const name of CRED_FILES) {
    const file = path.join(home, name);
    try {
      const st = fs.statSync(file);
      out.files[name] = { size: st.size, mtimeMs: Math.round(st.mtimeMs) };
    } catch (e) {
      out.missing.push(name);
    }
  }
  return out;
}

function compareStamps(before, after) {
  const changed = [];
  for (const name of Object.keys(before.files)) {
    const b = before.files[name];
    const a = after.files[name];
    if (!a || a.size !== b.size || a.mtimeMs !== b.mtimeMs) changed.push(name);
  }
  return changed;
}

// Copies the credential files into the scratch ZCODE_HOME. Returns counts and
// names only - never any content.
function copyCredentials(zcodeHome, report) {
  const src = path.join(realZcodeHome(), 'v2');
  const dst = path.join(zcodeHome, 'v2');
  fs.mkdirSync(dst, { recursive: true });
  const copied = [], skipped = [];
  for (const name of CRED_FILES) {
    const from = path.join(src, name);
    const to = path.join(dst, name);
    try {
      fs.copyFileSync(from, to);
      copied.push(name);
    } catch (e) {
      skipped.push(name);
    }
  }
  report.credentials = { source: src, destination: dst, copied: copied, skipped: skipped };
  return report.credentials;
}

// --------------------------------------------------------------------- cdp --
async function httpJson(url, timeoutMs = 5000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
    return await res.json();
  } finally { clearTimeout(t); }
}

function connect(wsUrl, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const t = setTimeout(() => { try { ws.close(); } catch (e) {} reject(new Error('WebSocket connect timeout')); }, timeoutMs);
    ws.addEventListener('open', () => { clearTimeout(t); resolve(ws); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('WebSocket connect error')); }, { once: true });
  });
}

function makeSender(ws) {
  let nextId = 1;
  return function send(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const onMessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        if (msg.id !== id) return;
        ws.removeEventListener('message', onMessage);
        if (msg.error) reject(new Error(method + ': ' + JSON.stringify(msg.error)));
        else resolve(msg.result);
      };
      ws.addEventListener('message', onMessage);
      try { ws.send(JSON.stringify({ id: id, method: method, params: params || {} })); }
      catch (err) { ws.removeEventListener('message', onMessage); reject(err); }
    });
  };
}

async function evaluate(send, expression) {
  const res = await send('Runtime.evaluate', { expression: expression, returnByValue: true, awaitPromise: true });
  if (res.exceptionDetails) throw new Error('Runtime.evaluate threw: ' + JSON.stringify(res.exceptionDetails).slice(0, 500));
  return res.result ? res.result.value : undefined;
}

async function findPageTarget(base, budgetMs) {
  const deadline = Date.now() + budgetMs;
  let targets = [];
  while (Date.now() < deadline) {
    try { targets = await httpJson(base + '/json/list', 3000); } catch (err) { targets = []; }
    const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl && String(t.url || '').indexOf('devtools://') !== 0);
    if (pages.length > 0) return { target: pages.find((t) => /zcode/i.test(t.title || '')) || pages[0], targets: targets };
    await sleep(500);
  }
  return { target: null, timeout: true, targets: targets };
}

// ------------------------------------------------- page-side: shared parts --
// A page-side helper block shared by the snapshot and the vector. It is
// injected as a prefix so both expressions describe elements the same way.
const HELPERS = `
  var MAXLIST = 80, MAXTEXT = 200, MAXSAMPLE = 10;
  function num(v){ var n = parseFloat(v); return isNaN(n) ? null : Math.round(n * 100) / 100; }
  function clip(s, n){ s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '...' : s; }
  function vis(el){
    if (!el || el.nodeType !== 1) return false;
    var c = getComputedStyle(el);
    if (c.display === 'none' || c.visibility === 'hidden') return false;
    if (parseFloat(c.opacity) === 0) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  }
  function box(el){
    if (!el) return null;
    var r = el.getBoundingClientRect();
    return { x: num(r.x), y: num(r.y), w: num(r.width), h: num(r.height), top: num(r.top), bottom: num(r.bottom), left: num(r.left), right: num(r.right) };
  }
  // Stable identity of an element: tag + id + data-slot + the semantic
  // attributes that carry state. Deliberately excludes class and never uses
  // text, so a key survives re-render and copy changes.
  function attrsOf(el){
    var o = {}, i, a;
    for (i = 0; i < el.attributes.length; i++) {
      a = el.attributes[i];
      if (a.name === 'class' || a.name === 'style' || a.name === 'd') continue;
      o[a.name] = clip(a.value, 120);
    }
    return o;
  }
  function dataKeys(el){
    var keys = [], i, a;
    for (i = 0; i < el.attributes.length; i++) {
      a = el.attributes[i];
      if (a.name.indexOf('data-') === 0 || a.name === 'role' || a.name.indexOf('aria-') === 0) keys.push(a.name + '=' + clip(a.value, 60));
    }
    return keys.sort();
  }
  function keyOf(el){
    var parts = [el.tagName.toLowerCase()];
    if (el.id) parts.push('#' + el.id);
    var slot = el.getAttribute('data-slot');
    if (slot) parts.push('[data-slot="' + slot + '"]');
    var al = el.getAttribute('aria-label');
    if (al) parts.push('[aria-label="' + clip(al, 40) + '"]');
    var testid = el.getAttribute('data-testid');
    if (testid) parts.push('[data-testid="' + testid + '"]');
    var other = [];
    var i, a;
    for (i = 0; i < el.attributes.length; i++) {
      a = el.attributes[i];
      if (a.name.indexOf('data-') !== 0) continue;
      if (a.name === 'data-slot' || a.name === 'data-testid') continue;
      other.push(a.name + '=' + clip(a.value, 40));
    }
    if (other.length) parts.push('{' + other.sort().join(',') + '}');
    return parts.join('');
  }
  function ancestry(el, stop, depth){
    var segs = [], cur = el, guard = 0;
    while (cur && cur.nodeType === 1 && guard < (depth || 10)) {
      var seg = cur.tagName.toLowerCase();
      if (cur.id) seg += '#' + cur.id;
      var slot = cur.getAttribute('data-slot');
      if (slot) seg += '[data-slot="' + slot + '"]';
      var role = cur.getAttribute('role');
      if (role) seg += '[role="' + role + '"]';
      var tid = cur.getAttribute('data-testid');
      if (tid) seg += '[data-testid="' + tid + '"]';
      segs.unshift(seg);
      if (cur === stop) break;
      cur = cur.parentElement; guard += 1;
    }
    return segs.join(' > ');
  }
  function pathOf(el, stop){
    var segs = [], cur = el, guard = 0;
    while (cur && cur.nodeType === 1 && guard < 12) {
      segs.unshift(keyOf(cur));
      if (cur === stop || cur === document.body) break;
      cur = cur.parentElement; guard += 1;
    }
    return segs.join(' > ');
  }
  function ownText(el){
    var t = '';
    for (var i = 0; i < el.childNodes.length; i++) {
      if (el.childNodes[i].nodeType === 3) t += el.childNodes[i].nodeValue;
    }
    t = t.trim();
    return t || (el.childElementCount === 0 ? (el.textContent || '').trim() : '');
  }
  function liveKind(el){
    var c = getComputedStyle(el);
    var live = el.getAttribute('aria-live') || c.getPropertyValue('aria-live') || '';
    var role = el.getAttribute('role') || '';
    var busy = el.getAttribute('aria-busy') || '';
    return { ariaLive: live, role: role, ariaBusy: busy, ariaAtomic: el.getAttribute('aria-atomic') || '', ariaRelevant: el.getAttribute('aria-relevant') || '', tag: el.tagName.toLowerCase() };
  }
  // An element is "noteworthy" when one of its data-*/aria-* attributes names
  // or carries a run-state concept. This is what makes the scan generic: a new
  // attribute on a future build is picked up without a selector list.
  var NOTEWORTHY = /(run|state|status|busy|stream|tool|reason|think|approv|error|abort|idle|pending|ask|turn|agent|task|progress|phase|step|wait|working|stop|cancel|queue)/i;
  function noteworthy(el){
    var i, a;
    for (i = 0; i < el.attributes.length; i++) {
      a = el.attributes[i];
      if (a.name === 'data-slot' || a.name === 'data-testid') continue;
      if (a.name.indexOf('data-') === 0 || a.name.indexOf('aria-') === 0 || a.name === 'role') {
        if (NOTEWORTHY.test(a.name) || NOTEWORTHY.test(a.value)) return true;
      }
      if (a.name === 'aria-busy' && a.value === 'true') return true;
    }
    return false;
  }
  function buttonsIn(root){
    var sel = 'button, [role="button"], [type="submit"], [data-slot="button"]';
    var list = root ? root.querySelectorAll(sel) : document.querySelectorAll(sel);
    var out = [];
    for (var i = 0; i < list.length && out.length < MAXLIST; i++) {
      var b = list[i];
      if (!vis(b)) continue;
      var c = getComputedStyle(b);
      out.push({
        key: keyOf(b),
        text: clip(ownText(b), 60),
        attrs: attrsOf(b),
        disabled: b.disabled === true || b.getAttribute('aria-disabled') === 'true' || c.pointerEvents === 'none',
        dataState: b.getAttribute('data-state'),
        box: box(b)
      });
    }
    return out;
  }
`;

// ----------------------------------------------------------------- snapshot --
// The structural dump. Deliberately verbose: it is the discovery instrument.
const SNAPSHOT = '(function(){\n' + HELPERS + `
  var out = {};
  out.meta = {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    visibility: document.visibilityState,
    htmlClasses: document.documentElement.className,
    bodyClasses: document.body ? document.body.className : '',
    viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
    userAgent: navigator.userAgent,
    hasRoot: !!document.getElementById('root'),
    rootChildren: document.getElementById('root') ? document.getElementById('root').childElementCount : 0,
    bodyChildren: document.body ? document.body.childElementCount : 0
  };
  out.takenAt = new Date().toISOString();

  // 1. Every data-* attribute name in the document, with count and samples.
  var names = {}, all = document.querySelectorAll('body *');
  var i, el, a, j;
  for (i = 0; i < all.length; i++) {
    el = all[i];
    for (j = 0; j < el.attributes.length; j++) {
      a = el.attributes[j];
      if (a.name.indexOf('data-') !== 0) continue;
      var rec = names[a.name] || (names[a.name] = { count: 0, values: [], elements: [], byTag: {} });
      rec.count += 1;
      if (rec.values.length < MAXSAMPLE && rec.values.indexOf(a.value) < 0) rec.values.push(clip(a.value, 60));
      var tag = el.tagName.toLowerCase();
      rec.byTag[tag] = (rec.byTag[tag] || 0) + 1;
      if (rec.elements.length < 3) rec.elements.push(pathOf(el, document.body));
    }
  }
  var dataNames = Object.keys(names).sort();
  out.dataAttributeNames = dataNames;
  out.dataAttributes = {};
  for (i = 0; i < dataNames.length; i++) out.dataAttributes[dataNames[i]] = names[dataNames[i]];

  // 2. ARIA live regions and busy/progress affordances.
  var live = [];
  var liveSel = '[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"], [role="log"], [role="progressbar"], [aria-busy="true"]';
  var liveList = document.querySelectorAll(liveSel);
  for (i = 0; i < liveList.length && live.length < MAXLIST; i++) {
    el = liveList[i];
    var k = liveKind(el);
    live.push({ key: keyOf(el), ancestry: ancestry(el, document.body, 8), text: clip(ownText(el) || el.textContent, MAXTEXT), kind: k, attrs: attrsOf(el), box: box(el), visible: vis(el) });
  }
  out.liveRegions = live;

  // 3. Noteworthy attribute-driven elements.
  var note = [];
  for (i = 0; i < all.length && note.length < 60; i++) {
    el = all[i];
    if (!noteworthy(el)) continue;
    note.push({ key: keyOf(el), ancestry: ancestry(el, document.body, 8), attrs: attrsOf(el), text: clip(ownText(el), 160), box: box(el), visible: vis(el) });
  }
  out.noteworthy = note;

  // 4. Anchors this repository already depends on, re-verified per build.
  var greeting = document.querySelector('p[data-v4-draft-greeting="true"]');
  var greetingSpan = greeting ? greeting.querySelector('span:not([aria-hidden]):last-child') : null;
  out.anchors = {
    greeting: greeting ? { found: true, key: keyOf(greeting), attrs: attrsOf(greeting), text: clip(greeting.textContent, 120), visibleSpanText: greetingSpan ? clip(greetingSpan.textContent, 120) : null, box: box(greeting), fontVar: getComputedStyle(greeting).getPropertyValue('--v4-draft-greeting-font-size').trim() } : { found: false },
    emptyChat: null,
    banner: !!document.getElementById('zcode-tarkov-banner'),
    panelRoot: !!document.getElementById('zcode-beautify-panel-root')
  };
  var empty = document.querySelector('[data-testid="chat-empty"]') || document.querySelector('p[data-v4-draft-greeting="true"]');
  if (empty) out.anchors.emptyChat = { key: keyOf(empty), ancestry: ancestry(empty, document.body, 8), box: box(empty) };

  // 5. Composer and everything inside two levels of it.
  var editor = document.querySelector('[contenteditable="true"], textarea, [role="textbox"]');
  var composer = editor, hops = 0;
  while (composer && composer.parentElement && composer.parentElement !== document.body && hops < 6) { composer = composer.parentElement; hops += 1; }
  out.composer = { found: !!editor, editor: null, container: null, buttons: [], form: null };
  if (editor) {
    out.composer.editor = { key: keyOf(editor), ancestry: ancestry(editor, document.body, 10), attrs: attrsOf(editor), tag: editor.tagName.toLowerCase(), isContentEditable: editor.isContentEditable === true, box: box(editor), placeholder: editor.getAttribute('placeholder') || editor.getAttribute('data-placeholder') || '' };
    out.composer.container = { key: keyOf(composer), ancestry: ancestry(composer, document.body, 12), attrs: attrsOf(composer), box: box(composer) };
    out.composer.buttons = buttonsIn(composer);
    var form = editor.closest('form');
    if (form) out.composer.form = { key: keyOf(form), attrs: attrsOf(form), buttons: buttonsIn(form) };
  }

  // 6. The status strip: every visible leaf-text element in a band around the
  // composer. Text is recorded, but the vector keys on attributes, not text.
  var strip = [];
  if (editor) {
    var er = editor.getBoundingClientRect();
    var band = { left: er.left - 320, right: er.right + 320, top: er.top - 300, bottom: er.bottom + 160 };
    for (i = 0; i < all.length && strip.length < MAXLIST; i++) {
      el = all[i];
      if (el === editor || el.contains(editor) || editor.contains(el)) continue;
      if (el.childElementCount > 0) continue;
      if (!vis(el)) continue;
      var t = (el.textContent || '').trim();
      if (!t || t.length > 220) continue;
      var r = el.getBoundingClientRect();
      if (r.left < band.left || r.right > band.right || r.top < band.top || r.bottom > band.bottom) continue;
      strip.push({ key: keyOf(el), ancestry: ancestry(el, document.body, 10), attrs: attrsOf(el), text: clip(t, 220), box: box(el), distToEditorTop: num(Math.abs(r.top - er.top)) });
    }
    strip.sort(function (a, b) { return a.distToEditorTop - b.distToEditorTop; });
  }
  out.statusStrip = strip;

  // 7. Account area: the bottom-left corner of the shell, described by
  // structure (bottom <= viewport, left <= 320) rather than by its label.
  var account = [];
  for (i = 0; i < all.length && account.length < 30; i++) {
    el = all[i];
    if (!vis(el)) continue;
    var ar = el.getBoundingClientRect();
    if (ar.bottom < innerHeight - 160 || ar.left > 320 || ar.width > 320) continue;
    if (el.childElementCount > 3) continue;
    account.push({ key: keyOf(el), ancestry: ancestry(el, document.body, 8), attrs: attrsOf(el), text: clip((el.textContent || '').trim(), 80), box: box(el), depth: (function (e) { var d = 0; while (e && e.parentElement) { e = e.parentElement; d += 1; } return d; })(el) });
  }
  out.bottomLeft = account;

  // 8. Transcript containers: how many message rows / tool rows exist, and
  // which structural slots carry them.
  var slots = {};
  var slotEls = document.querySelectorAll('[data-slot]');
  for (i = 0; i < slotEls.length; i++) {
    var s = slotEls[i].getAttribute('data-slot');
    slots[s] = (slots[s] || 0) + 1;
  }
  out.slots = slots;
  var testids = {};
  var tidEls = document.querySelectorAll('[data-testid]');
  for (i = 0; i < tidEls.length; i++) {
    var tid = tidEls[i].getAttribute('data-testid');
    testids[tid] = (testids[tid] || 0) + 1;
  }
  out.testids = testids;

  // 9. Dialogs / approval surfaces, when open.
  var dialogs = [];
  var dlgList = document.querySelectorAll('[role="dialog"], [role="alertdialog"], [data-slot="dialog-content"], [data-slot="alert-dialog-content"], [data-state="open"]');
  for (i = 0; i < dlgList.length && dialogs.length < 20; i++) {
    el = dlgList[i];
    if (!vis(el)) continue;
    dialogs.push({ key: keyOf(el), ancestry: ancestry(el, document.body, 8), attrs: attrsOf(el), text: clip(el.textContent, 400), box: box(el), buttons: buttonsIn(el) });
  }
  out.dialogs = dialogs;

  // 10. Weak text digest of the window bottom, for humans only.
  out.textDigestBottom = (function () {
    var r = document.getElementById('root');
    var text = (r ? r.innerText : document.body.innerText) || '';
    return clip(text.slice(-1200), 1200);
  })();
  return out;
})()`;

// ------------------------------------------------------------------- vector --
// The transition key. Timestamps are excluded on purpose: they change on every
// tick and would turn every poll into a "transition". Box geometry is excluded
// too, for the same reason (a caret blink or a resize animation would otherwise
// look like a state change).
function vectorKey(vec) {
  return JSON.stringify(stripBoxes(Object.assign({}, vec, { t: undefined, wall: undefined })));
}

// Removes the geometry fields so a stored transition stays readable and small.
function stripBoxes(value) {
  if (Array.isArray(value)) return value.map(stripBoxes);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) {
      if (k === 'box') continue;
      out[k] = stripBoxes(value[k]);
    }
    return out;
  }
  return value;
}

// The polled state vector. Small, attribute-keyed, and diffable: everything a
// state machine needs, nothing that changes on every animation frame.
const VECTOR = '(function(){\n' + HELPERS + `
  function sig(list, keyFn) {
    var out = [], i;
    for (i = 0; i < list.length; i++) {
      var k = keyFn(list[i]);
      if (out.indexOf(k) < 0) out.push(k);
    }
    return out.sort();
  }
  var v = { t: Math.round(performance.now()), wall: new Date().toISOString() };
  var editor = document.querySelector('[contenteditable="true"], textarea, [role="textbox"]');
  var composer = editor, hops = 0;
  while (composer && composer.parentElement && composer.parentElement !== document.body && hops < 6) { composer = composer.parentElement; hops += 1; }

  // Anchors (presence booleans are the cheapest, most stable signal of all).
  v.greeting = !!document.querySelector('p[data-v4-draft-greeting="true"]');
  v.emptyChat = !!document.querySelector('[data-testid="chat-empty"]');
  v.editor = !!editor;
  v.composer = !!composer;

  // Explicit handles, read by attribute so their whole attribute set is
  // compared on every tick. These are the elements the signal table in
  // docs/dev/zcode-runtime-signals.md names, and they are the reason this
  // vector is generic without being blind: anything the table documents is
  // sampled every tick, and anything new still shows up in the noteworthy list.
  var ANCHORS = [
    ['paneShell', '[data-testid="v4-pane-shell-workspace-main"]'],
    ['sessionPane', '[data-testid="v4-session-pane-workspace-main"]'],
    ['timeline', '[data-testid="v4-timeline"]'],
    ['chatEmpty', '[data-testid="chat-empty"]'],
    ['greeting', 'p[data-v4-draft-greeting="true"]'],
    ['composer', '[data-testid="v4-composer"]'],
    ['composerInput', '[data-testid="v4-composer-input"]'],
    ['composerSend', '[data-testid="v4-composer-send"]'],
    // Run state: the stop control only exists while the agent can be
    // interrupted, and chat-loading is the transcript's role=status spinner.
    ['stopControl', '[data-testid="v4-stop"]'],
    ['chatLoading', '[data-testid="chat-loading"]'],
    // Approval: the option set is the language-independent presence test; the
    // trigger prefix is the second candidate.
    ['permissionOption', '[data-permission-option-kind]'],
    ['permissionTrigger', '[data-testid^="tool-summary-trigger-permission:"]'],
    // Transcript content: tool calls and reasoning are counted, not matched.
    ['toolBlock', '[data-tool-call-id]'],
    ['reasoningTrigger', '[data-testid="chat-reasoning-trigger"]'],
    ['turnNavigator', '[data-testid^="v4-turn-navigator-item-"]'],
    // Background-work panel: STATIC ONLY in the bundle so far, watched for the
    // first session that mounts it.
    ['summaryPanel', '[data-testid="chat-summary-panel"]'],
    ['modelConfig', '[data-testid="v4-model-config"]'],
    ['sessionTitle', '[data-testid="v4-session-title"]'],
    ['conversation', '[data-testid="conversation"]'],
    ['sidebar', '[data-testid="sidebar"]'],
    ['taskList', '[data-testid="task-list"]'],
    ['taskEmpty', '[data-testid="task-empty"]'],
    ['loginTrigger', '[data-testid="login-trigger"]']
  ];
  v.anchors = {};
  for (i = 0; i < ANCHORS.length; i++) {
    var an = document.querySelector(ANCHORS[i][1]);
    if (!an) { v.anchors[ANCHORS[i][0]] = null; continue; }
    var full = (an.textContent || '').trim();
    var leafish = an.childElementCount <= 3;
    v.anchors[ANCHORS[i][0]] = {
      sel: ANCHORS[i][1],
      key: keyOf(an),
      attrs: attrsOf(an),
      // Text is recorded for small elements only. A container's text changes on
      // every streamed token and would make every tick a transition; for those,
      // the length is enough to see movement without the noise.
      text: leafish ? clip(full, 160) : null,
      textLen: full.length,
      disabled: an.disabled === true || an.getAttribute('aria-disabled') === 'true',
      visible: vis(an)
    };
  }

  // Derived counters read straight off the transcript element, so a change is
  // readable in a diff without parsing attribute strings.
  function numAttr(sel, name) {
    var el = document.querySelector(sel);
    if (!el) return null;
    var raw = el.getAttribute(name);
    if (raw === null || raw === '') return raw === null ? null : '';
    var n = Number(raw);
    return isNaN(n) ? raw : n;
  }
  v.timeline = {
    rows: numAttr('[data-testid="v4-timeline"]', 'data-row-count'),
    totalRows: numAttr('[data-testid="v4-timeline"]', 'data-total-row-count'),
    windowRows: numAttr('[data-testid="v4-timeline"]', 'data-window-row-count'),
    renderUnits: numAttr('[data-testid="v4-timeline"]', 'data-render-unit-count'),
    following: numAttr('[data-testid="v4-timeline"]', 'data-following'),
    scrollLocked: numAttr('[data-testid="v4-timeline"]', 'data-v4-timeline-scroll-locked'),
    loadingOlder: numAttr('[data-testid="v4-timeline"]', 'data-loading-older')
  };
  v.run = {
    sessionId: numAttr('[data-testid="v4-session-pane-workspace-main"]', 'data-session-id'),
    projectionSeq: numAttr('[data-testid="v4-session-pane-workspace-main"]', 'data-projection-seq'),
    runningSubagentIds: numAttr('[data-testid="v4-session-pane-workspace-main"]', 'data-running-subagent-ids'),
    runningSubagentWorkIds: numAttr('[data-testid="v4-session-pane-workspace-main"]', 'data-running-subagent-work-ids'),
    dropTarget: numAttr('[data-testid="v4-session-pane-workspace-main"]', 'data-v4-conversation-drop-target')
  };

  // Composer controls: the send/stop button swap is the primary running signal.
  var btns = composer ? buttonsIn(composer) : [];
  v.composerButtons = btns.map(function (b) { return { key: b.key, disabled: b.disabled, dataState: b.dataState, text: b.text }; });

  // Live regions, keyed on attributes; text recorded for the report only.
  var live = [];
  var liveList = document.querySelectorAll('[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"], [role="log"], [role="progressbar"], [aria-busy="true"]');
  for (var i = 0; i < liveList.length && live.length < 24; i++) {
    var el = liveList[i];
    var k = liveKind(el);
    live.push({ key: keyOf(el), kind: k, text: clip((el.textContent || '').trim(), 200), visible: vis(el), box: box(el) });
  }
  v.live = live;

  // Noteworthy elements, reduced to their identity + text. Scanned inside the
  // conversation pane only: the sidebar is by far the noisiest part of the tree
  // and its state says nothing about a run.
  var pane = document.querySelector('[data-testid="v4-pane-shell-workspace-main"]') || document.body;
  var paneEls = pane.querySelectorAll('*');
  var note = [];
  for (i = 0; i < paneEls.length && note.length < 60; i++) {
    var n = paneEls[i];
    if (!noteworthy(n)) continue;
    note.push({ key: keyOf(n), text: clip(ownText(n), 120), attrs: attrsOf(n), visible: vis(n) });
  }
  v.noteworthy = note;

  // Structure counts: how much transcript exists at this instant.
  v.counts = {
    collapsible: pane.querySelectorAll('[data-slot="collapsible"], [data-slot="collapsible-trigger"]').length,
    buttons: document.querySelectorAll('button, [role="button"]').length,
    dialogs: document.querySelectorAll('[role="dialog"], [role="alertdialog"], [data-slot="dialog-content"], [data-slot="alert-dialog-content"]').length,
    busy: document.querySelectorAll('[aria-busy="true"]').length,
    progressbar: document.querySelectorAll('[role="progressbar"], progress').length
  };

  // Dialogs, in full: approval surfaces show up here.
  var dialogs = [];
  var dlgList = document.querySelectorAll('[role="dialog"], [role="alertdialog"], [data-slot="dialog-content"], [data-slot="alert-dialog-content"]');
  for (i = 0; i < dlgList.length && dialogs.length < 8; i++) {
    var d = dlgList[i];
    if (!vis(d)) continue;
    dialogs.push({ key: keyOf(d), attrs: attrsOf(d), text: clip(d.textContent, 300), buttons: buttonsIn(d) });
  }
  v.dialogs = dialogs;

  // The status strip around the composer, keyed on attributes only.
  var strip = [];
  if (editor) {
    var er = editor.getBoundingClientRect();
    for (i = 0; i < paneEls.length && strip.length < 20; i++) {
      var s = paneEls[i];
      if (s === editor || s.contains(editor) || editor.contains(s)) continue;
      if (s.childElementCount > 0) continue;
      if (!vis(s)) continue;
      var t = (s.textContent || '').trim();
      if (!t || t.length > 220) continue;
      var r = s.getBoundingClientRect();
      if (r.left < er.left - 320 || r.right > er.right + 320) continue;
      if (r.top < er.top - 300 || r.bottom > er.bottom + 160) continue;
      strip.push({ key: keyOf(s), attrs: attrsOf(s), text: clip(t, 220), box: box(s), visible: true });
    }
  }
  v.strip = strip;

  // Editor content length, so "an empty composer" is visible without text.
  if (editor) v.editorTextLength = (editor.value != null ? String(editor.value) : (editor.textContent || '')).trim().length;
  return v;
})()`;

// A compact JSON of the vector, used as the equality key for transition
// detection. Computed page-side so the comparison never depends on key order.
const VECTOR_KEY = '(function(){ var v = ' + VECTOR + '; return JSON.stringify(v); })()';

// ------------------------------------------------------------------- driver --
// Driving the UI is separate from observing it, and it may use text heuristics
// (there is no contract for the send control). Observation code never does.
//
// Typing goes through Chromium's own input pipeline (Input.insertText /
// Input.dispatchKeyEvent), not through DOM assignment: the composer is a
// Lexical editor (data-lexical-editor="true"), which ignores textContent and
// only reacts to real beforeinput/input events. Measured on 3.12.3: a
// textContent write left the composer empty, and execCommand('insertText')
// inserted nothing detectable, while Input.insertText filled it.
const FOCUS_EDITOR = '(function(){\n' + HELPERS + `
  var editor = document.querySelector('[contenteditable="true"], textarea, [role="textbox"]');
  if (!editor) return { found: false };
  editor.focus();
  var sel = window.getSelection();
  sel.removeAllRanges();
  var range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  sel.addRange(range);
  var r = editor.getBoundingClientRect();
  return { found: true, key: keyOf(editor), box: { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }, focused: document.activeElement === editor };
})()`;

const EDITOR_STATE = '(function(){\n' + HELPERS + `
  var editor = document.querySelector('[contenteditable="true"], textarea, [role="textbox"]');
  if (!editor) return { found: false, len: 0, text: '' };
  var v = editor.value != null ? String(editor.value) : (editor.textContent || '');
  return { found: true, len: v.trim().length, text: clip(v, 120), key: keyOf(editor) };
})()`;

// The submit control, identified by its own attributes. Two accepted handles,
// both structural: the explicit testid, or an aria-label matching send/submit.
// There is deliberately no positional fallback: clicking the wrong control in
// this row opens a model or mode menu, which is exactly the kind of side effect
// that must not be possible from a probe.

// Clicks the submit control and reports whether the composer then emptied,
// which is the only evidence that the prompt was actually taken.
const CLICK_SUBMIT = '(function(){\n' + HELPERS + `
  var explicit = document.querySelector('[data-testid="v4-composer-send"]');
  var target = null, how = null;
  function eligible(el) { return el && el.disabled !== true && el.getAttribute('aria-disabled') !== 'true' && getComputedStyle(el).pointerEvents !== 'none'; }
  if (eligible(explicit)) { target = explicit; how = 'testid'; }
  if (!target) {
    var pool = document.querySelectorAll('button, [role="button"], [type="submit"]');
    var prefer = /(send|submit)/i;
    for (var i = 0; i < pool.length; i++) {
      var b = pool[i];
      if (!eligible(b)) continue;
      var label = (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('data-testid') || '') + ' ' + (b.getAttribute('title') || '');
      if (prefer.test(label)) { target = b; how = 'aria-label'; break; }
    }
  }
  if (!target) return { clicked: false, reason: 'no enabled submit control found' };
  var key = keyOf(target);
  target.click();
  return { clicked: true, how: how, key: key };
})()`;
// Presses Enter in the composer through CDP input events (fallback path).
async function pressEnter(send) {
  const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' };
  await send('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, key));
  await send('Input.dispatchKeyEvent', Object.assign({ type: 'char' }, { text: '\r', key: 'Enter', unmodifiedText: '\r' }));
  await send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, key));
}

// Focuses the editing surface with a real click, so the caret really is inside
// the Lexical editor rather than merely on it.
async function focusEditor(send) {
  const info = await evaluate(send, FOCUS_EDITOR);
  if (!info || !info.found) return { found: false };
  const x = Math.round(info.box.cx);
  const y = Math.round(info.box.cy);
  try {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x, y: y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x, y: y, button: 'left', clickCount: 1 });
  } catch (err) {
    info.clickError = String(err.message || err);
  }
  await sleep(150);
  return info;
}

// Types a prompt and submits it. Returns every step, because "the prompt was
// accepted" is a claim that has to be evidenced, not assumed.
async function typeAndSubmit(send, text, settleMs) {
  const out = { text: text, focus: null, before: null, after: null, submit: null, typed: false, submitted: false, how: null, accepted: false };
  out.focus = await focusEditor(send);
  if (!out.focus || !out.focus.found) return out;
  out.before = await evaluate(send, EDITOR_STATE);
  try { await send('Input.insertText', { text: text }); }
  catch (err) { out.insertTextError = String(err.message || err); }
  await sleep(200);
  out.after = await evaluate(send, EDITOR_STATE);
  if (!out.after || !out.after.len) {
    if (text.length <= 300) {
      for (const ch of text) await send('Input.dispatchKeyEvent', { type: 'char', text: ch });
      await sleep(250);
      out.afterChars = await evaluate(send, EDITOR_STATE);
    }
  }
  out.typed = !!((out.afterChars && out.afterChars.len) || (out.after && out.after.len));
  out.submit = await evaluate(send, CLICK_SUBMIT);
  out.submitted = !!(out.submit && out.submit.clicked);
  if (out.submitted) out.how = 'click:' + out.submit.how;
  else { await pressEnter(send); out.how = 'enter'; }
  await sleep(settleMs);
  out.afterSubmit = await evaluate(send, EDITOR_STATE);
  out.accepted = out.typed && !!out.afterSubmit && out.afterSubmit.len === 0;
  return out;
}

// Clicks the composer's stop control (drives the interrupted state).
const CLICK_STOP = '(function(){\n' + HELPERS + `
  var editor = document.querySelector('[contenteditable="true"], textarea, [role="textbox"]');
  var composer = editor, hops = 0;
  while (composer && composer.parentElement && composer.parentElement !== document.body && hops < 6) { composer = composer.parentElement; hops += 1; }
  var cands = composer ? buttonsIn(composer) : [];
  var stopRe = /(stop|cancel|abort|interrupt)/i;
  var chosen = null, pool = document.querySelectorAll('button, [role="button"], [data-slot="button"]');
  for (var i = 0; i < cands.length; i++) {
    if (!stopRe.test(cands[i].key) && !stopRe.test(cands[i].text)) continue;
    for (var j = 0; j < pool.length; j++) {
      if (keyOf(pool[j]) === cands[i].key && pool[j].getBoundingClientRect().top === cands[i].box.top) { chosen = pool[j]; break; }
    }
    if (chosen) break;
  }
  if (!chosen) return { clicked: false, candidates: cands };
  chosen.click();
  return { clicked: true, key: keyOf(chosen), text: clip(ownText(chosen), 60), candidates: cands };
})()`;

// Clicks a button inside an open dialog, matched on its own attributes or text.
const CLICK_DIALOG_BUTTON = (pattern) => '(function(){\n' + HELPERS + `
  var re = new RegExp(${JSON.stringify(pattern)}, 'i');
  var dlgs = document.querySelectorAll('[role="dialog"], [role="alertdialog"], [data-slot="dialog-content"], [data-slot="alert-dialog-content"]');
  var pool = document.querySelectorAll('button, [role="button"], [data-slot="button"]');
  var seen = [], all = [];
  for (var i = 0; i < pool.length; i++) { all.push(pool[i]); }
  for (var d = 0; d < dlgs.length; d++) {
    var inDlg = dlgs[d].querySelectorAll('button, [role="button"], [data-slot="button"]');
    for (var q = 0; q < inDlg.length; q++) { if (all.indexOf(inDlg[q]) < 0) all.push(inDlg[q]); }
  }
  for (var k = 0; k < all.length; k++) {
    var b = all[k];
    if (!vis(b)) continue;
    seen.push({ key: keyOf(b), text: clip(ownText(b), 60), inDialog: dlgs.length > 0 && (dlgs[0] ? dlgs[0].contains(b) : false) });
    if (b.disabled === true || b.getAttribute('aria-disabled') === 'true') continue;
    var label = keyOf(b) + ' ' + ownText(b) + ' ' + (b.getAttribute('title') || '');
    if (!re.test(label)) continue;
    b.click();
    return { clicked: true, key: keyOf(b), text: clip(ownText(b), 60), seen: seen };
  }
  return { clicked: false, seen: seen };
})()`;

// --------------------------------------------------------------- lifecycle --
function resolveScratch(args) {
  const temp = tempRoot();
  const root = path.resolve(args.scratch || path.join(temp, 'zct-signals-' + stamp() + '-' + args.port));
  // ZCode resolves its home from any of ZCODE_HOME, HOME/.zcode or
  // ZCODE_DATA_BASE_DIR/.zcode depending on the code path. All of them are
  // pointed at the same scratch directory, so there is no code path left that
  // can reach the real ~/.zcode.
  const homeParent = path.join(root, 'home');
  const scratch = {
    root: root,
    profile: path.resolve(args.profile || path.join(root, 'zcode-profile')),
    home: homeParent,
    zcodeHome: path.resolve(args.zcodeHome || path.join(homeParent, '.zcode')),
    userhome: path.join(root, 'userhome'),
    session: path.join(root, 'zcode-session'),
    appdata: path.join(root, 'appdata'),
    beautify: path.join(root, 'plugin-data'),
  };
  for (const key of Object.keys(scratch)) {
    const problem = scratchPathProblem(scratch[key], 'scratch ' + key);
    if (problem) return { refusal: problem };
  }
  return { scratch: scratch };
}

async function launchInstance(args, report) {
  const resolved = resolveScratch(args);
  if (resolved.refusal) {
    report.refusal = resolved.refusal;
    report.ok = false;
    return { ok: false, code: 2, report: report };
  }
  const scratch = resolved.scratch;
  report.scratch = scratch;

  if (!fs.existsSync(args.exe)) {
    report.refusal = 'ZCode.exe not found at ' + args.exe;
    report.ok = false;
    return { ok: false, code: 2, report: report };
  }
  const probe = await tcpProbe(args.port);
  if (probe === 'listening') {
    report.refusal = 'CDP port ' + args.port + ' is already listening; refusing to disturb the instance that owns it';
    return { ok: false, code: 2, report: report };
  }
  if (probe !== 'free') {
    report.refusal = 'could not prove CDP port ' + args.port + ' is free (TCP probe: ' + probe + ')';
    return { ok: false, code: 2, report: report };
  }
  for (const key of Object.keys(scratch)) fs.mkdirSync(scratch[key], { recursive: true });
  fs.mkdirSync(path.join(scratch.zcodeHome, 'v2'), { recursive: true });

  report.realStoreBefore = storeStamps();
  if (args.copyCreds) {
    copyCredentials(scratch.zcodeHome, report);
    if (report.credentials.copied.length === 0) {
      report.refusal = 'no credential file could be copied from ' + report.credentials.source + '; refusing to launch into an unusable scratch home';
      return { ok: false, code: 2, report: report };
    }
  } else {
    report.credentials = { copied: [], skipped: CRED_FILES.slice(), note: '--no-copy-creds' };
  }

  const launchEnv = Object.assign({}, process.env, {
    APPDATA: scratch.appdata,
    USERPROFILE: scratch.userhome,
    HOME: scratch.home,
    ZCODE_HOME: scratch.zcodeHome,
    ZCODE_DATA_BASE_DIR: scratch.home,
    ZCODE_DESKTOP_HOME_DIR: scratch.zcodeHome,
    ZCODE_DESKTOP_USER_DATA_DIR: scratch.profile,
    ZCODE_DESKTOP_SESSION_DATA_DIR: scratch.session,
    ZCODE_BEAUTIFY_DATA_DIR: scratch.beautify,
  });
  const stdoutLog = path.join(scratch.root, 'zcode-stdout.log');
  const stderrLog = path.join(scratch.root, 'zcode-stderr.log');
  const outFd = fs.openSync(stdoutLog, 'a');
  const errFd = fs.openSync(stderrLog, 'a');
  const launchArgs = ['--remote-debugging-port=' + args.port, '--user-data-dir=' + scratch.profile];
  const child = spawn(args.exe, launchArgs, { detached: true, stdio: ['ignore', outFd, errFd], windowsHide: true, env: launchEnv, cwd: scratch.root });
  child.once('error', (err) => { report.spawnError = String((err && err.message) ? err.message : err); });
  child.unref();
  fs.closeSync(outFd);
  fs.closeSync(errFd);
  report.launch = { exe: args.exe, args: launchArgs, pid: child.pid, env: {
    APPDATA: scratch.appdata, USERPROFILE: scratch.userhome, HOME: scratch.home,
    ZCODE_HOME: scratch.zcodeHome, ZCODE_DATA_BASE_DIR: scratch.home,
    ZCODE_DESKTOP_HOME_DIR: scratch.zcodeHome,
    ZCODE_DESKTOP_USER_DATA_DIR: scratch.profile, ZCODE_DESKTOP_SESSION_DATA_DIR: scratch.session,
    ZCODE_BEAUTIFY_DATA_DIR: scratch.beautify,
  }, stdoutLog: stdoutLog, stderrLog: stderrLog };

  const base = 'http://127.0.0.1:' + args.port;
  const waited = await findPageTarget(base, args.timeoutMs);
  if (!waited.target) {
    report.refusal = 'no renderer page target within ' + args.timeoutMs + ' ms (' + (waited.targets || []).length + ' CDP target(s) seen)';
    report.stderrTail = tail(stderrLog);
    return { ok: false, code: 2, report: report };
  }
  report.pageTarget = { id: waited.target.id, title: waited.target.title, url: waited.target.url };
  report.port = args.port;
  report.base = base;
  report.ok = true;
  return { ok: true, code: 0, report: report, scratch: scratch, target: waited.target, base: base };
}

function tail(file, lines = 6) {
  try {
    return fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).slice(-lines).join(' | ');
  } catch (e) { return ''; }
}

async function openSession(base, target) {
  const ws = await connect(target.webSocketDebuggerUrl);
  const send = makeSender(ws);
  await send('Runtime.enable');
  await send('Page.enable').catch(() => {});
  return { ws: ws, send: send };
}

// Waits for the renderer to look like a usable chat surface: React mounted and
// an editing surface present. Returns the last observation either way, so an
// instance stuck on the login screen is reported as such rather than timing out
// silently.
async function waitForChat(send, budgetMs) {
  const deadline = Date.now() + budgetMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await evaluate(send, '({ root: !!document.getElementById("root"), rootChildren: document.getElementById("root") ? document.getElementById("root").childElementCount : 0, editor: !!document.querySelector(\'[contenteditable="true"], textarea, [role="textbox"]\'), greeting: !!document.querySelector(\'p[data-v4-draft-greeting="true"]\'), title: document.title })');
    if (last && last.root && last.editor) return { ready: true, state: last };
    await sleep(400);
  }
  return { ready: false, state: last };
}

// ------------------------------------------------------------------ cleanup --
async function closeInstance(port, scratch, options) {
  const result = { port: port, browserClose: null, browserCloseError: null, portReleased: false, pidsMatched: [], pidsStopped: [], note: null };
  const base = 'http://127.0.0.1:' + port;
  // 1. The polite path: this instance's own browser endpoint.
  try {
    const version = await httpJson(base + '/json/version', 4000);
    const ws = await connect(version.webSocketDebuggerUrl, 5000);
    const send = makeSender(ws);
    try {
      // Browser.close may never answer: the browser is already gone by the time
      // it would reply. That is normal and is not an error.
      await Promise.race([send('Browser.close'), sleep(3000)]);
      result.browserClose = 'sent';
    } catch (err) {
      result.browserCloseError = String(err.message || err);
    }
    try { ws.close(); } catch (e) {}
  } catch (err) {
    result.browserClose = 'not-reachable';
  }
  // 2. Verify the port is released.
  for (let i = 0; i < 20; i += 1) {
    if (!(await portListening(port))) { result.portReleased = true; break; }
    await sleep(500);
  }
  // 3. Residual processes: only those carrying BOTH this run's scratch profile
  // path and this port. Never by image name.
  const profile = scratch && scratch.profile ? scratch.profile : (options && options.profile ? options.profile : '');
  if (profile) {
    result.pidsMatched = await psListScratch(profile, port);
  } else {
    result.note = 'no scratch profile given: process kill path skipped (Browser.close only)';
  }
  if (!result.portReleased && result.pidsMatched.length > 0) {
    result.pidsStopped = await psStop(result.pidsMatched);
    for (let i = 0; i < 20; i += 1) {
      if (!(await portListening(port))) { result.portReleased = true; break; }
      await sleep(250);
    }
  }
  if (!result.portReleased && !profile && options && options.allowPortKill) {
    const byPort = await psListByPort(port);
    result.pidsMatched = byPort;
    result.pidsStopped = await psStop(byPort);
    result.note = (result.note || '') + ' port-match kill used (--allow-port-kill)';
    for (let i = 0; i < 20; i += 1) {
      if (!(await portListening(port))) { result.portReleased = true; break; }
      await sleep(250);
    }
  }
  if (!result.portReleased) {
    const leftovers = await psListByPort(port);
    result.remainingPids = leftovers;
    result.note = (result.note ? result.note + '; ' : '') + 'port still listening with ' + leftovers.length + ' process(es) carrying --remote-debugging-port=' + port;
  }
  return result;
}

function removeScratch(scratch) {
  if (!scratch || !scratch.root) return { removed: false, reason: 'no scratch root' };
  const problem = scratchPathProblem(scratch.root, 'scratch root');
  if (problem) return { removed: false, reason: problem };
  try {
    fs.rmSync(scratch.root, { recursive: true, force: true });
    return { removed: !fs.existsSync(scratch.root) };
  } catch (err) {
    return { removed: !fs.existsSync(scratch.root), error: String((err && err.message) ? err.message : err) };
  }
}

// ------------------------------------------------------------------- flows --
function writeOut(file, data) {
  if (!file) return null;
  try {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    fs.writeFileSync(path.resolve(file), JSON.stringify(data, null, 2));
    return path.resolve(file);
  } catch (err) { return null; }
}

// Note: this writer only ever targets paths the caller named plus the scratch
// tree, so it cannot walk into the repository by accident.
async function cmdLaunch(args) {
  const report = { tool: 'probe-signals.mjs', cmd: 'launch', version: 1, startedAt: new Date().toISOString() };
  const launched = await launchInstance(args, report);
  if (!launched.ok) {
    report.finishedAt = new Date().toISOString();
    printLaunch(report);
    writeOut(args.out, report);
    return launched.code;
  }
  const session = await openSession(launched.base, launched.target);
  const ready = await waitForChat(session.send, args.timeoutMs);
  report.chat = ready;
  report.ready = ready.ready;
  report.startedAtReal = new Date().toISOString();
  // The caller keeps this instance alive on purpose; record the session file so
  // a later `close --scratch <dir>` can find the profile without guessing, and
  // so the real-store tripwire survives across the two processes: the stamps
  // taken before the launch are handed to the close command.
  writeOut(path.join(launched.scratch.root, 'session.json'), {
    tool: 'probe-signals.mjs', port: args.port, scratchRoot: launched.scratch.root,
    profile: launched.scratch.profile, zcodeHome: launched.scratch.zcodeHome,
    pid: report.launch.pid, startedAt: new Date().toISOString(),
    realStoreBefore: report.realStoreBefore,
  });
  try { session.ws.close(); } catch (e) {}
  report.finishedAt = new Date().toISOString();
  printLaunch(report);
  writeOut(args.out, report);
  return report.ready ? 0 : 1;
}

function printLaunch(report) {
  if (report.refusal) {
    console.error('REFUSED: ' + report.refusal);
    if (report.stderrTail) console.error('stderr tail: ' + report.stderrTail);
    return;
  }
  if (report.scratch) console.log('scratch root: ' + report.scratch.root);
  if (report.credentials) console.log('credentials copied: ' + report.credentials.copied.length + '/' + CRED_FILES.length + (report.credentials.skipped.length ? ' (skipped: ' + report.credentials.skipped.join(', ') + ')' : ''));
  if (report.launch) console.log('launched pid ' + report.launch.pid + ' args: ' + report.launch.args.join(' '));
  if (report.pageTarget) console.log('page target: ' + report.pageTarget.title + ' <' + report.pageTarget.url + '>');
  if (report.chat) console.log('chat surface ready: ' + report.chat.ready + ' ' + JSON.stringify(report.chat.state));
}

async function withInstance(args, fn) {
  // Shared shape for snapshot/watch/send/close: connect to the instance that
  // owns this port, run fn, and leave the instance running (the caller decides
  // when to close it).
  const base = 'http://127.0.0.1:' + args.port;
  let version;
  try { version = await httpJson(base + '/json/version', 4000); }
  catch (err) { return { ok: false, code: 2, reason: 'no CDP endpoint on port ' + args.port + ' (' + String(err.message || err) + ')' }; }
  const waited = await findPageTarget(base, 15000);
  if (!waited.target) return { ok: false, code: 2, reason: 'no renderer page target on port ' + args.port };
  const session = await openSession(base, waited.target);
  try {
    return await fn(session, base, waited.target, version);
  } finally {
    try { session.ws.close(); } catch (e) {}
  }
}

async function cmdSnapshot(args) {
  const result = await withInstance(args, async (session) => {
    const snap = await evaluate(session.send, SNAPSHOT);
    return { ok: true, code: 0, snapshot: snap };
  });
  if (!result.ok) { console.error('REFUSED: ' + result.reason); return result.code; }
  const file = writeOut(args.out, result.snapshot);
  if (file) console.log('snapshot written: ' + file);
  else console.log(JSON.stringify(result.snapshot));
  return 0;
}

async function cmdSend(args) {
  if (!args.text) { console.error('REFUSED: --text is required'); return 2; }
  const result = await withInstance(args, async (session) => {
    const before = await evaluate(session.send, VECTOR);
    const typed = await typeAndSubmit(session.send, args.text, args.settleMs);
    const after = await evaluate(session.send, VECTOR);
    return { ok: true, code: 0, typed: typed, before: before, after: after };
  });
  if (!result.ok) { console.error('REFUSED: ' + result.reason); return result.code; }
  const out = { tool: 'probe-signals.mjs', cmd: 'send', version: 1, at: new Date().toISOString(), text: args.text, typed: result.typed, before: result.before, after: result.after };
  const file = writeOut(args.out, out);
  console.log('send: typed=' + result.typed.typed + ' submitted=' + result.typed.submitted + ' how=' + result.typed.how + ' accepted=' + result.typed.accepted + (file ? ' -> ' + file : ''));
  if (!result.typed.accepted) console.error('prompt NOT accepted: ' + JSON.stringify(result.typed).slice(0, 800));
  return result.typed.accepted ? 0 : 1;
}

// The transition watcher: polls the vector, and records a transition whenever
// its key changes. Every transition carries both sides so a reader can see what
// actually moved instead of trusting a label.
async function watchTransitions(session, seconds, intervalMs, options) {
  const timeline = [];
  const startedAt = Date.now();
  const deadline = startedAt + seconds * 1000;
  let prevKey = null;
  let prevVec = null;
  let ticks = 0;
  let first = true;
  while (Date.now() < deadline) {
    const vec = await evaluate(session.send, VECTOR);
    const key = vectorKey(vec);
    ticks += 1;
    if (key !== prevKey) {
      const change = summarizeChange(prevVec, vec, options && options.maxItems ? options.maxItems : 6);
      timeline.push({
        index: timeline.length,
        tick: ticks,
        at: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        wall: vec.wall,
        perfNow: vec.t,
        first: first,
        change: change,
        // The vector without geometry; the first transition is the baseline.
        vector: stripBoxes(vec),
      });
      if (options && options.onTransition) options.onTransition(timeline[timeline.length - 1]);
      prevKey = key;
      prevVec = vec;
      first = false;
    }
    if (options && options.onTick) options.onTick(ticks, vec);
    await sleep(intervalMs);
  }
  return { ticks: ticks, elapsedMs: Date.now() - startedAt, transitions: timeline };
}

// A human-readable account of what moved between two vectors. Structural: it
// names the attribute or count that changed, not the words on screen.
function summarizeChange(prev, next, maxItems) {
  if (!prev) return { kind: 'initial', markers: markersOf(next) };
  const items = [];
  const push = (what, from, to) => { if (items.length < maxItems) items.push({ what: what, from: from, to: to }); };
  if (prev.greeting !== next.greeting) push('greeting', prev.greeting, next.greeting);
  if (prev.editor !== next.editor) push('editor', prev.editor, next.editor);
  if (prev.composer !== next.composer) push('composer', prev.composer, next.composer);
  if (prev.editorTextLength !== next.editorTextLength) push('editorTextLength', prev.editorTextLength, next.editorTextLength);
  // Transcript counters: the sharpest "a row appeared" signal there is.
  for (const k of Object.keys(next.timeline || {})) {
    const a = (prev.timeline || {})[k], b = (next.timeline || {})[k];
    if (a !== b) push('timeline.' + k, a, b);
  }
  for (const k of Object.keys(next.run || {})) {
    const a = (prev.run || {})[k], b = (next.run || {})[k];
    if (a !== b) push('run.' + k, a, b);
  }
  // Anchor attribute sets, per named handle, reported as the changed keys only.
  for (const name of Object.keys(next.anchors || {})) {
    const a = (prev.anchors || {})[name], b = (next.anchors || {})[name];
    const ak = a ? JSON.stringify({ key: a.key, attrs: a.attrs, disabled: a.disabled, visible: a.visible, text: a.text }) : 'absent';
    const bk = b ? JSON.stringify({ key: b.key, attrs: b.attrs, disabled: b.disabled, visible: b.visible, text: b.text }) : 'absent';
    if (ak === bk) continue;
    const changed = [];
    for (const f of ['key', 'disabled', 'visible', 'text']) {
      const av = a ? a[f] : null, bv = b ? b[f] : null;
      if (JSON.stringify(av) !== JSON.stringify(bv)) changed.push({ field: f, from: av, to: bv });
    }
    const aAttrs = (a && a.attrs) || {}, bAttrs = (b && b.attrs) || {};
    for (const k of new Set(Object.keys(aAttrs).concat(Object.keys(bAttrs)))) {
      if (aAttrs[k] !== bAttrs[k]) changed.push({ attr: k, from: aAttrs[k] === undefined ? null : aAttrs[k], to: bAttrs[k] === undefined ? null : bAttrs[k] });
    }
    push('anchor.' + name, changed.length ? changed.slice(0, 6) : 'changed', 'see items');
    // Replace the placeholder above with the real fields, bounded.
    if (items.length) items[items.length - 1].detail = changed;
  }
  const pb = (prev.composerButtons || []).map((b) => b.key + (b.disabled ? ':off' : ':on')).sort().join(',');
  const nb = (next.composerButtons || []).map((b) => b.key + (b.disabled ? ':off' : ':on')).sort().join(',');
  if (pb !== nb) {
    const before = (prev.composerButtons || []).map((b) => b.key + (b.disabled ? ':off' : ':on'));
    const after = (next.composerButtons || []).map((b) => b.key + (b.disabled ? ':off' : ':on'));
    push('composerButtons', before.filter((x) => after.indexOf(x) < 0), after.filter((x) => before.indexOf(x) < 0));
  }
  for (const k of Object.keys(next.counts || {})) {
    const a = (prev.counts || {})[k], b = (next.counts || {})[k];
    if (a !== b) push('counts.' + k, a, b);
  }
  const keyed = (list) => (list || []).map((x) => x.key + '|' + (x.attrs ? JSON.stringify(x.attrs) : '') + '|' + (x.text || '')).sort();
  const liveBefore = keyed(prev.live), liveAfter = keyed(next.live);
  const liveAdded = liveAfter.filter((x) => liveBefore.indexOf(x) < 0);
  const liveRemoved = liveBefore.filter((x) => liveAfter.indexOf(x) < 0);
  if (liveAdded.length) push('live+', [], liveAdded.slice(0, 4));
  if (liveRemoved.length) push('live-', liveRemoved.slice(0, 4), []);
  const noteBefore = keyed(prev.noteworthy), noteAfter = keyed(next.noteworthy);
  const noteAdded = noteAfter.filter((x) => noteBefore.indexOf(x) < 0);
  const noteRemoved = noteBefore.filter((x) => noteAfter.indexOf(x) < 0);
  if (noteAdded.length) push('noteworthy+', [], noteAdded.slice(0, 4));
  if (noteRemoved.length) push('noteworthy-', noteRemoved.slice(0, 4), []);
  const dlgBefore = keyed(prev.dialogs), dlgAfter = keyed(next.dialogs);
  if (JSON.stringify(dlgBefore) !== JSON.stringify(dlgAfter)) push('dialogs', dlgBefore, dlgAfter);
  const stripBefore = keyed(prev.strip), stripAfter = keyed(next.strip);
  const stripAdded = stripAfter.filter((x) => stripBefore.indexOf(x) < 0);
  const stripRemoved = stripBefore.filter((x) => stripAfter.indexOf(x) < 0);
  if (stripAdded.length) push('strip+', [], stripAdded.slice(0, 4));
  if (stripRemoved.length) push('strip-', stripRemoved.slice(0, 4), []);
  return { kind: 'delta', markers: markersOf(next), items: items };
}

// The one-line summary of a state, so a timeline can be read at a glance
// without opening any single vector.
function markersOf(vec) {
  if (!vec) return null;
  const t = vec.timeline || {};
  return {
    greeting: vec.greeting,
    editorLen: vec.editorTextLength,
    rows: t.rows,
    renderUnits: t.renderUnits,
    following: t.following,
    scrollLocked: t.scrollLocked,
    session: vec.run ? vec.run.sessionId : null,
    projectionSeq: vec.run ? vec.run.projectionSeq : null,
    subagents: vec.run ? vec.run.runningSubagentIds : null,
    busy: vec.counts ? vec.counts.busy : null,
    progressbar: vec.counts ? vec.counts.progressbar : null,
    dialogs: vec.dialogs ? vec.dialogs.length : null,
    sendDisabled: (function () {
      const b = (vec.composerButtons || []).find((x) => /v4-composer-send/.test(x.key));
      return b ? b.disabled : null;
    })(),
  };
}

async function cmdWatch(args) {
  const seconds = args.seconds > 0 ? args.seconds : 30;
  const result = await withInstance(args, async (session) => {
    const timeline = await watchTransitions(session, seconds, args.intervalMs, {
      onTransition: (t) => {
        console.log('[' + pad(t.elapsedMs + 'ms', 9) + '] #' + t.index + ' ' + JSON.stringify(t.change).slice(0, 400));
      },
    });
    return { ok: true, code: 0, watch: timeline };
  });
  if (!result.ok) { console.error('REFUSED: ' + result.reason); return result.code; }
  const out = { tool: 'probe-signals.mjs', cmd: 'watch', version: 1, port: args.port, seconds: seconds, intervalMs: args.intervalMs, watch: result.watch };
  const file = writeOut(args.out, out);
  console.log('watch: ' + result.watch.ticks + ' ticks, ' + result.watch.transitions.length + ' transitions' + (file ? ' -> ' + file : ''));
  return 0;
}

async function cmdClose(args) {
  let profile = args.profile;
  let scratch = null;
  if (args.scratch) {
    const resolved = resolveScratch(args);
    if (resolved.refusal) { console.error('REFUSED: ' + resolved.refusal); return 2; }
    scratch = resolved.scratch;
    profile = scratch.profile;
  }
  // Read the pre-launch store stamps the launch command left behind, so the
  // isolation claim is checked in the same process that removes the tree. A
  // change here means something wrote the real store while the scratch instance
  // was up - attributable or not, it must be visible, so it sets exit code 1.
  let before = null;
  if (scratch) {
    try {
      const session = JSON.parse(fs.readFileSync(path.join(scratch.root, 'session.json'), 'utf8'));
      before = session.realStoreBefore || null;
    } catch (e) { before = null; }
  }
  const close = await closeInstance(args.port, scratch, { profile: profile, allowPortKill: args.allowPortKill });
  const report = { tool: 'probe-signals.mjs', cmd: 'close', version: 1, at: new Date().toISOString(), close: close };
  let touched = [];
  if (before) {
    report.realStoreBefore = before;
    report.realStoreAfter = storeStamps();
    touched = compareStamps(before, report.realStoreAfter);
    report.realStoreTouched = touched;
  } else {
    report.realStoreTouched = null;
    report.note = 'no pre-launch store stamps found (launch was given --no-copy-creds or a different scratch root): the real store cannot be compared';
  }
  if (scratch && !args.keepScratch) report.scratchRemoved = removeScratch(scratch);
  const file = writeOut(args.out, report);
  console.log('close: browserClose=' + close.browserClose + ' portReleased=' + close.portReleased + ' matched=' + close.pidsMatched.length + ' stopped=' + close.pidsStopped.length + (file ? ' -> ' + file : ''));
  if (close.note) console.log('note: ' + close.note);
  if (touched.length) console.error('TRIPWIRE: the real store changed while the scratch instance was up: ' + touched.join(', ') + ' (this is a fact about the machine, not proof that this tool wrote it - other instances write settings too)');
  return (close.portReleased && touched.length === 0) ? 0 : 1;
}

// The full cycle used to gather the evidence for the signal table: launch,
// observe the resting state, send each prompt, watch it run, observe the
// resting state again, close, clean up, report.
async function cmdSession(args) {
  const report = { tool: 'probe-signals.mjs', cmd: 'session', version: 1, startedAt: new Date().toISOString(), prompts: [], snapshots: {}, watches: [] };
  const outDir = path.resolve(args.outDir || path.join(tempRoot(), 'zct-signals-out-' + stamp()));
  fs.mkdirSync(outDir, { recursive: true });
  report.outDir = outDir;
  const problems = [];

  const launched = await launchInstance(args, report);
  if (!launched.ok) {
    report.finishedAt = new Date().toISOString();
    printLaunch(report);
    writeOut(args.out, report);
    return launched.code;
  }
  const argsResolved = Object.assign({}, args, { scratch: launched.scratch.root, profile: launched.scratch.profile });
  printLaunch(report);

  let session = null;
  const secondsPerPrompt = args.seconds > 0 ? args.seconds : 60;
  try {
    session = await openSession(launched.base, launched.target);
    const ready = await waitForChat(session.send, args.timeoutMs);
    report.chat = ready;
    if (!ready.ready) {
      problems.push('renderer never exposed a chat surface: ' + JSON.stringify(ready.state));
    }

    report.snapshots.idle = await evaluate(session.send, SNAPSHOT);
    writeOut(path.join(outDir, 'snapshot-idle.json'), report.snapshots.idle);

    const prompts = args.prompts.length ? args.prompts : (args.text ? [args.text] : []);
    for (let i = 0; i < prompts.length; i += 1) {
      const text = prompts[i];
      const entry = { index: i, text: text, at: new Date().toISOString() };
      console.log('[prompt ' + i + '] ' + text);
      entry.before = await evaluate(session.send, VECTOR);
      entry.typed = await typeAndSubmit(session.send, text, args.settleMs);
      console.log('[prompt ' + i + '] typed=' + entry.typed.typed + ' submitted=' + entry.typed.submitted + ' how=' + entry.typed.how + ' accepted=' + entry.typed.accepted);
      if (!entry.typed.accepted) problems.push('prompt ' + i + ' was not accepted by the composer: ' + JSON.stringify(entry.typed).slice(0, 500));
      const watchOptions = {
        onTransition: (t) => { console.log('  [' + pad(t.elapsedMs + 'ms', 9) + '] #' + t.index + ' ' + JSON.stringify(t.change).slice(0, 500)); },
      };
      if (args.stopAfterMs > 0) {
        const stopAt = Date.now() + args.stopAfterMs;
        watchOptions.onTick = async () => {
          if (Date.now() >= stopAt && !entry.stopClicked) {
            entry.stopClickedAt = new Date().toISOString();
            try { entry.stop = await evaluate(session.send, CLICK_STOP); } catch (err) { entry.stop = { error: String(err.message || err) }; }
          }
        };
      }
      const watch = await watchTransitions(session, secondsPerPrompt, args.intervalMs, watchOptions);
      entry.watchTransitions = watch.transitions.length;
      entry.watchTicks = watch.ticks;
      report.watches.push(watch);
      writeOut(path.join(outDir, 'watch-' + i + '.json'), watch);
      entry.after = await evaluate(session.send, VECTOR);
      report.prompts.push(entry);
      report.snapshots['after' + i] = await evaluate(session.send, SNAPSHOT);
      writeOut(path.join(outDir, 'snapshot-after-' + i + '.json'), report.snapshots['after' + i]);
    }
  } catch (err) {
    problems.push('session error: ' + String((err && err.message) ? err.message : err));
  } finally {
    if (session) { try { session.ws.close(); } catch (e) {} }
  }

  report.close = await closeInstance(args.port, launched.scratch, { profile: launched.scratch.profile });
  if (!args.keepScratch) report.scratchRemoved = removeScratch(launched.scratch);
  report.realStoreAfter = storeStamps();
  const touched = compareStamps(report.realStoreBefore, report.realStoreAfter);
  report.realStoreTouched = touched;
  if (touched.length) problems.push('the real store changed during the run: ' + touched.join(', '));
  if (report.close && !report.close.portReleased) problems.push('CDP port ' + args.port + ' was still listening after close');
  if (report.scratchRemoved && report.scratchRemoved.removed === false && !args.keepScratch) problems.push('scratch tree was not removed: ' + JSON.stringify(report.scratchRemoved));
  report.problems = problems;
  report.exitCode = problems.length ? 1 : 0;
  report.finishedAt = new Date().toISOString();
  const file = writeOut(args.out, report);
  console.log('session: ' + report.prompts.length + ' prompt(s), ' + report.watches.reduce((a, w) => a + w.transitions.length, 0) + ' transition(s)');
  console.log('close: ' + JSON.stringify(report.close));
  if (report.scratchRemoved) console.log('scratch removed: ' + JSON.stringify(report.scratchRemoved));
  console.log('real store touched: ' + (touched.length ? touched.join(', ') : 'no'));
  if (problems.length) { console.error('PROBLEMS:'); for (const p of problems) console.error('  - ' + p); }
  if (file) console.log('report: ' + file);
  void argsResolved;
  return report.exitCode;
}

// Utility: run an arbitrary expression in the renderer and print the result.
// Ad-hoc structural questions ("what is the parent of this status span, and
// does it carry aria-live?") are answered with this instead of editing the
// snapshot expression.
async function cmdEval(args) {
  let expr = args.text;
  if (!expr && args.file) {
    try { expr = fs.readFileSync(args.file, 'utf8'); }
    catch (err) { console.error('REFUSED: cannot read --file ' + args.file + ': ' + String(err.message || err)); return 2; }
  }
  if (!expr) { console.error('REFUSED: --expr or --file is required'); return 2; }
  const result = await withInstance(args, async (session) => {
    const value = await evaluate(session.send, expr);
    return { ok: true, code: 0, value: value };
  });
  if (!result.ok) { console.error('REFUSED: ' + result.reason); return result.code; }
  const file = writeOut(args.out, result.value);
  if (file) console.log('eval result written: ' + file);
  else console.log(JSON.stringify(result.value, null, 2));
  return 0;
}

// Utility: click a dialog button (approval decision) on a running instance.
async function cmdClick(args) {
  const result = await withInstance(args, async (session) => {
    const r = await evaluate(session.send, CLICK_DIALOG_BUTTON(args.text || 'allow|approve|accept|confirm|yes'));
    const after = await evaluate(session.send, VECTOR);
    return { ok: true, code: 0, clicked: r, after: after };
  });
  if (!result.ok) { console.error('REFUSED: ' + result.reason); return result.code; }
  const out = { tool: 'probe-signals.mjs', cmd: 'click', version: 1, at: new Date().toISOString(), clicked: result.clicked, after: result.after };
  const file = writeOut(args.out, out);
  console.log('click: ' + JSON.stringify(result.clicked).slice(0, 600) + (file ? ' -> ' + file : ''));
  return result.clicked && result.clicked.clicked ? 0 : 1;
}

const HELP = `probe-signals.mjs - discover and record ZCode client run-state DOM signals.

Commands:
  launch    launch an isolated, credential-copied instance and wait for its chat surface
  snapshot  dump a structural snapshot of the renderer DOM (JSON)
  watch     poll the state vector and record every transition with a timestamp
  send      type a prompt into the composer and submit it
  eval      run an arbitrary expression in the renderer and print the JSON result
  click     click a dialog button (approval decision) matching a regex
  close     close the instance on this port and optionally remove its scratch tree
  session   full cycle: launch, snapshot, prompt(s), watch, snapshot, close, clean up

Examples:
  node tools/probe-signals.mjs session --prompt "reply with the single word OK" --seconds 45 --out <tmp>/ok.json
  node tools/probe-signals.mjs launch --port 9463 --scratch <tmp>/probe
  node tools/probe-signals.mjs snapshot --port 9463 --out <tmp>/idle.json
  node tools/probe-signals.mjs watch --port 9463 --seconds 30 --out <tmp>/watch.json
  node tools/probe-signals.mjs send --port 9463 --text "run echo hi and show the output"
  node tools/probe-signals.mjs eval --port 9463 --expr "document.title"
  node tools/probe-signals.mjs click --port 9463 --text "allow|approve"
  node tools/probe-signals.mjs close --port 9463 --scratch <tmp>/probe

Safety: scratch paths must be under TEMP and outside this repository; the real
~/.zcode is never written to (it is tripwired and reported if it changes); the
launched instance is closed only through its own CDP Browser.close and, if it
survives, by stopping only processes carrying both its scratch profile path and
its scratch CDP port. See the header comment for the full flag list.
`;

// ------------------------------------------------------------------- main --
async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (err) { console.error(String(err.message || err)); console.error(HELP); return 2; }
  if (args.cmd === 'help' || args.cmd === '--help') { console.log(HELP); return 0; }
  switch (args.cmd) {
    case 'launch': return cmdLaunch(args);
    case 'snapshot': return cmdSnapshot(args);
    case 'watch': return cmdWatch(args);
    case 'send': return cmdSend(args);
    case 'eval': return cmdEval(args);
    case 'click': return cmdClick(args);
    case 'close': return cmdClose(args);
    case 'session': return cmdSession(args);
    default:
      console.error('unknown command: ' + args.cmd);
      console.error(HELP);
      return 2;
  }
}

main().then((code) => { process.exitCode = code; }).catch((err) => {
  console.error('FATAL: ' + String((err && err.stack) ? err.stack : err));
  process.exitCode = 2;
});
