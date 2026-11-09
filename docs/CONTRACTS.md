# CONTRACTS & SCHEMAS SPECIFICATION (DS03)

## Bổ sung tương thích cho bản tích hợp

- Gateway chuyển `GET /api/v1/drivers/available?lat=&lon=&radius_km=` sang `GET /drivers/nearby` sau xác thực Identity. Route Driver nội bộ cần `X-Internal-Key`. Tài xế tự đặt `OFFLINE` hoặc `AVAILABLE`. `RESERVED` và `BUSY` thuộc luồng hệ thống.
- `GET /internal/candidates` trả snapshot `id`, `latitude`, `longitude`, `locationUpdatedAtMs`, `status`, `version` cho Matching. `POST /internal/reservations` nhận `{"trip_id":"<uuid>","candidates":[{"id":"<driver-uuid>","version":7}]}`, theo thứ tự ưu tiên. Mảng rỗng chỉ tra kết quả theo chuyến. Driver trả `data: null` khi chưa có reservation và hết ứng viên; nếu đã có thì trả kết quả lưu bền vững.
- `POST /internal/reservations/confirm` yêu cầu `trip_id` và `reservation_id`, có thể kèm `driver_id`. `POST /internal/reservations/release` dùng các định danh tương tự và hỗ trợ lệnh hủy chỉ có `trip_id`. Cả hai dùng khóa coordinator. Chỉ `state: CONFIRMED` xác nhận accept hợp lệ. Hủy trước khi có reservation ghi tombstone theo chuyến.
- Matching có `POST /internal/events` và `GET /internal/matches/:tripId` phục vụ adapter/test đã xác thực. Luồng Compose dùng RabbitMQ.
- Event v1.0 giữ snake_case. `trip.event.driver_matched` thêm các trường tùy chọn `reservation_id`, `expires_at`, `driver_user_id`. `causation_id` và `aggregate_id` là metadata bổ sung. `trip.event.matching_failed` mang `trip_id` và `reason`. `trip.event.release_driver` mang `trip_id` và, nếu đã biết, `driver_id` hoặc `reservation_id`.
- `trip.event.created` và `trip.event.release_driver` đi vào `matching.queue`. Matching thực hiện release qua API Driver. `trip.event.driver_matched`, `trip.event.matching_failed`, `payment.event.hold_success`, `payment.event.hold_failed` đi vào `trip.queue`. Payment chỉ giữ tiền khi nhận `payment.event.hold_requested` từ Trip, với `trip_id`, `passenger_id`, `driver_id`, `amount`. `payment.event.refund_requested` và `trip.event.completed` cũng đi vào `payment.queue`.
- Top-up qua `POST /api/v1/payments/topup` nhận số nguyên VNĐ dương. Header `Idempotency-Key` được áp dụng theo tài khoản. Dùng lại khóa với số tiền khác trả 409.

Schema chạy thực tế nằm trong `src/driver-service/schema.sql`, `src/matching-service/schema.sql`, `src/payment-service/schema.sql`, và `db.js` của Identity/Trip. Các schema bên dưới là bản thiết kế PostgreSQL ban đầu.

Tài liệu này là **Single Source of Truth (SSOT)** về giao diện kết nối giữa các microservices, định dạng sự kiện Message Queue và cấu trúc cơ sở dữ liệu độc lập cho từng dịch vụ.

---

## 1. Chuẩn Hoá Định Dạng Chung (Common Conventions)

### 1.1. HTTP Response Chuẩn
Mọi phản hồi từ các dịch vụ đều tuân theo cấu trúc JSON thống nhất:
```json
{
  "success": true,
  "data": { ... },
  "error": null,
  "meta": {
    "correlation_id": "c1f7a28e-5b1b-4f9e-bc43-268e0d4c9f12",
    "timestamp": "2026-11-04T07:30:00.000Z"
  }
}
```
Khi xảy ra lỗi (`success: false`):
```json
{
  "success": false,
  "data": null,
  "error": {
    "code": "DRIVER_ALREADY_BUSY",
    "message": "Tài xế đã nhận một cuốc xe khác"
  },
  "meta": {
    "correlation_id": "c1f7a28e-5b1b-4f9e-bc43-268e0d4c9f12",
    "timestamp": "2026-11-04T07:30:00.000Z"
  }
}
```

