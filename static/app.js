// ═══════════════════════════════════════════════════════════════════════
//  KardPad — app.js  v1.0
//  Cliente WebSocket para mando de Mario Kart Wii en Dolphin.
//  Inputs: botones digitales · inclinación (volante) · shake · puntero
// ═══════════════════════════════════════════════════════════════════════

/* ─── Colores por jugador ─────────────────────────────────────────── */
const PLAYER_COLORS = { 1: '#e74c3c', 2: '#3498db', 3: '#f1c40f', 4: '#2ecc71' };

/* ─── Sensibilidad del volante (inclinación) ─────────────────────── */
// deadzone: ignorar inclinaciones menores a este valor (0-1)
// threshold: a partir de aquí se "activa" la dirección (visual)
const TILT_SENSE_MAP = {
  1: { deadzone: 0.12, threshold: 0.28 },
  2: { deadzone: 0.10, threshold: 0.26 },
  3: { deadzone: 0.07, threshold: 0.22 },
  4: { deadzone: 0.04, threshold: 0.18 },
  5: { deadzone: 0.02, threshold: 0.14 },
};
const TILT_SMOOTH_ALPHA = 0.25;  // Suavizado EMA (0=sin suavizar, 1=máximo)

/* ─── Detección de shake ──────────────────────────────────────────── */
const SHAKE_THRESHOLD    = 18;   // m/s² — umbral de aceleración para shake
const SHAKE_DEBOUNCE_MS  = 250;  // tiempo mínimo entre dos shakes (ms)

/* ─── Estado global ───────────────────────────────────────────────── */
const state = {
  // WebSocket
  socket:          null,
  selectedPlayer:  1,
  connectedPlayer: null,
  wsUrl:           null,

  // Botones activos
  activeButtons: new Set(),

  // Volante (inclinación)
  tiltEnabled:       false,
  tiltPermission:    false,
  tiltNeutral:       null,   // valor de beta/gamma "al centro"
  tiltSmoothed:      0,      // valor suavizado del roll
  tiltSensLevel:     Number(lsGet('kardpad_tilt_sens') || '3'),

  // Shake
  lastShakeTs:        0,
  accelLast:          { x: 0, y: 0, z: 0 },

  // Puntero
  pointerEnabled:    false,

  // Ajustes
  vibrationEnabled:  lsGet('kardpad_vibration') !== 'false',

  // QR scanner
  qrStream:    null,
  qrAnimFrame: null,
};

/* ═══════════════════════════════════════════════════════════════════════
   ENTRADA
   ═══════════════════════════════════════════════════════════════════════ */

document.addEventListener('DOMContentLoaded', () => {
  bindSetup();
  bindController();
  applyPlayerTheme(1);
  initSettingsPanel();

  state.wsUrl = buildWsUrl();
  updateServerAddress();
  const p = getInitialPlayer();
  if (p) connectAs(p);
  else setSetupMessage('Toca tu jugador para conectarte.');
});

/* ─── URL del WebSocket ──────────────────────────────────────────── */
function buildWsUrl(hostOverride) {
  const params = new URLSearchParams(window.location.search);
  const host   = hostOverride || params.get('wsHost');
  const port   = params.get('wsPort') || '8000';
  if (host) return `ws://${host}:${port}`;
  return `ws://${window.location.hostname || '127.0.0.1'}:${port}`;
}

/* ═══════════════════════════════════════════════════════════════════════
   MÓDULO: SETUP
   ═══════════════════════════════════════════════════════════════════════ */

function getInitialPlayer() {
  const p = Number.parseInt(new URLSearchParams(location.search).get('player') || '', 10);
  return Number.isInteger(p) && p >= 1 && p <= 4 ? p : null;
}

function bindSetup() {
  document.querySelectorAll('.player-card').forEach((card) => {
    card.addEventListener('click', () => {
      const p = Number.parseInt(card.dataset.player || '', 10);
      if (p) connectAs(p);
    });
  });
  document.getElementById('openQrScannerBtn')?.addEventListener('click', openQrScanner);
}

