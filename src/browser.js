import { launchPersistentContext } from 'cloakbrowser';
import config from '../config.js';
import { join } from 'path';
import { mkdirSync } from 'fs';

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
export async function launchBrowser() {
  const viewport = randomFrom(config.viewports);
  const timezone = randomFrom(TIMEZONES);
  const locale = randomFrom(LOCALES);

  // Create a persistent profile directory — cookies/localStorage survive across sessions
  // This avoids incognito detection and builds trust with reCAPTCHA
  const profileDir = join(process.cwd(), 'chrome-profiles', `profile-${randomInt(1, 5)}`);
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

  // Launch persistent context — cookies and localStorage persist across restarts
  // This bypasses incognito detection and builds browser trust
  const context = await launchPersistentContext(launchOptions);

  const page = context.pages()[0] || await context.newPage();

  return { context, page, viewport, timezone, locale };
}
