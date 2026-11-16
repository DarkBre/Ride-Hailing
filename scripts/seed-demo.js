'use strict';

/**
 * Seed tài khoản demo cho Dashboard:
 * - Đăng ký/đăng nhập Passenger 1, Passenger 2, Passenger 0đ và Driver qua Identity.
 * - Nạp ví demo qua Payment bằng chính JWT của người dùng.
 * - Tạo hồ sơ Driver trong driver_db bằng psql qua Docker Compose
 *   (TV2 hiện chưa cung cấp POST /drivers để tạo profile).
 *
 * Chạy: node scripts/seed-demo.js
 */

const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const path = require('node:path');

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:8080';
const COMPOSE_FILE = path.join(__dirname, '..', 'deploy', 'docker-compose.yml');

const ACCOUNTS = [
  {
    key: 'passenger1',
    email: 'passenger1@demo.ds03',
    password: 'Password123!',
    name: 'Nguyễn Văn A',
    phone: '0900000001',
    role: 'PASSENGER',
    topup: 300000,
  },
  {
    key: 'passenger2',
    email: 'passenger2@demo.ds03',
    password: 'Password123!',
    name: 'Trần Thị B',
    phone: '0900000002',
    role: 'PASSENGER',
    topup: 300000,
  },
  {
    key: 'passengerZero',
    email: 'passenger0@demo.ds03',
    password: 'Password123!',
    name: 'Lê Văn C',
    phone: '0900000003',
    role: 'PASSENGER',
    topup: 0,
  },
  {
    key: 'driver1',
    email: 'driver1@demo.ds03',
    password: 'Password123!',
    name: 'Nguyễn Văn Tài',
    phone: '0900000004',
    role: 'DRIVER',
    topup: 0,
  },
  {
    key: 'driver2',
    email: 'driver2@demo.ds03',
    password: 'Password123!',
    name: 'Lê Văn Lái',
    phone: '0900000005',
    role: 'DRIVER',
    topup: 0,
  },
];

async function request(pathname, { method = 'GET', body = null, token = null } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${GATEWAY_URL}${pathname}`, {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const text = await response.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch (_) {
    json = { raw: text };
  }
  return { status: response.status, ok: response.ok, json };
}

async function ensureAccount(account) {
  const registered = await request('/api/v1/auth/register', {
    method: 'POST',
    body: {
      email: account.email,
      password: account.password,
      name: account.name,
      phone: account.phone,
      role: account.role,
    },
  });

  if (registered.ok) {
    console.log(`[seed] Đã tạo ${account.role}: ${account.email}`);
  } else if (registered.status === 409) {
    console.log(`[seed] Tài khoản đã tồn tại: ${account.email}`);
  } else {
    throw new Error(`Đăng ký ${account.email} thất bại: ${JSON.stringify(registered.json)}`);
  }

  const login = await request('/api/v1/auth/login', {
    method: 'POST',
    body: { email: account.email, password: account.password },
  });
  if (!login.ok || !login.json.data?.token) {
    throw new Error(`Đăng nhập ${account.email} thất bại: ${JSON.stringify(login.json)}`);
  }

  return {
    ...account,
    token: login.json.data.token,
    user: login.json.data.user,
  };
}

async function topup(account) {
  if (!account.topup || account.topup <= 0) {
    console.log(`[seed] Bỏ qua nạp ví cho ${account.email} (mục tiêu 0đ để test Saga).`);
    return;
  }
  const response = await request('/api/v1/payments/topup', {
    method: 'POST',
    token: account.token,
    body: { amount: account.topup },
  });
  if (!response.ok) {
    throw new Error(`Nạp ví ${account.email} thất bại: ${JSON.stringify(response.json)}`);
  }
  console.log(`[seed] Đã nạp ${account.topup.toLocaleString('vi-VN')} đ cho ${account.email}`);
}

function getDockerCmd() {
  const candidates = [
    'docker',
    'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe',
  ];
  for (const cmd of candidates) {
    try {
      execFileSync(cmd, ['--version'], { stdio: 'ignore' });
      return cmd;
    } catch (_) {}
  }
  return 'docker';
}

function seedDriverProfile(driver) {
  if (!driver || !driver.user?.id) return;
  const plate = driver.key === 'driver2' ? '29A-999.99' : '29A-888.88';
  const model = driver.key === 'driver2' ? 'Hyundai Accent' : 'Toyota Vios';
  const lat = driver.key === 'driver2' ? 21.0900 : 21.0285;
  const lon = driver.key === 'driver2' ? 105.8200 : 105.8544;

  const sql = `
INSERT INTO drivers (id, user_id, name, vehicle_plate, vehicle_model, latitude, longitude, status, version, location_updated_at, updated_at)
VALUES (
  '${randomUUID()}', '${driver.user.id}', '${driver.name.replace(/'/g, "''")}', '${plate}', '${model}',
  ${lat}, ${lon}, 'AVAILABLE', 1, NOW(), NOW()
)
ON CONFLICT (user_id) DO UPDATE SET
  name = EXCLUDED.name,
  vehicle_plate = EXCLUDED.vehicle_plate,
  vehicle_model = EXCLUDED.vehicle_model,
  latitude = EXCLUDED.latitude,
  longitude = EXCLUDED.longitude,
  status = 'AVAILABLE',
  location_updated_at = NOW(),
  updated_at = NOW();`;

  try {
    const envFile = path.join(__dirname, '..', '.env');
    const dockerCmd = getDockerCmd();
    execFileSync(
      dockerCmd,
      ['compose', '--env-file', envFile, '-f', COMPOSE_FILE, 'exec', '-T', 'postgres', 'psql', '-U', process.env.POSTGRES_USER || 'postgres', '-d', 'driver_db', '-v', 'ON_ERROR_STOP=1', '-c', sql],
      { stdio: 'inherit' }
    );
    console.log(`[seed] Đã tạo/cập nhật hồ sơ ${driver.name} (${driver.email}) trong driver_db.`);
  } catch (err) {
    console.warn(`[seed] Không thể seed Driver ${driver.email} qua Docker: ${err.message}`);
  }
}

function cleanupLingeringTrips() {
  try {
    const dockerCmd = getDockerCmd();
    const js = "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync('data/trip_db.sqlite'); db.exec(\"UPDATE trips SET status = 'CANCELLED' WHERE status NOT IN ('COMPLETED', 'CANCELLED');\");";
    execFileSync(dockerCmd, ['exec', '-i', 'ds03-trip', 'node', '-e', js]);
    console.log('[seed] Đã dọn dẹp các chuyến xe dở dang cũ trong ds03-trip.');
  } catch (err) {
    console.warn('[seed] Không thể dọn dẹp chuyến xe trong ds03-trip:', err.message);
  }
}

async function main() {
  console.log('='.repeat(70));
  console.log(' DS03 DEMO SEED — Gateway:', GATEWAY_URL);
  console.log('='.repeat(70));

  cleanupLingeringTrips();

  const accounts = [];
  for (const account of ACCOUNTS) {
    accounts.push(await ensureAccount(account));
  }

  for (const account of accounts) {
    await topup(account);
  }

  const drivers = accounts.filter((account) => account.role === 'DRIVER');
  for (const drv of drivers) {
    seedDriverProfile(drv);
  }

  console.log('\n[seed] Hoàn tất. Tài khoản demo:');
  for (const account of accounts) {
    console.log(`  - ${account.role.padEnd(9)} ${account.email} / ${account.password} (id=${account.user?.id || 'n/a'})`);
  }
}

main().catch((err) => {
  console.error('[seed] LỖI:', err.message);
  process.exit(1);
});
