// DS03 Ride-Hailing Web Application Bundle
'use strict';

const API_BASE = window.DS03_API_BASE || `${window.location.protocol}//${window.location.hostname}:8080/api/v1`;

// Application State
const state = {
  token: localStorage.getItem('ds03_token') || null,
  user: null,
  currentView: 'landing',
  activeTrip: null,
  driverStatus: 'AVAILABLE',
  driverCoords: { lat: 21.0285, lon: 105.8544 },
  pickupCoords: { lat: 21.0285, lon: 105.8544, address: 'Hồ Hoàn Kiếm, Hoàn Kiếm, Hà Nội' },
  dropoffCoords: { lat: 21.0173, lon: 105.7839, address: 'Landmark 72, Nam Từ Liêm, Hà Nội' },
  mapPickMode: null, // 'pickup' | 'dropoff' | null
  notifications: [],
  readNotifIds: new Set(),
  sseSource: null,
  pollingInterval: null,
};

// Maps & Markers
let passengerMap = null;
let passengerPickupMarker = null;
let passengerDropoffMarker = null;
let passengerDriverMarker = null;
let passengerRouteLine = null;

let driverMap = null;
let driverSelfMarker = null;
let driverTripPickupMarker = null;
let driverRouteLine = null;

// Helper: Haversine distance in km
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c * 10) / 10;
}

// Helper: Dynamic Fare estimation
function estimateFare(distanceKm, surge = 1.0) {
  const baseFare = 12000;
  const perKmRate = 10000;
  const rawFare = (baseFare + distanceKm * perKmRate) * surge;
  return Math.round(rawFare / 1000) * 1000;
}

// Toast notification helper
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast-item toast-${type}`;
  toast.innerHTML = `<span>${message}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 200);
  }, 4000);
}

// Log line into diagnostics drawer
function logDiagnostic(scope, message, correlationId = '') {
  const container = document.getElementById('logs-container');
  if (!container) return;

  const entry = document.createElement('div');
  entry.className = `log-entry log-${scope}`;
  entry.dataset.corr = correlationId;

  const timeStr = new Date().toLocaleTimeString('vi-VN');
  entry.innerHTML = `
    <div class="flex items-center justify-between text-[10px] text-slate-400">
      <span class="font-bold uppercase text-slate-300">[${scope}]</span>
      <span>${timeStr}</span>
    </div>
    <div class="text-slate-200 mt-0.5 break-words">${message}</div>
    ${correlationId ? `<div class="text-[9px] text-slate-500 mt-0.5 font-mono truncate">corr: ${correlationId}</div>` : ''}
  `;

  container.prepend(entry);
  while (container.children.length > 80) {
    container.removeChild(container.lastChild);
  }
}

// Authenticated API request wrapper
async function apiRequest(path, { method = 'GET', body = null, token = state.token, headers = {} } = {}) {
  const reqHeaders = { 'Content-Type': 'application/json', ...headers };
  if (token) reqHeaders.Authorization = `Bearer ${token}`;

  const url = `${API_BASE}${path}`;
  const options = {
    method,
    headers: reqHeaders,
    body: body !== null ? JSON.stringify(body) : undefined,
  };

  try {
    const res = await fetch(url, options);
    const corrId = res.headers.get('X-Correlation-ID') || '';
    const json = await res.json().catch(() => ({}));

    logDiagnostic(
      path.split('/')[1] || 'gateway',
      `${method} ${path} -> HTTP ${res.status}`,
      corrId
    );

    return { ok: res.ok, status: res.status, data: json.data || json, error: json.error, corrId };
  } catch (err) {
    logDiagnostic('network', `Lỗi kết nối ${method} ${path}: ${err.message}`);
    return { ok: false, status: 0, error: { message: `Không thể kết nối đến máy chủ (${err.message})` } };
  }
}

// View Navigation & Router
function navigateTo(viewName, pushHistory = true) {
  state.currentView = viewName;

  const views = [
    'view-landing',
    'view-auth-passenger',
    'view-auth-driver',
    'view-passenger-dashboard',
    'view-driver-dashboard',
  ];

  views.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
  });

  const activeEl = document.getElementById(`view-${viewName}`);
  if (activeEl) activeEl.classList.remove('hidden');

  // Update browser URL
  const pathMap = {
    landing: '/',
    'auth-passenger': '/login/passenger',
    'auth-driver': '/login/driver',
    'passenger-dashboard': '/passenger',
    'driver-dashboard': '/driver',
  };

  if (pushHistory && pathMap[viewName]) {
    window.history.pushState({ view: viewName }, '', pathMap[viewName]);
  }

  // View specific activations
  if (viewName === 'passenger-dashboard') {
    setTimeout(initPassengerMap, 100);
    fetchWalletBalance();
    updateFarePreview();
  } else if (viewName === 'driver-dashboard') {
    setTimeout(initDriverMap, 100);
    fetchDriverProfile();
  }

  updateSessionUI();
}

// Update Top Navigation Session Status
function updateSessionUI() {
  const loggedInContainer = document.getElementById('session-logged-in');
  const guestContainer = document.getElementById('session-guest');
  const nameEl = document.getElementById('session-user-name');
  const roleEl = document.getElementById('session-user-role');

  if (state.user && state.token) {
    loggedInContainer?.classList.remove('hidden');
    guestContainer?.classList.add('hidden');
    if (nameEl) nameEl.textContent = state.user.name || state.user.email;
    if (roleEl) {
      roleEl.textContent = state.user.role === 'DRIVER' ? 'Tài Xế' : 'Hành Khách';
      roleEl.className = state.user.role === 'DRIVER'
        ? 'text-[10px] font-mono text-blue-400 uppercase font-bold'
        : 'text-[10px] font-mono text-emerald-400 uppercase font-bold';
    }
  } else {
    loggedInContainer?.classList.add('hidden');
    guestContainer?.classList.remove('hidden');
  }
}