### 1.2. RabbitMQ Message Envelope Chuẩn
Mọi thông điệp được publish lên RabbitMQ đều được đóng gói theo định dạng envelope:
```json
{
  "event_id": "550e8400-e29b-41d4-a716-446655440000",
  "correlation_id": "c1f7a28e-5b1b-4f9e-bc43-268e0d4c9f12",
  "event_type": "trip.event.created",
  "timestamp": "2026-11-04T07:30:00.000Z",
  "source_service": "trip-service",
  "version": "1.0",
  "payload": { ... }
}
```

---

## 2. Đặc Tả REST API Theo Từng Service

### 2.1. API Gateway (Port 8080)
Cung cấp định tuyến và phân quyền:
* `POST /api/v1/auth/register` $\rightarrow$ Forward sang Identity Service (`POST /auth/register`)
* `POST /api/v1/auth/login` $\rightarrow$ Forward sang Identity Service (`POST /auth/login`)
* `GET  /api/v1/auth/me` $\rightarrow$ Forward sang Identity Service (`GET /auth/me`)
* `PUT  /api/v1/drivers/location` $\rightarrow$ Forward sang Driver Service (`PUT /drivers/location`)
* `PUT  /api/v1/drivers/status` $\rightarrow$ Forward sang Driver Service (`PUT /drivers/status`)
* `GET  /api/v1/drivers/available` $\rightarrow$ Forward sang Driver Service (`GET /drivers/available`)
* `POST /api/v1/trips` $\rightarrow$ Forward sang Trip Service (`POST /trips`)
* `GET  /api/v1/trips/:id` $\rightarrow$ Forward sang Trip Service (`GET /trips/:id`)
* `POST /api/v1/trips/:id/accept` $\rightarrow$ Forward sang Trip Service (`POST /trips/:id/accept`)
* `POST /api/v1/trips/:id/complete` $\rightarrow$ Forward sang Trip Service (`POST /trips/:id/complete`)
* `GET  /api/v1/payments/wallet` $\rightarrow$ Forward sang Payment Service (`GET /wallet`)
* `POST /api/v1/payments/topup` $\rightarrow$ Forward sang Payment Service (`POST /wallet/topup`)
* `GET  /api/v1/simulation/stream` $\rightarrow$ SSE stream logs & toạ độ xe cho Web Dashboard

### 2.2. Identity / User Service (Port 8001)
* **`POST /auth/register`**
  * *Request Body:*
    ```json
    {
      "email": "user@example.com",
      "password": "SecurePassword123!",
      "name": "Nguyen Van A",
      "phone": "0912345678",
      "role": "PASSENGER" // hoặc "DRIVER"
    }
    ```
  * *Response 201 Created:* Trả về thông tin user (đã loại bỏ password hash).
* **`POST /auth/login`**
  * *Request Body:* `{"email": "...", "password": "..."}`
  * *Response 200 OK:*
    ```json
    {
      "token": "eyJhbGciOi...",
      "user": { "id": "uuid", "email": "...", "name": "...", "role": "PASSENGER" }
    }
    ```

### 2.3. Driver / Location Service (Port 8002)
* **`PUT /drivers/location`** (Yêu cầu Header `Authorization: Bearer <jwt>`, role `DRIVER`)
  * *Request Body:*
    ```json
    {
      "latitude": 21.028511,
      "longitude": 105.854444
    }
    ```
* **`PUT /drivers/status`**
  * *Request Body:*
    ```json
    {
      "status": "AVAILABLE" // "AVAILABLE" | "BUSY" | "OFFLINE"
    }
    ```
