/**
 * Export every Chrome profile's cookies into profile-bundle/ so they survive
 * the move to another laptop.
 *
 * Run on the SOURCE machine (the one that currently has working, CAPTCHA-free
 * profiles), then zip the whole bot folder.
 *
 *   npm run profiles:export
 *   npm run profiles:export -- --include-browser    (also bundle Chromium, ~540 MB)
 *
 * Nothing in chrome-profiles/ is modified. Cookies are read out through the
 * browser, where they are still decrypted, and written to plain JSON.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { binaryInfo } from 'cloakbrowser';
import config from '../config.js';
import { profileIdentity, profileDirNameFor } from '../src/profile-identity.js';
import { openProfile, closeProfile } from './lib/profile-browser.js';
import {
  ROOT,
  PROFILES_DIR,
  BUNDLE_DIR,
  BUNDLE_PROFILES_DIR,
  BUNDLE_BROWSER_DIR,
  BUNDLE_FORMAT,
  listProfileDirs,
  writeManifest,
  machineId,
  normalizeCookie,
  dropExpired,
  summarizeCookies,
  dirSize,
  human,
  log,
  step,
  ok,
  warn,
  fail,
  info,
} from './lib/bundle.js';

const args = process.argv.slice(2);
const INCLUDE_BROWSER = args.includes('--include-browser');
const ONLY = (() => {
  const i = args.indexOf('--only');
  return i >= 0 && args[i + 1] ? args[i + 1].split(',').map((s) => s.trim()) : null;
})();

/** Map profile dir name -> account email, from accounts.json. */
function accountIndex() {
  const map = new Map();
  for (const a of config.accounts || []) {
    if (a && a.email) map.set(profileDirNameFor(a.email), a.email);
  }
  return map;
}

function pkgVersion(name) {
  try {
    const p = path.join(ROOT, 'node_modules', name, 'package.json');
    return JSON.parse(fs.readFileSync(p, 'utf8')).version;
  } catch {
    return null;
  }
}

/** Copy the exact Chromium build this machine runs, so the target matches it. */
function copyBrowser(chromium) {
  if (!chromium || !chromium.installed) {
    fail('Chromium binary not found on this machine - skipping --include-browser.');
    return null;
  }
  const dest = path.join(BUNDLE_BROWSER_DIR, `chromium-${chromium.version}`);
  if (fs.existsSync(dest)) {
    ok(`Chromium ${chromium.version} already bundled.`);
    return { version: chromium.version, dir: path.relative(ROOT, dest) };
  }
  info(`Copying Chromium ${chromium.version} (${human(dirSize(chromium.cacheDir))}) - this takes a minute...`);
  fs.mkdirSync(BUNDLE_BROWSER_DIR, { recursive: true });
  fs.cpSync(chromium.cacheDir, dest, { recursive: true });
  ok(`Chromium ${chromium.version} bundled.`);
  return { version: chromium.version, dir: path.relative(ROOT, dest) };
}

async function exportProfile(profileName, email) {
  const identity = profileIdentity(profileName);
  const outDir = path.join(BUNDLE_PROFILES_DIR, profileName);
  const profileDir = path.join(PROFILES_DIR, profileName);

  let context;
  try {
    ({ context } = await openProfile(profileName));
  } catch (e) {
    fail(`${profileName} - could not open profile: ${e.message}`);
    return { profileName, email, error: e.message, cookies: 0 };
  }

  try {
    const raw = await context.cookies();
    const cookies = raw.map(normalizeCookie);
    const { kept, expired } = dropExpired(cookies);
    const summary = summarizeCookies(kept);

    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(
      path.join(outDir, 'cookies.json'),
      JSON.stringify(
        {
          format: BUNDLE_FORMAT,
          profileName,
          accountEmail: email || null,
          exportedAt: new Date().toISOString(),
          identity,
          summary,
          cookies: kept,
        },
        null,
        2
      )
    );

    const flag = summary.loggedIn ? 'logged in' : 'NOT logged in';
    ok(
      `${profileName} - ${kept.length} cookies (${summary.google} google, ${summary.domains} domains, ${flag})` +
        (expired ? ` [${expired} expired dropped]` : '')
    );
    if (!summary.loggedIn) {
      warn(`  no SID / __Secure-1PSID cookie - this profile is not signed in to Google.`);
    }

    return {
      profileName,
      email: email || null,
      cookies: kept.length,
      expired,
      google: summary.google,
      auth: summary.auth,
      loggedIn: summary.loggedIn,
      profileBytes: dirSize(profileDir),
      hasLoginFlag: fs.existsSync(path.join(profileDir, 'LOGIN_SUCCESS.txt')),
    };
  } catch (e) {
    fail(`${profileName} - export failed: ${e.message}`);
    return { profileName, email, error: e.message, cookies: 0 };
  } finally {
    try {
      await closeProfile(context, 300);
    } catch {
      /* already gone */
    }
  }
}

