const API = 'http://localhost:3000/api';
let reportData = [];

function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast-item ${type}`;
  el.textContent = msg;
  document.getElementById('toast').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function fmt(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

async function loadClasses() {
  const classes = await fetch(`${API}/classes`).then(r => r.json()).catch(() => []);
  const sel = document.getElementById('filterClass');
  classes.forEach(c => { const o = document.createElement('option'); o.value = c; o.textContent = c; sel.appendChild(o); });
}

async function loadSessions() {
  const sessions = await fetch(`${API}/sessions`).then(r => r.json()).catch(() => []);
  const sel = document.getElementById('filterSession');
  sessions.forEach(s => { const o = document.createElement('option'); o.value = s.id; o.textContent = `${s.name} (${s.date})`; sel.appendChild(o); });
}

async function loadReport() {
  const date = document.getElementById('filterDate').value || null;
  const className = document.getElementById('filterClass').value || null;
  const sessionId = document.getElementById('filterSession').value || null;

  const params = new URLSearchParams();
  if (date) params.set('date', date);
  if (className) params.set('class_name', className);
  if (sessionId) params.set('session_id', sessionId);

  try {
    reportData = await fetch(`${API}/reports?${params}`).then(r => r.json());
    renderTable(reportData);
  } catch (e) {
    toast('Failed to load report', 'error');
  }
}

function renderTable(data) {
  const body = document.getElementById('reportBody');
  const present = data.filter(r => r.status_flag === 'present').length;
  const total = data.length;
  const absent = total - present;
  const rate = total ? Math.round((present / total) * 100) : 0;

  document.getElementById('rPresent').textContent = present;
  document.getElementById('rAbsent').textContent = absent;
  document.getElementById('rRate').textContent = `${rate}%`;
  document.getElementById('recordCount').textContent = `${total} record${total !== 1 ? 's' : ''}`;

  if (!data.length) {
    body.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--text-muted);padding:2rem">No records found for selected filters</td></tr>';
    return;
  }

  body.innerHTML = data.map(r => `
    <tr>
      <td style="font-weight:600">${r.student_name}</td>
      <td style="color:var(--text-secondary)">${r.roll_no}</td>
      <td>${r.class_name}</td>
      <td style="color:var(--text-secondary);font-size:.8rem">${r.session_name}</td>
      <td style="color:var(--text-secondary)">${r.date}</td>
      <td>${r.status_flag === 'present'
        ? '<span class="badge-present">● Present</span>'
        : '<span class="badge-absent">● Absent</span>'}</td>
      <td style="color:var(--text-secondary);font-size:.82rem">${fmt(r.marked_at)}</td>
      <td style="color:var(--text-muted);font-size:.82rem">${r.confidence ? Math.round(r.confidence * 100) + '%' : '—'}</td>
    </tr>`).join('');
}

function exportCSV() {
  if (!reportData.length) { toast('Nothing to export', 'error'); return; }
  let csv = 'Student,Roll No,Class,Session,Date,Status,Marked At,Confidence\n';
  reportData.forEach(r => {
    csv += `"${r.student_name}","${r.roll_no}","${r.class_name}","${r.session_name}","${r.date}","${r.status_flag}","${r.marked_at || ''}","${r.confidence ? Math.round(r.confidence * 100) + '%' : ''}"\n`;
  });
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `attendance_report_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  toast('CSV exported ✓', 'success');
}

// ── Init ───────────────────────────────────────────────────────────────────
document.getElementById('filterDate').value = new Date().toISOString().slice(0, 10);
Promise.all([loadClasses(), loadSessions()]).then(() => loadReport());
