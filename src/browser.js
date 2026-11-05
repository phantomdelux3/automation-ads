import { launchPersistentContext } from 'cloakbrowser';
import config from '../config.js';
import { join } from 'path';
import { mkdirSync, existsSync, writeFileSync } from 'fs';
import proxyChain from 'proxy-chain';
import {
  profileIdentity,
  profileDirNameFor,
  profileDirFor,
  proxyIndexFor,
  fingerprintArgs,
} from './profile-identity.js';
import { loginToGoogle as signIn } from './google-login.js';
import { trackContext } from './session-registry.js';

/**
 * Pick a random item from an array
 */
function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Random integer between min and max (inclusive)
 */
function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Sign an account in during launch, once per profile.
 *
 * LOGIN_SUCCESS.txt is the "this profile has been through the sign-in flow"
 * marker; it is what stops every session from re-running the login. It is
 * written only after the sign-in is actually confirmed, so a failed or
 * challenged attempt is retried next time instead of being remembered as done.
 *
 * The real work lives in google-login.js, shared with the Accounts tab's
 * re-login button so both take exactly the same path through Google.
 */
async function loginToGoogle(page, account, profileDir) {
  const successFile = join(profileDir, 'LOGIN_SUCCESS.txt');
  if (existsSync(successFile)) return;

  console.log(`  → Checking Google login for ${account.email}...`);
  const result = await signIn(page, account);

  if (result.ok) {
    console.log(`  ✓ ${result.message}`);
    writeFileSync(successFile, 'ready', 'utf8');
    return;
  }

  console.log(`  ⚠ Google login failed for ${account.email}: ${result.message}`);
  throw new Error(result.message);
}

/**
 * Launch a stealth CloakBrowser instance with:
 * - Persistent context (avoids incognito detection, keeps cookies)
 * - humanize: true (built-in Bézier mouse, per-char typing, realistic scrolls)
 * - humanPreset: 'careful' (slower, more deliberate)
 * - Fixed fingerprint seed per profile (looks like a returning visitor)
 */
