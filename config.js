import dotenv from 'dotenv';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const accountsPath = join(__dirname, 'accounts.json');
let accounts = [];
try {
  if (fs.existsSync(accountsPath)) {
    accounts = JSON.parse(fs.readFileSync(accountsPath, 'utf8'));
  }
} catch (e) {
  console.error("Error reading accounts.json:", e);
}

const config = {
  // ── Keywords & Targeting ──────────────────────────────────
  keywords: process.env.KEYWORDS
    ? process.env.KEYWORDS.split(',').map((k) => k.trim())
    : ['best vpn 2026'],

  targetDomains: process.env.TARGET_DOMAINS
    ? process.env.TARGET_DOMAINS.split(',').map((d) => d.trim().toLowerCase())
    : [],

  sessionsPerKeyword: parseInt(process.env.SESSIONS_PER_KEYWORD, 10) || 1,

  // ── Site Browsing (after clicking the ad) ─────────────────
  siteBrowseMin: parseInt(process.env.SITE_BROWSE_MIN, 10) || 15,
  siteBrowseMax: parseInt(process.env.SITE_BROWSE_MAX, 10) || 45,
  internalPagesMin: parseInt(process.env.INTERNAL_PAGES_MIN, 10) || 1,
  internalPagesMax: parseInt(process.env.INTERNAL_PAGES_MAX, 10) || 3,

  // ── Timing (milliseconds) ────────────────────────────────
  minDelay: parseInt(process.env.MIN_DELAY, 10) || 3000,
  maxDelay: parseInt(process.env.MAX_DELAY, 10) || 10000,
  minScrollDelay: parseInt(process.env.MIN_SCROLL_DELAY, 10) || 500,
  maxScrollDelay: parseInt(process.env.MAX_SCROLL_DELAY, 10) || 2000,

  // ── Browser ──────────────────────────────────────────────
  headless: process.env.HEADLESS === 'true',
  loginEmail: process.env.LOGIN_EMAIL !== 'false',
  accounts: accounts,

  // ── Cookie Warmup ────────────────────────────────────────
  // Visit Google properties (YouTube, Google News) before searching
  // to build Google cookies and reduce reCAPTCHA triggers
  //
  // Sponsored Only — set to false to also search organic results for target domains
  sponsoredOnly: process.env.SPONSORED_ONLY !== 'false', // true by default
  cookieWarmup: process.env.COOKIE_WARMUP !== 'false', // enabled by default

  // ── Search History ───────────────────────────────────────
  searchHistory: process.env.SEARCH_HISTORY !== 'false',
  searchHistoryCount: parseInt(process.env.SEARCH_HISTORY_COUNT, 10) || 3,

  searchQueries: process.env.SEARCH_QUERIES
    ? process.env.SEARCH_QUERIES.split(',').map((q) => q.trim())
    : [
        'best coupon codes 2026',
        'online shopping deals today',
        'cashback offers credit card',
        'discount codes free shipping',
        'promo codes electronics',
        'best savings websites',
        'compare prices online',
        'money saving tips shopping',
        'best deal finder apps',
        'online coupons grocery',
      ],

  warmupUrls: process.env.WARMUP_URLS
    ? process.env.WARMUP_URLS.split(',').map((u) => u.trim())
    : [
        'https://www.retailmenot.com/',
        'https://www.coupons.com/',
        'https://www.groupon.com/',
        'https://www.honey.com/',
        'https://www.slickdeals.net/',
        'https://www.dealnews.com/',
        'https://www.offers.com/',
        'https://www.rakuten.com/',
        'https://www.couponfollow.com/',
      ],

  // ── Viewports ────────────────────────────────────────────
  viewports: [
    { width: 1920, height: 1080 },
    { width: 1366, height: 768 },
    { width: 1536, height: 864 },
    { width: 1440, height: 900 },
    { width: 1280, height: 720 },
    { width: 1600, height: 900 },
    { width: 2560, height: 1440 },
    { width: 1280, height: 800 },
  ],

  // ── Proxy (optional) ─────────────────────────────────────
  proxies: process.env.PROXY_LIST
    ? process.env.PROXY_LIST.split(',').map((p) => p.trim())
    : [],
  proxyUser: process.env.PROXY_USER || '',
  proxyPass: process.env.PROXY_PASS || '',
};

export default config;
