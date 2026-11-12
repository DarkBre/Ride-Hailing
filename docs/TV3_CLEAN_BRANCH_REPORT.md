# TV3 CLEAN BRANCH REPORT — PAYMENT, NOTIFICATION, GATEWAY & DASHBOARD

**Nhánh:** `feature/tv3-payment-gateway-clean`  
**Base:** `origin/main` (`eef9446`)  
**Ngày kiểm chứng:** 2026-11-12  
**Phạm vi:** Chỉ các thành phần TV3. Không sửa `src/identity-service/`, `src/trip-service/`, `src/driver-service/`, `src/matching-service/`.

---

## 1. Các thay đổi bắt buộc theo ADR-007 / SSOT mới

1. **Payment không còn nhận `trip.event.release_driver`:**
   - Xoá khỏi `PAYMENT_SUBSCRIPTIONS` trong `src/payment-service/broker.js`.
   - Xoá khỏi `handleBrokerEvent()` trong `src/payment-service/payment-logic.js`.
   - Payment chỉ refund khi nhận `payment.event.refund_requested`.
   - Payment chỉ hold khi nhận `payment.event.hold_requested` (không hold sớm từ `trip.event.driver_matched`).
   - Broker chủ động `unbindQueue` hai routing key cũ để dọn topology sót trong volume RabbitMQ.
2. **Xác thực JWT & quyền sở hữu ví tại Payment:**
   - Thêm `src/payment-service/auth.js`: xác thực HS256 + `exp` + `iss`/`aud` tuỳ chọn.
   - Ưu tiên gọi Identity `POST /internal/verify-token` bằng `X-Internal-Key` để tôn trọng blacklist logout.
   - Fallback cục bộ chỉ khi Identity không sẵn sàng; token giả/hết hạn/`alg=none` bị từ chối.
   - User chỉ xem/nạp ví của chính mình; `user_id` khác trả `403 FORBIDDEN`. Chỉ request có `X-Internal-Key` hợp lệ mới được chỉ định `user_id`.
3. **Gateway:**
   - Chặn mọi request có segment `/internal` bằng `403 INTERNAL_ROUTE_BLOCKED`.
   - Luôn xoá `X-Internal-Key` do client gửi.
   - Chỉ gắn `X-Internal-Key` cho projection `GET /api/v1/drivers/available` (map sang `/drivers/nearby`).
   - Thêm route `/api/v1/notifications` và cấu hình `NOTIFICATION_URL`.
4. **Notification Service mới (`:8006`):**
   - `GET /live`, `/health`, `/ready`, `/notifications`.
   - Subscribe `notification.queue` (`#` từ `trip.exchange`), DLX `trip.dlx`, DLQ routing key `notification.event.dlq`.
   - Dedup theo `event_id`, log thông báo Passenger/Driver, broadcast SSE qua Gateway.
5. **Dashboard dùng JWT thật:**
   - Đăng nhập demo qua `POST /api/v1/auth/login`; đính kèm `Authorization: Bearer <jwt>` cho trips/drivers/payments.
   - Nút Accept/Start/Complete/Cancel gọi API thật thay vì chỉ đổi UI.
   - Thêm UI đăng nhập nhanh 4 tài khoản demo và trạng thái Notification.
6. **Deploy:**
   - `notification` service trong Compose, đầy đủ env cho identity/driver/matching/trip/payment/gateway.
   - RabbitMQ definitions: bỏ binding `release_driver`/`driver_matched` khỏi `payment.queue`; thêm `notification.queue`; thêm topology retry managed cho Matching; DLQ routing key khớp code.
   - `scripts/seed-demo.js` tạo tài khoản/ví demo và seed Driver profile qua `docker compose exec postgres psql`.

---

## 2. Kết quả chạy thật trên máy kiểm chứng

**Môi trường:** Node.js `v26.13.1`, npm `12.2.2`, Windows.

### 2.1. Bộ test TV3

Lệnh:

```bash
node tests/run-all-tv3.js
```

Kết quả: **PASS 43/43 test**, 7/7 file:

