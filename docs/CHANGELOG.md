# CHANGELOG: RIDE-HAILING MICROSERVICES (DS03)

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

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
