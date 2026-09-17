#!/usr/bin/env node
/**
 * verify-v02.mjs - renderer + host-API acceptance harness for the v0.2 client.
 *
 * Renderer half of tools/verify-v02.ps1. The driver launches an isolated ZCode
 * instance with a credential-copied scratch home and starts the repository's
 * own `serve` in front of it; this script then proves, over CDP and over the
 * real HTTP API, that the injected client is present, idempotent, torn down
 * cleanly, that the banner reservation obeys its layout contract in all three
 * modes, that the media library streams byte ranges, that the dock, the pet
 * and the settings centre behave, that a custom palette reaches every accent
 * surface and that an uncustomised install still renders with no inline
 * override left behind, that the editable greeting text and its escaping
 * round-trip, and it captures the screenshots the README embeds.
 *
 * Modes:
 *   --mode verify  (default) run every check, capture the screenshots, write
 *                  the evidence JSON (checks, observations, screenshots)
 *   --mode close   close the browser through its own CDP browser endpoint
 *                  (Browser.close), never by image-name kill
 *
 * Requirements: Node >= 22 with global fetch/WebSocket (Node 24 here). No
 * dependencies, nothing is installed.
 *
 * Safety:
 *   - the scratch tree must be under TEMP and outside this repository;
 *   - screenshots may only be written below <repo>/docs/images;
 *   - the evidence JSON may only be written inside the scratch tree;
 *   - tokens are read from the live boot object, used in memory, and never
 *     written to the evidence file or printed: the page-side secret scan
 *     reports pattern names and counts only.
 *
 * Exit codes: 0 all checks passed, 1 at least one check failed, 2 refused
 * (bad arguments, unreachable instance, a path outside the allowed roots).
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { browserPid, psWindow } from './measure-layout.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const DEFAULT_WIDTH = 1440;
const DEFAULT_HEIGHT = 900;

// These names exist only so a capture can never publish the owner's private
// project list: the copied setting.json history is blanked by the driver, and
// this is the check that proves the renderer really is showing no trace of it.
// The list is deliberately short - it is a tripwire for the known leak, not a
// general content filter.
const PRIVATE_PROJECT_NAMES = ['CompanionLab', 'BakaronLab', 'Cerebro-WebAccess', 'oplus-super-save-guard'];

function parseArgs(argv) {
  const out = {
    mode: 'verify', port: 0, apiPort: 0, outDir: '', evidence: '', scratch: '', dataDir: '',
    width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT, accent: '', background: '', fullHeight: 0, compactHeight: 0,
    timeoutMs: 90000, repo: REPO, help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => { i += 1; if (i >= argv.length) throw new Error('missing value for ' + a); return argv[i]; };
    if (a === '--mode') out.mode = String(next());
    else if (a === '--port') out.port = Number(next());
    else if (a === '--api-port') out.apiPort = Number(next());
    else if (a === '--out-dir') out.outDir = String(next());
    else if (a === '--evidence') out.evidence = String(next());
    else if (a === '--scratch') out.scratch = String(next());
    else if (a === '--data-dir') out.dataDir = String(next());
    else if (a === '--width') out.width = Number(next());
    else if (a === '--height') out.height = Number(next());
    else if (a === '--accent') out.accent = String(next());
    else if (a === '--background') out.background = String(next());
    else if (a === '--full-height') out.fullHeight = Number(next());
    else if (a === '--compact-height') out.compactHeight = Number(next());
    else if (a === '--timeout-ms') out.timeoutMs = Number(next());
    else if (a === '--repo') out.repo = String(next());
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error('unknown argument: ' + a);
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isUnder(candidate, root) {
  const p = path.resolve(candidate).toLowerCase();
  const r = path.resolve(root).toLowerCase().replace(/[\\/]+$/, '');
  return p === r || p.startsWith(r + path.sep);
}

function tempRoot() {
  return path.resolve(process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp');
}

// The scratch tree and the evidence file are the only places this script may
// write outside the repository; screenshots are the only place it may write
// inside it. Both are enforced here rather than trusted from the caller.
function pathProblem(file, label, allowedRoot) {
  if (!file) return label + ' was not given';
  const p = path.resolve(file);
  if (!isUnder(p, allowedRoot)) return label + ' ' + p + ' is not under ' + path.resolve(allowedRoot);
  return null;
}

// ------------------------------------------------------------------- HTTP --
async function httpRaw(url, options = {}) {
  const headers = Object.assign({}, options.headers || {});
  if (options.token) headers['x-zb-token'] = options.token;
  if (options.range !== undefined) headers['Range'] = options.range;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), options.timeoutMs || 8000);
  try {
    const init = { method: options.method || 'GET', headers: headers, signal: ctl.signal };
    if (options.body !== undefined) init.body = options.body;
    const res = await fetch(url, init);
    let body = Buffer.alloc(0);
    if ((options.method || 'GET') !== 'HEAD') body = Buffer.from(await res.arrayBuffer());
    const h = {};
    res.headers.forEach((value, key) => { h[String(key).toLowerCase()] = value; });
    return { status: res.status, headers: h, body: body, text: body.toString('utf8') };
  } finally {
    clearTimeout(t);
  }
}

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

// -------------------------------------------------------------------- CDP --
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
  if (res.exceptionDetails) throw new Error('Runtime.evaluate threw: ' + JSON.stringify(res.exceptionDetails).slice(0, 400));
  return res.result ? res.result.value : undefined;
}

function pickPageTarget(targets) {
  const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  const notDevtools = pages.filter((t) => String(t.url || '').indexOf('devtools://') !== 0);
  const preferred = notDevtools.find((t) => /zcode/i.test(t.title || '')) || notDevtools[0] || pages[0];
  return { pages: pages, preferred: preferred };
}

// ------------------------------------------------------------------- PNG ---
function pngInfo(file) {
  try {
    const buf = fs.readFileSync(file);
    if (buf.length > 24 && buf.toString('ascii', 1, 4) === 'PNG') {
      return { bytes: buf.length, width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    return { bytes: buf.length, width: null, height: null };
  } catch (err) {
    return { bytes: null, error: String((err && err.message) ? err.message : err) };
  }
}

// Minimal dependency-free PNG decode (8-bit, non-interlaced RGB/RGBA) plus a
// coarse histogram, enough to prove a capture is not blank and not a single
// flat colour. No image library is installed, and a failed capture must be
// visible in the evidence rather than silently shipped as a screenshot.
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
  if (!ihdr || ihdr.bitDepth !== 8 || ihdr.interlace !== 0) throw new Error('unsupported PNG');
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
  let count = 0; let sr = 0; let sg = 0; let sb = 0; let nearBlack = 0;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = y * stride + x * channels;
      const r = data[i]; const g = data[i + 1]; const b = data[i + 2];
      count += 1; sr += r; sg += g; sb += b;
      colors.add((r << 16) | (g << 8) | b);
      if (r < 12 && g < 12 && b < 12) nearBlack += 1;
    }
  }
  return {
    width: width, height: height, sampled: count, distinctColors: colors.size,
    avgRgb: [Math.round(sr / count), Math.round(sg / count), Math.round(sb / count)],
    nearBlackFraction: Math.round((nearBlack / count) * 1000) / 1000,
  };
}

// ------------------------------------------------------- page-side probing --
// The deny list is assembled host-side: token-like patterns are matched
// page-side, and the matched text is never returned - only the pattern name
// and a count, so evidence can never become a secret leak.
function denyList() {
  const list = [];
  const home = process.env.USERPROFILE || '';
  const appdata = process.env.APPDATA || '';
  if (home) list.push(home);
  if (appdata) list.push(appdata);
  // Chrome profile roots of the running machine, in case one leaks into a path.
  if (home) list.push(path.join(home, 'AppData'));
  return list.filter((s) => s && s.length > 4);
}

function privacyList() {
  return PRIVATE_PROJECT_NAMES.slice();
}

function snapshotExpression(deny, privateNames) {
  return `(function(){
  var DENY = ${JSON.stringify(deny)};
  var PRIVATE = ${JSON.stringify(privateNames)};
  var out = { at: Date.now() };
  function num(v) { var n = parseFloat(v); return isNaN(n) ? null : Math.round(n * 100) / 100; }
  function rect(el) {
    if (!el) return null;
    var r = el.getBoundingClientRect();
    return { x: num(r.x), y: num(r.y), w: num(r.width), h: num(r.height), top: num(r.top), bottom: num(r.bottom), left: num(r.left), right: num(r.right) };
  }
  function q(sel) { return document.querySelectorAll(sel).length; }
  function vis(el) {
    if (!el || el.nodeType !== 1) return false;
    var c = getComputedStyle(el);
    if (c.display === 'none' || c.visibility === 'hidden' || parseFloat(c.opacity) === 0) return false;
    return true;
  }
  function leafText(sel) { var el = document.querySelector(sel); return el ? String(el.textContent || '') : null; }
  var de = document.documentElement;
  var cs = getComputedStyle(de);
  out.viewport = { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio };
  out.readyState = document.readyState;
  out.title = document.title;
  out.htmlClasses = de.className;
  out.bodyClasses = document.body ? document.body.className : '';
  out.ids = {
    uiRoot: q('#zct-ui-root'),
    uiStyle: q('#zct-ui-style'),
    dockFab: q('#zct-dock-fab'),
    dock: q('#zct-dock'),
    panelFab: q('#zct-panel-fab'),
    panel: q('#zct-panel'),
    pet: q('#zct-pet'),
    petMenu: q('#zct-pet-menu'),
    banner: q('#zcode-tarkov-banner'),
    bannerStyle: q('#zcode-tarkov-banner-style'),
    v1Panel: q('#zcode-beautify-panel-root'),
    v1Style: q('#zcode-beautify-style'),
    statusStyle: q('#zct-status-style'),
    toast: q('#zct-toast')
  };
  out.elementCount = document.getElementsByTagName('*').length;
  out.bodyChildren = document.body ? document.body.childElementCount : null;
  out.htmlBannerAttr = de.getAttribute('data-zct-banner');
  out.bannerVar = cs.getPropertyValue('--zcode-tarkov-banner-height').trim();
  out.bannerVarInline = de.style.getPropertyValue('--zcode-tarkov-banner-height');
  out.tokens = {
    colorPrimary: cs.getPropertyValue('--color-primary').trim(),
    tarkovAccent: cs.getPropertyValue('--tarkov-accent').trim(),
    colorBackground: cs.getPropertyValue('--color-background').trim(),
    colorForeground: cs.getPropertyValue('--color-foreground').trim(),
    zctAccent: cs.getPropertyValue('--zct-accent').trim()
  };
  var b = document.getElementById('zcode-tarkov-banner');
  out.banner = b ? {
    rect: rect(b),
    height: num(getComputedStyle(b).height),
    bg: getComputedStyle(b).backgroundColor,
    isBodyFirstChild: document.body ? document.body.firstElementChild === b : null,
    textLen: String(b.textContent || '').length
  } : null;
  var root = document.getElementById('root');
  out.root = root ? { rect: rect(root), marginTop: getComputedStyle(root).marginTop, height: num(getComputedStyle(root).height) } : null;
  var ed = document.querySelector('div[role="textbox"], textarea, [contenteditable="true"]');
  var composer = null;
  if (ed) {
    var walk = ed;
    for (var i = 0; i < 10 && walk && walk !== document.body; i++) {
      var cls = typeof walk.className === 'string' ? walk.className : '';
      if (/composer/i.test(cls)) composer = walk;
      walk = walk.parentElement;
    }
  }
  out.editor = ed ? { rect: rect(ed) } : null;
  out.composer = composer ? { rect: rect(composer), how: 'class' } : (ed ? { rect: rect(ed), how: 'editor-fallback' } : null);
  // The bottom-left account row, matched on its own label (never on structure
  // alone). The matched text is not returned: an account row can carry a name.
  var ACCOUNT_TEXT = [String.fromCharCode(0x8fde, 0x63a5, 0x4f7f, 0x7528), 'Connect to use', 'Sign in'];
  var all = document.querySelectorAll('body *');
  var account = null;
  for (var k = 0; k < all.length; k++) {
    var cand = all[k];
    if (cand.childElementCount > 0 || !vis(cand)) continue;
    var t = String(cand.textContent || '').trim();
    for (var m = 0; m < ACCOUNT_TEXT.length; m++) {
      if (t === ACCOUNT_TEXT[m] || (t.length < 40 && t.indexOf(ACCOUNT_TEXT[m]) >= 0)) { account = { rect: rect(cand), matchIndex: m, textLen: t.length }; break; }
    }
    if (account) break;
  }
  out.account = account;
  out.htmlScroll = { scrollHeight: de.scrollHeight, clientHeight: de.clientHeight };
  var uiRoot = document.getElementById('zct-ui-root');
  out.uiRootTheme = uiRoot ? uiRoot.getAttribute('data-zct-theme') : null;
  // The client paints a custom accent as an INLINE property on #zct-ui-root
  // (src/client/main.ts applyAccent). Both forms are recorded: the inline
  // declaration is what proves an override was set or cleared, the computed
  // value is what the UI actually resolves.
  out.uiRootAccent = uiRoot ? {
    theme: uiRoot.getAttribute('data-zct-theme'),
    inline: uiRoot.style.getPropertyValue('--zct-accent'),
    inlineSoft: uiRoot.style.getPropertyValue('--zct-accent-soft'),
    computed: getComputedStyle(uiRoot).getPropertyValue('--zct-accent').trim(),
    // The page token the injected skin derives its accent from when no inline
    // override is present. Recorded beside the computed value so the two paths
    // (stylesheet derivation and client-side override) can be told apart.
    pageToken: getComputedStyle(uiRoot).getPropertyValue('--tarkov-accent').trim()
  } : null;
  var fab = document.getElementById('zct-dock-fab');
  var dock = document.getElementById('zct-dock');
  var locked = document.getElementById('zct-dock-locked');
  out.dock = {
    fabPresent: !!fab,
    fabHidden: fab ? fab.hidden : null,
    fabRect: rect(fab),
    lockedAttr: fab ? fab.getAttribute('data-locked') : null,
    expanded: fab ? fab.getAttribute('aria-expanded') : null,
    hidden: dock ? dock.hidden : null,
    rect: rect(dock),
    title: dock ? leafText('#zct-dock-title') : null,
    sub: dock ? leafText('#zct-dock-sub') : null,
    playPresent: !!(dock && document.getElementById('zct-dock-play')),
    playDisabled: (function () { var p = document.getElementById('zct-dock-play'); return p ? p.disabled === true : null; })(),
    prevDisabled: (function () { var p = document.getElementById('zct-dock-prev'); return p ? p.disabled === true : null; })(),
    lockedNoteHidden: locked ? locked.hidden : null,
    emptyNoteHidden: (function () { var e = document.getElementById('zct-dock-empty'); return e ? e.hidden : null; })()
  };
  var pet = document.getElementById('zct-pet');
  out.pet = pet ? {
    rect: rect(pet),
    styleWidth: pet.style.width,
    hidden: pet.hidden,
    hasImage: !!pet.querySelector('img, svg')
  } : null;
  var panel = document.getElementById('zct-panel');
  // Scoped to the injected panel's own tablist: the app's Radix tab triggers
  // also carry role="tab" in the same document, and the criterion is about the
  // settings centre's five tabs only.
  var tabButtons = [].slice.call(document.querySelectorAll('#zct-panel-tabs [role="tab"]'));
  out.panel = {
    present: !!panel,
    hidden: panel ? panel.hidden : null,
    rect: rect(panel),
    offline: panel ? panel.getAttribute('data-offline') : null,
    tabs: tabButtons.map(function (b) { return { id: b.id, selected: b.getAttribute('aria-selected') === 'true', labelLen: String(b.textContent || '').length }; }),
    selectedCount: tabButtons.filter(function (b) { return b.getAttribute('aria-selected') === 'true'; }).length,
    tabCount: tabButtons.length
  };
  var rows = document.querySelectorAll('#zct-tracks .zct-track');
  out.tracks = [].slice.call(rows).map(function (r) {
    var n = r.querySelector('.zct-track-name');
    return { name: n ? String(n.textContent || '') : null, current: r.dataset.current === '1', disabled: r.dataset.disabled === '1' };
  });
  // The greeting notice: two lines drawn by the pseudo-elements of ZCode's own
  // visible greeting span, plus the badge on the paragraph itself. The raw
  // computed content is recorded next to a decoded copy, because a value with
  // an escaped quote or a backslash is only comparable after decoding.
  function cssContent(raw) {
    if (raw === null || raw === undefined) return null;
    var text = String(raw);
    if (text === 'none' || text === 'normal' || text.length < 2) return text;
    if (text.charAt(0) === '"') {
      try { return JSON.parse(text); } catch (e) { return text; }
    }
    return text;
  }
  var greetP = document.querySelector('p[data-v4-draft-greeting="true"]');
  var greetSpans = document.querySelectorAll('p[data-v4-draft-greeting="true"] > span:not([aria-hidden]):last-child');
  var greetSpan = greetSpans.length > 0 ? greetSpans[0] : null;
  var themeStyle = document.getElementById('zcode-beautify-style');
  out.greeting = {
    paragraphCount: q('p[data-v4-draft-greeting="true"]'),
    spanCount: greetSpans.length,
    beforeRaw: greetSpan ? getComputedStyle(greetSpan, '::before').content : null,
    afterRaw: greetSpan ? getComputedStyle(greetSpan, '::after').content : null,
    beforeText: greetSpan ? cssContent(getComputedStyle(greetSpan, '::before').content) : null,
    afterText: greetSpan ? cssContent(getComputedStyle(greetSpan, '::after').content) : null,
    spanText: greetSpan ? String(greetSpan.textContent || '') : null,
    spanFontSize: greetSpan ? getComputedStyle(greetSpan).fontSize : null,
    badgeContentRaw: greetP ? getComputedStyle(greetP, '::before').content : null,
    badgeColor: greetP ? getComputedStyle(greetP, '::before').color : null,
    ruleInStyle: !!(themeStyle && themeStyle.textContent && themeStyle.textContent.indexOf('data-v4-draft-greeting') >= 0),
    styleLength: themeStyle && themeStyle.textContent ? themeStyle.textContent.length : 0
  };
  out.boot = (function () {
    var boot = window.__ZCT_BOOT__;
    if (!boot || typeof boot !== 'object') return { present: false };
    var t = boot.token;
    var mt = boot.mediaToken;
    return {
      present: true,
      tokenIsNull: t === null || t === undefined,
      tokenType: typeof t,
      tokenLength: typeof t === 'string' ? t.length : null,
      mediaTokenIsNull: mt === null || mt === undefined,
      apiPort: typeof boot.apiPort === 'number' ? boot.apiPort : null,
      version: typeof boot.version === 'string' ? boot.version : null
    };
  })();
  out.client = {
    live: !!(window.__zcodeTarkov && typeof window.__zcodeTarkov.destroy === 'function'),
    cleared: window.__zcodeTarkov === null || window.__zcodeTarkov === undefined
  };
  out.secretScan = (function () {
    var text = '';
    try { text = (document.body ? document.body.innerText : '') || ''; } catch (e) { text = ''; }
    var hay = text + '\\n' + (document.title || '');
    var patterns = {
      hex32plus: /[0-9a-fA-F]{32,}/g,
      skKey: /sk-[A-Za-z0-9_-]{16,}/g,
      jwt: /eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}/g,
      bearer: /Bearer\\s+[A-Za-z0-9._-]{16,}/g
    };
    var tokenHits = {};
    var tokenTotal = 0;
    for (var name in patterns) {
      var found = hay.match(patterns[name]);
      if (found && found.length > 0) { tokenHits[name] = found.length; tokenTotal += found.length; }
    }
    // Profile-path hits are recorded but never gate a capture: the scratch tree
    // lives under TEMP, which on Windows is itself below the profile directory,
    // so a legitimate scratch path would otherwise look like a leak. The hit
    // count is evidence for a human to look at, not an automatic verdict.
    var denyHits = {};
    var denyTotal = 0;
    for (var d = 0; d < DENY.length; d++) {
      if (DENY[d] && hay.indexOf(DENY[d]) >= 0) { denyHits['path' + d] = 1; denyTotal += 1; }
    }
    // The owner's private project names must never reach a published capture.
    var projectHits = [];
    var lower = hay.toLowerCase();
    for (var pIdx = 0; pIdx < PRIVATE.length; pIdx++) {
      if (PRIVATE[pIdx] && lower.indexOf(PRIVATE[pIdx].toLowerCase()) >= 0) projectHits.push(PRIVATE[pIdx]);
    }
    return { tokenHits: tokenHits, tokenTotal: tokenTotal, denyHits: denyHits, denyTotal: denyTotal, projectHits: projectHits, textLength: text.length };
  })();
  return out;
})()`;
}

const CLICK_SEQ = (id) => `(function () {
  var el = document.getElementById(${JSON.stringify(id)});
  if (!el) return { ok: false, reason: 'missing element ' + ${JSON.stringify(id)} };
  var r = el.getBoundingClientRect();
  var x = r.left + r.width / 2;
  var y = r.top + r.height / 2;
  var o = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, view: window };
  el.dispatchEvent(new PointerEvent('pointerdown', o));
  el.dispatchEvent(new PointerEvent('pointerup', o));
  el.dispatchEvent(new MouseEvent('click', o));
  return { ok: true, x: x, y: y };
})()`;

const CONTEXTMENU_PET = `(function () {
  var el = document.getElementById('zct-pet');
  if (!el) return { ok: false, reason: 'no #zct-pet' };
  var r = el.getBoundingClientRect();
  var o = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 2, view: window };
  el.dispatchEvent(new MouseEvent('contextmenu', o));
  return { ok: true };
})()`;

const DESTROY_CLIENT = `(function () {
  var live = window.__zcodeTarkov;
  if (!live || typeof live.destroy !== 'function') return { ok: false, reason: 'no live client handle' };
  live.destroy();
  return { ok: true };
})()`;

// The controls the appearance work adds. Ids are generated per instance by
// uid(), so the probe and the drives below address them by type and order,
// scoped to the panel (and for the tab count, to the panel's own tablist: the
// document carries other Radix tabs).
const APPEARANCE_CONTROLS = `(function () {
  var selected = document.querySelector('#zct-panel-tabs [role="tab"][aria-selected="true"]');
  var colors = [].slice.call(document.querySelectorAll('#zct-panel input[type="color"]'));
  var texts = [].slice.call(document.querySelectorAll('#zct-panel input[type="text"]'));
  return {
    selectedTab: selected ? selected.id : null,
    scopedTabCount: document.querySelectorAll('#zct-panel-tabs [role="tab"]').length,
    documentTabCount: document.querySelectorAll('[role="tab"]').length,
    colorCount: colors.length,
    colorIds: colors.map(function (el) { return el.id; }),
    colorValues: colors.map(function (el) { return el.value; }),
    textCount: texts.length,
    textIds: texts.map(function (el) { return el.id; }),
    textValues: texts.map(function (el) { return el.value; })
  };
})()`;

// What the panel's own colour controls hold and display right now: the values
// a user would see, which is how the client's applied prefs can be read back
// without reaching into the client.
const PANEL_COLOR_STATE = `(function () {
  return [].slice.call(document.querySelectorAll('#zct-panel input[type="color"]')).map(function (el) {
    var row = el.parentElement;
    var readout = row ? row.querySelector('.zct-value') : null;
    return { id: el.id, value: el.value, readout: readout ? String(readout.textContent || '') : null };
  });
})()`;

// Drives one control the way a user edit does: set the value, then dispatch the
// input and change events the control listens for. Neither the panel's handler
// nor the client's internal API is called directly, so what is proven is the
// wiring a real edit travels through.
function driveInputExpression(type, index, value) {
  const selector = '#zct-panel input[type=' + JSON.stringify(type) + ']';
  return `(function () {
  var els = document.querySelectorAll(${JSON.stringify(selector)});
  if (els.length <= ${index}) return { ok: false, reason: 'expected at least ' + ${index + 1} + ' ' + ${JSON.stringify(type)} + ' controls, found ' + els.length };
  var el = els[${index}];
  el.value = ${JSON.stringify(value)};
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, id: el.id, value: el.value };
})()`;
}

// ------------------------------------------------------------------ checks --
function makeChecks() {
  const checks = [];
  return {
    checks: checks,
    add(name, expectation, observed, pass) {
      const ok = pass === true;
      checks.push({ name: name, expectation: expectation, observed: observed, pass: ok, status: ok ? 'pass' : 'fail' });
      return ok;
    },
    notTested(name, expectation, observed, reason) {
      checks.push({ name: name, expectation: expectation, observed: observed, pass: false, status: 'not-tested', reason: reason });
    },
    summary() {
      const passed = checks.filter((c) => c.status === 'pass').length;
      const failed = checks.filter((c) => c.status === 'fail').length;
      const notTested = checks.filter((c) => c.status === 'not-tested').length;
      return { passed: passed, failed: failed, notTested: notTested, total: checks.length };
    },
  };
}

// ------------------------------------------------------------------- main ---
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log('see the header of this file'); return 0; }
  const repo = path.resolve(args.repo || REPO);

  if (args.mode === 'close') return await runClose(args);

  const problems = [];
  let problem = pathProblem(args.scratch, '--scratch', tempRoot());
  if (problem) problems.push(problem);
  if (args.scratch && isUnder(args.scratch, repo)) problems.push('--scratch is inside the repository: ' + path.resolve(args.scratch));
  problem = pathProblem(args.evidence, '--evidence', args.scratch ? path.resolve(args.scratch) : tempRoot());
  if (problem) problems.push(problem);
  problem = pathProblem(args.outDir, '--out-dir', path.join(repo, 'docs', 'images'));
  if (problem) problems.push(problem);
  if (!Number.isFinite(args.port) || args.port <= 0) problems.push('--port is required');
  if (!Number.isFinite(args.apiPort) || args.apiPort <= 0) problems.push('--api-port is required');
  if (problems.length > 0) {
    for (const p of problems) console.error('REFUSED: ' + p);
    return 2;
  }

  const base = 'http://127.0.0.1:' + args.port;
  const api = 'http://127.0.0.1:' + args.apiPort;
  const evidence = { tool: 'tools/verify-v02.mjs', version: 1, startedAt: new Date().toISOString(), mode: 'verify' };

  const version = await httpJson(base + '/json/version').catch(() => null);
  if (!version) throw new Error('no CDP endpoint on port ' + args.port);
  evidence.zcodeVersion = { browser: version.Browser, userAgent: version['User-Agent'], protocol: version['Protocol-Version'] };

  let targets = [];
  let picked = { pages: [], preferred: null };
  const targetDeadline = Date.now() + args.timeoutMs;
  while (Date.now() < targetDeadline) {
    targets = await httpJson(base + '/json/list').catch(() => []);
    picked = pickPageTarget(targets);
    if (picked.preferred) break;
    await sleep(500);
  }
  if (!picked.preferred) throw new Error('no page target with a webSocketDebuggerUrl after ' + args.timeoutMs + 'ms');
  evidence.pageTarget = { id: picked.preferred.id, title: picked.preferred.title, url: picked.preferred.url };
  evidence.targets = targets.map((t) => ({ id: t.id, type: t.type, title: t.title }));

  const ws = await connect(picked.preferred.webSocketDebuggerUrl);
  const send = makeSender(ws);
  // Renderer console/exception capture: bounded, and it is the only way to see
  // why an injected script did not mount (the service ignores the exception
  // details of its own Runtime.evaluate calls).
  const consoleEvents = [];
  ws.addEventListener('message', (ev) => {
    let msg = null;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const p = msg.params || {};
      const parts = (p.args || []).map((a) => (typeof a.value === 'string' ? a.value : typeof a.value === 'number' ? String(a.value) : ''));
      consoleEvents.push({ type: String(p.type || 'log'), text: parts.join(' ').slice(0, 300), at: Date.now() });
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = (msg.params || {}).exceptionDetails || {};
      const text = String(d.text || (d.exception && d.exception.description) || '');
      consoleEvents.push({ type: 'exception', text: text.slice(0, 300), at: Date.now() });
    }
    if (consoleEvents.length > 80) consoleEvents.splice(0, consoleEvents.length - 80);
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.bringToFront');

  const checks = makeChecks();
  const notes = [];
  const snapshots = {};
  const screenshots = [];

  const snapExpr = snapshotExpression(denyList(), privacyList());
  // A host-side escaping mistake in the page-side source would otherwise look
  // like "the client never appeared"; compiling it here names the real fault.
  for (const [label, expr] of [['snapshot', snapExpr], ['destroy', DESTROY_CLIENT], ['contextmenu', CONTEXTMENU_PET], ['click', CLICK_SEQ('zct-ui-root')], ['appearance-controls', APPEARANCE_CONTROLS], ['panel-colors', PANEL_COLOR_STATE], ['drive-color', driveInputExpression('color', 0, '#123456')], ['drive-text', driveInputExpression('text', 0, 'x')]]) {
    try { new Function(expr); } catch (err) { throw new Error('internal: the ' + label + ' page expression does not compile: ' + String((err && err.message) ? err.message : err)); }
  }
  const snap = async () => evaluate(send, snapExpr);

  // Polls the live renderer until a predicate holds. Returns the last snapshot
  // either way, so a timeout is recorded as an observation rather than thrown.
  async function waitForSnapshot(predicate, timeoutMs = 10000) {
    const start = Date.now();
    let last = null;
    let lastError = null;
    while (Date.now() - start < timeoutMs) {
      try { last = await snap(); } catch (err) { lastError = String((err && err.message) ? err.message : err); last = null; }
      if (last && predicate(last)) return { waitedMs: Date.now() - start, snapshot: last, timedOut: false };
      await sleep(250);
    }
    return { waitedMs: Date.now() - start, snapshot: last, lastError: lastError, timedOut: true };
  }

  const normColor = (v) => {
    const rgb = parseColor(v);
    if (!rgb) return String(v || '').trim().toLowerCase();
    const hex = (n) => Math.min(255, Math.max(0, Math.round(n))).toString(16).padStart(2, '0');
    return '#' + hex(rgb.r) + hex(rgb.g) + hex(rgb.b);
  };

  // Wait for the renderer to be a real chat surface, then for the injected
  // client. Both are asynchronous: the service injects on its own poll tick.
  const readyDeadline = Date.now() + args.timeoutMs;
  let ready = false;
  while (Date.now() < readyDeadline) {
    try {
      const s = await evaluate(send, '({ root: !!document.getElementById("root"), children: document.getElementById("root") ? document.getElementById("root").childElementCount : 0 })');
      if (s && s.root && s.children > 0) { ready = true; break; }
    } catch (err) { /* still navigating */ }
    await sleep(750);
  }
  evidence.rendererReady = ready;
  const injectDeadline = Date.now() + args.timeoutMs;
  let injected = null;
  let injectWaitedMs = 0;
  let injectLast = null;
  let injectLastError = null;
  const injectStart = Date.now();
  while (Date.now() < injectDeadline) {
    let cur = null;
    try { cur = await snap(); } catch (err) { injectLastError = String((err && err.message) ? err.message : err); cur = null; }
    injectLast = cur || injectLast;
    if (cur && cur.ids.uiRoot === 1 && cur.ids.uiStyle === 1 && cur.ids.dockFab === 1 && cur.ids.panelFab === 1 && cur.ids.pet === 1) { injected = cur; break; }
    await sleep(500);
  }
  injectWaitedMs = Date.now() - injectStart;
  evidence.injection = {
    appeared: !!injected,
    waitedMs: injectWaitedMs,
    lastError: injectLastError,
    lastIds: injectLast ? injectLast.ids : null,
    lastBoot: injectLast ? injectLast.boot : null,
    lastClient: injectLast ? injectLast.client : null,
    rendererConsole: consoleEvents.slice(-30),
  };
  if (!injected) {
    // The service evaluates the client script and never looks at the result, so
    // re-evaluating the same bundle here is the only way to record the actual
    // error. The result is evidence, not a repair: the checks below do not run.
    try {
      const boot = await evaluate(send, 'window.__ZCT_BOOT__ ? { apiPort: window.__ZCT_BOOT__.apiPort, token: window.__ZCT_BOOT__.token, mediaToken: window.__ZCT_BOOT__.mediaToken, version: window.__ZCT_BOOT__.version } : null');
      const bundle = fs.readFileSync(path.join(repo, 'dist', 'client.js'), 'utf8');
      const probe = await send('Runtime.evaluate', {
        expression: 'window.__ZCT_BOOT__ = ' + JSON.stringify(boot) + ';\n' + bundle,
        returnByValue: true,
        awaitPromise: false,
      });
      evidence.injection.reevaluate = probe.exceptionDetails
        ? { threw: true, details: String(probe.exceptionDetails.text || '') + ' ' + String((probe.exceptionDetails.exception && probe.exceptionDetails.exception.description) || '').slice(0, 600) }
        : { threw: false };
      await sleep(700);
      const after = await snap().catch(() => null);
      evidence.injection.afterReevaluate = after ? { ids: after.ids, client: after.client } : null;
    } catch (err) {
      evidence.injection.reevaluate = { threw: true, details: 'diagnostic evaluate failed: ' + String((err && err.message) ? err.message : err) };
    }
    evidence.checks = checks.checks;
    evidence.summary = checks.summary();
    evidence.failures = ['the injected client never appeared within ' + args.timeoutMs + 'ms'];
    fs.writeFileSync(args.evidence, JSON.stringify(evidence, null, 2));
    try { ws.close(); } catch (e) {}
    console.error('INJECTION TIMEOUT: ' + JSON.stringify({ lastIds: evidence.injection.lastIds, console: evidence.injection.rendererConsole.slice(-6), reevaluate: evidence.injection.reevaluate }));
    return 2;
  }

  // The boot object carries this run's tokens. They stay in memory; only the
  // shape of the object is ever recorded.
  const boot = await evaluate(send, '(function(){ var b = window.__ZCT_BOOT__; return b ? { apiPort: b.apiPort, token: b.token, mediaToken: b.mediaToken, version: b.version } : null; })()');
  const token = boot && typeof boot.token === 'string' ? boot.token : '';
  const apiPort = boot && typeof boot.apiPort === 'number' ? boot.apiPort : args.apiPort;
  evidence.apiPort = apiPort;
  evidence.pluginVersion = boot ? boot.version : null;
  evidence.accentExpected = args.accent;
  if (!token) {
    evidence.checks = checks.checks;
    evidence.summary = checks.summary();
    evidence.failures = ['the renderer holds no API token; the service did not inject a usable boot object'];
    fs.writeFileSync(args.evidence, JSON.stringify(evidence, null, 2));
    try { ws.close(); } catch (e) {}
    return 2;
  }

  const apiFetch = (p, o = {}) => httpRaw(api + p, Object.assign({ token: token }, o));
  const apiGetJson = async (p) => {
    const r = await apiFetch(p);
    let json = null;
    try { json = JSON.parse(r.text); } catch (e) { json = null; }
    return { status: r.status, headers: r.headers, json: json, text: r.text };
  };

  // ---------------------------------------------------------- viewport -----
  const viewportAttempts = [];
  let viewportChosen = null;
  async function applyViewport(width, height) {
    viewportAttempts.length = 0;
    const pid = await browserPid(base).catch(() => 0);
    if (pid) {
      const info = await psWindow(pid, 'query');
      if (info && info.found) {
        await psWindow(pid, 'raise');
        const visDeadline = Date.now() + 8000;
        while (Date.now() < visDeadline) {
          const st = await evaluate(send, '({vis: document.visibilityState})').catch(() => null);
          if (st && st.vis === 'visible') break;
          await sleep(300);
        }
        const before = await evaluate(send, '({w: innerWidth, h: innerHeight, rw: document.documentElement.getBoundingClientRect().width, rh: document.documentElement.getBoundingClientRect().height, dpr: devicePixelRatio})');
        const dpr = before.dpr || 1;
        const frameW = info.window[2] - info.client[2];
        const frameH = info.window[3] - info.client[3];
        let targetW = Math.round(width * dpr + frameW);
        let targetH = Math.round(height * dpr + frameH);
        let measured = before;
        for (let attempt = 0; attempt < 4; attempt += 1) {
          await psWindow(pid, 'set', targetW, targetH);
          await sleep(350);
          measured = await evaluate(send, '({w: innerWidth, h: innerHeight, rw: document.documentElement.getBoundingClientRect().width, rh: document.documentElement.getBoundingClientRect().height, dpr: devicePixelRatio})');
          viewportAttempts.push({ method: 'SetWindowPos', targetW: targetW, targetH: targetH, measured: measured });
          if (Math.abs(measured.rw - width) <= 0.3 && Math.abs(measured.rh - height) <= 0.3) break;
          targetW += Math.round((width - measured.rw) * dpr);
          targetH += Math.round((height - measured.rh) * dpr);
        }
        if (Math.abs(measured.rw - width) <= 0.3 && Math.abs(measured.rh - height) <= 0.3) {
          viewportChosen = { method: 'SetWindowPos', real: true, innerWidth: measured.w, innerHeight: measured.h, cssWidth: measured.rw, cssHeight: measured.rh };
          return viewportChosen;
        }
      } else {
        viewportAttempts.push({ method: 'SetWindowPos', error: 'no main window for browser pid ' + pid });
      }
    } else {
      viewportAttempts.push({ method: 'SetWindowPos', error: 'no browser pid reported by CDP' });
    }
    try {
      const bws = await httpJson(base + '/json/version');
      const bconn = await connect(bws.webSocketDebuggerUrl);
      const bsend = makeSender(bconn);
      const win = await bsend('Browser.getWindowForTarget', { targetId: picked.preferred.id });
      await bsend('Browser.setWindowBounds', { windowId: win.windowId, bounds: { windowState: 'normal', width: Math.round(width), height: Math.round(height) } });
      await sleep(400);
      const after = await evaluate(send, '({w: innerWidth, h: innerHeight, dpr: devicePixelRatio})');
      viewportAttempts.push({ method: 'Browser.setWindowBounds', measured: after });
      try { bconn.close(); } catch (e) {}
      if (Math.abs(after.w - width) <= 1 && Math.abs(after.h - height) <= 1) {
        viewportChosen = { method: 'Browser.setWindowBounds', real: true, innerWidth: after.w, innerHeight: after.h };
        return viewportChosen;
      }
    } catch (err) {
      viewportAttempts.push({ method: 'Browser.setWindowBounds', error: String((err && err.message) ? err.message : err) });
    }
    await send('Emulation.setDeviceMetricsOverride', { width: Math.round(width), height: Math.round(height), deviceScaleFactor: 0, mobile: false });
    await sleep(300);
    const emu = await evaluate(send, '({w: innerWidth, h: innerHeight})');
    viewportAttempts.push({ method: 'Emulation.setDeviceMetricsOverride', measured: emu });
    viewportChosen = { method: 'Emulation.setDeviceMetricsOverride', real: false, emulated: true, innerWidth: emu.w, innerHeight: emu.h };
    return viewportChosen;
  }
  async function clearEmulation() {
    try { await send('Emulation.clearDeviceMetricsOverride'); } catch (e) { /* nothing applied */ }
    await sleep(300);
  }

  const vp = await applyViewport(args.width, args.height);
  evidence.viewport = { requested: { width: args.width, height: args.height }, chosen: vp, attempts: viewportAttempts };
  checks.add('E.viewport-fixed', 'the renderer viewport is ' + args.width + ' x ' + args.height + ' CSS px', { method: vp.method, innerWidth: vp.innerWidth, innerHeight: vp.innerHeight }, Math.abs(vp.innerWidth - args.width) <= 1 && Math.abs(vp.innerHeight - args.height) <= 1);

  // -------------------------------------------------------- phase A --------
  // The greeting element mounts with the empty-chat screen a moment after the
  // client does. Waiting for it here is what lets the shipped text observed in
  // this snapshot be the reference the later restore check compares against,
  // instead of hard-coding copy the harness does not own. A timeout is not
  // fatal: the greeting checks then report NOT TESTED with that reason.
  const startSnap = await waitForSnapshot((st) => !!(st.greeting && st.greeting.spanText), 8000);
  let s = startSnap.snapshot || (await snap());
  snapshots.initial = s;
  const greetingAtStart = s.greeting || null;
  checks.add('privacy.no-private-project-names', 'no known private project name is visible anywhere in the renderer', { matched: s.secretScan.projectHits, denylistSize: PRIVATE_PROJECT_NAMES.length, scannedChars: s.secretScan.textLength }, s.secretScan.projectHits.length === 0);
  const EXPECT_ACCENT = (args.accent || '#ee8a3a').toLowerCase();
  const norm = (v) => String(v || '').trim().toLowerCase();

  checks.add('A1.ui-root-exactly-once', '#zct-ui-root exists exactly once', s.ids.uiRoot, s.ids.uiRoot === 1);
  checks.add('A1.ui-style-exactly-once', '#zct-ui-style exists exactly once', s.ids.uiStyle, s.ids.uiStyle === 1);
  checks.add('A2.banner-attribute', 'html[data-zct-banner="1"] in Tarkov/full mode', s.htmlBannerAttr, s.htmlBannerAttr === '1');
  checks.add('A2.banner-element', '#zcode-tarkov-banner exists exactly once in Tarkov/full mode', s.ids.banner, s.ids.banner === 1);
  checks.add('A3.banner-var-full', '--zcode-tarkov-banner-height resolves to ' + (args.fullHeight || 56) + 'px in full mode', s.bannerVar, s.bannerVar === (args.fullHeight || 56) + 'px');
  checks.add('A6.color-primary-accent', 'computed --color-primary is ' + EXPECT_ACCENT, s.tokens.colorPrimary, norm(s.tokens.colorPrimary) === EXPECT_ACCENT);
  checks.add('A6.tarkov-accent-token', 'computed --tarkov-accent is ' + EXPECT_ACCENT, s.tokens.tarkovAccent, norm(s.tokens.tarkovAccent) === EXPECT_ACCENT);
  checks.add('A6.banner-band-background', 'the banner band background-color is rgba(238, 138, 58, ...)', s.banner ? s.banner.bg : 'no band', !!s.banner && norm(s.banner.bg).indexOf('rgba(238, 138, 58') === 0);

  // -------------------------------------------------------- phase A4 -------
  async function setBannerMode(mode) {
    const r = await apiFetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ banner: { mode: mode } }) });
    let json = null;
    try { json = JSON.parse(r.text); } catch (e) { json = null; }
    const wantAbsent = mode === 'off';
    const wantVar = mode === 'off' ? '0px' : mode === 'compact' ? (args.compactHeight || 28) + 'px' : (args.fullHeight || 56) + 'px';
    const start = Date.now();
    let last = null;
    while (Date.now() - start < 8000) {
      last = await snap();
      const bannerOk = wantAbsent ? last.ids.banner === 0 && last.htmlBannerAttr === null : last.ids.banner === 1 && last.htmlBannerAttr === '1';
      if (bannerOk && last.bannerVar === wantVar) break;
      await sleep(250);
    }
    return { status: r.status, body: json, waitedMs: Date.now() - start, snapshot: last };
  }

  // `prefix` and `context` let the same contract be re-asserted under a custom
  // palette without touching the default-palette checks: the names differ, the
  // expectations say why, and both runs stay in the evidence.
  function layoutChecksFor(mode, obs, prefix = 'A4', context = '') {
    const H = obs.viewport.h;
    const tag = prefix + '.' + mode;
    const varOk = mode === 'off' ? obs.bannerVar === '0px' : mode === 'compact' ? obs.bannerVar === (args.compactHeight || 28) + 'px' : obs.bannerVar === (args.fullHeight || 56) + 'px';
    checks.add(tag + '.banner-var', '--zcode-tarkov-banner-height is ' + (mode === 'off' ? '0px' : mode === 'compact' ? (args.compactHeight || 28) + 'px' : (args.fullHeight || 56) + 'px') + ' in ' + mode + ' mode' + context, { var: obs.bannerVar, inline: obs.bannerVarInline, attr: obs.htmlBannerAttr, bannerCount: obs.ids.banner }, varOk);
    checks.add(prefix === 'A4' ? 'A5.' + mode + '.banner-var-verbatim' : tag + '.banner-var-verbatim', 'the computed --zcode-tarkov-banner-height is recorded verbatim for ' + mode + ' mode' + context, obs.bannerVar, varOk);
    if (mode === 'off') {
      checks.add(tag + '.root-margin-top', '#root margin-top is 0px with the banner off' + context, obs.root ? obs.root.marginTop : 'no #root', !!obs.root && obs.root.marginTop === '0px');
      checks.add(tag + '.root-height-equals-viewport', '#root height equals the no-banner viewport height (' + H + 'px)' + context, obs.root ? { height: obs.root.height, rect: obs.root.rect, viewport: H } : 'no #root', !!obs.root && obs.root.height !== null && Math.abs(obs.root.height - H) <= 0.5);
      checks.add(tag + '.banner-var-zero', 'the computed --zcode-tarkov-banner-height is 0px with the banner off' + context, { computed: obs.bannerVar, inline: obs.bannerVarInline }, obs.bannerVar === '0px');
      checks.add(tag + '.banner-var-not-inline-pinned', 'no inline --zcode-tarkov-banner-height is left on <html> in off mode' + context + '; the 0px comes from the stylesheet rule', { inline: obs.bannerVarInline, computed: obs.bannerVar, bannerStylePresent: obs.ids.bannerStyle }, obs.bannerVarInline === '' && obs.bannerVar === '0px');
      if (obs.composer) checks.add(tag + '.composer-inside-viewport', 'the composer is fully inside the viewport with the banner off' + context, { rect: obs.composer.rect, how: obs.composer.how, viewport: H }, obs.composer.rect.top >= -0.5 && obs.composer.rect.bottom <= H + 0.5);
      else checks.notTested(tag + '.composer-inside-viewport', 'the composer is fully inside the viewport with the banner off' + context, 'no composer or editing surface found', 'this renderer exposes no composer');
      if (obs.account) checks.add(tag + '.account-inside-viewport', 'the bottom-left account area is fully inside the viewport with the banner off' + context, { rect: obs.account.rect, viewport: H }, obs.account.rect.top >= -0.5 && obs.account.rect.bottom <= H + 0.5);
      else checks.notTested(tag + '.account-inside-viewport', 'the bottom-left account area is fully inside the viewport with the banner off' + context, 'no account label found', 'this renderer has no bottom-left account row');
      checks.add(tag + '.banner-absent', 'no band element and no html[data-zct-banner] with off' + context, { bannerCount: obs.ids.banner, attr: obs.htmlBannerAttr, bannerVar: obs.bannerVar }, obs.ids.banner === 0 && obs.htmlBannerAttr === null);
    } else if (mode === 'compact') {
      const band = obs.banner ? obs.banner.rect.h : null;
      checks.add(tag + '.band-height', 'the painted band is ' + (args.compactHeight || 28) + 'px tall' + context, { bandHeight: band, var: obs.bannerVar }, band !== null && Math.abs(band - (args.compactHeight || 28)) <= 0.5);
      checks.add(tag + '.band-plus-root-equals-viewport', 'band height + #root height equals the viewport height' + context, { band: band, root: obs.root ? obs.root.height : null, viewport: H }, band !== null && !!obs.root && Math.abs(band + obs.root.height - H) <= 0.5);
      if (obs.composer) checks.add(tag + '.composer-inside-viewport', 'the composer is fully inside the viewport in compact mode' + context, { rect: obs.composer.rect, viewport: H }, obs.composer.rect.top >= -0.5 && obs.composer.rect.bottom <= H + 0.5);
      else checks.notTested(tag + '.composer-inside-viewport', 'the composer is fully inside the viewport in compact mode' + context, 'no composer found', 'this renderer exposes no composer');
      if (obs.account) checks.add(tag + '.account-inside-viewport', 'the bottom-left account area is fully inside the viewport in compact mode' + context, { rect: obs.account.rect, viewport: H }, obs.account.rect.top >= -0.5 && obs.account.rect.bottom <= H + 0.5);
      else checks.notTested(tag + '.account-inside-viewport', 'the bottom-left account area is fully inside the viewport in compact mode' + context, 'no account label found', 'this renderer has no bottom-left account row');
    } else {
      const band = obs.banner ? obs.banner.rect.h : null;
      checks.add(tag + '.band-plus-root-equals-viewport', 'band + #root equals the viewport height in full mode' + context, { band: band, root: obs.root ? obs.root.height : null, viewport: H }, band !== null && !!obs.root && Math.abs(band + obs.root.height - H) <= 0.5);
      checks.add(tag + '.band-inside-viewport', 'the full band sits at the top of the viewport (top 0, bottom ' + (args.fullHeight || 56) + ')' + context, obs.banner ? obs.banner.rect : 'no band', !!obs.banner && Math.abs(obs.banner.rect.top) <= 0.5 && Math.abs(obs.banner.rect.bottom - (args.fullHeight || 56)) <= 0.5);
      checks.add(tag + '.root-bottom-at-viewport', '|#root.bottom - viewport height| <= 0.5 in full mode' + context, obs.root ? { bottom: obs.root.rect.bottom, viewport: H } : 'no #root', !!obs.root && Math.abs(obs.root.rect.bottom - H) <= 0.5);
      if (obs.composer) checks.add(tag + '.composer-inside-viewport', 'the composer is fully inside the viewport in full mode' + context, { rect: obs.composer.rect, viewport: H }, obs.composer.rect.top >= -0.5 && obs.composer.rect.bottom <= H + 0.5);
      else checks.notTested(tag + '.composer-inside-viewport', 'the composer is fully inside the viewport in full mode' + context, 'no composer found', 'this renderer exposes no composer');
      if (obs.account) checks.add(tag + '.account-inside-viewport', 'the bottom-left account area is fully inside the viewport in full mode' + context, { rect: obs.account.rect, viewport: H }, obs.account.rect.top >= -0.5 && obs.account.rect.bottom <= H + 0.5);
      else checks.notTested(tag + '.account-inside-viewport', 'the bottom-left account area is fully inside the viewport in full mode' + context, 'no account label found', 'this renderer has no bottom-left account row');
    }
    checks.add(tag + '.no-vertical-overflow', 'html.scrollHeight <= html.clientHeight + 1 in ' + mode + ' mode' + context, { scrollHeight: obs.htmlScroll ? obs.htmlScroll.scrollHeight : null, clientHeight: obs.htmlScroll ? obs.htmlScroll.clientHeight : null }, !!obs.htmlScroll && obs.htmlScroll.scrollHeight <= obs.htmlScroll.clientHeight + 1);
    return obs;
  }

  const modes = ['off', 'compact', 'full'];
  const modeEvidence = {};
  for (const mode of modes) {
    const result = await setBannerMode(mode);
    modeEvidence[mode] = { post: { status: result.status, body: result.body }, waitedMs: result.waitedMs };
    const obs = result.snapshot || (await snap());
    snapshots['mode-' + mode] = obs;
    layoutChecksFor(mode, obs);
  }
  evidence.bannerModes = modeEvidence;

  // -------------------------------------------------------- phase B --------
  s = await snap();
  snapshots.afterModes = s;
  checks.add('B7.dock-fab-single', '#zct-dock-fab exists exactly once', s.ids.dockFab, s.ids.dockFab === 1);
  checks.add('B7.panel-fab-single', '#zct-panel-fab exists exactly once', s.ids.panelFab, s.ids.panelFab === 1);
  checks.add('B7.pet-single', '#zct-pet exists exactly once', s.ids.pet, s.ids.pet === 1);

  // Re-injection: POST /api/config with a change makes the service re-push the
  // bootstrap into this renderer. The DOM node counts must not move.
  const pushCounts = [{ label: 'before', count: s.elementCount, bodyChildren: s.bodyChildren }];
  const pushIds = [];
  for (const opacity of [0.8, 0.92]) {
    const r = await apiFetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ banner: { opacity: opacity } }) });
    pushIds.push({ opacity: opacity, status: r.status, body: safeJson(r.text) });
    await sleep(1200);
    const after = await snap();
    pushCounts.push({ label: 'after-opacity-' + opacity, count: after.elementCount, bodyChildren: after.bodyChildren, ids: after.ids });
    s = after;
  }
  snapshots.afterReinjections = s;
  const countsStable = pushCounts.every((p) => p.count === pushCounts[0].count && p.bodyChildren === pushCounts[0].bodyChildren);
  checks.add('B8.reinjection-idempotent', 'two service re-pushes do not duplicate #zct-ui-root, #zct-ui-style, #zct-dock-fab, #zct-panel-fab or #zct-pet', { pushes: pushCounts, ids: s.ids }, s.ids.uiRoot === 1 && s.ids.uiStyle === 1 && s.ids.dockFab === 1 && s.ids.panelFab === 1 && s.ids.pet === 1);
  checks.add('B8.reinjection-node-counts-constant', 'the DOM node count stays constant across two re-injections', pushCounts, countsStable);
  evidence.reinjection = { pushes: pushIds, counts: pushCounts };

  // Teardown, then the real "survives a renderer reload" check.
  const destroyed = await evaluate(send, DESTROY_CLIENT);
  await sleep(700);
  const afterDestroy = await snap();
  snapshots.afterDestroy = afterDestroy;
  const goneIds = ['uiRoot', 'uiStyle', 'dockFab', 'panelFab', 'pet'];
  const gone = {};
  for (const id of goneIds) gone[id] = afterDestroy.ids[id];
  checks.add('B9.teardown-ids-gone', 'destroy() removes #zct-ui-root, #zct-ui-style, #zct-dock-fab, #zct-panel-fab and #zct-pet', { destroyed: destroyed, ids: gone }, destroyed && destroyed.ok === true && goneIds.every((id) => gone[id] === 0));
  checks.add('B9.teardown-boot-token-null', 'window.__ZCT_BOOT__.token is null after destroy()', { boot: afterDestroy.boot, client: afterDestroy.client }, afterDestroy.boot && afterDestroy.boot.tokenIsNull === true);
  if (!(afterDestroy.boot && afterDestroy.boot.tokenIsNull === true)) {
    notes.push('the boot object still carries a token after destroy(); src/client/main.ts destroy() never clears BOOT_KEY, and src/client/boot.ts buildClientTeardownScript() (which does clear it) is referenced by no runtime path');
  }

  await send('Page.reload', { ignoreCache: false });
  await sleep(1500);
  let reloaded = null;
  const reloadStart = Date.now();
  const reloadDeadline = reloadStart + 60000;
  while (Date.now() < reloadDeadline) {
    try {
      const cur = await snap();
      if (cur.ids.uiRoot === 1 && cur.ids.dockFab === 1 && cur.ids.panelFab === 1 && cur.ids.pet === 1 && cur.client.live) { reloaded = cur; break; }
    } catch (err) { /* navigating */ }
    await sleep(750);
  }
  snapshots.afterReload = reloaded;
  checks.add('B9.reload-client-returns', 'after Page.reload the client is injected again (single copies, live handle)', reloaded ? { ids: reloaded.ids, client: reloaded.client, waitedMs: Date.now() - reloadStart } : 'client never came back', !!reloaded);

  // Theme switch: native tears the band down, tarkov brings it back.
  async function setColorMode(mode) {
    const r = await apiFetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ colorMode: mode }) });
    let json = null;
    try { json = JSON.parse(r.text); } catch (e) { json = null; }
    const wantBanner = mode === 'tarkov';
    const start = Date.now();
    let last = null;
    while (Date.now() - start < 8000) {
      last = await snap();
      const ok = wantBanner ? last.ids.banner === 1 && last.htmlBannerAttr === '1' : last.ids.banner === 0 && last.htmlBannerAttr === null;
      if (ok) break;
      await sleep(250);
    }
    return { status: r.status, body: json, waitedMs: Date.now() - start, snapshot: last };
  }
  const native = await setColorMode('native');
  const nativeSnap = native.snapshot;
  checks.add('B10.native-banner-torn-down', 'colorMode native removes #zcode-tarkov-banner and html[data-zct-banner]', { status: native.status, waitedMs: native.waitedMs, bannerCount: nativeSnap.ids.banner, attr: nativeSnap.htmlBannerAttr, bannerVar: nativeSnap.bannerVar }, nativeSnap.ids.banner === 0 && nativeSnap.htmlBannerAttr === null);
  checks.add('B10.native-no-root-duplication', 'switching to native leaves exactly one #zct-ui-root', nativeSnap.ids.uiRoot, nativeSnap.ids.uiRoot === 1);
  const tarkov = await setColorMode('tarkov');
  const tarkovSnap = tarkov.snapshot;
  checks.add('B10.tarkov-banner-returns', 'switching back to tarkov restores the band', { status: tarkov.status, waitedMs: tarkov.waitedMs, bannerCount: tarkovSnap.ids.banner, attr: tarkovSnap.htmlBannerAttr }, tarkovSnap.ids.banner === 1 && tarkovSnap.htmlBannerAttr === '1');
  checks.add('B10.tarkov-no-root-duplication', 'switching back to tarkov leaves exactly one #zct-ui-root', tarkovSnap.ids.uiRoot, tarkovSnap.ids.uiRoot === 1);
  evidence.themeSwitch = { native: { post: { status: native.status, body: native.body }, waitedMs: native.waitedMs }, tarkov: { post: { status: tarkov.status, body: tarkov.body }, waitedMs: tarkov.waitedMs } };

  // -------------------------------------------------------- phase C --------
  const fixturePath = path.join(path.resolve(args.scratch), 'harness-tone.wav');
  const fixture = writeWavFixture(fixturePath);
  evidence.fixture = fixture;
  const wavBytes = fs.readFileSync(fixturePath);
  const add = await apiFetch('/api/library/music/add?name=harness-tone.wav', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: wavBytes });
  const addJson = safeJson(add.text);
  checks.add('C12.library-add-ok', 'POST /api/library/music/add answers {ok:true}', { status: add.status, body: addJson }, add.status === 200 && !!addJson && addJson.ok === true);
  const library = await apiGetJson('/api/library/music');
  const track = library.json && Array.isArray(library.json.tracks) ? library.json.tracks.find((t) => t.filename === 'harness-tone.wav') : null;
  checks.add('C12.library-lists-fixture', 'GET /api/library/music lists harness-tone.wav with its real duration', { status: library.status, track: track, expectedDurationSeconds: fixture.expectedDurationSeconds }, !!track && typeof track.durationSeconds === 'number' && Math.abs(track.durationSeconds - fixture.expectedDurationSeconds) <= 0.05);

  const range = await httpRaw(api + '/api/media/music/harness-tone.wav', { token: token, range: 'bytes=0-99' });
  checks.add('C13.range-206', 'Range bytes=0-99 answers 206 with Content-Range bytes 0-99/<size>, Content-Length 100 and exactly 100 bytes', { status: range.status, contentRange: range.headers['content-range'], contentLength: range.headers['content-length'], bodyBytes: range.body.length, acceptRanges: range.headers['accept-ranges'] }, range.status === 206 && range.headers['content-range'] === 'bytes 0-99/' + wavBytes.length && Number(range.headers['content-length']) === 100 && range.body.length === 100);
  const full = await httpRaw(api + '/api/media/music/harness-tone.wav', { token: token });
  checks.add('C13.full-200', 'a bare GET answers 200 with the whole file', { status: full.status, bodyBytes: full.body.length, contentLength: full.headers['content-length'], expected: wavBytes.length }, full.status === 200 && full.body.length === wavBytes.length);
  const head = await httpRaw(api + '/api/media/music/harness-tone.wav', { token: token, method: 'HEAD' });
  checks.add('C13.head-empty-body', 'HEAD answers the headers with an empty body', { status: head.status, contentLength: head.headers['content-length'], bodyBytes: head.body.length, acceptRanges: head.headers['accept-ranges'] }, head.status === 200 && head.body.length === 0 && Number(head.headers['content-length']) === wavBytes.length);

  let prefsRaw = null;
  try { prefsRaw = fs.readFileSync(path.join(path.resolve(args.dataDir || args.scratch), 'prefs.json'), 'utf8'); } catch (e) { prefsRaw = null; }
  const traversal = await httpRaw(api + '/api/media/music/..%2F..%2Fprefs.json', { token: token });
  const traversalLeaked = !!prefsRaw && (traversal.text.indexOf(prefsRaw) >= 0 || traversal.text.indexOf('"colorMode"') >= 0 || traversal.text.indexOf('"appearance"') >= 0);
  checks.add('C14.traversal-refused', 'a traversal name is refused with 4xx and leaks no prefs content', { status: traversal.status, bodyBytes: traversal.body.length, prefsFileFound: !!prefsRaw, bodyLooksLikePrefs: traversalLeaked, bodyPrefix: traversal.text.slice(0, 120) }, traversal.status >= 400 && traversal.status < 500 && !traversalLeaked);
  const badType = await httpRaw(api + '/api/media/music/nope.exe', { token: token });
  checks.add('C14.bad-type-refused', 'an unservable extension is refused with 4xx', { status: badType.status, bodyPrefix: badType.text.slice(0, 120) }, badType.status >= 400 && badType.status < 500);
  const noToken = await httpRaw(api + '/api/media/music/harness-tone.wav', {});
  checks.add('C14.media-token-required', 'a media read without a token is refused', { status: noToken.status }, noToken.status >= 400 && noToken.status < 500);

  // Audio lock state and the dock, before any gesture at all.
  let lockSnap = await snap();
  snapshots.beforeGesture = lockSnap;
  const lockedBefore = lockSnap.dock.lockedAttr;
  checks.add('C16.audio-locked-before-gesture', '#zct-dock-fab reports data-locked="1" before any gesture', { lockedAttr: lockedBefore, fabHidden: lockSnap.dock.fabHidden }, lockedBefore === '1');

  // Open the dock with the synthetic pointer sequence the task specifies.
  if (lockSnap.dock.hidden === false) {
    await evaluate(send, CLICK_SEQ('zct-dock-fab'));
    await sleep(400);
    lockSnap = await snap();
  }
  const clickResult = await evaluate(send, CLICK_SEQ('zct-dock-fab'));
  let dockSnap = null;
  const dockDeadline = Date.now() + 8000;
  while (Date.now() < dockDeadline) {
    dockSnap = await snap();
    if (dockSnap.dock.hidden === false && dockSnap.dock.title === 'harness-tone') break;
    await sleep(250);
  }
  snapshots.dockOpen = dockSnap;
  checks.add('C15.dock-click-opens', 'the synthetic pointerdown/pointerup/click sequence on #zct-dock-fab opens #zct-dock', { click: clickResult, before: lockSnap.dock.hidden, after: dockSnap.dock.hidden, expanded: dockSnap.dock.expanded }, clickResult && clickResult.ok === true && dockSnap.dock.hidden === false);
  checks.add('C15.dock-title-fixture', 'the dock title shows the fixture display name', { title: dockSnap.dock.title, sub: dockSnap.dock.sub, tracks: dockSnap.tracks }, dockSnap.dock.title === 'harness-tone');
  checks.add('C15.dock-play-present', '#zct-dock-play is present', { playPresent: dockSnap.dock.playPresent, playDisabled: dockSnap.dock.playDisabled }, dockSnap.dock.playPresent === true);

  // Both gesture paths are recorded separately so a reviewer sees which one
  // actually cleared the lock. The synthetic sequence is not user activation,
  // so it is not expected to resume an AudioContext - but this Electron build
  // may run with the no-user-gesture-required autoplay policy, and the engine's
  // unlock listener fires for untrusted events too, so the observation decides.
  const fabRect = dockSnap.dock.fabRect;
  const syntheticPhase = {
    lockedAttrBefore: lockedBefore,
    lockedAttrAfterSyntheticSequence: dockSnap.dock.lockedAttr,
    note: 'the synthetic pointerdown/pointerup/click sequence opened the dock; whether it cleared the lock is recorded from the observation, not assumed',
  };
  let gestureEvidence = {
    used: 'Input.dispatchMouseEvent',
    syntheticPhase: syntheticPhase,
    rect: fabRect,
    // The causal chain behind data-locked="0": BgmPlayer reports
    // locked = !AudioEngine.unlocked, and AudioEngine sets unlocked only when the
    // AudioContext's state reads "running" (src/client/core/audio.ts). So a "0"
    // here is an observation that the context actually resumed, not a claim.
    unlockedMeansContextRunning: 'src/client/bgm/player.ts state.locked = !audio.unlocked; src/client/core/audio.ts marks unlocked only when AudioContext.state === "running"',
    // Environment fact, recorded so nobody reads notTested:0 as "the autoplay
    // policy was exercised": this Electron build allowed resume() without user
    // activation, so the classic Chromium autoplay block did not reproduce
    // here. The unlock path is verified; the policy that makes it necessary is
    // an untested branch on this machine.
    environmentFact: 'this Electron build allowed AudioContext.resume() without user activation; the classic Chromium autoplay block did not reproduce here, so the stricter-build branch remains untested here',
    autoplayPolicyObserved: false,
  };
  if (fabRect) {
    const cx = Math.round(fabRect.left + fabRect.w / 2);
    const cy = Math.round(fabRect.top + fabRect.h / 2);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 });
    await sleep(1200);
    const next = await snap();
    gestureEvidence.firstRead = { lockedAttr: next.dock.lockedAttr, lockedNoteHidden: next.dock.lockedNoteHidden, dockHidden: next.dock.hidden };
    // The player re-renders the dock on its own emits; a transport command is
    // the smallest re-render trigger that does not start playback. If the dock
    // was closed by the click, reopen it first.
    if (next.dock.hidden !== false) { await evaluate(send, CLICK_SEQ('zct-dock-fab')); await sleep(500); }
    await evaluate(send, CLICK_SEQ('zct-dock-next'));
    await sleep(800);
    const after = await snap();
    gestureEvidence.afterTransportRead = { lockedAttr: after.dock.lockedAttr, lockedNoteHidden: after.dock.lockedNoteHidden, dockHidden: after.dock.hidden, trackNames: after.tracks.map((t) => t.name) };
    const clearedBySynthetic = syntheticPhase.lockedAttrAfterSyntheticSequence === '0';
    const clearedByTrusted = after.dock.lockedAttr === '0';
    gestureEvidence.clearedBy = clearedBySynthetic ? 'synthetic-sequence' : clearedByTrusted ? 'trusted-Input.dispatchMouseEvent' : null;
    dockSnap = after;
    if (clearedBySynthetic || clearedByTrusted) {
      checks.add('C16.lock-clears-after-gesture', 'the audio lock clears after a click on the dock and the UI stops claiming to be locked', gestureEvidence, true);
    } else {
      checks.notTested('C16.lock-clears-after-gesture', 'the audio lock clears after a click on the dock and the UI stops claiming to be locked', gestureEvidence, 'the AudioContext stayed locked after both the synthetic sequence and a trusted gesture (data-locked="' + after.dock.lockedAttr + '"); the lock state is recorded, not claimed as a pass');
    }
  } else {
    checks.notTested('C16.lock-clears-after-gesture', 'the audio lock clears after a click on the dock and the UI stops claiming to be locked', gestureEvidence, '#zct-dock-fab has no box to click, so no gesture could be dispatched');
  }

  // -------------------------------------------------------- phase D --------
  let prefs = null;
  const prefsGet = await apiGetJson('/api/prefs');
  if (prefsGet.json && prefsGet.json.prefs) prefs = prefsGet.json.prefs;
  evidence.prefsSeen = prefs ? { pet: prefs.pet, appearance: { colorMode: prefs.appearance.colorMode, banner: prefs.appearance.banner }, audio: { enabled: prefs.audio.enabled, bgm: { enabled: prefs.audio.bgm.enabled } } } : null;

  let petSnap = await snap();
  if (petSnap.pet && prefs) {
    const w = petSnap.pet.rect.w;
    checks.add('D17.pet-width-matches-prefs', 'the rendered pet width matches prefs.pet.scale', { renderedWidth: w, scale: prefs.pet.scale, styleWidth: petSnap.pet.styleWidth }, Math.abs(w - prefs.pet.scale) <= 0.5);
  } else {
    checks.notTested('D17.pet-width-matches-prefs', 'the rendered pet width matches prefs.pet.scale', { pet: petSnap.pet, prefs: prefs ? prefs.pet : null }, 'no #zct-pet element or no readable prefs');
  }
  const smallW = Math.min(800, Math.round(args.width / 2));
  const smallH = Math.min(500, Math.round(args.height / 2));
  await send('Emulation.setDeviceMetricsOverride', { width: smallW, height: smallH, deviceScaleFactor: 0, mobile: false });
  await sleep(700);
  const shrunk = await snap();
  const petRect = shrunk.pet ? shrunk.pet.rect : null;
  const inside = !!petRect && petRect.top >= -0.5 && petRect.left >= -0.5 && petRect.right <= shrunk.viewport.w + 0.5 && petRect.bottom <= shrunk.viewport.h + 0.5;
  checks.add('D17.pet-clamped-inside-small-viewport', 'after a resize to ' + smallW + 'x' + smallH + ' the pet is still fully inside the viewport', { viewport: shrunk.viewport, rect: petRect, inside: inside }, inside);
  await clearEmulation();
  await applyViewport(args.width, args.height);

  const ctx = await evaluate(send, CONTEXTMENU_PET);
  await sleep(400);
  const menuSnap = await snap();
  snapshots.petMenu = menuSnap;
  checks.add('D18.pet-contextmenu-opens-menu', 'a contextmenu on the pet opens #zct-pet-menu with at least four items', { dispatch: ctx, menuPresent: menuSnap.ids.petMenu, items: await evaluate(send, "(function(){ var m = document.getElementById('zct-pet-menu'); return m ? m.querySelectorAll('.zct-menu-item').length : 0; })()") }, menuSnap.ids.petMenu === 1 && ctx && ctx.ok === true);
  await pressKey(send, { key: 'Escape', code: 'Escape', vk: 27 });
  await sleep(400);
  const afterEsc = await snap();
  checks.add('D18.pet-menu-escape-closes', 'Escape closes the pet menu', { menuPresentAfterEscape: afterEsc.ids.petMenu }, afterEsc.ids.petMenu === 0);

  const panelOpen = await evaluate(send, CLICK_SEQ('zct-panel-fab'));
  await sleep(600);
  let panelSnap = await snap();
  snapshots.panelOpen = panelSnap;
  checks.add('D19.panel-opens', 'clicking #zct-panel-fab makes #zct-panel visible', { click: panelOpen, hidden: panelSnap.panel.hidden, tabCount: panelSnap.panel.tabCount }, panelOpen && panelOpen.ok === true && panelSnap.panel.hidden === false);
  checks.add('D19.five-tabs', 'the settings centre has five [role="tab"] elements', { tabCount: panelSnap.panel.tabCount, ids: panelSnap.panel.tabs.map((t) => t.id) }, panelSnap.panel.tabCount === 5);
  checks.add('D19.one-selected', 'exactly one tab carries aria-selected="true"', { selectedCount: panelSnap.panel.selectedCount, tabs: panelSnap.panel.tabs }, panelSnap.panel.selectedCount === 1);

  const selectedBefore = panelSnap.panel.tabs.filter((t) => t.selected).map((t) => t.id)[0] || null;
  const targetTab = selectedBefore === 'zct-tab-audio' ? 'zct-tab-appearance' : 'zct-tab-audio';
  const tabClick = await evaluate(send, CLICK_SEQ(targetTab));
  await sleep(400);
  let afterTabClick = await snap();
  let selectedAfter = afterTabClick.panel.tabs.filter((t) => t.selected).map((t) => t.id)[0] || null;
  let trustedClick = null;
  if (selectedAfter === selectedBefore) {
    const rect = await evaluate(send, '(function(){ var b = document.getElementById(' + JSON.stringify(targetTab) + '); if (!b) return null; var r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()');
    if (rect) {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
      await sleep(500);
      trustedClick = rect;
      afterTabClick = await snap();
      selectedAfter = afterTabClick.panel.tabs.filter((t) => t.selected).map((t) => t.id)[0] || null;
    }
  }
  checks.add('D19.tab-click-changes-selection', 'clicking a tab changes which one carries aria-selected', { selectedBefore: selectedBefore, clicked: targetTab, syntheticClick: tabClick, trustedClick: trustedClick, selectedAfter: selectedAfter }, selectedAfter !== null && selectedAfter !== selectedBefore);
  if (selectedAfter === selectedBefore) {
    notes.push('mouse clicks do not switch settings tabs; the tablist click delegation did not move aria-selected (src/client/ui/panel.ts build())');
  }

  // Keyboard navigation is the product's other tab-switching path. The focused
  // tab is the one the keydown must originate from: an Input.dispatchKeyEvent
  // goes to the active element, and the handler lives on the tablist, so a
  // press while <body> is focused would prove nothing.
  const beforeKeys = selectedAfter;
  const keyAttempts = [];
  for (const method of ['Input.dispatchKeyEvent', 'dispatchEvent']) {
    const cur0 = await snap();
    const sel0 = cur0.panel.tabs.filter((t) => t.selected).map((t) => t.id)[0] || null;
    const focused = await evaluate(send, '(function(){ var b = document.getElementById(' + JSON.stringify(sel0 || '') + '); if (b) b.focus(); return document.activeElement ? document.activeElement.id : null; })()');
    if (method === 'Input.dispatchKeyEvent') {
      await pressKey(send, { key: 'ArrowRight', code: 'ArrowRight', vk: 39 });
    } else {
      await evaluate(send, '(function(){ var el = document.activeElement; if (!el) return false; el.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); return true; })()');
    }
    await sleep(300);
    const cur = await snap();
    const sel = cur.panel.tabs.filter((t) => t.selected).map((t) => t.id)[0] || null;
    keyAttempts.push({ method: method, focused: focused, from: sel0, to: sel });
    if (sel !== sel0) { selectedAfter = sel; break; }
  }
  checks.add('D19.tab-keyboard-changes-selection', 'ArrowRight moves the tab selection after the tab is focused (the product supports keyboard tab switching)', { before: beforeKeys, after: selectedAfter, attempts: keyAttempts }, selectedAfter !== beforeKeys);

  await pressKey(send, { key: 'Escape', code: 'Escape', vk: 27 });
  await sleep(400);
  const afterPanelEsc = await snap();
  checks.add('D19.escape-closes-panel', 'Escape closes the settings centre', { hiddenAfterEscape: afterPanelEsc.panel.hidden }, afterPanelEsc.panel.hidden === true);

  // -------------------------------------------------------- phase E --------
  async function selectTabByKeyboard(tabId) {
    for (let i = 0; i < 6; i += 1) {
      const cur = await snap();
      const sel = cur.panel.tabs.filter((t) => t.selected).map((t) => t.id)[0] || null;
      if (sel === tabId) return true;
      const order = cur.panel.tabs.map((t) => t.id);
      const direction = order.indexOf(tabId) > order.indexOf(sel) ? 'ArrowRight' : 'ArrowLeft';
      await evaluate(send, '(function(){ var b = document.getElementById(' + JSON.stringify(sel || '') + '); if (b) b.focus(); return true; })()');
      await pressKey(send, { key: direction, code: direction, vk: direction === 'ArrowRight' ? 39 : 37 });
      await sleep(250);
    }
    const fin = await snap();
    return (fin.panel.tabs.filter((t) => t.selected).map((t) => t.id)[0] || null) === tabId;
  }

  const outDir = path.resolve(args.outDir);
  fs.mkdirSync(outDir, { recursive: true });
  const shotRecords = [];
  async function capture(name, note, clip) {
    const dir = path.join(path.resolve(args.scratch), 'screenshots');
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, name + '.png');
    const state = await snap();
    // A capture that would publish a token or a private project name is
    // recorded as a failure and withheld: the evidence stays honest and the
    // repository never receives the image.
    const tokenLeak = state.secretScan.tokenTotal > 0;
    const projectLeak = state.secretScan.projectHits.length > 0;
    if (tokenLeak || projectLeak) {
      checks.add('E.' + name + '.no-secret-text', 'no token-like text and no private project name is visible in the renderer at capture time', state.secretScan, false);
      checks.add('E.' + name + '.captured', 'the screenshot is a non-blank PNG and no leaked image is written', { withheld: true, reason: 'the pre-capture scan found a token or a private project name', projectHits: state.secretScan.projectHits, tokenTotal: state.secretScan.tokenTotal }, false);
      const rec = { name: name, note: note, file: null, withheld: true, reason: 'the pre-capture scan found a token or a private project name', viewport: state.viewport, secretScan: state.secretScan };
      shotRecords.push(rec);
      return rec;
    }
    const params = { format: 'png' };
    if (clip) {
      params.clip = { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 1 };
      params.captureBeyondViewport = false;
    }
    const shot = await send('Page.captureScreenshot', params);
    fs.writeFileSync(tmp, Buffer.from(shot.data, 'base64'));
    const dest = path.join(outDir, name + '.png');
    fs.copyFileSync(tmp, dest);
    let analysis = null;
    let analysisError = null;
    try { analysis = analyzePng(dest); } catch (err) { analysisError = String((err && err.message) ? err.message : err); }
    const rec = {
      name: name, note: note, file: dest, ...pngInfo(dest),
      cropped: !!clip, clip: clip || null,
      viewport: state.viewport, secretScan: state.secretScan,
      distinctColors: analysis ? analysis.distinctColors : null, avgRgb: analysis ? analysis.avgRgb : null,
      nearBlackFraction: analysis ? analysis.nearBlackFraction : null, analysisError: analysisError,
      bannerVar: state.bannerVar, bannerCount: state.ids.banner, dockHidden: state.dock.hidden, panelHidden: state.panel.hidden, petPresent: state.ids.pet,
    };
    shotRecords.push(rec);
    const blank = !analysis || analysis.distinctColors < 50 || (analysis.avgRgb[0] + analysis.avgRgb[1] + analysis.avgRgb[2]) < 10;
    checks.add('E.' + name + '.captured', 'the screenshot is a non-blank PNG', { file: dest, bytes: rec.bytes, width: rec.width, height: rec.height, distinctColors: rec.distinctColors, avgRgb: rec.avgRgb, error: analysisError }, !blank);
    checks.add('E.' + name + '.no-secret-text', 'no token-like text and no private project name is visible in the renderer at capture time', state.secretScan, state.secretScan.tokenTotal === 0 && state.secretScan.projectHits.length === 0);
    return rec;
  }

  // The D17 clamp test moves the pet to the clamped position and the pet keeps
  // it (working as designed), so the designed bottom-left corner is restored
  // through the pet's own menu before the hero images are taken. The drag,
  // clamp and persistence assertions above are untouched.
  async function resetPetToDefaultCorner() {
    await evaluate(send, CONTEXTMENU_PET);
    await sleep(350);
    const clicked = await evaluate(send, '(function(){ var m = document.getElementById("zct-pet-menu"); if (!m) return { ok: false, reason: "no menu" }; var b = m.querySelector("[data-action=\\"reset\\"]"); if (!b) return { ok: false, reason: "no reset item" }; b.click(); return { ok: true }; })()');
    await sleep(700);
    const after = await snap();
    return { clicked: clicked, rect: after.pet ? after.pet.rect : null, account: after.account, viewport: after.viewport };
  }
  const petReset = await resetPetToDefaultCorner();
  // The designed default corner is bottom-left but deliberately clear of the
  // window edge (DEFAULT_BOTTOM_CLEARANCE in the pet), so "at the corner" means
  // near the bottom without touching it, not flush with it.
  const petBottomGap = petReset.rect ? Math.round(petReset.viewport.h - petReset.rect.bottom) : null;
  const petAtCorner = !!petReset.rect && petReset.rect.left <= 32 && petBottomGap !== null && petBottomGap >= 8 && petBottomGap <= 200;
  checks.add('E.pet-reset-to-default-corner', 'the pet menu resets the pet to its designed bottom-left corner (near the bottom edge, not flush with it)', { clicked: petReset.clicked, rect: petReset.rect, viewport: petReset.viewport, bottomGapPx: petBottomGap }, petAtCorner);
  if (petReset.rect && petReset.account) {
    const overlap = !(petReset.rect.right <= petReset.account.rect.left || petReset.rect.left >= petReset.account.rect.right || petReset.rect.bottom <= petReset.account.rect.top || petReset.rect.top >= petReset.account.rect.bottom);
    checks.add('E.pet-default-corner-clear-of-account', 'the pet in its default corner does not overlap the bottom-left account row', { pet: petReset.rect, account: petReset.account.rect, overlap: overlap }, !overlap);
  } else {
    checks.notTested('E.pet-default-corner-clear-of-account', 'the pet in its default corner does not overlap the bottom-left account row', { pet: petReset.rect, account: petReset.account, reason: 'no account label found to compare against' }, 'this renderer exposes no bottom-left account row');
  }

  // 01 - Tarkov main view. The band is full, nothing injected is open.
  await setBannerMode('full');
  await closeSurfaces(send);
  await capture('01-tarkov-main', 'full app, Tarkov mode, banner full');

  // 02 - settings centre, Appearance tab.
  await evaluate(send, CLICK_SEQ('zct-panel-fab'));
  await sleep(700);
  await selectTabByKeyboard('zct-tab-appearance');
  await sleep(400);
  await capture('02-settings-appearance', 'settings centre open on the Appearance tab');

  // 03 - Audio tab with the fixture listed.
  await selectTabByKeyboard('zct-tab-audio');
  let audioReady = false;
  const audioDeadline = Date.now() + 8000;
  while (Date.now() < audioDeadline) {
    const cur = await snap();
    if (cur.tracks.some((t) => t.name === 'harness-tone')) { audioReady = true; break; }
    await sleep(300);
  }
  await capture('03-settings-audio', 'Audio tab with the fixture track listed; audioReady=' + audioReady);

  // 04 - the dock open on the fixture.
  await pressKey(send, { key: 'Escape', code: 'Escape', vk: 27 });
  await sleep(400);
  let dockNow = await snap();
  if (dockNow.dock.hidden !== false) { await evaluate(send, CLICK_SEQ('zct-dock-fab')); await sleep(700); }
  dockNow = await snap();
  await capture('04-bgm-dock', 'background-music dock open; title=' + dockNow.dock.title);

  // 05 - the pet, cropped to a region around it so the subject is legible at
  // README size; the evidence JSON records that this image is cropped.
  await evaluate(send, CLICK_SEQ('zct-dock-fab'));
  await sleep(400);
  const petShotState = await snap();
  let petClip = null;
  if (petShotState.pet) {
    const r = petShotState.pet.rect;
    const pad = 70;
    const x = Math.max(0, Math.round(r.left - pad));
    const y = Math.max(0, Math.round(r.top - pad));
    petClip = {
      x: x, y: y,
      width: Math.min(petShotState.viewport.w - x, Math.round(r.w + pad * 2)),
      height: Math.min(petShotState.viewport.h - y, Math.round(r.h + pad * 2)),
      petRect: r,
    };
  }
  await capture('05-pet', 'the pet, cropped to a region around it (this image is cropped, not a full-viewport capture)', petClip);

  // 06 - compact band.
  await setBannerMode('compact');
  await capture('06-status-banner-compact', 'compact band');

  // 07 - band off: the composer and the account area must be in place.
  const offResult = await setBannerMode('off');
  const offSnap = offResult.snapshot;
  await capture('07-banner-off', 'band off; composer and account area in place');
  checks.add('E.07-banner-off.composer-and-account-in-place', 'with the band off the composer and account row sit inside the viewport', { composer: offSnap.composer ? offSnap.composer.rect : null, account: offSnap.account ? offSnap.account.rect : null, viewport: offSnap.viewport }, !!offSnap.composer && !!offSnap.account && offSnap.composer.rect.bottom <= offSnap.viewport.h + 0.5 && offSnap.account.rect.bottom <= offSnap.viewport.h + 0.5);

  // Leave the instance in its default mode and check the band comes back.
  const restored = await setBannerMode('full');
  checks.add('E.restore-full-banner', 'the harness restores the full band before it finishes', { var: restored.snapshot.bannerVar, bannerCount: restored.snapshot.ids.banner, attr: restored.snapshot.htmlBannerAttr }, restored.snapshot.bannerVar === (args.fullHeight || 56) + 'px' && restored.snapshot.ids.banner === 1);

  // ------------------------------------------------ phase F: appearance ----
  // The recolourable palette and the editable greeting are verified after the
  // seven screenshots above, so those images keep showing an uncustomised
  // install. The shipped background and accent come from the driver, which
  // reads them out of src/themes/palette.ts; the shipped greeting text is the
  // one this run observed in the live renderer, never a literal here.
  const shipped = {
    background: (args.background || '#1c1207').trim().toLowerCase(),
    accent: (args.accent || '#ee8a3a').trim().toLowerCase(),
  };
  const customPalette = { background: '#0b1020', accent: '#3ba7ff' };
  const lightBackground = '#f2ece0';
  const customGreeting = { line1: 'HARNESS GREETING LINE ONE', line2: 'The second line follows the first one down the badge.' };
  const trickyGreeting = { line1: 'Quote " then backslash \\ then quote " again', line2: 'Path C:\\Tarkov\\beta "quoted" twice' };
  const shippedGreeting = greetingAtStart && greetingAtStart.ruleInStyle === true && typeof greetingAtStart.beforeText === 'string' && greetingAtStart.beforeText.length > 0 && greetingAtStart.beforeText !== 'none' && greetingAtStart.afterText !== 'none'
    ? { line1: greetingAtStart.beforeText, line2: greetingAtStart.afterText }
    : null;
  const appearanceEvidence = {
    shipped: shipped,
    customPalette: customPalette,
    lightBackground: lightBackground,
    customGreeting: customGreeting,
    trickyGreeting: trickyGreeting,
    greetingAtStart: greetingAtStart,
    shippedGreeting: shippedGreeting,
    steps: [],
  };
  evidence.appearance = appearanceEvidence;

  async function postPrefs(patch) {
    const r = await apiFetch('/api/prefs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    return { status: r.status, body: safeJson(r.text) };
  }
  async function waitForPrefs(predicate, timeoutMs = 8000) {
    const start = Date.now();
    let last = null;
    while (Date.now() - start < timeoutMs) {
      const cur = await apiGetJson('/api/prefs').catch(() => null);
      last = cur && cur.json && cur.json.prefs ? cur.json.prefs : null;
      if (last && predicate(last)) return { waitedMs: Date.now() - start, prefs: last, timedOut: false };
      await sleep(250);
    }
    return { waitedMs: Date.now() - start, prefs: last, timedOut: true };
  }

  // --- F8/F9: the panel exposes the controls and they are wired ------------
  const panelOpenForControls = await evaluate(send, CLICK_SEQ('zct-panel-fab'));
  await sleep(600);
  await selectTabByKeyboard('zct-tab-appearance');
  await sleep(400);
  const controlProbe = await evaluate(send, APPEARANCE_CONTROLS);
  appearanceEvidence.steps.push({ step: 'panel-controls', click: panelOpenForControls, probe: controlProbe });
  checks.add('F8.appearance-controls', 'the selected Appearance pane holds exactly two colour inputs and two greeting text inputs, scoped to #zct-panel', controlProbe, !!controlProbe && controlProbe.selectedTab === 'zct-tab-appearance' && controlProbe.colorCount === 2 && controlProbe.textCount === 2);
  checks.add('F8.panel-tabs-five-scoped', '#zct-panel-tabs holds exactly five [role="tab"] elements (the document has other Radix tabs)', controlProbe ? { scoped: controlProbe.scopedTabCount, inDocument: controlProbe.documentTabCount } : 'no probe', !!controlProbe && controlProbe.scopedTabCount === 5);

  const wiredColor = '#123456';
  const wiredText = 'HARNESS CONTROL WIRING';
  const driveColor = await evaluate(send, driveInputExpression('color', 0, wiredColor));
  const prefsAfterColor = await waitForPrefs((p) => !!p.appearance && p.appearance.background === wiredColor, 8000);
  checks.add('F9.color-input-writes-pref', 'driving the first colour input with real input/change events stores appearance.background', { drive: driveColor, readBack: prefsAfterColor.prefs ? { background: prefsAfterColor.prefs.appearance.background, accent: prefsAfterColor.prefs.appearance.accent } : null, waitedMs: prefsAfterColor.waitedMs }, !!(driveColor && driveColor.ok) && !!prefsAfterColor.prefs && prefsAfterColor.prefs.appearance.background === wiredColor);
  const driveText = await evaluate(send, driveInputExpression('text', 0, wiredText));
  const prefsAfterText = await waitForPrefs((p) => !!p.appearance && !!p.appearance.greeting && p.appearance.greeting.line1 === wiredText, 8000);
  checks.add('F9.text-input-writes-pref', 'driving the first greeting text input with real input/change events stores appearance.greeting.line1', { drive: driveText, readBack: prefsAfterText.prefs ? { line1: prefsAfterText.prefs.appearance.greeting.line1, line2: prefsAfterText.prefs.appearance.greeting.line2 } : null, waitedMs: prefsAfterText.waitedMs }, !!(driveText && driveText.ok) && !!prefsAfterText.prefs && prefsAfterText.prefs.appearance.greeting.line1 === wiredText);

  // The F9 text drive left a harness marker in the greeting; the shipped text
  // goes back before the palette capture, so 08 differs from 01 by colour only.
  if (shippedGreeting) {
    await postPrefs({ appearance: { greeting: { enabled: true, line1: shippedGreeting.line1, line2: shippedGreeting.line2 } } });
    await waitForSnapshot((st) => !!st.greeting && st.greeting.beforeText === shippedGreeting.line1, 8000);
  }

  // --- F1: a custom palette reaches every accent surface -------------------
  const wallpaperOff = await apiFetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ wallpaperVisible: false }) });
  appearanceEvidence.wallpaperVisibleFalse = { status: wallpaperOff.status, body: safeJson(wallpaperOff.text) };
  const palettePost = await postPrefs({ appearance: { background: customPalette.background, accent: customPalette.accent } });
  const paletteWait = await waitForSnapshot((st) => normColor(st.tokens.colorPrimary) === customPalette.accent && normColor(st.tokens.tarkovAccent) === customPalette.accent && normColor(st.tokens.colorBackground) === customPalette.background, 10000);
  // The injected UI can reach the custom accent two ways: the skin derives
  // --zct-accent from the page token, and the client also sets an inline
  // override. Both are valid for "the UI's own accent followed the POST", so
  // the renderer gets one short, recorded moment to settle before the observed
  // value is taken.
  const uiRootWait = await waitForSnapshot((st) => !!st.uiRootAccent && normColor(st.uiRootAccent.computed) === customPalette.accent, 5000);
  const ps = uiRootWait.snapshot || paletteWait.snapshot;
  const paletteObserved = ps ? {
    colorPrimary: ps.tokens.colorPrimary,
    tarkovAccent: ps.tokens.tarkovAccent,
    colorBackground: ps.tokens.colorBackground,
    colorForeground: ps.tokens.colorForeground,
    bandBackground: ps.banner ? ps.banner.bg : null,
    uiRootTheme: ps.uiRootTheme,
    uiRootAccentInline: ps.uiRootAccent ? ps.uiRootAccent.inline : null,
    uiRootAccentComputed: ps.uiRootAccent ? ps.uiRootAccent.computed : null,
    uiRootAccentPageToken: ps.uiRootAccent ? ps.uiRootAccent.pageToken : null,
    greetingBadgeColor: ps.greeting ? ps.greeting.badgeColor : null,
    greetingBadgeContent: ps.greeting ? ps.greeting.badgeContentRaw : null,
  } : null;
  appearanceEvidence.customPaletteRun = { post: palettePost, waitedMs: paletteWait.waitedMs, uiRootSettleWaitedMs: uiRootWait.waitedMs, timedOut: paletteWait.timedOut, observed: paletteObserved };
  checks.add('F1.custom-primary-accent', 'with appearance.accent=' + customPalette.accent + ' the computed --color-primary is the chosen accent', ps ? ps.tokens.colorPrimary : 'no snapshot', !!ps && normColor(ps.tokens.colorPrimary) === customPalette.accent);
  checks.add('F1.custom-tarkov-accent', 'the computed --tarkov-accent is the chosen accent', ps ? ps.tokens.tarkovAccent : 'no snapshot', !!ps && normColor(ps.tokens.tarkovAccent) === customPalette.accent);
  checks.add('F1.custom-background-token', 'with appearance.background=' + customPalette.background + ' and wallpaperVisible=false the computed --color-background is the opaque chosen colour', ps ? { colorBackground: ps.tokens.colorBackground, wallpaperVisible: false } : 'no snapshot', !!ps && normColor(ps.tokens.colorBackground) === customPalette.background);
  checks.add('F1.custom-band-background', 'the band background-color follows the custom accent instead of staying at the shipped orange', ps && ps.banner ? ps.banner.bg : 'no band', !!ps && !!ps.banner && String(ps.banner.bg).indexOf('rgba(59, 167, 255') === 0);
  checks.add('F1.custom-ui-root-accent', 'after POST /api/prefs the injected UI\'s own --zct-accent on #zct-ui-root is ' + customPalette.accent, ps && ps.uiRootAccent ? { inline: ps.uiRootAccent.inline, computed: ps.uiRootAccent.computed, theme: ps.uiRootAccent.theme, pageToken: ps.uiRootAccent.pageToken } : 'no #zct-ui-root', !!(ps && ps.uiRootAccent) && normColor(ps.uiRootAccent.computed) === customPalette.accent);
  if (ps && ps.greeting && ps.greeting.paragraphCount > 0) {
    checks.add('F1.custom-greeting-badge-accent', 'the greeting badge glyph follows the custom accent', { badgeColor: ps.greeting.badgeColor, badgeContentRaw: ps.greeting.badgeContentRaw }, normColor(ps.greeting.badgeColor) === customPalette.accent);
  } else {
    checks.notTested('F1.custom-greeting-badge-accent', 'the greeting badge glyph follows the custom accent', { greeting: ps ? ps.greeting : null }, 'the empty-chat greeting element was not in the renderer for this snapshot');
  }

  // The client holds its own in-memory copy of prefs and re-reads them when it
  // writes them itself (via the panel's controls), not when the API is written
  // from outside. Both observations are recorded separately: an external write
  // that never reached the client must not be reported as the control path
  // working, nor the other way round.
  // The client's UI resolves its accent through the theme's own token rather
  // than an inline override: the injected theme stylesheet publishes
  // --tarkov-accent on <html> and the service re-pushes it on any config change,
  // so the dock, panel and pet follow a recolour with no JavaScript, and a
  // non-Tarkov mode cannot inherit a Tarkov accent. The assertion is therefore
  // about the *outcome* — the panel control write reaches the UI — and about the
  // absence of a stale inline override, not about the mechanism.
  // The accent control (index 1) is driven to a probe value first, so the
  // client's own write can be observed landing in /api/prefs, and then back to
  // the declared accent; a write that never happened and a client that never
  // set the override are therefore distinguishable in the evidence.
  const accentProbe = '#3ba7fe';
  const panelColorsBefore = await evaluate(send, PANEL_COLOR_STATE);
  const paletteControlDrive = await evaluate(send, driveInputExpression('color', 1, accentProbe));
  const prefsAfterDrive = await waitForPrefs((p) => !!p.appearance && String(p.appearance.accent).toLowerCase() === accentProbe, 8000);
  const clientProbeWait = await waitForSnapshot((st) => !!st.uiRootAccent && st.uiRootAccent.inline.trim().toLowerCase() === accentProbe, 8000);
  const panelColorsAfterProbe = await evaluate(send, PANEL_COLOR_STATE);
  const paletteControlDriveBack = await evaluate(send, driveInputExpression('color', 1, customPalette.accent));
  const clientPaletteWait = await waitForSnapshot((st) => !!st.uiRootAccent && st.uiRootAccent.inline.trim().toLowerCase() === customPalette.accent, 8000);
  const clientPaletteSnap = clientPaletteWait.snapshot || ps;
  const clientPaletteObserved = clientPaletteSnap && clientPaletteSnap.uiRootAccent ? { theme: clientPaletteSnap.uiRootAccent.theme, inline: clientPaletteSnap.uiRootAccent.inline, inlineSoft: clientPaletteSnap.uiRootAccent.inlineSoft, computed: clientPaletteSnap.uiRootAccent.computed } : null;
  appearanceEvidence.customPaletteControlPath = {
    panelColorsBefore: panelColorsBefore,
    driveProbe: paletteControlDrive,
    prefsAfterProbeWrite: prefsAfterDrive.prefs ? { accent: prefsAfterDrive.prefs.appearance.accent, background: prefsAfterDrive.prefs.appearance.background } : null,
    probeWriteWaitedMs: prefsAfterDrive.waitedMs,
    inlineAfterProbeWrite: clientProbeWait.snapshot && clientProbeWait.snapshot.uiRootAccent ? clientProbeWait.snapshot.uiRootAccent.inline : null,
    inlineAfterProbeWaitedMs: clientProbeWait.waitedMs,
    inlineAfterProbeTimedOut: clientProbeWait.timedOut,
    panelColorsAfterProbe: panelColorsAfterProbe,
    driveBack: paletteControlDriveBack,
    waitedMs: clientPaletteWait.waitedMs,
    timedOut: clientPaletteWait.timedOut,
    observed: clientPaletteObserved,
  };
  checks.add('F1.custom-ui-root-accent-after-control-write', 'driving the panel\'s own background control through real events makes #zct-ui-root resolve ' + customPalette.accent + ' (through the theme token, with no inline override left behind)', clientPaletteObserved, !!(clientPaletteSnap && clientPaletteSnap.uiRootAccent) && normColor(clientPaletteSnap.uiRootAccent.computed) === customPalette.accent && clientPaletteSnap.uiRootAccent.inline.trim() === '');
  const postAccentFollowed = !!(ps && ps.uiRootAccent) && normColor(ps.uiRootAccent.computed) === customPalette.accent;
  if (!postAccentFollowed) {
    notes.push('after POST /api/prefs with accent ' + customPalette.accent + ', #zct-ui-root resolved --zct-accent=' + (ps && ps.uiRootAccent ? ps.uiRootAccent.computed : 'unknown') + ' (theme attribute ' + (ps && ps.uiRootAccent ? ps.uiRootAccent.theme : 'unknown') + ', inherited page token ' + (ps && ps.uiRootAccent ? ps.uiRootAccent.pageToken : 'unknown') + ', inline="' + (ps && ps.uiRootAccent ? ps.uiRootAccent.inline : 'unknown') + '") and only took the accent after the panel control write; F1.custom-ui-root-accent records that as a failure while the control-path check passes.');
  } else if (ps && ps.uiRootAccent && ps.uiRootAccent.inline === '') {
    notes.push('with the custom palette stored, #zct-ui-root resolves --zct-accent=' + ps.uiRootAccent.computed + ' through the stylesheet rule that derives it from the inherited page token, with no inline override; F1.custom-ui-root-accent-after-control-write checks that the panel control write reaches it, and F2.no-inline-accent-override checks that returning to the shipped accent leaves no leftover override.');
  }

  // --- F4: the band contract re-run under the custom palette ---------------
  const customModes = {};
  for (const mode of modes) {
    const result = await setBannerMode(mode);
    customModes[mode] = { post: { status: result.status, body: result.body }, waitedMs: result.waitedMs };
    const obs = result.snapshot || (await snap());
    layoutChecksFor(mode, obs, 'F4.palette', ' with the custom palette applied');
  }
  appearanceEvidence.customPaletteModes = customModes;
  await setBannerMode('full');
  await closeSurfaces(send);
  await sleep(400);
  await capture('08-palette-custom', 'custom palette: background ' + customPalette.background + ', accent ' + customPalette.accent + '; the band follows the accent');

  // --- F2: restoring the shipped palette leaves no inline override ---------
  await evaluate(send, CLICK_SEQ('zct-panel-fab'));
  await sleep(600);
  const restorePost = await postPrefs({ appearance: { background: shipped.background, accent: shipped.accent } });
  const restoreWait = await waitForSnapshot((st) => normColor(st.tokens.colorPrimary) === shipped.accent && normColor(st.tokens.tarkovAccent) === shipped.accent && normColor(st.tokens.colorBackground) === shipped.background, 10000);
  const restoreSnap = restoreWait.snapshot;
  const restoreObserved = restoreSnap ? {
    colorPrimary: restoreSnap.tokens.colorPrimary,
    tarkovAccent: restoreSnap.tokens.tarkovAccent,
    colorBackground: restoreSnap.tokens.colorBackground,
    bandBackground: restoreSnap.banner ? restoreSnap.banner.bg : null,
    uiRootAccentInline: restoreSnap.uiRootAccent ? restoreSnap.uiRootAccent.inline : null,
    uiRootAccentComputed: restoreSnap.uiRootAccent ? restoreSnap.uiRootAccent.computed : null,
  } : null;
  appearanceEvidence.restoredPalette = { post: restorePost, waitedMs: restoreWait.waitedMs, timedOut: restoreWait.timedOut, observed: restoreObserved };
  checks.add('F2.restored-primary-accent', 'restoring the shipped accent puts --color-primary back to ' + shipped.accent, restoreSnap ? restoreSnap.tokens.colorPrimary : 'no snapshot', !!restoreSnap && normColor(restoreSnap.tokens.colorPrimary) === shipped.accent);
  checks.add('F2.restored-tarkov-accent', 'restoring the shipped accent puts --tarkov-accent back to ' + shipped.accent, restoreSnap ? restoreSnap.tokens.tarkovAccent : 'no snapshot', !!restoreSnap && normColor(restoreSnap.tokens.tarkovAccent) === shipped.accent);
  checks.add('F2.restored-background', 'restoring the shipped background puts --color-background back to ' + shipped.background, restoreSnap ? restoreSnap.tokens.colorBackground : 'no snapshot', !!restoreSnap && normColor(restoreSnap.tokens.colorBackground) === shipped.background);
  checks.add('F2.restored-band-background', 'the band background returns to the shipped accent', restoreSnap && restoreSnap.banner ? restoreSnap.banner.bg : 'no band', !!restoreSnap && !!restoreSnap.banner && String(restoreSnap.banner.bg).indexOf('rgba(238, 138, 58') === 0);

  // The same two-step sequence as F1: the external POST moves the page, then
  // the panel control makes the client apply the restored prefs. The guarantee
  // under test is that a colour back at the shipped value leaves no inline
  // override behind, which is what keeps an uncustomised install identical.
  const restoreDrive = await evaluate(send, driveInputExpression('color', 1, shipped.accent));
  const restorePrefsWait = await waitForPrefs((p) => !!p.appearance && String(p.appearance.accent).toLowerCase() === shipped.accent, 8000);
  const clientRestoreWait = await waitForSnapshot((st) => !!st.uiRootAccent && st.uiRootAccent.inline === '' && normColor(st.uiRootAccent.computed) === shipped.accent, 8000);
  const clientRestoreSnap = clientRestoreWait.snapshot;
  const clientRestoreObserved = clientRestoreSnap && clientRestoreSnap.uiRootAccent ? { inline: clientRestoreSnap.uiRootAccent.inline, inlineSoft: clientRestoreSnap.uiRootAccent.inlineSoft, computed: clientRestoreSnap.uiRootAccent.computed } : null;
  appearanceEvidence.restoredPaletteControlPath = { drive: restoreDrive, prefsAfterDrive: restorePrefsWait.prefs ? { accent: restorePrefsWait.prefs.appearance.accent, background: restorePrefsWait.prefs.appearance.background } : null, writeWaitedMs: restorePrefsWait.waitedMs, waitedMs: clientRestoreWait.waitedMs, timedOut: clientRestoreWait.timedOut, observed: clientRestoreObserved };
  checks.add('F2.no-inline-accent-override', 'with the shipped accent applied after an inline custom override existed, #zct-ui-root has no inline --zct-accent left: style.getPropertyValue("--zct-accent") === ""', { inlineBeforeRestore: clientPaletteObserved ? clientPaletteObserved.inline : null, afterExternalPost: restoreObserved ? { inline: restoreObserved.uiRootAccentInline, computed: restoreObserved.uiRootAccentComputed } : null, afterControlWrite: clientRestoreObserved }, !!(clientRestoreSnap && clientRestoreSnap.uiRootAccent) && clientRestoreSnap.uiRootAccent.inline === '' && normColor(clientRestoreSnap.uiRootAccent.computed) === shipped.accent);
  await pressKey(send, { key: 'Escape', code: 'Escape', vk: 27 });
  await sleep(400);

  // --- F3: a light background picks dark text ------------------------------
  const lightPost = await postPrefs({ appearance: { background: lightBackground } });
  const lightWait = await waitForSnapshot((st) => normColor(st.tokens.colorBackground) === lightBackground, 10000);
  const lightSnap = lightWait.snapshot;
  const lightForeground = lightSnap ? lightSnap.tokens.colorForeground : null;
  const fgRgb = parseColor(lightForeground);
  const fgLuminance = fgRgb ? Math.round(relativeLuminance(fgRgb) * 10000) / 10000 : null;
  const fgContrast = fgRgb ? contrastRatio(fgRgb, parseColor(lightBackground)) : null;
  appearanceEvidence.lightBackgroundRun = { post: lightPost, waitedMs: lightWait.waitedMs, observed: lightSnap ? { colorBackground: lightSnap.tokens.colorBackground, colorForeground: lightForeground } : null, foregroundLuminance: fgLuminance, contrastRatioAgainstBackground: fgContrast };
  checks.add('F3.light-background-dark-foreground', 'with background ' + lightBackground + ' the computed --color-foreground is a dark colour', { colorForeground: lightForeground, relativeLuminance: fgLuminance }, fgLuminance !== null && fgLuminance < 0.2);
  checks.add('F3.light-background-contrast-ratio', 'the observed foreground/background pair clears the WCAG AA contrast bar for body text (4.5:1); the ratio is recorded', { foreground: lightForeground, background: lightBackground, contrastRatio: fgContrast, wcagAaThreshold: 4.5 }, fgContrast !== null && fgContrast >= 4.5);
  const lightRestore = await postPrefs({ appearance: { background: shipped.background } });
  appearanceEvidence.lightBackgroundRun.restore = lightRestore;

  // --- F5/F6/F7: the greeting text is editable -----------------------------
  const greetingPost = await postPrefs({ appearance: { greeting: { enabled: true, line1: customGreeting.line1, line2: customGreeting.line2 } } });
  const greetingWait = await waitForSnapshot((st) => !!st.greeting && typeof st.greeting.beforeText === 'string' && st.greeting.beforeText.indexOf(customGreeting.line1) >= 0 && typeof st.greeting.afterText === 'string' && st.greeting.afterText.indexOf(customGreeting.line2) >= 0, 10000);
  const greetingSnap = greetingWait.snapshot;
  const greetingObserved = greetingSnap ? { beforeRaw: greetingSnap.greeting.beforeRaw, beforeText: greetingSnap.greeting.beforeText, afterRaw: greetingSnap.greeting.afterRaw, afterText: greetingSnap.greeting.afterText, spanText: greetingSnap.greeting.spanText, spanFontSize: greetingSnap.greeting.spanFontSize, ruleInStyle: greetingSnap.greeting.ruleInStyle } : null;
  appearanceEvidence.greetingCustomRun = { post: greetingPost, waitedMs: greetingWait.waitedMs, timedOut: greetingWait.timedOut, observed: greetingObserved };
  checks.add('F5.greeting-line1-custom', 'the ::before content of the greeting span carries the custom first line', { requested: customGreeting.line1, observed: greetingObserved ? { raw: greetingObserved.beforeRaw, text: greetingObserved.beforeText } : null }, !!greetingSnap && !!greetingSnap.greeting && typeof greetingSnap.greeting.beforeText === 'string' && greetingSnap.greeting.beforeText.indexOf(customGreeting.line1) >= 0);
  checks.add('F5.greeting-line2-custom', 'the ::after content of the greeting span carries the custom second line', { requested: customGreeting.line2, observed: greetingObserved ? { raw: greetingObserved.afterRaw, text: greetingObserved.afterText } : null }, !!greetingSnap && !!greetingSnap.greeting && typeof greetingSnap.greeting.afterText === 'string' && greetingSnap.greeting.afterText.indexOf(customGreeting.line2) >= 0);
  await closeSurfaces(send);
  await setBannerMode('full');
  await sleep(400);
  await capture('09-greeting-custom', 'empty-chat screen with the custom greeting text; both pseudo-element lines drawn');

  const greetingOffPost = await postPrefs({ appearance: { greeting: { enabled: false } } });
  const greetingOffWait = await waitForSnapshot((st) => !!st.greeting && st.greeting.ruleInStyle === false, 10000);
  const greetingOffSnap = greetingOffWait.snapshot;
  const greetingOffObserved = greetingOffSnap ? { ruleInStyle: greetingOffSnap.greeting.ruleInStyle, styleLength: greetingOffSnap.greeting.styleLength, beforeRaw: greetingOffSnap.greeting.beforeRaw, beforeText: greetingOffSnap.greeting.beforeText, afterText: greetingOffSnap.greeting.afterText, spanText: greetingOffSnap.greeting.spanText, spanFontSize: greetingOffSnap.greeting.spanFontSize, paragraphCount: greetingOffSnap.greeting.paragraphCount } : null;
  appearanceEvidence.greetingDisabledRun = { post: greetingOffPost, waitedMs: greetingOffWait.waitedMs, timedOut: greetingOffWait.timedOut, observed: greetingOffObserved };
  checks.add('F6.greeting-disabled-rule-gone', 'with greeting.enabled=false the injected stylesheet (#zcode-beautify-style) no longer carries a data-v4-draft-greeting rule', { ruleInStyle: greetingOffSnap ? greetingOffSnap.greeting.ruleInStyle : null, styleLength: greetingOffSnap ? greetingOffSnap.greeting.styleLength : null }, !!greetingOffSnap && greetingOffSnap.greeting.ruleInStyle === false);
  checks.add('F6.greeting-disabled-pseudo-not-ours', 'the greeting pseudo-elements no longer draw the custom text', { beforeText: greetingOffSnap ? greetingOffSnap.greeting.beforeText : null, afterText: greetingOffSnap ? greetingOffSnap.greeting.afterText : null, customLine1: customGreeting.line1, customLine2: customGreeting.line2 }, !!greetingOffSnap && typeof greetingOffSnap.greeting.beforeText === 'string' && greetingOffSnap.greeting.beforeText.indexOf(customGreeting.line1) < 0 && typeof greetingOffSnap.greeting.afterText === 'string' && greetingOffSnap.greeting.afterText.indexOf(customGreeting.line2) < 0);
  checks.add('F6.greeting-disabled-native-text-renders', 'ZCode\'s own greeting text is what the element renders again (the collapse rule is gone)', { spanText: greetingOffSnap ? greetingOffSnap.greeting.spanText : null, spanFontSize: greetingOffSnap ? greetingOffSnap.greeting.spanFontSize : null, customLine1: customGreeting.line1 }, !!greetingOffSnap && typeof greetingOffSnap.greeting.spanText === 'string' && greetingOffSnap.greeting.spanText.length > 0 && greetingOffSnap.greeting.spanText.indexOf(customGreeting.line1) < 0 && greetingOffSnap.greeting.spanFontSize !== '0px');
  const greetingBackPost = await postPrefs({ appearance: { greeting: { enabled: true, line1: customGreeting.line1, line2: customGreeting.line2 } } });
  const greetingBackWait = await waitForSnapshot((st) => !!st.greeting && st.greeting.ruleInStyle === true && typeof st.greeting.beforeText === 'string' && st.greeting.beforeText.indexOf(customGreeting.line1) >= 0 && typeof st.greeting.afterText === 'string' && st.greeting.afterText.indexOf(customGreeting.line2) >= 0, 10000);
  const greetingBackSnap = greetingBackWait.snapshot;
  appearanceEvidence.greetingReenabledRun = { post: greetingBackPost, waitedMs: greetingBackWait.waitedMs, observed: greetingBackSnap ? { ruleInStyle: greetingBackSnap.greeting.ruleInStyle, beforeText: greetingBackSnap.greeting.beforeText, afterText: greetingBackSnap.greeting.afterText } : null };
  checks.add('F6.greeting-reenabled-custom-text-back', 're-enabling the notice brings the custom text back', appearanceEvidence.greetingReenabledRun.observed, !!greetingBackSnap && !!greetingBackSnap.greeting && greetingBackSnap.greeting.ruleInStyle === true && typeof greetingBackSnap.greeting.beforeText === 'string' && greetingBackSnap.greeting.beforeText.indexOf(customGreeting.line1) >= 0 && typeof greetingBackSnap.greeting.afterText === 'string' && greetingBackSnap.greeting.afterText.indexOf(customGreeting.line2) >= 0);

  const trickyPost = await postPrefs({ appearance: { greeting: { enabled: true, line1: trickyGreeting.line1, line2: trickyGreeting.line2 } } });
  const trickyWait = await waitForSnapshot((st) => !!st.greeting && st.greeting.beforeText === trickyGreeting.line1 && st.greeting.afterText === trickyGreeting.line2, 10000);
  const trickySnap = trickyWait.snapshot;
  const trickyObserved = trickySnap ? { requestedLine1: trickyGreeting.line1, beforeRaw: trickySnap.greeting.beforeRaw, beforeText: trickySnap.greeting.beforeText, requestedLine2: trickyGreeting.line2, afterRaw: trickySnap.greeting.afterRaw, afterText: trickySnap.greeting.afterText } : null;
  appearanceEvidence.greetingEscapedRun = { post: trickyPost, waitedMs: trickyWait.waitedMs, timedOut: trickyWait.timedOut, observed: trickyObserved };
  checks.add('F7.greeting-escaped-quote-backslash-round-trip', 'a greeting line containing a double quote and a backslash round-trips through the generated content value', trickyObserved, !!trickySnap && !!trickySnap.greeting && trickySnap.greeting.beforeText === trickyGreeting.line1 && trickySnap.greeting.afterText === trickyGreeting.line2);
  checks.add('F7.greeting-raw-content-shows-escaping', 'the raw computed content carries the escaped quote and backslash, not a broken literal', { beforeRaw: trickySnap ? trickySnap.greeting.beforeRaw : null, afterRaw: trickySnap ? trickySnap.greeting.afterRaw : null }, !!trickySnap && !!trickySnap.greeting && typeof trickySnap.greeting.beforeRaw === 'string' && trickySnap.greeting.beforeRaw.indexOf('\\"') >= 0 && trickySnap.greeting.beforeRaw.indexOf('\\\\') >= 0);

  if (shippedGreeting) {
    const greetingRestorePost = await postPrefs({ appearance: { greeting: { enabled: true, line1: shippedGreeting.line1, line2: shippedGreeting.line2 } } });
    const greetingRestoreWait = await waitForSnapshot((st) => !!st.greeting && st.greeting.beforeText === shippedGreeting.line1 && st.greeting.afterText === shippedGreeting.line2, 10000);
    const greetingRestoreSnap = greetingRestoreWait.snapshot;
    appearanceEvidence.greetingRestoredRun = { post: greetingRestorePost, waitedMs: greetingRestoreWait.waitedMs, observed: greetingRestoreSnap ? { ruleInStyle: greetingRestoreSnap.greeting.ruleInStyle, beforeText: greetingRestoreSnap.greeting.beforeText, afterText: greetingRestoreSnap.greeting.afterText } : null };
    checks.add('F.restore-shipped-greeting', 'the run leaves the greeting text it observed at the start in place', { shipped: shippedGreeting, observed: appearanceEvidence.greetingRestoredRun.observed }, !!greetingRestoreSnap && !!greetingRestoreSnap.greeting && greetingRestoreSnap.greeting.beforeText === shippedGreeting.line1 && greetingRestoreSnap.greeting.afterText === shippedGreeting.line2);
  } else {
    checks.notTested('F.restore-shipped-greeting', 'the run leaves the greeting text it observed at the start in place', { greetingAtStart: greetingAtStart }, 'the shipped greeting text could not be read from the live renderer when the run started, so there is nothing to compare the restored text against');
  }

  const finalSnap = await snap();
  checks.add('privacy.no-private-project-names-final', 'no known private project name is visible after the full journey', { matched: finalSnap.secretScan.projectHits, scannedChars: finalSnap.secretScan.textLength }, finalSnap.secretScan.projectHits.length === 0);

  evidence.screenshots = shotRecords;
  evidence.snapshotSummary = {
    initial: trimSnapshot(snapshots.initial),
    modeOff: trimSnapshot(snapshots['mode-off']),
    modeCompact: trimSnapshot(snapshots['mode-compact']),
    modeFull: trimSnapshot(snapshots['mode-full']),
    afterDestroy: trimSnapshot(snapshots.afterDestroy),
    afterReload: trimSnapshot(snapshots.afterReload),
    beforeGesture: trimSnapshot(snapshots.beforeGesture),
    dockOpen: trimSnapshot(snapshots.dockOpen),
  };
  evidence.checks = checks.checks;
  evidence.summary = checks.summary();
  evidence.notes = notes;
  // Environment facts, separated from checks so a green run cannot be read as
  // more than it proves.
  evidence.environmentFacts = [
    {
      id: 'autoplay-policy',
      fact: 'this Electron build allowed AudioContext.resume() without user activation, so the classic Chromium autoplay block did not reproduce on this machine',
      consequence: 'the unlock path (data-locked "1" -> "0", which by the audio.ts chain means AudioContext.state === "running") is verified; the branch where a stricter build keeps the context suspended until a real user gesture remains untested here and would be recorded as NOT TESTED by C16.lock-clears-after-gesture',
      observed: 'clearedBy=' + (gestureEvidence.clearedBy || 'none'),
    },
    {
      id: 'viewport',
      fact: 'the ' + args.width + 'x' + args.height + ' CSS viewport was reached with a real SetWindowPos resize of the isolated window, at devicePixelRatio ' + (snapshots.initial && snapshots.initial.viewport ? snapshots.initial.viewport.dpr : 'unknown'),
      consequence: 'screenshots are ' + (snapshots.initial && snapshots.initial.viewport ? Math.round(args.width * snapshots.initial.viewport.dpr) + 'x' + Math.round(args.height * snapshots.initial.viewport.dpr) : 'physical-pixel') + ' PNGs of that viewport; no emulation was used',
      observed: evidence.viewport && evidence.viewport.chosen ? evidence.viewport.chosen.method : 'unknown',
    },
    {
      id: 'appearance-turn',
      fact: 'the palette checks drove POST /api/prefs with background ' + customPalette.background + ' and accent ' + customPalette.accent + ' (wallpaperVisible=false), the light-background check used ' + lightBackground + ', and the greeting checks used custom text before restoring the text observed at start',
      consequence: 'screenshots 01-07 were captured before this phase, so they show an uncustomised install; 08 and 09 are the customised captures. The inline --zct-accent on #zct-ui-root is proven through the panel control path because an external POST does not refresh the client\'s in-memory prefs (see notes)',
      observed: 'shipped palette final state: --color-primary=' + (finalSnap && finalSnap.tokens ? finalSnap.tokens.colorPrimary : 'unknown') + ', inline --zct-accent="' + (finalSnap && finalSnap.uiRootAccent ? finalSnap.uiRootAccent.inline : 'unknown') + '"',
    },
  ];
  evidence.finishedAt = new Date().toISOString();
  fs.writeFileSync(args.evidence, JSON.stringify(evidence, null, 2));
  try { ws.close(); } catch (e) {}
  console.log(JSON.stringify({ mode: 'verify', summary: evidence.summary, failed: checks.checks.filter((c) => c.status === 'fail').map((c) => c.name), notTested: checks.checks.filter((c) => c.status === 'not-tested').map((c) => c.name) }));
  return evidence.summary.failed === 0 ? 0 : 1;
}

