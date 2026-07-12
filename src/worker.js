const { db, log } = require('./db');
const { processOne } = require('./automation');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let ticking = false;

// Returns { dateStr: 'YYYY-MM-DD', hour, minute } for "now" shifted into the
// configured timezone (default IST, UTC+5:30), without pulling in a date
// library — good enough since we only need date/hour/minute granularity.
function localNow(offsetMinutes) {
  const shifted = new Date(Date.now() + offsetMinutes * 60000);
  const dateStr = shifted.toISOString().slice(0, 10); // YYYY-MM-DD (of the shifted instant, read as UTC fields)
  return { dateStr, hour: shifted.getUTCHours(), minute: shifted.getUTCMinutes() };
}

// If it's on/after the configured auto-start time and we haven't already
// auto-started today, copy the saved client list into the queue and kick
// off a run. Runs once per day; does nothing if already running, already
// triggered today, or the saved list is empty.
function checkAutoStart() {
  const settings = db.get('settings').value();
  const auto = settings.autoStart || {};
  if (!auto.enabled) return;

  const { dateStr, hour, minute } = localNow(settings.timezoneOffsetMinutes ?? 330);
  const afterStartTime = hour > auto.hour || (hour === auto.hour && minute >= auto.minute);
  if (!afterStartTime) return;
  if (settings.lastAutoRunDate === dateStr) return; // already ran today
  if (settings.running) return; // a run (manual or auto) is already in progress

  const savedClients = db.get('savedClients').value();
  if (!savedClients.length) {
    // Still mark today as "handled" so we don't spam-check every 5s all day
    // once past the start time with an empty list — but log it once.
    if (settings.lastAutoRunDate !== dateStr + ':empty') {
      log('warn', 'Daily auto-start time reached, but the saved client list is empty — nothing to run.');
      db.set('settings.lastAutoRunDate', dateStr + ':empty').write();
    }
    return;
  }

  db.set('queue', JSON.parse(JSON.stringify(savedClients))).write();
  db.set('settings.running', true).write();
  db.set('settings.nextRunAt', 0).write();
  db.set('settings.lastAutoRunDate', dateStr).write();
  log('success', `Daily auto-start: loaded ${savedClients.length} saved client(s) into the queue and started the run.`);
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    checkAutoStart();

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