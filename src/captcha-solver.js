import chalk from 'chalk';
import config from '../config.js';

const API_BASE = 'https://api.2captcha.com';

// ─── Helpers ────────────────────────────────────────────────

/**
 * Sleep helper that supports both fixed and random range delays.
 * - sleep(ms) → sleeps exactly ms
 * - sleep(min, max) → sleeps a random duration between min and max
 */
const sleep = (min, max) => {
  const ms = max !== undefined
    ? min + Math.random() * (max - min)
    : min;
  return new Promise((r) => setTimeout(r, ms));
};

/**
 * Make a JSON POST request to the 2Captcha API.
 */
async function apiRequest(endpoint, body) {
  const res = await fetch(`${API_BASE}/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

// ─── Balance Check ──────────────────────────────────────────

/**
 * Check 2Captcha account balance.
 * - Warns if balance < $1
 * - Throws error if balance <= 0
 * Returns the balance amount.
 */
export async function check2CaptchaBalance() {
  if (!config.twoCaptchaApiKey) {
    console.log(chalk.dim(`  → 2Captcha: No API key configured, auto-solve disabled`));
    return null;
  }

  try {
    const data = await apiRequest('getBalance', {
      clientKey: config.twoCaptchaApiKey,
    });

    if (data.errorId && data.errorId !== 0) {
      console.log(chalk.red(`  ✗ 2Captcha balance check failed: ${data.errorDescription || data.errorCode || 'Unknown error'}`));
      return null;
    }

    const balance = data.balance;

    if (balance <= 0) {
      console.log(chalk.red.bold(`  ✗ 2Captcha balance is ZERO ($${balance}). Cannot solve CAPTCHAs automatically!`));
      throw new Error(`2Captcha balance is depleted ($${balance}). Please add funds at https://2captcha.com/pay`);
    }

    if (balance < 1) {
      console.log(chalk.yellow.bold(`  ⚠ 2Captcha balance is LOW: $${balance.toFixed(4)}. Consider adding funds soon.`));
    } else {
      console.log(chalk.green(`  ✓ 2Captcha balance: $${balance.toFixed(4)}`));
    }

    return balance;
  } catch (err) {
    if (err.message.includes('balance is depleted')) throw err;
    console.log(chalk.red(`  ✗ 2Captcha balance check error: ${err.message}`));
    return null;
  }
}

// ─── Extract Cookies from Page ──────────────────────────────

/**
 * Extract cookies from the current browser page context.
 * Returns cookies formatted as "key=val; key2=val2" for 2Captcha API.
 */
async function extractCookies(page) {
  try {
    const context = page.context();
    const cookies = await context.cookies();
    if (cookies && cookies.length > 0) {
      // Filter to Google-related cookies and format them
      const googleCookies = cookies.filter(c =>
        c.domain.includes('google') || c.domain.includes('.google.')
      );
      if (googleCookies.length > 0) {
        return googleCookies.map(c => `${c.name}=${c.value}`).join('; ');
      }
    }
  } catch (err) {
    // Non-fatal — cookies are optional for solving
    console.log(chalk.dim(`    → Could not extract cookies: ${err.message}`));
  }
  return null;
}

// ─── Extract reCAPTCHA Parameters from Page ─────────────────

/**
 * Extract reCAPTCHA v2 parameters from the current page.
 * Google Search uses a special `data-s` parameter that must be
 * obtained fresh for each solve attempt (it's single-use).
 *
 * Returns: { siteKey, dataS, pageUrl } or null if not found
 */
