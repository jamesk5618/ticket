# EazyBusiness Ticket Automation — Server Edition (headless, Render-ready)

Converts the old Tampermonkey userscript into a 24/7 server-side service:
- **Playwright (headless Chromium)** drives the automation — fills the ticket
  form, searches contacts/brands, sends the resolution email, closes the
  ticket. No visible browser window, so it runs on Render (which has no
  display) or any headless server.
- **Express dashboard** to upload the employee CSV/Excel, start/stop the run,
  watch live logs, and manage login credentials.
- **Persistent queue** stored on disk (`/data/db.json`), so it survives
  restarts and paces itself with your configured gap between tickets.
- **UptimeRobot-friendly**: `/healthz` responds instantly with no auth, so a
  free UptimeRobot monitor pinging it every 5 minutes keeps a Render
  "Starter" (always-on) instance alive and detects downtime.

## 1. How login works (important — read this)

Render containers have **no display**, so this cannot open a visible Chrome
window for you to log in by hand. Authentication instead works like this:

**Primary method — session cookies (works even with 2FA):**
1. Log into `help.eazybusiness.in` normally, in your own browser, on your PC.
2. Export your cookies as JSON — e.g. install the "Cookie-Editor" extension,
   open it on the eazybusiness tab, click **Export → Export as JSON**.
3. Paste that JSON array into the dashboard → **Login Settings → Session
   Cookies** box, and click **Save Login Settings**.
4. The automation loads these cookies into its headless browser before every
   run — no restart needed, it picks up new cookies automatically.
5. **Cookies expire.** When they do, ticket creation will start failing with
   a "Not logged in" error in the Live Logs. Just repeat steps 1–3 to refresh
   them.

**Fallback method — username & password (only works if the site has no
CAPTCHA/2FA):**
Set `EAZY_USERNAME` / `EAZY_PASSWORD` (env vars or dashboard → Login
Settings). If cookies are missing or stale, the automation will try a
scripted login using the selectors in `LOGIN_USERNAME_SELECTOR` /
`LOGIN_PASSWORD_SELECTOR` / `LOGIN_SUBMIT_SELECTOR` — update these to match
the real login form if they don't match (right-click the field → Inspect).

`src/manual-login.js` (`npm run login`) still exists for **local debugging
only** — it opens a real visible Chrome window so you can watch selectors
work, but it is not used and cannot be used on Render.

## 2. Local test run

```bash
cp .env.example .env
# edit .env with real values
npm install
npx playwright install --with-deps chromium
npm start
# open http://localhost:3000
```

## 3. Deploy to Render

1. Push this folder to a GitHub repo. **Do not commit `.env`** — it's already
   listed in `.gitignore`; put real secrets into Render's dashboard instead.
2. In Render: **New → Blueprint**, point it at the repo (it reads
   `render.yaml` automatically). This provisions a 1GB persistent Disk
   mounted at `/data` for your queue/logs/cookies — without it, everything
   resets on every deploy.
3. Render will ask you to fill in the `sync: false` secrets:
   - `DASHBOARD_PASSWORD` — password you'll use to log into your own dashboard
   - `EAZY_USERNAME` / `EAZY_PASSWORD` — optional fallback (method B above)
4. Deploy. It uses the `Dockerfile`, which is based on Playwright's official
   image (`mcr.microsoft.com/playwright:...`) — Chromium and all OS deps are
   already baked in, so headless automation works with no extra setup.
5. Visit `https://<your-service>.onrender.com`, log in with your dashboard
   password, and paste your session cookies into **Login Settings** (step 1
   above). Cookies can be updated any time directly in the UI — no redeploy
   needed.

> Use the **Starter** plan (already set in `render.yaml`) for true 24/7
> operation — Render's free tier spins down after inactivity, which
> interrupts a running queue and defeats the point of UptimeRobot pinging it.

## 4. Keep it alive 24/7 with UptimeRobot

1. Create a free account at uptimerobot.com.
2. Add a new **HTTP(s) monitor**, URL = `https://<your-service>.onrender.com/healthz`.
3. Set the check interval to 5 minutes (free tier minimum).
4. That's it — as long as the Render service is on the Starter plan (not
   Free), this keeps the process warm and alerts you if it ever goes down.
   It does **not** fix expired session cookies — you still need to refresh
   those yourself when login starts failing (Live Logs will show it).

## 5. Uploading employees

Dashboard → "Upload Employee List" accepts `.csv` or `.xlsx`. Recognized
columns (case/space-insensitive): `EmployeeName` (required), `Company` /
`Brand` / `BrandName` / `Distributor`, `Phone`, `Email`, `Subject` (must
match one of the keys in Login Settings → Subject Mapping, otherwise it
defaults to "Test"). See `sample-employees.csv` for the format.

## 6. If selectors on the actual site differ

This is a faithful port of the original script's selectors (`lbl_Contact
Name`, `lbl_Brand`, `category_c`, `rca_type_c`, `status`, `btn_save`, the
Froala email editor class, etc). If EazyBusiness changes their UI, update
the matching selectors in `src/automation.js` — everything is grouped by
function name so it maps 1:1 to the old userscript functions
(`selectBrand`, `addPhone`, `addEmail`, `openContactSearch`, `searchContact`,
`createTicket`, `sendResolutionEmail`, `closeTicket`).

## 7. Watching it work

Because this runs headless on a server, you can't "see" the browser. Use the
**Live Logs** panel on the dashboard — every step (login, ticket created,
email sent, ticket closed, or any error) is logged there in real time. To
visually debug selectors locally before deploying, temporarily change
`headless: true` to `headless: false` in `src/automation.js`'s `getContext()`
— that only works on a machine with a display (your PC), not on Render.
