# DS03: RIDE-HAILING MICROSERVICES SYSTEM (GRAB / UBER SIMULATION)

> **Môn học:** Hệ phân tán (Distributed Systems)  
> **Đề tài:** Topic DS03 – Build a Ride-Hailing Microservices System Simulating Grab/Uber  
> **Quy chuẩn quản trị:** Tuân thủ `KHUNG_QUY_TRINH_PROJECT_CHUAN_V1.md` và `COURSE PROJECT SPECIFICATION.pdf`.

---

## 1. Giới Thiệu Dự Án (Project Description)
Dự án mô phỏng hệ thống đặt xe công nghệ (tương tự Grab, Uber) dựa trên kiến trúc **Event-Driven Microservices**. Toàn bộ hệ thống bao gồm **8 business microservices độc lập và 1 API Gateway**, mỗi dịch vụ chạy trong một tiến trình riêng rẽ, sở hữu cơ sở dữ liệu tách biệt hoàn toàn (**Database-per-service** với SQLite WAL mode) và giao tiếp qua mạng bằng HTTP RESTful API và Message Broker.

### Các Đặc Trưng Hệ Phân Tán Trọng Yếu:
* **Giao Dịch Phân Tán (Saga Pattern):** Phối hợp luồng Đặt xe $\rightarrow$ Ghép tài xế $\rightarrow$ Tạm giữ cước $\rightarrow$ Xác nhận chuyến; tự động kích hoạt **Compensating Actions** giải phóng tài xế và huỷ cuốc khi thanh toán thất bại.
* **Kiểm Soát Đồng Thời (Concurrency Control):** Ngăn chặn triệt để hiện tượng 2 khách hàng tranh chấp cùng 1 tài xế bằng cơ chế **CAS Optimistic Lock (`version` checking)** và Atomic In-Memory State Updates.
* **Độ Tin Cậy Thông Điệp (Reliable Messaging):** Sử dụng Idempotency Keys, Deduplication, Bounded Retries và Dead-Letter Queue (DLQ).
* **Xuất Bản Sự Kiện Đáng Tin Cậy (Transactional Outbox Pattern):** Tránh hiện tượng dual-write, bảo đảm thông điệp sự kiện không bao giờ bị thất lạc giữa DB và Broker.
* **Định Giá Động (Dynamic Pricing):** Tự động điều chỉnh hệ số giá cước theo thời gian thực dựa trên cự ly Haversine GPS và tỷ lệ cung cầu (Surge Multiplier).
* **Chịu Lỗi & Tự Phục Hồi (Fault Tolerance):** Cho phép tắt đột ngột bất kỳ service nào trong luồng xử lý; tin nhắn được lưu trữ bền bỉ trong hàng đợi Message Broker và tiếp tục hoàn tất khi service khởi động lại.
* **Truy Vết Phân Tán (Distributed Tracing):** Gắn `X-Correlation-ID` xuyên suốt tất cả các log từ API Gateway qua các microservices.
* **Web Simulation Dashboard:** Bản đồ tương tác trực quan (Leaflet) mô phỏng xe chạy, 2 màn hình khách - tài xế và live log phân tán phục vụ buổi bảo vệ (10 phút).

---

## 2. Kiến Trúc Hệ Thống (Architecture & Components)

