/**
 * Signing a profile back into Google, and telling whether it is signed in.
 *
 * Why this is its own module
 * --------------------------
 * Chrome encrypts its cookie store with a key bound to the Windows user +
 * machine that created it (see scripts/lib/bundle.js). Move a profile folder
 * to another laptop and the *login* cookies are the one thing that does not
 * survive - everything else (history, localStorage, preferences, the profile's
 * age) comes across fine. That is the exact situation this module is for: a
 * profile that still looks like a long-lived, trusted browser but arrives
 * signed out. Signing it back in restores the account without touching
 * anything that would make the browser look new.
 *
 * Everything here runs on the page the caller already opened, so the profile
 * keeps its own fingerprint, proxy and timezone throughout.
 */
import { sleep, gaussianDelay, humanScroll, mouseJitter } from './human-behavior.js';
import { detectAndHandleRecaptcha } from './captcha-guard.js';
import config from '../config.js';
import chalk from 'chalk';

/** Landing page used for every signed-in check. Signed-out visits redirect. */
const MYACCOUNT_URL = 'https://myaccount.google.com/';
const SIGNIN_URL =
  'https://accounts.google.com/ServiceLogin?hl=en&continue=https%3A%2F%2Fmyaccount.google.com%2F';
const LOGOUT_URL = 'https://accounts.google.com/Logout';

/** URLs Google sends a signed-out (or half-signed-in) browser to. */
const SIGNIN_URL_RE = /accounts\.google\.com\/(v3\/signin|signin|ServiceLogin|AccountChooser)/i;
const CHALLENGE_URL_RE = /accounts\.google\.com\/.*(challenge|deniedsigninrejected|speedbump)/i;

// ── Small helpers ───────────────────────────────────────────────────

const log = {
  step: (m) => console.log(chalk.blue(`    → ${m}`)),
  ok: (m) => console.log(chalk.green(`    ✓ ${m}`)),
  warn: (m) => console.log(chalk.yellow(`    ⚠ ${m}`)),
  fail: (m) => console.log(chalk.red(`    ✗ ${m}`)),
  dim: (m) => console.log(chalk.dim(`      ${m}`)),
};

/** First visible locator out of a list, or null. Never throws. */
async function firstVisible(page, selectors, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      try {
        const loc = page.locator(sel).first();
        if (await loc.isVisible({ timeout: 250 }).catch(() => false)) return loc;
      } catch {
        /* selector not present yet */
      }
    }
    await sleep(200);
  }
  return null;
}

/**
 * Type into a field one character at a time.
 *
 * Google's sign-in form watches keystroke timing; a value that materialises in
 * one paste-like event is one of the cheapest bot tells on the page.
 */
async function typeLikeAHuman(locator, text) {
  await locator.click();
  await sleep(250, 700);
  try {
    await locator.pressSequentially(text, { delay: gaussianDelay(120, 45) });
  } catch {
    // Older Playwright builds only have type(); fill() is the last resort.
    try {
      await locator.type(text, { delay: 120 });
    } catch {
      await locator.fill(text);
    }
  }
  await sleep(300, 900);
}

/** Accept Google's cookie/consent interstitial when it is in the way. */
export async function acceptConsent(page) {
  const btn = await firstVisible(
    page,
    [
      'button#L2AGLb',
      'button[aria-label="Accept all"]',
      'button:has-text("Accept all")',
      'button:has-text("I agree")',
      'div[role="button"]:has-text("Accept all")',
    ],
    3000
  );
  if (!btn) return false;
  await sleep(400, 1200);
  await btn.click().catch(() => {});
  log.dim('accepted Google consent dialog');
  await sleep(1000, 2200);
  return true;
}

/**
 * Dismiss the "Protect your account" / passkey / "Add recovery" screens that
 * appear right after a successful sign-in. Left alone they park the profile on
 * an interstitial instead of a real signed-in page.
 */
