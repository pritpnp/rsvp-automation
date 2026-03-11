# BAPS Scranton Region — RSVP Automation System

A fully automated RSVP pipeline for BAPS Scranton Mandir events. Drop a flyer image into a folder, run one command, and a live RSVP site deploys itself — complete with OCR-extracted event details, embedded Microsoft Forms, WhatsApp preview images, and Telegram summaries.

**Live site:** [scparasabha.com](https://scparasabha.com)  
**GitHub repo:** `pritpnp/rsvp-automation`  
**Telegram group:** Parasabha RSVPs (supergroup)

---

## How It Works — Full Pipeline

### 1. Flyer Upload
1. Drop flyer image (JPG/PNG) into the correct zone folder inside `Parasabha Zones/` on your Desktop
2. Run `Upload Flyers.command` (double-click it)
3. Script removes any old flyer from that zone in the GitHub repo, copies the new one in, commits, and pushes
4. A Mac notification confirms success ("Glass" sound) or no flyers found ("Basso" sound)
5. GitHub push triggers GitHub Actions automatically

### 2. GitHub Actions — Site Build (`rsvp-automation.yml`)
Triggered on every push to `main`. Runs `scripts/automate.js` which:
1. Scans all 5 zone folders in `flyers/` for images
2. For each flyer, calls **Claude API (claude-sonnet-4-20250514)** with vision to OCR-extract event info
3. Generates a styled HTML page for the zone
4. Generates a 1200×630 OG image (split-panel: top of flyer left, bottom right)
5. Compresses the flyer to JPEG under 300KB
6. Deploys everything to Netlify in one manifest-diff deploy
7. Commits updated `deadlines.json` back to the repo

### 3. RSVP Collection
- User visits `scparasabha.com/{zone}` and fills out the embedded **Microsoft Form**
- **Power Automate** flow fires: `When a new response is submitted` → `Get response details` → `Insert row` into Google Sheet
- One Power Automate flow per zone (5 flows total), all writing to the same Google Sheet

### 4. Telegram Summaries
- **Automatic:** Every 3 days at 3:00 PM ET — `rsvp-summary.yml` runs `scripts/summary.js`
- **On demand:** Send `/summary` in the Telegram group → **Pipedream** webhook receives it → triggers `rsvp-summary.yml` via GitHub API dispatch → `summary.js` reads the Google Sheet CSV → sends per-zone breakdown back to the group
- Summary only sends zones whose RSVP deadline has not yet passed (or all zones in TEST_MODE)

### 5. Nightly Cleanup
- **Google Apps Script** (`cleanupOldRSVPs`) runs daily at 3–4 AM ET
- Fetches `deadlines.json` from GitHub raw URL
- Deletes all rows from the Google Sheet for any zone where `eventDate <= today`
- Runs on a time-driven Apps Script trigger (Day timer, 3am–4am GMT-04:00)

---

## Site Structure

| URL | Description |
|-----|-------------|
| `scparasabha.com` | Hub page — lists all upcoming events across all zones |
| `scparasabha.com/{zone}` | Zone event page — flyer, event details, embedded RSVP form |
| `scparasabha.com/np/{zone}` | Same page but OG/Twitter meta tags stripped (for WhatsApp sharing without image preview) |

### Zones
| Slug | Display Name |
|------|-------------|
| `scranton` | Scranton |
| `mountain-top` | Mountain Top |
| `satsang-sabha` | Satsang Sabha |
| `moosic` | Moosic |
| `bloomsburg` | Bloomsburg |

---

## Repo Structure

```
rsvp-automation/
├── .github/
│   └── workflows/
│       ├── rsvp-automation.yml     # Triggered on push — builds & deploys site
│       └── rsvp-summary.yml        # Triggered on schedule or dispatch — sends RSVP summary
├── flyers/
│   ├── scranton/
│   ├── mountain-top/
│   ├── satsang-sabha/
│   ├── moosic/
│   └── bloomsburg/
├── images/
│   ├── baps-logo.png               # Header logo on hub page + favicon on all pages
│   └── baps-sanstha.png            # Footer image on hub page
├── netlify/
│   └── functions/
│       └── telegram-webhook.js     # Legacy Netlify function (replaced by Pipedream)
├── scripts/
│   ├── automate.js                 # Main script: OCR → HTML → Netlify deploy
│   ├── summary.js                  # Reads Google Sheet CSV → sends Telegram summary
│   ├── package.json
│   └── node_modules/
├── deadlines.json                  # Auto-updated by automate.js — event metadata per zone
├── netlify.toml                    # Points Netlify to functions directory
├── .last-upload                    # Timestamp file — ensures git always sees a change on upload
└── .gitignore
```

---

## Key Files In Detail

### `scripts/automate.js`
The brain of the system. Key functions:
- **`extractEventInfo(flyerPath)`** — Sends flyer to Claude vision API. Returns JSON: `eventName`, `date`, `time`, `location`, `description`, `rsvpDeadline`, `invitationYPercent`
- **`buildHtmlPage(eventInfo, zone, ...)`** — Generates full mobile HTML page. Includes scroll-lock on load, RSVP form iframe, late RSVP fallback (Telegram notification), `noPreview` flag for `/np/` routes
- **`buildOgImage(flyerPath, invitationYPercent)`** — Splits flyer at the "Invitation" line into 1200×630 composite using Sharp
- **`buildHubPage(allFlyers, deadlines)`** — Hub page listing only zones with future event dates
- **`deployAllToNetlify(pages, deadlines, eventInfoMap)`** — SHA1 manifest-diff deploy: hub page, zone HTML, `/np/` HTML, `flyer.jpg`, `og.jpg` all in one deploy

### `scripts/summary.js`
- Downloads Google Sheet as public CSV
- Filters zones by deadline (skips past-deadline zones unless TEST_MODE)
- Sends Telegram message per zone: zone name, event name, total responses, total guests, name/guest list

### `deadlines.json`
Auto-generated and committed by `automate.js` after each deploy. Structure:
```json
{
  "mountain-top": {
    "deadline": "2026-03-17",
    "eventName": "Para Satsang Sabha",
    "date": "Friday, March 20",
    "eventDate": "2026-03-20",
    "time": "6:00 pm"
  }
}
```
Used by: `summary.js` (which zones to summarize), Apps Script cleanup (which zones to clear), hub page (which zones to show).

### `Upload Flyers.command` (Desktop)
Lives in `~/Desktop/Parasabha Zones/`. Bash script that:
1. `git pull` to sync first
2. Scans each Desktop zone folder for images
3. `git rm` all existing flyers for that zone from repo
4. Copies new flyer(s) in and `git add`
5. Updates `.last-upload` timestamp (ensures push always triggers Actions)
6. Single commit + push
7. Mac notification on completion

Desktop folder → repo slug mapping:
- `Scranton` → `scranton`
- `Mountain Top` → `mountain-top`
- `Satsang Sabha` → `satsang-sabha`
- `Moosic` → `moosic`
- `Bloomsburg` → `bloomsburg`

---

## External Services

### Anthropic Claude API
- Model: `claude-sonnet-4-20250514`
- Used for: OCR of flyer images to extract event details
- Secret: `ANTHROPIC_API_KEY` (GitHub Actions secret)

### Netlify
- Site: `scparasabha.com`
- Deploy method: Direct API (SHA1 manifest diff — only uploads changed files)
- Functions directory: `netlify/functions/`
- Secrets: `NETLIFY_AUTH_TOKEN`, `NETLIFY_SITE_ID`

### Google Sheets — "Parasabha RSVPs"
- Sheet ID: `1OaLLmNaBQJ8lLSw3Y6qReao6tbHsjC7ADX7fCTDyXCc`
- Tab name: `responses`
- Columns: `zone` | `name` | `guests` | `submitted` | `__PowerAppsId__`
- Access: Public (fetched as CSV, no auth)
- `zone` values match repo slugs exactly (e.g. `mountain-top`)

### Microsoft Forms + Power Automate
- One form per zone (5 forms total), embedded as iframes on zone pages
- One Power Automate cloud flow per zone: `When a new response is submitted` → `Get response details` → `Insert row` (Google Sheets)
- Form URLs are hardcoded in `getGoogleForm()` in `automate.js`

### Telegram
- Group: "Parasabha RSVPs" (supergroup, chat ID: `-1003677003826`)
- Bot sends: RSVP summaries, late RSVP notifications, deploy confirmations
- Secrets: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`

### Pipedream
- Workflow: `prestigious-synonymous-salvageable` (v5, Active)
- Webhook URL: `https://eo894vtqftheoci.m.pipedream.net/`
- Registered as Telegram bot webhook
- Receives `/summary` command → Node.js code step → dispatches `rsvp-summary.yml` via GitHub API
- Secret needed: `GITHUB_PAT`

### Google Apps Script — "cleanup"
- Script project linked to the Google Sheet
- Function: `cleanupOldRSVPs()`
- Fetches `deadlines.json` from GitHub raw URL
- Deletes sheet rows for zones where `eventDate <= today`
- Trigger: Daily, 3–4 AM ET (GMT-04:00)
- Failure notifications: daily email

---

## GitHub Actions Secrets Required

| Secret | Used By |
|--------|---------|
| `ANTHROPIC_API_KEY` | `automate.js` — Claude OCR |
| `NETLIFY_AUTH_TOKEN` | `automate.js` — Netlify deploy |
| `NETLIFY_SITE_ID` | `automate.js` — Netlify deploy |
| `TELEGRAM_BOT_TOKEN` | `automate.js`, `summary.js` |
| `TELEGRAM_CHAT_ID` | `automate.js`, `summary.js` |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Listed in `rsvp-automation.yml` (may be unused) |
| `GITHUB_PAT` | Pipedream code step — dispatches workflow |

---

## RSVP Form Behavior

- **Before deadline:** Microsoft Form iframe shown with "Open form in browser ↗" link below
- **After deadline:** Form hidden, replaced by late RSVP panel — name + guest count inputs, "Send Late Request" button sends Telegram notification directly from browser to bot
- Deadline check is client-side JS using `rsvpDeadline` baked into the HTML at build time
- Scroll is locked to top on page load until user intentionally scrolls (prevents iframe focus-stealing)

---

## OG Image Generation

- Claude returns `invitationYPercent` — how far down the flyer (0–1) the word "Invitation" appears
- Sharp splits the flyer at that Y coordinate
- Left panel: top portion of flyer, resized to 600×630
- Right panel: bottom portion of flyer, cover-cropped to 600×630
- Final: 1200×630 JPEG at 90% quality
- Used for WhatsApp/social link previews on `/{zone}` URLs
- `/np/{zone}` URLs strip all OG tags — for sharing on WhatsApp without any preview

---

## Node.js Dependencies (`scripts/package.json`)

| Package | Purpose |
|---------|---------|
| `@anthropic-ai/sdk` | Claude API for OCR |
| `sharp` | Flyer compression + OG image generation |
| `axios` | Netlify API HTTP calls |
| `adm-zip` | Zip handling for Netlify deploy |
| `googleapis` | Google API (may be unused — summary uses public CSV) |
| `xlsx` | Spreadsheet parsing (may be unused) |