* **`GET /drivers/nearby?lat=21.0285&lon=105.8544&radius_km=5`**
  * *Response 200 OK:* Danh sách các tài xế `AVAILABLE` gần nhất kèm khoảng cách `distance_km`.

### 2.4. Trip / Booking Service (Port 8003)
* **`POST /trips`** (Yêu cầu role `PASSENGER`)
  * *Request Body:*
    ```json
    {
      "pickup_latitude": 21.028511,
      "pickup_longitude": 105.854444,
      "pickup_address": "12 Kim Ma, Ba Dinh, Ha Noi",
      "dropoff_latitude": 21.035789,
      "dropoff_longitude": 105.841234,
      "dropoff_address": "88 Cau Giay, Ha Noi"
    }
    ```
  * *Response 201 Created:*
    ```json
    {
      "id": "trip-uuid-123",
      "status": "REQUESTED",
      "estimated_fare": 45000,
      "distance_km": 3.2,
      "surge_multiplier": 1.2
    }
    ```
* **`GET /trips/:id`**: Trả về trạng thái hiện tại, tài xế được gán, cước phí.

### 2.5. Payment Service (Port 8005)
* **`GET /wallet`**: Lấy số dư hiện tại và số tiền đang bị tạm giữ (Held balance).
* **`POST /wallet/topup`**: Nạp tiền giả lập vào ví ảo (`{"amount": 200000}`).

---

## 3. Đặc Tả Sự Kiện Message Queue (RabbitMQ Event Contracts)

### 3.1. Danh Sách Topic Events

| Event Type | Producer | Consumer | Mô Tả Nghiệp Vụ |
|---|---|---|---|
| `trip.event.created` | Trip Service (Outbox) | Matching Service | Cuốc xe mới vừa được tạo, cần tìm tài xế gần nhất |
| `trip.event.driver_matched` | Matching Service | Trip Service, Payment Service | Đã lock tài xế thành công, cần tạo yêu cầu giữ tiền cước |
| `trip.event.matching_failed` | Matching Service | Trip Service | Không còn tài xế nào khả dụng trong khu vực |
| `payment.event.hold_success` | Payment Service | Trip Service | Đã tạm giữ tiền thành công, chuyến đi chuyển sang `CONFIRMED` |
| `payment.event.hold_failed` | Payment Service | Trip Service (Saga Coordinator) | Số dư không đủ hoặc thẻ lỗi, kích hoạt Saga bù trừ |
| `trip.event.release_driver` | Trip Service (Compensate) | Driver Service | Lệnh bù trừ: Mở khoá tài xế từ `BUSY` trở lại `AVAILABLE` |
| `trip.event.completed` | Trip Service | Payment Service | Chuyến đi kết thúc, trừ tiền thật từ khoản tạm giữ |

### 3.2. Payload Mẫu của các Event quan trọng

#### `trip.event.created`
```json
{
  "trip_id": "a81bc81b-dead-4e5d-abff-90865d1e13b1",
  "passenger_id": "p01-uuid",
  "pickup_latitude": 21.028511,
  "pickup_longitude": 105.854444,
  "estimated_fare": 50000
}
```

#### `trip.event.driver_matched`
```json
{
  "trip_id": "a81bc81b-dead-4e5d-abff-90865d1e13b1",
  "passenger_id": "p01-uuid",
  "driver_id": "d01-uuid",
  "estimated_fare": 50000
}
```

#### `payment.event.hold_failed` (Trigger bù trừ)
```json
{
  "trip_id": "a81bc81b-dead-4e5d-abff-90865d1e13b1",
  "passenger_id": "p01-uuid",
  "driver_id": "d01-uuid",
  "reason": "INSUFFICIENT_FUNDS",
  "required_amount": 50000,
  "current_balance": 15000
}
```

---

## 4. Đặc Tả Cấu Trúc Database (Database-per-Service Schemas)

