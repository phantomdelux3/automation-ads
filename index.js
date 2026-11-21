import { runSession } from './src/click-engine.js';
import { check2CaptchaBalance } from './src/captcha-solver.js';
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
  console.log(chalk.dim(`  2Captcha:        ${config.twoCaptchaApiKey ? 'configured' : 'not configured (manual solve only)'}`));

  // ── 2Captcha Balance Check ──
  if (config.twoCaptchaApiKey) {
    console.log(chalk.bold.blue(`\n══════════════════════════════════════════════════════`));
    console.log(chalk.bold.blue(`  Checking 2Captcha Balance`));
    console.log(chalk.bold.blue(`══════════════════════════════════════════════════════`));
    try {
      await check2CaptchaBalance();
    } catch (err) {
      // Balance is zero — fatal error, cannot auto-solve
      console.log(chalk.red.bold(`\n  ✗ ${err.message}`));
      console.log(chalk.red(`  Cannot proceed with auto-solve. Add funds or remove 2CAPTCHA_API_KEY to use manual mode.\n`));
      process.exit(1);
    }
  }

  // SETUP PROFILES
  if (config.loginEmail && config.accounts && config.accounts.length > 0) {
    console.log(chalk.bold.yellow(`\n══════════════════════════════════════════════════════`));
    console.log(chalk.bold.yellow(`  Initializing Unmade Browser Profiles`));
    console.log(chalk.bold.yellow(`══════════════════════════════════════════════════════`));
    
    const fs = await import('fs');
    const path = await import('path');
    const { launchBrowser } = await import('./src/browser.js');
    const { profileDirNameFor, profileDirFor } = await import('./src/profile-identity.js');
    const { warmupProfile } = await import('./src/warmup.js');

    for (const account of config.accounts) {
      const profileDirName = profileDirNameFor(account.email);
      const profileDir = profileDirFor(profileDirName);
      const successFile = path.join(profileDir, 'LOGIN_SUCCESS.txt');
      
      const needsLogin = !fs.existsSync(successFile);
      const needsWarmup = config.cookieWarmup;

      if (needsLogin || needsWarmup) {
        console.log(chalk.cyan(`\n  → Setting up/warming up profile for: ${account.email}`));
        try {
          const result = await launchBrowser(0, account, true);
          if (result && result.context && result.page) {
            if (needsWarmup) {
              await warmupProfile(result.page, result.context, { rounds: 1, label: account.email });
            }
            await result.context.close();
            console.log(chalk.green(`  ✓ Profile setup/warmup complete for ${account.email}`));
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

  const fs = await import('fs');
  const path = await import('path');

  const historyFile = path.join(process.cwd(), 'history.json');
  let runHistory = [];
  if (fs.existsSync(historyFile)) {
    try { runHistory = JSON.parse(fs.readFileSync(historyFile, 'utf8')); } catch(e){}
  }

  const globalStats = {
    timestamp: new Date().toISOString(),
    totalSessions: 0,
    successes: 0,
    failures: 0,
    targetClicks: 0,
    keywordData: new Map(),
  };

  const startTime = Date.now();
  const MAX_RUNS = 20;
  const runId = `run_${startTime}`;
  const sessions = [];
  let runStatus = 'running';
  let currentLoop = 1;
  let currentSession = null;
  // Keep the newest N session records per run; totals and keyword stats still cover every session.
  const MAX_SESSIONS_PER_RUN = 500;
  let sessionsDropped = 0;

  const runConfig = {
    keywords: config.keywords,
    targetDomains: config.targetDomains,
    sessionsPerKeyword: config.sessionsPerKeyword,
    sponsoredOnly: config.sponsoredOnly,
    loopBot: config.loopBot,
    cookieWarmup: config.cookieWarmup,
    searchHistory: config.searchHistory,
    headless: config.headless,
    proxies: config.proxies.length,
    accounts: config.accounts ? config.accounts.length : 0,
  };

  function buildRunRecord() {
    return {
      id: runId,
      timestamp: globalStats.timestamp,
      lastUpdate: new Date().toISOString(),
      status: runStatus,
      loop: currentLoop,
      elapsed: ((Date.now() - startTime) / 1000).toFixed(1),
      totalSessions: globalStats.totalSessions,
      successes: globalStats.successes,
      failures: globalStats.failures,
      targetClicks: globalStats.targetClicks,
      config: runConfig,
      currentSession,
      keywordData: Object.fromEntries(globalStats.keywordData),
      sessions,
      sessionsDropped,
    };
  }

  // History is best-effort: a failed write must never crash or abort the bot.
  function saveHistory() {
    try {
      // Re-read so we don't clobber runs written by another bot process.
      // Only a missing file means "no history" - any other read/parse error
      // falls back to what we already have in memory, so old runs are never wiped.
      let onDisk = runHistory;
      try {
        const parsed = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
        if (Array.isArray(parsed)) onDisk = parsed;
      } catch (e) {
        if (e.code === 'ENOENT') onDisk = [];
      }
      const others = onDisk.filter(r => r && r.id !== runId);
      const all = [buildRunRecord(), ...others]
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
        .slice(0, MAX_RUNS);
      const json = JSON.stringify(all);

      // Write to a temp file then rename, so readers never see a half-written file.
      // On Windows the rename can fail briefly while the dashboard is reading
      // the file, so retry a few times before falling back to a direct write.
      const tmp = `${historyFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, json);
      let renamed = false;
      for (let attempt = 0; attempt < 5 && !renamed; attempt++) {
        try { fs.renameSync(tmp, historyFile); renamed = true; }
        catch (e) { const until = Date.now() + 50; while (Date.now() < until) { /* brief wait */ } }
      }
      if (!renamed) {
        fs.writeFileSync(historyFile, json);
        try { fs.unlinkSync(tmp); } catch (e) {}
      }
      runHistory = all;
    } catch (e) {
      console.log(chalk.yellow(`  ⚠ Could not update history.json: ${e.message}`));
    }
  }

  // Mark the run as stopped if the process is interrupted
  const onStop = () => {
    runStatus = 'stopped';
    currentSession = null;
    try { saveHistory(); } catch (e) {}
    process.exit(130);
  };
  process.once('SIGINT', onStop);
  process.once('SIGTERM', onStop);

  // Initialize current run in history
  saveHistory();

  const reportInterval = setInterval(() => {
    // Derive counts from keywordData for the table header
    const kwsWithSponsored = [...globalStats.keywordData.values()].filter(d => d.sponsoredSessions > 0).length;
    const kwsWithTarget = [...globalStats.keywordData.values()].filter(d => d.targetsMax > 0).length;

    // Update live history
    saveHistory();

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
    const sponsoredKws = [...globalStats.keywordData.entries()].filter(([,d]) => d.sponsoredSessions > 0);
    const targetKws    = [...globalStats.keywordData.entries()].filter(([,d]) => d.targetsMax > 0);
    if (sponsoredKws.length > 0) {
      console.log(chalk.yellow(`  Ads Found For:`));
      sponsoredKws.forEach(([kw, d]) => console.log(chalk.dim(`    • "${kw}" — ${d.sponsoredMax} sponsored ad(s) max in ${d.sponsoredSessions} sessions`)));
    }
    if (targetKws.length > 0) {
      console.log(chalk.green(`  Targets Found For:`));
      targetKws.forEach(([kw, d]) => console.log(chalk.dim(`    • "${kw}" — ${d.targetsMax} target link(s) max`)));
    }
  }, 60000);

  let loopCount = 1;

  do {
    currentLoop = loopCount;
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

        currentSession = { label: sessionLabel, keyword, startedAt: new Date().toISOString() };
        saveHistory();

        const stats = await runSession(sessionLabel, keyword);
        currentSession = null;

        sessions.push(stats
          ? { ...stats, label: config.loopBot ? `L${loopCount}${sessionLabel}` : sessionLabel, loop: loopCount }
          : { label: sessionLabel, keyword, loop: loopCount, success: false, outcome: 'error', reason: 'Session returned no data', endedAt: new Date().toISOString() });
        if (sessions.length > MAX_SESSIONS_PER_RUN) {
          sessionsDropped += sessions.length - MAX_SESSIONS_PER_RUN;
          sessions.splice(0, sessions.length - MAX_SESSIONS_PER_RUN);
        }

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
          const existing = globalStats.keywordData.get(keyword) || { 
            sponsoredMax: 0, 
            targetsMax: 0,
            totalSessions: 0,
            sponsoredSessions: 0,
            adDomains: {}
          };
          existing.totalSessions++;
          if (stats.hasSponsored) {
            existing.sponsoredSessions++;
            existing.sponsoredMax = Math.max(existing.sponsoredMax, stats.sponsoredCount || 0);
          }
          if (stats.hasTargetDomain) {
            existing.targetsMax = Math.max(existing.targetsMax, stats.targetCount || 0);
          }
          if (stats.sponsoredDomains) {
            stats.sponsoredDomains.forEach(domain => {
              existing.adDomains[domain] = (existing.adDomains[domain] || 0) + 1;
            });
          }
          globalStats.keywordData.set(keyword, existing);
        } else {
          globalStats.failures++;
        }

        // Update live history immediately after session
        saveHistory();


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

  const kwsWithSponsored = [...globalStats.keywordData.values()].filter(d => d.sponsoredSessions > 0).length;
  const kwsWithTarget    = [...globalStats.keywordData.values()].filter(d => d.targetsMax > 0).length;

  // Final update of the history record for this run
  runStatus = 'completed';
  saveHistory();

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

  const sponsoredKws = [...globalStats.keywordData.entries()].filter(([,d]) => d.sponsoredSessions > 0);
  const targetKws    = [...globalStats.keywordData.entries()].filter(([,d]) => d.targetsMax > 0);

  if (sponsoredKws.length > 0) {
    console.log(chalk.yellow(`\n[Keywords with Sponsored Ads]:`));
    sponsoredKws.forEach(([kw, d]) => console.log(chalk.dim(`  • "${kw}" — ${d.sponsoredMax} sponsored ad(s) max in ${d.sponsoredSessions} sessions`)));
  }

  if (targetKws.length > 0) {
    console.log(chalk.green(`\n[Keywords with Target Domain Found]:`));
    targetKws.forEach(([kw, d]) => console.log(chalk.dim(`  • "${kw}" — ${d.targetsMax} target link(s) found max`)));
  }
}

main().catch((err) => {
  console.error(chalk.red(`Fatal error: ${err.message}`));
  console.error(err.stack);
  process.exit(1);
});
