// ── Tiny helpers ────────────────────────────────────────────────────
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show ${kind}`;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => (t.className = 'toast'), 2600);
}

async function api(method, url, body) {
  const opt = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opt.body = JSON.stringify(body);
  const res = await fetch(url, opt);
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data;
}

// ── Tabs ────────────────────────────────────────────────────────────
$$('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach((t) => t.classList.remove('active'));
    $$('.panel').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    $(`#tab-${tab.dataset.tab}`).classList.add('active');
  });
});

// ════════════════════════════════════════════════════════════════════
//  CONTROL & LOGS
// ════════════════════════════════════════════════════════════════════
const consoleEl = $('#console');
const stats = { sessions: 0, success: 0, failed: 0, targets: 0 };

function setStatus(s) {
  const dot = $('#statusDot');
  const text = $('#statusText');
  if (s.running) {
    dot.className = 'dot running';
    text.textContent = `Running · pid ${s.pid}`;
    $('#btnStart').disabled = true;
    $('#btnStop').disabled = false;
    startUptime(s.startedAt);
  } else {
    dot.className = 'dot stopped';
    text.textContent = 'Stopped';
    $('#btnStart').disabled = false;
    $('#btnStop').disabled = true;
    stopUptime();
  }
}

let uptimeTimer = null;
function startUptime(startedAt) {
  stopUptime();
  const tick = () => {
    if (!startedAt) return;
    const s = Math.floor((Date.now() - startedAt) / 1000);
    const h = String(Math.floor(s / 3600)).padStart(2, '0');
    const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const sec = String(s % 60).padStart(2, '0');
    $('#uptime').textContent = `${h}:${m}:${sec}`;
  };
  tick();
  uptimeTimer = setInterval(tick, 1000);
}
function stopUptime() {
  clearInterval(uptimeTimer);
  $('#uptime').textContent = '';
}

function fmtTime(t) {
  const d = new Date(t);
  return d.toLocaleTimeString('en-GB');
}

function appendLog(e) {
  const div = document.createElement('span');
  div.className = 'line';
  let cls = e.stream;
  if (e.stream === 'stdout') {
    if (/✓|success|complete|found/i.test(e.line)) cls = 'ln-ok';
    else if (/⚠|warn|retry|captcha/i.test(e.line)) cls = 'ln-warn';
  }
  div.innerHTML =
    `<span class="ts">${fmtTime(e.t)}</span><span class="${cls}"></span>`;
  div.lastChild.textContent = e.line;
  consoleEl.appendChild(div);
  parseStats(e.line);
  if ($('#autoscroll').checked) consoleEl.scrollTop = consoleEl.scrollHeight;

  // Trim DOM if it grows huge
  while (consoleEl.childElementCount > 2000) consoleEl.removeChild(consoleEl.firstChild);
}

function parseStats(line) {
  const grab = (re) => { const m = line.match(re); return m ? parseInt(m[1], 10) : null; };
  let v;
  if ((v = grab(/Total Sessions(?: Run)?:\s*(\d+)/)) !== null) { stats.sessions = v; $('#sSessions').textContent = v; }
  if ((v = grab(/Successful Clicks:\s*(\d+)/)) !== null) { stats.success = v; $('#sSuccess').textContent = v; }
  if ((v = grab(/Failed Sessions:\s*(\d+)/)) !== null) { stats.failed = v; $('#sFailed').textContent = v; }
  if ((v = grab(/Target Clicks Made:\s*(\d+)/)) !== null) { stats.targets = v; $('#sTargets').textContent = v; }
}

// SSE connection (auto-reconnects)
function connectStream() {
  const es = new EventSource('/api/logs/stream');
  es.addEventListener('log', (ev) => appendLog(JSON.parse(ev.data)));
  es.addEventListener('status', (ev) => setStatus(JSON.parse(ev.data)));
  es.onerror = () => { /* EventSource auto-retries */ };
}
connectStream();

$('#btnStart').addEventListener('click', async () => {
  try { await api('POST', '/api/bot/start'); toast('Bot started', 'ok'); }
  catch (e) { toast(e.message, 'err'); }
});
$('#btnStop').addEventListener('click', async () => {
  try { await api('POST', '/api/bot/stop'); toast('Stopping bot…', 'ok'); }
  catch (e) { toast(e.message, 'err'); }
});
$('#btnClear').addEventListener('click', () => { consoleEl.innerHTML = ''; });

