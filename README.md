# DS03: HỆ THỐNG GỌI XE PHÂN TÁN (RIDE-HAILING MICROSERVICES)

Hệ thống mô phỏng nền tảng gọi xe công nghệ theo kiến trúc **Event-Driven Microservices**, kết hợp giữa giao tiếp RESTful API đồng bộ và Message Broker bất đồng bộ.

---

## 1. Phân Công Trách Nhiệm Thành Viên

| Thành viên | Đóng góp (%) | Phân hệ / Dịch vụ phụ trách chính | Đóng góp kỹ thuật cốt lõi |
| :--- | :---: | :--- | :--- |
| **Thành viên 1**<br>*(Nguyễn Hoàng Anh Đức - DarkBre)<br>**Trưởng nhóm** | **40%** | • `Identity Service` (:8001)<br>• `Trip Booking Service` (:8003)<br>• Saga Coordinator & Dynamic Pricing | • Thiết kế kiến trúc phân tán tổng thể, cơ sở dữ liệu SQLite WAL.<br>• Thuật toán định giá động Dynamic Pricing Engine (Haversine GPS + Surge Multiplier).<br>• Điều phối giao dịch phân tán Saga Coordinator & Vòng đời bù trừ 2 chiều (Refund / Release driver).<br>• Bảo mật xác thực JWT HS256, Scrypt hashing, Persistent Token Blacklist, Idempotency-Key. |
| **Thành viên 2**<br>*(Dương Quốc Hoàng)* | **30%** | • `Driver Location Service` (:8002)<br>• `Matching Service` (:8004)<br>• Driver PostgreSQL Database | • Xây dựng cơ sở dữ liệu `driver_db` và `match_db` trên PostgreSQL 17.<br>• Giao thức đặt trước tài xế Driver Reservation Protocol (`HELD`, `CONFIRMED`, `RELEASED`, `EXPIRED`).<br>• Kiểm soát tranh chấp đồng thời bằng CAS Optimistic Lock (`version`) + `FOR UPDATE SKIP LOCKED`.<br>• Thuật toán định vị và lọc tài xế theo bán kính không gian Haversine Geospatial Filter. |
| **Thành viên 3**<br>*(Minh Quang - Quangdz1125)* | **30%** | • `Payment Service` (:8005)<br>• `Notification Service` (:8006)<br>• `API Gateway` (:8080)<br>• `Web Dashboard` (:3000)<br>• Hạ tầng Docker & RabbitMQ | • Triển khai Payment Service với quản lý số dư ví, Row-Level Lock và Transactional Outbox Pattern.<br>• Thiết lập RabbitMQ 4 Topology: Topic Exchange `trip.exchange`, Dead-Letter Queue `trip.dlq`, Bounded Retries.<br>• Xây dựng API Gateway phân quyền RBAC, CORS, Distributed Tracing (`X-Correlation-ID`).<br>• Phát triển Web Dashboard mô phỏng bản đồ Leaflet thời gian thực và Server-Sent Events (SSE).<br>• Đóng gói Docker Compose 10 containers với healthcheck tự động. |

---

## 2. Kiến Trúc Tổng Thể

```text
               [ Web Simulation Dashboard (:3000) ]
                               │ HTTP REST + SSE
                               ▼
                ┌─────────────────────────────┐
                │    API GATEWAY (:8080)      │
                │ Proxy, Auth, Correlation-ID │
                └──────────────┬──────────────┘
                               │ HTTP REST
      ┌───────────────────┬────┴───────┬───────────────────┐
      ▼                   ▼            ▼                   ▼
┌──────────────┐   ┌─────────────┐┌─────────────┐   ┌─────────────┐
│ Identity     │   │ Driver      ││ Trip & Saga │   │ Payment     │
│ Service      │   │ Service     ││ Service     │   │ Service     │
│ (:8001)      │   │ (:8002)     ││ (:8003)     │   │ (:8005)     │
│ DB: user_db  │   │ DB:driver_db││ DB: trip_db │   │DB:payment_db│
│ (SQLite WAL) │   │ (Postgres)  ││ (SQLite WAL)│   │ (Postgres)  │
└──────────────┘   └──────▲──────┘└──────┬──────┘   └──────▲──────┘
                          │ REST         │                 │
                   ┌─────────────┐       │                 │
                   │ Matching    │       │                 │
                   │ Service     │       │                 │
                   │ (:8004)     │       │                 │
                   │ DB: match_db│       │                 │
                   │ (Postgres)  │       │                 │
                   └──────▲──────┘       │                 │
                          │              ▼                 │
      ════════════════════╪════════════════════════════════╪════════
                   RABBITMQ 4 MESSAGE BROKER (:5672)
           Exchange: trip.exchange (Topic, durable)
           Queues:   matching.queue, payment.queue, trip.queue, notification.queue
           DLX/DLQ:  trip.dlx ──► trip.dlq (Dead-Letter Queue)
      ═══════════════════════════════════╤══════════════════════════
                                         ▼
                              ┌──────────────────┐
                              │ Notification     │
                              │ Service (:8006)  │
                              │ Console / SSE    │
                              └──────────────────┘
```

