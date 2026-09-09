# Moving profiles to another laptop

Copying the bot folder to a second machine used to produce endless Google
CAPTCHAs, while the original machine ran clean. This document explains why and
what the transfer tooling does about it.

## Why a plain copy loses everything

Chrome on Windows encrypts every cookie **value** with a master key stored in
`chrome-profiles/<profile>/Local State` under `os_crypt.encrypted_key`. That key
is itself wrapped by Windows DPAPI, which binds it to the **Windows user account
on that specific machine**.

Copy the folder to another laptop — or even to a different Windows user on the
same laptop — and Chrome can no longer unwrap the key. Every encrypted cookie
decodes to garbage and is silently dropped. Nothing errors. The profile folder
looks perfect: same size, same files, same `History` database. It just boots up
with an empty cookie jar and no Google session.

From Google's side that is a brand new browser arriving on a rotating proxy IP
and immediately searching. That is a CAPTCHA, every time.

Three smaller versions of the same problem:

- `.gitignore` excludes `chrome-profiles/`, `.env` and `node_modules/`, so any
  git-based copy silently arrives with no profiles at all.
- The profile path used to be resolved from `process.cwd()`, so launching the
  bot from a different working directory created a second, empty set of
  profiles. It is now anchored to the source tree.
- `playwright-core` was pinned to `latest`, so a fresh `npm install` on the
  other machine could pull a different Chromium than the profiles were built
  with. Both browser packages are now pinned to exact versions.

## What is and is not machine-bound

| Data | Encrypted? | Survives a copy? |
| --- | --- | --- |
| Cookies (`Default/Network/Cookies`) | yes, DPAPI | **no** — must be re-injected |
| Saved passwords (`Login Data`) | yes, DPAPI | no |
| History, Top Sites, Favicons | no | yes |
| Local Storage, IndexedDB, Session Storage | no | yes |
| Preferences, Web Data (autofill) | no | yes |
| HSTS state (`TransportSecurity`) | no | yes |
| Cache, Code Cache, GPU/shader caches | no | irrelevant — rebuilt |

So only the cookies need special handling. The fix is to move them **through
the browser** rather than through the filesystem: read them decrypted on the
source machine, write them back on the target, where Chrome re-encrypts them
with that machine's own key.

## The four commands

All four are also buttons in the dashboard's **Transfer** tab.

| Command | Where | What it does |
| --- | --- | --- |
| `npm run profiles:export` | source | Opens each profile headless (no navigation, no network), reads its cookies, writes `profile-bundle/profiles/<name>/cookies.json` plus a manifest. Changes nothing in `chrome-profiles/`. |
| `npm run profiles:pack` | source | Builds a verified transfer zip next to the bot folder. |
| `npm run profiles:import` | target | Sanitises each copied profile, re-injects its cookies, then re-opens it to confirm they persisted. |
| `npm run profiles:status` | either | Reports what is on disk, what is exported, and what still needs importing. |

Useful flags:

```
profiles:export -- --include-browser     also bundle Chromium (~540 MB) for an exact browser match
profiles:export -- --only a@b.com_       just one profile
profiles:import -- --no-verify           skip the re-open check
profiles:import -- --force               rebuild profiles on the source machine too
profiles:pack   -- --out D:\move.zip     choose the output path
```

## Step by step

### On the source laptop

1. Stop the bot.
2. **Transfer → Export Profiles.** Every profile should report `logged in`.
3. **Transfer → Pack Transfer Zip.**

The packer exists because the folder is about 7.3 GB, and roughly 7.2 GB of
that is Chrome's HTTP cache, code cache and compiled GPU shaders — all
rebuilt automatically, none of it carrying any login or trust. It skips those
without deleting anything locally, and the resulting zip is around 19 MB. It
then reopens the archive and verifies that `.env`, `accounts.json`,
`node_modules/`, `chrome-profiles/` and every exported profile are actually
inside before declaring success.

### On the target laptop

1. Unzip anywhere. Install Node 20+.
2. If you did not copy `node_modules/`, run `npm ci`.
3. `npm start`, open <http://localhost:3000>, go to **Transfer**.
4. The banner should say *N profiles were copied from another machine and have
   not been imported*. Click **Import Profiles**.

For each profile the import:

- strips the source machine's DPAPI key from `Local State`, so Chrome mints a
  fresh one instead of failing against a key it cannot unwrap
- deletes the unreadable `Cookies` and `Login Data` databases
- clears stale single-instance locks (`SingletonLock`, leveldb `LOCK` files)
  left behind if the profile was copied while Chrome had it open
- drops caches and network state carried over from the old machine
- marks the last session as a clean exit, so no "Restore pages?" bubble sits
  over the page the bot is driving
- launches the profile with its exact bot identity and injects every cookie
- **re-opens the profile and counts what actually persisted**

That last step matters: Chrome flushes its cookie store on shutdown, so an
import that races the flush would otherwise look successful and arrive empty.

Only when the cookies verify does it write `TRANSFER_IMPORTED.json` into the
profile, which is how the dashboard knows that profile is done.

## One identity per profile

Export, import and the bot all derive a profile's identity from the same place
(`src/profile-identity.js`), keyed on the profile directory name:

- fingerprint seed, GPU vendor/renderer, screen size, window size
- timezone and locale, drawn from the pool matching the proxy exit country
  (read from the gateway hostname — `us.decodo.com` → `us`, override with
  `PROXY_COUNTRY`)
- preferred proxy endpoint

Same profile name, same identity, forever, on any machine. Previously the
timezone, locale and window size were re-randomised on every launch, so a
profile could be `Asia/Tokyo`/`en-IN` one session and `Europe/London`/`en-GB`
the next, on a US residential IP. A profile with a long cookie history absorbs
that; a freshly transferred one has nothing else to go on.

Because the identity depends on the proxy country, the import **refuses to run**
if `.env` resolves to a different country than the bundle was built for —
otherwise every profile's timezone and locale would shift on arrival.

## After importing

Keep `SESSIONS_PER_KEYWORD` low for the first day. The profiles carry their full
history and login, but they are appearing from a new machine, so give them a
normal rhythm before pushing volume.

If a profile still gets challenged, check `npm run profiles:status`: a profile
showing `not exported` or `NOT signed in` was never carrying a session to begin
with and needs a fresh login plus warmup (`COOKIE_WARMUP=true`).

## Signed out on arrival — the normal case

Even a perfect import can land you here: the browser is trusted (no CAPTCHA)
but Google shows nobody signed in. That is the transfer working as designed —
everything that makes the profile *look* like a returning machine survives the
move; only the session does not.

The fix is on the dashboard's **Accounts** tab, not here:

```bash
npm run accounts:check      # which profiles actually still have a session
npm run accounts:relogin    # sign the signed-out ones back in
```

Re-login reuses the profile exactly as it is — same folder, same fingerprint,
same proxy endpoint. Nothing is rebuilt, so nothing that earned the profile its
trust is lost.

Do the import **before** the re-login. Importing tears down and rebuilds the
cookie store, which would throw away a session you had just created. The
Accounts tab refuses to re-login while any profile is still flagged
`NEEDS IMPORT`.

## profile-map.json travels too

Once an account has been given a profile from the cookie pool, the link between
the two lives in `profile-map.json` at the project root. Without that file the
other laptop would resolve the account back to an email-named folder that does
not exist and build it from scratch, with a different fingerprint. `npm run
profiles:pack` includes it and verifies it made it into the zip.
