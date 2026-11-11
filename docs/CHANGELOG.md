# CHANGELOG: RIDE-HAILING MICROSERVICES (DS03)

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

## [0.3.0] - 2026-11-12
### Changed (Thống nhất Kiến trúc Bản Final Cách 1 — Mục 7.1–7.4)
- **Thống nhất tài liệu SSOT sau khi kiểm tra đủ 3 nhánh GitHub (`main`, `feature/tv1-identity-trip`, `feature/tv2-driver-matching`):**
  - Chốt **ADR-007 (Cách 1):** Hợp nhất toàn nhóm trên nền **Docker Compose + PostgreSQL 17 + RabbitMQ 4 (AMQP 0-9-1) + Node.js >= 22.13.0 LTS**, ưu tiên hoàn thiện trọn vẹn **Mục 7.1–7.4** và gác lại các lớp 7.5 phức tạp từ nhánh TV2 (`Internal TLS/mTLS`, `RabbitMQ ACL đa role`, `PITR WAL Backup`, `Chaos scripts`).
  - Cập nhật lại phân công sở hữu thực tế trong `README.md` và `docs/PROJECT_BRIEF.md`:
    - **TV1:** `Identity (:8001)` & `Trip/Pricing/Saga (:8003)` (SQLite WAL độc lập).
    - **TV2:** `Driver (:8002)` & `Matching (:8004)` (PostgreSQL 17, CAS Lock & Reservations).
    - **TV3:** `Payment (:8005)` (PostgreSQL 17), `Notification (:8006)`, `API Gateway (:8080)`, `Web Dashboard (:3000)`, Docker Compose & RabbitMQ 4.
  - Chuẩn hoá bảng contract sự kiện RabbitMQ trong `docs/CONTRACTS.md` (thêm `payment.event.refund_requested`, truyền `passenger_id` ở `hold_requested`, `reservation_id` & `driver_user_id` ở `driver_matched`, gỡ binding nhầm `trip.event.release_driver` khỏi `payment.queue`).
  - Đồng bộ yêu cầu runtime `Node.js >= 22.13.0` hỗ trợ native `node:sqlite`, cập nhật `docs/TEST_PLAN.md` và `.env.example`.
- **Added:** `docs/INTEGRATION_CHECKLIST.md` hướng dẫn chi tiết 5 điểm khớp nối khi ghép code TV1, TV2, TV3.

## [0.2.0] - 2026-11-08
### Changed
- Hợp nhất PR #1 của TV3 (`Payment Service`, `API Gateway`, `Web Dashboard`, `Docker Compose`, `PostgreSQL 17`, `RabbitMQ 4`) lên nhánh `main`.
- Cập nhật danh sách thành viên nhóm và khung kiểm thử.

## [0.1.0] - 2026-11-04
### Added
- Khởi tạo bộ tài liệu Single Source of Truth (SSOT) trong thư mục `docs/` (`PROJECT_BRIEF.md`, `REQUIREMENTS.md`, `ARCHITECTURE.md`, `CONTRACTS.md`, `TEST_PLAN.md`, `DECISIONS.md`, `README.md`, `.env.example`).
