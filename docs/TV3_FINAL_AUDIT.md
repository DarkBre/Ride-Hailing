# TÀI LIỆU HẬU KIỂM KỸ THUẬT & HƯỚNG DẪN BẢO VỆ ĐỒ ÁN (TV3 FINAL DEFENSE AUDIT)

**Dự án:** DS03 – Ride-Hailing Microservices System (Mô phỏng Grab/Uber)  
**Phân hệ sở hữu:** Thành viên 3 (TV3 — Quang)  
**Mục tiêu tài liệu:** Bằng chứng nghiệm thu kỹ thuật, phân tích sâu các ca lỗi biên phân tán, và cẩm nang trả lời chất vấn của Hội đồng chấm thi.

---

## 1. TỔNG QUAN KIẾN TRÚC PHÂN HỆ THÀNH VIÊN 3

Thành viên 3 chịu trách nhiệm các mắt xích hạ tầng truyền tin và điều phối trọng yếu của toàn bộ hệ thống DS03:
1. **Simulated Payment Service (Port 8005):** Quản lý ví ảo, tạm giữ cước, thanh toán dứt điểm và hoàn tiền bù trừ.
2. **API Gateway (Port 8080):** Điểm đón nhận HTTP duy nhất, reverse proxy, bảo mật CORS, circuit timeout, sinh & truyền `X-Correlation-ID` và stream log SSE.
3. **Web Simulation Dashboard (Port 3000):** Giao diện tương tác 2 góc nhìn Rider & Driver, bản đồ xe chạy Leaflet, bảng điều khiển log phân tán thời gian thực.
4. **Hạ Tầng RabbitMQ & Dead-Letter Queue (DLQ):** AMQP 0-9-1 Topic Exchange `trip.exchange`, DLX `trip.dlx`, DLQ `trip.dlq`, delay queues với exponential backoff.
5. **Transactional Outbox Pattern:** Giải quyết triệt để bài toán Dual-Write Inconsistency giữa PostgreSQL và RabbitMQ với cơ chế **Lease Fencing Token**.
6. **Distributed Tracing:** Gắn mã định danh `X-Correlation-ID` xuyên suốt HTTP headers và AMQP message envelope.

```
[ Web Simulation Dashboard (:3000) ]
               │
               │ HTTP REST / SSE Stream
               ▼
      [ API GATEWAY (:8080) ]
               │ (Sinh & chuyển tiếp X-Correlation-ID)
 ┌─────────────┼─────────────┬─────────────┐
 │ /auth/*     │ /drivers/*  │ /trips/*    │ /payments/*
 ▼             ▼             ▼             ▼
[Identity :8001] [Driver :8002] [Trip :8003]  [Payment :8005] ──► [payment_db (PostgreSQL)]
                                    │               │                 (wallets, holds, outbox_events)
                                    ▼               ▼
                        ═════════════════════════════════════════════════
                                      RABBITMQ BROKER (AMQP)
                                  Exchange: trip.exchange (Topic)
                                  DLX: trip.dlx ──► DLQ: trip.dlq
                        ═════════════════════════════════════════════════
```

---

## 2. VÒNG ĐỜI THANH TOÁN (PAYMENT LIFECYCLE) VÀ AN TOÀN GIAO DỊCH

### 2.1. Ba Trạng Thái Giao Dịch
1. **HOLD (Tạm Giữ):**
   - Khi nhận `payment.event.hold_requested` (hoặc `trip.event.driver_matched`).
   - Khóa dòng `SELECT id, balance, held_balance FROM wallets WHERE user_id = $1 FOR UPDATE`.
   - Nếu `balance >= amount`: `balance -= amount`, `held_balance += amount`, trạng thái hold là `HELD`. Phát event `payment.event.hold_success` qua Outbox.
   - Nếu `balance < amount`: Không trừ tiền, trạng thái hold là `FAILED`. Phát event `payment.event.hold_failed` qua Outbox để kích hoạt Saga Bù Trừ.
2. **CAPTURE (Thanh Toán Dứt Điểm):**
   - Khi nhận `trip.event.completed`.
   - Kiểm tra `payment_holds.state == 'HELD'`. Trừ dứt điểm `held_balance -= amount`, chuyển state sang `CAPTURED`.
   - Nếu đã ở trạng thái `CAPTURED` do message đến lặp lại, bỏ qua an toàn mà không trừ tiền lần 2.
