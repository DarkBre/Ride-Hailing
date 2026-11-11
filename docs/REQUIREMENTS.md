# REQUIREMENTS SPECIFICATION: RIDE-HAILING MICROSERVICES (DS03)

## 1. Phân Loại Yêu Cầu Theo Mô Hình MoSCoW

### 1.1. Must Have (P0) — Bắt buộc đạt chuẩn Mục 7.1 – 7.4 PDF
* **P0-01 (Microservices Architecture):** 5 business services nghiệp vụ cốt lõi (`Identity :8001`, `Driver :8002`, `Trip :8003`, `Matching :8004`, `Payment :8005`) + `Notification Service (:8006)` + `API Gateway (:8080)`.
* **P0-02 (Database-per-Service):** Mỗi service sở hữu database hoàn toàn riêng (`user_db` & `trip_db` dùng SQLite WAL cô lập theo volume; `driver_db`, `match_db`, `payment_db` dùng các database & role tách biệt trên PostgreSQL 17). Cấm tuyệt đối truy cập chéo DB.
* **P0-03 (Authentication & RBAC):** Đăng ký, đăng nhập JWT (`userId`, `user_id`, `role`, `exp`), băm mật khẩu `scrypt`, phân quyền chặt chẽ `DRIVER` và `PASSENGER`, persistent SHA-256 blacklist khi logout.
* **P0-04 (Driver Management & Location):** Tài xế cập nhật trạng thái (`AVAILABLE`, `BUSY`, `OFFLINE`) và toạ độ GPS; hỗ trợ cơ chế khoá giữ tài xế độc quyền (Reservation / CAS Lock).
* **P0-05 (Trip Lifecycle Management):** Vòng đời cuốc xe chuẩn xác: `REQUESTED` $\rightarrow$ (`MATCHING`) $\rightarrow$ `DRIVER_ASSIGNED` $\rightarrow$ `CONFIRMED` $\rightarrow$ `ACCEPTED` $\rightarrow$ `IN_PROGRESS` $\rightarrow$ `COMPLETED` / `CANCELLED`.
* **P0-06 (Matching & Concurrency Control):** Thuật toán tìm tài xế gần nhất (Haversine); giải quyết triệt để tranh chấp khi 2 khách hàng đặt cùng lúc 1 tài xế. Tuyệt đối không bao giờ gán 1 tài xế cho 2 chuyến cùng lúc.
* **P0-07 (Simulated Payment & Saga Transaction):** Tạm giữ cước (`Hold`), trừ tiền thật (`Capture`), và hoàn tiền (`Refund`). Áp dụng **Saga Distributed Transaction** với hành động bù trừ cả 2 chiều: giải phóng tài xế (`trip.event.release_driver`) và giải phóng tiền giữ (`payment.event.refund_requested`).
* **P0-08 (Reliable Messaging qua RabbitMQ 4):** Sử dụng `trip.exchange` (Topic, `durable: true`), message `persistent: true`, có `event_id` (UUID), Deduplication (`processed_events`), Bounded Retries và Dead-Letter Queue (`trip.dlx` $\rightarrow$ `trip.dlq`).
* **P0-09 (Distributed Tracing & Notifications):** Truyền `X-Correlation-ID` xuyên suốt HTTP Gateway và RabbitMQ envelopes; `Notification Service` ghi nhận & phát thông báo sự kiện cho hành khách và tài xế.
* **P0-10 (Fault Tolerance & Self-Healing):** Dừng đột ngột một service (ví dụ `ds03-payment`), thông điệp vẫn nằm bền vững trong RabbitMQ; khi service khởi động lại, tự động tiêu thụ tiếp và hoàn tất cuốc xe.

