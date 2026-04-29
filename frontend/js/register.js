const API = 'http://localhost:3000/api';
const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model';

let stream = null;
let modelsLoaded = false;
let capturedDescriptors = [];
let capturedPhotos = [];

// ── Liveness state ─────────────────────────────────────────────────────────
let livenessVerified  = false;
let calibrating       = true;   // true during baseline measurement
let calibrationNoses  = [];     // raw nose-X samples during calibration
let baselineNoseX     = null;   // center nose-X for THIS user
let faceBaseWidth     = null;   // avg face box width for normalization

const CALIBRATION_FRAMES = 40; // ~2 s of frames to establish baseline
// How far nose must move (as fraction of face width) to count as a turn
const TURN_THRESHOLD  = 0.12;
// How many distinct turns (left OR right) are needed
const TURNS_NEEDED    = 2;

// State machine: 'center' → 'left'/'right' → back to 'center' = 1 turn
let headState   = 'center'; // 'center' | 'left' | 'right'
let turnCount   = 0;

// ── Nose offset helper ─────────────────────────────────────────────────────
// Returns normalised nose-X offset: negative = left, positive = right
function getNoseOffset(landmarks, box) {
  const nose = landmarks.getNose(); // array of points; tip is nose[3]
  const tip  = nose[3];
  const faceCenter = box.x + box.width / 2;
  return (tip.x - faceCenter) / box.width; // –0.5 … +0.5
}

function arrMean(arr) {
  return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
}

// ── Liveness UI helpers ────────────────────────────────────────────────────
function ensureLivenessUI() {
  if (!document.getElementById('livenessIndicator')) {
    const badge = document.createElement('div');
    badge.id = 'livenessIndicator';
    badge.className = 'liveness-badge pending';
    badge.innerHTML = '<span class="live-dot"></span><span id="liveBadgeText">Calibrating…</span>';
    document.getElementById('camWrap').after(badge);
  }
  if (!document.getElementById('livenessChallenge')) {
    const c = document.createElement('div');
    c.id = 'livenessChallenge';
    c.className = 'liveness-challenge';
    c.innerHTML = `
      <span class="challenge-icon">🔄</span>
      <div style="flex:1">
        <div id="challengeText" style="color:#ffd60a">Keep still — calibrating…</div>
        <div class="challenge-bar"><div class="challenge-bar-fill" id="blinkBar" style="width:0%"></div></div>
      </div>
      <span id="earDebug" style="font-size:.7rem;color:var(--text-muted);font-weight:400;min-width:64px;text-align:right"></span>`;
    document.getElementById('camWrap').appendChild(c);
  }
}

function updateLivenessUI() {
  const badge  = document.getElementById('livenessIndicator');
  const bText  = document.getElementById('liveBadgeText');
  const cText  = document.getElementById('challengeText');
  const bar    = document.getElementById('blinkBar');
  const cEl    = document.getElementById('livenessChallenge');
  if (!badge) return;

  if (livenessVerified) {
    badge.className = 'liveness-badge verified';
    bText.textContent = '✓ Liveness verified — capture your samples';
    if (cEl) cEl.classList.add('hidden');
    if (bar) bar.style.width = '100%';
    return;
  }

  if (calibrating) {
    const pct = Math.round((calibrationNoses.length / CALIBRATION_FRAMES) * 100);
    badge.className = 'liveness-badge checking';
    bText.textContent = `⚙️ Calibrating head sensor… ${pct}%`;
    if (cText) { cText.style.color = '#4facfe'; cText.textContent = 'Look straight at the camera'; }
    if (bar)   bar.style.width = pct + '%';
  } else {
    const remaining = TURNS_NEEDED - turnCount;
    badge.className = 'liveness-badge pending';
    bText.textContent = `🔄 Turn head ${remaining} more time${remaining > 1 ? 's' : ''} (left or right)`;
    if (cText) {
      cText.style.color = '#ffd60a';
      const dir = headState === 'center' ? 'Slowly turn your head left or right' :
                  headState === 'left'   ? 'Good! Now return to center ✓'       :
                                           'Good! Now return to center ✓';
      cText.textContent = `${dir}  (${turnCount}/${TURNS_NEEDED})`;
    }
    if (bar) bar.style.width = (turnCount / TURNS_NEEDED * 100) + '%';
  }
}

