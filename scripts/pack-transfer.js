/**
 * Zip this bot folder for transfer to another laptop.
 *
 *   npm run profiles:pack
 *   npm run profiles:pack -- --out D:\transfer.zip
 *
 * Why not just right-click -> Send to -> Compressed folder:
 *
 *   - chrome-profiles/ is ~7 GB, and about 97% of that is Chrome's HTTP cache,
 *     code cache and compiled GPU shaders. All of it is rebuilt automatically
 *     and none of it carries any login or trust. This packer leaves it out
 *     without deleting anything from this machine.
 *   - A git-based copy silently drops chrome-profiles/, .env and node_modules/
 *     because .gitignore excludes them - which is exactly how a transfer ends
 *     up CAPTCHA-ing on the other side.
 *
 * The zip is written OUTSIDE the bot folder so it cannot include itself.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import {
  ROOT,
  PROFILES_DIR,
  BUNDLE_DIR,
  MANIFEST_PATH,
  listProfileDirs,
  listBundledProfiles,
  dirSize,
  human,
  log,
  step,
  ok,
  warn,
  fail,
  info,
} from './lib/bundle.js';

const args = process.argv.slice(2);
const outArg = (() => {
  const i = args.indexOf('--out');
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
})();

/**
 * Cache directories inside each profile. Regenerable, GPU/machine specific,
 * and responsible for nearly all of the folder's size.
 */
const PROFILE_CACHE_DIRS = [
  'Default/Cache',
  'Default/Code Cache',
  'Default/GPUCache',
  'Default/DawnGraphiteCache',
  'Default/DawnWebGPUCache',
  'Default/Service Worker/CacheStorage',
  'Default/Service Worker/ScriptCache',
  'Default/optimization_guide_model_store',
  'Default/Shared Dictionary',
  'GPUCache',
  'ShaderCache',
  'GrShaderCache',
  'GraphiteDawnCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'component_crx_cache',
  'extensions_crx_cache',
];

/** Repo-level things that should never travel. */
const ROOT_EXCLUDES = ['./.git', './stealth-test-result.png', './ad-diagnostic.png', '*.log'];

/** Everything the other laptop cannot work without. */
const REQUIRED = [
  { rel: 'chrome-profiles', why: 'browsing history, localStorage, preferences' },
  { rel: 'profile-bundle/manifest.json', why: 'the exported cookies' },
  { rel: '.env', why: 'proxy credentials and settings' },
  { rel: 'accounts.json', why: 'the account list' },
  { rel: 'package.json', why: 'dependency versions' },
];

function tarExe() {
  const sys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  // The Windows build is bsdtar/libarchive, which writes real .zip files.
  // GNU tar (e.g. the one bundled with Git) cannot, so prefer the system one.
  return fs.existsSync(sys) ? sys : 'tar';
}

/**
 * profile-map.json records which account owns which profile directory. It only
 * exists once a pool profile has been handed to an account - but from that
 * moment it is load-bearing: without it the other laptop would resolve that
 * account back to an email-named folder that does not exist, and rebuild it
 * from scratch with a different fingerprint.
 */
function checkProfileMap() {
  const p = path.join(ROOT, 'profile-map.json');
  if (!fs.existsSync(p)) {
    info('profile-map.json - not present (no pooled profiles to map)');
    return false;
  }
  try {
    const n = Object.keys(JSON.parse(fs.readFileSync(p, 'utf8')).assignments || {}).length;
    ok(`profile-map.json - present (${n} account(s) mapped to a pool profile)`);
  } catch (e) {
    warn(`profile-map.json - present but unreadable: ${e.message}`);
  }
  return true;
}

function preflight() {
  let blocking = 0;

  for (const r of REQUIRED) {
    const p = path.join(ROOT, r.rel);
    if (fs.existsSync(p)) {
      ok(`${r.rel} - present (${r.why})`);
    } else if (r.rel === 'profile-bundle/manifest.json') {
      fail(`${r.rel} - MISSING. Run the export first, or the profiles will not`);
      fail('  survive the move: their cookies stay encrypted with this machine\'s key.');
      blocking++;
    } else {
      fail(`${r.rel} - MISSING (${r.why})`);
      blocking++;
    }
  }

  checkProfileMap();

  const onDisk = listProfileDirs();
  const bundled = listBundledProfiles();
  const notExported = onDisk.filter((p) => !bundled.includes(p));
  if (notExported.length) {
    warn(`${notExported.length} profile(s) on disk have no exported cookies:`);
    notExported.forEach((p) => warn(`  - ${p}`));
    warn('  They will arrive logged out. Re-run the export to include them.');
  }

  return blocking;
}

