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
        timeout: 60000,
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
  let isRecaptcha = false;
  try {
    isRecaptcha = await page.evaluate(() => {
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
  } catch (err) {
    if (err.message.includes('Execution context was destroyed') || err.message.includes('Target closed')) {
      return false; // Page is navigating or closed, ignore captcha check
    }
    throw err;
  }

  if (!isRecaptcha) return false;

  console.log(chalk.red.bold(`\n  ╔══════════════════════════════════════════════╗`));
  console.log(chalk.red.bold(`  ║  🛑  reCAPTCHA DETECTED — SOLVE IT NOW!     ║`));
  console.log(chalk.red.bold(`  ║  The browser window is waiting for you.      ║`));
  console.log(chalk.red.bold(`  ║  Solve the CAPTCHA manually, then wait...    ║`));
  console.log(chalk.red.bold(`  ╚══════════════════════════════════════════════╝\n`));

  // Poll every 5 seconds until reCAPTCHA is gone
  let attempts = 0;
  const maxAttempts = 180; // 15 minutes max

  while (attempts < maxAttempts) {
    await sleep(5000);
    attempts++;

    try {
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
    } catch (err) {
      if (err.message.includes('Execution context was destroyed') || err.message.includes('Target closed')) {
        console.log(chalk.green(`  ✓ Navigation detected (reCAPTCHA likely solved)! Continuing...\n`));
        await sleep(3000, 5000);
        return true;
      }
      throw err;
    }

    if (attempts % 6 === 0) {
      console.log(chalk.yellow(`  ⏳ Still waiting for CAPTCHA to be solved... (${attempts * 5}s)`));
      if (attempts >= 12) {
          console.log(chalk.magenta(`  🔔 Remember to solve the CAPTCHA in the active browser window!`));
      }
    }
  }

  console.log(chalk.red(`  ✗ Timed out waiting for CAPTCHA solve (15 min)`));
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
    timeout: 60000,
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
    await page.waitForSelector('#search, #rso, #main, #tads, .uEierd', { timeout: 15000 });
    // Also wait a bit for scripts to stop generating dynamic ads (like shopping carousels)
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  } catch {
    console.log(chalk.yellow(`  ⚠ Search results container didn't appear normally, but continuing...`));
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

  const matchedAds = await page.evaluate((domains) => {
    const results = [];
    const matchedAds = [];

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

    // Helper: extract main domain (strip www. and subdomains, keep last 2-3 parts)
    function getMainDomain(hostname) {
      const h = hostname.toLowerCase().replace(/^www\./, '');
      return h;
    }

    // Enhance results with trackingUrl if present on the DOM link
    results.forEach((r) => {
      r.trackingUrl = r.href;
      const links = document.querySelectorAll('a');
      for (const link of links) {
        if (link.href === r.href) {
          const rw = link.getAttribute('data-rw') || link.getAttribute('data-adurl');
          if (rw) {
            r.trackingUrl = rw.startsWith('http') ? rw : 'https://www.google.com' + rw;
            break;
          }
        }
      }
    });

  // Now match against target domains
    for (const ad of results) {
      let adHostname = '';
      try { adHostname = new URL(ad.href).hostname; } catch {}
      const adMainDomain = getMainDomain(adHostname);
      const combined = (ad.href + ' ' + ad.displayUrl).toLowerCase();
      for (const domain of domains) {
        const targetMain = getMainDomain(domain);
        if (adMainDomain === targetMain || adMainDomain.endsWith('.' + targetMain) || combined.includes(targetMain)) {
          if (!matchedAds.some(m => m.href === ad.href)) {
             matchedAds.push({
               href: ad.href,
               trackingUrl: ad.trackingUrl,
               displayUrl: ad.displayUrl,
               domain: domain,
               top: ad.top,
               matched: true,
               type: 'sponsored',
             });
          }
        }
      }
    }

    return { matched: matchedAds.length > 0, ads: matchedAds, totalAds: results.length, sampleUrls: results.slice(0, 5).map(r => r.href) };
  }, targetDomains);

  if (matchedAds.matched) {
    console.log(chalk.green(`  ✓ Found ${matchedAds.ads.length} sponsored ad(s) matching targets`));
    return matchedAds.ads;
  }

  console.log(chalk.yellow(`  ⚠ No matching sponsored ads found (${matchedAds.totalAds} total ads on page)`));
  if (matchedAds.sampleUrls?.length > 0) {
    console.log(chalk.dim(`    Found ads pointing to:`));
    matchedAds.sampleUrls.forEach((url) => {
      console.log(chalk.dim(`      → ${url.substring(0, 80)}`));
    });
  }

  return [];
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
    const matchedResults = [];

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

    // Helper: extract main domain (strip www. and subdomains, keep root)
    function getMainDomain(hostname) {
      const h = hostname.toLowerCase().replace(/^www\./, '');
      return h;
    }

    // Match against target domains
    for (const result of results) {
      const resultMainDomain = getMainDomain(result.hostname);
      for (const domain of domains) {
        const targetMain = getMainDomain(domain);
        if (resultMainDomain === targetMain || resultMainDomain.endsWith('.' + targetMain)) {
           if (!matchedResults.some(m => m.href === result.href)) {
             matchedResults.push({
               href: result.href,
               displayUrl: result.displayUrl,
               domain: domain,
               top: result.top,
               matched: true,
               type: 'organic',
               text: result.text,
             });
           }
        }
      }
    }

    return {
      matched: matchedResults.length > 0,
      ads: matchedResults,
      totalResults: results.length,
      sampleUrls: results.slice(0, 8).map(r => `${r.hostname} — ${r.text.substring(0, 40)}`),
    };
  }, targetDomains);

  if (matchedResult.matched) {
    console.log(chalk.green(`  ✓ Found ${matchedResult.ads.length} organic result(s) matching targets`));
    return matchedResult.ads;
  }

  console.log(chalk.yellow(`  ⚠ No matching results found on page (${matchedResult.totalResults} total results)`));
  if (matchedResult.sampleUrls?.length > 0) {
    console.log(chalk.dim(`    Results on page:`));
    matchedResult.sampleUrls.forEach((s) => {
      console.log(chalk.dim(`      → ${s}`));
    });
  }

  return [];
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
    const domain = new URL(targetHref).hostname.replace(/^www\./, '');
    for (const link of allLinks) {
      try {
        const linkDomain = new URL(link.href).hostname.replace(/^www\./, '');
        if (link.href && (linkDomain === domain || linkDomain.endsWith('.' + domain))) {
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
      const targetMain = domain.toLowerCase().replace(/^www\./, '');
      const allLinks = document.querySelectorAll('a');
      for (const link of allLinks) {
        try {
          if (link.href) {
            const linkDomain = new URL(link.href).hostname.toLowerCase().replace(/^www\./, '');
            if (linkDomain === targetMain || linkDomain.endsWith('.' + targetMain)) {
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

  return await performHumanClick(page, clicked.rect, 'Sponsored ad');
}

// ─── Click Organic Result ───────────────────────────────────

/**
 * Click on a matched organic result naturally.
 * Searches ALL links on the page (not just ad containers).
 */
async function clickOrganicResult(page, resultInfo) {
  console.log(chalk.dim(`  → Scrolling to organic result...`));

  // Step 1: Find the matching link, mark it with a data attribute, and scroll to it
  const found = await page.evaluate(({ targetHref, targetDomain }) => {
    const targetMain = targetDomain.toLowerCase().replace(/^www\./, '');
    const allLinks = document.querySelectorAll('#search a, #rso a, #main a');

    // First try exact href match
    for (const link of allLinks) {
      if (link.href && link.href === targetHref && link.offsetWidth > 0 && link.offsetHeight > 0) {
        link.setAttribute('data-organic-target', 'true');
        link.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return true;
      }
    }

    // Fallback: match by main domain
    for (const link of allLinks) {
      try {
        if (!link.href || !link.offsetWidth || !link.offsetHeight) continue;
        const linkDomain = new URL(link.href).hostname.toLowerCase().replace(/^www\./, '');
        if (linkDomain === targetMain || linkDomain.endsWith('.' + targetMain)) {
          if (link.innerText?.trim().length > 0 || link.querySelector('h3')) {
            link.setAttribute('data-organic-target', 'true');
            link.scrollIntoView({ behavior: 'smooth', block: 'center' });
            return true;
          }
        }
      } catch {}
    }

    return false;
  }, { targetHref: resultInfo.href, targetDomain: resultInfo.domain });

  if (!found) {
    console.log(chalk.yellow(`  ⚠ Could not locate the organic result link to click`));
    return false;
  }

  // Step 2: Wait for smooth scroll to finish
  await sleep(1500, 2500);

  // Step 3: Re-measure coordinates now that scroll is done
  const rect = await page.evaluate(() => {
    const link = document.querySelector('a[data-organic-target="true"]');
    if (!link) return null;
    const r = link.getBoundingClientRect();
    return {
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
      width: r.width,
      height: r.height,
    };
  });

  if (!rect) {
    console.log(chalk.yellow(`  ⚠ Could not re-measure the organic result position`));
    return false;
  }

  return await performHumanClick(page, rect, 'Organic result');
}

// ─── Shared Human Click ─────────────────────────────────────

/**
 * Perform a human-like click at the given rect position.
 */
async function performHumanClick(page, rect, label) {
  await sleep(1000, 2000);

  // Random offset within the link (not dead center — humans never click dead center)
  const offsetX = (Math.random() - 0.5) * rect.width * 0.3;
  const offsetY = (Math.random() - 0.5) * rect.height * 0.3;
  const clickX = Math.round(rect.x + offsetX);
  const clickY = Math.round(rect.y + offsetY);

  // Human-like mouse approach
  console.log(chalk.dim(`  → Moving to ${label.toLowerCase()}...`));
  await page.mouse.move(clickX - randomInt(60, 120), clickY - randomInt(20, 50));
  await sleep(200, 500);
  await page.mouse.move(clickX + randomInt(-5, 5), clickY + randomInt(-3, 3));
  await sleep(150, 400);

  // Click!
  await page.mouse.click(clickX, clickY);
  console.log(chalk.green(`  ✓ ${label} clicked!`));

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

  let sessionStats = {
    keyword,
    success: false,
    hasSponsored: false,
    hasTargetDomain: false
  };

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

    // 5. FAST FAIL CHECKS - Before wasting time scrolling
    console.log(chalk.dim(`  → FAST FAIL CHECK: Validating presence & targets...`));
    const fastCheck = await page.evaluate(({ domains, onlySponsored }) => {
      function getMainDomain(hostname) { return hostname.toLowerCase().replace(/^www\./, ''); }

      // Count distinct sponsored ad blocks
      const adBlockEls = document.querySelectorAll('#tads > *, #tadsb > *, [data-text-ad], .uEierd');
      const sponsoredSpans = Array.from(document.querySelectorAll('span')).filter(s => s.textContent?.trim() === 'Sponsored' || s.textContent?.trim() === 'Ad');
      const sponsoredCount = adBlockEls.length || sponsoredSpans.length;
      const hasSponsored = sponsoredCount > 0;

      let targetInSponsored = false;
      let targetInOrganic = false;
      let sponsoredTargetCount = 0;
      let organicTargetCount = 0;
      const seenSponsoredTargets = new Set();
      const seenOrganicTargets = new Set();

      // Check for targets in Sponsored Ads
      const allAdLinks = document.querySelectorAll('#tads a, #tadsb a, [data-text-ad] a, .uEierd a, .commercial-unit-desktop-top a, [data-rw]');
      for (const link of allAdLinks) {
        if (!link.href) continue;
        let adMainDomain = '';
        try { adMainDomain = getMainDomain(new URL(link.href).hostname); } catch {}
        for (const domain of domains) {
          const targetMain = getMainDomain(domain);
          if (adMainDomain === targetMain || adMainDomain.endsWith('.' + targetMain) || link.href.toLowerCase().includes(targetMain)) {
            targetInSponsored = true;
            if (!seenSponsoredTargets.has(link.href)) {
              seenSponsoredTargets.add(link.href);
              sponsoredTargetCount++;
            }
          }
        }
      }

      // Check for targets in Organic (if SPONSORED_ONLY is false)
      if (!onlySponsored) {
        const organicLinks = document.querySelectorAll('#search a, #rso a, #main a');
        for (const link of organicLinks) {
          if (!link.href) continue;
          let organicMainDomain = '';
          try { organicMainDomain = getMainDomain(new URL(link.href).hostname); } catch {}
          for (const domain of domains) {
            const targetMain = getMainDomain(domain);
            if (organicMainDomain === targetMain || organicMainDomain.endsWith('.' + targetMain) || link.href.toLowerCase().includes(targetMain)) {
              targetInOrganic = true;
              if (!seenOrganicTargets.has(link.href)) {
                seenOrganicTargets.add(link.href);
                organicTargetCount++;
              }
            }
          }
        }
      }

      const totalTargetCount = sponsoredTargetCount + organicTargetCount;

      return {
        hasSponsored,
        sponsoredCount,
        hasTarget: targetInSponsored || (!onlySponsored && targetInOrganic),
        targetInSponsored,
        targetInOrganic,
        sponsoredTargetCount,
        organicTargetCount,
        totalTargetCount,
      };
    }, { domains: config.targetDomains, onlySponsored: config.sponsoredOnly });

    sessionStats.hasSponsored = fastCheck.hasSponsored;
    sessionStats.hasTargetDomain = fastCheck.hasTarget;
    sessionStats.sponsoredCount = fastCheck.sponsoredCount;
    sessionStats.targetCount = fastCheck.totalTargetCount;

    if (config.sponsoredOnly) {
      if (!fastCheck.hasSponsored) {
        console.log(chalk.yellow(`  ⚠ FAST FAIL: No sponsored ads found on page. Skipping session.`));
        return sessionStats;
      }
      if (!fastCheck.targetInSponsored) {
        console.log(chalk.yellow(`  ⚠ FAST FAIL: Found ${fastCheck.sponsoredCount} sponsored ad(s) but target domain was NOT among them. Skipping session.`));
        return sessionStats;
      }
    } else {
      if (!fastCheck.hasTarget) {
        console.log(chalk.yellow(`  ⚠ FAST FAIL: Target domains not found in sponsored or organic results. Skipping session.`));
        return sessionStats;
      }
    }
    console.log(chalk.green(`  ✓ Validated! ${fastCheck.sponsoredCount} sponsored ad(s) on page, ${fastCheck.totalTargetCount} target link(s) found. Proceeding...`));

    // 6. Simulate organic behavior on search results
    console.log(chalk.dim(`  → Simulating organic browsing on results...`));
    await humanScroll(page);
    await randomIdle();
    await mouseJitter(page);

    // 7. Find matching result (sponsored first, then organic if SPONSORED_ONLY=false)
    let adInfos = [];

    if (config.sponsoredOnly) {
      // Only look at sponsored ads
      adInfos = await findSponsoredAd(page, config.targetDomains);
    } else {
      // Search sponsored first, fall back to organic results
      adInfos = await findSponsoredAd(page, config.targetDomains);
      if (adInfos.length === 0) {
        console.log(chalk.dim(`  → No sponsored match, checking organic results...`));
        adInfos = await findOrganicResult(page, config.targetDomains);
      }
    }

    if (adInfos.length === 0) {
      console.log(chalk.yellow(`⚠ Session ${sessionNumber} — no matching result found for "${keyword}"`));
      return sessionStats;
    }

    // 8. Click and browse ALL matched targets
    for (let c = 0; c < adInfos.length; c++) {
      const adInfo = adInfos[c];
      console.log(chalk.dim(`  → Target ${c + 1}/${adInfos.length}: Clicking ${adInfo.type} result (${adInfo.domain})...`));
      
      const clicked = adInfo.type === 'organic'
        ? await clickOrganicResult(page, adInfo)
        : await clickSponsoredAd(page, adInfo);

      if (!clicked) {
        console.log(chalk.yellow(`  ⚠ Could not click target ${c + 1}`));
        continue;
      }
      
      sessionStats.clickedTargets = (sessionStats.clickedTargets || 0) + 1;

      // 9. Wait for navigation to the target site
      console.log(chalk.dim(`  → Waiting for navigation to target site...`));
      try {
        await page.waitForURL((url) => !url.toString().includes('google.com/search'), { timeout: 10000 });
      } catch {
        // Navigation might not have happened — check current URL
        const currentUrl = page.url();
        if (currentUrl.includes('google.com/search')) {
          console.log(chalk.yellow(`  ⚠ Navigation didn't happen, trying direct goto...`));
          const gotoUrl = adInfo.trackingUrl || adInfo.href;
          console.log(chalk.dim(`  → Direct goto URL: ${gotoUrl.substring(0, 100)}...`));
          await page.goto(gotoUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        }
      }
      await sleep(2000, 4000);
      await browseTargetSite(page, context);

      console.log(chalk.green(`  ✓ Browsed target ${c + 1} — "${adInfo.domain}" (${adInfo.type})`));
      
      if (c < adInfos.length - 1) {
         console.log(chalk.dim(`  → Navigating back to Google Search for next target...`));
         await page.goBack({ waitUntil: 'networkidle' });
         // Re-find the next element to scroll
         await sleep(2000, 4000);
         await humanScroll(page);
      }
    }

    console.log(chalk.green(`✓ Session ${sessionNumber} completed — clicked ${sessionStats.clickedTargets} targets`));
    sessionStats.success = true;
    return sessionStats;
  } catch (err) {
    console.log(chalk.red(`✗ Session ${sessionNumber} failed: ${err.message}`));
    return sessionStats;
  } finally {
    if (context) {
      await context.close();
    }
  }
}