function resetLiveness() {
  livenessVerified  = false;
  calibrating       = true;
  calibrationNoses  = [];
  baselineNoseX     = null;
  faceBaseWidth     = null;
  headState         = 'center';
  turnCount         = 0;

  const badge = document.getElementById('livenessIndicator');
  const bar   = document.getElementById('blinkBar');
  const cEl   = document.getElementById('livenessChallenge');
  if (badge) badge.className = 'liveness-badge pending';
  if (bar)   bar.style.width = '0%';
  if (cEl)   cEl.classList.remove('hidden');
  updateLivenessUI();
}

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

// ── Load models ────────────────────────────────────────────────────────────
async function loadModels() {
  if (modelsLoaded) return;
  toast('Loading AI models… (first load may take a moment)', 'info');
  try {
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68TinyNet.loadFromUri(MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
    ]);
    modelsLoaded = true;
    toast('AI models ready ✓', 'success');
  } catch (e) {
    toast('Failed to load AI models. Check internet connection.', 'error');
    throw e;
  }
}

// ── Camera ─────────────────────────────────────────────────────────────────
async function startCamera() {
  await loadModels();
  const video = document.getElementById('video');
  const overlay = document.getElementById('overlay');
  const placeholder = document.getElementById('camPlaceholder');
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: 'user' },
      audio: false,
    });
    video.srcObject = stream;
    await new Promise(res => (video.onloadedmetadata = res));
    video.style.display = 'block';
    overlay.width  = video.videoWidth;
    overlay.height = video.videoHeight;
    overlay.style.display = 'block';
    placeholder.style.display = 'none';
    document.getElementById('captureBtn').disabled = true;
    document.getElementById('startCamBtn').textContent = '⏹ Stop Camera';
    document.getElementById('startCamBtn').onclick = stopCamera;
    ensureLivenessUI();
    resetLiveness();
    runLiveDetection();
  } catch (e) {
    toast('Camera access denied — please allow camera permission', 'error');
  }
}

function stopCamera() {
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  document.getElementById('video').style.display = 'none';
  document.getElementById('overlay').style.display = 'none';
  document.getElementById('camPlaceholder').style.display = 'flex';
  document.getElementById('captureBtn').disabled = true;
  document.getElementById('startCamBtn').textContent = '▶ Start Camera';
  document.getElementById('startCamBtn').onclick = startCamera;
  resetLiveness();
}

