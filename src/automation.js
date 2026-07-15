const { chromium } = require('playwright');
const path = require('path');
const { db, log } = require('./db');

const BASE_URL = process.env.BASE_URL || 'https://help.eazybusiness.in';
const TICKET_CREATE_URL = process.env.TICKET_CREATE_URL || `${BASE_URL}/tickets/create`;
const LOGIN_URL = process.env.LOGIN_URL || `${BASE_URL}/login`;

// Selectors used for scripted username/password login (fallback path, only
// used if no valid cookies are set). Configurable via env / render.yaml
// since the real selectors depend on the site's actual login form.
const LOGIN_USERNAME_SELECTOR = process.env.LOGIN_USERNAME_SELECTOR || '#username';
const LOGIN_PASSWORD_SELECTOR = process.env.LOGIN_PASSWORD_SELECTOR || '#password';
const LOGIN_SUBMIT_SELECTOR = process.env.LOGIN_SUBMIT_SELECTOR || 'button[type=submit]';

// The exact "Sign in with Google" button/link markup varies by site. These
// are reasonable guesses tried in order; if none match, set
// GOOGLE_BUTTON_SELECTOR in .env to the real one (right-click the button on
// the login page -> Inspect -> Copy selector).
const GOOGLE_BUTTON_SELECTORS = [
  process.env.GOOGLE_BUTTON_SELECTOR,
  'a[href*="accounts.google.com"]',
  'a:has-text("Google")',
  'button:has-text("Google")',
  '[class*="google" i]'
].filter(Boolean);

// Kept only for local/backwards compatibility. No longer required for
// login — cookies are the primary auth path since Render containers have
// no display for a manual, visible-Chrome login.
const USER_DATA_DIR = process.env.USER_DATA_DIR || path.join(process.env.DATA_DIR || './data', 'chrome-profile');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Robust click: tries a normal Playwright click first, but this site has a
// fixed/sticky top navbar (`nav.navbar...top-nav-bar`) that sits on top of
// the page and keeps intercepting pointer events for anything scrolled near
// the top. Playwright's actionability checks correctly refuse to click
// through that overlap and just retry for 30s until they time out. Rather
// than fighting the overlap with scroll offsets, fall back to dispatching
// the click directly in the page (bypassing the overlap/visibility checks)
// when the real click doesn't succeed quickly.
async function safeClick(handleOrLocator, { timeout = 6000 } = {}) {
  try {
    await handleOrLocator.click({ timeout });
    return true;
  } catch (err) {
    try {
      await handleOrLocator.evaluate((el) => el.click());
      return true;
    } catch (err2) {
      log('warn', `safeClick fallback also failed: ${err2.message}`);
      return false;
    }
  }
}

/* ================= LOGIN (session-based) ================= */

// This selector only exists once you're actually inside the app (it's on the
// ticket-create form), never on the login page — so it's a reliable signal
// for "are we really logged in".
const LOGGED_IN_PROBE_SELECTOR = '#btn_search_contact_id';