function main() {
  log('');
  log('==========================================================');
  log('  Pack for transfer');
  log('==========================================================');

  step('Checking what will be included');
  const blocking = preflight();
  if (blocking > 0) {
    log('');
    fail(`${blocking} required item(s) missing - not packing.`);
    process.exit(1);
  }

  // ── Build the exclude list ─────────────────────────────────────
  const excludes = [...ROOT_EXCLUDES];
  for (const name of listProfileDirs()) {
    for (const sub of PROFILE_CACHE_DIRS) {
      const rel = `./chrome-profiles/${name}/${sub}`;
      if (fs.existsSync(path.join(ROOT, 'chrome-profiles', name, sub))) excludes.push(rel);
    }
  }

  // An exclude FILE rather than --exclude flags: with 13 profiles this is
  // ~200 paths, several of which contain spaces, and Windows command lines
  // have a hard length limit.
  const excludeFile = path.join(os.tmpdir(), `pennywise-exclude-${Date.now()}.txt`);
  fs.writeFileSync(excludeFile, excludes.join('\n') + '\n', 'utf8');

  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const out = outArg
    ? path.resolve(outArg)
    : path.join(path.dirname(ROOT), `${path.basename(ROOT)}-transfer-${stamp}.zip`);

  if (path.resolve(out).startsWith(path.resolve(ROOT) + path.sep)) {
    fail('The output zip would sit inside the folder being zipped.');
    fail(`Pick a path outside ${ROOT} with --out.`);
    process.exit(1);
  }

  step('Sizes');
  const profilesBytes = dirSize(PROFILES_DIR);
  let cacheBytes = 0;
  for (const name of listProfileDirs()) {
    for (const sub of PROFILE_CACHE_DIRS) {
      const p = path.join(PROFILES_DIR, name, sub);
      if (fs.existsSync(p)) cacheBytes += dirSize(p);
    }
  }
  info(`chrome-profiles/ total:   ${human(profilesBytes)}`);
  info(`  cache being skipped:    ${human(cacheBytes)}`);
  info(`  actually packed:        ${human(profilesBytes - cacheBytes)}`);
  info(`profile-bundle/:          ${human(dirSize(BUNDLE_DIR))}`);
  info(`node_modules/:            ${human(dirSize(path.join(ROOT, 'node_modules')))}`);

  step('Creating the archive');
  info(`Output: ${out}`);
  info('This takes a few minutes. Compressing...');

  if (fs.existsSync(out)) fs.rmSync(out);

  const res = spawnSync(
    tarExe(),
    ['-a', '-c', '-f', out, '-X', excludeFile, '-C', ROOT, '.'],
    { stdio: ['ignore', 'inherit', 'inherit'] }
  );

  try {
    fs.rmSync(excludeFile);
  } catch {
    /* temp file - non-fatal */
  }

  if (res.error) {
    fail(`Could not run tar: ${res.error.message}`);
    process.exit(1);
  }
  // bsdtar warns (exit 1) about files that changed while reading; the archive
  // is still valid. Only a hard failure (2) is fatal.
  if (res.status !== 0 && res.status !== 1) {
    fail(`tar exited with code ${res.status}`);
    process.exit(1);
  }
  if (!fs.existsSync(out)) {
    fail('tar finished but no archive was produced.');
    process.exit(1);
  }

  step('Verifying the archive');
  const listing = spawnSync(tarExe(), ['-tf', out], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const entries = (listing.stdout || '').split(/\r?\n/).filter(Boolean);

  const need = [
    ['./.env', '.env'],
    ['./accounts.json', 'accounts.json'],
    ...(fs.existsSync(path.join(ROOT, 'profile-map.json'))
      ? [['./profile-map.json', 'profile-map.json']]
      : []),
    ['./profile-bundle/manifest.json', 'the exported cookies'],
    ['./node_modules/', 'node_modules'],
    ['./chrome-profiles/', 'chrome-profiles'],
  ];
  let missing = 0;
  for (const [prefix, label] of need) {
    if (entries.some((e) => e === prefix || e.startsWith(prefix))) {
      ok(`${label} is inside the zip`);
    } else {
      fail(`${label} is NOT inside the zip`);
      missing++;
    }
  }

  const bundledProfiles = listBundledProfiles();
  const inZip = bundledProfiles.filter((n) =>
    entries.some((e) => e.startsWith(`./profile-bundle/profiles/${n}/`))
  );
  if (inZip.length === bundledProfiles.length) {
    ok(`all ${bundledProfiles.length} exported profile(s) are inside the zip`);
  } else {
    fail(`only ${inZip.length}/${bundledProfiles.length} exported profiles made it in`);
    missing++;
  }

  const zipBytes = fs.statSync(out).size;

  step('Done');
  info(`Archive:  ${out}`);
  info(`Size:     ${human(zipBytes)} (${entries.length} entries)`);
  log('');

  if (missing) {
    fail('The archive is incomplete - do not transfer it. Fix the items above and re-pack.');
    process.exit(1);
  }

  ok('Archive verified.');
  info('On the other laptop: unzip it, run `npm start`, open the dashboard,');
  info('go to the Transfer tab and click Import Profiles.');
  log('');
}

main();
