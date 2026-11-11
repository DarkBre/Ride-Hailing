# INTEGRATION CHECKLIST: HỢP NHẤT 3 NHÁNH CHO BẢN FINAL MVP (MỤC 7.1–7.4)

Tài liệu này hướng dẫn chi tiết cách ghép code từ 3 nhánh GitHub (`feature/tv3-payment-gateway-dashboard`, `feature/tv1-identity-trip`, `feature/tv2-driver-matching`) lên nhánh tích hợp mới tách từ `origin/main` theo **ADR-007 (Cách 1)** để chạy toàn vẹn hệ thống qua Docker Compose, đồng thời tránh đè code hoặc sót contract.

---

## 1. Quy Tắc Lấy Code Từ 3 Nhánh (Trên Nhánh Tích Hợp Mới Từ `origin/main`)

| Nguồn | File / Thư mục lấy vào bản Final | File **KHÔNG** lấy để tránh xung đột / phức tạp 7.5 |
|---|---|---|
| **`origin/feature/tv3-payment-gateway-dashboard`** (TV3, `2b8ad2f` / sau khi TV3 chuẩn hoá) | `src/payment-service/`, `src/api-gateway/`, `src/web-dashboard/`, `deploy/docker-compose.yml`, `deploy/init-postgres.sh`, `deploy/rabbitmq.conf`, `deploy/rabbitmq-definitions.json`, `tests/*tv3*` | *(Gỡ binding `trip.event.release_driver` ở Payment trước khi chạy chung; `PR #1` đã được hoàn tác khỏi `main` để kiểm thử & chuẩn hoá)* |
| **`origin/feature/tv1-identity-trip`** (`ab90ebd`) | `src/identity-service/`, `src/trip-service/`, `tests/identity.test.js`, `tests/trip.test.js`, `tests/saga.test.js`, `tests/run-all-tv1.js` | Không dùng bản `trip-service` cũ `8758e74` bên nhánh TV2 (bị hụt các vá bảo mật `ab90ebd`). |
| **`origin/feature/tv2-driver-matching`** (`94ef0eb`) | **Chỉ lấy:** `src/driver-service/`, `src/matching-service/`, `services/_shared/amqp.js` | **KHÔNG lấy** `src/payment-service/`, `src/api-gateway/`, `docker-compose.tls/acl/internal-tls`, `postgres-pitr-drill.sh`, `benchmark-*` trên nhánh TV2. |

---

## 2. Năm Điểm Khớp Nối Bắt Buộc Phải Cập Nhật Khi Ghép Code

### Điểm 1 (TV1): Gắn RabbitMQ AMQP Adapter vào `Trip Service` (`ab90ebd`)
* **File:** `src/trip-service/index.js`, `src/trip-service/package.json`, `src/trip-service/Dockerfile`.
* **Việc cần làm:**
  * Thêm dependency `"amqplib"` trong `src/trip-service/package.json` và dùng `services/_shared/amqp.js` (từ nhánh TV2) khi `process.env.RABBITMQ_URL` tồn tại:
    - `OutboxManager` xuất bản sự kiện vào `trip.exchange` với Publisher Confirm.
    - Consumer lắng nghe `trip.queue` chuyển tiếp vào handler `/internal/events`.
  * Khi `RABBITMQ_URL` không đặt (khi chạy suite test cục bộ TV1), giữ nguyên HTTP adapter mặc định để `62/62` tests TV1 tiếp tục PASS.

### Điểm 2 (TV3): Sửa binding `trip.event.release_driver` ở `Payment Service`
* **File:** `deploy/rabbitmq-definitions.json` và `src/payment-service/broker.js` (`PAYMENT_SUBSCRIPTIONS`).
* **Vấn đề:** Bản TV3 hiện bind cả `trip.event.release_driver` vào `payment.queue` trỏ vào hàm `processRefund()`. Khi `Trip` phát cả `trip.event.completed` lẫn `trip.event.release_driver` lúc kết thúc chuyến, nếu `release_driver` tới trước sẽ gây hoàn tiền nhầm thay vì capture.
* **Việc cần làm:** Bỏ `trip.event.release_driver` khỏi `payment.queue` và `PAYMENT_SUBSCRIPTIONS`; Payment chỉ chạy `processRefund()` khi nhận **`payment.event.refund_requested`** (đã được TV1 phát ở nhánh bù trừ và TV3 đã hỗ trợ sẵn trong `payment-logic.js`).

