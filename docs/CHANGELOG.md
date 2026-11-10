# CHANGELOG: RIDE-HAILING MICROSERVICES (DS03)

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

- **Nghiệm thu cuối:** Thêm overlay PostgreSQL TLS và AMQPS, probe TLS âm tính, PITR biệt lập, integrity check khi restore và benchmark A/B. Giữ profile demo, schema và contract nghiệp vụ.

- **Production hardening:** Thêm overlay Gateway HTTPS và RabbitMQ ACL, rate limit xác thực dùng SQLite, Identity/Trip non-root, liveness/readiness và drain khi shutdown.
- **Vận hành:** Thêm backup/restore drill trên project riêng, probe TLS/ACL/network partition và tài liệu giới hạn HA.

- **Release hardening:** Cô lập idempotency key theo hành khách, chặn payment failure đến trễ sửa chuyến đã kết thúc và đối chiếu command với khoản giữ tiền.
- **Security:** Kiểm tra claim JWT và issuer/audience trong Compose, giới hạn request body, ẩn lỗi 5xx và kiểm tra token trước khi thu hồi.
- **Pricing và nghiệm thu:** Compose lấy nguồn cung tài xế từ Driver API, giữ snapshot cước. Thêm probe load và restart RabbitMQ/Driver, tài liệu readiness và kịch bản demo.

- **Audit và tích hợp mã TV1:** Khôi phục Identity, Trip, Pricing và suite TV1 từ nhánh `8758e74`. Giữ schema SQLite hiện có và bổ sung migration metadata reservation.
- **Reservation:** Driver quản lý RESERVED, khóa `SKIP LOCKED`, CAS, confirm, release, expiry và tombstone cho chuyến hủy.
- **Matching:** Thêm service port 8004, inbox/outbox PostgreSQL, job có lease, khôi phục reservation sau retry và Haversine theo snapshot Driver.
- **RabbitMQ và luồng đặt xe:** Thêm publisher confirm, retry, DLQ, adapter Trip, Gateway và Payment mô phỏng với ví, hold, capture, refund.
- **Nghiệm thu:** Thêm integration HTTP/PostgreSQL, E2E Compose, test contention, recovery và cấu hình triển khai với role database riêng.

## [0.2.0] - 2026-11-08
### Changed
- **Cập nhật chính thức danh sách thành viên nhóm và phân công chi tiết**:
  - **Thành viên 1 (Trưởng nhóm / DarkBre)**: Phụ trách `Trip Service` (:4003), `Pricing Service` (:4005), `Identity Service` (:4001), Saga Coordinator & Bù trừ, Demo Phút 1–3, Báo cáo Chương 1–4.
  - **Thành viên 2 (Dương Quốc Hoàng)**: Phụ trách `Driver Service` (:4002), `Matching Service` (:4004), `Payment Service` (:4006), CAS Lock Concurrency & Idempotency, Demo Phút 4–6, Báo cáo Chương 5–8.
  - **Thành viên 3 (Quang)**: Phụ trách `Broker Service` (:4000), `Notification Service` (:4007), `API Gateway & Web UI` (:8080), Reliable Queue & Fault Recovery, Demo Phút 7–10, Báo cáo Chương 9–13.
- Cập nhật đồng bộ toàn bộ tài liệu SSOT (`README.md`, `docs/PROJECT_BRIEF.md`, `docs/ARCHITECTURE.md`, `docs/TEST_PLAN.md`) sang kiến trúc 9 microservices chuẩn tỷ lệ 33.3% - 33.3% - 33.3%.

## [0.1.0] - 2026-11-04
### Added
- **Giai đoạn 0 & 1 Completed (Initialization & Scope Freeze)**:
  - Khởi tạo bộ tài liệu Single Source of Truth (SSOT) trong thư mục `docs/`.
  - Hoàn thiện `docs/PROJECT_BRIEF.md`: Mục tiêu, bối cảnh, ma trận phân vai RACI cân bằng chuẩn 33.3% - 33.3% - 33.3% cho nhóm 3 thành viên.
  - Cập nhật `README.md` và `docs/TEST_PLAN.md`: Phân bổ đều các services, cơ chế phân tán, bộ test và khối lượng báo cáo.
  - Hoàn thiện `docs/REQUIREMENTS.md`: Phân loại MoSCoW, đặc tả trạng thái State Machine cho Trip và Driver, tiêu chí nghiệm thu (Acceptance Criteria cho P0).
  - Hoàn thiện `docs/ARCHITECTURE.md`: Thiết kế sơ đồ kiến trúc 5 microservices + API Gateway, giải pháp phân tán cho Concurrency Control (`SELECT FOR UPDATE SKIP LOCKED`), Saga Orchestration/Choreography kèm Compensating Actions, Transactional Outbox Pattern, Dynamic Pricing Engine và Fault Tolerance với DLQ.
  - Hoàn thiện `docs/CONTRACTS.md`: Chốt các hợp đồng REST DTO, RabbitMQ Message Envelope & Topic format, Database Schemas chi tiết cho 5 database riêng biệt.
  - Hoàn thiện `docs/TEST_PLAN.md`: Đặc tả 8 Functional Tests, 2 Concurrency Tests, 2 Fault & Recovery Tests, 2 Security Tests và 1 Performance Experiment.
  - Hoàn thiện `docs/DECISIONS.md`: Ghi nhận 6 quyết định kiến trúc quan trọng (ADR-001 đến ADR-006).
  - Khởi tạo file `.env.example` và `README.md`.
