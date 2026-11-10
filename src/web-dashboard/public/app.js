// Web Simulation Dashboard Application (DS03)
'use strict';

const API_BASE = 'http://localhost:8080/api/v1';

// Predefined Demo Entities
const PASSENGERS = {
  'passenger-1': { id: '11111111-1111-4111-a111-111111111111', name: 'Nguyễn Văn A (Đủ tiền)' },
  'passenger-2': { id: '22222222-2222-4222-a222-222222222222', name: 'Trần Thị B (Tranh chấp CT-01)' },
  'passenger-zero': { id: '33333333-3333-4333-a333-333333333333', name: 'Lê Văn C (0 đ - Saga Bù Trừ)' },
};

const DRIVER = {
  id: 'd1111111-1111-4111-a111-111111111111',
  userId: 'd9999999-9999-4999-a999-999999999999',
  name: 'Nguyễn Văn Tài',
  plate: '29A-888.88',
  status: 'AVAILABLE',
  lat: 21.0285,
  lon: 105.8544,
};

let map, pickupMarker, dropoffMarker, driverMarker, routeLine;
let activeTrip = null;
let currentPassengerKey = 'passenger-1';
let clickMode = null; // 'pickup' | 'dropoff'

// Initialize Map
function initMap() {
  map = L.map('map').setView([21.0285, 105.8544], 13);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap contributors',
  }).addTo(map);

  // Custom icons
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

// Health check monitoring
async function checkServicesHealth() {
  const gwIndicator = document.getElementById('gateway-indicator');
  const payIndicator = document.getElementById('payment-indicator');

  try {
    const res = await fetch('http://localhost:8080/health', { signal: AbortSignal.timeout(1500) });
    if (res.ok) {
      gwIndicator.className = 'w-2.5 h-2.5 rounded-full bg-emerald-500';
    } else {
      gwIndicator.className = 'w-2.5 h-2.5 rounded-full bg-red-500';
    }
  } catch (_) {
    gwIndicator.className = 'w-2.5 h-2.5 rounded-full bg-red-500';
  }

  try {
    const res = await fetch('http://localhost:8005/health', { signal: AbortSignal.timeout(1500) });
    if (res.ok) {
      payIndicator.className = 'w-2.5 h-2.5 rounded-full bg-emerald-500';
    } else {
      payIndicator.className = 'w-2.5 h-2.5 rounded-full bg-red-500';
    }
  } catch (_) {
    payIndicator.className = 'w-2.5 h-2.5 rounded-full bg-red-500';
  }
}

// SSE Live Stream Connection
function connectSSE() {
  const sseIndicator = document.getElementById('sse-indicator');
  const sseUrl = `${API_BASE}/simulation/stream`;
  const eventSource = new EventSource(sseUrl);

  eventSource.onopen = () => {
    sseIndicator.className = 'w-2.5 h-2.5 rounded-full bg-emerald-500';
    addLogEntry({
      type: 'SYSTEM',
      service: 'gateway',
      message: 'SSE Stream connected successfully to API Gateway',
    });
  };

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleIncomingEvent(data);
    } catch (_) {}
  };

  eventSource.onerror = () => {
    sseIndicator.className = 'w-2.5 h-2.5 rounded-full bg-red-500';
  };
}

function handleIncomingEvent(data) {
  addLogEntry(data);

  // Update Saga visualizer if event matches
  const eventType = data.event_type || data.type;
  if (eventType === 'trip.event.created') {
    setSagaStep(1, true);
  } else if (eventType === 'trip.event.driver_matched') {
    setSagaStep(2, true);
  } else if (eventType === 'payment.event.hold_success') {
    setSagaStep(3, true);
    setSagaStep(4, true);
    fetchWalletBalance();
  } else if (eventType === 'payment.event.hold_failed') {
    setSagaStep(3, false, 'FAILED');
    addLogEntry({
      type: 'SAGA_COMPENSATION',
      service: 'trip-service',
      message: `[SAGA COMPENSATE] Payment hold failed (${data.payload?.reason || 'INSUFFICIENT_FUNDS'}). Kích hoạt bù trừ: Giải phóng tài xế về AVAILABLE.`,
      correlation_id: data.correlation_id,
    });
    DRIVER.status = 'AVAILABLE';
    updateDriverUi();
    fetchWalletBalance();
  } else if (eventType === 'trip.event.completed') {
    fetchWalletBalance();
  }
}

