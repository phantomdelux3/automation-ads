/**
 * Opens a bot profile for maintenance (reading or writing its cookie store).
 *
 * Two rules this file exists to enforce:
 *
 * 1. The profile is opened with EXACTLY the identity the bot will use later -
 *    same fingerprint seed, GPU, screen, timezone and locale. Chrome writes
 *    some of that into the profile, so opening a profile with a different
 *    identity than the bot uses would leave the two out of sync.
 *
 * 2. Nothing touches the network. No page is ever navigated, and Chrome's own
 *    background chatter (component updater, variations, safebrowsing, sync,
 *    domain reliability) is switched off. Export/import must never put these
 *    accounts on the wire from an un-proxied IP.
 */
import { launchPersistentContext } from 'cloakbrowser';
import {
  profileIdentity,
  fingerprintArgs,
  profileDirFor,
} from '../../src/profile-identity.js';

/** Chrome flags that keep a launched profile completely silent. */
const OFFLINE_ARGS = [
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-domain-reliability',
  '--disable-sync',
  '--disable-client-side-phishing-detection',
  '--safebrowsing-disable-auto-update',
  '--metrics-recording-only',
  '--no-first-run',
  '--no-default-browser-check',
  '--no-service-autorun',
  '--disable-quic',
  '--proxy-bypass-list=<-loopback>',
];

/**
 * Launch one profile headless and hand back its Playwright context.
 * Always pair with closeProfile() so Chrome flushes its cookie store.
 */
export async function openProfile(profileDirName, { headless = true, timeout = 60000 } = {}) {
  const identity = profileIdentity(profileDirName);

  const context = await launchPersistentContext({
    userDataDir: profileDirFor(profileDirName),
    headless,
    timezone: identity.timezone,
    locale: identity.locale,
    viewport: identity.viewport,
    args: [...fingerprintArgs(identity), ...OFFLINE_ARGS],
    launchOptions: { timeout },
  });

  return { context, identity };
}

/**
 * Close a context and give Chrome a moment to finish writing.
 *
 * Chrome batches cookie writes and flushes on shutdown. Closing and
 * immediately re-launching (or exiting the process) can race that flush, and
 * a lost flush is a silently empty cookie jar on the new machine.
 */
export async function closeProfile(context, settleMs = 1500) {
  await new Promise((r) => setTimeout(r, settleMs));
  await context.close();
  await new Promise((r) => setTimeout(r, 500));
}
