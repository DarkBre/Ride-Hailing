# PROJECT BRIEF: RIDE-HAILING MICROSERVICES SYSTEM (DS03)

## 1. Thông Tin Tổng Quan (Project Overview)
* **Tên đề tài:** Xây dựng hệ thống đặt xe công nghệ theo kiến trúc Microservices mô phỏng Grab/Uber (Topic DS03).
* **Môn học:** Hệ phân tán (Distributed Systems).
* **Quy mô nhóm:** 3 thành viên.
* **Thời hạn hoàn thành:** 
  * Hạn nộp GitHub & Báo cáo: 22/11/2026.
  * Lịch bảo vệ & Demo: 23/11/2026 – 30/11/2026.
* **Tài liệu quy chuẩn tuân thủ:** 
  * `COURSE PROJECT SPECIFICATION.pdf` (Đặc tả môn học).
  * `D:\KHUNG_QUY_TRINH_PROJECT_CHUAN_V1.md` (Khung quy trình chuẩn V1.0).

---

## 2. Mục Tiêu Dự Án (Objectives)
1. **Kiến trúc Microservices độc lập:** Xây dựng hệ thống gồm 5 business services và 1 API Gateway. Mỗi service chạy như một tiến trình/container độc lập, có database riêng biệt (Database-per-service), giao tiếp thuần túy qua mạng (HTTP/REST và RabbitMQ).
2. **Giải quyết triệt để các bài toán phân tán cốt lõi:**
   * **Giao dịch phân tán (Distributed Transaction):** Triển khai Saga Pattern kèm bù trừ (Compensating Actions) cho luồng Đặt xe – Giữ cước – Nhận xe.
   * **Kiểm soát đồng thời (Concurrency Control):** Ngăn chặn hiện tượng 2 khách hàng tranh chấp cùng 1 tài xế tại cùng thời điểm bằng PostgreSQL Row-level Lock (`SELECT FOR UPDATE SKIP LOCKED`) & Optimistic Versioning.
   * **Đảm bảo độ tin cậy thông điệp (Reliable Messaging):** Triển khai Idempotency Key, Deduplication, Bounded Retries với Exponential Backoff, Dead-Letter Queue (DLQ).
   * **Tính toàn vẹn xuất bản sự kiện:** Áp dụng Transactional Outbox Pattern để tránh mất mát event giữa Database và Message Broker.
   * **Định giá động (Dynamic Pricing Engine):** Tính cước linh hoạt theo thời gian thực dựa trên nhu cầu và mật độ tài xế khả dụng.
   * **Khả năng chịu lỗi và tự phục hồi (Fault Tolerance & Recovery):** Minh chứng hệ thống không mất dữ liệu khi một service bị sập (`docker stop`), lưu trữ message an toàn trong queue và khôi phục xử lý khi service restart.
   * **Truy vết phân tán (Distributed Tracing):** Sử dụng `X-Correlation-ID` đồng bộ xuyên suốt qua Gateway, HTTP headers và Message headers.
3. **Trực quan hoá quá trình nghiệm thu:** Cung cấp Web Simulation Dashboard (Bản đồ Leaflet, điều khiển 2 khách & 1 tài xế, Live Streaming Logs) phục vụ 7–10 phút demo trước hội đồng.

---

## 3. Tech Stack & Hạ Tầng (Technology Decisions)
* **Ngôn ngữ & Runtime:** Node.js (v20+ LTS) / TypeScript.
* **Framework Web / Microservices:** Express / Fastify (nhẹ, hiệu năng cao, linh hoạt).
* **Message Broker:** RabbitMQ 3.13+ (Hỗ trợ AMQP 0-9-1, Topic Exchange, Dead-Letter Exchange, Durable Queues, Publisher Confirms, Manual ACK).
* **Database Engine:** PostgreSQL 16+ (Database-per-service: `user_db`, `driver_db`, `trip_db`, `match_db`, `payment_db`).
* **Concurrency Locking & Geo:** PostgreSQL Row-Level Lock (`SELECT FOR UPDATE SKIP LOCKED`), tính khoảng cách bằng công thức lượng giác Haversine / PostGIS.
* **Giao diện Demo:** Single Page App (HTML5, TailwindCSS, Leaflet OpenStreetMap, Server-Sent Events).
* **Containerization:** Docker & Docker Compose v2.

---

## 4. Phân Vai Trách Nhiệm Cân Bằng (Balanced RACI & Workload Matrix)

Nhằm đảm bảo **khối lượng công việc bình đẳng tuyệt đối (33.3% - 33.3% - 33.3%)**, mỗi thành viên sở hữu **2 thành phần/service**, **1 cơ chế phân tán trọng tâm**, **một phần bộ kiểm thử** và **1/3 khối lượng báo cáo & slide**:

```
┌─────────────────────────────────┬─────────────────────────────────┬─────────────────────────────────┐
│          THÀNH VIÊN 1           │          THÀNH VIÊN 2           │          THÀNH VIÊN 3           │
│    (Trip, Auth & Pricing)       │  (Driver, Matching & Locking)   │   (Payment, Fault & Dashboard)  │
├─────────────────────────────────┼─────────────────────────────────┼─────────────────────────────────┤
│ • Identity / User Service       │ • Driver / Location Service     │ • Simulated Payment Service     │
│ • Trip / Booking Service        │ • Matching Service              │ • API Gateway & Web Dashboard   │
│ • Saga Coordinator (Trip State) │ • PostgreSQL Concurrency Lock   │ • RabbitMQ Hạ tầng & DLQ        │
│ • Dynamic Pricing Engine        │ • Idempotency & Deduplication   │ • Transactional Outbox Pattern  │
│ • 4 Functional + 2 Security Test│ • 2 Functional + 2 Concurr Test │ • 2 Functional + 2 Fault + 1Load│
│ • Báo cáo: Ch. 1-4 (7-8 trang)  │ • Báo cáo: Ch. 5-9 (7-8 trang)  │ • Báo cáo: Ch. 10-14 (7-8 trang)│
└─────────────────────────────────┴─────────────────────────────────┴─────────────────────────────────┘
```

