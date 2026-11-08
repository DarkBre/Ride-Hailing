# PROJECT BRIEF: RIDE-HAILING MICROSERVICES SYSTEM (DS03)

## 1. Thông Tin Tổng Quan (Project Overview)
* **Tên đề tài:** Xây dựng hệ thống đặt xe công nghệ theo kiến trúc Microservices mô phỏng Grab/Uber (Topic DS03).
* **Môn học:** Hệ phân tán (Distributed Systems).
* **Quy mô nhóm:** 3 thành viên.
  * **Thành viên 1 (Trưởng nhóm / DarkBre):** Phụ trách Kiến trúc nền tảng, `Trip`, `Pricing`, `Identity`.
  * **Thành viên 2 (Dương Quốc Hoàng):** Phụ trách `Driver`, `Matching`, `Payment`.
  * **Thành viên 3 (Quang):** Phụ trách `Broker`, `Notification`, `Gateway`.
* **Thời hạn hoàn thành:** 
  * Hạn nộp GitHub & Báo cáo: 22/11/2026.
  * Lịch bảo vệ & Demo: 23/11/2026 – 30/11/2026.
* **Tài liệu quy chuẩn tuân thủ:** 
  * `COURSE PROJECT SPECIFICATION.pdf` (Đặc tả môn học).
  * `D:\KHUNG_QUY_TRINH_PROJECT_CHUAN_V1.md` (Khung quy trình chuẩn V1.0).

---

## 2. Mục Tiêu Dự Án (Objectives)
1. **Kiến trúc Microservices độc lập:** Xây dựng hệ thống gồm 9 microservices độc lập (8 backend services + 1 API Gateway). Mỗi service chạy như một tiến trình độc lập, sở hữu cơ sở dữ liệu riêng biệt (**Database-per-service** với SQLite WAL), giao tiếp thuần túy qua mạng (HTTP/REST và Message Broker).
2. **Giải quyết triệt để các bài toán phân tán cốt lõi:**
   * **Giao dịch phân tán (Distributed Transaction):** Triển khai Saga Orchestration kèm bù trừ (Compensating Actions) cho luồng Đặt xe – Giữ cước – Nhận xe.
   * **Kiểm soát đồng thời (Concurrency Control):** Ngăn chặn hiện tượng 2 khách hàng tranh chấp cùng 1 tài xế tại cùng thời điểm bằng CAS Optimistic Lock (`version` control) & Atomic In-Memory State Updates.
   * **Đảm bảo độ tin cậy thông điệp (Reliable Messaging):** Triển khai Idempotency Key, Deduplication, Bounded Retries với Exponential Backoff, Dead-Letter Queue (DLQ).
   * **Tính toàn vẹn xuất bản sự kiện:** Áp dụng Transactional Outbox Pattern để tránh mất mát event giữa Database và Message Broker.
   * **Định giá động (Dynamic Pricing Engine):** Tính cước linh hoạt theo thời gian thực dựa trên cự ly Haversine GPS và hệ số nhu cầu cao điểm (Surge Multiplier).
   * **Khả năng chịu lỗi và tự phục hồi (Fault Tolerance & Recovery):** Minh chứng hệ thống không mất dữ liệu khi một service bị sập, lưu trữ message an toàn trong queue bền bỉ và khôi phục xử lý khi service restart.
   * **Truy vết phân tán (Distributed Tracing):** Sử dụng `X-Correlation-ID` đồng bộ xuyên suốt qua Gateway, HTTP headers và Message envelope.
3. **Trực quan hoá quá trình nghiệm thu:** Cung cấp Web Simulation Dashboard (Bản đồ Leaflet, điều khiển 2 khách & 1 tài xế, Live Streaming Logs) phục vụ 10 phút demo trước hội đồng.

---

## 3. Tech Stack & Hạ Tầng (Technology Decisions)
* **Ngôn ngữ & Runtime:** Node.js (>= 22.5.0 LTS) thuần (Zero external dependencies).
* **Database Engine:** `node:sqlite` Native với WAL mode (`busy_timeout = 5000ms`, `foreign_keys = ON`, Database-per-service độc lập).
* **Giao thức liên lạc:** HTTP/1.1 REST JSON và Message Broker (Pub/Sub, Topic Routing, DLQ, Idempotency).
* **Bảo mật:** Băm mật khẩu `scrypt` kèm salt ngẫu nhiên, JWT HMAC-SHA256, xác thực mạng nội bộ `X-Internal-Key`.
* **Định vị không gian:** Thuật toán Haversine tính khoảng cách GPS đường cong Trái Đất (km) và ước tính ETA.
* **Giao diện Demo:** Single Page App (HTML5, TailwindCSS, Leaflet Map, Server-Sent Events / SSE stream log).

---

## 4. Phân Vai Trách Nhiệm Cân Bằng (Balanced RACI & Workload Matrix)

Nhằm đảm bảo **khối lượng công việc bình đẳng tuyệt đối (33.3% - 33.3% - 33.3%)**, mỗi thành viên sở hữu **3 microservices**, **1 cơ chế phân tán trọng tâm**, **khối lượng kịch bản test tương ứng**, **1/3 thời lượng demo** và **1/3 khối lượng báo cáo đồ án**:

### Bảng Phân Chia Khối Lượng Công Việc Chuẩn

