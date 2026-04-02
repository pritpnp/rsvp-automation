# Scranton Region — RSVP Automation System

A fully automated RSVP pipeline for Scranton region events. Drop a flyer image into a folder, run one script, and a live event site deploys itself — complete with OCR-extracted event details, embedded Microsoft Forms, WhatsApp preview images, VIP passes, and Telegram summaries.

**Live site:** [screvents.com](https://screvents.com)  
**GitHub repo:** `pritpnp/rsvp-automation`  
**Telegram group:** SCREvents Admin (supergroup)

---

## How It Works — Full Pipeline

### 1. Flyer Upload
Two ways to upload a flyer:

**Mac script (original):**
1. Drop flyer image (JPG/PNG) into the correct zone folder inside `Screvents Flyers/` on your iCloud Desktop
2. Run `Upload Flyers` (double-click the Automator app on your Desktop)
3. Script stashes local changes, pulls latest, removes any old flyer for that zone from the repo, copies the new one in, commits, and pushes
4. A Mac notification confirms success ("Glass" sound), a removal-only sync, or no changes found ("Basso" sound)
5. GitHub push triggers GitHub Actions automatically

**Telegram (admin chat):**
1. Send `/uploadflyer` in the SCREvents Admin group
2. Bot prompts for a photo — send the flyer image
3. Select the zone from the inline keyboard
4. Confirm — bot commits the image to `flyers/{zone}/flyer.jpg` via GitHub Contents API
5. GitHub Actions triggers automatically

To remove a flyer via Telegram: `/removeflyer` → select zone → confirm.

### 2. GitHub Actions — Site Build (`rsvp-automation.yml`)
Triggered on every push to `main` (ignoring `dist/` changes). Runs `scripts/automate.js` which:
1. Scans all zone folders in `flyers/` for images
2. For each flyer, calls **Claude API (claude-sonnet-4-20250514)** with vision to OCR-extract event info
3. Generates a styled HTML page for the zone (Parasabha or Mandir layout depending on zone)
4. Generates a 1200×630 OG image (50/50 split: top half left panel, bottom half right panel)
5. Compresses the flyer to JPEG under 300KB
6. Writes everything to `dist/`, commits with `"deploy: update dist"`, pushes — Netlify CI deploys automatically
7. Commits updated `deadlines.json` back to the repo with `[skip ci]`

### 3. RSVP Collection
- User visits `screvents.com/{zone}` and fills out the embedded **Microsoft Form**
- **Power Automate** flow fires: `When a new response is submitted` → `Get response details` → `Insert row` into Google Sheet
- One Power Automate flow per zone, all writing to the same Google Sheet (`Parasabha RSVPs`)
- Insert row retry policy: Exponential, count 4, interval PT5S (prevents 429 failures)

### 4. Telegram Summaries
- **Automatic:** Every 3 days at 2:30 PM EDT — `rsvp-summary.yml` runs `scripts/summary.js`
- **On demand:** Send `/summary` in a Telegram group → `telegram-webhook` Netlify function receives it → triggers `rsvp-summary.yml` via GitHub API dispatch → `summary.js` reads the Google Sheet CSV → sends per-zone breakdown back to the group
- Summary only sends zones whose RSVP deadline has not yet passed (or all zones in TEST_MODE)

### 5. Final Summary
- `final-summary.yml` runs nightly at 9 PM EDT
- Sends final RSVP list for zones where `eventDate === today` to the admin group only

### 6. Nightly Cleanup
- **Google Apps Script** (`cleanupOldRSVPs`) runs daily at 3–4 AM ET
- Fetches `deadlines.json` from GitHub raw URL
- Deletes all rows from the Google Sheet for any zone where `eventDate < today`

---

## Site Structure

| URL | Description |
|-----|-------------|
| `screvents.com` | Hub page — Parasabha Events + Mandir Events sections |
| `screvents.com/{zone}` | Zone event page — flyer, event details, embedded RSVP form |
| `screvents.com/np/{zone}` | Same page, OG/Twitter meta tags stripped (WhatsApp no-preview share) |
| `screvents.com/vip/{uuid}` | VIP pass card |
| `screvents.com/admin` | Admin portal |
| `screvents.com/login` | Manager login |

### Zones

**Parasabha Events** (saffron/gold cards on hub — RSVP form always shown)
| Slug | Display Name |
|------|-------------|
| `scranton` | Scranton |
| `mountain-top` | Mountain Top |
| `moosic` | Moosic |
| `bloomsburg` | Bloomsburg |

**Mandir Events** (maroon/rose cards on hub — RSVP form only shown if deadline detected on flyer)
| Slug | Display Name |
|------|-------------|
| `satsang-sabha` | Satsang Sabha |
| `mandir-1` – `mandir-5` | Generic Mandir slots |

---

## Repo Structure

```
rsvp-automation/
├── .github/
│   └── workflows/
│       ├── rsvp-automation.yml     # Triggered on push — builds & deploys site
│       ├── rsvp-summary.yml        # Triggered on schedule or dispatch — sends RSVP summary
│       └── final-summary.yml       # Triggered nightly — sends final summary on event day
├── flyers/
│   ├── scranton/
│   ├── mountain-top/
│   ├── satsang-sabha/
│   ├── moosic/
│   ├── bloomsburg/
│   └── mandir-1/ … mandir-5/       # Each folder must have a .gitkeep
├── images/
│   ├── logo.png
│   └── sanstha.png
├── netlify/
│   └── functions/
│       ├── admin-passes.js          # VIP pass CRUD
│       ├── get-pass.js              # Public pass lookup
│       ├── get-rsvps.js             # Google Sheet read/edit/delete
│       ├── late-rsvp.js             # Late RSVP Telegram notification
│       ├── manager-auth.js          # Login/logout/verify
│       ├── superadmin-events.js     # Events table CRUD
│       ├── superadmin-managers.js   # Managers table CRUD
│       ├── telegram-webhook.js      # Telegram bot webhook handler
│       ├── package.json             # Required for @supabase/supabase-js
│       └── package-lock.json
├── public/
│   ├── admin/index.html
│   ├── login/index.html
│   └── vip/index.html
├── scripts/
│   ├── automate.js                  # Main script: OCR → HTML → deploy
│   ├── summary.js                   # Reads Google Sheet → sends Telegram summary
│   ├── final-summary.js             # Sends final RSVP list on event day
│   └── package.json
├── dist/                            # Auto-generated — do not edit manually
├── deadlines.json                   # Auto-updated by automate.js
├── netlify.toml
└── package.json
```

---

## Key Files In Detail

### `scripts/automate.js`
The brain of the system. Key functions:
- **`extractEventInfo(flyerPath)`** — Sends flyer to Claude vision API. Returns JSON: `eventName`, `date`, `time`, `location`, `description`, `rsvpDeadline`, `invitationYPercent`. Flyers over 4MB are pre-compressed with Sharp before encoding.
- **`resolveEventName(zone, ocrName)`** — Checks `zone_events` Supabase table for a canonical event name for the zone; prefers DB name over OCR result. Stale names cleared when flyer folder is empty.
- **`buildHtmlPage(eventInfo, zone, ...)`** — Generates Parasabha-style event page. RSVP form always shown.
- **`buildMandirPage(eventInfo, zone, ...)`** — Generates Mandir-style event page. RSVP form only shown if `rsvpDeadline` is set.
- **`buildOgImage(flyerPath)`** — 50/50 vertical split of flyer into 1200×630 composite using Sharp.
- **`buildHubPage(allFlyers, deadlines)`** — Hub page with two sections: Parasabha Events (saffron/gold) sorted by date ascending, and Mandir Events (maroon/rose).
- **`deployAllToNetlify(...)`** — Writes all files to `dist/`, commits `"deploy: update dist"` (no `[skip ci]`), pushes. Netlify CI watches for pushes and deploys.

### `scripts/summary.js`
- Downloads Google Sheet as public CSV (no auth needed)
- Filters zones by deadline (skips past-deadline zones unless TEST_MODE)
- Sends Telegram message per zone: zone name, event name, total responses, total guests, name/guest list

### `scripts/final-summary.js`
- Runs nightly at 9 PM EDT (1 AM UTC cron — UTC date offset handled)
- Sends final RSVP list for zones where `eventDate === today (EDT)` to admin group only

### `deadlines.json`
Auto-generated and committed by `automate.js` after each run. Used by `summary.js` (which zones to summarize), Apps Script cleanup (which zones to clear), and the hub page (which zones to show and in what order).

### `netlify/functions/telegram-webhook.js`
Handles all inbound Telegram webhook events. Key behaviors:
- `/uploadflyer` and `/removeflyer` only work in the admin chat (`TELEGRAM_CHAT_ID`)
- Multi-step flow state (upload/remove) is persisted in Supabase `telegram_upload_sessions`
- Photos are downloaded server-side from Telegram and committed to GitHub via Contents API
- All flyer images fetched server-side and sent as multipart/form-data (bypasses Palo Alto firewall)
- `allowed_updates: ["message", "callback_query"]` must be set on the webhook
- Bot privacy mode must be **off** in BotFather; bot must be re-added to groups after changing

---

## RSVP Form Behavior

- **Before deadline:** Microsoft Form iframe shown with "Open form in browser ↗" link
- **After deadline:** Form hidden, replaced by late RSVP panel — name + guest count inputs, "Send Late Request" button sends Telegram notification directly from the browser
- **Mandir zones:** Form only rendered at all if `rsvpDeadline` is present in `deadlines.json`
- Deadline check is client-side JS using `rsvpDeadline` baked into the HTML at build time

---

## OG Image Generation

- Sharp splits the flyer at exactly 50% height
- Left panel: top half of flyer, resized to 600×630
- Right panel: bottom half of flyer, cover-cropped to 600×630
- Final: 1200×630 JPEG
- Used for WhatsApp/social link previews on `/{zone}` URLs
- `/np/{zone}` strips all OG tags — for sharing on WhatsApp without any preview

---

## Admin Portal

Login at `/login`. Role-based tab access:

| Tab | Who sees it |
|-----|-------------|
| VIP Passes | All authenticated managers |
| RSVPs | Managers with `view_rsvps` permission |
| Managers | Superadmin only |
| Events | Superadmin only |

Sessions expire after 24 hours and are stored in localStorage (`admin_token`, `admin_role`, `admin_permissions`).

**Superadmin note:** Superadmin sessions have `manager_id: null` in the `manager_sessions` table. All Netlify functions must check for this before any Supabase join query — see `superadmin-events.js` for the established pattern.

---

## External Services

### Anthropic Claude API
- Model: `claude-sonnet-4-20250514`
- Used for: OCR of flyer images to extract event details
- Images over 4MB are compressed with Sharp before sending
- Secret: `ANTHROPIC_API_KEY`

### Netlify
- Site: `screvents.com`
- Deploy method: Netlify CI (watches for pushes to `main`, deploys `dist/`)
- Functions directory: `netlify/functions/`
- Secrets: `NETLIFY_AUTH_TOKEN`, `NETLIFY_SITE_ID`

### Supabase
- Tables: `vip_passes`, `managers`, `manager_sessions`, `events`, `telegram_upload_sessions`, `zone_events`
- `manager_sessions.manager_id` is nullable — `null` indicates a superadmin session
- RLS enabled on all public tables with no policies (correct given service role usage)
- Secrets: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SUPABASE_ANON_KEY`

### Google Sheets — "Parasabha RSVPs"
- Tab name: `responses`
- Columns: `zone` | `name` | `guests` | `submitted` | `__PowerAppsId__`
- Read by `summary.js` as public CSV export (no auth)
- Edited/deleted by `get-rsvps.js` via googleapis service account

### Microsoft Forms + Power Automate
- One form per zone, embedded as iframes on zone pages
- One Power Automate flow per zone: `When a new response is submitted` → `Get response details` → `Insert row` (Google Sheets)
- Insert row retry policy: Exponential, count 4, interval PT5S

### Telegram
- Bot: `@parasabha_bot`
- Bot sends: RSVP summaries, late RSVP notifications, deploy confirmations, flyer images
- Bot receives: `/summary`, `/getflyer`, `/uploadflyer`, `/removeflyer`, `/cancel` + inline keyboard callbacks
- Privacy mode: **off** (required to receive photo messages in supergroups)
- Secrets: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`

---

## GitHub Actions Secrets Required

| Secret | Used By |
|--------|---------|
| `ANTHROPIC_API_KEY` | `automate.js` — Claude OCR |
| `NETLIFY_AUTH_TOKEN` | `automate.js` — Netlify deploy |
| `NETLIFY_SITE_ID` | `automate.js` — Netlify deploy |
| `TELEGRAM_BOT_TOKEN` | `automate.js`, `summary.js`, `late-rsvp.js` |
| `TELEGRAM_CHAT_ID` | `automate.js`, `summary.js`, admin group |
| `GOOGLE_SHEET_ID` | `summary.js` |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | `get-rsvps.js` |
| `GITHUB_PAT` | `telegram-webhook.js` — workflow dispatch + GitHub Contents API |
| `ADMIN_PASSWORD` | `manager-auth.js`, `admin-passes.js`, `get-rsvps.js` |
| `SUPABASE_URL` | All Netlify functions |
| `SUPABASE_SERVICE_KEY` | All Netlify functions |
| `SUPABASE_ANON_KEY` | `get-pass.js` (public) |

---

## Known Issues & Fixes

**Upload script not triggering GitHub workflow**
Cause: Leftover local state causes `git pull` to fail silently — nothing commits, workflow never fires.
Fix: Script now stashes before pulling and pops after. Push failures surface as a Mac notification.

**Removed flyer still showing on homepage**
Cause: Old script skipped zones with no new files — `git rm` cleanup never ran.
Fix: Cleanup now always runs for every zone regardless of new files.

**Supabase join crash in Netlify functions**
Cause: Superadmin sessions have `manager_id: null`, which breaks join queries.
Fix: Check `if (!session.manager_id)` first → grant full permissions → skip manager lookup.

**Flyer image exceeding Claude API limit**
Cause: Large flyers exceed the 4MB base64 limit.
Fix: `automate.js` pre-compresses with Sharp (resize to 1800px wide, JPEG 85%) before encoding.

**Power Automate Insert row broken after editing flow**
Cause: 429 rate limit hit while saving — schema loads incorrectly.
Fix: Wait ~10 min, reopen flow, reselect the worksheet dropdown, verify all field mappings, save again.

**Photo messages not received in supergroup**
Cause: Bot privacy mode was on — bots only receive command messages by default in supergroups.
Fix: Disable privacy mode in BotFather → remove bot from group → re-add bot → re-grant admin.

**Netlify function state lost between invocations**
Cause: In-memory objects are reset on each cold start.
Fix: Use Supabase `telegram_upload_sessions` to persist upload/remove flow state across invocations.

**Telegram can't fetch screvents.com URLs**
Cause: Palo Alto Networks firewall blocks Telegram's servers from fetching the domain.
Fix: Always fetch image buffers server-side and upload as multipart/form-data. Never pass screvents.com URLs directly to Telegram's sendPhoto API.

**`@supabase/supabase-js` not available in Netlify functions**
Cause: No `package.json` in `netlify/functions/` directory.
Fix: Run `cd netlify/functions && npm init -y && npm install @supabase/supabase-js` and commit the generated files.
