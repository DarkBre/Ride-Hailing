import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { Pool } from 'pg';
import { brokerLoop } from './broker';
import { event, Matching, uuid } from './matching';

export function matchingServer(matching: Matching, key: string, ready: () => boolean) {
  return createServer({ requestTimeout: 10_000, headersTimeout: 5000 }, async (req, res) => {
    const reply = (status: number, data: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    try {
      if (req.method === 'GET' && req.url === '/live') return reply(200, { status: 'live' });
      if (req.method === 'GET' && ['/health', '/ready'].includes(req.url ?? '')) {
        await matching.pool.query('SELECT 1');
        return reply(ready() ? 200 : 503, { database: 'ready', rabbitmq: ready() ? 'ready' : 'unavailable' });
      }
      const supplied = req.headers['x-internal-key'];
      if (typeof supplied !== 'string' || Buffer.byteLength(supplied) !== Buffer.byteLength(key) ||
          !timingSafeEqual(Buffer.from(supplied), Buffer.from(key))) {
        return reply(401, { error: 'UNAUTHORIZED' });
      }
      if (req.method === 'POST' && req.url === '/internal/events') {
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const chunk of req.iterator({ destroyOnReturn: false })) {
          length += chunk.length;
          if (length > 16_384) {
            req.resume();
            return reply(413, { error: 'PAYLOAD_TOO_LARGE' });
          }
          chunks.push(chunk);
        }
        let parsed;
        try {
          parsed = event(JSON.parse(Buffer.concat(chunks).toString()));
        } catch {
          return reply(400, { error: 'INVALID_EVENT' });
        }
        await matching.receive(parsed);
        return reply(202, { accepted: true });
      }
      const tripId = req.url?.match(/^\/internal\/matches\/([^/?]+)$/)?.[1];
      if (req.method === 'GET' && tripId && uuid.test(tripId)) {
        const { rows } = await matching.pool.query(
          'SELECT trip_id, state, attempts, result FROM matching_requests WHERE trip_id = $1', [tripId]);
        return rows[0] ? reply(200, rows[0]) : reply(404, { error: 'NOT_FOUND' });
      }
      return reply(404, { error: 'NOT_FOUND' });
    } catch {
      return reply(503, { error: 'SERVICE_UNAVAILABLE' });
    }
  });
}

function required(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`Missing ${name}`);
  return value;
}

function positive(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid ${name}`);
  return value;
}

async function start() {
  const brokerUrl = required('RABBITMQ_URL');
  const key = required('MATCHING_INTERNAL_KEY');
  const port = positive('MATCHING_SERVICE_PORT', 8004);
  const settings = {
    driverUrl: required('DRIVER_URL'), driverKey: required('DRIVER_INTERNAL_KEY'),
    tripKey: required('DRIVER_TRIP_KEY'), radiusKm: positive('MATCHING_RADIUS_KM', 5),
    maxAgeMs: positive('DRIVER_LOCATION_MAX_AGE_MS', 60_000),
    matchingTimeoutMs: positive('MATCHING_TIMEOUT_MS', 30_000),
  };
  const pool = new Pool({
    database: process.env.MATCHING_DB_NAME ?? 'match_db', host: required('POSTGRES_HOST'),
    port: positive('POSTGRES_PORT', 5432), user: required('POSTGRES_USER'), password: required('POSTGRES_PASSWORD'),
    connectionTimeoutMillis: 3000, statement_timeout: 5000,
  });
  pool.on('error', () => console.error('matching-service: PostgreSQL idle connection lost'));
  try {
    await pool.query(await readFile(resolve(__dirname, '../schema.sql'), 'utf8'));
  } catch {
    await pool.end();
    throw new Error('Matching database initialization failed');
  }
  const matching = new Matching(pool, settings);
  const stop = new AbortController();
  let ready = false;
  const server = matchingServer(matching, key, () => ready);
  server.listen(port, () => console.log(`matching-service listening on ${port}`));
  const broker = brokerLoop(matching, brokerUrl, process.env.RABBITMQ_EXCHANGE ?? 'trip.exchange',
    process.env.RABBITMQ_DLX ?? 'trip.dlx', process.env.RABBITMQ_DLQ ?? 'trip.dlq',
    stop.signal, value => { ready = value; });
  const worker = (async () => {
    while (!stop.signal.aborted) {
      try {
        await matching.runOnce();
      } catch {
        console.error('matching-service: matching job failed');
      }
      await pause(150, undefined, { signal: stop.signal }).catch(() => {});
    }
  })();
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      stop.abort();
      server.close(() => void Promise.allSettled([broker, worker]).then(() => pool.end()));
    });
  }
}

if (require.main === module) {
  start().catch(() => {
    console.error('matching-service: startup failed');
    process.exitCode = 1;
  });
}