function setSagaStep(stepNum, isSuccess, label = null) {
  const el = document.getElementById(`step-${stepNum}`);
  if (!el) return;
  if (isSuccess) {
    el.className = 'step-active';
  } else {
    el.className = 'step-failed';
    if (label) el.textContent += ` (${label})`;
  }
}

function addLogEntry(data) {
  const container = document.getElementById('logs-container');
  const corrId = data.correlation_id || '';
  const service = (data.service || data.source_service || 'gateway').toLowerCase();
  const time = new Date().toLocaleTimeString('vi-VN');

  const div = document.createElement('div');
  div.className = `log-entry log-${service}`;
  div.dataset.corr = corrId;
  div.dataset.service = service;

  let content = data.message;
  if (!content && data.event_type) {
    content = `Event: ${data.event_type}`;
  } else if (!content && data.path) {
    content = `${data.method} ${data.path} -> ${data.statusCode}`;
  }

  div.innerHTML = `
    <div class="flex items-center justify-between text-[10px] text-slate-400">
      <span class="font-bold uppercase text-slate-300">[${service}]</span>
      <span>${time}</span>
    </div>
    <div class="text-slate-200 mt-0.5 break-words">${content || JSON.stringify(data)}</div>
    ${corrId ? `<div class="text-[9px] text-slate-500 mt-1 truncate" title="${corrId}">corr: ${corrId}</div>` : ''}
  `;

  container.prepend(div);
  // Keep max 100 entries
  while (container.children.length > 100) {
    container.removeChild(container.lastChild);
  }
}

// Wallet functions
async function fetchWalletBalance() {
  const passenger = PASSENGERS[currentPassengerKey];
  if (!passenger) return;

  try {
    const res = await fetch(`${API_BASE}/payments/wallet?user_id=${passenger.id}`);
    if (res.ok) {
      const json = await res.json();
      const balance = json.data?.balance ?? 0;
      const held = json.data?.held_balance ?? 0;
      document.getElementById('rider-balance').textContent = Number(balance).toLocaleString('vi-VN');
      document.getElementById('rider-held').textContent = Number(held).toLocaleString('vi-VN');
    } else {
      console.warn(`Payment Service responded with status ${res.status}`);
    }
  } catch (err) {
    console.warn('Could not fetch wallet balance (Payment Service unavailable):', err.message);
  }
}

