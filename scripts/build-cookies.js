/**
 * Build N warm, un-owned Chrome profiles ("the cookie pool").
 *
 * The problem this solves
 * ----------------------
 * A brand new profile that is created and immediately signed into Google is
 * the worst possible first impression: no NID, no consent record, no history,
 * no age - and the very first request it makes is an authentication. That is
 * the profile that gets a reCAPTCHA.
 *
 * So the two halves are separated in time. This script builds profiles with
 * nobody signed into them and browses normally in each one until it holds the
 * cookies a real browser accumulates. They then sit in the pool. Later, when a
 * new account is added, provision-accounts.js hands it one of these already
 * trusted profiles and signs in there - a login from a browser Google has seen
 * behaving like a person, which is the request that does NOT get challenged.
 *
 * Pool profiles are named pool.<random> and keep that name forever, even after
 * an account claims one (see src/profile-map.js): the name seeds the profile's
 * fingerprint, so renaming it would throw away the trust just built.
 *
 *   node scripts/build-cookies.js --count 5
 *   node scripts/build-cookies.js --count 5 --rounds 2   (heavier warmup)
 *   node scripts/build-cookies.js --count 3 --headed
 */
import fs from 'fs';
import config from '../config.js';
import { launchBrowser } from '../src/browser.js';
import { warmupProfile } from '../src/warmup.js';
import {
  newPoolProfileName,
  profileDirFor,
  profileIdentity,
  isPoolProfile,
} from '../src/profile-identity.js';
import { assignedDirs } from '../src/profile-map.js';
import { updateProfile } from './lib/profile-state.js';
import {
  listProfileDirs,
  summarizeCookies,
  cookieHealth,
  normalizeCookie,
  sleep,
  log,
  step,
  ok,
  warn,
  fail,
  info,
} from './lib/bundle.js';

const args = process.argv.slice(2);

function numArg(flag, fallback, min, max) {
  const i = args.indexOf(flag);
  if (i < 0 || !args[i + 1]) return fallback;
  const n = parseInt(args[i + 1], 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

const COUNT = numArg('--count', 1, 1, 50);
const ROUNDS = numArg('--rounds', 1, 1, 5);
const HEADED = args.includes('--headed');
const HEADLESS_FLAG = args.includes('--headless');

/**
 * Warmup is browsing, and browsing is what the bot does headless every day, so
 * headless is fine here - .env decides unless a flag overrides it.
 */
function headlessMode() {
  if (HEADED) return false;
  if (HEADLESS_FLAG) return true;
  return config.headless;
}

/** A pool name nothing on disk is using yet. */
function freshPoolName(taken) {
  for (let i = 0; i < 50; i++) {
    const name = newPoolProfileName();
    if (!taken.has(name)) {
      taken.add(name);
      return name;
    }
  }
  throw new Error('Could not find an unused pool profile name');
}

async function buildOne(profileDirName, index, total, headless) {
  const identity = profileIdentity(profileDirName);

  log('');
  info(`[${index}/${total}] ${profileDirName}`);
  info(
    `  identity: seed ${identity.seed}, ${identity.timezone}, ${identity.locale}, ` +
      `${identity.screen.width}x${identity.screen.height}`
  );

  let session;
  try {
    // No account, no login - just the profile, its fingerprint and its proxy.
    session = await launchBrowser(0, null, false, { profileDirName, headless });
  } catch (e) {
    fail(`could not launch: ${e.message}`);
    return { profileDirName, error: e.message };
  }

  const { context, page } = session;
  try {
    await warmupProfile(page, context, { rounds: ROUNDS, label: profileDirName });

    const raw = await context.cookies().then((c) => c.map(normalizeCookie)).catch(() => []);
    const cookies = summarizeCookies(raw);
    const health = cookieHealth(raw);

    updateProfile(profileDirName, {
      kind: 'pool',
      email: null,
      createdAt: new Date().toISOString(),
      warmedAt: new Date().toISOString(),
      rounds: ROUNDS,
      cookies: cookies.total,
      googleCookies: cookies.google,
      cookieVerdict: health.verdict,
      loggedIn: false,
      lastError: null,
    });

    const line = `ready — ${cookies.total} cookies (${cookies.google} Google), warmth: ${health.verdict}`;
    if (health.healthy) ok(line);
    else warn(`${line} — missing ${health.missing.join(', ')}. Re-warm this one before use.`);

    return { profileDirName, cookies: cookies.total, verdict: health.verdict };
  } catch (e) {
    fail(`warmup failed: ${e.message}`);
    updateProfile(profileDirName, {
      kind: 'pool',
      createdAt: new Date().toISOString(),
      lastError: e.message,
    });
    return { profileDirName, error: e.message };
  } finally {
    // Let Chrome flush the cookie store it just filled before the process ends.
    await sleep(2000);
    await context.close().catch(() => {});
    await sleep(500);
  }
}

async function main() {
  const headless = headlessMode();
  const existing = listProfileDirs();
  const taken = new Set(existing);
  const claimed = assignedDirs();
  const freeBefore = existing.filter((n) => isPoolProfile(n) && !claimed.has(n)).length;

  log('');
  log('==========================================================');
  log('  Build cookie profiles - warm, unclaimed, ready to use');
  log('==========================================================');
  info(`Building:      ${COUNT} profile(s)`);
  info(`Warmup rounds: ${ROUNDS}`);
  info(`Browser:       ${headless ? 'headless' : 'visible'}`);
  info(`Proxies:       ${(config.proxies || []).length || 'none (direct connection)'}`);
  info(`Pool already holds ${freeBefore} unclaimed profile(s).`);

  if (!(config.proxies || []).length) {
    warn('No proxies configured - every profile will warm up from this machine\'s own IP,');
    warn('  and will keep using it later. That is a shared-IP pattern across the pool.');
  }

  step(`Warming ${COUNT} new profile(s)`);

  const results = [];
  for (let i = 1; i <= COUNT; i++) {
    const name = freshPoolName(taken);
    results.push(await buildOne(name, i, COUNT, headless));

    if (i < COUNT) {
      // Profiles created back-to-back on the same second, from the same exit,
      // look like exactly what they are. Space them out.
      const gap = 15000 + Math.random() * 25000;
      info(`  …resting ${(gap / 1000).toFixed(0)}s before the next profile`);
      await sleep(gap);
    }
  }

  step('Summary');
  const built = results.filter((r) => !r.error);
  const failed = results.filter((r) => r.error);

  info(`Built:  ${built.length}/${COUNT}`);
  for (const r of built) info(`  ${r.profileDirName} — ${r.cookies} cookies, warmth: ${r.verdict}`);
  for (const r of failed) fail(`  ${r.profileDirName} — ${r.error}`);

  // A profile whose folder exists but which never got cookies is worse than no
  // profile: provisioning would hand it out as if it were warm.
  for (const r of failed) {
    const dir = profileDirFor(r.profileDirName);
    try {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
        info(`  removed the empty folder for ${r.profileDirName}`);
      }
    } catch {
      warn(`  could not remove ${dir} - delete it by hand so it is not handed out.`);
    }
  }

  log('');
  if (built.length) {
    ok(`${freeBefore + built.length} warm profile(s) are now waiting in the pool.`);
    info('Add accounts in the Accounts tab, then click "Provision new accounts" to');
    info('sign them into these profiles instead of building cold ones.');
  }
  log('');

  if (failed.length && !built.length) process.exit(1);
}

main().catch((err) => {
  fail(`Fatal: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
