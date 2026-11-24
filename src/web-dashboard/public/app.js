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
  driverActiveTrip: null,
  driverGpsInterval: null,
  driverTripPollInterval: null,
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
let passengerRouteCasing = null;
let passengerRouteLine = null;

let driverMap = null;
let driverSelfMarker = null;
let driverTripPickupMarker = null;
let driverTripDropoffMarker = null;
let driverRouteCasing = null;
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

// Log line into diagnostics drawer - Formats raw IDs into human-readable distributed system events
function logDiagnostic(scope, message, correlationId = '') {
  const container = document.getElementById('logs-container');
  if (!container) return;

  const entry = document.createElement('div');
  entry.className = `log-entry log-${scope} p-2 rounded-lg bg-[#121316] border border-white/[0.04] text-[11px]`;
  entry.dataset.corr = correlationId;

  // Format message: replace cryptic UUIDs with clear human labels
  let readableMsg = typeof message === 'string' ? message : JSON.stringify(message);
  readableMsg = readableMsg
    .replace(/6919a339-7055-4836-b49a-fd681ea8e604/gi, 'Tài xế Nguyễn Văn Tài (29A-888.88)')
    .replace(/1e6d0ff6-1aac-40da-8047-a6b12e6e3022/gi, 'Tài xế Nguyễn Văn Tài')
    .replace(/"driver_id"\s*:\s*"[^"]+"/gi, '"driver": "Nguyễn Văn Tài (29A-888.88)"')
    .replace(/"passenger_id"\s*:\s*"[^"]+"/gi, `"passenger": "${state.user?.name || 'Hành khách (Bạn)'}"`);

  // Service badge color
  const scopeColors = {
    gateway: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
    trip: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
    driver: 'text-sky-400 bg-sky-500/10 border-sky-500/20',
    payment: 'text-purple-400 bg-purple-500/10 border-purple-500/20',
    saga: 'text-pink-400 bg-pink-500/10 border-pink-500/20',
    event: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
    notification: 'text-red-400 bg-red-500/10 border-red-500/20',
    network: 'text-red-400 bg-red-500/10 border-red-500/20',
  };
  const colorClass = scopeColors[scope.toLowerCase()] || 'text-slate-300 bg-white/5 border-white/10';

  const timeStr = new Date().toLocaleTimeString('vi-VN');
  entry.innerHTML = `
    <div class="flex items-center justify-between text-[10px]">
      <span class="px-1.5 py-0.5 rounded font-bold uppercase border ${colorClass}">[${scope.toUpperCase()}]</span>
      <span class="text-[#6b7280] font-mono">${timeStr}</span>
    </div>
    <div class="text-[#f3f4f6] mt-1 break-words leading-relaxed">${readableMsg}</div>
    ${correlationId ? `<div class="text-[9px] text-[#6b7280] mt-1 font-mono truncate">corr: ${correlationId}</div>` : ''}
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

    const responseData = json.data !== undefined ? json.data : json;
    return { ok: res.ok, status: res.status, data: responseData, error: json.error, corrId };
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
    fetchPassengerActiveTrip();
    stopDriverMonitoring();
  } else if (viewName === 'driver-dashboard') {
    setTimeout(initDriverMap, 100);
    startDriverMonitoring();
  } else {
    stopDriverMonitoring();
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
    listEl.innerHTML = '<div class="p-6 text-center text-xs text-slate-500">Không có thông báo mới</div>';
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
  if (!mapContainer) return;
  if (passengerMap) {
    passengerMap.invalidateSize();
    return;
  }

  passengerMap = L.map('passenger-map', {
    center: [21.0285, 105.8544],
    zoom: 13,
    zoomControl: false,
    dragging: true,
    tap: true,
    touchZoom: true,
    scrollWheelZoom: true,
    doubleClickZoom: true,
  });

  window.passengerMap = passengerMap;
  L.control.zoom({ position: 'bottomleft' }).addTo(passengerMap);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 18,
  }).addTo(passengerMap);

  // Default mode: Pan (Kéo bản đồ tự do - MẶC ĐỊNH)
  state.mapInteractionMode = 'pan';

  // Mouse cursor during dragging
  passengerMap.on('dragstart', () => {
    if (state.mapInteractionMode === 'pan') {
      const mapContainer = document.getElementById('passenger-map');
      if (mapContainer) mapContainer.style.cursor = 'grabbing';
    }
  });

  passengerMap.on('dragend', () => {
    if (state.mapInteractionMode === 'pan') {
      const mapContainer = document.getElementById('passenger-map');
      if (mapContainer) mapContainer.style.cursor = 'grab';
    }
  });

  // Map Click Handling: TÁCH BIỆT HOÀN TOÀN KÉO BẢN ĐỒ VÀ GHIM ĐIỂM
  passengerMap.on('click', (e) => {
    // KHI Ở CHẾ ĐỘ 'pan' (KÉO BẢN ĐỒ TỰ DO):
    // TUYỆT ĐỐI KHÔNG MỞ POPUP! Người dùng tự do kéo lướt, click không bị phiền!
    if (!state.mapInteractionMode || state.mapInteractionMode === 'pan') {
      return;
    }

    const { lat, lng } = e.latlng;
    const roundedLat = Math.round(lat * 10000) / 10000;
    const roundedLng = Math.round(lng * 10000) / 10000;

    if (state.mapInteractionMode === 'pickup') {
      setPickupCoordinates(roundedLat, roundedLng, `Toạ độ (${roundedLat}, ${roundedLng})`);
      setMapInteractionMode('pan');
      showToast(`Đã chọn điểm đón tại (${roundedLat}, ${roundedLng})`, 'success');
      return;
    } else if (state.mapInteractionMode === 'dropoff') {
      setDropoffCoordinates(roundedLat, roundedLng, `Toạ độ (${roundedLat}, ${roundedLng})`);
      setMapInteractionMode('pan');
      showToast(`Đã chọn điểm đến tại (${roundedLat}, ${roundedLng})`, 'success');
      return;
    } else if (state.mapInteractionMode === 'pin') {
      // Chỉ khi người dùng chủ động bật chế độ Ghim Điểm
      openPinSelectionPopup(e.latlng, roundedLat, roundedLng);
    }
  });

  // Chuột phải (Contextmenu) kiểu Google Maps: Nhấp chuột phải tại điểm bất kỳ để ghim nhanh mà không bị nhầm với kéo chuột trái
  passengerMap.on('contextmenu', (e) => {
    const { lat, lng } = e.latlng;
    const roundedLat = Math.round(lat * 10000) / 10000;
    const roundedLng = Math.round(lng * 10000) / 10000;
    openPinSelectionPopup(e.latlng, roundedLat, roundedLng);
  });

  renderPassengerMapMarkers();
}

// Open Pin Dropdown Popup
function openPinSelectionPopup(latlng, roundedLat, roundedLng) {
  const popupContent = document.createElement('div');
  popupContent.className = 'p-1 text-[#f3f4f6] text-xs';
  popupContent.innerHTML = `
    <div class="font-semibold mb-1 text-[#f3f4f6] flex items-center gap-1.5">
      <svg class="w-3.5 h-3.5 text-amber-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a8 8 0 0 0-8 8c0 5.25 8 12 8 12s8-6.75 8-12a8 8 0 0 0-8-8z"/><circle cx="12" cy="10" r="3"/></svg>
      <span>Toạ độ: ${roundedLat}, ${roundedLng}</span>
    </div>
    <div class="text-[11px] text-[#9ca3af] mb-2">Chọn ghim vị trí này cho chuyến đi của bạn:</div>
    <div class="flex flex-col gap-1.5">
      <button id="btn-popup-set-pickup" class="w-full bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-semibold py-1.5 px-2.5 rounded-lg shadow-sm flex items-center justify-center gap-1.5 transition">
        <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a8 8 0 0 0-8 8c0 5.25 8 12 8 12s8-6.75 8-12a8 8 0 0 0-8-8z"/><circle cx="12" cy="10" r="3"/></svg>
        <span>Đặt làm Điểm Đón</span>
      </button>
      <button id="btn-popup-set-dropoff" class="w-full bg-[#22242a] hover:bg-[#2a2c34] text-[#f3f4f6] border border-white/[0.08] text-[11px] font-semibold py-1.5 px-2.5 rounded-lg shadow-sm flex items-center justify-center gap-1.5 transition">
        <svg class="w-3 h-3 text-amber-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/></svg>
        <span>Đặt làm Điểm Đến</span>
      </button>
    </div>
  `;

  L.popup({ minWidth: 180, closeButton: true })
    .setLatLng(latlng)
    .setContent(popupContent)
    .openOn(passengerMap);

  popupContent.querySelector('#btn-popup-set-pickup')?.addEventListener('click', () => {
    setPickupCoordinates(roundedLat, roundedLng, `Ghim bản đồ (${roundedLat}, ${roundedLng})`);
    passengerMap.closePopup();
    setMapInteractionMode('pan');
    showToast(`Đã đặt Điểm Đón tại (${roundedLat}, ${roundedLng})`, 'success');
  });

  popupContent.querySelector('#btn-popup-set-dropoff')?.addEventListener('click', () => {
    setDropoffCoordinates(roundedLat, roundedLng, `Ghim bản đồ (${roundedLat}, ${roundedLng})`);
    passengerMap.closePopup();
    setMapInteractionMode('pan');
    showToast(`Đã đặt Điểm Đến tại (${roundedLat}, ${roundedLng})`, 'success');
  });
}

// Map Interaction Modes: 'pan' (default - dragging only, no popups) vs 'pin' (explicit pin dropping)
function setMapInteractionMode(mode) {
  state.mapInteractionMode = mode; // 'pan' | 'pin' | 'pickup' | 'dropoff'
  state.mapPickMode = (mode === 'pickup' || mode === 'dropoff') ? mode : null;

  const btnPan = document.getElementById('btn-mode-pan');
  const btnPin = document.getElementById('btn-mode-pin');
  const banner = document.getElementById('pick-mode-banner');
  const bannerText = document.getElementById('pick-mode-text');
  const cancelBtn = document.getElementById('btn-cancel-pick');
  const mapContainer = document.getElementById('passenger-map');

  if (mode === 'pan') {
    if (btnPan) {
      btnPan.className = 'bg-blue-600 text-white font-medium px-2 py-1 rounded transition flex items-center gap-1 shadow-sm';
    }
    if (btnPin) {
      btnPin.className = 'text-slate-300 hover:text-white px-2 py-1 rounded transition flex items-center gap-1';
    }
    if (mapContainer) mapContainer.style.cursor = 'grab';
    document.body.style.cursor = 'default';
    if (banner) banner.classList.add('hidden');
    if (cancelBtn) cancelBtn.classList.add('hidden');
    if (passengerMap) passengerMap.closePopup();
  } else if (mode === 'pin') {
    if (btnPan) {
      btnPan.className = 'text-slate-300 hover:text-white px-2 py-1 rounded transition flex items-center gap-1';
    }
    if (btnPin) {
      btnPin.className = 'bg-emerald-600 text-white font-medium px-2 py-1 rounded transition flex items-center gap-1 shadow-sm ring-1 ring-emerald-400';
    }
    if (mapContainer) mapContainer.style.cursor = 'crosshair';
    document.body.style.cursor = 'crosshair';
    if (banner) {
      banner.classList.remove('hidden');
      if (bannerText) bannerText.textContent = 'Chế độ Ghim Điểm: Nhấp vào bản đồ để chọn Điểm Đón hoặc Điểm Đến';
    }
    if (cancelBtn) cancelBtn.classList.remove('hidden');
    showToast('Chế độ Ghim Điểm: Nhấp vị trí bất kỳ trên bản đồ để chọn điểm đón/đến', 'info');
  } else if (mode === 'pickup') {
    if (btnPan) btnPan.className = 'text-slate-300 hover:text-white px-2 py-1 rounded transition flex items-center gap-1';
    if (btnPin) btnPin.className = 'text-slate-300 hover:text-white px-2 py-1 rounded transition flex items-center gap-1';
    if (mapContainer) mapContainer.style.cursor = 'crosshair';
    document.body.style.cursor = 'crosshair';
    if (banner) {
      banner.classList.remove('hidden');
      if (bannerText) bannerText.textContent = 'Nhấp lên bản đồ để chọn Điểm Đón';
    }
    if (cancelBtn) cancelBtn.classList.remove('hidden');
    showToast('Vui lòng nhấp vào bản đồ để chọn điểm đón...', 'info');
  } else if (mode === 'dropoff') {
    if (btnPan) btnPan.className = 'text-slate-300 hover:text-white px-2 py-1 rounded transition flex items-center gap-1';
    if (btnPin) btnPin.className = 'text-slate-300 hover:text-white px-2 py-1 rounded transition flex items-center gap-1';
    if (mapContainer) mapContainer.style.cursor = 'crosshair';
    document.body.style.cursor = 'crosshair';
    if (banner) {
      banner.classList.remove('hidden');
      if (bannerText) bannerText.textContent = 'Nhấp lên bản đồ để chọn Điểm Đến';
    }
    if (cancelBtn) cancelBtn.classList.remove('hidden');
    showToast('Vui lòng nhấp vào bản đồ để chọn điểm đến...', 'info');
  }
}

function cancelMapPickMode() {
  setMapInteractionMode('pan');
}

function renderPassengerMapMarkers() {
  if (!passengerMap) return;

  // Pickup marker (Draggable)
  if (!passengerPickupMarker) {
    const pickupIcon = L.divIcon({
      className: 'custom-marker-pin marker-pickup',
      html: '<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="10" r="3"/><path d="M12 2a8 8 0 0 0-8 8c0 5.25 8 12 8 12s8-6.75 8-12a8 8 0 0 0-8-8z"/></svg>',
      iconSize: [28, 28],
      iconAnchor: [14, 28],
    });
    passengerPickupMarker = L.marker([state.pickupCoords.lat, state.pickupCoords.lon], {
      icon: pickupIcon,
      draggable: true,
    })
      .addTo(passengerMap)
      .bindPopup('<b>Điểm đón (Có thể kéo)</b><br>' + state.pickupCoords.address);

    passengerPickupMarker.on('dragend', (e) => {
      const { lat, lng } = e.target.getLatLng();
      const roundedLat = Math.round(lat * 10000) / 10000;
      const roundedLng = Math.round(lng * 10000) / 10000;
      setPickupCoordinates(roundedLat, roundedLng, `Toạ độ (${roundedLat}, ${roundedLng})`);
      showToast(`Đã kéo điểm đón đến (${roundedLat}, ${roundedLng})`, 'info');
    });
  } else {
    passengerPickupMarker.setLatLng([state.pickupCoords.lat, state.pickupCoords.lon]);
    passengerPickupMarker.setPopupContent('<b>Điểm đón (Có thể kéo)</b><br>' + state.pickupCoords.address);
  }

  // Dropoff marker (Draggable)
  if (!passengerDropoffMarker) {
    const dropoffIcon = L.divIcon({
      className: 'custom-marker-pin marker-dropoff',
      html: '<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/></svg>',
      iconSize: [28, 28],
      iconAnchor: [14, 14],
    });
    passengerDropoffMarker = L.marker([state.dropoffCoords.lat, state.dropoffCoords.lon], {
      icon: dropoffIcon,
      draggable: true,
    })
      .addTo(passengerMap)
      .bindPopup('<b>Điểm đến (Có thể kéo)</b><br>' + state.dropoffCoords.address);

    passengerDropoffMarker.on('dragend', (e) => {
      const { lat, lng } = e.target.getLatLng();
      const roundedLat = Math.round(lat * 10000) / 10000;
      const roundedLng = Math.round(lng * 10000) / 10000;
      setDropoffCoordinates(roundedLat, roundedLng, `Toạ độ (${roundedLat}, ${roundedLng})`);
      showToast(`Đã kéo điểm đến đến (${roundedLat}, ${roundedLng})`, 'info');
    });
  } else {
    passengerDropoffMarker.setLatLng([state.dropoffCoords.lat, state.dropoffCoords.lon]);
    passengerDropoffMarker.setPopupContent('<b>Điểm đến (Có thể kéo)</b><br>' + state.dropoffCoords.address);
  }

  // Signature Visual: Transit Route Line (Dual Layer Casing + Signal Amber Core)
  const latlngs = [
    [state.pickupCoords.lat, state.pickupCoords.lon],
    [state.dropoffCoords.lat, state.dropoffCoords.lon],
  ];

  if (!passengerRouteCasing) {
    passengerRouteCasing = L.polyline(latlngs, {
      color: '#0a0b0d',
      weight: 7,
      opacity: 0.85,
      lineCap: 'round',
      lineJoin: 'round',
    }).addTo(passengerMap);
  } else {
    passengerRouteCasing.setLatLngs(latlngs);
  }

  if (!passengerRouteLine) {
    passengerRouteLine = L.polyline(latlngs, {
      color: '#f59e0b',
      weight: 4,
      opacity: 0.95,
      lineCap: 'round',
      lineJoin: 'round',
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
  if (!mapContainer) return;
  if (driverMap) {
    driverMap.invalidateSize();
    return;
  }

  driverMap = L.map('driver-map', {
    center: [state.driverCoords.lat, state.driverCoords.lon],
    zoom: 14,
    zoomControl: false,
    dragging: true,
    tap: true,
    touchZoom: true,
    scrollWheelZoom: true,
    doubleClickZoom: true,
  });

  window.driverMap = driverMap;
  L.control.zoom({ position: 'bottomleft' }).addTo(driverMap);

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

  driverSelfMarker = L.marker([state.driverCoords.lat, state.driverCoords.lon], {
    icon: carIcon,
    draggable: true,
  })
    .addTo(driverMap)
    .bindPopup('<b>Vị trí xe của bạn (Có thể kéo)</b><br>Kéo thả để cập nhật toạ độ GPS');

  driverSelfMarker.on('dragend', async (e) => {
    const { lat, lng } = e.target.getLatLng();
    state.driverCoords.lat = Math.round(lat * 10000) / 10000;
    state.driverCoords.lon = Math.round(lng * 10000) / 10000;
    await sendDriverGpsHeartbeat();
    showToast(`Đã cập nhật vị trí GPS tài xế: (${state.driverCoords.lat}, ${state.driverCoords.lon})`, 'success');
  });
}

function renderDriverTripRoute(trip) {
  if (!driverMap) return;

  const pLat = Number(trip.pickup_latitude);
  const pLon = Number(trip.pickup_longitude);
  const dLat = Number(trip.dropoff_latitude);
  const dLon = Number(trip.dropoff_longitude);

  if (isNaN(pLat) || isNaN(pLon) || isNaN(dLat) || isNaN(dLon)) return;

  // Pickup marker
  if (!driverTripPickupMarker) {
    const pIcon = L.divIcon({
      className: 'custom-marker-pin marker-pickup',
      html: '<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="10" r="3"/><path d="M12 2a8 8 0 0 0-8 8c0 5.25 8 12 8 12s8-6.75 8-12a8 8 0 0 0-8-8z"/></svg>',
      iconSize: [26, 26],
      iconAnchor: [13, 26],
    });
    driverTripPickupMarker = L.marker([pLat, pLon], { icon: pIcon })
      .addTo(driverMap)
      .bindPopup('<b>Điểm đón khách</b><br>' + (trip.pickup_address || ''));
  } else {
    driverTripPickupMarker.setLatLng([pLat, pLon]);
    driverTripPickupMarker.setPopupContent('<b>Điểm đón khách</b><br>' + (trip.pickup_address || ''));
  }

  // Dropoff marker
  if (!driverTripDropoffMarker) {
    const dIcon = L.divIcon({
      className: 'custom-marker-pin marker-dropoff',
      html: '<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/></svg>',
      iconSize: [26, 26],
      iconAnchor: [13, 13],
    });
    driverTripDropoffMarker = L.marker([dLat, dLon], { icon: dIcon })
      .addTo(driverMap)
      .bindPopup('<b>Điểm trả khách</b><br>' + (trip.dropoff_address || ''));
  } else {
    driverTripDropoffMarker.setLatLng([dLat, dLon]);
    driverTripDropoffMarker.setPopupContent('<b>Điểm trả khách</b><br>' + (trip.dropoff_address || ''));
  }

  // Route polyline from pickup to dropoff (Signature Transit Dual Layer)
  const latlngs = [[pLat, pLon], [dLat, dLon]];

  if (!driverRouteCasing) {
    driverRouteCasing = L.polyline(latlngs, {
      color: '#0a0b0d',
      weight: 7,
      opacity: 0.85,
      lineCap: 'round',
      lineJoin: 'round',
    }).addTo(driverMap);
  } else {
    driverRouteCasing.setLatLngs(latlngs);
  }

  if (!driverRouteLine) {
    driverRouteLine = L.polyline(latlngs, {
      color: '#f59e0b',
      weight: 4,
      opacity: 0.95,
      lineCap: 'round',
      lineJoin: 'round',
    }).addTo(driverMap);
  } else {
    driverRouteLine.setLatLngs(latlngs);
  }

  driverMap.fitBounds(L.latLngBounds([[pLat, pLon], [dLat, dLon], [state.driverCoords.lat, state.driverCoords.lon]]), {
    padding: [40, 40],
  });
}

function clearDriverTripRoute() {
  if (driverTripPickupMarker && driverMap) {
    driverMap.removeLayer(driverTripPickupMarker);
    driverTripPickupMarker = null;
  }
  if (driverTripDropoffMarker && driverMap) {
    driverMap.removeLayer(driverTripDropoffMarker);
    driverTripDropoffMarker = null;
  }
  if (driverRouteCasing && driverMap) {
    driverMap.removeLayer(driverRouteCasing);
    driverRouteCasing = null;
  }
  if (driverRouteLine && driverMap) {
    driverMap.removeLayer(driverRouteLine);
    driverRouteLine = null;
  }
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
      updateLiveDistributionMetrics();
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
      updateLiveDistributionMetrics();
    }, 3000);
  }

  // Update Live Distribution Table synchronously with trip changes
  updateLiveDistributionMetrics();
}

function startTripPolling(tripId) {
  stopTripPolling();
  state.pollingInterval = setInterval(async () => {
    const res = await apiRequest(`/trips/${tripId}`);
    if (res.ok && res.data && res.data.id) {
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

async function fetchPassengerActiveTrip() {
  if (!state.token || state.user?.role !== 'PASSENGER') return;
  const res = await apiRequest('/trips/active');
  if (res.ok && res.data && res.data.id) {
    state.activeTrip = res.data;
    showActiveTripUI(res.data);
    startTripPolling(res.data.id);
  } else {
    state.activeTrip = null;
    stopTripPolling();
    document.getElementById('passenger-active-trip-section')?.classList.add('hidden');
    document.getElementById('passenger-booking-section')?.classList.remove('hidden');
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
    showToast(`Đã nạp thành công ${Number(amount).toLocaleString('vi-VN')} đ vào ví!`, 'success');
    document.getElementById('topup-modal')?.classList.add('hidden');
    fetchWalletBalance();
  } else {
    showToast(res.error?.message || 'Nạp ví không thành công', 'error');
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
        toggleBtn.disabled = false;
        toggleBtn.textContent = 'Đang Sẵn Sàng (Bấm để Tạm Nghỉ)';
        toggleBtn.className = 'flex-1 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold py-2 rounded-lg transition active:scale-[0.98]';
      } else if (state.driverStatus === 'RESERVED') {
        statusTextEl.textContent = 'RESERVED (Đang giữ chuyến)';
        statusTextEl.className = 'text-[11px] font-mono font-bold text-amber-400';
        toggleBtn.disabled = true;
        toggleBtn.textContent = 'Đang điều phối (Chờ nhận chuyến)...';
        toggleBtn.className = 'flex-1 bg-amber-600/30 text-amber-300 text-xs font-semibold py-2 rounded-lg border border-amber-500/30 cursor-not-allowed';
      } else if (state.driverStatus === 'BUSY') {
        statusTextEl.textContent = 'BUSY (Đang phục vụ)';
        statusTextEl.className = 'text-[11px] font-mono font-bold text-sky-400';
        toggleBtn.disabled = true;
        toggleBtn.textContent = 'Đang trong chuyến đi...';
        toggleBtn.className = 'flex-1 bg-sky-600/30 text-sky-300 text-xs font-semibold py-2 rounded-lg border border-sky-500/30 cursor-not-allowed';
      } else {
        statusTextEl.textContent = 'OFFLINE';
        statusTextEl.className = 'text-[11px] font-mono font-bold text-slate-400';
        toggleBtn.disabled = false;
        toggleBtn.textContent = 'Đang Tạm Nghỉ (Bấm để Sẵn Sàng)';
        toggleBtn.className = 'flex-1 bg-[#22242a] hover:bg-[#2a2c34] text-[#f3f4f6] text-xs font-semibold py-2 rounded-lg border border-white/[0.08] transition active:scale-[0.98]';
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

async function sendDriverGpsHeartbeat() {
  if (!state.token || state.user?.role !== 'DRIVER') return;
  if (state.driverStatus !== 'AVAILABLE' && state.driverStatus !== 'BUSY' && state.driverStatus !== 'RESERVED') return;
  await apiRequest('/drivers/location', {
    method: 'PUT',
    body: { latitude: state.driverCoords.lat, longitude: state.driverCoords.lon },
  });
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

function startDriverMonitoring() {
  stopDriverMonitoring();
  fetchDriverProfile();
  pollDriverActiveTrip();
  sendDriverGpsHeartbeat();
  state.driverTripPollInterval = setInterval(pollDriverActiveTrip, 2500);
  state.driverGpsInterval = setInterval(sendDriverGpsHeartbeat, 15000);
}

function stopDriverMonitoring() {
  if (state.driverTripPollInterval) {
    clearInterval(state.driverTripPollInterval);
    state.driverTripPollInterval = null;
  }
  if (state.driverGpsInterval) {
    clearInterval(state.driverGpsInterval);
    state.driverGpsInterval = null;
  }
}

async function pollDriverActiveTrip() {
  if (!state.token || state.user?.role !== 'DRIVER') return;
  const res = await apiRequest('/trips/active');
  const noTripEl = document.getElementById('driver-no-trip');
  const activeTripEl = document.getElementById('driver-active-trip');

  if (res.ok && res.data && res.data.id) {
    const trip = res.data;
    state.driverActiveTrip = trip;
    fetchDriverProfile();

    noTripEl?.classList.add('hidden');
    activeTripEl?.classList.remove('hidden');

    const idEl = document.getElementById('driver-trip-id');
    const passengerEl = document.getElementById('driver-passenger-name');
    const fareEl = document.getElementById('driver-trip-fare');
    const pickupEl = document.getElementById('driver-trip-pickup');
    const dropoffEl = document.getElementById('driver-trip-dropoff');
    const badgeEl = document.getElementById('driver-trip-badge');

    if (idEl) idEl.textContent = trip.id;
    if (passengerEl) passengerEl.textContent = trip.passenger_name || 'Khách hàng DS03';
    if (fareEl) fareEl.textContent = `${Number(trip.fare || trip.estimated_fare || 0).toLocaleString('vi-VN')} đ`;
    if (pickupEl) pickupEl.textContent = trip.pickup_address || `(${trip.pickup_latitude}, ${trip.pickup_longitude})`;
    if (dropoffEl) dropoffEl.textContent = trip.dropoff_address || `(${trip.dropoff_latitude}, ${trip.dropoff_longitude})`;
    if (badgeEl) badgeEl.textContent = trip.status;

    // Driver action buttons based on trip status
    const btnAccept = document.getElementById('btn-driver-accept');
    const btnStart = document.getElementById('btn-driver-start');
    const btnComplete = document.getElementById('btn-driver-complete');

    if (btnAccept && btnStart && btnComplete) {
      if (['DRIVER_ASSIGNED', 'CONFIRMED'].includes(trip.status)) {
        btnAccept.classList.remove('hidden');
        btnStart.classList.add('hidden');
        btnComplete.classList.add('hidden');
      } else if (trip.status === 'ACCEPTED') {
        btnAccept.classList.add('hidden');
        btnStart.classList.remove('hidden');
        btnComplete.classList.add('hidden');
      } else if (trip.status === 'IN_PROGRESS') {
        btnAccept.classList.add('hidden');
        btnStart.classList.add('hidden');
        btnComplete.classList.remove('hidden');
      } else {
        btnAccept.classList.add('hidden');
        btnStart.classList.add('hidden');
        btnComplete.classList.add('hidden');
      }
    }

    renderDriverTripRoute(trip);
  } else {
    const wasActive = state.driverActiveTrip !== null;
    state.driverActiveTrip = null;
    noTripEl?.classList.remove('hidden');
    activeTripEl?.classList.add('hidden');
    clearDriverTripRoute();
    if (wasActive) {
      fetchDriverProfile();
    }
  }
}

async function handleDriverAcceptTrip() {
  if (!state.driverActiveTrip) return;
  const tripId = state.driverActiveTrip.id;
  const btn = document.getElementById('btn-driver-accept');
  if (btn) btn.disabled = true;

  const res = await apiRequest(`/trips/${tripId}/accept`, { method: 'POST' });
  if (btn) btn.disabled = false;

  if (res.ok) {
    showToast('Đã nhận chuyến xe! Vui lòng di chuyển đến điểm đón khách.', 'success');
    await pollDriverActiveTrip();
    await fetchDriverProfile();
  } else {
    showToast(res.error?.message || 'Không thể tiếp nhận chuyến xe này', 'error');
  }
}

async function handleDriverStartTrip() {
  if (!state.driverActiveTrip) return;
  const tripId = state.driverActiveTrip.id;
  const btn = document.getElementById('btn-driver-start');
  if (btn) btn.disabled = true;

  const res = await apiRequest(`/trips/${tripId}/start`, { method: 'POST' });
  if (btn) btn.disabled = false;

  if (res.ok) {
    showToast('Đã bắt đầu chuyến đi! Chúc bạn lái xe an toàn.', 'success');
    await pollDriverActiveTrip();
    await fetchDriverProfile();
  } else {
    showToast(res.error?.message || 'Không thể bắt đầu chuyến đi', 'error');
  }
}

async function handleDriverCompleteTrip() {
  if (!state.driverActiveTrip) return;
  const tripId = state.driverActiveTrip.id;
  const btn = document.getElementById('btn-driver-complete');
  if (btn) btn.disabled = true;

  const res = await apiRequest(`/trips/${tripId}/complete`, { method: 'POST' });
  if (btn) btn.disabled = false;

  if (res.ok) {
    showToast('Chúc mừng! Chuyến đi đã hoàn tất thành công.', 'success');
    state.driverActiveTrip = null;
    document.getElementById('driver-no-trip')?.classList.remove('hidden');
    document.getElementById('driver-active-trip')?.classList.add('hidden');
    clearDriverTripRoute();
    await pollDriverActiveTrip();
    await fetchDriverProfile();
  } else {
    showToast(res.error?.message || 'Không thể hoàn tất chuyến đi', 'error');
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
  state.activeTrip = null;
  state.driverActiveTrip = null;
  localStorage.removeItem('ds03_token');
  localStorage.removeItem('ds03_user');

  if (state.sseSource) {
    state.sseSource.close();
    state.sseSource = null;
  }
  stopTripPolling();
  stopDriverMonitoring();

  // Reset trip view states
  document.getElementById('passenger-active-trip-section')?.classList.add('hidden');
  document.getElementById('passenger-booking-section')?.classList.remove('hidden');
  document.getElementById('driver-active-trip')?.classList.add('hidden');
  document.getElementById('driver-no-trip')?.classList.remove('hidden');

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
  if (res.ok && res.data && res.data.id) {
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

// Popular Vietnamese Landmarks & Hubs for Google Maps Style Autocomplete
const POPULAR_LOCATIONS = [
  // Hà Nội
  { name: 'Hồ Hoàn Kiếm, Hoàn Kiếm, Hà Nội', lat: 21.0285, lon: 105.8544, desc: 'Trung tâm thủ đô Hà Nội' },
  { name: 'Keangnam Landmark 72, Nam Từ Liêm, Hà Nội', lat: 21.0173, lon: 105.7839, desc: 'Tòa nhà Landmark 72 Phạm Hùng' },
  { name: 'Sân bay Quốc tế Nội Bài, Sóc Sơn, Hà Nội', lat: 21.2187, lon: 105.8042, desc: 'Cảng hàng không quốc tế Nội Bài' },
  { name: 'Hồ Tây, Tây Hồ, Hà Nội', lat: 21.0583, lon: 105.8239, desc: 'Hồ Tây, đường Thanh Niên' },
  { name: 'Đại học Bách Khoa Hà Nội, Hai Bà Trưng, Hà Nội', lat: 21.0044, lon: 105.8433, desc: 'Đại Cồ Việt, Bách Khoa' },
  { name: 'Vincom Mega Mall Royal City, Thanh Xuân, Hà Nội', lat: 20.9995, lon: 105.8155, desc: '72A Nguyễn Trãi' },
  { name: 'Vincom Mega Mall Times City, Hai Bà Trưng, Hà Nội', lat: 20.9950, lon: 105.8670, desc: '458 Minh Khai' },
  // Đà Nẵng
  { name: 'Cầu Rồng, Hải Châu, Đà Nẵng', lat: 16.0611, lon: 108.2272, desc: 'Cầu Rồng sông Hàn' },
  { name: 'Bãi biển Mỹ Khê, Ngũ Hành Sơn, Đà Nẵng', lat: 16.0600, lon: 108.2460, desc: 'Bãi biển Mỹ Khê' },
  { name: 'Sân bay Quốc tế Đà Nẵng, Hải Châu, Đà Nẵng', lat: 16.0538, lon: 108.1994, desc: 'Cảng hàng không quốc tế Đà Nẵng' },
  { name: 'Bán đảo Sơn Trà, Sơn Trà, Đà Nẵng', lat: 16.1189, lon: 108.2778, desc: 'Bán đảo Sơn Trà, Chùa Linh Ứng' },
  { name: 'Bà Nà Hills, Hòa Vang, Đà Nẵng', lat: 15.9989, lon: 107.9959, desc: 'Khu du lịch Sun World Bà Nà Hills' },
  // TP. Hồ Chí Minh
  { name: 'Chợ Bến Thành, Quận 1, TP. HCM', lat: 10.7725, lon: 106.6980, desc: 'Chợ Bến Thành, trung tâm Quận 1' },
  { name: 'Landmark 81, Bình Thạnh, TP. HCM', lat: 10.7950, lon: 106.7219, desc: 'Tòa nhà cao nhất Việt Nam' },
  { name: 'Sân bay Quốc tế Tân Sơn Nhất, Tân Bình, TP. HCM', lat: 10.8185, lon: 106.6588, desc: 'Cảng hàng không quốc tế Tân Sơn Nhất' },
  { name: 'Nhà thờ Đức Bà, Quận 1, TP. HCM', lat: 10.7798, lon: 106.6990, desc: 'Công trường Công Xã Paris' },
  { name: 'Phố đi bộ Nguyễn Huệ, Quận 1, TP. HCM', lat: 10.7744, lon: 106.7032, desc: 'Phố đi bộ Quận 1' },
  { name: 'Khu đô thị Phú Mỹ Hưng, Quận 7, TP. HCM', lat: 10.7293, lon: 106.7153, desc: 'Khu đô thị Phú Mỹ Hưng' },
  // Các tỉnh thành khác
  { name: 'Thành phố Đà Lạt, Lâm Đồng', lat: 11.9404, lon: 108.4583, desc: 'Trung tâm TP. Đà Lạt, Hồ Xuân Hương' },
  { name: 'Thành phố Vũng Tàu, Bà Rịa - Vũng Tàu', lat: 10.3460, lon: 107.0843, desc: 'Bãi Trước, Bãi Sau Vũng Tàu' },
  { name: 'Thành phố Cần Thơ, Cần Thơ', lat: 10.0452, lon: 105.7469, desc: 'Bến Ninh Kiều, Cần Thơ' },
  { name: 'Thành phố Nha Trang, Khánh Hòa', lat: 12.2388, lon: 109.1967, desc: 'Bờ biển Trần Phú, Nha Trang' },
  { name: 'Thành phố Huế, Thừa Thiên Huế', lat: 16.4637, lon: 107.5909, desc: 'Đại Nội Huế, Sông Hương' },
  { name: 'Vịnh Hạ Long, Quảng Ninh', lat: 20.9101, lon: 107.1839, desc: 'Thành phố Hạ Long, Bãi Cháy' },
  { name: 'Đảo Phú Quốc, Kiên Giang', lat: 10.2899, lon: 103.9840, desc: 'TP. Phú Quốc, Bãi Trường' },
];

// Live Driver Distribution & Passenger Saga Monitor Updater
async function updateLiveDistributionMetrics() {
  const availEl = document.getElementById('dist-count-available');
  const resEl = document.getElementById('dist-count-reserved');
  const busyEl = document.getElementById('dist-count-busy');
  const offEl = document.getElementById('dist-count-offline');

  let availableCount = 2; // Default driver pool
  let reservedCount = 0;
  let busyCount = 0;
  let offlineCount = 0;

  try {
    const lat = state.pickupCoords?.lat || 21.0285;
    const lon = state.pickupCoords?.lon || 105.8544;
    const res = await fetch(`http://localhost:8080/drivers/available?lat=${lat}&lon=${lon}&radius_km=50`, {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const json = await res.json();
      if (Array.isArray(json.data) && json.data.length > 0) {
        availableCount = json.data.length;
      }
    }
  } catch (_) {
    // Keep fallback
  }

  // Determine active trip status across Passenger & Driver states
  const trip = state.activeTrip || state.driverActiveTrip;
  const tripStatus = trip?.status || null;

  // Driver elements
  const badge1 = document.getElementById('driver-status-badge-1');
  const badge2 = document.getElementById('driver-status-badge-2');
  const loc1 = document.getElementById('driver-loc-1');
  const loc2 = document.getElementById('driver-loc-2');

  // If currently logged in as driver, sync driver state directly
  if (state.driver?.status) {
    if (state.driver.status === 'RESERVED') {
      reservedCount = Math.max(1, reservedCount);
      availableCount = Math.max(0, availableCount - 1);
      if (badge1) {
        badge1.textContent = 'RESERVED';
        badge1.className = 'px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-amber-500/20 text-amber-400 border border-amber-500/30';
      }
    } else if (state.driver.status === 'BUSY') {
      busyCount = Math.max(1, busyCount);
      availableCount = Math.max(0, availableCount - 1);
      if (badge1) {
        badge1.textContent = 'BUSY';
        badge1.className = 'px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-sky-500/20 text-sky-400 border border-sky-500/30';
      }
    } else if (state.driver.status === 'OFFLINE') {
      offlineCount = 1;
      availableCount = Math.max(0, availableCount - 1);
      if (badge1) {
        badge1.textContent = 'OFFLINE';
        badge1.className = 'px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-white/10 text-[#9ca3af] border border-white/10';
      }
    }
  } else if (tripStatus) {
    // Passenger has an active trip lifecycle
    if (tripStatus === 'REQUESTED') {
      if (badge1) {
        badge1.textContent = 'MATCHING...';
        badge1.className = 'px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-amber-500/20 text-amber-400 border border-amber-500/30 animate-pulse';
      }
    } else if (tripStatus === 'DRIVER_ASSIGNED') {
      reservedCount = 1;
      availableCount = Math.max(0, availableCount - 1);
      if (badge1) {
        badge1.textContent = 'RESERVED';
        badge1.className = 'px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-amber-500/20 text-amber-400 border border-amber-500/30';
      }
      if (loc1) loc1.textContent = 'Đang di chuyển đến điểm đón (Hoàn Kiếm)';
    } else if (['CONFIRMED', 'ACCEPTED', 'IN_PROGRESS'].includes(tripStatus)) {
      busyCount = 1;
      availableCount = Math.max(0, availableCount - 1);
      if (badge1) {
        badge1.textContent = 'BUSY';
        badge1.className = 'px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-sky-500/20 text-sky-400 border border-sky-500/30';
      }
      if (loc1) loc1.textContent = 'Đang trên hành trình chở khách';
    } else {
      if (badge1) {
        badge1.textContent = 'AVAILABLE';
        badge1.className = 'px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30';
      }
      if (loc1) loc1.textContent = 'Hồ Hoàn Kiếm, Hà Nội';
    }
  } else {
    // Default available
    if (badge1) {
      badge1.textContent = 'AVAILABLE';
      badge1.className = 'px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30';
    }
    if (badge2) {
      badge2.textContent = 'AVAILABLE';
      badge2.className = 'px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30';
    }
  }

  // Update counter boxes
  if (availEl) availEl.textContent = availableCount;
  if (resEl) resEl.textContent = reservedCount;
  if (busyEl) busyEl.textContent = busyCount;
  if (offEl) offEl.textContent = offlineCount;

  // Update Passenger & Saga Lifecycle section
  const emptyState = document.getElementById('dist-trip-empty-state');
  const activeState = document.getElementById('dist-trip-active-state');

  if (trip && trip.status && trip.status !== 'CANCELLED' && trip.status !== 'COMPLETED') {
    emptyState?.classList.add('hidden');
    activeState?.classList.remove('hidden');

    const nameEl = document.getElementById('dist-passenger-name');
    const walletEl = document.getElementById('dist-passenger-wallet');
    const statusEl = document.getElementById('dist-trip-status');
    const fareEl = document.getElementById('dist-trip-fare');
    const distEl = document.getElementById('dist-trip-distance');
    const origEl = document.getElementById('dist-trip-origin');
    const destEl = document.getElementById('dist-trip-destination');

    if (nameEl) nameEl.textContent = state.user?.name || (state.user?.role === 'DRIVER' ? 'Khách hàng đặt xe' : 'Hành khách (Bạn)');
    if (walletEl) {
      const balance = state.wallet?.balance !== undefined ? `${Number(state.wallet.balance).toLocaleString('vi-VN')} đ` : 'Đã xác thực ví';
      walletEl.textContent = `Ví: ${balance}`;
    }
    if (statusEl) {
      statusEl.textContent = trip.status;
      statusEl.className = trip.status === 'CONFIRMED' || trip.status === 'IN_PROGRESS'
        ? 'font-bold text-emerald-400 truncate mt-0.5'
        : 'font-bold text-amber-400 truncate mt-0.5';
    }
    const fareVal = trip.estimated_fare || trip.fare || 0;
    if (fareEl) fareEl.textContent = `Giá: ${Number(fareVal).toLocaleString('vi-VN')} đ`;

    const distance = trip.distance_km || calculateDistance(state.pickupCoords.lat, state.pickupCoords.lon, state.dropoffCoords.lat, state.dropoffCoords.lon);
    if (distEl) distEl.textContent = `${distance} km (Haversine GPS)`;

    if (origEl) origEl.textContent = trip.origin_address || state.pickupCoords.address || 'Hồ Hoàn Kiếm, Hà Nội';
    if (destEl) destEl.textContent = trip.destination_address || state.dropoffCoords.address || 'Landmark 72, Nam Từ Liêm, Hà Nội';

    // Saga step indicators highlighting
    const s1 = document.getElementById('dist-saga-step-1');
    const s2 = document.getElementById('dist-saga-step-2');
    const s3 = document.getElementById('dist-saga-step-3');

    if (trip.status === 'REQUESTED') {
      if (s1) s1.className = 'p-1.5 rounded bg-amber-500/20 border border-amber-500/40 text-amber-300 animate-pulse';
      if (s2) s2.className = 'p-1.5 rounded bg-[#18191d] border border-white/[0.08] text-[#9ca3af]';
      if (s3) s3.className = 'p-1.5 rounded bg-[#18191d] border border-white/[0.08] text-[#9ca3af]';
    } else if (trip.status === 'DRIVER_ASSIGNED') {
      if (s1) s1.className = 'p-1.5 rounded bg-emerald-500/20 border border-emerald-500/40 text-emerald-300';
      if (s2) s2.className = 'p-1.5 rounded bg-amber-500/20 border border-amber-500/40 text-amber-300 animate-pulse';
      if (s3) s3.className = 'p-1.5 rounded bg-[#18191d] border border-white/[0.08] text-[#9ca3af]';
    } else if (['CONFIRMED', 'ACCEPTED', 'IN_PROGRESS'].includes(trip.status)) {
      if (s1) s1.className = 'p-1.5 rounded bg-emerald-500/20 border border-emerald-500/40 text-emerald-300';
      if (s2) s2.className = 'p-1.5 rounded bg-emerald-500/20 border border-emerald-500/40 text-emerald-300';
      if (s3) s3.className = 'p-1.5 rounded bg-emerald-500/20 border border-emerald-500/40 text-emerald-300';
    }
  } else {
    emptyState?.classList.remove('hidden');
    activeState?.classList.add('hidden');
    if (state.user) {
      const p = emptyState?.querySelector('p:first-child');
      if (p) p.textContent = `Hành khách: ${state.user.name || state.user.email} (IDLE)`;
    }
  }
}

