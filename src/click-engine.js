import { launchBrowser } from './browser.js';
import {
  humanClick,
  humanScroll,
  simulateReading,
  mouseJitter,
  randomIdle,
  sleep,
  gaussianDelay,
} from './human-behavior.js';
import config from '../config.js';
import chalk from 'chalk';

// ─── Helpers ────────────────────────────────────────────────

function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ─── Google Cookie Warmup ───────────────────────────────────

/**
 * Visit Google properties to build cookie trust before searching.
 * This significantly reduces reCAPTCHA triggers because Google
 * already has established cookies (NID, SID, etc.) for this browser.
 */
async function warmupGoogleCookies(page) {
  if (!config.cookieWarmup) {
    console.log(chalk.dim(`  → Cookie warmup: SKIPPED (disabled)`));
    return;
  }

  console.log(chalk.blue(`  🍪 Warming up Google cookies...\n`));

  const warmupSites = [
    { url: 'https://www.google.com', name: 'Google' },
    { url: 'https://www.youtube.com', name: 'YouTube' },
    { url: 'https://news.google.com', name: 'Google News' },
  ];

  // Shuffle and visit 1-2 Google properties
  const shuffled = [...warmupSites].sort(() => Math.random() - 0.5);
  const toVisit = shuffled.slice(0, randomInt(1, 2));

  for (const site of toVisit) {
    try {
      console.log(chalk.dim(`    → Visiting ${site.name}...`));
      await page.goto(site.url, {
        waitUntil: 'domcontentloaded',
        timeout: 20000,
      });

      // Accept Google cookie consent if it appears
      await acceptGoogleConsent(page);

      // Simulate natural browsing
      await sleep(2000, 4000);
      await humanScroll(page);
      await mouseJitter(page);
      await sleep(1000, 3000);

      console.log(chalk.dim(`    ✓ Browsed ${site.name}`));
    } catch (err) {
      console.log(chalk.dim(`    → ${site.name} didn't load fully, continuing...`));
    }

    await sleep(1000, 2000);
  }

  console.log(chalk.green(`  ✓ Google cookies warmed up\n`));
}

/**
 * Accept Google's cookie consent dialog if it appears.
 * This prevents it from blocking the search page later.
 */
async function acceptGoogleConsent(page) {
  try {
    // Wait briefly for consent dialog
    const consentBtn = await page.locator(
      'button:has-text("Accept all"), button:has-text("Accept All"), button:has-text("I agree"), button[id="L2AGLb"], button[aria-label="Accept all"]'
    ).first();

    const visible = await consentBtn.isVisible({ timeout: 3000 }).catch(() => false);
    if (visible) {
      await sleep(500, 1000);
      await consentBtn.click();
      console.log(chalk.dim(`    → Accepted Google cookie consent`));
      await sleep(1000, 2000);
    }
  } catch {
    // No consent dialog — that's fine
  }
}

// ─── Build Search History ───────────────────────────────────

/**
 * Browse related sites + perform DuckDuckGo searches to build
 * a browsing profile that influences Google's ad targeting.
 */
async function buildSearchHistory(page) {
  if (!config.searchHistory) {
    console.log(chalk.dim(`  → Search history: SKIPPED (disabled)`));
    return;
  }

  const historyCount = config.searchHistoryCount;
  console.log(chalk.blue(`  🔍 Building search history (${historyCount} sites)...\n`));

  // Visit warmup URLs
  const shuffledUrls = [...config.warmupUrls].sort(() => Math.random() - 0.5);
  const urlsToVisit = shuffledUrls.slice(0, Math.ceil(historyCount / 2));

  for (let i = 0; i < urlsToVisit.length; i++) {
    const url = urlsToVisit[i];
    console.log(chalk.dim(`    [${i + 1}/${urlsToVisit.length}] Visiting: ${url}`));

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await sleep(2000, 4000);
      await humanScroll(page);
      await sleep(1000, 2000);
      await mouseJitter(page);
      await sleep(500, 1500);
      console.log(chalk.dim(`    ✓ Browsed ${new URL(url).hostname}`));
    } catch {
      console.log(chalk.dim(`    → Didn't load fully, continuing...`));
    }

    await sleep(1000, 3000);
  }

  // DuckDuckGo searches (CAPTCHA-free)
  const shuffledQueries = [...config.searchQueries].sort(() => Math.random() - 0.5);
  const queriesToSearch = shuffledQueries.slice(0, Math.floor(historyCount / 2) + 1);

  for (let i = 0; i < queriesToSearch.length; i++) {
    const query = queriesToSearch[i];
    console.log(chalk.dim(`    [search ${i + 1}/${queriesToSearch.length}] "${query}"`));

    try {
      await page.goto(`https://duckduckgo.com/?q=${encodeURIComponent(query)}`, {
        waitUntil: 'domcontentloaded',
        timeout: 15000,
      });

      await sleep(2000, 3000);
      await humanScroll(page);
      await sleep(1000, 2000);
      console.log(chalk.dim(`    ✓ Searched "${query}"`));
    } catch {
      console.log(chalk.dim(`    → Search didn't load fully, continuing...`));
    }

    await sleep(1000, 2000);
  }

  console.log(chalk.green(`\n  ✓ Search history built\n`));
}

