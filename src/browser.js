import { launchPersistentContext } from 'cloakbrowser';
import config from '../config.js';
import { join } from 'path';
import { mkdirSync, existsSync, writeFileSync } from 'fs';
import proxyChain from 'proxy-chain';

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
 * Windows desktop GPU profiles — vendor/renderer pairs that match real PCs.
 * One is picked deterministically per profile so the hardware identity is
 * stable across sessions but varies between profiles.
 */
const WINDOWS_GPU_PROFILES = [
  {
    vendor: 'Google Inc. (NVIDIA)',
    renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 (0x00002484) Direct3D11 vs_5_0 ps_5_0, D3D11)',
  },
  {
    vendor: 'Google Inc. (NVIDIA)',
    renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002504) Direct3D11 vs_5_0 ps_5_0, D3D11)',
  },
  {
    vendor: 'Google Inc. (NVIDIA)',
    renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 (0x00002882) Direct3D11 vs_5_0 ps_5_0, D3D11)',
  },
  {
    vendor: 'Google Inc. (NVIDIA)',
    renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 (0x00002786) Direct3D11 vs_5_0 ps_5_0, D3D11)',
  },
  {
    vendor: 'Google Inc. (NVIDIA)',
    renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 (0x00002184) Direct3D11 vs_5_0 ps_5_0, D3D11)',
  },
  {
    vendor: 'Google Inc. (NVIDIA)',
    renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 (0x00001F82) Direct3D11 vs_5_0 ps_5_0, D3D11)',
  },
  {
    vendor: 'Google Inc. (AMD)',
    renderer: 'ANGLE (AMD, AMD Radeon RX 6700 XT (0x000073DF) Direct3D11 vs_5_0 ps_5_0, D3D11)',
  },
  {
    vendor: 'Google Inc. (AMD)',
    renderer: 'ANGLE (AMD, AMD Radeon RX 6600 (0x000073FF) Direct3D11 vs_5_0 ps_5_0, D3D11)',
  },
  {
    vendor: 'Google Inc. (AMD)',
    renderer: 'ANGLE (AMD, AMD Radeon RX 7600 (0x00007480) Direct3D11 vs_5_0 ps_5_0, D3D11)',
  },
  {
    vendor: 'Google Inc. (Intel)',
    renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 (0x00003E92) Direct3D11 vs_5_0 ps_5_0, D3D11)',
  },
  {
    vendor: 'Google Inc. (Intel)',
    renderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x000046A6) Direct3D11 vs_5_0 ps_5_0, D3D11)',
  },
  {
    vendor: 'Google Inc. (Intel)',
    renderer: 'ANGLE (Intel, Intel(R) Arc(TM) A750 Graphics (0x000056A1) Direct3D11 vs_5_0 ps_5_0, D3D11)',
  },
];

/**
 * Deterministic 32-bit string hash (FNV-1a). Used to derive a stable
 * but well-distributed seed/index from a profile name so hardware identity
 * differs between profiles instead of clustering by name length.
 */
function hashProfile(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
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

  // Stable-but-well-distributed fingerprint seed per profile. The seed drives
  // cloakbrowser's auto-generated hardware (hardwareConcurrency, deviceMemory,
  // screen, window). Same profile = same hardware across sessions (good for
  // reCAPTCHA v3); different profiles = different hardware identity.
  const profileHash = hashProfile(profileDirName);
  const fingerprintSeed = (profileHash % 90000) + 10000; // 10000-99999, matches cloakbrowser's own range
  const gpu = WINDOWS_GPU_PROFILES[profileHash % WINDOWS_GPU_PROFILES.length];

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
      // Required to launch Chromium inside Termux/proot (no real sandbox available)
      '--no-sandbox',
      '--disable-setuid-sandbox',
      `--fingerprint=${fingerprintSeed}`,
      `--fingerprint-platform=windows`, // PC only
      `--fingerprint-gpu-vendor=${gpu.vendor}`,
      `--fingerprint-gpu-renderer=${gpu.renderer}`,
      `--fingerprint-screen-width=${viewport.width}`,
      `--fingerprint-screen-height=${viewport.height}`,
      `--proxy-bypass-list=<-loopback>`, // Optimize local browser socket connection speed
      `--disable-quic` // Prevent proxies from hanging on HTTP/3
    ],
  };

  let anonymizedProxyUrl = null;
  let rawProxyUrl = null;

  // Add proxy if configured
  if (config.proxies && config.proxies.length > 0) {
    const proxy = randomFrom(config.proxies);
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
