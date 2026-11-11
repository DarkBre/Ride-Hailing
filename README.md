# DS03: RIDE-HAILING MICROSERVICES SYSTEM (GRAB / UBER SIMULATION)

> **Môn học:** Hệ phân tán (Distributed Systems)  
> **Đề tài:** Topic DS03 – Build a Ride-Hailing Microservices System Simulating Grab/Uber  
> **Đặc tả chuẩn:** Tuân thủ `COURSE PROJECT SPECIFICATION.pdf` (Mục 7.1 – 7.4)  
> **Kiến trúc chốt cho bản Final (Cách 1):** **Docker Compose + RabbitMQ 4 (AMQP 0-9-1) + PostgreSQL 17 / SQLite WAL + Node.js >= 22.13.0 LTS**

---

## 1. Giới Thiệu & Phạm Vi Mục Tiêu Bản Final

Hệ thống mô phỏng đặt xe công nghệ theo kiến trúc **Event-Driven Microservices**, tập trung hoàn thiện **100% các tiêu chí bắt buộc từ Mục 7.1 đến Mục 7.4** của đặc tả môn học (`COURSE PROJECT SPECIFICATION.pdf`), đồng thời giữ sẵn các hạ tầng nền đã hoàn thành (`API Gateway`, `Web Dashboard`, `Outbox`, `Dynamic Pricing`) và **gác lại các phần 7.5 rườm rà chưa cần thiết** (`TLS/mTLS nội bộ`, `RabbitMQ ACL riêng`, `PITR WAL Backup`, `Chaos/Kubernetes/Multi-instance scaling`).

### Các Đặc Trưng Hệ Phân Tán Cốt Lõi (7.1 – 7.4):
* **Triển khai độc lập (Database-per-service):** Mỗi business microservice chạy trong một container/tiến trình độc lập và sở hữu cơ sở dữ liệu riêng (`user_db`, `driver_db`, `match_db`, `trip_db`, `payment_db`, `notif_db`), không truy vấn chéo DB.
* **Giao tiếp kết hợp Đồng bộ & Bất đồng bộ:**
  * **RESTful API (HTTP/JSON):** Khách đặt xe, đăng ký/đăng nhập JWT, tài xế cập nhật GPS/trạng thái, xác nhận reservation, nạp tiền ví.
  * **Message Queue (RabbitMQ 4 AMQP 0-9-1):** Topic Exchange `trip.exchange`, Dead-Letter Exchange `trip.dlx` $\rightarrow$ Dead-Letter Queue `trip.dlq`, các hàng đợi bền bỉ (`durable`, `persistent`) `matching.queue`, `payment.queue`, `trip.queue`, `notification.queue`.
* **Giao Dịch Phân Tán (Saga Pattern & Compensating Actions):** Phối hợp Đặt xe $\rightarrow$ Khoá tài xế $\rightarrow$ Tạm giữ cước $\rightarrow$ Xác nhận cuốc (`CONFIRMED`); tự động kích hoạt bù trừ giải phóng tài xế (`trip.event.release_driver`) và hoàn tiền tạm giữ (`payment.event.refund_requested`) khi thanh toán lỗi hoặc khách huỷ muộn.
* **Kiểm Soát Tranh Chấp Đồng Thời (Concurrency Control):** Ngăn chặn 2 khách đặt trùng 1 tài xế bằng **CAS Optimistic Lock (`version`) + `FOR UPDATE SKIP LOCKED` + Driver Reservation** trong `driver_db`, và khoá giao dịch `pg_advisory_xact_lock` trên ví `payment_db`.
* **Độ Tin Cậy Thông Điệp (Reliable Messaging):** `event_id` (UUID), `Idempotency-Key` (kèm payload hash), Deduplication qua `processed_events`, Bounded Retries và Dead-Letter Queue (`trip.dlq`).
* **Truy Vết & Giám Sát:** Đồng bộ `X-Correlation-ID` qua `API Gateway` (`:8080`), HTTP headers và RabbitMQ event envelopes; hỗ trợ quan sát trực tiếp queue tại RabbitMQ Management (`:15672`) và `Web Dashboard` (`:3000`).

---

## 2. Kiến Trúc Tổng Thể Bản Final (Cách 1)

