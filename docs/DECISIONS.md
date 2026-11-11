# ARCHITECTURE DECISION RECORDS (ADR) - DS03

Tài liệu này ghi nhận các quyết định thiết kế kiến trúc quan trọng, lý do kỹ thuật và ranh giới triển khai của toàn nhóm.

---

## ADR-001: Phân Tách Microservices Nghiệp Vụ Độc Lập
* **Trạng thái:** ĐÃ PHÊ DUYỆT (APPROVED).
* **Bối cảnh:** Đề tài DS03 yêu cầu tối thiểu 4 business microservices độc lập (không tính API Gateway).
* **Quyết định:** Vận hành **5 Business Services chính + 1 Notification Consumer** (`Identity :8001`, `Driver :8002`, `Trip :8003` gồm luôn Pricing & Saga, `Matching :8004`, `Payment :8005`, `Notification :8006`), cộng thêm `API Gateway (:8080)` và `Web Dashboard (:3000)`.
* **Lý do:** Giữ gọn logic tính cước trong `Trip Service` tránh phân mảnh thêm 1 tiến trình không cần thiết, trong khi tách riêng `Driver`, `Matching`, `Payment`, `Notification` để minh chứng trọn vẹn Saga bù trừ, CAS Lock tranh chấp và Pub/Sub nhiều consumer.

---

## ADR-002: Nền Tảng Runtime Node.js >= 22.13.0 LTS (JavaScript + TypeScript)
* **Trạng thái:** CẬP NHẬT & PHÊ DUYỆT (UPDATED 2026-11-12).
* **Bối cảnh:** `Identity Service` và `Trip Service` sử dụng trực tiếp module core `node:sqlite` (không cần cờ `--experimental-sqlite` từ bản Node.js `22.13.0+`), đồng thời Node.js 20 đã hết hỗ trợ. `Driver Service` và `Matching Service` viết bằng TypeScript biên dịch sang JavaScript.
* **Quyết định:** Chuẩn hoá runtime tối thiểu toàn dự án là **Node.js `>= 22.13.0` LTS** (`node:22-alpine` trong Docker).

---

## ADR-003: Cơ Sở Dữ Liệu Tách Biệt (PostgreSQL 17 & SQLite WAL Độc Lập)
* **Trạng thái:** CẬP NHẬT & PHÊ DUYỆT (UPDATED 2026-11-12).
* **Bối cảnh:** Đề bài bắt buộc **Database-per-Service**. Trên GitHub, TV2 (`Driver`, `Matching`) và TV3 (`Payment`) đã triển khai trên **PostgreSQL 17** (`FOR UPDATE SKIP LOCKED`, `CAS version`, `pg_advisory_xact_lock`); còn TV1 (`Identity`, `Trip`) đã triển khai hoàn chỉnh và kiểm thử chặt trên **`node:sqlite` (WAL mode)** với Docker volume riêng.
* **Quyết định:** Giữ mô hình **Database-per-Service độc lập thực dụng**:
  - `Driver`, `Matching`, `Payment` dùng 3 database và 3 role cô lập hoàn toàn trong `PostgreSQL 17` (`driver_db`, `match_db`, `payment_db`).
  - `Identity`, `Trip` giữ nguyên `node:sqlite` WAL trên volume riêng (`identity-data`, `trip-data`) để tránh chi phí rewrite/migration rủi ro sát hạn nộp.
  - Tuyệt đối không truy vấn chéo DB giữa bất kỳ service nào.

---

## ADR-004: RabbitMQ 4 (AMQP 0-9-1) Làm Message Broker Trung Tâm & DLQ
* **Trạng thái:** ĐÃ PHÊ DUYỆT (APPROVED).
* **Bối cảnh:** Cần một Message Broker bền bỉ đáp ứng đồng thời Mục 7.1, 7.3 và 7.4 (async pub/sub, Publisher Confirms, Retry có giới hạn, Dead-Letter Queue, giữ message khi consumer tắt).
* **Quyết định:** Sử dụng **RabbitMQ 4 (`rabbitmq:4-management`)** với Topic Exchange **`trip.exchange`**, Dead-Letter Exchange **`trip.dlx`** $\rightarrow$ Dead-Letter Queue **`trip.dlq`**, cùng các hàng đợi bền bỉ (`durable: true`): `matching.queue`, `payment.queue`, `trip.queue`, `notification.queue`.
* **Lưu ý cấu hình:** Không bật TLS/mTLS hay ACL nhiều tài khoản nội bộ trong bản Final MVP để bảo đảm khả năng khởi chạy ổn định qua `docker compose`.

---