async function skipPostLoginInterstitials(page, rounds = 3) {
  for (let i = 0; i < rounds; i++) {
    const btn = await firstVisible(
      page,
      [
        'button:has-text("Not now")',
        'button:has-text("Skip")',
        'button:has-text("Cancel")',
        'button:has-text("Done")',
        'div[role="button"]:has-text("Not now")',
      ],
      2500
    );
    if (!btn) return;
    log.dim('dismissed a post-login prompt');
    await sleep(500, 1400);
    await btn.click().catch(() => {});
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    await sleep(1200, 2500);
  }
}

/** Read the signed-in account's email out of the page, when it exposes one. */
async function readSignedInEmail(page) {
  try {
    return await page.evaluate(() => {
      const attr = document.querySelector('[data-email]');
      if (attr) return attr.getAttribute('data-email');
      // The account bubble's aria-label carries the address on most surfaces.
      const aria = document.querySelector('a[aria-label*="@"], [aria-label*="@gmail.com"]');
      if (aria) {
        const m = (aria.getAttribute('aria-label') || '').match(/[\w.+-]+@[\w.-]+\.\w+/);
        if (m) return m[0];
      }
      const text = document.body ? document.body.innerText : '';
      const m = text.match(/[\w.+-]+@(gmail\.com|googlemail\.com)/);
      return m ? m[0] : null;
    });
  } catch {
    return null;
  }
}

/**
 * Is this profile signed into Google, and as whom?
 *
 * Navigates to the account page: a signed-in browser stays there, a signed-out
 * one is bounced to the sign-in flow. That redirect is the signal - far more
 * reliable than looking for an avatar, which renders differently across
 * Google's surfaces.
 *
 * Returns { signedIn, email, url, blocked } where `blocked` is 'challenge'
 * when Google is asking for something before it will answer.
 */
