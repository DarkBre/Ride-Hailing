'use strict';

// =========================================================================
// [TV1] Tính khoảng cách trắc địa theo công thức Haversine (Mặt cầu R = 6371 km)
// Sử dụng để đo khoảng cách thực tế giữa điểm đón và điểm đến từ toạ độ GPS
// =========================================================================

// [TV1] Tính khoảng cách trắc địa mặt cầu giữa 2 toạ độ GPS (km)
function haversineDistanceKm(coord1, coord2) {
  if (!coord1 || !coord2) return 0;
  const lat1 = Number(coord1.lat ?? coord1.latitude);
  const lon1 = Number(coord1.lng ?? coord1.lon ?? coord1.longitude);
  const lat2 = Number(coord2.lat ?? coord2.latitude);
  const lon2 = Number(coord2.lng ?? coord2.lon ?? coord2.longitude);

  if (isNaN(lat1) || isNaN(lon1) || isNaN(lat2) || isNaN(lon2)) return 0;

  const R = 6371; // Bán kính trung bình của Trái Đất (km)
  const dLat = ((lat2 - lat1) * Math.PI) / 180; // Đổi hiệu vĩ độ sang radian
  const dLon = ((lon2 - lon1) * Math.PI) / 180; // Đổi hiệu kinh độ sang radian

  // Công thức Haversine: tính bình phương nửa dây cung góc tâm
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)); // Góc ở tâm (radian)
  const d = R * c; // Khoảng cách trắc địa trên mặt cầu (km)

  return Math.round(d * 100) / 100; // Làm tròn 2 chữ số thập phân
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
