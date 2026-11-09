# REQUIREMENTS SPECIFICATION: RIDE-HAILING MICROSERVICES (DS03)

**Trạng thái bản demo.** Pricing lấy số tài xế có GPS hợp lệ từ Driver API khi chạy Compose và lưu cước theo chuyến. Trạng thái chuyến đọc qua API. Notification push, SSE và Dashboard chưa có trong bản tích hợp.

## 1. Phân Loại Yêu Cầu Theo Mô Hình MoSCoW

### 1.1. Must Have (P0) — Bắt buộc phải có để đạt yêu cầu nghiệm thu
* **P0-01 (Microservices Architecture):** Tối thiểu 4 business services độc lập (chọn 5: Identity, Driver, Trip, Matching, Payment) + 1 API Gateway.
* **P0-02 (Database-per-Service):** Mỗi service có database/schema riêng trong PostgreSQL, không service nào kết nối trực tiếp đến DB của service khác.
* **P0-03 (Authentication & RBAC):** Đăng ký, đăng nhập JWT, phân quyền tài xế (`DRIVER`) và hành khách (`PASSENGER`).
* **P0-04 (Driver Management & Location):** Tài xế cập nhật trạng thái (`AVAILABLE`, `BUSY`, `OFFLINE`) và toạ độ định vị địa lý.
* **P0-05 (Trip Lifecycle Management):** Vòng đời cuốc xe: `REQUESTED` $\rightarrow$ `MATCHING` $\rightarrow$ `DRIVER_ASSIGNED` $\rightarrow$ `ACCEPTED` $\rightarrow$ `IN_PROGRESS` $\rightarrow$ `COMPLETED` / `CANCELLED`.
* **P0-06 (Matching & Concurrency Control):** Thuật toán tìm tài xế gần nhất; giải quyết triệt để tranh chấp khi 2 khách hàng đồng thời yêu cầu cùng 1 tài xế. Một tài xế tuyệt đối không nhận 2 cuốc cùng lúc.
* **P0-07 (Simulated Payment & Saga Transaction):** Tạm giữ tiền (Hold), thanh toán (Capture), và hoàn tiền (Refund). Bắt buộc có **Saga Distributed Transaction** với các hành động bù trừ (Compensating Actions).
* **P0-08 (Reliable Messaging & Idempotency):** Trao đổi event qua RabbitMQ; mỗi message có `event_id` / `idempotency_key`, hỗ trợ Deduplication, Bounded Retries và Dead-Letter Queue (DLQ).
* **P0-09 (Distributed Tracing):** Tích hợp `Correlation-ID` xuyên suốt HTTP requests và RabbitMQ messages.
* **P0-10 (Fault Tolerance & Self-Healing):** Dừng đột ngột 1 service (ví dụ Payment Service), tin nhắn được giữ an toàn trong queue; khởi động lại service tiếp tục xử lý thành công.

### 1.2. Should Have (P1) — Giá trị cao, nâng cao chất lượng đề tài
* **P1-01 (Transactional Outbox Pattern):** Ghi event vào bảng Outbox cùng transaction với dữ liệu nghiệp vụ, chuyển phát sang RabbitMQ có kiểm tra ACK để đạt tính toàn vẹn At-least-once.
* **P1-02 (Dynamic Pricing Engine):** Tự động điều chỉnh hệ số giá cước (`Surge Multiplier`) dựa trên mật độ cuốc xe đang chờ và số tài xế khả dụng tại khu vực.
* **P1-03 (Web Simulation Dashboard):** Bản đồ tương tác trực quan hiển thị vị trí các xe, giao diện Khách đặt xe & Tài xế nhận cuốc, streaming logs thời gian thực.
* **P1-04 (Circuit Breaker):** Cơ chế ngắt mạch khi gọi REST API đồng bộ giữa các service nhằm bảo vệ hệ thống khỏi lỗi dây chuyền (Cascading Failure).

