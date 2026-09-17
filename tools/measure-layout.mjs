#!/usr/bin/env node
/**
 * measure-layout.mjs - layout measurement over CDP for the zcode-tarkov banner.
 *
 * Connects to the renderer of an isolated ZCode instance, applies a colour mode
 * through the CLI, optionally resizes the real OS window, evaluates the layout
 * measurement expression in the page, prints a readable table and writes the
 * raw observations as JSON. With --shot it also captures a viewport screenshot.
 *
 * It exists because the banner reserves space in ZCode's own layout chain and
 * that chain has to be measured, not assumed: the tool is the evidence source
 * for the "banner band + app root == viewport" invariant.
 *
 * Requirements: Node >= 22 (global WebSocket and fetch; Node 24 here). No
 * dependencies, nothing is installed. Windows-only for the real resize
 * (SetWindowPos); everywhere else the tool falls back to emulated metrics and
 * says so in the output.
 *
 * Usage:
 *   node tools/measure-layout.mjs --port 9455 --mode tarkov --label before \
 *     --out <tmp>/layout-before-1366x768.json --shot <tmp>/layout-before-1366x768.png \
 *     --width 1366 --height 768 --cli <install>/dist/cli.js --data-dir <tmp>/plugin-data
 *
 * Self-contained sweep (no live session required; launches and closes its own
 * isolated scratch instance):
 *   node tools/measure-layout.mjs --sweep --out-dir docs/images/layout --shot-dir docs/images/layout
 *
 * Clipped elements are classified. Anything injected by this project (the
 * banner, the panel root, #zb-* nodes, the wallpaper) fails the
 * no-clipped-elements check in every case. An app-side entry is re-measured
 * after a 1.5s settle: when it clears it is recorded as transient under
 * checks[].detail.transientPaintedOutside and the check passes; only app-side
 * entries still outside the viewport after the settle are persistent failures.
 * Only persistent failures and entries of ours make the exit code non-zero.
 *
 * Flags:
 *   --port N          CDP port of the instance (required unless --sweep; --sweep
 *                     defaults to free port 9471 and refuses a busy one)
 *   --mode M          tarkov | native | monet : applied through the CLI first.
 *                     Omit to measure without changing the current mode.
 *   --out FILE        JSON output path (required)
 *   --label TEXT      "before" | "after" or any label, recorded in the JSON
 *   --shot FILE       capture a viewport screenshot to this PNG
 *   --width / --height N   target CSS-pixel viewport; resizes the real window
 *   --cli FILE        CLI entry point used for --mode (default <repo>/dist/cli.js)
 *   --data-dir DIR    ZCODE_BEAUTIFY_DATA_DIR for the CLI run (keeps writes in a
 *                     scratch tree instead of the real plugin data directory)
 *   --compare FILE    compare geometry against a previous JSON from this tool
 *   --settle-ms N     extra settle time after a mode change / resize (default 500)
 *   --timeout-ms N    renderer wait budget (default 30000)
 *   --case-timeout-ms N  sweep per-case watchdog budget (default 90000)
 *   --no-resize       never touch the window geometry
 *   --sweep           launch an isolated scratch ZCode instance under $env:TEMP,
 *                     measure every viewport x mode combination, write the
 *                     artifacts and close only the instance it started
 *   --out-dir DIR     sweep JSON artifact directory (default docs/images/layout)
 *   --shot-dir DIR    sweep screenshot directory (default --out-dir)
 *
 * Sweep safety: it refuses a busy CDP port, refuses any scratch path that is
 * not under $env:TEMP, never writes into the real profile, and closes the
 * scratch instance by matching the scratch profile path in its command line.
 *
 * Sweep failure handling: a websocket close/error, a dead renderer, or a
 * per-case watchdog timeout aborts the run instead of looking like a pass. The
 * aborted case and the reason are logged and recorded (report.aborted, plus a
 * failing case.aborted check for that case), the remaining cases are skipped,
 * and the exit code is non-zero. Cleanup (close only the instance this run
 * started, delete the scratch tree) always runs in a finally block; the summary
 * reports whether it succeeded (summary.cleanupSucceeded, report.cleanup), so a
 * leftover scratch tree is visible instead of silent.
 *
 * Exit codes: 0 measured (all checks passed if any were evaluated), 1 measured
 * with failed checks, an aborted sweep, or incomplete cleanup, 2 refused (no
 * renderer target / bad arguments / CLI failed).
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

function parseArgs(argv) {
  const out = {
    port: 0, mode: '', out: '', label: '', shot: '', width: 0, height: 0,
    cli: path.join(REPO, 'dist', 'cli.js'), dataDir: '', compare: '',
    settleMs: 500, timeoutMs: 30000, caseTimeoutMs: 90000, resize: true, help: false,
    sweep: false, outDir: '', shotDir: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => { i += 1; return argv[i]; };
    if (a === '--port') out.port = Number(next());
    else if (a === '--mode') out.mode = String(next());
    else if (a === '--out') out.out = String(next());
    else if (a === '--label') out.label = String(next());
    else if (a === '--shot') out.shot = String(next());
    else if (a === '--width') out.width = Number(next());
    else if (a === '--height') out.height = Number(next());
    else if (a === '--cli') out.cli = String(next());
    else if (a === '--data-dir') out.dataDir = String(next());
    else if (a === '--compare') out.compare = String(next());
    else if (a === '--settle-ms') out.settleMs = Number(next());
    else if (a === '--timeout-ms') out.timeoutMs = Number(next());
    else if (a === '--case-timeout-ms') out.caseTimeoutMs = Number(next());
    else if (a === '--no-resize') out.resize = false;
    else if (a === '--sweep') out.sweep = true;
    else if (a === '--out-dir') out.outDir = String(next());
    else if (a === '--shot-dir') out.shotDir = String(next());
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error('unknown argument: ' + a);
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function httpJson(url, timeoutMs = 5000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
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

function run(file, args, env, timeoutMs = 25000) {
  return new Promise((resolve) => {
    const child = execFile(file, args, { env: env || process.env, windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: timeoutMs }, (err, stdout, stderr) => {
      const timedOut = !!(err && (err.killed || err.signal));
      resolve({ code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0, timedOut: timedOut, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
    void child;
  });
}

// ------------------------------------------------------- abort detection --
// A sweep must never turn a dead renderer into an apparent pass. A closed or
// errored CDP socket is latched here (the events fire once), a hung request is
// bounded by withTimeout, and classifySweepAbort turns either into a recorded
// abort instead of a silent continue.
function watchSocket(ws) {
  const state = { closed: false, closeCode: null, closeReason: null, errored: false, error: null, at: null };
  try {
    ws.addEventListener('close', (ev) => {
      if (state.closed) return;
      state.closed = true;
      state.closeCode = ev && typeof ev.code === 'number' ? ev.code : null;
      state.closeReason = ev && ev.reason ? String(ev.reason) : null;
      state.at = new Date().toISOString();
    });
    ws.addEventListener('error', (ev) => {
      if (state.errored) return;
      state.errored = true;
      state.error = (ev && ev.message) ? String(ev.message) : 'websocket error event';
      state.at = new Date().toISOString();
    });
  } catch (e) { /* a socket that cannot be watched cannot be classified */ }
  return state;
}

function socketFailure(state) {
  if (!state) return null;
  if (state.closed) {
    return 'CDP websocket closed' + (state.closeCode === null ? '' : ' (code ' + state.closeCode + ')') +
      (state.closeReason ? ' reason="' + state.closeReason + '"' : '');
  }
  if (state.errored) return 'CDP websocket error: ' + state.error;
  return null;
}

// Error texts Chromium/undici produce when the renderer or its page target is
// gone. A plain CDP evaluate error (bad expression, missing runtime) must keep
// the old behaviour: recorded as a failing case check, sweep continues.
const RENDERER_GONE = [
  /Target closed/i, /target.*closed/i, /Session closed/i, /Connection closed/i,
  /WebSocket is not open/i, /websocket.*(closed|disconnect)/i,
  /socket hang up/i, /ECONNRESET/i, /EPIPE/i, /browser has disconnected/i
];

function withTimeout(promise, ms, label) {
  let timer = null;
  const watchdog = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error('watchdog timeout after ' + ms + ' ms: ' + label);
      err.watchdogTimeout = true;
      err.timeoutMs = ms;
      err.label = label;
      reject(err);
    }, ms);
  });
  return Promise.race([promise, watchdog]).finally(() => { if (timer) clearTimeout(timer); });
}

// Returns the abort record when err/socketState is fatal, else null.
function classifySweepAbort(err, socketState, caseLabel) {
  if (!err && !socketFailure(socketState)) return null;
  const socket = socketFailure(socketState);
  if (socket) return { kind: 'websocket', case: caseLabel, reason: socket };
  if (err && err.watchdogTimeout === true) return { kind: 'watchdog-timeout', case: caseLabel, reason: String((err && err.message) ? err.message : err) };
  if (err) {
    const msg = String(err.message ? err.message : err);
    for (const re of RENDERER_GONE) if (re.test(msg)) return { kind: 'renderer-unreachable', case: caseLabel, reason: msg };
  }
  return null;
}

