'use strict';

const { chromium } = require('playwright');

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  page.on('console', msg => console.log(`[BROWSER CONSOLE] ${msg.type()}: ${msg.text()}`));
  page.on('pageerror', err => console.error(`[BROWSER ERROR] ${err.message}`));

  console.log('1. Navigating to http://localhost:3000/ ...');
  await page.goto('http://localhost:3000/', { waitUntil: 'networkidle' });

  // Login as passenger1
  console.log('2. Logging in as passenger1@demo.ds03...');
  await page.click('#btn-landing-passenger');
  await page.waitForSelector('#passenger-login-email', { state: 'visible' });
  await page.fill('#passenger-login-email', 'passenger1@demo.ds03');
  await page.fill('#passenger-login-password', 'Password123!');
  await page.click('#btn-submit-passenger-login');
  await page.waitForSelector('#view-passenger-dashboard', { state: 'visible' });

  // Test BUG-002: Check map dragging
  console.log('\n--- TESTING BUG-002: Map Pan / Drag ---');
  const mapBox = await page.locator('#passenger-map').boundingBox();
  console.log('Map bounding box:', mapBox);

  // Read initial pane transform
  const initialTransform = await page.evaluate(() => {
    const pane = document.querySelector('#passenger-map .leaflet-map-pane');
    return pane ? pane.style.transform : 'none';
  });
  console.log('Initial Map Pane Transform:', initialTransform);

  const startX = mapBox.x + mapBox.width / 2;
  const startY = mapBox.y + mapBox.height / 2;
  console.log(`Dragging from (${startX}, ${startY}) to (${startX + 200}, ${startY + 150})...`);

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 200, startY + 150, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(500);

  const afterTransform = await page.evaluate(() => {
    const pane = document.querySelector('#passenger-map .leaflet-map-pane');
    return pane ? pane.style.transform : 'none';
  });
  console.log('After Drag Map Pane Transform:', afterTransform);
  console.log('Did transform change?', initialTransform !== afterTransform);

  // Test BUG-001: Try booking trip
  console.log('\n--- TESTING BUG-001: Passenger Booking ---');
  // Click create trip
  await page.click('#btn-create-trip');
  await page.waitForTimeout(2000);

  const tripId = await page.textContent('#active-trip-id');
  const tripBadge = await page.textContent('#active-trip-status-badge');
  console.log(`Trip created: ID=${tripId}, Initial Status=${tripBadge}`);

  // Wait 4 seconds to observe Saga resolution
  await page.waitForTimeout(4000);
  const afterStatus = await page.textContent('#active-trip-status-badge');
  console.log(`Trip status after 4s: ${afterStatus}`);

  // Test BUG-004: Layering check for notification popover & diagnostics
  console.log('\n--- TESTING BUG-004: Layering of Popover & Diagnostics ---');
  await page.click('#btn-notif-bell');
  await page.waitForTimeout(300);
  const popoverBox = await page.locator('#notification-popover').boundingBox();
  const headerZ = await page.evaluate(() => {
    const header = document.querySelector('header');
    const popover = document.getElementById('notification-popover');
    const map = document.getElementById('passenger-map');
    return {
      headerZIndex: window.getComputedStyle(header).zIndex,
      headerPosition: window.getComputedStyle(header).position,
      popoverZIndex: window.getComputedStyle(popover).zIndex,
      mapZIndex: window.getComputedStyle(map).zIndex,
      mapPanesZ: Array.from(map.querySelectorAll('.leaflet-pane')).map(p => ({
        cls: p.className,
        z: window.getComputedStyle(p).zIndex
      }))
    };
  });
  console.log('Z-Index analysis:', headerZ);

  // Test BUG-003: Driver RESERVED status check
  console.log('\n--- TESTING BUG-003: Driver State Mapping ---');
  await page.goto('http://localhost:3000/login/driver', { waitUntil: 'networkidle' });
  await page.fill('#driver-login-email', 'driver1@demo.ds03');
  await page.fill('#driver-login-password', 'Password123!');
  await page.click('#btn-submit-driver-login');
  await page.waitForSelector('#view-driver-dashboard', { state: 'visible' });

  const initialDriverStatus = await page.textContent('#driver-status-text');
  const toggleBtnText = await page.textContent('#btn-toggle-driver-status');
  console.log(`Driver initial status on UI: ${initialDriverStatus}, Button: ${toggleBtnText}`);

  await browser.close();
  console.log('\nReproduction test finished.');
}

main().catch(console.error);