async function extractRecaptchaParams(page) {
  try {
    const params = await page.evaluate(() => {
      // Method 1: Look for the reCAPTCHA div with data-sitekey
      const recaptchaDiv = document.querySelector('.g-recaptcha, [data-sitekey]');
      if (recaptchaDiv) {
        return {
          siteKey: recaptchaDiv.getAttribute('data-sitekey'),
          dataS: recaptchaDiv.getAttribute('data-s') || null,
          pageUrl: window.location.href,
        };
      }

      // Method 2: Look for reCAPTCHA iframe and extract sitekey from its src
      const iframes = document.querySelectorAll('iframe[src*="recaptcha"]');
      for (const iframe of iframes) {
        const src = iframe.src || '';
        const siteKeyMatch = src.match(/[?&]k=([^&]+)/);
        if (siteKeyMatch) {
          // Try to find data-s from a nearby element or the page
          const parentDiv = iframe.closest('[data-s]') || document.querySelector('[data-s]');
          return {
            siteKey: siteKeyMatch[1],
            dataS: parentDiv?.getAttribute('data-s') || null,
            pageUrl: window.location.href,
          };
        }
      }

      // Method 3: Search for sitekey in script tags (Google embeds it)
      const scripts = document.querySelectorAll('script');
      for (const script of scripts) {
        const text = script.textContent || '';
        const keyMatch = text.match(/['"]sitekey['"]\s*:\s*['"]([^'"]+)['"]/);
        if (keyMatch) {
          return {
            siteKey: keyMatch[1],
            dataS: null,
            pageUrl: window.location.href,
          };
        }
      }

      // Method 4: Google's "unusual traffic" page — the form contains a hidden recaptcha
      const form = document.querySelector('#captcha-form, form[action*="sorry"]');
      if (form) {
        // Google often has the sitekey on the recaptcha div or inlined
        const gRecaptcha = form.querySelector('.g-recaptcha');
        if (gRecaptcha) {
          return {
            siteKey: gRecaptcha.getAttribute('data-sitekey'),
            dataS: gRecaptcha.getAttribute('data-s') || null,
            pageUrl: window.location.href,
          };
        }
      }

      return null;
    });

    return params;
  } catch (err) {
    if (err.message.includes('Execution context was destroyed') || err.message.includes('Target closed')) {
      return null;
    }
    throw err;
  }
}

// ─── Solve reCAPTCHA v2 via 2Captcha ────────────────────────

/**
 * Submit a reCAPTCHA v2 task to 2Captcha and wait for the solution.
 *
 * @param {string} siteKey - The reCAPTCHA sitekey
 * @param {string} pageUrl - The URL of the page showing the captcha
 * @param {string|null} dataS - The data-s parameter (Google Search specific)
 * @param {string|null} cookies - Browser cookies formatted as "key=val; key2=val2"
 * @returns {{ token: string, taskId: number }|null} - The solution token and taskId, or null on failure
 */
async function solveRecaptchaV2(siteKey, pageUrl, dataS = null, cookies = null, proxyStr = null) {
  console.log(chalk.blue(`  🤖 Sending reCAPTCHA to 2Captcha for solving...`));
  console.log(chalk.dim(`    → Site key: ${siteKey}`));
  console.log(chalk.dim(`    → Page URL: ${pageUrl.substring(0, 80)}`));
  if (dataS) {
    console.log(chalk.dim(`    → data-s: ${dataS.substring(0, 40)}...`));
  }
  if (cookies) {
    console.log(chalk.dim(`    → Cookies: ${cookies.substring(0, 60)}...`));
  }

  // Build the task payload
  const task = {
    type: proxyStr ? 'RecaptchaV2Task' : 'RecaptchaV2TaskProxyless',
    websiteURL: pageUrl,
    websiteKey: siteKey,
    isInvisible: false,
  };

  // If using a proxy, we must pass it to 2Captcha to avoid Google IP mismatch errors (especially with data-s)
  if (proxyStr) {
    try {
      const url = new URL(proxyStr);
      task.proxyType = url.protocol.replace(':', '');
      task.proxyAddress = url.hostname;
      task.proxyPort = url.port || (task.proxyType === 'https' ? '443' : '80');
      if (url.username && url.password) {
        task.proxyLogin = decodeURIComponent(url.username);
        task.proxyPassword = decodeURIComponent(url.password);
      }
      console.log(chalk.dim(`    → Proxy: ${task.proxyAddress}:${task.proxyPort} provided to solver`));
    } catch {
      // Invalid proxy string — fallback to proxyless
      task.type = 'RecaptchaV2TaskProxyless';
    }
  }

  // Google Search reCAPTCHA uses the data-s parameter
  if (dataS) {
    task.dataS = dataS;
  }

  // For Google pages, set the apiDomain to improve success rate
  if (pageUrl.includes('google.com') || pageUrl.includes('google.co.')) {
    task.apiDomain = 'google.com';
  }

  // Pass cookies if available — helps with Google Search captchas
  if (cookies) {
    task.cookies = cookies;
  }

  // Step 1: Create the task
  const createResponse = await apiRequest('createTask', {
    clientKey: config.twoCaptchaApiKey,
    task,
  });

  if (createResponse.errorId && createResponse.errorId !== 0) {
    const errorMsg = createResponse.errorDescription || createResponse.errorCode;
    console.log(chalk.red(`  ✗ 2Captcha task creation failed: ${errorMsg}`));

    // ERROR_CAPTCHA_UNSOLVABLE is common with data-s (single-use)
    if (createResponse.errorCode === 'ERROR_CAPTCHA_UNSOLVABLE') {
      console.log(chalk.yellow(`    → data-s token was likely expired/used. Will retry with fresh token.`));
    }
    return null;
  }

  const taskId = createResponse.taskId;
  console.log(chalk.dim(`    → Task created: ID ${taskId}`));

  // Step 2: Poll for the result (max ~3 minutes)
  const maxPolls = 36; // 36 * 5s = 180s = 3 minutes
  const pollInterval = 5000;

  for (let attempt = 1; attempt <= maxPolls; attempt++) {
    await sleep(pollInterval);

    const resultResponse = await apiRequest('getTaskResult', {
      clientKey: config.twoCaptchaApiKey,
      taskId,
    });

    if (resultResponse.errorId && resultResponse.errorId !== 0) {
      const errorMsg = resultResponse.errorDescription || resultResponse.errorCode;
      console.log(chalk.red(`  ✗ 2Captcha error: ${errorMsg}`));

      // ERROR_CAPTCHA_UNSOLVABLE means this data-s was bad — stop polling, retry fresh
      if (resultResponse.errorCode === 'ERROR_CAPTCHA_UNSOLVABLE') {
        console.log(chalk.yellow(`    → Captcha unsolvable with this data-s. Will need fresh token.`));
        return null;
      }
      return null;
    }

    if (resultResponse.status === 'ready') {
      const token = resultResponse.solution?.gRecaptchaResponse || resultResponse.solution?.token;
      if (token) {
        console.log(chalk.green(`  ✓ reCAPTCHA solved by 2Captcha! (${attempt * 5}s)`));
        console.log(chalk.dim(`    → Token: ${token.substring(0, 40)}...`));
        return { token, taskId };
      }
      console.log(chalk.red(`  ✗ 2Captcha returned ready but no token found`));
      return null;
    }

    if (attempt % 4 === 0) {
      console.log(chalk.dim(`    → Waiting for solution... (${attempt * 5}s)`));
    }
  }

  console.log(chalk.red(`  ✗ 2Captcha timed out after 3 minutes`));
  return null;
}

// ─── Report Incorrect Solution ──────────────────────────────

/**
 * Report an incorrect solution to 2Captcha (for refund).
 * Call this when the token was injected but the captcha wasn't actually solved.
 */
async function reportIncorrect(taskId) {
  try {
    await apiRequest('reportIncorrect', {
      clientKey: config.twoCaptchaApiKey,
      taskId,
    });
    console.log(chalk.dim(`    → Reported incorrect solution (task ${taskId}) for refund`));
  } catch {
    // Non-fatal
  }
}

// ─── Inject Solution into Page ──────────────────────────────

/**
 * Inject the solved reCAPTCHA token into the page and submit the form.
 * Google's reCAPTCHA pages have a textarea#g-recaptcha-response and
 * a form that needs to be submitted.
 *
 * @param {Page} page - Playwright page
 * @param {string} token - The g-recaptcha-response token
 * @returns {boolean} - Whether the injection + submission succeeded
 */
async function injectRecaptchaToken(page, token) {
  console.log(chalk.dim(`  → Injecting reCAPTCHA solution token into page...`));

  try {
    const injected = await page.evaluate((solvedToken) => {
      // Set the g-recaptcha-response textarea value
      const responseTextarea = document.querySelector('#g-recaptcha-response, textarea[name="g-recaptcha-response"]');
      if (responseTextarea) {
        responseTextarea.value = solvedToken;
        responseTextarea.style.display = 'block'; // Make visible for debugging
      }

      // Also try setting via the reCAPTCHA callback (if defined)
      // Google pages sometimes use ___grecaptcha_cfg.clients
      try {
        if (typeof window.___grecaptcha_cfg !== 'undefined') {
          const clients = window.___grecaptcha_cfg.clients;
          if (clients) {
            for (const clientKey in clients) {
              const client = clients[clientKey];
              // Traverse the client object to find the callback
              const traverse = (obj, depth = 0) => {
                if (depth > 5 || !obj || typeof obj !== 'object') return;
                for (const key in obj) {
                  if (typeof obj[key] === 'function' && key.toLowerCase().includes('callback')) {
                    try { obj[key](solvedToken); } catch {}
                  }
                  if (typeof obj[key] === 'object') {
                    traverse(obj[key], depth + 1);
                  }
                }
              };
              traverse(client);
            }
          }
        }
      } catch {}

      // Submit the captcha form
      const captchaForm = document.querySelector('#captcha-form, form[action*="sorry"], form');
      if (captchaForm && responseTextarea) {
        return { found: true, hasForm: true };
      }

      return { found: !!responseTextarea, hasForm: false };
    }, token);

    if (!injected.found) {
      console.log(chalk.yellow(`  ⚠ Could not find g-recaptcha-response textarea on page`));
      return false;
    }

    // Submit the form after a brief human-like delay
    await sleep(500, 1500);

    if (injected.hasForm) {
      console.log(chalk.dim(`  → Submitting captcha form...`));
      await page.evaluate(() => {
        const form = document.querySelector('#captcha-form, form[action*="sorry"], form');
        if (form) {
          form.submit();
        }
      });
    }

    // Wait for navigation after form submission
    try {
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 });
    } catch {
      // Navigation might not trigger if using callback approach
    }

    console.log(chalk.green(`  ✓ reCAPTCHA token injected and form submitted!`));
    return true;
  } catch (err) {
    if (err.message.includes('Execution context was destroyed') || err.message.includes('Target closed')) {
      // Page navigated away — likely success
      console.log(chalk.green(`  ✓ Page navigated after token injection (likely solved)!`));
      return true;
    }
    console.log(chalk.red(`  ✗ Token injection error: ${err.message}`));
    return false;
  }
}

// ─── Main Auto-Solve Entry Point ────────────────────────────

/**
 * Automatically solve a reCAPTCHA v2 on the current page using 2Captcha.
 * This is the main function called from the click-engine.
 *
 * Flow:
 * 1. Extract reCAPTCHA parameters (sitekey, data-s, page URL)
 * 2. Extract browser cookies for Google
 * 3. Send to 2Captcha API
 * 4. Wait for solution
 * 5. Inject token + submit form
 * 6. Verify CAPTCHA is gone
 *
 * @param {Page} page - Playwright page instance
 * @param {number} maxRetries - Maximum number of solve attempts (default: 3)
 * @returns {boolean} - true if solved, false if failed
 */
export async function autoSolveRecaptcha(page, maxRetries = 3) {
  if (!config.twoCaptchaApiKey) {
    console.log(chalk.dim(`  → 2Captcha auto-solve: No API key, falling back to manual`));
    return false;
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (attempt > 1) {
      console.log(chalk.yellow(`  → reCAPTCHA solve retry ${attempt}/${maxRetries}...`));
    }

    // Allow time for Google's captcha iframe/div to fully render before extracting
    await sleep(2000, 3000);
    try {
      await page.waitForSelector('.g-recaptcha, iframe[src*="recaptcha"], #captcha-form', { timeout: 10000 });
    } catch {
      // It might not match the exact selector, we'll still try to extract below
    }

    // Step 1: Extract reCAPTCHA parameters from the page
    // (Must be done fresh each attempt because data-s is single-use)
    const params = await extractRecaptchaParams(page);

    if (!params || !params.siteKey) {
      console.log(chalk.yellow(`  ⚠ Could not extract reCAPTCHA parameters from page`));
      if (attempt < maxRetries) {
        await sleep(2000, 3000);
        continue;
      }
      return false;
    }

    // Step 1b: Extract cookies and raw proxy from browser context
    const cookies = await extractCookies(page);
    const proxyStr = page.rawProxyUrl || null;

    if (config.showProxyIp && proxyStr) {
      try {
        const captchaIp = await page.evaluate(async () => {
          try {
            const res = await fetch('https://api.ipify.org?format=json');
            if (res.ok) {
              const data = await res.json();
              return data.ip;
            }
          } catch (e) {}
          return null;
        });
        if (captchaIp) {
          console.log(chalk.magenta(`  → Current Page IP at CAPTCHA: ${captchaIp}`));
        }
      } catch (err) {}
    }

    // Step 2: Solve via 2Captcha
    const result = await solveRecaptchaV2(params.siteKey, params.pageUrl, params.dataS, cookies, proxyStr);

    if (!result) {
      if (attempt < maxRetries) {
        console.log(chalk.yellow(`  → Solve failed, will retry with fresh data-s...`));

        // For Google Search, we need to reload to get a fresh data-s value
        if (params.dataS) {
          console.log(chalk.dim(`  → Reloading page for fresh data-s token...`));
          try {
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
            await sleep(2000, 3000);
          } catch {
            // Reload might fail but we can still retry
          }
        }
        continue;
      }
      return false;
    }

    // Step 3: Inject token and submit
    const success = await injectRecaptchaToken(page, result.token);

    if (!success) {
      // Report incorrect so we get a refund for the failed solve
      await reportIncorrect(result.taskId);
      if (attempt < maxRetries) {
        continue;
      }
      return false;
    }

    // Step 4: Wait and verify the CAPTCHA is gone
    await sleep(2000, 3000);

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
        console.log(chalk.green(`  ✓ reCAPTCHA successfully auto-solved! Page is clear.`));
        return true;
      }

      console.log(chalk.yellow(`  ⚠ CAPTCHA still present after token injection (attempt ${attempt})`));

      // Report incorrect for refund since the solve didn't actually work
      await reportIncorrect(result.taskId);

      // Reload to get fresh data-s for retry
      if (attempt < maxRetries && params.dataS) {
        console.log(chalk.dim(`  → Reloading for fresh data-s...`));
        try {
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
          await sleep(2000, 3000);
        } catch {
          // Reload might fail
        }
      }
    } catch (err) {
      if (err.message.includes('Execution context was destroyed') || err.message.includes('Target closed')) {
        // Page navigated — likely success
        console.log(chalk.green(`  ✓ Page navigated — reCAPTCHA likely solved!`));
        return true;
      }
    }
  }

  console.log(chalk.red(`  ✗ Failed to auto-solve reCAPTCHA after ${maxRetries} attempts`));
  return false;
}