// Google Maps Style Controls: Search, Geolocation & Fullscreen
function setupMapSearchAndControls() {
  const searchInput = document.getElementById('input-map-search');
  const searchBtn = document.getElementById('btn-map-search');
  const suggestionsBox = document.getElementById('map-search-suggestions');
  const myLocationBtn = document.getElementById('btn-map-my-location');
  const fullscreenBtn = document.getElementById('btn-map-fullscreen');
  const mapWrapper = document.getElementById('passenger-map-wrapper');

  if (fullscreenBtn && mapWrapper) {
    fullscreenBtn.addEventListener('click', () => {
      const isFullscreen = mapWrapper.classList.contains('fixed');
      if (isFullscreen) {
        mapWrapper.classList.remove('fixed', 'inset-0', 'z-[1050]', 'h-screen', 'w-screen', 'rounded-none');
        fullscreenBtn.classList.remove('text-blue-400');
        showToast('Đã thoát chế độ toàn màn hình', 'info');
      } else {
        mapWrapper.classList.add('fixed', 'inset-0', 'z-[1050]', 'h-screen', 'w-screen', 'rounded-none');
        fullscreenBtn.classList.add('text-blue-400');
        showToast('Bản đồ toàn màn hình (Nhấn Esc để thoát)', 'info');
      }
      setTimeout(() => {
        if (passengerMap) passengerMap.invalidateSize();
      }, 100);
    });
  }

  if (myLocationBtn) {
    myLocationBtn.addEventListener('click', () => {
      if ('geolocation' in navigator) {
        myLocationBtn.classList.add('animate-pulse');
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            myLocationBtn.classList.remove('animate-pulse');
            const lat = Math.round(pos.coords.latitude * 10000) / 10000;
            const lon = Math.round(pos.coords.longitude * 10000) / 10000;
            if (passengerMap) {
              passengerMap.flyTo([lat, lon], 15, { duration: 1.5 });
            }
            setPickupCoordinates(lat, lon, `Vị trí GPS của tôi (${lat}, ${lon})`);
            showToast(`Đã định vị thành công vị trí của bạn (${lat}, ${lon})`, 'success');
          },
          (err) => {
            myLocationBtn.classList.remove('animate-pulse');
            const fallbackLat = 21.0285;
            const fallbackLon = 105.8544;
            if (passengerMap) {
              passengerMap.flyTo([fallbackLat, fallbackLon], 14, { duration: 1 });
            }
            showToast(`Không thể đọc GPS (${err.message || 'Quyền bị từ chối'}). Đã căn giữa khu vực chính.`, 'warning');
          },
          { timeout: 5000, enableHighAccuracy: true }
        );
      } else {
        showToast('Trình duyệt không hỗ trợ Geolocation API', 'warning');
      }
    });
  }

  function renderSuggestions(items) {
    if (!suggestionsBox) return;
    if (!items || items.length === 0) {
      suggestionsBox.innerHTML = '<div class="p-2.5 text-[#9ca3af] text-center text-xs">Không tìm thấy địa điểm phù hợp</div>';
      suggestionsBox.classList.remove('hidden');
      return;
    }
    suggestionsBox.innerHTML = items.map((item) => `
      <div class="search-suggestion-item p-2.5 hover:bg-[#22242a] cursor-pointer flex flex-col transition text-xs border-b border-white/[0.04] last:border-b-0" data-lat="${item.lat}" data-lon="${item.lon}" data-name="${encodeURIComponent(item.name)}">
        <span class="font-medium text-[#f3f4f6] text-xs">${item.name}</span>
        <span class="text-[10px] text-[#9ca3af] font-mono">${item.desc || (item.lat + ', ' + item.lon)}</span>
      </div>
    `).join('');
    suggestionsBox.classList.remove('hidden');

    suggestionsBox.querySelectorAll('.search-suggestion-item').forEach((el) => {
      el.addEventListener('click', () => {
        const lat = parseFloat(el.dataset.lat);
        const lon = parseFloat(el.dataset.lon);
        const name = decodeURIComponent(el.dataset.name);
        selectLocation(lat, lon, name);
      });
    });
  }

  function selectLocation(lat, lon, name) {
    if (searchInput) searchInput.value = name;
    if (suggestionsBox) suggestionsBox.classList.add('hidden');
    if (passengerMap) {
      passengerMap.flyTo([lat, lon], 14, { duration: 1.2 });
      setTimeout(() => {
        const popupContent = document.createElement('div');
        popupContent.className = 'p-1 text-[#f3f4f6] text-xs';
        popupContent.innerHTML = `
          <div class="font-semibold mb-1 text-[#f3f4f6]">${name}</div>
          <div class="text-[11px] text-[#9ca3af] mb-2 font-mono tabular-nums">Toạ độ: ${lat}, ${lon}</div>
          <div class="flex flex-col gap-1.5">
            <button id="btn-popup-search-pickup" class="w-full bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-semibold py-1.5 px-2 rounded-lg transition">
              Đặt làm Điểm Đón
            </button>
            <button id="btn-popup-search-dropoff" class="w-full bg-amber-500 hover:bg-amber-400 text-slate-950 text-[11px] font-semibold py-1.5 px-2 rounded-lg transition shadow-sm">
              Đặt làm Điểm Đến
            </button>
          </div>
        `;
        L.popup({ minWidth: 180, closeButton: true })
          .setLatLng([lat, lon])
          .setContent(popupContent)
          .openOn(passengerMap);

        popupContent.querySelector('#btn-popup-search-pickup')?.addEventListener('click', () => {
          setPickupCoordinates(lat, lon, name);
          passengerMap.closePopup();
          showToast(`Đã đặt Điểm Đón: ${name}`, 'success');
        });
        popupContent.querySelector('#btn-popup-search-dropoff')?.addEventListener('click', () => {
          setDropoffCoordinates(lat, lon, name);
          passengerMap.closePopup();
          showToast(`Đã đặt Điểm Đến: ${name}`, 'success');
        });
      }, 500);
    }
  }

  let searchTimeout = null;
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      clearTimeout(searchTimeout);
      if (!q) {
        if (suggestionsBox) suggestionsBox.classList.add('hidden');
        return;
      }
      const matches = POPULAR_LOCATIONS.filter((loc) =>
        loc.name.toLowerCase().includes(q) || (loc.desc && loc.desc.toLowerCase().includes(q))
      );
      if (matches.length > 0) {
        renderSuggestions(matches.slice(0, 5));
      } else {
        searchTimeout = setTimeout(async () => {
          try {
            const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&countrycodes=vn&limit=4`, {
              signal: AbortSignal.timeout(3500)
            });
            if (res.ok) {
              const data = await res.json();
              const items = data.map((d) => ({
                name: d.display_name.split(',').slice(0, 3).join(','),
                lat: parseFloat(d.lat),
                lon: parseFloat(d.lon),
                desc: d.display_name
              }));
              renderSuggestions(items);
            } else {
              renderSuggestions([]);
            }
          } catch (_) {
            renderSuggestions([]);
          }
        }, 400);
      }
    });

    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const firstItem = suggestionsBox?.querySelector('.search-suggestion-item');
        if (firstItem) {
          firstItem.click();
        } else if (searchInput.value.trim()) {
          const q = searchInput.value.trim().toLowerCase();
          const match = POPULAR_LOCATIONS.find((loc) =>
            loc.name.toLowerCase().includes(q)
          );
          if (match) {
            selectLocation(match.lat, match.lon, match.name);
          }
        }
      }
    });
  }

  if (searchBtn && searchInput) {
    searchBtn.addEventListener('click', () => {
      const q = searchInput.value.trim().toLowerCase();
      if (!q) return;
      const match = POPULAR_LOCATIONS.find((loc) =>
        loc.name.toLowerCase().includes(q)
      );
      if (match) {
        selectLocation(match.lat, match.lon, match.name);
      } else {
        searchInput.dispatchEvent(new Event('input'));
      }
    });
  }

  document.addEventListener('click', (e) => {
    if (suggestionsBox && !suggestionsBox.contains(e.target) && e.target !== searchInput) {
      suggestionsBox.classList.add('hidden');
    }
  });
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
    checkService('http://localhost:8003/health', 'trip-indicator'),
    checkService('http://localhost:8002/health', 'driver-indicator'),
    checkService('http://localhost:8005/health', 'payment-indicator'),
    checkService('http://localhost:8006/health', 'sse-indicator'),
    updateLiveDistributionMetrics(),
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

  // Diagnostics & Live Distribution Drawer
  const toggleDiagnostics = () => {
    const drawer = document.getElementById('diagnostics-drawer');
    const backdrop = document.getElementById('diagnostics-backdrop');
    if (!drawer) return;
    const isHidden = drawer.classList.contains('hidden');
    if (isHidden) {
      drawer.classList.remove('hidden');
      backdrop?.classList.remove('hidden');
      pollDiagnosticsHealth();
    } else {
      drawer.classList.add('hidden');
      backdrop?.classList.add('hidden');
    }
  };

  document.getElementById('btn-toggle-diagnostics')?.addEventListener('click', toggleDiagnostics);
  document.getElementById('btn-close-diagnostics')?.addEventListener('click', () => {
    document.getElementById('diagnostics-drawer')?.classList.add('hidden');
    document.getElementById('diagnostics-backdrop')?.classList.add('hidden');
  });
  document.getElementById('diagnostics-backdrop')?.addEventListener('click', () => {
    document.getElementById('diagnostics-drawer')?.classList.add('hidden');
    document.getElementById('diagnostics-backdrop')?.classList.add('hidden');
  });
  document.getElementById('btn-clear-logs')?.addEventListener('click', () => {
    const container = document.getElementById('logs-container');
    if (container) container.innerHTML = '';
  });

  // Live Distribution Drawer Tab Switching
  const tabNodes = document.getElementById('tab-drawer-nodes');
  const tabTopology = document.getElementById('tab-drawer-topology');
  const tabLogs = document.getElementById('tab-drawer-logs');
  const viewNodes = document.getElementById('drawer-view-nodes');
  const viewTopology = document.getElementById('drawer-view-topology');
  const viewLogs = document.getElementById('drawer-view-logs');

  const switchDrawerTab = (activeTab, activeView) => {
    [tabNodes, tabTopology, tabLogs].forEach((tab) => {
      tab?.classList.remove('border-amber-400', 'text-amber-400');
      tab?.classList.add('border-transparent', 'text-[#9ca3af]');
    });
    [viewNodes, viewTopology, viewLogs].forEach((v) => v?.classList.add('hidden'));

    activeTab?.classList.add('border-amber-400', 'text-amber-400');
    activeTab?.classList.remove('border-transparent', 'text-[#9ca3af]');
    activeView?.classList.remove('hidden');
  };

  tabNodes?.addEventListener('click', () => switchDrawerTab(tabNodes, viewNodes));
  tabTopology?.addEventListener('click', () => switchDrawerTab(tabTopology, viewTopology));
  tabLogs?.addEventListener('click', () => switchDrawerTab(tabLogs, viewLogs));

  // Correlation-ID / Service Filter for Logs
  document.getElementById('log-filter-corr')?.addEventListener('input', (e) => {
    const val = (e.target.value || '').trim().toLowerCase();
    const entries = document.querySelectorAll('#logs-container .log-entry');
    entries.forEach((entry) => {
      if (!val) {
        entry.style.display = '';
        return;
      }
      const text = entry.textContent.toLowerCase();
      const corr = (entry.dataset.corr || '').toLowerCase();
      entry.style.display = text.includes(val) || corr.includes(val) ? '' : 'none';
    });
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

  // Map Interaction Mode Switcher (Kéo Bản Đồ vs Ghim Điểm)
  document.getElementById('btn-mode-pan')?.addEventListener('click', () => {
    setMapInteractionMode('pan');
    showToast('Đang ở chế độ Kéo bản đồ tự do', 'info');
  });

  document.getElementById('btn-mode-pin')?.addEventListener('click', () => {
    if (state.mapInteractionMode === 'pin') {
      setMapInteractionMode('pan');
    } else {
      setMapInteractionMode('pin');
    }
  });

  // Map Pick Controls (Passenger Form)
  document.getElementById('btn-pick-pickup')?.addEventListener('click', () => {
    setMapInteractionMode('pickup');
  });

  document.getElementById('btn-pick-dropoff')?.addEventListener('click', () => {
    setMapInteractionMode('dropoff');
  });

  document.getElementById('btn-cancel-pick')?.addEventListener('click', () => {
    cancelMapPickMode();
    showToast('Đã quay lại chế độ Kéo bản đồ tự do', 'info');
  });

  document.getElementById('btn-map-fit')?.addEventListener('click', () => {
    if (passengerMap && passengerRouteLine) {
      passengerMap.fitBounds(passengerRouteLine.getBounds(), { padding: [40, 40] });
    }
  });

  document.getElementById('btn-map-reset-points')?.addEventListener('click', () => {
    cancelMapPickMode();
    setPickupCoordinates(21.0285, 105.8544, 'Hồ Hoàn Kiếm, Hoàn Kiếm, Hà Nội');
    setDropoffCoordinates(21.0173, 105.7839, 'Landmark 72, Nam Từ Liêm, Hà Nội');
    if (passengerMap) {
      passengerMap.setView([21.0285, 105.8544], 13);
    }
    showToast('Đã đặt lại lộ trình mặc định', 'info');
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

  // Driver Controls & Trip Actions
  document.getElementById('btn-toggle-driver-status')?.addEventListener('click', handleToggleDriverStatus);
  document.getElementById('btn-update-driver-gps')?.addEventListener('click', handleUpdateDriverGPS);
  document.getElementById('btn-driver-accept')?.addEventListener('click', handleDriverAcceptTrip);
  document.getElementById('btn-driver-start')?.addEventListener('click', handleDriverStartTrip);
  document.getElementById('btn-driver-complete')?.addEventListener('click', handleDriverCompleteTrip);

  // Initialize Google Maps Style Controls & Search
  setupMapSearchAndControls();

  // Responsive window resize for Leaflet maps
  window.addEventListener('resize', () => {
    if (passengerMap) passengerMap.invalidateSize();
    if (driverMap) driverMap.invalidateSize();
  });

  // Keyboard shortcut: Escape key closes drawers, modals, search suggestions and fullscreen
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.getElementById('diagnostics-drawer')?.classList.add('hidden');
      document.getElementById('diagnostics-backdrop')?.classList.add('hidden');
      document.getElementById('notification-popover')?.classList.add('hidden');
      document.getElementById('cancel-confirm-modal')?.classList.add('hidden');
      document.getElementById('topup-modal')?.classList.add('hidden');
      document.getElementById('map-search-suggestions')?.classList.add('hidden');
      const mapWrapper = document.getElementById('passenger-map-wrapper');
      if (mapWrapper?.classList.contains('fixed')) {
        mapWrapper.classList.remove('fixed', 'inset-0', 'z-[1050]', 'h-screen', 'w-screen', 'rounded-none');
        document.getElementById('btn-map-fullscreen')?.classList.remove('text-blue-400');
        if (passengerMap) passengerMap.invalidateSize();
      }
      cancelMapPickMode();
    }
  });

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
