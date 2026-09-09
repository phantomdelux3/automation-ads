/**
 * Web Dashboard for the Keyword Ad Click Tool
 *
 * Run with:  npm start   (→ node dashboard.js)
 * Then open: http://localhost:3000
 *
 * Lets you:
 *   • Start / Stop the bot (index.js) and watch its logs + errors live
 *   • Edit .env config from a form (or raw)
 *   • Add / edit / remove accounts in accounts.json
 */
import express from 'express';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { profileStatus } from './scripts/lib/status.js';
import { accountsStatus } from './scripts/lib/accounts-status.js';
import { TASKS, taskArgv } from './scripts/lib/task-argv.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const ENV_PATH = path.join(ROOT, '.env');
const ACCOUNTS_PATH = path.join(ROOT, 'accounts.json');
const PORT = parseInt(process.env.DASHBOARD_PORT, 10) || 3000;

const app = express();
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(ROOT, 'public')));

// ── ANSI stripping (chalk colors in piped output) ───────────────────
const ANSI_RE =
  /[][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
const ESC = String.fromCharCode(27); // \x1b
const ANSI_SAFE = new RegExp(ESC + '\\[[0-9;?]*[ -/]*[@-~]', 'g');
const stripAnsi = (s) => String(s).replace(ANSI_SAFE, '');

// ── Bot process state + live log stream ─────────────────────────────
let botProc = null;
let botStartedAt = null;
const LOG_BUFFER_MAX = 1500;
let logBuffer = [];
const sseClients = new Set();

function statusObj() {
  return {
    running: !!botProc,
    pid: botProc ? botProc.pid : null,
    startedAt: botStartedAt,
  };
}

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

function pushLog(stream, text) {
  const clean = stripAnsi(String(text));
  for (const raw of clean.split(/\r?\n/)) {
    if (raw.trim() === '') continue;
    const entry = { t: Date.now(), stream, line: raw };
    logBuffer.push(entry);
    if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
    broadcast('log', entry);
  }
}

// ── SSE: live logs + status ─────────────────────────────────────────
app.get('/api/logs/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  sseClients.add(res);

  // Send current status + backlog to the new client
  res.write(`event: status\ndata: ${JSON.stringify(statusObj())}\n\n`);
  res.write(`event: task\ndata: ${JSON.stringify(taskObj())}\n\n`);
  for (const e of logBuffer) {
    res.write(`event: log\ndata: ${JSON.stringify(e)}\n\n`);
  }

  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* ignore */
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(ping);
    sseClients.delete(res);
  });
});

app.get('/api/bot/status', (req, res) => res.json(statusObj()));

app.post('/api/bot/start', (req, res) => {
  if (botProc) return res.status(409).json({ error: 'Bot is already running' });
  if (taskProc) {
    return res.status(409).json({
      error: `Wait for ${TASKS[taskName].label} to finish — it has the Chrome profiles open.`,
    });
  }
  try {
    botProc = spawn(process.execPath, ['index.js'], {
      cwd: ROOT,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    });
  } catch (e) {
    botProc = null;
    return res.status(500).json({ error: e.message });
  }
  botStartedAt = Date.now();
  pushLog('system', `▶ Bot started (pid ${botProc.pid})`);

  botProc.stdout.on('data', (d) => pushLog('stdout', d.toString()));
  botProc.stderr.on('data', (d) => pushLog('stderr', d.toString()));
  botProc.on('error', (err) => pushLog('stderr', `Spawn error: ${err.message}`));
  botProc.on('exit', (code, signal) => {
    pushLog(
      'system',
      `■ Bot stopped (exit code ${code}${signal ? `, signal ${signal}` : ''})`
    );
    botProc = null;
    botStartedAt = null;
    broadcast('status', statusObj());
  });

  broadcast('status', statusObj());
  res.json(statusObj());
});