3. **REFUND (Hoàn Tiền / Bù Trừ Saga):**
   - Khi nhận `payment.event.refund_requested` hoặc `trip.event.release_driver`.
   - Chuyển `held_balance -= amount` và hoàn lại `balance += amount`, chuyển state sang `REFUNDED`.

### 2.2. Kiểm Soát Tranh Chấp & Thứ Tự Khóa (Lock Ordering)
- **Khóa Advisory Cấp Giao Dịch:** `SELECT pg_advisory_xact_lock(hashtextextended(trip_id, 0))`.
  Mọi tác vụ liên quan đến cùng một `trip_id` đều phải xếp hàng tuần tự qua advisory lock này.
- **Thứ tự khóa nhất quán:** Luôn khóa theo thứ tự `trip_id` $\rightarrow$ `user_id` (ví). Tuyệt đối không có thứ tự ngược lại, triệt tiêu hoàn toàn nguy cơ Deadlock giữa các giao dịch đồng thời.
- **Bảo Vệ Số Dư:** Ràng buộc cấp cơ sở dữ liệu `CHECK (balance >= 0)` và `CHECK (held_balance >= 0)`.

---

## 3. ĐÁNH GIÁ CHUYÊN SÂU TRANSACTIONAL OUTBOX VÀ CƠ CHẾ LEASE FENCING

### 3.1. Phân Tích 7 Tình Huống Sự Cố (Failure Scenarios)

| STT | Kịch Bản Sự Cố | Rủi Ro Kỹ Thuật | Cơ Chế Giải Quyết Của TV3 |
|:---:|---|---|---|
| **1** | Worker crash trước khi publish | Event nằm trong DB nhưng chưa gửi sang Broker | Khi worker restart, quét các event `PENDING` và phát lại. Không mất dữ liệu. |
| **2** | Worker crash sau khi publish nhưng trước khi UPDATE `PUBLISHED` | Event đã gửi sang Broker nhưng DB vẫn ghi `PENDING` $\rightarrow$ phát lặp khi restart | Consumer ở phía nhận sở hữu bảng `processed_events (event_id)` $\rightarrow$ nhận diện event trùng và bỏ qua an toàn (Idempotency). |
| **3** | Hai OutboxWorker cùng chạy song song | Cả 2 worker cùng quét trúng 1 event và publish trùng | Sử dụng `UPDATE ... WHERE id IN (SELECT id ... FOR UPDATE SKIP LOCKED) RETURNING ...`. Dòng dữ liệu được lock và chuyển sang `PUBLISHING` tức thì, worker thứ hai tự động bỏ qua. |
| **4** | Worker bị treo/lag mạng quá 30 giây (Lease Expiration / Zombie Worker) | Worker A giữ event quá 30s. Worker B tưởng A đã chết nên reclaim và publish. Sau đó A tỉnh lại và cũng đánh dấu `PUBLISHED` | **Lease Fencing Token:** Mỗi lần claim, worker gán token `locked_by = <worker_id>_<timestamp>`. Khi hoàn tất, worker chỉ được update nếu `WHERE locked_by = <token_của_mình>`. Nếu đã bị Worker B reclaim, update của A trả về `rowCount = 0` $\rightarrow$ A biết lease đã mất và huỷ bỏ, tránh xung đột. |
| **5** | RabbitMQ tạm thời mất kết nối | Worker không thể gửi message | Bắt exception, tăng `retry_count`. Khi RabbitMQ hồi phục, worker tiếp tục gửi các event đang `PENDING`. |
| **6** | Publisher Confirmation bị thất lạc | Worker không nhận được ACK từ RabbitMQ | Kích hoạt timeout 5000ms $\rightarrow$ ném lỗi $\rightarrow$ event chuyển lại về `PENDING` để retry. |
| **7** | Event được gửi nhiều hơn một lần (At-least-once delivery) | Khách có thể bị trừ tiền 2 lần hoặc tài xế bị release 2 lần | Consumer kiểm tra `processed_events` + kiểm tra trạng thái máy `payment_holds.state` $\rightarrow$ Ngữ nghĩa xử lý đạt **Exactly-Once Processing**. |

---

## 4. HẠ TẦNG RABBITMQ, DEAD-LETTER QUEUE VÀ BOUNDED RETRIES

### 4.1. Cấu Hình Topology
- **Topic Exchange:** `trip.exchange` (Durable: true).
- **Dead-Letter Exchange (DLX):** `trip.dlx` (Topic, Durable: true).
- **Dead-Letter Queue (DLQ):** `trip.dlq` (Durable: true, binding `#` từ `trip.dlx`).
- **Main Queue:** `payment.queue` cấu hình `x-dead-letter-exchange: trip.dlx`.