```text
                [ Web Dashboard (:3000) / Demo CLI Scripts ]
                                       │ HTTP REST + SSE
                                       ▼
                        ┌─────────────────────────────┐
                        │    API GATEWAY (:8080)      │ (TV3)
                        │ Proxy, CORS, X-Correlation  │
                        └──────────────┬──────────────┘
                                       │ HTTP REST
      ┌───────────────────┬────────────┼────────────┬───────────────────┐
      ▼                   ▼            │            ▼                   ▼
┌──────────────┐   ┌─────────────┐     │     ┌─────────────┐     ┌─────────────┐
│ Identity     │   │ Driver      │     │     │ Trip + Saga │     │ Payment     │
│ Service      │   │ Service     │◄────┼─────┤ & Pricing   │     │ Service     │
│ (:8001) TV1  │   │ (:8002) TV2 │REST │     │ (:8003) TV1 │     │ (:8005) TV3 │
│ DB: user_db  │   │ DB:driver_db│(CAS)│     │ DB: trip_db │     │DB:payment_db│
│ (SQLite WAL) │   │ (Postgres)  │     │     │ (SQLite WAL)│     │ (Postgres)  │
└──────────────┘   └──────▲──────┘     │     └──────┬──────┘     └──────▲──────┘
                          │ REST       │            │                   │
                          │            ▼            │                   │
                   ┌─────────────┐                  │                   │
                   │ Matching    │                  │                   │
                   │ Service     │                  │                   │
                   │ (:8004) TV2 │                  │                   │
                   │ DB: match_db│                  │                   │
                   │ (Postgres)  │                  │                   │
                   └──────▲──────┘                  │                   │
                          │                         ▼                   │
      ════════════════════╪═════════════════════════════════════════════╪════════
                           RABBITMQ 4 MESSAGE BROKER (:5672 / UI :15672)
           Exchange: trip.exchange (Topic, durable)
           Queues:   matching.queue, payment.queue, trip.queue, notification.queue
           DLX/DLQ:  trip.dlx ──► trip.dlq (dead-letter storage)
      ═══════════════════════════════════════════════════╤═══════════════════════
                                                         ▼
                                              ┌──────────────────┐
                                              │ Notification     │
                                              │ Service (:8006)  │ (TV3 - 7.3)
                                              │ Console / Log DB │
                                              └──────────────────┘
```

---

## 3. Phân Công Trách Nhiệm Thành Viên (Khớp Thực Tế GitHub)