// --------------------------------------------------------------- measurement --
const MEASURE = `(function(){
  var H = innerHeight, W = innerWidth;
  function num(v){ var n = parseFloat(v); return isNaN(n) ? null : Math.round(n * 100) / 100; }
  function rect(el){
    if (!el) return null;
    var r = el.getBoundingClientRect();
    return { x: num(r.x), y: num(r.y), w: num(r.width), h: num(r.height), top: num(r.top), bottom: num(r.bottom), left: num(r.left), right: num(r.right) };
  }
  var P = ['height','min-height','max-height','overflow','overflow-x','overflow-y','box-sizing','position','top','bottom','margin-top','margin-bottom','padding-top','padding-bottom','display','flex','z-index'];
  function styles(el){
    if (!el) return null;
    var c = getComputedStyle(el), o = {};
    for (var i = 0; i < P.length; i++) o[P[i]] = c.getPropertyValue(P[i]);
    return o;
  }
  function visible(el){
    var c = getComputedStyle(el);
    if (c.display === 'none' || c.visibility === 'hidden') return false;
    if (parseFloat(c.opacity) === 0) return false;
    return true;
  }
  function desc(el){
    if (!el) return null;
    var s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    var slot = el.getAttribute('data-slot');
    if (slot) s += '[data-slot="' + slot + '"]';
    var al = el.getAttribute('aria-label');
    if (al) s += '[aria-label="' + al.slice(0, 30) + '"]';
    return s;
  }
  function pathOf(el, stop){
    var segs = [], cur = el, guard = 0;
    while (cur && cur.nodeType === 1 && guard < 12) {
      segs.unshift(desc(cur));
      if (cur === stop) break;
      cur = cur.parentElement; guard += 1;
    }
    return segs.join(' > ');
  }
  function depthOf(el){
    var d = 0, cur = el;
    while (cur && cur.parentElement) { cur = cur.parentElement; d += 1; }
    return d;
  }
  var out = { };
  out.viewport = { innerWidth: W, innerHeight: H, devicePixelRatio: devicePixelRatio, outerWidth: outerWidth, outerHeight: outerHeight, screen: { w: screen.width, h: screen.height, availW: screen.availWidth, availH: screen.availHeight } };
  out.url = location.href;
  out.title = document.title;
  out.htmlClasses = document.documentElement.className;
  out.bodyClasses = document.body ? document.body.className : '';
  out.bannerAttribute = document.documentElement.getAttribute('data-zct-banner');
  out.bannerHeightVar = getComputedStyle(document.documentElement).getPropertyValue('--zcode-tarkov-banner-height').trim();

  var html = document.documentElement, body = document.body, root = document.getElementById('root');
  out.html = { rect: rect(html), clientWidth: html.clientWidth, clientHeight: html.clientHeight, scrollWidth: html.scrollWidth, scrollHeight: html.scrollHeight, offsetHeight: html.offsetHeight, styles: styles(html) };
  out.body = { rect: rect(body), clientWidth: body ? body.clientWidth : null, clientHeight: body ? body.clientHeight : null, scrollWidth: body ? body.scrollWidth : null, scrollHeight: body ? body.scrollHeight : null, offsetHeight: body ? body.offsetHeight : null, styles: styles(body) };
  out.root = { rect: rect(root), clientHeight: root ? root.clientHeight : null, scrollHeight: root ? root.scrollHeight : null, styles: styles(root) };
  if (root) {
    var op = root.offsetParent;
    out.root.offsetParent = op ? desc(op) : null;
  }

  var banner = document.getElementById('zcode-tarkov-banner');
  out.banner = banner ? { present: true, rect: rect(banner), styles: styles(banner), isBodyFirstChild: body ? body.firstElementChild === banner : null, childCount: banner.childElementCount } : { present: false };

  // App shell: the largest visible descendant of #root (the box that carries the UI).
  var shell = null, shellArea = 0, shellCount = 0;
  if (root) {
    var rk = root.querySelectorAll('*');
    for (var i = 0; i < rk.length; i++) {
      var el = rk[i];
      if (!visible(el)) continue;
      var r = el.getBoundingClientRect();
      if (r.width < 200 || r.height < 100) continue;
      shellCount += 1;
      var area = r.width * r.height;
      if (area > shellArea) { shellArea = area; shell = el; }
    }
  }
  out.appShell = shell ? { selector: pathOf(shell, root), rect: rect(shell), styles: styles(shell), isRoot: shell === root } : null;
  out.appShellCount = shellCount;

  // Sidebar: descend along the leftmost full-height column of the app shell.
  // Wide wrappers are descended through; the result is the deepest column that
  // is still full-height, starts at the left edge and is narrower than half the
  // window (the sidebar panel), which is what the account area lives in.
  var sidebarChain = [], sidebar = null, cur = root;
  while (cur && cur.children) {
    var best = null, bestLeft = Infinity, bestWidth = -1;
    for (var j = 0; j < cur.children.length; j++) {
      var kid = cur.children[j];
      if (!visible(kid)) continue;
      if (kid.id === 'zcode-tarkov-banner') continue;
      var kcs = getComputedStyle(kid);
      if (kcs.position === 'fixed' || kcs.position === 'absolute') continue;
      var kr = kid.getBoundingClientRect();
      if (kr.height < H * 0.75) continue;
      if (kr.width < 40) continue;
      if (kr.left > 16) continue;
      if (kr.left < bestLeft - 1 || (Math.abs(kr.left - bestLeft) <= 1 && kr.width > bestWidth)) {
        best = kid; bestLeft = kr.left; bestWidth = kr.width;
      }
    }
    if (!best) break;
    sidebarChain.push(best);
    if (bestWidth <= W * 0.6) { sidebar = best; break; }
    cur = best;
  }
  if (!sidebar) {
    var byId = document.getElementById('sidebar');
    if (byId && root && root.contains(byId)) { sidebar = byId; sidebarChain.push(byId); }
  }
  out.sidebar = sidebar ? {
    selector: pathOf(sidebar, root),
    chain: sidebarChain.map(function (e) { return desc(e); }),
    rect: rect(sidebar),
    styles: styles(sidebar),
    insideRoot: root ? root.contains(sidebar) : null
  } : null;
  var sidebarById = document.getElementById('sidebar');
  if (sidebarById) {
    out.sidebarById = { rect: rect(sidebarById), styles: styles(sidebarById), sameAsSidebar: sidebarById === sidebar };
  }

  // Account area: the deepest element whose visible label reads "\u8fde\u63a5\u4f7f\u7528" (connect to use),
  // or the English equivalent; its ancestor chain is reported so the container is checkable.
  var ACCOUNT = ['\u8fde\u63a5\u4f7f\u7528', 'Connect to use', 'Sign in', '\u767b\u5f55'];
  var account = null, accountText = '';
  var all = document.querySelectorAll('body *');
  for (var k = 0; k < all.length; k++) {
    var cand = all[k];
    if (cand.childElementCount > 0 || !visible(cand)) continue;
    var t = (cand.textContent || '').trim();
    for (var m = 0; m < ACCOUNT.length; m++) {
      if (t === ACCOUNT[m] || (t.length < 40 && t.indexOf(ACCOUNT[m]) >= 0)) { account = cand; accountText = t; break; }
    }
    if (account) break;
  }
  if (account) {
    var anc = [], p = account.parentElement, g = 0;
    while (p && p !== body && g < 4) { anc.push({ selector: desc(p), rect: rect(p) }); p = p.parentElement; g += 1; }
    out.account = { text: accountText, selector: pathOf(account, body), rect: rect(account), styles: styles(account), ancestors: anc, insideRoot: root ? root.contains(account) : null };
  } else {
    out.account = { present: false, text: '' };
  }

  // Composer: walk up from the editing surface to the highest ancestor that
  // still carries the app's own "composer" class, else six levels up.
  var editor = document.querySelector('textarea, [contenteditable="true"], [role="textbox"]');
  out.editor = editor ? { selector: desc(editor), rect: rect(editor), styles: styles(editor) } : null;
  var composer = null, composerBy = null, chain = [];
  if (editor) {
    var walk = editor, lastComposer = null, hops = 0;
    while (walk && walk !== body && hops < 10) {
      chain.push(desc(walk));
      var cls = typeof walk.className === 'string' ? walk.className : '';
      if (/composer/i.test(cls)) lastComposer = walk;
      walk = walk.parentElement; hops += 1;
    }
    if (lastComposer) { composer = lastComposer; composerBy = 'class-match'; }
    else { composer = editor; for (var up = 0; up < 6 && composer.parentElement && composer.parentElement !== body; up++) composer = composer.parentElement; composerBy = 'six-levels'; }
  }
  out.composer = composer ? { selector: pathOf(composer, body), rect: rect(composer), styles: styles(composer), foundBy: composerBy, chain: chain, insideRoot: root ? root.contains(composer) : null } : null;

  // Clipped elements. An element counts when its painted box still reaches
  // outside the viewport. The painted box is the element rect intersected with
  // every clipping ancestor (overflow != visible); <html>/<body> are treated as
  // the window edge rather than as internal clippers, so a #root that overflows
  // the window is still reported. An element that is merely scrolled out of an
  // app scroll container (sidebar list, message list) intersects to an empty
  // box: it is not window clipping and is kept only in the raw count.
  function paintedBox(el) {
    var r0 = el.getBoundingClientRect();
    var top0 = r0.top, bottom0 = r0.bottom, left0 = r0.left, right0 = r0.right;
    if (getComputedStyle(el).position === 'fixed') return { top: top0, bottom: bottom0, left: left0, right: right0 };
    var p = el.parentElement, guard = 0;
    while (p && p !== body && p !== html && guard < 25) {
      var pc = getComputedStyle(p);
      if (pc.overflow !== 'visible' || pc.overflowX !== 'visible' || pc.overflowY !== 'visible') {
        var pr = p.getBoundingClientRect();
        if (pr.top > top0) top0 = pr.top;
        if (pr.bottom < bottom0) bottom0 = pr.bottom;
        if (pr.left > left0) left0 = pr.left;
        if (pr.right < right0) right0 = pr.right;
      }
      p = p.parentElement; guard += 1;
    }
    return { top: top0, bottom: bottom0, left: left0, right: right0 };
  }
  // Ownership: the tool's own injected UI is never excused, so every
  // painted-outside entry is labelled before anything is decided about it. An
  // entry is "ours" when it or any ancestor is the banner, the panel root, a
  // #zb-* panel node, the wallpaper or the backdrop; everything else is the
  // app's own UI.
  var OURS_IDS = { 'zcode-tarkov-banner': true, 'zcode-beautify-panel-root': true, 'zcode-beautify-wallpaper': true, 'zcode-beautify-backdrop': true };
  function ownerOf(el) {
    var cur = el, guard = 0;
    while (cur && cur.nodeType === 1 && guard < 60) {
      var oid = cur.id || '';
      if (OURS_IDS[oid] === true || oid.indexOf('zb-') === 0) return '#' + oid;
      cur = cur.parentElement; guard += 1;
    }
    return null;
  }
  var clipped = [], clippedRaw = 0, clippedOursTotal = 0, clippedAppTotal = 0;
  for (var q = 0; q < all.length; q++) {
    var cel = all[q];
    if (!visible(cel)) continue;
    if (cel.id === 'zcode-beautify-wallpaper' || cel.id === 'zcode-beautify-backdrop') continue;
    var cr = cel.getBoundingClientRect();
    if (cr.width <= 0 || cr.height <= 0) continue;
    if (!(cr.bottom > H + 1 || cr.top < -1)) continue;
    clippedRaw += 1;
    var pb = paintedBox(cel);
    if (pb.bottom <= pb.top || pb.right <= pb.left) continue;
    if (!(pb.bottom > H + 1 || pb.top < -1)) continue;
    var ownerMatch = ownerOf(cel);
    if (ownerMatch) clippedOursTotal += 1; else clippedAppTotal += 1;
    clipped.push({
      depth: depthOf(cel),
      tag: cel.tagName.toLowerCase(),
      id: cel.id || null,
      dataSlot: cel.getAttribute('data-slot'),
      ariaLabel: cel.getAttribute('aria-label'),
      text: (cel.textContent || '').trim().slice(0, 40),
      owner: ownerMatch ? 'ours' : 'app',
      ownerMatch: ownerMatch,
      rect: rect(cel),
      painted: { top: num(pb.top), bottom: num(pb.bottom) },
      overflowBelow: num(pb.bottom - H),
      overflowAbove: num(-pb.top)
    });
  }
  clipped.sort(function (a, b) {
    var d = (b.overflowBelow || 0) - (a.overflowBelow || 0);
    if (d !== 0) return d;
    return b.depth - a.depth;
  });
  out.clippedTotal = clipped.length;
  out.clippedRawTotal = clippedRaw;
  out.clippedOursTotal = clippedOursTotal;
  out.clippedAppTotal = clippedAppTotal;
  out.clipped = clipped.slice(0, 25);
  out.clippedOurs = clipped.filter(function (e) { return e.owner === 'ours'; }).slice(0, 25);
  out.clippedApp = clipped.filter(function (e) { return e.owner === 'app'; }).slice(0, 25);

  out.overflow = {
    windowInnerHeight: H,
    windowInnerWidth: W,
    scrollingElementTag: document.scrollingElement ? document.scrollingElement.tagName.toLowerCase() : null,
    scrollingElementScrollHeight: document.scrollingElement ? document.scrollingElement.scrollHeight : null,
    scrollingElementClientHeight: document.scrollingElement ? document.scrollingElement.clientHeight : null,
    htmlOverflows: html.scrollHeight > html.clientHeight + 1,
    bodyOverflows: body ? body.scrollHeight > body.clientHeight + 1 : null,
    rootOverflows: root ? root.scrollHeight > root.clientHeight + 1 : null,
    documentScrollTop: document.scrollingElement ? document.scrollingElement.scrollTop : null
  };
  return out;
})()`;