async function isLoggedIn(page) {
  await page.goto(TICKET_CREATE_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  const probe = await page.waitForSelector(LOGGED_IN_PROBE_SELECTOR, { timeout: 8000 }).catch(() => null);
  return !!probe;
}

// Parses the cookies JSON pasted into the dashboard's "Session Cookies" box
// (the same format Cookie-Editor's "Export → JSON" produces) and loads them
// into the given browser context before any navigation happens.
async function applyCookies(context) {
  const raw = db.get('settings.cookiesJson').value();
  if (!raw) return false;
  let cookies;
  try {
    cookies = JSON.parse(raw);
  } catch (err) {
    log('error', `Stored cookiesJson is not valid JSON: ${err.message}`);
    return false;
  }
  if (!Array.isArray(cookies) || !cookies.length) return false;

  // Normalize common export quirks: Cookie-Editor sometimes emits
  // sameSite values Playwright doesn't accept, and may omit url/domain.
  const normalized = cookies
    .filter((c) => c && c.name && c.value)
    .map((c) => {
      const out = { name: c.name, value: String(c.value) };
      if (c.domain) out.domain = c.domain;
      else out.url = BASE_URL;
      out.path = c.path || '/';
      if (c.expirationDate) out.expires = c.expirationDate;
      else if (c.expires) out.expires = c.expires;
      if (typeof c.httpOnly === 'boolean') out.httpOnly = c.httpOnly;
      if (typeof c.secure === 'boolean') out.secure = c.secure;
      if (c.sameSite) {
        const v = String(c.sameSite).toLowerCase();
        out.sameSite = v === 'no_restriction' ? 'None' : v === 'lax' ? 'Lax' : v === 'strict' ? 'Strict' : undefined;
      }
      return out;
    });

  await context.addCookies(normalized);
  log('info', `Loaded ${normalized.length} cookies from saved session settings.`);
  return true;
}

// Clicks a "Sign in with Google" button/link if one is found on the current
// page. Returns true if something was clicked (not whether login actually
// succeeded — caller checks that separately).
async function clickGoogleButton(page) {
  for (const sel of GOOGLE_BUTTON_SELECTORS) {
    const el = await page.$(sel).catch(() => null);
    if (el) {
      log('info', `Clicking "Sign in with Google" (matched selector: ${sel})`);
      await el.click().catch(() => {});
      return true;
    }
  }
  return false;
}

// The self-healing trick: EazyBusiness's own session cookie expires often,
// but the GOOGLE session cookies captured during the one-time "npm run
// login" (and re-saved here after every successful login — see
// persistFreshCookies below) last much longer. When EazyBusiness logs us
// out, revisiting its login page and clicking "Sign in with Google" again
// lets Google recognize its own still-valid session cookie already loaded
// into this browser context and silently redirect straight through — no
// password, no 2FA, no human needed — exactly like staying signed into
// Gmail on a browser and having every Google-linked site auto-log-you-in.
// This only fails once Google's OWN session eventually expires too (which
// happens far less often), at which point login() falls through to the
// password fallback and finally a clear error telling you to log in by hand
// once via "npm run login".
async function googleSilentReauth(page) {
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});

  const clicked = await clickGoogleButton(page);
  if (!clicked) {
    log('warn', 'Silent Google re-auth: no "Sign in with Google" button found on the login page ' +
      '(set GOOGLE_BUTTON_SELECTOR in env if the site\'s markup differs from the built-in guesses).');
    return false;
  }

  // The Google OAuth step can either redirect the same tab or open a popup,
  // depending on how the site implements it — handle both.
  const popup = await page.context().waitForEvent('page', { timeout: 3000 }).catch(() => null);
  if (popup) {
    await popup.waitForLoadState('domcontentloaded').catch(() => {});
    await wait(2500);
    await popup.close().catch(() => {});
  }

  await wait(2500);
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  return isLoggedIn(page);
}

// After any successful login (silent Google re-auth or password), capture
// the browser's current cookies — INCLUDING Google's own domain cookies,
// not just EazyBusiness's — and save them back to storage. This is what
// makes the self-healing loop durable across server restarts/redeploys: a
// brand-new headless context on a fresh boot still has Google's session
// available to retry this same trick, not just whatever was captured once
// during the original manual login.
async function persistFreshCookies(context) {
  try {
    const cookies = await context.cookies();
    const relevant = cookies.filter(
      (c) => c.domain && (c.domain.replace(/^\./, '').includes('eazybusiness.in') || c.domain.replace(/^\./, '').includes('google.com'))
    );
    db.set('settings.cookiesJson', JSON.stringify(relevant)).write();
    db.set('settings.cookiesUpdatedAt', Date.now()).write();
    cookiesAppliedAt = Date.now(); // we already have these applied in this context; avoid a redundant re-apply on the next getContext() call
    log('info', `Saved ${relevant.length} refreshed cookie(s) (EazyBusiness + Google session) for future runs.`);
  } catch (err) {
    log('warn', `Could not persist refreshed cookies: ${err.message}`);
  }
}
async function passwordLogin(page) {
  const settings = db.get('settings').value();
  const { username, password } = settings;
  if (!username || !password) return false;

  log('info', 'Attempting username/password login.');
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  const userField = await page.waitForSelector(LOGIN_USERNAME_SELECTOR, { timeout: 10000 }).catch(() => null);
  if (!userField) {
    log('warn', `Login username field (${LOGIN_USERNAME_SELECTOR}) not found.`);
    return false;
  }
  await page.fill(LOGIN_USERNAME_SELECTOR, username);
  await page.fill(LOGIN_PASSWORD_SELECTOR, password);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}),
    page.click(LOGIN_SUBMIT_SELECTOR).catch(() => {})
  ]);
  await wait(1000);
  return isLoggedIn(page);
}

