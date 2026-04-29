const API = 'http://localhost:3000/api';
const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model';

let stream = null;
let modelsLoaded = false;
let currentSession = null;
let labeledDescriptors = [];
let matcher = null;
let attendanceMarked = new Set(); // student IDs marked in this session
let detectionInterval = null;
let frameCount = 0, lastFpsTime = Date.now();

// ── Toast ──────────────────────────────────────────────────────────────────
function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast-item ${type}`;
  el.textContent = msg;
  document.getElementById('toast').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function getInitials(name) {
  return name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
}

// ── Speech Output ──────────────────────────────────────────────────────────
let lastUnauthorizedSpeechTime = 0;
function speak(text) {
  if (!('speechSynthesis' in window)) return;
  // Use a slight timeout to prevent overlapping with rapid triggers
  setTimeout(() => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    window.speechSynthesis.speak(utterance);
  }, 100);
}

// ── Models ─────────────────────────────────────────────────────────────────
async function loadModels() {
  if (modelsLoaded) return;
  toast('Loading face recognition AI…', 'info');
  await Promise.all([
    faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
    faceapi.nets.faceLandmark68TinyNet.loadFromUri(MODEL_URL),
    faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
  ]);
  modelsLoaded = true;
  toast('AI ready ✓', 'success');
}

// ── Load students & build matcher ──────────────────────────────────────────
async function buildMatcher(className) {
  let url = `${API}/students`;
  const students = await fetch(url).then(r => r.json());
  const filtered = className ? students.filter(s => s.class_name === className) : students;
  if (!filtered.length) { toast('No students found for this class', 'error'); return false; }

  labeledDescriptors = filtered.map(s => new faceapi.LabeledFaceDescriptors(
    JSON.stringify({ id: s.id, name: s.name, roll: s.roll_no, photo: s.photo || '' }),
    [new Float32Array(s.descriptor)]
  ));
  matcher = new faceapi.FaceMatcher(labeledDescriptors, parseFloat(document.getElementById('threshold').value));
  return true;
}

// ── Load class list ────────────────────────────────────────────────────────
async function loadClasses() {
  const classes = await fetch(`${API}/classes`).then(r => r.json());
  const sel = document.getElementById('sessionClass');
  classes.forEach(c => { const o = document.createElement('option'); o.value = c; o.textContent = c; sel.appendChild(o); });
}

// ── Start session ──────────────────────────────────────────────────────────
async function startSession() {
  let name = document.getElementById('sessionName').value.trim();
  const className = document.getElementById('sessionClass').value;
  
  if (!className) { 
    toast('Please select a Class / Batch from the dropdown', 'error'); 
    document.getElementById('sessionClass').style.borderColor = 'red';
    return; 
  }
  
  // If user didn't type a name, generate one automatically
  if (!name) { 
    name = `${className} Session`; 
    document.getElementById('sessionName').value = name;
  }

  const btn = document.getElementById('startSessionBtn');
  btn.disabled = true; 
  btn.textContent = '⏳ Loading AI Models (may take a few secs)...';

  try {
    await loadModels();
    
    btn.textContent = '⚙️ Preparing Camera...';
    const ok = await buildMatcher(className);
    if (!ok) { btn.disabled = false; btn.textContent = '▶ Start'; return; }

    btn.textContent = '📡 Creating Session...';
    const res = await fetch(`${API}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, class_name: className }),
    });
    
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Backend failed to start session');
    
    currentSession = { id: data.id, name, class_name: className };
    attendanceMarked.clear();

    // Update UI
    document.getElementById('setupCard').style.display = 'none';
    document.getElementById('sessionBar').style.display = 'flex';
    document.getElementById('sessionBarText').textContent = `Session: ${name} — ${className}`;
    document.getElementById('attendanceSubtitle').textContent = `Class: ${className}`;
    document.getElementById('exportBtn').disabled = false;
    document.getElementById('scanLine').style.display = 'block';
    toast(`Session "${name}" started ✓`, 'success');

    // Start camera AFTER creating session so session is definitely created
    try {
      await startCamera();
    } catch (camErr) {
      alert('Failed to access camera! Please make sure your camera is not being used by another tab (like the Register page).');
      toast('Camera error. Refresh and try again.', 'error');
      console.error(camErr);
    }

  } catch (e) {
    alert('Error starting session: ' + (e.message || 'Unknown error'));
    toast(e.message || 'Failed to start session', 'error');
    console.error(e);
  } finally {
    btn.disabled = false; 
    if (document.getElementById('setupCard').style.display !== 'none') {
      btn.textContent = '▶ Start';
    }
  }
}

// ── Camera ────────────────────────────────────────────────────────────────
async function startCamera() {
  const video = document.getElementById('video');
  const overlay = document.getElementById('overlay');
  stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: 'user' }, audio: false });
  video.srcObject = stream;
  
  await new Promise(res => {
    video.onloadedmetadata = res;
    // Fallback if metadata doesn't fire
    setTimeout(res, 1000);
  });
  
  // Ensure video is playing
  try { await video.play(); } catch(e) { console.log('Video play error:', e); }

  video.style.display = 'block';
  overlay.width = video.videoWidth || 640; 
  overlay.height = video.videoHeight || 480;
  overlay.style.display = 'block';
  document.getElementById('camPlaceholder').style.display = 'none';
  startDetectionLoop(video, overlay);
}

