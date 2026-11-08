# CHANGELOG: RIDE-HAILING MICROSERVICES (DS03)

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

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
