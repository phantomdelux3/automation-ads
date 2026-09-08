/**
 * Deterministic per-profile identity.
 *
 * Everything about a profile's hardware/locale identity is derived from its
 * directory name, so it is IDENTICAL on every machine and in every session:
 *
 *   - the bot (src/browser.js)         launches sessions
 *   - scripts/export-profiles.js       reads cookies out
 *   - scripts/import-profiles.js       writes cookies back in on the new PC
 *
 * If these three ever disagreed, an imported profile would present different
 * hardware than the one that earned the cookies - which is exactly what makes
 * Google re-challenge with a CAPTCHA.
 */
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import config from '../config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path to chrome-profiles/, anchored to THIS FILE rather than
 * process.cwd(). Running `node index.js` from another working directory used
 * to silently create a second, empty set of profiles.
 */
export const PROFILES_ROOT = resolve(__dirname, '..', 'chrome-profiles');

/** Turn an account email into its on-disk profile directory name. */
export function profileDirNameFor(email) {
  return String(email).replace(/[^a-z0-9@.-]+/gi, '_');
}

/** Absolute path to one profile's user-data dir. */
export function profileDirFor(profileDirName) {
  return join(PROFILES_ROOT, profileDirName);
}

/**
 * Deterministic 32-bit string hash (FNV-1a). Well distributed, so profile
 * names that look alike still land on different hardware.
 */
export function hashProfile(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/**
 * An independent draw for the same profile. Without the salt every list would
 * be indexed by the same number and the choices would correlate (e.g. every
 * NVIDIA profile also landing on the same timezone).
 */
function draw(profileDirName, salt) {
  return hashProfile(`${profileDirName}::${salt}`);
}

function pick(arr, profileDirName, salt) {
  return arr[draw(profileDirName, salt) % arr.length];
}

/**
 * Windows desktop GPU profiles - vendor/renderer pairs that match real PCs.
 */
export const WINDOWS_GPU_PROFILES = [
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 (0x00002484) Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002504) Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 (0x00002882) Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 (0x00002786) Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 (0x00002184) Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 (0x00001F82) Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 6700 XT (0x000073DF) Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 6600 (0x000073FF) Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 7600 (0x00007480) Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 (0x00003E92) Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x000046A6) Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) Arc(TM) A750 Graphics (0x000056A1) Direct3D11 vs_5_0 ps_5_0, D3D11)' },
];

/**
 * Timezone pools and locale grouped by proxy exit country. A US residential
 * exit reporting Asia/Kolkata is one of the cheapest bot signals there is, so
 * the identity is drawn from the pool matching where the traffic comes out.
 */
const GEO = {
  us: { tz: ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Phoenix'], locale: 'en-US' },
  ca: { tz: ['America/Toronto', 'America/Vancouver', 'America/Edmonton'], locale: 'en-CA' },
  gb: { tz: ['Europe/London'], locale: 'en-GB' },
  uk: { tz: ['Europe/London'], locale: 'en-GB' },
  au: { tz: ['Australia/Sydney', 'Australia/Melbourne', 'Australia/Perth'], locale: 'en-AU' },
  de: { tz: ['Europe/Berlin'], locale: 'de-DE' },
  fr: { tz: ['Europe/Paris'], locale: 'fr-FR' },
  nl: { tz: ['Europe/Amsterdam'], locale: 'nl-NL' },
  in: { tz: ['Asia/Kolkata'], locale: 'en-IN' },
  sg: { tz: ['Asia/Singapore'], locale: 'en-SG' },
  jp: { tz: ['Asia/Tokyo'], locale: 'ja-JP' },
  ae: { tz: ['Asia/Dubai'], locale: 'en-AE' },
};

/**
 * Country of the proxy pool, read from the gateway hostname
 * (us.decodo.com -> us). Override with PROXY_COUNTRY in .env.
 * Falls back to US, which matches the default Decodo pool.
 */
export function proxyCountry() {
  const forced = (process.env.PROXY_COUNTRY || '').trim().toLowerCase();
  if (forced && GEO[forced]) return forced;

  const first = (config.proxies && config.proxies[0]) || '';
  const host = first.replace(/^[a-z]+:\/\//i, '').split(/[:/@]/)[0] || '';
  const label = host.split('.')[0].toLowerCase();
  if (GEO[label]) return label;

  return 'us';
}

/**
 * The complete, stable identity for one profile.
 *
 * Same profile name -> same seed, same GPU, same timezone, same locale, same
 * screen, same proxy endpoint. Forever, on any machine.
 */
export function profileIdentity(profileDirName) {
  const geo = GEO[proxyCountry()] || GEO.us;
  const base = pick(config.viewports, profileDirName, 'viewport');

  // Deterministic window size. Always SMALLER than the screen - a real window
  // never exceeds the display, and the height loses room to the tab strip,
  // omnibox and bookmarks bar. Stable across sessions, unlike the old random
  // jitter which redrew the window on every launch.
  const insetW = draw(profileDirName, 'inset-w') % 41; // 0-40px
  const insetH = 88 + (draw(profileDirName, 'inset-h') % 45); // 88-132px of browser UI
  const hash = hashProfile(profileDirName);

  return {
    profileDirName,
    hash,
    // 10000-99999, matching cloakbrowser's own seed range
    seed: (hash % 90000) + 10000,
    gpu: pick(WINDOWS_GPU_PROFILES, profileDirName, 'gpu'),
    timezone: pick(geo.tz, profileDirName, 'timezone'),
    locale: geo.locale,
    screen: { width: base.width, height: base.height },
    viewport: { width: base.width - insetW, height: base.height - insetH },
    country: proxyCountry(),
  };
}

/**
 * Which proxy endpoint this profile should prefer. Keeping a profile on one
 * endpoint keeps its exit IP in a consistent region instead of hopping across
 * the whole pool every session.
 */
export function proxyIndexFor(profileDirName, proxyCount) {
  if (!proxyCount) return -1;
  return draw(profileDirName, 'proxy') % proxyCount;
}

/**
 * Chromium fingerprint flags derived from an identity. Shared so the bot and
 * the import script build byte-identical fingerprints.
 */
export function fingerprintArgs(identity) {
  return [
    `--fingerprint=${identity.seed}`,
    `--fingerprint-platform=windows`,
    `--fingerprint-gpu-vendor=${identity.gpu.vendor}`,
    `--fingerprint-gpu-renderer=${identity.gpu.renderer}`,
    `--fingerprint-screen-width=${identity.screen.width}`,
    `--fingerprint-screen-height=${identity.screen.height}`,
  ];
}
