/**
 * What we last observed about each profile, remembered on disk.
 *
 * The dashboard needs to show whether every account is signed in, but finding
 * that out for real means launching Chrome and asking Google - thirteen times.
 * That is a job for a button, not for a page load. So the scripts that DO open
 * the browsers (relogin, build-cookies, provision) record what they saw here,
 * and the Accounts tab renders the record instantly.
 *
 * profile-state.json is a cache of observations, never a source of truth: it
 * is safe to delete, and every field is "as of lastCheckAt".
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const STATE_PATH = path.resolve(__dirname, '..', '..', 'profile-state.json');

const STATE_FORMAT = 1;

/** The whole file. An unreadable/absent state behaves like an empty one. */
export function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    return {
      format: parsed.format || STATE_FORMAT,
      profiles: parsed.profiles && typeof parsed.profiles === 'object' ? parsed.profiles : {},
    };
  } catch {
    return { format: STATE_FORMAT, profiles: {} };
  }
}

function writeState(state) {
  fs.writeFileSync(
    STATE_PATH,
    JSON.stringify({ format: STATE_FORMAT, profiles: state.profiles || {} }, null, 2)
  );
}

/** What we know about one profile, or an empty record. */
export function getProfile(profileDirName) {
  return readState().profiles[profileDirName] || null;
}

/**
 * Merge fields into one profile's record.
 *
 * Read-modify-write on every call rather than holding the file open: these
 * scripts run for minutes at a time with a browser in between writes, and a
 * crash halfway through a run should still leave the profiles it already
 * finished recorded correctly.
 */
export function updateProfile(profileDirName, patch) {
  const state = readState();
  const prev = state.profiles[profileDirName] || {};
  state.profiles[profileDirName] = { ...prev, ...patch, name: profileDirName };
  writeState(state);
  return state.profiles[profileDirName];
}

/** Forget a profile (used when its directory is gone). */
export function forgetProfile(profileDirName) {
  const state = readState();
  if (!(profileDirName in state.profiles)) return false;
  delete state.profiles[profileDirName];
  writeState(state);
  return true;
}

/**
 * Record the outcome of a login check/attempt.
 * `result` is the object google-login.js returns, or null for a check-only run.
 */
export function recordLoginResult(profileDirName, { email, signedIn, result, cookies }) {
  const now = new Date().toISOString();
  const patch = {
    kind: 'account',
    email: email || null,
    lastCheckAt: now,
    loggedIn: !!signedIn,
    lastError: null,
  };
  if (typeof cookies === 'number') patch.cookies = cookies;
  if (result) {
    patch.lastResult = result.state;
    patch.lastMessage = result.message;
    if (result.ok) patch.lastLoginAt = now;
    else patch.lastError = result.message;
  }
  return updateProfile(profileDirName, patch);
}
