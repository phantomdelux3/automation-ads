/**
 * Rebuild the exported profiles on THIS machine.
 *
 * Run on the TARGET laptop after unzipping the folder:
 *
 *   npm run profiles:import
 *   npm run profiles:import -- --no-verify     (skip the re-open check)
 *   npm run profiles:import -- --only a@b.com_,c@d.com_
 *
 * For every profile in profile-bundle/ this:
 *   1. sanitises the copied profile dir (strips the old machine's DPAPI key,
 *      deletes the unreadable cookie/login databases, stale locks, GPU caches)
 *   2. launches the profile with its exact bot identity and injects the
 *      exported cookies, which Chrome re-encrypts with this machine's key
 *   3. re-opens the profile and counts what actually persisted
 *
 * Safe to run more than once.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { binaryInfo } from 'cloakbrowser';
import config from '../config.js';
import { profileIdentity, profileDirNameFor } from '../src/profile-identity.js';
import { openProfile, closeProfile } from './lib/profile-browser.js';
import {
  PROFILES_DIR,
  BUNDLE_DIR,
  BUNDLE_BROWSER_DIR,
  listBundledProfiles,
  bundleProfilePath,
  readManifest,
  normalizeCookie,
  dropExpired,
  summarizeCookies,
  sanitizeProfile,
  hasForeignOsCrypt,
  writeImportMarker,
  machineId,
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
const VERIFY = !args.includes('--no-verify');
const FORCE = args.includes('--force');
const ONLY = (() => {
  const i = args.indexOf('--only');
  return i >= 0 && args[i + 1] ? args[i + 1].split(',').map((s) => s.trim()) : null;
})();

/**
 * Install a Chromium build that shipped inside the bundle, so this machine
 * runs the exact browser version the profiles were built on.
 */
function installBundledBrowser(manifest) {
  const bundled = manifest && manifest.bundledBrowser;
  if (!bundled) return false;

  const src = path.join(BUNDLE_BROWSER_DIR, `chromium-${bundled.version}`);
  if (!fs.existsSync(src)) {
    warn(`Manifest lists bundled Chromium ${bundled.version} but ${src} is missing.`);
    return false;
  }

  const cacheDir = process.env.CLOAKBROWSER_CACHE_DIR || path.join(os.homedir(), '.cloakbrowser');
  const dest = path.join(cacheDir, `chromium-${bundled.version}`);

  if (!fs.existsSync(path.join(dest, 'chrome.exe'))) {
    info(`Installing bundled Chromium ${bundled.version} (${human(dirSize(src))})...`);
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.cpSync(src, dest, { recursive: true });
  }

  // The version marker is how cloakbrowser decides which build to run.
  try {
    fs.writeFileSync(path.join(cacheDir, 'latest_version_windows-x64'), bundled.version);
  } catch (e) {
    warn(`Could not write version marker: ${e.message}`);
  }

  ok(`Chromium ${bundled.version} installed and pinned.`);
  return true;
}

/** Compare the browser this machine will run against the source machine's. */
function checkChromium(manifest) {
  let here = null;
  try {
    here = binaryInfo();
  } catch (e) {
    warn(`Could not read local Chromium info: ${e.message}`);
    return;
  }
  const there = manifest && manifest.source && manifest.source.chromium;

  if (!here.installed) {
    info(`Chromium ${here.version} is not downloaded yet - it will download on the first bot run.`);
  } else {
    info(`Chromium here: ${here.version}`);
  }
  if (!there) return;

  if (here.version !== there.version && here.version !== there) {
    warn(`Source machine ran Chromium ${there}, this machine will run ${here.version}.`);
    warn('  Not fatal, but a different build means a slightly different fingerprint.');
    warn('  For an exact match, re-run the export with --include-browser.');
  } else {
    ok(`Chromium build matches the source machine (${here.version}).`);
  }
}