// ── Main detection loop ────────────────────────────────────────────────────
async function runLiveDetection() {
  const video  = document.getElementById('video');
  const canvas = document.getElementById('overlay');
  const ctx    = canvas.getContext('2d');
  const opts   = new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.4 });

  async function loop() {
    if (!stream) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const det = await faceapi
      .detectSingleFace(video, opts)
      .withFaceLandmarks(true);

    if (det) {
      const box   = det.detection.box;
      const lm    = det.landmarks;

      // ── Draw bounding box ────────────────────────────────────────────
      const boxColor = livenessVerified ? '#00f5a0' : calibrating ? '#4facfe' : '#ffd60a';
      ctx.strokeStyle = boxColor;
      ctx.lineWidth   = 2;
      ctx.shadowColor = boxColor;
      ctx.shadowBlur  = 10;
      ctx.strokeRect(box.x, box.y, box.width, box.height);
      ctx.shadowBlur  = 0;
      ctx.fillStyle   = boxColor;
      ctx.font        = 'bold 12px Inter, sans-serif';
      const label = livenessVerified ? '✓ Live'
                  : calibrating      ? 'Calibrating…'
                  : headState === 'center' ? 'Turn head ↔'
                  : 'Return to center ↩';
      ctx.fillText(label, box.x + 4, box.y - 8);

      // ── Nose tip dot ────────────────────────────────────────────────
      const nose = lm.getNose();
      const tip  = nose[3];
      ctx.fillStyle = boxColor;
      ctx.beginPath();
      ctx.arc(tip.x, tip.y, 4, 0, Math.PI * 2);
      ctx.fill();

      // ── Nose offset ─────────────────────────────────────────────────
      const offset = getNoseOffset(lm, box); // –0.5 … +0.5

      // Update debug readout
      const dbg = document.getElementById('earDebug');
      if (dbg) dbg.textContent = `off ${offset.toFixed(3)}`;

      // ── Phase 1 — Calibration ────────────────────────────────────────
      if (calibrating && !livenessVerified) {
        calibrationNoses.push(offset);
        updateLivenessUI();

        if (calibrationNoses.length >= CALIBRATION_FRAMES) {
          // Use median offset as the baseline center
          const sorted = [...calibrationNoses].sort((a, b) => a - b);
          baselineNoseX = sorted[Math.floor(sorted.length / 2)];
          calibrating   = false;
          headState     = 'center';
          toast('✓ Head sensor calibrated — now slowly turn your head left or right', 'success');
          updateLivenessUI();
        }
      }

      // ── Phase 2 — Head movement detection ───────────────────────────
      if (!calibrating && !livenessVerified) {
        // Relative offset from calibrated center
        const rel = offset - baselineNoseX;

        if (headState === 'center') {
          if (rel < -TURN_THRESHOLD) {
            headState = 'left';
            toast('◀ Head turned left!', 'info');
            updateLivenessUI();
          } else if (rel > TURN_THRESHOLD) {
            headState = 'right';
            toast('▶ Head turned right!', 'info');
            updateLivenessUI();
          }
        } else {
          // Waiting to return to center (within half the threshold)
          if (Math.abs(rel) < TURN_THRESHOLD * 0.5) {
            turnCount++;
            headState = 'center';
            toast(`Turn ${turnCount}/${TURNS_NEEDED} counted ✓`, 'info');
            updateLivenessUI();

            if (turnCount >= TURNS_NEEDED) {
              livenessVerified = true;
              toast('✅ Liveness confirmed! You may capture samples now.', 'success');
              updateLivenessUI();
            }
          }
        }

        // ── Draw direction arrow ─────────────────────────────────────
        if (!livenessVerified) {
          const cx = canvas.width / 2;
          const cy = box.y + box.height + 28;
          ctx.fillStyle = '#ffd60a';
          ctx.font = 'bold 22px Inter, sans-serif';
          ctx.textAlign = 'center';
          if (headState === 'center') {
            ctx.fillText('← Turn your head →', cx, cy);
          } else {
            ctx.fillText('↩ Return to center', cx, cy);
          }
          ctx.textAlign = 'left';
        }
      }

      // ── Enable capture button ────────────────────────────────────────
      document.getElementById('captureBtn').disabled =
        !livenessVerified || capturedDescriptors.length >= 5;

    } else {
      // No face detected
      document.getElementById('captureBtn').disabled = true;
      const dbg = document.getElementById('earDebug');
      if (dbg) dbg.textContent = 'No face';
    }

    requestAnimationFrame(loop);
  }
  loop();
}

// ── Capture sample ──────────────────────────────────────────────────────────
async function captureFrame() {
  if (!livenessVerified) {
    toast('⚠️ Move your head left and right first to verify liveness', 'error');
    return;
  }
  if (capturedDescriptors.length >= 5) return;

  const video = document.getElementById('video');
  const opts  = new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.4 });
  const det   = await faceapi.detectSingleFace(video, opts).withFaceLandmarks(true).withFaceDescriptor();
  if (!det) { toast('No face detected — try again', 'error'); return; }

  capturedDescriptors.push(Array.from(det.descriptor));

  const tmp = document.createElement('canvas');
  const b = det.detection.box;
  const pad = 20;
  tmp.width  = Math.min(b.width  + pad * 2, video.videoWidth);
  tmp.height = Math.min(b.height + pad * 2, video.videoHeight);
  tmp.getContext('2d').drawImage(
    video,
    Math.max(0, b.x - pad), Math.max(0, b.y - pad),
    tmp.width, tmp.height,
    0, 0, tmp.width, tmp.height,
  );
  capturedPhotos.push(tmp.toDataURL('image/jpeg', 0.7));

  updatePhotoGrid();
  toast(`Sample ${capturedDescriptors.length}/5 captured ✓`, 'success');
  if (capturedDescriptors.length === 5) {
    document.getElementById('registerBtn').disabled = false;
    document.getElementById('progressMsg').textContent = '5 samples captured — ready to register!';
    document.getElementById('captureBtn').disabled = true;
  } else {
    document.getElementById('progressMsg').textContent = `${capturedDescriptors.length}/5 samples captured`;
  }
  document.getElementById('captureCount').textContent = capturedDescriptors.length;
}

