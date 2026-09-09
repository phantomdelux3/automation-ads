/**
 * Re-warm the cookies of profiles that already exist.
 *
 * What this is for
 * ----------------
 * Cookies decay. NID and AEC expire, SOCS gets cleared, a profile sits unused
 * for a month, or an import rebuilt the cookie store and only the login came
 * back. The profile still looks like a long-lived browser on disk - it just no
 * longer carries the cookies that tell Google it has been seen before, and the
 * next search from it is the one that gets a reCAPTCHA.
 *
 * This walks every existing profile, browses normally in each one, and keeps
 * going until the jar actually grades healthy (see cookieHealth in
 * scripts/lib/bundle.js) rather than just assuming one lap was enough.
 *
 * Two things make this trustworthy rather than hopeful:
 *
 *   1. It grades the result instead of counting rounds. A profile that comes
 *      back "thin" gets another round, up to --max-rounds.
 *   2. It re-opens the profile OFFLINE afterwards and re-reads the jar, so the
 *      report is what actually persisted to disk - not what the browser held
 *      in memory before it was closed. Chrome flushes cookies on shutdown, and
 *      a lost flush is exactly the silent failure this is meant to catch.
 *
 * Existing sessions are left alone: warming is only browsing, it never signs
 * anything out. A profile that was signed in stays signed in.
 *
 *   node scripts/rewarmup.js                        every profile on disk
 *   node scripts/rewarmup.js --only a@b.com         one account
 *   node scripts/rewarmup.js --only pool.1a2b3c4d   one profile by folder name
 *   node scripts/rewarmup.js --accounts-only
 *   node scripts/rewarmup.js --rounds 2 --max-rounds 4
 *   node scripts/rewarmup.js --headless
 */
import config from '../config.js';
import { launchBrowser } from '../src/browser.js';
import { warmupProfile } from '../src/warmup.js';
import { profileDirNameFor, isPoolProfile } from '../src/profile-identity.js';
import { emailForDir } from '../src/profile-map.js';
import { openProfile, closeProfile } from './lib/profile-browser.js';
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

const ROUNDS = numArg('--rounds', 1, 1, 5);
const MAX_ROUNDS = Math.max(ROUNDS, numArg('--max-rounds', 3, 1, 6));
const HEADED = args.includes('--headed');
const HEADLESS_FLAG = args.includes('--headless');
const ACCOUNTS_ONLY = args.includes('--accounts-only');
const POOL_ONLY = args.includes('--pool-only');
const NO_VERIFY = args.includes('--no-verify');
const ONLY = (() => {
  const i = args.indexOf('--only');
  if (i < 0 || !args[i + 1]) return null;
  return args[i + 1].split(',').map((s) => s.trim()).filter(Boolean);
})();

/** Warming is only browsing, so headless is fine unless a CAPTCHA needs hands. */
function headlessMode() {
  if (HEADED) return false;
  if (HEADLESS_FLAG) return true;
  return config.headless;
}

/**
 * Which profiles to work on.
 *
 * --only accepts either an account email or a profile folder name, because
 * pool profiles have no email and are addressed by folder.
 */
function targetProfiles() {
  const onDisk = listProfileDirs();

  if (ONLY) {
    const wanted = new Set();
    for (const token of ONLY) {
      if (onDisk.includes(token)) {
        wanted.add(token);
        continue;
      }
      const byEmail = profileDirNameFor(token);
      if (onDisk.includes(byEmail)) wanted.add(byEmail);
      else warn(`--only "${token}" matches no profile on disk, skipping.`);
    }
    return [...wanted].sort();
  }

  return onDisk
    .filter((n) => (ACCOUNTS_ONLY ? !isPoolProfile(n) : true))
    .filter((n) => (POOL_ONLY ? isPoolProfile(n) : true));
}

/** The account this folder belongs to, whether by map or by its name. */
function emailFor(profileDirName) {
  const mapped = emailForDir(profileDirName);
  if (mapped) return mapped;
  const match = (config.accounts || []).find(
    (a) => a && a.email && profileDirNameFor(a.email) === profileDirName
  );
  return match ? match.email : null;
}

function describe(health) {
  const bits = [
    health.consent ? 'consent' : null,
    health.nid ? 'NID' : null,
    health.aec ? 'AEC' : null,
    health.youtube ? 'YouTube' : null,
    health.loggedIn ? 'signed in' : null,
  ].filter(Boolean);
  return bits.length ? bits.join(' + ') : 'nothing';
}

/**
 * Re-read the jar with the profile re-opened offline.
 *
 * This is the honest number: it comes off disk, after Chrome has shut down and
 * flushed, with no network involved (see lib/profile-browser.js).
 */
async function verifyPersisted(profileDirName) {
  let context;
  try {
    ({ context } = await openProfile(profileDirName));
  } catch (e) {
    warn(`could not re-open to verify: ${e.message}`);
    return null;
  }
  try {
    const cookies = (await context.cookies()).map(normalizeCookie);
    return { summary: summarizeCookies(cookies), health: cookieHealth(cookies) };
  } catch (e) {
    warn(`could not re-read cookies: ${e.message}`);
    return null;
  } finally {
    await closeProfile(context, 300);
  }
}