### 4.2. Bounded Retries với Exponential Backoff
- **Số lần retry tối đa:** `MAX_RETRIES = 3`.
- **Hàng đợi trễ:**
  - `payment.queue.retry.<topic>.1000` (TTL 1000ms)
  - `payment.queue.retry.<topic>.2000` (TTL 2000ms)
  - `payment.queue.retry.<topic>.4000` (TTL 4000ms)
- **Quy trình retry:**
  - Lần 1: Lỗi tạm thời $\rightarrow$ Đẩy sang queue trễ 1000ms, gắn header `x-ds03-retry: 1`. ACK message cũ khỏi queue chính.
  - Lần 2: Hết TTL, quay lại queue chính $\rightarrow$ Lỗi tiếp $\rightarrow$ Đẩy sang queue trễ 2000ms, gắn `x-ds03-retry: 2`.
  - Lần 3: Đẩy sang queue trễ 4000ms, gắn `x-ds03-retry: 3`.
  - Lần 4 (Quá 3 lần): Gọi `basicNack(false, false)` $\rightarrow$ RabbitMQ đẩy trực tiếp sang `trip.dlx` $\rightarrow$ `trip.dlq`.
- **Poison Message:** Nếu message không thể parse JSON hoặc kích thước vượt quá 64KB, NACK ngay sang `trip.dlq` mà không đưa vào hàng đợi retry, chống tắc nghẽn queue.

---

## 5. API GATEWAY VÀ DISTRIBUTED TRACING

### 5.1. Nhiệm Vụ Của API Gateway (Port 8080)
1. **Reverse Proxy:** Định tuyến theo URL prefix `/api/v1/auth`, `/api/v1/drivers`, `/api/v1/trips`, `/api/v1/payments`.
2. **CORS:** Cung cấp đầy đủ preflight headers cho Web Dashboard (`Access-Control-Allow-Origin: *`, `OPTIONS 204`).
3. **Resilience & Timeouts:** Timeout 8000ms. Khi service downstream sập hoặc treo, trả về HTTP 502/504 chuẩn hoá, không lộ stack trace.
4. **SSE Hub:** Stream sự kiện thời gian thực `/api/v1/simulation/stream`.

### 5.2. Chu Trình Truy Vết Phân Tán (Distributed Tracing Flow)
```
[Client / Dashboard]
      │
      │ 1. Request kèm hoặc không kèm X-Correlation-ID
      ▼
[API Gateway] ── 2. Sinh corr_<uuid> nếu chưa có ──► 3. Gắn header X-Correlation-ID
      │
      │ HTTP Request
      ▼
[Payment Service] ── 4. Nhúng correlation_id vào Envelope JSON & AMQP Properties
      │
      │ Publish (trip.exchange)
      ▼
[RabbitMQ Broker]
      │
      │ Deliver
      ▼
[Consumer / Trip Service] ── 5. Đọc correlation_id, ghi log console: [TIMESTAMP] [CORR_ID] [SERVICE] ...
      │
      │ Broadcast
      ▼
[Dashboard Live Console] ── 6. Hiển thị log cùng Correlation-ID, hỗ trợ filter truy vết toàn luồng
```

---

## 6. BẰNG CHỨNG KIỂM THỬ THỰC TẾ