Mỗi service sử dụng một Database PostgreSQL riêng rẽ:

### 4.1. Database `user_db` (Identity Service)
```sql
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    phone VARCHAR(50),
    role VARCHAR(20) NOT NULL CHECK (role IN ('PASSENGER', 'DRIVER')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

### 4.2. Database `driver_db` (Driver / Location Service)
```sql
CREATE TABLE drivers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    vehicle_plate VARCHAR(50) NOT NULL,
    vehicle_model VARCHAR(100),
    latitude DOUBLE PRECISION DEFAULT 21.028511,
    longitude DOUBLE PRECISION DEFAULT 105.854444,
    status VARCHAR(20) DEFAULT 'OFFLINE' CHECK (status IN ('AVAILABLE', 'BUSY', 'OFFLINE')),
    version INT DEFAULT 1, -- Dùng cho Optimistic Concurrency Control
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_drivers_status_location ON drivers (status, latitude, longitude);
```

### 4.3. Database `trip_db` (Trip Service)
```sql
CREATE TABLE trips (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    passenger_id UUID NOT NULL,
    driver_id UUID NULL,
    pickup_latitude DOUBLE PRECISION NOT NULL,
    pickup_longitude DOUBLE PRECISION NOT NULL,
    pickup_address TEXT,
    dropoff_latitude DOUBLE PRECISION NOT NULL,
    dropoff_longitude DOUBLE PRECISION NOT NULL,
    dropoff_address TEXT,
    distance_km DOUBLE PRECISION NOT NULL,
    fare NUMERIC(12, 2) NOT NULL,
    surge_multiplier DOUBLE PRECISION DEFAULT 1.0,
    status VARCHAR(30) NOT NULL DEFAULT 'REQUESTED' 
        CHECK (status IN ('REQUESTED', 'MATCHING', 'DRIVER_ASSIGNED', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED')),
    cancellation_reason TEXT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Bảng Transactional Outbox Pattern
CREATE TABLE outbox_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    aggregate_type VARCHAR(50) NOT NULL,
    aggregate_id UUID NOT NULL,
    event_type VARCHAR(100) NOT NULL,
    payload JSONB NOT NULL,
    correlation_id VARCHAR(100) NOT NULL,
    status VARCHAR(20) DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PUBLISHED', 'FAILED')),
    retry_count INT DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    published_at TIMESTAMP WITH TIME ZONE NULL
);

-- Bảng lưu Idempotency
CREATE TABLE processed_events (
    event_id UUID PRIMARY KEY,
    event_type VARCHAR(100) NOT NULL,
    processed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

### 4.4. Database `match_db` (Matching Service)
```sql
CREATE TABLE match_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    trip_id UUID NOT NULL,
    driver_id UUID NULL,
    status VARCHAR(30) NOT NULL, -- 'SUCCESS', 'NO_DRIVER', 'TIMEOUT'
    duration_ms INT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE processed_events (
    event_id UUID PRIMARY KEY,
    event_type VARCHAR(100) NOT NULL,
    processed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

### 4.5. Database `payment_db` (Payment Service)
```sql
CREATE TABLE wallets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID UNIQUE NOT NULL,
    balance NUMERIC(12, 2) DEFAULT 0 CHECK (balance >= 0),
    held_balance NUMERIC(12, 2) DEFAULT 0 CHECK (held_balance >= 0),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id UUID NOT NULL REFERENCES wallets(id),
    trip_id UUID NOT NULL,
    amount NUMERIC(12, 2) NOT NULL,
    type VARCHAR(20) NOT NULL CHECK (type IN ('TOPUP', 'HOLD', 'CAPTURE', 'REFUND')),
    status VARCHAR(20) NOT NULL CHECK (status IN ('SUCCESS', 'FAILED')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE processed_events (
    event_id UUID PRIMARY KEY,
    event_type VARCHAR(100) NOT NULL,
    processed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```