async function evaluate(send, expression) {
  const res = await send('Runtime.evaluate', { expression: expression, returnByValue: true, awaitPromise: true });
  if (res.exceptionDetails) throw new Error('Runtime.evaluate threw: ' + JSON.stringify(res.exceptionDetails).slice(0, 600));
  return res.result ? res.result.value : undefined;
}

// ------------------------------------------------------------------- resize --
// The window handle is resolved from the browser process id that Chromium
// itself reports over CDP (SystemInfo.getProcessInfo), never from a name or a
// command-line match: the process that owns the CDP endpoint is by definition
// the instance being measured, so no other ZCode window can be touched.
const PS_WINDOW = (pid, action, cx, cy) => `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class ZctWin {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int X, int Y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
[void][ZctWin]::SetProcessDpiAwarenessContext([IntPtr](-4))
$gp = Get-Process -Id ${Math.round(pid)} -ErrorAction SilentlyContinue
if (-not $gp -or $gp.MainWindowHandle -eq 0) { Write-Output '{"found":false,"reason":"no main window for browser pid ${Math.round(pid)}"}'; exit 0 }
$hwnd = $gp.MainWindowHandle
$wr = New-Object ZctWin+RECT
$cr = New-Object ZctWin+RECT
[void][ZctWin]::GetWindowRect($hwnd, [ref]$wr)
[void][ZctWin]::GetClientRect($hwnd, [ref]$cr)
$out = [ordered]@{
  found = $true
  pid = ${Math.round(pid)}
  hwnd = [int64]$hwnd
  title = $gp.MainWindowTitle
  iconic = [ZctWin]::IsIconic($hwnd)
  window = @($wr.Left, $wr.Top, ($wr.Right - $wr.Left), ($wr.Bottom - $wr.Top))
  client = @($cr.Left, $cr.Top, ($cr.Right - $cr.Left), ($cr.Bottom - $cr.Top))
}
${action === 'raise' ? `
# HWND_TOPMOST, no move/size, show, no activate: makes the renderer un-occluded
# so Chromium applies the resize and produces frames, without stealing focus.
# A plain HWND_TOP raise is not enough when another process owns the foreground
# window (measured: SetWindowPos returned true but visibilityState stayed
# "hidden"); topmost is guaranteed to be above every non-topmost window and is
# restored right after the measurement.
$flags = 0x0002 -bor 0x0001 -bor 0x0040 -bor 0x0010
$out.raised = [ZctWin]::SetWindowPos($hwnd, [IntPtr](-1), 0, 0, 0, 0, $flags)
` : ''}
${action === 'restore' ? `
$flags = 0x0002 -bor 0x0001 -bor 0x0010
$out.notTopmost = [ZctWin]::SetWindowPos($hwnd, [IntPtr](-2), 0, 0, 0, 0, $flags)
$out.lowered = [ZctWin]::SetWindowPos($hwnd, [IntPtr]1, 0, 0, 0, 0, $flags)
` : ''}
${action === 'set' ? `
if ($out.iconic) { [void][ZctWin]::ShowWindow($hwnd, 9) }
$flags = 0x0002 -bor 0x0004 -bor 0x0010 -bor 0x0040
[void][ZctWin]::SetWindowPos($hwnd, [IntPtr]::Zero, 0, 0, ${Math.round(cx)}, ${Math.round(cy)}, $flags)
Start-Sleep -Milliseconds 200
[void][ZctWin]::GetWindowRect($hwnd, [ref]$wr)
[void][ZctWin]::GetClientRect($hwnd, [ref]$cr)
$out.after = [ordered]@{ window = @($wr.Left, $wr.Top, ($wr.Right - $wr.Left), ($wr.Bottom - $wr.Top)); client = @($cr.Left, $cr.Top, ($cr.Right - $cr.Left), ($cr.Bottom - $cr.Top)) }
` : ''}
$out | ConvertTo-Json -Compress -Depth 4
`;

async function psWindow(pid, action, cx, cy) {
  const script = PS_WINDOW(pid, action, cx, cy);
  const r = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], null, 25000);
  if (r.timedOut) return { found: false, error: 'powershell timed out after 25s' };
  const text = (r.stdout.replace(/^\uFEFF/, '').trim().split(/\r?\n/).filter(Boolean).pop() || '').replace(/^\uFEFF/, '');
  if (!text) return { found: false, error: (r.stderr || 'empty output').trim().slice(0, 300) };
  try { return JSON.parse(text); } catch (e) { return { found: false, error: 'unparseable: ' + text.slice(0, 200) }; }
}

async function browserPid(base) {
  try {
    const version = await httpJson(base + '/json/version');
    const ws = await connect(version.webSocketDebuggerUrl);
    const send = makeSender(ws);
    const info = await send('SystemInfo.getProcessInfo');
    try { ws.close(); } catch (e) {}
    const browser = (info.processInfo || []).find((p) => p.type === 'browser');
    return browser ? browser.id : 0;
  } catch (e) {
    return 0;
  }
}

function rectsClose(a, b, tol) {
  if (!a || !b) return false;
  return Math.abs(a.w - b.w) <= tol && Math.abs(a.h - b.h) <= tol && Math.abs(a.top - b.top) <= tol && Math.abs(a.left - b.left) <= tol;
}

async function resizeReal(send, base, pid, width, height) {
  const sizeExpr = '({w: innerWidth, h: innerHeight, rw: document.documentElement.getBoundingClientRect().width, rh: document.documentElement.getBoundingClientRect().height, dpr: devicePixelRatio, ow: outerWidth, oh: outerHeight})';
  if (!pid) return { method: 'none', real: false, note: 'no browser pid reported by CDP' };
  const info = await psWindow(pid, 'query');
  if (!info.found) return { method: 'none', real: false, note: 'no main window for browser pid ' + pid + (info.error ? ' (' + info.error + ')' : '') };
  // An occluded renderer never applies a window resize (measured: innerWidth
  // stayed stale while document.visibilityState was "hidden"), so raise the
  // window to the top of the z-order without activating it first. The scratch
  // window is the only window this tool ever touches.
  const raised = await psWindow(pid, 'raise');
  const visDeadline = Date.now() + 10000;
  let visible = false;
  while (Date.now() < visDeadline) {
    const state = await evaluate(send, '({vis: document.visibilityState})');
    if (state && state.vis === 'visible') { visible = true; break; }
    await sleep(300);
  }
  const before = await evaluate(send, sizeExpr);
  const dpr = before.dpr || 1;
  const frameW = info.window[2] - info.client[2];
  const frameH = info.window[3] - info.client[3];
  let targetW = Math.round(width * dpr + frameW);
  let targetH = Math.round(height * dpr + frameH);
  let result = { method: 'SetWindowPos', real: true, pid: pid, window: info, raisedWindow: !!raised.raised, rendererVisibleAfterRaise: visible, before: before, attempts: [] };
  if (!visible) {
    result.note = 'the page stayed hidden after raising the scratch window; Chromium will not apply the resize';
    result.after = before;
    result.matched = false;
    result.clientChanged = false;
    return result;
  }
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const applied = await psWindow(pid, 'set', targetW, targetH);
    await sleep(300);
    const now = await evaluate(send, sizeExpr);
    const osClient = applied.found && applied.after ? applied.after.client : null;
    // Honest reporting of the real OS client rect: the renderer viewport can
    // stay stale for a frame, and a constraining window manager can clamp the
    // request without an error.
    const osClientChanged = osClient ? (osClient[2] !== info.client[2] || osClient[3] !== info.client[3]) : null;
    result.attempts.push({ targetW: targetW, targetH: targetH, measured: now, applied: !!applied.found, osClient: osClient, osClientChanged: osClientChanged });
    result.after = now;
    result.osClient = osClient;
    result.osClientChanged = osClientChanged;
    // The client size moves in whole physical pixels, so the reachable CSS
    // sizes are multiples of 1/dpr: accept the closest one, not just any size
    // within a whole CSS pixel.
    if (Math.abs(now.rw - width) <= 0.3 && Math.abs(now.rh - height) <= 0.3) break;
    targetW += Math.round((width - now.rw) * dpr);
    targetH += Math.round((height - now.rh) * dpr);
  }
  if (!result.after) result.after = before;
  result.clientChanged = result.after.w !== before.w || result.after.h !== before.h;
  result.matched = Math.abs(result.after.rw - width) <= 0.3 && Math.abs(result.after.rh - height) <= 0.3;
  result.residualCss = { w: Math.round((result.after.rw - width) * 100) / 100, h: Math.round((result.after.rh - height) * 100) / 100 };
  if (!result.clientChanged) result.note = 'SetWindowPos did not change the client rect (window may be constrained)';
  return result;
}

async function resizeEmulated(send, width, height) {
  await send('Emulation.setDeviceMetricsOverride', { width: width, height: height, deviceScaleFactor: 0, mobile: false });
  await sleep(250);
  const after = await evaluate(send, '({w: innerWidth, h: innerHeight, dpr: devicePixelRatio})');
  return { method: 'Emulation.setDeviceMetricsOverride', real: false, emulated: true, after: after, matched: Math.abs(after.w - width) <= 1 && Math.abs(after.h - height) <= 1 };
}

