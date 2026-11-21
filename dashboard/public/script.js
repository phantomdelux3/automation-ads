// ─── Pennywise dashboard ─────────────────────────────────────
// Polls /api/history and renders a detailed view of the selected run.

const POLL_MS = 3000;
const STALE_MS = 5 * 60 * 1000; // a "running" run with no update for 5 min is probably dead

const OUTCOMES = {
  clicked:       { label: 'Clicked target',       st: 'good',     ic: '✓' },
  'no-target':   { label: 'Ads, no target',       st: 'warning',  ic: '!' },
  'no-ads':      { label: 'No ads shown',         st: 'neutral',  ic: '–' },
  'not-located': { label: 'Target not clickable', st: 'serious',  ic: '?' },
  'click-failed':{ label: 'Click failed',         st: 'serious',  ic: '×' },
  error:         { label: 'Error',                st: 'critical', ic: '!' },
  running:       { label: 'In progress',          st: 'running',  ic: '…' },
};

const state = {
  history: [],
  selectedKey: null,     // run key the user is looking at
  followLatest: true,    // auto-jump to newest run until the user picks one
  lastRendered: '',      // JSON of the last rendered run, to skip no-op re-renders
  lastRunList: '',
  openSessions: new Set(),
  filters: { text: '', keyword: '', outcome: '' },
};

const $ = (id) => document.getElementById(id);

