/**
 * The Accounts tab's picture of every account and every pool profile.
 *
 * Reads files only - no browser, no network - so the dashboard can call it on
 * every page load. The login column comes from profile-state.json, i.e. what
 * the last Check/Re-login run actually observed; when nothing has ever checked
 * a profile it says so rather than guessing from LOGIN_SUCCESS.txt, which only
 * means "the sign-in flow ran here once".
 */
import fs from 'fs';
import path from 'path';
import config from '../../config.js';
import {
  profileDirNameFor,
  defaultProfileDirNameFor,
  isPoolProfile,
  PROFILES_ROOT,
} from '../../src/profile-identity.js';
import { readMap, emailForDir } from '../../src/profile-map.js';
import { listProfileDirs } from './bundle.js';
import { profileStatus } from './status.js';
import { readState } from './profile-state.js';

/**
 * Where an account's profile stands, as one word the UI can colour.
 *
 *   missing      - no profile directory at all; it has never been provisioned
 *   needs-import - the folder came from another machine and its cookies are
 *                  still encrypted with that machine's key
 *   signed-out   - the last check found it logged out (the after-transfer case)
 *   signed-in    - the last check found it logged in
 *   unchecked    - the folder exists but nothing has verified it yet
 */
function verdictFor({ hasDir, needsImport, record }) {
  if (!hasDir) return 'missing';
  if (needsImport) return 'needs-import';
  if (!record || typeof record.loggedIn !== 'boolean') return 'unchecked';
  return record.loggedIn ? 'signed-in' : 'signed-out';
}

export function accountsStatus() {
  const transfer = profileStatus();
  const byName = new Map(transfer.profiles.map((p) => [p.name, p]));
  const onDisk = new Set(listProfileDirs());
  const state = readState().profiles;
  const assignments = readMap().assignments;

  const accounts = (config.accounts || [])
    .filter((a) => a && a.email)
    .map((a) => {
      const profile = profileDirNameFor(a.email);
      const xfer = byName.get(profile) || null;
      const record = state[profile] || null;
      const hasDir = onDisk.has(profile);
      const verdict = verdictFor({ hasDir, needsImport: !!(xfer && xfer.needsImport), record });

      return {
        email: a.email,
        name: a.name || null,
        profile,
        // True when this account borrowed a pre-warmed profile from the pool
        // instead of getting a folder named after its own address.
        fromPool: isPoolProfile(profile),
        assigned: profile !== defaultProfileDirNameFor(a.email),
        hasDir,
        hasPassword: !!a.password,
        loginFlag: hasDir && fs.existsSync(path.join(PROFILES_ROOT, profile, 'LOGIN_SUCCESS.txt')),
        needsImport: !!(xfer && xfer.needsImport),
        verdict,
        loggedIn: record && typeof record.loggedIn === 'boolean' ? record.loggedIn : null,
        cookies: record && typeof record.cookies === 'number' ? record.cookies : null,
        // How much Google trust the jar carries, as of the last re-warm.
        cookieVerdict: record ? record.cookieVerdict || null : null,
        warmedAt: record ? record.warmedAt || null : null,
        lastCheckAt: record ? record.lastCheckAt || null : null,
        lastLoginAt: record ? record.lastLoginAt || null : null,
        lastResult: record ? record.lastResult || null : null,
        lastMessage: record ? record.lastMessage || null : null,
        lastError: record ? record.lastError || null : null,
        identity: xfer ? xfer.identity : null,
      };
    });

  // ── The cookie pool ─────────────────────────────────────────
  const poolNames = [...onDisk].filter(isPoolProfile).sort();
  const pool = poolNames.map((name) => {
    const record = state[name] || null;
    const owner = emailForDir(name);
    return {
      name,
      assignedTo: owner,
      free: !owner,
      warmedAt: record ? record.warmedAt || null : null,
      cookieVerdict: record ? record.cookieVerdict || null : null,
      cookies: record && typeof record.cookies === 'number' ? record.cookies : null,
      googleCookies: record && typeof record.googleCookies === 'number' ? record.googleCookies : null,
      rounds: record ? record.rounds || null : null,
      identity: byName.get(name) ? byName.get(name).identity : null,
    };
  });

  const free = pool.filter((p) => p.free);
  const needsProvisioning = accounts.filter((a) => a.verdict === 'missing');
  const signedOut = accounts.filter((a) => a.verdict === 'signed-out');

  return {
    accounts,
    pool,
    counts: {
      accounts: accounts.length,
      signedIn: accounts.filter((a) => a.verdict === 'signed-in').length,
      signedOut: signedOut.length,
      unchecked: accounts.filter((a) => a.verdict === 'unchecked').length,
      needsImport: accounts.filter((a) => a.verdict === 'needs-import').length,
      needsProvisioning: needsProvisioning.length,
      poolTotal: pool.length,
      poolFree: free.length,
      poolAssigned: pool.length - free.length,
      // Pool profiles still to build before every unprovisioned account can be
      // given a warm one instead of a cold, CAPTCHA-prone new folder.
      poolShortfall: Math.max(0, needsProvisioning.length - free.length),
      // Profiles whose cookies were last graded too weak to search safely.
      coldCookies: [...accounts, ...pool].filter(
        (p) => p.cookieVerdict === 'cold' || p.cookieVerdict === 'thin'
      ).length,
    },
    assignments,
    machine: transfer.machine,
    proxyCountry: transfer.proxyCountry,
  };
}
