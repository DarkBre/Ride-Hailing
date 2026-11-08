# DS03: RIDE-HAILING MICROSERVICES SYSTEM (GRAB / UBER SIMULATION)

> **Môn học:** Hệ phân tán (Distributed Systems)  
> **Đề tài:** Topic DS03 – Build a Ride-Hailing Microservices System Simulating Grab/Uber  
> **Quy chuẩn quản trị:** Tuân thủ `KHUNG_QUY_TRINH_PROJECT_CHUAN_V1.md` và `COURSE PROJECT SPECIFICATION.pdf`.

---

## 1. Giới Thiệu Dự Án (Project Description)
Dự án mô phỏng hệ thống đặt xe công nghệ (tương tự Grab, Uber) dựa trên kiến trúc **Event-Driven Microservices**. Toàn bộ hệ thống bao gồm **5 business microservices độc lập và 1 API Gateway**, mỗi dịch vụ chạy trong một tiến trình/container riêng rẽ, sở hữu cơ sở dữ liệu tách biệt hoàn toàn (**Database-per-service**) và giao tiếp qua mạng bằng HTTP RESTful API và RabbitMQ Message Broker.

### Các Đặc Trưng Hệ Phân Tán Trọng Yếu:
* **Giao Dịch Phân Tán (Saga Pattern):** Phối hợp luồng Đặt xe $\rightarrow$ Match tài xế $\rightarrow$ Tạm giữ cước $\rightarrow$ Xác nhận chuyến; tự động kích hoạt **Compensating Actions** giải phóng tài xế và huỷ cuốc khi thanh toán thất bại.
* **Kiểm Soát Đồng Thời (Concurrency Control):** Ngăn chặn triệt để hiện tượng 2 khách hàng tranh chấp cùng 1 tài xế bằng cơ chế **PostgreSQL Row-Level Lock (`SELECT FOR UPDATE SKIP LOCKED`)** và Optimistic Versioning.
* **Độ Tin Cậy Thông Điệp (Reliable Messaging):** Sử dụng Idempotency Keys, Deduplication, Bounded Retries và Dead-Letter Queue (DLQ).
* **Xuất Bản Sự Kiện Đáng Tin Cậy (Transactional Outbox Pattern):** Tránh hiện tượng dual-write, bảo đảm thông điệp sự kiện không bao giờ bị thất lạc.
* **Định Giá Động (Dynamic Pricing):** Tự động điều chỉnh hệ số giá cước theo thời gian thực dựa trên tỷ lệ cung cầu (tài xế rảnh / cuốc đang chờ).
* **Chịu Lỗi & Tự Phục Hồi (Fault Tolerance):** Cho phép tắt đột ngột bất kỳ service nào trong luồng xử lý; tin nhắn được lưu trữ bền bỉ trong RabbitMQ và tiếp tục hoàn tất khi service khởi động lại.
* **Truy Vết Phân Tán (Distributed Tracing):** Gắn `X-Correlation-ID` xuyên suốt tất cả các log từ API Gateway qua các microservices.
* **Web Simulation Dashboard:** Bản đồ tương tác trực quan (Leaflet) mô phỏng xe chạy, 2 màn hình khách - tài xế và live log phân tán phục vụ buổi bảo vệ (7–10 phút).

---

## 2. Kiến Trúc Hệ Thống (Architecture & Components)

```
                            [ Web Simulation Dashboard (Port 3000) ]
                                               │
                                               │ HTTP / REST / SSE Stream
                                               ▼
                                   ┌───────────────────────┐
                                   │      API GATEWAY      │
                                   │      (Port 8080)      │
                                   └───────────┬───────────┘
                                               │
       ┌───────────────────────┬───────────────┴───────────────┬───────────────────────┐
       ▼                       ▼                               ▼                       ▼
┌──────────────┐      ┌─────────────────┐             ┌─────────────────┐     ┌─────────────────┐
│Identity/User │      │ Driver/Location │             │  Trip/Booking   │     │Simulated Payment│
│   Service    │      │     Service     │             │     Service     │     │     Service     │
│ (Port 8001)  │      │   (Port 8002)   │             │   (Port 8003)   │     │   (Port 8005)   │
│ DB: user_db  │      │ DB: driver_db   │             │  DB: trip_db    │     │ DB: payment_db  │
└──────────────┘      └────────┬────────┘             └────────┬────────┘     └────────┬────────┘
                               │                               │                       │
                               │ REST Query                    │                       │
                               ▼                               │                       │
                      ┌─────────────────┐                      │                       │
                      │Matching Service │                      │                       │
                      │   (Port 8004)   │                      │                       │
                      │  DB: match_db   │                      │                       │
                      └────────┬────────┘                      │                       │
                               │                               │                       │
                               ▼                               ▼                       ▼
                     ═════════════════════════════════════════════════════════════════════════
                                        RABBITMQ MESSAGE BROKER (AMQP)
                          Topics: trip.event.created, trip.event.driver_matched,
                                  payment.event.hold_success, payment.event.hold_failed,
                                  trip.event.release_driver, trip.event.completed
                          Dead-Letter Exchange: trip.dlx -> Queue: trip.dlq
                     ═════════════════════════════════════════════════════════════════════════
```

