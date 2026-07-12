let PASSWORD = localStorage.getItem('dash_pw') || '';

async function api(path, opts = {}) {
  const isFormData = opts.body instanceof FormData;
  opts.headers = Object.assign({}, opts.headers, {
    'x-dashboard-password': PASSWORD
  });
  // For FormData uploads, don't set Content-Type at all — the browser needs
  // to set it itself (multipart/form-data; boundary=...). Setting it to
  // undefined still leaves the key present and fetch stringifies it to the
  // literal "undefined", which breaks multer's multipart parsing server-side.
  if (!isFormData) {
    opts.headers['Content-Type'] = 'application/json';
  }
  const res = await fetch('/api' + path, opts);
  if (res.status === 401) throw new Error('unauthorized');
  return res.json();
}

async function tryLogin() {
  PASSWORD = document.getElementById('pwInput').value;
  try {
    await api('/settings');
    localStorage.setItem('dash_pw', PASSWORD);
    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    boot();
  } catch (e) {
    document.getElementById('pwError').innerText = 'Incorrect password.';
  }
}

document.getElementById('pwBtn').onclick = tryLogin;
document.getElementById('pwInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') tryLogin(); });

function boot() {
  refreshQueue();
  refreshLogs();
  refreshSettings();
  refreshClients();
  setInterval(() => { if (document.getElementById('autoRefresh').checked) { refreshQueue(); refreshLogs(); } }, 5000);
}

// Auto-login if password already stored
if (PASSWORD) tryLogin();

/* ---------- Queue ---------- */

document.getElementById('fileInput').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append('file', file);
  const result = await api('/upload', { method: 'POST', body: fd });
  document.getElementById('uploadResult').innerText = result.ok
    ? `✅ Loaded ${result.count} employees into the queue.`
    : `❌ ${result.error}`;
  refreshQueue();
};

document.getElementById('startBtn').onclick = async () => {
  const r = await api('/queue/start', { method: 'POST' });
  if (r.error) alert(r.error);
  refreshQueue();
};
document.getElementById('stopBtn').onclick = async () => { await api('/queue/stop', { method: 'POST' }); refreshQueue(); };
document.getElementById('clearBtn').onclick = async () => {
  if (!confirm('Clear the entire queue?')) return;
  await api('/queue/clear', { method: 'POST' });
  refreshQueue();
};
document.getElementById('saveGapBtn').onclick = async () => {
  await api('/settings', { method: 'POST', body: JSON.stringify({ gapMinutes: document.getElementById('gapMinutes').value }) });
  refreshQueue();
};

async function refreshQueue() {
  const { queue, settings } = await api('/queue');
  document.getElementById('queueCount').innerText = queue.length;
  document.getElementById('gapMinutes').value = settings.gapMinutes;

  const badge = document.getElementById('statusBadge');
  badge.innerText = settings.running ? 'RUNNING' : 'STOPPED';
  badge.className = 'badge ' + (settings.running ? 'running' : 'stopped');

  document.getElementById('nextRun').innerText = settings.nextRunAt && settings.nextRunAt > Date.now()
    ? new Date(settings.nextRunAt).toLocaleTimeString()
    : 'now / n-a';

  const rows = queue.slice(0, 25).map((e, i) => `
    <tr><td>${i + 1}</td><td>${escapeHtml(e.EmployeeName)}</td><td>${escapeHtml(e.Company)}</td>
    <td>${escapeHtml(e.Phone)}</td><td>${escapeHtml(e.Email)}</td><td>${escapeHtml(e.Subject)}</td></tr>`).join('');

  document.getElementById('queueTableWrap').innerHTML = queue.length ? `
    <table><thead><tr><th>#</th><th>Name</th><th>Company</th><th>Phone</th><th>Email</th><th>Subject</th></tr></thead>
    <tbody>${rows}</tbody></table>
    ${queue.length > 25 ? `<p class="muted">…and ${queue.length - 25} more</p>` : ''}
  ` : '<p class="muted">Queue is empty.</p>';
}

/* ---------- Logs ---------- */

document.getElementById('refreshLogsBtn').onclick = refreshLogs;
document.getElementById('clearLogsBtn').onclick = async () => { await api('/logs/clear', { method: 'POST' }); refreshLogs(); };

async function refreshLogs() {
  const { logs } = await api('/logs?limit=300');
  document.getElementById('logsWrap').innerHTML = logs.map((l) =>
    `<div class="log-line"><span class="log-${l.level}">[${new Date(l.ts).toLocaleTimeString()}] [${l.level.toUpperCase()}]</span> ${escapeHtml(l.message)}</div>`
  ).join('') || '<p class="muted">No logs yet.</p>';
}