app.post('/api/bot/stop', (req, res) => {
  if (!botProc) return res.status(409).json({ error: 'Bot is not running' });
  const pid = botProc.pid;
  pushLog('system', `⏹ Stop requested — killing process tree (pid ${pid})…`);
  if (process.platform === 'win32') {
    // Kill the whole tree so Chromium children die too
    spawn('taskkill', ['/pid', String(pid), '/T', '/F']);
  } else {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
  res.json({ ok: true });
});

// ── Profile transfer (export / import / pack) ───────────────────────
//
// These run as child processes so their output lands in the same live log
// console as the bot, and so a long export can't block the dashboard.

let taskProc = null;
let taskName = null;
let taskStartedAt = null;

function taskObj() {
  return {
    running: !!taskProc,
    task: taskName,
    label: taskName ? TASKS[taskName].label : null,
    startedAt: taskStartedAt,
  };
}

app.get('/api/transfer/status', (req, res) => {
  try {
    res.json({ ...profileStatus({ withSizes: req.query.sizes === '1' }), task: taskObj() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/transfer/run', (req, res) => {
  const { task, options } = req.body || {};

  if (!TASKS[task]) return res.status(400).json({ error: `Unknown task: ${task}` });
  if (taskProc) return res.status(409).json({ error: `${TASKS[taskName].label} is already running` });
  if (botProc) {
    return res.status(409).json({
      error: 'Stop the bot first — these tasks open the same Chrome profiles.',
    });
  }

  const argv = taskArgv(task, options);

  try {
    taskProc = spawn(process.execPath, argv, {
      cwd: ROOT,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    });
  } catch (e) {
    taskProc = null;
    return res.status(500).json({ error: e.message });
  }

  taskName = task;
  taskStartedAt = Date.now();
  pushLog('system', `▶ ${TASKS[task].label} started (pid ${taskProc.pid})`);

  taskProc.stdout.on('data', (d) => pushLog('stdout', d.toString()));
  taskProc.stderr.on('data', (d) => pushLog('stderr', d.toString()));
  taskProc.on('error', (err) => pushLog('stderr', `Spawn error: ${err.message}`));
  taskProc.on('exit', (code) => {
    pushLog(
      'system',
      code === 0
        ? `■ ${TASKS[task].label} finished successfully`
        : `■ ${TASKS[task].label} FAILED (exit code ${code})`
    );
    taskProc = null;
    taskName = null;
    taskStartedAt = null;
    broadcast('task', { ...taskObj(), lastExit: code, lastTask: task });
  });

  broadcast('task', taskObj());
  res.json(taskObj());
});

app.post('/api/transfer/stop', (req, res) => {
  if (!taskProc) return res.status(409).json({ error: 'No transfer task is running' });
  const pid = taskProc.pid;
  pushLog('system', `⏹ Stopping ${TASKS[taskName].label} (pid ${pid})…`);
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F']);
  } else {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
  res.json({ ok: true });
});

// ── Config (.env) ───────────────────────────────────────────────────
function parseEnv(raw) {
  const values = {};
  for (const line of raw.split(/\r?\n/)) {
    if (line.trimStart().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (m) values[m[1]] = m[2];
  }
  return values;
}

function applyEnvValues(content, values) {
  const lines = content.split(/\r?\n/);
  const seen = new Set();
  const out = lines.map((line) => {
    if (line.trimStart().startsWith('#')) return line;
    const m = line.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (m && m[2] in values) {
      seen.add(m[2]);
      return `${m[1]}${m[2]}=${values[m[2]]}`;
    }
    return line;
  });
  for (const [k, v] of Object.entries(values)) {
    if (!seen.has(k)) out.push(`${k}=${v}`);
  }
  return out.join('\n');
}

app.get('/api/config', (req, res) => {
  const raw = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
  res.json({ raw, values: parseEnv(raw) });
});

app.post('/api/config', (req, res) => {
  const { values, raw } = req.body || {};
  try {
    if (typeof raw === 'string') {
      backup(ENV_PATH);
      fs.writeFileSync(ENV_PATH, raw);
      return res.json({ ok: true, mode: 'raw' });
    }
    if (values && typeof values === 'object') {
      const current = fs.existsSync(ENV_PATH)
        ? fs.readFileSync(ENV_PATH, 'utf8')
        : '';
      backup(ENV_PATH);
      fs.writeFileSync(ENV_PATH, applyEnvValues(current, values));
      return res.json({ ok: true, mode: 'form' });
    }
    res.status(400).json({ error: 'Provide { values } or { raw }' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Accounts (accounts.json) ────────────────────────────────────────
app.get('/api/accounts', (req, res) => {
  try {
    let arr = [];
    if (fs.existsSync(ACCOUNTS_PATH)) {
      arr = JSON.parse(fs.readFileSync(ACCOUNTS_PATH, 'utf8'));
    }
    res.json(Array.isArray(arr) ? arr : []);
  } catch (e) {
    res.status(500).json({ error: `Could not read accounts.json: ${e.message}` });
  }
});

// Everything the Accounts tab needs to draw its status table: who has a
// profile, which of them the last check found signed in, and what the cookie
// pool holds. File reads only - the real answer comes from the Check button,
// which launches the browsers and records what it saw.
app.get('/api/accounts/status', (req, res) => {
  try {
    res.json({ ...accountsStatus(), task: taskObj() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/accounts', (req, res) => {
  const arr = req.body;
  if (!Array.isArray(arr))
    return res.status(400).json({ error: 'Expected an array of accounts' });
  for (const a of arr) {
    if (!a || typeof a !== 'object' || !a.email)
      return res.status(400).json({ error: 'Every account needs an email' });
  }
  try {
    backup(ACCOUNTS_PATH);
    fs.writeFileSync(ACCOUNTS_PATH, JSON.stringify(arr, null, 2));
    res.json({ ok: true, count: arr.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Keep a single rolling .bak before any overwrite (these hold credentials/keys)
function backup(file) {
  try {
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  } catch {
    /* non-fatal */
  }
}

app.listen(PORT, () => {
  console.log(`\n  Dashboard running →  http://localhost:${PORT}\n`);
});