export async function launchBrowser(
  retryCount = 0,
  specificAccount = null,
  performLogin = false,
  options = {}
) {
  if (retryCount > 5) {
    throw new Error('Failed to launch browser after 5 proxy retries.');
  }

  let account = specificAccount;
  let profileDirName = `profile-${randomInt(1, 5)}`;

  if (!account && config.loginEmail && config.accounts && config.accounts.length > 0) {
    account = randomFrom(config.accounts);
  }

  if (account) {
    profileDirName = profileDirNameFor(account.email);
  }

  // An explicit name wins over the account-derived one. The cookie pool builds
  // profiles before they belong to anybody, so it has a directory name and no
  // account at all; provisioning then opens that same directory WITH an
  // account, and the name must stay the pool's - it seeds the fingerprint.
  if (options.profileDirName) {
    profileDirName = options.profileDirName;
  }

  // Create a persistent profile directory — cookies/localStorage survive across sessions
  // This avoids incognito detection and builds trust with reCAPTCHA.
  // Anchored to the source tree, not process.cwd(), so launching the bot from
  // another working directory can't create a second, empty set of profiles.
  const profileDir = profileDirFor(profileDirName);
  try {
    mkdirSync(profileDir, { recursive: true });
  } catch {
    // Already exists
  }

  // The profile's whole identity — fingerprint seed, GPU, screen, window,
  // timezone, locale — derived from its name, so it is identical in every
  // session and on every machine. A profile whose timezone or screen size
  // changes between visits does not look like a returning user; it looks like
  // a fresh browser wearing an old cookie jar, which is what draws CAPTCHAs.
  let identity = profileIdentity(profileDirName);
  // Optional one-launch screen override (used by "relogin --same-screen").
  // Only the screen/window size changes - seed, GPU, timezone, locale and
  // proxy stay the profile's own. Normal bot runs never pass this, so every
  // profile keeps its own per-profile screen there.
  if (options.screen && options.screen.width && options.screen.height) {
    const { width, height } = options.screen;
    identity = {
      ...identity,
      screen: { width, height },
      viewport: options.viewport || { width, height: height - 110 },
    };
  }
  const { viewport, locale } = identity;
  let timezone = identity.timezone;

  // Timezone must match the proxy's EXIT IP (CloakBrowser's #1 tip). The
  // wrapper's geoip only fills the timezone when we leave it unset - passing
  // the profile's pool timezone (e.g. Los_Angeles) while the residential exit
  // is in Ohio is exactly the mismatch reCAPTCHA scores against. So with a
  // proxy + geoip we leave it to geoip. Locale stays explicit (it follows the
  // proxy country, which is fixed). If geoip keeps failing, the last retries
  // fall back to the profile's stable timezone rather than not launching.
  const hasProxy = Boolean(config.proxies && config.proxies.length > 0);
  const geoTimezone = hasProxy && config.cloakbrowserGeoip && retryCount < 3;

  const needsGoogleLogin = Boolean(
    account && performLogin && !existsSync(join(profileDir, 'LOGIN_SUCCESS.txt'))
  );

  const launchOptions = {
    userDataDir: profileDir,
    headless: options.headless === undefined ? config.headless : options.headless,
    humanize: true,
    humanPreset: 'careful',
    ...(geoTimezone ? {} : { timezone }),
    locale,
    viewport,
    licenseKey: config.cloakbrowserLicenseKey || undefined,
    releaseChannel: config.cloakbrowserReleaseChannel || undefined,
    launchOptions: { timeout: 45000 },
    args: [
      ...fingerprintArgs(identity),
      ...(config.cloakbrowserAllow3pCookies || options.allow3pCookies || needsGoogleLogin
        ? ['--fingerprint-allow-3p-cookies']
        : []),
      ...(config.cloakbrowserTransparentProxy || options.transparentProxy
        ? ['--fingerprint-transparent-proxy']
        : []),
      ...(config.cloakbrowserLicenseThroughProxy || options.licenseThroughProxy
        ? ['--license-through-proxy']
        : []),
      `--proxy-bypass-list=<-loopback>`, // Optimize local browser socket connection speed
      `--disable-quic` // Prevent proxies from hanging on HTTP/3
    ],
  };

  let anonymizedProxyUrl = null;
  let rawProxyUrl = null;

  // Add proxy if configured
  if (config.proxies && config.proxies.length > 0) {
    // Each profile prefers one endpoint, so its exit IP stays in a consistent
    // region instead of hopping the whole pool every session. Retries after a
    // failed launch fall back to a random endpoint.
    const proxy =
      retryCount === 0
        ? config.proxies[proxyIndexFor(profileDirName, config.proxies.length)]
        : randomFrom(config.proxies);
    rawProxyUrl = proxy;

    if (!rawProxyUrl.includes('://')) {
      rawProxyUrl = `http://${proxy}`;
    } else if (rawProxyUrl.startsWith('https://')) {
      rawProxyUrl = rawProxyUrl.replace('https://', 'http://');
    }

    if (config.proxyUser && config.proxyPass) {
      const urlObj = new URL(rawProxyUrl);
      urlObj.username = config.proxyUser;
      urlObj.password = config.proxyPass;
      rawProxyUrl = urlObj.toString();
    }
    
    // Anonymize the proxy so Playwright doesn't have to handle proxy auth
    anonymizedProxyUrl = await proxyChain.anonymizeProxy({ url: rawProxyUrl });
    launchOptions.proxy = { server: anonymizedProxyUrl };
    if (config.cloakbrowserGeoip) {
      launchOptions.geoip = true;
    }
  }

  let context = null;
  try {
    // Launch persistent context — cookies and localStorage persist across restarts
    // This bypasses incognito detection and builds browser trust
    context = await launchPersistentContext(launchOptions);
    trackContext(context);

    // Make sure we close the anonymized proxy when context closes to avoid port leaking
    if (anonymizedProxyUrl) {
      const originalClose = context.close.bind(context);
      context.close = async () => {
        await originalClose();
        await proxyChain.closeAnonymizedProxy(anonymizedProxyUrl, true);
      };
    }
    const page = context.pages()[0] || await context.newPage();
    
    // Store the raw proxy URL so captcha-solver can use it natively
    if (rawProxyUrl) {
      page.rawProxyUrl = rawProxyUrl;
    }

    // Whether a human could actually see this window. The captcha guard uses
    // it to decide if "wait for a manual solve" is a real option or four
    // minutes of waiting for somebody who cannot see anything.
    page.isHeadless = !!launchOptions.headless;

    // Report the timezone the browser actually runs with (geoip-resolved
    // when a proxy is in use), not the profile's fallback.
    if (geoTimezone) {
      timezone = await page
        .evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)
        .catch(() => timezone);
    }

    if (account && performLogin) {
      await loginToGoogle(page, account, profileDir);
    }
    
    return {
      context,
      page,
      viewport,
      timezone,
      locale,
      account,
      profileDirName,
      profileDir,
      proxyString: anonymizedProxyUrl,
    };
  } catch (err) {
    if (context) {
      try { await context.close(); } catch { /* ignore */ }
    } else if (anonymizedProxyUrl) {
      try { await proxyChain.closeAnonymizedProxy(anonymizedProxyUrl, true); } catch { /* ignore */ }
    }

    // Do not retry license errors (invalid/missing key or seat cap reached)
    if (err && (err.name === 'CloakBrowserLicenseError' || /CloakBrowser Pro:.*license/i.test(err.message))) {
      throw err;
    }

    if (config.proxies && config.proxies.length > 0) {
      console.log(`  ⚠ Browser launch or proxy failed, retrying with another proxy (${retryCount + 1}/5)...`);
      return await launchBrowser(retryCount + 1, specificAccount, performLogin, options);
    } else {
      throw err;
    }
  }
}
