# TEST PLAN & EVALUATION SPECIFICATION (DS03)

Tài liệu này xác định chiến lược kiểm thử và danh mục bài kiểm thử chuẩn hoá theo **Mục 7.4 & Mục 9 của `COURSE PROJECT SPECIFICATION.pdf`** cho toàn bộ nhóm (TV1, TV2, TV3).

---

## 1. Chiến Lược Kiểm Thử (Testing Strategy)

1. **Unit & Service Integration Tests:** Kiểm thử từng service độc lập với database thật (`node:sqlite` cho TV1; `PostgreSQL` cho TV2/TV3).
2. **Contract & RabbitMQ Broker Tests:** Xác minh format Message Envelope, Routing Key, `event_id` deduplication, Publisher Confirms, Retry và Dead-Letter Queue (`trip.dlq`).
3. **Concurrency / Conflict Tests (CT-01, CT-02):** Mô phỏng 2 hành khách đặt cùng lúc 1 tài xế duy nhất và 2 giao dịch hold tiền đồng thời trên cùng 1 ví.
4. **Fault Tolerance & Recovery Tests (FR-01, FR-02):** Can thiệp tắt tiến trình (`docker stop ds03-payment`), quan sát hàng đợi bền bỉ trên RabbitMQ (`:15672`), bật lại service (`docker start ds03-payment`) để xử lý nốt, và kiểm tra Saga bù trừ.
5. **End-to-End Acceptance (Mục 7.4):** Chạy xuyên suốt qua `API Gateway (:8080)` trên Docker Compose.

---

## 2. Danh Sách Các Bài Test Bắt Buộc Theo Đề Tài (Mục 9 PDF)

### 2.1. 08 Bài Functional Tests (FT-01 $\rightarrow$ FT-08)

| Mã Test | Chức năng kiểm thử | Dữ liệu đầu vào & Thao tác | Kết quả mong đợi (Assertion) | Chủ sở hữu |
|---|---|---|---|---|
| **FT-01** | Đăng ký tài khoản Passenger & Driver | `POST /api/v1/auth/register` (`email`, `password`, `role`) | `HTTP 201`, mật khẩu hash `scrypt` trong `user_db.sqlite`, không trả `password_hash`. | **TV1** |
| **FT-02** | Đăng nhập & Xác thực JWT | `POST /api/v1/auth/login` | `HTTP 200`, token JWT HS256 chứa `userId`, `user_id`, `role`, `exp`; logout lưu SHA-256 hash vào `token_blacklist`. | **TV1** |
| **FT-03** | Cập nhật toạ độ GPS tài xế | Driver gửi JWT `PUT /api/v1/drivers/location` | `HTTP 200`, lưu `(latitude, longitude)` và `location_updated_at` vào `driver_db`. | **TV2** |
| **FT-04** | Đổi trạng thái tài xế | Driver gửi `PUT /api/v1/drivers/status` (`AVAILABLE`/`OFFLINE`) | `driver_db.drivers.status` cập nhật đúng; tự đặt `BUSY` bị chặn `403`. | **TV2** |
| **FT-05** | Tạo cuốc xe & Định giá động | Passenger gửi JWT `POST /api/v1/trips` | `HTTP 201`, `status = 'REQUESTED'`, tính đúng Haversine + Surge, lưu `trip_db` & Outbox `trip.event.created`. | **TV1** |
| **FT-06** | Ghép tài xế gần nhất | Matching (`:8004`) tiêu thụ `trip.event.created` từ RabbitMQ | Tìm tài xế `AVAILABLE`, khoá reservation `HELD` tại Driver (`:8002`), bắn `trip.event.driver_matched` $\rightarrow$ `DRIVER_ASSIGNED`. | **TV2** |
| **FT-07** | Tạm giữ cước ví ảo (Saga Hold) | Payment (`:8005`) tiêu thụ `payment.event.hold_requested` | Trừ `balance`, tăng `held_balance` trong `payment_db`, bắn `payment.event.hold_success` $\rightarrow$ Trip `CONFIRMED`. | **TV3** |
| **FT-08** | Hoàn tất cuốc xe, Capture & Nhả xe | Driver được gán gọi `/accept` $\rightarrow$ `/start` $\rightarrow$ `/complete` | Trip `COMPLETED`, bắn `trip.event.completed` $\rightarrow$ Payment `CAPTURED` tiền thật, Driver nhả về `AVAILABLE`, Notification ghi log. | **TV1 + TV3** |

### 2.2. 02 Bài Concurrency / Conflict Tests (TV2 phụ trách chính)

* **CT-01: Hai hành khách tranh chấp đồng thời 1 tài xế duy nhất**
  * *Thiết lập:* Toàn hệ thống chỉ có **1 tài xế ($D_1$)** trạng thái `AVAILABLE`.
  * *Thao tác:* Bắn đồng thời (`Promise.all`) 2 request `POST /api/v1/trips` từ $P_1$ và $P_2$ tại cùng toạ độ.
  * *Assertion:* Chỉ **1 cuốc** khoá thành công reservation qua `FOR UPDATE SKIP LOCKED` + CAS `version` tại `driver_db` và đạt `CONFIRMED`; cuốc còn lại nhận `CANCELLED / NO_DRIVER_AVAILABLE`. Tuyệt đối không gán trùng $D_1$.
* **CT-02: Hai lệnh tạm giữ cước đồng thời trên cùng 1 ví**
  * *Thiết lập:* Ví có số dư `50.000 đ`.
  * *Thao tác:* Phát đồng thời 2 lệnh `hold_requested` mỗi lệnh `40.000 đ`.
  * *Assertion:* Nhờ `SELECT ... FOR UPDATE` trên `wallets` và `CHECK (balance >= 0)`, đúng 1 lệnh `hold_success` (còn `10.000 đ`), lệnh còn lại `hold_failed` (`INSUFFICIENT_FUNDS`).