## ADR-005: Transactional Outbox Pattern & Idempotent Consumers
* **Trạng thái:** ĐÃ PHÊ DUYỆT (APPROVED).
* **Quyết định:**
  1. **Trip Service (SQLite):** Ghi trạng thái Trip/Saga + `outbox_events` trong cùng `BEGIN IMMEDIATE ... COMMIT`; Outbox Worker chỉ đánh dấu `PUBLISHED` khi nhận Publisher Confirm từ RabbitMQ.
  2. **Payment & Matching Service (Postgres):** Outbox Worker dùng `FOR UPDATE SKIP LOCKED` + **Lease Fencing Token (`locked_by`)**.
  3. **Deduplication:** Mọi consumer ghi nhận `event_id` vào bảng `processed_events` trong cùng DB transaction xử lý sự kiện (ngữ nghĩa At-least-once delivery + Idempotent processing).

---

## ADR-006: Giao Diện Giám Sát & Kịch Bản Demo (`Web Dashboard` + Script CLI)
* **Trạng thái:** ĐÃ PHÊ DUYỆT (APPROVED).
* **Quyết định:** Giữ lại `API Gateway (:8080)` và `Web Simulation Dashboard (:3000)` của TV3 (trên nhánh `feature/tv3-payment-gateway-dashboard`, kèm RabbitMQ Management `:15672` và script demo CLI chuẩn hoá), giúp trình bày rõ ràng 9 kịch bản của Mục 7.4 trong 10 phút bảo vệ.

---

## ADR-007: Chốt Kiến Trúc Tích Hợp Final MVP Mục 7.1–7.4 & Cắt Giảm Phần 7.5 Phức Tạp (Cách 1)
* **Trạng thái:** ĐÃ PHÊ DUYỆT BỞI CẢ NHÓM (2026-11-12).
* **Bối cảnh:** Kiểm tra toàn bộ các nhánh GitHub cho thấy TV3 đã dựng `Payment`, `Gateway`, `Dashboard`, `RabbitMQ`, `Postgres` trên `feature/tv3-payment-gateway-dashboard` (PR #1 từng merge lên `main` nhưng đã hoàn tác bằng `5c7e6ea` để kiểm thử thực tế & chuẩn hoá trước khi hợp nhất chính thức); TV2 đã xong `Driver`, `Matching` dùng Postgres/RabbitMQ (kèm nhiều lớp 7.5 nâng cao như Internal TLS, ACL, PITR backup, Chaos scripts); TV1 đã hardening xong `Identity`, `Trip` (bản `ab90ebd` dùng SQLite + Outbox HTTP). Nhóm cần chốt 1 bản hợp nhất gọn nhẹ nhất bảo đảm chạy chắc chắn toàn bộ **Mục 7.1 – 7.4**.
* **Quyết định:**
  1. **Chọn Cách 1 (Hợp nhất trên `Docker Compose + RabbitMQ 4 + PostgreSQL 17 + Node.js >= 22.13.0`)**: Lấy nhánh TV3 (`feature/tv3-payment-gateway-dashboard`, sau khi chuẩn hoá & kiểm thử thực tế) làm nền hạ tầng + ghép `driver`/`matching`/`amqp.js` từ nhánh TV2 + ghép `identity`/`trip` mới nhất (`ab90ebd`) từ nhánh TV1.
  2. **Gác bỏ khỏi bản Final các lớp 7.5 không bắt buộc dễ gây lỗi vận hành:** Không tích hợp `Internal TLS/mTLS`, `RabbitMQ ACL đa role`, `PITR WAL Backup`, `Chaos scripts` phức tạp từ nhánh TV2 vào `deploy/docker-compose.yml` chuẩn.
  3. **Sửa 5 điểm khớp nối khi hợp nhất code:**
     - Gắn adapter `amqp.js` vào `Trip Service (ab90ebd)` khi có `RABBITMQ_URL`.
     - Loại bỏ binding `trip.event.release_driver` khỏi `payment.queue` để tránh Payment hoàn tiền nhầm khi chuyến đi `COMPLETED`; Payment chỉ refund qua `payment.event.refund_requested`.
     - Đồng bộ `driver_user_id` & `reservation_id` từ `trip.event.driver_matched` sang `Trip` để `/accept` xác nhận reservation tại `Driver Service` và giải phóng xe khi `/complete`.
     - Tắt ép buộc `JWT_ISSUER`/`JWT_AUDIENCE` cứng hoặc hỗ trợ tuỳ chọn trong `Identity Service`, kèm `scripts/seed-demo.js` tạo đồng bộ User (`user_db`), Driver Profile (`driver_db`) và Ví (`payment_db`).
     - Bổ sung `Notification Service (:8006)` gọn nhẹ tiêu thụ event từ `trip.exchange` (và gắn JWT cho luồng Demo/Dashboard gọi `/api/v1/trips*`).