```
                            [ Web Simulation Dashboard (Port 8080) ]
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
 │ (Port 4001)  │      │   (Port 4002)   │             │   (Port 4003)   │     │   (Port 4006)   │
 │DB:identity.db│      │ DB: driver.db   │             │  DB: trip.db    │     │ DB: payment.db  │
 └──────────────┘      └────────┬────────┘             └────────┬────────┘     └────────┬────────┘
                                │                               │                       │
                                │ REST Query                    │                       │
                                ▼                               │                       │
                       ┌─────────────────┐             ┌────────▼────────┐              │
                       │Matching Service │             │ Pricing Service │              │
                       │   (Port 4004)   │             │   (Port 4005)   │              │
                       │  DB: matching.db│             │  DB: pricing.db │              │
                       └────────┬────────┘             └─────────────────┘              │
                                │                               │                       │
                                ▼                               ▼                       ▼
                      ═════════════════════════════════════════════════════════════════════════
                                      RELIABLE MESSAGE BROKER (Port 4000)
                           Topics: trip.event.created, trip.event.driver_matched,
                                   payment.event.hold_success, payment.event.hold_failed,
                                   trip.event.release_driver, trip.event.completed
                           Dead-Letter Queue (DLQ): dead_letter_events (DB: broker.db)
                      ═════════════════════════════════════════════════════════════════════════
                                                │
                                                ▼
                                    ┌───────────────────────┐
                                    │ Notification Service  │
                                    │      (Port 4007)      │
                                    │  DB: notification.db  │
                                    └───────────────────────┘
```

---

## 3. Phân Công Trách Nhiệm Thành Viên (Balanced Task Assignment Table - 33.3% Mỗi Người)

Khối lượng công việc được phân chia cân bằng tuyệt đối giữa 3 thành viên: mỗi người sở hữu **3 microservices**, **1 cơ chế phân tán trọng tâm**, **1 nhóm kịch bản test**, **1/3 thời lượng demo** và **1/3 khối lượng báo cáo & slide**:

### Bảng Phân Chia Tổng Quan Chuẩn

| Tiêu chí | Thành viên 1 *(Trưởng nhóm / DarkBre)* | Thành viên 2 *(Dương Quốc Hoàng)* | Thành viên 3 *(Quang)* |
|---|:---:|:---:|:---:|
| **Số Microservices làm chủ** | **3** (`Trip`, `Pricing`, `Identity`) | **3** (`Driver`, `Matching`, `Payment`) | **3** (`Broker`, `Notification`, `Gateway`) |
| **Cơ chế phân tán cốt lõi** | **Saga Coordinator & Bù trừ** | **CAS Lock Concurrency & Idempotency** | **Reliable Queue, DLQ & Fault Recovery** |
| **Thời lượng Demo (10 phút)** | **Phút 1 – 3** (Mở đầu & Saga chuẩn) | **Phút 4 – 6** (Tranh chấp 2 khách) | **Phút 7 – 10** (Sập service, DLQ & Kết luận) |
| **Khối lượng Báo cáo (`report.pdf`)** | **Chương 1 – 4** (~8–9 trang) | **Chương 5 – 8** (~8–9 trang) | **Chương 9 – 13** (~8–9 trang) |
| **Tỷ lệ đóng góp dự án** | **33.3%** | **33.3%** | **33.3%** |

---

### Bảng Phân Nhiệm Chi Tiết

| Thành viên | Khối trách nhiệm chính | Services & Modules phụ trách | Cơ chế phân tán & Kiểm thử phụ trách | Báo cáo & Thuyết trình |
|---|---|---|---|---|
| **Thành viên 1** *(Trưởng nhóm)* | **Trip Orchestration, Dynamic Pricing & Identity** | • `Identity Service` (Port 4001)<br>• `Trip Service` (Port 4003)<br>• `Pricing Service` (Port 4005) | • **Saga Transaction Coordinator & Bù trừ**<br>• Dynamic Pricing Engine (Haversine & Surge)<br>• 3 Functional Tests (FT-01, FT-02, FT-05)<br>• 2 Security Tests (ST-01, ST-02) | • Viết Chương 1–4 Báo cáo (~8–9 trang)<br>• Demo Luồng 1: Xác thực, Đặt xe & Vòng đời cuốc xe (Phút 1 – 3) |
| **Thành viên 2** *(Dương Quốc Hoàng)* | **Driver, Matching & Concurrency Control** | • `Driver Service` (Port 4002)<br>• `Matching Service` (Port 4004)<br>• `Payment Service` (Port 4006) | • **CAS Lock Concurrency Control** (`version` check)<br>• Idempotency & Deduplication logic<br>• 3 Functional Tests (FT-03, FT-04, FT-06)<br>• 2 Concurrency Tests (CT-01, CT-02) | • Viết Chương 5–8 Báo cáo (~8–9 trang)<br>• Demo Luồng 2: Tranh chấp đồng thời 2 khách & Khoá xe (Phút 4 – 6) |
| **Thành viên 3** *(Quang)* | **Message Broker, Gateway & Fault Recovery** | • `Broker Service` (Port 4000)<br>• `Notification Service` (Port 4007)<br>• `API Gateway & Web UI` (Port 8080) | • **Reliable Queue, Dead-Letter Queue (DLQ)**<br>• Fault Tolerance & Phục hồi khi sập tiến trình<br>• Distributed Tracing (`X-Correlation-ID`)<br>• 2 Functional Tests (FT-07, FT-08)<br>• 2 Fault Tests (FR-01, FR-02)<br>• 1 Load/Performance Experiment | • Viết Chương 9–13 Báo cáo (~8–9 trang)<br>• Demo Luồng 3: Sập service, DLQ & Kết luận (Phút 7 – 10) |

