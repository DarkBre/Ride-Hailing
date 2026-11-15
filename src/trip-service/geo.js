'use strict';

/**
 * Tính khoảng cách đường chim bay giữa 2 toạ độ GPS bằng công thức Haversine (km)
 */
function haversineDistanceKm(coord1, coord2) {
  if (!coord1 || !coord2) return 0;
  const lat1 = Number(coord1.lat ?? coord1.latitude);
  const lon1 = Number(coord1.lng ?? coord1.lon ?? coord1.longitude);
  const lat2 = Number(coord2.lat ?? coord2.latitude);
  const lon2 = Number(coord2.lng ?? coord2.lon ?? coord2.longitude);

  if (isNaN(lat1) || isNaN(lon1) || isNaN(lat2) || isNaN(lon2)) return 0;

  const R = 6371; // Bán kính Trái Đất (km)
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const d = R * c;

  return Math.round(d * 100) / 100;
}

/**
 * Ước tính thời gian di chuyển (phút) dựa trên tốc độ trung bình 25 km/h
 */
function estimateTravelMinutes(distanceKm) {
  if (!distanceKm || distanceKm <= 0) return 3;
  const avgSpeedKmH = 25;
  const minutes = (distanceKm / avgSpeedKmH) * 60;
  return Math.max(3, Math.round(minutes));
}

module.exports = {
  haversineDistanceKm,
  estimateTravelMinutes,
};
