import dotenv from 'dotenv';
dotenv.config();

const config = {
  // Target page containing the ad
  targetUrl: process.env.TARGET_URL || 'https://your-site.com',

  // CSS selector for the ad element to click
  adSelector: process.env.AD_SELECTOR || '.ad-banner',

  // Number of click sessions to run
  clickCount: parseInt(process.env.CLICK_COUNT, 10) || 3,

  // Delay range between sessions (ms)
  minDelay: parseInt(process.env.MIN_DELAY, 10) || 3000,
  maxDelay: parseInt(process.env.MAX_DELAY, 10) || 10000,

  // Scroll delay range (ms)
  minScrollDelay: parseInt(process.env.MIN_SCROLL_DELAY, 10) || 500,
  maxScrollDelay: parseInt(process.env.MAX_SCROLL_DELAY, 10) || 2000,

  // Browser mode
  headless: process.env.HEADLESS === 'true',

  // Search history — browse related sites first to build cookies/profile
  // This influences what ads Google serves
  searchHistory: process.env.SEARCH_HISTORY !== 'false', // enabled by default
  searchHistoryCount: parseInt(process.env.SEARCH_HISTORY_COUNT, 10) || 3, // how many sites to visit

  // Search queries to use for building history (comma-separated in .env)
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

  // Warmup URLs — real sites to visit before the target to build browsing profile
  // These should be in the same niche as your target site
  warmupUrls: process.env.WARMUP_URLS
    ? process.env.WARMUP_URLS.split(',').map((u) => u.trim())
    : [
        'https://www.retailmenot.com/',
        'https://www.coupons.com/',
        'https://www.groupon.com/',
        'https://www.honey.com/',
        'https://www.slickdeals.net/',
        'https://www.dealnews.com/',
        'https://www.brad\'sdeal.com/',
        'https://www.offers.com/',
        'https://www.rakuten.com/',
        'https://www.couponfollow.com/',
      ],

  // Common screen resolutions to randomly pick from
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

  // Referrer URLs — places a "real user" might come from before visiting your site
  referrerUrls: [
    'https://www.google.com/search?q=best+deals+online',
    'https://www.google.com/search?q=coupon+codes',
    'https://www.bing.com/search?q=savings+website',
    'https://www.google.com/search?q=discount+offers',
    'https://duckduckgo.com/?q=best+online+deals',
    'https://www.google.com/search?q=cashback+sites',
  ],

  // Proxy configuration (to be filled in later)
  proxies: process.env.PROXY_LIST
    ? process.env.PROXY_LIST.split(',').map((p) => p.trim())
    : [],
  proxyUser: process.env.PROXY_USER || '',
  proxyPass: process.env.PROXY_PASS || '',
};

export default config;