// Real resize first, then Chromium's own window bounds, then an explicitly
// labelled emulated layout viewport. Shared by the single-instance path and the
// sweep so both report the same three-attempt chain.
async function applyViewport(send, base, targetId, pid, width, height) {
  const attempts = [];
  const real = await resizeReal(send, base, pid, width, height);
  attempts.push(real);
  let chosen = real;
  if (!real.matched) {
    // Chromium's own window bounds (still a real OS window resize). Not
    // available in every Electron build, which is why it is a fallback.
    try {
      const browserWs = await httpJson(base + '/json/version');
      const bws = await connect(browserWs.webSocketDebuggerUrl);
      const bsend = makeSender(bws);
      const win = await bsend('Browser.getWindowForTarget', { targetId: targetId });
      await bsend('Browser.setWindowBounds', { windowId: win.windowId, bounds: { windowState: 'normal', width: Math.round(width), height: Math.round(height) } });
      await sleep(400);
      const after = await evaluate(send, '({w: innerWidth, h: innerHeight, dpr: devicePixelRatio})');
      const attempt = { method: 'Browser.setWindowBounds', real: true, emulated: false, after: after, matched: Math.abs(after.w - width) <= 1 && Math.abs(after.h - height) <= 1 };
      attempts.push(attempt);
      try { bws.close(); } catch (e) {}
      if (attempt.matched) chosen = attempt;
    } catch (err) {
      attempts.push({ method: 'Browser.setWindowBounds', real: true, emulated: false, error: String(err.message || err) });
    }
  }
  if (!chosen.matched) {
    // Emulated layout viewport. Explicitly labelled: the OS window is NOT
    // resized, only the page's layout metrics are overridden.
    try {
      const emu = await resizeEmulated(send, Math.round(width), Math.round(height));
      emu.note = 'emulated layout viewport; the OS window keeps its real size';
      attempts.push(emu);
      if (emu.matched) chosen = emu;
    } catch (err) {
      attempts.push({ method: 'Emulation.setDeviceMetricsOverride', real: false, emulated: true, error: String(err.message || err) });
    }
  }
  return { chosen: chosen, attempts: attempts };
}

// Applies a mode through the CLI exactly like the single-instance path does.
async function applyModeCli(args, mode, envExtra) {
  const cliArgs = [args.cli, 'theme', mode, '--port', String(args.port)];
  const env = Object.assign({}, process.env, envExtra || {});
  if (args.dataDir) env.ZCODE_BEAUTIFY_DATA_DIR = args.dataDir;
  const r = await run(process.execPath, cliArgs, env);
  return {
    step: { step: 'apply-mode', cli: args.cli, mode: mode, exitCode: r.code, stdout: r.stdout.trim(), stderr: r.stderr.trim() },
    result: r
  };
}

// The injected banner is (re)built behind a MutationObserver/rAF debounce, so
// wait for the mode to be visible in the DOM before measuring. Bounded: a
// timeout is recorded, never silently treated as success.
async function waitForModeSettle(send, mode, settleMs) {
  const wantBanner = mode === 'tarkov';
  const settleDeadline = Date.now() + 8000;
  let state = null;
  while (Date.now() < settleDeadline) {
    state = await evaluate(send, '({attr: document.documentElement.getAttribute("data-zct-banner"), banner: !!document.getElementById("zcode-tarkov-banner")})');
    if (state && state.attr === (wantBanner ? '1' : null) && state.banner === wantBanner) break;
    await sleep(250);
  }
  const timedOut = !state || state.attr !== (wantBanner ? '1' : null) || state.banner !== wantBanner;
  await sleep(Math.max(100, Math.round(settleMs / 2)));
  return { step: { step: 'mode-settled', wanted: mode, observed: state }, timedOut: timedOut };
}

// Extra sweep-only probes: banner element count (the existing check set only
// proves one was found by id, not that duplicates are absent) and the injected
// panel's own geometry (the panel is added by the service, so the sweep must
// report whether it was present at all instead of implying coverage).
const EXTRAS = `(function(){
  var root = document.getElementById('zcode-beautify-panel-root');
  function rect(el){ if (!el) return null; var r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, top: r.top, bottom: r.bottom, left: r.left, right: r.right }; }
  var status = root ? document.getElementById('zb-status') : null;
  var fab = root ? document.getElementById('zb-fab') : null;
  return {
    bannerCount: document.querySelectorAll('#zcode-tarkov-banner').length,
    panel: root ? {
      present: true,
      fab: fab ? rect(fab) : null,
      status: status ? { rect: rect(status), empty: (status.textContent || '').trim() === '' } : null
    } : { present: false }
  };
})()`;

async function probeExtras(send) {
  const res = await evaluate(send, EXTRAS);
  return res && typeof res === 'object' ? res : {};
}

// The sweep's assertion set: the existing checks plus the exactly-once banner
// assertion (the task contract's (b) item) and the panel-presence report.
function sweepChecks(obs, options) {
  const checks = buildChecks(obs, options);
  const wantBanner = options.mode === 'tarkov';
  const count = typeof obs.bannerCount === 'number' ? obs.bannerCount : null;
  checks.push({
    id: 'banner.present-exactly-once',
    expected: wantBanner ? 'exactly 1 banner element in the document' : '0 banner elements in the document',
    observed: count,
    pass: wantBanner ? count === 1 : count === 0
  });
  return checks;
}

// -------------------------------------------------------------------- checks --
function buildChecks(obs, options) {
  const checks = [];
  const add = (id, expected, observed, pass) => checks.push({ id: id, expected: expected, observed: observed, pass: pass === true });
  const H = obs.viewport.innerHeight;
  const mode = options.mode || '(unchanged)';
  const banner = obs.banner;
  const bannerBottom = banner.present ? banner.rect.bottom : 0;

  if (mode === 'tarkov' || (mode === '(unchanged)' && banner.present)) {
    add('banner.present', 'exactly one banner in Tarkov mode', banner.present, banner.present === true);
    add('banner.inside-viewport', 'top >= 0 and bottom <= innerHeight + 0.5', banner.present ? [banner.rect.top, banner.rect.bottom, H] : 'absent',
      banner.present && banner.rect.top >= 0 && banner.rect.bottom <= H + 0.5);
    add('banner.attribute-set', 'html[data-zct-banner="1"]', obs.bannerAttribute, obs.bannerAttribute === '1');
    add('banner.height-variable', '--zcode-tarkov-banner-height resolves to the band height',
      [obs.bannerHeightVar, banner.present ? banner.rect.h : null],
      banner.present && /px$/.test(obs.bannerHeightVar) && Math.abs(parseFloat(obs.bannerHeightVar) - banner.rect.h) <= 0.5);
  } else {
    add('banner.absent', 'no banner outside Tarkov mode', banner.present, banner.present === false);
    add('banner.attribute-cleared', 'data-zct-banner removed', obs.bannerAttribute, obs.bannerAttribute === null);
  }

  add('app-shell.below-banner', 'app shell top >= banner bottom (no coverage)',
    obs.appShell ? [obs.appShell.rect.top, bannerBottom] : 'no shell found',
    !banner.present ? true : (obs.appShell ? obs.appShell.rect.top >= bannerBottom - 0.5 : false));
  add('root.bottom-at-viewport', '|#root.bottom - innerHeight| <= 0.5',
    obs.root.rect ? [obs.root.rect.bottom, H] : null, !!obs.root.rect && Math.abs(obs.root.rect.bottom - H) <= 0.5);
  add('composer.fully-visible', 'composer top >= 0 and bottom <= innerHeight + 0.5',
    obs.composer ? [obs.composer.rect.top, obs.composer.rect.bottom, H] : 'not found',
    !!obs.composer && obs.composer.rect.top >= 0 && obs.composer.rect.bottom <= H + 0.5);
  add('sidebar.fully-visible', 'sidebar top >= 0 and bottom <= innerHeight + 0.5',
    obs.sidebar ? [obs.sidebar.rect.top, obs.sidebar.rect.bottom, H] : 'not found',
    !!obs.sidebar && obs.sidebar.rect.top >= 0 && obs.sidebar.rect.bottom <= H + 0.5);
  add('account.fully-visible', 'account label top >= 0 and bottom <= innerHeight + 0.5',
    obs.account && obs.account.present !== false ? [obs.account.rect.top, obs.account.rect.bottom, H] : 'not found',
    !!(obs.account && obs.account.present !== false) && obs.account.rect.top >= 0 && obs.account.rect.bottom <= H + 0.5);
  add('no-clipped-elements', 'no painted element reaches outside the viewport',
    { paintedOutside: obs.clippedTotal, rawRectHits: obs.clippedRawTotal, sample: (obs.clipped || []).slice(0, 5) },
    obs.clippedTotal === 0);
  add('no-vertical-overflow', 'html.scrollHeight <= html.clientHeight + 1',
    [obs.html.scrollHeight, obs.html.clientHeight], obs.html.scrollHeight <= obs.html.clientHeight + 1);
  return checks;
}

// ------------------------------------------------------ clipped resolution --
// The no-clipped-elements decision. Ours (banner / panel / #zb-* / wallpaper)
// is a failure immediately and in every case. An app-side entry may be a host
// notification that is on its way in or out (ZCode's "update downloaded" toast
// parks itself with a few pixels above the edge, and dismisses on a timer), so
// that case alone is re-measured after a settle: a transient is excused and
// recorded, an entry still painted outside after the settle is a persistent
// failure. The confirm measurement is taken with the same MEASURE expression,
// so both observations are directly comparable.
//
// The settle has to outlast the host's own dismissal timer, not just its
// animation: measured 2026-09-17, the same toast cleared within 1.5 s in one
// run and was still parked after 1.5 s in another, because the second run
// measured it right after the update check fired. 10 s is comfortably past both
// the animation and the dismissal, while a real layout clip (the pre-fix
// sidebar/composer/account clipping that this check exists for) is static and
// persists indefinitely, so it is still reported as persistent.
const CLIP_CONFIRM_SETTLE_MS = 10000;

function clippedCounts(obs) {
  const entries = Array.isArray(obs.clipped) ? obs.clipped : [];
  const ours = Array.isArray(obs.clippedOurs) ? obs.clippedOurs : entries.filter((e) => e.owner === 'ours');
  const app = Array.isArray(obs.clippedApp) ? obs.clippedApp : entries.filter((e) => e.owner !== 'ours');
  const total = typeof obs.clippedTotal === 'number' ? obs.clippedTotal : ours.length + app.length;
  const oursTotal = typeof obs.clippedOursTotal === 'number' ? obs.clippedOursTotal : ours.length;
  const appTotal = typeof obs.clippedAppTotal === 'number' ? obs.clippedAppTotal : Math.max(0, total - oursTotal);
  return { total: total, oursTotal: oursTotal, appTotal: appTotal, ours: ours, app: app, rawTotal: obs.clippedRawTotal };
}

function clippedReport(counts) {
  return {
    paintedOutside: counts.total,
    rawRectHits: counts.rawTotal,
    ours: counts.oursTotal,
    app: counts.appTotal,
    entries: counts.ours.concat(counts.app)
  };
}

function makeClippedCheck(firstObs, pass, detail) {
  const first = clippedCounts(firstObs);
  const check = {
    id: 'no-clipped-elements',
    expected: 'no painted element reaches outside the viewport',
    observed: {
      paintedOutside: first.total,
      rawRectHits: first.rawTotal,
      ours: first.oursTotal,
      app: first.appTotal,
      sample: (firstObs.clipped || []).slice(0, 5)
    },
    pass: pass === true
  };
  if (detail) check.detail = detail;
  return check;
}