/* ═══════════════════════════════════════════════════════════════════════
   MÓDULO: WEBSOCKET
   ═══════════════════════════════════════════════════════════════════════ */

function connectAs(player) {
  state.selectedPlayer = player;
  applyPlayerTheme(player);
  setStatus(`Conectando jugador ${player}...`);
  setSetupMessage(`Conectando P${player}…`);
  if (state.socket) disconnect('switch');

  let socket;
  try { socket = new WebSocket(state.wsUrl); }
  catch { showSetup(); setSetupMessage('No se pudo abrir el WebSocket.'); return; }

  state.socket = socket;

  const timer = setTimeout(() => {
    if (state.socket !== socket) return;
    if (socket.readyState === WebSocket.CONNECTING) {
      socket.close(); state.socket = null;
      showSetup(); setSetupMessage('Sin respuesta. ¿Está corriendo server.py?');
    }
  }, 6000);

  socket.addEventListener('open', () => {
    clearTimeout(timer);
    safeSend({ player });
  });

  socket.addEventListener('message', (event) => {
    let msg; try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.status === 'connected') {
      state.connectedPlayer = msg.player;
      applyPlayerTheme(msg.player);
      syncSettingsPlayerBtns(msg.player);
      showController();
      setStatus(`P${msg.player} conectado 🏎️`);
    }
    // Haptic del servidor (opcional)
    if (msg.type === 'haptic' && state.vibrationEnabled) {
      triggerHaptic(msg.duration_ms || 80);
    }
  });

  socket.addEventListener('error', () => {
    clearTimeout(timer);
    if (state.socket !== socket) return;
    showSetup(); setSetupMessage('No se pudo conectar. Revisa la IP y la Wi-Fi.');
  });

  socket.addEventListener('close', () => {
    clearTimeout(timer);
    if (state.socket !== socket) return;
    state.socket = null; releaseAllButtons();
    if (state.connectedPlayer !== null) {
      showSetup(); setSetupMessage('Conexión perdida.');
    }
    state.connectedPlayer = null;
  });
}

function disconnect(reason) {
  releaseAllButtons();
  if (!state.socket) { state.connectedPlayer = null; return; }
  const s = state.socket; state.socket = null; state.connectedPlayer = null;
  try { s.close(1000, reason); } catch {}
}

function safeSend(payload) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return;
  state.socket.send(JSON.stringify(payload));
}

/* ═══════════════════════════════════════════════════════════════════════
   MÓDULO: BOTONES DIGITALES
   ═══════════════════════════════════════════════════════════════════════ */

function bindController() {
  document.getElementById('tiltBtn')?.addEventListener('click', toggleTiltMode);
  document.getElementById('tiltCenterBtn')?.addEventListener('click', calibrateTilt);
  document.getElementById('fullscreenBtn')?.addEventListener('click', toggleFullscreen);
  document.getElementById('settingsGearBtn')?.addEventListener('click', openSettings);

  bindButtonPad();
  bindShakeButton();
  bindPointerPad();

  window.addEventListener('beforeunload', () => disconnect('pagehide'));
  window.addEventListener('pagehide',     () => disconnect('pagehide'));
  window.addEventListener('blur', releaseAllButtons);

  // Acelerómetro para inclinación y shake
  window.addEventListener('devicemotion', handleDeviceMotion);

  // Recalibrar al girar la pantalla
  const onOrientationChange = () => {
    setTimeout(() => {
      if (state.tiltEnabled) {
        state.tiltNeutral  = null;
        state.tiltSmoothed = 0;
        setTiltCopy('Orientación cambiada. Pulsa "Centrar".');
      }
    }, 350);
  };
  if (screen.orientation) screen.orientation.addEventListener('change', onOrientationChange);
  else window.addEventListener('orientationchange', onOrientationChange);

  updateTiltUi();
}

