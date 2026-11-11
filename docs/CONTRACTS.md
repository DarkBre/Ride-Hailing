# CONTRACTS & SCHEMAS SPECIFICATION (DS03)

Tài liệu này là **Single Source of Truth (SSOT)** về giao diện REST API, định dạng thông điệp RabbitMQ và cấu trúc cơ sở dữ liệu độc lập giữa các nhánh của **TV1, TV2, TV3**.

---

## 1. Chuẩn Hoá Định Dạng Chung (Common Conventions)

### 1.1. HTTP Response Chuẩn
Mọi phản hồi JSON tuân theo envelope thống nhất:
```json
{
  "success": true,
  "data": { ... },
  "error": null,
  "meta": {
    "correlation_id": "corr_c1f7a28e-5b1b-4f9e-bc43-268e0d4c9f12",
    "timestamp": "2026-11-12T03:00:00.000Z"
  }
}
```
Khi có lỗi (`success: false`, HTTP `4xx`/`5xx`):
```json
{
  "success": false,
  "data": null,
  "error": {
    "code": "DRIVER_ALREADY_BUSY",
    "message": "Tài xế đã nhận một cuốc xe khác"
  },
  "meta": {
    "correlation_id": "corr_c1f7a28e-5b1b-4f9e-bc43-268e0d4c9f12",
    "timestamp": "2026-11-12T03:00:00.000Z"
  }
}
```

### 1.2. RabbitMQ Message Envelope Chuẩn
Mọi event đẩy lên `trip.exchange` (Topic Exchange) đều dùng envelope:
```json
{
  "event_id": "550e8400-e29b-41d4-a716-446655440000",
  "correlation_id": "corr_c1f7a28e-5b1b-4f9e-bc43-268e0d4c9f12",
  "event_type": "trip.event.created",
  "timestamp": "2026-11-12T03:00:00.000Z",
  "source_service": "trip-service",
  "version": "1.0",
  "payload": { ... }
}
```
* **Yêu cầu bắt buộc của `Matching Service` (TV2) & `Payment Service` (TV3):**
  * `event_id` phải là chuỗi UUID hợp lệ.
  * `correlation_id` khớp mẫu `^[\w.-]{1,100}$`.
  * Mọi `passenger_id`, `trip_id`, `driver_id` đều là chuỗi UUID chuẩn.

### 1.3. Chuẩn JWT Claims (`HS256`)
Token do `Identity Service (:8001)` phát hành chứa đầy đủ các claims tương thích chéo giữa TV1, TV2 và TV3:
```json
{
  "sub": "11111111-1111-4111-a111-111111111111",
  "userId": "11111111-1111-4111-a111-111111111111",
  "user_id": "11111111-1111-4111-a111-111111111111",
  "email": "user@example.com",
  "role": "PASSENGER",
  "iat": 1762910000,
  "exp": 1762996400,
  "jti": "uuid"
}
```
* **Lưu ý tích hợp Web Dashboard (`:3000`):** Mọi request tới `/api/v1/trips*` và `/api/v1/drivers/*` đều **bắt buộc đính kèm `Authorization: Bearer <jwt>`**; chỉ truyền `X-User-Id` mà thiếu JWT sẽ bị Trip Service và Driver Service từ chối với `HTTP 401 UNAUTHORIZED`.

---

## 2. Đặc Tả REST API Theo Từng Service

### 2.1. API Gateway (Port `8080` — TV3)
* `POST /api/v1/auth/register` $\rightarrow$ `Identity :8001/auth/register`
* `POST /api/v1/auth/login` $\rightarrow$ `Identity :8001/auth/login`
* `GET  /api/v1/auth/me` $\rightarrow$ `Identity :8001/auth/me`
* `POST /api/v1/auth/logout` $\rightarrow$ `Identity :8001/auth/logout`
* `PUT  /api/v1/drivers/location` $\rightarrow$ `Driver :8002/drivers/location`
* `PUT  /api/v1/drivers/status` $\rightarrow$ `Driver :8002/drivers/status`
* `GET  /api/v1/drivers/available` $\rightarrow$ `Driver :8002/drivers/nearby` *(Gateway tự gắn `X-Internal-Key`)*
* `POST /api/v1/trips` $\rightarrow$ `Trip :8003/trips`
* `GET  /api/v1/trips/:id` $\rightarrow$ `Trip :8003/trips/:id`
* `POST /api/v1/trips/:id/accept` $\rightarrow$ `Trip :8003/trips/:id/accept`
* `POST /api/v1/trips/:id/start` $\rightarrow$ `Trip :8003/trips/:id/start`
* `POST /api/v1/trips/:id/complete` $\rightarrow$ `Trip :8003/trips/:id/complete`
* `POST /api/v1/trips/:id/cancel` $\rightarrow$ `Trip :8003/trips/:id/cancel`
* `GET  /api/v1/payments/wallet` $\rightarrow$ `Payment :8005/wallet`
* `POST /api/v1/payments/topup` $\rightarrow$ `Payment :8005/wallet/topup`
* `GET  /api/v1/simulation/stream` $\rightarrow$ SSE stream log thời gian thực cho `Web Dashboard`
* `POST /api/v1/simulation/broadcast` $\rightarrow$ Tiếp nhận sự kiện nội bộ phát lên SSE stream