### 2.3. 02 Bài Fault & Recovery Tests (TV3 phụ trách chính, phối hợp TV1/TV2)

* **FR-01: Sập Service giữa luồng & Phục hồi từ RabbitMQ (`durable` queue)**
  * *Thao tác:* Cho chạy đặt xe rồi tắt ngay container `Payment Service` (`docker stop ds03-payment`) trước khi message trong `payment.queue` được đọc.
  * *Assertion:* Các service khác không crash; RabbitMQ UI (`:15672`) hiển thị message nằm an toàn trong `payment.queue`. Khi chạy `docker start ds03-payment`, Payment tự động tiêu thụ message tồn đọng và đưa cuốc xe sang `CONFIRMED`.
* **FR-02: Saga Bù trừ & Dead-Letter Queue (`trip.dlq`)**
  * *Kịch bản Bù trừ:* Khách có số dư `0 đ` đặt xe $\rightarrow$ `Matching` khoá xe (`RESERVED`) $\rightarrow$ `Payment` bắn `payment.event.hold_failed` $\rightarrow$ `Trip` chuyển `CANCELLED` và bắn `trip.event.release_driver` $\rightarrow$ `Driver` trả $D_1$ về `AVAILABLE`. (Kiểm tra thêm race condition `hold_success` đến muộn sau khi huỷ $\rightarrow$ phát `payment.event.refund_requested`).
  * *Kịch bản DLQ:* Đẩy message hỏng vượt số lần retry (`maxRetries = 3`) $\rightarrow$ message đi qua `trip.dlx` vào hàng đợi chết `trip.dlq`.

### 2.4. 02 Bài Security & Input Validation Tests (TV1 phụ trách chính)

* **ST-01: Xác thực JWT & Kiểm soát quyền sở hữu (RBAC)**
  * Gọi `/api/v1/trips*` hoặc `/api/v1/drivers/status` không kèm JWT / JWT hết hạn (`now >= exp`) / JWT đã logout (persistent SHA-256 blacklist) $\rightarrow$ `401 UNAUTHORIZED`.
  * `DRIVER` tạo cuốc xe, `PASSENGER` gọi `/start` hoặc `/complete`, Passenger B xem/huỷ chuyến của A, Driver Y nhận chuyến của X $\rightarrow$ `403 FORBIDDEN`.
  * API nội bộ `/internal/*` thiếu hoặc sai `X-Internal-Key` $\rightarrow$ `401 UNAUTHORIZED_INTERNAL`.
* **ST-02: Validation dữ liệu & Chống Injection / Idempotency**
  * Toạ độ ngoài phạm vi Trái Đất (`lat: 999`, `""`, `null`), điểm đón trùng điểm đến $\rightarrow$ `400 Bad Request`.
  * Payload SQL Injection (`"'; DROP TABLE trips; --"`) được xử lý an toàn qua Prepared Statements.
  * Gửi trùng `Idempotency-Key` cùng payload trả lại kết quả cũ; đổi payload trả `409 IDEMPOTENCY_PAYLOAD_MISMATCH`.

### 2.5. Ghi chú Experiments bổ sung (Mục 7.5 nếu có thời gian)
* Đánh giá hiệu năng đo Latency/Throughput tại `API Gateway` (`tests/load-performance.experiment.js` của TV3 đã có sẵn, giữ ở mức tham khảo báo cáo, không chặn nghiệm thu 7.1–7.4).

---

## 3. Bảng Check Nghiệm Thu 9 Kịch Bản Demo Bắt Buộc (Mục 7.4 PDF)

| STT | Yêu cầu Mục 7.4 PDF | Lệnh / Thao tác kiểm chứng | Trạng thái mục tiêu |
|:---:|---|---|:---:|
| 1 | Start services independently | `docker compose -f deploy/docker-compose.yml --profile full ps` (mọi service độc lập `healthy`) | Chờ tích hợp & chạy Docker |
| 2 | Drivers become available | Seed driver + `PUT /api/v1/drivers/location` & `PUT /api/v1/drivers/status` = `AVAILABLE` | Chờ tích hợp |
| 3 | A passenger requests a ride | Passenger `POST /api/v1/trips` nhận `201 REQUESTED` + `X-Correlation-ID` | Đã xong TV1, chờ E2E |
| 4 | Matching selects a driver | `Matching` nhận `trip.event.created` $\rightarrow$ lock `Driver` $\rightarrow$ `Payment` hold $\rightarrow$ `CONFIRMED` | Chờ tích hợp TV1+TV2+TV3 |
| 5 | Driver accepts and completes trip | Driver `POST /accept` $\rightarrow$ `/start` $\rightarrow$ `/complete` $\rightarrow$ `Payment` capture & `Driver` về `AVAILABLE` | Chờ tích hợp |
| 6 | Two passengers simultaneously request same driver | Script `Promise.all` (CT-01): 1 cuốc `CONFIRMED`, 1 cuốc `CANCELLED` | Chờ tích hợp |
| 7 | Stop one service during business flow | `docker stop ds03-payment` giữa luồng đặt xe $\rightarrow$ message chờ trong `payment.queue` | Chờ tích hợp |
| 8 | Demonstrate retry, queue handling, or compensation | Xem retry/DLQ tại `:15672` + chạy khách `0đ` (FR-02) thấy xe tự mở khoá `AVAILABLE` | Chờ tích hợp |
| 9 | Restart service and continue processing | `docker start ds03-payment` $\rightarrow$ message tự động tiêu thụ hết, cuốc lên `CONFIRMED` | Chờ tích hợp |