async function topupWallet(amount) {
  const passenger = PASSENGERS[currentPassengerKey];
  const idempotencyKey = `topup_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  try {
    const res = await fetch(`${API_BASE}/payments/topup`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
        'X-User-Id': passenger.id,
      },
      body: JSON.stringify({
        user_id: passenger.id,
        amount,
      }),
    });

    if (res.ok) {
      const json = await res.json();
      addLogEntry({
        type: 'PAYMENT',
        service: 'payment',
        message: `Nạp thành công ${amount.toLocaleString('vi-VN')} đ cho ${passenger.name}`,
        correlation_id: json.meta?.correlation_id,
      });
      fetchWalletBalance();
    } else {
      const errJson = await res.json().catch(() => ({}));
      addLogEntry({
        type: 'PAYMENT_ERROR',
        service: 'payment',
        message: `Nạp tiền thất bại: ${errJson.error?.message || res.statusText}`,
      });
      alert(`Nạp tiền thất bại: ${errJson.error?.message || 'Lỗi kết nối Payment Service'}`);
    }
  } catch (err) {
    alert('Lỗi nạp tiền (Payment Service mất kết nối): ' + err.message);
  }
}

// Trip actions
async function createTrip(overridePassengerKey = null) {
  const pKey = overridePassengerKey || currentPassengerKey;
  const passenger = PASSENGERS[pKey];
  const pickup = pickupMarker.getLatLng();
  const dropoff = dropoffMarker.getLatLng();

  const tripCard = document.getElementById('trip-card');
  tripCard.classList.remove('hidden');
  document.getElementById('trip-status').textContent = 'REQUESTED';
  document.getElementById('trip-status').className = 'px-2 py-0.5 rounded font-bold uppercase text-[10px] bg-amber-500/20 text-amber-300 border border-amber-500/30';
  document.getElementById('step-1').className = 'step-active';
  document.getElementById('step-2').className = 'text-slate-500';
  document.getElementById('step-3').className = 'text-slate-500';
  document.getElementById('step-4').className = 'text-slate-500';

  const correlationId = `corr_trip_${Date.now()}`;

  try {
    const res = await fetch(`${API_BASE}/trips`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Correlation-ID': correlationId,
        'X-User-Id': passenger.id,
      },
      body: JSON.stringify({
        passenger_id: passenger.id,
        pickup_latitude: pickup.lat,
        pickup_longitude: pickup.lng,
        pickup_address: document.getElementById('pickup-address').value,
        dropoff_latitude: dropoff.lat,
        dropoff_longitude: dropoff.lng,
        dropoff_address: document.getElementById('dropoff-address').value,
      }),
    });

    const json = await res.json().catch(() => ({}));
    if (res.ok && json.data) {
      activeTrip = json.data;
      document.getElementById('trip-id').textContent = activeTrip.id ? activeTrip.id.substring(0, 8) + '...' : 'pending';
      document.getElementById('trip-fare').textContent = Number(activeTrip.estimated_fare || activeTrip.fare || 45000).toLocaleString('vi-VN');

      addLogEntry({
        type: 'TRIP_CREATED',
        service: 'trip-service',
        message: `Cuốc xe được khởi tạo thành công (${activeTrip.id || 'new'}), cước: ${Number(activeTrip.estimated_fare || 45000).toLocaleString('vi-VN')} đ`,
        correlation_id: correlationId,
      });

      // Show driver incoming request
      document.getElementById('driver-actions-card').classList.remove('hidden');
    } else {
      // Clear indication of failure instead of fabricated success
      const errorMsg = json.error?.message || (res.status === 502 ? 'Trip Service (:8003) chưa khởi động hoặc mất kết nối' : `HTTP ${res.status}`);
      document.getElementById('trip-status').textContent = 'FAILED';
      document.getElementById('trip-status').className = 'px-2 py-0.5 rounded font-bold uppercase text-[10px] bg-rose-500/20 text-rose-300 border border-rose-500/30';
      setSagaStep(1, false, 'FAILED');

      addLogEntry({
        type: 'TRIP_ERROR',
        service: 'gateway',
        message: `⚠️ Lỗi tạo cuốc: ${errorMsg}`,
        correlation_id: correlationId,
      });
    }
  } catch (err) {
    document.getElementById('trip-status').textContent = 'GATEWAY_ERROR';
    document.getElementById('trip-status').className = 'px-2 py-0.5 rounded font-bold uppercase text-[10px] bg-rose-500/20 text-rose-300 border border-rose-500/30';
    setSagaStep(1, false, 'ERROR');

    addLogEntry({
      type: 'GATEWAY_ERROR',
      service: 'gateway',
      message: `Không thể kết nối API Gateway: ${err.message}`,
      correlation_id: correlationId,
    });
  }
}

// Driver actions
async function updateDriverLocation(lat, lon) {
  try {
    const res = await fetch(`${API_BASE}/drivers/location`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Driver-Id': DRIVER.id,
      },
      body: JSON.stringify({ latitude: lat, longitude: lon }),
    });
    if (!res.ok) {
      console.warn(`Driver Service responded with status ${res.status}`);
    }
  } catch (err) {
    console.warn('Driver Service unavailable:', err.message);
  }
}

function updateDriverUi() {
  const badge = document.getElementById('driver-status-badge');
  const btn = document.getElementById('btn-toggle-driver');
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

// Setup Event Listeners
document.addEventListener('DOMContentLoaded', () => {
  initMap();
  connectSSE();
  fetchWalletBalance();
  checkServicesHealth();
  setInterval(checkServicesHealth, 5000);

  document.getElementById('rider-select').addEventListener('change', (e) => {
    currentPassengerKey = e.target.value;
    fetchWalletBalance();
  });

  document.getElementById('btn-topup').addEventListener('click', () => {
    topupWallet(100000);
  });

  document.getElementById('btn-book-trip').addEventListener('click', () => {
    createTrip();
  });

  // Concurrency Demo: Book 2 concurrent requests
  document.getElementById('btn-demo-concurrency').addEventListener('click', async () => {
    addLogEntry({
      type: 'DEMO_CONCURRENCY',
      service: 'gateway',
      message: '⚡ [DEMO CT-01] Bắt đầu bắn 2 requests đồng thời từ Khách 1 & Khách 2 tới cùng toạ độ tài xế!',
    });
    await Promise.all([
      createTrip('passenger-1'),
      createTrip('passenger-2'),
    ]);
  });

  // Saga Compensation Demo: Book with 0 balance
  document.getElementById('btn-demo-saga').addEventListener('click', () => {
    document.getElementById('rider-select').value = 'passenger-zero';
    currentPassengerKey = 'passenger-zero';
    fetchWalletBalance();
    addLogEntry({
      type: 'DEMO_SAGA',
      service: 'gateway',
      message: '💥 [DEMO FR-02] Đặt xe với tài khoản số dư = 0 đ để kích hoạt Saga Bù Trừ!',
    });
    createTrip('passenger-zero');
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
      const res = await fetch(`${API_BASE}/drivers/status`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Driver-Id': DRIVER.id,
        },
        body: JSON.stringify({ status: nextStatus }),
      });
      if (res.ok) {
        DRIVER.status = nextStatus;
        updateDriverUi();
      } else {
        addLogEntry({
          type: 'DRIVER_ERROR',
          service: 'driver',
          message: `Không thể đổi trạng thái tài xế (HTTP ${res.status})`,
        });
        // Still toggle locally for simulation demonstration if driver service is offline
        DRIVER.status = nextStatus;
        updateDriverUi();
      }
    } catch (_) {
      DRIVER.status = nextStatus;
      updateDriverUi();
    }
  });

  document.getElementById('btn-clear-logs').addEventListener('click', () => {
    document.getElementById('logs-container').innerHTML = '';
  });

  document.getElementById('log-filter').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    const entries = document.querySelectorAll('.log-entry');
    entries.forEach((el) => {
      const match = el.textContent.toLowerCase().includes(q);
      el.style.display = match ? 'block' : 'none';
    });
  });

  // Driver accept button
  document.getElementById('btn-driver-accept').addEventListener('click', () => {
    document.getElementById('trip-status').textContent = 'ACCEPTED';
    document.getElementById('btn-driver-accept').classList.add('hidden');
    document.getElementById('btn-driver-start').classList.remove('hidden');
  });

  // Driver start button
  document.getElementById('btn-driver-start').addEventListener('click', () => {
    document.getElementById('trip-status').textContent = 'IN_PROGRESS';
    document.getElementById('btn-driver-start').classList.add('hidden');
    document.getElementById('btn-driver-complete').classList.remove('hidden');
  });

  // Driver complete button
  document.getElementById('btn-driver-complete').addEventListener('click', async () => {
    document.getElementById('trip-status').textContent = 'COMPLETED';
    document.getElementById('trip-status').className = 'px-2 py-0.5 rounded font-bold uppercase text-[10px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/30';
    document.getElementById('driver-actions-card').classList.add('hidden');
    document.getElementById('btn-driver-complete').classList.add('hidden');
    document.getElementById('btn-driver-accept').classList.remove('hidden');

    addLogEntry({
      type: 'TRIP_COMPLETED',
      service: 'trip-service',
      message: 'Cuốc xe hoàn tất! Kích hoạt trừ tiền cước chính thức (Payment Capture).',
    });
    fetchWalletBalance();
  });
});
