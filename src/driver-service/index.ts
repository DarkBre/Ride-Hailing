import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, IncomingMessage } from 'node:http';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { expireReservations, reserve, transition } from './reservations';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const profileFields = 'user_id, name, vehicle_plate, vehicle_model';
const driverFields = 'id, latitude, longitude, status, updated_at, location_updated_at';

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function driverIdentity(req: IncomingMessage, jwtSecret: string): string {
  const token = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i);
  if (!token) throw new HttpError(401, 'UNAUTHORIZED', 'Yêu cầu JWT hợp lệ');
  const [header, body, signature] = token[1].split('.');
  let claims;
  try {
    const expected = createHmac('sha256', jwtSecret).update(`${header}.${body}`).digest('base64url');
    if (!equal(signature, expected)) throw new Error();
    if (JSON.parse(Buffer.from(header, 'base64url').toString()).alg !== 'HS256') throw new Error();
    claims = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!Number.isFinite(claims.exp) || claims.exp <= Date.now() / 1000) throw new Error();
    const issuer = process.env.JWT_ISSUER?.trim();
    const audience = process.env.JWT_AUDIENCE?.trim();
    if ((issuer && claims.iss !== issuer) || (audience && claims.aud !== audience)) throw new Error();
  } catch {
    throw new HttpError(401, 'UNAUTHORIZED', 'Yêu cầu JWT hợp lệ');
  }
  if (claims.role !== 'DRIVER') throw new HttpError(403, 'FORBIDDEN', 'Yêu cầu vai trò DRIVER');
  const userId = claims.user_id ?? claims.userId;
  if (typeof userId !== 'string' || !uuid.test(userId) ||
      (claims.user_id && claims.userId && claims.user_id !== claims.userId)) {
    throw new HttpError(401, 'UNAUTHORIZED', 'JWT thiếu định danh hợp lệ');
  }
  return userId;
}

async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > 4096) {
      req.resume();
      throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Payload vượt giới hạn');
    }
    chunks.push(chunk);
  }
  try {
    const result = JSON.parse(Buffer.concat(chunks).toString());
    if (result && typeof result === 'object' && !Array.isArray(result)) return result;
  } catch {
    // Return the same response for malformed JSON and unsupported payload shapes.
  }
  throw new HttpError(400, 'INVALID_BODY', 'Yêu cầu JSON object');
}

function coordinate(value: unknown, limit: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit;
}

function queryNumber(url: URL, name: string): number {
  const value = url.searchParams.get(name);
  return value?.trim() ? Number(value) : NaN;
}

interface Settings {
  jwtSecret: string;
  internalKey: string;
  locationMinIntervalMs: number;
  locationMaxAgeMs: number;
  reservationTtlMs?: number;
  tripKey?: string;
  identityUrl?: string;
  identityKey?: string;
}