// ════════════════════════════════════════════════════════════════════
//  CONFIG FORM
// ════════════════════════════════════════════════════════════════════
const CONFIG_SCHEMA = [
  {
    group: 'Keywords & Targeting',
    fields: [
      { key: 'KEYWORDS', type: 'list', desc: 'Google search keywords (one per line)' },
      { key: 'TARGET_DOMAINS', type: 'list', desc: 'Ad domains to click (one per line)' },
      { key: 'SPONSORED_ONLY', type: 'bool', desc: 'Only click sponsored ads (not organic results)' },
      { key: 'SESSIONS_PER_KEYWORD', type: 'number', desc: 'How many sessions per keyword' },
      { key: 'LOOP_BOT', type: 'bool', desc: 'Loop forever' },
    ],
  },
  {
    group: 'Site Browsing',
    fields: [
      { key: 'SITE_BROWSE_MIN', type: 'number', desc: 'Min seconds on landing page' },
      { key: 'SITE_BROWSE_MAX', type: 'number', desc: 'Max seconds on landing page' },
      { key: 'INTERNAL_PAGES_MIN', type: 'number', desc: 'Min internal pages visited' },
      { key: 'INTERNAL_PAGES_MAX', type: 'number', desc: 'Max internal pages visited' },
      { key: 'COOKIE_WARMUP', type: 'bool', desc: 'Visit Google properties first to build cookies' },
    ],
  },
  {
    group: 'Timing (milliseconds)',
    fields: [
      { key: 'MIN_DELAY', type: 'number', desc: 'Min delay between sessions' },
      { key: 'MAX_DELAY', type: 'number', desc: 'Max delay between sessions' },
      { key: 'MIN_SCROLL_DELAY', type: 'number', desc: 'Min scroll delay' },
      { key: 'MAX_SCROLL_DELAY', type: 'number', desc: 'Max scroll delay' },
    ],
  },
  {
    group: 'Browser & History',
    fields: [
      { key: 'HEADLESS', type: 'bool', desc: 'Run browser invisibly' },
      { key: 'LOGIN_EMAIL', type: 'bool', desc: 'Use logged-in Google account profiles' },
      { key: 'SEARCH_HISTORY', type: 'bool', desc: 'Build browsing history before searching' },
      { key: 'SEARCH_HISTORY_COUNT', type: 'number', desc: 'Sites to visit per session' },
      { key: 'WARMUP_URLS', type: 'list', desc: 'Custom warmup URLs (one per line, optional)' },
    ],
  },
  {
    group: 'Proxy',
    fields: [
      { key: 'PROXY_LIST', type: 'list', desc: 'Proxy hosts host:port (one per line)' },
      { key: 'PROXY_USER', type: 'text', desc: 'Proxy username' },
      { key: 'PROXY_PASS', type: 'text', desc: 'Proxy password' },
      { key: 'SHOW_PROXY_IP', type: 'bool', desc: 'Print evaluated proxy IP each session' },
    ],
  },
  {
    group: 'SERP API & Captcha',
    fields: [
      { key: 'USE_SERP_API', type: 'bool', desc: 'Use Bright Data SERP API for searches' },
      { key: 'BRIGHTDATA_SERP_API_KEY', type: 'text', desc: 'Bright Data SERP API key' },
      { key: '2CAPTCHA_API_KEY', type: 'text', desc: '2Captcha API key (auto-solve reCAPTCHA)' },
      { key: 'CAPTCHA_WAIT_MINUTES', type: 'number', desc: 'Minutes to wait for a CAPTCHA to clear before giving up (default 4)' },
    ],
  },
];

const LIST_KEYS = new Set(
  CONFIG_SCHEMA.flatMap((g) => g.fields).filter((f) => f.type === 'list').map((f) => f.key)
);

function fieldId(key) { return 'cfg_' + key.replace(/[^a-z0-9]/gi, '_'); }