function bindButtonPad() {
  document.querySelectorAll('[data-btn]').forEach((btn) => {
    const name = btn.dataset.btn; if (!name) return;

    const press = (e) => {
      e.preventDefault();
      if (e.pointerId !== undefined) { try { btn.setPointerCapture(e.pointerId); } catch {} }
      if (btn.dataset.pressed === '1') return;
      btn.dataset.pressed = '1'; btn.classList.add('pressed');
      state.activeButtons.add(name);
      safeSend({ type: 'button', name, action: 'press' });
      if (['ACCELERATE','BRAKE','DRIFT'].includes(name)) triggerHaptic(18);
    };

    const release = (e) => {
      if (e) e.preventDefault();
      if (btn.dataset.pressed !== '1') return;
      if (e?.pointerId !== undefined) { try { btn.releasePointerCapture(e.pointerId); } catch {} }
      btn.dataset.pressed = '0'; btn.classList.remove('pressed');
      state.activeButtons.delete(name);
      safeSend({ type: 'button', name, action: 'release' });
    };

    btn.addEventListener('pointerdown',        press);
    btn.addEventListener('pointerup',          release);
    btn.addEventListener('pointercancel',      release);
    btn.addEventListener('pointerleave',       release);
    btn.addEventListener('lostpointercapture', release);
  });
}

/* ─── Botón de shake manual (truco / objeto) ─────────────────────── */
function bindShakeButton() {
  const btn = document.getElementById('shakeBtn');
  if (!btn) return;
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    triggerHaptic(40);
    safeSend({ type: 'shake', intensity: 1.0 });
    btn.classList.add('pressed');
  });
  btn.addEventListener('pointerup',     () => btn.classList.remove('pressed'));
  btn.addEventListener('pointercancel', () => btn.classList.remove('pressed'));
}

/* ─── Liberar todos los botones ──────────────────────────────────── */
function releaseAllButtons() {
  state.activeButtons.forEach(name => safeSend({ type: 'button', name, action: 'release' }));
  state.activeButtons.clear();
  document.querySelectorAll('[data-btn]').forEach(b => {
    b.classList.remove('pressed'); b.dataset.pressed = '0';
  });
}

/* ═══════════════════════════════════════════════════════════════════════
   MÓDULO: INCLINACIÓN (VOLANTE)
   ═══════════════════════════════════════════════════════════════════════ */

async function toggleTiltMode() {
  if (state.tiltEnabled) { disableTilt(); return; }
  const ok = await requestMotionPermission();
  if (!ok) { setTiltCopy('Permiso denegado. Pulsa "Volante" de nuevo.'); return; }
  state.tiltEnabled  = true;
  state.tiltSmoothed = 0;
  calibrateTilt();
  setStatus(`P${state.connectedPlayer ?? state.selectedPlayer} — Volante activo 🏎️`);
  setTiltCopy('Inclina como un volante. Pulsa "Centrar" si se desvía.');
  updateTiltUi();
}

function disableTilt() {
  state.tiltEnabled = false; state.tiltNeutral = null; state.tiltSmoothed = 0;
  updateTiltIndicator(0);
  updateTiltUi();
  setTiltCopy('Activa el Volante para girar.');
}

async function requestMotionPermission() {
  if (state.tiltPermission) return true;
  if (typeof DeviceMotionEvent === 'undefined') return false;
  if (typeof DeviceMotionEvent.requestPermission === 'function') {
    try {
      const r = await DeviceMotionEvent.requestPermission();
      state.tiltPermission = r === 'granted'; return state.tiltPermission;
    } catch { return false; }
  }
  state.tiltPermission = true; return true;
}

function calibrateTilt() {
  if (!state.lastTiltRaw) { setTiltCopy('Sujeta el móvil horizontal y pulsa "Centrar".'); return; }
  state.tiltNeutral  = state.lastTiltRaw;
  state.tiltSmoothed = 0;
  updateTiltIndicator(0);
  if (state.tiltEnabled) setTiltCopy('Centro guardado. Inclina para girar.');
}

