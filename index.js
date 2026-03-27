import { runSession } from './src/click-engine.js';
import { sleep, gaussianDelay } from './src/human-behavior.js';
import config from './config.js';
import chalk from 'chalk';

/**
 * Main entry point
 * Runs multiple click sessions with randomized delays between them
 */
async function main() {
  console.log(chalk.bold.magenta(`
╔══════════════════════════════════════════════════════╗
║       Ad Platform Click Testing Tool v1.0            ║
║       For internal QA & fraud detection testing      ║
╚══════════════════════════════════════════════════════╝
  `));

  console.log(chalk.white(`Configuration:`));
  console.log(chalk.dim(`  Target URL:    ${config.targetUrl}`));
  console.log(chalk.dim(`  Ad Selector:   ${config.adSelector}`));
  console.log(chalk.dim(`  Sessions:      ${config.clickCount}`));
  console.log(chalk.dim(`  Headless:      ${config.headless}`));
  console.log(chalk.dim(`  Delay Range:   ${config.minDelay}ms - ${config.maxDelay}ms`));
  console.log(chalk.dim(`  Proxies:       ${config.proxies.length > 0 ? config.proxies.length + ' configured' : 'none (direct)'}`));

  const startTime = Date.now();
  let successCount = 0;
  let failCount = 0;

  for (let i = 1; i <= config.clickCount; i++) {
    const success = await runSession(i);

    if (success) {
      successCount++;
    } else {
      failCount++;
    }

    // Random delay between sessions (skip after last session)
    if (i < config.clickCount) {
      const delay = gaussianDelay(
        (config.minDelay + config.maxDelay) / 2,
        (config.maxDelay - config.minDelay) / 4
      );
      console.log(chalk.dim(`\n  ⏳ Waiting ${(delay / 1000).toFixed(1)}s before next session...\n`));
      await sleep(delay);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(chalk.bold.magenta(`
╔══════════════════════════════════════════════════════╗
║                    Results                           ║
╠══════════════════════════════════════════════════════╣
║  Total Sessions:    ${String(config.clickCount).padEnd(32)}║
║  Successful:        ${chalk.green(String(successCount).padEnd(32))}║
║  Failed:            ${chalk.red(String(failCount).padEnd(32))}║
║  Elapsed Time:      ${String(elapsed + 's').padEnd(32)}║
╚══════════════════════════════════════════════════════╝
  `));
}

main().catch((err) => {
  console.error(chalk.red(`Fatal error: ${err.message}`));
  console.error(err.stack);
  process.exit(1);
});