async function login(page) {
  if (await isLoggedIn(page)) {
    log('info', 'Session already valid — skipping login.');
    return true;
  }

  // Cookies were applied to the context before this page navigated (see
  // getContext), so if we're here they were either absent or the
  // EazyBusiness session specifically has expired. Try the silent Google
  // re-auth trick first — it needs no human interaction as long as
  // Google's own session cookie (saved during "npm run login" and kept
  // fresh by persistFreshCookies) is still valid.
  if (await googleSilentReauth(page)) {
    log('success', 'Silently re-authenticated via Google using the saved session — no manual login needed.');
    await persistFreshCookies(page.context());
    return true;
  }

  // Fallback: scripted username/password, only useful if EAZY_USERNAME /
  // EAZY_PASSWORD are set and the site ever supports non-SSO login.
  if (await passwordLogin(page)) {
    log('success', 'Logged in via username/password.');
    await persistFreshCookies(page.context());
    return true;
  }

  log('error', 'Not logged in — silent Google re-auth and username/password login both failed or were not available.');
  throw new Error(
    'Not logged in. This usually means the saved GOOGLE session itself has finally expired (rare — ' +
    'happens after weeks/months, a password change, or "sign out everywhere"), not just the EazyBusiness ' +
    'cookie. Run "npm run login" once locally (log in via Google) to restore it — after that, this server ' +
    'will keep re-authenticating itself automatically again for a long while.'
  );
}

/* ================= LOW-LEVEL HELPERS (mirroring the original userscript) ================= */

// Node-safe replacement for the browser-only `CSS.escape`. This helper runs
// server-side in Node (page.fill / waitForSelector are called from the Node
// context, not from inside page.evaluate), so referencing the global `CSS`
// object throws "CSS is not defined" — that's what was breaking every ticket
// right after the contact search succeeded. This does the same job: escape
// any character that isn't a plain word-char or hyphen so it's safe to use
// in an "#id" selector.
function escapeCssId(id) {
  return String(id).replace(/([^\w-])/g, '\\$1');
}

async function setInputValueById(page, id, value) {
  if (value === undefined || value === null || value === '') return;
  const sel = `#${escapeCssId(id)}`;
  await page.waitForSelector(sel, { timeout: 10000 }).catch(() => {});
  await page.fill(sel, String(value)).catch(async () => {
    // fallback for non-standard inputs
    await page.evaluate(({ id, value }) => {
      const el = document.getElementById(id);
      if (el) {
        el.focus();
        el.value = value;
        ['input', 'change', 'blur'].forEach((ev) => el.dispatchEvent(new Event(ev, { bubbles: true })));
      }
    }, { id, value });
  });
}

async function setSelectValueById(page, id, textToSelect) {
  if (!textToSelect) return;
  await page.evaluate(({ id, textToSelect }) => {
    const sel = document.getElementById(id);
    if (!sel) return false;
    for (let i = 0; i < sel.options.length; i++) {
      if (sel.options[i].text.trim().toLowerCase() === textToSelect.toLowerCase()) {
        sel.selectedIndex = i;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
    }
    return false;
  }, { id, textToSelect });
}

async function findButtonNearInput(page, inputId) {
  return page.evaluate((inputId) => {
    let el = document.getElementById(inputId);
    for (let i = 0; i < 7 && el; i++) {
      const btn = el.querySelector && el.querySelector('button');
      if (btn) {
        btn.setAttribute('data-automation-target', 'true');
        return true;
      }
      el = el.parentElement;
    }
    return false;
  }, inputId);
}

async function clickMarkedButton(page) {
  const btn = await page.$('[data-automation-target="true"]');
  if (btn) {
    await btn.scrollIntoViewIfNeeded().catch(() => {});
    await safeClick(btn);
    await page.evaluate(() => {
      const el = document.querySelector('[data-automation-target="true"]');
      if (el) el.removeAttribute('data-automation-target');
    });
  }
  return !!btn;
}

async function waitForLookupSearchInput(page) {
  return page.waitForSelector('.modal.show input.if-text-basic-search', { timeout: 15000 });
}

async function selectFirstLookupRow(page) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const row = await page.$('.modal.show td.relate-select-td a.get-select-val');
    if (row) {
      await row.scrollIntoViewIfNeeded();
      await wait(300);
      await safeClick(row);
      return true;
    }
    const empty = await page.$('.modal.show .dataTables_empty');
    if (empty && await empty.isVisible()) {
      log('warn', 'No lookup results found, closing modal.');
      const closeBtn = await page.$('.modal.show button.close');
      if (closeBtn) await safeClick(closeBtn);
      return false;
    }
    await wait(300);
  }
  log('warn', 'Timed out waiting for lookup results.');
  return false;
}