### 1.2. Should Have (P1) — Đã có sẵn & giữ lại phục vụ trình diễn
* **P1-01 (Transactional Outbox Pattern):** Ghi event vào bảng `outbox_events` trong cùng DB transaction với thay đổi nghiệp vụ (SQLite TX ở Trip; PostgreSQL `SKIP LOCKED` + Lease Fencing ở Payment).
* **P1-02 (Dynamic Pricing Engine):** Tự động tính giá theo cự ly Haversine và hệ số cao điểm Surge Multiplier $[1.0, 2.5]$ tích hợp trong `Trip Service`.
* **P1-03 (Web Simulation Dashboard):** Bản đồ Leaflet + SSE Live Log stream ở port `:3000` (TV3) phục vụ trực quan hoá 10 phút bảo vệ.
* **P1-04 (Gateway Timeout & Idempotency Payload Hash):** Chống treo kết nối bằng request timeout ở Gateway và kiểm tra `Idempotency-Key` + SHA-256 payload hash ở Trip/Payment.

### 1.3. Deferred / Won’t Have (Gác lại khỏi bản Final MVP 7.1 – 7.4)
* `Internal TLS / mTLS` giữa các container, `RabbitMQ ACL` nhiều user phức tạp, `PostgreSQL PITR WAL Archive`.
* `Kubernetes`, `Multi-instance auto-scaling`.
* Thanh toán thẻ ngân hàng thực tế & Google Maps API trả phí.

---

## 2. Đặc Tả Nghiệp Vụ & Quy Tắc Trạng Thái (Business Rules & State Machines)

### 2.1. Vòng Đời Cuốc Xe (Trip State Machine)
```text
[REQUESTED] ──► [DRIVER_ASSIGNED] ──► [CONFIRMED] ──► [ACCEPTED] ──► [IN_PROGRESS] ──► [COMPLETED]
     │                  │                  │               │               │
     ▼                  ▼                  ▼               ▼               ▼
[CANCELLED]        [CANCELLED]        [CANCELLED]     [CANCELLED]     [CANCELLED]
(No Driver /      (Payment Failed /  (Khách huỷ ->   (Khách/Tài xế   (Huỷ khẩn ->
 Khách huỷ)        Khách huỷ ->       Release Driver   huỷ -> Release   Release Driver
                   Release Driver)    & Refund)        & Refund)        & Refund)
```
*(Ghi chú: Trạng thái `MATCHING` được hỗ trợ trong constraint DB như trạng thái trung gian tuỳ chọn).*

* **Quy tắc chuyển trạng thái bắt buộc:**
  * `REQUESTED`: Khởi tạo khi hành khách gửi `POST /api/v1/trips` (sinh Outbox `trip.event.created`).
  * `DRIVER_ASSIGNED`: Khi `Trip Service` nhận event `trip.event.driver_matched` từ `Matching Service` (kèm `driver_id`, `driver_user_id`, `reservation_id`), đồng thời phát `payment.event.hold_requested`.
  * `CONFIRMED`: Khi `Trip Service` nhận `payment.event.hold_success` từ `Payment Service`.
  * `ACCEPTED`: Khi tài xế được gán gọi `POST /api/v1/trips/:id/accept` (kiểm tra quyền chủ sở hữu + xác nhận reservation tại `Driver Service`).
  * `IN_PROGRESS`: Khi tài xế được gán gọi `POST /api/v1/trips/:id/start` (từ `ACCEPTED`).
  * `COMPLETED`: Khi tài xế được gán gọi `POST /api/v1/trips/:id/complete` $\rightarrow$ phát `trip.event.completed` (Payment capture tiền & Driver giải phóng về `AVAILABLE`).
  * `CANCELLED`: Trạng thái kết thúc lỗi/huỷ; tuyệt đối **không** cho phép chuyển ngược về `CONFIRMED` hoặc tái kích hoạt bởi event đến muộn.

### 2.2. Trạng Thái Tài Xế (Driver State Machine)
```text
[OFFLINE] <════════════════════> [AVAILABLE]
                                   │     ▲
            (CAS Lock/Reserve)     │     │ (Completed / Cancel / Expired / Release)
                                   ▼     │
                         [RESERVED] ──► [BUSY]
```
* Chỉ tài xế ở trạng thái `AVAILABLE` có GPS hợp lệ mới được `Matching` chọn và `Driver Service` giữ quyền qua `CAS version` + `FOR UPDATE SKIP LOCKED`.
* Tài xế đang `RESERVED`/`BUSY` không thể nhận đồng thời chuyến thứ 2 và không được phép tự đổi trạng thái thủ công qua API công khai (`409 DRIVER_ALREADY_BUSY`).