### 2.2. Identity / User Service (Port `8001` — TV1)
* **`POST /auth/register`**: Input `{ email, password (>=6), name, phone?, role ("PASSENGER" | "DRIVER") }` $\rightarrow$ `201 Created` (không trả `password_hash`). Trùng email $\rightarrow$ `409 EMAIL_ALREADY_EXISTS`.
* **`POST /auth/login`**: Input `{ email, password }` $\rightarrow$ `200 OK` `{ token, user }`.
* **`GET /auth/me`**: Yêu cầu `Authorization: Bearer <jwt>` $\rightarrow$ `200 OK` thông tin user.
* **`POST /auth/logout`**: Thu hồi JWT bằng SHA-256 hash vào SQLite `token_blacklist`.
* **`POST /internal/verify-token`** *(Nội bộ, yêu cầu header `X-Internal-Key`)*: Kiểm tra token kèm blacklist bền vững.

### 2.3. Driver / Location Service (Port `8002` — TV2)
* **`PUT /drivers/location`** *(JWT role `DRIVER`)*: `{ "latitude": 21.0285, "longitude": 105.8544 }`
* **`PUT /drivers/status`** *(JWT role `DRIVER`)*: `{ "status": "AVAILABLE" | "OFFLINE" }` *(từ chối `403` nếu tự đặt `BUSY`/`RESERVED`; từ chối `409` nếu đang trong cuốc)*.
* **`GET /drivers/nearby?lat=...&lon=...&radius_km=5`** *(Nội bộ, yêu cầu `X-Internal-Key`)*: Trả danh sách tài xế `AVAILABLE` kèm `id`, `user_id`, `latitude`, `longitude`, `version`, `location_updated_at`.
* **Giao diện nội bộ giữ tài xế (Reservation CAS — yêu cầu `DRIVER_INTERNAL_KEY` / `DRIVER_TRIP_KEY`):**
  * `POST /internal/reservations`: Khoá tối đa 1 ứng viên từ `candidates: [{ id, version }]` cho `trip_id` bằng `FOR UPDATE SKIP LOCKED` + `CAS version`, trả `{ id (reservation_id), trip_id, driver_id, driver_user_id, state: "HELD", expires_at }`.
  * `POST /internal/reservations/confirm`: Chuyển reservation `HELD` $\rightarrow$ `CONFIRMED` và driver `RESERVED` $\rightarrow$ `BUSY` khi tài xế accept.
  * `POST /internal/reservations/release`: Mở khoá reservation & trả tài xế về `AVAILABLE` khi huỷ/hoàn tất/bù trừ.

### 2.4. Trip / Booking Service (Port `8003` — TV1)
* **`POST /trips`** *(Bắt buộc JWT role `PASSENGER`; hỗ trợ header `Idempotency-Key`)*:
  * *Body:* `{ pickup_latitude, pickup_longitude, pickup_address, dropoff_latitude, dropoff_longitude, dropoff_address }`
  * *Quy tắc:* Lấy `passenger_id` trực tiếp từ JWT (bỏ qua nếu client tự gửi giả mạo). Trùng `Idempotency-Key` + khác payload trả `409 IDEMPOTENCY_PAYLOAD_MISMATCH`.
  * *Response `201 Created`:*
    ```json
    {
      "id": "trip-uuid",
      "status": "REQUESTED",
      "estimated_fare": 45000,
      "distance_km": 3.2,
      "surge_multiplier": 1.2
    }
    ```
* **`GET /trips/:id`** *(Bắt buộc JWT đúng `passenger_id` hoặc đúng `driver_user_id` được gán)*.
* **`POST /trips/:id/accept`** *(JWT `DRIVER` được gán)*: Chuyển `DRIVER_ASSIGNED`/`CONFIRMED` $\rightarrow$ `ACCEPTED` và xác nhận reservation tại Driver Service.
* **`POST /trips/:id/start`** *(JWT `DRIVER` được gán)*: Chuyển `ACCEPTED` $\rightarrow$ `IN_PROGRESS`.
* **`POST /trips/:id/complete`** *(JWT `DRIVER` được gán)*: Chuyển `IN_PROGRESS`/`ACCEPTED` $\rightarrow$ `COMPLETED` + ghi Outbox `trip.event.completed` + giải phóng reservation tài xế.
* **`POST /trips/:id/cancel`** *(JWT chủ chuyến `PASSENGER` hoặc `DRIVER` được gán)*: Chuyển $\rightarrow$ `CANCELLED` (trừ `COMPLETED`/`CANCELLED`), phát `trip.event.release_driver` (nếu đã gán xe) và `payment.event.refund_requested` (nếu từ `CONFIRMED` trở đi).
* **`POST /internal/events`** *(Nội bộ, yêu cầu `X-Internal-Key` + `event_id`)*: Tiếp nhận domain event để chạy `SagaCoordinator`.

