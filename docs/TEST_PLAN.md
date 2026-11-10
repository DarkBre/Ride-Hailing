# TEST PLAN & EVALUATION SPECIFICATION (DS03)

## Bộ nghiệm thu bản tích hợp

- `node --test tests/rate-limit.test.cjs` kiểm tra limiter với HTTP và SQLite thật. `tests/production-probes.test.cjs` xác minh TLS, ACL, UID và network partition trên stack hardening riêng. Các probe có thao tác restart chỉ chạy khi `RUN_NETWORK_TEST=1`.

- Các probe `RUN_LOAD_TEST=1` và `RUN_CHAOS_TEST=1` chỉ chạy trên project Compose thử nghiệm riêng. Kết quả tải và fault recovery được ghi riêng. Chạy JWT claims regression bằng `node --test tests/security.test.cjs`.

- `npm --prefix src/driver-service test` cùng `DRIVER_TEST_DATABASE_URL` kiểm tra FT-03/04, quyền JWT, rollback, rate limit, reservation và `SKIP LOCKED` trên PostgreSQL thật.
- `npm --prefix src/matching-service test` kiểm tra Haversine và lọc/xếp hạng. `node --test tests/booking.integration.test.cjs` kiểm tra HTTP, PostgreSQL và tiến trình phục hồi với cầu nối HTTP của bộ test.
- `node --test tests/compose.e2e.test.cjs` kiểm tra FT-06, CT-01, CT-02, luồng accept/complete, bù trừ, restart và DLQ trên Compose thực. Chạy trên project thử nghiệm riêng. Xem [hướng dẫn chạy](../README.md#kiểm-thử-và-demo).
- `node tests/run-all-tv1.js` chạy regression Identity, Trip, Saga và Pricing.

Tài liệu này xác định chiến lược kiểm thử, danh sách kịch bản test bắt buộc theo mục 9 của đặc tả đồ án, cùng phương pháp đo đạc đánh giá hiệu năng hệ thống phân tán.

---

## 1. Chiến Lược Kiểm Thử (Testing Strategy)

Tuân thủ nguyên tắc **"Bằng chứng quan trọng hơn lời tuyên bố"** (Mục 1.6 trong Khung quy trình chuẩn):
1. **Unit Tests:** Kiểm thử các hàm logic độc lập (Công thức Haversine tính khoảng cách, thuật toán Dynamic Pricing, validation DTO, băm mật khẩu `scrypt` & JWT).
2. **Contract Tests:** Kiểm thử tính tương thích giữa API client và server, tính đúng đắn của Message Envelope và Data Types.
3. **Integration & Concurrency Tests:** Sử dụng script tự động mô phỏng nhiều client gọi đồng thời vào API Gateway để kiểm chứng cơ chế **CAS Optimistic Lock** chống tranh chấp tài xế.
4. **Fault & Recovery Tests:** Sử dụng script can thiệp hạ tầng (ngắt tiến trình service, bật lại service) để kiểm chứng tính bền bỉ của hàng đợi Message Broker và cơ chế bù trừ Saga.
5. **Performance / Scalability Experiments:** Đo throughput (req/s), độ trễ (latency p95, p99) và tỷ lệ lỗi.

---

## 2. Danh Sách Các Bài Test Bắt Buộc

### 2.1. 08 Bài Functional Tests (Kiểm Thử Chức Năng)

| Mã Test | Chức năng kiểm thử | Dữ liệu đầu vào & Thao tác | Kết quả mong đợi (Assertion) | Thành viên phụ trách |
|---|---|---|---|:---:|
| **FT-01** | Đăng ký tài khoản Passenger & Driver | Gọi `POST /api/v1/auth/register` với email, pass, role | Trả về HTTP 201, password được hash `scrypt` trong `identity.db` | **Thành viên 1** *(Trưởng nhóm)* |
| **FT-02** | Đăng nhập & Xác thực JWT | Gọi `POST /api/v1/auth/login` với tài khoản vừa tạo | Trả về HTTP 200, JWT token chứa đúng `userId` và `role` | **Thành viên 1** *(Trưởng nhóm)* |
| **FT-03** | Cập nhật toạ độ GPS tài xế | Driver gửi toạ độ mới qua `PUT /api/v1/drivers/location` | Trả về HTTP 200, toạ độ mới được ghi vào `driver.db` | **Thành viên 2** *(Dương Quốc Hoàng)* |
| **FT-04** | Đổi trạng thái tài xế | Driver đổi trạng thái sang `AVAILABLE` qua `PUT /api/v1/drivers/status` | `status` trong `driver.db` chuyển sang `AVAILABLE` | **Thành viên 2** *(Dương Quốc Hoàng)* |
| **FT-05** | Tạo cuốc xe & Định giá động | Passenger gọi `POST /api/v1/trips` với điểm đón và điểm đến | Tạo cuốc thành công với cước tính đúng công thức, state = `REQUESTED`, lưu Outbox | **Thành viên 1** *(Trưởng nhóm)* |
| **FT-06** | Ghép tài xế gần nhất | Matching Service bắt event `trip.event.created` | Tìm đúng tài xế gần nhất, lock tài xế $\rightarrow$ state = `DRIVER_ASSIGNED` | **Thành viên 2** *(Dương Quốc Hoàng)* |
| **FT-07** | Tạm giữ cước ví ảo (Saga Hold) | Payment Service bắt event `trip.event.driver_matched` | Số dư khả dụng giảm đúng số tiền cước, `held_balance` tăng tương ứng | **Thành viên 2** *(Dương Quốc Hoàng)* |
| **FT-08** | Hoàn tất cuốc xe & Trừ tiền | Driver bấm hoàn thành `POST /api/v1/trips/:id/complete` | State = `COMPLETED`, tiền từ `held_balance` bị capture chính thức | **Thành viên 3** *(Quang)* |

---

### 2.2. 02 Bài Concurrency / Conflict Tests (Thành viên 2 - Dương Quốc Hoàng phụ trách)

* **CT-01: Hai hành khách tranh chấp cùng một tài xế duy nhất (Owner: Dương Quốc Hoàng)**
  * **Thiết lập:** Khởi tạo hệ thống chỉ có **1 tài xế duy nhất ($D_1$)** đang ở trạng thái `AVAILABLE`.
  * **Hành động:** Bắn đồng thời 2 HTTP requests tạo cuốc xe từ 2 khách hàng ($P_1$ và $P_2$) tới cùng khu vực của $D_1$ trong cùng khoảng thời gian $\le 5$ ms.
  * **Kiểm chứng:**
    1. Chỉ duy nhất một khách hàng ($P_1$ hoặc $P_2$) nhận được cuốc với tài xế $D_1$.
    2. Khách hàng còn lại nhận kết quả `{ matched: false, status: 'no_driver' }` hợp lệ (không bị crash hay gán trùng xe).
    3. Trạng thái của $D_1$ trong `driver.db` chỉ chuyển sang `BUSY` một lần nhờ CAS Optimistic Lock, không có race condition.
* **CT-02: Hai request nạp tiền / thanh toán đồng thời trên cùng 1 ví (Owner: Dương Quốc Hoàng)**
  * **Thiết lập:** Ví có số dư 50,000 VNĐ.
  * **Hành động:** Bắn đồng thời 2 request trừ tiền tạm giữ 40,000 VNĐ từ 2 cuốc xe khác nhau.
  * **Kiểm chứng:** Chỉ 1 request thành công, request thứ hai bị từ chối do không đủ số dư khả dụng (Không xảy ra lỗi số dư bị âm).

---

### 2.3. 02 Bài Fault & Recovery Tests (Thành viên 3 - Quang phụ trách)

* **FR-01: Service sập đột ngột trong luồng nghiệp vụ & Phục hồi từ Queue (Owner: Quang)**
  * **Thiết lập:** Khách hàng $P_1$ vừa tạo cuốc xe và Matching Service đã tìm thấy tài xế $D_1$.
  * **Hành động can thiệp:** Lập tức ngắt tiến trình `Payment Service` trước khi sự kiện `payment.event.hold_requested` được xử lý.
  * **Quan sát trạng thái:**
    1. Trip Service và Matching Service không bị crash; hệ thống vẫn hoạt động bình thường.
    2. Tin nhắn yêu cầu giữ tiền nằm an toàn trong hàng đợi của `Broker Service` (lưu trữ bền vững trong `broker.db`).
  * **Hành động phục hồi:** Khởi động lại `Payment Service`.
  * **Kiểm chứng:** Payment Service tự động kéo sự kiện từ Broker về xử lý, giữ tiền thành công và đưa chuyến đi về trạng thái `CONFIRMED`. Không có dữ liệu nào bị mất mát.
* **FR-02: Saga Bù Trừ (Compensating Transaction) khi lỗi thanh toán (Owner: Quang & Thành viên 1 phối hợp)**
  * **Thiết lập:** Khách hàng $P_1$ có số dư ví = 0 VNĐ.
  * **Hành động:** $P_1$ đặt cuốc xe có cước 50,000 VNĐ. Matching Service tìm thấy và tạm gán tài xế $D_1$ (`status: BUSY`).
  * **Kích hoạt bù trừ:** Payment Service phát hiện số dư không đủ $\rightarrow$ bắn event `payment.event.hold_failed`.
  * **Kiểm chứng:**
    1. Trip Service nhận event lỗi $\rightarrow$ chuyển trạng thái chuyến đi sang `CANCELLED`.
    2. Trip Service bắn event bù trừ `trip.event.release_driver`.
    3. Driver Service nhận event bù trừ $\rightarrow$ trả lại trạng thái cho tài xế $D_1$ từ `BUSY` về `AVAILABLE`.
    4. Xác nhận trong cơ sở dữ liệu: $D_1$ sẵn sàng đón khách mới, cuốc xe đã bị huỷ sạch sẽ, tính toàn vẹn hệ thống được bảo toàn.

---

### 2.4. 02 Bài Security & Invalid Data Tests (Thành viên 1 - Trưởng nhóm phụ trách)

* **ST-01: Kiểm tra Xác thực & Phân quyền truy cập tài nguyên (Owner: Thành viên 1)**
  * **Thử nghiệm:** Hành khách $P_1$ cố tình gọi API của tài xế (`PUT /api/v1/drivers/location`), hoặc gọi API tạo cuốc mà không kèm JWT token.
  * **Kết quả:** Gateway hoặc Service chặn ngay lập tức, trả về `401 Unauthorized` hoặc `403 Forbidden`. Không thể thao tác giả mạo danh tính.
* **ST-02: Kiểm tra Xử lý Dữ liệu sai định dạng (Owner: Thành viên 1)**
  * **Thử nghiệm:** Gửi payload đặt xe với toạ độ ngoài Trái Đất (`latitude: 999.0`), số tiền âm (`fare: -50000`), hoặc chuỗi SQL Injection (`pickup_address: "'; DROP TABLE trips; --"`).
  * **Kết quả:** Validator chặn ở tầng DTO, trả về `400 Bad Request` kèm chi tiết lỗi, không có lỗi Runtime unhandled exception hay rò rỉ cấu trúc cơ sở dữ liệu.

---

### 2.5. 01 Bài Thí Nghiệm Hiệu Năng & Khả Năng Mở Rộng (Thành viên 3 - Quang phụ trách)

* **Kịch bản:** Giả lập 50 tài xế liên tục gửi toạ độ GPS và 10 khách hàng đặt cuốc đồng thời trong vòng 60 giây.
* **Chỉ số đo đạc thu thập:**
  1. Throughput trung bình (Requests per second).
  2. Latency phân vị: p50, p90, p95, p99.
  3. Tỷ lệ lỗi (Error rate $\le 0.1\%$).
  4. Mức tiêu thụ CPU & RAM của từng tiến trình microservice.
