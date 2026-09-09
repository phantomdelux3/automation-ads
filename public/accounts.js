// ════════════════════════════════════════════════════════════════════
//  ACCOUNT PROFILE HEALTH  (check / re-login / cookie pool / provision)
// ════════════════════════════════════════════════════════════════════
//
// Loaded after app.js and shares its helpers ($, api, toast, badge,
// escapeHtml, runTask) through the global scope.
//
// The table here shows what the LAST check observed, not a live reading:
// finding out for real means launching Chrome once per account, which is a
// button, not a page load. The scripts write what they saw to
// profile-state.json and this only renders it.

let acctState = null;

const VERDICTS = {
  'signed-in': { label: 'signed in', kind: 'ok' },
  'signed-out': { label: 'SIGNED OUT', kind: 'bad' },
  unchecked: { label: 'not checked', kind: '' },
  'needs-import': { label: 'NEEDS IMPORT', kind: 'bad' },
  missing: { label: 'no profile', kind: 'warn' },
};

/**
 * How much Google trust the cookie jar carries, as graded by cookieHealth on
 * the server. This is the column that predicts a reCAPTCHA: a "cold" profile
 * is one Google has no memory of.
 */
const WARMTH = {
  strong: { label: 'strong', kind: 'ok' },
  ok: { label: 'ok', kind: 'ok' },
  thin: { label: 'thin', kind: 'warn' },
  cold: { label: 'COLD', kind: 'bad' },
};

function warmthBadge(verdict) {
  if (!verdict) return badge('not warmed', '');
  const w = WARMTH[verdict] || { label: verdict, kind: '' };
  return badge(w.label, w.kind);
}

function timeAgo(iso) {
  if (!iso) return '—';
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(secs)) return '—';
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function renderAcctBanner(s) {
  const c = s.counts;
  const parts = [];

  if (c.needsImport > 0) {
    parts.push(
      `<div class="xfer-banner bad"><b>${c.needsImport} profile(s) still carry another machine's
       encryption key.</b> Run <b>Import Profiles</b> on the Transfer tab first — signing in before
       that would sign into a profile whose old cookies are about to be wiped.</div>`
    );
  }

  if (c.signedOut > 0) {
    parts.push(
      `<div class="xfer-banner warn"><b>${c.signedOut} account(s) are signed out.</b>
       Their profiles are intact and still trusted — they only lost the login cookies in the move.
       Click <b>Re-login signed-out</b>.</div>`
    );
  } else if (c.accounts > 0 && c.unchecked === c.accounts) {
    parts.push(
      `<div class="xfer-banner info"><b>Nothing has been checked yet.</b> Click <b>Check logins</b>
       to open each profile and ask Google whether it is still signed in.</div>`
    );
  } else if (c.signedIn > 0 && c.signedOut === 0 && c.needsProvisioning === 0) {
    parts.push(
      `<div class="xfer-banner ok"><b>${c.signedIn}/${c.accounts} account(s) confirmed signed in.</b>
       The bot can be started.</div>`
    );
  }

  if (c.needsProvisioning > 0) {
    const pool =
      c.poolFree >= c.needsProvisioning
        ? `The pool has ${c.poolFree} warm profile(s) ready for them.`
        : `The pool holds only ${c.poolFree} warm profile(s) — build ${c.poolShortfall} more first,
           or they will get cold profiles that have to be warmed on the spot.`;
    parts.push(
      `<div class="xfer-banner warn"><b>${c.needsProvisioning} account(s) have no profile yet.</b>
       ${pool}</div>`
    );
  }

  $('#acctBanner').innerHTML = parts.join('');
}

