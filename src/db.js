const low = require('lowdb');
const path = require('path');
const fs = require('fs');

let createClient = null;
try {
  ({ createClient } = require('@supabase/supabase-js'));
  // supabase-js v2's realtime client unconditionally checks for a native
  // WebSocket global at construction time (Node 22+ has one built in). The
  // Playwright base Docker image we deploy on ships Node 20, which doesn't,
  // so createClient() throws immediately even though we only ever use REST
  // calls (select/upsert) and never touch realtime. Polyfilling with `ws`
  // satisfies that check without changing any actual behavior we rely on.
  if (typeof globalThis.WebSocket === 'undefined') {
    globalThis.WebSocket = require('ws');
  }
} catch (err) {
  createClient = null; // package not installed — fine, falls back to local file
}

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || '';
const SUPABASE_TABLE = process.env.SUPABASE_TABLE || 'app_state';
const usingSupabase = !!(SUPABASE_URL && SUPABASE_KEY && createClient);

const DEFAULTS = {
  queue: [],          // pending employees to process (drains as it runs)
  savedClients: [],   // persistent manually-added client list, reused every day
  logs: [],           // execution log entries
  settings: {
    running: false,
    gapMinutes: parseInt(process.env.DEFAULT_GAP_MINUTES || '5', 10),
    nextRunAt: 0,
    cookiesJson: process.env.EAZY_COOKIES_JSON || '',
    cookiesUpdatedAt: process.env.EAZY_COOKIES_JSON ? Date.now() : 0,
    username: process.env.EAZY_USERNAME || '',
    password: process.env.EAZY_PASSWORD || '',
    // Daily auto-start: every day at this local time, the savedClients list
    // is copied into the queue and the run starts automatically.
    autoStart: {
      enabled: true,
      hour: 10,     // 24h, local to timezoneOffsetMinutes below
      minute: 0,
      daysOfWeek: [1, 2, 3, 4, 5, 6] // 0=Sun...6=Sat; default Monday-Saturday, Sunday off
    },
    timezoneOffsetMinutes: 330, // IST (UTC+5:30) — change if deploying for another timezone
    lastAutoRunDate: '',        // 'YYYY-MM-DD' (in the above timezone) of the last auto-start, prevents re-triggering same day
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
};

// Fills in any keys missing from a stored blob (e.g. after a code update
// that added new settings) without discarding what was actually saved.
function mergeWithDefaults(stored) {
  const merged = { ...DEFAULTS, ...stored };
  merged.settings = { ...DEFAULTS.settings, ...(stored.settings || {}) };
  merged.settings.subjectMapping = { ...DEFAULTS.settings.subjectMapping, ...((stored.settings && stored.settings.subjectMapping) || {}) };
  merged.settings.autoStart = { ...DEFAULTS.settings.autoStart, ...((stored.settings && stored.settings.autoStart) || {}) };
  merged.queue = stored.queue || [];
  merged.savedClients = stored.savedClients || [];
  merged.logs = stored.logs || [];
  return merged;
}

let db;
let ready; // resolves once the initial data (from Supabase, if configured) has loaded

if (usingSupabase) {
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  const ROW_ID = 1;

  // Writes are debounced: the worker loop and ticket steps call db.write()
  // frequently, and we don't want to hit Supabase on every single one.
  let saveTimer = null;
  function schedulePersist(data) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      try {
        const { error } = await supabase
          .from(SUPABASE_TABLE)
          .upsert({ id: ROW_ID, data, updated_at: new Date().toISOString() });
        if (error) console.error('[Supabase] persist failed:', error.message);
      } catch (err) {
        console.error('[Supabase] persist failed:', err.message);
      }
    }, 400);
  }

  // Custom lowdb adapter: read() is synchronous (required so `low(adapter)`
  // returns the db instance immediately, not a Promise, keeping every other
  // file's `db.get(...).value()` chain-style calls unchanged). The real
  // Supabase fetch happens once, asynchronously, right below via `ready`,
  // and hydrates the in-memory store via db.setState(...).
  class SupabaseAdapter {
    constructor(defaultValue) { this.defaultValue = defaultValue; }
    read() { return this.defaultValue; }
    write(data) { schedulePersist(data); }
  }

  db = low(new SupabaseAdapter(DEFAULTS));
  db.defaults(DEFAULTS).write();

  ready = (async () => {
    const timeoutMs = 10000;
    const timeout = new Promise((resolve) =>
      setTimeout(() => resolve({ timedOut: true }), timeoutMs)
    );
    try {
      const result = await Promise.race([
        supabase.from(SUPABASE_TABLE).select('data').eq('id', ROW_ID).maybeSingle(),
        timeout
      ]);

      if (result.timedOut) {
        console.error(
          `[Supabase] Initial load did not respond within ${timeoutMs / 1000}s — starting with ` +
          'in-memory defaults for now. Data already saved in Supabase is safe; this boot just could not ' +
          'fetch it in time. Restart the service once connectivity is confirmed.'
        );
        return;
      }

      const { data, error } = result;
      if (error) throw error;

      if (data && data.data) {
        db.setState(mergeWithDefaults(data.data)).write();
        console.log('[Supabase] Loaded existing app state — saved clients, queue, settings and cookies restored.');
      } else {
        db.write(); // no row yet — create one with defaults
        console.log('[Supabase] No existing row found — created one with defaults.');
      }
    } catch (err) {
      console.error(
        '[Supabase] Failed to load initial state — continuing with in-memory defaults ' +
        'for this run (nothing will be lost that was already saved; this just means this ' +
        'particular boot could not reach Supabase). Error:', err.message
      );
    }
  })();
} else {
  // Fallback for local development or if Supabase env vars aren't set:
  // same as before, a local JSON file. NOTE: on Render this only survives
  // redeploys if a persistent Disk is correctly attached at DATA_DIR — set
  // SUPABASE_URL / SUPABASE_SERVICE_KEY to avoid depending on that.
  const FileSync = require('lowdb/adapters/FileSync');
  const DATA_DIR = process.env.DATA_DIR || './data';
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const adapter = new FileSync(path.join(DATA_DIR, 'db.json'));
  db = low(adapter);
  db.defaults(DEFAULTS).write();
  ready = Promise.resolve();
  console.warn(
    '[DB] SUPABASE_URL / SUPABASE_SERVICE_KEY not set — using local file storage. ' +
    'This will NOT reliably survive a Render redeploy unless a persistent Disk is attached. ' +
    'Set the Supabase env vars to fix this permanently.'
  );
}

function log(level, message, meta = {}) {
  const entry = {
    id: Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    ts: new Date().toISOString(),
    level, // info | success | error | warn
    message,
    meta
  };
  db.get('logs').push(entry).write();
  // keep only the last 2000 log entries so storage doesn't grow unbounded
  const all = db.get('logs').value();
  if (all.length > 2000) {
    db.set('logs', all.slice(all.length - 2000)).write();
  }
  console.log(`[${entry.ts}] [${level.toUpperCase()}] ${message}`);
  return entry;
}

module.exports = { db, log, ready, usingSupabase };