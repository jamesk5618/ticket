// ============================================================================
// ONE-TIME SETUP — run this once (and only again if it ever fails, see below)
//   npm run login
// ============================================================================
//
// This opens a real, visible Chrome window with its own local profile.
// Log in there by hand — including "Sign in with Google" and any 2FA, since
// EazyBusiness doesn't support plain username/password login. Once you
// confirm, this script automatically:
//
//   1. Reads ALL of the browser's cookies for BOTH help.eazybusiness.in AND
//      Google's own domain, INCLUDING HttpOnly ones (session cookies) —
//      Playwright can read these because it talks to Chrome via DevTools
//      Protocol, unlike page JavaScript (document.cookie), which is blocked
//      from HttpOnly cookies by design.
//   2. Pushes that full cookie set straight to your deployed dashboard's
//      Login Settings via its API — which stores it in Supabase — so the
//      live, headless automation on Render picks it up immediately.
//
// Why capture Google's cookies too: EazyBusiness's own session expires
// often, but Google's session inside this profile lasts far longer. The
// deployed automation (src/automation.js) uses that saved Google session to
// silently re-authenticate ITSELF whenever EazyBusiness logs it out — no
// scheduled task, no daily script, no human required. You should only need
// to run this script again when Google's OWN session finally expires too
// (rare — weeks/months, or after a password change / "sign out
// everywhere"), which the Live Logs will tell you clearly if it happens.
//
// If DASHBOARD_URL / DASHBOARD_PASSWORD aren't set in .env, it just prints
// the JSON so you can paste it into the dashboard manually instead.

require('dotenv').config();
const { chromium } = require('playwright');
const readline = require('readline');
const path = require('path');

const BASE_URL = process.env.BASE_URL || 'https://help.eazybusiness.in';
const LOGIN_URL = process.env.LOGIN_URL || `${BASE_URL}/login`;
const TICKET_CREATE_URL = process.env.TICKET_CREATE_URL || `${BASE_URL}/tickets/create`;
const USER_DATA_DIR = process.env.USER_DATA_DIR || path.join(process.env.DATA_DIR || './data', 'chrome-profile');

// Your live Render URL, e.g. https://ticket-yt7o.onrender.com — no trailing slash needed.
const DASHBOARD_URL = process.env.DASHBOARD_URL || '';
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';

function waitForEnter(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, () => { rl.close(); resolve(); }));
}

// Keep cookies for EazyBusiness itself AND Google's own domain. The deployed
// automation needs BOTH: the EazyBusiness cookie for the actual session, and
// Google's session cookie so it can silently re-authenticate itself via
// "Sign in with Google" later on, without any human involved — see
// src/automation.js's googleSilentReauth().
function filterRelevantCookies(cookies) {
  return cookies
    .filter((c) => {
      if (!c.domain) return false;
      const d = c.domain.replace(/^\./, '');
      return d.includes('eazybusiness.in') || d.includes('google.com');
    })
    .map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
      httpOnly: c.httpOnly,
      secure: c.secure,
      // Playwright's sameSite is already 'Strict' | 'Lax' | 'None', matching
      // what automation.js's applyCookies() expects — no translation needed.
      sameSite: c.sameSite
    }));
}

async function pushCookiesToDashboard(cookies) {
  if (!DASHBOARD_URL || !DASHBOARD_PASSWORD) {
    console.log('\n⚠️  DASHBOARD_URL / DASHBOARD_PASSWORD not set in .env — not auto-uploading.');
    console.log('   Paste this into the dashboard → Login Settings → Session Cookies box:\n');
    console.log(JSON.stringify(cookies));
    return false;
  }

  const url = DASHBOARD_URL.replace(/\/+$/, '') + '/api/settings';
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-dashboard-password': DASHBOARD_PASSWORD },
      body: JSON.stringify({ cookiesJson: JSON.stringify(cookies) })
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.log(`\n❌ Dashboard rejected the upload (HTTP ${res.status}). ${text}`.trim());
      console.log('   Double-check DASHBOARD_URL and DASHBOARD_PASSWORD in .env, or paste this manually:\n');
      console.log(JSON.stringify(cookies));
      return false;
    }
    console.log(`\n✅ Pushed ${cookies.length} cookie(s) to ${DASHBOARD_URL} — the live automation will use them right away, no redeploy needed.`);
    return true;
  } catch (err) {
    console.log(`\n❌ Could not reach ${url}: ${err.message}`);
    console.log('   Paste this into the dashboard manually instead:\n');
    console.log(JSON.stringify(cookies));
    return false;
  }
}

(async () => {
  console.log(`Opening Chrome with profile: ${USER_DATA_DIR}`);
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    channel: 'chrome',
    viewport: null,
    args: ['--start-maximized']
  });

  const page = context.pages()[0] || (await context.newPage());
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});

  console.log('\nA Chrome window has opened. Log in there manually — use "Sign in with Google" and complete any 2FA.');
  await waitForEnter('Once you are fully logged in and see the dashboard, come back here and press Enter... ');

  // Verify by checking for an element that only exists once inside the app.
  const page2 = await context.newPage();
  await page2.goto(TICKET_CREATE_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  const probe = await page2.waitForSelector('#btn_search_contact_id', { timeout: 8000 }).catch(() => null);

  if (probe) {
    console.log('\n✅ Login confirmed.');
    const allCookies = await context.cookies();
    const relevant = filterRelevantCookies(allCookies);
    console.log(`Captured ${relevant.length} cookie(s) — EazyBusiness session + Google session (including HttpOnly ones).`);
    await pushCookiesToDashboard(relevant);
  } else {
    console.log('\n⚠️  Could not confirm login (the ticket-create page did not show the expected contact-search icon).');
    console.log('   Double check you are fully logged in, then re-run "npm run login" if needed.');
  }

  await waitForEnter('\nPress Enter to close this browser window... ');
  await context.close();
  process.exit(0);
})();