/* TTS Service 配置界面 · 单文件前端（无构建） */
(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var state = { overview: null, voices: null, keys: null, route: '', dirty: false, lastHash: '' };
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

  // ---------------------------------------------------------------- 错误语义

  function describeError(error) {
    var status = error && error.status;
    var detail = (error && (error.detail || error.message)) || '未知错误';
    var table = {
      400: { title: '请求不合法', hint: detail, action: '' },
      401: { title: '凭据无效', hint: '管理会话可能已过期；客户端则是密钥被停用或删除。', action: '#/keys', label: '检查客户端密钥' },
      403: { title: '被拒绝', hint: '写操作需要会话 Cookie 加 X-TTS-Admin 请求头。', action: '', label: '' },
      404: { title: '目标不存在', hint: detail, action: '', label: '' },
      413: { title: '文本过长', hint: '缩短单条文本，或调高「单条最大字符」。', action: '#/settings', label: '调整上限' },
      429: { title: '服务繁忙', hint: '并发已满，稍后重试；或调高「最大并发」（需重启）。', action: '#/settings', label: '查看并发设置' },
      502: { title: '上游返回错误', hint: '上游活着但合成失败，看「上游进程」日志尾部。', action: '#/upstream', label: '查看上游日志' },
      503: { title: '上游未运行', hint: '先把 GPT-SoVITS 上游启动起来。', action: '#/upstream', label: '去启动上游' },
      504: { title: '上游超时', hint: '合成超过时限；确认 GPU 是否被占满，或调高超时。', action: '#/settings', label: '调整超时' }
    };
    var info = table[status] || { title: '操作失败', hint: detail, action: '', label: '' };
    return {
      status: status || 0,
      title: info.title,
      hint: (status && table[status] ? info.hint + (status >= 400 && detail && detail !== info.hint ? '（' + detail + '）' : '') : info.hint),
      action: info.action,
      label: info.label
    };
  }

  function errorBanner(error, kind) {
    var info = describeError(error);
    var html = '<div class="banner ' + (kind || '') + '">' +
      '<div class="banner-body"><div class="banner-title">' + esc(info.title) +
      (info.status ? ' <span class="tag">HTTP ' + esc(info.status) + '</span>' : '') + '</div>' +
      '<div class="banner-text">' + esc(info.hint) + '</div></div>';
    if (info.action) {
      html += '<a class="btn btn-sm" href="' + esc(info.action) + '">' + esc(info.label) + '</a>';
    }
    return html + '</div>';
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
    if (response.status === 401 && path.indexOf('/admin/api/') === 0) {
      showGate('login');
    }
    var type = response.headers.get('content-type') || '';
    var payload = null;
    if (type.indexOf('application/json') >= 0) {
      payload = await response.json().catch(function () { return null; });
    }
    if (!response.ok) {
      var error = new Error((payload && payload.detail) || ('HTTP ' + response.status));
      error.status = response.status;
      error.detail = payload && payload.detail;
      throw error;
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
    document.title = 'TTS Service · 登录';
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
  var navigatingBack = false;

  function route() {
    if ($('#shell').hidden) return;
    var hash = (location.hash || '#/overview').replace(/^#\/?/, '');
    var page = PAGES[hash] ? hash : 'overview';
    if (state.dirty && !navigatingBack) {
      if (!window.confirm('服务设置里有未保存的修改，确定离开？')) {
        navigatingBack = true;
        location.hash = state.lastHash || '#/overview';
        return;
      }
      state.dirty = false;
    }
    navigatingBack = false;
    state.lastHash = '#/' + page;
    state.route = page;
    $('#brand-page').textContent = PAGES[page];
    document.title = 'TTS Service · ' + PAGES[page];
    Array.prototype.forEach.call(document.querySelectorAll('.nav-item'), function (item) {
      if (item.getAttribute('data-page') === page) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    });
    $('#view').innerHTML = '<div class="empty">加载中…</div>';
    (VIEWS[page] || VIEWS.overview)().catch(function (error) {
      $('#view').innerHTML = errorBanner(error);
    });
    refreshChrome();
    clearTimeout(timer);
    if (page === 'overview' || page === 'requests' || page === 'upstream') {
      timer = setTimeout(function () { if (state.route === page && !state.dirty) route(); }, 15000);
    }
  }

  window.addEventListener('hashchange', route);

  // ---------------------------------------------------------------- 概览

  function updateChrome(data) {
    var pill = $('#pill-upstream');
    pill.className = 'badge ' + (data.upstream.alive ? 'ok' : 'bad');
    pill.title = data.upstream.alive ? '上游存活（探针结果，仅供参考）' : '上游离线';
    pill.innerHTML = '<span class="dot"></span><span>上游' + (data.upstream.alive ? '在线' : '离线') + '</span>';
    var publicHost = String(data.public_base_url || '').replace(/^https?:\/\//, '');
    var listen = data.listen.host + ':' + data.listen.port;
    var pill2 = $('#pill-listen');
    pill2.textContent = publicHost || listen;
    pill2.title = publicHost ? ('对外地址 ' + data.public_base_url + '（监听 ' + listen + '）') : ('监听 ' + listen);
    $('#status-left').textContent = 'v' + data.version + ' · ' + (publicHost || listen);
    $('#status-right').textContent = '更新于 ' + new Date().toLocaleTimeString('zh-CN');
  }

  function refreshChrome() {
    api('/admin/api/overview').then(function (data) {
      state.overview = data;
      updateChrome(data);
    }).catch(function () { /* 顶栏只是显示，失败不打扰 */ });
  }

  function requestTable(rows) {
    if (!rows || !rows.length) return '<div class="empty">还没有请求。<br><span class="p-text-sm">合成一次之后，这里会出现状态、耗时与字节数（不记录文本）。</span></div>';
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
            (row.error ? ' <span class="p-text-xs fg-subtle" title="' + esc(row.error) + '">' + esc(String(row.error).slice(0, 60)) + '</span>' : '')) +
        '</td></tr>';
    }).join('');
    return '<div class="table-wrap"><table class="table"><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>';
  }

  function selfcheckRows(result) {
    return result.checks.map(function (check) {
      return '<div class="check-row">' +
        '<div class="state">' + (check.ok
          ? '<span class="badge ok"><span class="dot"></span>通过</span>'
          : '<span class="badge bad"><span class="dot"></span>注意</span>') + '</div>' +
        '<div class="name">' + esc(check.title) + '</div>' +
        '<div class="detail">' + esc(check.detail) + '</div>' +
        (check.action ? '<a class="btn btn-sm" href="' + esc(check.action) + '">处理</a>' : '<span></span>') +
        '</div>';
    }).join('');
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

    html += '<div class="card mt-16"><div class="card-head">健康自检<span class="spacer"></span>' +
      '<label class="switch" title="自检是否顺带合成一句（会占用 GPU 约 2 秒）">' +
      '<input type="checkbox" id="sc-synth"><span class="switch-track"></span>' +
      '<span class="p-text-sm fg-muted">含合成</span></label>' +
      '<button class="btn btn-sm btn-primary" id="sc-run" type="button">运行自检</button></div>' +
      '<div class="check-list" id="sc-list"><div class="empty">尚未运行。自检会逐项确认口令、密钥、音色、安装目录与上游。</div></div></div>';

    html += '<div class="card"><div class="card-head">服务状态</div><div class="card-body"><dl class="kv">';
    html += '<dt>版本</dt><dd>v' + esc(data.version) + '</dd>';
    html += '<dt>监听</dt><dd>' + esc(data.listen.host + ':' + data.listen.port) + '</dd>';
    html += '<dt>对外地址</dt><dd>' + esc(data.public_base_url) + '</dd>';
    html += '<dt>上游 TTS</dt><dd>' + esc(data.upstream.base) + ' ' +
      (data.upstream.alive ? '<span class="badge ok"><span class="dot"></span>在线</span>'
        : '<span class="badge bad"><span class="dot"></span>离线</span>') +
      ' <span class="hint-inline">（探针仅供参考，合成以实际调用为准）</span></dd>';
    html += '<dt>上游进程</dt><dd>' + (data.upstream.managed
      ? ('由本服务管理，PID ' + esc(data.upstream.pid))
      : '外部启动（不由本服务托管）') + '</dd>';
    html += '<dt>GPT-SoVITS</dt><dd>' + esc(data.upstream.install || '未找到安装目录') + '</dd>';
    html += '</dl>';

    var checks = [];
    if (!data.checks.has_admin_password) checks.push({ text: '未设置管理员口令', href: '#/security', label: '去设置' });
    if (!data.checks.has_client_key) checks.push({ text: '没有启用的客户端密钥，外部客户端无法调用', href: '#/keys', label: '去创建' });
    if (!data.checks.install_found) checks.push({ text: '未找到 GPT-SoVITS 安装目录，音色编辑与上游启动不可用', href: '#/settings', label: '看配置' });
    if (!data.upstream.alive) checks.push({ text: '上游 TTS 离线（探针），合成会失败', href: '#/upstream', label: '去启动' });
    if (checks.length) {
      html += '<div class="banner warn mt-16"><div class="banner-body"><div class="banner-title">需要处理</div>' +
        '<div class="banner-text">' + checks.map(function (item) { return esc(item.text); }).join('；') + '</div></div>' +
        '<a class="btn btn-sm" href="' + esc(checks[0].href) + '">' + esc(checks[0].label) + '</a></div>';
    }
    html += '</div></div>';

    html += '<div class="card"><div class="card-head">最近请求<span class="spacer"></span>' +
      '<span class="p-text-xs fg-muted">只记录长度与状态，不记录文本</span></div>' +
      '<div class="card-body tight">' + requestTable(data.recent) + '</div></div>';
    $('#view').innerHTML = html;

    $('#sc-run').addEventListener('click', async function () {
      var button = $('#sc-run');
      var list = $('#sc-list');
      button.disabled = true;
      list.innerHTML = '<div class="empty">自检中…</div>';
      try {
        var result = await api('/admin/api/selfcheck', {
          method: 'POST',
          body: { synthesize: $('#sc-synth').checked }
        });
        list.innerHTML = selfcheckRows(result);
        toast(result.ok ? '自检通过（' + result.elapsed_ms + ' ms）' : '自检发现问题，见列表', result.ok ? 'ok' : 'bad');
      } catch (error) {
        list.innerHTML = errorBanner(error);
      } finally {
        button.disabled = false;
      }
    });
  };

  VIEWS.requests = async function () {
    var data = await api('/admin/api/requests?limit=100');
    var rows = data.requests || [];
    var clients = [];
    rows.forEach(function (row) {
      if (row.client && clients.indexOf(row.client) < 0) clients.push(row.client);
    });
    var html = '<div class="card"><div class="card-head">最近请求<span class="spacer"></span>' +
      '<span class="p-text-xs fg-muted">共 ' + rows.length + ' 条，最多保留 100 条</span></div>' +
      '<div class="toolbar">' +
      '<select class="select" id="f-client"><option value="">全部客户端</option>' +
      clients.map(function (name) { return '<option value="' + esc(name) + '">' + esc(name) + '</option>'; }).join('') +
      '</select>' +
      '<select class="select" id="f-status"><option value="">全部状态</option>' +
      '<option value="2">成功 (2xx)</option><option value="4">客户端错误 (4xx)</option><option value="5">服务端错误 (5xx)</option>' +
      '</select>' +
      '<span class="spacer"></span><button class="btn btn-sm" id="refresh-requests" type="button">刷新</button>' +
      '</div><div class="card-body tight" id="req-list">' + requestTable(rows) + '</div></div>';
    $('#view').innerHTML = html;

    var apply = function () {
      var client = $('#f-client').value;
      var status = $('#f-status').value;
      var filtered = rows.filter(function (row) {
        if (client && row.client !== client) return false;
        if (status && String(row.status || '')[0] !== status) return false;
        return true;
      });
      $('#req-list').innerHTML = requestTable(filtered);
    };
    $('#f-client').addEventListener('change', apply);
    $('#f-status').addEventListener('change', apply);
    $('#refresh-requests').addEventListener('click', function () { route(); });
  };

  // ---------------------------------------------------------------- 音色

  function detectLang(text) {
    var value = String(text || '');
    if (/[\u3040-\u309f\u30a0-\u30ff]/.test(value)) return 'ja';
    if (/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(value)) return 'zh';
    if (/[A-Za-z]/.test(value)) return 'en';
    return '';
  }

  function splitSentences(text) {
    return String(text || '')
      .split(/(?<=[。！？!?；;\n])/)
      .map(function (item) { return item.trim(); })
      .filter(Boolean);
  }

  function langChips(text) {
    var pieces = splitSentences(text);
    if (!pieces.length) return '<span class="hint-inline">输入一段文本，看它会被切成几段、每段推断成什么语言。</span>';
    return pieces.map(function (piece) {
      var lang = detectLang(piece) || '（未识别，回落到音色语言）';
      var cls = (lang === 'ja' || lang === 'zh' || lang === 'en') ? ' ' + lang : '';
      return '<span class="seg-chip' + cls + '" title="' + esc(piece) + '">' + esc(lang) + '</span>';
    }).join('');
  }

  VIEWS.voices = async function () {
    var data = await api('/admin/api/voices');
    state.voices = data;
    var rows = data.voices.map(function (voice) {
      var isDefault = data.default === voice.id;
      var weights = [voice.gpt, voice.sovits].filter(Boolean);
      var weightText = weights.length ? weights.map(baseName).join(' / ') : '—';
      return '<tr data-id="' + esc(voice.id) + '">' +
        '<td class="mono nowrap">' + esc(voice.id) + (isDefault ? ' <span class="badge accent">默认</span>' : '') + '</td>' +
        '<td class="mono p-text-xs" title="' + esc(weights.join(' / ')) + '">' + esc(weightText) + '</td>' +
        '<td class="mono p-text-xs">' + esc(voice.ref_audio) + '</td>' +
        '<td class="nowrap">' + esc(voice.ref_lang) + ' → ' + esc(voice.text_lang) + '</td>' +
        '<td class="nowrap"><label class="switch" title="按文本自动推断语言；关闭则固定用上面的文本语言">' +
        '<input type="checkbox" data-act="voice-autolang"' + (voice.auto_text_lang ? ' checked' : '') + '>' +
        '<span class="switch-track"></span></label></td>' +
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
        '<th>语言</th><th>自动推断</th><th class="num">语速</th><th>操作</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
        : '<div class="empty">还没有音色。<br><span class="p-text-sm">新增时需要一个参考音频与它的原文（逐字一致）；合成时只需给音色 ID。</span></div>') +
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
      field('文本语言（自动推断关闭时使用）', '<input class="input mono" id="v-textlang" value="' + esc(v.text_lang || 'zh') + '">') +
      field('语速', '<input class="input mono" id="v-speed" type="number" step="0.05" min="0.5" max="2" value="' + esc(v.speed || 1) + '">') +
      '</div>';
    html += '<label class="switch"><input type="checkbox" id="v-autolang"' + (v.auto_text_lang === false ? '' : ' checked') + '>' +
      '<span class="switch-track"></span><span class="p-text-sm">按文本自动推断语言（推荐）</span></label>';
    html += '<div class="field"><span>推断预览</span>' +
      '<textarea class="textarea" id="v-preview" rows="2">茶会是淑女的必修课。OK, let me check. それは秘密です。</textarea>' +
      '<div class="seg-preview" id="v-chips"></div>' +
      '<span class="field-hint">分段回复时，每段是独立请求，所以按段推断；关闭自动推断则全部用上面的「文本语言」。</span></div>';

    var result = await openModal({
      title: voice ? ('编辑音色 ' + voice.id) : '新增音色',
      html: html,
      okText: '保存',
      setup: function (body) {
        var preview = body.querySelector('#v-preview');
        var chips = body.querySelector('#v-chips');
        var update = function () { chips.innerHTML = langChips(preview.value); };
        preview.addEventListener('input', update);
        update();
      }
    });
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
    } catch (error) { toast(describeError(error).title + '：' + describeError(error).hint, 'bad'); }
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
              var error = new Error(payload.detail || ('HTTP ' + response.status));
              error.status = response.status;
              error.detail = payload.detail;
              throw error;
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
            var info = describeError(error);
            meta.textContent = '';
            toast(info.title + '：' + info.hint, 'bad');
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
        '<td class="nowrap"><div class="row gap-8">' +
        '<button class="btn btn-sm" data-act="key-copy" type="button">复制</button>' +
        '<button class="btn btn-sm" data-act="key-edit" type="button">编辑</button>' +
        '<button class="btn btn-sm btn-danger" data-act="key-del" type="button">删除</button>' +
        '</div></td></tr>';
    }).join('');

    var html = '<div class="card"><div class="card-head">客户端密钥<span class="spacer"></span>' +
      '<button class="btn btn-sm btn-primary" id="key-add" type="button">创建密钥</button></div>' +
      '<div class="card-body tight">' +
      (rows ? '<div class="table-wrap"><table class="table"><thead><tr><th>名称</th><th>密钥</th><th>启用</th>' +
        '<th class="num">调用次数</th><th>最近使用</th><th>创建时间</th><th>操作</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
        : '<div class="empty">还没有密钥。<br><span class="p-text-sm">外部客户端需要一把 sk- 开头的密钥才能调用；配置界面本身不消耗配额。</span></div>') +
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
      } catch (error) { toast(describeError(error).title + '：' + describeError(error).hint, 'bad'); }
    });
  };

  // ---------------------------------------------------------------- 设置

  VIEWS.settings = async function () {
    var data = await api('/admin/api/settings');
    var voiceData = await api('/admin/api/voices');
    state.voices = voiceData;
    state.dirty = false;
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
      '<button class="btn" id="s-reset" type="button">放弃修改</button>' +
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
        state.dirty = false;
        if (result.restart_required && result.restart_required.length) {
          $('#s-hint').innerHTML = '<span class="attention">已保存；' +
            esc(result.restart_required.join('、')) + ' 需要重启后生效</span>';
        } else {
          $('#s-hint').innerHTML = '<span class="success">已保存并立即生效</span>';
        }
        toast('设置已保存', 'ok');
        refreshChrome();
      } catch (error) {
        var info = describeError(error);
        toast(info.title + '：' + info.hint, 'bad');
      }
    });

    $('#s-reset').addEventListener('click', function () {
      state.dirty = false;
      route();
    });

    $('#s-restart').addEventListener('click', async function () {
      var ok = await confirmDialog('重启服务',
        '<p>服务会断开约 2–5 秒。由启动器（run-tts-service）托管时会自动重新拉起；否则需要手动启动。</p>', '重启');
      if (!ok) return;
      try {
        await api('/admin/api/restart', { method: 'POST' });
        toast('正在重启，稍后刷新页面', 'ok');
        setTimeout(function () { location.reload(); }, 4000);
      } catch (error) { toast(describeError(error).hint, 'bad'); }
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
      '<div class="form-actions"><button class="btn btn-primary" id="p-save" type="button">修改口令</button>' +
      '<span id="p-hint" class="p-text-sm fg-muted"></span></div>' +
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
        $('#p-hint').innerHTML = '<span class="success">下次登录请用新口令</span>';
      } catch (error) { toast(describeError(error).title + '：' + describeError(error).hint, 'bad'); }
    });
  };

  // ---------------------------------------------------------------- 上游

  VIEWS.upstream = async function () {
    var data = await api('/admin/api/upstream?tail=80');
    var voices = null;
    try { voices = await api('/admin/api/voices'); } catch (error) { /* 音色列表只是锦上添花 */ }
    var weights = (voices && voices.weights) || { GPT: [], SoVITS: [] };
    var options = function (items) {
      return items.map(function (item) {
        return '<option value="' + esc(item.rel) + '">' + esc(item.rel) + '</option>';
      }).join('');
    };

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
      '</div></div>';

    if (weights.GPT.length || weights.SoVITS.length) {
      html += '<div class="card"><div class="card-head">热加载权重<span class="spacer"></span>' +
        '<span class="p-text-sm card-sub">只切换上游当前权重，不改音色表</span></div><div class="card-body">' +
        '<div class="form-grid">' +
        field('GPT 权重', '<select class="select" id="w-gpt"><option value="">（不改）</option>' + options(weights.GPT) + '</select>') +
        field('SoVITS 权重', '<select class="select" id="w-sovits"><option value="">（不改）</option>' + options(weights.SoVITS) + '</select>') +
        '</div><div class="form-actions"><button class="btn" id="w-load" type="button">加载到上游</button>' +
        '<span id="w-hint" class="p-text-sm fg-muted"></span></div></div></div>';
    }

    html += '<div class="card"><div class="card-head">上游日志（末尾 80 行）</div><div class="card-body tight">' +
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
        toast(describeError(error).title + '：' + describeError(error).hint, 'bad');
      } finally {
        button.disabled = false;
        route();
      }
    });
    $('#u-stop').addEventListener('click', async function () {
      var ok = await confirmDialog('停止上游', '<p>停止后合成会失败（503）。</p>', '停止');
      if (!ok) return;
      try {
        await api('/admin/api/upstream/stop', { method: 'POST' });
        toast('已停止', 'ok');
        route();
      } catch (error) { toast(describeError(error).hint, 'bad'); }
    });
    if ($('#w-load')) {
      $('#w-load').addEventListener('click', async function () {
        var body = {};
        if ($('#w-gpt').value) body.gpt = $('#w-gpt').value;
        if ($('#w-sovits').value) body.sovits = $('#w-sovits').value;
        if (!body.gpt && !body.sovits) {
          $('#w-hint').textContent = '至少选择一项';
          return;
        }
        var button = $('#w-load');
        button.disabled = true;
        $('#w-hint').textContent = '加载中…';
        try {
          var result = await api('/admin/api/upstream/load', { method: 'POST', body: body });
          $('#w-hint').innerHTML = '<span class="success">已加载：' +
            Object.keys(result.results || {}).join(' / ') + '</span>';
        } catch (error) {
          $('#w-hint').textContent = '';
          toast(describeError(error).hint, 'bad');
        } finally {
          button.disabled = false;
        }
      });
    }
  };

  // ---------------------------------------------------------------- 示例

  VIEWS.guide = async function () {
    var overview = await api('/admin/api/overview');
    var base = overview.public_base_url;
    var voice = overview.defaults.voice || 'xxx_trained';
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

    var html = '<div class="note info">对外地址取自「服务设置」里的配置；换网段后改一次，示例会自动更新。' +
      '本服务返回到达的音频是<b>完整 WAV</b>，不提供流式 PCM。</div>' +
      '<div class="card mt-16"><div class="card-head">cURL</div><div class="card-body"><pre class="code">' + esc(curl) + '</pre></div></div>' +
      '<div class="card"><div class="card-head">Python（openai SDK）</div><div class="card-body"><pre class="code">' + esc(python) + '</pre></div></div>' +
      '<div class="card"><div class="card-head">Node.js</div><div class="card-body"><pre class="code">' + esc(node) + '</pre></div></div>' +
      '<div class="card"><div class="card-head">环境变量</div><div class="card-body"><pre class="code">' + esc(env) + '</pre></div></div>';
    $('#view').innerHTML = html;
  };

  // ---------------------------------------------------------------- 事件委托

  document.addEventListener('input', function (event) {
    if (state.route === 'settings' && event.target.closest && event.target.closest('#view')) {
      state.dirty = true;
    }
  });

  document.addEventListener('change', async function (event) {
    var target = event.target;
    if (!target || !target.closest) return;

    if (state.route === 'settings' && target.closest('#view')) state.dirty = true;

    var auto = target.closest('input[data-act="voice-autolang"]');
    if (auto) {
      var row = auto.closest('tr');
      var vid = row.getAttribute('data-id');
      var list = (state.voices && state.voices.voices) || [];
      var voice = list.filter(function (item) { return item.id === vid; })[0];
      if (!voice) return;
      try {
        await api('/admin/api/voices', {
          method: 'POST',
          body: {
            id: voice.id, gpt: voice.gpt || '', sovits: voice.sovits || '',
            ref_audio: voice.ref_audio, ref_text: voice.ref_text,
            ref_lang: voice.ref_lang, text_lang: voice.text_lang,
            speed: voice.speed, auto_text_lang: auto.checked
          }
        });
        toast(auto.checked ? '已开启自动推断' : '已固定为 ' + voice.text_lang, 'ok');
        route();
      } catch (error) {
        auto.checked = !auto.checked;
        toast(describeError(error).hint, 'bad');
      }
      return;
    }

    var toggle = target.closest('input[data-act="key-toggle"]');
    if (toggle) {
      var keyRow = toggle.closest('tr');
      try {
        await api('/admin/api/keys/' + encodeURIComponent(keyRow.getAttribute('data-id')), {
          method: 'PUT',
          body: { enabled: toggle.checked }
        });
        toast(toggle.checked ? '已启用' : '已停用', 'ok');
      } catch (error) {
        toggle.checked = !toggle.checked;
        toast(describeError(error).hint, 'bad');
      }
    }
  });

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
      if (act === 'key-edit' && kid) {
        var record = ((state.keys && state.keys.keys) || []).filter(function (item) { return item.id === kid; })[0] || {};
        var result = await openModal({
          title: '编辑密钥',
          html: field('用途名称', '<input class="input" id="k-name" value="' + esc(record.name || '') + '">') +
            field('备注', '<input class="input" id="k-note" value="' + esc(record.note || '') + '">'),
          okText: '保存'
        });
        if (!result.ok) return;
        await api('/admin/api/keys/' + encodeURIComponent(kid), {
          method: 'PUT',
          body: {
            name: result.body.querySelector('#k-name').value.trim(),
            note: result.body.querySelector('#k-note').value.trim()
          }
        });
        toast('已保存', 'ok');
        route();
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
      toast(describeError(error).title + '：' + describeError(error).hint, 'bad');
    }
  });

  // ---------------------------------------------------------------- 启动

  boot();
})();
