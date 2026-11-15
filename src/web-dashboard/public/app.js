// Web Simulation Dashboard Application (DS03)
'use strict';

const API_BASE = window.DS03_API_BASE || 'http://localhost:8080/api/v1';

// Tài khoản demo được tạo bởi scripts/seed-demo.js
const ACCOUNTS = {
  passenger1: { email: 'passenger1@demo.ds03', password: 'Password123!', name: 'Khách 1 (đủ tiền)' },
  passenger2: { email: 'passenger2@demo.ds03', password: 'Password123!', name: 'Khách 2 (tranh chấp CT-01)' },
  passengerZero: { email: 'passenger0@demo.ds03', password: 'Password123!', name: 'Khách 0đ (Saga bù trừ)' },
  driver: { email: 'driver1@demo.ds03', password: 'Password123!', name: 'Tài xế Nguyễn Văn Tài' },
};

const auth = {
  passenger1: { token: null, user: null },
  passenger2: { token: null, user: null },
  passengerZero: { token: null, user: null },
  driver: { token: null, user: null },
};

const DRIVER = {
  name: 'Nguyễn Văn Tài',
  plate: '29A-888.88',
  status: 'AVAILABLE',
  lat: 21.0285,
  lon: 105.8544,
};

let map, pickupMarker, dropoffMarker, driverMarker, routeLine;
let activeTrip = null;
let activeTripPassengerKey = null;
let currentPassengerKey = 'passenger1';
let clickMode = null;

function logLine(level, scope, message, correlationId = '') {
  const container = document.getElementById('logs-container');
  if (!container) return;

  const wrapper = document.createElement('div');
  wrapper.className = `log-entry log-${scope}`;
  wrapper.dataset.corr = correlationId;
  wrapper.dataset.service = scope;

  const header = document.createElement('div');
  header.className = 'flex items-center justify-between text-[10px] text-slate-400';
  const scopeEl = document.createElement('span');
  scopeEl.className = 'font-bold uppercase text-slate-300';
  scopeEl.textContent = `[${scope}]`;
  const timeEl = document.createElement('span');
  timeEl.textContent = new Date().toLocaleTimeString('vi-VN');
  header.append(scopeEl, timeEl);

  const body = document.createElement('div');
  body.className = 'text-slate-200 mt-0.5 break-words';
  body.textContent = String(message || '');

  wrapper.append(header, body);
  if (correlationId) {
    const corrEl = document.createElement('div');
    corrEl.className = 'text-[9px] text-slate-500 mt-1 truncate';
    corrEl.textContent = `corr: ${correlationId}`;
    wrapper.appendChild(corrEl);
  }

  container.prepend(wrapper);
  while (container.children.length > 100) container.removeChild(container.lastChild);
}

function addLogEntry(data) {
  const scope = (data.service || data.source_service || 'gateway').toLowerCase();
  const message = data.message || (data.event_type ? `Event: ${data.event_type}` : null)
    || (data.path ? `${data.method} ${data.path} -> ${data.statusCode}` : JSON.stringify(data));
  logLine(data.level || 'info', scope, message, data.correlation_id || '');
}

function updateAuthStatus() {
  const el = document.getElementById('auth-status');
  if (!el) return;
  const passenger = auth[currentPassengerKey]?.user;
  const driver = auth.driver?.user;
  const parts = [];
  parts.push(passenger ? `Passenger: ${passenger.email}` : 'Passenger: chưa đăng nhập');
  parts.push(driver ? `Driver: ${driver.email}` : 'Driver: chưa đăng nhập');
  el.textContent = parts.join(' | ');
  el.className = passenger && driver
    ? 'text-[10px] text-emerald-400'
    : 'text-[10px] text-amber-400';
}