| Thành viên | Nhánh GitHub hiện tại | Services & Hạ tầng sở hữu | Cơ chế phân tán & Kiểm thử phụ trách | Báo cáo & Demo (10 phút) |
|---|---|---|---|---|
| **Thành viên 1**<br>*(Trưởng nhóm / DarkBre)* | `feature/tv1-identity-trip` | • `Identity Service` (`:8001`, `user_db`)<br>• `Trip Service` (`:8003`, `trip_db`, gồm Pricing & Saga)<br>• Adapter kết nối Outbox/Consumer với RabbitMQ | • **Saga Coordinator & Bù trừ** (`release_driver`, `refund_requested`)<br>• **Dynamic Pricing**, JWT/RBAC, Persistent Hash Blacklist<br>• **Tests:** FT-01, FT-02, FT-05, ST-01, ST-02 | • **Chương 1–4** (~8–9 trang)<br>• **Phút 1–3:** Xác thực, đặt xe & vòng đời chuyến đi |
| **Thành viên 2**<br>*(Dương Quốc Hoàng)* | `feature/tv2-driver-matching` | • `Driver Service` (`:8002`, `driver_db` Postgres)<br>• `Matching Service` (`:8004`, `match_db` Postgres)<br>• Driver Reservation Protocol & `services/_shared/amqp.js` | • **CAS Optimistic Lock (`version`) + `FOR UPDATE SKIP LOCKED`**<br>• Reservation Hold/Confirm/Expire & Idempotency<br>• **Tests:** FT-03, FT-04, FT-06, CT-01, CT-02 | • **Chương 5–8** (~8–9 trang)<br>• **Phút 4–6:** Tranh chấp đồng thời 2 khách đặt 1 tài xế |
| **Thành viên 3**<br>*(Quang)* | `feature/tv3-payment-gateway-dashboard` *(PR #1 đã hoàn tác khỏi `main` để kiểm thử & chuẩn hoá)* | • `Payment Service` (`:8005`, `payment_db` Postgres)<br>• `Notification Service` (`:8006`, bổ sung gọn cho 7.3)<br>• `API Gateway` (`:8080`), `Web Dashboard` (`:3000`)<br>• Hạ tầng `Docker Compose`, `PostgreSQL 17`, `RabbitMQ 4` | • **RabbitMQ Topology, Retry, Dead-Letter Queue (`trip.dlq`)**<br>• Payment Outbox (`SKIP LOCKED` + Lease Fencing)<br>• **Tests:** FT-07, FT-08, FR-01, FR-02, Load Experiment | • **Chương 9–13** (~8–9 trang)<br>• **Phút 7–10:** Sập service, queue recovery, DLQ & Saga bù trừ |

---

## 4. Cấu Trúc Thư Mục Mục Tiêu Sau Tích Hợp

```text
Ride-Hailing/
├── .env.example                  # Biến môi trường chuẩn toàn hệ thống (không chứa secret thật)
├── package.json                  # Runtime tối thiểu Node.js >= 22.13.0 LTS
├── README.md                     # Tài liệu tổng quan & hướng dẫn chạy bản Final
├── deploy/
│   ├── docker-compose.yml        # Orchestration chuẩn 7.1-7.4 (Postgres, RabbitMQ, 6 services, Gateway, Dashboard)
│   ├── init-postgres.sh          # Khởi tạo role & DB độc lập (driver_db, match_db, payment_db)
│   ├── rabbitmq.conf             # Cấu hình RabbitMQ + load_definitions
│   └── rabbitmq-definitions.json # Khai báo trip.exchange, trip.dlx -> trip.dlq và các queue
├── docs/                         # Bộ tài liệu SSOT đã đồng bộ theo Cách 1
│   ├── PROJECT_BRIEF.md
│   ├── REQUIREMENTS.md
│   ├── ARCHITECTURE.md
│   ├── CONTRACTS.md
│   ├── TEST_PLAN.md
│   ├── DECISIONS.md              # Bao gồm ADR-007 chốt kiến trúc Final MVP 7.1-7.4
│   ├── INTEGRATION_CHECKLIST.md  # Hướng dẫn chi tiết 5 điểm ghép code giữa 3 nhánh
│   └── CHANGELOG.md
├── scripts/
│   ├── check.js                  # Kiểm tra Node >= 22.13.0, node:sqlite và shared foundation
│   └── seed-demo.js              # Khởi tạo tài khoản, ví và hồ sơ tài xế khớp nhau cho Demo 7.4
├── services/_shared/             # Helper dùng chung (gồm amqp.js cho RabbitMQ)
├── src/
│   ├── identity-service/         # Port 8001 (TV1)
│   ├── driver-service/           # Port 8002 (TV2)
│   ├── trip-service/             # Port 8003 (TV1)
│   ├── matching-service/         # Port 8004 (TV2)
│   ├── payment-service/          # Port 8005 (TV3)
│   ├── notification-service/     # Port 8006 (TV3 - tối giản cho 7.3)
│   ├── api-gateway/              # Port 8080 (TV3)
│   └── web-dashboard/            # Port 3000 (TV3)
└── tests/                        # Unit, Service Integration, Concurrency & Fault/Saga E2E
```

---

## 5. Yêu Cầu Môi Trường & Quickstart (Bản Final)

### 5.1. Yêu cầu môi trường
* **Docker Desktop / Docker Engine + Docker Compose v2+** *(Khuyên dùng để khởi chạy trọn bộ Postgres 17 + RabbitMQ 4 + toàn bộ microservices bằng 1 lệnh).*
* **Node.js `>= 22.13.0` LTS** *(Bắt buộc khi chạy/test trực tiếp trên host vì `identity-service` và `trip-service` dùng native `node:sqlite` không cần cờ `--experimental-sqlite`).*
* **RAM khả dụng:** Tối thiểu 4 GB (khi bật toàn bộ Docker Compose stack).

### 5.2. Khởi chạy kiểm thử nền & chuẩn bị cấu hình
```bash
# 1. Tạo file .env từ mẫu (trên máy chạy, KHÔNG commit .env lên Git)
cp .env.example .env

# 2. Kiểm tra runtime Node >= 22.13.0 & node:sqlite
node scripts/check.js

# 3. Khởi động toàn bộ stack bằng Docker Compose (sau bước hợp nhất code)
docker compose -f deploy/docker-compose.yml --profile full up -d --build
```

### 5.3. Các cổng dịch vụ mặc định
* **API Gateway:** `http://localhost:8080`
* **Web Dashboard:** `http://localhost:3000`
* **RabbitMQ Management UI:** `http://localhost:15672` *(Quan sát trực tiếp `payment.queue`, `matching.queue`, `trip.queue`, `trip.dlq`)*
* **Business Services:** Identity `8001` | Driver `8002` | Trip `8003` | Matching `8004` | Payment `8005` | Notification `8006`
* **PostgreSQL:** `5432`

---

## 6. Danh Mục 9 Kịch Bản Demo Bắt Buộc (Mục 7.4 PDF)

1. **Start services independently:** `docker compose ps` cho thấy toàn bộ service/DB tách biệt ở trạng thái `healthy`.
2. **Drivers become available:** Tài xế cập nhật toạ độ GPS và trạng thái `AVAILABLE` tại `Driver Service (:8002)`.
3. **Passenger requests a ride:** Hành khách đặt cuốc xe qua `POST /api/v1/trips` (kèm JWT & `X-Correlation-ID`).
4. **Matching Service selects a driver:** `Matching (:8004)` nhận `trip.event.created`, lọc ứng viên, khoá tài xế tại `Driver (:8002)` và `Payment (:8005)` tạm giữ cước $\rightarrow$ `CONFIRMED`.
5. **Driver accepts and completes trip:** Tài xế `/accept` $\rightarrow$ `/start` $\rightarrow$ `/complete` $\rightarrow$ `Payment` capture tiền thật & `Driver` giải phóng xe về `AVAILABLE`.
6. **Two passengers simultaneously request the same driver (CT-01):** Hệ thống chỉ có 1 xe `AVAILABLE`, bắn đồng thời 2 yêu cầu đặt xe $\rightarrow$ chỉ 1 khách nhận được xe, khách còn lại nhận `NO_DRIVER_AVAILABLE` (không bao giờ gán trùng).
7. **Stop one service during a business flow (FR-01):** Chạy `docker stop ds03-payment` giữa luồng đặt xe $\rightarrow$ tin nhắn `payment.event.hold_requested` nằm an toàn trong `payment.queue` trên RabbitMQ `:15672`.
8. **Demonstrate retry, queue handling, or compensation (FR-02 & DLQ):** Demo khách số dư `0đ` để `Payment` bắn `hold_failed` $\rightarrow$ `Trip` huỷ chuyến và phát `trip.event.release_driver` mở khoá xe về `AVAILABLE`; kiểm tra `trip.dlq` với message lỗi vượt ngưỡng retry.
9. **Restart the service and continue processing messages:** Chạy `docker start ds03-payment` $\rightarrow$ `Payment` tự kéo message tồn đọng trong `payment.queue` về xử lý hoàn tất chuyến đi.

---

## 7. Tài Liệu SSOT Liên Quan
* [PROJECT_BRIEF.md](file:///d:/btl%20ph%C3%A2n%20t%C3%A1n/docs/PROJECT_BRIEF.md) — Mục tiêu, công nghệ và ma trận RACI chuẩn.
* [REQUIREMENTS.md](file:///d:/btl%20ph%C3%A2n%20t%C3%A1n/docs/REQUIREMENTS.md) — Phân loại MoSCoW, State Machine và Acceptance Criteria.
* [ARCHITECTURE.md](file:///d:/btl%20ph%C3%A2n%20t%C3%A1n/docs/ARCHITECTURE.md) — Kiến trúc thống nhất, Saga, Driver Reservation CAS, Outbox.
* [CONTRACTS.md](file:///d:/btl%20ph%C3%A2n%20t%C3%A1n/docs/CONTRACTS.md) — Single Source of Truth cho REST DTOs, RabbitMQ Events & Database Schemas.
* [DECISIONS.md](file:///d:/btl%20ph%C3%A2n%20t%C3%A1n/docs/DECISIONS.md) — Nhật ký quyết định kiến trúc (ADR-001 $\rightarrow$ ADR-007).
* [TEST_PLAN.md](file:///d:/btl%20ph%C3%A2n%20t%C3%A1n/docs/TEST_PLAN.md) — Danh mục kiểm thử bắt buộc và kịch bản đánh giá 7.4.
* [INTEGRATION_CHECKLIST.md](file:///d:/btl%20ph%C3%A2n%20t%C3%A1n/docs/INTEGRATION_CHECKLIST.md) — Danh sách 5 điểm cần ghép giữa TV1, TV2, TV3 ở bước tiếp theo.
