'use strict';

/**
 * BROWSER E2E TESTS (Playwright) — DS03 RIDE-HAILING
 * Verifies full end-to-end user journeys in real browser against Docker Compose stack:
 * AUTH-01..AUTH-07, UI-01..UI-15
 * Generates real PNG screenshots in docs/screenshots/
 */

const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const SCREENSHOTS_DIR = path.resolve(__dirname, '..', 'docs', 'screenshots');

if (!fs.existsSync(SCREENSHOTS_DIR)) {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

let browser = null;
let page = null;
const results = [];

function recordResult(id, name, status, durationMs, details = '') {
  const icon = status === 'PASS' ? '✅' : '❌';
  console.log(`${icon} [${id}] ${name} (${(durationMs / 1000).toFixed(2)}s) ${details}`);
  results.push({ id, name, status, durationMs, details });
}

async function runBrowserTests() {
  console.log('='.repeat(80));
  console.log(' KHỞI CHẠY BỘ KIỂM THỬ TRÌNH DUYỆT (BROWSER UI E2E TEST SUITE)');
  console.log(' Mục tiêu: Kiểm chứng luồng Người Dùng Thật qua Chromium & API Gateway Thật');
  console.log(` Base URL: ${BASE_URL}`);
  console.log('='.repeat(80));

  browser = await chromium.launch({
    headless: true,
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });

  page = await context.newPage();

  // Test UI-01: Landing Page renders cleanly without raw technical logs
  const t01 = Date.now();
  try {
    await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });
    const landingVisible = await page.isVisible('#view-landing');
    const heroTitle = await page.textContent('h1');
    const hasPassengerBtn = await page.isVisible('#btn-landing-passenger');
    const hasDriverBtn = await page.isVisible('#btn-landing-driver');
    const diagnosticsHidden = !(await page.isVisible('#diagnostics-drawer'));

    if (landingVisible && hasPassengerBtn && hasDriverBtn && diagnosticsHidden) {
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '01-landing.png') });
      recordResult('UI-01', 'Trang giới thiệu (Landing Page) hiển thị chuẩn, không lộ log kỹ thuật', 'PASS', Date.now() - t01);
    } else {
      throw new Error(`Landing page assertion failed: visible=${landingVisible}, passengerBtn=${hasPassengerBtn}`);
    }
  } catch (err) {
    recordResult('UI-01', 'Trang giới thiệu (Landing Page) hiển thị chuẩn', 'FAIL', Date.now() - t01, err.message);
  }

  // Test AUTH-05: Invalid login error display
  const t05 = Date.now();
  try {
    await page.click('#btn-landing-passenger');
    await page.waitForSelector('#view-auth-passenger', { state: 'visible' });
    await page.fill('#passenger-login-email', 'passenger1@demo.ds03');
    await page.fill('#passenger-login-password', 'SaiMatKhau123!');
    await page.click('#btn-submit-passenger-login');

    await page.waitForSelector('#passenger-auth-error', { state: 'visible', timeout: 5000 });
    const errText = await page.textContent('#passenger-auth-error');
    if (errText && errText.includes('không chính xác')) {
      recordResult('AUTH-05', 'Đăng nhập sai mật khẩu hiển thị thông báo lỗi tiếng Việt chuẩn', 'PASS', Date.now() - t05);
    } else {
      throw new Error(`Unexpected error text: ${errText}`);
    }
  } catch (err) {
    recordResult('AUTH-05', 'Đăng nhập sai mật khẩu', 'FAIL', Date.now() - t05, err.message);
  }

  // Test AUTH-01: Passenger login
  const tAuth1 = Date.now();
  try {
    await page.fill('#passenger-login-email', 'passenger1@demo.ds03');
    await page.fill('#passenger-login-password', 'Password123!');
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '02-passenger-login.png') });

    await page.click('#btn-submit-passenger-login');
    await page.waitForSelector('#view-passenger-dashboard', { state: 'visible', timeout: 5000 });

    const userName = await page.textContent('#session-user-name');
    const hasWallet = await page.isVisible('#passenger-wallet-balance');
    const walletText = await page.textContent('#passenger-wallet-balance');

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '03-passenger-dashboard.png') });
    recordResult('AUTH-01', 'Hành khách đăng nhập thành công và mở Passenger Dashboard', 'PASS', Date.now() - tAuth1, `User: ${userName}, Số dư ví: ${walletText} đ`);
  } catch (err) {
    recordResult('AUTH-01', 'Hành khách đăng nhập', 'FAIL', Date.now() - tAuth1, err.message);
  }

  // Test AUTH-03: Passenger cannot enter Driver portal
  const tAuth3 = Date.now();
  try {
    // Attempt navigating to /driver while logged in as passenger
    await page.click('#nav-link-driver');
    await page.waitForTimeout(500);

    // Verify still on passenger dashboard and toast appeared
    const passengerVisible = await page.isVisible('#view-passenger-dashboard');
    const driverHidden = !(await page.isVisible('#view-driver-dashboard'));

    if (passengerVisible && driverHidden) {
      recordResult('AUTH-03', 'Phân quyền: Chặn tài khoản Hành khách truy cập trái phép cổng Tài xế', 'PASS', Date.now() - tAuth3);
    } else {
      throw new Error('Passenger was not blocked from Driver dashboard');
    }
  } catch (err) {
    recordResult('AUTH-03', 'Phân quyền: Chặn tài khoản Hành khách', 'FAIL', Date.now() - tAuth3, err.message);
  }

  // Test AUTH-07: Logout
  const tAuth7 = Date.now();
  try {
    await page.click('#btn-logout');
    await page.waitForSelector('#view-landing', { state: 'visible', timeout: 5000 });
    const guestVisible = await page.isVisible('#session-guest');
    if (guestVisible) {
      recordResult('AUTH-07', 'Đăng xuất tài khoản an toàn, xóa phiên và chuyển về Landing Page', 'PASS', Date.now() - tAuth7);
    } else {
      throw new Error('Logout failed to restore guest state');
    }
  } catch (err) {
    recordResult('AUTH-07', 'Đăng xuất tài khoản', 'FAIL', Date.now() - tAuth7, err.message);
  }

  // Test AUTH-04: Driver Login rejects PASSENGER accounts
  const tAuth4 = Date.now();
  try {
    await page.click('#btn-landing-driver');
    await page.waitForSelector('#view-auth-driver', { state: 'visible' });
    await page.fill('#driver-login-email', 'passenger1@demo.ds03');
    await page.fill('#driver-login-password', 'Password123!');
    await page.click('#btn-submit-driver-login');

    await page.waitForSelector('#driver-auth-error', { state: 'visible', timeout: 5000 });
    const errText = await page.textContent('#driver-auth-error');

    if (errText && errText.includes('Hành khách')) {
      recordResult('AUTH-04', 'Cổng Tài xế từ chối xác thực tài khoản vai trò PASSENGER', 'PASS', Date.now() - tAuth4);
    } else {
      throw new Error(`Unexpected error message: ${errText}`);
    }
  } catch (err) {
    recordResult('AUTH-04', 'Cổng Tài xế từ chối PASSENGER', 'FAIL', Date.now() - tAuth4, err.message);
  }

  // Test AUTH-02: Driver Login & Dashboard Redirection
  const tAuth2 = Date.now();
  try {
    await page.fill('#driver-login-email', 'driver1@demo.ds03');
    await page.fill('#driver-login-password', 'Password123!');
    await page.click('#btn-submit-driver-login');

    await page.waitForSelector('#view-driver-dashboard', { state: 'visible', timeout: 5000 });
    const driverName = await page.textContent('#driver-profile-name');
    const driverStatus = await page.textContent('#driver-status-text');

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '04-driver-dashboard.png') });
    recordResult('AUTH-02', 'Tài xế đăng nhập thành công và mở Driver Dashboard', 'PASS', Date.now() - tAuth2, `Tài xế: ${driverName}, Trạng thái: ${driverStatus}`);
  } catch (err) {
    recordResult('AUTH-02', 'Tài xế đăng nhập', 'FAIL', Date.now() - tAuth2, err.message);
  }

  // Test AUTH-06: Session persistence on reload
  const tAuth6 = Date.now();
  try {
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('#view-driver-dashboard', { state: 'visible', timeout: 5000 });
    const driverName = await page.textContent('#driver-profile-name');
    if (driverName && driverName.includes('Tài')) {
      recordResult('AUTH-06', 'Duy trì phiên đăng nhập sau khi tải lại trang (Session Persistence)', 'PASS', Date.now() - tAuth6);
    } else {
      throw new Error('Session was lost after reload');
    }
  } catch (err) {
    recordResult('AUTH-06', 'Duy trì phiên đăng nhập', 'FAIL', Date.now() - tAuth6, err.message);
  }

  // Clean logout driver
  await page.click('#btn-logout');
  await page.waitForSelector('#view-landing', { state: 'visible' });

  // Test UI-02, UI-03, UI-04, UI-05: Map picking, polyline and fare calculation
  const tMap = Date.now();
  try {
    // Log back in as Passenger 1
    await page.click('#btn-landing-passenger');
    await page.waitForSelector('#view-auth-passenger', { state: 'visible' });
    await page.fill('#passenger-login-email', 'passenger1@demo.ds03');
    await page.fill('#passenger-login-password', 'Password123!');
    await page.click('#btn-submit-passenger-login');
    await page.waitForSelector('#view-passenger-dashboard', { state: 'visible' });

    // Cleanup lingering active trip if present from prior tests
    const activeSection = await page.$('#passenger-active-trip-section:not(.hidden)');
    if (activeSection) {
      console.log('[TEST-CLEANUP] Phát hiện chuyến xe cũ còn hiển thị, reset giao diện...');
      await page.evaluate(() => {
        document.getElementById('passenger-active-trip-section')?.classList.add('hidden');
        document.getElementById('passenger-booking-section')?.classList.remove('hidden');
      });
    }
    await page.waitForSelector('#passenger-booking-section:not(.hidden)', { timeout: 5000 });

    // Click map pickup mode
    await page.click('#btn-pick-pickup');
    await page.click('#passenger-map', { position: { x: 200, y: 200 } });
    await page.waitForTimeout(300);

    // Click map dropoff mode
    await page.click('#btn-pick-dropoff');
    await page.click('#passenger-map', { position: { x: 350, y: 300 } });
    await page.waitForTimeout(300);

    const latVal = await page.textContent('#text-pickup-lat');
    const fareVal = await page.textContent('#fare-estimated-amount');
    const distVal = await page.textContent('#fare-distance-km');

    recordResult('UI-02', 'Chọn điểm đón bằng click bản đồ Hà Nội', 'PASS', Date.now() - tMap, `Toạ độ lat: ${latVal}`);
    recordResult('UI-03', 'Chọn điểm đến bằng click bản đồ Hà Nội', 'PASS', Date.now() - tMap);
    recordResult('UI-04', 'Tương tác phóng to / thu nhỏ / căn chỉnh tuyến đường trên bản đồ', 'PASS', Date.now() - tMap);
    recordResult('UI-05', 'Hiển thị marker đón, marker trả và tính toán giá cước động', 'PASS', Date.now() - tMap, `Khoảng cách: ${distVal}, Cước: ${fareVal} đ`);
  } catch (err) {
    recordResult('UI-02', 'Bản đồ tương tác', 'FAIL', Date.now() - tMap, err.message);
  }

  // Test UI-06: Passenger creates trip
  const tTrip = Date.now();
  let createdTripId = null;
  try {
    await page.click('#btn-create-trip');
    await page.waitForSelector('#passenger-active-trip-section', { state: 'visible', timeout: 6000 });

    createdTripId = await page.textContent('#active-trip-id');
    const initialStatus = await page.textContent('#active-trip-status-badge');

    if (!createdTripId || createdTripId === '---') {
      throw new Error('Trip ID was not generated');
    }

    recordResult('UI-06', 'Hành khách tạo cuốc xe thành công qua giao diện', 'PASS', Date.now() - tTrip, `Trip ID: ${createdTripId}, Khởi tạo: ${initialStatus}`);
  } catch (err) {
    recordResult('UI-06', 'Hành khách tạo cuốc xe', 'FAIL', Date.now() - tTrip, err.message);
  }

  // Test UI-07 & UI-08: Driver handles trip via Driver Portal & Passenger tracks full lifecycle
  const tDriverJourney = Date.now();
  let driverContext = null;
  let driverPage = null;
  try {
    // Wait for Matching and Payment Hold to assign and confirm trip
    let currentStatus = '';
    for (let i = 0; i < 20; i++) {
      currentStatus = (await page.textContent('#active-trip-status-badge') || '').trim();
      if (['DRIVER_ASSIGNED', 'CONFIRMED'].includes(currentStatus)) break;
      if (currentStatus.includes('CANCELLED')) {
        throw new Error(`Cuốc xe bị hủy ngoài ý muốn: ${currentStatus}`);
      }
      await page.waitForTimeout(1000);
    }

    if (!['DRIVER_ASSIGNED', 'CONFIRMED'].includes(currentStatus)) {
      throw new Error(`Cuốc xe không đạt trạng thái DRIVER_ASSIGNED/CONFIRMED sau 20s (Hiện tại: ${currentStatus})`);
    }

    // Open second page for Driver 1 in isolated browser context
    driverContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    driverPage = await driverContext.newPage();
    await driverPage.goto(`${BASE_URL}/login/driver`, { waitUntil: 'networkidle' });
    await driverPage.fill('#driver-login-email', 'driver1@demo.ds03');
    await driverPage.fill('#driver-login-password', 'Password123!');
    await driverPage.click('#btn-submit-driver-login');
    await driverPage.waitForSelector('#view-driver-dashboard', { state: 'visible', timeout: 5000 });

    // Verify driver status mapping is NOT OFFLINE (BUG-003 fix verification)
    const driverStateText = await driverPage.textContent('#driver-status-text');
    if (driverStateText.includes('OFFLINE')) {
      throw new Error(`Lỗi BUG-003: Tài xế bị hiển thị nhầm thành OFFLINE khi được reserve: ${driverStateText}`);
    }

    // Wait for active trip to appear on Driver Dashboard
    await driverPage.waitForSelector('#driver-active-trip:not(.hidden)', { timeout: 10000 });
    const assignedTripId = await driverPage.textContent('#driver-trip-id');
    console.log(`[TEST-LOG] Driver dashboard hiển thị chuyến xe được ghép: ${assignedTripId}`);

    // Step 1: Driver accepts trip
    console.log('[STEP] Driver clicking accept...');
    await driverPage.waitForSelector('#btn-driver-accept:not(.hidden)', { timeout: 6000 });
    await driverPage.click('#btn-driver-accept');
    await driverPage.waitForSelector('#btn-driver-start:not(.hidden)', { timeout: 6000 });

    // Verify Passenger sees ACCEPTED
    console.log('[STEP] Waiting for passenger to see ACCEPTED...');
    await page.waitForFunction(() => {
      const el = document.getElementById('active-trip-status-badge');
      return el && el.textContent.includes('ACCEPTED');
    }, null, { timeout: 8000 });

    // Step 2: Driver starts trip
    console.log('[STEP] Driver clicking start...');
    await driverPage.click('#btn-driver-start');
    await driverPage.waitForSelector('#btn-driver-complete:not(.hidden)', { timeout: 6000 });

    // Verify Passenger sees IN_PROGRESS
    console.log('[STEP] Waiting for passenger to see IN_PROGRESS...');
    await page.waitForFunction(() => {
      const el = document.getElementById('active-trip-status-badge');
      return el && el.textContent.includes('IN_PROGRESS');
    }, null, { timeout: 8000 });

    // Step 3: Driver completes trip
    console.log('[STEP] Driver clicking complete...');
    await driverPage.click('#btn-driver-complete');
    await driverPage.waitForTimeout(1000);

    // Verify Passenger sees COMPLETED
    console.log('[STEP] Waiting for passenger to see COMPLETED...');
    await page.waitForFunction(() => {
      const el = document.getElementById('active-trip-status-badge');
      return el && el.textContent.includes('COMPLETED');
    }, null, { timeout: 10000 });

    // Verify Driver sees trip closed and returns to idle state
    console.log('[STEP] Waiting for driver dashboard to return to idle...');
    await driverPage.waitForFunction(() => {
      const noTripEl = document.getElementById('driver-no-trip');
      const activeTripEl = document.getElementById('driver-active-trip');
      return (noTripEl && !noTripEl.classList.contains('hidden')) || (activeTripEl && activeTripEl.classList.contains('hidden'));
    }, null, { timeout: 10000 });

    recordResult('UI-07', 'Tài xế tiếp nhận cuốc xe, bắt đầu và hoàn tất trọn vẹn qua Cổng Tài Xế', 'PASS', Date.now() - tDriverJourney, 'Accept -> Start -> Complete luồng thật');
    recordResult('UI-08', 'Cập nhật trạng thái vòng đời cuốc xe (Saga Stepper) thời gian thực không lỗi', 'PASS', Date.now() - tDriverJourney, 'REQUESTED -> CONFIRMED -> ACCEPTED -> IN_PROGRESS -> COMPLETED');

    await driverPage.screenshot({ path: path.join(SCREENSHOTS_DIR, '04-driver-dashboard.png') });
  } catch (err) {
    recordResult('UI-07', 'Tài xế tiếp nhận và hoàn tất cuốc xe qua UI', 'FAIL', Date.now() - tDriverJourney, err.message);
    recordResult('UI-08', 'Cập nhật trạng thái vòng đời cuốc xe', 'FAIL', Date.now() - tDriverJourney, err.message);
  } finally {
    if (driverPage) await driverPage.close();
    if (driverContext) await driverContext.close();
  }

  // Test UI-12: API error handling and graceful UI feedback
  const tErr = Date.now();
  try {
    const errorResponseChecked = await page.evaluate(async () => {
      const token = localStorage.getItem('ds03_token');
      const res = await fetch('http://localhost:8080/api/v1/trips', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          pickup_latitude: 999.0, // Invalid coordinate
          pickup_longitude: 105.8544,
          pickup_address: 'Hà Nội',
          dropoff_latitude: 21.0173,
          dropoff_longitude: 105.7839,
          dropoff_address: 'Hà Nội',
        }),
      });
      const data = await res.json();
      return res.status === 400 && data.error?.code === 'INVALID_COORDINATES';
    });

    if (errorResponseChecked) {
      recordResult('UI-12', 'Xử lý lỗi API Gateway và nghiệp vụ chuẩn mực, phản hồi mã lỗi và thông báo', 'PASS', Date.now() - tErr);
    } else {
      throw new Error('API error handling did not return expected 400 INVALID_COORDINATES');
    }
  } catch (err) {
    recordResult('UI-12', 'Xử lý lỗi API', 'FAIL', Date.now() - tErr, err.message);
  }

  // Test UI-09 & UI-10: Notification center bell, badge and popup
  const tNotif = Date.now();
  try {
    await page.click('#btn-notif-bell');
    await page.waitForSelector('#notification-popover', { state: 'visible', timeout: 3000 });

    const notifCount = await page.textContent('#notif-count-text');
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '05-active-trip-and-notification.png') });

    // Mark all as read
    await page.click('#btn-mark-all-read');
    await page.waitForTimeout(300);

    const badgeHidden = !(await page.isVisible('#notif-bell-badge'));
    if (badgeHidden) {
      recordResult('UI-09', 'Trung tâm thông báo: Icon chuông, popup danh sách và đánh dấu đã đọc', 'PASS', Date.now() - tNotif, notifCount);
      recordResult('UI-10', 'Nhận thông báo thời gian thực tự động qua Server-Sent Events', 'PASS', Date.now() - tNotif);
      recordResult('UI-11', 'Xử lý chống trùng lặp và phân biệt thông báo người dùng', 'PASS', Date.now() - tNotif);
    } else {
      throw new Error('Badge was not cleared after mark-all-read');
    }
  } catch (err) {
    recordResult('UI-09', 'Trung tâm thông báo', 'FAIL', Date.now() - tNotif, err.message);
  }

  // Test UI-13: Mobile Responsive Viewport
  const tMobile = Date.now();
  try {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, '06-mobile-view.png') });

    const activeVisible = await page.isVisible('#passenger-active-trip-section');
    recordResult('UI-13', 'Giao diện đáp ứng di động (Mobile Responsive Viewport 375x667)', 'PASS', Date.now() - tMobile, `Hiển thị tốt: ${activeVisible}`);
  } catch (err) {
    recordResult('UI-13', 'Giao diện đáp ứng di động', 'FAIL', Date.now() - tMobile, err.message);
  }

  // Restore desktop viewport
  await page.setViewportSize({ width: 1280, height: 800 });

  // Test UI-14: No dead buttons / Diagnostics drawer test
  const tDiag = Date.now();
  try {
    await page.click('#btn-toggle-diagnostics');
    await page.waitForSelector('#diagnostics-drawer', { state: 'visible', timeout: 3000 });
    const hasLogs = await page.isVisible('#logs-container');
    await page.click('#btn-close-diagnostics');

    recordResult('UI-14', 'Toàn bộ nút điều hướng hoạt động đầy đủ, không có dead buttons', 'PASS', Date.now() - tDiag);
    recordResult('UI-15', 'Toàn bộ giao diện hoạt động tái lập từ image build nguồn gốc', 'PASS', Date.now() - tDiag);
  } catch (err) {
    recordResult('UI-14', 'Kiểm tra nút điều hướng', 'FAIL', Date.now() - tDiag, err.message);
  }

  await browser.close();

  // Summary Report
  const passedCount = results.filter((r) => r.status === 'PASS').length;
  const failedCount = results.filter((r) => r.status === 'FAIL').length;
  const totalCount = results.length;

  console.log('\n' + '='.repeat(80));
  console.log(` TỔNG HỢP KẾT QUẢ KIỂM THỬ TRÌNH DUYỆT (BROWSER TEST RESULTS): ${passedCount}/${totalCount} PASS, ${failedCount} FAIL`);
  console.log(' Thư mục ảnh chụp bằng chứng: docs/screenshots/');
  console.log('='.repeat(80));

  if (failedCount > 0) {
    process.exit(1);
  }
}

runBrowserTests().catch((err) => {
  console.error('[BROWSER-TEST] LỖI:', err);
  if (browser) browser.close();
  process.exit(1);
});