// ─── Helpers ────────────────────────────────────────────────
function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const runKey = (r) => r.id || r.timestamp;
const pct = (n, d) => (d > 0 ? (n / d) * 100 : 0);
const fmtPct = (n, d) => (d > 0 ? `${Math.round(pct(n, d))}%` : '—');
function fmtDuration(ms) {
  if (ms == null || isNaN(ms)) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), rs = s % 60;
  if (m < 60) return `${m}m ${String(rs).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString() : '—');
const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
function ago(iso) {
  if (!iso) return '';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
const normDomain = (d) => String(d || '').toLowerCase().replace(/^www\./, '');
function isTarget(domain, targets) {
  const d = normDomain(domain);
  return (targets || []).some((t) => { const tt = normDomain(t); return d === tt || d.endsWith('.' + tt); });
}

function runStatus(run) {
  if (!run.status) return 'recorded';
  if (run.status === 'running' && run.lastUpdate && Date.now() - new Date(run.lastUpdate).getTime() > STALE_MS) return 'stale';
  return run.status;
}
const STATUS_LABEL = { running: 'Running', completed: 'Completed', stopped: 'Stopped', stale: 'Not responding', recorded: 'Recorded' };

function outcomeOf(s) {
  if (s.outcome && OUTCOMES[s.outcome]) return s.outcome;
  // Older session records without an explicit outcome
  if (s.success) return 'clicked';
  if (!s.hasSponsored) return 'no-ads';
  if (!s.hasTargetDomain) return 'no-target';
  return 'click-failed';
}
function badge(outcome) {
  const o = OUTCOMES[outcome] || OUTCOMES.error;
  return `<span class="badge st-${o.st}"><span class="ic">${o.ic}</span>${esc(o.label)}</span>`;
}
function miniBar(n, d, text) {
  const w = Math.max(0, Math.min(100, pct(n, d)));
  return `<div class="mini"><div class="track"><div class="fill" style="width:${w}%"></div></div><span class="pct">${text ?? fmtPct(n, d)}</span></div>`;
}

// ─── Derived run data ───────────────────────────────────────
function deriveRun(run) {
  const sessions = Array.isArray(run.sessions) ? run.sessions : [];
  const hasDetail = sessions.length > 0 || Array.isArray(run.sessions);
  const targets = run.config?.targetDomains || [];
  const kwData = run.keywordData || {};

  // Keyword rows
  const keywords = new Map();
  const ensureKw = (k) => {
    if (!keywords.has(k)) keywords.set(k, { keyword: k, sessions: 0, withAds: 0, adsSum: 0, adsMax: 0, targetSeen: 0, clicks: 0, success: 0 });
    return keywords.get(k);
  };
  // Domain rows
  const domains = new Map();
  const ensureDom = (d) => {
    if (!domains.has(d)) domains.set(d, { domain: d, count: 0, keywords: new Set() });
    return domains.get(d);
  };

  const outcomes = {};
  let durSum = 0, durN = 0;

  if (hasDetail) {
    for (const s of sessions) {
      const k = ensureKw(s.keyword || '(unknown)');
      k.sessions++;
      if (s.hasSponsored) { k.withAds++; k.adsSum += s.sponsoredCount || 0; k.adsMax = Math.max(k.adsMax, s.sponsoredCount || 0); }
      if (s.hasTargetDomain) k.targetSeen++;
      k.clicks += s.clickedTargets || 0;
      if (s.success) k.success++;
      for (const d of s.sponsoredDomains || []) { const e = ensureDom(normDomain(d)); e.count++; e.keywords.add(s.keyword); }
      const o = outcomeOf(s);
      outcomes[o] = (outcomes[o] || 0) + 1;
      if (s.durationMs) { durSum += s.durationMs; durN++; }
    }
  } else {
    // Legacy run: only keyword aggregates are available
    for (const [kw, d] of Object.entries(kwData)) {
      const k = ensureKw(kw);
      k.sessions = d.totalSessions || 0;
      k.withAds = d.sponsoredSessions || 0;
      k.adsMax = d.sponsoredMax || 0;
      k.adsSum = null;
      k.targetSeen = d.targetsMax > 0 ? null : 0;
      k.clicks = null;
      k.success = null;
      for (const [dom, c] of Object.entries(d.adDomains || {})) { const e = ensureDom(normDomain(dom)); e.count += c; e.keywords.add(kw); }
    }
  }

  const total = run.totalSessions || sessions.length || 0;
  const withAds = hasDetail ? sessions.filter((s) => s.hasSponsored).length : [...keywords.values()].reduce((a, k) => a + k.withAds, 0);
  const targetSeen = hasDetail ? sessions.filter((s) => s.hasTargetDomain).length : null;

  return {
    sessions, hasDetail, targets,
    keywords: [...keywords.values()],
    domains: [...domains.values()].sort((a, b) => b.count - a.count),
    outcomes, total, withAds, targetSeen,
    successes: run.successes || 0,
    targetClicks: run.targetClicks || 0,
    avgDuration: durN ? durSum / durN : null,
    sessionsDropped: run.sessionsDropped || 0,
  };
}

// ─── Data loading ───────────────────────────────────────────
async function loadData(isRetry = false) {
  const ind = $('refresh-indicator');
  try {
    // The server only includes per-session records for the run we ask for
    const q = state.selectedKey && !state.followLatest ? `?run=${encodeURIComponent(state.selectedKey)}` : '';
    const res = await fetch(`/api/history${q}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(res.statusText);
    const data = await res.json();
    state.history = Array.isArray(data) ? data : [];
    ind.className = 'refresh ok';
    $('refresh-text').textContent = `Live · updated ${new Date().toLocaleTimeString()}`;
  } catch (e) {
    ind.className = 'refresh err';
    $('refresh-text').textContent = 'Connection lost — retrying';
    return;
  }

  if (state.history.length === 0) {
    $('main').classList.add('hidden');
    $('empty').classList.remove('hidden');
    $('run-selector').innerHTML = '<option>No runs yet</option>';
    return;
  }
  $('main').classList.remove('hidden');
  $('empty').classList.add('hidden');

  const keys = state.history.map(runKey);
  if (state.followLatest || !keys.includes(state.selectedKey)) {
    if (state.selectedKey !== keys[0]) state.openSessions.clear();
    state.selectedKey = keys[0];
  }

  renderRunSelector();
  const run = state.history.find((r) => runKey(r) === state.selectedKey);
  // Sessions weren't sent for this run (we switched to it this tick) - fetch it right away
  if (!Array.isArray(run.sessions) && run.sessionCount != null && !isRetry) return loadData(true);
  const snapshot = JSON.stringify(run) + runStatus(run);
  if (snapshot !== state.lastRendered) {
    state.lastRendered = snapshot;
    render(run);
  }
  renderHistory(); // cheap, keeps "x ago" and selection fresh
}

