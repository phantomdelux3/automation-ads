# 🤖 Ad Platform Click Testing Tool

A Node.js tool for testing your ad platform's click fraud detection system by simulating realistic human-like browsing and clicking behavior.

> **⚠️ For internal QA testing only.** This tool is designed to test your own ad platform's fraud detection capabilities.

---

## 🚀 Quick Start

### 1. Install Dependencies

```bash
cd bot-undetectable-click
npm install
```

### 2. Configure

Edit `.env` with your settings:

```env
# Your site URL containing the ad
TARGET_URL=https://your-site.com

# CSS selector for the ad element
AD_SELECTOR=.ad-banner

# Number of test click sessions
CLICK_COUNT=3

# Delay between sessions (ms)
MIN_DELAY=3000
MAX_DELAY=10000

# Browser mode (true = invisible, false = visible for debugging)
HEADLESS=false
```

### 3. Run

```bash
# Run click testing
npm start

# Run with browser visible (for debugging)
npm run start:headed

# Test stealth detection
npm run test-stealth
```

---

## 📁 Project Structure

```
bot-undetectable-click/
├── index.js              # CLI entry point
├── dashboard.js          # Web control panel (npm start)
├── config.js             # Configuration loader
├── test-stealth.js       # Bot detection test script
├── TRANSFER.md           # Moving profiles to another laptop
├── .env                  # Your configuration (git-ignored)
├── .env.example          # Example configuration
├── package.json
├── src/
│   ├── browser.js          # Stealth browser launcher
│   ├── profile-identity.js # Deterministic per-profile fingerprint
│   ├── profile-map.js      # Which profile folder belongs to which account
│   ├── google-login.js     # Sign-in + "is this profile signed in?"
│   ├── warmup.js           # Cookie warmup for new profiles
│   ├── captcha-guard.js    # Shared reCAPTCHA auto-solve / manual wait
│   ├── human-behavior.js   # Human behavior simulation
│   └── click-engine.js     # Click session orchestration
└── scripts/
    ├── export-profiles.js      # Read cookies out for transfer
    ├── import-profiles.js      # Rebuild profiles on a new machine
    ├── pack-transfer.js        # Build a verified transfer zip
    ├── profiles-status.js      # What's on disk vs. exported
    ├── relogin.js              # Check / re-login every account
    ├── build-cookies.js        # Build warm, unclaimed profiles (cookie pool)
    ├── rewarmup.js             # Re-warm the cookies of existing profiles
    └── provision-accounts.js   # Give new accounts a warm profile + login
```

---

## 💻 Moving to Another Laptop

Copying `chrome-profiles/` by itself does **not** work: Chrome encrypts cookies
with a key bound to the Windows user + machine, so a copied profile arrives
logged out and gets CAPTCHA'd on every search.

Use the Transfer tab in the dashboard, or:

```bash
# On the source machine
npm run profiles:export     # read cookies out while they are still decryptable
npm run profiles:pack       # verified zip, skips ~7 GB of rebuildable cache

# On the target machine, after unzipping
npm run profiles:import     # re-inject cookies, then verify they persisted
npm run profiles:status     # check what still needs importing
```

See [TRANSFER.md](TRANSFER.md) for the full explanation.

---

## 👤 Accounts tab — keeping profiles signed in

Everything below is a button on the dashboard's **Accounts** tab. All of it is
aimed at one thing: never letting Google see a browser worth challenging.

### 1. Check / re-login

After a transfer the profiles look trusted (no CAPTCHA) but are **signed out** —
Chrome could not decrypt the login cookies that came with them. This signs the
same account back into the same profile, over the same proxy and fingerprint,
changing nothing else.

```bash
npm run accounts:check      # open each profile, ask Google if it is signed in
npm run accounts:relogin    # sign the signed-out ones back in
```

Keep **Show the browser window** ticked for sign-ins: if Google asks for 2FA or
a CAPTCHA you have to finish it by hand, and the script waits
`CAPTCHA_WAIT_MINUTES` for you.

### 2. Cookie pool — build warm profiles in advance

```bash
npm run cookies:build -- --count 5           # 5 warm, unclaimed profiles
npm run cookies:build -- --count 5 --rounds 2
```

Builds profiles with **nobody signed in** and browses normally in each one
(Google, YouTube, News, real sites, searches) until it holds the cookies a
genuine browser accumulates. They wait in the pool until an account needs one.

Building trust *before* a login exists is the whole point: a brand new profile
whose first act is signing into Google is exactly what gets challenged.

### 3. Re-warm cookies

