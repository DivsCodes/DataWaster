const els = {
  target: document.getElementById('targetInput'),
  start: document.getElementById('startBtn'),
  pause: document.getElementById('pauseBtn'),
  stop: document.getElementById('stopBtn'),
  chunk: document.getElementById('chunkSelect'),
  wake: document.getElementById('wakeToggle'),
  progress: document.getElementById('progressBar'),
  progressText: document.getElementById('progressText'),
  eta: document.getElementById('etaText'),
  statusTitle: document.getElementById('statusTitle'),
  statusChip: document.getElementById('statusChip'),
  note: document.getElementById('statusNote'),
  wasted: document.getElementById('wastedStat'),
  speed: document.getElementById('speedStat'),
  elapsed: document.getElementById('elapsedStat'),
  peak: document.getElementById('peakStat'),
  canvas: document.getElementById('speedCanvas'),
  graphLabel: document.getElementById('graphLabel'),
  history: document.getElementById('historyList'),
  clearHistory: document.getElementById('clearHistoryBtn')
};

const ctx = els.canvas.getContext('2d');
const state = {
  running: false,
  paused: false,
  targetBytes: 0,
  wastedBytes: 0,
  startTime: 0,
  pausedAt: 0,
  pausedMs: 0,
  peakMbps: 0,
  sessionId: 0,
  abortController: null,
  wakeLock: null,
  speedHistory: Array(60).fill(0),
  lastBytes: 0,
  lastSpeedTime: 0,
  smoothMbps: 0
};

const MB = 1024 * 1024;
const HISTORY_KEY = 'dataWasterHistoryV3';

function formatMB(bytes) {
  const mb = bytes / MB;
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}
function formatMbps(mbps) { return `${mbps < 10 ? mbps.toFixed(1) : mbps.toFixed(0)} Mbps`; }
function formatTime(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return h ? `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}
function elapsedMs() { return state.startTime ? Date.now() - state.startTime - state.pausedMs : 0; }
function setBodyMode(mode) { document.body.classList.remove('running','paused','finished'); if (mode) document.body.classList.add(mode); }

function render() {
  const targetMB = state.targetBytes / MB;
  const pct = state.targetBytes > 0 ? Math.min(100, (state.wastedBytes / state.targetBytes) * 100) : (state.running ? 100 : 0);
  els.progress.style.width = `${pct}%`;
  els.progressText.textContent = state.targetBytes > 0 ? `${formatMB(state.wastedBytes)} / ${formatMB(state.targetBytes)}` : `${formatMB(state.wastedBytes)} / ∞`;
  els.wasted.textContent = formatMB(state.wastedBytes);
  els.speed.textContent = formatMbps(state.smoothMbps);
  els.peak.textContent = formatMbps(state.peakMbps);
  els.elapsed.textContent = formatTime(elapsedMs());

  if (state.targetBytes > 0 && state.smoothMbps > 0) {
    const remainingBits = Math.max(0, state.targetBytes - state.wastedBytes) * 8;
    const sec = remainingBits / (state.smoothMbps * 1e6);
    els.eta.textContent = `~${formatTime(sec * 1000)} left`;
  } else if (state.running) els.eta.textContent = 'No limit';
  else els.eta.textContent = '—';

  drawGraph();
}

function drawGraph() {
  const dpr = window.devicePixelRatio || 1;
  const rect = els.canvas.getBoundingClientRect();
  if (!rect.width) return;
  if (els.canvas.width !== Math.floor(rect.width * dpr) || els.canvas.height !== Math.floor(220 * dpr)) {
    els.canvas.width = Math.floor(rect.width * dpr);
    els.canvas.height = Math.floor(220 * dpr);
  }
  ctx.setTransform(dpr,0,0,dpr,0,0);
  const w = rect.width, h = 220;
  ctx.clearRect(0,0,w,h);

  ctx.strokeStyle = 'rgba(255,255,255,.05)'; ctx.lineWidth = 1;
  for (let y=40;y<h;y+=40) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(w,y); ctx.stroke(); }
  const max = Math.max(10, ...state.speedHistory) * 1.15;
  ctx.beginPath();
  state.speedHistory.forEach((v,i) => {
    const x = (i/(state.speedHistory.length-1))*w;
    const y = h - 18 - (v/max)*(h-36);
    if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
  });
  ctx.strokeStyle = '#b9ff5a'; ctx.lineWidth = 2.5; ctx.stroke();
  ctx.lineTo(w,h-18); ctx.lineTo(0,h-18); ctx.closePath();
  ctx.fillStyle = 'rgba(185,255,90,.06)'; ctx.fill();
  els.graphLabel.textContent = state.running ? `peak ${formatMbps(state.peakMbps)}` : 'Waiting for data…';
}

function setStatus(type, title, chip, note) {
  setBodyMode(type);
  els.statusTitle.textContent = title;
  els.statusChip.textContent = chip;
  els.note.textContent = note;
}

async function requestWakeLock() {
  if (!els.wake.checked || !('wakeLock' in navigator)) return;
  try { state.wakeLock = await navigator.wakeLock.request('screen'); }
  catch (_) { state.wakeLock = null; }
}
async function releaseWakeLock() {
  try { await state.wakeLock?.release(); } catch (_) {}
  state.wakeLock = null;
}

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && state.running && !state.paused) await requestWakeLock();
});

async function wasteChunk(signal, bytes) {
  const cacheBust = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const url = `https://speed.cloudflare.com/__down?bytes=${bytes}&cache=${cacheBust}`;
  const started = performance.now();
  const response = await fetch(url, { cache: 'no-store', signal });
  if (!response.ok) throw new Error(`Download endpoint returned ${response.status}`);

  let downloaded = 0;
  if (response.body) {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      downloaded += value.byteLength;
      state.wastedBytes += value.byteLength;
      updateSpeed();
      render();
      if (state.targetBytes > 0 && state.wastedBytes >= state.targetBytes) {
        try { await reader.cancel(); } catch (_) {}
        break;
      }
    }
  } else {
    const buffer = await response.arrayBuffer();
    downloaded = buffer.byteLength;
    state.wastedBytes += downloaded;
    updateSpeed();
    render();
  }
  const secs = Math.max(.001, (performance.now() - started) / 1000);
  return { downloaded, instantMbps: (downloaded * 8) / secs / 1e6 };
}