async function resolveClippedCheck(send, firstObs, options) {
  const settleMs = options && Number.isFinite(options.settleMs) ? options.settleMs : CLIP_CONFIRM_SETTLE_MS;
  const first = clippedCounts(firstObs);
  if (first.oursTotal > 0) {
    // Anything of ours is a failure in every case: no settle, no second chance.
    return {
      check: makeClippedCheck(firstObs, false, {
        oursPaintedOutside: { total: first.oursTotal, entries: first.ours }
      }),
      confirmObs: null
    };
  }
  if (first.total === 0) return { check: makeClippedCheck(firstObs, true, null), confirmObs: null };
  await sleep(settleMs);
  const confirmObs = await evaluate(send, MEASURE);
  const confirm = clippedCounts(confirmObs);
  if (confirm.total > 0) {
    // Still painted outside after the settle: a persistent clip, not a
    // transient. This is the regression the check exists for.
    return {
      check: makeClippedCheck(firstObs, false, {
        persistentPaintedOutside: {
          settleMs: settleMs,
          reason: confirm.oursTotal > 0 ? 'ours-still-painted-outside' : 'app-still-painted-outside',
          first: clippedReport(first),
          confirm: clippedReport(confirm)
        }
      }),
      confirmObs: confirmObs
    };
  }
  return {
    check: makeClippedCheck(firstObs, true, {
      transientPaintedOutside: {
        classification: 'transient-app-side',
        settleMs: settleMs,
        cleared: true,
        first: clippedReport(first),
        confirm: clippedReport(confirm)
      }
    }),
    confirmObs: confirmObs
  };
}

function compareTo(baseline, obs) {
  const rows = [];
  const tol = 0.5;
  const keys = ['html', 'body', 'root'];
  for (const k of keys) {
    if (!baseline[k] || !baseline[k].rect || !obs[k] || !obs[k].rect) continue;
    rows.push({ id: 'compare.' + k + '-rect', expected: baseline[k].rect, observed: obs[k].rect, pass: rectsClose(baseline[k].rect, obs[k].rect, tol) });
  }
  for (const k of ['sidebar', 'composer', 'account', 'appShell', 'banner']) {
    const b = baseline[k], o = obs[k];
    if (!b || !o) continue;
    if (b.rect && o.rect) rows.push({ id: 'compare.' + k + '-rect', expected: b.rect, observed: o.rect, pass: rectsClose(b.rect, o.rect, tol) });
  }
  if (baseline.html && obs.html) {
    rows.push({ id: 'compare.html-scrollHeight', expected: baseline.html.scrollHeight, observed: obs.html.scrollHeight, pass: baseline.html.scrollHeight === obs.html.scrollHeight });
  }
  if (baseline.viewport && obs.viewport) {
    rows.push({ id: 'compare.viewport', expected: [baseline.viewport.innerWidth, baseline.viewport.innerHeight], observed: [obs.viewport.innerWidth, obs.viewport.innerHeight], pass: baseline.viewport.innerWidth === obs.viewport.innerWidth && baseline.viewport.innerHeight === obs.viewport.innerHeight });
  }
  return rows;
}

// --------------------------------------------------------------- sweep mode --
const SWEEP_DEFAULT_PORT = 9471;
const SWEEP_VIEWPORTS = [[1366, 768], [1440, 900], [960, 720]];
const SWEEP_MODES = ['tarkov', 'native', 'monet'];
const ZCODE_EXE = 'C:\\Program Files\\ZCode\\ZCode.exe';
const SWEEP_TARGET_BUDGET_MS = 60000;
// The OS-window resize is not a measured case (it precedes the three mode
// cases), so it gets its own fixed budget instead of the --case-timeout-ms one.
const SWEEP_RESIZE_TIMEOUT_MS = 180000;
const SWEEP_HANDSHAKE_TIMEOUT_MS = 60000;

// A plain TCP connect is the only honest "is someone listening" test: an HTTP
// fetch to a non-CDP listener can fail in ways that look like a free port.
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

function isUnder(candidate, root) {
  const p = path.resolve(candidate).toLowerCase();
  const r = path.resolve(root).toLowerCase().replace(/[\\/]+$/, '');
  return p === r || p.startsWith(r + path.sep);
}

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

function psQuote(text) {
  return "'" + String(text).replace(/'/g, "''") + "'";
}

// Lists ZCode.exe processes whose command line carries the scratch profile
// path: that path is unique to this run, so the match is proof of identity.
async function psListByProfile(profile) {
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    '$needle = ' + psQuote(profile),
    "$procs = @(Get-CimInstance Win32_Process -Filter \"Name = 'ZCode.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($needle) })",
    "if ($procs.Count -eq 0) { Write-Output '[]' } else { $procs | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; cmd = [string]$_.CommandLine } } | ConvertTo-Json -Compress -Depth 3 }"
  ].join('; ');
  const r = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], null, 30000);
  const text = (r.stdout || '').replace(/^\uFEFF/, '').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (e) {
    return [];
  }
}

// Kills only processes that still carry the scratch profile path at kill time
// (re-checked against the live process object, so a recycled PID cannot hit an
// unrelated process). Returns the pids it stopped.
async function psKillByProfile(profile) {
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    '$needle = ' + psQuote(profile),
    '$killed = New-Object System.Collections.ArrayList',
    "$procs = @(Get-CimInstance Win32_Process -Filter \"Name = 'ZCode.exe'\")",
    'foreach ($p in $procs) { if ($p.CommandLine -and $p.CommandLine.Contains($needle)) { [void]$killed.Add([int]$p.ProcessId); Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue } }',
    "$killed -join ','"
  ].join('; ');
  const r = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], null, 30000);
  const text = (r.stdout || '').replace(/^\uFEFF/, '').trim();
  return text ? text.split(',').map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0) : [];
}

async function waitForPageTarget(base, budgetMs, child) {
  const deadline = Date.now() + budgetMs;
  let targets = [];
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) return { target: null, exited: true, code: child.exitCode, targets: targets };
    try { targets = await httpJson(base + '/json/list', 3000); } catch (err) { targets = []; }
    const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl && String(t.url || '').indexOf('devtools://') !== 0);
    if (pages.length > 0) return { target: pages.find((t) => /zcode/i.test(t.title || '')) || pages[0], exited: false, targets: targets };
    await sleep(500);
  }
  return { target: null, exited: false, timeout: true, targets: targets };
}

function describeResize(attempt) {
  if (!attempt) return '(none)';
  const bits = [attempt.method || '?', 'real=' + String(!!attempt.real)];
  if (attempt.emulated) bits.push('emulated=true');
  if (attempt.matched !== undefined) bits.push('matched=' + String(!!attempt.matched));
  if (attempt.clientChanged !== undefined) bits.push('clientChanged=' + String(attempt.clientChanged));
  if (attempt.osClientChanged !== undefined) bits.push('osClientChanged=' + String(attempt.osClientChanged));
  if (attempt.note) bits.push('note=' + attempt.note);
  if (attempt.error) bits.push('error=' + String(attempt.error).slice(0, 120));
  return bits.join(' ');
}

function sweepStamp() {
  const iso = new Date().toISOString();
  return iso.slice(0, 10).replace(/-/g, '') + '-' + iso.slice(11, 19).replace(/:/g, '');
}

function writeSweepCase(caseResult, outDir) {
  const name = 'sweep-' + caseResult.mode + '-' + caseResult.requestedViewport.w + 'x' + caseResult.requestedViewport.h + '.json';
  const file = path.join(outDir, name);
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(caseResult, null, 2));
    return { file: file, bytes: fs.statSync(file).size };
  } catch (err) {
    return { file: file, error: String((err && err.message) ? err.message : err) };
  }
}

function pad(s, n) { return (String(s) + ' '.repeat(n)).slice(0, n); }

// The no-clipped-elements decision for one case, as a one-line summary for the
// console; null when the case was clean (nothing painted outside).
function describeClipDetail(check) {
  const d = check && check.detail;
  if (!d) return null;
  if (d.oursPaintedOutside) return 'ours: ' + d.oursPaintedOutside.total + ' painted-outside entry(ies) belonging to this project (never excused)';
  if (d.persistentPaintedOutside) return 'persistent: ' + d.persistentPaintedOutside.confirm.paintedOutside + ' app-side entry(ies) still outside after the ' + d.persistentPaintedOutside.settleMs + ' ms settle';
  if (d.transientPaintedOutside) return 'transient: ' + d.transientPaintedOutside.first.paintedOutside + ' app-side entry(ies) cleared after the ' + d.transientPaintedOutside.settleMs + ' ms settle (excused, both measurements recorded)';
  return null;
}

function clipColumn(caseResult) {
  const check = (caseResult.checks || []).find((c) => c.id === 'no-clipped-elements');
  const d = check && check.detail;
  if (!d) return '-';
  if (d.oursPaintedOutside) return 'ours:' + d.oursPaintedOutside.total;
  if (d.persistentPaintedOutside) return 'persistent:' + d.persistentPaintedOutside.confirm.paintedOutside;
  if (d.transientPaintedOutside) return 'transient:' + d.transientPaintedOutside.first.paintedOutside + '(cleared)';
  return '-';
}

// Distinguishes the two outcomes the sweep summary must keep apart: transient
// app-side entries that cleared after the settle (not failures) versus
// persistent app-side entries and anything of ours (failures).
function summarizeClipResults(cases) {
  let transientCases = 0, transientEntries = 0, persistentCases = 0, oursCases = 0;
  for (const c of cases) {
    const check = (c.checks || []).find((x) => x.id === 'no-clipped-elements');
    const d = check && check.detail;
    if (d && d.transientPaintedOutside) { transientCases += 1; transientEntries += d.transientPaintedOutside.first.paintedOutside || 0; }
    if (d && d.persistentPaintedOutside) persistentCases += 1;
    if (d && d.oursPaintedOutside) oursCases += 1;
  }
  return { transientCases: transientCases, transientEntries: transientEntries, persistentCases: persistentCases, oursCases: oursCases };
}