// ─── reCAPTCHA Detection ────────────────────────────────────

/**
 * Detect reCAPTCHA / "unusual traffic" page from Google.
 * If detected, print a loud message and wait for user to solve it.
 */
async function detectAndHandleRecaptcha(page) {
  const isRecaptcha = await page.evaluate(() => {
    const bodyText = document.body?.innerText || '';
    const hasRecaptchaFrame = !!document.querySelector(
      'iframe[src*="recaptcha"], iframe[src*="captcha"], #recaptcha, .g-recaptcha'
    );
    const hasUnusualTraffic =
      bodyText.includes('unusual traffic') ||
      bodyText.includes('not a robot') ||
      bodyText.includes('automated queries') ||
      bodyText.includes('captcha');
    return hasRecaptchaFrame || hasUnusualTraffic;
  });

  if (!isRecaptcha) return false;

  console.log(chalk.red.bold(`\n  ╔══════════════════════════════════════════════╗`));
  console.log(chalk.red.bold(`  ║  🛑  reCAPTCHA DETECTED — SOLVE IT NOW!     ║`));
  console.log(chalk.red.bold(`  ║  The browser window is waiting for you.      ║`));
  console.log(chalk.red.bold(`  ║  Solve the CAPTCHA manually, then wait...    ║`));
  console.log(chalk.red.bold(`  ╚══════════════════════════════════════════════╝\n`));

  // Poll every 5 seconds until reCAPTCHA is gone
  let attempts = 0;
  const maxAttempts = 60; // 5 minutes max

  while (attempts < maxAttempts) {
    await sleep(5000);
    attempts++;

    const stillCaptcha = await page.evaluate(() => {
      const bodyText = document.body?.innerText || '';
      const hasRecaptchaFrame = !!document.querySelector(
        'iframe[src*="recaptcha"], iframe[src*="captcha"], #recaptcha, .g-recaptcha'
      );
      const hasUnusualTraffic =
        bodyText.includes('unusual traffic') ||
        bodyText.includes('not a robot') ||
        bodyText.includes('automated queries');
      return hasRecaptchaFrame || hasUnusualTraffic;
    });

    if (!stillCaptcha) {
      console.log(chalk.green(`  ✓ reCAPTCHA solved! Continuing...\n`));
      await sleep(2000, 3000);
      return true; // was captcha, now solved
    }

    if (attempts % 6 === 0) {
      console.log(chalk.yellow(`  ⏳ Still waiting for CAPTCHA to be solved... (${attempts * 5}s)`));
    }
  }

  console.log(chalk.red(`  ✗ Timed out waiting for CAPTCHA solve (5 min)`));
  return false;
}

// ─── Google Search ──────────────────────────────────────────

/**
 * Navigate to Google and search for a keyword naturally.
 * Types the keyword character-by-character with human delays.
 */
