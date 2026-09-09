/**
 * Check every account's profile, and sign back in the ones that are logged out.
 *
 * This is the script behind the Accounts tab's Check / Re-login buttons, and
 * it exists for one specific situation:
 *
 *   Chrome encrypts cookies with a key bound to the Windows user + machine
 *   that created them. Copy chrome-profiles/ to another laptop and the profile
 *   arrives with all of its history, localStorage, preferences and age intact
 *   - but signed out, because the login cookies could not be decrypted. The
 *   profile still LOOKS trusted (which is why no CAPTCHA appears); it just has
 *   nobody signed into it.
 *
 * So the fix is not to rebuild the profile. It is to sign the same account
 * back into the same profile, over the same proxy, with the same fingerprint -
 * changing nothing else about it.
 *
 *   node scripts/relogin.js                     check all, re-login the signed-out
 *   node scripts/relogin.js --check-only        report only, never sign in
 *   node scripts/relogin.js --only a@b.com,c@d.com
 *   node scripts/relogin.js --headed            show the browser (needed for 2FA)
 *   node scripts/relogin.js --force             re-login even if already signed in
 */
import fs from 'fs';
import path from 'path';
import config from '../config.js';
import { launchBrowser } from '../src/browser.js';
import { detectLoginState, loginToGoogle } from '../src/google-login.js';
import { profileDirNameFor, profileDirFor } from '../src/profile-identity.js';
import { recordLoginResult, updateProfile } from './lib/profile-state.js';
import { summarizeCookies, normalizeCookie, sleep, log, step, ok, warn, fail, info } from './lib/bundle.js';

const args = process.argv.slice(2);
const CHECK_ONLY = args.includes('--check-only');
const FORCE = args.includes('--force');
const HEADED = args.includes('--headed');
const HEADLESS_FLAG = args.includes('--headless');
const ONLY = (() => {
  const i = args.indexOf('--only');
  if (i < 0 || !args[i + 1]) return null;
  return args[i + 1]
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
})();

/**
 * Signing in may need a human (2FA, "verify it's you", a CAPTCHA), so the
 * default is a visible window unless .env or a flag says otherwise. A
 * check-only pass never needs one and stays headless.
 */
function headlessMode() {
  if (HEADED) return false;
  if (HEADLESS_FLAG) return true;
  if (CHECK_ONLY) return true;
  return config.headless;
}

/** Pause between profiles - thirteen logins in a row from one exit is a pattern. */
function restBetweenProfiles() {
  return 8000 + Math.random() * 12000;
}

async function handleAccount(account, headless) {
  const profileDirName = profileDirNameFor(account.email);
  const profileDir = profileDirFor(profileDirName);

  log('');
  info(`${account.email}  →  ${profileDirName}`);

  if (!fs.existsSync(profileDir)) {
    warn('no profile folder on this machine - run "Provision new accounts" instead.');
    return { email: account.email, profileDirName, status: 'missing' };
  }

  let session;
  try {
    // No performLogin here: the launcher's own login is a one-shot gated on
    // LOGIN_SUCCESS.txt, and after a transfer that marker exists while the
    // session does not. This script decides for itself, from what Google says.
    session = await launchBrowser(0, account, false, { profileDirName, headless });
  } catch (e) {
    fail(`could not launch the profile: ${e.message}`);
    updateProfile(profileDirName, {
      kind: 'account',
      email: account.email,
      lastCheckAt: new Date().toISOString(),
      lastError: e.message,
    });
    return { email: account.email, profileDirName, status: 'launch-failed', error: e.message };
  }

  const { context, page } = session;
  let outcome = { email: account.email, profileDirName };

  try {
    const state = await detectLoginState(page);
    const cookieCount = await context
      .cookies()
      .then((c) => c.length)
      .catch(() => null);

    if (state.signedIn && !FORCE) {
      ok(`signed in${state.email ? ` as ${state.email}` : ''} (${cookieCount ?? '?'} cookies)`);
      recordLoginResult(profileDirName, {
        email: account.email,
        signedIn: true,
        cookies: cookieCount,
        result: { ok: true, state: 'already', message: 'session still valid' },
      });
      outcome.status = 'signed-in';
      return outcome;
    }

    if (!state.signedIn) {
      if (state.blocked === 'challenge') {
        warn('Google is showing a verification screen for this profile.');
      } else {
        warn(`signed OUT (${cookieCount ?? '?'} cookies present)`);
      }
    }

    if (CHECK_ONLY) {
      recordLoginResult(profileDirName, {
        email: account.email,
        signedIn: false,
        cookies: cookieCount,
        result: null,
      });
      outcome.status = 'signed-out';
      return outcome;
    }

    // ── Re-login ────────────────────────────────────────────
    const result = await loginToGoogle(page, account, { skipIfSignedIn: !FORCE });

    const after = await context
      .cookies()
      .then((c) => summarizeCookies(c.map(normalizeCookie)))
      .catch(() => null);

    recordLoginResult(profileDirName, {
      email: account.email,
      signedIn: result.ok,
      cookies: after ? after.total : cookieCount,
      result,
    });

    if (result.ok) {
      ok(`${result.message}${after ? ` — ${after.total} cookies, auth: ${after.auth.join(', ') || 'none'}` : ''}`);
      // The marker now means what it claims: this profile has a live session.
      try {
        fs.writeFileSync(path.join(profileDir, 'LOGIN_SUCCESS.txt'), 'ready', 'utf8');
      } catch {
        /* non-fatal */
      }
      outcome.status = 'relogged-in';
    } else {
      fail(`${result.state}: ${result.message}`);
      outcome.status = result.state;
      outcome.error = result.message;
    }
    return outcome;
  } catch (e) {
    fail(`error: ${e.message}`);
    updateProfile(profileDirName, {
      kind: 'account',
      email: account.email,
      lastCheckAt: new Date().toISOString(),
      lastError: e.message,
    });
    outcome.status = 'error';
    outcome.error = e.message;
    return outcome;
  } finally {
    // Chrome flushes its cookie store on shutdown; racing that flush is how a
    // successful login ends up not persisted.
    await sleep(1500);
    await context.close().catch(() => {});
    await sleep(500);
  }
}

