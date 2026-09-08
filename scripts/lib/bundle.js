/**
 * Shared plumbing for the profile export/import scripts.
 *
 * Background - why any of this is needed:
 *
 * Chrome on Windows encrypts cookie values with a master key stored in
 * <profile>/Local State as os_crypt.encrypted_key, and that key is itself
 * wrapped by Windows DPAPI, bound to the Windows user account + machine that
 * created it. Copy the profile folder to another laptop and Chrome can no
 * longer unwrap the key: every encrypted cookie decodes to garbage and is
 * silently dropped. The folder looks perfect on disk but boots up cookieless
 * and logged out, so Google sees a brand new browser and challenges it.
 *
 * The fix is to move the cookies through the browser rather than through the
 * filesystem: read them decrypted on the source machine, and write them back
 * on the target machine so Chrome re-encrypts them with the target's own key.
 *
 * Everything else in a profile (History, Local Storage, IndexedDB,
 * Preferences, Web Data) is NOT encrypted and travels fine in the zip.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(__dirname, '..', '..');
export const PROFILES_DIR = path.join(ROOT, 'chrome-profiles');
export const BUNDLE_DIR = path.join(ROOT, 'profile-bundle');
export const BUNDLE_PROFILES_DIR = path.join(BUNDLE_DIR, 'profiles');
export const BUNDLE_BROWSER_DIR = path.join(BUNDLE_DIR, 'browser');
export const MANIFEST_PATH = path.join(BUNDLE_DIR, 'manifest.json');

/** Format of the bundle on disk. Bumped if the layout ever changes. */
export const BUNDLE_FORMAT = 1;

// ── Logging ─────────────────────────────────────────────────────────
// Plain stdout with no colour: the dashboard pipes these straight into the
// live log console, and chalk escape codes would just be stripped again.

export const log = (msg = '') => console.log(msg);
export const step = (msg) => console.log(`\n=== ${msg} ===`);
export const ok = (msg) => console.log(`  [ok] ${msg}`);
export const warn = (msg) => console.log(`  [!]  ${msg}`);
export const fail = (msg) => console.log(`  [x]  ${msg}`);
export const info = (msg) => console.log(`  ${msg}`);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Profile discovery ───────────────────────────────────────────────

/**
 * Every profile directory that actually looks like a Chrome user-data dir.
 * A folder counts if it has a Default/ subdirectory or a Local State file -
 * that filters out stray folders without guessing from the name.
 */
export function listProfileDirs() {
  if (!fs.existsSync(PROFILES_DIR)) return [];
  return fs
    .readdirSync(PROFILES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => {
      const dir = path.join(PROFILES_DIR, name);
      return (
        fs.existsSync(path.join(dir, 'Default')) ||
        fs.existsSync(path.join(dir, 'Local State'))
      );
    })
    .sort();
}