async function searchGoogle(page, keyword) {
  console.log(chalk.blue(`  🔎 Searching Google for: "${keyword}"\n`));

  // Navigate to Google
  await page.goto('https://www.google.com', {
    waitUntil: 'domcontentloaded',
    timeout: 20000,
  });

  // Accept consent if it shows again
  await acceptGoogleConsent(page);

  // Check for reCAPTCHA on Google homepage (rare but possible)
  const captchaOnHome = await detectAndHandleRecaptcha(page);
  if (captchaOnHome === false && captchaOnHome !== true) {
    // false here means timeout — can't continue
  }

  // Brief pause on Google homepage — look natural
  await sleep(1500, 3000);
  await mouseJitter(page);

  // Find the search box
  const searchBox = page.locator('textarea[name="q"], input[name="q"]').first();
  await searchBox.click();
  await sleep(500, 1000);

  // Type the keyword character by character with natural delays
  console.log(chalk.dim(`  → Typing keyword naturally...`));
  for (let i = 0; i < keyword.length; i++) {
    await page.keyboard.type(keyword[i], { delay: randomInt(50, 180) });

    // Occasional thinking pause mid-word (10% chance)
    if (Math.random() < 0.10 && i > 0 && i < keyword.length - 1) {
      await sleep(300, 800);
    }
  }

  // Small pause after typing — like a user reviewing their query
  await sleep(800, 2000);

  // Dismiss autocomplete suggestions by pressing Escape then Enter
  // This prevents clicking on a suggestion instead of searching
  await page.keyboard.press('Escape');
  await sleep(200, 500);
  await page.keyboard.press('Enter');

  console.log(chalk.dim(`  → Waiting for search results...`));

  // Wait for results to load
  try {
    await page.waitForSelector('#search, #rso', { timeout: 15000 });
  } catch {
    console.log(chalk.yellow(`  ⚠ Search results didn't load normally`));
  }

  await sleep(2000, 4000);

  // Check for reCAPTCHA on search results
  await detectAndHandleRecaptcha(page);

  console.log(chalk.dim(`  ✓ Search results loaded`));
}

// ─── Find Sponsored Ads ─────────────────────────────────────

/**
 * Scan Google search results for sponsored ads matching target domains.
 * Returns the first matching ad element info, or null if none found.
 *
 * Google marks sponsored results with:
 * - "Sponsored" label text
 * - data-text-ad attribute
 * - ads within #tads (top ads) or #tadsb (bottom ads) containers
 */
