import { Pool, PoolClient } from 'pg';

export async function transaction<T>(pool: Pool, run: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  let discard = false;
  try {
    await db.query('BEGIN');
    const result = await run(db);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await db.query('ROLLBACK');
    } catch {
      discard = true;
    }
    throw error;
  } finally {
    db.release(discard);
  }
}

interface Reservation {
  id: string;
  trip_id: string;
  driver_id: string | null;
  driver_user_id: string | null;
  state: 'HELD' | 'CONFIRMED' | 'RELEASED' | 'EXPIRED';
  expires_at: Date | null;
  expired: boolean;
}

interface Choice {
  id: string;
  version: number;
}

async function lockTrip(db: PoolClient, tripId: string) {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1::uuid::text, 0))', [tripId]);
  const { rows } = await db.query<Reservation>(`
    SELECT r.*, d.user_id AS driver_user_id, r.expires_at <= clock_timestamp() AS expired
    FROM driver_reservations r LEFT JOIN drivers d ON d.id = r.driver_id
    WHERE r.trip_id = $1 FOR UPDATE OF r`, [tripId]);
  return rows[0];
}

async function changeState(db: PoolClient, reservation: Reservation, state: Reservation['state']) {
  const driverState = state === 'CONFIRMED' ? 'BUSY' : 'AVAILABLE';
  const expected = reservation.state === 'CONFIRMED' ? 'BUSY' : 'RESERVED';
  const updated = await db.query(`
    UPDATE drivers SET status = $2, version = version + 1, updated_at = clock_timestamp()
    WHERE id = $1 AND status = $3`, [reservation.driver_id, driverState, expected]);
  if (updated.rowCount !== 1) throw new Error('Reservation and driver state diverged');
  await db.query('UPDATE driver_reservations SET state = $2 WHERE id = $1', [reservation.id, state]);
  return { ...reservation, state };
}

export function reserve(pool: Pool, tripId: string, candidates: Choice[], maxAgeMs: number, ttlMs: number) {
  return transaction(pool, async db => {
    const existing = await lockTrip(db, tripId);
    if (existing) {
      return existing.state === 'HELD' && existing.expired
        ? changeState(db, existing, 'EXPIRED') : existing;
    }
    if (candidates.length === 0) return null;
    const selected = await db.query(`
      SELECT d.id, d.version, d.user_id
      FROM unnest($1::uuid[], $2::int[]) WITH ORDINALITY AS c(id, version, position)
      JOIN drivers d ON d.id = c.id AND d.version = c.version
      WHERE d.status = 'AVAILABLE'
        AND d.location_updated_at >= statement_timestamp() - $3::float8 * interval '1 millisecond'
      ORDER BY c.position
      LIMIT 1 FOR UPDATE OF d SKIP LOCKED`, [
      candidates.map(candidate => candidate.id), candidates.map(candidate => candidate.version), maxAgeMs,
    ]);
    const driver = selected.rows[0];
    if (!driver) return null;
    const updated = await db.query(`
      UPDATE drivers SET status = 'RESERVED', version = version + 1, updated_at = clock_timestamp()
      WHERE id = $1 AND version = $2 AND status = 'AVAILABLE'`, [driver.id, driver.version]);
    if (updated.rowCount !== 1) throw new Error('Driver version changed during reservation');
    const { rows } = await db.query<Reservation>(`
      INSERT INTO driver_reservations (trip_id, driver_id, state, expires_at)
      VALUES ($1, $2, 'HELD', clock_timestamp() + $3::float8 * interval '1 millisecond')
      RETURNING *, false AS expired`, [tripId, driver.id, ttlMs]);
    return { ...rows[0], driver_user_id: driver.user_id };
  });
}

export function transition(
  pool: Pool, tripId: string, action: 'confirm' | 'release', reservationId?: string, driverId?: string,
) {
  return transaction(pool, async db => {
    const current = await lockTrip(db, tripId);
    if (!current) {
      if (action !== 'release' || reservationId || driverId) return null;
      const { rows } = await db.query<Reservation>(`
        INSERT INTO driver_reservations (trip_id, state) VALUES ($1, 'RELEASED') RETURNING *`, [tripId]);
      return { ...rows[0], driver_user_id: null };
    }
    if ((reservationId && current.id !== reservationId) || (driverId && current.driver_id !== driverId)) {
      return null;
    }
    if (current.state === 'HELD' && current.expired) return changeState(db, current, 'EXPIRED');
    if (action === 'confirm' && current.state === 'HELD') return changeState(db, current, 'CONFIRMED');
    if (action === 'release' && (current.state === 'HELD' || current.state === 'CONFIRMED')) {
      return changeState(db, current, 'RELEASED');
    }
    return current;
  });
}

export async function expireReservations(pool: Pool) {
  return transaction(pool, async db => {
    const { rows } = await db.query<Reservation>(`
      SELECT * FROM driver_reservations
      WHERE state = 'HELD' AND expires_at <= statement_timestamp()
      ORDER BY expires_at, id LIMIT 50 FOR UPDATE SKIP LOCKED`);
    for (const reservation of rows) await changeState(db, reservation, 'EXPIRED');
    return rows.length;
  });
}
