export interface Coordinates {
  latitude: number;
  longitude: number;
}

function valid(point: Coordinates | null | undefined): point is Coordinates {
  return point != null &&
    Number.isFinite(point.latitude) && Math.abs(point.latitude) <= 90 &&
    Number.isFinite(point.longitude) && Math.abs(point.longitude) <= 180;
}

export function haversineKm(from: Coordinates, to: Coordinates): number {
  if (!valid(from) || !valid(to)) throw new RangeError('Invalid coordinates');
  const radians = Math.PI / 180;
  const deltaLatitude = (to.latitude - from.latitude) * radians;
  const deltaLongitude = (to.longitude - from.longitude) * radians;
  const a = Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(from.latitude * radians) * Math.cos(to.latitude * radians) *
    Math.sin(deltaLongitude / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(Math.max(0, Math.min(1, a))));
}

export interface Candidate extends Coordinates {
  id: string;
  status: string;
  locationUpdatedAtMs: number;
}

export function rankCandidates(
  pickup: Coordinates,
  candidates: readonly Candidate[],
  radiusKm: number,
  locationCutoffMs: number,
) {
  if (!valid(pickup) || !Number.isFinite(radiusKm) || radiusKm <= 0 || !Number.isFinite(locationCutoffMs)) {
    throw new RangeError('Invalid matching search parameters');
  }
  return candidates
    .filter(candidate => candidate.status === 'AVAILABLE' &&
      Number.isFinite(candidate.locationUpdatedAtMs) && candidate.locationUpdatedAtMs >= locationCutoffMs &&
      valid(candidate))
    .map(candidate => ({ id: candidate.id, distance_km: haversineKm(pickup, candidate) }))
    .filter(candidate => candidate.distance_km <= radiusKm)
    .sort((a, b) => a.distance_km - b.distance_km || a.id.localeCompare(b.id));
}