function renderRunSelector() {
  const sel = $('run-selector');
  const n = state.history.length;
  const opts = state.history.map((r, i) => {
    const st = runStatus(r);
    const tag = st === 'running' ? ' · LIVE' : st === 'stale' ? ' · not responding' : st === 'stopped' ? ' · stopped' : '';
    return { key: runKey(r), text: `Run ${n - i} — ${fmtDateTime(r.timestamp)} (${r.totalSessions || 0} sessions)${tag}` };
  });
  const sig = JSON.stringify(opts) + state.selectedKey;
  if (sig === state.lastRunList) return;
  state.lastRunList = sig;
  sel.innerHTML = opts.map((o) => `<option value="${esc(o.key)}" ${o.key === state.selectedKey ? 'selected' : ''}>${esc(o.text)}</option>`).join('');
}

function selectRun(key) {
  state.selectedKey = key;
  state.followLatest = key === runKey(state.history[0]);
  state.openSessions.clear();
  state.filters = { text: '', keyword: '', outcome: '' };
  $('filter-text').value = '';
  state.lastRendered = '';
  state.lastRunList = '';
  loadData();
}

// ─── Render ─────────────────────────────────────────────────
function render(run) {
  const d = deriveRun(run);
  const idx = state.history.findIndex((r) => runKey(r) === runKey(run));
  renderHeader(run, d, state.history.length - idx);
  renderKpis(run, d);
  renderFunnel(d);
  renderOutcomes(d);
  renderTimeline(run, d);
  renderKeywords(d);
  renderDomains(d);
  renderFilterOptions(d);
  renderSessions(d);
}

function renderHeader(run, d, num) {
  const st = runStatus(run);
  $('run-title').textContent = `Run ${num}`;
  const pill = $('run-status');
  pill.className = `status-pill ${st}`;
  pill.textContent = STATUS_LABEL[st] || st;

  const elapsedMs = parseFloat(run.elapsed || 0) * 1000;
  const parts = [
    `Started ${fmtDateTime(run.timestamp)}`,
    `Running time ${fmtDuration(elapsedMs)}`,
  ];
  if (run.loop && run.config?.loopBot) parts.push(`Loop #${run.loop}`);
  if (run.lastUpdate) parts.push(`Last update ${ago(run.lastUpdate)}`);
  $('run-meta').textContent = parts.join('  ·  ');

  const live = $('live-session');
  if (run.currentSession && st === 'running') {
    live.classList.remove('hidden');
    $('live-session-text').innerHTML =
      `<b>${esc(run.currentSession.label)}</b> · “${esc(run.currentSession.keyword)}” · started ${esc(ago(run.currentSession.startedAt))}`;
  } else {
    live.classList.add('hidden');
  }

  const c = run.config;
  const chips = [];
  if (c) {
    chips.push(`Targets: <b>${esc((c.targetDomains || []).join(', ') || '—')}</b>`);
    chips.push(`Keywords: <b>${(c.keywords || []).length}</b>`);
    chips.push(`Sessions / keyword: <b>${esc(c.sessionsPerKeyword)}</b>`);
    chips.push(`Mode: <b>${c.sponsoredOnly ? 'Sponsored only' : 'Sponsored + organic'}</b>`);
    chips.push(`Loop: <b>${c.loopBot ? 'on' : 'off'}</b>`);
    chips.push(`Cookie warmup: <b>${c.cookieWarmup ? 'on' : 'off'}</b>`);
    chips.push(`Search history: <b>${c.searchHistory ? 'on' : 'off'}</b>`);
    chips.push(`Headless: <b>${c.headless ? 'yes' : 'no'}</b>`);
    chips.push(`Proxies: <b>${esc(c.proxies)}</b>`);
    chips.push(`Accounts: <b>${esc(c.accounts)}</b>`);
  } else {
    chips.push('Run settings were not recorded for this run');
  }
  $('run-config').innerHTML = chips.map((t) => `<span class="chip">${t}</span>`).join('');
}

