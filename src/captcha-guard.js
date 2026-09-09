/**
 * Shared reCAPTCHA / "unusual traffic" guard.
 *
 * Every part of the bot that puts a profile on Google - searching, logging an
 * account back in, warming a fresh cookie jar - has to react to a challenge
 * the same way, so the logic lives here rather than in each caller.
 *
 * Order of attack:
 *   1. auto-solve through 2Captcha when an API key is configured
 *   2. otherwise (or on failure) wait CAPTCHA_WAIT_MINUTES for a human to
 *      solve it in the visible browser window
 *
 * Returns true when a challenge was present and is now gone, false when there
 * was nothing to solve OR the wait timed out - callers that need to tell those
 * apart should check the page again themselves.
 */
import { sleep } from './human-behavior.js';
import { autoSolveRecaptcha } from './captcha-solver.js';
import config from '../config.js';
import chalk from 'chalk';

// ─── reCAPTCHA Detection ────────────────────────────────────

/**
 * Detect reCAPTCHA / "unusual traffic" page from Google.
 * If detected:
 *   1. First try auto-solving via 2Captcha (if API key is configured)
 *   2. Fall back to waiting for manual solve if auto-solve fails
 */
export async function detectAndHandleRecaptcha(page) {
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

  console.log(chalk.red.bold(`\n  ╔══════════════════════════════════════════════════════╗`));
  console.log(chalk.red.bold(`  ║  🛑  reCAPTCHA DETECTED!                              ║`));
  console.log(chalk.red.bold(`  ╚══════════════════════════════════════════════════════╝\n`));

  // ── Attempt auto-solve via 2Captcha ──
  if (config.twoCaptchaApiKey) {
    console.log(chalk.blue.bold(`  🤖 Attempting automatic solve via 2Captcha...\n`));

    try {
      const autoSolved = await autoSolveRecaptcha(page, 3);
      if (autoSolved) {
        console.log(chalk.green.bold(`  ✅ reCAPTCHA auto-solved successfully! Continuing...\n`));
        await sleep(2000, 3000);
        return true;
      }
      console.log(chalk.yellow(`  ⚠ Auto-solve failed, falling back to manual solve...\n`));
    } catch (err) {
      if (err.message.includes('Execution context was destroyed') || err.message.includes('Target closed')) {
        console.log(chalk.green(`  ✓ Page navigated during auto-solve (likely solved)!\n`));
        await sleep(3000, 5000);
        return true;
      }
      console.log(chalk.yellow(`  ⚠ Auto-solve error: ${err.message}. Falling back to manual...\n`));
    }
  } else {
    console.log(chalk.dim(`  → No 2Captcha API key configured — waiting for manual solve`));
  }

  // ── Manual solve fallback ──
  //
  // Only worth offering when there is a window to solve it in. A headless run
  // has nobody at the keyboard, so waiting the full CAPTCHA_WAIT_MINUTES just
  // burns the clock and then fails anyway - report and move on instead.
  if (page.isHeadless) {
    console.log(
      chalk.yellow(
        `  ⚠ Headless run - nobody can solve this by hand. Skipping the ${
          config.captchaWaitMinutes || 4
        } min wait.`
      )
    );
    console.log(
      chalk.dim('    Re-run with the browser visible (--headed) to solve it yourself.')
    );
    return false;
  }

  console.log(chalk.red.bold(`  ╔══════════════════════════════════════════════════════╗`));
  console.log(chalk.red.bold(`  ║  👆 SOLVE THE CAPTCHA MANUALLY IN THE BROWSER!       ║`));
  console.log(chalk.red.bold(`  ║  Waiting for you to solve it...                      ║`));
  console.log(chalk.red.bold(`  ╚══════════════════════════════════════════════════════╝\n`));

  // Poll every 5 seconds until reCAPTCHA is gone
  const waitMinutes = config.captchaWaitMinutes || 4;
  let attempts = 0;
  const maxAttempts = Math.max(1, Math.round((waitMinutes * 60) / 5)); // configurable wait window
  console.log(chalk.dim(`  → Will wait up to ${waitMinutes} min for the CAPTCHA to clear\n`));

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

  console.log(chalk.red(`  ✗ Timed out waiting for CAPTCHA solve (${waitMinutes} min)`));
  return false;
}