// Notification Center Logic
function loadReadNotifs() {
  if (!state.user) return;
  try {
    const raw = localStorage.getItem(`ds03_read_notifs_${state.user.id}`);
    state.readNotifIds = new Set(raw ? JSON.parse(raw) : []);
  } catch (_) {
    state.readNotifIds = new Set();
  }
}

function saveReadNotifs() {
  if (!state.user) return;
  localStorage.setItem(
    `ds03_read_notifs_${state.user.id}`,
    JSON.stringify(Array.from(state.readNotifIds))
  );
}

function renderNotifications() {
  const listEl = document.getElementById('notification-list');
  const badgeEl = document.getElementById('notif-bell-badge');
  const countTextEl = document.getElementById('notif-count-text');
  if (!listEl) return;

  const unreadCount = state.notifications.filter((n) => !state.readNotifIds.has(n.id || n.timestamp)).length;

  if (badgeEl) {
    if (unreadCount > 0) {
      badgeEl.textContent = unreadCount > 9 ? '9+' : unreadCount;
      badgeEl.classList.remove('hidden');
    } else {
      badgeEl.classList.add('hidden');
    }
  }

  if (countTextEl) {
    countTextEl.textContent = `(${unreadCount} chưa đọc)`;
  }

  if (state.notifications.length === 0) {
    listEl.innerHTML = '<div class="p-6 text-center text-xs text-slate-500">Chưa có thông báo nào</div>';
    return;
  }

  listEl.innerHTML = '';
  state.notifications.forEach((item) => {
    const id = item.id || item.timestamp;
    const isUnread = !state.readNotifIds.has(id);

    const el = document.createElement('div');
    el.className = `p-3 text-xs transition cursor-pointer hover:bg-slate-800/60 ${isUnread ? 'bg-blue-950/20' : ''}`;
    el.innerHTML = `
      <div class="flex items-center justify-between mb-1">
        <span class="font-semibold text-slate-200 flex items-center gap-1.5">
          ${isUnread ? '<span class="w-1.5 h-1.5 rounded-full bg-blue-500"></span>' : ''}
          ${item.title || 'Thông báo từ hệ thống'}
        </span>
        <span class="text-[10px] font-mono text-slate-400">
          ${item.created_at ? new Date(item.created_at).toLocaleTimeString('vi-VN') : ''}
        </span>
      </div>
      <p class="text-slate-300 text-[11px] leading-relaxed">${item.message || ''}</p>
    `;

    el.onclick = () => {
      state.readNotifIds.add(id);
      saveReadNotifs();
      renderNotifications();
    };

    listEl.appendChild(el);
  });
}

async function fetchNotifications() {
  if (!state.token) return;
  const res = await apiRequest('/notifications?limit=20');
  if (res.ok && Array.isArray(res.data)) {
    state.notifications = res.data;
    renderNotifications();
  }
}

// SSE Connection for Real-Time Simulation Stream
function connectSSE() {
  if (!state.token) return;
  if (state.sseSource) {
    state.sseSource.close();
    state.sseSource = null;
  }

  const sseUrl = `${API_BASE}/simulation/stream?token=${encodeURIComponent(state.token)}`;
  const sse = new EventSource(sseUrl);
  state.sseSource = sse;

  const sseIndicator = document.getElementById('sse-indicator');

  sse.onopen = () => {
    if (sseIndicator) sseIndicator.className = 'w-2 h-2 rounded-full bg-emerald-500';
    logDiagnostic('sse', 'Đã kết nối luồng sự kiện phân tán (SSE Connected)');
  };

  sse.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleIncomingSSEEvent(data);
    } catch (_) {}
  };

  sse.onerror = () => {
    if (sseIndicator) sseIndicator.className = 'w-2 h-2 rounded-full bg-red-500';
  };
}

function handleIncomingSSEEvent(data) {
  // Add to diagnostics stream
  const scope = (data.service || data.source_service || 'event').toLowerCase();
  const msg = data.message || data.event_type || JSON.stringify(data);
  logDiagnostic(scope, msg, data.correlation_id);

  // If this is a notification for user
  if (data.type === 'NOTIFICATION' || data.title) {
    const notifItem = {
      id: data.id || `notif_${Date.now()}_${Math.random()}`,
      title: data.title || 'Cập nhật chuyến đi',
      message: data.message || '',
      created_at: data.timestamp || new Date().toISOString(),
    };
    // Prepend and render
    state.notifications.unshift(notifItem);
    renderNotifications();
    showToast(`${notifItem.title}: ${notifItem.message}`, 'info');
  }

  // If trip event matches active trip
  if (data.trip_id && state.activeTrip && state.activeTrip.id === data.trip_id) {
    if (data.status) {
      updateActiveTripStatus(data.status);
    }
  }

  // If wallet event occurred
  if (data.type === 'WALLET_UPDATE' || data.event_type === 'payment.event.held') {
    fetchWalletBalance();
  }
}

// Interactive Map Implementation (Leaflet Hanoi)
function initPassengerMap() {
  const mapContainer = document.getElementById('passenger-map');
  if (!mapContainer || passengerMap) {
    if (passengerMap) passengerMap.invalidateSize();
    return;
  }

  passengerMap = L.map('passenger-map').setView([21.0285, 105.8544], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 18,
  }).addTo(passengerMap);

  // Click on map to pick location
  passengerMap.on('click', (e) => {
    const { lat, lng } = e.latlng;
    const roundedLat = Math.round(lat * 10000) / 10000;
    const roundedLng = Math.round(lng * 10000) / 10000;

    if (state.mapPickMode === 'pickup') {
      setPickupCoordinates(roundedLat, roundedLng, `Toạ độ (${roundedLat}, ${roundedLng})`);
      state.mapPickMode = null;
      document.body.style.cursor = 'default';
      showToast(`Đã chọn điểm đón tại (${roundedLat}, ${roundedLng})`, 'success');
    } else if (state.mapPickMode === 'dropoff') {
      setDropoffCoordinates(roundedLat, roundedLng, `Toạ độ (${roundedLat}, ${roundedLng})`);
      state.mapPickMode = null;
      document.body.style.cursor = 'default';
      showToast(`Đã chọn điểm đến tại (${roundedLat}, ${roundedLng})`, 'success');
    }
  });

  renderPassengerMapMarkers();
}

