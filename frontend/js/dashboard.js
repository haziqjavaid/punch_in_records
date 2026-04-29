const API = 'http://localhost:3000/api';

function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast-item ${type}`;
  el.textContent = msg;
  document.getElementById('toast').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function timeAgo(isoStr) {
  const diff = Date.now() - new Date(isoStr).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function getInitials(name) {
  return name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
}

async function loadStats() {
  try {
    const res = await fetch(`${API}/stats`);
    const { stats, activity } = await res.json();

    document.getElementById('statStudents').textContent = stats.total_students;
    document.getElementById('statPresent').textContent = stats.todays_present;
    document.getElementById('statSessions').textContent = stats.todays_sessions;
    document.getElementById('statActive').textContent = stats.active_sessions;

    const feed = document.getElementById('activityFeed');
    if (!activity.length) {
      feed.innerHTML = '<div class="empty-state"><p>No activity yet today</p></div>';
    } else {
      feed.innerHTML = activity.map(a => `
        <div class="activity-item">
          <div class="activity-dot"></div>
          <div class="info">
            <span>${a.name} <span style="color:var(--text-muted)">(${a.roll_no})</span></span>
            <small>${a.session_name}</small>
          </div>
          <div class="time">${timeAgo(a.timestamp)}</div>
        </div>`).join('');
    }
  } catch (e) {
    toast('Cannot reach server — is it running?', 'error');
  }
}

async function loadStudents() {
  try {
    const students = await fetch(`${API}/students`).then(r => r.json());
    const list = document.getElementById('studentList');
    if (!students.length) {
      list.innerHTML = '<div class="empty-state"><p>No students registered yet. <a href="register.html" style="color:var(--accent)">Register one →</a></p></div>';
      return;
    }
    list.innerHTML = students.slice(0, 8).map(s => `
      <div class="activity-item">
        <div style="width:32px;height:32px;border-radius:50%;background:linear-gradient(135deg,var(--accent),var(--accent2));display:flex;align-items:center;justify-content:center;font-weight:700;font-size:.75rem;flex-shrink:0;overflow:hidden">
          ${s.photo ? `<img src="${s.photo}" style="width:100%;height:100%;object-fit:cover">` : getInitials(s.name)}
        </div>
        <div class="info">
          <span>${s.name}</span>
          <small>${s.roll_no} · ${s.class_name}</small>
        </div>
      </div>`).join('') + (students.length > 8 ? `<div style="text-align:center;padding:.75rem;font-size:.8rem;color:var(--text-muted)">+${students.length - 8} more · <a href="register.html" style="color:var(--accent)">View all</a></div>` : '');
  } catch (e) {
    console.error(e);
  }
}

loadStats();
loadStudents();
setInterval(loadStats, 15000);
