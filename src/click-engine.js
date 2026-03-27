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

/**
 * Pick a random item from an array
 */
function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Navigate to target URL with a spoofed referrer header.
 * 
 * We do NOT visit Google/Bing directly — those sites show CAPTCHAs
 * even to stealth browsers. Instead, we just set the Referer header
 * so the target site sees the visit as coming from a search engine.
 */
async function navigateToTarget(page) {
  const referrer = randomFrom(config.referrerUrls);
  console.log(chalk.dim(`  → Referrer: ${referrer}`));
  console.log(chalk.dim(`  → Navigating to target: ${config.targetUrl}`));

  // Set the referer header — the target site sees this as an organic search visit
  await page.goto(config.targetUrl, {
    waitUntil: 'networkidle',
    timeout: 30000,
    referer: referrer,
  });

  // Wait for page to settle
  await sleep(1000, 2000);
}

/**
 * Wait for Google Ads to load and find the ad element.
 * 
 * Google Ads work like this:
 * 1. The page has an <ins class="adsbygoogle"> container
 * 2. Google's script fills it with a cross-origin <iframe>
 * 3. The actual clickable ad creative is INSIDE that iframe
 * 4. You CAN'T querySelector inside cross-origin iframes
 * 
 * Solution: Find the iframe element on the main page and click ON it
 */
async function findGoogleAd(page) {
  console.log(chalk.dim(`  → Waiting for Google Ads to load...`));

  const maxWaitMs = 20000;
  const checkIntervalMs = 2000;
  let elapsed = 0;

  while (elapsed < maxWaitMs) {
    const adInfo = await page.evaluate(() => {
      // Strategy 1: Find iframes from Google ad servers
      const googleAdIframes = document.querySelectorAll(
        'iframe[src*="googleads"], iframe[src*="doubleclick"], iframe[id*="google_ads"], iframe[id*="aswift"]'
      );

      // Strategy 2: Find filled adsbygoogle containers
      const adContainers = document.querySelectorAll('ins.adsbygoogle[data-ad-status="filled"]');

      // Strategy 3: Find any iframe inside adsbygoogle containers
      const adsbyGoogleIframes = document.querySelectorAll('ins.adsbygoogle iframe');

      const ads = [];

      for (const iframe of googleAdIframes) {
        const rect = iframe.getBoundingClientRect();
        if (rect.width > 10 && rect.height > 10 && rect.top < window.innerHeight * 2) {
          ads.push({
            type: 'google-iframe',
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
            width: rect.width,
            height: rect.height,
            top: rect.top,
            src: iframe.src?.substring(0, 100),
          });
        }
      }

      for (const container of adContainers) {
        const iframe = container.querySelector('iframe');
        if (iframe) {
          const rect = iframe.getBoundingClientRect();
          if (rect.width > 10 && rect.height > 10) {
            const dup = ads.some(a => Math.abs(a.x - (rect.left + rect.width / 2)) < 5);
            if (!dup) {
              ads.push({
                type: 'adsbygoogle-filled',
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2,
                width: rect.width,
                height: rect.height,
                top: rect.top,
                src: iframe.src?.substring(0, 100),
              });
            }
          }
        }
      }

      for (const iframe of adsbyGoogleIframes) {
        const rect = iframe.getBoundingClientRect();
        if (rect.width > 10 && rect.height > 10) {
          const dup = ads.some(a => Math.abs(a.x - (rect.left + rect.width / 2)) < 5);
          if (!dup) {
            ads.push({
              type: 'adsbygoogle-iframe',
              x: rect.left + rect.width / 2,
              y: rect.top + rect.height / 2,
              width: rect.width,
              height: rect.height,
              top: rect.top,
              src: iframe.src?.substring(0, 100),
            });
          }
        }
      }

      return {
        ads,
        totalIframes: document.querySelectorAll('iframe').length,
        adsbygoogleCount: document.querySelectorAll('ins.adsbygoogle').length,
      };
    });

    if (adInfo.ads.length > 0) {
      console.log(chalk.green(`  ✓ Found ${adInfo.ads.length} Google Ad(s) after ${(elapsed / 1000).toFixed(1)}s`));
      adInfo.ads.forEach((ad, i) => {
        console.log(chalk.dim(`    Ad ${i + 1}: ${ad.type} — ${ad.width}x${ad.height}`));
      });
      return adInfo.ads;
    }

    console.log(
      chalk.dim(
        `  → No ads yet (${(elapsed / 1000).toFixed(0)}s) — ${adInfo.adsbygoogleCount} containers, ${adInfo.totalIframes} iframes...`
      )
    );

    await sleep(checkIntervalMs);
    elapsed += checkIntervalMs;
  }

  return [];
}

/**
 * Click on a Google Ad by coordinates
 */
