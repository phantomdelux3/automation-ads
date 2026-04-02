import { launchPersistentContext } from 'cloakbrowser';
import config from '../config.js';
import { join } from 'path';
import { mkdirSync, existsSync, writeFileSync } from 'fs';

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
 * Common timezone strings weighted toward popular ones
 */
const TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'Asia/Tokyo',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Australia/Sydney',
];

const LOCALES = ['en-US', 'en-GB', 'en-AU', 'en-CA', 'en-IN'];

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

  const viewport = randomFrom(config.viewports);
  const timezone = randomFrom(TIMEZONES);
  const locale = randomFrom(LOCALES);

  let account = specificAccount;
  let profileDirName = `profile-${randomInt(1, 5)}`;
  
  if (!account && config.loginEmail && config.accounts && config.accounts.length > 0) {
    account = randomFrom(config.accounts);
  }

  if (account) {
    profileDirName = account.email.replace(/[^a-z0-9@.-]+/gi, '_');
  }

  // Create a persistent profile directory — cookies/localStorage survive across sessions
  // This avoids incognito detection and builds trust with reCAPTCHA
  const profileDir = join(process.cwd(), 'chrome-profiles', profileDirName);
  try {
    mkdirSync(profileDir, { recursive: true });
  } catch {
    // Already exists
  }

  // Use a stable fingerprint seed per profile so revisiting the same site
  // looks like a returning visitor (better reCAPTCHA v3 scores)
  const fingerprintSeed = profileDir.length * 31337;

  const launchOptions = {
    userDataDir: profileDir,
    headless: config.headless,
    humanize: true,
    humanPreset: 'careful',
    timezone,
    locale,
    viewport: {
      width: viewport.width + randomInt(-20, 20),
      height: viewport.height + randomInt(-20, 20),
    },
    args: [
      `--fingerprint=${fingerprintSeed}`,
      `--fingerprint-screen-width=${viewport.width}`,
      `--fingerprint-screen-height=${viewport.height}`,
      `--proxy-bypass-list=<-loopback>`, // Optimize local browser socket connection speed
    ],
  };

  // Add proxy if configured
  if (config.proxies && config.proxies.length > 0) {
    const proxy = randomFrom(config.proxies);
    let proxyUrl = proxy;
    
    if (!proxyUrl.includes('://')) {
      proxyUrl = `http://${proxy}`;
    }

    launchOptions.proxy = { server: proxyUrl };

    if (config.proxyUser && config.proxyPass) {
      launchOptions.proxy.username = config.proxyUser;
      launchOptions.proxy.password = config.proxyPass;
    }
  }

  try {
    // Launch persistent context — cookies and localStorage persist across restarts
    // This bypasses incognito detection and builds browser trust
    const context = await launchPersistentContext(launchOptions, { timeout: 45000 });
    const page = context.pages()[0] || await context.newPage();
    
    if (account && performLogin) {
      await loginToGoogle(page, account, profileDir);
    }
    
    return { context, page, viewport, timezone, locale, account };
  } catch (err) {
    if (config.proxies && config.proxies.length > 0) {
      console.log(`  ⚠ Browser launch or proxy failed, retrying with another proxy (${retryCount + 1}/5)...`);
      return await launchBrowser(retryCount + 1, specificAccount, performLogin);
    } else {
      throw err;
    }
  }
}
