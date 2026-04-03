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

  const globalStats = {
    totalSessions: 0,
    successes: 0,
    failures: 0,
    targetClicks: 0,
    // Map<keyword, { sponsored: number, targets: number }>
    keywordData: new Map(),
  };

  const startTime = Date.now();

  const reportInterval = setInterval(() => {
    // Derive counts from keywordData for the table header
    const kwsWithSponsored = [...globalStats.keywordData.values()].filter(d => d.sponsored > 0).length;
    const kwsWithTarget = [...globalStats.keywordData.values()].filter(d => d.targets > 0).length;
    console.log(chalk.bold.magenta(`
╔══════════════════════════════════════════════════════╗
║               Live Progress Report                   ║
╠══════════════════════════════════════════════════════╣
║ Total Sessions Run:   ${String(globalStats.totalSessions).padEnd(31)}║
║ Successful Clicks:    ${chalk.green(String(globalStats.successes).padEnd(31))}║
║ Failed Sessions:      ${chalk.red(String(globalStats.failures).padEnd(31))}║
║ Target Clicks Made:   ${chalk.cyan(String(globalStats.targetClicks).padEnd(31))}║
║ KWs w/ Sponsored Ads: ${String(kwsWithSponsored).padEnd(31)}║
║ KWs w/ Target Domain: ${String(kwsWithTarget).padEnd(31)}║
╚══════════════════════════════════════════════════════╝
    `));
    const sponsoredKws = [...globalStats.keywordData.entries()].filter(([,d]) => d.sponsored > 0);
    const targetKws    = [...globalStats.keywordData.entries()].filter(([,d]) => d.targets > 0);
    if (sponsoredKws.length > 0) {
      console.log(chalk.yellow(`  Ads Found For:`));
      sponsoredKws.forEach(([kw, d]) => console.log(chalk.dim(`    • "${kw}" — ${d.sponsored} sponsored ad(s)`)));
    }
    if (targetKws.length > 0) {
      console.log(chalk.green(`  Targets Found For:`));
      targetKws.forEach(([kw, d]) => console.log(chalk.dim(`    • "${kw}" — ${d.targets} target link(s)`)));
    }
  }, 60000);

  let loopCount = 1;

  do {
    if (config.loopBot) {
      console.log(chalk.bold.yellow(`\n══════════════════════════════════════════════════════`));
      console.log(chalk.bold.yellow(`  Starting Loop Iteration #${loopCount}`));
      console.log(chalk.bold.yellow(`══════════════════════════════════════════════════════`));
    }

    // Loop over each keyword
    for (let kwIdx = 0; kwIdx < config.keywords.length; kwIdx++) {
      const keyword = config.keywords[kwIdx];

      console.log(chalk.bold.blue(`\n══════════════════════════════════════════════════════`));
      console.log(chalk.bold.blue(`  Keyword ${kwIdx + 1}/${config.keywords.length}: "${keyword}"`));
      console.log(chalk.bold.blue(`══════════════════════════════════════════════════════`));

      // Run N sessions for this keyword
      for (let sess = 1; sess <= config.sessionsPerKeyword; sess++) {
        globalStats.totalSessions++;
        const sessionLabel = `K${kwIdx + 1}S${sess}`;

        const stats = await runSession(sessionLabel, keyword);

        if (stats) {
          if (stats.success) {
            globalStats.successes++;
          } else {
            globalStats.failures++;
          }
          if (stats.clickedTargets > 0) {
            globalStats.targetClicks += stats.clickedTargets;
          }
          // Accumulate per-keyword data
          const existing = globalStats.keywordData.get(keyword) || { sponsored: 0, targets: 0 };
          if (stats.hasSponsored) {
            existing.sponsored = Math.max(existing.sponsored, stats.sponsoredCount || 0);
          }
          if (stats.hasTargetDomain) {
            existing.targets = Math.max(existing.targets, stats.targetCount || 0);
          }
          globalStats.keywordData.set(keyword, existing);
        } else {
          globalStats.failures++;
        }

        // Random delay between sessions (skip after the very last one if not looping)
        const isLastSession = kwIdx === config.keywords.length - 1 && sess === config.sessionsPerKeyword;
        if (config.loopBot || !isLastSession) {
          const delay = gaussianDelay(
            (config.minDelay + config.maxDelay) / 2,
            (config.maxDelay - config.minDelay) / 4
          );
          console.log(chalk.dim(`\n  ⏳ Waiting ${(delay / 1000).toFixed(1)}s before next session...\n`));
          await sleep(delay);
        }
      }
    }
    
    loopCount++;
  } while (config.loopBot);

  clearInterval(reportInterval);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  const kwsWithSponsored = [...globalStats.keywordData.values()].filter(d => d.sponsored > 0).length;
  const kwsWithTarget    = [...globalStats.keywordData.values()].filter(d => d.targets > 0).length;

  console.log(chalk.bold.magenta(`
╔══════════════════════════════════════════════════════╗
║                    Final Results                     ║
╠══════════════════════════════════════════════════════╣
║ Keywords:             ${String(config.keywords.length).padEnd(31)}║
║ Total Sessions:       ${String(globalStats.totalSessions).padEnd(31)}║
║ Successful Clicks:    ${chalk.green(String(globalStats.successes).padEnd(31))}║
║ Failed Sessions:      ${chalk.red(String(globalStats.failures).padEnd(31))}║
║ Target Clicks Made:   ${chalk.cyan(String(globalStats.targetClicks).padEnd(31))}║
║ Elapsed Time:         ${String(elapsed + 's').padEnd(31)}║
║ KWs w/ Sponsored Ads: ${String(kwsWithSponsored).padEnd(31)}║
║ KWs w/ Target Domain: ${String(kwsWithTarget).padEnd(31)}║
╚══════════════════════════════════════════════════════╝
  `));

  const sponsoredKws = [...globalStats.keywordData.entries()].filter(([,d]) => d.sponsored > 0);
  const targetKws    = [...globalStats.keywordData.entries()].filter(([,d]) => d.targets > 0);

  if (sponsoredKws.length > 0) {
    console.log(chalk.yellow(`\n[Keywords with Sponsored Ads]:`));
    sponsoredKws.forEach(([kw, d]) => console.log(chalk.dim(`  • "${kw}" — ${d.sponsored} sponsored ad(s)`)));
  }

  if (targetKws.length > 0) {
    console.log(chalk.green(`\n[Keywords with Target Domain Found]:`));
    targetKws.forEach(([kw, d]) => console.log(chalk.dim(`  • "${kw}" — ${d.targets} target link(s) found`)));
  }
}

main().catch((err) => {
  console.error(chalk.red(`Fatal error: ${err.message}`));
  console.error(err.stack);
  process.exit(1);
});