function updateSpeed() {
  const now = performance.now();
  if (!state.lastSpeedTime) { state.lastSpeedTime = now; state.lastBytes = state.wastedBytes; return; }
  const dt = (now - state.lastSpeedTime) / 1000;
  if (dt < .12) return;
  const delta = state.wastedBytes - state.lastBytes;
  const mbps = (delta * 8) / dt / 1e6;
  state.smoothMbps = state.smoothMbps ? state.smoothMbps * .65 + mbps * .35 : mbps;
  state.peakMbps = Math.max(state.peakMbps, mbps);
  state.speedHistory.push(state.smoothMbps); state.speedHistory.shift();
  state.lastSpeedTime = now; state.lastBytes = state.wastedBytes;
}

function resetSession() {
  state.wastedBytes = 0; state.startTime = Date.now(); state.pausedAt = 0; state.pausedMs = 0; state.peakMbps = 0;
  state.speedHistory = Array(60).fill(0); state.lastBytes = 0; state.lastSpeedTime = 0; state.smoothMbps = 0;
  render();
}

async function runSession() {
  if (state.running && !state.paused) return;
  let targetMB = Math.max(0, Number(els.target.value) || 0);
  state.targetBytes = targetMB * MB;
  const continuing = state.running && state.paused;
  if (!continuing) {
    state.sessionId++;
    state.running = true;
    resetSession();
  }
  state.paused = false;
  state.abortController = new AbortController();
  els.start.disabled = true; els.pause.disabled = false; els.stop.disabled = false;
  els.target.disabled = true; els.chunk.disabled = true;
  setStatus('running', targetMB > 0 ? 'Wasting data…' : 'Wasting data with no limit.', 'RUNNING', 'Downloading real bytes from the test endpoint. Your data usage will increase.');
  await requestWakeLock();

  const sessionId = state.sessionId;
  try {
    while (state.running && !state.paused && sessionId === state.sessionId) {
      const chunk = Number(els.chunk.value);
      const remaining = state.targetBytes > 0 ? state.targetBytes - state.wastedBytes : chunk;
      const bytes = Math.max(1024, Math.min(chunk, remaining));
      await wasteChunk(state.abortController.signal, bytes);
      if (state.targetBytes > 0 && state.wastedBytes >= state.targetBytes) {
        await finishSession(true);
        break;
      }
    }
  } catch (err) {
    if (err?.name !== 'AbortError' && state.running) {
      setStatus('paused', 'Download stopped.', 'ERROR', `Could not continue: ${err.message}. Check your connection and try again.`);
      state.running = false; state.paused = false;
      els.start.disabled = false; els.pause.disabled = true; els.stop.disabled = true; els.target.disabled = false; els.chunk.disabled = false;
      await releaseWakeLock();
    }
  }
}