### Điểm 3 (TV1 + TV2): Khớp `driver_user_id` & `Driver Reservations`
* **File:** `src/trip-service/db.js`, `src/trip-service/saga-coordinator.js`, `src/trip-service/routes.js`, `deploy/docker-compose.yml`.
* **Vấn đề:** `Driver Service` (TV2) dùng `drivers.id` cho profile xe và `drivers.user_id` cho tài khoản đăng nhập JWT; `Matching` trả kèm `driver_id`, `driver_user_id`, `reservation_id`, `expires_at` trong `trip.event.driver_matched`.
* **Việc cần làm:**
  * Lưu thêm `driver_user_id`, `reservation_id`, `reservation_expires_at` trong bảng `trips`.
  * Dùng `trip.driver_user_id || trip.driver_id` khi kiểm tra quyền tài xế (`DRIVER`) tại `/accept`, `/start`, `/complete`, `/cancel` (giữ nguyên toàn bộ kiểm tra JWT bắt buộc của `ab90ebd`, không mở lỗ hổng anonymous).
  * Gọi `POST /internal/reservations/confirm` tới `Driver :8002` khi `/accept`, và `POST /internal/reservations/release` (kèm `trip.event.release_driver`) khi `/complete` hoặc `/cancel`.
  * Đồng bộ các biến môi trường `DRIVER_INTERNAL_KEY`, `DRIVER_TRIP_KEY` giữa `docker-compose.yml` của TV3 và code của TV2.

### Điểm 4 (TV1 + TV2 + TV3): Đồng bộ JWT & Seed Dữ Liệu Demo
* **JWT:** Trong `deploy/docker-compose.yml` bản đơn giản, giữ chung `JWT_SECRET` (và không bật ép buộc `JWT_ISSUER`/`JWT_AUDIENCE` nếu không cần; hoặc bổ sung gắn `iss`/`aud` tuỳ chọn trong `identity-service/auth.js` nếu env được thiết lập).
* **Dashboard & Auth:** Bản `src/web-dashboard/public/app.js` hiện gửi `X-User-Id` mà chưa gọi login lấy `Authorization: Bearer <jwt>`. Cần cập nhật Dashboard (hoặc dùng script Demo `scripts/demo-7.4.js`) gọi `POST /api/v1/auth/login` lấy JWT đính kèm mọi request `/api/v1/trips*` và `/api/v1/drivers/*`.
* **Seed hồ sơ tài xế:** Viết `scripts/seed-demo.js` tạo tài khoản `PASSENGER` và `DRIVER` qua `Identity`, nạp tiền ví `Payment`, và tạo tương ứng bản ghi tài xế (`user_id` khớp JWT) vào `driver_db` trước khi trình diễn.

### Điểm 5 (TV3): Bổ sung `Notification Service` tối giản (`:8006`)
* **Mục tiêu:** Đáp ứng tường minh yêu cầu *"Send notifications to passengers and drivers"* của **Mục 7.3 PDF** và làm dịch vụ thứ 6 minh hoạ Pub/Sub đa consumer từ `trip.exchange`.
* **Cách làm:** Tạo `src/notification-service/` (~60–80 dòng) dùng `amqplib` lắng nghe `notification.queue` (bind `#` vào `trip.exchange`), kiểm tra deduplication cơ bản, in log console thông báo rõ cho Passenger & Driver và gọi `POST /api/v1/simulation/broadcast` đẩy lên SSE Gateway (`:8080`) nếu Dashboard đang mở.

---

## 3. Lệnh Chạy & Kiểm Chứng Trên Docker Sau Khi Ghép

```bash
# 1. Cài đặt cấu hình môi trường
cp .env.example .env

# 2. Khởi chạy toàn bộ stack (Postgres, RabbitMQ, Identity, Driver, Trip, Matching, Payment, Notification, Gateway, Dashboard)
docker compose -f deploy/docker-compose.yml --profile full up -d --build

# 3. Kiểm tra toàn bộ tiến trình/container đều healthy
docker compose -f deploy/docker-compose.yml --profile full ps

# 4. Seed dữ liệu & chạy kiểm thử/demo trọn vẹn 9 bước Mục 7.4
node scripts/seed-demo.js
node scripts/demo-7.4.js
```
