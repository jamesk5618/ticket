const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || './data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const adapter = new FileSync(path.join(DATA_DIR, 'db.json'));
const db = low(adapter);

db.defaults({
  queue: [],          // pending employees to process
  logs: [],           // execution log entries
  settings: {
    running: false,
    gapMinutes: parseInt(process.env.DEFAULT_GAP_MINUTES || '5', 10),
    nextRunAt: 0,
    cookiesJson: process.env.EAZY_COOKIES_JSON || '',
    cookiesUpdatedAt: process.env.EAZY_COOKIES_JSON ? Date.now() : 0,
    username: process.env.EAZY_USERNAME || '',
    password: process.env.EAZY_PASSWORD || '',
    subjectMapping: {
      'Login Issue': { category: 'Login Issue', rca: 'Restart App' },
      'Distributor Mapping Issue': { category: 'Route Management Issue', rca: 'Ask Mis Admin' },
      'Test': { category: 'Login Issue', rca: 'Restart App' },
      'Reset Device Issue': { category: 'Reset Device', rca: 'Reset Device In Portal' },
      'Knowledge Gap Issue': { category: 'Application Knowledge Gap', rca: 'Traning Provided' },
      'Logout Issue': { category: 'Logout Issues', rca: 'Not Able To Login Twice In A Same Day' },
      'Live Location Tracking Issue': { category: 'Live Location Tracking', rca: 'Restart And Sync' },
      'Invalid City': { category: 'Data Issue', rca: 'Sync Is Not Happend' }
    }
  }
}).write();

function log(level, message, meta = {}) {
  const entry = {
    id: Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    ts: new Date().toISOString(),
    level, // info | success | error | warn
    message,
    meta
  };
  db.get('logs').push(entry).write();
  // keep only the last 2000 log entries so the file doesn't grow unbounded
  const all = db.get('logs').value();
  if (all.length > 2000) {
    db.set('logs', all.slice(all.length - 2000)).write();
  }
  console.log(`[${entry.ts}] [${level.toUpperCase()}] ${message}`);
  return entry;
}

module.exports = { db, log };