export async function detectLoginState(page, { navigate = true, depth = 0 } = {}) {
  if (navigate) {
    try {
      await page.goto(MYACCOUNT_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    } catch (e) {
      return { signedIn: false, email: null, url: page.url(), blocked: null, error: e.message };
    }
    await sleep(1500, 3000);
    await acceptConsent(page);
  }

  const url = page.url();

  // A challenge page is neither signed in nor cleanly signed out.
  if (CHALLENGE_URL_RE.test(url)) {
    return { signedIn: false, email: null, url, blocked: 'challenge' };
  }

  // Only chase a CAPTCHA once - a solve that lands back on another CAPTCHA
  // would otherwise recurse until the wait budget is spent several times over.
  if (depth === 0) {
    const hadCaptcha = await detectAndHandleRecaptcha(page).catch(() => false);
    if (hadCaptcha) {
      await sleep(1500, 2500);
      return detectLoginState(page, { navigate: true, depth: 1 });
    }
  }

  if (SIGNIN_URL_RE.test(url)) {
    return { signedIn: false, email: null, url, blocked: null };
  }

  if (/myaccount\.google\.com/.test(url)) {
    return { signedIn: true, email: await readSignedInEmail(page), url, blocked: null };
  }

  // Anything else (consent domain, an interstitial, a redirect still in
  // flight): give it one settle and re-read rather than guessing.
  await sleep(2000, 3000);
  const settled = page.url();
  if (/myaccount\.google\.com/.test(settled)) {
    return { signedIn: true, email: await readSignedInEmail(page), url: settled, blocked: null };
  }
  return { signedIn: false, email: null, url: settled, blocked: null };
}

/** Sign the current account out, so a different one can be signed in. */
export async function signOut(page) {
  try {
    await page.goto(LOGOUT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2000, 4000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Wait for a human to finish a verification step Google threw up (2FA, "Verify
 * it's you", a device prompt). Polls the signed-in state instead of guessing
 * at the challenge's markup, which changes constantly.
 */
async function waitForManualChallenge(page, account) {
  const waitMinutes = config.captchaWaitMinutes || 4;
  console.log(chalk.red.bold(`\n  ╔══════════════════════════════════════════════════════╗`));
  console.log(chalk.red.bold(`  ║  👆 GOOGLE IS ASKING FOR VERIFICATION                ║`));
  console.log(chalk.red.bold(`  ║  Finish it in the browser window, then wait.         ║`));
  console.log(chalk.red.bold(`  ╚══════════════════════════════════════════════════════╝\n`));
  log.dim(`account: ${account.email} — waiting up to ${waitMinutes} min`);

  const deadline = Date.now() + waitMinutes * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(5000);
    const url = page.url();
    if (!SIGNIN_URL_RE.test(url) && !CHALLENGE_URL_RE.test(url)) {
      const state = await detectLoginState(page, { depth: 1 });
      if (state.signedIn) return true;
    }
  }
  return false;
}

/**
 * Settle a freshly signed-in profile.
 *
 * Signing in and immediately closing the browser leaves Google's session
 * cookies half-written and gives the account a login with no activity behind
 * it. A short, ordinary-looking visit afterwards is what makes the session
 * look like a person who logged in and then used the browser.
 */
async function settleAfterLogin(page) {
  try {
    await page.goto('https://www.google.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await acceptConsent(page);
    await sleep(2000, 4000);
    await humanScroll(page).catch(() => {});
    await mouseJitter(page).catch(() => {});
    await sleep(1500, 3500);
  } catch {
    /* the login itself already succeeded - a failed settle is not fatal */
  }
}

/** Text of the inline error Google puts under the field it rejected. */
async function fieldError(page) {
  return page
    .locator('div[jsname="B34EJ"], div.o6cuMc, div.OyEIQ')
    .first()
    .innerText({ timeout: 1500 })
    .catch(() => '');
}

/**
 * Sign `account` into whatever profile `page` belongs to.
 *
 * Returns { ok, state, message } where state is one of:
 *   already       - the profile was already signed in as this account
 *   logged-in     - signed in during this call
 *   wrong-account - signed in as somebody else and could not be switched
 *   challenge     - Google demanded verification nobody completed in time
 *   rejected      - Google refused the browser ("may not be secure")
 *   bad-password  - credentials rejected
 *   failed        - anything else, with the reason in `message`
 */
export async function loginToGoogle(page, account, { skipIfSignedIn = true } = {}) {
  if (!account || !account.email || !account.password) {
    return { ok: false, state: 'failed', message: 'account has no email/password' };
  }

  // ── Already signed in? ──────────────────────────────────────
  const before = await detectLoginState(page);
  if (before.signedIn) {
    const sameAccount =
      !before.email || before.email.toLowerCase() === account.email.toLowerCase();
    if (sameAccount && skipIfSignedIn) {
      return {
        ok: true,
        state: 'already',
        message: `already signed in${before.email ? ` as ${before.email}` : ''}`,
      };
    }
    // Signed in as somebody else, or the caller asked for a fresh session
    // anyway. Either way the old session has to go first: walking to the
    // sign-in URL while a valid session exists just redirects back to the
    // account page, and the "re-login" would silently do nothing.
    if (sameAccount) log.dim('forcing a fresh sign-in - signing out first');
    else log.warn(`profile is signed in as ${before.email}, signing out first`);
    await signOut(page);
  }

  // ── Sign-in form ────────────────────────────────────────────
  log.step(`signing in ${account.email}`);
  try {
    await page.goto(SIGNIN_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (e) {
    return { ok: false, state: 'failed', message: `sign-in page did not load: ${e.message}` };
  }
  await sleep(1500, 3000);
  await acceptConsent(page);
  await detectAndHandleRecaptcha(page).catch(() => {});

  // Google may show an account chooser instead of an empty form when the
  // profile still remembers the account (very common after a transfer).
  const chooser = await firstVisible(
    page,
    [
      `div[data-identifier="${account.email}"]`,
      `li:has-text("${account.email}")`,
      `div[role="link"]:has-text("${account.email}")`,
    ],
    2500
  );
  if (chooser) {
    log.dim('picked the remembered account from the chooser');
    await sleep(600, 1500);
    await chooser.click().catch(() => {});
    await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
    await sleep(1500, 3000);
  } else {
    const emailInput = await firstVisible(
      page,
      ['input[type="email"]', 'input#identifierId', 'input[name="identifier"]'],
      8000
    );
    if (!emailInput) {
      // No email field and no chooser - either already through, or stuck.
      const state = await detectLoginState(page);
      if (state.signedIn) {
        return { ok: true, state: 'already', message: 'session was still valid' };
      }
      return { ok: false, state: 'failed', message: `no email field on ${page.url()}` };
    }
    await typeLikeAHuman(emailInput, account.email);
    const next = await firstVisible(
      page,
      ['#identifierNext button', '#identifierNext', 'button:has-text("Next")'],
      4000
    );
    if (next) await next.click().catch(() => {});
    else await page.keyboard.press('Enter');
    await sleep(2500, 4500);

    // Unknown-account errors surface here rather than as a missing field.
    const idError = await fieldError(page);
    if (idError && /couldn.?t find|no account/i.test(idError)) {
      return { ok: false, state: 'failed', message: `Google does not know ${account.email}` };
    }
  }

  // ── Password ────────────────────────────────────────────────
  const passInput = await firstVisible(
    page,
    ['input[type="password"]', 'input[name="Passwd"]', 'input[name="password"]'],
    20000
  );
  if (!passInput) {
    if (CHALLENGE_URL_RE.test(page.url())) {
      const done = await waitForManualChallenge(page, account);
      return done
        ? { ok: true, state: 'logged-in', message: 'signed in after manual verification' }
        : { ok: false, state: 'challenge', message: 'Google asked for verification before the password' };
    }
    const state = await detectLoginState(page);
    if (state.signedIn) {
      return { ok: true, state: 'logged-in', message: 'signed in without a password prompt' };
    }
    return { ok: false, state: 'failed', message: `no password field on ${page.url()}` };
  }

  await typeLikeAHuman(passInput, account.password);
  const passNext = await firstVisible(
    page,
    ['#passwordNext button', '#passwordNext', 'button:has-text("Next")'],
    4000
  );
  if (passNext) await passNext.click().catch(() => {});
  else await page.keyboard.press('Enter');

  await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  await sleep(3000, 5000);

  const passError = await fieldError(page);
  if (passError && /wrong password|incorrect/i.test(passError)) {
    return { ok: false, state: 'bad-password', message: `wrong password for ${account.email}` };
  }

  if (/deniedsigninrejected/i.test(page.url())) {
    return {
      ok: false,
      state: 'rejected',
      message: 'Google refused this browser ("this browser or app may not be secure")',
    };
  }

  await detectAndHandleRecaptcha(page).catch(() => {});
  await skipPostLoginInterstitials(page);

  // ── Confirm ─────────────────────────────────────────────────
  let after = await detectLoginState(page);
  if (!after.signedIn && (after.blocked === 'challenge' || CHALLENGE_URL_RE.test(page.url()))) {
    const done = await waitForManualChallenge(page, account);
    if (!done) {
      return { ok: false, state: 'challenge', message: 'verification was not completed in time' };
    }
    await skipPostLoginInterstitials(page);
    after = await detectLoginState(page);
  }

  if (!after.signedIn) {
    return { ok: false, state: 'failed', message: `still signed out after the attempt (${after.url})` };
  }

  if (after.email && after.email.toLowerCase() !== account.email.toLowerCase()) {
    return { ok: false, state: 'wrong-account', message: `ended up signed in as ${after.email}` };
  }

  await settleAfterLogin(page);
  return { ok: true, state: 'logged-in', message: `signed in as ${account.email}` };
}
