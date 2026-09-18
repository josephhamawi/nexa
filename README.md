# BLS Spain Appointment Monitor (Lagos, Nigeria)

🇪🇸 Spain · 📍 Lagos, Nigeria

An availability monitor for Spanish visa appointments at the **BLS International
Lagos centre**. It watches the official portal, tells you the moment a suitable
slot appears, and then gets out of the way so you can book it yourself.

---

## What it does

- Opens the official BLS Spain Nigeria portal in a real Chromium window using a
  **persistent profile**, so you log in once and stay logged in.
- Polls the appointment page on a **randomised 3-6 minute interval** with error
  backoff.
- Detects available slots, normalises them to `YYYY-MM-DD` / `HH:mm`, and filters
  them against your preferred date and time windows.
- Alerts you via **Telegram, a desktop notification and a sound**, stops
  monitoring, captures a screenshot and leaves the browser open on the page.
- Detects CAPTCHA / human verification, login walls and session expiry, pauses,
  and hands you the browser. It then notices when you are finished and **resumes
  by itself**, without you pressing anything.
- Everything you would otherwise edit in `config.json` (visa type and category,
  Individual / Family / Group, number of applicants, date and time windows,
  polling interval, notification channels) is editable in the dashboard.

## What it deliberately does NOT do

This is a monitor, not a bot. It will never:

- solve, submit, read or interact with a CAPTCHA or any human-verification
  challenge;
- bypass Cloudflare, anti-bot systems, rate limits or fingerprinting (it runs
  stock Playwright Chromium with no stealth plugin and no fingerprint patching);
- type, store or transmit your BLS password;
- handle OTP / MFA codes;
- make a payment;
- click a final booking confirmation.

When any of those steps appears, monitoring **stops** and hands you the browser.
The code enforces this: `FORBIDDEN_ACTION_PATTERNS` in `src/bls/BlsSelectors.ts`
lists the controls the adapter refuses to click, and there is no code path that
submits a booking.

### One rule above all others

**A technical failure is never reported as "no appointments available."**

`NOT_AVAILABLE` is produced only when the page explicitly says there is nothing
to book (see `NO_APPOINTMENT_PATTERNS`). A page that failed to load, changed
shape, bounced to login or showed a CAPTCHA produces its own status
(`SITE_UNAVAILABLE`, `ERROR`, `LOGIN_REQUIRED`, `CAPTCHA_REQUIRED`), so you never
mistake a broken scraper for a fully booked centre.

---

## Architecture

```
src/
  main/            Electron shell (main process, IPC, preload)
  ui/              Dashboard (plain HTML/CSS/JS, context-isolated)
  browser/         Persistent Chromium profile + session bookkeeping
  bls/             Everything BLS-specific
     BlsSelectors.ts          all selectors, URLs and text patterns
     BlsPageDetector.ts       login / CAPTCHA / site-error detection
     BlsAvailabilityParser.ts turns a page into AVAILABLE / NOT_AVAILABLE / failure
     BlsSpainAdapter.ts       drives the portal
     errors.ts                WebsiteStructureChangedError et al.
  monitoring/      MonitorManager, MonitorWorker, Scheduler, MonitorState
  availability/    AvailabilityResult + status vocabulary and filtering
  notifications/   Telegram, desktop, sound
  storage/         State file + JSONL event log
  config/          Zod schema and loader
  logging/         Pino logger with credential redaction
  utils/           time, retry, randomDelay, screenshots
  cli/             login, monitor, check, diagnostics, test:telegram

data/
  sessions/bls-spain-lagos/   persistent Chromium profile (gitignored)
  screenshots/bls-spain-lagos/
  logs/
  state/
```

Key design points:

- **One browser, one adapter, one scheduler, one worker.** `MonitorWorker` holds
  an in-flight guard, so a scheduled poll arriving during a manual check is
  skipped rather than queued. Parallel loops are impossible by construction.
- **Detection runs on snapshots, not on live pages.** `PageSnapshot` is a plain
  serialisable object, which is why the same detection logic runs unchanged in
  unit tests against HTML fixtures.
- **Selectors live in exactly one file** with ordered fallbacks; when every
  strategy misses, the adapter raises `WebsiteStructureChangedError`.

---

## Installation

Requires **Node.js 20.10 or newer**.

```bash
cd bls-spain-monitor
npm install          # also runs "playwright install chromium"
cp .env.example .env
```

If the Chromium download was skipped:

```bash
npx playwright install chromium
```

---

## First BLS login

From the dashboard, press **Sign in to BLS**. From a terminal, `npm run login`
does the same thing.