async function selectBrand(page, name) {
  if (!name) return;
  const found = await findButtonNearInput(page, 'lbl_Brand');
  if (found) await clickMarkedButton(page);
  await wait(1000);
  const search = await waitForLookupSearchInput(page);
  await search.fill(name);
  await search.press('Enter');
  await wait(2000);
  await selectFirstLookupRow(page);
}

async function addPhone(page, phone) {
  if (!phone) return;
  const found = await findButtonNearInput(page, 'lbl_Phone');
  if (found) await clickMarkedButton(page);
  await page.waitForSelector('#phone_no', { timeout: 10000 });
  await page.fill('#phone_no', String(phone));
  await page.evaluate(() => {
    const input = document.getElementById('phone_no');
    input.closest('.input-group')?.querySelector('button')?.click();
  });
  await wait(500);
}

async function addEmail(page, email) {
  if (!email) return;
  const found = await findButtonNearInput(page, 'lbl_Email');
  if (found) await clickMarkedButton(page);
  await page.waitForSelector('#email_id', { timeout: 10000 });
  await page.fill('#email_id', String(email));
  await page.evaluate(() => {
    const input = document.getElementById('email_id');
    input.closest('.input-group')?.querySelector('button')?.click();
  });
  await wait(500);
}

async function openContactSearch(page) {
  const btn = await page.$('#btn_search_contact_id');
  if (!btn) throw new Error('Contact search icon not found');
  await btn.scrollIntoViewIfNeeded();
  await wait(300);
  await safeClick(btn);
}

async function searchContact(page, name) {
  if (!name) return;
  const search = await waitForLookupSearchInput(page);
  await search.fill(name);
  await search.press('Enter');
  await wait(2000);
  await selectFirstLookupRow(page);
}

/* ================= HIGH-LEVEL WORKFLOW (create -> email -> close) ================= */

const DRAFT_MESSAGE = `
Dear Sir,<br>
    Greetings from Recibo.<br><br>
    Your issue has been successfully resolved. If you need any further assistance, please feel free to let us know.<br><br>
    Best Regards,<br>
    Team Recibo
  `;

async function createTicket(page, emp) {
  const settings = db.get('settings').value();
  const subjectVal = emp.Subject || 'Test';
  const logic = settings.subjectMapping[subjectVal] || settings.subjectMapping['Test'] || { category: '', rca: '' };

  await page.goto(TICKET_CREATE_URL, { waitUntil: 'domcontentloaded' });
  await wait(1000);

  // Pass the raw id — escapeCssId() handles the space (and any other
  // special characters) internally, so no manual `.replace()` is needed.
  await setInputValueById(page, 'lbl_Contact Name', emp.EmployeeName).catch(() => {});
  await openContactSearch(page);
  await searchContact(page, emp.EmployeeName);
  await wait(1000);

  if (emp.Company) await selectBrand(page, emp.Company);
  await wait(500);

  await setInputValueById(page, 'name', subjectVal);
  await wait(400);
  await setSelectValueById(page, 'category_c', logic.category);
  await wait(400);
  await setSelectValueById(page, 'rca_type_c', logic.rca);
  await wait(400);
  await setInputValueById(page, 'sales_info_c', emp.EmployeeName);
  await wait(400);
  await setSelectValueById(page, 'support_mode', 'Bug');
  await wait(400);
  await setSelectValueById(page, 'status', 'Resolved');
  await wait(400);
  await setSelectValueById(page, 'case_origin_c', 'Self');
  await wait(500);

  if (emp.Phone) await addPhone(page, emp.Phone);
  if (emp.Email) await addEmail(page, emp.Email);

  await wait(1000);
  const saveBtn = await page.$('#btn_save');
  if (!saveBtn) throw new Error('Save button not found on ticket create form');
  await safeClick(saveBtn);
  await wait(3000);

  log('success', `Ticket created for ${emp.EmployeeName}`, { subject: subjectVal });
  return { subjectVal };
}

