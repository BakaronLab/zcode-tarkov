#!/usr/bin/env node
/**
 * verify-clean-install.mjs - CDP assertions + screenshots for the zcode-tarkov
 * clean-install acceptance journey.
 *
 * Renderer half of tools/verify-clean-install.ps1: the PowerShell driver
 * installs, launches and uninstalls inside a scratch tree, and calls this
 * script to prove over CDP that the Tarkov theme and the beta band are really
 * in effect in the live renderer, and to capture the screenshots.
 *
 * Modes:
 *   --mode verify  (default) probe /json/version + /json/list, run the DOM
 *                  assertions, capture the screenshots, write the evidence JSON
 *   --mode close   close the browser through its own CDP browser endpoint
 *                  (Browser.close), never by image-name kill
 *
 * Requirements: Node >= 22 with a global WebSocket and global fetch (Node 24
 * here). No dependencies, nothing is installed.
 *
 * The layout.no-clipped-elements assertion is not decided here: the decision
 * (an entry of this project fails immediately, an app-side entry is re-measured
 * after the settle and fails only when still painted outside) is imported from
 * tools/measure-layout.mjs (resolveClippedCheck + its MEASURE expression), so
 * the harness and the measurement tool cannot disagree. The first and the
 * confirming measurement, the entries and the classification are kept in the
 * evidence JSON, and a note records when a transient was excused.
 *
 * Measurement conditions: before the layout observations are taken, the scratch
 * instance this harness launched is raised to the top of the z-order without
 * activation, through the same helper the sweep uses (tools/measure-layout.mjs
 * psWindow 'raise'). An unraised/occluded Chromium window does not advance CSS
 * animations, so an app-side slide-in (ZCode's update toast) can sit frozen
 * below the viewport and look like a persistent clip. The raise and the
 * before/after painted-outside measurements are recorded in the evidence JSON
 * as windowRaise; a failed raise is recorded and does not fail the run alone.
 *
 * Usage:
 *   node tools/verify-clean-install.mjs --port 9444 \
 *     --out-dir <repo>/docs/images --evidence <tmp>/cdp-evidence.json \
 *     --palette accent=#e07930 --palette background=#1c1207 --palette text=#e8d9c8
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import zlib from 'node:zlib';
import { resolveClippedCheck, clippedCounts, CLIP_CONFIRM_SETTLE_MS, MEASURE, browserPid, psWindow } from './measure-layout.mjs';

function parseArgs(argv) {
  const out = { port: 9444, mode: 'verify', outDir: '', evidence: '', palette: {}, timeoutMs: 45000 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--port') { out.port = Number(argv[i + 1]); i += 1; }
    else if (a === '--mode') { out.mode = argv[i + 1]; i += 1; }
    else if (a === '--out-dir') { out.outDir = argv[i + 1]; i += 1; }
    else if (a === '--evidence') { out.evidence = argv[i + 1]; i += 1; }
    else if (a === '--timeout-ms') { out.timeoutMs = Number(argv[i + 1]); i += 1; }
    else if (a === '--palette') {
      const pair = String(argv[i + 1] || '');
      i += 1;
      const eq = pair.indexOf('=');
      if (eq > 0) out.palette[pair.slice(0, eq)] = pair.slice(eq + 1);
    } else if (a === '--help' || a === '-h') { out.help = true; }
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

function pngInfo(file) {
  try {
    const buf = fs.readFileSync(file);
    if (buf.length > 24 && buf.toString('ascii', 1, 4) === 'PNG') {
      return { bytes: buf.length, width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    return { bytes: buf.length, width: null, height: null };
  } catch (err) {
    return { bytes: null, error: String(err.message || err) };
  }
}

// Minimal dependency-free PNG decode (8-bit, non-interlaced RGB/RGBA - what
// Chromium's Page.captureScreenshot emits) plus a palette histogram. It proves
// a screenshot is not a blank/failed capture and that the Tarkov band and
// accent colours are actually painted, without an image viewer.
function decodePng(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8;
  let ihdr = null;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') ihdr = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), bitDepth: data[8], colorType: data[9], interlace: data[12] };
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (!ihdr || ihdr.bitDepth !== 8 || ihdr.interlace !== 0) throw new Error('unsupported PNG (bitDepth ' + (ihdr && ihdr.bitDepth) + ', interlace ' + (ihdr && ihdr.interlace) + ')');
  const channels = ihdr.colorType === 6 ? 4 : ihdr.colorType === 2 ? 3 : 0;
  if (!channels) throw new Error('unsupported color type ' + ihdr.colorType);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = ihdr.width * channels;
  const out = Buffer.alloc(stride * ihdr.height);
  let prev = Buffer.alloc(stride);
  let rp = 0;
  for (let y = 0; y < ihdr.height; y += 1) {
    const filter = raw[rp]; rp += 1;
    const cur = Buffer.from(raw.subarray(rp, rp + stride)); rp += stride;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = cur[x];
      if (filter === 1) v = (v + a) & 255;
      else if (filter === 2) v = (v + b) & 255;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        v = (v + pr) & 255;
      }
      cur[x] = v;
    }
    cur.copy(out, y * stride);
    prev = cur;
  }
  return { width: ihdr.width, height: ihdr.height, channels: channels, data: out };
}

function analyzePng(file) {
  const img = decodePng(file);
  const { width, height, channels, data } = img;
  const stride = width * channels;
  const step = Math.max(1, Math.floor(Math.min(width, height) / 400));
  const colors = new Set();
  let count = 0; let sr = 0; let sg = 0; let sb = 0;
  let accent = 0; let band = 0; let deep = 0; let nearBlack = 0;
  const near = (r, g, b, R, G, B, tol) => Math.abs(r - R) <= tol && Math.abs(g - G) <= tol && Math.abs(b - B) <= tol;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = y * stride + x * channels;
      const r = data[i]; const g = data[i + 1]; const b = data[i + 2];
      count += 1; sr += r; sg += g; sb += b;
      colors.add((r << 16) | (g << 8) | b);
      if (near(r, g, b, 224, 121, 48, 24)) accent += 1;
      if (near(r, g, b, 160, 86, 35, 22) || near(r, g, b, 171, 94, 37, 22)) band += 1;
      if (near(r, g, b, 28, 18, 7, 14)) deep += 1;
      if (r < 12 && g < 12 && b < 12) nearBlack += 1;
    }
  }
  return {
    file: file, width: width, height: height, sampled: count, sampleStep: step,
    distinctColors: colors.size,
    avgRgb: [Math.round(sr / count), Math.round(sg / count), Math.round(sb / count)],
    accentPixels: accent, bandPixels: band, deepSurfacePixels: deep, nearBlackPixels: nearBlack
  };
}

function pickPageTarget(targets) {
  const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  const notDevtools = pages.filter((t) => String(t.url || '').indexOf('devtools://') !== 0);
  const preferred = notDevtools.find((t) => /zcode/i.test(t.title || '')) || notDevtools[0] || pages[0];
  return { pages: pages, preferred: preferred };
}

async function evaluate(send, expression) {
  const res = await send('Runtime.evaluate', { expression: expression, returnByValue: true, awaitPromise: true });
  if (res.exceptionDetails) throw new Error('Runtime.evaluate threw: ' + JSON.stringify(res.exceptionDetails));
  return res.result ? res.result.value : undefined;
}

// ---------------------------------------------------- scratch window raise ---
// The layout observations below are only comparable to the sweep's when the
// window is in the same state: an unraised (occluded/background) Chromium
// window does not advance CSS animations - a minimized window stops producing
// frames entirely (docs/dev/zcode-dom-notes.md) - so an app-side slide-in (the
// update toast) can sit frozen below the viewport for as long as the window is
// left alone. The sweep raises its scratch window before measuring; this
// harness raises the scratch instance it launched with the same helper
// (psWindow 'raise' = user32 SetWindowPos to HWND_TOPMOST with
// SWP_NOSIZE | SWP_NOMOVE | SWP_SHOWWINDOW | SWP_NOACTIVATE: un-occluded,
// without stealing focus). The window is resolved from the browser pid the CDP
// endpoint of this port reports (SystemInfo.getProcessInfo), so only the
// instance that owns this endpoint - the one this harness started - can be
// touched. A failed raise is recorded and does not fail the run on its own.
const RAISE_CALL = 'tools/measure-layout.mjs psWindow(pid, "raise") -> user32!SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_SHOWWINDOW | SWP_NOACTIVATE)';
const RAISE_VISIBLE_BUDGET_MS = 10000;
const RAISE_FRAME_ADVANCE_MS = 500;

// The app-side painted-outside set as evidence (this is not a decision). The
// exported clippedCounts classification and the same MEASURE expression the
// resolver uses keep the before/after observations directly comparable.
function paintedOutsideSet(obs) {
  const counts = clippedCounts(obs);
  return {
    paintedOutside: counts.total,
    rawRectHits: counts.rawTotal,
    ours: counts.oursTotal,
    app: counts.appTotal,
    appEntries: counts.app.slice(0, 10)
  };
}

async function raiseScratchWindow(send, base) {
  const evidence = {
    step: 'raise-scratch-window',
    attempted: true,
    target: 'the scratch instance launched by this harness (browser pid from CDP SystemInfo.getProcessInfo on the harness CDP port)',
    call: RAISE_CALL,
    note: 'An unraised/occluded Chromium window does not advance CSS animations (a minimized window stops producing frames entirely; docs/dev/zcode-dom-notes.md), so an app-side toast can sit frozen below the fold and look like a persistent clip. The sweep (tools/measure-layout.mjs) raises its scratch window before measuring; this raise aligns the harness measurement conditions with the sweep. A failed raise is recorded here and does not fail the run on its own.',
    succeeded: false,
    paintedOutsideBefore: null,
    paintedOutsideAfter: null
  };
  const measure = async () => {
    try { return paintedOutsideSet(await evaluate(send, MEASURE)); }
    catch (err) { return { error: String((err && err.message) ? err.message : err) }; }
  };
  evidence.paintedOutsideBefore = await measure();
  try {
    const pid = await browserPid(base);
    evidence.pid = pid;
    if (!pid) {
      evidence.error = 'no browser pid reported by CDP SystemInfo.getProcessInfo; the scratch window cannot be located';
    } else {
      const raised = await psWindow(pid, 'raise');
      evidence.raiseResult = raised;
      evidence.succeeded = !!(raised && raised.found && raised.raised === true);
      if (!evidence.succeeded) {
        evidence.error = (raised && raised.error) ? String(raised.error) : 'SetWindowPos(HWND_TOPMOST) did not report success';
      }
      const visDeadline = Date.now() + RAISE_VISIBLE_BUDGET_MS;
      let state = null;
      while (Date.now() < visDeadline) {
        try { state = await evaluate(send, '({vis: document.visibilityState, focused: document.hasFocus()})'); }
        catch (err) { state = { error: String((err && err.message) ? err.message : err) }; }
        if (state && state.vis === 'visible') break;
        await sleep(300);
      }
      evidence.rendererAfterRaise = state;
      evidence.rendererVisibleAfterRaise = !!(state && state.vis === 'visible');
    }
  } catch (err) {
    evidence.error = String((err && err.message) ? err.message : err);
  }
  // Let the un-occluded renderer advance a few frames before the "after"
  // measurement and before the observation that feeds the assertions.
  await sleep(RAISE_FRAME_ADVANCE_MS);
  evidence.frameAdvanceMs = RAISE_FRAME_ADVANCE_MS;
  evidence.paintedOutsideAfter = await measure();
  return evidence;
}

const ASSERT_EXPR = `(function(){
  var out = {};
  var styleEl = document.getElementById('zcode-beautify-style');
  out.styleElPresent = !!styleEl;
  out.styleElText = styleEl ? styleEl.textContent : '';
  out.styleElTextLen = styleEl ? styleEl.textContent.length : 0;
  var cs = getComputedStyle(document.documentElement);
  out.varPrimary = cs.getPropertyValue('--color-primary').trim();
  out.varForeground = cs.getPropertyValue('--color-foreground').trim();
  out.varBackground = cs.getPropertyValue('--color-background').trim();
  out.varPanel = cs.getPropertyValue('--color-panel').trim();
  out.varCard = cs.getPropertyValue('--color-card').trim();
  out.varTarkovAccent = cs.getPropertyValue('--tarkov-accent').trim();
  out.htmlClasses = document.documentElement.className;
  out.bodyClasses = document.body ? document.body.className : '';
  out.locationHref = location.href;
  out.title = document.title;
  out.devicePixelRatio = window.devicePixelRatio;
  out.viewport = { w: window.innerWidth, h: window.innerHeight };
  var p = document.querySelector('p[data-v4-draft-greeting="true"]');
  out.greetingPresent = !!p;
  if (p) {
    var pcs = getComputedStyle(p);
    out.greetingBackground = pcs.background;
    out.greetingBgColor = pcs.backgroundColor;
    out.greetingWidth = pcs.width;
    out.greetingHeight = pcs.height;
    out.greetingRadius = pcs.borderRadius;
    out.greetingFontVar = pcs.getPropertyValue('--v4-draft-greeting-font-size').trim();
    var before = getComputedStyle(p, '::before');
    out.badgeContent = before.content;
    out.badgeWidth = before.width;
    out.badgeHeight = before.height;
    out.badgeBg = before.backgroundColor;
    out.badgeColor = before.color;
    out.badgeClip = before.clipPath;
    var spans = p.querySelectorAll(':scope > span');
    out.greetingSpanCount = spans.length;
    var vis = p.querySelector(':scope > span:not([aria-hidden]):last-child');
    out.visibleSpanFound = !!vis;
    if (vis) {
      var vcs = getComputedStyle(vis);
      out.visibleSpanText = vis.textContent;
      out.visibleSpanFontSize = vcs.fontSize;
      var vb = getComputedStyle(vis, '::before');
      var va = getComputedStyle(vis, '::after');
      out.line1Content = vb.content;
      out.line2Content = va.content;
      out.line1Font = vb.fontSize + ' ' + vb.fontWeight;
      out.line2Font = va.fontSize + ' ' + va.fontWeight;
      out.line1Color = vb.color;
      out.line2Color = va.color;
    }
    var hidden = p.querySelector(':scope > span[aria-hidden="true"]');
    out.hiddenSpanFound = !!hidden;
  }
  var root = document.getElementById('zcode-beautify-panel-root');
  out.panelRootPresent = !!root;
  if (root) {
    out.panelThemeAttr = root.getAttribute('data-zb-theme');
    out.panelOfflineAttr = root.getAttribute('data-offline');
  }
  var fab = document.getElementById('zb-fab');
  out.fabPresent = !!fab;
  var sel = document.getElementById('zb-theme');
  out.themeSelectPresent = !!sel;
  if (sel) out.themeSelectValue = sel.value;
  out.dialogCount = document.querySelectorAll('[role="dialog"], [role="alertdialog"], [data-slot="dialog-content"], [data-slot="alert-dialog-content"]').length;
  out.hasFocus = document.hasFocus();
  out.bodyChildCount = document.body ? document.body.childElementCount : null;

  // ---- layout observation for the banner band reservation invariant ----
  // Band height + app root height must add up to the viewport; nothing may sit
  // below the window edge. Same locators as tools/measure-layout.mjs (the
  // sidebar is the leftmost full-height column, the composer is found by
  // climbing from the editing surface), so the harness and the measurement
  // tool cannot disagree about what they measured.
  var rct = function (el) { if (!el) return null; var r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, top: r.top, bottom: r.bottom, left: r.left, right: r.right }; };
  var vis = function (el) { var c = getComputedStyle(el); return c.display !== 'none' && c.visibility !== 'hidden' && parseFloat(c.opacity) !== 0; };
  var visibleEls = document.querySelectorAll('body *');
  var L = {
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
    bannerCount: document.querySelectorAll('#zcode-tarkov-banner').length,
    bannerVar: getComputedStyle(document.documentElement).getPropertyValue('--zcode-tarkov-banner-height').trim(),
    bannerAttr: document.documentElement.getAttribute('data-zct-banner'),
    banner: null, appShell: null, sidebar: null, composer: null, editor: null, account: null,
    html: { rect: rct(document.documentElement), scrollHeight: document.documentElement.scrollHeight, clientHeight: document.documentElement.clientHeight },
    body: { rect: rct(document.body), paddingTop: getComputedStyle(document.body).paddingTop, display: getComputedStyle(document.body).display },
    root: { rect: rct(document.getElementById('root')), height: getComputedStyle(document.getElementById('root')).height, marginTop: getComputedStyle(document.getElementById('root')).marginTop }
  };
  var bannerEl = document.getElementById('zcode-tarkov-banner');
  if (bannerEl) L.banner = { rect: rct(bannerEl), isBodyFirstChild: document.body.firstElementChild === bannerEl };
  var rootEl = document.getElementById('root');
  var shell = null, shellArea = 0;
  for (var li = 0; li < visibleEls.length; li++) {
    var le = visibleEls[li];
    if (!rootEl || !rootEl.contains(le) || !vis(le)) continue;
    var lr = le.getBoundingClientRect();
    if (lr.width < 200 || lr.height < 100) continue;
    if (lr.width * lr.height > shellArea) { shellArea = lr.width * lr.height; shell = le; }
  }
  if (shell) L.appShell = { rect: rct(shell) };
  var cur = rootEl, hops = 0;
  while (cur && cur.children && hops < 12) {
    var best = null, bestLeft = Infinity, bestWidth = -1;
    for (var lj = 0; lj < cur.children.length; lj++) {
      var kid = cur.children[lj];
      if (kid.id === 'zcode-tarkov-banner' || !vis(kid)) continue;
      var kcs = getComputedStyle(kid);
      if (kcs.position === 'fixed' || kcs.position === 'absolute') continue;
      var kr = kid.getBoundingClientRect();
      if (kr.height < L.innerHeight * 0.75 || kr.width < 40 || kr.left > 16) continue;
      if (kr.left < bestLeft - 1 || (Math.abs(kr.left - bestLeft) <= 1 && kr.width > bestWidth)) { best = kid; bestLeft = kr.left; bestWidth = kr.width; }
    }
    if (!best) break;
    if (bestWidth <= L.innerWidth * 0.6) { L.sidebar = { rect: rct(best) }; break; }
    cur = best; hops += 1;
  }
  var editor = document.querySelector('div[role="textbox"], textarea, [contenteditable="true"]');
  if (editor) {
    var walk = editor, composer = null;
    for (var lu = 0; lu < 10 && walk && walk !== document.body; lu++) {
      var lcls = typeof walk.className === 'string' ? walk.className : '';
      if (/composer/i.test(lcls)) composer = walk;
      walk = walk.parentElement;
    }
    L.editor = { rect: rct(editor) };
    if (composer) L.composer = { rect: rct(composer) };
  }
  var ACCOUNT_TEXT = [String.fromCharCode(0x8fde, 0x63a5, 0x4f7f, 0x7528), 'Connect to use', 'Sign in'];
  for (var lk = 0; lk < visibleEls.length; lk++) {
    var cand = visibleEls[lk];
    if (cand.childElementCount > 0 || !vis(cand)) continue;
    var ltext = (cand.textContent || '').trim();
    for (var lm = 0; lm < ACCOUNT_TEXT.length; lm++) {
      if (ltext === ACCOUNT_TEXT[lm] || (ltext.length < 40 && ltext.indexOf(ACCOUNT_TEXT[lm]) >= 0)) { L.account = { rect: rct(cand), text: ltext }; break; }
    }
    if (L.account) break;
  }
  // Clipped elements are NOT gathered here: the decision (and therefore the
  // ownership classification) belongs to tools/measure-layout.mjs, which owns
  // the MEASURE expression and resolveClippedCheck. This block keeps only the
  // layout locators the other assertions need.
  out.layout = L;
  return out;
})()`;

function buildAssertions(obs, expected) {
  const list = [];
  const add = (id, expectedVal, observedVal, pass) => list.push({ id: id, expected: expectedVal, observed: observedVal, pass: pass });
  const has = (s, needle) => typeof s === 'string' && s.indexOf(needle) >= 0;
  const norm = (s) => String(s).replace(/\s+/g, '').toLowerCase();

  add('theme.style-element', 'present', obs.styleElPresent, obs.styleElPresent === true);
  add('theme.css-has-primary-token', 'injected css carries --color-primary:#e07930',
    'style text ' + obs.styleElTextLen + ' chars, hasPrimaryToken=' + has(obs.styleElText, '--color-primary:#e07930'),
    obs.styleElPresent === true && has(obs.styleElText, '--color-primary:#e07930'));
  add('theme.computed-color-primary', expected.accent, obs.varPrimary, norm(obs.varPrimary) === norm(expected.accent));
  add('theme.computed-color-foreground', expected.text, obs.varForeground, norm(obs.varForeground) === norm(expected.text));
  add('theme.computed-tarkov-accent', expected.accent, obs.varTarkovAccent, norm(obs.varTarkovAccent) === norm(expected.accent));
  add('theme.computed-color-panel', expected.panel, obs.varPanel, norm(obs.varPanel) === norm(expected.panel));
  add('theme.computed-color-card', expected.card, obs.varCard, norm(obs.varCard) === norm(expected.card));
  add('theme.not-native-panel-token', 'not #202020 (ZCode native dark panel)', obs.varPanel, String(obs.varPanel).toLowerCase() !== '#202020');
  add('page.html-classes-dark', 'dark in html class list', obs.htmlClasses, /\bdark\b/.test(String(obs.htmlClasses)));

  add('band.greeting-present', 'p[data-v4-draft-greeting="true"] present', obs.greetingPresent, obs.greetingPresent === true);
  add('band.background-rgba', 'background contains rgba(224, 121, 48,', obs.greetingBackground,
    has(obs.greetingBackground, expected.bandRgb) || has(obs.greetingBgColor, expected.bandRgb));
  const fontVar = parseFloat(String(obs.greetingFontVar || '30').replace('px', '')) || 30;
  // Chromium reports computed lengths without trailing zeros ("43.5px", not
  // "43.50px"), so compare numerically, not as strings.
  const px = (v) => parseFloat(String(v));
  const expBadgeW = fontVar * 1.45;
  const expBadgeH = fontVar * 1.25;
  add('band.badge-width', expBadgeW + 'px (1.45 x greeting font var ' + fontVar + 'px)', obs.badgeWidth, px(obs.badgeWidth) === expBadgeW);
  add('band.badge-height', expBadgeH + 'px (1.25 x greeting font var)', obs.badgeHeight, px(obs.badgeHeight) === expBadgeH);
  add('band.badge-bg', 'rgb(28, 18, 7)', obs.badgeBg, norm(obs.badgeBg) === 'rgb(28,18,7)');
  add('band.badge-color', 'rgb(224, 121, 48)', obs.badgeColor, norm(obs.badgeColor) === 'rgb(224,121,48)');
  add('band.badge-hexagon-clip', expected.badgeClip, obs.badgeClip, norm(obs.badgeClip) === norm(expected.badgeClip));
  add('band.line1-content', 'contains "Beta"', obs.line1Content, has(obs.line1Content, 'Beta'));
  add('band.line2-content', 'non-empty', obs.line2Content, typeof obs.line2Content === 'string' && obs.line2Content.length > 2);
  add('band.line1-font', (fontVar * 0.6) + 'px 700', obs.line1Font, px(obs.line1Font) === fontVar * 0.6 && String(obs.line1Font).indexOf('700') > 0);
  add('band.line2-font', (fontVar * 0.5) + 'px 400', obs.line2Font, px(obs.line2Font) === fontVar * 0.5 && String(obs.line2Font).indexOf('400') > 0);
  add('band.real-greeting-text-preserved', 'non-empty original greeting text inside the span', obs.visibleSpanText,
    typeof obs.visibleSpanText === 'string' && obs.visibleSpanText.trim().length > 0);
  add('panel.root-present', 'injected panel root present', obs.panelRootPresent, obs.panelRootPresent === true);
  add('panel.theme-select-present', '#zb-theme select present', obs.themeSelectPresent, obs.themeSelectPresent === true);
  add('screenshot.no-dialog-open', 'no modal dialog element in the tree at capture time', obs.dialogCount, obs.dialogCount === 0);
  add('screenshot.renderer-focused', 'document.hasFocus() (informational: the capture is a renderer surface, occlusion does not blank it)', obs.hasFocus, obs.hasFocus === true);
  return list;
}

// Re-labels the resolver's check as this harness's layout assertion. The id and
// the expected string are the harness contract and stay exactly as they were;
// the meaning is the resolver's refined one: an entry of this project fails
// immediately, an app-side entry fails only when still painted outside after
// the settle. The resolver's detail (entries, first and confirming
// measurements, classification) plus a human-readable note stay on the
// assertion, so the evidence shows when a transient was excused.
function harnessClipAssertion(resolverCheck) {
  const assertion = {
    id: 'layout.no-clipped-elements',
    expected: 'no painted element reaches outside the viewport',
    observed: resolverCheck.observed,
    pass: resolverCheck.pass === true
  };
  const detail = resolverCheck.detail;
  if (detail) assertion.detail = detail;
  if (detail && detail.oursPaintedOutside) {
    assertion.note = 'FAILED immediately: ' + detail.oursPaintedOutside.total + ' painted-outside entry(ies) belong to this project (banner/panel/#zb-*/wallpaper) and are never excused; no settle was attempted. Entries are in detail.oursPaintedOutside.';
  } else if (detail && detail.persistentPaintedOutside) {
    assertion.note = 'FAILED as persistent: ' + detail.persistentPaintedOutside.confirm.paintedOutside + ' app-side entry(ies) were still painted outside after the ' + detail.persistentPaintedOutside.settleMs + ' ms settle (' + detail.persistentPaintedOutside.reason + '). First and confirming measurements are in detail.persistentPaintedOutside.';
  } else if (detail && detail.transientPaintedOutside) {
    assertion.note = 'transient excused: ' + detail.transientPaintedOutside.first.paintedOutside + ' app-side entry(ies) were painted outside at the first measurement and had cleared after the ' + detail.transientPaintedOutside.settleMs + ' ms settle (classification=' + detail.transientPaintedOutside.classification + '); no entry of this project was involved. The entries and both measurements are recorded in detail.transientPaintedOutside and in clipDecision.';
  }
  return assertion;
}