async function importProfile(profileName, bundleExportedAt) {
  const bundlePath = bundleProfilePath(profileName);
  const profileDir = path.join(PROFILES_DIR, profileName);

  let record;
  try {
    record = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
  } catch (e) {
    fail(`${profileName} - unreadable bundle: ${e.message}`);
    return { profileName, error: e.message };
  }

  const exported = Array.isArray(record.cookies) ? record.cookies : [];
  if (exported.length === 0) {
    warn(`${profileName} - bundle holds no cookies, skipping.`);
    return { profileName, injected: 0, verified: 0, skipped: true };
  }

  // ── 1. Sanitise ────────────────────────────────────────────────
  const hadProfileDir = fs.existsSync(profileDir);
  const carriedForeignKey = hadProfileDir && hasForeignOsCrypt(profileDir);

  if (hadProfileDir) {
    const r = sanitizeProfile(profileDir);
    const bits = [];
    if (r.osCrypt) bits.push('old DPAPI key stripped');
    if (r.encrypted) bits.push(`${r.encrypted} encrypted db(s) removed`);
    if (r.locks) bits.push(`${r.locks} stale lock(s)`);
    if (r.caches) bits.push(`${r.caches} cache dir(s)`);
    if (r.network) bits.push(`${r.network} network state file(s)`);
    info(`${profileName} - sanitised: ${bits.length ? bits.join(', ') : 'nothing to clean'}`);
  } else {
    warn(`${profileName} - no profile folder found; creating a cookies-only profile.`);
    warn('  (chrome-profiles/ was not included in the zip, so history and');
    warn('   localStorage did not come across - the Google login still will.)');
    fs.mkdirSync(profileDir, { recursive: true });
  }

  // ── 2. Inject ──────────────────────────────────────────────────
  const { kept, expired } = dropExpired(exported.map(normalizeCookie));
  if (expired) info(`${profileName} - ${expired} cookie(s) expired since export, dropped.`);

  let context;
  try {
    ({ context } = await openProfile(profileName));
  } catch (e) {
    fail(`${profileName} - could not launch profile: ${e.message}`);
    return { profileName, error: e.message };
  }

  let injected = 0;
  try {
    // One bad cookie must not lose the whole jar, so fall back to one-by-one.
    try {
      await context.addCookies(kept);
      injected = kept.length;
    } catch (e) {
      warn(`${profileName} - bulk insert rejected (${e.message}); inserting individually.`);
      for (const c of kept) {
        try {
          await context.addCookies([c]);
          injected++;
        } catch {
          /* skip the one Chrome refuses */
        }
      }
    }

    const live = await context.cookies();
    info(`${profileName} - injected ${injected}/${kept.length}, browser reports ${live.length}.`);
  } finally {
    // The settle delay matters: Chrome flushes its cookie store on shutdown,
    // and racing that flush is how an import silently ends up empty.
    await closeProfile(context, 2000);
  }

  // Mark the profile as ready so the bot does not try to log in again.
  fs.writeFileSync(path.join(profileDir, 'LOGIN_SUCCESS.txt'), 'ready', 'utf8');

  // ── 3. Verify ──────────────────────────────────────────────────
  let verified = null;
  let summary = null;
  if (VERIFY) {
    try {
      const { context: check } = await openProfile(profileName);
      const persisted = await check.cookies();
      summary = summarizeCookies(persisted);
      verified = persisted.length;
      await closeProfile(check, 300);
    } catch (e) {
      warn(`${profileName} - verification launch failed: ${e.message}`);
    }
  }

  // Record that this profile has been rebuilt behind THIS machine's DPAPI
  // boundary, so the dashboard stops asking for an import. Only written when
  // the cookies actually landed - a failed import must stay flagged.
  if (verified === null || verified > 0) {
    writeImportMarker(profileDir, bundleExportedAt);
  }

  if (verified !== null) {
    if (verified === 0) {
      fail(`${profileName} - VERIFY FAILED: no cookies persisted.`);
    } else if (summary && !summary.loggedIn) {
      warn(`${profileName} - ${verified} cookies persisted, but no Google login cookie.`);
    } else {
      ok(`${profileName} - ${verified} cookies persisted, Google login present.`);
    }
  }

  return {
    profileName,
    email: record.accountEmail || null,
    exportedCookies: exported.length,
    injected,
    verified,
    loggedIn: summary ? summary.loggedIn : null,
    hadProfileDir,
    carriedForeignKey,
  };
}

/**
 * accounts.json entries whose profile never made it into the bundle - these
 * will be built from scratch (and hit CAPTCHAs) unless the user notices.
 */
function reportMissingAccounts() {
  // Measured against the whole bundle, not just this run's selection, so a
  // --only import doesn't report every other account as missing.
  const inBundle = new Set(listBundledProfiles());
  const missing = (config.accounts || [])
    .filter((a) => a && a.email)
    .filter((a) => !inBundle.has(profileDirNameFor(a.email)));

  if (missing.length) {
    warn(`${missing.length} account(s) in accounts.json have no exported profile:`);
    missing.forEach((a) => warn(`  - ${a.email}`));
    warn('  These will be created fresh on first run and will need a warmup.');
  }
}