async function sendResolutionEmail(page) {
  // The site should now be showing the ticket detail. Find the compose-email link.
  const composeLink = await page.$('a.intercom-detail-view-compose-email');
  if (!composeLink) {
    log('warn', 'Compose-email link not found; skipping email step.');
    return false;
  }
  const href = await composeLink.getAttribute('href');
  if (!href || !href.includes('record_id=')) {
    log('warn', 'Compose-email link missing record_id; skipping email step.');
    return false;
  }

  const emailUrl = href.startsWith('http') ? href : new URL(href, BASE_URL).toString();
  await page.goto(emailUrl, { waitUntil: 'domcontentloaded' });

  const selector = '.col.pb-1 > .fr-box.fr-basic.fr-top > .fr-wrapper.show-placeholder > .fr-element.fr-view';
  const editor = await page.waitForSelector(selector, { timeout: 20000 }).catch(() => null);
  if (!editor) {
    log('warn', 'Email editor did not load; skipping email step.');
    return false;
  }

  await safeClick(editor);
  await wait(300);
  await page.evaluate((html) => {
    document.execCommand('insertHTML', false, html);
  }, DRAFT_MESSAGE);
  await wait(2000);

  const sendBtn = await page.$('#btn_send');
  if (sendBtn) {
    await safeClick(sendBtn);
    await wait(3000);
    log('success', 'Resolution email sent.');
    return true;
  }
  log('warn', 'Send button not found.');
  return false;
}

async function closeTicket(page, subjectVal) {
  const settings = db.get('settings').value();
  await wait(2000);

  const editBtn = await page.$('#edit-button-Ticket');
  if (editBtn) {
    await safeClick(editBtn);
    await wait(1500);
  }

  const statusSelect = await page.$('#status');
  if (!statusSelect) {
    log('warn', 'Could not find status field to close the ticket.');
    return false;
  }

  const logic = settings.subjectMapping[subjectVal] || { rca: 'Restart App' };
  await setSelectValueById(page, 'rca_type_c', logic.rca);
  await wait(800);
  await setSelectValueById(page, 'status', 'Closed');
  await wait(1000);

  const saveBtn = await page.$('#btn_save');
  if (saveBtn) {
    await saveBtn.click();
    await wait(2000);
    log('success', 'Ticket closed.');
    return true;
  }
  log('warn', 'Save button not found while closing ticket.');
  return false;
}

/* ================= ENTRY POINT ================= */

// Single shared headless browser context, reused across every ticket in the
// queue. Runs headless because Render's containers have no display — auth
// is handled by injecting session cookies (or scripted password login)
// rather than a manual, visible-Chrome login.
let browserSingleton = null;
let contextSingleton = null;
let cookiesAppliedAt = 0;

async function getContext() {
  if (!browserSingleton) {
    browserSingleton = await chromium.launch({ headless: true });
  }
  if (!contextSingleton) {
    contextSingleton = await browserSingleton.newContext();
  }

  // Re-apply cookies if they were updated in the dashboard since the last
  // time we loaded them (cheap check, avoids stale sessions after the user
  // pastes fresh cookies without restarting the server).
  const settings = db.get('settings').value();
  if (settings.cookiesUpdatedAt && settings.cookiesUpdatedAt > cookiesAppliedAt) {
    await applyCookies(contextSingleton);
    cookiesAppliedAt = settings.cookiesUpdatedAt;
  } else if (cookiesAppliedAt === 0) {
    await applyCookies(contextSingleton);
    cookiesAppliedAt = Date.now();
  }

  return contextSingleton;
}

async function processOne(emp) {
  const context = await getContext();
  const page = await context.newPage();
  try {
    await login(page);
    const { subjectVal } = await createTicket(page, emp);
    const emailSent = await sendResolutionEmail(page);
    if (emailSent) {
      await closeTicket(page, subjectVal);
    }
    log('success', `Finished processing ${emp.EmployeeName}`);
    return { ok: true };
  } catch (err) {
    log('error', `Failed processing ${emp.EmployeeName}: ${err.message}`, { stack: err.stack });
    return { ok: false, error: err.message };
  } finally {
    await page.close().catch(() => {});
  }
}

module.exports = { processOne, getContext, USER_DATA_DIR, TICKET_CREATE_URL, LOGIN_URL };