### 1.3. Could Have (P2) — Mở rộng nếu dư dả thời gian
* **P2-01 (Realtime Push Notifications via SSE):** Đẩy cập nhật trạng thái chuyến đi đến trình duyệt người dùng qua Server-Sent Events.
* **P2-02 (Geospatial indexing với PostGIS):** Tối ưu hóa truy vấn không gian toạ độ khi số lượng tài xế tăng lên hàng nghìn.

### 1.4. Won’t Have (Phiên bản này)
* Thanh toán thẻ ngân hàng thực tế (chỉ dùng thẻ/ví giả lập có số dư ảo).
* Tích hợp định tuyến đường đi thực tế qua Google Maps API (dùng khoảng cách đường chim bay Haversine hoặc giả lập toạ độ bản đồ cục bộ để tránh phụ thuộc API key trả phí).

---

## 2. Đặc Tả Nghiệp Vụ & Quy Tắc Trạng Thái (Business Rules & State Machines)

### 2.1. Vòng Đời Cuốc Xe (Trip State Machine)
```
[REQUESTED] ──► [MATCHING] ──► [DRIVER_ASSIGNED] ──► [ACCEPTED] ──► [IN_PROGRESS] ──► [COMPLETED]
     │              │                  │                  │
     ▼              ▼                  ▼                  ▼
[CANCELLED]    [CANCELLED]        [CANCELLED]        [CANCELLED]
(Khách huỷ)    (Hết timeout)    (Tài xế từ chối)  (Lỗi thanh toán / Saga Compensation)
```

* **Quy tắc chuyển trạng thái**:
  * Chuyển từ `REQUESTED` sang `MATCHING`: Khi Trip Service ghi nhận yêu cầu và bắt đầu tìm kiếm xe.
  * Chuyển sang `DRIVER_ASSIGNED`: Khi Matching Service lock thành công 1 tài xế khả dụng gần nhất và phát thông báo.
  * Chuyển sang `ACCEPTED`: Khi tài xế xác nhận nhận chuyến.
  * Chuyển sang `CANCELLED`: Nếu tài xế từ chối, hoặc hết hạn (timeout sau 30 giây không ai nhận), hoặc khách hàng chủ động huỷ trước khi tài xế nhận, hoặc luồng Saga thanh toán thất bại.
  * Chuyển sang `IN_PROGRESS`: Khi tài xế bấm "Bắt đầu chuyến đi" (đã đón khách).
  * Chuyển sang `COMPLETED`: Khi tài xế bấm "Kết thúc chuyến đi" $\rightarrow$ kích hoạt hoàn tất thanh toán.

### 2.2. Trạng Thái Tài Xế (Driver State Machine)
```
[OFFLINE] <════════════════════> [AVAILABLE]
                                     │   ▲
                                     │   │ (Kết thúc chuyến / Huỷ chuyến / Bù trừ)
                                     ▼   │
                                   [BUSY]
```
* Tài xế chỉ có thể chuyển sang `BUSY` nếu trạng thái hiện tại là `AVAILABLE`.
* Một tài xế ở trạng thái `BUSY` tuyệt đối không được trả về trong kết quả tìm kiếm của Matching Service.

---

## 3. Tiêu Chí Nghiệm Thu Chi Tiết (Acceptance Criteria cho P0)

### AC-01: Xác thực & Phân quyền
* Khi đăng ký người dùng với vai trò `PASSENGER` hoặc `DRIVER`, mật khẩu phải được băm an toàn bằng `bcrypt` trước khi lưu vào `user_db`.
* Đăng nhập thành công trả về `access_token` (JWT chứa `user_id`, `role`, `exp`).
* Truy cập API yêu cầu quyền (ví dụ `POST /trips` chỉ dành cho `PASSENGER`, `POST /drivers/location` chỉ dành cho `DRIVER`) nếu không có token hoặc token sai role phải trả về mã `401 Unauthorized` hoặc `403 Forbidden`.