---

## 4. Cấu Trúc Thư Mục Chuẩn (Project Structure)

```text
d:\btl phân tán/
├── .env.example            # Cấu hình biến môi trường mẫu
├── package.json            # Cấu hình Node.js >= 22.5.0, 0 external dependencies
├── README.md               # Hướng dẫn tổng quan và vận hành dự án
├── docs/                   # Bộ tài liệu SSOT chuẩn mực
│   ├── PROJECT_BRIEF.md    # Mục tiêu, phạm vi, bối cảnh, RACI
│   ├── REQUIREMENTS.md     # Yêu cầu MoSCoW, State Machines, Acceptance Criteria
│   ├── ARCHITECTURE.md     # Kiến trúc phân tán, Saga, Outbox, Concurrency Lock
│   ├── CONTRACTS.md        # REST DTOs, Broker Envelope, Database Schemas
│   ├── TEST_PLAN.md        # Kịch bản kiểm thử (8 Functional, 2 Concurrency, 2 Fault, 2 Security, 1 Load)
│   ├── DECISIONS.md        # Kiến trúc quyết định (ADR-001 -> ADR-006)
│   └── CHANGELOG.md        # Nhật ký phát triển phiên bản
├── scripts/                # Script kiểm tra toàn vẹn, test tranh chấp, test chịu lỗi
│   ├── check.js            # Kiểm tra nền tảng Node.js, node:sqlite và shared modules
│   ├── test_concurrency.js # Bắn 2 request tranh chấp cùng 1 tài xế
│   └── fault_injection.js  # Script ngắt và phục hồi service để kiểm tra queue
├── services/               # Mã nguồn 9 Microservices độc lập
│   ├── _shared/            # Modules dùng chung (config, id, logger, store, auth, geo, http)
│   ├── identity/           # Port 4001 - Thành viên 1
│   ├── driver/             # Port 4002 - Thành viên 2 (Dương Quốc Hoàng)
│   ├── trip/               # Port 4003 - Thành viên 1
│   ├── matching/           # Port 4004 - Thành viên 2 (Dương Quốc Hoàng)
│   ├── pricing/            # Port 4005 - Thành viên 1
│   ├── payment/            # Port 4006 - Thành viên 2 (Dương Quốc Hoàng)
│   ├── broker/             # Port 4000 - Thành viên 3 (Quang)
│   ├── notification/       # Port 4007 - Thành viên 3 (Quang)
│   └── gateway/            # Port 8080 - Thành viên 3 (Quang)
└── tests/                  # Bộ test tự động (Functional, Concurrency, Fault, Security)
```

---

## 5. Hướng Dẫn Cài Đặt & Khởi Chạy (Quickstart)