async function findSponsoredAd(page, targetDomains) {
  console.log(chalk.dim(`  → Scanning for sponsored ads matching: ${targetDomains.join(', ')}`));

  // Small natural scroll first — a real user would glance at results
  await humanScroll(page);
  await sleep(1000, 2000);

  const matchedAd = await page.evaluate((domains) => {
    const results = [];

    // ── Strategy 1: Top ads container (#tads) ──
    const topAdsContainer = document.querySelector('#tads');
    if (topAdsContainer) {
      const adBlocks = topAdsContainer.querySelectorAll('.uEierd, [data-text-ad], .CnP9N');
      adBlocks.forEach((block) => {
        const linkEl = block.querySelector('a[data-rw]') || block.querySelector('a[ping]') || block.querySelector('a');
        if (linkEl) {
          const href = linkEl.href || '';
          const displayUrl = block.querySelector('.V6f4Id, .qzEoUe, cite')?.innerText || '';
          results.push({ href, displayUrl, top: block.getBoundingClientRect().top });
        }
      });
    }

    // ── Strategy 2: Bottom ads container (#tadsb) ──
    const bottomAdsContainer = document.querySelector('#tadsb');
    if (bottomAdsContainer) {
      const adBlocks = bottomAdsContainer.querySelectorAll('.uEierd, [data-text-ad], .CnP9N');
      adBlocks.forEach((block) => {
        const linkEl = block.querySelector('a[data-rw]') || block.querySelector('a[ping]') || block.querySelector('a');
        if (linkEl) {
          const href = linkEl.href || '';
          const displayUrl = block.querySelector('.V6f4Id, .qzEoUe, cite')?.innerText || '';
          results.push({ href, displayUrl, top: block.getBoundingClientRect().top });
        }
      });
    }

    // ── Strategy 3: Find elements with "Sponsored" text via DOM traversal ──
    // NOTE: :has-text() is NOT a valid DOM CSS selector — we iterate manually
    document.querySelectorAll('[data-dtld]').forEach((el) => {
      const linkEl = el.querySelector('a') || el.closest('a');
      if (linkEl && linkEl.href && !results.some(r => r.href === linkEl.href)) {
        const parent = el.closest('[data-text-ad]') || el.closest('.uEierd') || el.closest('.CnP9N') || el.parentElement;
        const displayUrl = parent?.querySelector('cite, .qzEoUe, .V6f4Id')?.innerText || '';
        results.push({ href: linkEl.href, displayUrl, top: el.getBoundingClientRect().top });
      }
    });

    // Find spans that actually contain "Sponsored" text
    document.querySelectorAll('span').forEach((span) => {
      if (span.textContent?.trim() === 'Sponsored' || span.textContent?.trim() === 'Ad') {
        // Walk up to find the parent ad container
        const container = span.closest('[data-text-ad]') || span.closest('.uEierd') || span.closest('.CnP9N')
          || span.closest('#tads') || span.closest('#tadsb');
        if (container) {
          const linkEl = container.querySelector('a[data-rw]') || container.querySelector('a[ping]') || container.querySelector('a');
          if (linkEl && linkEl.href && !results.some(r => r.href === linkEl.href)) {
            const displayUrl = container.querySelector('cite, .qzEoUe, .V6f4Id')?.innerText || '';
            results.push({ href: linkEl.href, displayUrl, top: container.getBoundingClientRect().top });
          }
        }
      }
    });

    // Broader: find ad-related links
    document.querySelectorAll('.commercial-unit-desktop-top a, .pla-unit a, [data-rw]').forEach((el) => {
      const href = el.href || '';
      if (href && !results.some(r => r.href === href)) {
        const parent = el.closest('[data-text-ad]') || el.closest('.uEierd') || el.closest('.CnP9N') || el.parentElement;
        const displayUrl = parent?.querySelector('cite, .qzEoUe, .V6f4Id')?.innerText || '';
        results.push({ href, displayUrl, top: el.getBoundingClientRect().top });
      }
    });

    // Now match against target domains
    for (const ad of results) {
      const combined = (ad.href + ' ' + ad.displayUrl).toLowerCase();
      for (const domain of domains) {
        if (combined.includes(domain.toLowerCase())) {
          return {
            href: ad.href,
            displayUrl: ad.displayUrl,
            domain: domain,
            top: ad.top,
            matched: true,
            type: 'sponsored',
          };
        }
      }
    }

    return { matched: false, totalAds: results.length, sampleUrls: results.slice(0, 5).map(r => r.href) };
  }, targetDomains);

  if (matchedAd.matched) {
    console.log(chalk.green(`  ✓ Found sponsored ad for "${matchedAd.domain}": ${matchedAd.displayUrl || matchedAd.href}`));
    return matchedAd;
  }

  console.log(chalk.yellow(`  ⚠ No matching sponsored ads found (${matchedAd.totalAds} total ads on page)`));
  if (matchedAd.sampleUrls?.length > 0) {
    console.log(chalk.dim(`    Found ads pointing to:`));
    matchedAd.sampleUrls.forEach((url) => {
      console.log(chalk.dim(`      → ${url.substring(0, 80)}`));
    });
  }

  return null;
}

// ─── Find Organic Result ────────────────────────────────────

/**
 * When SPONSORED_ONLY=false, search ALL results on the first page
 * (organic + sponsored) for target domains.
 */