async function runSweep(args) {
  const port = args.port ? Number(args.port) : SWEEP_DEFAULT_PORT;
  const outDir = path.resolve(args.outDir || path.join(REPO, 'docs', 'images', 'layout'));
  const shotDir = path.resolve(args.shotDir || outDir);

  // Fail closed on the artifact destinations: the two paths named on the
  // command line are the only allowed non-TEMP writes, and never into the real
  // profile.
  for (const entry of [['--out-dir', outDir], ['--shot-dir', shotDir]]) {
    for (const blocked of blockedRealPaths()) {
      if (isUnder(entry[1], blocked)) {
        console.error('REFUSED: ' + entry[0] + ' ' + entry[1] + ' is inside the real profile location ' + blocked);
        return 2;
      }
    }
  }

  // 1. The port must be provably free: another instance (the user's or another
  // worker's scratch run) must never be disturbed.
  const portState = await tcpProbe(port);
  if (portState === 'listening') {
    console.error('REFUSED: CDP port ' + port + ' is already listening; refusing to disturb the instance that owns it');
    return 2;
  }
  if (portState !== 'free') {
    console.error('REFUSED: could not prove that CDP port ' + port + ' is free (TCP probe: ' + portState + ')');
    return 2;
  }

  if (!fs.existsSync(ZCODE_EXE)) {
    console.error('REFUSED: ZCode.exe not found at ' + ZCODE_EXE);
    return 2;
  }

  // 2. Scratch tree, every path under TEMP.
  const tempRoot = path.resolve(process.env.TEMP || process.env.TMP || os.tmpdir());
  const scratchRoot = path.join(tempRoot, 'zct-sweep-' + sweepStamp() + '-' + port);
  const scratch = {
    root: scratchRoot,
    profile: path.join(scratchRoot, 'zcode-profile'),
    session: path.join(scratchRoot, 'zcode-session'),
    data: path.join(scratchRoot, 'plugin-data'),
    appdata: path.join(scratchRoot, 'appdata'),
    home: path.join(scratchRoot, 'home')
  };
  for (const key of Object.keys(scratch)) {
    if (!isUnder(scratch[key], tempRoot)) {
      console.error('REFUSED: scratch ' + key + ' ' + scratch[key] + ' is not under TEMP (' + tempRoot + ')');
      return 2;
    }
    for (const blocked of blockedRealPaths()) {
      if (isUnder(scratch[key], blocked)) {
        console.error('REFUSED: scratch ' + key + ' ' + scratch[key] + ' is inside the real profile location ' + blocked);
        return 2;
      }
    }
  }
  for (const key of Object.keys(scratch)) fs.mkdirSync(scratch[key], { recursive: true });

  const report = { tool: 'measure-layout.mjs', version: 1, sweep: true, timestamp: new Date().toISOString(), port: port, scratchRoot: scratchRoot, cases: [], summary: {} };
  const cleanupProblems = [];
  const plannedCases = SWEEP_VIEWPORTS.length * SWEEP_MODES.length;
  let preferred = null;
  let ws = null;
  let child = null;
  let socketState = null;
  let aborted = null;

  console.log('[sweep] port ' + port + ' is free; scratch root: ' + scratchRoot);
  console.log('[sweep] out-dir: ' + outDir);
  console.log('[sweep] shot-dir: ' + shotDir);

  try {
    // 3. Launch the scratch instance. --user-data-dir is required: the Chromium
    // singleton lock is taken before ZCODE_DESKTOP_USER_DATA_DIR is applied, so
    // without it the scratch process can notify or take over the user's real
    // instance.
    const launchEnv = Object.assign({}, process.env, {
      APPDATA: scratch.appdata,
      USERPROFILE: scratch.home,
      ZCODE_DESKTOP_USER_DATA_DIR: scratch.profile,
      ZCODE_DESKTOP_SESSION_DATA_DIR: scratch.session,
      ZCODE_BEAUTIFY_DATA_DIR: scratch.data
    });
    const stdoutLog = path.join(scratchRoot, 'zcode-stdout.log');
    const stderrLog = path.join(scratchRoot, 'zcode-stderr.log');
    const outFd = fs.openSync(stdoutLog, 'a');
    const errFd = fs.openSync(stderrLog, 'a');
    const launchArgs = ['--remote-debugging-port=' + port, '--user-data-dir=' + scratch.profile];
    child = spawn(ZCODE_EXE, launchArgs, { detached: true, stdio: ['ignore', outFd, errFd], windowsHide: true, env: launchEnv, cwd: os.tmpdir() });
    child.once('error', (err) => { console.error('[sweep] spawn error: ' + String((err && err.message) ? err.message : err)); });
    child.unref();
    // The child holds its own duplicates of these handles; the parent can close.
    fs.closeSync(outFd);
    fs.closeSync(errFd);
    console.log('[sweep] launched ' + ZCODE_EXE + ' pid ' + child.pid + ' ' + launchArgs.join(' '));

    const base = 'http://127.0.0.1:' + port;
    const waited = await waitForPageTarget(base, SWEEP_TARGET_BUDGET_MS, child);
    if (!waited.target) {
      const why = waited.exited ? ('the launched process exited with code ' + waited.code) : 'no renderer page target within ' + SWEEP_TARGET_BUDGET_MS + 'ms';
      console.error('REFUSED: ' + why + ' (' + (waited.targets || []).length + ' CDP target(s) seen)');
      try {
        const errTail = fs.readFileSync(stderrLog, 'utf8').trim().split(/\r?\n/).slice(-5).join(' | ');
        if (errTail) console.error('[sweep] stderr tail: ' + errTail);
      } catch (e) { /* no log */ }
      return 2;
    }
    preferred = waited.target;
    report.pageTarget = { id: preferred.id, title: preferred.title, url: preferred.url };
    console.log('[sweep] renderer page target up: ' + preferred.title);

    ws = await connect(preferred.webSocketDebuggerUrl);
    socketState = watchSocket(ws);
    const send = makeSender(ws);
    // The handshake itself is bounded: a renderer that accepts the websocket
    // but never answers must abort the sweep, not hang it.
    try {
      await withTimeout((async () => {
        await send('Runtime.enable');
        await send('Page.enable');
        try { await send('Page.bringToFront'); } catch (e) { /* informational */ }
      })(), SWEEP_HANDSHAKE_TIMEOUT_MS, 'initial renderer handshake');
    } catch (err) {
      aborted = classifySweepAbort(err, socketState, 'initial renderer handshake');
      if (!aborted) throw err;
    }
    await sleep(args.settleMs);

    const pid = await browserPid(base);
    report.browserPid = pid;
    console.log('[sweep] browser pid (CDP SystemInfo): ' + pid);
    if (!pid) console.error('[sweep] WARNING: no browser pid reported; the real window cannot be resized');

    for (const viewport of SWEEP_VIEWPORTS) {
      if (aborted) break;
      const vw = viewport[0], vh = viewport[1];
      const viewportLabel = vw + 'x' + vh;
      const socketAbortBeforeResize = classifySweepAbort(null, socketState, viewportLabel + ' (before resize)');
      if (socketAbortBeforeResize) { aborted = socketAbortBeforeResize; break; }
      // A previous case may have left an emulated layout viewport behind.
      try { await send('Emulation.clearDeviceMetricsOverride'); } catch (e) { /* not available */ }
      await sleep(200);
      let applied;
      try {
        applied = await withTimeout(applyViewport(send, base, preferred.id, pid, vw, vh), SWEEP_RESIZE_TIMEOUT_MS, viewportLabel + ' resize');
      } catch (err) {
        const resizeAbort = classifySweepAbort(err, socketState, viewportLabel + ' (resize)');
        if (resizeAbort) { aborted = resizeAbort; break; }
        applied = { chosen: { method: 'none', real: false, emulated: false, matched: false, error: String((err && err.message) ? err.message : err) }, attempts: [] };
      }
      console.log('');
      console.log('=== viewport ' + vw + 'x' + vh + ' ===');
      console.log('resize            : ' + describeResize(applied.chosen));
      for (const attempt of applied.attempts) {
        if (!attempt.matched || attempt !== applied.chosen) console.log('resize attempt    : ' + describeResize(attempt));
      }

      for (const mode of SWEEP_MODES) {
        if (aborted) break;
        const requestedViewport = { w: vw, h: vh };
        const caseLabel = vw + 'x' + vh + ' ' + mode;
        const deadSocket = classifySweepAbort(null, socketState, caseLabel);
        if (deadSocket) { aborted = deadSocket; break; }
        // Everything one case does over CDP (theme command, settle, measurement,
        // clipped confirmation, screenshot, artifact write) runs inside the
        // per-case watchdog. A watchdog timeout or a lost socket aborts the
        // sweep and is recorded as a failing case, never skipped or excused.
        const runOneCase = async () => {
          let caseResult;
          try {
            const cli = await applyModeCli({ cli: args.cli, port: port, dataDir: scratch.data }, mode, { APPDATA: scratch.appdata, USERPROFILE: scratch.home });
            const settle = await waitForModeSettle(send, mode, args.settleMs);
            await sleep(Math.max(150, Math.round(args.settleMs / 2)));
            const obs = await evaluate(send, MEASURE);
            const extras = await probeExtras(send);
            Object.assign(obs, extras);
            const measuredViewport = await evaluate(send, '({w: innerWidth, h: innerHeight})');
            obs.measuredViewport = measuredViewport;
            const checks = sweepChecks(obs, { mode: mode });
            // The clipped decision may need a confirming re-measurement; replace
            // the synchronous check with the resolved one before anything reads it.
            const clipResolution = await resolveClippedCheck(send, obs);
            const clipIndex = checks.findIndex((c) => c.id === 'no-clipped-elements');
            if (clipIndex >= 0) checks[clipIndex] = clipResolution.check;
            else checks.push(clipResolution.check);
            if (cli.result.code !== 0) {
              checks.unshift({ id: 'cli.apply-mode', expected: 'theme command exit 0', observed: cli.result.code + (cli.result.stderr ? (' stderr=' + cli.result.stderr.slice(0, 160)) : ''), pass: false });
            }
            caseResult = {
              tool: 'measure-layout.mjs', version: 1, sweep: true, label: 'sweep', mode: mode,
              timestamp: new Date().toISOString(), port: port, requestedViewport: requestedViewport,
              measuredViewport: measuredViewport, resize: applied.chosen, resizeAttempts: applied.attempts,
              emulationActive: applied.chosen.emulated === true,
              pageTarget: { id: preferred.id, title: preferred.title, url: preferred.url },
              steps: [cli.step, settle.step], modeSettleTimedOut: settle.timedOut,
              observations: obs, checks: checks,
              summary: { checks: checks.length, checksPassed: checks.filter((c) => c.pass).length, clipped: obs.clippedTotal }
            };
          } catch (err) {
            // A dead socket must abort, not be laundered into a per-case check.
            if (classifySweepAbort(err, socketState, caseLabel)) throw err;
            const msg = String((err && err.message) ? err.message : err).slice(0, 400);
            const checks = [{ id: 'case.error', expected: 'measurement completes', observed: msg, pass: false }];
            caseResult = {
              tool: 'measure-layout.mjs', version: 1, sweep: true, label: 'sweep', mode: mode,
              timestamp: new Date().toISOString(), port: port, requestedViewport: requestedViewport,
              resize: applied.chosen, observations: null, error: msg, checks: checks,
              summary: { checks: checks.length, checksPassed: 0, clipped: null }
            };
          }
          const shotName = 'sweep-' + mode + '-' + vw + 'x' + vh + '.png';
          const shotPath = path.join(shotDir, shotName);
          try {
            await send('Page.bringToFront');
            const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
            fs.mkdirSync(shotDir, { recursive: true });
            fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
            caseResult.screenshot = { file: shotPath, bytes: fs.statSync(shotPath).size };
          } catch (err) {
            if (classifySweepAbort(err, socketState, caseLabel)) throw err;
            caseResult.screenshot = { file: shotPath, error: String((err && err.message) ? err.message : err) };
          }
          caseResult.artifacts = writeSweepCase(caseResult, outDir);
          return caseResult;
        };
        let caseResult = null;
        try {
          caseResult = await withTimeout(runOneCase(), args.caseTimeoutMs, caseLabel);
        } catch (err) {
          const abortRecord = classifySweepAbort(err, socketState, caseLabel);
          if (abortRecord) {
            aborted = abortRecord;
            caseResult = {
              tool: 'measure-layout.mjs', version: 1, sweep: true, label: 'sweep', mode: mode,
              timestamp: new Date().toISOString(), port: port, requestedViewport: requestedViewport,
              resize: applied.chosen, observations: null, aborted: true,
              error: abortRecord.kind + ' at ' + abortRecord.case + ': ' + abortRecord.reason,
              checks: [{ id: 'case.aborted', expected: 'measurement completes', observed: abortRecord.kind + ' at ' + abortRecord.case + ': ' + abortRecord.reason, pass: false }],
              summary: { checks: 1, checksPassed: 0, clipped: null }
            };
          } else {
            const msg = String((err && err.message) ? err.message : err).slice(0, 400);
            const checks = [{ id: 'case.error', expected: 'measurement completes', observed: msg, pass: false }];
            caseResult = {
              tool: 'measure-layout.mjs', version: 1, sweep: true, label: 'sweep', mode: mode,
              timestamp: new Date().toISOString(), port: port, requestedViewport: requestedViewport,
              resize: applied.chosen, observations: null, error: msg, checks: checks,
              summary: { checks: checks.length, checksPassed: 0, clipped: null }
            };
          }
          caseResult.artifacts = writeSweepCase(caseResult, outDir);
        }
        report.cases.push(caseResult);
        // A socket that died during the case (even after the last reply) must
        // abort the sweep and be attributed to the case it died in.
        if (!aborted) {
          const deadAfterCase = classifySweepAbort(null, socketState, caseLabel);
          if (deadAfterCase) aborted = deadAfterCase;
        }

        console.log('');
        console.log('--- ' + vw + 'x' + vh + ' ' + mode + '  ' + describeResize(applied.chosen));
        if (caseResult.observations) {
          const panel = caseResult.observations.panel || { present: false };
          console.log('    panel          : ' + (panel.present ? 'present (fab=' + JSON.stringify(panel.fab) + ', status=' + JSON.stringify(panel.status) + ')' : 'absent (the CLI theme command does not inject the panel)'));
          console.log('    banner count   : ' + caseResult.observations.bannerCount + '   html.scrollHeight/clientHeight: ' + caseResult.observations.html.scrollHeight + '/' + caseResult.observations.html.clientHeight + '   clipped: ' + caseResult.observations.clippedTotal + ' (ours ' + caseResult.observations.clippedOursTotal + ', app ' + caseResult.observations.clippedAppTotal + ')');
          const clipLine = describeClipDetail((caseResult.checks || []).find((c) => c.id === 'no-clipped-elements'));
          if (clipLine) console.log('    clipped detail : ' + clipLine);
        }
        for (const c of caseResult.checks) {
          console.log((c.pass ? 'PASS' : 'FAIL') + ' ' + vw + 'x' + vh + ' ' + mode + ' ' + pad(c.id, 30) + ' expected=' + JSON.stringify(c.expected) + ' observed=' + JSON.stringify(c.observed));
        }
        console.log('    json: ' + (caseResult.artifacts ? caseResult.artifacts.file : '(failed)') + (caseResult.artifacts && caseResult.artifacts.error ? ' error=' + caseResult.artifacts.error : '') + '  screenshot: ' + (caseResult.screenshot ? (caseResult.screenshot.file + (caseResult.screenshot.bytes ? ' (' + caseResult.screenshot.bytes + ' bytes)' : '')) : '(none)'));
      }
    }

    if (appliedEmulation(report.cases)) {
      try { await send('Emulation.clearDeviceMetricsOverride'); } catch (e) { /* not available */ }
    }
    if (report.browserPid && report.cases.some((c) => c.resize && c.resize.raisedWindow)) {
      const restored = await psWindow(report.browserPid, 'restore');
      report.windowRestoredAfter = !!(restored.notTopmost && restored.lowered);
    }
  } finally {
    if (ws) { try { ws.close(); } catch (e) { /* closing */ } }
    // 5. Close only the instance this run started: graceful CDP close first,
    // then a force kill restricted to processes whose live command line still
    // carries the scratch profile path.
    let graceful = false;
    try {
      const version = await httpJson('http://127.0.0.1:' + port + '/json/version', 3000);
      const bws = await connect(version.webSocketDebuggerUrl);
      const bsend = makeSender(bws);
      // Browser.close often closes the connection before replying; a bounded
      // race keeps a pending reply from stalling the cleanup.
      await Promise.race([
        bsend('Browser.close').then(() => undefined).catch(() => undefined),
        sleep(5000)
      ]);
      graceful = true;
      try { bws.close(); } catch (e) { /* closing */ }
    } catch (e) { /* endpoint already gone */ }
    const closeDeadline = Date.now() + 15000;
    while (Date.now() < closeDeadline && await portListening(port)) await sleep(500);
    let killed = [];
    if (await portListening(port)) killed = await psKillByProfile(scratch.profile);
    const killDeadline = Date.now() + 15000;
    let leftovers = await psListByProfile(scratch.profile);
    while (Date.now() < killDeadline && leftovers.length > 0) {
      await sleep(500);
      leftovers = await psListByProfile(scratch.profile);
    }
    const portStillOpen = await portListening(port);
    report.cleanup = { gracefulBrowserClose: graceful, killedPids: killed, leftoverProcesses: leftovers.length, portStillOpen: portStillOpen };
    if (leftovers.length > 0 || portStillOpen) {
      cleanupProblems.push('scratch instance cleanup incomplete: leftoverProcesses=' + leftovers.length + ' portStillOpen=' + portStillOpen);
    }
    console.log('');
    console.log('cleanup           : gracefulBrowserClose=' + graceful + ' killed=' + (killed.length ? killed.join(',') : '(none)') + ' leftover=' + leftovers.length + ' portStillOpen=' + portStillOpen);
    try {
      fs.rmSync(scratchRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    } catch (err) {
      cleanupProblems.push('scratch tree not fully deleted: ' + String((err && err.message) ? err.message : err));
    }
    report.cleanup.scratchTreeDeleted = !fs.existsSync(scratchRoot);
    if (!report.cleanup.scratchTreeDeleted) cleanupProblems.push('scratch tree still exists: ' + scratchRoot);
    for (const p of cleanupProblems) console.error('[sweep] CLEANUP PROBLEM: ' + p);
  }

  // --------------------------------------------------------- abort record ----
  // The abort is recorded after cleanup has run, so the JSON carries both the
  // failing case and whether the scratch instance/tree were actually removed.
  if (aborted) {
    report.aborted = Object.assign({
      at: new Date().toISOString(),
      plannedCases: plannedCases,
      completedCases: report.cases.length,
      skippedCases: Math.max(0, plannedCases - report.cases.length)
    }, aborted);
    console.error('');
    console.error('[sweep] ABORTED at case ' + aborted.case + ': kind=' + aborted.kind + ' reason=' + aborted.reason + ' (remaining cases skipped)');
  }

  // ------------------------------------------------------------- summary ----
  console.log('');
  console.log('=== sweep summary ===');
  console.log(pad('viewport', 10) + pad('mode', 8) + pad('resize', 46) + pad('checks', 10) + pad('clips', 24) + 'failed');
  for (const c of report.cases) {
    const failed = c.checks.filter((x) => !x.pass).map((x) => x.id);
    const resizeText = (c.resize ? (c.resize.method + (c.resize.matched ? ' matched' : ' unmatched') + (c.resize.emulated ? ' emulated' : '')) : 'none');
    console.log(pad(c.requestedViewport.w + 'x' + c.requestedViewport.h, 10) + pad(c.mode, 8) + pad(resizeText, 46) + pad(c.summary.checksPassed + '/' + c.summary.checks, 10) + pad(clipColumn(c), 24) + (failed.length ? failed.join(',') : '-'));
  }
  const totalChecks = report.cases.reduce((n, c) => n + c.summary.checks, 0);
  const totalPassed = report.cases.reduce((n, c) => n + c.summary.checksPassed, 0);
  const clipSummary = summarizeClipResults(report.cases);
  report.summary = {
    cases: report.cases.length, plannedCases: plannedCases, checks: totalChecks, checksPassed: totalPassed, checksFailed: totalChecks - totalPassed,
    transientClipCases: clipSummary.transientCases, transientClipEntries: clipSummary.transientEntries,
    persistentClipFailures: clipSummary.persistentCases, oursClipFailures: clipSummary.oursCases,
    aborted: !!report.aborted,
    cleanupProblems: cleanupProblems.length,
    cleanupSucceeded: cleanupProblems.length === 0,
    scratchTreeDeleted: !!(report.cleanup && report.cleanup.scratchTreeDeleted)
  };
  console.log('');
  console.log('clip classification: transient app-side excused = ' + clipSummary.transientCases + ' case(s) / ' + clipSummary.transientEntries + ' entry(ies); persistent app-side clip failures = ' + clipSummary.persistentCases + '; ours clip failures = ' + clipSummary.oursCases);
  console.log('cleanup result    : ' + (report.summary.cleanupSucceeded
    ? 'succeeded (scratch instance closed, scratch tree deleted=' + report.summary.scratchTreeDeleted + ')'
    : 'FAILED (' + cleanupProblems.join('; ') + ')'));
  console.log('sweep result: ' + report.cases.length + ' cases, ' + totalChecks + ' checks, ' + totalPassed + ' passed, ' + (totalChecks - totalPassed) + ' failed; cleanup problems: ' + cleanupProblems.length + (report.aborted ? '; ABORTED at case ' + report.aborted.case + ' (' + report.aborted.kind + '): ' + report.aborted.reason : ''));
  console.log('artifacts: ' + outDir + ' (json), ' + shotDir + ' (png)');
  const summaryFile = path.join(outDir, 'sweep-summary.json');
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(summaryFile, JSON.stringify(report, null, 2));
    console.log('summary json written: ' + summaryFile);
  } catch (err) {
    console.error('WARNING: could not write ' + summaryFile + ': ' + String((err && err.message) ? err.message : err));
  }
  if (report.aborted) return 1;
  if (totalChecks - totalPassed > 0) return 1;
  if (cleanupProblems.length > 0) return 1;
  return 0;
}