export function driverServer(pool: Pool, settings: Settings) {
  return createServer({ requestTimeout: 10_000, headersTimeout: 5_000 }, async (req, res) => {
    const suppliedId = req.headers['x-correlation-id'];
    const correlationId = typeof suppliedId === 'string' && /^[\w.-]{1,100}$/.test(suppliedId)
      ? suppliedId : randomUUID();
    const send = (status: number, data: unknown, error: { code: string; message: string } | null = null) => {
      res.writeHead(status, { 'content-type': 'application/json', 'x-correlation-id': correlationId });
      res.end(JSON.stringify({
        success: !error, data, error, meta: { correlation_id: correlationId, timestamp: new Date().toISOString() },
      }));
    };
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/live') return send(200, { status: 'live' });
      if (req.method === 'GET' && ['/health', '/ready'].includes(url.pathname)) {
        await pool.query('SELECT 1');
        return send(200, { status: 'ready' });
      }
      if (url.pathname.startsWith('/internal/')) {
        const key = req.headers['x-internal-key'];
        const path = url.pathname;
        const action = path.match(/^\/internal\/reservations\/(confirm|release)$/)?.[1];
        const expectedKey = action ? settings.tripKey : settings.internalKey;
        if (!expectedKey || typeof key !== 'string' || !equal(key, expectedKey)) {
          throw new HttpError(401, 'UNAUTHORIZED', 'Yêu cầu xác thực service');
        }
        if (req.method === 'GET' && path === '/internal/candidates') {
          const { rows } = await pool.query(`
            SELECT id, latitude, longitude, version, status,
              extract(epoch FROM location_updated_at)::float8 * 1000 AS "locationUpdatedAtMs"
            FROM drivers WHERE status = 'AVAILABLE'
              AND latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180
              AND location_updated_at >= statement_timestamp() - $1::float8 * interval '1 millisecond'`,
          [settings.locationMaxAgeMs]);
          return send(200, rows);
        }
        if (req.method === 'POST' && (path === '/internal/reservations' || action)) {
          const body = await jsonBody(req);
          const tripId = body.trip_id;
          const validId = (value: unknown): value is string => typeof value === 'string' && uuid.test(value);
          if (!validId(tripId)) throw new HttpError(400, 'INVALID_TRIP', 'trip_id không hợp lệ');
          if (action === 'confirm' || action === 'release') {
            const reservationId = body.reservation_id;
            const driverId = body.driver_id;
            if ((action === 'confirm' && !validId(reservationId)) ||
                (reservationId !== undefined && !validId(reservationId)) ||
                (driverId !== undefined && !validId(driverId))) {
              throw new HttpError(400, 'INVALID_RESERVATION', 'Định danh reservation không hợp lệ');
            }
            const result = await transition(pool, tripId, action, reservationId, driverId);
            if (!result) throw new HttpError(404, 'RESERVATION_NOT_FOUND', 'Không tìm thấy reservation của chuyến');
            return send(200, result);
          }
          const candidates = body.candidates;
          if (!Array.isArray(candidates) || candidates.length > 50 ||
              candidates.some(candidate => !validId(candidate?.id) ||
                !Number.isInteger(candidate.version) || candidate.version < 1 || candidate.version > 2147483647)) {
            throw new HttpError(400, 'INVALID_CANDIDATES', 'Danh sách ứng viên không hợp lệ');
          }
          const result = await reserve(pool, tripId, candidates, settings.locationMaxAgeMs,
            settings.reservationTtlMs ?? 30_000);
          console.info(JSON.stringify({
            service: 'driver-service', event: 'reservation', timestamp: new Date().toISOString(),
            correlation_id: correlationId, trip_id: tripId, result: result?.state ?? 'NO_DRIVER',
          }));
          return send(200, result);
        }
      }
      if (req.method === 'GET' && url.pathname === '/drivers/nearby') {
        const key = req.headers['x-internal-key'];
        if (typeof key !== 'string' || !equal(key, settings.internalKey)) {
          throw new HttpError(401, 'UNAUTHORIZED', 'Yêu cầu xác thực service');
        }
        const latitude = queryNumber(url, 'lat');
        const longitude = queryNumber(url, 'lon');
        const radius = queryNumber(url, 'radius_km');
        if (!coordinate(latitude, 90) || !coordinate(longitude, 180) || !Number.isFinite(radius) || radius <= 0) {
          throw new HttpError(400, 'INVALID_LOCATION', 'Tọa độ hoặc bán kính không hợp lệ');
        }
        // This read-only projection satisfies the nearby contract. It grants no assignment.
        const { rows } = await pool.query(`
          SELECT id, user_id, latitude, longitude, version, location_updated_at, distance_km FROM (
            SELECT id, user_id, latitude, longitude, version, location_updated_at, 12742 * asin(sqrt(least(1.0, greatest(0.0,
              power(sin(radians(latitude - $1::float8) / 2), 2)
              + cos(radians($1::float8)) * cos(radians(latitude))
              * power(sin(radians(longitude - $2::float8) / 2), 2)
            )))) AS distance_km
            FROM drivers
            WHERE status = 'AVAILABLE'
              AND latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180
              AND location_updated_at >= statement_timestamp() - $4::float8 * interval '1 millisecond'
          ) AS nearby
          WHERE distance_km <= $3
          ORDER BY distance_km, id`, [latitude, longitude, radius, settings.locationMaxAgeMs]);
        return send(200, rows);
      }
      const path = url.pathname;
      const getProfile = req.method === 'GET' && path === '/drivers/me';
      const saveProfile = req.method === 'POST' && path === '/drivers';
      const updatePositionOrStatus = req.method === 'PUT' && ['/drivers/location', '/drivers/status'].includes(path);
      if (!getProfile && !saveProfile && !updatePositionOrStatus) {
        throw new HttpError(404, 'NOT_FOUND', 'Không tìm thấy API');
      }
      const userId = driverIdentity(req, settings.jwtSecret);
      if (settings.identityUrl && settings.identityKey) {
        let verified: boolean;
        try {
          const response = await fetch(new URL('/internal/verify-token', settings.identityUrl), {
            method: 'POST', signal: AbortSignal.timeout(2000),
            headers: { 'content-type': 'application/json', 'x-internal-key': settings.identityKey,
              'x-correlation-id': correlationId },
            body: JSON.stringify({ token: req.headers.authorization!.slice(7) }),
          });
          if (response.status >= 500) throw new Error('Identity unavailable');
          const identity = response.ok ? (await response.json()).data : null;
          verified = identity?.valid === true && identity.user?.id === userId && identity.user.role === 'DRIVER';
        } catch {
          throw new HttpError(503, 'IDENTITY_UNAVAILABLE', 'Không thể kiểm tra phiên đăng nhập');
        }
        if (!verified) throw new HttpError(401, 'UNAUTHORIZED', 'Phiên đăng nhập không hợp lệ');
      }
      if (getProfile) {
        const { rows } = await pool.query(
          `SELECT ${driverFields}, ${profileFields} FROM drivers WHERE user_id = $1`, [userId]);
        if (!rows[0]) throw new HttpError(404, 'DRIVER_NOT_FOUND', 'Không tìm thấy hồ sơ tài xế');
        return send(200, rows[0]);
      }
      const body = await jsonBody(req);
      if (saveProfile) {
        const { name, vehicle_plate: plate, vehicle_model: model } = body;
        const valid = (value: unknown, max: number): value is string =>
          typeof value === 'string' && value.trim().length > 0 && Array.from(value.trim()).length <= max && !value.includes('\0');
        if (!valid(name, 255) || !valid(plate, 50) || (model != null && !valid(model, 100))) {
          throw new HttpError(400, 'INVALID_DRIVER_PROFILE', 'Tên hoặc thông tin xe không hợp lệ');
        }
        const { rows } = await pool.query(`
          INSERT INTO drivers (user_id, name, vehicle_plate, vehicle_model, status, latitude, longitude)
          VALUES ($1, $2, $3, $4, 'OFFLINE', NULL, NULL)
          ON CONFLICT (user_id) DO UPDATE SET name = EXCLUDED.name, vehicle_plate = EXCLUDED.vehicle_plate,
            vehicle_model = CASE WHEN $5 THEN EXCLUDED.vehicle_model ELSE drivers.vehicle_model END
          RETURNING ${driverFields}, ${profileFields}`,
        [userId, name.trim(), plate.trim(), typeof model === 'string' ? model.trim() : null, model !== undefined]);
        return send(200, rows[0]);
      }
      const updatingLocation = url.pathname === '/drivers/location';
      if (updatingLocation) {
        if (!coordinate(body.latitude, 90) || !coordinate(body.longitude, 180)) {
          throw new HttpError(400, 'INVALID_LOCATION', 'Tọa độ không hợp lệ');
        }
      } else {
        if (body.status === 'BUSY' || body.status === 'RESERVED') {
          throw new HttpError(403, 'FORBIDDEN', 'Trạng thái do luồng gán chuyến quản lý');
        }
        if (body.status !== 'OFFLINE' && body.status !== 'AVAILABLE') {
          throw new HttpError(400, 'INVALID_STATUS', 'Trạng thái không hợp lệ');
        }
      }
      const client = await pool.connect();
      let discard = false;
      try {
        await client.query('BEGIN');
        const current = await client.query(
          'SELECT id, status, version FROM drivers WHERE user_id = $1 FOR UPDATE', [userId],
        );
        if (!current.rowCount) throw new HttpError(404, 'DRIVER_NOT_FOUND', 'Không tìm thấy hồ sơ tài xế');
        const { id, status, version } = current.rows[0];
        if (!updatingLocation && (status === 'BUSY' || status === 'RESERVED')) {
          throw new HttpError(409, 'DRIVER_ALREADY_BUSY', 'Tài xế đang được gán chuyến');
        }
        const result = updatingLocation
          ? await client.query(`
              UPDATE drivers SET latitude = $3, longitude = $4,
                location_updated_at = statement_timestamp(), updated_at = statement_timestamp(), version = version + 1
              WHERE id = $1 AND version = $2 AND (
                location_updated_at IS NULL OR
                location_updated_at <= statement_timestamp() - $5::float8 * interval '1 millisecond'
              )
              RETURNING ${driverFields}`, [id, version, body.latitude, body.longitude, settings.locationMinIntervalMs])
          : await client.query(`
              UPDATE drivers SET status = $3, updated_at = statement_timestamp(), version = version + 1
              WHERE id = $1 AND version = $2 RETURNING ${driverFields}`, [id, version, body.status]);
        if (result.rowCount !== 1) {
          if (updatingLocation) {
            res.setHeader('retry-after', Math.ceil(settings.locationMinIntervalMs / 1000));
            throw new HttpError(429, 'LOCATION_RATE_LIMIT', 'Cập nhật vị trí quá thường xuyên');
          }
          throw new HttpError(409, 'VERSION_CONFLICT', 'Hồ sơ tài xế vừa thay đổi');
        }
        await client.query('COMMIT');
        return send(200, result.rows[0]);
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          discard = true;
        }
        throw error;
      } finally {
        client.release(discard);
      }
    } catch (error) {
      if (error instanceof HttpError) return send(error.status, null, { code: error.code, message: error.message });
      console.error(JSON.stringify({ service: 'driver-service', event: 'request_failed', correlation_id: correlationId }));
      return send(503, null, { code: 'SERVICE_UNAVAILABLE', message: 'Driver Service tạm thời không khả dụng' });
    }
  });
}