---

## 3. Phân Công Trách Nhiệm Thành Viên (Balanced Task Assignment Table - 33.3% Mỗi Người)

Khối lượng công việc được phân chia cân bằng tuyệt đối giữa 3 thành viên: mỗi người sở hữu **2 thành phần/service**, **1 cơ chế phân tán trọng tâm**, **1 nhóm kịch bản test** và **1/3 khối lượng báo cáo & slide**:

| Thành viên | Khối trách nhiệm chính | Services & Modules phụ trách | Cơ chế phân tán & Kiểm thử phụ trách | Báo cáo & Thuyết trình |
|---|---|---|---|---|
| **Thành viên 1** | **Trip Orchestration, Auth & Dynamic Pricing** | • `Identity / User Service` (Port 8001)<br>• `Trip / Booking Service` (Port 8003) | • **Saga Transaction Coordinator** (Điều phối trạng thái cuốc)<br>• **Dynamic Pricing Engine** (Định giá theo cung/cầu)<br>• 4 Functional Tests (FT-01, FT-02, FT-05, FT-08)<br>• 2 Security Tests (ST-01: RBAC, ST-02: Input Validation) | • Viết Chương 1–4 Báo cáo (~8 trang)<br>• Demo Luồng 1: Xác thực, Đặt xe & Vòng đời cuốc xe (3 phút) |
| **Thành viên 2** | **Driver, Location & Concurrency Control** | • `Driver / Location Service` (Port 8002)<br>• `Matching Service` (Port 8004) | • **PostgreSQL Concurrency Control** (`SELECT FOR UPDATE SKIP LOCKED`)<br>• Thuật toán định vị không gian Haversine<br>• Idempotency & Deduplication logic<br>• 2 Functional Tests (FT-03, FT-04, FT-06)<br>• 2 Concurrency Tests (CT-01: 2 khách book 1 xe, CT-02: Ví) | • Viết Chương 5–9 Báo cáo (~8 trang)<br>• Demo Luồng 2: Tranh chấp đồng thời & Khoá độc quyền tài xế (3 phút) |
| **Thành viên 3** | **Payment, Fault Tolerance & Web Dashboard** | • `Simulated Payment Service` (Port 8005)<br>• `API Gateway` (Port 8080)<br>• `Web Simulation Dashboard` (Port 3000) | • **Hạ tầng RabbitMQ, Dead-Letter Queue (DLQ)** & Bounded Retries<br>• **Transactional Outbox Pattern** (Chống dual-write)<br>• Distributed Tracing (`X-Correlation-ID`)<br>• 2 Functional Tests (FT-07: Ví ảo/Hold tiền)<br>• 2 Fault Tests (FR-01: Kill service & phục hồi, FR-02: Saga Bù trừ)<br>• 1 Load/Performance Experiment (k6 / Autocannon) | • Viết Chương 10–14 Báo cáo (~8 trang)<br>• Demo Luồng 3: Chịu lỗi, sập container & Saga bù trừ (3 phút) |

---

## 4. Cấu Trúc Thư Mục Chuẩn (Project Structure)

```text
d:\btl phân tán/
├── .env.example            # Cấu hình biến môi trường mẫu
├── README.md               # Tài liệu hướng dẫn tổng quan và vận hành
├── docs/                   # Bộ tài liệu SSOT chuẩn mực
│   ├── PROJECT_BRIEF.md    # Mục tiêu, phạm vi, bối cảnh, RACI
│   ├── REQUIREMENTS.md     # Yêu cầu MoSCoW, State Machines, Acceptance Criteria
│   ├── ARCHITECTURE.md     # Kiến trúc phân tán, Saga, Outbox, Concurrency Lock
│   ├── CONTRACTS.md        # REST DTOs, RabbitMQ Envelope, Database Schemas
│   ├── TEST_PLAN.md        # Kịch bản kiểm thử (8 Functional, 2 Concurrency, 2 Fault, 2 Security, 1 Load)
│   ├── DECISIONS.md        # Kiến trúc quyết định (ADR-001 -> ADR-006)
│   └── CHANGELOG.md        # Nhật ký phát triển phiên bản
├── deploy/                 # Docker Compose và hạ tầng triển khai
│   ├── docker-compose.yml
│   └── postgres-init/      # Scripts tạo 5 database tự động khi boot
├── src/                    # Mã nguồn các Microservices
│   ├── api-gateway/
│   ├── identity-service/
│   ├── driver-service/
│   ├── trip-service/
│   ├── matching-service/
│   ├── payment-service/
│   └── web-dashboard/
├── scripts/                # Script khởi động, test tranh chấp, test chịu lỗi
│   ├── seed_data.sh / .ps1
│   ├── test_concurrency.js # Bắn 2 request tranh chấp cùng tài xế
│   └── fault_injection.sh  # Script dừng và bật lại container để kiểm tra queue
└── tests/                  # Bộ test tự động (Functional, Concurrency, Fault, Security)
```