async function pauseSession() {
  if (!state.running || state.paused) return;
  state.paused = true; state.pausedAt = Date.now(); state.abortController?.abort();
  els.pause.textContent = 'Resume';
  setStatus('paused', 'Paused.', 'PAUSED', 'Press Resume to continue the same session.');
  await releaseWakeLock();
}

async function resumeSession() {
  if (!state.running || !state.paused) return;
  state.pausedMs += Date.now() - state.pausedAt; state.pausedAt = 0; state.paused = false;
  state.abortController = new AbortController();
  els.pause.textContent = 'Pause';
  setStatus('running', 'Wasting data…', 'RUNNING', 'Back at it.');
  await requestWakeLock();
  runSession();
}

async function stopSession(save = true) {
  if (!state.running) return;
  state.running = false; state.paused = false; state.abortController?.abort(); state.sessionId++;
  await releaseWakeLock();
  const used = state.wastedBytes;
  const duration = elapsedMs();
  els.start.disabled = false; els.pause.disabled = true; els.stop.disabled = true; els.target.disabled = false; els.chunk.disabled = false; els.pause.textContent = 'Pause';
  setStatus('finished', used > 0 ? 'Stopped. Data successfully wasted.' : 'Ready to waste.', 'STOPPED', used > 0 ? 'Session ended by you.' : 'Nothing was downloaded.');
  if (save && used > 0) addHistory({ used, duration, peak: state.peakMbps, target: state.targetBytes });
  render();
}

async function finishSession() {
  state.running = false; state.paused = false; state.sessionId++;
  await releaseWakeLock();
  const used = state.wastedBytes, duration = elapsedMs();
  els.start.disabled = false; els.pause.disabled = true; els.stop.disabled = true; els.target.disabled = false; els.chunk.disabled = false; els.pause.textContent = 'Pause';
  setStatus('finished', 'Target reached. Data destroyed.', 'DONE', `You just used ${formatMB(used)} of your precious data.`);
  addHistory({ used, duration, peak: state.peakMbps, target: state.targetBytes });
  render();
}

function addHistory(item) {
  const history = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
  history.unshift({ ...item, at: Date.now() });
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 10)));
  renderHistory();
}
function renderHistory() {
  const history = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
  if (!history.length) { els.history.innerHTML = '<div class="empty-history">No finished sessions yet.</div>'; return; }
  els.history.innerHTML = history.map(h => {
    const when = new Date(h.at).toLocaleString([], { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' });
    return `<div class="history-row"><div class="history-main"><strong>${formatMB(h.used)}</strong><span>${when}${h.target ? ` · target ${formatMB(h.target)}` : ' · infinite'}</span></div><span>${formatTime(h.duration)}</span><span>${formatMbps(h.peak)} peak</span></div>`;
  }).join('');
}

els.start.addEventListener('click', runSession);
els.pause.addEventListener('click', () => state.paused ? resumeSession() : pauseSession());
els.stop.addEventListener('click', () => stopSession(true));
els.target.addEventListener('keydown', e => { if (e.key === 'Enter') runSession(); });
document.querySelectorAll('[data-preset]').forEach(btn => btn.addEventListener('click', () => { els.target.value = btn.dataset.preset; }));
els.clearHistory.addEventListener('click', () => { localStorage.removeItem(HISTORY_KEY); renderHistory(); });
setInterval(() => { if (state.startTime) { updateSpeed(); render(); } }, 500);
window.addEventListener('resize', drawGraph);
renderHistory(); render();