---

## 3. Tiêu Chí Nghiệm Thu Chi Tiết (Acceptance Criteria cho P0)

### AC-01: Xác thực & Phân quyền
* Đăng ký (`PASSENGER` hoặc `DRIVER`) phải băm mật khẩu bằng `scrypt` kèm salt ngẫu nhiên trong `user_db`.
* Đăng nhập thành công trả JWT token (`HS256`) chứa `userId`, `user_id`, `sub`, `email`, `role`, `iat`, `exp`, `jti`.
* Mọi API người dùng (`/trips*`, `/drivers/location`, `/drivers/status`, `/payments*`) không có token hợp lệ hoặc token hết hạn/đã logout (blacklist) $\rightarrow$ trả `401 Unauthorized`; sai vai trò hoặc thao tác nhầm chuyến của người khác $\rightarrow$ trả `403 Forbidden`.

### AC-02: Cập nhật Vị trí & Trạng thái Tài xế
* `PUT /api/v1/drivers/status` chuyển `AVAILABLE` / `OFFLINE`; `PUT /api/v1/drivers/location` lưu `(latitude, longitude)` kèm `location_updated_at` trong `driver_db`.

### AC-03: Matching & Kiểm soát tranh chấp đồng thời (Concurrency Control)
* **Kịch bản CT-01:** Hệ thống chỉ có 1 tài xế $D_1$ đang `AVAILABLE`; $P_1$ và $P_2$ gửi yêu cầu đặt xe đồng thời.
* **Tiêu chuẩn đạt:** Duy nhất 1 cuốc ghép được $D_1$ (nhờ CAS + reservation trên `driver_db`), cuốc còn lại nhận `CANCELLED / NO_DRIVER_AVAILABLE`, tuyệt đối không trùng tài xế.

### AC-04: Giao dịch phân tán Saga & Bù trừ (Compensating Actions)
* **Happy Path:** `REQUESTED` $\rightarrow$ `driver_matched` (`DRIVER_ASSIGNED`) $\rightarrow$ `hold_success` (`CONFIRMED`) $\rightarrow$ `accept` $\rightarrow$ `start` $\rightarrow$ `complete` (Capture + Release Driver).
* **Bù trừ lỗi thanh toán (`payment.event.hold_failed`):** Trip chuyển `CANCELLED`, Saga chuyển `COMPENSATED`, phát `trip.event.release_driver` mở khoá tài xế $D_1$ từ `RESERVED/BUSY` $\rightarrow$ `AVAILABLE`.
* **Bù trừ race condition (`hold_success` đến muộn hoặc khách huỷ sau `CONFIRMED`):** Trip giữ nguyên `CANCELLED`, phát `trip.event.release_driver` (nếu có tài xế) VÀ phát `payment.event.refund_requested` hoàn lại `held_balance` về `balance`.

### AC-05: Chống trùng lặp (Idempotency) & Retry & Dead-Letter Queue
* Mọi message trên RabbitMQ có `event_id` (UUID). Consumer ghi nhận vào `processed_events` trong cùng DB transaction xử lý sự kiện; nếu trùng `event_id` thì ACK và bỏ qua.
* Lỗi xử lý vượt ngưỡng retry (`maxRetries = 3`) được nack (`requeue = false`) qua `trip.dlx` vào hàng đợi chết `trip.dlq` để lưu trữ/điều tra không gây tắc queue chính.

### AC-06: Khả năng Chịu lỗi & Tự Phục Hồi (Fault Tolerance)
* Dừng đột ngột `Payment Service` (`docker stop ds03-payment`) trong khi có cuốc xe vừa ghép tài xế $\rightarrow$ sự kiện `payment.event.hold_requested` nằm an toàn trong `payment.queue` (`durable: true`, `persistent: true`).
* Khởi động lại `docker start ds03-payment` $\rightarrow$ service tự động tiêu thụ message tồn đọng, giữ tiền và chuyển cuốc sang `CONFIRMED`.