async function rewarm(profileDirName, index, total, headless) {
  const email = emailFor(profileDirName);

  log('');
  info(`[${index}/${total}] ${profileDirName}${email ? `  (${email})` : '  (pool profile)'}`);

  let session;
  try {
    session = await launchBrowser(0, null, false, { profileDirName, headless });
  } catch (e) {
    fail(`could not launch: ${e.message}`);
    updateProfile(profileDirName, { lastError: e.message, lastCheckAt: new Date().toISOString() });
    return { profileDirName, email, error: e.message };
  }

  const { context, page } = session;
  let before = null;
  let after = null;
  let roundsRun = 0;

  try {
    before = cookieHealth((await context.cookies().catch(() => [])).map(normalizeCookie));
    info(`  before: ${before.verdict} — ${describe(before)}`);

    // Keep warming while the jar still grades below "ok". One lap is usually
    // enough; a cold profile sometimes needs two, and there is no point
    // stopping at a fixed count when the thing being fixed is measurable.
    while (roundsRun < MAX_ROUNDS) {
      const batch = roundsRun === 0 ? ROUNDS : 1;
      await warmupProfile(page, context, { rounds: batch, label: profileDirName });
      roundsRun += batch;

      after = cookieHealth((await context.cookies().catch(() => [])).map(normalizeCookie));
      if (after.healthy) break;

      if (roundsRun < MAX_ROUNDS) {
        warn(`  still ${after.verdict} (missing ${after.missing.join(', ')}) — another round`);
        await sleep(6000 + Math.random() * 8000);
      }
    }

    info(`  after:  ${after.verdict} — ${describe(after)}`);
  } catch (e) {
    fail(`warmup error: ${e.message}`);
    updateProfile(profileDirName, { lastError: e.message, lastCheckAt: new Date().toISOString() });
    return { profileDirName, email, error: e.message, before, after };
  } finally {
    // Chrome writes the cookie store on shutdown; rushing this is how a good
    // warmup ends up not on disk.
    await sleep(2500);
    await context.close().catch(() => {});
    await sleep(800);
  }

  // ── Verify what actually landed on disk ───────────────────
  let persisted = null;
  if (!NO_VERIFY) {
    persisted = await verifyPersisted(profileDirName);
    if (persisted) {
      const h = persisted.health;
      const line = `  on disk: ${persisted.summary.total} cookies (${persisted.summary.google} Google) — ${h.verdict}`;
      if (h.healthy) ok(line);
      else warn(`${line}, missing ${h.missing.join(', ')}`);
    }
  }

  const finalHealth = (persisted && persisted.health) || after;
  const finalSummary = persisted ? persisted.summary : null;

  updateProfile(profileDirName, {
    kind: isPoolProfile(profileDirName) && !email ? 'pool' : 'account',
    email,
    warmedAt: new Date().toISOString(),
    lastCheckAt: new Date().toISOString(),
    rounds: roundsRun,
    cookies: finalSummary ? finalSummary.total : null,
    googleCookies: finalSummary ? finalSummary.google : null,
    cookieVerdict: finalHealth ? finalHealth.verdict : null,
    // Warming never signs anything out, so a jar that still carries the login
    // cookie is still signed in as far as this script is concerned.
    loggedIn: finalHealth ? finalHealth.loggedIn : undefined,
    lastError: null,
  });

  return {
    profileDirName,
    email,
    before,
    after: finalHealth,
    rounds: roundsRun,
    cookies: finalSummary ? finalSummary.total : null,
  };
}

async function main() {
  const headless = headlessMode();

  log('');
  log('==========================================================');
  log('  Re-warm cookies - refresh the trust on existing profiles');
  log('==========================================================');

  const targets = targetProfiles();

  info(`Profiles:      ${targets.length}`);
  info(`Rounds:        ${ROUNDS} to start, up to ${MAX_ROUNDS} until the jar grades healthy`);
  info(`Browser:       ${headless ? 'headless' : 'visible'}`);
  info(`Proxies:       ${(config.proxies || []).length || 'none (direct connection)'}`);
  info(`Verify:        ${NO_VERIFY ? 'off' : 'profiles are re-opened offline afterwards'}`);

  if (targets.length === 0) {
    log('');
    warn('No profiles matched. Nothing to do.');
    log('');
    return;
  }

  step(`Re-warming ${targets.length} profile(s)`);

  const results = [];
  for (let i = 0; i < targets.length; i++) {
    results.push(await rewarm(targets[i], i + 1, targets.length, headless));

    if (i < targets.length - 1) {
      // Profiles warmed back-to-back from one proxy pool look like one machine
      // cycling identities. Spacing them out is most of what keeps this quiet.
      const gap = 20000 + Math.random() * 25000;
      info(`  …resting ${(gap / 1000).toFixed(0)}s before the next profile`);
      await sleep(gap);
    }
  }

  // ── Summary ───────────────────────────────────────────────
  step('Summary');
  const errored = results.filter((r) => r.error);
  const graded = results.filter((r) => !r.error && r.after);
  const healthy = graded.filter((r) => r.after.healthy);
  const weak = graded.filter((r) => !r.after.healthy);
  const improved = graded.filter(
    (r) => r.before && !r.before.healthy && r.after.healthy
  );

  info(`Warmed:            ${results.length - errored.length}/${results.length}`);
  info(`Healthy cookies:   ${healthy.length}/${graded.length}`);
  if (improved.length) info(`Rescued from cold: ${improved.length}`);

  for (const r of weak) {
    warn(`${r.profileDirName} - still ${r.after.verdict}, missing ${r.after.missing.join(', ')}`);
  }
  for (const r of errored) {
    fail(`${r.profileDirName} - ${r.error}`);
  }

  log('');
  if (weak.length) {
    warn('Profiles that stayed weak are usually a proxy problem, not a warmup one:');
    warn('  an exit IP that Google already distrusts will not hand out AEC/NID no');
    warn('  matter how long you browse. Try those profiles on a different endpoint.');
    log('');
  }
  if (healthy.length === graded.length && graded.length > 0) {
    ok('Every profile is carrying healthy Google cookies.');
  }
  log('');

  if (errored.length) process.exit(1);
}

main().catch((err) => {
  fail(`Fatal: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
