/* TTS Service 配置界面 · 单文件前端（无构建） */
(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var state = { overview: null, voices: null, keys: null, route: '' };
  var timer = null;
  var audioUrl = null;

  // ---------------------------------------------------------------- 工具

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtTime(ts) {
    if (!ts) return '—';
    var d = new Date(Number(ts) * 1000);
    var p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function fmtDuration(seconds) {
    var s = Math.max(0, Math.floor(Number(seconds) || 0));
    var d = Math.floor(s / 86400);
    var h = Math.floor((s % 86400) / 3600);
    var m = Math.floor((s % 3600) / 60);
    if (d) return d + ' 天 ' + h + ' 小时';
    if (h) return h + ' 小时 ' + m + ' 分';
    if (m) return m + ' 分';
    return s + ' 秒';
  }

  function fmtBytes(n) {
    var v = Number(n) || 0;
    if (v < 1024) return v + ' B';
    if (v < 1048576) return (v / 1024).toFixed(1) + ' KB';
    if (v < 1073741824) return (v / 1048576).toFixed(1) + ' MB';
    return (v / 1073741824).toFixed(2) + ' GB';
  }

  var toastTimer = null;
  function toast(message, kind) {
    var node = $('#toast');
    node.textContent = message;
    node.className = 'toast' + (kind ? ' ' + kind : '');
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { node.hidden = true; }, 3600);
  }

  function openModal(options) {
    return new Promise(function (resolve) {
      var dlg = $('#modal');
      var body = $('#modal-body');
      $('#modal-title').textContent = options.title || '';
      body.innerHTML = options.html || '';
      var ok = $('#modal-ok');
      ok.textContent = options.okText || '确定';
      ok.className = 'btn ' + (options.danger ? 'btn-danger' : 'btn-primary');
      var cancel = $('#modal-cancel');
      cancel.classList.toggle('hidden', !!options.hideCancel);
      dlg.returnValue = '';
      function onClose() {
        dlg.removeEventListener('close', onClose);
        $('#modal-ok').onclick = null;
        $('#modal-cancel').onclick = null;
        resolve({ ok: dlg.returnValue === 'ok', body: body });
      }
      dlg.addEventListener('close', onClose);
      $('#modal-ok').onclick = function () { dlg.close('ok'); };
      $('#modal-cancel').onclick = function () { dlg.close('cancel'); };
      dlg.showModal();
      if (options.setup) options.setup(body);
      var first = body.querySelector('input, textarea, select');
      if (first) setTimeout(function () { first.focus(); }, 30);
    });
  }

  function confirmDialog(title, html, okText) {
    return openModal({ title: title, html: html, okText: okText || '确定', danger: true })
      .then(function (result) { return result.ok; });
  }

  function field(label, inputHtml, hint) {
    return '<label class="field"><span>' + esc(label) + '</span>' + inputHtml +
      (hint ? '<span class="field-hint">' + esc(hint) + '</span>' : '') + '</label>';
  }

  function revokeAudio() {
    if (audioUrl) { URL.revokeObjectURL(audioUrl); audioUrl = null; }
  }

  function baseName(path) {
    return String(path || '').split(/[\\/]/).pop();
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (error) {
      var area = document.createElement('textarea');
      area.value = text;
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
  }

  // ---------------------------------------------------------------- API

  async function api(path, options) {
    options = options || {};
    var init = {
      method: options.method || 'GET',
      credentials: 'same-origin',
      headers: { 'X-TTS-Admin': '1' }
    };
    if (options.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
    var response = await fetch(path, init);
    if (response.status === 401) {
      showGate('login');
      throw new Error('未登录或会话已过期');
    }
    var type = response.headers.get('content-type') || '';
    var payload = null;
    if (type.indexOf('application/json') >= 0) {
      payload = await response.json().catch(function () { return null; });
    }
    if (!response.ok) {
      var detail = payload && payload.detail ? payload.detail : ('HTTP ' + response.status);
      throw new Error(detail);
    }
    return payload;
  }

  // ---------------------------------------------------------------- 登录

  var gateMode = 'login';

  function showGate(mode) {
    gateMode = mode || 'login';
    $('#shell').hidden = true;
    $('#gate').hidden = false;
    var setup = gateMode === 'setup';
    $('#gate-sub').textContent = setup ? '首次使用：设置管理员口令（至少 8 位）' : '配置界面';
    $('#gate-label').textContent = setup ? '设置管理员口令' : '管理员口令';
    $('#gate-submit').textContent = setup ? '设置并进入' : '进入';
    $('#gate-password').value = '';
    $('#gate-error').textContent = '';
    setTimeout(function () { $('#gate-password').focus(); }, 40);
  }

  async function boot() {
    try {
      var response = await fetch('/admin/api/session', { credentials: 'same-origin' });
      var session = await response.json();
      if (session.authenticated) enterApp();
      else if (session.needs_setup) showGate('setup');
      else showGate('login');
    } catch (error) {
      showGate('login');
    }
  }

  $('#gate-form').addEventListener('submit', async function (event) {
    event.preventDefault();
    var password = $('#gate-password').value;
    if (!password) return;
    if (gateMode === 'setup' && password.length < 8) {
      $('#gate-error').textContent = '口令至少 8 位';
      return;
    }
    var submit = $('#gate-submit');
    submit.disabled = true;
    try {
      var endpoint = gateMode === 'setup' ? '/admin/api/setup' : '/admin/api/login';
      var response = await fetch(endpoint, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: password })
      });
      if (!response.ok) {
        var payload = await response.json().catch(function () { return {}; });
        throw new Error(payload.detail || ('HTTP ' + response.status));
      }
      $('#gate-error').textContent = '';
      enterApp();
    } catch (error) {
      $('#gate-error').textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  });

  function enterApp() {
    $('#gate').hidden = true;
    $('#shell').hidden = false;
    if (!location.hash) location.hash = '#/overview';
    route();
  }

  $('#btn-logout').addEventListener('click', async function () {
    await fetch('/admin/api/logout', { method: 'POST', credentials: 'same-origin' }).catch(function () {});
    showGate('login');
  });

  // ---------------------------------------------------------------- 主题

  var THEME_KEY = 'tts-admin-theme';
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch (error) { /* ignore */ }
  }
  (function initTheme() {
    var saved = null;
    try { saved = localStorage.getItem(THEME_KEY); } catch (error) { /* ignore */ }
    var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    applyTheme(saved || (prefersDark ? 'dark' : 'light'));
  })();
  $('#btn-theme').addEventListener('click', function () {
    applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
  });

  // ---------------------------------------------------------------- 路由

  var PAGES = {
    overview: '概览',
    requests: '最近请求',
    upstream: '上游进程',
    voices: '音色',
    keys: '客户端密钥',
    settings: '服务设置',
    security: '安全',
    guide: '接入示例'
  };

  var VIEWS = {};

  function route() {
    if ($('#shell').hidden) return;
    var hash = (location.hash || '#/overview').replace(/^#\/?/, '');
    var page = PAGES[hash] ? hash : 'overview';
    state.route = page;
    $('#brand-page').textContent = PAGES[page];
    Array.prototype.forEach.call(document.querySelectorAll('.nav-item'), function (item) {
      if (item.getAttribute('data-page') === page) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    });
    $('#view').innerHTML = '<div class="empty">加载中…</div>';
    (VIEWS[page] || VIEWS.overview)().catch(function (error) {
      $('#view').innerHTML = '<div class="note bad">加载失败：' + esc(error.message) + '</div>';
    });
    refreshChrome();
    clearTimeout(timer);
    if (page === 'overview' || page === 'requests' || page === 'upstream') {
      timer = setTimeout(function () { if (state.route === page) route(); }, 15000);
    }
  }

  window.addEventListener('hashchange', route);

  // ---------------------------------------------------------------- 概览

  function updateChrome(data) {
    var pill = $('#pill-upstream');
    pill.className = 'badge ' + (data.upstream.alive ? 'ok' : 'bad');
    pill.innerHTML = '<span class="dot"></span><span>上游' + (data.upstream.alive ? '在线' : '离线') + '</span>';
    $('#pill-listen').textContent = data.listen.host + ':' + data.listen.port;
    $('#status-left').textContent = 'v' + data.version + ' · ' + data.listen.host + ':' + data.listen.port;
    $('#status-right').textContent = '更新于 ' + new Date().toLocaleTimeString('zh-CN');
  }

  function refreshChrome() {
    api('/admin/api/overview').then(function (data) {
      state.overview = data;
      updateChrome(data);
    }).catch(function () { /* 顶栏只是显示，失败不打扰 */ });
  }

  function requestTable(rows) {
    if (!rows || !rows.length) return '<div class="empty">还没有请求</div>';
    var head = '<tr><th>时间</th><th>客户端</th><th>音色</th><th class="num">字符</th>' +
      '<th class="num">耗时</th><th class="num">字节</th><th>状态</th></tr>';
    var body = rows.map(function (row) {
      var ok = row.status >= 200 && row.status < 300;
      return '<tr><td class="mono">' + esc(fmtTime(row.ts)) + '</td>' +
        '<td>' + esc(row.client || '—') + '</td>' +
        '<td class="mono">' + esc(row.voice || '—') + '</td>' +
        '<td class="num">' + esc(row.chars || 0) + '</td>' +
        '<td class="num">' + esc(row.ms != null ? row.ms + ' ms' : '—') + '</td>' +
        '<td class="num">' + esc(row.bytes ? fmtBytes(row.bytes) : '—') + '</td>' +
        '<td>' + (ok
          ? '<span class="badge ok"><span class="dot"></span>' + esc(row.status) + '</span>'
          : '<span class="badge bad"><span class="dot"></span>' + esc(row.status) + '</span>' +
            (row.error ? ' <span class="p-text-xs fg-subtle">' + esc(String(row.error).slice(0, 60)) + '</span>' : '')) +
        '</td></tr>';
    }).join('');
    return '<div class="table-wrap"><table class="table"><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>';
  }

  VIEWS.overview = async function () {
    var data = await api('/admin/api/overview');
    state.overview = data;
    updateChrome(data);
    var counts = data.counts;
    var stat = function (label, value, note) {
      return '<div class="stat"><div class="stat-label">' + esc(label) + '</div>' +
        '<div class="stat-value">' + esc(value) + '</div>' +
        '<div class="stat-note">' + esc(note || '') + '</div></div>';
    };
    var html = '<div class="grid grid-3">';
    html += stat('合成请求', counts.speech_requests, '成功 ' + counts.speech_ok + ' / 失败 ' + counts.speech_failed);
    html += stat('合成字符', counts.chars, '累计输入字符数');
    html += stat('输出音频', fmtBytes(counts.bytes), '累计返回字节数');
    html += stat('在线时长', fmtDuration(counts.uptime_seconds), '本次进程启动至今');
    html += stat('音色', counts.voices, '默认：' + (data.defaults.voice || '未设置'));
    html += stat('客户端密钥', counts.keys_enabled + ' / ' + counts.keys, '启用 / 总数');
    html += '</div>';

    html += '<div class="card mt-16"><div class="card-head">服务状态</div><div class="card-body"><dl class="kv">';
    html += '<dt>版本</dt><dd>v' + esc(data.version) + '</dd>';
    html += '<dt>监听</dt><dd>' + esc(data.listen.host + ':' + data.listen.port) + '</dd>';
    html += '<dt>对外地址</dt><dd>' + esc(data.public_base_url) + '</dd>';
    html += '<dt>上游 TTS</dt><dd>' + esc(data.upstream.base) + ' ' +
      (data.upstream.alive ? '<span class="badge ok"><span class="dot"></span>在线</span>'
        : '<span class="badge bad"><span class="dot"></span>离线</span>') + '</dd>';
    html += '<dt>上游进程</dt><dd>' + (data.upstream.managed
      ? ('由本服务管理，PID ' + esc(data.upstream.pid))
      : '外部启动（不由本服务托管）') + '</dd>';
    html += '<dt>GPT-SoVITS</dt><dd>' + esc(data.upstream.install || '未找到安装目录') + '</dd>';
    html += '</dl>';

    var checks = [];
    if (!data.checks.has_admin_password) checks.push('未设置管理员口令');
    if (!data.checks.has_client_key) checks.push('没有启用的客户端密钥，外部客户端无法调用');
    if (!data.checks.install_found) checks.push('未找到 GPT-SoVITS 安装目录，音色编辑与上游启动不可用');
    if (!data.upstream.alive) checks.push('上游 TTS 未运行：合成会返回 503');
    if (checks.length) html += '<div class="note mt-16">需要处理：' + checks.map(esc).join('；') + '</div>';
    html += '</div></div>';

    html += '<div class="card"><div class="card-head">最近请求<span class="spacer"></span>' +
      '<span class="p-text-xs fg-muted">只记录长度与状态，不记录文本</span></div>' +
      '<div class="card-body tight">' + requestTable(data.recent) + '</div></div>';
    $('#view').innerHTML = html;
  };

  VIEWS.requests = async function () {
    var data = await api('/admin/api/requests?limit=100');
    $('#view').innerHTML = '<div class="card"><div class="card-head">最近请求<span class="spacer"></span>' +
      '<button class="btn btn-sm" id="refresh-requests" type="button">刷新</button></div>' +
      '<div class="card-body tight">' + requestTable(data.requests) + '</div></div>';
    $('#refresh-requests').addEventListener('click', function () { route(); });
  };

  // ---------------------------------------------------------------- 音色

  VIEWS.voices = async function () {
    var data = await api('/admin/api/voices');
    state.voices = data;
    var rows = data.voices.map(function (voice) {
      var isDefault = data.default === voice.id;
      var weights = [voice.gpt, voice.sovits].filter(Boolean);
      var weightText = weights.length ? weights.map(baseName).join(' / ') : '—';
      return '<tr>' +
        '<td class="mono nowrap">' + esc(voice.id) + (isDefault ? ' <span class="badge accent">默认</span>' : '') + '</td>' +
        '<td class="mono p-text-xs" title="' + esc(weights.join(' / ')) + '">' + esc(weightText) + '</td>' +
        '<td class="mono p-text-xs">' + esc(voice.ref_audio) + '</td>' +
        '<td class="nowrap">' + esc(voice.ref_lang) + ' → ' + esc(voice.text_lang) +
        (voice.auto_text_lang ? ' <span class="badge">自动</span>' : '') + '</td>' +
        '<td class="num">' + esc(voice.speed) + '</td>' +
        '<td class="nowrap"><div class="row gap-8">' +
        '<button class="btn btn-sm" data-act="voice-try" data-id="' + esc(voice.id) + '" type="button">试听</button>' +
        (isDefault ? '' : '<button class="btn btn-sm" data-act="voice-default" data-id="' + esc(voice.id) + '" type="button">设为默认</button>') +
        '<button class="btn btn-sm" data-act="voice-edit" data-id="' + esc(voice.id) + '" type="button">编辑</button>' +
        '<button class="btn btn-sm btn-danger" data-act="voice-del" data-id="' + esc(voice.id) + '" type="button">删除</button>' +
        '</div></td></tr>';
    }).join('');

    var weights = data.weights || { GPT: [], SoVITS: [] };
    var weightList = function (items) {
      if (!items.length) return '<div class="p-text-sm fg-muted">未扫描到权重文件</div>';
      return '<pre class="code">' + esc(items.map(function (item) { return item.rel; }).join('\n')) + '</pre>';
    };

    var html = '<div class="card"><div class="card-head">音色<span class="spacer"></span>' +
      '<span class="p-text-sm card-sub">默认：' + esc(data.default || '未设置') + '</span>' +
      '<button class="btn btn-sm btn-primary" id="voice-add" type="button">新增音色</button></div>' +
      '<div class="card-body tight">' +
      (rows ? '<div class="table-wrap"><table class="table"><thead><tr><th>ID</th><th>权重</th><th>参考音频</th>' +
        '<th>语言</th><th class="num">语速</th><th>操作</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
        : '<div class="empty">还没有音色。新增时需要一个参考音频与它的原文。</div>') +
      '</div></div>';
    html += '<div class="grid grid-2">' +
      '<div class="card"><div class="card-head">可用 GPT 权重</div><div class="card-body">' + weightList(weights.GPT) + '</div></div>' +
      '<div class="card"><div class="card-head">可用 SoVITS 权重</div><div class="card-body">' + weightList(weights.SoVITS) + '</div></div>' +
      '</div>';
    $('#view').innerHTML = html;
    $('#voice-add').addEventListener('click', function () { editVoice(null); });
  };

  async function editVoice(voice) {
    var v = voice || {};
    var html = field('音色 ID', '<input class="input mono" id="v-id" value="' + esc(v.id || '') + '"' +
      (voice ? ' readonly' : '') + ' placeholder="furina_normal">', '字母/数字/下划线/点/短横线');
    html += '<div class="form-grid">' +
      field('GPT 权重（.ckpt）', '<input class="input mono" id="v-gpt" value="' + esc(v.gpt || '') + '" placeholder="GPT_weights_v2Pro/xxx-e15.ckpt">') +
      field('SoVITS 权重（.pth）', '<input class="input mono" id="v-sovits" value="' + esc(v.sovits || '') + '" placeholder="SoVITS_weights_v2Pro/xxx_e8_s208.pth">') +
      '</div>';
    html += field('参考音频（相对 GPT-SoVITS 目录）', '<input class="input mono" id="v-ref" value="' + esc(v.ref_audio || '') + '" placeholder="refs/furina/furina_normal.wav">');
    html += field('参考音频原文（必须逐字一致）', '<textarea class="textarea" id="v-reftext" rows="3">' + esc(v.ref_text || '') + '</textarea>');
    html += '<div class="form-grid">' +
      field('参考语言', '<input class="input mono" id="v-reflang" value="' + esc(v.ref_lang || 'zh') + '">') +
      field('文本语言', '<input class="input mono" id="v-textlang" value="' + esc(v.text_lang || 'zh') + '">') +
      field('语速', '<input class="input mono" id="v-speed" type="number" step="0.05" min="0.5" max="2" value="' + esc(v.speed || 1) + '">') +
      '</div>';
    html += '<label class="switch"><input type="checkbox" id="v-autolang"' + (v.auto_text_lang === false ? '' : ' checked') + '>' +
      '<span class="switch-track"></span><span class="p-text-sm">按文本自动推断语言（推荐）</span></label>';

    var result = await openModal({ title: voice ? ('编辑音色 ' + voice.id) : '新增音色', html: html, okText: '保存' });
    if (!result.ok) return;
    var body = result.body;
    try {
      await api('/admin/api/voices', {
        method: 'POST',
        body: {
          id: body.querySelector('#v-id').value.trim(),
          gpt: body.querySelector('#v-gpt').value.trim(),
          sovits: body.querySelector('#v-sovits').value.trim(),
          ref_audio: body.querySelector('#v-ref').value.trim(),
          ref_text: body.querySelector('#v-reftext').value.trim(),
          ref_lang: body.querySelector('#v-reflang').value.trim() || 'zh',
          text_lang: body.querySelector('#v-textlang').value.trim() || 'zh',
          speed: parseFloat(body.querySelector('#v-speed').value) || 1,
          auto_text_lang: body.querySelector('#v-autolang').checked
        }
      });
      toast('已保存', 'ok');
      route();
    } catch (error) { toast(error.message, 'bad'); }
  }

  function tryVoice(voice) {
    if (!voice) return;
    var html = field('试听文本', '<textarea class="textarea" id="t-text" rows="3">茶会是淑女的必修课。如果你想学习茶会礼仪的话，我可以教你哦。</textarea>');
    html += '<div class="row gap-8"><button class="btn" id="t-run" type="button">合成并试听</button>' +
      '<span id="t-meta" class="p-text-xs fg-muted"></span></div>' +
      '<audio id="t-audio" controls></audio>';
    openModal({
      title: '试听音色 ' + voice.id,
      html: html,
      okText: '关闭',
      hideCancel: true,
      setup: function (body) {
        body.querySelector('#t-run').addEventListener('click', async function () {
          var button = body.querySelector('#t-run');
          var meta = body.querySelector('#t-meta');
          button.disabled = true;
          meta.textContent = '合成中…';
          try {
            var response = await fetch('/admin/api/test', {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json', 'X-TTS-Admin': '1' },
              body: JSON.stringify({ voice: voice.id, input: body.querySelector('#t-text').value })
            });
            if (!response.ok) {
              var payload = await response.json().catch(function () { return {}; });
              throw new Error(payload.detail || ('HTTP ' + response.status));
            }
            var ms = response.headers.get('x-tts-ms');
            var blob = await response.blob();
            revokeAudio();
            audioUrl = URL.createObjectURL(blob);
            var audio = body.querySelector('#t-audio');
            audio.src = audioUrl;
            audio.play().catch(function () {});
            meta.textContent = '完成：' + (ms || '?') + ' ms，' + fmtBytes(blob.size);
          } catch (error) {
            meta.textContent = '';
            toast(error.message, 'bad');
          } finally {
            button.disabled = false;
          }
        });
      }
    }).then(revokeAudio);
  }

  // ---------------------------------------------------------------- 密钥

  VIEWS.keys = async function () {
    var data = await api('/admin/api/keys');
    state.keys = data;
    var rows = (data.keys || []).map(function (key) {
      return '<tr data-id="' + esc(key.id) + '">' +
        '<td>' + esc(key.name) + (key.note ? '<div class="p-text-xs fg-subtle">' + esc(key.note) + '</div>' : '') + '</td>' +
        '<td class="mono">' + esc(key.mask) + '</td>' +
        '<td><label class="switch" title="启用/停用"><input type="checkbox" data-act="key-toggle"' + (key.enabled ? ' checked' : '') + '>' +
        '<span class="switch-track"></span></label></td>' +
        '<td class="num">' + esc(key.uses || 0) + '</td>' +
        '<td class="mono p-text-xs">' + esc(key.last_used_at ? fmtTime(key.last_used_at) : '从未') + '</td>' +
        '<td class="mono p-text-xs">' + esc(fmtTime(key.created_at)) + '</td>' +
        '<td><div class="row gap-8">' +
        '<button class="btn btn-sm" data-act="key-copy" type="button">复制</button>' +
        '<button class="btn btn-sm btn-danger" data-act="key-del" type="button">删除</button>' +
        '</div></td></tr>';
    }).join('');

    var html = '<div class="card"><div class="card-head">客户端密钥<span class="spacer"></span>' +
      '<button class="btn btn-sm btn-primary" id="key-add" type="button">创建密钥</button></div>' +
      '<div class="card-body tight">' +
      (rows ? '<div class="table-wrap"><table class="table"><thead><tr><th>名称</th><th>密钥</th><th>启用</th>' +
        '<th class="num">调用次数</th><th>最近使用</th><th>创建时间</th><th>操作</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
        : '<div class="empty">还没有密钥。外部客户端需要一个 sk- 开头的密钥才能调用。</div>') +
      '</div></div>' +
      '<div class="note info">密钥明文保存在服务器的 config.json 中，界面上默认只显示前后缀。' +
      '「复制」会重新取回完整密钥；怀疑泄露时删除并新建一把即可。</div>';
    $('#view').innerHTML = html;

    $('#key-add').addEventListener('click', async function () {
      var result = await openModal({
        title: '创建客户端密钥',
        html: field('用途名称', '<input class="input" id="k-name" placeholder="hub / dsh-plugin / phone">') +
          field('备注（可选）', '<input class="input" id="k-note" placeholder="用于哪台设备">'),
        okText: '创建'
      });
      if (!result.ok) return;
      try {
        var created = await api('/admin/api/keys', {
          method: 'POST',
          body: {
            name: result.body.querySelector('#k-name').value.trim(),
            note: result.body.querySelector('#k-note').value.trim()
          }
        });
        await openModal({
          title: '密钥已创建',
          html: '<p class="p-text-sm">完整密钥只在这里显示一次，请立即复制到客户端配置：</p>' +
            '<pre class="code" id="new-key">' + esc(created.key) + '</pre>' +
            '<button class="btn" id="copy-new" type="button">复制密钥</button>',
          okText: '完成',
          hideCancel: true,
          setup: function (body) {
            body.querySelector('#copy-new').addEventListener('click', function () {
              copyText(created.key).then(function () { toast('已复制', 'ok'); });
            });
          }
        });
        route();
      } catch (error) { toast(error.message, 'bad'); }
    });
  };

  // ---------------------------------------------------------------- 设置

  VIEWS.settings = async function () {
    var data = await api('/admin/api/settings');
    var voiceData = await api('/admin/api/voices');
    state.voices = voiceData;
    var voiceOptions = '<option value="">（不设置）</option>' + voiceData.voices.map(function (voice) {
      return '<option value="' + esc(voice.id) + '"' + (data.defaults.voice === voice.id ? ' selected' : '') + '>' +
        esc(voice.id) + '</option>';
    }).join('');

    var html = '<div class="card"><div class="card-head">监听与对外地址<span class="spacer"></span>' +
      '<span class="badge warn"><span class="dot"></span>改监听需要重启</span></div><div class="card-body"><div class="form-grid">';
    html += field('监听地址', '<select class="select" id="s-host">' +
      ['0.0.0.0', '127.0.0.1'].map(function (host) {
        return '<option value="' + host + '"' + (data.server.host === host ? ' selected' : '') + '>' + host + '</option>';
      }).join('') + '</select>', '0.0.0.0 = 局域网可访问');
    html += field('端口', '<input class="input mono" id="s-port" type="number" min="1" max="65535" value="' + esc(data.server.port) + '">');
    html += field('对外地址（写进示例）', '<input class="input mono" id="s-public" value="' + esc(data.server.public_base_url || '') + '" placeholder="http://192.168.1.166:18080">');
    html += '</div></div></div>';

    html += '<div class="card"><div class="card-head">上游 TTS</div><div class="card-body"><div class="form-grid">';
    html += field('上游地址', '<input class="input mono" id="s-upstream" value="' + esc(data.upstream.base) + '">', 'GPT-SoVITS api_v2.py 的地址');
    html += field('上游启动监听', '<input class="input mono" id="s-uphost" value="' + esc(data.upstream.api_host) + '">', '建议保持 127.0.0.1');
    html += field('上游端口', '<input class="input mono" id="s-upport" type="number" value="' + esc(data.upstream.api_port) + '">');
    html += field('上游配置', '<input class="input mono" id="s-upconfig" value="' + esc(data.upstream.config_path) + '">');
    html += field('上游日志路径', '<input class="input mono" id="s-uplog" value="' + esc(data.upstream.log_path || '') + '" placeholder="留空自动探测">');
    html += field('合成超时（秒）', '<input class="input mono" id="s-timeout" type="number" min="10" max="3600" value="' + esc(data.upstream.timeout_seconds) + '">');
    html += field('启动等待（秒）', '<input class="input mono" id="s-starttimeout" type="number" min="10" max="1800" value="' + esc(data.upstream.start_timeout_seconds) + '">');
    html += '</div></div></div>';

    html += '<div class="card"><div class="card-head">默认合成参数</div><div class="card-body"><div class="form-grid">';
    html += field('默认音色', '<select class="select" id="s-voice">' + voiceOptions + '</select>');
    html += field('输出格式', '<select class="select" id="s-format">' +
      ['wav', 'ogg', 'aac'].map(function (format) {
        return '<option value="' + format + '"' + (data.defaults.response_format === format ? ' selected' : '') + '>' +
          format + '</option>';
      }).join('') + '</select>');
    html += field('默认语速', '<input class="input mono" id="s-speed" type="number" step="0.05" min="0.5" max="2" value="' + esc(data.defaults.speed) + '">');
    html += field('单条最大字符', '<input class="input mono" id="s-maxchars" type="number" min="1" value="' + esc(data.limits.max_input_chars) + '">');
    html += field('最大并发', '<input class="input mono" id="s-concurrency" type="number" min="1" max="8" value="' + esc(data.limits.max_concurrent) + '">', '改并发需要重启');
    html += '</div></div></div>';

    html += '<div class="card"><div class="card-head">配置文件</div><div class="card-body"><dl class="kv">' +
      '<dt>路径</dt><dd>' + esc(data.config_path) + '</dd>' +
      '<dt>安装目录</dt><dd>' + esc(data.install || '未找到') + '</dd>' +
      '</dl></div></div>';

    html += '<div class="form-actions"><button class="btn btn-primary" id="s-save" type="button">保存设置</button>' +
      '<button class="btn" id="s-restart" type="button">重启服务</button>' +
      '<span id="s-hint" class="p-text-sm fg-muted"></span></div>';

    $('#view').innerHTML = html;

    $('#s-save').addEventListener('click', async function () {
      var body = {
        server: {
          host: $('#s-host').value,
          port: parseInt($('#s-port').value, 10) || 18080,
          public_base_url: $('#s-public').value.trim()
        },
        upstream: {
          base: $('#s-upstream').value.trim(),
          api_host: $('#s-uphost').value.trim() || '127.0.0.1',
          api_port: parseInt($('#s-upport').value, 10) || 9880,
          config_path: $('#s-upconfig').value.trim(),
          log_path: $('#s-uplog').value.trim(),
          timeout_seconds: parseInt($('#s-timeout').value, 10) || 600,
          start_timeout_seconds: parseInt($('#s-starttimeout').value, 10) || 180
        },
        defaults: {
          voice: $('#s-voice').value || null,
          response_format: $('#s-format').value,
          speed: parseFloat($('#s-speed').value) || 1
        },
        limits: {
          max_input_chars: parseInt($('#s-maxchars').value, 10) || 2000,
          max_concurrent: parseInt($('#s-concurrency').value, 10) || 2
        }
      };
      try {
        var result = await api('/admin/api/settings', { method: 'PUT', body: body });
        if (result.restart_required && result.restart_required.length) {
          $('#s-hint').innerHTML = '<span class="attention">已保存；' +
            esc(result.restart_required.join('、')) + ' 需要重启后生效</span>';
        } else {
          $('#s-hint').innerHTML = '<span class="success">已保存并立即生效</span>';
        }
        toast('设置已保存', 'ok');
      } catch (error) { toast(error.message, 'bad'); }
    });

    $('#s-restart').addEventListener('click', async function () {
      var ok = await confirmDialog('重启服务',
        '<p>服务会断开约 2–5 秒。由启动器（run-tts-service）托管时会自动重新拉起；否则需要手动启动。</p>', '重启');
      if (!ok) return;
      try {
        await api('/admin/api/restart', { method: 'POST' });
        toast('正在重启，稍后刷新页面', 'ok');
        setTimeout(function () { location.reload(); }, 4000);
      } catch (error) { toast(error.message, 'bad'); }
    });
  };

  // ---------------------------------------------------------------- 安全

  VIEWS.security = async function () {
    var overview = await api('/admin/api/overview');
    var html = '<div class="card"><div class="card-head">管理员口令</div><div class="card-body">' +
      '<div class="form-grid">' +
      field('当前口令', '<input class="input" id="p-current" type="password" autocomplete="current-password">') +
      field('新口令', '<input class="input" id="p-new" type="password" autocomplete="new-password">', '至少 8 位') +
      '</div>' +
      '<div class="form-actions"><button class="btn btn-primary" id="p-save" type="button">修改口令</button></div>' +
      '</div></div>';

    html += '<div class="card"><div class="card-head">暴露面</div><div class="card-body"><dl class="kv">' +
      '<dt>监听</dt><dd>' + esc(overview.listen.host + ':' + overview.listen.port) + '</dd>' +
      '<dt>对外地址</dt><dd>' + esc(overview.public_base_url) + '</dd>' +
      '<dt>客户端密钥</dt><dd>' + esc(overview.counts.keys_enabled) + ' 把启用 / ' + esc(overview.counts.keys) + ' 把总数</dd>' +
      '<dt>传输加密</dt><dd>HTTP（明文）；仅限可信局域网，不要直接映射到公网</dd>' +
      '</dl>' +
      '<div class="note mt-16">对外共享只开放 <span class="mono">/v1/audio/*</span>、<span class="mono">/v1/models</span> 与 <span class="mono">/healthz</span>；' +
      '配置界面的写操作要求管理员会话 Cookie 加自定义请求头，跨站表单无法直接改写配置。</div>' +
      '</div></div>';
    $('#view').innerHTML = html;

    $('#p-save').addEventListener('click', async function () {
      try {
        await api('/admin/api/password', {
          method: 'POST',
          body: { current: $('#p-current').value, password: $('#p-new').value }
        });
        toast('口令已修改', 'ok');
        $('#p-current').value = '';
        $('#p-new').value = '';
      } catch (error) { toast(error.message, 'bad'); }
    });
  };

  // ---------------------------------------------------------------- 上游

  VIEWS.upstream = async function () {
    var data = await api('/admin/api/upstream?tail=80');
    var alive = data.alive;
    var html = '<div class="card"><div class="card-head">上游状态<span class="spacer"></span>' +
      (alive ? '<span class="badge ok"><span class="dot"></span>在线</span>'
             : '<span class="badge bad"><span class="dot"></span>离线</span>') +
      '</div><div class="card-body"><dl class="kv">' +
      '<dt>地址</dt><dd>' + esc(data.base) + '</dd>' +
      '<dt>托管</dt><dd>' + (data.managed ? ('是（PID ' + esc(data.pid) + '，' + esc(data.started_at) + ' 启动）') : '否') + '</dd>' +
      '<dt>安装目录</dt><dd>' + esc(data.install || '未找到') + '</dd>' +
      '<dt>日志</dt><dd>' + esc(data.log_path) + '</dd>' +
      '</dl>' +
      '<div class="form-actions">' +
      '<button class="btn btn-primary" id="u-start" type="button">启动上游</button>' +
      '<button class="btn btn-danger" id="u-stop" type="button">停止上游</button>' +
      '<button class="btn" id="u-refresh" type="button">刷新</button>' +
      '<span id="u-hint" class="p-text-sm fg-muted"></span></div>' +
      '</div></div>' +
      '<div class="card"><div class="card-head">上游日志（末尾 80 行）</div><div class="card-body tight">' +
      '<pre class="log">' + esc((data.log_tail || []).join('\n') || '（没有日志）') + '</pre></div></div>';
    $('#view').innerHTML = html;

    $('#u-refresh').addEventListener('click', function () { route(); });
    $('#u-start').addEventListener('click', async function () {
      var button = $('#u-start');
      button.disabled = true;
      $('#u-hint').textContent = '启动中，首次加载模型可能需要 1–3 分钟…';
      try {
        var result = await api('/admin/api/upstream/start', { method: 'POST', body: {} });
        $('#u-hint').textContent = result.ready ? '上游已就绪' : (result.note || '仍在启动');
      } catch (error) {
        $('#u-hint').textContent = '';
        toast(error.message, 'bad');
      } finally {
        button.disabled = false;
        route();
      }
    });
    $('#u-stop').addEventListener('click', async function () {
      var ok = await confirmDialog('停止上游', '<p>停止后合成会返回 503。</p>', '停止');
      if (!ok) return;
      try {
        await api('/admin/api/upstream/stop', { method: 'POST' });
        toast('已停止', 'ok');
        route();
      } catch (error) { toast(error.message, 'bad'); }
    });
  };

  // ---------------------------------------------------------------- 示例

  VIEWS.guide = async function () {
    var overview = await api('/admin/api/overview');
    var base = overview.public_base_url;
    var voice = overview.defaults.voice || 'furina_normal';
    var sample = '茶会是淑女的必修课。';

    var curl = [
      '# 1) 探活（不需要密钥）',
      'curl ' + base + '/healthz',
      '',
      '# 2) 合成语音并落盘',
      'curl -X POST ' + base + '/v1/audio/speech \\',
      '  -H "Authorization: Bearer sk-你的密钥" \\',
      '  -H "Content-Type: application/json" \\',
      '  -d \'{"model":"tts-1","input":"' + sample + '","voice":"' + voice + '","response_format":"wav"}\' \\',
      '  --output out.wav'
    ].join('\n');

    var python = [
      'from openai import OpenAI',
      '',
      'client = OpenAI(base_url="' + base + '/v1", api_key="sk-你的密钥")',
      'speech = client.audio.speech.create(',
      '    model="tts-1",',
      '    voice="' + voice + '",',
      '    input="' + sample + '",',
      '    response_format="wav",',
      ')',
      'speech.write_to_file("out.wav")'
    ].join('\n');

    var node = [
      'const response = await fetch("' + base + '/v1/audio/speech", {',
      '  method: "POST",',
      '  headers: {',
      '    "Authorization": "Bearer sk-你的密钥",',
      '    "Content-Type": "application/json",',
      '  },',
      '  body: JSON.stringify({',
      '    model: "tts-1",',
      '    voice: "' + voice + '",',
      '    input: "' + sample + '",',
      '    response_format: "wav",',
      '  }),',
      '});',
      'if (!response.ok) throw new Error(`HTTP ${response.status}`);',
      'const buffer = Buffer.from(await response.arrayBuffer());'
    ].join('\n');

    var env = [
      '# Absolute Solver Hub（E:\\Absolute-Solver\\run-hub-v0.2.1.cmd）',
      'SOLVER_TTS_URL=' + base,
      'SOLVER_TTS_API_KEY=sk-你的密钥',
      'SOLVER_TTS_MODEL=tts-1',
      'SOLVER_TTS_VOICE=' + voice,
      '',
      '# DSH dsh-tts 插件（本机）',
      'DSH_TTS_BASE_URL=' + base + '/v1',
      'DSH_TTS_API_KEY=sk-你的密钥'
    ].join('\n');

    var html = '<div class="note info">对外地址取自「服务设置」里的配置；换网段后改一次，示例会自动更新。</div>' +
      '<div class="card mt-16"><div class="card-head">cURL</div><div class="card-body"><pre class="code">' + esc(curl) + '</pre></div></div>' +
      '<div class="card"><div class="card-head">Python（openai SDK）</div><div class="card-body"><pre class="code">' + esc(python) + '</pre></div></div>' +
      '<div class="card"><div class="card-head">Node.js</div><div class="card-body"><pre class="code">' + esc(node) + '</pre></div></div>' +
      '<div class="card"><div class="card-head">环境变量</div><div class="card-body"><pre class="code">' + esc(env) + '</pre></div></div>';
    $('#view').innerHTML = html;
  };

  // ---------------------------------------------------------------- 事件委托

  document.addEventListener('click', async function (event) {
    var button = event.target.closest ? event.target.closest('button[data-act]') : null;
    if (!button || !button.closest('#view')) return;
    var act = button.getAttribute('data-act');
    var vid = button.getAttribute('data-id');
    try {
      if (act === 'voice-try' || act === 'voice-edit' || act === 'voice-default' || act === 'voice-del') {
        var list = (state.voices && state.voices.voices) || [];
        var voice = list.filter(function (item) { return item.id === vid; })[0];
        if (act === 'voice-try') return tryVoice(voice);
        if (act === 'voice-edit') return editVoice(voice);
        if (act === 'voice-default') {
          await api('/admin/api/voices/default', { method: 'POST', body: { id: vid } });
          toast('默认音色已切换为 ' + vid, 'ok');
          return route();
        }
        if (act === 'voice-del') {
          var confirmed = await confirmDialog('删除音色',
            '<p>确定删除音色 <strong class="mono">' + esc(vid) + '</strong>？</p>', '删除');
          if (!confirmed) return;
          await api('/admin/api/voices/' + encodeURIComponent(vid), { method: 'DELETE' });
          toast('已删除', 'ok');
          return route();
        }
      }

      var row = button.closest('tr');
      var kid = row ? row.getAttribute('data-id') : null;
      if (act === 'key-copy' && kid) {
        var revealed = await api('/admin/api/keys/' + encodeURIComponent(kid) + '/reveal', { method: 'POST' });
        await copyText(revealed.key);
        toast('密钥已复制到剪贴板', 'ok');
      }
      if (act === 'key-del' && kid) {
        var okDelete = await confirmDialog('删除密钥',
          '<p>删除后使用这把密钥的客户端会立刻收到 401。</p>', '删除');
        if (!okDelete) return;
        await api('/admin/api/keys/' + encodeURIComponent(kid), { method: 'DELETE' });
        toast('已删除', 'ok');
        route();
      }
    } catch (error) {
      toast(error.message, 'bad');
    }
  });

  document.addEventListener('change', async function (event) {
    var input = event.target.closest ? event.target.closest('input[data-act="key-toggle"]') : null;
    if (!input) return;
    var row = input.closest('tr');
    if (!row) return;
    try {
      await api('/admin/api/keys/' + encodeURIComponent(row.getAttribute('data-id')), {
        method: 'PUT',
        body: { enabled: input.checked }
      });
      toast(input.checked ? '已启用' : '已停用', 'ok');
    } catch (error) {
      input.checked = !input.checked;
      toast(error.message, 'bad');
    }
  });

  // ---------------------------------------------------------------- 启动

  boot();
})();