function required(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`Missing configuration ${name}`);
  return value;
}

function positiveInt(name: string, fallback?: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid configuration ${name}`);
  return value;
}

async function start() {
  const port = positiveInt('DRIVER_SERVICE_PORT', 8002);
  const identityUrl = process.env.IDENTITY_URL?.trim();
  const settings = {
    identityUrl,
    identityKey: identityUrl ? required('INTERNAL_KEY') : undefined,
    jwtSecret: required('JWT_SECRET'),
    internalKey: required('DRIVER_INTERNAL_KEY'),
    tripKey: required('DRIVER_TRIP_KEY'),
    reservationTtlMs: positiveInt('DRIVER_RESERVATION_TTL_MS', 30_000),
    locationMinIntervalMs: positiveInt('DRIVER_LOCATION_MIN_INTERVAL_MS', 1000),
    locationMaxAgeMs: positiveInt('DRIVER_LOCATION_MAX_AGE_MS', 60_000),
  };
  const pool = new Pool({
    database: process.env.DRIVER_DB_NAME ?? 'driver_db',
    host: required('POSTGRES_HOST'),
    port: positiveInt('POSTGRES_PORT', 5432),
    user: required('POSTGRES_USER'),
    password: required('POSTGRES_PASSWORD'),
    connectionTimeoutMillis: 3000,
    statement_timeout: 5000,
  });
  pool.on('error', () => console.error('driver-service: PostgreSQL idle connection lost'));
  try {
    await pool.query(await readFile(resolve(__dirname, '../schema.sql'), 'utf8'));
    const server = driverServer(pool, settings);
    const expiryWorker = setInterval(() => {
      void expireReservations(pool).catch(() => console.error('driver-service: expiry failed'));
    }, 1000);
    expiryWorker.unref();
    server.listen(port, () => console.log(`driver-service listening on ${port}`));
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.once(signal, () => {
        clearInterval(expiryWorker);
        server.close(() => void pool.end());
      });
    }
  } catch {
    await pool.end();
    throw new Error('Driver database initialization failed');
  }
}

if (require.main === module) {
  start().catch(() => {
    console.error('driver-service: startup failed');
    process.exitCode = 1;
  });
}