function appliedEmulation(cases) {
  return cases.some((c) => c.emulationActive === true || (c.resize && c.resize.emulated === true));
}

// ---------------------------------------------------------------------- main --
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]); return 0; }
  if (args.sweep) return await runSweep(args);
  if (!args.port) throw new Error('--port is required');
  if (!args.out) throw new Error('--out is required');
  if (args.mode && !/^(tarkov|native|monet)$/.test(args.mode)) throw new Error('--mode must be tarkov | native | monet');
  const base = 'http://127.0.0.1:' + args.port;

  const result = {
    tool: 'measure-layout.mjs', version: 1, label: args.label || null, mode: args.mode || '(unchanged)',
    timestamp: new Date().toISOString(), port: args.port, requestedViewport: (args.width && args.height) ? { w: args.width, h: args.height } : null,
    steps: [], checks: [], comparisons: []
  };

  // A renderer target must exist; refuse otherwise (fail closed).
  let targets = [];
  const deadline = Date.now() + args.timeoutMs;
  let preferred = null;
  while (Date.now() < deadline) {
    try { targets = await httpJson(base + '/json/list'); } catch (err) { targets = []; }
    const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl && String(t.url || '').indexOf('devtools://') !== 0);
    if (pages.length > 0) { preferred = pages.find((t) => /zcode/i.test(t.title || '')) || pages[0]; break; }
    await sleep(500);
  }
  if (!preferred) {
    result.refused = 'no renderer page target on ' + base + ' within ' + args.timeoutMs + 'ms (' + targets.length + ' targets)';
    fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
    fs.writeFileSync(args.out, JSON.stringify(result, null, 2));
    console.error('REFUSED: ' + result.refused);
    return 2;
  }
  result.pageTarget = { id: preferred.id, title: preferred.title, url: preferred.url };
  result.targetsSeen = targets.map((t) => ({ type: t.type, title: t.title }));

  if (args.mode) {
    const cli = await applyModeCli(args, args.mode);
    result.steps.push(cli.step);
    if (cli.result.code !== 0) {
      result.refused = 'CLI failed to apply mode ' + args.mode + ' (exit ' + cli.result.code + ')';
      fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
      fs.writeFileSync(args.out, JSON.stringify(result, null, 2));
      console.error('REFUSED: ' + result.refused);
      return 2;
    }
  }

  const ws = await connect(preferred.webSocketDebuggerUrl);
  const send = makeSender(ws);
  await send('Runtime.enable');
  await send('Page.enable');
  try { await send('Page.bringToFront'); } catch (e) { /* informational */ }
  await sleep(args.settleMs);
  // A previous run may have left an emulated layout viewport behind; clear it
  // so the measurement always starts from the real window geometry.
  try { await send('Emulation.clearDeviceMetricsOverride'); } catch (e) { /* not available */ }

  // The injected banner is (re)built behind a MutationObserver/rAF debounce, so
  // wait for the mode to be visible in the DOM before measuring. Bounded: a
  // timeout is recorded, never silently treated as success.
  if (args.mode) {
    const settle = await waitForModeSettle(send, args.mode, args.settleMs);
    result.steps.push(settle.step);
    if (settle.timedOut) result.modeSettleTimedOut = true;
  }

  if (args.width && args.height && args.resize) {
    const pid = await browserPid(base);
    result.browserPid = pid;
    const applied = await applyViewport(send, base, preferred.id, pid, args.width, args.height);
    const chosen = applied.chosen;
    const attempts = applied.attempts;
    result.resize = chosen;
    result.resizeAttempts = attempts;
    result.emulationActive = chosen.emulated === true;
    result.steps.push({ step: 'resize', method: chosen.method, real: !!chosen.real, emulated: !!chosen.emulated, matched: !!chosen.matched, attempts: attempts.map((a) => ({ method: a.method, matched: a.matched, error: a.error || null, note: a.note || null })) });
  } else if (args.width && args.height) {
    result.resize = { method: 'skipped', real: false, note: '--no-resize' };
  } else {
    result.resize = { method: 'none', real: false, note: 'no --width/--height given; measured at the window size the app already has' };
  }

  await sleep(Math.max(150, Math.round(args.settleMs / 2)));
  const obs = await evaluate(send, MEASURE);
  result.observations = obs;
  result.checks = buildChecks(obs, { mode: args.mode });

  if (args.compare) {
    const baseline = JSON.parse(fs.readFileSync(args.compare, 'utf8'));
    result.compareBaseline = args.compare;
    result.comparisons = compareTo(baseline.observations || {}, obs);
  }

  if (args.shot) {
    try {
      await send('Page.bringToFront');
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.mkdirSync(path.dirname(path.resolve(args.shot)), { recursive: true });
      fs.writeFileSync(args.shot, Buffer.from(shot.data, 'base64'));
      const st = fs.statSync(args.shot);
      result.screenshot = { file: args.shot, bytes: st.size };
    } catch (err) {
      result.screenshot = { file: args.shot, error: String(err.message || err) };
    }
  }
  if (result.emulationActive) {
    try { await send('Emulation.clearDeviceMetricsOverride'); result.emulationClearedAfter = true; } catch (e) { result.emulationClearedAfter = false; }
  }
  if (result.browserPid && result.resize && result.resize.raisedWindow) {
    // Put the scratch window back where it was: the temporary topmost state was
    // only needed so Chromium would apply the resize and render frames.
    const restored = await psWindow(result.browserPid, 'restore');
    result.windowRestoredAfter = !!(restored.notTopmost && restored.lowered);
  }
  try { ws.close(); } catch (e) {}

  // ------------------------------------------------------------------ output --
  const lines = [];
  const pad = (s, n) => (String(s) + ' '.repeat(n)).slice(0, n);
  lines.push('label            : ' + (result.label || '(none)') + '   mode: ' + result.mode + '   label-file: ' + args.out);
  lines.push('viewport         : ' + obs.viewport.innerWidth + 'x' + obs.viewport.innerHeight + ' css px, dpr ' + obs.viewport.devicePixelRatio + ', outer ' + obs.viewport.outerWidth + 'x' + obs.viewport.outerHeight);
  lines.push('resize           : ' + (result.resize ? (result.resize.method + ' (real=' + result.resize.real + ', matched=' + result.resize.matched + ')') : 'none'));
  if (obs.resizeNote) lines.push('resize note      : ' + obs.resizeNote);
  lines.push('');
  lines.push(pad('element', 14) + pad('rect (x,y,w,h,bottom)', 34) + pad('height', 10) + pad('min-h', 8) + pad('position', 10) + pad('overflow', 16) + 'box-sizing');
  const rowFor = (label, o) => {
    if (!o || !o.rect) return pad(label, 14) + 'absent';
    const s = o.styles || {};
    return pad(label, 14) + pad(JSON.stringify([o.rect.x, o.rect.y, o.rect.w, o.rect.h, o.rect.bottom]), 34) + pad(s.height, 10) + pad(s['min-height'], 8) + pad(s.position, 10) + pad(s.overflow, 16) + (s['box-sizing'] || '');
  };
  lines.push(rowFor('html', obs.html));
  lines.push(rowFor('body', obs.body));
  lines.push(rowFor('#root', obs.root));
  lines.push(rowFor('app shell', obs.appShell));
  lines.push(rowFor('sidebar', obs.sidebar));
  if (obs.sidebarById) lines.push(rowFor('sidebar(#id)', obs.sidebarById));
  lines.push(rowFor('composer', obs.composer));
  lines.push(rowFor('account', obs.account && obs.account.present !== false ? obs.account : null));
  lines.push(rowFor('banner', obs.banner && obs.banner.present ? obs.banner : null));
  lines.push('');
  lines.push('body padding-top : ' + (obs.body.styles ? obs.body.styles['padding-top'] : null) + '   body margin-top: ' + (obs.body.styles ? obs.body.styles['margin-top'] : null) + '   body display: ' + (obs.body.styles ? obs.body.styles.display : null));
  lines.push('root margin-top  : ' + (obs.root.styles ? obs.root.styles['margin-top'] : null) + '   root offsetParent: ' + (obs.root.offsetParent || null) + '   insideRoot checks: sidebar=' + (obs.sidebar ? obs.sidebar.insideRoot : null) + ' composer=' + (obs.composer ? obs.composer.insideRoot : null) + ' account=' + (obs.account ? obs.account.insideRoot : null));
  lines.push('banner var       : --zcode-tarkov-banner-height = ' + (obs.bannerHeightVar || '(unset)') + '   data-zct-banner=' + String(obs.bannerAttribute));
  lines.push('overflow         : html.scrollHeight=' + obs.html.scrollHeight + ' clientHeight=' + obs.html.clientHeight + ' overflows=' + obs.overflow.htmlOverflows + ' | body.scrollHeight=' + obs.body.scrollHeight + ' clientHeight=' + obs.body.clientHeight + ' overflows=' + obs.overflow.bodyOverflows + ' | scrollingElement=' + obs.overflow.scrollingElementTag);
  lines.push('clipped elements : ' + obs.clippedTotal + ' painted outside the viewport; raw rect hits: ' + obs.clippedRawTotal + ' (up to ' + obs.clipped.length + ' shown)');
  for (const c of obs.clipped) {
    lines.push('  - ' + c.tag + (c.id ? '#' + c.id : '') + (c.dataSlot ? '[data-slot=' + c.dataSlot + ']' : '') + (c.ariaLabel ? '[aria-label=' + c.ariaLabel + ']' : '') +
      ' rect=' + JSON.stringify([c.rect.x, c.rect.y, c.rect.w, c.rect.h]) + ' painted=' + JSON.stringify([c.painted.top, c.painted.bottom]) + ' below=' + c.overflowBelow + ' above=' + c.overflowAbove + ' text="' + c.text.replace(/\s+/g, ' ').slice(0, 40) + '"');
  }
  lines.push('');
  lines.push('checks:');
  for (const c of result.checks) lines.push('  ' + (c.pass ? 'PASS' : 'FAIL') + ' ' + pad(c.id, 28) + ' expected=' + JSON.stringify(c.expected) + ' observed=' + JSON.stringify(c.observed));
  if (result.comparisons.length) {
    lines.push('comparisons against ' + result.compareBaseline + ':');
    for (const c of result.comparisons) lines.push('  ' + (c.pass ? 'PASS' : 'FAIL') + ' ' + pad(c.id, 28) + ' expected=' + JSON.stringify(c.expected) + ' observed=' + JSON.stringify(c.observed));
  }

  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  result.summary = {
    checks: result.checks.length,
    checksPassed: result.checks.filter((c) => c.pass).length,
    comparisons: result.comparisons.length,
    comparisonsPassed: result.comparisons.filter((c) => c.pass).length,
    clipped: obs.clippedTotal
  };
  fs.writeFileSync(args.out, JSON.stringify(result, null, 2));
  console.log(lines.join('\n'));
  console.log('');
  console.log('json written: ' + args.out + (result.screenshot ? '  screenshot: ' + result.screenshot.file + ' (' + result.screenshot.bytes + ' bytes)' : ''));
  const failed = result.checks.filter((c) => !c.pass).length + result.comparisons.filter((c) => !c.pass).length;
  return failed === 0 ? 0 : 1;
}

// Exported so the clipped classification decision and the sweep abort handling
// can be exercised directly by a targeted local check; importing the module
// must not run the tool. MEASURE is exported so the clean-install harness can
// take its first clipped observation with this tool's ownership classification
// instead of forking a second copy of it. browserPid and psWindow are exported
// so that harness can raise its own scratch window the same way the sweep does
// (the window is resolved from the CDP browser pid, so only the instance that
// owns the CDP endpoint is ever touched) instead of forking the user32 call.
export { resolveClippedCheck, clippedCounts, CLIP_CONFIRM_SETTLE_MS, MEASURE, withTimeout, watchSocket, classifySweepAbort, browserPid, psWindow };

const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const here = fileURLToPath(import.meta.url);
    const there = path.resolve(entry);
    return process.platform === 'win32' ? here.toLowerCase() === there.toLowerCase() : here === there;
  } catch (e) {
    return false;
  }
})();
if (invokedDirectly) {
  main().then((code) => { process.exitCode = code; }).catch((err) => {
    console.error('ERROR: ' + String((err && err.message) ? err.message : err));
    process.exitCode = 2;
  });
}