### 5.1. Yêu cầu môi trường
* Node.js v22.5.0+ LTS (Dự án sử dụng trực tiếp `node:sqlite` native, không cần cài `npm install`).
* RAM tối thiểu: 2 GB rảnh.

### 5.2. Kiểm tra toàn vẹn codebase
```bash
# Di chuyển vào thư mục dự án
cd "d:\btl phân tán"

# Chạy script kiểm tra nền tảng
node scripts/check.js
```

---

## 6. Kịch Bản Trình Diễn Bắt Buộc (Demonstration Scenarios - 10 Phút)

### Kịch bản 1: Luồng Đặt Xe & Saga Tiêu Chuẩn (Phút 1 – 3, Thành viên 1)
1. Mở Web Dashboard tại `http://localhost:8080`.
2. Tài xế bật trạng thái `AVAILABLE` và cập nhật vị trí GPS.
3. Hành khách tạo cuốc xe: Pricing Service tính cước động $\rightarrow$ Matching Service gán tài xế $\rightarrow$ Payment Service tạm giữ cước $\rightarrow$ Chuyến đi xác nhận thành công.

### Kịch bản 2: Tranh Chấp Đồng Thời 2 Khách Hàng (Phút 4 – 6, Thành viên 2 - Dương Quốc Hoàng)
1. Khởi tạo duy nhất 1 tài xế ở trạng thái `AVAILABLE`.
2. Bắn đồng thời 2 HTTP requests tạo cuốc xe từ 2 khách hàng tới cùng toạ độ tài xế.
3. **Kết quả chứng minh:** Nhờ cơ chế CAS Optimistic Lock (`version` checking), chỉ duy nhất 1 khách hàng match được tài xế. Khách hàng còn lại nhận thông báo không có tài xế phù hợp (`no_driver`), không bao giờ bị gán trùng xe.

### Kịch bản 3: Chịu Lỗi, Sập Service & Saga Bù Trừ (Phút 7 – 10, Thành viên 3 - Quang)
1. **Chịu lỗi:** Đặt xe và ngắt đột ngột Payment Service $\rightarrow$ Sự kiện nằm an toàn trong Broker $\rightarrow$ Khởi động lại Payment Service $\rightarrow$ Tự động tiêu thụ sự kiện và hoàn tất cuốc xe.
2. **Saga bù trừ:** Đặt xe với tài khoản số dư = 0 VNĐ $\rightarrow$ Payment Service báo giữ tiền thất bại $\rightarrow$ Trip Service tự động kích hoạt bù trừ: Huỷ chuyến và giải phóng tài xế về lại trạng thái `AVAILABLE`.

---

## 7. Tài Liệu Nghiệm Thu Chi Tiết
* [PROJECT_BRIEF.md](file:///d:/btl%20ph%C3%A2n%20t%C3%A1n/docs/PROJECT_BRIEF.md): Mục tiêu và phân vai RACI.
* [REQUIREMENTS.md](file:///d:/btl%20ph%C3%A2n%20t%C3%A1n/docs/REQUIREMENTS.md): Phân loại MoSCoW, State Machine và Tiêu chí nghiệm thu.
* [ARCHITECTURE.md](file:///d:/btl%20ph%C3%A2n%20t%C3%A1n/docs/ARCHITECTURE.md): Kiến trúc chuyên sâu 9 microservices, Saga, Concurrency Lock, Outbox, Dynamic Pricing.
* [CONTRACTS.md](file:///d:/btl%20ph%C3%A2n%20t%C3%A1n/docs/CONTRACTS.md): Danh mục API, Event Schema và Database Schemas.
* [TEST_PLAN.md](file:///d:/btl%20ph%C3%A2n%20t%C3%A1n/docs/TEST_PLAN.md): Danh mục 15 bài test bắt buộc theo mục 9 của đặc tả.
* [DECISIONS.md](file:///d:/btl%20ph%C3%A2n%20t%C3%A1n/docs/DECISIONS.md): Nhật ký quyết định kiến trúc (ADRs).