// ── Detection loop ─────────────────────────────────────────────────────────
function startDetectionLoop(video, canvas) {
  const ctx = canvas.getContext('2d');
  const opts = new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.5 });

  async function loop() {
    if (!stream) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const threshold = parseFloat(document.getElementById('threshold').value);
    document.getElementById('thresholdVal').textContent = threshold.toFixed(2);
    if (matcher) matcher = new faceapi.FaceMatcher(labeledDescriptors, threshold);

    const detections = await faceapi.detectAllFaces(video, opts).withFaceLandmarks(true).withFaceDescriptors();

    for (const det of detections) {
      const box = det.detection.box;
      let label = 'Not Registered', color = '#ff4d6d', conf = 0, studentData = null;

      if (matcher) {
        const match = matcher.findBestMatch(det.descriptor);
        if (match.label !== 'unknown') {
          try { studentData = JSON.parse(match.label); } catch {}
          label = studentData ? studentData.name : match.label;
          conf = Math.round((1 - match.distance) * 100);
          color = '#00f5a0';

          // Mark attendance
          if (studentData && !attendanceMarked.has(studentData.id) && currentSession) {
            attendanceMarked.add(studentData.id);
            markAttendance(studentData, conf, studentData.photo);
            speak(`${studentData.name} is authorized`);
          }
        } else {
          // Unauthorized / Unknown face
          if (Date.now() - lastUnauthorizedSpeechTime > 5000) {
            speak("Unauthorized user detected");
            lastUnauthorizedSpeechTime = Date.now();
          }
        }
      }

      // Draw bounding box
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.shadowColor = color; ctx.shadowBlur = 10;
      ctx.strokeRect(box.x, box.y, box.width, box.height);
      ctx.shadowBlur = 0;

      // Label background
      const labelText = label + (conf ? ` ${conf}%` : '');
      ctx.font = 'bold 13px Inter, sans-serif';
      const tw = ctx.measureText(labelText).width;
      ctx.fillStyle = color;
      ctx.fillRect(box.x, box.y - 24, tw + 16, 22);
      ctx.fillStyle = '#000';
      ctx.fillText(labelText, box.x + 8, box.y - 7);
    }

    // FPS counter
    frameCount++;
    if (Date.now() - lastFpsTime > 1000) {
      document.getElementById('fpsBar').textContent = `Detection rate: ${frameCount} fps · ${detections.length} face(s) in frame`;
      frameCount = 0; lastFpsTime = Date.now();
    }

    requestAnimationFrame(loop);
  }
  loop();
}

// ── Mark attendance ────────────────────────────────────────────────────────
async function markAttendance(studentData, confidence, photo) {
  try {
    await fetch(`${API}/attendance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: currentSession.id, student_id: studentData.id, confidence: confidence / 100 }),
    });
    addAttendanceCard(studentData, confidence, photo);
    toast(`✓ ${studentData.name} marked present (${confidence}%)`, 'success');
  } catch (e) { console.error(e); }
}

function addAttendanceCard(studentData, confidence, photo) {
  const list = document.getElementById('attendanceList');
  const empty = list.querySelector('.empty-state');
  if (empty) empty.remove();

  const item = document.createElement('div');
  item.className = 'attendance-item';
  item.innerHTML = `
    <div class="avatar">${photo ? `<img src="${photo}">` : getInitials(studentData.name)}</div>
    <div class="info">
      <strong>${studentData.name}</strong>
      <span>${studentData.roll} · ${new Date().toLocaleTimeString()}</span>
    </div>
    <div class="conf">${confidence}%</div>`;
  list.prepend(item);

  const count = document.getElementById('presentCount');
  count.textContent = parseInt(count.textContent || 0) + 1;
}

// ── End session ────────────────────────────────────────────────────────────
async function endSession() {
  if (!currentSession) return;
  if (!confirm('End this session and save attendance?')) return;
  await fetch(`${API}/sessions/${currentSession.id}/end`, { method: 'PUT' });
  stopCamera();
  toast('Session ended — attendance saved ✓', 'success');
  currentSession = null;
  document.getElementById('setupCard').style.display = 'block';
  document.getElementById('sessionBar').style.display = 'none';
  document.getElementById('scanLine').style.display = 'none';
  document.getElementById('exportBtn').disabled = true;
}

function stopCamera() {
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  document.getElementById('video').style.display = 'none';
  document.getElementById('overlay').style.display = 'none';
  document.getElementById('camPlaceholder').style.display = 'flex';
}

// ── Export ─────────────────────────────────────────────────────────────────
async function exportAttendance() {
  if (!currentSession) return;
  const rows = await fetch(`${API}/attendance/${currentSession.id}`).then(r => r.json());
  let csv = 'Name,Roll No,Class,Timestamp,Confidence\n';
  rows.forEach(r => { csv += `"${r.name}","${r.roll_no}","${r.class_name}","${r.timestamp}","${Math.round(r.confidence * 100)}%"\n`; });
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `attendance_${currentSession.name}_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
}

// ── Init ───────────────────────────────────────────────────────────────────
document.getElementById('sessionDate').value = new Date().toISOString().slice(0, 10);
loadClasses();