async function main() {
  const headless = headlessMode();

  log('');
  log('==========================================================');
  log(CHECK_ONLY ? '  Login check - are the profiles still signed in?' : '  Re-login - sign the signed-out profiles back in');
  log('==========================================================');

  let accounts = (config.accounts || []).filter((a) => a && a.email);
  if (ONLY) {
    accounts = accounts.filter((a) => ONLY.includes(a.email.toLowerCase()));
  }

  if (accounts.length === 0) {
    fail(ONLY ? 'None of the requested emails are in accounts.json.' : 'accounts.json has no accounts.');
    process.exit(1);
  }

  const noPassword = accounts.filter((a) => !a.password);
  if (noPassword.length && !CHECK_ONLY) {
    warn(`${noPassword.length} account(s) have no password and cannot be signed in:`);
    noPassword.forEach((a) => warn(`  - ${a.email}`));
  }

  info(`Accounts:  ${accounts.length}`);
  info(`Browser:   ${headless ? 'headless' : 'visible (needed if Google asks for verification)'}`);
  info(`Proxies:   ${(config.proxies || []).length || 'none (direct connection)'}`);
  if (CHECK_ONLY) info('Mode:      check only - no sign-in will be attempted');

  step(`Working through ${accounts.length} profile(s)`);

  const results = [];
  for (let i = 0; i < accounts.length; i++) {
    results.push(await handleAccount(accounts[i], headless));
    if (i < accounts.length - 1) {
      const gap = restBetweenProfiles();
      info(`  …resting ${(gap / 1000).toFixed(0)}s before the next profile`);
      await sleep(gap);
    }
  }

  // ── Summary ───────────────────────────────────────────────
  step('Summary');
  const by = (s) => results.filter((r) => r.status === s);
  const good = [...by('signed-in'), ...by('relogged-in')];
  const bad = results.filter((r) => !['signed-in', 'relogged-in'].includes(r.status));

  info(`Signed in already:  ${by('signed-in').length}`);
  if (!CHECK_ONLY) info(`Signed back in:     ${by('relogged-in').length}`);
  if (CHECK_ONLY) info(`Signed out:         ${by('signed-out').length}`);
  info(`Problems:           ${bad.length - (CHECK_ONLY ? by('signed-out').length : 0)}`);

  for (const r of bad) {
    if (CHECK_ONLY && r.status === 'signed-out') {
      warn(`${r.email} - signed out (run Re-login to fix)`);
      continue;
    }
    if (r.status === 'missing') {
      warn(`${r.email} - no profile yet (use "Provision new accounts")`);
    } else if (r.status === 'challenge') {
      fail(`${r.email} - Google wants verification. Re-run with the browser visible and finish it by hand.`);
    } else if (r.status === 'rejected') {
      fail(`${r.email} - Google refused the browser. Warm the profile up before signing in.`);
    } else if (r.status === 'bad-password') {
      fail(`${r.email} - wrong password in accounts.json.`);
    } else {
      fail(`${r.email} - ${r.status}${r.error ? `: ${r.error}` : ''}`);
    }
  }

  log('');
  if (!CHECK_ONLY && good.length === results.length) {
    ok('Every profile has a live Google session. The bot can be started.');
  } else if (CHECK_ONLY) {
    ok('Check complete - the Accounts tab now shows the current state.');
  }
  log('');

  // Only a real failure is worth a non-zero exit; "signed out" is the expected
  // finding of a check-only run, not an error.
  const hardFailures = bad.filter((r) => !(CHECK_ONLY && r.status === 'signed-out') && r.status !== 'missing');
  if (hardFailures.length) process.exit(1);
}

main().catch((err) => {
  fail(`Fatal: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
