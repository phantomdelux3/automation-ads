/**
 * Cookie warmup - turning an empty profile into one Google treats as a
 * returning visitor.
 *
 * A brand new Chrome profile that walks straight up to google.com and searches
 * has no NID, no SOCS, no AEC and no history. That combination is what earns
 * the "unusual traffic" wall. Warming up first gives the profile the cookies
 * and the browsing rhythm a real browser accumulates on its own, BEFORE it is
 * ever used for the actual work - and before it has an account attached to it,
 * so a challenge here costs nothing.
 *
 * What a warmup has to produce (see cookieHealth in scripts/lib/bundle.js):
 *
 *   NID   - minted by google.com on the first visit
 *   SOCS  - the consent record; needs the consent dialog answered
 *   AEC   - Google's anti-abuse token, handed out to browsers that have
 *           actually USED Google Search and behaved like a person
 *   YouTube's VISITOR_INFO1_LIVE / YSC - near-universal on a real Chrome
 *
 * The last two are why this module does what an earlier version did not:
 * google.com and youtube.com are always visited (never left to a random
 * shuffle), and the profile performs one ordinary Google search during the
 * warmup. A profile that has never searched Google does not get AEC, and its
 * first-ever search then happens on the real keyword - which is exactly the
 * request worth protecting.
 *
 * The click engine does a lighter version of this at the start of every
 * session (warmupGoogleCookies in click-engine.js). This module is the
 * heavier, one-off version: it runs when a profile is created or re-warmed.
 */
import {
  sleep,
  humanScroll,
  mouseJitter,
  simulateReading,
} from './human-behavior.js';
import { acceptConsent } from './google-login.js';
import { detectAndHandleRecaptcha } from './captcha-guard.js';
import config from '../config.js';
import chalk from 'chalk';

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function shuffled(arr) {
  return [...arr].sort(() => Math.random() - 0.5);
}

/**
 * Always visited, in this order. These two mint the cookies that decide
 * whether Google thinks it has seen this browser before, so they are not
 * subject to the shuffle - an earlier version sliced them randomly and
 * regularly produced profiles with no consent record and no YouTube cookies.
 */
const CORE_PROPERTIES = [
  { url: 'https://www.google.com/', name: 'Google' },
  { url: 'https://www.youtube.com/', name: 'YouTube' },
];

/** Visited on top of the core two, for variety between profiles. */
const EXTRA_PROPERTIES = [
  { url: 'https://news.google.com/', name: 'Google News' },
  { url: 'https://www.google.com/maps', name: 'Google Maps' },
  { url: 'https://mail.google.com/', name: 'Gmail' },
];

/** Harmless queries for the one Google search each warmup round performs. */
const BENIGN_QUERIES = [
  'weather today',
  'time zone converter',
  'unit converter',
  'calculator',
  'news today',
  'dictionary definition',
  'world clock',
  'currency converter',
];

/**
 * Visit one page and behave like a person on it.
 *
 * Failures are reported with their reason rather than swallowed: a warmup that
 * quietly fails every navigation still "succeeds" and hands back a profile
 * with an empty cookie jar, which is the worst possible outcome here.
 */
async function browseFor(page, url, name, { deep = false } = {}) {
  try {
    console.log(chalk.dim(`      → ${name}`));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await acceptConsent(page);
    await detectAndHandleRecaptcha(page).catch(() => {});
    await sleep(2000, 4500);
    await humanScroll(page).catch(() => {});
    await mouseJitter(page).catch(() => {});
    if (deep) {
      await simulateReading(page).catch(() => {});
      await sleep(2000, 5000);
    }
    await sleep(1200, 3000);
    return true;
  } catch (e) {
    const why = String(e.message).split('\n')[0].slice(0, 110);
    console.log(chalk.yellow(`      ⚠ ${name} failed: ${why}`));
    return false;
  }
}

/**
 * Perform one ordinary search on Google, typed into the box rather than
 * navigated to as a /search URL.
 *
 * This is the step that earns AEC. It is deliberately a boring query: the
 * point is to have used Google Search at all, from a browser that already
 * holds NID and a consent record, well before the real keyword is typed.
 */