| File | Kết quả |
|---|---|
| `tests/ft-07-payment.test.js` | 7/7 PASS |
| `tests/payment-auth.test.js` | 4/4 PASS |
| `tests/fr-01-fr-02-fault-saga.test.js` | 7/7 PASS |
| `tests/dlq-retry.test.js` | 5/5 PASS |
| `tests/notification.test.js` | 5/5 PASS |
| `tests/topology.test.js` | 5/5 PASS |
| `tests/gateway.test.js` | 10/10 PASS |

Trong đó có kiểm thử thật bằng HTTP server trong tiến trình:
- Payment trả `401` khi thiếu token, `403` khi user A đọc/nạp ví user B.
- Notification trả `/live` 200, `/ready` 503 khi chưa có RabbitMQ, `/notifications` 200.
- Gateway chặn `/internal`, không gắn key nội bộ cho ghi Driver, chỉ gắn cho `drivers/available`.

### 2.2. Kiểm tra nền tảng và cú pháp

```bash
node scripts/check.js
```

Kết quả: PASS toàn bộ 5 bước (Node, `node:sqlite`, 8 shared modules, auth/geo logic, SQLite transaction rollback).

```bash
node --check <tất cả file JS đã sửa>
node -e "JSON.parse(...deploy/rabbitmq-definitions.json...)"
```

Kết quả: PASS. `rabbitmq-definitions.json` hợp lệ JSON.

### 2.3. Phát hiện quan trọng khi chạy thật

`tests/ft-07-payment.test.js` ban đầu FAIL 5/6 sub-test. Nguyên nhân là **mock DB trong test lưu sai `payment_holds.state`** (luôn `undefined`), không phải logic Payment. Đã sửa mock suy ra state từ SQL (`HELD`/`FAILED`/`REFUNDED`), sau đó 7/7 PASS. Đây là bằng chứng việc chạy test thật cần thiết thay vì kết luận bằng đọc code.

---

## 3. Phần CHƯA chạy thật (bắt buộc ghi rõ)

Máy kiểm chứng **không có Docker CLI/Engine** (`docker --version` → command not found), do đó:

- **Chưa chạy** `docker compose -f deploy/docker-compose.yml --profile full config`.
- **Chưa dựng** PostgreSQL 17, RabbitMQ 4, Payment, Notification, Gateway, Dashboard bằng container.
- **Chưa chạy** `scripts/seed-demo.js` với Gateway thật.
- **Chưa kiểm chứng** Outbox/Lease Fencing, DLQ, retry và Saga end-to-end với RabbitMQ/PostgreSQL thật.
- **Chưa chạy** `tests/load-performance.experiment.js` với Gateway thật; script này có fallback mock nên không dùng số liệu fallback để kết luận hiệu năng.

Đã thay thế một phần bằng kiểm tra tĩnh có kiểm soát:
- Parse YAML Compose (merge key anchors) thành công; 10 service: postgres, rabbitmq, payment, notification, gateway, dashboard, identity, driver, matching, trip.
- Kiểm tra JSON definitions bằng parser.
- Unit/integration test Node như bảng trên.

---

## 4. Điều kiện để chạy E2E sau khi hợp nhất

```bash
# 1. Hợp nhất thêm TV1 (identity, trip) + TV2 (driver, matching, services/_shared/amqp.js)
# 2. Tạo .env từ mẫu, KHÔNG commit .env
cp .env.example .env

# 3. Dựng stack
docker compose -f deploy/docker-compose.yml --profile full up -d --build --wait

# 4. Seed tài khoản/ví/driver
node scripts/seed-demo.js

# 5. Kiểm tra
docker compose -f deploy/docker-compose.yml --profile full ps
node tests/run-all-tv3.js
```

**Kết luận trung thực:** Phần TV3 đã hoàn tất code + test Node và PASS 43/43 test chạy thật. Hệ thống container/E2E **chưa được xác nhận** trên máy này vì thiếu Docker; không có kết luận “sẵn sàng demo” cho đến khi chạy được bước 3–5 ở trên.
