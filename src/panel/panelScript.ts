/**
 * The injected settings panel: a floating, draggable panel in the ZCode
 * renderer for live-tuning blur/dim, choosing the color mode (Monet / Tarkov /
 * Native), toggling wallpaper visibility, and swapping the wallpaper image —
 * all via the local API started by `zcode-tarkov serve`.
 *
 * The script always rebuilds the panel, so a stale copy left in the DOM can
 * never shadow a newer script version, and it is safe to re-evaluate on every
 * injection or reload.
 *
 * The panel's own skin is driven entirely by CSS custom properties declared on
 * `#zcode-beautify-panel-root`. Tarkov mode flips one `data-zb-theme` attribute
 * that overrides those properties, so leaving Tarkov restores the neutral look
 * with no leftover state.
 */

export const PANEL_ROOT_ID = "zcode-beautify-panel-root";

export function buildPanelScript(apiPort: number, token: string): string {
  const api = `http://127.0.0.1:${apiPort}`;
  return `(function(){
  var API = ${JSON.stringify(api)};
  var TOKEN = ${JSON.stringify(token)};
  var ROOT_ID = ${JSON.stringify(PANEL_ROOT_ID)};
  // Always rebuild: an older panel left in the DOM would otherwise shadow the
  // current script version forever (the old build skipped installation).
  var stale = document.getElementById(ROOT_ID);
  if (stale) stale.remove();
  var staleStyle = document.getElementById('zcode-beautify-panel-style');
  if (staleStyle) staleStyle.remove();

  var css = [
    // --- neutral skin (Monet / Native) as the default variable set ---------
    '#zcode-beautify-panel-root {',
      ' --zb-bg: rgba(24,24,30,.88);',
      ' --zb-border: rgba(255,255,255,.12);',
      ' --zb-radius: 12px;',
      ' --zb-radius-sm: 6px;',
      ' --zb-radius-pill: 999px;',
      ' --zb-text: #e8e8ea;',
      ' --zb-muted: rgba(255,255,255,.1);',
      ' --zb-ctl-bg: rgba(255,255,255,.09);',
      ' --zb-ctl-border: rgba(255,255,255,.14);',
      ' --zb-ctl-hover: rgba(255,255,255,.16);',
      ' --zb-accent: #7aa2f7;',
      ' --zb-shadow: 0 8px 32px rgba(0,0,0,.45);',
      ' --zb-font: system-ui, sans-serif; }',
    // --- Tarkov skin: deep brown, warm orange, squarer corners ------------
    '#zcode-beautify-panel-root[data-zb-theme="tarkov"] {',
      ' --zb-bg: rgba(26,18,10,.94);',
      ' --zb-border: rgba(224,121,48,.45);',
      ' --zb-radius: 4px;',
      ' --zb-radius-sm: 3px;',
      ' --zb-radius-pill: 3px;',
      ' --zb-text: #e8d9c8;',
      ' --zb-muted: rgba(224,121,48,.28);',
      ' --zb-ctl-bg: rgba(224,121,48,.14);',
      ' --zb-ctl-border: rgba(224,121,48,.35);',
      ' --zb-ctl-hover: rgba(224,121,48,.26);',
      ' --zb-accent: #e07930;',
      ' --zb-shadow: 0 8px 28px rgba(0,0,0,.6); }',

    '#zcode-beautify-panel-root, #zcode-beautify-panel-root * { box-sizing: border-box; font-family: var(--zb-font); }',
    '#zcode-beautify-panel-root { position: fixed; inset: auto; z-index: 2147483647; font-size: 12px; color: var(--zb-text); }',
    '#zb-fab { position: fixed; right: 18px; bottom: 18px; width: 34px; height: 34px; border-radius: var(--zb-radius-pill);',
      ' background: var(--zb-bg); border: 1px solid var(--zb-border); cursor: pointer;',
      ' display: flex; align-items: center; justify-content: center; backdrop-filter: blur(10px);',
      ' box-shadow: 0 2px 12px rgba(0,0,0,.35); user-select: none; font-size: 15px; line-height: 1; }',
    '#zb-fab:hover { background: var(--zb-ctl-hover); }',
    '#zb-panel { position: fixed; right: 18px; bottom: 60px; width: 264px; padding: 0 0 10px;',
      ' background: var(--zb-bg); border: 1px solid var(--zb-border); border-radius: var(--zb-radius);',
      ' backdrop-filter: blur(16px); box-shadow: var(--zb-shadow); user-select: none; }',
    '#zb-panel[hidden] { display: none; }',
    '#zb-head { padding: 9px 12px; font-weight: 600; cursor: move; border-bottom: 1px solid var(--zb-border);',
      ' display: flex; justify-content: space-between; align-items: center; }',
    '#zb-close { cursor: pointer; opacity: .7; padding: 0 4px; } #zb-close:hover { opacity: 1; }',
    '#zb-body { padding: 10px 12px 0; }',
    '.zb-row { margin-bottom: 10px; }',
    '.zb-row label { display: flex; justify-content: space-between; margin-bottom: 4px; opacity: .85; }',
    '#zb-panel input[type=range] { width: 100%; accent-color: var(--zb-accent); height: 18px; margin: 0; cursor: pointer; }',
    '.zb-toggles { display: flex; justify-content: center; gap: 16px; }',
    '.zb-toggles label { display: flex; align-items: center; gap: 5px; margin: 0; cursor: pointer; }',
    '.zb-actions { display: flex; justify-content: center; gap: 10px; }',
    '.zb-btn { display: inline-block; padding: 6px 20px; text-align: center; border-radius: var(--zb-radius-pill); cursor: pointer;',
      ' background: var(--zb-ctl-bg); border: 1px solid var(--zb-ctl-border); color: inherit; font-size: 12px; }',
    '.zb-btn:hover { background: var(--zb-ctl-hover); }',
    '#zb-status { min-height: 14px; padding: 2px 12px 0; opacity: .6; font-size: 11px; }',
    '#zb-offline { display: flex; flex-direction: column; gap: 6px; align-items: center;',
      ' padding: 10px 12px; background: rgba(120,53,15,.55); font-size: 11px; line-height: 1.5; text-align: center; }',
    '#zb-offline[hidden] { display: none; }',
    '#zb-offline code { background: rgba(0,0,0,.35); padding: 1px 4px; border-radius: var(--zb-radius-sm);',
      ' font-size: 10px; user-select: text; }',
    '#zb-offline .zb-hint { opacity: .85; }',
    // While offline the controls hold nothing we could read, so they must not
    // look interactive — a slider parked mid-track next to a "0px" label reads
    // as a real (wrong) setting.
    '#zcode-beautify-panel-root[data-offline="1"] #zb-body { opacity: .45; pointer-events: none; }',
    '#zcode-beautify-panel-root[data-offline="1"] #zb-status { display: none; }',
    '#zcode-beautify-panel-root[data-offline="1"] #zb-fab { border-color: rgba(248,113,113,.7); }',
    '#zb-needs-relaunch { display: flex; flex-direction: column; gap: 6px; align-items: center;',
      ' padding: 10px 12px; background: rgba(120,53,15,.45); font-size: 11px; line-height: 1.5; text-align: center; }',
    '#zb-needs-relaunch[hidden] { display: none; }',
    '#zb-recovery, #zb-theme { width: 100%; padding: 4px 6px; border-radius: var(--zb-radius-sm); font-size: 11px; color: inherit;',
      ' background: var(--zb-ctl-bg); border: 1px solid var(--zb-ctl-border); }',
    '#zb-recovery option, #zb-theme option { color: #111; }',
    '#zb-recovery-hint { margin-top: 4px; opacity: .65; font-size: 10px; line-height: 1.45; }',
    // Tarkov accents the active theme row so the current mode reads at a glance.
    '#zcode-beautify-panel-root[data-zb-theme="tarkov"] #zb-theme { border-color: var(--zb-accent); }'
  ].join('');

  var style = document.createElement('style');
  style.id = 'zcode-beautify-panel-style';
  style.textContent = css;
  (document.head || document.documentElement).appendChild(style);

  var root = document.createElement('div');
  root.id = ROOT_ID;
  root.innerHTML =
    '<div id="zb-fab" title="ZCode Tarkov">🎨</div>' +
    '<div id="zb-panel" hidden>' +
    '  <div id="zb-head"><span id="zb-title">ZCode Tarkov</span><span id="zb-close">✕</span></div>' +
    '  <div id="zb-offline" hidden>' +
    '    <div>⚠ 美化服务未运行,面板不可用</div>' +
    '    <div class="zb-hint">请从 ZCode Tarkov 快捷方式重新启动 ZCode,服务会自动恢复</div>' +
    '    <button class="zb-btn" id="zb-retry">重试连接</button>' +
    '  </div>' +
    '  <div id="zb-needs-relaunch" hidden>' +
    '    <div>⚠ ZCode 美化插件还没生效,需要重启一下 ZCode</div>' +
    '    <button class="zb-btn" id="zb-relaunch">立即重启 ZCode</button>' +
    '  </div>' +
    '  <div id="zb-body">' +
    '    <div class="zb-row">' +
    '      <label for="zb-theme" title="UI 配色来源:Monet 从壁纸取色,Tarkov 使用固定战术配色,Native 保留 ZCode 原生颜色"><span>UI Theme</span></label>' +
    '      <select id="zb-theme">' +
    '        <option value="monet">Monet · 壁纸取色</option>' +
    '        <option value="tarkov">Tarkov · 战术界面</option>' +
    '        <option value="native">Native · ZCode 原生</option>' +
    '      </select>' +
    '    </div>' +
    '    <div class="zb-row"><label title="背景模糊程度(像素)"><span>背景模糊</span><span><span id="zb-blur-val">0</span>px</span></label>' +
    '      <input type="range" id="zb-blur" min="0" max="30" step="1" value="0"></div>' +
    '    <div class="zb-row"><label title="背景压暗程度(百分比,越高越暗)"><span>背景压暗</span><span><span id="zb-dim-val">0</span>%</span></label>' +
    '      <input type="range" id="zb-dim" min="0" max="80" step="1" value="0"></div>' +
    '    <div class="zb-row zb-toggles">' +
    '      <label title="显示或隐藏背景壁纸"><input type="checkbox" id="zb-vis">显示壁纸</label>' +
    '    </div>' +
    '    <div class="zb-row zb-actions">' +
    '      <button class="zb-btn" id="zb-fit" title="背景填充方式:填满裁剪铺满窗口 / 完整显示不裁剪(模糊垫底)/ 智能适配自动分析画面主体">背景填充: …</button>' +
    '    </div>' +
    '    <div class="zb-row zb-actions">' +
    '      <label class="zb-btn" for="zb-file" title="选择一张图片作为背景壁纸">更换图片…</label>' +
    '      <input type="file" id="zb-file" accept="image/*" hidden>' +
    '    </div>' +
    '    <div class="zb-row zb-actions">' +
    '      <button class="zb-btn" id="zb-reset" title="移除壁纸与配色,还原 ZCode 默认外观(壁纸会被记住,可再次恢复)">还原默认外观</button>' +
    '    </div>' +
    '    <div class="zb-row" style="border-top:1px solid var(--zb-border);padding-top:8px">' +
    '      <label title="ZCode 每次重启都会丢掉壁纸和配色,这里决定由谁来把它们恢复回来"><span>自动恢复</span></label>' +
    '      <select id="zb-recovery">' +
    '        <option value="off">关闭</option>' +
    '        <option value="on-start">ZCode 启动时恢复</option>' +
    '        <option value="always">后台常驻(可用本面板)</option>' +
    '      </select>' +
    '      <div id="zb-recovery-hint"></div>' +
    '    </div>' +
    '  </div>' +
    '</div>' +
    '<div id="zb-status"></div>';
  document.body.appendChild(root);

  function $(id) { return document.getElementById(id); }
  function wallpaperEl() { return document.getElementById('zcode-beautify-wallpaper'); }
  function status(msg) {
    var el = $('zb-status'); if (!el) return;
    el.textContent = msg;
    setTimeout(function () { if (el.textContent === msg) el.textContent = ''; }, 2200);
  }
  function auth(extra) {
    var h = extra || {};
    h['x-zb-token'] = TOKEN;
    return h;
  }
  function post(path, body, cb) {
    fetch(API + path, { method: 'POST', headers: auth({ 'Content-Type': 'application/json' }), body: JSON.stringify(body) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.error) { status('操作失败: ' + d.error); return; }
        if (cb) cb(d);
      })
      .catch(function () { status('无法连接美化服务 service unreachable'); });
  }

  // The panel wears the same skin as the page, so the mode is obvious from the
  // panel alone. Only the attribute changes; the CSS variables do the rest.
  function applyPanelSkin(mode) {
    if (mode === 'tarkov') root.setAttribute('data-zb-theme', 'tarkov');
    else root.removeAttribute('data-zb-theme');
    var title = $('zb-title');
    if (title) title.textContent = mode === 'tarkov' ? 'ZCode Tarkov' : 'ZCode Beautify';
    var fab = $('zb-fab');
    if (fab) fab.title = mode === 'tarkov' ? 'ZCode Tarkov' : 'ZCode Beautify';
  }

  // Local live preview; the server re-injects the authoritative CSS right after.
  function preview() {
    var w = wallpaperEl(); if (!w) return;
    var b = Number($('zb-blur').value), d = Number($('zb-dim').value);
    w.style.filter = b > 0 ? 'blur(' + b + 'px)' : 'none';
    w.style.transform = b > 0 ? 'scale(1.04)' : 'none';
    document.documentElement.style.setProperty('--zcode-beautify-dim', String(d / 100));
  }

  var pushTimer = null;
  function pushConfig() {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(function () {
      post('/api/config', {
        blur: Number($('zb-blur').value),
        dim: Number($('zb-dim').value),
        colorMode: $('zb-theme').value,
        wallpaperVisible: $('zb-vis').checked
      }, function (d) { status(d && d.windows > 0 ? '已应用 applied' : '已保存(ZCode 未连接)'); });
    }, 300);
  }

  // The control service lives in a separate process that can stop or die. When
  // it is unreachable the panel must say so instead of rendering values it
  // never read, and it must recover on its own once the service is back.
  var beatTimer = null;
  function panelOpen() { return !$('zb-panel').hidden; }
  /** Re-check the service: while the panel is open, and always while offline. */
  function beat(on) {
    if (on && !beatTimer) beatTimer = setInterval(function () { refresh(); refreshStatus(); }, 4000);
    if (!on && beatTimer) { clearInterval(beatTimer); beatTimer = null; }
  }

  function setOffline(on) {
    root.setAttribute('data-offline', on ? '1' : '0');
    $('zb-offline').hidden = !on;
    $('zb-retry').textContent = '重试连接';
    $('zb-fab').title = on ? 'ZCode Tarkov — 美化服务未运行' : 'ZCode Tarkov';
    if (on) {
      $('zb-blur').value = 0; $('zb-blur-val').textContent = '0';
      $('zb-dim').value = 0; $('zb-dim-val').textContent = '0';
      $('zb-theme').value = 'monet';
      applyPanelSkin('monet');
      $('zb-vis').checked = false;
      $('zb-fit').textContent = '背景填充: 未知';
      $('zb-fit').removeAttribute('data-fit');
      $('zb-reset').textContent = '还原默认外观';
      $('zb-reset').setAttribute('data-mode', 'reset');
      beat(true);
    } else {
      if (!panelOpen()) beat(false);
    }
  }

  function refresh() {
    fetch(API + '/api/config', { headers: auth() })
      .then(function (r) { return r.json(); })
      .then(function (c) {
        setOffline(false);
        $('zb-blur').value = c.blur; $('zb-blur-val').textContent = c.blur;
        $('zb-dim').value = c.dim; $('zb-dim-val').textContent = c.dim;
        // Older services only report the legacy monet boolean; derive the mode
        // from it so the panel still shows the truth during a version mismatch.
        var mode = c.colorMode || (c.monet ? 'monet' : 'native');
        $('zb-theme').value = mode;
        applyPanelSkin(mode);
        $('zb-vis').checked = !!c.wallpaperVisible;
        $('zb-fit') && applyFitLabel($('zb-fit'), c.fit || 'cover');
        var resetBtn = $('zb-reset');
        if (c.wallpaperSet) {
          resetBtn.textContent = '还原默认外观';
          resetBtn.setAttribute('data-mode', 'reset');
          resetBtn.title = '移除壁纸与配色,还原 ZCode 默认外观(壁纸会被记住,可再次恢复)';
        } else if (c.hasBackup) {
          resetBtn.textContent = '恢复我的壁纸';
          resetBtn.setAttribute('data-mode', 'restore');
          resetBtn.title = '从备份恢复你之前的壁纸与配色';
        } else {
          resetBtn.textContent = '还原默认外观';
          resetBtn.setAttribute('data-mode', 'reset');
          resetBtn.title = '当前已是默认外观';
        }
      })
      .catch(function () { setOffline(true); });
  }

  $('zb-blur').addEventListener('input', function () {
    $('zb-blur-val').textContent = this.value; preview(); pushConfig();
  });
  $('zb-dim').addEventListener('input', function () {
    $('zb-dim-val').textContent = this.value; preview(); pushConfig();
  });
  // Theme switches must feel immediate: repaint the panel skin from the chosen
  // value right away, then let the server push the authoritative page CSS.
  $('zb-theme').addEventListener('change', function () {
    applyPanelSkin(this.value);
    pushConfig();
  });
  $('zb-vis').addEventListener('change', pushConfig);

  var FITS = ['cover', 'contain', 'smart'];
  var FIT_LABELS = { cover: '填满裁剪', contain: '完整显示', smart: '智能适配' };
  function applyFitLabel(btn, fit) {
    btn.textContent = '背景填充: ' + (FIT_LABELS[fit] || fit);
    btn.setAttribute('data-fit', fit);
  }
  $('zb-fit').addEventListener('click', function () {
    var current = this.getAttribute('data-fit') || 'cover';
    var next = FITS[(FITS.indexOf(current) + 1) % FITS.length];
    applyFitLabel(this, next);
    post('/api/config', { fit: next }, function (d) { status(d && d.windows > 0 ? '已应用:' + FIT_LABELS[next] : '已保存(ZCode 未连接)'); });
  });

  $('zb-file').addEventListener('change', function () {
    var f = this.files && this.files[0];
    this.value = '';
    if (!f) return;
    if (f.size > 20 * 1024 * 1024) { status('图片过大,上限 20 MB'); return; }
    var fr = new FileReader();
    fr.onload = function () {
      post('/api/wallpaper', { dataUri: fr.result, name: f.name }, function () { status('壁纸已更新 updated'); });
    };
    fr.readAsDataURL(f);
  });

  $('zb-reset').addEventListener('click', function () {
    var mode = this.getAttribute('data-mode') || 'reset';
    post(mode === 'restore' ? '/api/restore' : '/api/reset', {}, function () {
      if (mode === 'reset') {
        try { localStorage.removeItem('zcode-beautify:css'); localStorage.removeItem('zcode-beautify:wallpaper'); } catch (e) {}
        status('已还原默认外观');
      } else {
        status('已恢复你的壁纸');
      }
      refresh();
    });
  });

  $('zb-retry').addEventListener('click', function () {
    this.textContent = '正在重试…';
    refresh();
  });

  // The service answers but ZCode is not listening for it: either the app is
  // closed, or it came up without the debug port. The second case is the one
  // the plugin cannot fix on its own, and the only lever is a proper restart.
  var RECOVERY_HINTS = {
    off: 'ZCode 重启后不会自动恢复,需要手动重新应用。',
    'on-start': 'ZCode 每次启动时自动恢复一次,不占内存;设置面板不会自动出现。',
    always: '后台常驻一个小服务(约 60MB 内存),壁纸自动恢复,设置面板随时可用。'
  };

  function applyStatus(s) {
    $('zb-needs-relaunch').hidden = !(s && !s.cdpReachable && s.zcodeRunning);
    if (s && s.recovery) {
      var sel = $('zb-recovery');
      if (sel && document.activeElement !== sel) sel.value = s.recovery.mode;
      var hint = $('zb-recovery-hint');
      if (hint) hint.textContent = RECOVERY_HINTS[s.recovery.mode] || '';
    }
  }

  function refreshStatus() {
    fetch(API + '/api/status', { headers: auth() })
      .then(function (r) { return r.json(); })
      .then(applyStatus)
      .catch(function () { /* the offline banner already covers this */ });
  }

  $('zb-relaunch').addEventListener('click', function () {
    var btn = this;
    btn.textContent = '正在重启 ZCode,请稍候…';
    btn.disabled = true;
    post('/api/relaunch', {}, function () {
      btn.textContent = '立即重启 ZCode';
      btn.disabled = false;
      status('ZCode 已重启,壁纸马上回来');
      setTimeout(refresh, 2000);
      setTimeout(refreshStatus, 3000);
    });
  });

  $('zb-recovery').addEventListener('change', function () {
    var value = this.value;
    post('/api/recovery', { mode: value }, function () {
      var hint = $('zb-recovery-hint');
      if (hint) hint.textContent = RECOVERY_HINTS[value] || '';
      status('自动恢复设置已保存');
    });
  });

  $('zb-fab').addEventListener('click', function () {
    var p = $('zb-panel');
    p.hidden = !p.hidden;
    if (!p.hidden) {
      refresh();
      refreshStatus();
      beat(true);
    } else if (root.getAttribute('data-offline') !== '1') {
      beat(false);
    }
  });
  $('zb-close').addEventListener('click', function () {
    $('zb-panel').hidden = true;
    if (root.getAttribute('data-offline') !== '1') beat(false);
  });

  // Fill in the fit label (and control values) right away, not just on open.
  refresh();
  refreshStatus();

  (function () {
    var head = $('zb-head'), panel = $('zb-panel');
    var sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    head.addEventListener('pointerdown', function (e) {
      dragging = true; sx = e.clientX; sy = e.clientY;
      var r = panel.getBoundingClientRect(); ox = r.left; oy = r.top;
      panel.style.right = 'auto'; panel.style.bottom = 'auto';
      head.setPointerCapture(e.pointerId);
    });
    head.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var x = Math.max(4, Math.min(window.innerWidth - 80, ox + e.clientX - sx));
      var y = Math.max(4, Math.min(window.innerHeight - 60, oy + e.clientY - sy));
      panel.style.left = x + 'px'; panel.style.top = y + 'px';
    });
    head.addEventListener('pointerup', function () { dragging = false; });
  })();

  // Self-heal: if the theme style is missing but a previous injection saved it,
  // restore it from localStorage.
  if (!document.getElementById('zcode-beautify-style')) {
    var savedCss = null, savedWp = null;
    try {
      savedCss = localStorage.getItem('zcode-beautify:css');
      savedWp = localStorage.getItem('zcode-beautify:wallpaper');
    } catch (e) {}
    if (savedCss) {
      var s = document.createElement('style');
      s.id = 'zcode-beautify-style';
      s.textContent = savedCss;
      (document.head || document.documentElement).appendChild(s);
      if (savedWp && !wallpaperEl()) {
        var w = document.createElement('div');
        w.id = 'zcode-beautify-wallpaper';
        document.documentElement.appendChild(w);
        w.style.backgroundImage = 'url(' + savedWp + ')';
      }
    }
  }
})();`;
}
