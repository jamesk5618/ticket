const { db, log } = require('./db');
const { processOne } = require('./automation');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let ticking = false;

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const settings = db.get('settings').value();
    if (!settings.running) return;

    const queue = db.get('queue').value();
    if (!queue.length) {
      db.set('settings.running', false).write();
      log('info', 'Queue empty — automation stopped.');
      return;
    }

    const now = Date.now();
    if (settings.nextRunAt && now < settings.nextRunAt) return; // still waiting out the gap

    const emp = queue[0];
    db.get('queue').shift().write();
    log('info', `Starting ticket for ${emp.EmployeeName}`, { remaining: queue.length - 1 });

    const result = await processOne(emp);

    const gapMs = (db.get('settings.gapMinutes').value() || 5) * 60 * 1000;
    db.set('settings.nextRunAt', Date.now() + gapMs).write();

    if (!result.ok) {
      log('error', `Ticket for ${emp.EmployeeName} failed and was skipped.`);
    }
  } catch (err) {
    log('error', `Worker tick error: ${err.message}`);
  } finally {
    ticking = false;
  }
}

function startWorkerLoop() {
  setInterval(tick, 5000);
  log('info', 'Worker loop started (checking queue every 5s).');
}

module.exports = { startWorkerLoop };