| File Kiểm Thử | Mục Tiêu | Kết Quả |
|---|---|:---:|
| [`tests/ft-07-payment.test.js`](file:///d:/proj/Ride-Hailing/tests/ft-07-payment.test.js) | Hold thành công, chống trừ tiền 2 lần, thiếu số dư báo lỗi, Capture trừ dứt điểm, Refund bù trừ, Race condition refund đến trước hold | **6/6 PASS** |
| [`tests/fr-01-fr-02-fault-saga.test.js`](file:///d:/proj/Ride-Hailing/tests/fr-01-fr-02-fault-saga.test.js) | FR-01 Sập service & phục hồi từ queue durable; FR-02 Saga bù trừ giải phóng tài xế D1 về AVAILABLE khi ví = 0 đ | **PASS** |
| [`tests/dlq-retry.test.js`](file:///d:/proj/Ride-Hailing/tests/dlq-retry.test.js) | Poison message vào DLQ ngay; Bounded retries 1s, 2s, 4s; quá 3 lần NACK sang trip.dlq | **4/4 PASS** |
| [`tests/gateway.test.js`](file:///d:/proj/Ride-Hailing/tests/gateway.test.js) | CORS 204, sinh & bảo tồn Correlation-ID, định tuyến đúng upstream, timeout 504, upstream down 502 | **6/6 PASS** |
| [`tests/load-performance.experiment.js`](file:///d:/proj/Ride-Hailing/tests/load-performance.experiment.js) | Benchmark tải 500 requests, concurrency 20 workers | **PASS** (~450 RPS, p50=5.8ms, p99=24.6ms, Error=0%) |

---

## 7. CÂU HỎI THƯỜNG GẶP TỪ HỘI ĐỒNG VÀ CÂU TRẢ LỜI CHUẨN XÁC

### Q1: Tại sao nhóm không dùng RabbitMQ trực tiếp trong API Gateway để bắn event mà phải qua HTTP rồi vào Service?
> **Trả lời:** "API Gateway là cửa ngõ giao tiếp của Client (Mobile App / Web Browser). Theo chuẩn RESTful và phân tách trách nhiệm (Separation of Concerns), Gateway chỉ đóng vai trò Reverse Proxy, xác thực, sinh Correlation-ID và định tuyến. Gateway không chứa nghiệp vụ tạo cuốc xe hay trừ tiền. Việc ghi nhận nghiệp vụ và sinh event phải do Microservice sở hữu dữ liệu thực hiện trong cùng một Transaction (Transactional Outbox) để đảm bảo tính nhất quán dữ liệu."

### Q2: Nếu Payment Service ghi database thành công nhưng RabbitMQ bị sập ngay thời điểm đó thì dữ liệu có bị mất không?
> **Trả lời:** "Dữ liệu hoàn toàn không bị mất. Nhờ áp dụng Transactional Outbox Pattern, sự kiện thanh toán được lưu trữ ngay trong bảng `outbox_events` của `payment_db` trong cùng transaction với số dư ví. Khi RabbitMQ sập, OutboxWorker gặp lỗi publish và ghi nhận trạng thái retry. Bản ghi vẫn nằm an toàn ở trạng thái `PENDING`. Ngay khi RabbitMQ hồi phục, OutboxWorker tiếp tục quét và gửi lại message với Publisher Confirms."

### Q3: Nếu message được gửi lại nhiều lần (At-least-once), làm sao đảm bảo khách hàng không bị trừ tiền 2 lần?
> **Trả lời:** "Hệ thống kết hợp 2 tầng phòng ngự Idempotency:
> 1. Tầng Broker: Bảng `processed_events (event_id)` lưu lại mọi event ID đã tiêu thụ. Nếu nhận lại event cùng ID, consumer bỏ qua ngay lập tức.
> 2. Tầng Nghiệp vụ: Bảng `payment_holds` lưu trạng thái của từng cuốc xe (`HELD`, `CAPTURED`, `REFUNDED`). Nếu nhận lệnh HOLD lần 2 cho cuốc xe đã `HELD`, hệ thống nhận diện cuốc xe đã được giữ tiền và không thực hiện trừ ví nữa."

### Q4: Cơ chế Bounded Retries khác gì với Dead-Letter Queue?
> **Trả lời:** "Bounded Retries là chiến lược xử lý lỗi tạm thời (Transient Error — như ngắt kết nối mạng chớp nhoáng, lock timeout) bằng cách thử lại có giới hạn (tối đa 3 lần) với khoảng thời gian chờ tăng dần (1s, 2s, 4s) qua các delay queues. Còn Dead-Letter Queue (DLQ) là 'bến đỗ cuối cùng' dành cho các message lỗi vĩnh viễn (Poison Message hoặc message đã thử hết 3 lần mà vẫn thất bại). DLQ giúp cách ly message lỗi để không làm nghẽn hàng đợi chính, đồng thời lưu giữ toàn bộ ngữ cảnh để kỹ sư điều tra."

### Q5: Nếu lệnh bù trừ (Refund / Release Driver) đến trước lệnh giữ tiền (Hold) do mạng chập chờn thì hệ thống xử lý thế nào?
> **Trả lời:** "Đây là ca lỗi kinh điển Race Condition Out-of-Order. Trong `payment-logic.js`, nếu nhận được lệnh Refund khi chưa có bản ghi Hold nào cho chuyến xe đó, hệ thống sẽ ghi nhận trước bản ghi `payment_holds` với trạng thái `REFUNDED`. Khi lệnh Hold đến muộn sau đó, service kiểm tra thấy trạng thái đã là `REFUNDED` thì sẽ lập tức huỷ bỏ thao tác giữ tiền, bảo vệ tuyệt đối số dư của khách hàng."