function renderPassengerMapMarkers() {
  if (!passengerMap) return;

  // Pickup marker
  if (!passengerPickupMarker) {
    const pickupIcon = L.divIcon({
      className: 'custom-marker-pin marker-pickup',
      html: '<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="10" r="3"/><path d="M12 2a8 8 0 0 0-8 8c0 5.25 8 12 8 12s8-6.75 8-12a8 8 0 0 0-8-8z"/></svg>',
      iconSize: [28, 28],
      iconAnchor: [14, 28],
    });
    passengerPickupMarker = L.marker([state.pickupCoords.lat, state.pickupCoords.lon], { icon: pickupIcon })
      .addTo(passengerMap)
      .bindPopup('<b>Điểm đón</b><br>' + state.pickupCoords.address);
  } else {
    passengerPickupMarker.setLatLng([state.pickupCoords.lat, state.pickupCoords.lon]);
    passengerPickupMarker.setPopupContent('<b>Điểm đón</b><br>' + state.pickupCoords.address);
  }

  // Dropoff marker
  if (!passengerDropoffMarker) {
    const dropoffIcon = L.divIcon({
      className: 'custom-marker-pin marker-dropoff',
      html: '<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/></svg>',
      iconSize: [28, 28],
      iconAnchor: [14, 14],
    });
    passengerDropoffMarker = L.marker([state.dropoffCoords.lat, state.dropoffCoords.lon], { icon: dropoffIcon })
      .addTo(passengerMap)
      .bindPopup('<b>Điểm đến</b><br>' + state.dropoffCoords.address);
  } else {
    passengerDropoffMarker.setLatLng([state.dropoffCoords.lat, state.dropoffCoords.lon]);
    passengerDropoffMarker.setPopupContent('<b>Điểm đến</b><br>' + state.dropoffCoords.address);
  }

  // Route Polyline
  const latlngs = [
    [state.pickupCoords.lat, state.pickupCoords.lon],
    [state.dropoffCoords.lat, state.dropoffCoords.lon],
  ];

  if (!passengerRouteLine) {
    passengerRouteLine = L.polyline(latlngs, {
      color: '#3b82f6',
      weight: 4,
      opacity: 0.8,
      dashArray: '6, 8',
    }).addTo(passengerMap);
  } else {
    passengerRouteLine.setLatLngs(latlngs);
  }
}

function setPickupCoordinates(lat, lon, address = '') {
  state.pickupCoords.lat = lat;
  state.pickupCoords.lon = lon;
  if (address) state.pickupCoords.address = address;

  const latEl = document.getElementById('text-pickup-lat');
  const lonEl = document.getElementById('text-pickup-lon');
  const addrEl = document.getElementById('input-pickup-address');

  if (latEl) latEl.textContent = lat;
  if (lonEl) lonEl.textContent = lon;
  if (addrEl && address) addrEl.value = address;

  renderPassengerMapMarkers();
  updateFarePreview();
}

function setDropoffCoordinates(lat, lon, address = '') {
  state.dropoffCoords.lat = lat;
  state.dropoffCoords.lon = lon;
  if (address) state.dropoffCoords.address = address;

  const latEl = document.getElementById('text-dropoff-lat');
  const lonEl = document.getElementById('text-dropoff-lon');
  const addrEl = document.getElementById('input-dropoff-address');

  if (latEl) latEl.textContent = lat;
  if (lonEl) lonEl.textContent = lon;
  if (addrEl && address) addrEl.value = address;

  renderPassengerMapMarkers();
  updateFarePreview();
}

function updateFarePreview() {
  const dist = calculateDistance(
    state.pickupCoords.lat,
    state.pickupCoords.lon,
    state.dropoffCoords.lat,
    state.dropoffCoords.lon
  );
  const fare = estimateFare(dist);

  const distEl = document.getElementById('fare-distance-km');
  const fareEl = document.getElementById('fare-estimated-amount');

  if (distEl) distEl.textContent = `${dist} km`;
  if (fareEl) fareEl.textContent = fare.toLocaleString('vi-VN');
}

// Driver Map Implementation
function initDriverMap() {
  const mapContainer = document.getElementById('driver-map');
  if (!mapContainer || driverMap) {
    if (driverMap) driverMap.invalidateSize();
    return;
  }

  driverMap = L.map('driver-map').setView([state.driverCoords.lat, state.driverCoords.lon], 14);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 18,
  }).addTo(driverMap);

  const carIcon = L.divIcon({
    className: 'custom-marker-pin marker-driver',
    html: '<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>',
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });

  driverSelfMarker = L.marker([state.driverCoords.lat, state.driverCoords.lon], { icon: carIcon })
    .addTo(driverMap)
    .bindPopup('<b>Vị trí của bạn</b><br>Đang trực tuyến');
}

