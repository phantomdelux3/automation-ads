import config from '../config.js';

/**
 * Random number between min and max
 */
function random(min, max) {
  return Math.random() * (max - min) + min;
}

/**
 * Random integer between min and max (inclusive)
 */
function randomInt(min, max) {
  return Math.floor(random(min, max + 1));
}

/**
 * Sleep for a random duration in range
 */
export function sleep(min, max) {
  const ms = max ? random(min, max) : min;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Gaussian (bell-curve) random delay for more natural timing
 * Clusters around the mean with occasional outliers
 */
export function gaussianDelay(mean, stdDev) {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const normal = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  return Math.max(200, Math.floor(mean + stdDev * normal));
}

/**
 * Simulate realistic mouse movement to a random position
 * CloakBrowser's humanize mode automatically applies Bézier curves
 */
export async function humanMouseMove(page) {
  const size = page.viewportSize();
  const idleMoves = randomInt(1, 3);
  for (let i = 0; i < idleMoves; i++) {
    const x = randomInt(100, size.width - 100);
    const y = randomInt(100, size.height - 100);
    await page.mouse.move(x, y); // CloakBrowser humanizes this automatically
    await sleep(300, 800);
  }
}

/**
 * Click an element with human-like behavior
 * CloakBrowser's humanize mode applies Bézier mouse curves,
 * realistic aim point, and natural click timing automatically
 */
export async function humanClick(page, selector) {
  // CloakBrowser's humanize: true makes page.click() use Bézier curves,
  // realistic aim points, and natural timing automatically
  await sleep(100, 400);
  await page.click(selector, {
    delay: randomInt(50, 150), // hold duration
  });
}

/**
 * Simulate organic page scrolling
 * - Variable scroll distances
 * - Random pauses between scrolls
 * - Occasionally scrolls back up
 */
export async function humanScroll(page) {
  const scrollSteps = randomInt(3, 8);

  for (let i = 0; i < scrollSteps; i++) {
    const direction = Math.random() > 0.15 ? 1 : -1; // 85% down, 15% up
    const distance = randomInt(100, 500) * direction;

    await page.evaluate((dist) => {
      window.scrollBy({
        top: dist,
        left: 0,
        behavior: 'smooth',
      });
    }, distance);

    // Random pause between scrolls (Gaussian distributed)
    await sleep(gaussianDelay(
      (config.minScrollDelay + config.maxScrollDelay) / 2,
      (config.maxScrollDelay - config.minScrollDelay) / 4
    ));
  }
}

/**
 * Simulate reading content on the page
 * Scrolls slowly and pauses as if reading text
 */
export async function simulateReading(page) {
  const readingTime = randomInt(3, 8); // 3-8 scroll-pause cycles

  for (let i = 0; i < readingTime; i++) {
    // Small scroll like reading
    await page.evaluate(() => {
      window.scrollBy({
        top: Math.random() * 200 + 50,
        left: 0,
        behavior: 'smooth',
      });
    });

    // Pause as if reading a paragraph
    await sleep(gaussianDelay(2000, 800));
  }
}

/**
 * Simulate typing with realistic per-key delays
 * CloakBrowser's humanize mode adds per-character timing and typo simulation
 */
export async function humanType(page, selector, text) {
  await page.click(selector);
  await sleep(200, 500);
  // CloakBrowser humanize auto-applies per-char delays, thinking pauses, and typo simulation
  await page.type(selector, text);
}

/**
 * Random mouse jitter — small movements that humans naturally make
 * CloakBrowser's humanize mode applies Bézier curves automatically
 */
export async function mouseJitter(page) {
  try {
    const size = page.viewportSize();
    if (!size) return;
    const jitterCount = randomInt(2, 5);

    for (let i = 0; i < jitterCount; i++) {
      const x = randomInt(200, size.width - 200);
      const y = randomInt(200, size.height - 200);
      await page.mouse.move(x, y); // CloakBrowser humanizes this
      await sleep(100, 400);
    }
  } catch {
    // Page may have navigated or closed — safe to ignore
  }
}

/**
 * Random idle period — simulates user thinking/pausing
 */
export async function randomIdle() {
  await sleep(gaussianDelay(3000, 1500));
}