// --------------------------------------------------------------- utilities --
function safeJson(text) {
  try { return JSON.parse(text); } catch (e) { return null; }
}

function trimSnapshot(s) {
  if (!s) return null;
  return {
    viewport: s.viewport, ids: s.ids, elementCount: s.elementCount, htmlBannerAttr: s.htmlBannerAttr,
    bannerVar: s.bannerVar, bannerVarInline: s.bannerVarInline, tokens: s.tokens,
    banner: s.banner, root: s.root, composer: s.composer, account: s.account, htmlScroll: s.htmlScroll,
    dock: s.dock, pet: s.pet, panel: s.panel, tracks: s.tracks, boot: s.boot, client: s.client,
    uiRootTheme: s.uiRootTheme, uiRootAccent: s.uiRootAccent, greeting: s.greeting, secretScan: s.secretScan,
  };
}

/** Parses the colour forms the renderer reports (`#rgb`, `#rrggbb`, `rgb()`). */
function parseColor(value) {
  const s = String(value || '').trim().toLowerCase();
  let m = /^#([0-9a-f]{6})$/.exec(s);
  if (m) return { r: parseInt(m[1].slice(0, 2), 16), g: parseInt(m[1].slice(2, 4), 16), b: parseInt(m[1].slice(4, 6), 16) };
  m = /^#([0-9a-f]{3})$/.exec(s);
  if (m) return { r: parseInt(m[1][0] + m[1][0], 16), g: parseInt(m[1][1] + m[1][1], 16), b: parseInt(m[1][2] + m[1][2], 16) };
  m = /^rgba?\(([^)]+)\)$/.exec(s);
  if (m) {
    const parts = m[1].split(',').map((p) => Number(p.trim()));
    if (parts.length >= 3 && parts.slice(0, 3).every((v) => Number.isFinite(v))) return { r: parts[0], g: parts[1], b: parts[2] };
  }
  return null;
}