/* ─── Ángulo de pantalla ─────────────────────────────────────────── */
function getScreenAngle() {
  if (typeof screen !== 'undefined' && screen.orientation) return screen.orientation.angle ?? 0;
  if (typeof window.orientation === 'number') return window.orientation;
  return 0;
}

/* ─── Procesamiento del acelerómetro ─────────────────────────────── */
function handleDeviceMotion(ev) {
  const acc = ev.accelerationIncludingGravity;
  if (!acc) return;

  // ── Inclinación (volante) ──────────────────────────────────────
  // Guardamos el valor raw para poder calibrar
  const angle  = getScreenAngle();
  let rawRoll;
  // En landscape (90°): el eje Y del acelerómetro es el roll
  if (angle === 90 || angle === -270) {
    rawRoll = clamp((acc.y ?? 0) / 9.8, -1, 1);
  } else if (angle === 270 || angle === -90) {
    rawRoll = clamp(-(acc.y ?? 0) / 9.8, -1, 1);
  } else {
    // Portrait: eje X es el roll
    rawRoll = clamp((acc.x ?? 0) / 9.8, -1, 1);
  }
  state.lastTiltRaw = rawRoll;

  if (state.tiltEnabled) {
    // Restar neutral si está calibrado
    const raw = state.tiltNeutral != null ? rawRoll - state.tiltNeutral : rawRoll;

    // Suavizado EMA
    const alpha = 1 - TILT_SMOOTH_ALPHA;
    state.tiltSmoothed = alpha * raw + TILT_SMOOTH_ALPHA * state.tiltSmoothed;

    // Deadzone
    const sens     = TILT_SENSE_MAP[state.tiltSensLevel] || TILT_SENSE_MAP[3];
    const smoothed = Math.abs(state.tiltSmoothed) > sens.deadzone ? state.tiltSmoothed : 0;

    safeSend({ type: 'tilt', axis: 'roll', value: smoothed, timestamp: Date.now() });
    updateTiltIndicator(smoothed);
  }

  // ── Detección de shake ────────────────────────────────────────
  const ax = acc.x ?? 0, ay = acc.y ?? 0, az = acc.z ?? 0;
  // Magnitud del "jerk" (cambio brusco de aceleración)
  const dx = ax - state.accelLast.x;
  const dy = ay - state.accelLast.y;
  const dz = az - state.accelLast.z;
  const jerk = Math.sqrt(dx*dx + dy*dy + dz*dz);

  state.accelLast = { x: ax, y: ay, z: az };

  if (jerk > SHAKE_THRESHOLD) {
    const now = Date.now();
    if (now - state.lastShakeTs > SHAKE_DEBOUNCE_MS) {
      state.lastShakeTs = now;
      const intensity = clamp(jerk / 40, 0, 1);
      safeSend({ type: 'shake', intensity });
      flashShakeButton();
    }
  }
}

/* ─── Barra visual de inclinación ────────────────────────────────── */
function updateTiltIndicator(value) {
  const ind = document.getElementById('tiltIndicator'); if (!ind) return;
  // value: -1 (izquierda) … 0 (centro) … +1 (derecha)
  const pct = clamp((value + 1) / 2 * 100, 0, 100);
  ind.style.left = `${pct}%`;

  // Colorear según dirección
  const sens = TILT_SENSE_MAP[state.tiltSensLevel] || TILT_SENSE_MAP[3];
  if (value > sens.threshold)       ind.style.background = '#3498db';
  else if (value < -sens.threshold) ind.style.background = '#e74c3c';
  else                              ind.style.background = '#f1c40f';
}

function flashShakeButton() {
  const btn = document.getElementById('shakeBtn'); if (!btn) return;
  btn.classList.add('shake-flash');
  setTimeout(() => btn.classList.remove('shake-flash'), 180);
  triggerHaptic(35);
}