async function main() {
  log('');
  log('==========================================================');
  log('  Profile Export - prepare this machine for transfer');
  log('==========================================================');

  if (!fs.existsSync(PROFILES_DIR)) {
    fail(`No chrome-profiles/ directory at ${PROFILES_DIR}`);
    process.exit(1);
  }

  let profiles = listProfileDirs();
  if (ONLY) profiles = profiles.filter((p) => ONLY.includes(p));

  if (profiles.length === 0) {
    fail('No Chrome profiles found to export.');
    process.exit(1);
  }

  const emails = accountIndex();
  info(`Found ${profiles.length} profile(s) in chrome-profiles/`);
  info(`Bundle output: ${BUNDLE_DIR}`);

  step('Reading cookies');
  fs.mkdirSync(BUNDLE_PROFILES_DIR, { recursive: true });

  const results = [];
  for (const name of profiles) {
    results.push(await exportProfile(name, emails.get(name)));
  }

  // ── Chromium build ───────────────────────────────────────────────
  let bundledBrowser = null;
  let chromium = null;
  try {
    chromium = binaryInfo();
  } catch (e) {
    warn(`Could not read Chromium info: ${e.message}`);
  }

  if (INCLUDE_BROWSER) {
    step('Bundling Chromium');
    bundledBrowser = copyBrowser(chromium);
  }

  // ── Manifest ─────────────────────────────────────────────────────
  step('Writing manifest');
  const manifest = {
    format: BUNDLE_FORMAT,
    exportedAt: new Date().toISOString(),
    source: {
      hostname: os.hostname(),
      // Identifies the DPAPI boundary these cookies were encrypted behind, so
      // the target machine can tell "needs importing" from "already home".
      machineId: machineId(),
      platform: `${os.platform()} ${os.release()}`,
      node: process.version,
      cloakbrowser: pkgVersion('cloakbrowser'),
      playwrightCore: pkgVersion('playwright-core'),
      chromium: chromium ? chromium.version : null,
    },
    bundledBrowser,
    proxyCountry: profileIdentity(profiles[0]).country,
    profiles: results,
  };
  writeManifest(manifest);
  ok(`manifest.json written`);

  writeChecklist(manifest);
  ok('TRANSFER-CHECKLIST.md written');

  // ── Summary ──────────────────────────────────────────────────────
  const okCount = results.filter((r) => !r.error).length;
  const loggedIn = results.filter((r) => r.loggedIn).length;
  const totalCookies = results.reduce((n, r) => n + (r.cookies || 0), 0);
  const profilesBytes = dirSize(PROFILES_DIR);

  step('Export complete');
  info(`Profiles exported:   ${okCount}/${results.length}`);
  info(`Signed in to Google: ${loggedIn}/${results.length}`);
  info(`Cookies captured:    ${totalCookies}`);
  info(`chrome-profiles/:    ${human(profilesBytes)} (must be included in the zip)`);
  info(`profile-bundle/:     ${human(dirSize(BUNDLE_DIR))}`);
  log('');
  info('Next: zip this entire bot folder (including chrome-profiles/,');
  info('profile-bundle/, node_modules/ and .env), unzip it on the other');
  info('laptop, then run the Import from its dashboard.');
  info('Step-by-step: profile-bundle/TRANSFER-CHECKLIST.md');
  log('');

  const failed = results.filter((r) => r.error);
  if (failed.length) {
    warn(`${failed.length} profile(s) failed to export:`);
    failed.forEach((r) => warn(`  - ${r.profileName}: ${r.error}`));
    process.exit(1);
  }
}