### 2.5. Simulated Payment Service (Port `8005` — TV3)
* **`GET /wallet?user_id=<uuid>`** *(hoặc header `X-User-Id`)*: Lấy `balance`, `held_balance`, lịch sử giao dịch.
* **`POST /wallet/topup`** *(Hỗ trợ `Idempotency-Key`)*: `{ "user_id": "<uuid>", "amount": 200000 }`.

---

## 3. Đặc Tả Sự Kiện Message Queue (RabbitMQ `trip.exchange`)

### 3.1. Bảng Định Tuyến Topic Events

| Routing Key (`event_type`) | Producer | Queue & Consumer đích | Mô tả nghiệp vụ |
|---|---|---|---|
| `trip.event.created` | Trip (`:8003`) | `matching.queue` (Matching `:8004`), `notification.queue` | Cuốc xe mới tạo ở trạng thái `REQUESTED`, cần ghép tài xế. |
| `trip.event.driver_matched` | Matching (`:8004`) | `trip.queue` (Trip `:8003`), `notification.queue` | Đã giữ tài xế (Reservation `HELD`); Trip chuyển `DRIVER_ASSIGNED` & phát lệnh giữ tiền. |
| `trip.event.matching_failed` | Matching (`:8004`) | `trip.queue` (Trip `:8003`), `notification.queue` | Không có xe khả dụng / hết timeout; Trip chuyển `CANCELLED`. |
| `payment.event.hold_requested` | Trip (`:8003`) | `payment.queue` (Payment `:8005`), `notification.queue` | Yêu cầu tạm giữ `estimated_fare` trên ví của `passenger_id`. |
| `payment.event.hold_success` | Payment (`:8005`) | `trip.queue` (Trip `:8003`), `notification.queue` | Giữ tiền thành công; Trip chuyển `CONFIRMED`. |
| `payment.event.hold_failed` | Payment (`:8005`) | `trip.queue` (Trip `:8003`), `notification.queue` | Số dư không đủ; Trip huỷ chuyến & phát `trip.event.release_driver`. |
| `trip.event.release_driver` | Trip (`:8003`) | `matching.queue` (Matching `:8004` $\rightarrow$ Driver `:8002`), `notification.queue` | **Lệnh bù trừ tài xế:** Mở khoá reservation tài xế từ `RESERVED/BUSY` về `AVAILABLE`. *(Không route vào `payment.queue` để tránh hoàn tiền nhầm khi chuyến đã `COMPLETED`)*. |
| `payment.event.refund_requested` | Trip (`:8003`) | `payment.queue` (Payment `:8005`), `notification.queue` | **Lệnh bù trừ hoàn tiền:** Giải phóng `held_balance` về `balance` khi `hold_success` đến muộn sau khi huỷ hoặc khi khách huỷ sau `CONFIRMED`. |
| `trip.event.completed` | Trip (`:8003`) | `payment.queue` (Payment `:8005`), Driver/Matching release, `notification.queue` | Chuyến đi hoàn tất; Payment thực hiện `CAPTURE` trừ tiền dứt điểm, tài xế trả về `AVAILABLE`. |

### 3.2. Payload Chuẩn Của Các Event Chính

* **`trip.event.created`**
  ```json
  {
    "trip_id": "uuid",
    "passenger_id": "uuid",
    "pickup_latitude": 21.0285,
    "pickup_longitude": 105.8544,
    "estimated_fare": 45000
  }
  ```
* **`trip.event.driver_matched`**
  ```json
  {
    "trip_id": "uuid",
    "passenger_id": "uuid",
    "driver_id": "driver-profile-uuid",
    "driver_user_id": "driver-account-uuid",
    "reservation_id": "reservation-uuid",
    "expires_at": "2026-11-12T03:05:00.000Z",
    "estimated_fare": 45000
  }
  ```
* **`payment.event.hold_requested`** *(Bắt buộc có `passenger_id` UUID cho Payment Service)*
  ```json
  {
    "trip_id": "uuid",
    "passenger_id": "uuid",
    "driver_id": "driver-profile-uuid",
    "amount": 45000
  }
  ```
* **`payment.event.hold_failed`**
  ```json
  {
    "trip_id": "uuid",
    "passenger_id": "uuid",
    "driver_id": "driver-profile-uuid",
    "reason": "INSUFFICIENT_FUNDS",
    "required_amount": 45000,
    "current_balance": 10000
  }
  ```