async function login(key) {
  const account = ACCOUNTS[key];
  if (!account) throw new Error(`Tài khoản demo không tồn tại: ${key}`);

  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: account.email, password: account.password }),
  });
  const json = await res.json().catch(() => ({}));
  const data = json.data || json;
  if (!res.ok || !data?.token) {
    throw new Error(json.error?.message || `Đăng nhập thất bại (HTTP ${res.status})`);
  }

  auth[key] = { token: data.token, user: data.user || null };
  updateAuthStatus();
  logLine('info', 'identity', `Đăng nhập thành công: ${account.email}`, json.meta?.correlation_id);
  return auth[key];
}

async function ensureLogin(key) {
  if (auth[key]?.token) return auth[key];
  return login(key);
}

async function apiFetch(key, path, options = {}, retry = true) {
  await ensureLogin(key);
  const headers = {
    ...(options.headers || {}),
    Authorization: `Bearer ${auth[key].token}`,
  };
  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  if (res.status === 401 && retry) {
    auth[key] = { token: null, user: null };
    await login(key);
    return apiFetch(key, path, options, false);
  }
  return res;
}

async function readJson(res) {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (_) {
    return { raw: text };
  }
}

// Initialize Map
function initMap() {
  map = L.map('map').setView([21.0285, 105.8544], 13);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap contributors',
  }).addTo(map);

  const pickupIcon = L.divIcon({
    className: 'custom-icon',
    html: '<div style="background-color:#10b981; width:16px; height:16px; border-radius:50%; border:2px solid white; box-shadow:0 0 8px #10b981;"></div>',
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });

  const dropoffIcon = L.divIcon({
    className: 'custom-icon',
    html: '<div style="background-color:#f59e0b; width:16px; height:16px; border-radius:50%; border:2px solid white; box-shadow:0 0 8px #f59e0b;"></div>',
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });

  const driverIcon = L.divIcon({
    className: 'custom-icon',
    html: '<div style="background-color:#06b6d4; width:22px; height:22px; border-radius:4px; display:flex; align-items:center; justify-content:center; color:white; font-size:12px; border:2px solid white; box-shadow:0 0 10px #06b6d4;">🚕</div>',
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });

  pickupMarker = L.marker([21.0285, 105.8544], { icon: pickupIcon, draggable: true }).addTo(map);
  dropoffMarker = L.marker([21.0358, 105.7950], { icon: dropoffIcon, draggable: true }).addTo(map);
  driverMarker = L.marker([DRIVER.lat, DRIVER.lon], { icon: driverIcon, draggable: true }).addTo(map);

  updateRouteLine();

  pickupMarker.on('dragend', () => {
    const pos = pickupMarker.getLatLng();
    document.getElementById('pickup-lat').textContent = pos.lat.toFixed(4);
    document.getElementById('pickup-lon').textContent = pos.lng.toFixed(4);
    updateRouteLine();
  });

  dropoffMarker.on('dragend', () => {
    const pos = dropoffMarker.getLatLng();
    document.getElementById('dropoff-lat').textContent = pos.lat.toFixed(4);
    document.getElementById('dropoff-lon').textContent = pos.lng.toFixed(4);
    updateRouteLine();
  });

  driverMarker.on('dragend', async () => {
    const pos = driverMarker.getLatLng();
    DRIVER.lat = pos.lat;
    DRIVER.lon = pos.lng;
    await updateDriverLocation(pos.lat, pos.lng);
  });

  map.on('click', (e) => {
    if (clickMode === 'pickup') {
      pickupMarker.setLatLng(e.latlng);
      document.getElementById('pickup-lat').textContent = e.latlng.lat.toFixed(4);
      document.getElementById('pickup-lon').textContent = e.latlng.lng.toFixed(4);
      clickMode = null;
      document.getElementById('pickup-mode').textContent = 'Nhấp bản đồ để chọn';
      updateRouteLine();
    } else if (clickMode === 'dropoff') {
      dropoffMarker.setLatLng(e.latlng);
      document.getElementById('dropoff-lat').textContent = e.latlng.lat.toFixed(4);
      document.getElementById('dropoff-lon').textContent = e.latlng.lng.toFixed(4);
      clickMode = null;
      document.getElementById('dropoff-mode').textContent = 'Nhấp bản đồ để chọn';
      updateRouteLine();
    }
  });
}