/* ---------- Settings ---------- */

async function refreshSettings() {
  const s = await api('/settings');
  document.getElementById('username').value = s.username || '';
  document.getElementById('authStatus').innerText =
    `Password set: ${s.hasPassword ? 'yes' : 'no'} | Cookies set: ${s.hasCookies ? 'yes' : 'no'}`;

  const auto = s.autoStart || { enabled: true, hour: 10, minute: 0 };
  document.getElementById('autoHour').value = auto.hour;
  document.getElementById('autoMinute').value = auto.minute;
  document.getElementById('autoEnabled').checked = !!auto.enabled;
  document.getElementById('autoStartStatus').innerText = s.lastAutoRunDate
    ? `Last auto-run: ${s.lastAutoRunDate}`
    : 'Not run yet today.';

  const subjectSelect = document.getElementById('cSubject');
  const subjects = Object.keys(s.subjectMapping || {});
  subjectSelect.innerHTML = subjects.map((sub) => `<option value="${escapeHtml(sub)}">${escapeHtml(sub)}</option>`).join('');

  const storageBadge = document.getElementById('storageBadge');
  storageBadge.innerText = s.storageBackend === 'supabase'
    ? '💾 Storage: Supabase (survives redeploys)'
    : '⚠️ Storage: local file (may reset on redeploy — set SUPABASE_URL/SUPABASE_SERVICE_KEY)';
}

document.getElementById('saveAutoStartBtn').onclick = async () => {
  await api('/settings', {
    method: 'POST',
    body: JSON.stringify({
      autoStart: {
        enabled: document.getElementById('autoEnabled').checked,
        hour: document.getElementById('autoHour').value,
        minute: document.getElementById('autoMinute').value
      }
    })
  });
  refreshSettings();
};

/* ---------- Saved Clients (daily list) ---------- */

document.getElementById('addClientBtn').onclick = async () => {
  const EmployeeName = document.getElementById('cName').value.trim();
  if (!EmployeeName) { alert('Employee Name is required.'); return; }
  const body = {
    EmployeeName,
    Company: document.getElementById('cCompany').value.trim(),
    Phone: document.getElementById('cPhone').value.trim(),
    Email: document.getElementById('cEmail').value.trim(),
    Subject: document.getElementById('cSubject').value
  };
  const r = await api('/clients', { method: 'POST', body: JSON.stringify(body) });
  if (r.error) { alert(r.error); return; }
  ['cName', 'cCompany', 'cPhone', 'cEmail'].forEach((id) => (document.getElementById(id).value = ''));
  refreshClients();
};

document.getElementById('runNowBtn').onclick = async () => {
  const r = await api('/clients/run-now', { method: 'POST' });
  if (r.error) { alert(r.error); return; }
  refreshQueue();
};

async function deleteClient(id) {
  if (!confirm('Remove this client from the daily list?')) return;
  await api('/clients/' + id, { method: 'DELETE' });
  refreshClients();
}
window.deleteClient = deleteClient;

async function refreshClients() {
  const { clients } = await api('/clients');
  const rows = clients.map((c) => `
    <tr>
      <td>${escapeHtml(c.EmployeeName)}</td>
      <td>${escapeHtml(c.Company)}</td>
      <td>${escapeHtml(c.Phone)}</td>
      <td>${escapeHtml(c.Email)}</td>
      <td>${escapeHtml(c.Subject)}</td>
      <td><button class="red" onclick="deleteClient('${c.id}')">Remove</button></td>
    </tr>`).join('');

  document.getElementById('clientsTableWrap').innerHTML = clients.length ? `
    <table><thead><tr><th>Name</th><th>Company</th><th>Phone</th><th>Email</th><th>Subject</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table>
    <p class="muted">${clients.length} saved client(s) — this whole list reloads into the queue every day at the auto-start time.</p>
  ` : '<p class="muted">No saved clients yet. Add some above.</p>';
}

document.getElementById('saveAuthBtn').onclick = async () => {
  const body = {
    username: document.getElementById('username').value,
    cookiesJson: document.getElementById('cookiesJson').value
  };
  const pw = document.getElementById('password').value;
  if (pw) body.password = pw;
  await api('/settings', { method: 'POST', body: JSON.stringify(body) });
  document.getElementById('password').value = '';
  refreshSettings();
};

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}