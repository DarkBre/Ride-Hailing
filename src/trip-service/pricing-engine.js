'use strict';

// =========================================================================
// [TV1] Thuật toán Định giá động (Dynamic Pricing Engine)
// - calculateSurgeMultiplier: Tính hệ số tăng giá theo tỷ lệ Cầu/Cung (chặn trần 2.5x)
// - calculateFare: Tính cước từ khoảng cách Haversine và làm tròn 1.000 VNĐ
// =========================================================================

const { haversineDistanceKm } = require('./geo');
const config = require('./config');

/**
 * Dynamic Pricing Engine (Định Giá Động)
 * Tuân thủ chính xác công thức tại docs/ARCHITECTURE.md Section 4.4
 */
class PricingEngine {
  constructor(options = {}) {
    this.baseFare = options.baseFare || config.PRICING.BASE_FARE;
    this.perKmRate = options.perKmRate || config.PRICING.PER_KM_RATE;
    this.minSurge = options.minSurge || config.PRICING.MIN_SURGE;
    this.maxSurge = options.maxSurge || config.PRICING.MAX_SURGE;
  }

  // [TV1] Tính hệ số Surge Multiplier theo Cầu/Cung (chặn trần tối đa 2.5x)
  calculateSurgeMultiplier(demand, supply) {
    const validDemand = Number(demand);
    const validSupply = Number(supply);

    // Xử lý NaN hoặc số âm
    const cleanDemand = !isNaN(validDemand) && validDemand >= 0 ? validDemand : 0;
    const cleanSupply = !isNaN(validSupply) && validSupply >= 0 ? validSupply : 0;

    // Nếu không có nhu cầu (demand = 0), hệ số = 1.0
    if (cleanDemand === 0) {
      return this.minSurge;
    }

    // Tránh chia cho 0: max(1, supply)
    const effectiveSupply = Math.max(1, cleanSupply);
    const ratio = cleanDemand / effectiveSupply; // Tỷ lệ Cầu / Cung

    const rawSurge = 1.0 + ratio * 0.2; // Tăng 0.2 cho mỗi tỉ lệ thặng dư cầu
    const clampedSurge = Math.min(this.maxSurge, Math.max(this.minSurge, rawSurge)); // Chặn trần 2.5x và sàn 1.0x

    return Math.round(clampedSurge * 100) / 100;
  }

  // [TV1] Tính cước phí hoàn chỉnh (BaseFare + Distance * Rate) * Surge và làm tròn 1.000 VNĐ
  calculateFare({ pickup, dropoff, demand = 0, supply = 1 }) {
    if (!pickup || !dropoff) {
      throw new Error('Toạ độ điểm đón và điểm đến không hợp lệ');
    }

    const distanceKm = haversineDistanceKm(pickup, dropoff); // Tính khoảng cách trắc địa Haversine
    if (distanceKm <= 0) {
      throw new Error('Điểm đón và điểm đến trùng nhau hoặc toạ độ không hợp lệ');
    }

    const surgeMultiplier = this.calculateSurgeMultiplier(demand, supply); // Lấy hệ số tăng giá
    const rawFare = (this.baseFare + distanceKm * this.perKmRate) * surgeMultiplier; // Công thức cước chuẩn

    // Làm tròn đến 1,000 VND gần nhất (phù hợp thực tế thanh toán)
    const roundedFare = Math.max(this.baseFare, Math.round(rawFare / 1000) * 1000);

    return {
      distance_km: distanceKm,
      surge_multiplier: surgeMultiplier,
      base_fare: this.baseFare,
      per_km_rate: this.perKmRate,
      estimated_fare: roundedFare,
    };
  }
}

const defaultPricingEngine = new PricingEngine();

module.exports = {
  PricingEngine,
  defaultPricingEngine,
};
