import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { Candidate, rankCandidates } from './geo';

export const created = 'trip.event.created';
export const released = 'trip.event.release_driver';
export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type Envelope = {
  event_id: string;
  event_type: string;
  timestamp: string;
  source_service: string;
  version: '1.0';
  correlation_id: string;
  causation_id?: string;
  aggregate_id?: string;
  payload: {
    trip_id: string;
    passenger_id?: string;
    pickup_latitude?: number;
    pickup_longitude?: number;
    estimated_fare?: number;
    driver_id?: string;
    reservation_id?: string;
  };
};

export function event(value: unknown): Envelope {
  const data = value as Envelope;
  const p = data?.payload;
  if (!p || ![created, released].includes(data.event_type) || data.source_service !== 'trip-service' ||
      data.version !== '1.0' || typeof data.event_id !== 'string' || !uuid.test(data.event_id) ||
      typeof p.trip_id !== 'string' || !uuid.test(p.trip_id) ||
      typeof data.timestamp !== 'string' || !Number.isFinite(Date.parse(data.timestamp)) ||
      typeof data.correlation_id !== 'string' || !/^[\w.-]{1,100}$/.test(data.correlation_id)) {
    throw new TypeError('Invalid event envelope');
  }
  if (data.event_type === created &&
      (typeof p.passenger_id !== 'string' || !uuid.test(p.passenger_id) ||
       typeof p.pickup_latitude !== 'number' || !Number.isFinite(p.pickup_latitude) ||
       Math.abs(p.pickup_latitude) > 90 ||
       typeof p.pickup_longitude !== 'number' || !Number.isFinite(p.pickup_longitude) ||
       Math.abs(p.pickup_longitude) > 180 ||
       typeof p.estimated_fare !== 'number' || !Number.isFinite(p.estimated_fare) || p.estimated_fare < 0)) {
    throw new TypeError('Invalid trip pickup or fare');
  }
  if (data.event_type === released &&
      ((p.driver_id !== undefined && (typeof p.driver_id !== 'string' || !uuid.test(p.driver_id))) ||
       (p.reservation_id !== undefined && (typeof p.reservation_id !== 'string' || !uuid.test(p.reservation_id))))) {
    throw new TypeError('Invalid release payload');
  }
  return data;
}

interface Settings {
  driverUrl: string;
  driverKey: string;
  tripKey: string;
  radiusKm: number;
  maxAgeMs: number;
  matchingTimeoutMs: number;
}

interface Reservation {
  id: string;
  driver_id: string;
  driver_user_id: string;
  state: string;
  expires_at: string;
}

interface Job {
  trip_id: string;
  envelope: Envelope;
  attempts: number;
  remaining_ms: number;
  lease_token: string;
}

export class Matching {
  constructor(readonly pool: Pool, readonly settings: Settings) {}