function updateRouteLine() {
  if (routeLine) map.removeLayer(routeLine);
  const p1 = pickupMarker.getLatLng();
  const p2 = dropoffMarker.getLatLng();
  routeLine = L.polyline([p1, p2], { color: '#38bdf8', weight: 3, dashArray: '5, 8' }).addTo(map);
}

async function checkServicesHealth() {
  const checks = [
    ['gateway-indicator', 'http://localhost:8080/health'],
    ['payment-indicator', 'http://localhost:8005/health'],
    ['notification-indicator', 'http://localhost:8006/health'],
  ];
  await Promise.all(checks.map(async ([id, url]) => {
    const el = document.getElementById(id);
    if (!el) return;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      el.className = res.ok
        ? 'w-2.5 h-2.5 rounded-full bg-emerald-500'
        : 'w-2.5 h-2.5 rounded-full bg-red-500';
    } catch (_) {
      el.className = 'w-2.5 h-2.5 rounded-full bg-red-500';
    }
  }));
}

let eventSource = null;

function connectSSE() {
  const sseIndicator = document.getElementById('sse-indicator');
  const token = auth[currentPassengerKey]?.token;
  if (!token) {
    sseIndicator.className = 'w-2.5 h-2.5 rounded-full bg-red-500';
    return;
  }
  if (eventSource) eventSource.close();
  eventSource = new EventSource(
    `${API_BASE}/simulation/stream?token=${encodeURIComponent(token)}`
  );

  eventSource.onopen = () => {
    sseIndicator.className = 'w-2.5 h-2.5 rounded-full bg-emerald-500';
    logLine('info', 'gateway', 'SSE stream connected');
  };

  eventSource.onmessage = (event) => {
    try {
      handleIncomingEvent(JSON.parse(event.data));
    } catch (_) {}
  };

  eventSource.onerror = () => {
    sseIndicator.className = 'w-2.5 h-2.5 rounded-full bg-red-500';
  };
}

function setSagaStep(stepNum, isSuccess, label = null) {
  const el = document.getElementById(`step-${stepNum}`);
  if (!el) return;
  if (isSuccess) {
    el.className = 'step-active';
  } else {
    el.className = 'step-failed';
    if (label) el.textContent = `${el.textContent.split(' (')[0]} (${label})`;
  }
}

function handleIncomingEvent(data) {
  addLogEntry(data);

  const eventType = data.event_type || data.type;
  if (eventType === 'trip.event.created') {
    setSagaStep(1, true);
  } else if (eventType === 'trip.event.driver_matched') {
    setSagaStep(2, true);
    if (activeTrip && !activeTrip.driver_id && data.payload) {
      activeTrip.driver_id = data.payload.driver_id || activeTrip.driver_id;
      document.getElementById('trip-driver').textContent =
        (data.payload.driver_id || 'đã ghép').substring(0, 8);
    }
  } else if (eventType === 'payment.event.hold_success') {
    setSagaStep(3, true);
    setSagaStep(4, true);
    fetchWalletBalance();
  } else if (eventType === 'payment.event.hold_failed') {
    setSagaStep(3, false, 'FAILED');
    DRIVER.status = 'AVAILABLE';
    updateDriverUi();
    fetchWalletBalance();
  } else if (eventType === 'trip.event.completed') {
    DRIVER.status = 'AVAILABLE';
    updateDriverUi();
    fetchWalletBalance();
  } else if (eventType === 'payment.event.refund_requested') {
    fetchWalletBalance();
  }
}

async function fetchWalletBalance() {
  const el = document.getElementById('rider-balance');
  const heldEl = document.getElementById('rider-held');
  try {
    const res = await apiFetch(currentPassengerKey, '/payments/wallet');
    const json = await readJson(res);
    if (!res.ok) throw new Error(json.error?.message || `HTTP ${res.status}`);
    const balance = json.data?.balance ?? 0;
    const held = json.data?.held_balance ?? 0;
    el.textContent = Number(balance).toLocaleString('vi-VN');
    heldEl.textContent = Number(held).toLocaleString('vi-VN');
  } catch (err) {
    el.textContent = '--';
    heldEl.textContent = '--';
    logLine('warn', 'payment', `Không lấy được số dư: ${err.message}`);
  }
}