```bash
npm run cookies:rewarm                      # every profile on disk
npm run cookies:rewarm -- --accounts-only
npm run cookies:rewarm -- --only a@b.com
```

Cookies decay. `NID` and `AEC` expire, a profile sits unused for weeks, or an
import rebuilt the cookie store and only the login came back. The profile still
looks long-lived on disk — it just stopped carrying the cookies that tell Google
it has been seen before, and the next search from it is the one that gets
challenged.

This browses every profile and **keeps going until the jar actually grades
healthy**, then re-opens each profile offline to confirm the cookies survived the
browser closing. Signed-in profiles stay signed in — warming only browses.

Warmth is graded on what Google actually hands out:

| Cookie | Why it matters |
|---|---|
| `NID` | The floor. Without it Google has no memory of this browser. |
| `AEC` | Google's own anti-abuse token — only given to a browser that has *used* Search and behaved. |
| YouTube `VISITOR_INFO1_LIVE` / `YSC` | Near-universal on a real Chrome profile. |
| `SOCS` / `CONSENT` | Bonus only — the consent wall is region-dependent and US exits often never see one. |

Verdicts: **strong** (NID + AEC + another signal) · **ok** (NID + one signal) ·
**thin** (recognised, nothing behind it) · **cold** (no NID — will be challenged).

### 4. Provision new accounts

```bash
npm run accounts:provision
```

Every account with no profile yet gets one — from the warm pool first, and only
when the pool is empty does it create a profile, warm it up, and *then* sign in.

A claimed pool profile keeps its `pool.<random>` folder name forever. The name
seeds the fingerprint, so renaming it to the account's email would change the
hardware Google sees and throw away the warmup. The email → folder link lives in
`profile-map.json`, which must travel with the transfer zip (the packer checks).

---

## 🛡️ Anti-Detection Features

| Feature | Description |
|---------|-------------|
| **Stealth Plugin** | Patches `navigator.webdriver`, Chrome runtime, plugin enumeration, and all common bot detection vectors |
| **Bezier Mouse Curves** | Mouse follows natural acceleration/deceleration paths via ghost-cursor |
| **Gaussian Timing** | Delays follow bell-curve distribution, not uniform random |
| **Viewport Randomization** | Each session uses a different common screen resolution |
| **User-Agent Rotation** | Fresh realistic desktop UA per session |
| **WebGL Spoofing** | GPU vendor/renderer strings match real hardware |
| **Timezone/Language** | Randomized per session for fingerprint diversity |
| **Referrer Chain** | Visits a search engine before navigating to target (organic pattern) |
| **Organic Scrolling** | Variable speed with occasional scroll-up (not just down) |
| **Reading Simulation** | Pauses at natural intervals as if reading content |
| **Post-Click Behavior** | Interacts with the landing page after clicking |

---

## 🔧 Configuration Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `TARGET_URL` | `https://your-site.com` | Page containing the ad |
| `AD_SELECTOR` | `.ad-banner` | CSS selector for the ad element |
| `CLICK_COUNT` | `3` | Number of click sessions to run |
| `MIN_DELAY` | `3000` | Minimum delay between sessions (ms) |
| `MAX_DELAY` | `10000` | Maximum delay between sessions (ms) |
| `HEADLESS` | `false` | Run browser invisibly |
| `PROXY_LIST` | _(empty)_ | Comma-separated proxy addresses |
| `PROXY_USER` | _(empty)_ | Proxy authentication username |
| `PROXY_PASS` | _(empty)_ | Proxy authentication password |

---

## 🌐 Adding Proxies (Future)

When ready to add your proxy network, update `.env`:

```env
PROXY_LIST=proxy1.example.com:8080,proxy2.example.com:8080,proxy3.example.com:8080
PROXY_USER=your_username
PROXY_PASS=your_password
```

Each session will randomly pick a proxy from the list, so clicks appear from different IPs.

---

## 🧪 Testing Stealth

Run the stealth test to verify the browser passes bot detection:

```bash
npm run test-stealth
```

This opens [bot.sannysoft.com](https://bot.sannysoft.com) and reports which detection tests pass/fail. A screenshot is saved as `stealth-test-result.png`.

---

## 📋 How It Works

Each click session follows this flow:

1. **Launch** — Stealth browser with randomized fingerprint
2. **Referrer** — Visit a search engine (Google/Bing/DuckDuckGo)
3. **Navigate** — Go to your target URL with the referrer set
4. **Browse** — Scroll, read, move mouse organically
5. **Click** — Find and click the ad element with natural motion
6. **Post-Click** — Interact with the landing page (read, scroll)
7. **Close** — End session and wait before next one