function renderAcctStatusTable(s) {
  const body = $('#acctStatusBody');
  body.innerHTML = '';

  for (const a of s.accounts) {
    const v = VERDICTS[a.verdict] || VERDICTS.unchecked;
    let note = '—';
    if (a.lastError) note = `<span class="badge bad">${escapeHtml(a.lastError)}</span>`;
    else if (a.lastMessage) note = escapeHtml(a.lastMessage);
    else if (!a.hasPassword) note = badge('no password', 'warn');

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="name">${escapeHtml(a.email)}</td>
      <td class="ident">${escapeHtml(a.profile)}</td>
      <td>${a.fromPool ? badge('warm pool', 'info') : badge('own profile', '')}</td>
      <td>${badge(v.label, v.kind)}</td>
      <td>${a.cookies === null ? '—' : a.cookies}</td>
      <td>${warmthBadge(a.cookieVerdict)}</td>
      <td>${timeAgo(a.lastCheckAt)}</td>
      <td>${note}</td>`;
    body.appendChild(tr);
  }

  $('#acctStatusCount').textContent = `(${s.accounts.length})`;
}

function renderPoolTable(s) {
  const body = $('#poolBody');
  body.innerHTML = '';

  for (const p of s.pool) {
    const id = p.identity;
    const cookies =
      p.cookies === null
        ? '—'
        : `${p.cookies}${p.googleCookies !== null ? ` (${p.googleCookies} Google)` : ''}`;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="name">${escapeHtml(p.name)}</td>
      <td>${p.free ? badge('free', 'ok') : badge(`used by ${escapeHtml(p.assignedTo)}`, 'info')}</td>
      <td>${cookies}</td>
      <td>${warmthBadge(p.cookieVerdict)}</td>
      <td>${timeAgo(p.warmedAt)}</td>
      <td class="ident">${id ? `${id.seed} · ${id.timezone} · ${id.screen}` : '—'}</td>`;
    body.appendChild(tr);
  }

  if (s.pool.length === 0) {
    body.innerHTML =
      '<tr><td colspan="6" class="desc">No pool profiles yet — build some above so new accounts have a warm browser to sign into.</td></tr>';
  }

  $('#poolCount2').textContent = `(${s.pool.length})`;
  $('#poolSummary').textContent =
    `Pool: ${s.counts.poolTotal} profile(s) — ${s.counts.poolFree} free, ${s.counts.poolAssigned} in use.`;
  const cold = s.accounts.filter((a) => a.cookieVerdict === 'cold' || a.cookieVerdict === 'thin').length;
  const never = s.accounts.filter((a) => !a.cookieVerdict).length;
  $('#rewarmSummary').textContent =
    cold > 0
      ? `${cold} profile(s) are carrying weak Google cookies — re-warm them before the next run.`
      : never === s.accounts.length
        ? 'Cookie warmth has never been measured. Run this once to find out where the profiles stand.'
        : 'All measured profiles are carrying healthy Google cookies.';

  $('#provisionSummary').textContent =
    s.counts.needsProvisioning === 0
      ? 'Every account already has a profile.'
      : `${s.counts.needsProvisioning} account(s) waiting, ${s.counts.poolFree} warm profile(s) available.`;
}

/** These tasks share the one child-process slot with export/import/pack. */
function setAcctTaskState(t) {
  const stop = $('#btnAcctStop');
  if (!stop) return;
  const running = !!(t && t.running);
  stop.disabled = !running;
  [
    '#btnCheckLogins',
    '#btnRelogin',
    '#btnReloginAll',
    '#btnBuildCookies',
    '#btnRewarmup',
    '#btnProvision',
  ].forEach(
    (sel) => {
      const el = $(sel);
      if (el) el.disabled = running;
    }
  );
  $('#acctTaskState').textContent = running
    ? `${t.label} running…  (watch the Control & Logs tab)`
    : 'No task running.';
}

async function loadAccountStatus() {
  try {
    const s = await api('GET', '/api/accounts/status');
    acctState = s;
    renderAcctBanner(s);
    renderAcctStatusTable(s);
    renderPoolTable(s);
    setAcctTaskState(s.task);
  } catch (e) {
    toast(e.message, 'err');
  }
}

const headedRun = () => $('#acctHeaded').checked;

/**
 * Re-logging in before an import would sign into a profile whose cookie store
 * is about to be torn down and rebuilt, so both re-login buttons refuse.
 */
function blockedByPendingImport() {
  if (acctState && acctState.counts.needsImport > 0) {
    toast('Import those profiles on the Transfer tab first', 'err');
    return true;
  }
  return false;
}

$('#acctStatusReload').addEventListener('click', loadAccountStatus);

$('#btnCheckLogins').addEventListener('click', () =>
  // Check-only never needs a visible window: it only reads the session back.
  runTask('relogin', { checkOnly: true }, 'Checking logins…')
);

$('#btnRelogin').addEventListener('click', () => {
  if (blockedByPendingImport()) return;
  runTask('relogin', { headed: headedRun() }, 'Re-login started');
});

$('#btnReloginAll').addEventListener('click', () => {
  if (blockedByPendingImport()) return;
  runTask('relogin', { headed: headedRun(), force: true }, 'Re-login (all) started');
});

$('#btnBuildCookies').addEventListener('click', () => {
  const count = parseInt($('#poolCount').value, 10);
  if (!Number.isFinite(count) || count < 1) {
    toast('Enter how many profiles to build', 'err');
    return;
  }
  runTask(
    'buildcookies',
    { count, rounds: parseInt($('#poolRounds').value, 10) || 1, headed: headedRun() },
    `Building ${count} profile(s)…`
  );
});

$('#btnRewarmup').addEventListener('click', () => {
  if (blockedByPendingImport()) return;
  runTask(
    'rewarmup',
    {
      rounds: parseInt($('#rewarmRounds').value, 10) || 1,
      maxRounds: parseInt($('#rewarmMax').value, 10) || 3,
      accountsOnly: $('#rewarmAccountsOnly').checked,
      headed: headedRun(),
    },
    'Re-warming cookies…'
  );
});

$('#btnProvision').addEventListener('click', () =>
  runTask(
    'provision',
    { headed: headedRun(), noPool: $('#provisionNoPool').checked },
    'Provisioning new accounts…'
  )
);

$('#btnAcctStop').addEventListener('click', async () => {
  try {
    await api('POST', '/api/transfer/stop');
    toast('Stopping task…', 'ok');
  } catch (e) {
    toast(e.message, 'err');
  }
});

loadAccountStatus();
