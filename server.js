require('dotenv').config();
const express = require('express');
const multer = require('multer');
const xlsx = require('xlsx');
const path = require('path');
const { db, log, ready, usingSupabase } = require('./src/db');
const { startWorkerLoop } = require('./src/worker');
const { v4: uuidv4 } = require('uuid');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const PASSWORD = process.env.DASHBOARD_PASSWORD || 'change-me';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ---- very simple shared-password auth for all /api routes ---- */
app.use('/api', (req, res, next) => {
  const provided = req.headers['x-dashboard-password'] || req.query.password;
  if (provided !== PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

/* ---- health check (no auth, useful for Render) ---- */
app.get('/healthz', (req, res) => res.send('ok'));

/* ---- saved clients (persistent list, reused every day at auto-start time) ---- */
app.get('/api/clients', (req, res) => {
  res.json({ clients: db.get('savedClients').value() });
});

app.post('/api/clients', (req, res) => {
  const { EmployeeName, Company, Phone, Email, Subject } = req.body || {};
  if (!EmployeeName || !String(EmployeeName).trim()) {
    return res.status(400).json({ error: 'EmployeeName is required.' });
  }
  const client = {
    id: uuidv4(),
    EmployeeName: String(EmployeeName).trim(),
    Company: Company || '',
    Phone: Phone || '',
    Email: Email || '',
    Subject: Subject || 'Test'
  };
  db.get('savedClients').push(client).write();
  log('info', `Added saved client "${client.EmployeeName}" to the daily list.`);
  res.json({ ok: true, client });
});

app.put('/api/clients/:id', (req, res) => {
  const { id } = req.params;
  const existing = db.get('savedClients').find({ id }).value();
  if (!existing) return res.status(404).json({ error: 'Client not found.' });

  const { EmployeeName, Company, Phone, Email, Subject } = req.body || {};
  if (EmployeeName !== undefined && !String(EmployeeName).trim()) {
    return res.status(400).json({ error: 'EmployeeName cannot be empty.' });
  }
  db.get('savedClients').find({ id }).assign({
    ...(EmployeeName !== undefined && { EmployeeName: String(EmployeeName).trim() }),
    ...(Company !== undefined && { Company }),
    ...(Phone !== undefined && { Phone }),
    ...(Email !== undefined && { Email }),
    ...(Subject !== undefined && { Subject })
  }).write();
  log('info', `Updated saved client "${existing.EmployeeName}".`);
  res.json({ ok: true });
});

app.delete('/api/clients/:id', (req, res) => {
  const { id } = req.params;
  const existing = db.get('savedClients').find({ id }).value();
  if (!existing) return res.status(404).json({ error: 'Client not found.' });
  db.get('savedClients').remove({ id }).write();
  log('info', `Removed saved client "${existing.EmployeeName}" from the daily list.`);
  res.json({ ok: true });
});

// Manually copy the saved client list into the queue and start immediately
// (useful for testing the daily list without waiting for the 10am trigger).
app.post('/api/clients/run-now', (req, res) => {
  const clients = db.get('savedClients').value();
  if (!clients.length) return res.status(400).json({ error: 'Saved client list is empty.' });
  db.set('queue', JSON.parse(JSON.stringify(clients))).write();
  db.set('settings.running', true).write();
  db.set('settings.nextRunAt', 0).write();
  log('info', `Manually started a run with ${clients.length} saved client(s).`);
  res.json({ ok: true, count: clients.length });
});

/* ---- queue ---- */
app.get('/api/queue', (req, res) => {
  const s = { ...db.get('settings').value() };
  delete s.password;
  delete s.cookiesJson;
  res.json({ queue: db.get('queue').value(), settings: s });
});

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const wb = xlsx.read(req.file.buffer, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = xlsx.utils.sheet_to_json(sheet, { defval: '' });

    const parsed = rows.map((r) => {
      const norm = {};
      Object.keys(r).forEach((k) => (norm[k.trim().toLowerCase().replace(/\s+/g, '')] = r[k]));
      return {
        Company: norm.company || norm.brand || norm.brandname || norm.distributor || '',
        EmployeeName: norm.employeename || '',
        Phone: norm.phone || '',
        Email: norm.email || '',
        Subject: norm.subject || norm.subjecttype || 'Test'
      };
    }).filter((r) => r.EmployeeName);

    db.set('queue', parsed).write();
    log('info', `Uploaded ${parsed.length} rows via ${req.file.originalname}, queue replaced.`);
    res.json({ ok: true, count: parsed.length });
  } catch (err) {
    log('error', `Upload parse failed: ${err.message}`);
    res.status(400).json({ error: 'Could not parse file: ' + err.message });
  }
});

app.post('/api/queue/start', (req, res) => {
  const queue = db.get('queue').value();
  if (!queue.length) return res.status(400).json({ error: 'Queue is empty, upload a file first.' });
  db.set('settings.running', true).write();
  db.set('settings.nextRunAt', 0).write();
  log('info', 'Bulk run started from dashboard.');
  res.json({ ok: true });
});

app.post('/api/queue/stop', (req, res) => {
  db.set('settings.running', false).write();
  log('info', 'Bulk run stopped from dashboard.');
  res.json({ ok: true });
});

app.post('/api/queue/clear', (req, res) => {
  db.set('queue', []).write();
  db.set('settings.running', false).write();
  log('info', 'Queue cleared from dashboard.');
  res.json({ ok: true });
});

/* ---- logs ---- */
app.get('/api/logs', (req, res) => {
  const limit = parseInt(req.query.limit || '200', 10);
  const logs = db.get('logs').value();
  res.json({ logs: logs.slice(-limit).reverse() });
});

app.post('/api/logs/clear', (req, res) => {
  db.set('logs', []).write();
  res.json({ ok: true });
});

/* ---- settings ---- */
app.get('/api/settings', (req, res) => {
  const s = { ...db.get('settings').value() };
  delete s.password; // never send password back
  s.hasPassword = !!db.get('settings.password').value();
  s.hasCookies = !!db.get('settings.cookiesJson').value();
  delete s.cookiesJson;
  s.storageBackend = usingSupabase ? 'supabase' : 'local-file';
  res.json(s);
});

app.post('/api/settings', (req, res) => {
  const { gapMinutes, username, password, cookiesJson, subjectMapping, autoStart, timezoneOffsetMinutes } = req.body;
  if (gapMinutes !== undefined) db.set('settings.gapMinutes', parseInt(gapMinutes, 10) || 5).write();
  if (username !== undefined) db.set('settings.username', username).write();
  if (password) db.set('settings.password', password).write();
  if (cookiesJson !== undefined) {
    db.set('settings.cookiesJson', cookiesJson).write();
    db.set('settings.cookiesUpdatedAt', Date.now()).write();
  }
  if (subjectMapping !== undefined) db.set('settings.subjectMapping', subjectMapping).write();
  if (autoStart !== undefined) {
    const enabled = !!autoStart.enabled;
    const hour = Math.min(23, Math.max(0, parseInt(autoStart.hour, 10) || 0));
    const minute = Math.min(59, Math.max(0, parseInt(autoStart.minute, 10) || 0));
    let daysOfWeek = [1, 2, 3, 4, 5, 6];
    if (Array.isArray(autoStart.daysOfWeek)) {
      const valid = autoStart.daysOfWeek
        .map((d) => parseInt(d, 10))
        .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
      if (valid.length) daysOfWeek = [...new Set(valid)].sort();
    }
    db.set('settings.autoStart', { enabled, hour, minute, daysOfWeek }).write();
  }
  if (timezoneOffsetMinutes !== undefined) {
    db.set('settings.timezoneOffsetMinutes', parseInt(timezoneOffsetMinutes, 10) || 330).write();
  }
  log('info', 'Settings updated from dashboard.');
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
(async () => {
  await ready; // wait for saved data (queue, saved clients, cookies, settings) to load before serving requests
  app.listen(PORT, () => {
    log('info', `Dashboard server listening on port ${PORT}`);
    startWorkerLoop();
  });
})();