const Datastore = require('@seald-io/nedb');
const path = require('path');

const dbDir = path.join(__dirname, 'data');

const students   = new Datastore({ filename: path.join(dbDir, 'students.db'),   autoload: true });
const sessions   = new Datastore({ filename: path.join(dbDir, 'sessions.db'),   autoload: true });
const attendance = new Datastore({ filename: path.join(dbDir, 'attendance.db'), autoload: true });

// Ensure unique indexes
students.ensureIndex({ fieldName: 'roll_no', unique: true });
attendance.ensureIndex({ fieldName: 'session_student', unique: true }); // composite key stored as string

// ── Helpers ────────────────────────────────────────────────────────────────

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function nowStr() {
  return new Date().toISOString();
}

// Promisify NeDB callbacks
function pFind(db, query, sort) {
  return new Promise((res, rej) => {
    let cursor = db.find(query);
    if (sort) cursor = cursor.sort(sort);
    cursor.exec((err, docs) => err ? rej(err) : res(docs));
  });
}
function pFindOne(db, query) {
  return new Promise((res, rej) => db.findOne(query, (err, doc) => err ? rej(err) : res(doc)));
}
function pInsert(db, doc) {
  return new Promise((res, rej) => db.insert(doc, (err, newDoc) => err ? rej(err) : res(newDoc)));
}
function pUpdate(db, query, update, options = {}) {
  return new Promise((res, rej) => db.update(query, update, options, (err, n) => err ? rej(err) : res(n)));
}
function pRemove(db, query, options = {}) {
  return new Promise((res, rej) => db.remove(query, options, (err, n) => err ? rej(err) : res(n)));
}
function pCount(db, query) {
  return new Promise((res, rej) => db.count(query, (err, n) => err ? rej(err) : res(n)));
}

// ── Students ───────────────────────────────────────────────────────────────

async function getAllStudents() {
  return pFind(students, {}, { class_name: 1, roll_no: 1 });
}
async function getStudentById(id) {
  return pFindOne(students, { _id: id });
}
async function createStudent({ name, roll_no, class_name, descriptor, photo }) {
  return pInsert(students, { name, roll_no, class_name, descriptor, photo: photo || null, created_at: nowStr() });
}
async function removeStudent(id) {
  return pRemove(students, { _id: id });
}
async function getClasses() {
  const docs = await pFind(students, {});
  return [...new Set(docs.map(d => d.class_name))].sort();
}

// ── Sessions ───────────────────────────────────────────────────────────────

async function getAllSessions() {
  const docs = await pFind(sessions, {}, { started_at: -1 });
  const result = [];
  for (const s of docs.slice(0, 50)) {
    const count = await pCount(attendance, { session_id: s._id });
    result.push({ ...s, present_count: count });
  }
  return result;
}
async function getSessionById(id) {
  return pFindOne(sessions, { _id: id });
}
async function createSession({ name, class_name }) {
  return pInsert(sessions, { name, class_name, date: todayStr(), started_at: nowStr(), status: 'active' });
}
async function finishSession(id) {
  return pUpdate(sessions, { _id: id }, { $set: { status: 'ended', ended_at: nowStr() } });
}

// ── Attendance ─────────────────────────────────────────────────────────────

async function markAttendance({ session_id, student_id, confidence }) {
  const key = `${session_id}__${student_id}`;
  const existing = await pFindOne(attendance, { session_student: key });
  if (existing) return { duplicate: true };
  const doc = await pInsert(attendance, { session_id, student_id, confidence, session_student: key, timestamp: nowStr() });
  return { duplicate: false, doc };
}

async function getAttendanceBySession(session_id) {
  const rows = await pFind(attendance, { session_id }, { timestamp: 1 });
  // Enrich with student data
  const enriched = [];
  for (const row of rows) {
    const student = await getStudentById(row.student_id);
    if (student) enriched.push({ ...row, name: student.name, roll_no: student.roll_no, class_name: student.class_name });
  }
  return enriched;
}

async function getReport({ session_id, class_name, date }) {
  // Get sessions matching filters
  const sessionQuery = {};
  if (session_id) sessionQuery._id = session_id;
  if (class_name) sessionQuery.class_name = class_name;
  if (date) sessionQuery.date = date;

  const matchedSessions = await pFind(sessions, sessionQuery, { started_at: -1 });
  const allStudents = await getAllStudents();

  const result = [];
  for (const ses of matchedSessions) {
    const classStudents = allStudents.filter(s => s.class_name === ses.class_name);
    for (const student of classStudents) {
      const att = await pFindOne(attendance, { session_id: ses._id, student_id: student._id });
      result.push({
        session_id: ses._id,
        session_name: ses.name,
        class_name: ses.class_name,
        date: ses.date,
        started_at: ses.started_at,
        ended_at: ses.ended_at || null,
        status: ses.status,
        student_id: student._id,
        student_name: student.name,
        roll_no: student.roll_no,
        status_flag: att ? 'present' : 'absent',
        marked_at: att ? att.timestamp : null,
        confidence: att ? att.confidence : null,
      });
    }
  }
  return result;
}

async function getTodayStats() {
  const today = todayStr();
  const [total_students, todays_sessions, active_sessions] = await Promise.all([
    pCount(students, {}),
    pCount(sessions, { date: today }),
    pCount(sessions, { status: 'active' }),
  ]);
  const todaySessionDocs = await pFind(sessions, { date: today });
  const sessionIds = todaySessionDocs.map(s => s._id);
  const attRows = await pFind(attendance, { session_id: { $in: sessionIds } });
  const uniquePresent = new Set(attRows.map(r => r.student_id)).size;
  return { total_students, todays_sessions, active_sessions, todays_present: uniquePresent };
}

async function getRecentActivity() {
  const rows = await pFind(attendance, {}, { timestamp: -1 });
  const limited = rows.slice(0, 10);
  const enriched = [];
  for (const row of limited) {
    const student = await getStudentById(row.student_id);
    const session = await getSessionById(row.session_id);
    if (student && session) {
      enriched.push({ ...row, name: student.name, roll_no: student.roll_no, session_name: session.name });
    }
  }
  return enriched;
}

module.exports = {
  getAllStudents, getStudentById, createStudent, removeStudent, getClasses,
  getAllSessions, getSessionById, createSession, finishSession,
  markAttendance, getAttendanceBySession, getReport,
  getTodayStats, getRecentActivity,
};