async function main() {
  log('');
  log('==========================================================');
  log('  Profile Import - rebuild the profiles on this machine');
  log('==========================================================');

  if (!fs.existsSync(BUNDLE_DIR)) {
    fail(`No profile-bundle/ folder found at ${BUNDLE_DIR}`);
    fail('Run the export on the source machine first, and make sure');
    fail('profile-bundle/ is inside the zip you copied over.');
    process.exit(1);
  }

  const manifest = readManifest();
  if (manifest) {
    info(`Bundle exported ${manifest.exportedAt}`);
    info(`Source machine:  ${manifest.source.hostname} (${manifest.source.platform})`);
    info(`Source node:     ${manifest.source.node}   here: ${process.version}`);
  } else {
    warn('No manifest.json in the bundle - continuing with the cookie files alone.');
  }

  let names = listBundledProfiles();
  if (ONLY) names = names.filter((n) => ONLY.includes(n));

  if (names.length === 0) {
    fail('No profiles found in profile-bundle/profiles/.');
    process.exit(1);
  }

  // Importing on the machine that produced the bundle is a no-op round trip:
  // it deletes a perfectly good cookie store and rebuilds it from the export.
  // Harmless when it works, but there is nothing to gain, so make it explicit.
  if (manifest && manifest.source && manifest.source.machineId === machineId() && !FORCE) {
    log('');
    warn('This is the machine that created the bundle - its cookies are already');
    warn('readable here, so there is nothing to import. Run this on the OTHER');
    warn('laptop after unzipping. To rebuild the profiles here anyway, pass --force.');
    log('');
    process.exit(0);
  }

  step('Browser build');
  if (!installBundledBrowser(manifest)) checkChromium(manifest);

  step('Identity check');
  // The identity is derived from the profile name and the proxy country, so a
  // different PROXY_LIST in .env would silently change every fingerprint.
  const sample = profileIdentity(names[0]);
  if (manifest && manifest.proxyCountry && manifest.proxyCountry !== sample.country) {
    fail(`Proxy country changed: bundle was built for "${manifest.proxyCountry}",`);
    fail(`this machine's .env resolves to "${sample.country}".`);
    fail('That changes every profile\'s timezone and locale. Fix PROXY_LIST in');
    fail('.env (or set PROXY_COUNTRY) to match before importing.');
    process.exit(1);
  }
  ok(`Proxy country "${sample.country}" matches the bundle.`);
  info(`Example - ${names[0]}: seed ${sample.seed}, ${sample.timezone}, ${sample.locale}, ` +
    `${sample.screen.width}x${sample.screen.height}`);

  step(`Importing ${names.length} profile(s)`);
  fs.mkdirSync(PROFILES_DIR, { recursive: true });

  const results = [];
  for (const name of names) {
    log('');
    results.push(await importProfile(name, manifest ? manifest.exportedAt : null));
  }

  step('Import complete');
  const errored = results.filter((r) => r.error);
  const emptyVerify = results.filter((r) => r.verified === 0);
  const loggedIn = results.filter((r) => r.loggedIn).length;
  const noFolder = results.filter((r) => r.hadProfileDir === false);

  info(`Profiles imported:   ${results.length - errored.length}/${results.length}`);
  if (VERIFY) info(`Google login verified: ${loggedIn}/${results.length}`);

  if (noFolder.length) {
    warn(`${noFolder.length} profile(s) arrived without their chrome-profiles/ folder.`);
    warn('  Their Google login is restored, but browsing history and localStorage');
    warn('  did not transfer. If that was not intentional, re-zip the source folder');
    warn('  with chrome-profiles/ included and import again.');
  }

  reportMissingAccounts();

  if (errored.length || emptyVerify.length) {
    log('');
    for (const r of errored) fail(`${r.profileName}: ${r.error}`);
    for (const r of emptyVerify) fail(`${r.profileName}: cookies did not persist.`);
    fail('Import finished with problems - do not start the bot until these are fixed.');
    process.exit(1);
  }

  log('');
  ok('All profiles imported and verified. The bot can be started now.');
  info('First run tip: keep SESSIONS_PER_KEYWORD low for a day so the restored');
  info('profiles re-establish a normal rhythm on this machine.');
  log('');
}

main().catch((err) => {
  fail(`Fatal: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