// Passenger Booking Flow
async function handleCreateTrip() {
  const btn = document.getElementById('btn-create-trip');
  if (btn) btn.disabled = true;

  const payload = {
    pickup_latitude: state.pickupCoords.lat,
    pickup_longitude: state.pickupCoords.lon,
    pickup_address: document.getElementById('input-pickup-address')?.value || state.pickupCoords.address,
    dropoff_latitude: state.dropoffCoords.lat,
    dropoff_longitude: state.dropoffCoords.lon,
    dropoff_address: document.getElementById('input-dropoff-address')?.value || state.dropoffCoords.address,
  };

  const idempotencyKey = `idemp_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  const res = await apiRequest('/trips', {
    method: 'POST',
    body: payload,
    headers: { 'Idempotency-Key': idempotencyKey },
  });

  if (btn) btn.disabled = false;

  if (res.ok && res.data?.id) {
    state.activeTrip = res.data;
    showToast('Đã gửi yêu cầu đặt xe thành công!', 'success');
    showActiveTripUI(res.data);
    startTripPolling(res.data.id);
  } else {
    const errorMsg = res.error?.message || 'Không thể tạo cuốc xe, vui lòng kiểm tra số dư ví.';
    showToast(errorMsg, 'error');
  }
}

function showActiveTripUI(trip) {
  const bookingSection = document.getElementById('passenger-booking-section');
  const activeSection = document.getElementById('passenger-active-trip-section');
  const idEl = document.getElementById('active-trip-id');
  const fareEl = document.getElementById('active-trip-fare');

  bookingSection?.classList.add('hidden');
  activeSection?.classList.remove('hidden');

  if (idEl) idEl.textContent = trip.id;
  if (fareEl) fareEl.textContent = `${Number(trip.estimated_fare || trip.fare || 0).toLocaleString('vi-VN')} đ`;

  updateActiveTripStatus(trip.status || 'REQUESTED');
}

function updateActiveTripStatus(status) {
  const badgeEl = document.getElementById('active-trip-status-badge');
  const driverEl = document.getElementById('active-trip-driver');
  if (badgeEl) badgeEl.textContent = status;

  // Stepper elements
  const stepRequested = document.getElementById('step-requested');
  const stepMatching = document.getElementById('step-matching');
  const stepPayment = document.getElementById('step-payment');
  const stepTrip = document.getElementById('step-trip');

  [stepRequested, stepMatching, stepPayment, stepTrip].forEach((el) => {
    el?.classList.remove('step-active', 'step-failed');
  });

  if (status === 'REQUESTED') {
    stepRequested?.classList.add('step-active');
  } else if (status === 'DRIVER_ASSIGNED') {
    stepRequested?.classList.add('step-active');
    stepMatching?.classList.add('step-active');
    if (driverEl) driverEl.textContent = 'Đã ghép tài xế!';
  } else if (status === 'CONFIRMED') {
    stepRequested?.classList.add('step-active');
    stepMatching?.classList.add('step-active');
    stepPayment?.classList.add('step-active');
    if (driverEl) driverEl.textContent = 'Tài xế đang di chuyển đến bạn';
  } else if (status === 'ACCEPTED' || status === 'IN_PROGRESS') {
    stepRequested?.classList.add('step-active');
    stepMatching?.classList.add('step-active');
    stepPayment?.classList.add('step-active');
    stepTrip?.classList.add('step-active');
    if (driverEl) driverEl.textContent = 'Đang thực hiện chuyến đi';
  } else if (status === 'COMPLETED') {
    [stepRequested, stepMatching, stepPayment, stepTrip].forEach((el) => el?.classList.add('step-active'));
    showToast('Chuyến đi đã hoàn tất! Cảm ơn bạn.', 'success');
    stopTripPolling();
    fetchWalletBalance();
    setTimeout(() => {
      document.getElementById('passenger-active-trip-section')?.classList.add('hidden');
      document.getElementById('passenger-booking-section')?.classList.remove('hidden');
      state.activeTrip = null;
    }, 4000);
  } else if (status === 'CANCELLED') {
    badgeEl?.classList.add('bg-red-500/10', 'text-red-400', 'border-red-500/20');
    stepPayment?.classList.add('step-failed');
    showToast('Chuyến đi đã bị hủy và hoàn trả tiền ví.', 'info');
    stopTripPolling();
    fetchWalletBalance();
    setTimeout(() => {
      document.getElementById('passenger-active-trip-section')?.classList.add('hidden');
      document.getElementById('passenger-booking-section')?.classList.remove('hidden');
      state.activeTrip = null;
    }, 3000);
  }
}

function startTripPolling(tripId) {
  stopTripPolling();
  state.pollingInterval = setInterval(async () => {
    const res = await apiRequest(`/trips/${tripId}`);
    if (res.ok && res.data) {
      updateActiveTripStatus(res.data.status);
    }
  }, 2000);
}

function stopTripPolling() {
  if (state.pollingInterval) {
    clearInterval(state.pollingInterval);
    state.pollingInterval = null;
  }
}

async function handleCancelTrip() {
  if (!state.activeTrip) return;
  const res = await apiRequest(`/trips/${state.activeTrip.id}/cancel`, {
    method: 'POST',
    body: { reason: 'PASSENGER_CANCELLED' },
  });

  document.getElementById('cancel-confirm-modal')?.classList.add('hidden');

  if (res.ok) {
    updateActiveTripStatus('CANCELLED');
  } else {
    showToast(res.error?.message || 'Không thể hủy chuyến', 'error');
  }
}

// Wallet Operations
async function fetchWalletBalance() {
  if (!state.token) return;
  const res = await apiRequest('/payments');
  if (res.ok && res.data) {
    const balance = Number(res.data.balance || 0);
    const held = Number(res.data.held_balance || 0);

    const balEl = document.getElementById('passenger-wallet-balance');
    const heldEl = document.getElementById('passenger-wallet-held');

    if (balEl) balEl.textContent = balance.toLocaleString('vi-VN');
    if (heldEl) heldEl.textContent = held.toLocaleString('vi-VN');
  }
}

async function handleTopup(amount) {
  const res = await apiRequest('/payments/topup', {
    method: 'POST',
    body: { amount: Number(amount) },
  });

  if (res.ok) {
    showToast(`Đã nạp ${Number(amount).toLocaleString('vi-VN')} đ vào ví!`, 'success');
    document.getElementById('topup-modal')?.classList.add('hidden');
    fetchWalletBalance();
  } else {
    showToast(res.error?.message || 'Nạp ví thất bại', 'error');
  }
}

// Driver Operations
async function fetchDriverProfile() {
  if (!state.token) return;
  const res = await apiRequest('/drivers/me');
  if (res.ok && res.data) {
    const d = res.data;
    state.driverStatus = d.status || 'AVAILABLE';

    const nameEl = document.getElementById('driver-profile-name');
    const vehicleEl = document.getElementById('driver-profile-vehicle');
    const statusTextEl = document.getElementById('driver-status-text');
    const toggleBtn = document.getElementById('btn-toggle-driver-status');

    if (nameEl) nameEl.textContent = d.name || state.user?.name || 'Tài xế đối tác';
    if (vehicleEl) vehicleEl.textContent = `${d.vehicle_plate || '29A-888.88'} • ${d.vehicle_model || 'Toyota Vios'}`;

    if (statusTextEl && toggleBtn) {
      if (state.driverStatus === 'AVAILABLE') {
        statusTextEl.textContent = 'AVAILABLE';
        statusTextEl.className = 'text-[11px] font-mono font-bold text-emerald-400';
        toggleBtn.textContent = 'Đang Sẵn Sàng (Bấm để Nghỉ)';
        toggleBtn.className = 'flex-1 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold py-2 rounded-lg transition active:scale-[0.98]';
      } else {
        statusTextEl.textContent = 'OFFLINE';
        statusTextEl.className = 'text-[11px] font-mono font-bold text-slate-400';
        toggleBtn.textContent = 'Đang Nghỉ (Bấm để Sẵn Sàng)';
        toggleBtn.className = 'flex-1 bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs font-semibold py-2 rounded-lg transition active:scale-[0.98]';
      }
    }
  }
}

async function handleToggleDriverStatus() {
  const newStatus = state.driverStatus === 'AVAILABLE' ? 'OFFLINE' : 'AVAILABLE';
  const res = await apiRequest('/drivers/status', {
    method: 'PUT',
    body: { status: newStatus },
  });

  if (res.ok) {
    state.driverStatus = newStatus;
    fetchDriverProfile();
    showToast(`Đã chuyển trạng thái làm việc sang ${newStatus}`, 'info');
  } else {
    showToast(res.error?.message || 'Không thể cập nhật trạng thái', 'error');
  }
}

async function handleUpdateDriverGPS() {
  const res = await apiRequest('/drivers/location', {
    method: 'PUT',
    body: { latitude: state.driverCoords.lat, longitude: state.driverCoords.lon },
  });

  if (res.ok) {
    showToast('Đã cập nhật toạ độ GPS tài xế thành công!', 'success');
  } else {
    showToast(res.error?.message || 'Cập nhật toạ độ thất bại', 'error');
  }
}

// Authentication Forms Handlers
async function handlePassengerLogin(e) {
  e.preventDefault();
  const email = document.getElementById('passenger-login-email')?.value.trim();
  const password = document.getElementById('passenger-login-password')?.value;
  const errorEl = document.getElementById('passenger-auth-error');
  const btn = document.getElementById('btn-submit-passenger-login');

  if (errorEl) errorEl.classList.add('hidden');
  if (btn) btn.disabled = true;

  const res = await apiRequest('/auth/login', {
    method: 'POST',
    body: { email, password },
  });

  if (btn) btn.disabled = false;

  if (res.ok && res.data?.token) {
    state.token = res.data.token;
    state.user = res.data.user;
    localStorage.setItem('ds03_token', state.token);
    localStorage.setItem('ds03_user', JSON.stringify(state.user));

    loadReadNotifs();
    connectSSE();
    fetchNotifications();
    showToast(`Chào mừng bạn trở lại, ${state.user.name || state.user.email}!`, 'success');
    navigateTo('passenger-dashboard');
  } else {
    const errorMsg = res.error?.message || 'Email hoặc mật khẩu không chính xác.';
    if (errorEl) {
      errorEl.textContent = errorMsg;
      errorEl.classList.remove('hidden');
    }
  }
}

async function handlePassengerRegister(e) {
  e.preventDefault();
  const name = document.getElementById('passenger-register-name')?.value.trim();
  const phone = document.getElementById('passenger-register-phone')?.value.trim();
  const email = document.getElementById('passenger-register-email')?.value.trim();
  const password = document.getElementById('passenger-register-password')?.value;
  const errorEl = document.getElementById('passenger-auth-error');
  const successEl = document.getElementById('passenger-auth-success');
  const btn = document.getElementById('btn-submit-passenger-register');

  if (errorEl) errorEl.classList.add('hidden');
  if (successEl) successEl.classList.add('hidden');
  if (btn) btn.disabled = true;

  const res = await apiRequest('/auth/register', {
    method: 'POST',
    body: { name, phone, email, password, role: 'PASSENGER' },
  });

  if (btn) btn.disabled = false;

  if (res.ok) {
    if (successEl) {
      successEl.textContent = 'Đăng ký tài khoản thành công! Vui lòng đăng nhập.';
      successEl.classList.remove('hidden');
    }
    // Switch to login tab and pre-fill
    document.getElementById('tab-passenger-login')?.click();
    const loginEmail = document.getElementById('passenger-login-email');
    if (loginEmail) loginEmail.value = email;
  } else {
    const errorMsg = res.error?.message || 'Đăng ký không thành công. Vui lòng kiểm tra lại thông tin.';
    if (errorEl) {
      errorEl.textContent = errorMsg;
      errorEl.classList.remove('hidden');
    }
  }
}

async function handleDriverLogin(e) {
  e.preventDefault();
  const email = document.getElementById('driver-login-email')?.value.trim();
  const password = document.getElementById('driver-login-password')?.value;
  const errorEl = document.getElementById('driver-auth-error');
  const btn = document.getElementById('btn-submit-driver-login');

  if (errorEl) errorEl.classList.add('hidden');
  if (btn) btn.disabled = true;

  const res = await apiRequest('/auth/login', {
    method: 'POST',
    body: { email, password },
  });

  if (btn) btn.disabled = false;

  if (res.ok && res.data?.token) {
    const returnedUser = res.data.user;

    // Strict Role Guard: Reject PASSENGER accounts from entering Driver portal
    if (returnedUser.role !== 'DRIVER') {
      if (errorEl) {
        errorEl.textContent = 'Tài khoản này là Hành khách (PASSENGER). Vui lòng đăng nhập qua cổng Hành khách.';
        errorEl.classList.remove('hidden');
      }
      return;
    }

    state.token = res.data.token;
    state.user = returnedUser;
    localStorage.setItem('ds03_token', state.token);
    localStorage.setItem('ds03_user', JSON.stringify(state.user));

    loadReadNotifs();
    connectSSE();
    fetchNotifications();
    showToast(`Chào mừng tài xế ${state.user.name || state.user.email}!`, 'success');
    navigateTo('driver-dashboard');
  } else {
    const errorMsg = res.error?.message || 'Email hoặc mật khẩu không chính xác.';
    if (errorEl) {
      errorEl.textContent = errorMsg;
      errorEl.classList.remove('hidden');
    }
  }
}

async function handleDriverRegister(e) {
  e.preventDefault();
  const name = document.getElementById('driver-register-name')?.value.trim();
  const phone = document.getElementById('driver-register-phone')?.value.trim();
  const email = document.getElementById('driver-register-email')?.value.trim();
  const password = document.getElementById('driver-register-password')?.value;
  const errorEl = document.getElementById('driver-auth-error');
  const successEl = document.getElementById('driver-auth-success');
  const btn = document.getElementById('btn-submit-driver-register');

  if (errorEl) errorEl.classList.add('hidden');
  if (successEl) successEl.classList.add('hidden');
  if (btn) btn.disabled = true;

  const res = await apiRequest('/auth/register', {
    method: 'POST',
    body: { name, phone, email, password, role: 'DRIVER' },
  });

  if (btn) btn.disabled = false;

  if (res.ok) {
    if (successEl) {
      successEl.textContent = 'Đăng ký tài xế thành công! Vui lòng đăng nhập.';
      successEl.classList.remove('hidden');
    }
    document.getElementById('tab-driver-login')?.click();
    const loginEmail = document.getElementById('driver-login-email');
    if (loginEmail) loginEmail.value = email;
  } else {
    const errorMsg = res.error?.message || 'Đăng ký tài xế thất bại.';
    if (errorEl) {
      errorEl.textContent = errorMsg;
      errorEl.classList.remove('hidden');
    }
  }
}

function handleLogout() {
  if (state.token) {
    apiRequest('/auth/logout', { method: 'POST' });
  }

  state.token = null;
  state.user = null;
  localStorage.removeItem('ds03_token');
  localStorage.removeItem('ds03_user');

  if (state.sseSource) {
    state.sseSource.close();
    state.sseSource = null;
  }
  stopTripPolling();

  showToast('Đã đăng xuất khỏi hệ thống.', 'info');
  navigateTo('landing');
}

// Session Restore on initial load
async function restoreSession() {
  const savedToken = localStorage.getItem('ds03_token');
  if (!savedToken) {
    handleInitialRoute();
    return;
  }

  state.token = savedToken;
  const res = await apiRequest('/auth/me');
  if (res.ok && res.data) {
    state.user = res.data;
    localStorage.setItem('ds03_user', JSON.stringify(state.user));
    loadReadNotifs();
    connectSSE();
    fetchNotifications();
    handleInitialRoute();
  } else {
    // Token invalid or expired
    state.token = null;
    state.user = null;
    localStorage.removeItem('ds03_token');
    localStorage.removeItem('ds03_user');
    handleInitialRoute();
  }
}

function handleInitialRoute() {
  const pathname = window.location.pathname;

  if (pathname === '/login/passenger') {
    navigateTo('auth-passenger', false);
  } else if (pathname === '/login/driver') {
    navigateTo('auth-driver', false);
  } else if (pathname === '/passenger') {
    if (state.user && state.token) {
      if (state.user.role === 'DRIVER') {
        showToast('Bạn đang đăng nhập bằng tài khoản Tài xế', 'info');
        navigateTo('driver-dashboard', false);
      } else {
        navigateTo('passenger-dashboard', false);
      }
    } else {
      navigateTo('auth-passenger', false);
    }
  } else if (pathname === '/driver') {
    if (state.user && state.token) {
      if (state.user.role !== 'DRIVER') {
        showToast('Tài khoản này là Hành khách, không thể vào cổng Tài xế', 'error');
        navigateTo('passenger-dashboard', false);
      } else {
        navigateTo('driver-dashboard', false);
      }
    } else {
      navigateTo('auth-driver', false);
    }
  } else {
    navigateTo('landing', false);
  }
}

// Diagnostics Health Probes Poller
async function pollDiagnosticsHealth() {
  const checkService = async (url, indicatorId) => {
    const el = document.getElementById(indicatorId);
    if (!el) return;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      el.className = res.ok ? 'w-2 h-2 rounded-full bg-emerald-500' : 'w-2 h-2 rounded-full bg-red-500';
    } catch (_) {
      el.className = 'w-2 h-2 rounded-full bg-red-500';
    }
  };

  await Promise.allSettled([
    checkService('http://localhost:8080/health', 'gateway-indicator'),
    checkService('http://localhost:8005/health', 'payment-indicator'),
    checkService('http://localhost:8006/health', 'notification-indicator'),
  ]);
}

// Bind DOM Events
function bindEvents() {
  // Navigation Links
  document.getElementById('nav-brand')?.addEventListener('click', (e) => {
    e.preventDefault();
    navigateTo('landing');
  });
  document.getElementById('nav-link-landing')?.addEventListener('click', () => navigateTo('landing'));
  document.getElementById('nav-link-passenger')?.addEventListener('click', () => {
    if (state.user?.role === 'DRIVER') {
      showToast('Bạn đang đăng nhập bằng tài khoản Tài xế', 'info');
      navigateTo('driver-dashboard');
    } else if (state.user) {
      navigateTo('passenger-dashboard');
    } else {
      navigateTo('auth-passenger');
    }
  });
  document.getElementById('nav-link-driver')?.addEventListener('click', () => {
    if (state.user?.role === 'PASSENGER') {
      showToast('Tài khoản này là Hành khách, không có quyền vào cổng Tài xế', 'error');
      navigateTo('passenger-dashboard');
    } else if (state.user?.role === 'DRIVER') {
      navigateTo('driver-dashboard');
    } else {
      navigateTo('auth-driver');
    }
  });

  // Landing Page Buttons
  document.getElementById('btn-landing-passenger')?.addEventListener('click', () => {
    if (state.user?.role === 'DRIVER') {
      navigateTo('driver-dashboard');
    } else if (state.user) {
      navigateTo('passenger-dashboard');
    } else {
      navigateTo('auth-passenger');
    }
  });
  document.getElementById('btn-landing-driver')?.addEventListener('click', () => {
    if (state.user?.role === 'DRIVER') {
      navigateTo('driver-dashboard');
    } else {
      navigateTo('auth-driver');
    }
  });

  // Quick Demo Accounts Fill Buttons
  document.getElementById('btn-quick-passenger1')?.addEventListener('click', () => {
    navigateTo('auth-passenger');
    const email = document.getElementById('passenger-login-email');
    const pw = document.getElementById('passenger-login-password');
    if (email) email.value = 'passenger1@demo.ds03';
    if (pw) pw.value = 'Password123!';
  });
  document.getElementById('btn-quick-passenger2')?.addEventListener('click', () => {
    navigateTo('auth-passenger');
    const email = document.getElementById('passenger-login-email');
    const pw = document.getElementById('passenger-login-password');
    if (email) email.value = 'passenger2@demo.ds03';
    if (pw) pw.value = 'Password123!';
  });
  document.getElementById('btn-quick-passenger0')?.addEventListener('click', () => {
    navigateTo('auth-passenger');
    const email = document.getElementById('passenger-login-email');
    const pw = document.getElementById('passenger-login-password');
    if (email) email.value = 'passenger0@demo.ds03';
    if (pw) pw.value = 'Password123!';
  });
  document.getElementById('btn-quick-driver1')?.addEventListener('click', () => {
    navigateTo('auth-driver');
    const email = document.getElementById('driver-login-email');
    const pw = document.getElementById('driver-login-password');
    if (email) email.value = 'driver1@demo.ds03';
    if (pw) pw.value = 'Password123!';
  });

  // Header login buttons
  document.getElementById('btn-nav-login-passenger')?.addEventListener('click', () => navigateTo('auth-passenger'));
  document.getElementById('btn-logout')?.addEventListener('click', handleLogout);

  // Notification Bell & Popover
  document.getElementById('btn-notif-bell')?.addEventListener('click', () => {
    const popover = document.getElementById('notification-popover');
    popover?.classList.toggle('hidden');
  });
  document.getElementById('btn-mark-all-read')?.addEventListener('click', () => {
    state.notifications.forEach((n) => state.readNotifIds.add(n.id || n.timestamp));
    saveReadNotifs();
    renderNotifications();
    showToast('Đã đánh dấu tất cả thông báo là đã đọc', 'info');
  });

  // Diagnostics Drawer
  document.getElementById('btn-toggle-diagnostics')?.addEventListener('click', () => {
    document.getElementById('diagnostics-drawer')?.classList.toggle('hidden');
    pollDiagnosticsHealth();
  });
  document.getElementById('btn-close-diagnostics')?.addEventListener('click', () => {
    document.getElementById('diagnostics-drawer')?.classList.add('hidden');
  });
  document.getElementById('btn-clear-logs')?.addEventListener('click', () => {
    const container = document.getElementById('logs-container');
    if (container) container.innerHTML = '';
  });

  // Tab switching inside Passenger Auth
  document.getElementById('tab-passenger-login')?.addEventListener('click', () => {
    document.getElementById('form-passenger-login')?.classList.remove('hidden');
    document.getElementById('form-passenger-register')?.classList.add('hidden');
    document.getElementById('tab-passenger-login')?.classList.add('text-blue-400', 'border-b-2', 'border-blue-500');
    document.getElementById('tab-passenger-register')?.classList.remove('text-blue-400', 'border-b-2', 'border-blue-500');
  });
  document.getElementById('tab-passenger-register')?.addEventListener('click', () => {
    document.getElementById('form-passenger-login')?.classList.add('hidden');
    document.getElementById('form-passenger-register')?.classList.remove('hidden');
    document.getElementById('tab-passenger-register')?.classList.add('text-blue-400', 'border-b-2', 'border-blue-500');
    document.getElementById('tab-passenger-login')?.classList.remove('text-blue-400', 'border-b-2', 'border-blue-500');
  });
  document.getElementById('btn-switch-to-driver-auth')?.addEventListener('click', () => navigateTo('auth-driver'));

  // Tab switching inside Driver Auth
  document.getElementById('tab-driver-login')?.addEventListener('click', () => {
    document.getElementById('form-driver-login')?.classList.remove('hidden');
    document.getElementById('form-driver-register')?.classList.add('hidden');
    document.getElementById('tab-driver-login')?.classList.add('text-blue-400', 'border-b-2', 'border-blue-500');
    document.getElementById('tab-driver-register')?.classList.remove('text-blue-400', 'border-b-2', 'border-blue-500');
  });
  document.getElementById('tab-driver-register')?.addEventListener('click', () => {
    document.getElementById('form-driver-login')?.classList.add('hidden');
    document.getElementById('form-driver-register')?.classList.remove('hidden');
    document.getElementById('tab-driver-register')?.classList.add('text-blue-400', 'border-b-2', 'border-blue-500');
    document.getElementById('tab-driver-login')?.classList.remove('text-blue-400', 'border-b-2', 'border-blue-500');
  });
  document.getElementById('btn-switch-to-passenger-auth')?.addEventListener('click', () => navigateTo('auth-passenger'));

  // Show/Hide password toggles
  document.getElementById('btn-toggle-passenger-pw')?.addEventListener('click', () => {
    const input = document.getElementById('passenger-login-password');
    if (input) input.type = input.type === 'password' ? 'text' : 'password';
  });
  document.getElementById('btn-toggle-driver-pw')?.addEventListener('click', () => {
    const input = document.getElementById('driver-login-password');
    if (input) input.type = input.type === 'password' ? 'text' : 'password';
  });

  // Auth Forms Submit
  document.getElementById('form-passenger-login')?.addEventListener('submit', handlePassengerLogin);
  document.getElementById('form-passenger-register')?.addEventListener('submit', handlePassengerRegister);
  document.getElementById('form-driver-login')?.addEventListener('submit', handleDriverLogin);
  document.getElementById('form-driver-register')?.addEventListener('submit', handleDriverRegister);

  // Map Pick Controls (Passenger)
  document.getElementById('btn-pick-pickup')?.addEventListener('click', () => {
    state.mapPickMode = 'pickup';
    document.body.style.cursor = 'crosshair';
    showToast('Hãy nhấp vào bản đồ để chọn điểm đón...', 'info');
  });
  document.getElementById('btn-pick-dropoff')?.addEventListener('click', () => {
    state.mapPickMode = 'dropoff';
    document.body.style.cursor = 'crosshair';
    showToast('Hãy nhấp vào bản đồ để chọn điểm đến...', 'info');
  });
  document.getElementById('btn-map-fit')?.addEventListener('click', () => {
    if (passengerMap && passengerRouteLine) {
      passengerMap.fitBounds(passengerRouteLine.getBounds(), { padding: [40, 40] });
    }
  });
  document.getElementById('btn-map-reset-points')?.addEventListener('click', () => {
    setPickupCoordinates(21.0285, 105.8544, 'Hồ Hoàn Kiếm, Hoàn Kiếm, Hà Nội');
    setDropoffCoordinates(21.0173, 105.7839, 'Landmark 72, Nam Từ Liêm, Hà Nội');
    showToast('Đã đặt lại điểm mẫu mặc định', 'info');
  });

  // Booking & Trip Actions
  document.getElementById('btn-create-trip')?.addEventListener('click', handleCreateTrip);
  document.getElementById('btn-open-cancel-modal')?.addEventListener('click', () => {
    document.getElementById('cancel-confirm-modal')?.classList.remove('hidden');
  });
  document.getElementById('btn-cancel-modal-close')?.addEventListener('click', () => {
    document.getElementById('cancel-confirm-modal')?.classList.add('hidden');
  });
  document.getElementById('btn-cancel-modal-confirm')?.addEventListener('click', handleCancelTrip);

  // Wallet Modal
  document.getElementById('btn-open-topup-modal')?.addEventListener('click', () => {
    document.getElementById('topup-modal')?.classList.remove('hidden');
  });
  document.getElementById('btn-topup-close')?.addEventListener('click', () => {
    document.getElementById('topup-modal')?.classList.add('hidden');
  });
  document.querySelectorAll('.btn-preset-topup').forEach((btn) => {
    btn.addEventListener('click', () => {
      const amount = btn.dataset.amount;
      const input = document.getElementById('input-custom-topup');
      if (input && amount) input.value = amount;
    });
  });
  document.getElementById('btn-submit-topup')?.addEventListener('click', () => {
    const input = document.getElementById('input-custom-topup');
    const amount = Number(input?.value || 0);
    if (amount > 0) handleTopup(amount);
  });

  // Driver Controls
  document.getElementById('btn-toggle-driver-status')?.addEventListener('click', handleToggleDriverStatus);
  document.getElementById('btn-update-driver-gps')?.addEventListener('click', handleUpdateDriverGPS);

  // Close modals on clicking backdrop
  window.addEventListener('click', (e) => {
    const popover = document.getElementById('notification-popover');
    const bellBtn = document.getElementById('btn-notif-bell');
    if (popover && !popover.classList.contains('hidden') && !popover.contains(e.target) && !bellBtn?.contains(e.target)) {
      popover.classList.add('hidden');
    }
  });

  // Browser History Back/Forward
  window.addEventListener('popstate', (e) => {
    if (e.state?.view) {
      navigateTo(e.state.view, false);
    } else {
      handleInitialRoute();
    }
  });
}

// Bootstrap Application
document.addEventListener('DOMContentLoaded', () => {
  bindEvents();
  restoreSession();
  setInterval(pollDiagnosticsHealth, 15000);
});
