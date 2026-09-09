/**
 * Turning dashboard options into a child process's argv.
 *
 * Nothing the browser sends reaches argv as-is. Booleans map to fixed flags;
 * numbers are clamped to a sane range; the only string that gets through is an
 * email address, and only after it has been matched against an entry that
 * already exists in accounts.json. Anything unrecognised is dropped rather
 * than passed along.
 *
 * (The processes are spawned with an argv array and no shell, so a stray
 * character could not reach a command line anyway - this is about not letting
 * the dashboard drive the scripts with values they never expected.)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACCOUNTS_PATH = path.resolve(__dirname, '..', '..', 'accounts.json');

export function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Keep only the addresses that really are in accounts.json. */
export function knownEmails(list, accountsPath = ACCOUNTS_PATH) {
  if (!Array.isArray(list) || list.length === 0) return [];
  let accounts = [];
  try {
    accounts = JSON.parse(fs.readFileSync(accountsPath, 'utf8'));
  } catch {
    return [];
  }
  const known = new Set(
    (Array.isArray(accounts) ? accounts : [])
      .filter((a) => a && a.email)
      .map((a) => String(a.email).toLowerCase())
  );
  return [...new Set(list.map((e) => String(e).toLowerCase()))].filter((e) => known.has(e));
}

export const TASKS = {
  export: { script: 'scripts/export-profiles.js', label: 'Export profiles' },
  import: { script: 'scripts/import-profiles.js', label: 'Import profiles' },
  pack: { script: 'scripts/pack-transfer.js', label: 'Pack for transfer' },
  relogin: { script: 'scripts/relogin.js', label: 'Check / re-login accounts' },
  buildcookies: { script: 'scripts/build-cookies.js', label: 'Build cookie profiles' },
  provision: { script: 'scripts/provision-accounts.js', label: 'Provision new accounts' },
  rewarmup: { script: 'scripts/rewarmup.js', label: 'Re-warm cookies' },
};

const BUILDERS = {
  export: (o) => (o.includeBrowser ? ['--include-browser'] : []),
  import: (o) => (o.noVerify ? ['--no-verify'] : []),
  pack: () => [],

  relogin: (o) => {
    const argv = [];
    if (o.checkOnly) argv.push('--check-only');
    if (o.force) argv.push('--force');
    if (o.headed) argv.push('--headed');
    const only = knownEmails(o.only);
    if (only.length) argv.push('--only', only.join(','));
    return argv;
  },

  buildcookies: (o) => {
    const argv = ['--count', String(clampInt(o.count, 1, 50, 1))];
    argv.push('--rounds', String(clampInt(o.rounds, 1, 5, 1)));
    if (o.headed) argv.push('--headed');
    return argv;
  },

  rewarmup: (o) => {
    const argv = ['--rounds', String(clampInt(o.rounds, 1, 5, 1))];
    argv.push('--max-rounds', String(clampInt(o.maxRounds, 1, 6, 3)));
    if (o.accountsOnly) argv.push('--accounts-only');
    if (o.poolOnly) argv.push('--pool-only');
    if (o.headed) argv.push('--headed');
    const only = knownEmails(o.only);
    if (only.length) argv.push('--only', only.join(','));
    return argv;
  },

  provision: (o) => {
    const argv = [];
    if (o.noPool) argv.push('--no-pool');
    if (o.headed) argv.push('--headed');
    argv.push('--rounds', String(clampInt(o.rounds, 1, 5, 1)));
    const only = knownEmails(o.only);
    if (only.length) argv.push('--only', only.join(','));
    return argv;
  },
};

/** Full argv for a task, script first. Throws on an unknown task. */
export function taskArgv(task, options = {}) {
  if (!TASKS[task]) throw new Error(`Unknown task: ${task}`);
  return [TASKS[task].script, ...BUILDERS[task](options || {})];
}