### Bảng Ma Trận RACI Chi Tiết

| Thành phần & Nhiệm vụ | Thành viên 1 | Thành viên 2 | Thành viên 3 | Ghi chú nghiệm thu |
|---|:---:|:---:|:---:|---|
| **Identity Service (Port 8001)** | **A / R** | C | I | Đăng ký, đăng nhập JWT, phân quyền Driver/Passenger, băm mật khẩu bcrypt. |
| **Trip / Booking Service (Port 8003)** | **A / R** | C | C | State Machine vòng đời cuốc xe, điều phối luồng Saga, lưu trữ Outbox. |
| **Dynamic Pricing Engine** | **A / R** | I | I | Thuật toán tính cước động dựa trên toạ độ Haversine và tỷ lệ cung/cầu. |
| **Driver / Location Service (Port 8002)**| C | **A / R** | I | Quản lý profile tài xế, cập nhật toạ độ GPS, truy vấn tài xế khả dụng lân cận. |
| **Matching Service (Port 8004)** | C | **A / R** | I | Thuật toán ghép xe gần nhất, kiểm tra khoảng cách. |
| **Concurrency Control (PostgreSQL Lock)**| I | **A / R** | I | Sử dụng `SELECT FOR UPDATE SKIP LOCKED` & Versioning ngăn 2 khách book cùng 1 xe. |
| **Simulated Payment Service (Port 8005)**| C | I | **A / R** | Ví ảo, giao dịch Hold (tạm giữ), Capture (trừ thật) và Refund (hoàn tiền bù trừ). |
| **API Gateway (Port 8080) & Reverse Proxy**| C | C | **A / R** | Định tuyến, sinh Correlation-ID, forward JWT, SSE stream log thời gian thực. |
| **Hạ tầng RabbitMQ, DLQ & Retry** | I | I | **A / R** | Khởi tạo Exchanges, Queues, Dead-Letter Exchange/Queue, cấu hình persistent. |
| **Transactional Outbox Publisher Worker**| I | I | **A / R** | Worker định kỳ quét bảng outbox, gửi message có publisher confirms. |
| **Web Simulation Dashboard (Port 3000)** | C | C | **A / R** | Bản đồ Leaflet trực quan, giao diện 2 khách tranh chấp xe, live log trace. |
| **Kiểm thử Chức năng (8 Functional Tests)**| **R (4)** | **R (2)** | **R (2)** | Chia đều 8 bài test chức năng theo service phụ trách. |
| **Kiểm thử Concurrency (2 Tests)** | I | **A / R** | I | Kịch bản 2 khách book 1 tài xế & 2 request trừ tiền đồng thời. |
| **Kiểm thử Chịu lỗi & Phục hồi (2 Tests)** | I | I | **A / R** | Kịch bản kill service khi đang chạy và kịch bản Saga bù trừ. |
| **Kiểm thử Bảo mật (2 Tests)** | **A / R** | I | I | Kịch bản giả mạo token, vượt quyền RBAC và payload injection. |
| **Kiểm thử Hiệu năng & Tải (1 Test)** | I | I | **A / R** | Đo Throughput, Latency p95/p99, RAM/CPU qua Docker stats. |
| **Báo cáo đồ án (docs/report.pdf)** | **R (Ch 1-4)**| **R (Ch 5-9)** | **R (Ch 10-14)**| Chia đều 3 phần tương đương ~8-9 trang mỗi người (tổng 25 trang). |
| **Thuyết trình Demo (7–10 phút)** | Demo Luồng 1 | Demo Luồng 2 | Demo Luồng 3,4 | Cả 3 thành viên đều tham gia thuyết trình theo quy chế Mục 11. |

*(Chú thích RACI: **A** = Accountable - Chịu trách nhiệm chính; **R** = Responsible - Người thực thi; **C** = Consulted - Người phối hợp/tham vấn; **I** = Informed - Người được thông báo).*

---

## 5. Tiêu Chí Nghiệm Thu Chung (Definition of Success)
1. Toàn bộ hệ thống khởi động hoàn chỉnh chỉ với 1 lệnh: `docker compose up --build`.
2. Không có service nào truy cập chéo database của nhau.
3. Kịch bản Concurrency chứng minh rõ ràng: 2 khách book cùng 1 tài xế $\rightarrow$ chỉ 1 khách thành công, khách kia được giải quyết hợp lệ mà không xảy ra race condition.
4. Kịch bản Fault Tolerance chứng minh: Kill Payment Service $\rightarrow$ Message chờ trong RabbitMQ $\rightarrow$ Bật lại service $\rightarrow$ Xử lý hoàn tất chuyến đi.
5. Bộ báo cáo đồ án `docs/report.pdf` (20–30 trang) và slide thuyết trình `docs/slides.pdf` hoàn thiện đúng yêu cầu.
