/**
 * Which on-disk profile directory belongs to which account.
 *
 * Why this file exists
 * --------------------
 * A profile's whole identity - fingerprint seed, GPU, screen, timezone - is
 * derived from its DIRECTORY NAME (see profile-identity.js). That is what
 * makes a profile look like the same returning machine on every run and on
 * every laptop.
 *
 * The cookie pool builds warm, CAPTCHA-free profiles BEFORE anyone knows which
 * account will use them, so they are born with neutral names like
 * "pool.3f9a1c22". When such a profile is later handed to an account we must
 * NOT rename it to the account's email: renaming changes the derived hardware,
 * and a browser whose GPU and timezone changed overnight while carrying old
 * cookies is exactly the thing Google challenges.
 *
 * So instead of renaming the folder, the assignment is recorded here:
 *
 *   profile-map.json  ->  { "assignments": { "a@gmail.com": "pool.3f9a1c22" } }
 *
 * profileDirNameFor(email) consults this map first and falls back to the old
 * email-derived name, so every profile that existed before this file keeps
 * working untouched.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const MAP_PATH = path.resolve(__dirname, '..', 'profile-map.json');

/** Bumped only if the file layout changes. */
const MAP_FORMAT = 1;

const EMPTY = { format: MAP_FORMAT, assignments: {} };

// Cached read. The map is consulted on every profile launch, but it also
// changes underneath a long-running dashboard when provisioning writes to it,
// so the cache is keyed on the file's mtime + size rather than held forever.
let cache = { key: null, value: EMPTY };

function statKey() {
  try {
    const st = fs.statSync(MAP_PATH);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null; // no file yet
  }
}

/** The whole map. Never throws - an unreadable map behaves like an empty one. */
export function readMap() {
  const key = statKey();
  if (key === null) {
    cache = { key: null, value: EMPTY };
    return EMPTY;
  }
  if (cache.key === key) return cache.value;

  let value = EMPTY;
  try {
    const parsed = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8'));
    value = {
      format: parsed.format || MAP_FORMAT,
      assignments:
        parsed.assignments && typeof parsed.assignments === 'object'
          ? parsed.assignments
          : {},
    };
  } catch {
    /* corrupt map - fall back to email-derived names rather than crashing */
  }
  cache = { key, value };
  return value;
}

function writeMap(map) {
  const out = { format: MAP_FORMAT, assignments: map.assignments || {} };
  fs.writeFileSync(MAP_PATH, JSON.stringify(out, null, 2));
  cache = { key: statKey(), value: out };
}

/** The directory assigned to an email, or null when it uses the default name. */
export function assignmentFor(email) {
  if (!email) return null;
  const a = readMap().assignments;
  return a[email] || a[String(email).toLowerCase()] || null;
}

/** Reverse lookup: which account owns this directory. */
export function emailForDir(profileDirName) {
  for (const [email, dir] of Object.entries(readMap().assignments)) {
    if (dir === profileDirName) return email;
  }
  return null;
}

/** Every directory currently claimed by an account. */
export function assignedDirs() {
  return new Set(Object.values(readMap().assignments));
}

/**
 * Claim a profile directory for an account.
 *
 * Refuses to hand one directory to two accounts - that would have them share a
 * cookie jar, so the second login would silently sign the first one out.
 */
export function setAssignment(email, profileDirName) {
  const map = readMap();
  const assignments = { ...map.assignments };

  const owner = Object.entries(assignments).find(
    ([e, dir]) => dir === profileDirName && e !== email
  );
  if (owner) {
    throw new Error(
      `Profile ${profileDirName} is already assigned to ${owner[0]}`
    );
  }

  assignments[email] = profileDirName;
  writeMap({ ...map, assignments });
  return profileDirName;
}

/** Release a directory back to the pool (the folder itself is left alone). */
export function removeAssignment(email) {
  const map = readMap();
  if (!(email in map.assignments)) return false;
  const assignments = { ...map.assignments };
  delete assignments[email];
  writeMap({ ...map, assignments });
  return true;
}