  private async driver<T>(path: string, trace: string, body?: unknown, key = this.settings.driverKey): Promise<T> {
    const response = await fetch(new URL(path, this.settings.driverUrl), {
      method: body ? 'POST' : 'GET',
      headers: { 'x-internal-key': key, 'x-correlation-id': trace, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) throw new Error('Driver call failed');
    return (await response.json() as { data: T }).data;
  }

  async receive(message: Envelope) {
    const p = message.payload;
    const cancelled = message.event_type === released;
    // Driver commits the trip tombstone before acknowledging cancellation. Retry is safe.
    if (cancelled) {
      const processed = await this.pool.query('SELECT 1 FROM inbox_events WHERE event_id = $1', [message.event_id]);
      if (processed.rowCount) return;
      await this.driver('/internal/reservations/release', message.correlation_id,
        { trip_id: p.trip_id, driver_id: p.driver_id, reservation_id: p.reservation_id }, this.settings.tripKey);
    }
    await this.pool.query(`
      WITH accepted AS (
        INSERT INTO inbox_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING event_id
      )
      INSERT INTO matching_requests (trip_id, envelope, state, deadline)
      SELECT $2, $3, CASE WHEN $5::boolean THEN 'CANCELLED' ELSE 'PENDING' END,
        LEAST($4::timestamptz, statement_timestamp()) + $6::float8 * interval '1 millisecond'
      FROM accepted
      ON CONFLICT (trip_id) DO UPDATE SET state = 'CANCELLED', result = NULL
      WHERE $5::boolean AND matching_requests.state = 'PENDING'`, [message.event_id, p.trip_id, JSON.stringify(message),
      message.timestamp, cancelled, this.settings.matchingTimeoutMs]);
  }

  async runOnce(): Promise<boolean> {
    const claimedAt = performance.now();
    const { rows } = await this.pool.query<Job>(`
      UPDATE matching_requests SET lease_token = gen_random_uuid(), attempts = attempts + 1,
        next_attempt_at = statement_timestamp() + interval '15 seconds'
      WHERE trip_id = (
        SELECT trip_id FROM matching_requests WHERE state = 'PENDING' AND next_attempt_at <= statement_timestamp()
        ORDER BY next_attempt_at, trip_id LIMIT 1 FOR UPDATE SKIP LOCKED
      ) RETURNING trip_id, envelope, attempts, lease_token,
        (EXTRACT(epoch FROM (deadline - clock_timestamp())) * 1000)::float8 AS remaining_ms`);
    const job = rows[0];
    if (!job) return false;
    const expired = () => performance.now() - claimedAt >= job.remaining_ms;
    const message = job.envelope;
    const p = message.payload;
    let reservation: Reservation | null = null;
    let state = 'NO_DRIVER';
    if (expired()) {
      state = 'TIMEOUT';
    } else {
      try {
        // A previous worker may have crashed after Driver committed the hold.
        reservation = await this.driver<Reservation | null>('/internal/reservations', message.correlation_id,
          { trip_id: job.trip_id, candidates: [] });
        if (!reservation) {
          const candidates = await this.driver<(Candidate & { version: number })[]>(
            '/internal/candidates', message.correlation_id);
          const versions = new Map(candidates.map(candidate => [candidate.id, candidate.version]));
          const ranked = rankCandidates({ latitude: p.pickup_latitude!, longitude: p.pickup_longitude! },
            candidates, this.settings.radiusKm, Date.now() - this.settings.maxAgeMs);
          for (let i = 0; i < ranked.length && !expired(); i += 50) {
            const choices = ranked.slice(i, i + 50).map(({ id }) => ({ id, version: versions.get(id) }));
            reservation = await this.driver<Reservation | null>('/internal/reservations', message.correlation_id,
              { trip_id: job.trip_id, candidates: choices });
            if (reservation) break;
          }
        }
      } catch {
        if (!expired()) {
          await this.pool.query(`
            UPDATE matching_requests SET next_attempt_at = LEAST(deadline,
              statement_timestamp() + $3::float8 * interval '1 millisecond')
            WHERE trip_id = $1 AND lease_token = $2 AND state = 'PENDING'`,
          [job.trip_id, job.lease_token, Math.min(4000, 250 * 2 ** Math.min(job.attempts, 4))]);
          return true;
        }
        state = 'TIMEOUT';
      }
    }
    if (expired()) state = 'TIMEOUT';
    if (state !== 'TIMEOUT' && reservation?.state === 'HELD' && Date.parse(reservation.expires_at) > Date.now()) {
      state = 'MATCHED';
    } else if (reservation?.state === 'RELEASED') {
      state = 'CANCELLED';
    }
    const payload = {
      trip_id: p.trip_id, passenger_id: p.passenger_id, estimated_fare: p.estimated_fare,
      ...(state === 'MATCHED' ? {
        driver_id: reservation!.driver_id, driver_user_id: reservation!.driver_user_id,
        reservation_id: reservation!.id, expires_at: reservation!.expires_at,
      } : { reason: state }),
    };
    const output = {
      event_id: randomUUID(), event_type: state === 'MATCHED' ? 'trip.event.driver_matched' : 'trip.event.matching_failed',
      timestamp: new Date().toISOString(), source_service: 'matching-service', version: '1.0',
      correlation_id: message.correlation_id, causation_id: message.event_id, aggregate_id: job.trip_id, payload,
    };
    const result = await this.pool.query(`
      WITH finished AS (
        UPDATE matching_requests SET state = $3, result = $4
        WHERE trip_id = $1 AND lease_token = $2 AND state = 'PENDING' RETURNING trip_id
      )
      INSERT INTO outbox_events (event_id, envelope)
      SELECT $5, $6 FROM finished WHERE $3 <> 'CANCELLED'`,
    [job.trip_id, job.lease_token, state, JSON.stringify(payload), output.event_id, JSON.stringify(output)]);
    if (result.rowCount) console.info(JSON.stringify({
      service: 'matching-service', timestamp: output.timestamp, correlation_id: message.correlation_id,
      trip_id: job.trip_id, result: state,
    }));
    return true;
  }
}