async function topupWallet(amount) {
  try {
    const res = await apiFetch(currentPassengerKey, '/payments/topup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount }),
    });
    const json = await readJson(res);
    if (!res.ok) throw new Error(json.error?.message || `HTTP ${res.status}`);
    const account = ACCOUNTS[currentPassengerKey];
    logLine('info', 'payment', `Nạp ${amount.toLocaleString('vi-VN')} đ thành công cho ${account.name}`);
    await fetchWalletBalance();
  } catch (err) {
    logLine('error', 'payment', `Nạp tiền thất bại: ${err.message}`);
  }
}

async function updateDriverLocation(lat, lon) {
  try {
    const res = await apiFetch('driver', '/drivers/location', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ latitude: lat, longitude: lon }),
    });
    if (!res.ok) {
      const json = await readJson(res);
      logLine('warn', 'driver', `Cập nhật GPS thất bại: ${json.error?.message || res.status}`);
    }
  } catch (err) {
    logLine('warn', 'driver', `Driver Service không khả dụng: ${err.message}`);
  }
}

function updateDriverUi() {
  const badge = document.getElementById('driver-status-badge');
  const btn = document.getElementById('btn-toggle-driver');
  if (!badge || !btn) return;
  if (DRIVER.status === 'AVAILABLE') {
    badge.textContent = 'AVAILABLE';
    badge.className = 'px-2 py-0.5 rounded font-bold uppercase text-[10px] bg-emerald-500/20 text-emerald-400 border border-emerald-500/30';
    btn.textContent = 'Tắt Hoạt Động';
  } else {
    badge.textContent = 'OFFLINE';
    badge.className = 'px-2 py-0.5 rounded font-bold uppercase text-[10px] bg-slate-700 text-slate-400 border border-slate-600';
    btn.textContent = 'Bật Hoạt Động';
  }
}

function setTripStatus(status, variant = 'info') {
  const el = document.getElementById('trip-status');
  if (!el) return;
  el.textContent = status;
  const variants = {
    info: 'px-2 py-0.5 rounded font-bold uppercase text-[10px] bg-amber-500/20 text-amber-300 border border-amber-500/30',
    success: 'px-2 py-0.5 rounded font-bold uppercase text-[10px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/30',
    error: 'px-2 py-0.5 rounded font-bold uppercase text-[10px] bg-rose-500/20 text-rose-300 border border-rose-500/30',
  };
  el.className = variants[variant] || variants.info;
}

function renderTrip(data) {
  if (!data) return;
  document.getElementById('trip-card').classList.remove('hidden');
  document.getElementById('trip-id').textContent = data.id ? `${data.id.substring(0, 8)}...` : 'pending';
  document.getElementById('trip-fare').textContent =
    Number(data.estimated_fare || data.fare || 0).toLocaleString('vi-VN');
  document.getElementById('trip-driver').textContent = data.driver_id
    ? String(data.driver_id).substring(0, 8)
    : 'Đang tìm...';
  setTripStatus(data.status || 'REQUESTED');
  document.getElementById('driver-actions-card').classList.remove('hidden');
  document.getElementById('btn-driver-accept').classList.remove('hidden');
  document.getElementById('btn-driver-start').classList.add('hidden');
  document.getElementById('btn-driver-complete').classList.add('hidden');
}