* **`payment.event.refund_requested`** *(Lệnh bù trừ thanh toán mới chuẩn hoá)*
  ```json
  {
    "trip_id": "uuid",
    "passenger_id": "uuid",
    "amount": 45000,
    "reason": "TRIP_CANCELLED_COMPENSATION_RELEASE_HOLD"
  }
  ```
* **`trip.event.release_driver`**
  ```json
  {
    "trip_id": "uuid",
    "driver_id": "driver-profile-uuid",
    "reservation_id": "reservation-uuid",
    "reason": "SAGA_COMPENSATION_PAYMENT_FAILED"
  }
  ```
* **`trip.event.completed`**
  ```json
  {
    "trip_id": "uuid",
    "driver_id": "driver-profile-uuid",
    "passenger_id": "uuid",
    "fare": 45000
  }
  ```

---

## 4. Đặc Tả Cơ Sở Dữ Liệu (Database-per-Service Schemas)

### 4.1. `user_db.sqlite` — Identity Service (`:8001`, SQLite WAL)
* `users (id TEXT PK, email TEXT UNIQUE, password_hash TEXT, name TEXT, phone TEXT, role CHECK ('PASSENGER','DRIVER'), created_at, updated_at)`
* `token_blacklist (token_hash TEXT PK, revoked_at, expires_at INTEGER)` — Chỉ lưu SHA-256 hex digest của token.

### 4.2. `driver_db` — Driver Service (`:8002`, PostgreSQL 17)
* `drivers (id UUID PK, user_id UUID UNIQUE, name, vehicle_plate, latitude, longitude, status CHECK ('OFFLINE','AVAILABLE','RESERVED','BUSY'), version INT DEFAULT 1, location_updated_at, updated_at)`
* `driver_reservations (id UUID PK, trip_id UUID UNIQUE, driver_id UUID, driver_user_id UUID, state CHECK ('HELD','CONFIRMED','RELEASED','EXPIRED'), expires_at, created_at, updated_at)`
* `processed_events (event_id UUID PK, event_type, processed_at)`

### 4.3. `trip_db.sqlite` — Trip Service (`:8003`, SQLite WAL)
* `trips (id TEXT PK, passenger_id TEXT, driver_id TEXT, driver_user_id TEXT, reservation_id TEXT, reservation_expires_at TEXT, pickup_latitude, pickup_longitude, pickup_address, dropoff_latitude, dropoff_longitude, dropoff_address, distance_km, fare, surge_multiplier, status CHECK ('REQUESTED','MATCHING','DRIVER_ASSIGNED','CONFIRMED','ACCEPTED','IN_PROGRESS','COMPLETED','CANCELLED'), cancellation_reason, idempotency_key, idempotency_payload_hash, created_at, updated_at)` + Unique Index `(passenger_id, idempotency_key)`
* `outbox_events (id TEXT PK, aggregate_type, aggregate_id, event_type, payload, correlation_id, status CHECK ('PENDING','PUBLISHED','FAILED'), retry_count, created_at, published_at)`
* `processed_events (event_id TEXT PK, event_type, processed_at)`
* `saga_instances (saga_id TEXT PK, trip_id TEXT UNIQUE, current_step, status CHECK ('STARTED','MATCHED','HOLDING_PAYMENT','CONFIRMED','COMPENSATING','COMPENSATED','FAILED'), correlation_id, payload, error_reason, created_at, updated_at)`

### 4.4. `match_db` — Matching Service (`:8004`, PostgreSQL 17)
* `match_jobs (trip_id UUID PK, status, attempt_count, driver_id, reservation_id, lease_token, deadline_at, created_at, updated_at)`
* `outbox_events`, `processed_events`

### 4.5. `payment_db` — Payment Service (`:8005`, PostgreSQL 17)
* `wallets (id UUID PK, user_id UUID UNIQUE, balance NUMERIC(12,2) CHECK >= 0, held_balance NUMERIC(12,2) CHECK >= 0, updated_at)`
* `payment_holds (trip_id UUID PK, user_id UUID, amount NUMERIC(12,2), state CHECK ('HELD','CAPTURED','REFUNDED','FAILED'), created_at, updated_at)`
* `transactions (id UUID PK, wallet_id UUID, trip_id UUID, amount, type CHECK ('TOPUP','HOLD','CAPTURE','REFUND'), status, correlation_id, created_at)`
* `outbox_events (id UUID PK, ..., status CHECK ('PENDING','PUBLISHING','PUBLISHED','FAILED'), locked_by TEXT, locked_at TIMESTAMP, retry_count)` — Dùng Lease Fencing Token
* `processed_events (event_id UUID PK, event_type, processed_at)`