| Tiêu chí | Thành viên 1 *(Trưởng nhóm / DarkBre)* | Thành viên 2 *(Dương Quốc Hoàng)* | Thành viên 3 *(Quang)* |
|---|:---:|:---:|:---:|
| **Số Microservices làm chủ** | **3** (`Trip`, `Pricing`, `Identity`) | **3** (`Driver`, `Matching`, `Payment`) | **3** (`Broker`, `Notification`, `Gateway`) |
| **Cơ chế phân tán cốt lõi** | **Saga Coordinator & Bù trừ** | **CAS Lock Concurrency & Idempotency** | **Reliable Queue, DLQ & Fault Recovery** |
| **Thời lượng Demo (10 phút)** | **Phút 1 – 3** (Mở đầu & Saga chuẩn) | **Phút 4 – 6** (Tranh chấp 2 khách) | **Phút 7 – 10** (Sập service, DLQ & Kết luận) |
| **Khối lượng Báo cáo (`report.pdf`)** | **Chương 1 – 4** (~8–9 trang) | **Chương 5 – 8** (~8–9 trang) | **Chương 9 – 13** (~8–9 trang) |
| **Tỷ lệ đóng góp dự án** | **33.3%** | **33.3%** | **33.3%** |

---

### Bảng Ma Trận RACI Chi Tiết

| Thành phần & Nhiệm vụ | TV1 (Trưởng nhóm) | TV2 (Dương Quốc Hoàng) | TV3 (Quang) | Ghi chú nghiệm thu |
|---|:---:|:---:|:---:|---|
| **Identity Service (Port 4001)** | **A / R** | C | I | Đăng ký, đăng nhập JWT, phân quyền Driver/Passenger, băm mật khẩu `scrypt`. |
| **Pricing Service (Port 4005)** | **A / R** | I | I | Thuật toán tính cước động theo toạ độ Haversine GPS và hệ số nhu cầu cao điểm. |
| **Trip Service (Port 4003)** | **A / R** | C | C | State Machine vòng đời cuốc xe, Transactional Outbox, **Saga Coordinator & Bù trừ**. |
| **Driver Service (Port 4002)** | C | **A / R** | I | Quản lý hồ sơ tài xế, cập nhật GPS, truy vấn tài xế khả dụng lân cận. |
| **Matching Service (Port 4004)** | C | **A / R** | I | Ghép xe gần nhất, **CAS Optimistic Lock Concurrency** chống tranh chấp tài xế. |
| **Payment Service (Port 4006)** | C | **A / R** | I | Ví ảo, giao dịch Hold (tạm giữ), Capture (trừ thật) và Refund (hoàn tiền bù trừ). |
| **Broker Service (Port 4000)** | I | I | **A / R** | Reliable Message Broker, Dead-Letter Queue (DLQ), Exponential Retry, Deduplication. |
| **Notification Service (Port 4007)** | I | I | **A / R** | Tiếp nhận event từ Broker, gửi thông báo đẩy đến khách và tài xế. |
| **API Gateway (Port 8080) & Web UI** | C | C | **A / R** | Reverse Proxy, xác thực JWT, sinh Correlation-ID, SSE stream log, Leaflet Dashboard. |
| **Kiểm thử Chức năng (8 Tests)** | **R (3 tests)** | **R (3 tests)** | **R (2 tests)** | Chia đều 8 bài test chức năng theo service phụ trách. |
| **Kiểm thử Concurrency (2 Tests)** | I | **A / R** | I | Kịch bản 2 khách book 1 tài xế & 2 request trừ tiền đồng thời (CT-01, CT-02). |
| **Kiểm thử Chịu lỗi & Phục hồi (2 Tests)** | I | I | **A / R** | Kịch bản kill service khi đang chạy và khôi phục tin nhắn từ hàng đợi (FR-01, FR-02). |
| **Kiểm thử Bảo mật (2 Tests)** | **A / R** | I | I | Kịch bản giả mạo token, vượt quyền RBAC và payload injection (ST-01, ST-02). |
| **Kiểm thử Hiệu năng & Tải (1 Test)** | I | I | **A / R** | Đo Throughput, Latency p95/p99, RAM/CPU. |
| **Báo cáo đồ án (`docs/report.pdf`)** | **R (Ch 1-4)** | **R (Ch 5-8)** | **R (Ch 9-13)** | Mỗi thành viên đảm nhận ~8-9 trang, tổng cộng 25-27 trang. |
| **Thuyết trình Demo (10 phút)** | Phút 1 – 3 | Phút 4 – 6 | Phút 7 – 10 | Cả 3 thành viên đều tham gia thuyết trình theo quy chế Mục 11. |

*(Chú thích RACI: **A** = Accountable - Chịu trách nhiệm chính; **R** = Responsible - Người thực thi; **C** = Consulted - Người phối hợp/tham vấn; **I** = Informed - Người được thông báo).*

---

## 5. Tiêu Chí Nghiệm Thu Chung (Definition of Success)
1. Khởi động toàn bộ hệ thống với lệnh đơn giản, không yêu cầu cài thêm thư viện bên ngoài.
2. Không có service nào truy cập chéo database của nhau (Database-per-service độc lập tuyệt đối).
3. Kịch bản Concurrency chứng minh rõ ràng: 2 khách book cùng 1 tài xế $\rightarrow$ chỉ 1 khách thành công, khách kia nhận `NO_DRIVER_AVAILABLE` hoặc chờ, không có race condition.
4. Kịch bản Fault Tolerance chứng minh: Kill Payment Service $\rightarrow$ Message chờ trong Broker $\rightarrow$ Bật lại service $\rightarrow$ Xử lý hoàn tất chuyến đi.
5. Bộ báo cáo đồ án `docs/report.pdf` (20–30 trang) và slide thuyết trình `docs/slides.pdf` hoàn thiện đúng yêu cầu.