function renderKpis(run, d) {
  const tiles = [
    { label: 'Sessions', value: d.total, sub: run.config ? `${(run.config.keywords || []).length} keywords configured` : `${d.keywords.length} keywords` },
    { label: 'Successful sessions', value: d.successes, sub: `${fmtPct(d.successes, d.total)} success rate` },
    { label: 'Target ad clicks', value: d.targetClicks, sub: d.successes ? `${(d.targetClicks / d.successes).toFixed(1)} per successful session` : 'no clicks yet' },
    { label: 'Ads shown', value: fmtPct(d.withAds, d.total), sub: `${d.withAds} of ${d.total} sessions had ads` },
    { label: 'Target visible', value: d.targetSeen == null ? '—' : fmtPct(d.targetSeen, d.total), sub: d.targetSeen == null ? 'not tracked in this run' : `${d.targetSeen} of ${d.total} sessions` },
    { label: 'Avg session time', value: fmtDuration(d.avgDuration), sub: `Run time ${fmtDuration(parseFloat(run.elapsed || 0) * 1000)}` },
  ];
  $('kpis').innerHTML = tiles.map((t) => `
    <div class="kpi">
      <div class="k-label">${esc(t.label)}</div>
      <div class="k-value">${esc(t.value)}</div>
      <div class="k-sub">${esc(t.sub)}</div>
    </div>`).join('');
}

function renderFunnel(d) {
  const steps = [
    { label: 'Sessions run', n: d.total },
    { label: 'Ads shown', n: d.withAds },
    { label: 'Target domain visible', n: d.targetSeen },
    { label: 'Target clicked', n: d.hasDetail ? d.successes : d.successes },
  ];
  $('funnel').innerHTML = steps.map((s) => {
    if (s.n == null) {
      return `<div class="bar-row"><div class="b-label">${esc(s.label)}</div><div class="track"></div><div class="b-value"><span>not tracked</span></div></div>`;
    }
    return `<div class="bar-row">
      <div class="b-label">${esc(s.label)}</div>
      <div class="track"><div class="fill" style="width:${pct(s.n, d.total)}%"></div></div>
      <div class="b-value">${s.n}<span>${fmtPct(s.n, d.total)}</span></div>
    </div>`;
  }).join('');
}

