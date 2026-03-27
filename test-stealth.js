/**
 * Test script to verify CloakBrowser stealth passes bot detection
 * Run: node test-stealth.js
 *
 * Opens bot.sannysoft.com to check detection results
 */
import { launchBrowser } from './src/browser.js';
import { humanScroll, sleep } from './src/human-behavior.js';
import chalk from 'chalk';

async function testStealth() {
  console.log(chalk.bold.cyan('\n🔍 CloakBrowser Stealth Detection Test\n'));
  console.log(chalk.dim('Opening bot detection test page...\n'));

  const { context, page, timezone, locale } = await launchBrowser();

  const size = page.viewportSize();
  console.log(chalk.dim(`  TZ: ${timezone}`));
  console.log(chalk.dim(`  Locale: ${locale}`));
  console.log(chalk.dim(`  Viewport: ${size.width}x${size.height}\n`));

  // Navigate to bot detection test
  await page.goto('https://bot.sannysoft.com/', {
    waitUntil: 'networkidle',
    timeout: 30000,
  });

  console.log(chalk.green('✓ Page loaded. Waiting for tests to complete...'));
  await sleep(5000);

  // Simulate some human actions while on the page
  await humanScroll(page);
  await sleep(2000);

  // Take a screenshot for review
  const screenshotPath = './stealth-test-result.png';
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log(chalk.green(`\n✓ Screenshot saved: ${screenshotPath}`));

  // Extract test results
  const results = await page.evaluate(() => {
    const rows = document.querySelectorAll('table tr');
    const data = [];
    rows.forEach((row) => {
      const cells = row.querySelectorAll('td');
      if (cells.length >= 2) {
        data.push({
          test: cells[0]?.textContent?.trim(),
          result: cells[1]?.textContent?.trim(),
        });
      }
    });
    return data;
  });

  if (results.length > 0) {
    console.log(chalk.bold('\n📊 Detection Test Results:\n'));
    results.forEach(({ test, result }) => {
      const icon = result?.toLowerCase().includes('missing') ||
                   result?.toLowerCase().includes('failed')
        ? chalk.red('✗')
        : chalk.green('✓');
      console.log(`  ${icon} ${test}: ${result}`);
    });
  }

  console.log(chalk.dim('\nBrowser will stay open for 15 seconds for manual inspection...'));
  await sleep(15000);

  await context.close();
  console.log(chalk.cyan('\n✓ Test complete.\n'));
}

testStealth().catch((err) => {
  console.error(chalk.red(`Error: ${err.message}`));
  process.exit(1);
});