function writeChecklist(manifest) {
  const lines = [
    '# Transferring these profiles to another laptop',
    '',
    `Generated ${manifest.exportedAt} on ${manifest.source.hostname}.`,
    '',
    '## Why an import step is needed at all',
    '',
    'Chrome encrypts cookie values with a key stored in `<profile>/Local State`,',
    'wrapped by Windows DPAPI and bound to the Windows user account + machine that',
    'created it. Copying the profile folder to another laptop leaves Chrome unable',
    'to unwrap that key, so every cookie is silently dropped: the profile looks',
    'intact but boots up logged out, and Google challenges it with a CAPTCHA.',
    '',
    'The export read those cookies out while they were still decryptable. The',
    'import writes them back on the new machine, where Chrome re-encrypts them',
    "with that machine's own key.",
    '',
    '## On THIS laptop (source)',
    '',
    '1. Stop the bot.',
    '2. Run the export (dashboard -> Transfer -> Export, or `npm run profiles:export`).',
    '3. Zip the **entire** bot folder. These must be inside the zip:',
    '',
    '   - `chrome-profiles/`  - history, localStorage, IndexedDB, preferences',
    '   - `profile-bundle/`   - the decrypted cookies (this folder)',
    '   - `.env`              - proxy credentials, keys, settings',
    '   - `accounts.json`     - account list',
    '   - `node_modules/`     - keeps package versions identical (pure JS, portable)',
    '',
    '   Do not use a git clone or "export archive" - `.gitignore` excludes',
    '   `chrome-profiles/`, `.env` and `node_modules/`, so those never make it in.',
    '',
    '## On the OTHER laptop (target)',
    '',
    '1. Unzip the folder anywhere.',
    `2. Install Node ${manifest.source.node} (or any Node 20+).`,
    '3. If you did not copy `node_modules/`, run `npm ci` in the folder.',
    '4. Start the dashboard: `npm start`',
    '5. Open http://localhost:3000 -> **Transfer** tab -> **Import Profiles**.',
    '6. Wait for it to report every profile verified, then start the bot.',
    '',
    '## What the import does',
    '',
    '- Strips the source machine\'s DPAPI key from `Local State`',
    '- Deletes the unreadable `Cookies` / `Login Data` databases',
    '- Clears stale single-instance locks and GPU caches from the old machine',
    '- Marks the last session as a clean exit (no "Restore pages?" bubble)',
    '- Re-injects every exported cookie through the browser',
    '- Re-opens each profile to verify the cookies actually persisted',
    '',
    '## Chromium build',
    '',
    manifest.bundledBrowser
      ? `This bundle carries Chromium ${manifest.bundledBrowser.version}. The import` +
        ' installs it into `~/.cloakbrowser/` so the browser build matches exactly.'
      : `This machine runs Chromium ${manifest.source.chromium}. The bundle does NOT` +
        ' include the binary - the other laptop downloads its own on first launch. If' +
        ' the versions differ the import will warn you; re-run the export with' +
        ' `--include-browser` to ship an exact match.',
    '',
    '## Profiles in this bundle',
    '',
    '| Profile | Account | Cookies | Google login |',
    '| --- | --- | --- | --- |',
    ...manifest.profiles.map(
      (p) =>
        `| ${p.profileName} | ${p.email || '-'} | ${p.cookies || 0} | ${
          p.loggedIn ? 'yes' : 'NO'
        } |`
    ),
    '',
  ];
  fs.writeFileSync(path.join(BUNDLE_DIR, 'TRANSFER-CHECKLIST.md'), lines.join('\n'));
}

main().catch((err) => {
  fail(`Fatal: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
