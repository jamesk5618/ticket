// Run this once (and again any time your session expires):
//   npm run login
//
// It opens a real, visible Chrome window using the same persistent profile
// the automation uses. Log in by hand, then come back to this terminal and
// press Enter — the session is already saved to disk at that point (Chrome
// profiles persist automatically), this just gives you a clean way to
// confirm login succeeded before closing the browser.

const { chromium } = require('playwright');
const readline = require('readline');
const { USER_DATA_DIR, LOGIN_URL, TICKET_CREATE_URL } = require('./automation');

function waitForEnter(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, () => { rl.close(); resolve(); }));
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

  console.log('\nA Chrome window has opened. Log in there manually (including any 2FA).');
  await waitForEnter('Once you are logged in, come back here and press Enter to verify... ');

  // Verify by checking for an element that only exists once inside the app.
  const page2 = await context.newPage();
  await page2.goto(TICKET_CREATE_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  const probe = await page2.waitForSelector('#btn_search_contact_id', { timeout: 8000 }).catch(() => null);

  if (probe) {
    console.log('\n✅ Login confirmed — session saved. You can close this Chrome window now and run "npm start".');
  } else {
    console.log('\n⚠️  Could not confirm login (the ticket-create page did not show the expected contact-search icon).');
    console.log('   Double check you are fully logged in, then re-run "npm run login" if needed.');
  }

  await waitForEnter('\nPress Enter to close this browser window... ');
  await context.close();
  process.exit(0);
})();