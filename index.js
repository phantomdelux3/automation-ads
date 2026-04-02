import { runSession } from './src/click-engine.js';
import { sleep, gaussianDelay } from './src/human-behavior.js';
import config from './config.js';
import chalk from 'chalk';

/**
 * Main entry point
 * Loops over keywords × sessions, searching Google and clicking matching sponsored ads
 */
async function main() {
  console.log(chalk.bold.magenta(`
╔══════════════════════════════════════════════════════╗
║   Keyword Ad Click Tool v2.0                        ║
║   Google Search → Sponsored Ad → Natural Browse     ║
╚══════════════════════════════════════════════════════╝
  `));

  console.log(chalk.white(`Configuration:`));
  console.log(chalk.dim(`  Keywords:        ${config.keywords.join(', ')}`));
  console.log(chalk.dim(`  Target Domains:  ${config.targetDomains.join(', ')}`));
  console.log(chalk.dim(`  Sessions/KW:     ${config.sessionsPerKeyword}`));
  console.log(chalk.dim(`  Sponsored Only:  ${config.sponsoredOnly ? 'yes (ads only)' : 'no (ads + organic)'}`));
  console.log(chalk.dim(`  Cookie Warmup:   ${config.cookieWarmup ? 'enabled' : 'disabled'}`));
  console.log(chalk.dim(`  Search History:  ${config.searchHistory ? config.searchHistoryCount + ' sites per session' : 'disabled'}`));
  console.log(chalk.dim(`  Headless:        ${config.headless}`));
  console.log(chalk.dim(`  Browse Time:     ${config.siteBrowseMin}s - ${config.siteBrowseMax}s`));
  console.log(chalk.dim(`  Internal Pages:  ${config.internalPagesMin} - ${config.internalPagesMax}`));
  console.log(chalk.dim(`  Proxies:         ${config.proxies.length > 0 ? config.proxies.length + ' configured' : 'none (direct)'}`));

  // SETUP PROFILES
  if (config.loginEmail && config.accounts && config.accounts.length > 0) {
    console.log(chalk.bold.yellow(`\n══════════════════════════════════════════════════════`));
    console.log(chalk.bold.yellow(`  Initializing Unmade Browser Profiles`));
    console.log(chalk.bold.yellow(`══════════════════════════════════════════════════════`));
    
    const fs = await import('fs');
    const path = await import('path');
    const { launchBrowser } = await import('./src/browser.js');

    for (const account of config.accounts) {
      const profileDirName = account.email.replace(/[^a-z0-9@.-]+/gi, '_');
      const profileDir = path.join(process.cwd(), 'chrome-profiles', profileDirName);
      const successFile = path.join(profileDir, 'LOGIN_SUCCESS.txt');
      
      if (!fs.existsSync(successFile)) {
        console.log(chalk.cyan(`\n  → Setting up profile for: ${account.email}`));
        try {
          const result = await launchBrowser(0, account, true);
          if (result && result.context) {
            await result.context.close();
            console.log(chalk.green(`  ✓ Profile setup complete for ${account.email}`));
          }
        } catch (e) {
          console.log(chalk.red(`  ⚠ Error setting up profile for ${account.email}: ${e.message}`));
        }
      } else {
        console.log(chalk.dim(`  ✓ Profile for ${account.email} already exists and is logged in.`));
      }
    }
    console.log(chalk.bold.green(`\n[Setup] Browser profile initialization complete.\n`));
  }

  const startTime = Date.now();
  let totalSessions = 0;
  let successCount = 0;
  let failCount = 0;

  // Loop over each keyword
  for (let kwIdx = 0; kwIdx < config.keywords.length; kwIdx++) {
    const keyword = config.keywords[kwIdx];

    console.log(chalk.bold.blue(`\n══════════════════════════════════════════════════════`));
    console.log(chalk.bold.blue(`  Keyword ${kwIdx + 1}/${config.keywords.length}: "${keyword}"`));
    console.log(chalk.bold.blue(`══════════════════════════════════════════════════════`));

    // Run N sessions for this keyword
    for (let sess = 1; sess <= config.sessionsPerKeyword; sess++) {
      totalSessions++;
      const sessionLabel = `K${kwIdx + 1}S${sess}`;

      const success = await runSession(sessionLabel, keyword);

      if (success) {
        successCount++;
      } else {
        failCount++;
      }

      // Random delay between sessions (skip after the very last one)
      const isLast = kwIdx === config.keywords.length - 1 && sess === config.sessionsPerKeyword;
      if (!isLast) {
        const delay = gaussianDelay(
          (config.minDelay + config.maxDelay) / 2,
          (config.maxDelay - config.minDelay) / 4
        );
        console.log(chalk.dim(`\n  ⏳ Waiting ${(delay / 1000).toFixed(1)}s before next session...\n`));
        await sleep(delay);
      }
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(chalk.bold.magenta(`
╔══════════════════════════════════════════════════════╗
║                    Results                           ║
╠══════════════════════════════════════════════════════╣
║  Keywords:          ${String(config.keywords.length).padEnd(32)}║
║  Total Sessions:    ${String(totalSessions).padEnd(32)}║
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
