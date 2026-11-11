# PROJECT BRIEF: RIDE-HAILING MICROSERVICES SYSTEM (DS03)

## 1. Thông Tin Tổng Quan (Project Overview)
* **Tên đề tài:** Xây dựng hệ thống đặt xe công nghệ theo kiến trúc Microservices mô phỏng Grab/Uber (Topic DS03).
* **Môn học:** Hệ phân tán (Distributed Systems).
* **Quy mô nhóm:** 3 thành viên.
  * **Thành viên 1 (Trưởng nhóm / DarkBre):** Phụ trách Kiến trúc tổng thể, `Identity Service` (`:8001`), `Trip Service` (`:8003`, tích hợp Pricing Engine & Saga Coordinator).
  * **Thành viên 2 (Dương Quốc Hoàng):** Phụ trách `Driver Service` (`:8002`), `Matching Service` (`:8004`), CAS Concurrency Control & Driver Reservation Protocol.
  * **Thành viên 3 (Quang):** Phụ trách `Payment Service` (`:8005`), `Notification Service` (`:8006`), `API Gateway` (`:8080`), `Web Dashboard` (`:3000`), và hạ tầng `Docker Compose + RabbitMQ 4 + PostgreSQL 17`.
* **Thời hạn hoàn thành:**
  * Hạn nộp GitHub & Báo cáo: **22/11/2026**.
  * Lịch bảo vệ & Demo: **23/11/2026 – 30/11/2026**.
* **Tài liệu quy chuẩn:** `COURSE PROJECT SPECIFICATION.pdf` (Mục 7, 9, 10, 11, 12, 13).

---

## 2. Mục Tiêu & Phạm Vi Chốt (7.1 – 7.4 Mandatory First)
1. **Đạt trọn vẹn 100% tiêu chí bắt buộc (Mục 7.1 – 7.4):**
   * **Độc lập tiến trình & Database-per-service:** Mỗi microservice sở hữu DB hoàn toàn độc lập (`user_db`, `trip_db` dùng `node:sqlite` WAL; `driver_db`, `match_db`, `payment_db` dùng `PostgreSQL 17`), tuyệt đối không đọc/ghi chéo DB.
   * **Giao dịch phân tán (Saga Pattern):** Phối hợp Đặt xe $\rightarrow$ Giữ tài xế $\rightarrow$ Tạm giữ cước $\rightarrow$ Xác nhận cuốc, kèm bù trừ giải phóng tài xế (`trip.event.release_driver`) và hoàn tiền (`payment.event.refund_requested`).
   * **Kiểm soát đồng thời (Concurrency Control):** Ngăn 2 khách đặt trùng 1 xe bằng CAS Optimistic Lock (`version` + `FOR UPDATE SKIP LOCKED`) trong `driver_db` và `pg_advisory_xact_lock` trong `payment_db`.
   * **Reliable Messaging qua RabbitMQ 4 (AMQP 0-9-1):** Topic exchange `trip.exchange`, `event_id` (UUID), Deduplication (`processed_events`), Bounded Retries và Dead-Letter Queue (`trip.dlx` $\rightarrow$ `trip.dlq`).
   * **Truy vết & Thông báo:** `X-Correlation-ID` xuyên HTTP Gateway & RabbitMQ messages; `Notification Service` nhận sự kiện và phát thông báo Rider/Driver.
2. **Phạm vi gác lại (7.5 không bắt buộc cho bản Final MVP):**
   * Tạm bỏ qua `Internal TLS/mTLS`, `RabbitMQ ACL đa tài khoản`, `PostgreSQL PITR WAL Backup`, `Kubernetes`, `Multi-instance auto-scaling` để giảm độ phức tạp cấu hình chứng chỉ khi demo.
   * Giữ lại `Docker Compose`, `Outbox Pattern`, `Dynamic Pricing`, `API Gateway` và `Web Dashboard` vì đã có sẵn trên GitHub của các thành viên.

---

## 3. Tech Stack & Hạ Tầng (Đã Thống Nhất Theo Cách 1)
* **Runtime & Ngôn ngữ:** Node.js `>= 22.13.0` LTS (JavaScript cho Identity, Trip, Payment, Notification, Gateway, Dashboard; TypeScript biên dịch sang Node cho Driver & Matching).
* **Message Broker:** RabbitMQ 4 Management (`amqp://...`, port `5672`, UI `15672`).
* **Database Engine (Database-per-Service):**
  * `PostgreSQL 17` (`driver_db`, `match_db`, `payment_db`) cho TV2 & TV3.
  * `node:sqlite` (WAL mode) cô lập theo volume riêng (`user_db`, `trip_db`) cho TV1.