function renderOutcomes(d) {
  const el = $('outcomes');
  if (!d.hasDetail) {
    el.innerHTML = `<p class="muted small">Not available — this run predates per-session tracking.</p>`;
    return;
  }
  const total = d.sessions.length;
  const order = ['clicked', 'no-target', 'no-ads', 'not-located', 'click-failed', 'error'];
  el.innerHTML = order.map((o) => {
    const n = d.outcomes[o] || 0;
    return `<div class="bar-row outcome-row ${n ? '' : 'zero'}" data-outcome="${o}" title="Filter session log">
      <div class="b-label">${badge(o)}</div>
      <div class="track"><div class="fill" style="width:${pct(n, total)}%"></div></div>
      <div class="b-value">${n}<span>${fmtPct(n, total)}</span></div>
    </div>`;
  }).join('');
  el.querySelectorAll('.outcome-row').forEach((row) => row.addEventListener('click', () => {
    setFilter('outcome', row.dataset.outcome);
    $('session-table').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
}

function renderTimeline(run, d) {
  const el = $('timeline');
  if (!d.hasDetail) {
    el.innerHTML = `<p class="muted small">Not available — this run predates per-session tracking.</p>`;
    return;
  }
  const items = d.sessions.map((s, i) => ({ s, i, o: outcomeOf(s) }));
  let html = items.map(({ s, i, o }) => {
    const oc = OUTCOMES[o];
    return `<div class="sq st-${oc.st}" data-i="${i}" aria-label="${esc(s.label)} ${esc(oc.label)}">${oc.ic}</div>`;
  }).join('');
  if (run.currentSession && runStatus(run) === 'running') {
    html += `<div class="sq st-running" data-live="1">…</div>`;
  }
  if (!html) html = `<p class="muted small">No sessions finished yet.</p>`;
  const used = [...new Set(items.map((x) => x.o))];
  if (run.currentSession && runStatus(run) === 'running') used.push('running');
  el.innerHTML = `<div class="timeline">${html}</div>` +
    (used.length ? `<div class="timeline-legend">${used.map(badge).join('')}</div>` : '');

  el.querySelectorAll('.sq').forEach((sq) => {
    sq.addEventListener('mousemove', (e) => {
      if (sq.dataset.live) {
        const c = run.currentSession;
        showTip(e, `<div class="t-title">${esc(c.label)} — in progress</div><div class="t-row">“${esc(c.keyword)}”</div><div class="t-row">Started ${esc(fmtTime(c.startedAt))}</div>`);
        return;
      }
      const s = d.sessions[+sq.dataset.i];
      showTip(e, `
        <div class="t-title">${esc(s.label)} — ${esc(OUTCOMES[outcomeOf(s)].label)}</div>
        <div class="t-row">“${esc(s.keyword)}”</div>
        <div class="t-row">${s.sponsoredCount || 0} ads · ${s.targetCount || 0} target · ${s.clickedTargets || 0} clicks</div>
        <div class="t-row">${esc(fmtDuration(s.durationMs))} · ended ${esc(fmtTime(s.endedAt))}</div>`);
    });
    sq.addEventListener('mouseleave', hideTip);
    sq.addEventListener('click', () => {
      if (sq.dataset.live) return;
      const s = d.sessions[+sq.dataset.i];
      openSession(sessionId(s, +sq.dataset.i));
    });
  });
}

function renderKeywords(d) {
  const tbody = document.querySelector('#keyword-table tbody');
  if (d.keywords.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-cell">No keyword data yet.</td></tr>`;
    return;
  }
  const rows = [...d.keywords].sort((a, b) => b.sessions - a.sessions || a.keyword.localeCompare(b.keyword));
  tbody.innerHTML = rows.map((k) => {
    const avg = k.adsSum == null ? '—' : (k.withAds ? (k.adsSum / k.withAds).toFixed(1) : '0');
    const target = k.targetSeen == null ? '<span class="muted small">seen</span>' : miniBar(k.targetSeen, k.sessions, `${k.targetSeen}/${k.sessions}`);
    const success = k.success == null ? '<span class="muted small">—</span>' : miniBar(k.success, k.sessions, `${k.success}/${k.sessions}`);
    const sel = state.filters.keyword === k.keyword ? 'selected' : '';
    return `<tr class="clickable ${sel}" data-kw="${esc(k.keyword)}">
      <td class="kw">${esc(k.keyword)}</td>
      <td class="num">${k.sessions}</td>
      <td>${miniBar(k.withAds, k.sessions, `${k.withAds}/${k.sessions}`)}</td>
      <td class="num">${avg} / ${k.adsMax}</td>
      <td>${target}</td>
      <td class="num">${k.clicks == null ? '—' : k.clicks}</td>
      <td>${success}</td>
    </tr>`;
  }).join('');
  tbody.querySelectorAll('tr.clickable').forEach((tr) => tr.addEventListener('click', () => {
    setFilter('keyword', state.filters.keyword === tr.dataset.kw ? '' : tr.dataset.kw);
  }));
}

function renderDomains(d) {
  const tbody = document.querySelector('#domain-table tbody');
  if (d.domains.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="empty-cell">No sponsored ads detected in this run.</td></tr>`;
    return;
  }
  tbody.innerHTML = d.domains.map((x) => `
    <tr class="clickable" data-dom="${esc(x.domain)}">
      <td><span class="mono">${esc(x.domain)}</span>${isTarget(x.domain, d.targets) ? '<span class="tag-target">target</span>' : ''}</td>
      <td>${miniBar(x.count, d.total)}</td>
      <td class="num">${x.count}</td>
      <td class="kw-list">${[...x.keywords].map(esc).join(', ')}</td>
    </tr>`).join('');
  tbody.querySelectorAll('tr.clickable').forEach((tr) => tr.addEventListener('click', () => {
    setFilter('text', tr.dataset.dom);
    $('filter-text').value = tr.dataset.dom;
    $('session-table').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
}

function renderFilterOptions(d) {
  const kwSel = $('filter-keyword');
  const kws = d.keywords.map((k) => k.keyword).sort();
  kwSel.innerHTML = `<option value="">All keywords</option>` +
    kws.map((k) => `<option value="${esc(k)}" ${k === state.filters.keyword ? 'selected' : ''}>${esc(k)}</option>`).join('');
  const ocSel = $('filter-outcome');
  ocSel.innerHTML = `<option value="">All outcomes</option>` +
    Object.entries(OUTCOMES).filter(([k]) => k !== 'running')
      .map(([k, o]) => `<option value="${k}" ${k === state.filters.outcome ? 'selected' : ''}>${esc(o.label)}${d.outcomes[k] ? ` (${d.outcomes[k]})` : ''}</option>`).join('');
}

const sessionId = (s, i) => `${s.label || 'S'}|${s.startedAt || s.endedAt || i}`;

function sessionMatches(s) {
  const f = state.filters;
  if (f.keyword && s.keyword !== f.keyword) return false;
  if (f.outcome && outcomeOf(s) !== f.outcome) return false;
  if (f.text) {
    const hay = [s.label, s.keyword, s.profile, s.ip, s.timezone, s.locale, s.reason,
      ...(s.sponsoredDomains || []), ...(s.clicks || []).map((c) => `${c.domain} ${c.landingUrl || ''}`)].join(' ').toLowerCase();
    if (!hay.includes(f.text.toLowerCase())) return false;
  }
  return true;
}

function renderSessions(d) {
  const tbody = document.querySelector('#session-table tbody');
  $('legacy-note').classList.toggle('hidden', d.hasDetail);
  if (!d.hasDetail) {
    tbody.innerHTML = '';
    $('session-count').textContent = '';
    return;
  }
  const list = d.sessions.map((s, i) => ({ s, i, id: sessionId(s, i) })).filter(({ s }) => sessionMatches(s)).reverse();
  const anyFilter = state.filters.text || state.filters.keyword || state.filters.outcome;
  const dropped = d.sessionsDropped ? ` · ${d.sessionsDropped} older sessions not kept` : '';
  $('session-count').textContent = (anyFilter ? `${list.length} of ${d.sessions.length} sessions` : `${d.sessions.length} sessions · newest first · click a row for details`) + dropped;

  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" class="empty-cell">${d.sessions.length ? 'No sessions match the filters.' : 'No sessions finished yet.'}</td></tr>`;
    return;
  }

  tbody.innerHTML = list.map(({ s, id }) => {
    const open = state.openSessions.has(id);
    const o = outcomeOf(s);
    const target = s.hasTargetDomain
      ? `<span class="badge st-good"><span class="ic">✓</span>${s.targetCount || 1}${s.targetInSponsored ? ' in ads' : s.targetInOrganic ? ' organic' : ''}</span>`
      : `<span class="muted small">none</span>`;
    const row = `<tr class="clickable ${open ? 'open' : ''}" data-id="${esc(id)}">
      <td><span class="caret">▶</span></td>
      <td class="mono">${esc(s.label)}</td>
      <td class="kw">${esc(s.keyword)}</td>
      <td>${badge(o)}</td>
      <td class="num">${s.sponsoredCount || 0}</td>
      <td>${target}</td>
      <td class="num">${s.clickedTargets || 0}</td>
      <td class="small">${esc(s.profile || '—')}</td>
      <td class="num">${esc(fmtDuration(s.durationMs))}</td>
      <td class="small">${esc(fmtTime(s.endedAt))}</td>
    </tr>`;
    return row + (open ? sessionDetail(s, o, d.targets) : '');
  }).join('');

  tbody.querySelectorAll('tr.clickable').forEach((tr) => tr.addEventListener('click', () => {
    const id = tr.dataset.id;
    if (state.openSessions.has(id)) state.openSessions.delete(id); else state.openSessions.add(id);
    renderSessions(d);
  }));
}

function sessionDetail(s, o, targets) {
  const oc = OUTCOMES[o];
  const ads = (s.sponsoredDomains || []);
  const clicks = (s.clicks || []);
  const reason = s.reason || (o === 'clicked' ? `Clicked ${s.clickedTargets || 0} target result(s) and browsed the landing page.` : oc.label);
  return `<tr class="detail"><td colspan="10"><div class="detail-body">
    <div class="reason st-${oc.st}">${badge(o)} &nbsp;${esc(reason)}</div>
    <div>
      <h4>Session</h4>
      <dl class="kv">
        <dt>Label</dt><dd class="mono">${esc(s.label)}${s.loop ? ` (loop ${esc(s.loop)})` : ''}</dd>
        <dt>Keyword</dt><dd>${esc(s.keyword)}</dd>
        <dt>Started</dt><dd>${esc(fmtDateTime(s.startedAt))}</dd>
        <dt>Ended</dt><dd>${esc(fmtDateTime(s.endedAt))}</dd>
        <dt>Duration</dt><dd>${esc(fmtDuration(s.durationMs))}</dd>
        ${s.stage && o === 'error' ? `<dt>Failed at</dt><dd>${esc(s.stage)}</dd>` : ''}
      </dl>
    </div>
    <div>
      <h4>Browser &amp; network</h4>
      <dl class="kv">
        <dt>Profile</dt><dd>${esc(s.profile || '—')}</dd>
        <dt>IP</dt><dd class="mono">${esc(s.ip || '—')}</dd>
        <dt>Proxy</dt><dd>${s.proxy == null ? '—' : s.proxy ? 'yes' : 'direct'}</dd>
        <dt>Timezone</dt><dd>${esc(s.timezone || '—')}</dd>
        <dt>Locale</dt><dd>${esc(s.locale || '—')}</dd>
        <dt>Viewport</dt><dd>${esc(s.viewport || '—')}</dd>
      </dl>
    </div>
    <div>
      <h4>Results page</h4>
      <dl class="kv">
        <dt>Ads shown</dt><dd>${s.sponsoredCount || 0}</dd>
        <dt>Target links</dt><dd>${s.targetCount || 0}${s.targetInSponsored ? ' (in ads)' : ''}${s.targetInOrganic ? ' (organic)' : ''}</dd>
      </dl>
      <h4 style="margin-top:.8rem">Advertisers</h4>
      <div class="domain-pills">${ads.length ? ads.map((a) => `<span class="${isTarget(a, targets) ? 'is-target' : ''}">${esc(normDomain(a))}</span>`).join('') : '<span class="muted small">none</span>'}</div>
    </div>
    ${clicks.length ? `<div style="grid-column:1/-1">
      <h4>Clicks</h4>
      <ul class="click-list">${clicks.map((c, i) => `<li>
        ${c.clicked ? '<span class="badge st-good"><span class="ic">✓</span>Clicked</span>' : '<span class="badge st-serious"><span class="ic">×</span>Click failed</span>'}
        &nbsp;<b>${esc(c.domain)}</b> <span class="muted small">(${esc(c.type)}${c.dwellMs ? ` · on site ${esc(fmtDuration(c.dwellMs))}` : ''})</span>
        ${c.landingUrl ? `<div class="url">${esc(c.landingUrl)}</div>` : ''}
      </li>`).join('')}</ul>
    </div>` : ''}
  </div></td></tr>`;
}

function openSession(id) {
  state.filters = { text: '', keyword: '', outcome: '' };
  $('filter-text').value = '';
  state.openSessions.add(id);
  rerender();
  const tr = document.querySelector(`#session-table tr[data-id="${CSS.escape(id)}"]`);
  if (tr) tr.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function setFilter(key, value) {
  state.filters[key] = value;
  rerender();
}
function rerender() {
  const run = state.history.find((r) => runKey(r) === state.selectedKey);
  if (run) render(run);
}

// ─── Run history ────────────────────────────────────────────
function renderHistory() {
  const runs = state.history;
  const n = runs.length;
  const tbody = document.querySelector('#history-table tbody');
  tbody.innerHTML = runs.map((r, i) => {
    const d = deriveRun(r);
    const st = runStatus(r);
    const sel = runKey(r) === state.selectedKey ? 'selected' : '';
    return `<tr class="clickable ${sel}" data-key="${esc(runKey(r))}">
      <td><b>Run ${n - i}</b></td>
      <td>${esc(fmtDateTime(r.timestamp))}</td>
      <td><span class="status-pill ${st}">${esc(STATUS_LABEL[st] || st)}</span></td>
      <td class="num">${d.total}</td>
      <td class="num">${d.successes}</td>
      <td class="num">${fmtPct(d.successes, d.total)}</td>
      <td class="num">${fmtPct(d.withAds, d.total)}</td>
      <td class="num">${esc(fmtDuration(parseFloat(r.elapsed || 0) * 1000))}</td>
    </tr>`;
  }).join('');
  tbody.querySelectorAll('tr.clickable').forEach((tr) => tr.addEventListener('click', () => selectRun(tr.dataset.key)));

  // Bar chart: success rate per run, oldest → newest
  const chron = [...runs].reverse();
  const W = 1000, H = 170, padL = 36, padB = 22, padT = 10;
  const iw = W - padL - 8, ih = H - padB - padT;
  const slot = iw / Math.max(chron.length, 1);
  const bw = Math.min(48, slot - 4);
  let svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Success rate per run">`;
  for (const g of [0, 50, 100]) {
    const y = padT + ih - (g / 100) * ih;
    svg += `<line class="grid" x1="${padL}" x2="${W - 8}" y1="${y}" y2="${y}"/><text x="${padL - 6}" y="${y + 4}" text-anchor="end">${g}%</text>`;
  }
  chron.forEach((r, i) => {
    const d = deriveRun(r);
    const rate = pct(d.successes, d.total);
    const h = Math.max(d.total ? 2 : 0, (rate / 100) * ih);
    const x = padL + i * slot + (slot - bw) / 2;
    const y = padT + ih - h;
    const sel = runKey(r) === state.selectedKey ? 'sel' : '';
    // rounded top only, anchored on the baseline
    const rr = Math.min(4, h, bw / 2);
    svg += `<path class="bar ${sel}" d="M${x},${y + h} V${y + rr} Q${x},${y} ${x + rr},${y} H${x + bw - rr} Q${x + bw},${y} ${x + bw},${y + rr} V${y + h} Z"/>`;
    svg += `<rect class="bar-hit" data-key="${esc(runKey(r))}" data-i="${i}" x="${padL + i * slot}" y="${padT}" width="${slot}" height="${ih}"/>`;
    svg += `<text x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">R${i + 1}</text>`;
  });
  svg += `</svg>`;
  const chart = $('history-chart');
  chart.innerHTML = svg;
  chart.querySelectorAll('.bar-hit').forEach((hit) => {
    const r = chron[+hit.dataset.i];
    hit.addEventListener('mousemove', (e) => {
      const d = deriveRun(r);
      showTip(e, `<div class="t-title">Run ${+hit.dataset.i + 1} — ${esc(fmtDateTime(r.timestamp))}</div>
        <div class="t-row">Success ${fmtPct(d.successes, d.total)} (${d.successes}/${d.total})</div>
        <div class="t-row">Ads shown ${fmtPct(d.withAds, d.total)} · ${d.targetClicks} target clicks</div>`);
    });
    hit.addEventListener('mouseleave', hideTip);
    hit.addEventListener('click', () => selectRun(hit.dataset.key));
  });
}

// ─── Tooltip ────────────────────────────────────────────────
function showTip(e, html) {
  const t = $('tooltip');
  t.innerHTML = html;
  t.classList.remove('hidden');
  const pad = 14;
  let x = e.clientX + pad, y = e.clientY + pad;
  const r = t.getBoundingClientRect();
  if (x + r.width > window.innerWidth - 8) x = e.clientX - r.width - pad;
  if (y + r.height > window.innerHeight - 8) y = e.clientY - r.height - pad;
  t.style.left = `${x}px`;
  t.style.top = `${y}px`;
}
function hideTip() { $('tooltip').classList.add('hidden'); }

// ─── Wire up ────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  $('run-selector').addEventListener('change', (e) => selectRun(e.target.value));
  let t;
  $('filter-text').addEventListener('input', (e) => {
    clearTimeout(t);
    t = setTimeout(() => setFilter('text', e.target.value.trim()), 150);
  });
  $('filter-keyword').addEventListener('change', (e) => setFilter('keyword', e.target.value));
  $('filter-outcome').addEventListener('change', (e) => setFilter('outcome', e.target.value));
  $('filter-clear').addEventListener('click', () => {
    state.filters = { text: '', keyword: '', outcome: '' };
    $('filter-text').value = '';
    rerender();
  });

  loadData();
  setInterval(loadData, POLL_MS);
});
