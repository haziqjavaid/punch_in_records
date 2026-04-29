const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// ── Stats ─────────────────────────────────────────────────────────────────────
app.get('/api/stats', async (req, res) => {
  try {
    const [stats, activity] = await Promise.all([db.getTodayStats(), db.getRecentActivity()]);
    res.json({ stats, activity });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Students ──────────────────────────────────────────────────────────────────
app.get('/api/students', async (req, res) => {
  try {
    const students = await db.getAllStudents();
    // NeDB stores _id; remap for consistency
    res.json(students.map(s => ({ ...s, id: s._id })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/students/:id', async (req, res) => {
  try {
    const s = await db.getStudentById(req.params.id);
    if (!s) return res.status(404).json({ error: 'Student not found' });
    res.json({ ...s, id: s._id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/students', async (req, res) => {
  try {
    const { name, roll_no, class_name, descriptor, photo } = req.body;
    if (!name || !roll_no || !class_name || !descriptor)
      return res.status(400).json({ error: 'name, roll_no, class_name, descriptor are required' });

    const doc = await db.createStudent({ name: name.trim(), roll_no: roll_no.trim(), class_name: class_name.trim(), descriptor, photo });
    res.status(201).json({ id: doc._id, message: 'Student registered successfully' });
  } catch (e) {
    if (e.message && e.message.includes('unique')) return res.status(409).json({ error: 'Roll number already exists' });
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/students/:id', async (req, res) => {
  try {
    await db.removeStudent(req.params.id);
    res.json({ message: 'Student deleted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/classes', async (req, res) => {
  try { res.json(await db.getClasses()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Sessions ──────────────────────────────────────────────────────────────────
app.get('/api/sessions', async (req, res) => {
  try {
    const sessions = await db.getAllSessions();
    res.json(sessions.map(s => ({ ...s, id: s._id })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sessions', async (req, res) => {
  try {
    const { name, class_name } = req.body;
    if (!name || !class_name) return res.status(400).json({ error: 'name and class_name are required' });
    const doc = await db.createSession({ name: name.trim(), class_name: class_name.trim() });
    res.status(201).json({ id: doc._id, message: 'Session started' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/sessions/:id/end', async (req, res) => {
  try {
    await db.finishSession(req.params.id);
    res.json({ message: 'Session ended' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Attendance ────────────────────────────────────────────────────────────────
app.get('/api/attendance/:sessionId', async (req, res) => {
  try { res.json(await db.getAttendanceBySession(req.params.sessionId)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/attendance', async (req, res) => {
  try {
    const { session_id, student_id, confidence } = req.body;
    if (!session_id || !student_id || confidence === undefined)
      return res.status(400).json({ error: 'session_id, student_id, confidence are required' });
    const result = await db.markAttendance({ session_id, student_id, confidence });
    if (result.duplicate) return res.json({ message: 'Already marked', duplicate: true });
    res.status(201).json({ id: result.doc._id, message: 'Attendance marked' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Reports ───────────────────────────────────────────────────────────────────
app.get('/api/reports', async (req, res) => {
  try {
    const { session_id, class_name, date } = req.query;
    res.json(await db.getReport({ session_id: session_id || null, class_name: class_name || null, date: date || null }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SPA fallback ──────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🎓 Face Attendance System running at http://localhost:${PORT}`);
  console.log(`   Dashboard    → http://localhost:${PORT}/`);
  console.log(`   Register     → http://localhost:${PORT}/register.html`);
  console.log(`   Live Session → http://localhost:${PORT}/session.html`);
  console.log(`   Reports      → http://localhost:${PORT}/reports.html\n`);
});