### AC-02: Cập nhật Vị trí & Trạng thái Tài xế
* API `PUT /api/v1/drivers/status` cho phép chuyển trạng thái giữa `AVAILABLE`, `BUSY`, `OFFLINE`.
* API `PUT /api/v1/drivers/location` cho phép tài xế cập nhật toạ độ `(latitude, longitude)`.
* Hệ thống lưu trữ toạ độ và thời điểm cập nhật `updated_at` trong `driver_db`.

### AC-03: Matching & Kiểm soát tranh chấp đồng thời (Concurrency Control)
* **Kịch bản tranh chấp:** Giả lập 2 hành khách $P_1$ và $P_2$ cùng gửi yêu cầu đặt xe tại cùng 1 vị trí toạ độ. Trong hệ thống chỉ có duy nhất 1 tài xế $D_1$ đang `AVAILABLE`.
* **Tiêu chuẩn đạt (PASS):**
  * Chỉ duy nhất một yêu cầu của $P_1$ (hoặc $P_2$) ghép xe thành công với $D_1$. Trạng thái của $D_1$ chuyển sang `BUSY`.
  * Yêu cầu còn lại nhận thông báo không tìm thấy tài xế hoặc được xếp vào hàng chờ tìm xe khác.
  * Tuyệt đối không có trường hợp cả 2 cuốc xe đều ghi nhận tài xế là $D_1$.

### AC-04: Giao dịch phân tán Saga & Bù trừ (Compensating Actions)
* **Luồng Happy Path:**
  1. $P_1$ tạo cuốc xe.
  2. Matching Service lock tài xế $D_1$.
  3. Payment Service tạm giữ tiền cước thành công.
  4. Cuốc xe chuyển sang `CONFIRMED`.
* **Luồng Bù trừ (Compensation):**
  1. Giả lập trường hợp Payment Service xác định số dư tài khoản của $P_1$ không đủ $\rightarrow$ bắn event `payment.hold_failed`.
  2. Trip Service tiếp nhận event thất bại $\rightarrow$ kích hoạt chuỗi bù trừ:
     * Chuyển trạng thái cuốc xe sang `CANCELLED_PAYMENT_FAILED`.
     * Gửi lệnh sang Driver/Location Service để mở khoá tài xế $D_1$ từ `BUSY` trở lại `AVAILABLE`.
     * Bắn thông báo lỗi đến hành khách $P_1$.
  3. Kiểm tra DB: Tài xế $D_1$ trở lại trạng thái `AVAILABLE`, cuốc xe bị huỷ, không có tiền bị trừ.

### AC-05: Chống trùng lặp (Idempotency) & Retry & Dead-Letter Queue
* Mỗi message đẩy lên RabbitMQ có `event_id` (UUID).
* Consumer khi nhận message phải kiểm tra bảng `processed_events`. Nếu `event_id` đã tồn tại thì ACK và bỏ qua việc xử lý lại.
* Nếu consumer gặp lỗi trong quá trình xử lý (lỗi database, lỗi logic):
  * Tự động retry tối đa 3 lần với khoảng cách thời gian tăng dần.
  * Sau 3 lần thất bại, message được route sang hàng đợi lỗi Dead-Letter Queue (`trip.dlq`) kèm nguyên nhân lỗi để phục vụ việc kiểm tra và không làm nghẽn luồng xử lý chính.

### AC-06: Khả năng Chịu lỗi & Tự Phục Hồi (Fault Tolerance)
* Khi một cuốc xe đang được tạo, dừng đột ngột Payment Service (`docker stop payment-service`).
* Yêu cầu đặt xe vẫn được Trip Service ghi nhận và event giữ tiền được đưa vào RabbitMQ Queue (`payment.queue`).
* RabbitMQ đảm bảo tin nhắn không bị mất nhờ cờ `durable: true` và `persistent: true`.
* Khởi động lại Payment Service (`docker start payment-service`).
* Ngay sau khi service khởi động và kết nối lại queue, message tồn đọng lập tức được xử lý, cuốc xe tiếp tục hoàn thành bình thường.
