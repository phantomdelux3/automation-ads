/**
 * Diagnostic script — runs inside CloakBrowser to dump ALL ad-related elements
 * Run: node diagnose-ads.js
 * 
 * This opens the target site with CloakBrowser (which loads real ads),
 * waits for ads to render, then dumps every iframe and ad-related element.
 */
import { launchBrowser } from './src/browser.js';
import { humanScroll, sleep } from './src/human-behavior.js';
import config from './config.js';
import chalk from 'chalk';

async function diagnoseAds() {
  console.log(chalk.bold.cyan('\n🔍 Ad Element Diagnostic Tool\n'));
  console.log(chalk.dim(`Target: ${config.targetUrl}\n`));

  const { context, page, timezone, locale } = await launchBrowser();

  const size = page.viewportSize();
  console.log(chalk.dim(`  TZ: ${timezone}, Locale: ${locale}, Viewport: ${size.width}x${size.height}\n`));

  // Navigate to target
  console.log(chalk.dim('  → Loading target page...'));
  await page.goto(config.targetUrl, {
    waitUntil: 'networkidle',
    timeout: 30000,
  });

  console.log(chalk.green('  ✓ Page loaded. Scrolling to trigger lazy ads...\n'));

  // Scroll down to trigger lazy-loaded ads
  await humanScroll(page);
  await sleep(3000);

  // Scroll more
  await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight / 2, behavior: 'smooth' }));
  await sleep(3000);

  // Wait for ads to fill
  console.log(chalk.dim('  → Waiting 15 seconds for ads to fully load...\n'));
  await sleep(15000);

  // Take screenshot
  await page.screenshot({ path: './ad-diagnostic.png', fullPage: true });
  console.log(chalk.green('  ✓ Full page screenshot saved: ./ad-diagnostic.png\n'));

  // Dump all elements
  const results = await page.evaluate(() => {
    const data = {
      allIframes: [],
      insElements: [],
      adElements: [],
      googleElements: [],
    };

    // ALL iframes
    document.querySelectorAll('iframe').forEach((iframe, i) => {
      const rect = iframe.getBoundingClientRect();
      data.allIframes.push({
        index: i,
        id: iframe.id || '(none)',
        name: iframe.name || '(none)',
        src: (iframe.src || '').substring(0, 200),
        className: iframe.className || '(none)',
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        visible: rect.width > 0 && rect.height > 0,
        parentTag: iframe.parentElement?.tagName || '(none)',
        parentClass: (iframe.parentElement?.className || '').substring(0, 100),
        parentId: iframe.parentElement?.id || '(none)',
        grandparentTag: iframe.parentElement?.parentElement?.tagName || '(none)',
        grandparentClass: (iframe.parentElement?.parentElement?.className || '').substring(0, 100),
      });
    });

    // ins.adsbygoogle elements
    document.querySelectorAll('ins.adsbygoogle').forEach((ins, i) => {
      const rect = ins.getBoundingClientRect();
      data.insElements.push({
        index: i,
        dataAdSlot: ins.getAttribute('data-ad-slot'),
        dataAdClient: ins.getAttribute('data-ad-client'),
        dataAdStatus: ins.getAttribute('data-ad-status'),
        dataAdFormat: ins.getAttribute('data-ad-format'),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        childCount: ins.children.length,
        firstChildTag: ins.children[0]?.tagName || '(none)',
        firstChildSrc: (ins.children[0]?.src || '').substring(0, 150),
        innerHTML: ins.innerHTML.substring(0, 300),
      });
    });

    // Elements with 'ad' in class or id
    document.querySelectorAll('[class*="ad" i], [id*="ad" i], [class*="google" i], [id*="google" i]').forEach((el, i) => {
      if (i < 30) {
        const rect = el.getBoundingClientRect();
        data.adElements.push({
          tag: el.tagName,
          id: (el.id || '').substring(0, 80),
          className: (el.className || '').toString().substring(0, 120),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          childCount: el.children.length,
        });
      }
    });

    return data;
  });

  // Print results
  console.log(chalk.bold.yellow('═══════════════════════════════════════'));
  console.log(chalk.bold.yellow('  ALL IFRAMES ON PAGE'));
  console.log(chalk.bold.yellow('═══════════════════════════════════════\n'));

  if (results.allIframes.length === 0) {
    console.log(chalk.red('  No iframes found at all!\n'));
  } else {
    results.allIframes.forEach((iframe) => {
      const vis = iframe.visible ? chalk.green('✓ visible') : chalk.red('✗ hidden');
      console.log(chalk.white(`  [${iframe.index}] ${vis} — ${iframe.width}x${iframe.height}`));
      console.log(chalk.dim(`      id: ${iframe.id}`));
      console.log(chalk.dim(`      name: ${iframe.name}`));
      console.log(chalk.dim(`      class: ${iframe.className}`));
      console.log(chalk.dim(`      src: ${iframe.src || '(empty)'}`));
      console.log(chalk.dim(`      parent: <${iframe.parentTag}> class="${iframe.parentClass}" id="${iframe.parentId}"`));
      console.log(chalk.dim(`      grandparent: <${iframe.grandparentTag}> class="${iframe.grandparentClass}"`));
      console.log('');
    });
  }

  console.log(chalk.bold.yellow('═══════════════════════════════════════'));
  console.log(chalk.bold.yellow('  <ins class="adsbygoogle"> ELEMENTS'));
  console.log(chalk.bold.yellow('═══════════════════════════════════════\n'));

  if (results.insElements.length === 0) {
    console.log(chalk.red('  No ins.adsbygoogle elements found!\n'));
  } else {
    results.insElements.forEach((ins) => {
      console.log(chalk.white(`  [${ins.index}] ${ins.width}x${ins.height} — status: ${ins.dataAdStatus || '(none)'}`));
      console.log(chalk.dim(`      ad-client: ${ins.dataAdClient}`));
      console.log(chalk.dim(`      ad-slot: ${ins.dataAdSlot}`));
      console.log(chalk.dim(`      ad-format: ${ins.dataAdFormat}`));
      console.log(chalk.dim(`      children: ${ins.childCount}, first child: <${ins.firstChildTag}>`));
      console.log(chalk.dim(`      first child src: ${ins.firstChildSrc || '(none)'}`));
      console.log(chalk.dim(`      innerHTML preview: ${ins.innerHTML.substring(0, 200)}`));
      console.log('');
    });
  }

  console.log(chalk.bold.yellow('═══════════════════════════════════════'));
  console.log(chalk.bold.yellow('  ELEMENTS WITH "ad" or "google" IN CLASS/ID'));
  console.log(chalk.bold.yellow('═══════════════════════════════════════\n'));

  if (results.adElements.length === 0) {
    console.log(chalk.red('  No ad/google elements found!\n'));
  } else {
    results.adElements.forEach((el) => {
      console.log(chalk.white(`  <${el.tag}> ${el.width}x${el.height} — children: ${el.childCount}`));
      console.log(chalk.dim(`      id: ${el.id || '(none)'}`));
      console.log(chalk.dim(`      class: ${el.className || '(none)'}`));
      console.log('');
    });
  }

  console.log(chalk.bold.cyan('\n════════════════════════════════════════'));
  console.log(chalk.bold.cyan('  SUMMARY'));
  console.log(chalk.bold.cyan('════════════════════════════════════════'));
  console.log(chalk.white(`  Total iframes: ${results.allIframes.length}`));
  console.log(chalk.white(`  Visible iframes: ${results.allIframes.filter(f => f.visible).length}`));
  console.log(chalk.white(`  ins.adsbygoogle: ${results.insElements.length}`));
  console.log(chalk.white(`  Ad/Google elements: ${results.adElements.length}`));
  console.log('');

  console.log(chalk.dim('Browser staying open 30 seconds for manual inspection...'));
  await sleep(30000);

  await context.close();
  console.log(chalk.cyan('\n✓ Diagnostic complete.\n'));
}

diagnoseAds().catch((err) => {
  console.error(chalk.red(`Error: ${err.message}`));
  console.error(err.stack);
  process.exit(1);
});
