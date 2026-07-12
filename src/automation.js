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

// Scripted username/password login, used only when cookies are absent or
// stale. Selectors are configurable via env vars since they depend on the
// site's real login form markup.
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
  // getContext), so if we're here they were either absent or stale. Try a
  // scripted username/password login as a fallback.
  if (await passwordLogin(page)) {
    log('success', 'Logged in via username/password.');
    return true;
  }

  log('error', 'Not logged in — no valid cookies and username/password login failed or was not configured.');
  throw new Error(
    'Not logged in. Open the dashboard → "Login Settings", export fresh session cookies from your own ' +
    'browser (DevTools → Application → Cookies → export as JSON, e.g. via the "Cookie-Editor" extension) ' +
    'and paste them into "Session Cookies", or set Username/Password if the site supports plain login.'
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