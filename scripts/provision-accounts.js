/**
 * Give every account without a profile a working, signed-in one.
 *
 * Two paths, in this order:
 *
 *   1. A warm profile is waiting in the pool (built by build-cookies.js).
 *      Claim it for the account and sign in there. This is the good path: the
 *      browser already holds Google cookies, a consent record and a browsing
 *      history, so the sign-in arrives from something that looks like a person
 *      who has been using this machine for a while.
 *
 *   2. The pool is empty. Create a folder, warm it up FIRST, and only then
 *      sign in. Slower and a little riskier than path 1 (the warmup and the
 *      login happen in one sitting), but never "new profile straight into a
 *      login", which is the combination that draws a CAPTCHA.
 *
 * A claimed pool profile keeps its pool.<random> directory name for good - the
 * name seeds its fingerprint, so renaming it to the account's email would
 * change the hardware Google sees and undo the warmup. The email -> directory
 * link lives in profile-map.json instead.
 *
 *   node scripts/provision-accounts.js
 *   node scripts/provision-accounts.js --only new@gmail.com
 *   node scripts/provision-accounts.js --no-pool     (always build fresh)
 *   node scripts/provision-accounts.js --headed
 */
import fs from 'fs';
import path from 'path';
import config from '../config.js';
import { launchBrowser } from '../src/browser.js';
import { warmupProfile } from '../src/warmup.js';
import { loginToGoogle } from '../src/google-login.js';
import {
  profileDirNameFor,
  defaultProfileDirNameFor,
  profileDirFor,
  profileIdentity,
  isPoolProfile,
} from '../src/profile-identity.js';
import { assignedDirs, setAssignment, removeAssignment } from '../src/profile-map.js';
import { recordLoginResult, updateProfile, getProfile } from './lib/profile-state.js';
import {
  listProfileDirs,
  summarizeCookies,
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
const NO_POOL = args.includes('--no-pool');
const HEADED = args.includes('--headed');
const HEADLESS_FLAG = args.includes('--headless');
const ROUNDS = (() => {
  const i = args.indexOf('--rounds');
  const n = i >= 0 ? parseInt(args[i + 1], 10) : NaN;
  return Number.isFinite(n) ? Math.min(5, Math.max(1, n)) : 1;
})();
const ONLY = (() => {
  const i = args.indexOf('--only');
  if (i < 0 || !args[i + 1]) return null;
  return args[i + 1].split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
})();

/** Signing in may need a human for 2FA, so default to a visible window. */
function headlessMode() {
  if (HEADED) return false;
  if (HEADLESS_FLAG) return true;
  return config.headless;
}

/**
 * Warm pool profiles nobody has claimed, oldest first.
 *
 * Oldest first on purpose: a profile that has been sitting since last week has
 * cookies with age on them, which is worth more than one warmed an hour ago.
 */
function freePoolProfiles() {
  const claimed = assignedDirs();
  return listProfileDirs()
    .filter((n) => isPoolProfile(n) && !claimed.has(n))
    .map((name) => ({ name, record: getProfile(name) }))
    // Only hand out profiles that actually finished a warmup. A folder with no
    // record is one build-cookies.js never got through.
    .filter((p) => p.record && p.record.warmedAt)
    .sort((a, b) => String(a.record.warmedAt).localeCompare(String(b.record.warmedAt)))
    .map((p) => p.name);
}

/** Accounts with no usable profile directory yet. */
function accountsNeedingProfiles() {
  const onDisk = new Set(listProfileDirs());
  return (config.accounts || [])
    .filter((a) => a && a.email)
    .filter((a) => !ONLY || ONLY.includes(a.email.toLowerCase()))
    .filter((a) => !onDisk.has(profileDirNameFor(a.email)));
}

async function provision(account, profileDirName, { fromPool, headless }) {
  const identity = profileIdentity(profileDirName);
  const profileDir = profileDirFor(profileDirName);

  log('');
  info(`${account.email}`);
  info(`  profile:  ${profileDirName}  ${fromPool ? '(claimed from the warm pool)' : '(new, will be warmed first)'}`);
  info(
    `  identity: seed ${identity.seed}, ${identity.timezone}, ${identity.locale}, ` +
      `${identity.screen.width}x${identity.screen.height}`
  );

  let session;
  try {
    session = await launchBrowser(0, account, false, { profileDirName, headless });
  } catch (e) {
    fail(`could not launch the profile: ${e.message}`);
    return { email: account.email, profileDirName, status: 'launch-failed', error: e.message };
  }

  const { context, page } = session;
  try {
    // A pool profile is already warm. A fresh one must not go straight to a
    // login - that is the exact request Google challenges.
    if (!fromPool) {
      await warmupProfile(page, context, { rounds: ROUNDS, label: account.email });
      // A beat between "finished browsing" and "opened the sign-in page".
      await sleep(5000 + Math.random() * 5000);
    }

    const result = await loginToGoogle(page, account);
    const cookies = await context
      .cookies()
      .then((c) => summarizeCookies(c.map(normalizeCookie)))
      .catch(() => null);

    recordLoginResult(profileDirName, {
      email: account.email,
      signedIn: result.ok,
      cookies: cookies ? cookies.total : null,
      result,
    });
    updateProfile(profileDirName, {
      kind: 'account',
      provisionedAt: new Date().toISOString(),
      fromPool,
      googleCookies: cookies ? cookies.google : null,
    });

    if (result.ok) {
      try {
        fs.writeFileSync(path.join(profileDir, 'LOGIN_SUCCESS.txt'), 'ready', 'utf8');
      } catch {
        /* non-fatal */
      }
      ok(`${result.message} — ${cookies ? cookies.total : '?'} cookies, auth: ${cookies ? cookies.auth.join(', ') || 'none' : '?'}`);
      return { email: account.email, profileDirName, status: 'provisioned', fromPool };
    }

    fail(`${result.state}: ${result.message}`);
    return {
      email: account.email,
      profileDirName,
      status: result.state,
      error: result.message,
      fromPool,
    };
  } catch (e) {
    fail(`error: ${e.message}`);
    return { email: account.email, profileDirName, status: 'error', error: e.message, fromPool };
  } finally {
    await sleep(2000);
    await context.close().catch(() => {});
    await sleep(500);
  }
}

async function main() {
  const headless = headlessMode();

  log('');
  log('==========================================================');
  log('  Provision accounts - give new accounts a warm profile');
  log('==========================================================');

  const needing = accountsNeedingProfiles();
  const pool = NO_POOL ? [] : freePoolProfiles();

  info(`Accounts without a profile: ${needing.length}`);
  info(`Warm pool profiles free:    ${pool.length}${NO_POOL ? ' (ignored: --no-pool)' : ''}`);
  info(`Browser:                    ${headless ? 'headless' : 'visible (needed if Google asks for verification)'}`);

  if (needing.length === 0) {
    log('');
    ok('Every account already has a profile folder.');
    info('If some of them are signed OUT, that is the Re-login button, not this one.');
    log('');
    return;
  }

  if (pool.length < needing.length) {
    const short = needing.length - pool.length;
    warn(`${short} account(s) will get a brand new profile that has to be warmed up now.`);
    warn('  That works, but a profile warmed days in advance is stronger. To use the');
    warn(`  better path, build ${short} pool profile(s) first and run this again.`);
  }

  const noPassword = needing.filter((a) => !a.password);
  if (noPassword.length) {
    warn(`${noPassword.length} account(s) have no password and will be skipped:`);
    noPassword.forEach((a) => warn(`  - ${a.email}`));
  }

  const work = needing.filter((a) => a.password);
  step(`Provisioning ${work.length} account(s)`);

  const results = [];
  for (let i = 0; i < work.length; i++) {
    const account = work[i];
    const claimed = pool.shift() || null;
    let profileDirName;

    if (claimed) {
      try {
        setAssignment(account.email, claimed);
        profileDirName = claimed;
      } catch (e) {
        // Somebody else owns it - fall through to a fresh profile rather than
        // letting two accounts share one cookie jar.
        warn(`could not claim ${claimed}: ${e.message}`);
        profileDirName = defaultProfileDirNameFor(account.email);
      }
    } else {
      profileDirName = defaultProfileDirNameFor(account.email);
    }

    const fromPool = isPoolProfile(profileDirName);
    const result = await provision(account, profileDirName, { fromPool, headless });

    // A claimed profile that could not be signed into goes back to the pool -
    // it is still warm, and holding it hostage to a failed login would waste it.
    if (fromPool && result.status !== 'provisioned') {
      removeAssignment(account.email);
      updateProfile(profileDirName, { kind: 'pool', email: null });
      warn(`returned ${profileDirName} to the pool`);
    }

    results.push(result);

    if (i < work.length - 1) {
      const gap = 12000 + Math.random() * 18000;
      info(`  …resting ${(gap / 1000).toFixed(0)}s before the next account`);
      await sleep(gap);
    }
  }

  step('Summary');
  const done = results.filter((r) => r.status === 'provisioned');
  const bad = results.filter((r) => r.status !== 'provisioned');

  info(`Provisioned: ${done.length}/${results.length}`);
  for (const r of done) {
    info(`  ${r.email} → ${r.profileDirName}${r.fromPool ? ' (warm pool profile)' : ' (freshly warmed)'}`);
  }
  for (const r of bad) {
    fail(`  ${r.email} → ${r.status}${r.error ? `: ${r.error}` : ''}`);
  }

  if (bad.some((r) => r.status === 'challenge')) {
    log('');
    warn('Google asked for verification on at least one account. Re-run with the');
    warn('browser visible and complete it by hand - the profile is kept either way.');
  }

  log('');
  if (done.length === results.length) {
    ok('All new accounts are provisioned and signed in.');
    info('Run the export before moving this folder to another laptop, or their');
    info('cookies will not survive the trip.');
  }
  log('');

  if (bad.length) process.exit(1);
}

main().catch((err) => {
  fail(`Fatal: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