// Layout assertions for the banner band reservation. This harness only runs in
// Tarkov mode, so the band must be present and the invariant must hold:
// band height + app root height == viewport height, nothing below the window.
// The no-clipped-elements assertion is passed in as the resolver's check.
function buildLayoutAssertions(obs, options) {
  const list = [];
  const add = (id, expectedVal, observedVal, pass) => list.push({ id: id, expected: expectedVal, observed: observedVal, pass: pass === true });
  const L = obs.layout;
  if (!L) {
    add('layout.observation-present', 'the layout observation block ran', 'missing', false);
    return list;
  }
  const H = L.innerHeight;
  const near = (a, b, tol) => Math.abs(a - b) <= (tol === undefined ? 0.5 : tol);
  add('layout.banner-count', 'exactly one #zcode-tarkov-banner element', L.bannerCount, L.bannerCount === 1);
  add('layout.attribute-set', 'html[data-zct-banner="1"]', L.bannerAttr, L.bannerAttr === '1');
  add('layout.banner-band-height',
    '--zcode-tarkov-banner-height resolves and equals the painted band height',
    { property: L.bannerVar, bandHeight: L.banner ? L.banner.rect.h : null },
    /px$/.test(L.bannerVar) && !!L.banner && near(parseFloat(L.bannerVar), L.banner.rect.h));
  add('layout.banner-inside-viewport', 'band top >= 0 and bottom <= innerHeight + 0.5',
    L.banner ? [L.banner.rect.top, L.banner.rect.bottom, H] : 'no banner',
    !!L.banner && L.banner.rect.top >= 0 && L.banner.rect.bottom <= H + 0.5);
  add('layout.app-shell-below-banner', 'app shell top >= band bottom (band reserves, never covers)',
    [L.appShell ? L.appShell.rect.top : null, L.banner ? L.banner.rect.bottom : null],
    !!L.appShell && !!L.banner && L.appShell.rect.top >= L.banner.rect.bottom - 0.5);
  add('layout.root-bottom-at-viewport', '|#root.bottom - innerHeight| <= 0.5',
    [L.root.rect ? L.root.rect.bottom : null, H],
    !!L.root.rect && near(L.root.rect.bottom, H));
  add('layout.composer-fully-visible', 'composer top >= 0 and bottom <= innerHeight + 0.5',
    L.composer ? [L.composer.rect.top, L.composer.rect.bottom, H] : 'not found',
    !!L.composer && L.composer.rect.top >= 0 && L.composer.rect.bottom <= H + 0.5);
  add('layout.sidebar-fully-visible', 'sidebar top >= 0 and bottom <= innerHeight + 0.5',
    L.sidebar ? [L.sidebar.rect.top, L.sidebar.rect.bottom, H] : 'not found',
    !!L.sidebar && L.sidebar.rect.top >= 0 && L.sidebar.rect.bottom <= H + 0.5);
  add('layout.account-fully-visible', 'account label top >= 0 and bottom <= innerHeight + 0.5',
    L.account ? [L.account.text, L.account.rect.top, L.account.rect.bottom, H] : 'not found',
    !!L.account && L.account.rect.top >= 0 && L.account.rect.bottom <= H + 0.5);
  const clipCheck = options && options.clipCheck;
  if (clipCheck) list.push(harnessClipAssertion(clipCheck));
  else add('layout.no-clipped-elements', 'no painted element reaches outside the viewport', 'the clipped-decision resolver did not run', false);
  add('layout.no-vertical-overflow', 'html.scrollHeight <= html.clientHeight + 1',
    [L.html.scrollHeight, L.html.clientHeight],
    L.html.scrollHeight <= L.html.clientHeight + 1);
  return list;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log('see the header of this file'); return 0; }
  const base = 'http://127.0.0.1:' + args.port;
  const result = { timestamp: new Date().toISOString(), port: args.port, mode: args.mode, steps: [], assertions: [], screenshots: [], screenshotAnalysis: [] };

  if (args.mode === 'close') {
    const version = await httpJson(base + '/json/version');
    result.version = version;
    const ws = await connect(version.webSocketDebuggerUrl);
    const send = makeSender(ws);
    try {
      await send('Browser.close');
      result.steps.push({ step: 'Browser.close', ok: true });
    } catch (err) {
      result.steps.push({ step: 'Browser.close', ok: true, note: 'no reply before close: ' + String(err.message || err) });
    }
    try { ws.close(); } catch (e) {}
    const deadline = Date.now() + 20000;
    let stillUp = true;
    while (Date.now() < deadline) {
      await sleep(500);
      try { await httpJson(base + '/json/version', 1500); } catch (err) { stillUp = false; break; }
    }
    result.cdpStillUp = stillUp;
    if (args.evidence) fs.writeFileSync(args.evidence, JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ mode: 'close', cdpStillUp: stillUp, browser: version.Browser || null }));
    return stillUp ? 1 : 0;
  }

  if (args.mode === 'analyze') {
    if (!args.outDir) throw new Error('--out-dir is required in analyze mode');
    const files = [path.join(args.outDir, 'homepage-tarkov.png'), path.join(args.outDir, 'panel-theme-selector.png')];
    for (const f of files) {
      if (fs.existsSync(f)) {
        const analysis = analyzePng(f);
        result.screenshotAnalysis.push(analysis);
        result.steps.push({ step: 'analyze', file: f, ok: true, distinctColors: analysis.distinctColors, accentPixels: analysis.accentPixels, bandPixels: analysis.bandPixels, deepSurfacePixels: analysis.deepSurfacePixels });
      } else {
        result.steps.push({ step: 'analyze', file: f, ok: false, note: 'missing' });
      }
    }
    if (args.evidence) fs.writeFileSync(args.evidence, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result.steps));
    return 0;
  }

  let version = null;
  const waitDeadline = Date.now() + 60000;
  while (Date.now() < waitDeadline) {
    try { version = await httpJson(base + '/json/version', 3000); break; } catch (err) { await sleep(1000); }
  }
  if (!version) throw new Error('CDP endpoint ' + base + '/json/version did not answer within 60s');
  result.version = version;

  // The page target appears a moment after /json/version (measured ~2.5s on a
  // cold scratch profile), so wait for it instead of failing on the first list.
  let targets = [];
  let preferred = null;
  let picked = { pages: [] };
  const pageDeadline = Date.now() + args.timeoutMs;
  while (Date.now() < pageDeadline) {
    try { targets = await httpJson(base + '/json/list'); } catch (err) { targets = []; }
    picked = pickPageTarget(targets);
    preferred = picked.preferred;
    if (preferred) break;
    await sleep(500);
  }
  result.targets = targets.map((t) => ({ id: t.id, type: t.type, title: t.title, url: t.url }));
  if (!preferred) throw new Error('no page target with a webSocketDebuggerUrl in /json/list after ' + args.timeoutMs + 'ms (' + targets.length + ' targets)');
  result.pageTarget = { id: preferred.id, title: preferred.title, url: preferred.url, type: preferred.type };
  result.pageTargetCount = picked.pages.length;
  const ws = await connect(preferred.webSocketDebuggerUrl);
  const send = makeSender(ws);
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.bringToFront');

  const readyDeadline = Date.now() + args.timeoutMs;
  let ready = false;
  while (Date.now() < readyDeadline) {
    try {
      ready = !!(await evaluate(send, "!!document.querySelector('p[data-v4-draft-greeting=\"true\"]')"));
      if (ready) break;
    } catch (err) { /* page still navigating */ }
    await sleep(1000);
  }
  result.steps.push({ step: 'wait-for-renderer-mounted', ok: ready, waitedMs: args.timeoutMs });

  // The panel is injected by the resident service asynchronously (and, since
  // the panel-script fix, built on DOMContentLoaded while the document can
  // still be loading), so it is not guaranteed to exist the instant the
  // renderer looks ready. Wait for it, bounded and recorded; the presence
  // assertions themselves are unchanged and still fail when it never appears.
  const panelWaitStart = Date.now();
  const panelWaitBudgetMs = 10000;
  const panelWaitPollMs = 250;
  let panelWaitRoot = false;
  let panelWaitSelect = false;
  while (Date.now() - panelWaitStart < panelWaitBudgetMs) {
    let state = null;
    try {
      state = await evaluate(send, "(function(){ return { root: !!document.getElementById('zcode-beautify-panel-root'), select: !!document.getElementById('zb-theme') }; })()");
    } catch (err) { state = null; /* page still settling */ }
    panelWaitRoot = !!(state && state.root);
    panelWaitSelect = !!(state && state.select);
    if (panelWaitRoot && panelWaitSelect) break;
    await sleep(panelWaitPollMs);
  }
  const panelWait = {
    budgetMs: panelWaitBudgetMs,
    pollMs: panelWaitPollMs,
    waitedMs: Date.now() - panelWaitStart,
    root: panelWaitRoot,
    select: panelWaitSelect,
    appeared: panelWaitRoot && panelWaitSelect,
    timedOut: !(panelWaitRoot && panelWaitSelect)
  };
  result.panelWait = panelWait;
  result.steps.push({ step: 'wait-for-panel-injection', ok: panelWait.appeared, timedOut: panelWait.timedOut, waitedMs: panelWait.waitedMs, budgetMs: panelWaitBudgetMs, root: panelWaitRoot, select: panelWaitSelect });
  if (panelWait.timedOut) {
    console.error('[panel-wait] timed out after ' + panelWait.waitedMs + 'ms (budget ' + panelWaitBudgetMs + 'ms): #zcode-beautify-panel-root=' + panelWaitRoot + ' #zb-theme=' + panelWaitSelect);
  }

  // Measurement conditions aligned with the sweep: raise the scratch window this
  // harness launched before the layout observations are taken. Recorded in the
  // evidence JSON, including the app-side painted-outside set before and after
  // the raise; a failed raise does not fail the run on its own.
  result.windowRaise = await raiseScratchWindow(send, base);

  const obs = await evaluate(send, ASSERT_EXPR);
  result.observations = obs;
  // The clipped-element decision is owned by tools/measure-layout.mjs: the
  // first observation comes from its MEASURE expression (the same ownership
  // classification the resolver applies), the resolver re-measures after its
  // settle when only app-side entries are involved, and its check is
  // re-labelled for this harness below. Anything of ours is never excused.
  const clipFirst = await evaluate(send, MEASURE);
  const clipResolution = await resolveClippedCheck(send, clipFirst, { settleMs: CLIP_CONFIRM_SETTLE_MS });
  result.clipDecision = {
    resolver: 'tools/measure-layout.mjs resolveClippedCheck',
    settleMs: CLIP_CONFIRM_SETTLE_MS,
    check: clipResolution.check,
    firstMeasurement: clipFirst,
    confirmMeasurement: clipResolution.confirmObs
  };
  const expected = {
    accent: args.palette.accent || '#e07930',
    background: args.palette.background || '#1c1207',
    text: args.palette.text || '#e8d9c8',
    panel: 'rgba(26, 18, 10, 0.62)',
    card: 'rgba(42, 29, 16, 0.72)',
    bandRgb: 'rgba(224, 121, 48,',
    badgeClip: 'polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%)'
  };
  result.expected = expected;
  result.assertions = buildAssertions(obs, expected).concat(buildLayoutAssertions(obs, { clipCheck: clipResolution.check }));
  if (panelWait.timedOut) {
    // The assertions keep their own expected/observed/pass semantics; the note
    // only records that their observation happened after a timed-out wait.
    for (const a of result.assertions) {
      if (a.id === 'panel.root-present' || a.id === 'panel.theme-select-present') {
        a.note = 'panel wait timed out after ' + panelWait.waitedMs + ' ms (budget ' + panelWaitBudgetMs + ' ms); ' + a.id + ' was evaluated after the wait';
      }
    }
  }

  if (!args.outDir) throw new Error('--out-dir is required in verify mode');
  fs.mkdirSync(args.outDir, { recursive: true });
  const shotHome = path.join(args.outDir, 'homepage-tarkov.png');
  const home = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(shotHome, Buffer.from(home.data, 'base64'));
  result.screenshots.push(Object.assign({ file: shotHome, kind: 'homepage' }, pngInfo(shotHome)));

  const openPanel = await evaluate(send, "(function(){ var fab = document.getElementById('zb-fab'); var panel = document.getElementById('zb-panel'); if (!fab || !panel) return { opened: false, reason: 'fab or panel missing' }; fab.click(); return { opened: true }; })()");
  result.screenshotAnalysis = result.screenshotAnalysis || [];
  try {
    const homeAnalysis = analyzePng(shotHome);
    result.screenshotAnalysis.push(homeAnalysis);
    result.assertions.push({
      id: 'screenshot.homepage-not-blank',
      expected: 'distinct sampled colors > 200 and mean channel > 10 (a failed/occluded capture is uniform or black)',
      observed: { distinctColors: homeAnalysis.distinctColors, avgRgb: homeAnalysis.avgRgb, nearBlackPixels: homeAnalysis.nearBlackPixels, sampled: homeAnalysis.sampled },
      pass: homeAnalysis.distinctColors > 200 && (homeAnalysis.avgRgb[0] + homeAnalysis.avgRgb[1] + homeAnalysis.avgRgb[2]) > 30
    });
    result.assertions.push({
      id: 'screenshot.homepage-tarkov-colors-painted',
      expected: 'sampled pixels near the Tarkov accent #e07930 and near the painted band rgb(160,86,35)',
      observed: { accentPixels: homeAnalysis.accentPixels, bandPixels: homeAnalysis.bandPixels, deepSurfacePixels: homeAnalysis.deepSurfacePixels },
      pass: (homeAnalysis.accentPixels + homeAnalysis.bandPixels) > 200 && homeAnalysis.deepSurfacePixels > 200
    });
  } catch (err) {
    result.assertions.push({ id: 'screenshot.homepage-not-blank', expected: 'analyzable PNG', observed: String(err.message || err), pass: false });
  }
  await sleep(900);
  const panelState = await evaluate(send, "(function(){ var panel = document.getElementById('zb-panel'); var sel = document.getElementById('zb-theme'); var pr = panel ? panel.getBoundingClientRect() : null; var sr = sel ? sel.getBoundingClientRect() : null; return { panelHidden: panel ? panel.hasAttribute('hidden') : null, panelRect: pr ? [pr.x, pr.y, pr.width, pr.height] : null, selectVisible: !!(sr && sr.width > 0 && sr.height > 0), selectRect: sr ? [sr.x, sr.y, sr.width, sr.height] : null, selectValue: sel ? sel.value : null }; })()");
  result.panel = Object.assign({ openAttempt: openPanel }, panelState);
  if (panelState.selectVisible) {
    const shotPanel = path.join(args.outDir, 'panel-theme-selector.png');
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(shotPanel, Buffer.from(shot.data, 'base64'));
    result.screenshots.push(Object.assign({ file: shotPanel, kind: 'panel' }, pngInfo(shotPanel)));
    try {
      const panelAnalysis = analyzePng(shotPanel);
      result.screenshotAnalysis.push(panelAnalysis);
      result.assertions.push({
        id: 'screenshot.panel-not-blank',
        expected: 'distinct sampled colors > 200 and mean channel > 10',
        observed: { distinctColors: panelAnalysis.distinctColors, avgRgb: panelAnalysis.avgRgb, sampled: panelAnalysis.sampled },
        pass: panelAnalysis.distinctColors > 200 && (panelAnalysis.avgRgb[0] + panelAnalysis.avgRgb[1] + panelAnalysis.avgRgb[2]) > 30
      });
      result.assertions.push({
        id: 'screenshot.panel-tarkov-colors-painted',
        expected: 'sampled pixels near the Tarkov accent #e07930',
        observed: { accentPixels: panelAnalysis.accentPixels, deepSurfacePixels: panelAnalysis.deepSurfacePixels },
        pass: panelAnalysis.accentPixels > 50
      });
    } catch (err) {
      result.assertions.push({ id: 'screenshot.panel-not-blank', expected: 'analyzable PNG', observed: String(err.message || err), pass: false });
    }
  } else {
    result.screenshots.push({ file: null, kind: 'panel', skipped: 'theme selector not visible' });
  }
  result.assertions.push({
    id: 'panel.opened-and-select-visible',
    expected: 'panel opens on #zb-fab click and #zb-theme is visible',
    observed: panelState,
    pass: panelState.panelHidden === false && panelState.selectVisible === true
  });

  try { ws.close(); } catch (e) {}

  const failed = result.assertions.filter((a) => !a.pass);
  result.summary = { total: result.assertions.length, passed: result.assertions.length - failed.length, failed: failed.length };

  if (args.evidence) fs.writeFileSync(args.evidence, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ summary: result.summary, failed: failed.map((f) => f.id) }));
  return failed.length === 0 ? 0 : 1;
}

main().then((code) => { process.exitCode = code; }).catch((err) => {
  console.error(JSON.stringify({ error: String((err && err.message) ? err.message : err) }));
  process.exit(2);
});
