/**
 * A read-only picture of the profiles on this machine and in the bundle.
 *
 * Used by the dashboard's Transfer tab and by `npm run profiles:status`.
 * Reads files only - never launches a browser, never touches the network.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import config from '../../config.js';
import { profileIdentity, profileDirNameFor } from '../../src/profile-identity.js';
import {
  PROFILES_DIR,
  BUNDLE_DIR,
  listProfileDirs,
  listBundledProfiles,
  bundleProfilePath,
  readManifest,
  hasForeignOsCrypt,
  readImportMarker,
  machineId,
  dirSize,
} from './bundle.js';

function bundleRecord(name) {
  try {
    const raw = JSON.parse(fs.readFileSync(bundleProfilePath(name), 'utf8'));
    return {
      cookies: Array.isArray(raw.cookies) ? raw.cookies.length : 0,
      exportedAt: raw.exportedAt || null,
      email: raw.accountEmail || null,
      loggedIn: raw.summary ? !!raw.summary.loggedIn : null,
    };
  } catch {
    return null;
  }
}

export function profileStatus({ withSizes = false } = {}) {
  const onDisk = listProfileDirs();
  const bundled = listBundledProfiles();
  const manifest = readManifest();

  const names = [...new Set([...onDisk, ...bundled])].sort();
  const emailByProfile = new Map(
    (config.accounts || [])
      .filter((a) => a && a.email)
      .map((a) => [profileDirNameFor(a.email), a.email])
  );

  const here = machineId();
  // The bundle was made somewhere else, so these profiles crossed a DPAPI
  // boundary and their cookie stores are unreadable until imported.
  const fromAnotherMachine = !!(
    manifest &&
    manifest.source &&
    manifest.source.machineId &&
    manifest.source.machineId !== here
  );

  const profiles = names.map((name) => {
    const dir = path.join(PROFILES_DIR, name);
    const exists = onDisk.includes(name);
    const rec = bundled.includes(name) ? bundleRecord(name) : null;
    const identity = profileIdentity(name);
    const marker = exists ? readImportMarker(dir) : null;

    // Already rebuilt here, for this exact bundle.
    const importedHere = !!(
      marker &&
      marker.machineId === here &&
      (!manifest || marker.bundleExportedAt === manifest.exportedAt)
    );

    return {
      name,
      email: emailByProfile.get(name) || (rec && rec.email) || null,
      inAccounts: emailByProfile.has(name),
      hasProfileDir: exists,
      // Needs importing when the bundle came from another machine/user and
      // this profile has not been rebuilt here yet.
      needsImport: !!rec && fromAnotherMachine && !importedHere,
      importedHere,
      foreignKey: exists && hasForeignOsCrypt(dir),
      loggedInFlag: exists && fs.existsSync(path.join(dir, 'LOGIN_SUCCESS.txt')),
      bundled: !!rec,
      bundledCookies: rec ? rec.cookies : 0,
      bundledLoggedIn: rec ? rec.loggedIn : null,
      exportedAt: rec ? rec.exportedAt : null,
      bytes: withSizes && exists ? dirSize(dir) : null,
      identity: {
        seed: identity.seed,
        timezone: identity.timezone,
        locale: identity.locale,
        screen: `${identity.screen.width}x${identity.screen.height}`,
        gpu: (identity.gpu.renderer.match(/^ANGLE \([^,]+,\s*(.+?)\s*\(0x/) || [, identity.gpu.vendor])[1],
      },
    };
  });

  const sample = names.length ? profileIdentity(names[0]) : null;

  return {
    machine: os.hostname(),
    machineId: here,
    // True on the laptop that produced the bundle - it has nothing to import.
    isSourceMachine: !!(manifest && !fromAnotherMachine),
    profilesDir: PROFILES_DIR,
    bundleDir: BUNDLE_DIR,
    hasBundle: fs.existsSync(BUNDLE_DIR),
    manifest: manifest
      ? {
          exportedAt: manifest.exportedAt,
          source: manifest.source,
          proxyCountry: manifest.proxyCountry,
          bundledBrowser: manifest.bundledBrowser || null,
          profileCount: (manifest.profiles || []).length,
        }
      : null,
    proxyCountry: sample ? sample.country : null,
    proxyCount: (config.proxies || []).length,
    // Bundle built for a different proxy country = every fingerprint would
    // shift on import, so the UI needs to shout about it.
    countryMismatch: !!(
      manifest &&
      manifest.proxyCountry &&
      sample &&
      manifest.proxyCountry !== sample.country
    ),
    counts: {
      onDisk: onDisk.length,
      bundled: bundled.length,
      needsImport: profiles.filter((p) => p.needsImport).length,
      accounts: (config.accounts || []).length,
    },
    profiles,
  };
}