/** WCAG relative luminance, 0-1. */
function relativeLuminance(rgb) {
  const lin = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b);
}

/** WCAG contrast ratio between two colours, rounded to two decimals. */
function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

// Closes the settings centre and the dock through their own controls, so a
// screenshot shows the resting surface rather than a state this script forced
// by writing to the DOM.
async function closeSurfaces(send) {
  const state = await evaluate(send, '(function(){ var p = document.getElementById("zct-panel"); var d = document.getElementById("zct-dock"); return { panelOpen: p ? p.hidden === false : false, dockOpen: d ? d.hidden === false : false }; })()');
  if (state && state.panelOpen) {
    await pressKey(send, { key: 'Escape', code: 'Escape', vk: 27 });
    await sleep(400);
  }
  const dock = await evaluate(send, '(function(){ var d = document.getElementById("zct-dock"); return d ? d.hidden === false : false; })()');
  if (dock) {
    await evaluate(send, CLICK_SEQ('zct-dock-fab'));
    await sleep(500);
  }
  return { was: state };
}

async function pressKey(send, spec) {
  const base = { key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.vk, nativeVirtualKeyCode: spec.vk };
  await send('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, base));
  await send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base));
}

function writeWavFixture(file) {
  const sampleRate = 48000;
  const seconds = 0.4;
  const freq = 440;
  const samples = Math.round(sampleRate * seconds);
  const dataSize = samples * 2;
  const byteRate = sampleRate * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples; i += 1) {
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / sampleRate) * 12000), 44 + i * 2);
  }
  fs.writeFileSync(file, buf);
  return { file: file, bytes: buf.length, sampleRate: sampleRate, channels: 1, bitsPerSample: 16, dataBytes: dataSize, expectedDurationSeconds: dataSize / byteRate };
}