/* ═══════════════════════════════════════════════════════════════════════
   MÓDULO: PUNTERO TÁCTIL (para menús de Dolphin)
   ═══════════════════════════════════════════════════════════════════════ */

function bindPointerPad() {
  const pad = document.getElementById('pointerPad'); if (!pad) return;

  const sendPointerMove = (e) => {
    const r  = pad.getBoundingClientRect();
    const nx = clamp((e.clientX - r.left) / r.width, 0, 1);
    const ny = clamp((e.clientY - r.top)  / r.height, 0, 1);
    safeSend({
      type:     'pointer_move',
      x:        nx,
      y:        ny,
      screen_w: window.screen.width  || 1920,
      screen_h: window.screen.height || 1080,
    });
  };

  let ptId = null;
  pad.addEventListener('pointerdown', (e) => {
    e.preventDefault(); ptId = e.pointerId; pad.setPointerCapture(e.pointerId);
    sendPointerMove(e);
    safeSend({ type: 'pointer_click', action: 'press' });
    triggerHaptic(18);
  });
  pad.addEventListener('pointermove', (e) => {
    if (e.pointerId !== ptId) return;
    e.preventDefault(); sendPointerMove(e);
  });
  pad.addEventListener('pointerup', (e) => {
    if (e.pointerId !== ptId) return;
    e.preventDefault(); ptId = null;
    safeSend({ type: 'pointer_click', action: 'release' });
  });
  pad.addEventListener('pointercancel', (e) => {
    if (e.pointerId !== ptId) return;
    ptId = null;
    safeSend({ type: 'pointer_click', action: 'release' });
  });
}

function setPointerVisible(visible) {
  const cluster = document.getElementById('pointer-cluster');
  if (cluster) cluster.style.display = visible ? 'flex' : 'none';
}

/* ═══════════════════════════════════════════════════════════════════════
   MÓDULO: HÁPTICA
   ═══════════════════════════════════════════════════════════════════════ */

function triggerHaptic(ms = 22) {
  if (!state.vibrationEnabled) return;
  if (navigator.vibrate) { try { navigator.vibrate(ms); } catch {} }
}

/* ═══════════════════════════════════════════════════════════════════════
   MÓDULO: AJUSTES
   ═══════════════════════════════════════════════════════════════════════ */

function initSettingsPanel() {
  document.getElementById('settingsCloseBtn')?.addEventListener('click', closeSettings);
  document.getElementById('settingsBackdrop')?.addEventListener('click', closeSettings);

  document.querySelectorAll('[data-settings-player]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const p = Number.parseInt(btn.dataset.settingsPlayer || '', 10); if (!p) return;
      if (state.connectedPlayer) { disconnect('switch'); connectAs(p); }
      else { state.selectedPlayer = p; applyPlayerTheme(p); syncSettingsPlayerBtns(p); }
      closeSettings();
    });
  });

  // Toggle vibración
  const vibToggle = document.getElementById('vibrationToggle');
  if (vibToggle) {
    vibToggle.setAttribute('aria-checked', state.vibrationEnabled ? 'true' : 'false');
    vibToggle.addEventListener('click', () => {
      state.vibrationEnabled = !state.vibrationEnabled;
      lsSet('kardpad_vibration', String(state.vibrationEnabled));
      vibToggle.setAttribute('aria-checked', state.vibrationEnabled ? 'true' : 'false');
      if (state.vibrationEnabled) triggerHaptic(30);
    });
  }

  // Toggle puntero
  const ptrToggle = document.getElementById('pointerToggle');
  if (ptrToggle) {
    ptrToggle.setAttribute('aria-checked', 'false');
    ptrToggle.addEventListener('click', () => {
      state.pointerEnabled = !state.pointerEnabled;
      ptrToggle.setAttribute('aria-checked', String(state.pointerEnabled));
      setPointerVisible(state.pointerEnabled);
    });
  }

  // Slider sensibilidad volante
  const slider = document.getElementById('tiltSensSlider');
  if (slider) {
    slider.value = String(state.tiltSensLevel); updateTiltSensLabel();
    slider.addEventListener('input', () => {
      state.tiltSensLevel = Number(slider.value);
      lsSet('kardpad_tilt_sens', String(state.tiltSensLevel));
      updateTiltSensLabel();
    });
  }

  document.getElementById('rescanQrBtn')?.addEventListener('click',  () => { closeSettings(); setTimeout(openQrScanner, 300); });
  document.getElementById('reconnectBtn')?.addEventListener('click', () => {
    closeSettings();
    if (state.wsUrl) { const p = state.connectedPlayer||state.selectedPlayer||1; disconnect('manual'); setTimeout(() => connectAs(p), 300); }
    else showSetup();
  });
  document.getElementById('changePlayerBtn')?.addEventListener('click', () => {
    closeSettings(); disconnect('manual'); disableTilt(); showSetup(); setStatus('Elige jugador.');
  });

  syncSettingsPlayerBtns(state.selectedPlayer);
}