1. Chromium opens on the BLS portal login page.
2. **Type your user id and password in the browser**, never in this application.
3. Complete the image CAPTCHA yourself.
4. The monitor watches the page you already have open and, the moment you are
   through, logs *"Verification completed in the browser. Resuming automatically."*
   and carries on. You do not have to press Resume.
5. The session stays in `data/sessions/bls-spain-lagos/` and survives restarts
   until BLS expires it.

### Why there is no password field

The dashboard has no place to type your BLS password, and there is no IPC
channel that would accept one. That is deliberate, and it is not only a policy
choice. Automated login could not work here anyway:

- the login form renders ten decoy user-id and password inputs (`UserId1..10`,
  `Password1..10`), only one pair of which is real;
- it ships a scrambled on-screen keyboard;
- the Login button stays hidden until an image CAPTCHA (*"select all boxes with
  number …"*) is solved through `btnVerify`;
- the post has to carry a matching `CaptchaId`, `ScriptData` and
  `__RequestVerificationToken`.

Those controls exist to stop automation. This application does not defeat them,
and a stored password would stop at the same CAPTCHA box while adding a real
secret to your disk for nothing. Type it in the browser; that is the one step
that has to be yours.

**What the application does instead:** it keeps a persistent browser profile, so
you sign in rarely, and it resumes on its own the moment you are done.

---

## Telegram configuration

### From the dashboard (easiest)

Press **Set up Telegram** in the Notifications card. The panel walks you through
it and saves for you:

1. Message [@BotFather](https://t.me/BotFather), send `/newbot`, copy the token.
2. Message [@userinfobot](https://t.me/userinfobot), copy your numeric chat ID.
3. Send your own new bot any message once, so it is allowed to write to you.
4. Paste both into the panel and press **Save and verify**.

Saving writes the credentials to your `.env` file with owner-only permissions
(`chmod 600`), calls Telegram's `getMe` to confirm they work, and reports the bot
name back. The token is never displayed again, never logged, and never sent back
to the dashboard. **Send test message** posts a real message to your chat.

Both fields are validated before anything is written: the chat ID must be
numeric, and the token must match Telegram's `123456789:AA...` shape.

These are credentials for a bot you own, which is why the application can hold
them. Your BLS password is different, and is never entered anywhere in this
application.

### By hand

```dotenv
TELEGRAM_BOT_TOKEN=123456789:AA...
TELEGRAM_CHAT_ID=987654321
```

Then verify with:

```bash
npm run test:telegram
```

For a packaged build the file lives at
`~/Library/Application Support/bls-spain-monitor/.env`.

---

## Configuration

`config.json`:

```json
{
  "bls": {
    "enabled": true,
    "country": "Spain",
    "applicationCountry": "Nigeria",
    "city": "Lagos",
    "centre": "Lagos",
    "visaType": "Short Stay",
    "visaSubCategory": "Tourist",
    "applicantType": "Individual",
    "memberCount": 1,
    "preferredDateFrom": "",
    "preferredDateTo": "",
    "preferredTimeFrom": "",
    "preferredTimeTo": "",
    "intervalMinSeconds": 180,
    "intervalMaxSeconds": 360
  },
  "notifications": { "telegram": true, "desktop": true, "sound": true }
}
```

| Option | Meaning |
| --- | --- |
| `visaType` | Matched case-insensitively against the category names BLS currently shows. Default `Tourist`, the short-stay category on the current site. If it is not offered, you get `VISA_CATEGORY_NOT_FOUND`, another category is never substituted. |
| `visaSubCategory` | Second-level dropdown, when the form has one (e.g. type `Short Stay` + category `Tourist`). Default `Tourist`. Empty means the portal only asks once. |
| `applicantType` | `Individual`, `Family` or `Group`. BLS schedules these separately, so getting it wrong means watching the wrong availability. |
| `memberCount` | Number of applicants on the booking. Must be 1 for `Individual` and at least 2 for `Family` / `Group`; the schema rejects anything else rather than guessing. |
| `preferredDateFrom` / `preferredDateTo` | `YYYY-MM-DD`. Empty means no bound. Slots outside the window do not raise an alert. |
| `preferredTimeFrom` / `preferredTimeTo` | `HH:mm`, 24h. Empty means no bound. A slot whose time the site did not show is kept, so a real appointment is never hidden. |
| `intervalMinSeconds` / `intervalMaxSeconds` | Randomised polling range. **180 seconds is a hard floor**; a lower value is rejected by the config validator, not silently clamped. |
| `manualCheckCooldownSeconds` | Cooldown on the CHECK NOW button. Default 90. |
| `headless` | Default `false`. Leave it that way, you cannot complete a CAPTCHA you cannot see. |

`city` and `centre` are locked to `Lagos` by the Zod schema. There is no Abuja
configuration and no centre selector.

### Editing from the dashboard

You do not have to touch `config.json` by hand. The **Application details** panel
edits every one of these fields (visa type, category, Individual / Family /
Group, number of applicants, the date and time windows, the polling interval and
the notification channels) and writes them back to `config.json`.

**Visa type** and **Category** are dropdowns, not free text. They start from the
categories published on nigeria.blsspainvisa.com, and every list keeps a
`Custom...` entry for wording that is not there.

Press **Load lists from BLS** to replace them with exactly what your own account
is offered: the adapter opens your booking page and reads the real dropdowns
(read-only, it selects nothing and books nothing), then caches them in
`data/state/bls-options.json`. It needs you to be signed in; if you are not, it
says so and opens the login page instead of guessing.

A value you have already saved always stays selectable, even if neither list
mentions it, so your configuration is never silently dropped.

Saving runs the same Zod schema the file does, and the failure comes back to the
form as one readable line, e.g.:

```
memberCount: a Family appointment needs at least 2 applicants
intervalMinSeconds: Number must be greater than or equal to 180
preferredDateTo: preferredDateTo must be on or after preferredDateFrom
```

Changes apply to the next check; nothing needs restarting. **Revert** reloads the
saved values. `city` and `centre` are forced back to Lagos on every save, no
matter what the form sends.

Everything is validated on load; a bad config fails loudly with the offending
field named.

---

## Running

| Command | What it does |
| --- | --- |
| `npm run dev` | Build, then launch the Electron dashboard |
| `npm run build` | Compile TypeScript and copy UI assets to `dist/` |
| `npm start` | Launch the dashboard from an existing build |
| `npm run login` | Manual login in the persistent profile |
| `npm run monitor` | Headless-of-Electron monitoring loop in the terminal |
| `npm run check` | One availability check, prints the normalised result |
| `npm run diagnostics` | Health report (browser, site, session, Lagos, category, notifications) |
| `npm run package` | Build a distributable desktop app into `release/` |
| `npm run icon` | Regenerate the application icon |
| `npm test` | Unit tests (no network) |
| `npm run test:telegram` | Verify the bot and send a test message |
| `npm run lint` | ESLint |

### The dashboard

`npm run dev` opens the window: a status board (state, last check, next check,
interval), the register of counters, session and notification state, the
**Application details** form, and a live event log.

Controls: **Check now** (with cooldown), **Start / Pause / Resume monitoring**,
**Sign in to BLS**, **Open browser**, **Screenshots**, **Set up Telegram** and
**Load lists from BLS**.

It ships a light theme by default, with dark and system available from the
switch in the masthead; the choice is remembered. Type is self-hosted (Fraunces
and IBM Plex Mono are bundled), so the dashboard renders identically offline and
makes no network request of its own, the renderer runs under a strict CSP with
`default-src 'none'`.

---

## What the BLS portal actually allows (read this first)

Verified against the live site with a signed-in session in September 2026:

| Route | What it is |
| --- | --- |
| `/Global/account/login` | Sign-in. Decoy field grid, scrambled keyboard, image CAPTCHA. **A GET here while signed in ends your session**, so this application only opens it when you press *Sign in to BLS*. |
| `/Global/blsappointment/MyAppointments` | Your existing bookings. Safe to poll. Used as the entry point for every check. |
| `/Global/bls/visatypeverification` | "Book New Appointment", the only door into the booking funnel. |

That last page is the constraint. Signed in, it contains exactly this and
nothing else:

```html
<input id="CaptchaData" type="hidden">
<button id="btnVerify" onclick="VerifyCaptcha();">Verify Selection</button>
<button id="btnVerified" style="display:none">Verified</button>
<button id="btnSubmit"  style="display:none">Submit</button>
```

No visa dropdowns, no centre, no calendar. Those render only after a person
solves the image challenge behind *Verify Selection*.

**So unattended, indefinite polling of appointment availability is not possible
on this portal, and this application will not make it possible.** It does not
solve that challenge. What it does instead:

1. Walks to the gate on its own and recognises it (`CAPTCHA_REQUIRED`, matched
   on `#btnVerify`), captures a screenshot, and alerts you on Telegram, desktop
   and speaker.
2. Pauses, leaving Chromium open on the exact page.
3. Watches that page while you solve the challenge, and resumes by itself the
   moment you are through.
4. Keeps polling for as long as BLS honours that verification, and alerts you
   again the next time it asks.

How long a solved verification lasts is BLS's decision, not something this
project can control or extend. The event log shows each gate as it happens, so
you will see the real cadence after a day of use.

If a tool promises you unattended BLS booking, it is solving those CAPTCHAs.
This one does not.

---

## How monitoring works

1. Navigate to `/Global/blsappointment/MyAppointments`, never to the login
   route. A dead session bounces towards login over **plain http** on a port
   that does not answer; the adapter watches for that redirect and reports
   `LOGIN_REQUIRED` within a second or two instead of hanging, and refuses to
   open the login route itself because that would end a live session.
2. Check the gates in order: site error → human verification → MFA → login.
   Any hit stops the run and returns that status.
3. Navigate to the appointment area and enter the booking flow.
4. Select **Lagos**, then verify the control really reads Lagos. If it cannot be
   selected, raise `LAGOS_SELECTION_ERROR`. Abuja is never selected, there is an
   explicit assertion against it.
5. Select the configured visa category, or raise `VISA_CATEGORY_NOT_FOUND`.
6. Harvest every visible, non-disabled slot element, normalise dates and times.
7. Decide:
   - slots parsed → `AVAILABLE`
   - explicit "no appointments" wording → `NOT_AVAILABLE`
   - anything else → `WebsiteStructureChangedError`
8. Apply the date/time filters. Slots outside your window do not alert.
9. Schedule the next poll: 3-6 min normally, 5-10 min after 1-2 consecutive
   errors, 10-20 min after 3 or more. A successful check resets it.

### When an appointment is found

Monitoring stops immediately. The browser stays open on the page, a screenshot
is saved, Telegram / desktop / sound alerts fire, the Chromium window is raised
and the dashboard switches to the appointment view. **You complete the booking.**

### CAPTCHA / manual takeover

When human verification, a login wall, an OTP prompt or an expired session is
detected:

1. Monitoring pauses. Nothing on the challenge is read, filled or clicked.
2. A screenshot lands in `data/screenshots/bls-spain-lagos/`.
3. Telegram, desktop and sound alerts fire.
4. The dashboard shows **Manual verification required** with **Open browser** and
   **Resume monitoring**.
5. A watcher starts. Every six seconds it re-reads the page **that is already
   open**, no navigation, no extra requests to BLS, and as soon as the
   challenge is gone and the session looks authenticated it logs *"Verification
   completed in the browser. Resuming automatically."* and continues.

So in practice: solve the box, and go back to what you were doing. The Resume
button is still there if you would rather drive it yourself.

### Website structure changes

If the appointment page cannot be interpreted safely, the monitor saves a
screenshot plus the URL, page title and a bounded excerpt of the visible text,
logs the error, and, after three consecutive occurrences, pauses and notifies
you. It never reports "no appointments" in this situation.

---

## Screenshots

Saved to `data/screenshots/bls-spain-lagos/` as
`YYYY-MM-DD_HH-mm-ss_event.png` for: appointment found, CAPTCHA, login required,
session expired, unexpected page, site error, structure change, Lagos selection
error, visa category not found, and diagnostics runs.

---

## Packaging a desktop app

```bash
npm run icon      # regenerates build/icon.icns from the SVG in scripts/make-icon.mjs
npm run package   # builds, then produces release/ artifacts
```

On macOS this writes `release/BLS Spain Lagos Monitor-1.0.0.dmg`, a matching
`.zip`, and `release/mac/BLS Spain Lagos Monitor.app`. Windows (`nsis`) and Linux
(`AppImage`) targets are configured too, though only the macOS build has been
exercised here.

The build is **unsigned** (`identity: null`), so the first launch needs
right-click → Open, or `xattr -dr com.apple.quarantine "BLS Spain Lagos Monitor.app"`.

A packaged app cannot write inside its own bundle, so `src/main/appPaths.ts`
redirects the editable files to `~/Library/Application Support/bls-spain-monitor/`:

```
config.json          seeded from the bundled default on first run
.env                 put your Telegram credentials here for the packaged app
data/sessions/…      the persistent BLS profile
data/screenshots/…   data/logs/   data/state/
```

Development runs are unaffected, they keep using the project folder.

Playwright is unpacked from the asar archive so Chromium can still be launched
from inside the bundle. Chromium itself is **not** bundled; it comes from the
shared `~/Library/Caches/ms-playwright` install, so run
`npx playwright install chromium` once on any machine that has not got it.

---

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| `Persistent session: ✗ not configured` | Press **Sign in to BLS**, or run `npm run login`. |
| Always `LOGIN_REQUIRED` | The BLS session expired. Press **Sign in to BLS** and sign in again. |
| "Can I save my password in the app?" | No, see *Why there is no password field*. The login is CAPTCHA-gated, so a stored password would not get you past it. |
| `APPLICANT_SELECTION_ERROR` | The Individual / Family / Group value or the applicant count could not be set. The message lists what BLS actually offered. |
| macOS: "app is damaged / unidentified developer" | The build is unsigned. Right-click → Open, or `xattr -dr com.apple.quarantine`. |
| `CAPTCHA_REQUIRED` immediately | Complete the verification in the open Chromium window, then resume. This is expected behaviour, not a bug. |
| `SITE_UNAVAILABLE` repeatedly | BLS is down or rate limiting. The backoff will slow polling automatically; leave it running. |
| `WEBSITE STRUCTURE MAY HAVE CHANGED` | BLS changed the page. See the screenshot and the log, then update `src/bls/BlsSelectors.ts`. |
| `LAGOS_SELECTION_ERROR` | Lagos is not in the centre list on that page. Check the screenshot; the monitor refuses to continue rather than pick another centre. |
| `VISA_CATEGORY_NOT_FOUND` | The diagnostics output lists the categories BLS actually offers; copy one into `visaType`. |
| Chromium will not start | `npx playwright install chromium`. |
| Telegram silent | `npm run test:telegram`. Remember to `/start` your bot once. |

Logs: `data/logs/monitor.log`. Event history: `data/state/events.jsonl`.

---

## Diagnostics

```bash
npm run diagnostics
```

Reports Playwright availability, BLS reachability, the persistent session,
authentication state, appointment-page access, whether Lagos is offered, whether
your visa category exists, and the notification channels. Read-only: it never
logs in, never touches a CAPTCHA and never books.

Exit codes: `0` healthy, `1` needs your attention, `2` broken.

---

## Security

`.gitignore` covers `.env`, `data/sessions/`, `data/screenshots/`,
`data/logs/`, `node_modules/` and `dist/`.

- The BLS password is never requested, stored or logged. It only ever exists in
  the browser window you type it into.
- Authentication material lives solely inside Playwright's own profile
  directory. The state file holds operational data only.
- The Pino logger redacts passwords, cookies, tokens, OTPs, CAPTCHA fields,
  `__RequestVerificationToken`, passport and payment keys at every nesting level.
- URLs are logged with their query strings stripped.
- Telegram errors are scrubbed of anything token-shaped before they are recorded.
- The Electron renderer runs with context isolation on and no Node integration;
  its only capability is the narrow IPC surface in `src/main/preload.ts`, and
  screenshot opening is restricted to the screenshot directory.

---

## Updating selectors when BLS changes

Everything BLS-specific is in `src/bls/BlsSelectors.ts`.

1. Run `npm run diagnostics` and look at the screenshot it saves.
2. Open the page yourself in the monitor's Chromium (`npm run login`) and inspect
   the control that broke.
3. Add a new strategy to the relevant array, **prepend** it so it is tried
   first, and leave the old one as a fallback:

   ```ts
   export const LOCATION_CONTROLS: SelectorStrategy[] = [
     { kind: 'role', role: 'combobox', name: /application centre/i }, // new
     { kind: 'label', text: /location|centre|center|city|office/i },  // existing
     // …
   ];
   ```

   Prefer roles, labels, form names and visible text. Avoid positional selectors
   such as `button:nth-child(5)`.
4. If the wording for "no appointments" changed, add the new phrasing to
   `NO_APPOINTMENT_PATTERNS`, the monitor will report a structure change rather
   than a false "no appointments" until you do.
5. Add a fixture under `tests/fixtures/` reproducing the new markup and a test
   asserting the behaviour, then `npm test`.

---

## Testing

```bash
npm test
```

91 unit tests covering the availability parser, date and time filtering, state
transitions, CAPTCHA detection, login and session-expiry detection, site-error
detection, error mapping and retry, the scheduler and its backoff, Telegram
message formatting, configuration validation (including the refusal of any
non-Lagos centre), and availability normalisation.

Tests run against HTML fixtures in `tests/fixtures/` and a stubbed `fetch`.
**No test contacts BLS or Telegram.**

---

## Scope

Version 1 supports BLS Spain, Nigeria, Lagos, one account, monitoring only. No
Abuja, no other countries, no other providers, no automatic booking, no
payments. The layering, adapter, detector, parser, notifier, is where you would
add more later.