### Đặc trưng phân tán cốt lõi:
- **Database-per-Service:** Mỗi microservice sở hữu cơ sở dữ liệu và schema riêng biệt (`user_db`, `driver_db`, `match_db`, `trip_db`, `payment_db`), không truy cập chéo database.
- **Saga Pattern (Choreography & Orchestration):** Điều phối giao dịch phân tán giữa Đặt xe $\rightarrow$ Khóa giữ tài xế $\rightarrow$ Tạm giữ cước ví $\rightarrow$ Xác nhận chuyến; tự động kích hoạt bù trừ giải phóng tài xế và hoàn cước khi phát sinh lỗi hoặc hủy chuyến.
- **Concurrency Control:** Sử dụng CAS Optimistic Locking (`version`) kết hợp `FOR UPDATE SKIP LOCKED` trên PostgreSQL để triệt tiêu tình trạng tranh chấp và double-booking khi nhiều khách cùng đặt một tài xế.
- **Reliable Messaging:** Topic Exchange bền bỉ, hàng đợi `durable`, Transactional Outbox Pattern, Deduplication qua `processed_events`, Bounded Retries và Dead-Letter Queue (`trip.dlq`).
- **Distributed Tracing:** Đồng bộ `X-Correlation-ID` xuyên suốt từ Client $\rightarrow$ API Gateway $\rightarrow$ Microservices $\rightarrow$ RabbitMQ Envelopes.

---

## 3. Danh Mục Dịch Vụ và Phân Bổ Cổng

| Thành phần | Dịch vụ | Cổng truy cập | Cơ sở dữ liệu | Vai trò chính |
| :--- | :--- | :---: | :--- | :--- |
| **Gateway** | `api-gateway` | `8080` | Không lưu state | Reverse proxy, kiểm tra JWT, đồng bộ Correlation ID, rate limit |
| **Frontend** | `web-dashboard` | `3000` | Static / In-memory | Giao diện bản đồ mô phỏng thời gian thực cho Khách & Tài xế |
| **Auth** | `identity-service` | `8001` | SQLite WAL (`user_db`) | Quản lý người dùng, mã hóa `scrypt`, cấp và thu hồi JWT |
| **Driver** | `driver-service` | `8002` | PostgreSQL 17 (`driver_db`) | Vị trí GPS, trạng thái hoạt động, Reservation lock |
| **Trip** | `trip-service` | `8003` | SQLite WAL (`trip_db`) | Vòng đời chuyến xe, Dynamic Pricing, Saga Coordinator |
| **Matching** | `matching-service` | `8004` | PostgreSQL 17 (`match_db`) | Lọc tài xế theo bán kính Haversine, điều phối ứng viên |
| **Payment** | `payment-service` | `8005` | PostgreSQL 17 (`payment_db`) | Quản lý ví, tạm giữ cước (Hold), quyết toán (Capture), hoàn tiền |
| **Notif** | `notification-service`| `8006` | In-memory / Console | Nhận sự kiện từ Message Queue và phát tin tức thời qua SSE |
| **Broker** | `rabbitmq` | `5672` / `15672` | Mnesia (durable) | RabbitMQ 4 Management Console, Topic Exchange, DLX, DLQ |
| **Database**| `postgres` | `5432` | Volume lưu trữ | PostgreSQL 17 chứa 3 database phân lập cho các service |

---

## 4. Yêu Cầu Môi Trường

- **Docker Desktop / Docker Engine:** Hỗ trợ Docker Compose v2 trở lên.
- **Node.js:** Phiên bản `>= 22.13.0 LTS` (khuyến nghị khi chạy các script kiểm tra và khởi tạo dữ liệu cục bộ).
- **Phần cứng:** Tối thiểu 4 GB RAM khả dụng khi bật đầy đủ cụm container.

---

## 5. Hướng Dẫn Cài Đặt và Khởi Chạy