async function findOrganicResult(page, targetDomains) {
  console.log(chalk.dim(`  → Scanning ALL results (organic + sponsored) for: ${targetDomains.join(', ')}`));

  await humanScroll(page);
  await sleep(1000, 2000);

  const matchedResult = await page.evaluate((domains) => {
    const results = [];

    // Get ALL links in the search results area
    const searchContainer = document.querySelector('#search, #rso, #main');
    if (!searchContainer) return { matched: false, totalResults: 0 };

    // Organic results
    searchContainer.querySelectorAll('a[href]').forEach((link) => {
      try {
        const url = new URL(link.href);
        // Skip Google's own links, empty links, and internal anchors
        if (
          url.hostname.includes('google.com') ||
          url.hostname.includes('googleapis.com') ||
          url.href.includes('webcache') ||
          url.href.includes('translate.google') ||
          link.href.startsWith('javascript:') ||
          !link.offsetWidth ||
          !link.offsetHeight
        ) return;

        const displayUrl = link.closest('[data-sokoban-container]')?.querySelector('cite')?.innerText
          || link.closest('.g')?.querySelector('cite')?.innerText
          || '';

        if (!results.some(r => r.href === link.href)) {
          results.push({
            href: link.href,
            displayUrl,
            hostname: url.hostname,
            top: link.getBoundingClientRect().top,
            text: link.innerText?.trim().substring(0, 80) || '',
          });
        }
      } catch {}
    });

    // Match against target domains
    for (const result of results) {
      const combined = (result.href + ' ' + result.displayUrl + ' ' + result.hostname).toLowerCase();
      for (const domain of domains) {
        if (combined.includes(domain.toLowerCase())) {
          return {
            href: result.href,
            displayUrl: result.displayUrl,
            domain: domain,
            top: result.top,
            matched: true,
            type: 'organic',
            text: result.text,
          };
        }
      }
    }

    return {
      matched: false,
      totalResults: results.length,
      sampleUrls: results.slice(0, 8).map(r => `${r.hostname} — ${r.text.substring(0, 40)}`),
    };
  }, targetDomains);

  if (matchedResult.matched) {
    console.log(chalk.green(`  ✓ Found organic result for "${matchedResult.domain}": ${matchedResult.displayUrl || matchedResult.href}`));
    return matchedResult;
  }

  console.log(chalk.yellow(`  ⚠ No matching results found on page (${matchedResult.totalResults} total results)`));
  if (matchedResult.sampleUrls?.length > 0) {
    console.log(chalk.dim(`    Results on page:`));
    matchedResult.sampleUrls.forEach((s) => {
      console.log(chalk.dim(`      → ${s}`));
    });
  }

  return null;
}

// ─── Click Sponsored Ad ─────────────────────────────────────

/**
 * Click on the matched sponsored ad naturally.
 * Scrolls it into view, hovers, then clicks with human-like timing.
 */
async function clickSponsoredAd(page, adInfo) {
  console.log(chalk.dim(`  → Scrolling to sponsored ad...`));

  // Scroll the ad into view if needed
  const clicked = await page.evaluate(async (targetHref) => {
    // Find the actual clickable link
    const allLinks = document.querySelectorAll('#tads a, #tadsb a, [data-text-ad] a, [data-rw]');
    for (const link of allLinks) {
      if (link.href && link.href === targetHref) {
        link.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return {
          found: true,
          rect: {
            x: link.getBoundingClientRect().left + link.getBoundingClientRect().width / 2,
            y: link.getBoundingClientRect().top + link.getBoundingClientRect().height / 2,
            width: link.getBoundingClientRect().width,
            height: link.getBoundingClientRect().height,
          },
        };
      }
    }

    // Fallback: match by domain in href
    const domain = new URL(targetHref).hostname;
    for (const link of allLinks) {
      try {
        if (link.href && new URL(link.href).hostname.includes(domain)) {
          link.scrollIntoView({ behavior: 'smooth', block: 'center' });
          return {
            found: true,
            rect: {
              x: link.getBoundingClientRect().left + link.getBoundingClientRect().width / 2,
              y: link.getBoundingClientRect().top + link.getBoundingClientRect().height / 2,
              width: link.getBoundingClientRect().width,
              height: link.getBoundingClientRect().height,
            },
          };
        }
      } catch {}
    }

    return { found: false };
  }, adInfo.href);

  if (!clicked.found) {
    // Last resort: try clicking by domain match directly
    console.log(chalk.dim(`  → Trying to find ad link by domain...`));

    const domainClicked = await page.evaluate((domain) => {
      const allLinks = document.querySelectorAll('a');
      for (const link of allLinks) {
        try {
          if (link.href && link.href.toLowerCase().includes(domain)) {
            const parent = link.closest('[data-text-ad]') || link.closest('.uEierd') || link.closest('#tads') || link.closest('#tadsb');
            if (parent) {
              link.scrollIntoView({ behavior: 'smooth', block: 'center' });
              return {
                found: true,
                rect: {
                  x: link.getBoundingClientRect().left + link.getBoundingClientRect().width / 2,
                  y: link.getBoundingClientRect().top + link.getBoundingClientRect().height / 2,
                  width: link.getBoundingClientRect().width,
                  height: link.getBoundingClientRect().height,
                },
              };
            }
          }
        } catch {}
      }
      return { found: false };
    }, adInfo.domain);

    if (!domainClicked.found) {
      console.log(chalk.yellow(`  ⚠ Could not locate the ad link to click`));
      return false;
    }

    Object.assign(clicked, domainClicked);
  }

  await sleep(1000, 2000);

  // Re-measure position after scroll animation completes
  const rect = clicked.rect;

  // Random offset within the link (not dead center — humans never click dead center)
  const offsetX = (Math.random() - 0.5) * rect.width * 0.3;
  const offsetY = (Math.random() - 0.5) * rect.height * 0.3;
  const clickX = Math.round(rect.x + offsetX);
  const clickY = Math.round(rect.y + offsetY);

  // Human-like mouse approach
  console.log(chalk.dim(`  → Moving to ad...`));
  await page.mouse.move(clickX - randomInt(60, 120), clickY - randomInt(20, 50));
  await sleep(200, 500);
  await page.mouse.move(clickX + randomInt(-5, 5), clickY + randomInt(-3, 3));
  await sleep(150, 400);

  // Click!
  await page.mouse.click(clickX, clickY);
  console.log(chalk.green(`  ✓ Sponsored ad clicked!`));

  return true;
}