async function createTrip(overridePassengerKey = null) {
  const key = overridePassengerKey || currentPassengerKey;
  const pickup = pickupMarker.getLatLng();
  const dropoff = dropoffMarker.getLatLng();
  const correlationId = `corr_trip_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  try {
    const res = await apiFetch(key, '/trips', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Correlation-ID': correlationId,
        'Idempotency-Key': `trip_${key}_${Date.now()}`,
      },
      body: JSON.stringify({
        pickup_latitude: pickup.lat,
        pickup_longitude: pickup.lng,
        pickup_address: document.getElementById('pickup-address').value,
        dropoff_latitude: dropoff.lat,
        dropoff_longitude: dropoff.lng,
        dropoff_address: document.getElementById('dropoff-address').value,
      }),
    });
    const json = await readJson(res);
    if (!res.ok || !json.data) {
      throw new Error(json.error?.message || (res.status === 502
        ? 'Trip Service (:8003) chưa khởi động hoặc mất kết nối'
        : `HTTP ${res.status}`));
    }

    activeTrip = json.data;
    activeTripPassengerKey = key;
    renderTrip(activeTrip);
    document.getElementById('step-1').className = 'step-active';
    ['step-2', 'step-3', 'step-4'].forEach((id) => {
      document.getElementById(id).className = 'text-slate-500';
    });
    logLine('info', 'trip-service',
      `Tạo cuốc thành công (${activeTrip.id}), cước ${Number(activeTrip.estimated_fare || 0).toLocaleString('vi-VN')} đ`,
      correlationId);
    return activeTrip;
  } catch (err) {
    setTripStatus('FAILED', 'error');
    setSagaStep(1, false, 'FAILED');
    logLine('error', 'gateway', `Lỗi tạo cuốc: ${err.message}`, correlationId);
    return null;
  }
}

async function tripAction(action, successStatus) {
  if (!activeTrip?.id) {
    logLine('warn', 'trip-service', 'Chưa có chuyến đi đang hoạt động');
    return;
  }
  try {
    const res = await apiFetch('driver', `/trips/${activeTrip.id}/${action}`, { method: 'POST' });
    const json = await readJson(res);
    if (!res.ok) throw new Error(json.error?.message || `HTTP ${res.status}`);
    activeTrip = { ...activeTrip, ...(json.data || {}) };
    setTripStatus(successStatus, 'success');

    const acceptBtn = document.getElementById('btn-driver-accept');
    const startBtn = document.getElementById('btn-driver-start');
    const completeBtn = document.getElementById('btn-driver-complete');
    if (action === 'accept') {
      acceptBtn.classList.add('hidden');
      startBtn.classList.remove('hidden');
    } else if (action === 'start') {
      startBtn.classList.add('hidden');
      completeBtn.classList.remove('hidden');
    } else if (action === 'complete') {
      completeBtn.classList.add('hidden');
      acceptBtn.classList.remove('hidden');
    }

    logLine('info', 'trip-service', `Tài xế ${action} thành công cho chuyến ${activeTrip.id}`);
    if (action === 'complete') {
      DRIVER.status = 'AVAILABLE';
      updateDriverUi();
      await fetchWalletBalance();
    }
  } catch (err) {
    logLine('error', 'trip-service', `Thao tác ${action} thất bại: ${err.message}`);
  }
}

async function cancelTrip() {
  if (!activeTrip?.id || !activeTripPassengerKey) return;
  try {
    const res = await apiFetch(activeTripPassengerKey, `/trips/${activeTrip.id}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'PASSENGER_CANCELLED_FROM_DASHBOARD' }),
    });
    const json = await readJson(res);
    if (!res.ok) throw new Error(json.error?.message || `HTTP ${res.status}`);
    setTripStatus('CANCELLED', 'error');
    logLine('info', 'trip-service', `Huỷ chuyến ${activeTrip.id} thành công`);
    await fetchWalletBalance();
  } catch (err) {
    logLine('error', 'trip-service', `Huỷ chuyến thất bại: ${err.message}`);
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  initMap();
  checkServicesHealth();
  setInterval(checkServicesHealth, 5000);

  // Đăng nhập nhanh các tài khoản demo đã seed.
  try {
    await ensureLogin('passenger1');
    await ensureLogin('driver');
    // Làm mới GPS để Matching luôn thấy tài xế trong cửa sổ location_max_age.
    await updateDriverLocation(DRIVER.lat, DRIVER.lon);
  } catch (err) {
    logLine('warn', 'identity', `Đăng nhập demo thất bại: ${err.message}. Hãy chạy node scripts/seed-demo.js.`);
  }
  updateAuthStatus();
  connectSSE();
  await fetchWalletBalance();

  document.getElementById('btn-login-passenger').addEventListener('click', async () => {
    try { await login('passenger1'); await fetchWalletBalance(); connectSSE(); } catch (err) { logLine('error', 'identity', err.message); }
  });
  document.getElementById('btn-login-passenger2').addEventListener('click', async () => {
    try { await login('passenger2'); connectSSE(); } catch (err) { logLine('error', 'identity', err.message); }
  });
  document.getElementById('btn-login-zero').addEventListener('click', async () => {
    try { await login('passengerZero'); connectSSE(); } catch (err) { logLine('error', 'identity', err.message); }
  });
  document.getElementById('btn-login-driver').addEventListener('click', async () => {
    try { await login('driver'); } catch (err) { logLine('error', 'identity', err.message); }
  });

  document.getElementById('rider-select').addEventListener('change', async (e) => {
    currentPassengerKey = e.target.value;
    try {
      await ensureLogin(currentPassengerKey);
      updateAuthStatus();
      connectSSE();
      await fetchWalletBalance();
    } catch (err) {
      logLine('error', 'identity', err.message);
    }
  });

  document.getElementById('btn-topup').addEventListener('click', () => topupWallet(100000));

  document.getElementById('btn-book-trip').addEventListener('click', () => createTrip());

  document.getElementById('btn-demo-concurrency').addEventListener('click', async () => {
    logLine('info', 'gateway', '⚡ [CT-01] Bắn đồng thời 2 yêu cầu đặt xe từ Khách 1 và Khách 2');
    await Promise.all([createTrip('passenger1'), createTrip('passenger2')]);
  });

  document.getElementById('btn-demo-saga').addEventListener('click', () => {
    document.getElementById('rider-select').value = 'passengerZero';
    currentPassengerKey = 'passengerZero';
    logLine('info', 'gateway', '💥 [FR-02] Đặt xe bằng tài khoản 0đ để kích hoạt Saga bù trừ');
    createTrip('passengerZero');
  });

  document.getElementById('pickup-mode').addEventListener('click', () => {
    clickMode = 'pickup';
    document.getElementById('pickup-mode').textContent = '👉 Hãy nhấp lên bản đồ...';
  });

  document.getElementById('dropoff-mode').addEventListener('click', () => {
    clickMode = 'dropoff';
    document.getElementById('dropoff-mode').textContent = '👉 Hãy nhấp lên bản đồ...';
  });

  document.getElementById('btn-toggle-driver').addEventListener('click', async () => {
    const nextStatus = DRIVER.status === 'AVAILABLE' ? 'OFFLINE' : 'AVAILABLE';
    try {
      const res = await apiFetch('driver', '/drivers/status', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: nextStatus }),
      });
      const json = await readJson(res);
      if (!res.ok) throw new Error(json.error?.message || `HTTP ${res.status}`);
      DRIVER.status = nextStatus;
      updateDriverUi();
      logLine('info', 'driver', `Trạng thái tài xế: ${nextStatus}`);
    } catch (err) {
      logLine('error', 'driver', `Đổi trạng thái thất bại: ${err.message}`);
    }
  });

  document.getElementById('btn-clear-logs').addEventListener('click', () => {
    document.getElementById('logs-container').textContent = '';
  });

  document.getElementById('log-filter').addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase();
    document.querySelectorAll('.log-entry').forEach((entry) => {
      entry.style.display = entry.textContent.toLowerCase().includes(query) ? 'block' : 'none';
    });
  });

  document.getElementById('btn-driver-accept').addEventListener('click', () => tripAction('accept', 'ACCEPTED'));
  document.getElementById('btn-driver-start').addEventListener('click', () => tripAction('start', 'IN_PROGRESS'));
  document.getElementById('btn-driver-complete').addEventListener('click', () => tripAction('complete', 'COMPLETED'));
  document.getElementById('btn-cancel-trip').addEventListener('click', cancelTrip);
});