### Bước 1: Chuẩn bị biến môi trường
Sao chép tệp mẫu `.env.example` thành `.env`:
```bash
cp .env.example .env
```
*(Các tham số mặc định trong `.env.example` đã được cấu hình sẵn sàng cho môi trường chạy Docker Compose).*

### Bước 2: Kiểm tra môi trường nền tảng
```bash
npm run check
```

### Bước 3: Khởi động toàn bộ hệ thống bằng Docker Compose
```bash
docker compose -f deploy/docker-compose.yml --profile full up -d --build
```

Kiểm tra trạng thái sẵn sàng của cụm 10 container:
```bash
docker compose -f deploy/docker-compose.yml ps
```
*(Đảm bảo tất cả 10 container chuyển sang trạng thái `Up (healthy)`).*

### Bước 4: Khởi tạo dữ liệu mẫu (Seed Data)
```bash
npm run seed
```
Lệnh trên sẽ tự động khởi tạo các tài khoản khách, tài xế, nạp số dư ví ban đầu và cập nhật toạ độ sẵn sàng nhận cuốc.

---

## 6. Truy Cập Hệ Thống

Sau khi khởi chạy hoàn tất:
- **Giao diện điều hành (Web Dashboard):** `http://localhost:3000`
- **Cổng API Gateway:** `http://localhost:8080`
- **RabbitMQ Management UI:** `http://localhost:15672` (Tài khoản: `ds03_admin` / mật khẩu cấu hình trong `.env`)

### Danh sách tài khoản demo có sẵn:

| Vai trò | Email đăng nhập | Mật khẩu | Trạng thái ban đầu |
| :--- | :--- | :--- | :--- |
| **Hành khách 1** | `passenger1@demo.ds03` | `Password123!` | Số dư ví: 300.000 đ |
| **Hành khách 2** | `passenger2@demo.ds03` | `Password123!` | Số dư ví: 300.000 đ |
| **Hành khách 0** | `passenger0@demo.ds03` | `Password123!` | Số dư ví: 0 đ (Dùng kiểm thử Saga bù trừ khi thiếu tiền) |
| **Tài xế 1** | `driver1@demo.ds03` | `Password123!` | Tài xế: Nguyễn Văn Tài, sẵn sàng nhận cuốc (`AVAILABLE`) |
| **Tài xế 2** | `driver2@demo.ds03` | `Password123!` | Tài xế: Lê Văn Lái, sẵn sàng nhận cuốc (`AVAILABLE`) |

---

## 7. Cấu Trúc Thư Mục Sản Phẩm (Production Structure)

```text
.
├── .env.example                # Cấu hình biến môi trường mẫu
├── .gitattributes              # Quy ước xử lý kết thúc dòng Git
├── .gitignore                  # Danh sách loại trừ tệp tạm, secret và dependencies
├── package.json                # Cấu hình định danh dự án và các lệnh tiện ích
├── README.md                   # Hướng dẫn kiến trúc, triển khai và vận hành hệ thống
├── deploy/                     # Cấu hình triển khai hạ tầng
│   ├── docker-compose.yml      # Khởi chạy toàn bộ cụm 10 container
│   ├── init-postgres.sh        # Khởi tạo các database và phân quyền PostgreSQL
│   ├── rabbitmq-definitions.json # Khởi tạo Exchange, Queues và DLQ RabbitMQ
│   └── rabbitmq.conf           # Cấu hình nạp definitions cho RabbitMQ
├── scripts/                    # Scripts tiện ích runtime
│   ├── check.js                # Kiểm tra runtime Node.js và SQLite native
│   └── seed-demo.js            # Nạp dữ liệu mẫu cho phiên demo
├── services/                   # Thư viện dùng chung giữa các dịch vụ
│   └── _shared/                # Module AMQP, Auth, ID, Logging, Geo, HTTP
└── src/                        # Mã nguồn các microservices
    ├── api-gateway/            # Central Gateway (Port 8080)
    ├── driver-service/         # Quản lý tài xế & vị trí (Port 8002)
    ├── identity-service/       # Xác thực & người dùng (Port 8001)
    ├── matching-service/       # Ghép tài xế theo toạ độ (Port 8004)
    ├── notification-service/   # Thông báo thời gian thực SSE (Port 8006)
    ├── payment-service/        # Quản lý ví & thanh toán (Port 8005)
    ├── trip-service/           # Vòng đời chuyến đi & Saga (Port 8003)
    └── web-dashboard/          # Giao diện web mô phỏng (Port 3000)
```