// ─── Natural Site Browsing ──────────────────────────────────

/**
 * Browse the target site naturally after clicking the ad.
 * - Scrolls through the landing page
 * - Simulates reading
 * - Clicks 1-3 internal links
 * - Spends realistic time on each page
 * 
 * Goal: make the visit look like a real user in Google Analytics
 */
async function browseTargetSite(page, context) {
  console.log(chalk.blue(`  🌐 Browsing target site naturally...\n`));

  // Wait for the landing page to load
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 });
  } catch {
    // Timeout is fine — page might be slow
  }

  const pages = context.pages();
  const activePage = pages[pages.length - 1];
  const currentUrl = activePage.url();
  let currentHostname;

  try {
    currentHostname = new URL(currentUrl).hostname;
  } catch {
    currentHostname = '';
  }

  console.log(chalk.dim(`  → Landing page: ${currentUrl.substring(0, 80)}`));

  // Phase 1: Browse the landing page
  const browseTime = randomInt(config.siteBrowseMin, config.siteBrowseMax) * 1000;
  console.log(chalk.dim(`  → Will browse for ~${(browseTime / 1000).toFixed(0)}s total`));

  await simulateReading(activePage);
  await mouseJitter(activePage);
  await humanScroll(activePage);
  await sleep(3000, 6000);

  // Phase 2: Click internal links
  const internalPages = randomInt(config.internalPagesMin, config.internalPagesMax);
  console.log(chalk.dim(`  → Will visit ${internalPages} internal page(s)`));

  for (let i = 0; i < internalPages; i++) {
    try {
      // Find internal links on the current page
      const internalLinks = await activePage.evaluate((hostname) => {
        const links = Array.from(document.querySelectorAll('a[href]'));
        const internal = [];

        for (const link of links) {
          try {
            const url = new URL(link.href);
            // Same domain, not anchor, not javascript, not blank
            if (
              url.hostname === hostname &&
              url.pathname !== window.location.pathname &&
              !url.href.includes('#') &&
              !url.href.startsWith('javascript:') &&
              !url.href.includes('login') &&
              !url.href.includes('signup') &&
              !url.href.includes('cart') &&
              !url.href.includes('account') &&
              link.offsetWidth > 0 &&
              link.offsetHeight > 0
            ) {
              const rect = link.getBoundingClientRect();
              if (rect.top > 0 && rect.top < window.innerHeight * 3) {
                internal.push({
                  href: url.href,
                  text: link.innerText?.trim().substring(0, 50) || '',
                  top: rect.top,
                });
              }
            }
          } catch {}
        }

        // Deduplicate by href
        const unique = [];
        const seen = new Set();
        for (const link of internal) {
          if (!seen.has(link.href)) {
            seen.add(link.href);
            unique.push(link);
          }
        }

        return unique.slice(0, 10); // Return max 10 candidates
      }, currentHostname);

      if (internalLinks.length === 0) {
        console.log(chalk.dim(`    → No more internal links found`));
        break;
      }

      // Pick a random internal link
      const link = randomFrom(internalLinks);
      console.log(chalk.dim(`    [${i + 1}/${internalPages}] Clicking: "${link.text || link.href.substring(0, 50)}"`));

      // Scroll to the link area first
      await activePage.evaluate((top) => {
        window.scrollTo({
          top: window.scrollY + top - window.innerHeight / 2,
          behavior: 'smooth',
        });
      }, link.top);

      await sleep(800, 1500);

      // Navigate to the internal page
      await activePage.goto(link.href, {
        waitUntil: 'domcontentloaded',
        timeout: 15000,
      });

      // Browse the internal page naturally
      await sleep(2000, 4000);
      await simulateReading(activePage);
      await mouseJitter(activePage);
      await humanScroll(activePage);

      // Spend time on the page
      const pageTime = randomInt(5, 15) * 1000;
      await sleep(pageTime);

      console.log(chalk.dim(`    ✓ Browsed internal page for ${(pageTime / 1000).toFixed(0)}s`));
    } catch (err) {
      console.log(chalk.dim(`    → Internal link navigation failed: ${err.message?.substring(0, 50)}`));
    }

    await sleep(1000, 3000);
  }

  // Phase 3: Final dwell time
  const remainingTime = Math.max(3000, browseTime - (Date.now() % browseTime));
  const finalDwell = Math.min(remainingTime, randomInt(5000, 15000));
  console.log(chalk.dim(`  → Final dwell: ${(finalDwell / 1000).toFixed(0)}s`));

  await simulateReading(activePage);
  await mouseJitter(activePage);
  await sleep(finalDwell);

  console.log(chalk.green(`  ✓ Site browsing complete\n`));
}

