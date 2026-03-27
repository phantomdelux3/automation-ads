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
├── config.js             # Configuration loader
├── test-stealth.js       # Bot detection test script
├── .env                  # Your configuration (git-ignored)
├── .env.example          # Example configuration
├── package.json
└── src/
    ├── browser.js        # Stealth browser launcher
    ├── human-behavior.js # Human behavior simulation
    └── click-engine.js   # Click session orchestration
```

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
