/**
 * Print what this machine currently has: profiles on disk, profiles in the
 * bundle, and whether any of them still carry another machine's encryption
 * key (i.e. were copied here but never imported).
 *
 *   npm run profiles:status
 *   npm run profiles:status -- --sizes    (also measure folder sizes; slower)
 */
import { profileStatus } from './lib/status.js';
import { human, log, step, ok, warn, info } from './lib/bundle.js';

const withSizes = process.argv.includes('--sizes');
const s = profileStatus({ withSizes });

log('');
log('==========================================================');
log('  Profile status');
log('==========================================================');
info(`Machine:        ${s.machine}`);
info(`Profiles dir:   ${s.profilesDir}`);
info(`Proxy pool:     ${s.proxyCount} endpoint(s), country "${s.proxyCountry}"`);

if (s.manifest) {
  info(`Bundle:         ${s.manifest.profileCount} profile(s), exported ${s.manifest.exportedAt}`);
  info(`Bundle source:  ${s.manifest.source.hostname} (chromium ${s.manifest.source.chromium})`);
  if (s.manifest.bundledBrowser) {
    info(`Bundled browser: chromium ${s.manifest.bundledBrowser.version}`);
  }
} else {
  info('Bundle:         none (run the export to create one)');
}

if (s.countryMismatch) {
  warn(`Bundle was built for proxy country "${s.manifest.proxyCountry}" but this`);
  warn(`machine resolves to "${s.proxyCountry}". Importing would change every`);
  warn('profile\'s timezone and locale. Fix PROXY_LIST/PROXY_COUNTRY in .env first.');
}

step('Profiles');
for (const p of s.profiles) {
  const marks = [];
  if (!p.hasProfileDir) marks.push('NO FOLDER');
  if (p.needsImport) marks.push('NEEDS IMPORT');
  if (p.bundled) marks.push(`${p.bundledCookies} cookies exported`);
  else marks.push('not exported');
  if (p.hasProfileDir && !p.loggedInFlag) marks.push('no login flag');
  if (!p.inAccounts) marks.push('not in accounts.json');

  const size = p.bytes !== null ? ` [${human(p.bytes)}]` : '';
  info(`${p.name}${size}`);
  info(`    ${marks.join(' | ')}`);
  info(`    identity: seed ${p.identity.seed}, ${p.identity.timezone}, ${p.identity.locale}, ` +
    `${p.identity.screen}, ${p.identity.gpu}`);
}

step('Summary');
info(`On disk:      ${s.counts.onDisk}`);
info(`In bundle:    ${s.counts.bundled}`);
info(`In accounts:  ${s.counts.accounts}`);
if (s.counts.needsImport > 0) {
  warn(`${s.counts.needsImport} profile(s) were copied from another machine and still`);
  warn('need importing. Their cookies cannot be read until you run the import.');
} else if (s.counts.bundled > 0) {
  ok('No profiles are waiting on an import.');
}
log('');