// ─── Main Session Runner ────────────────────────────────────

/**
 * Run a single session:
 * 1. Launch browser
 * 2. Warm up Google cookies (if enabled)
 * 3. Build search history (if enabled)
 * 4. Search keyword on Google
 * 5. Find matching sponsored ad
 * 6. Click it
 * 7. Browse the landing page naturally
 */
export async function runSession(sessionNumber, keyword) {
  console.log(chalk.cyan(`\n━━━ Session ${sessionNumber} ━━━━━━━━━━━━━━━━━━━━━━`));
  console.log(chalk.cyan(`  Keyword: "${keyword}"`));

  let context;

  try {
    // 1. Launch CloakBrowser
    console.log(chalk.dim(`  → Launching CloakBrowser (stealth + humanize)...`));
    const result = await launchBrowser();
    context = result.context;
    const page = result.page;

    const size = page.viewportSize();
    console.log(chalk.dim(`  → TZ: ${result.timezone} | Locale: ${result.locale} | Viewport: ${size.width}x${size.height}`));

    // 2. Warm up Google cookies (reduces reCAPTCHA)
    await warmupGoogleCookies(page);

    // 3. Build search history (influences ad targeting)
    await buildSearchHistory(page);

    // 4. Search the keyword on Google
    await searchGoogle(page, keyword);

    // 5. Simulate organic behavior on search results
    console.log(chalk.dim(`  → Simulating organic browsing on results...`));
    await humanScroll(page);
    await randomIdle();
    await mouseJitter(page);

    // 6. Find matching result (sponsored first, then organic if SPONSORED_ONLY=false)
    let adInfo = null;

    if (config.sponsoredOnly) {
      // Only look at sponsored ads
      adInfo = await findSponsoredAd(page, config.targetDomains);
    } else {
      // Search sponsored first, fall back to organic results
      adInfo = await findSponsoredAd(page, config.targetDomains);
      if (!adInfo) {
        console.log(chalk.dim(`  → No sponsored match, checking organic results...`));
        adInfo = await findOrganicResult(page, config.targetDomains);
      }
    }

    if (!adInfo) {
      console.log(chalk.yellow(`⚠ Session ${sessionNumber} — no matching result found for "${keyword}"`));
      return false;
    }

    // 7. Click the result
    console.log(chalk.dim(`  → Clicking ${adInfo.type} result...`));
    const clicked = await clickSponsoredAd(page, adInfo);

    if (!clicked) {
      console.log(chalk.yellow(`⚠ Session ${sessionNumber} — could not click the result`));
      return false;
    }

    // 8. Wait for landing page and browse naturally
    await sleep(3000, 5000);
    await browseTargetSite(page, context);

    console.log(chalk.green(`✓ Session ${sessionNumber} completed — "${keyword}" → ${adInfo.domain} (${adInfo.type})`));
    return true;
  } catch (err) {
    console.log(chalk.red(`✗ Session ${sessionNumber} failed: ${err.message}`));
    return false;
  } finally {
    if (context) {
      await context.close();
    }
  }
}