function openSettings() { const o = document.getElementById('settingsOverlay'); if(o){o.classList.add('open');o.setAttribute('aria-hidden','false');} }
function closeSettings() { const o = document.getElementById('settingsOverlay'); if(o){o.classList.remove('open');o.setAttribute('aria-hidden','true');} }

function syncSettingsPlayerBtns(player) {
  document.querySelectorAll('[data-settings-player]').forEach((btn) => {
    btn.classList.toggle('active', Number.parseInt(btn.dataset.settingsPlayer||'',10) === player);
  });
}

function updateTiltSensLabel() {
  const labels = {1:'Zona muerta: muy amplia',2:'Zona muerta: amplia',3:'Zona muerta: media',4:'Zona muerta: pequeña',5:'Zona muerta: mínima'};
  const el = document.getElementById('tiltSensLabel'); if (el) el.textContent = labels[state.tiltSensLevel]||labels[3];
}

/* ═══════════════════════════════════════════════════════════════════════
   MÓDULO: QR SCANNER
   ═══════════════════════════════════════════════════════════════════════ */

function openQrScanner() {
  const modal = document.getElementById('qrScannerModal'); if (!modal) return;
  setQrResult('',''); document.getElementById('qrScannerHint').textContent = 'Apunta al QR del servidor';
  modal.classList.add('open'); modal.setAttribute('aria-hidden','false');
  startQrCamera();
}

function closeQrScanner() {
  stopQrCamera();
  const modal = document.getElementById('qrScannerModal');
  if (modal) { modal.classList.remove('open'); modal.setAttribute('aria-hidden','true'); }
}

function startQrCamera() {
  const video = document.getElementById('qrVideo'), canvas = document.getElementById('qrCanvas');
  if (!video || !canvas) return;
  stopQrCamera();
  navigator.mediaDevices.getUserMedia({ video:{ facingMode:'environment' }, audio:false })
    .then((stream) => {
      state.qrStream = stream; video.srcObject = stream; video.play().catch(()=>{});
      video.addEventListener('loadedmetadata', () => { canvas.width=video.videoWidth||640; canvas.height=video.videoHeight||640; scheduleQrScan(); }, { once:true });
    })
    .catch((err) => setQrResult(`No se pudo acceder a la cámara: ${err.name}`, 'error'));
}

function stopQrCamera() {
  if (state.qrAnimFrame) { cancelAnimationFrame(state.qrAnimFrame); state.qrAnimFrame=null; }
  if (state.qrStream)    { state.qrStream.getTracks().forEach(t=>t.stop()); state.qrStream=null; }
  const video=document.getElementById('qrVideo'); if(video) video.srcObject=null;
}

function scheduleQrScan() { state.qrAnimFrame = requestAnimationFrame(scanQrFrame); }