async function searchOnGoogle(page) {
  const query = BENIGN_QUERIES[randomInt(0, BENIGN_QUERIES.length - 1)];
  try {
    console.log(chalk.dim(`      → Google search "${query}"`));
    await page.goto('https://www.google.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });
    await acceptConsent(page);
    await detectAndHandleRecaptcha(page).catch(() => {});
    await sleep(1500, 3000);

    const box = page.locator('textarea[name="q"], input[name="q"]').first();
    if (!(await box.isVisible({ timeout: 8000 }).catch(() => false))) {
      console.log(chalk.yellow('      ⚠ no search box found, skipping the search'));
      return false;
    }

    await box.click();
    await sleep(400, 1000);
    for (const ch of query) {
      await page.keyboard.type(ch, { delay: randomInt(60, 190) });
    }
    await sleep(600, 1600);
    await page.keyboard.press('Enter');
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    await sleep(2500, 4500);

    // A challenge here is the whole reason warmup happens before an account is
    // attached: solve it now, cheaply, instead of mid-run on a real keyword.
    await detectAndHandleRecaptcha(page).catch(() => {});

    await humanScroll(page).catch(() => {});
    await sleep(1500, 3500);
    await mouseJitter(page).catch(() => {});
    console.log(chalk.dim('      ✓ searched Google'));
    return true;
  } catch (e) {
    const why = String(e.message).split('\n')[0].slice(0, 110);
    console.log(chalk.yellow(`      ⚠ Google search failed: ${why}`));
    return false;
  }
}

/**
 * A few searches on an engine that does not challenge cold browsers, to give
 * the profile a plausible search history without spending Google's patience.
 * Bing is the fallback: DuckDuckGo refuses some proxy exits outright, and a
 * silent failure there used to leave the profile with no history at all.
 */
async function buildSearchHistory(page) {
  const queries = shuffled(config.searchQueries).slice(0, randomInt(2, 3));
  for (const query of queries) {
    const q = encodeURIComponent(query);
    const done = await browseFor(page, `https://duckduckgo.com/?q=${q}`, `search "${query}"`);
    if (!done) {
      await browseFor(page, `https://www.bing.com/search?q=${q}`, `search "${query}" (Bing)`);
    }
  }
}

/** One warmup round: the core Google properties, a search, some real sites. */
async function warmupRound(page, round, rounds) {
  console.log(chalk.blue(`    Round ${round}/${rounds}`));

  for (const site of CORE_PROPERTIES) {
    await browseFor(page, site.url, site.name, { deep: true });
  }

  for (const site of shuffled(EXTRA_PROPERTIES).slice(0, randomInt(1, 2))) {
    await browseFor(page, site.url, site.name);
  }

  await searchOnGoogle(page);

  for (const url of shuffled(config.warmupUrls).slice(0, randomInt(1, 2))) {
    let host = url;
    try {
      host = new URL(url).hostname;
    } catch {
      /* keep the raw string */
    }
    await browseFor(page, url, host);
  }

  await buildSearchHistory(page);
}

/**
 * Warm one already-open profile.
 *
 * `page` must belong to a context launched with the profile's own identity and
 * proxy - warming a profile over a different exit IP than it will later use
 * teaches Google the wrong thing about it.
 *
 * Returns a small summary of what the profile ended up holding.
 */
export async function warmupProfile(page, context, { rounds = 1, label = '' } = {}) {
  console.log(chalk.blue(`  🍪 Warming cookies${label ? ` for ${label}` : ''} (${rounds} round(s))`));

  for (let r = 1; r <= rounds; r++) {
    await warmupRound(page, r, rounds);
    if (r < rounds) {
      const gap = randomInt(8000, 20000);
      console.log(chalk.dim(`    resting ${(gap / 1000).toFixed(0)}s between rounds`));
      await sleep(gap);
    }
  }

  let summary = { total: 0, google: 0 };
  try {
    const cookies = await context.cookies();
    summary = {
      total: cookies.length,
      google: cookies.filter((c) => /google\.|youtube\./.test(c.domain)).length,
    };
  } catch {
    /* the count is reporting only */
  }

  console.log(
    chalk.green(`  ✓ Warmup done — ${summary.total} cookies (${summary.google} Google/YouTube)`)
  );
  return summary;
}