async function clickGoogleAd(page, ad) {
  console.log(chalk.dim(`  → Scrolling ad into view...`));

  // Scroll the ad into the viewport
  await page.evaluate((adTop) => {
    const targetY = adTop - window.innerHeight / 2 + 100;
    window.scrollTo({
      top: window.scrollY + targetY,
      behavior: 'smooth',
    });
  }, ad.top);

  await sleep(1000, 2000);

  // Re-measure position after scrolling
  const updatedAd = await page.evaluate((adType) => {
    let iframes;
    if (adType === 'google-iframe') {
      iframes = document.querySelectorAll(
        'iframe[src*="googleads"], iframe[src*="doubleclick"], iframe[id*="google_ads"], iframe[id*="aswift"]'
      );
    } else {
      iframes = document.querySelectorAll('ins.adsbygoogle iframe');
    }

    for (const iframe of iframes) {
      const rect = iframe.getBoundingClientRect();
      if (rect.width > 10 && rect.height > 10 && rect.top > -50 && rect.top < window.innerHeight) {
        return {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          width: rect.width,
          height: rect.height,
        };
      }
    }
    return null;
  }, ad.type);

  if (!updatedAd) {
    console.log(chalk.yellow(`  ⚠ Could not locate ad after scrolling`));
    return false;
  }

  // Random offset within the ad bounds (like a real human — never dead center)
  const offsetX = (Math.random() - 0.5) * updatedAd.width * 0.4;
  const offsetY = (Math.random() - 0.5) * updatedAd.height * 0.4;
  const clickX = Math.round(updatedAd.x + offsetX);
  const clickY = Math.round(updatedAd.y + offsetY);

  console.log(chalk.dim(`  → Moving to ad area...`));

  // Move mouse naturally to the ad, then click
  // CloakBrowser humanize applies Bézier curves automatically
  await page.mouse.move(clickX - 80, clickY - 40);
  await sleep(200, 500);
  await page.mouse.move(clickX, clickY);
  await sleep(100, 300);
  await page.mouse.click(clickX, clickY);

  console.log(chalk.green(`  ✓ Ad clicked at (${clickX}, ${clickY})`));
  return true;
}

/**
 * Find and click the target ad element
 */
async function findAndClickAd(page) {
  // Try Google Ad detection first (iframe-based)
  const googleAds = await findGoogleAd(page);

  if (googleAds.length > 0) {
    const ad = randomFrom(googleAds);
    return await clickGoogleAd(page, ad);
  }

  // Fallback: try the config selector directly
  console.log(chalk.dim(`  → No Google Ads found, trying selector: ${config.adSelector}`));

  try {
    await page.locator(config.adSelector).waitFor({ timeout: 5000 });
  } catch {
    console.log(chalk.yellow(`  ⚠ No ad found with selector: ${config.adSelector}`));
    return false;
  }

  const isVisible = await page.evaluate((selector) => {
    const el = document.querySelector(selector);
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }, config.adSelector);

  if (!isVisible) {
    console.log(chalk.yellow(`  ⚠ Ad element exists but is not visible`));
    return false;
  }

  await page.evaluate((selector) => {
    document.querySelector(selector).scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, config.adSelector);

  await sleep(800, 1500);
  await humanClick(page, config.adSelector);

  console.log(chalk.green(`  ✓ Ad clicked successfully`));
  return true;
}

/**
 * Post-click behavior
 */
async function postClickBehavior(page, context) {
  console.log(chalk.dim(`  → Simulating post-click behavior...`));

  await sleep(2000, 4000);

  const pages = context.pages();
  const activePage = pages[pages.length - 1];

  try {
    await activePage.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  } catch {
    // Already completed
  }

  try {
    await simulateReading(activePage);
    await mouseJitter(activePage);
  } catch {
    console.log(chalk.dim(`  → Post-click page interaction limited`));
  }

  await sleep(gaussianDelay(5000, 2000));
}

/**
 * Run a single click session
 */
export async function runSession(sessionNumber) {
  console.log(chalk.cyan(`\n━━━ Session ${sessionNumber} ━━━━━━━━━━━━━━━━━━━━━━`));

  let context;

  try {
    // 1. Launch CloakBrowser (persistent context + humanize)
    console.log(chalk.dim(`  → Launching CloakBrowser (stealth + humanize)...`));
    const result = await launchBrowser();
    context = result.context;
    const page = result.page;

    const size = page.viewportSize();
    console.log(chalk.dim(`  → TZ: ${result.timezone}`));
    console.log(chalk.dim(`  → Locale: ${result.locale}`));
    console.log(chalk.dim(`  → Viewport: ${size.width}x${size.height}`));

    // 2. Navigate to target with spoofed referrer header
    //    (we don't visit Google — they CAPTCHA automated browsers)
    await navigateToTarget(page);

    // 3. Simulate organic browsing (also gives ads time to load)
    console.log(chalk.dim(`  → Simulating organic browsing...`));
    await humanScroll(page);
    await randomIdle();
    await mouseJitter(page);
    await simulateReading(page);

    // 4. Find and click Google Ad
    const clicked = await findAndClickAd(page);

    if (clicked) {
      // 5. Post-click behavior
      await postClickBehavior(page, context);
      console.log(chalk.green(`✓ Session ${sessionNumber} completed successfully`));
    } else {
      console.log(chalk.yellow(`⚠ Session ${sessionNumber} completed — no ad found/clicked`));
    }

    return clicked;
  } catch (err) {
    console.log(chalk.red(`✗ Session ${sessionNumber} failed: ${err.message}`));
    return false;
  } finally {
    if (context) {
      await context.close();
    }
  }
}