function updatePhotoGrid() {
  document.querySelectorAll('.photo-slot').forEach((slot, i) => {
    if (capturedPhotos[i]) {
      slot.classList.add('filled');
      slot.innerHTML = `<img src="${capturedPhotos[i]}">`;
    }
  });
}

// ── Average descriptor ──────────────────────────────────────────────────────
function averageDescriptors(descriptors) {
  const len = descriptors[0].length;
  const avg = new Array(len).fill(0);
  for (const d of descriptors) d.forEach((v, i) => (avg[i] += v));
  return avg.map(v => v / descriptors.length);
}

// ── Register student ────────────────────────────────────────────────────────
async function registerStudent() {
  const name      = document.getElementById('studentName').value.trim();
  const rollNo    = document.getElementById('rollNo').value.trim();
  const className = document.getElementById('className').value.trim();
  if (!name || !rollNo || !className) { toast('Fill in all student details', 'error'); return; }
  if (capturedDescriptors.length < 5) { toast('Need 5 face samples first', 'error'); return; }

  const btn = document.getElementById('registerBtn');
  btn.disabled = true; btn.textContent = 'Registering…';
  try {
    const res  = await fetch(`${API}/students`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name, roll_no: rollNo, class_name: className,
        descriptor: averageDescriptors(capturedDescriptors),
        photo: capturedPhotos[0],
      }),
    });
    const data = await res.json();
    if (!res.ok) toast(data.error || 'Registration failed', 'error');
    else { toast(`${name} registered successfully! 🎓`, 'success'); resetForm(); loadStudents(); }
  } catch {
    toast('Server error — is the backend running?', 'error');
  } finally {
    btn.disabled = false; btn.textContent = '🎓 Register Student';
  }
}

// ── Reset ───────────────────────────────────────────────────────────────────
function resetForm() {
  ['studentName', 'rollNo', 'className'].forEach(id => (document.getElementById(id).value = ''));
  capturedDescriptors = [];
  capturedPhotos      = [];
  document.querySelectorAll('.photo-slot').forEach((s, i) => {
    s.classList.remove('filled');
    s.innerHTML = `<span class="count">${i + 1}</span>`;
  });
  document.getElementById('captureCount').textContent = '0';
  document.getElementById('progressMsg').textContent  = 'No samples captured yet.';
  document.getElementById('registerBtn').disabled     = true;
  if (stream) resetLiveness();
}

// ── Enrolled students ───────────────────────────────────────────────────────
async function loadStudents() {
  try {
    const students = await fetch(`${API}/students`).then(r => r.json());
    const list = document.getElementById('enrolledList');
    if (!students.length) {
      list.innerHTML = '<div class="empty-state"><p>No students enrolled yet</p></div>';
      return;
    }
    list.innerHTML = students.map(s => `
      <div class="activity-item" style="display:flex;align-items:center;gap:10px">
        <div style="width:34px;height:34px;border-radius:50%;background:linear-gradient(135deg,var(--accent),var(--accent2));display:flex;align-items:center;justify-content:center;font-weight:700;font-size:.75rem;flex-shrink:0;overflow:hidden">
          ${s.photo ? `<img src="${s.photo}" style="width:100%;height:100%;object-fit:cover">` : getInitials(s.name)}
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-size:.87rem;font-weight:600">${s.name}</div>
          <div style="font-size:.72rem;color:var(--text-secondary)">${s.roll_no} · ${s.class_name}</div>
        </div>
        <button onclick="deleteStudent('${s.id}','${s.name}')" class="btn btn-danger" style="padding:4px 10px;font-size:.75rem">✕</button>
      </div>`).join('');
  } catch (e) { console.error(e); }
}

async function deleteStudent(id, name) {
  if (!confirm(`Remove ${name} from the system?`)) return;
  await fetch(`${API}/students/${id}`, { method: 'DELETE' });
  toast(`${name} removed`, 'info');
  loadStudents();
}

loadStudents();