* **Bảo mật:** Băm mật khẩu `scrypt` kèm salt, JWT HMAC-SHA256 (`userId` & `user_id` UUID claims), Persistent SHA-256 Token Blacklist, xác thực mạng nội bộ `X-Internal-Key` / `DRIVER_TRIP_KEY`.
* **Đóng gói vận hành:** Docker Compose v2+ (`deploy/docker-compose.yml`).

---

## 4. Phân Vai Trách Nhiệm Cân Bằng (Balanced RACI Matrix)

| Thành phần & Nhiệm vụ | TV1 (Trưởng nhóm) | TV2 (Dương Quốc Hoàng) | TV3 (Quang) | Ghi chú nghiệm thu |
|---|:---:|:---:|:---:|---|
| **Identity Service (`:8001`)** | **A / R** | C | I | Đăng ký, đăng nhập JWT, RBAC, `scrypt`, persistent hash blacklist (`user_db`). |
| **Trip Service (`:8003`)** | **A / R** | C | C | State Machine, Dynamic Pricing (Haversine + Surge), **Saga Coordinator**, Outbox (`trip_db`). |
| **Driver Service (`:8002`)** | C | **A / R** | I | Trạng thái (`AVAILABLE`/`BUSY`/`OFFLINE`), GPS, **CAS Lock + Reservation** (`driver_db`). |
| **Matching Service (`:8004`)** | C | **A / R** | I | Consumer RabbitMQ tìm xe gần nhất, giữ reservation qua Driver REST API (`match_db`). |
| **Payment Service (`:8005`)** | C | I | **A / R** | Ví ảo (`balance`, `held_balance`), Hold / Capture / Refund, Outbox Lease Fencing (`payment_db`). |
| **Notification Service (`:8006`)** | I | I | **A / R** | Subscribe sự kiện `trip.exchange` (`#`), ghi log/bảng thông báo Rider & Driver (7.3). |
| **Gateway (`:8080`), Dashboard (`:3000`), Docker & RabbitMQ** | C | C | **A / R** | Reverse proxy, `X-Correlation-ID`, SSE log stream, `docker-compose.yml`, DLQ `trip.dlq`. |
| **Kiểm thử Chức năng (8 Tests)** | **R (FT-01,02,05)** | **R (FT-03,04,06)** | **R (FT-07,08)** | Bao phủ đủ 8 luồng chức năng cốt lõi. |
| **Kiểm thử Concurrency (2 Tests)** | I | **A / R (CT-01,02)** | C | 2 khách tranh 1 tài xế & 2 lệnh hold tranh 1 ví. |
| **Kiểm thử Chịu lỗi & Phục hồi (2 Tests)** | C | C | **A / R (FR-01,02)** | Dừng/bật lại Payment giữa luồng & Saga bù trừ hoàn đủ tài nguyên. |
| **Kiểm thử Bảo mật (2 Tests)** | **A / R (ST-01,02)** | I | I | Token giả/hết hạn, RBAC vượt quyền, SQLi/toạ độ biên. |
| **Báo cáo đồ án (`docs/report.pdf`)** | **R (Ch 1–4)** | **R (Ch 5–8)** | **R (Ch 9–13)** | Tổng 20–30 trang chuẩn Mục 10.2 PDF. |
| **Thuyết trình Demo (10 phút)** | Phút 1 – 3 | Phút 4 – 6 | Phút 7 – 10 | Trình diễn đủ 9 bước Mục 7.4 PDF. |

*(Chú thích: **A** = Accountable; **R** = Responsible; **C** = Consulted; **I** = Informed).*

---

## 5. Tiêu Chí Nghiệm Thu Chung (Definition of Success)
1. Khởi chạy toàn bộ stack ổn định bằng `docker compose -f deploy/docker-compose.yml --profile full up -d --build`.
2. Đảm bảo cô lập dữ liệu tuyệt đối (Database-per-service).
3. Chạy thông suốt **9/9 kịch bản Demo của Mục 7.4 PDF** (bao gồm tranh chấp 2 khách đặt 1 xe, dừng/khởi động lại service giữa chừng không mất message trong RabbitMQ, DLQ và Saga bù trừ giải phóng cả tài xế lẫn tiền).
4. Hoàn thiện báo cáo `docs/report.pdf`, slide và gắn tag phát hành `v1.0.0` trước **22/11/2026**.