function renderConfig(values) {
  const wrap = $('#configForm');
  wrap.innerHTML = '';
  for (const grp of CONFIG_SCHEMA) {
    const box = document.createElement('div');
    box.className = 'cfg-group';
    box.innerHTML = `<h3>${grp.group}</h3>`;
    const grid = document.createElement('div');
    grid.className = 'cfg-grid';

    for (const f of grp.fields) {
      const val = values[f.key] ?? '';
      const id = fieldId(f.key);
      const field = document.createElement('div');
      field.className = 'cfg-field';
      // list fields span full width
      if (f.type === 'list') field.style.gridColumn = '1 / -1';

      if (f.type === 'bool') {
        const on = String(val).toLowerCase() === 'true';
        field.innerHTML = `
          <div class="toggle">
            <label class="switch">
              <input type="checkbox" id="${id}" data-key="${f.key}" data-type="bool" ${on ? 'checked' : ''}/>
              <span class="slider"></span>
            </label>
            <div><label>${f.key}</label><div class="desc">${f.desc}</div></div>
          </div>`;
      } else if (f.type === 'list') {
        const text = String(val).split(',').map((s) => s.trim()).filter(Boolean).join('\n');
        field.innerHTML = `
          <label>${f.key} <span class="desc">— ${f.desc}</span></label>
          <textarea id="${id}" data-key="${f.key}" data-type="list">${escapeHtml(text)}</textarea>`;
      } else {
        const t = f.type === 'number' ? 'number' : 'text';
        field.innerHTML = `
          <label>${f.key} <span class="desc">— ${f.desc}</span></label>
          <input type="${t}" id="${id}" data-key="${f.key}" data-type="${f.type}" value="${escapeHtml(String(val))}"/>`;
      }
      grid.appendChild(field);
    }
    box.appendChild(grid);
    wrap.appendChild(box);
  }
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function collectConfig() {
  const values = {};
  $$('#configForm [data-key]').forEach((el) => {
    const key = el.dataset.key;
    const type = el.dataset.type;
    if (type === 'bool') values[key] = el.checked ? 'true' : 'false';
    else if (type === 'list') values[key] = el.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).join(',');
    else values[key] = el.value.trim();
  });
  return values;
}

async function loadConfig() {
  try {
    const data = await api('GET', '/api/config');
    renderConfig(data.values || {});
    $('#rawEnv').value = data.raw || '';
  } catch (e) { toast(e.message, 'err'); }
}

$('#cfgReload').addEventListener('click', loadConfig);
$('#cfgSave').addEventListener('click', async () => {
  try {
    await api('POST', '/api/config', { values: collectConfig() });
    toast('Config saved', 'ok');
    loadConfig();
  } catch (e) { toast(e.message, 'err'); }
});

// Raw .env
$('#rawReload').addEventListener('click', loadConfig);
$('#rawSave').addEventListener('click', async () => {
  try {
    await api('POST', '/api/config', { raw: $('#rawEnv').value });
    toast('Raw .env saved', 'ok');
    loadConfig();
  } catch (e) { toast(e.message, 'err'); }
});

// ════════════════════════════════════════════════════════════════════
//  ACCOUNTS
// ════════════════════════════════════════════════════════════════════
const ACCT_FIELDS = ['email', 'password', 'name', 'gender', 'age', 'dob'];

function acctRow(a = {}) {
  const tr = document.createElement('tr');
  for (const f of ACCT_FIELDS) {
    const td = document.createElement('td');
    const input = document.createElement('input');
    input.dataset.field = f;
    input.value = a[f] ?? '';
    if (f === 'age') input.type = 'number';
    if (f === 'email') input.placeholder = 'name@gmail.com';
    td.appendChild(input);
    tr.appendChild(td);
  }
  const tdDel = document.createElement('td');
  const del = document.createElement('button');
  del.className = 'row-del';
  del.textContent = '✕';
  del.title = 'Remove account';
  del.addEventListener('click', () => { tr.remove(); updateAcctCount(); });
  tdDel.appendChild(del);
  tr.appendChild(tdDel);
  return tr;
}

function updateAcctCount() {
  $('#acctCount').textContent = `(${$('#acctBody').childElementCount})`;
}

function collectAccounts() {
  const out = [];
  $$('#acctBody tr').forEach((tr) => {
    const obj = {};
    tr.querySelectorAll('input').forEach((inp) => {
      let v = inp.value.trim();
      if (inp.dataset.field === 'age') v = v === '' ? '' : Number(v);
      if (v !== '') obj[inp.dataset.field] = v;
    });
    if (obj.email) out.push(obj);
  });
  return out;
}

async function loadAccounts() {
  try {
    const arr = await api('GET', '/api/accounts');
    const body = $('#acctBody');
    body.innerHTML = '';
    arr.forEach((a) => body.appendChild(acctRow(a)));
    updateAcctCount();
  } catch (e) { toast(e.message, 'err'); }
}

$('#acctReload').addEventListener('click', loadAccounts);
$('#acctAdd').addEventListener('click', () => {
  $('#acctBody').appendChild(acctRow());
  updateAcctCount();
  $('#acctBody').lastChild.querySelector('input').focus();
});
$('#acctSave').addEventListener('click', async () => {
  const accounts = collectAccounts();
  try {
    const r = await api('POST', '/api/accounts', accounts);
    toast(`Saved ${r.count} account(s)`, 'ok');
  } catch (e) { toast(e.message, 'err'); }
});

// ── Initial load ────────────────────────────────────────────────────
loadConfig();
loadAccounts();