/** Profile names present in the bundle. */
export function listBundledProfiles() {
  if (!fs.existsSync(BUNDLE_PROFILES_DIR)) return [];
  return fs
    .readdirSync(BUNDLE_PROFILES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((n) => fs.existsSync(path.join(BUNDLE_PROFILES_DIR, n, 'cookies.json')))
    .sort();
}

export function bundleProfilePath(profileName) {
  return path.join(BUNDLE_PROFILES_DIR, profileName, 'cookies.json');
}

// ── Manifest ────────────────────────────────────────────────────────

export function readManifest() {
  try {
    if (fs.existsSync(MANIFEST_PATH)) {
      return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    }
  } catch (e) {
    warn(`Could not read manifest.json: ${e.message}`);
  }
  return null;
}

export function writeManifest(manifest) {
  fs.mkdirSync(BUNDLE_DIR, { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
}

// ── Cookies ─────────────────────────────────────────────────────────

/**
 * Playwright's addCookies() rejects unknown fields, and newer Chrome exposes
 * extras (partitionKey, sameParty, sourceScheme...) through context.cookies().
 * Keep exactly the fields addCookies accepts.
 */
const COOKIE_FIELDS = ['name', 'value', 'domain', 'path', 'expires', 'httpOnly', 'secure', 'sameSite'];

export function normalizeCookie(c) {
  const out = {};
  for (const f of COOKIE_FIELDS) {
    if (c[f] !== undefined) out[f] = c[f];
  }
  // sameSite must be one of Strict/Lax/None; Chrome may report "unspecified"
  if (!['Strict', 'Lax', 'None'].includes(out.sameSite)) out.sameSite = 'Lax';
  // A None cookie is only valid when Secure - Chrome would reject the pair
  if (out.sameSite === 'None') out.secure = true;
  return out;
}

/** Drop cookies that already expired - they would be rejected on insert. */
export function dropExpired(cookies) {
  const now = Date.now() / 1000;
  const kept = [];
  let expired = 0;
  for (const c of cookies) {
    // expires === -1 means a session cookie, which is still worth keeping
    if (typeof c.expires === 'number' && c.expires > 0 && c.expires < now) {
      expired++;
      continue;
    }
    kept.push(c);
  }
  return { kept, expired };
}

/**
 * The cookies that actually carry Google login/trust. Reported per profile so
 * a silent partial transfer is visible instead of showing up later as a
 * CAPTCHA wall.
 */
export const GOOGLE_AUTH_COOKIES = [
  'SID', 'HSID', 'SSID', 'APISID', 'SAPISID',
  '__Secure-1PSID', '__Secure-3PSID', '__Secure-1PSIDTS', '__Secure-3PSIDTS',
  'NID', 'SOCS', 'AEC', '1P_JAR',
];

export function summarizeCookies(cookies) {
  const domains = new Set(cookies.map((c) => c.domain.replace(/^\./, '')));
  const google = cookies.filter((c) => /(^|\.)google\.[a-z.]+$/.test(c.domain.replace(/^\./, '')));
  const auth = new Set(
    cookies.filter((c) => GOOGLE_AUTH_COOKIES.includes(c.name)).map((c) => c.name)
  );
  return {
    total: cookies.length,
    domains: domains.size,
    google: google.length,
    auth: [...auth].sort(),
    loggedIn: auth.has('SID') || auth.has('__Secure-1PSID'),
  };
}

// ── Filesystem helpers ──────────────────────────────────────────────

function rmQuiet(target) {
  try {
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
      return true;
    }
  } catch {
    /* locked or already gone - non-fatal */
  }
  return false;
}

export function dirSize(dir) {
  let total = 0;
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        try {
          total += fs.statSync(p).size;
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(dir);
  return total;
}

export function human(bytes) {
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

// ── Profile sanitising ──────────────────────────────────────────────

/**
 * Files that can never survive the move to another Windows account/machine,
 * because they are encrypted with the source machine's DPAPI-wrapped key.
 * Chrome recreates all of them empty on next launch.
 */
const ENCRYPTED_FILES = [
  'Default/Network/Cookies',
  'Default/Network/Cookies-journal',
  'Default/Network/Cookies-wal',
  'Default/Network/Cookies-shm',
  'Default/Cookies',
  'Default/Cookies-journal',
  'Default/Login Data',
  'Default/Login Data-journal',
  'Default/Login Data For Account',
  'Default/Login Data For Account-journal',
];

/**
 * Network state tied to the source machine's connection (QUIC/alt-svc hints,
 * broken-server lists, pending report queues). Harmless but meaningless on a
 * different network, and it can produce odd connection behaviour.
 */
const NETWORK_STATE_FILES = [
  'Default/Network/Network Persistent State',
  'Default/Network/Reporting and NEL',
  'Default/Network/SCT Auditing Pending Reports',
];

/**
 * Stale single-instance locks. If the profile was copied while Chrome had it
 * open, these make the next launch think another Chrome owns the profile.
 */
const LOCK_FILES = [
  'SingletonLock',
  'SingletonCookie',
  'SingletonSocket',
  'lockfile',
  'Default/LOCK',
  'Default/Local Storage/leveldb/LOCK',
  'Default/Session Storage/LOCK',
  'Default/IndexedDB/LOCK',
];

/**
 * Caches - GPU/driver specific or just bulk. Removing these shrinks the zip a
 * lot and avoids shipping shader blobs compiled for the source machine's GPU.
 */
const CACHE_DIRS = [
  'Default/Cache',
  'Default/Code Cache',
  'Default/GPUCache',
  'Default/DawnGraphiteCache',
  'Default/DawnWebGPUCache',
  'Default/Service Worker/CacheStorage',
  'Default/Service Worker/ScriptCache',
  'Default/optimization_guide_model_store',
  'GPUCache',
  'ShaderCache',
  'GrShaderCache',
  'GraphiteDawnCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'component_crx_cache',
  'extensions_crx_cache',
];

/**
 * Strip the DPAPI-wrapped master key out of Local State.
 *
 * Leaving it in place is worse than removing it: Chrome keeps trying to use a
 * key it cannot unwrap. With os_crypt gone Chrome mints a fresh key on first
 * launch and encrypts the re-injected cookies with it.
 */
function stripOsCrypt(profileDir) {
  const p = path.join(profileDir, 'Local State');
  if (!fs.existsSync(p)) return false;
  try {
    const state = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!state.os_crypt) return false;
    delete state.os_crypt;
    fs.writeFileSync(p, JSON.stringify(state));
    return true;
  } catch (e) {
    warn(`Could not rewrite Local State: ${e.message}`);
    return false;
  }
}

/**
 * Mark the last session as a clean exit, so the target machine does not open
 * with the "Chrome didn't shut down correctly - Restore pages?" bubble sitting
 * over the page the bot is trying to drive.
 */
function markCleanExit(profileDir) {
  const p = path.join(profileDir, 'Default', 'Preferences');
  if (!fs.existsSync(p)) return false;
  try {
    const prefs = JSON.parse(fs.readFileSync(p, 'utf8'));
    prefs.profile = prefs.profile || {};
    prefs.profile.exit_type = 'Normal';
    prefs.profile.exited_cleanly = true;
    fs.writeFileSync(p, JSON.stringify(prefs));
    return true;
  } catch (e) {
    warn(`Could not rewrite Preferences: ${e.message}`);
    return false;
  }
}

/**
 * Make a profile directory safe to open on a different machine.
 *
 * Returns a small report so the caller can print what happened.
 * Safe to run more than once.
 */
export function sanitizeProfile(profileDir, { dropCaches = true } = {}) {
  const report = { encrypted: 0, network: 0, locks: 0, caches: 0, osCrypt: false, cleanExit: false };

  for (const rel of ENCRYPTED_FILES) if (rmQuiet(path.join(profileDir, rel))) report.encrypted++;
  for (const rel of NETWORK_STATE_FILES) if (rmQuiet(path.join(profileDir, rel))) report.network++;
  for (const rel of LOCK_FILES) if (rmQuiet(path.join(profileDir, rel))) report.locks++;
  if (dropCaches) {
    for (const rel of CACHE_DIRS) if (rmQuiet(path.join(profileDir, rel))) report.caches++;
  }

  report.osCrypt = stripOsCrypt(profileDir);
  report.cleanExit = markCleanExit(profileDir);
  return report;
}

// ── Machine identity ────────────────────────────────────────────────

/**
 * Who this profile's encryption key belongs to.
 *
 * DPAPI binds the key to the Windows USER on a given machine, not just the
 * machine, so both halves matter: the same folder under a different Windows
 * account on the same PC is just as unreadable as on a different laptop.
 *
 * An os_crypt key on disk looks identical whether it is ours or another
 * machine's, so this is what tells "already home" apart from "needs import".
 */
export function machineId() {
  let user = 'unknown';
  try {
    user = os.userInfo().username;
  } catch {
    /* no user info available */
  }
  return `${os.hostname()}\\${user}`;
}

/** Marker the import drops into a profile once it has been rebuilt here. */
const IMPORT_MARKER = 'TRANSFER_IMPORTED.json';

export function readImportMarker(profileDir) {
  try {
    const p = path.join(profileDir, IMPORT_MARKER);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    /* unreadable marker is the same as none */
  }
  return null;
}

export function writeImportMarker(profileDir, bundleExportedAt) {
  try {
    fs.writeFileSync(
      path.join(profileDir, IMPORT_MARKER),
      JSON.stringify(
        { machineId: machineId(), importedAt: new Date().toISOString(), bundleExportedAt },
        null,
        2
      )
    );
  } catch (e) {
    warn(`Could not write import marker: ${e.message}`);
  }
}

/**
 * True when a profile dir carries a DPAPI-wrapped key. On the machine that
 * created it that is normal; on any other machine it is unreadable.
 */
export function hasForeignOsCrypt(profileDir) {
  const p = path.join(profileDir, 'Local State');
  if (!fs.existsSync(p)) return false;
  try {
    const state = JSON.parse(fs.readFileSync(p, 'utf8'));
    return !!(state.os_crypt && state.os_crypt.encrypted_key);
  } catch {
    return false;
  }
}