function scanQrFrame() {
  const video=document.getElementById('qrVideo'), canvas=document.getElementById('qrCanvas');
  if (!video||!canvas||!state.qrStream) return;
  if (video.readyState !== video.HAVE_ENOUGH_DATA) { scheduleQrScan(); return; }
  const ctx=canvas.getContext('2d',{willReadFrequently:true});
  canvas.width=video.videoWidth; canvas.height=video.videoHeight;
  ctx.drawImage(video,0,0,canvas.width,canvas.height);
  let imageData; try { imageData=ctx.getImageData(0,0,canvas.width,canvas.height); } catch { scheduleQrScan(); return; }
  const code=(typeof jsQR!=='undefined') ? jsQR(imageData.data,imageData.width,imageData.height,{inversionAttempts:'dontInvert'}) : null;
  if (code?.data) handleQrDetected(code.data); else scheduleQrScan();
}

function handleQrDetected(rawData) {
  let ip=null;
  try { ip=new URL(rawData.trim()).hostname; }
  catch { const m=rawData.trim().match(/(\d{1,3}(?:\.\d{1,3}){3})/); if(m) ip=m[1]; }
  if (!ip) { setQrResult('QR sin IP válida.','error'); scheduleQrScan(); return; }
  triggerHaptic(40); setQrResult(`✓ Servidor: ${ip}`,'success');
  lsSet('kardpad_ip', ip);
  setTimeout(() => {
    state.wsUrl=`ws://${ip}:8000`; updateServerAddress();
    closeQrScanner(); closeSettings();
    connectAs(getInitialPlayer()||state.selectedPlayer||1);
  }, 900);
}

function setQrResult(text,type) {
  const el=document.getElementById('qrScannerResult'); if(!el) return;
  el.textContent=text; el.className='qr-scanner-result'+(type?` ${type}`:'');
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('qrScannerClose')?.addEventListener('click', closeQrScanner);
});

/* ═══════════════════════════════════════════════════════════════════════
   MÓDULO: UI HELPERS
   ═══════════════════════════════════════════════════════════════════════ */

function applyPlayerTheme(player) {
  const color = PLAYER_COLORS[player] || PLAYER_COLORS[1];
  document.documentElement.style.setProperty('--player-color', color);
  document.documentElement.style.setProperty('--player-glow', `${color}66`);
  document.querySelectorAll('.player-card').forEach(c => {
    const sel = Number.parseInt(c.dataset.player||'',10) === player;
    c.classList.toggle('selected', sel); c.setAttribute('aria-checked', String(sel));
  });
}

function updateTiltUi() {
  const btn = document.getElementById('tiltBtn');
  const ctr = document.getElementById('tiltCenterBtn');
  if (btn) { btn.textContent = state.tiltEnabled ? 'Volante ON' : 'Volante OFF'; btn.classList.toggle('mini-btn-active', state.tiltEnabled); }
  if (ctr) { ctr.disabled = !state.tiltEnabled; ctr.classList.toggle('mini-btn-disabled', !state.tiltEnabled); }
}

function setTiltCopy(t) { const el=document.getElementById('tiltCopy'); if(el) el.textContent=t; }

function updateServerAddress() { const el=document.getElementById('serverAddress'); if(el) el.textContent=state.wsUrl||'--'; }

function showController() {
  document.getElementById('setup').style.display      = 'none';
  document.getElementById('controller').style.display = 'block';
}

function showSetup() {
  document.getElementById('controller').style.display = 'none';
  document.getElementById('setup').style.display      = 'flex';
}

function setStatus(t) { const el=document.getElementById('statusText'); if(el) el.textContent=t; }
function setSetupMessage(t) { const el=document.getElementById('setupCopy'); if(el) el.textContent=t; }

async function toggleFullscreen() {
  const root=document.documentElement;
  if (!document.fullscreenElement && root.requestFullscreen) { try { await root.requestFullscreen(); } catch {} }
  else if (document.fullscreenElement && document.exitFullscreen) { try { await document.exitFullscreen(); } catch {} }
}

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

/* ─── localStorage ───────────────────────────────────────────────── */
function lsGet(k)    { try { return localStorage.getItem(k); }    catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); }        catch {} }