---

## 5. Hướng Dẫn Cài Đặt & Khởi Chạy (Quickstart)

### 5.1. Yêu cầu môi trường
* Node.js v20+ LTS
* Docker Desktop & Docker Compose v2+
* RAM tối thiểu: 4 GB rảnh

### 5.2. Khởi chạy toàn bộ hệ thống
```bash
# 1. Clone repository và di chuyển vào thư mục dự án
cd "d:\btl phân tán"

# 2. Tạo file cấu hình từ file mẫu
cp .env.example .env

# 3. Khởi chạy toàn bộ hệ thống bằng Docker Compose (1-click)
docker compose up --build -d

# 4. Kiểm tra trạng thái các container đang chạy
docker compose ps
```

### 5.3. Truy cập các dịch vụ
* **Web Simulation Dashboard:** `http://localhost:3000`
* **API Gateway:** `http://localhost:8080`
* **RabbitMQ Management Dashboard:** `http://localhost:15672` (Tài khoản: `guest` / `guest`)

---

## 6. Kịch Bản Trình Diễn Bắt Buộc (Demonstration Scenarios)

### Kịch bản 1: Luồng Đặt Xe & Hoàn Thành Tiêu Chuẩn (Happy Path)
1. Mở Web Dashboard tại `http://localhost:3000`.
2. Tài xế bật trạng thái `AVAILABLE` và cập nhật vị trí GPS.
3. Hành khách tạo cuốc xe.
4. Matching Service tìm và lock tài xế $\rightarrow$ Payment Service tạm giữ tiền $\rightarrow$ Tài xế đón khách và bấm hoàn thành cuốc xe.

### Kịch bản 2: Tranh Chấp Đồng Thời (Concurrency Conflict Demo)
1. Khởi tạo duy nhất 1 tài xế ở trạng thái `AVAILABLE`.
2. Nhấn đồng thời 2 nút **"Khách A Đặt Xe"** và **"Khách B Đặt Xe"** trên giao diện Web (hoặc chạy script `node scripts/test_concurrency.js`).
3. **Kết quả chứng minh:** Nhờ câu lệnh `SELECT ... FOR UPDATE SKIP LOCKED` trong PostgreSQL, chỉ 1 khách hàng match được với tài xế. Khách hàng còn lại nhận thông báo không có tài xế phù hợp, không xảy ra xung đột dữ liệu.

### Kịch bản 3: Chịu Lỗi & Phục Hồi Thông Điệp (Fault Tolerance Demo)
1. Khách hàng bấm đặt xe.
2. Ngay lập tức tắt Payment Service: `docker stop payment-service`.
3. Kiểm tra trên RabbitMQ Management (`http://localhost:15672`): Tin nhắn `payment.event.hold_requested` nằm an toàn trong `payment.queue`.
4. Bật lại Payment Service: `docker start payment-service`.
5. Payment Service tự động tiêu thụ tin nhắn, tạm giữ cước và cuốc xe tiếp tục hoàn thành bình thường.

### Kịch bản 4: Saga Bù Trừ (Compensating Transaction Demo)
1. Đặt cuốc xe với tài khoản khách hàng có số dư = 0 VNĐ.
2. Matching Service gán tài xế $D_1$ (`BUSY`).
3. Payment Service phát hiện không đủ tiền $\rightarrow$ bắn event `payment.event.hold_failed`.
4. Trip Service kích hoạt bù trừ: Huỷ cuốc xe và mở khoá tài xế $D_1$ về trạng thái `AVAILABLE`.

---

## 7. Tài Liệu Nghiệm Thu Chi Tiết
* [PROJECT_BRIEF.md](file:///d:/btl%20ph%C3%A2n%20t%C3%A1n/docs/PROJECT_BRIEF.md): Mục tiêu và phân vai RACI.
* [REQUIREMENTS.md](file:///d:/btl%20ph%C3%A2n%20t%C3%A1n/docs/REQUIREMENTS.md): Phân loại MoSCoW, State Machine và Tiêu chí nghiệm thu.
* [ARCHITECTURE.md](file:///d:/btl%20ph%C3%A2n%20t%C3%A1n/docs/ARCHITECTURE.md): Kiến trúc chuyên sâu, Saga, Concurrency Lock, Outbox, Dynamic Pricing.
* [CONTRACTS.md](file:///d:/btl%20ph%C3%A2n%20t%C3%A1n/docs/CONTRACTS.md): Danh mục API, Event Schema và Database Schemas.
* [TEST_PLAN.md](file:///d:/btl%20ph%C3%A2n%20t%C3%A1n/docs/TEST_PLAN.md): Danh mục 15 bài test bắt buộc theo mục 9 của đặc tả.
* [DECISIONS.md](file:///d:/btl%20ph%C3%A2n%20t%C3%A1n/docs/DECISIONS.md): Nhật ký quyết định kiến trúc (ADRs).
