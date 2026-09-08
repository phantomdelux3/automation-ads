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

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function loginToGoogle(page, account, profileDir) {
  try {
    const successFile = join(profileDir, 'LOGIN_SUCCESS.txt');
    if (existsSync(successFile)) {
      return;
    }

    console.log(`  → Checking Google login for ${account.email}...`);
    await page.goto('https://accounts.google.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    const emailInput = page.locator('input[type="email"]').first();
    const isVisible = await emailInput.isVisible({ timeout: 5000 }).catch(() => false);
    
    if (!isVisible) {
      console.log(`  ✓ Already logged in or no email input found.`);
      writeFileSync(successFile, 'ready', 'utf8');
      return;
    }
    
    console.log(`  → Logging in to Google account...`);
    await emailInput.fill(account.email);
    await sleep(1000);
    await page.keyboard.press('Enter');
    
    const passInput = page.locator('input[type="password"]').first();
    await passInput.waitFor({ state: 'visible', timeout: 15000 });
    await sleep(1000);
    await passInput.fill(account.password);
    await sleep(1000);
    await page.keyboard.press('Enter');
    
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    console.log(`  ✓ Google login sequence completed.`);
    writeFileSync(successFile, 'ready', 'utf8');
    await sleep(3000);
  } catch (err) {
    console.log(`  ⚠ Google login failed or skipped: ${err.message}`);
    throw err;
  }
}

/**
 * Launch a stealth CloakBrowser instance with:
 * - Persistent context (avoids incognito detection, keeps cookies)
 * - humanize: true (built-in Bézier mouse, per-char typing, realistic scrolls)
 * - humanPreset: 'careful' (slower, more deliberate)
 * - Fixed fingerprint seed per profile (looks like a returning visitor)
 */
export async function launchBrowser(retryCount = 0, specificAccount = null, performLogin = false) {
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
  const identity = profileIdentity(profileDirName);
  const { viewport, timezone, locale } = identity;

  const launchOptions = {
    userDataDir: profileDir,
    headless: config.headless,
    humanize: true,
    humanPreset: 'careful',
    timezone,
    locale,
    viewport,
    args: [
      ...fingerprintArgs(identity),
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
  }

  try {
    // Launch persistent context — cookies and localStorage persist across restarts
    // This bypasses incognito detection and builds browser trust
    const context = await launchPersistentContext(launchOptions, { timeout: 45000 });
    
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
    
    if (account && performLogin) {
      await loginToGoogle(page, account, profileDir);
    }
    
    return { context, page, viewport, timezone, locale, account, proxyString: anonymizedProxyUrl };
  } catch (err) {
    if (config.proxies && config.proxies.length > 0) {
      console.log(`  ⚠ Browser launch or proxy failed, retrying with another proxy (${retryCount + 1}/5)...`);
      return await launchBrowser(retryCount + 1, specificAccount, performLogin);
    } else {
      throw err;
    }
  }
}