async function runClose(args) {
  const base = 'http://127.0.0.1:' + args.port;
  const result = { tool: 'tools/verify-v02.mjs', mode: 'close', at: new Date().toISOString(), port: args.port };
  let version = null;
  try { version = await httpJson(base + '/json/version', 4000); } catch (err) { result.error = 'no CDP endpoint: ' + String((err && err.message) ? err.message : err); }
  if (version) {
    try {
      const ws = await connect(version.webSocketDebuggerUrl, 5000);
      const send = makeSender(ws);
      try {
        await Promise.race([send('Browser.close'), sleep(3000)]);
        result.browserClose = 'sent';
      } catch (err) {
        result.browserClose = 'sent';
        result.browserCloseNote = 'no reply before close: ' + String((err && err.message) ? err.message : err);
      }
      try { ws.close(); } catch (e) {}
    } catch (err) {
      result.browserClose = 'connect failed: ' + String((err && err.message) ? err.message : err);
    }
  }
  let released = false;
  for (let i = 0; i < 30; i += 1) {
    try { await httpJson(base + '/json/version', 1200); } catch (err) { released = true; break; }
    await sleep(500);
  }
  result.portReleased = released;
  if (args.evidence) { try { fs.writeFileSync(args.evidence, JSON.stringify(result, null, 2)); } catch (e) { /* driver reports */ } }
  console.log(JSON.stringify(result));
  return released ? 0 : 1;
}

main().then((code) => { process.exitCode = code; }).catch((err) => {
  console.error(JSON.stringify({ error: String((err && err.message) ? err.message : err) }));
  process.exitCode = 2;
});
