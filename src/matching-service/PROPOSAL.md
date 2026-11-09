# Đề xuất ADR TV2 — Quyền giữ tài xế và giao thức tích hợp

Trạng thái **chờ TV1/TV3 xác nhận**. Các giao diện bên dưới là ví dụ để review.

## Xung đột và quyết định cần chốt

- README và bảng service trong ARCHITECTURE mô tả SQLite, broker riêng và port 4002/4004. ADR-002–004, CONTRACTS, .env.example và sơ đồ PostgreSQL mô tả Node.js/TypeScript, PostgreSQL, RabbitMQ và port 8002/8004. Nhánh TV1 hiện có mã dùng SQLite. Đề nghị xác nhận bộ PostgreSQL/RabbitMQ là cấu hình tích hợp và thống nhất lịch chuyển adapter với TV1/TV3.
- ARCHITECTURE §4.1 đặt câu SQL tìm và khóa hàng `drivers` trong luồng Matching, trong khi §4.2 vẽ một lời gọi từ Matching sang Driver. Bảng `drivers` thuộc `driver_db`. CONTRACTS chỉ có API đọc ứng viên và chưa mô tả lệnh ghi quyền giữ. Đề nghị chạy transaction khóa tại Driver Service, do Matching gọi qua REST nội bộ.
- CONTRACTS nêu Gateway route `/drivers/available` nhưng định nghĩa Driver route `/drivers/nearby`. Cần TV3 thống nhất cách định tuyến và truyền định danh service. Driver hiện phục vụ route `/drivers/nearby` với khóa nội bộ. JWT ghi trạng thái/vị trí chấp nhận `user_id` theo REQUIREMENTS và `userId` theo nhánh TV1.
- Chưa có contract provision hồ sơ tài xế, dữ liệu phân loại xe, giá trị bán kính mặc định, thời hạn vị trí hay tần suất cập nhật GPS. Đề nghị TV1 xác nhận luồng provision, giữ DTO public hiện có, cấu hình cửa sổ GPS và bán kính theo môi trường. Cần thống nhất cả schema và payload trước khi hỗ trợ lọc loại xe. Tạm thời chỉ seed hồ sơ mô phỏng bằng quản trị DB.

## Driver là nguồn trạng thái

Matching nhận `trip.event.created`, ghi công việc theo `trip_id` trong `match_db`, đọc snapshot ứng viên có GPS còn hạn từ Driver, rồi lọc và xếp hạng bằng Haversine. Snapshot phục vụ chọn thứ tự. Driver xác nhận lại trạng thái, phiên bản và hạn GPS trong transaction giữ. `match_db` lưu trạng thái xử lý chuyến, kết quả, inbox và outbox. Quyền giữ và trạng thái `BUSY` cùng thuộc `driver_db`.

Đề xuất mở rộng giao diện nội bộ bằng route đọc snapshot, trả `id`, `latitude`, `longitude`, `location_updated_at`, `status` và `version` cho Matching đã xác thực. API nearby trong contract hiện có giữ nguyên ngữ nghĩa đọc.

Ví dụ lệnh nội bộ từ Matching sang Driver, với `Idempotency-Key` ổn định theo lần thử và `X-Correlation-ID` dùng để truy vết:

```http
POST /internal/driver-reservations
Idempotency-Key: <attempt-id>
X-Correlation-ID: <trace-id>
Content-Type: application/json

{"trip_id":"<trip-uuid>","candidates":[{"driver_id":"<driver-uuid>","version":12}]}
```

Đề xuất kết quả giữ thành công `{ "trip_id": "<trip-uuid>", "driver_id": "<driver-uuid>", "expires_at": "<iso-8601>" }`. Nếu tất cả ứng viên đã bị giữ hoặc không còn hợp lệ, trả kết quả nghiệp vụ hết ứng viên để Matching quyết định tìm lại hay phát `trip.event.matching_failed`. Cần TV1 chốt payload thất bại và deadline của từng lần tìm.

Trong một transaction PostgreSQL, Driver khóa hàng đủ điều kiện theo thứ tự ưu tiên bằng `LIMIT 1 FOR UPDATE SKIP LOCKED`, kiểm tra lại trạng thái/version và thực hiện CAS `UPDATE ... WHERE id = $id AND status = 'AVAILABLE' AND version = $version`. Chỉ commit nếu cập nhật đúng một hàng và ghi được reservation. Đề xuất thêm unique index có điều kiện trên `driver_id` và `trip_id` cho reservation `HELD` hoặc `CONFIRMED`. Giữ snapshot ứng viên bên Matching và thực hiện mọi network call ngoài transaction. Log quyết định theo correlation ID và loại kết quả, bỏ tọa độ, token và nội dung DB khỏi log.

## Xác nhận, hết hạn và bù trừ

- **Giữ:** ghi `HELD` và `BUSY` trong cùng transaction. Mốc 30 giây trong REQUIREMENTS áp dụng cho chờ tài xế nhận. TV1 và TV2 cần thống nhất cách đưa deadline của Trip vào lệnh giữ để hai service cùng dùng một mốc.
- **Xác nhận:** Trip gọi lệnh nội bộ đề xuất `POST /internal/driver-reservations/<trip-uuid>/confirm` với `{"driver_id":"<driver-uuid>"}` sau khi xác thực người nhận. Driver dùng chuyển trạng thái có điều kiện từ `HELD` còn hạn sang `CONFIRMED`. Retry trả lại kết quả đã lưu. Trip chịu trách nhiệm điều phối và bù trừ khi không ghi được accept.
- **Hết hạn:** worker của Driver chỉ thu hồi `HELD` hết hạn trong transaction, đối chiếu cả trip và driver. Xác nhận và hết hạn tranh chấp cùng reservation, nên chỉ một transition thắng. `CONFIRMED` chỉ được giải phóng khi kết thúc hoặc bù trừ.
- **Bù trừ/kết thúc:** giữ routing key `trip.event.release_driver`, đề nghị TV1 xác nhận payload ví dụ `{"trip_id":"<trip-uuid>","driver_id":"<driver-uuid>","reason":"CANCELLED"}` và phát cùng event khi hoàn thành. Driver chỉ giải phóng reservation của đúng chuyến, giữ dấu chuyến đã kết thúc để yêu cầu cũ đến trễ không tạo lại quyền giữ. Một kết quả match đến sau khi Trip đã hủy phải bị Trip bỏ qua và kích hoạt release nếu đã giữ tài xế. Nhánh TV1 có nhánh bù trừ stale-event cần kiểm chứng qua tích hợp.

## Idempotency và triển khai tương thích

- Inbox dùng `event_id` trong cùng transaction xử lý sự kiện. Một event khác ID nhưng cùng chuyến chỉ tham chiếu công việc theo `trip_id`. Retry HTTP dùng cùng attempt key với cùng payload. Xung đột giữa hai chuyến độc lập do lock và unique index xử lý. Sau timeout mơ hồ, tra lại kết quả theo khóa cũ trước khi mở lần thử mới. Chuyến đã hủy hoặc hết deadline kết thúc công việc.
- Ghi kết quả và event Matching vào outbox cùng transaction, giữ `event_id` ổn định qua mọi lần gửi. ACK đầu vào sau khi ghi bền vững. TV3 cần chốt exchange/queue binding, confirm và kiểm tra unroutable, reconnect, retry tối đa ba lần và DLQ. Các consumer hiện có giữ envelope v1.0 và routing key. Giao diện giữ/xác nhận là bổ sung nội bộ, cần triển khai Driver trước khi bật Matching và Trip mới.
- Nghiệm thu sau khi chốt gồm hai consumer hoặc instance cạnh tranh trên cùng PostgreSQL, hai transaction cho hai chuyến, một tài xế và đúng một quyền giữ. Kiểm tra thêm hai tài xế để chứng minh skip hàng đang khóa, cùng trip với event khác ID, timeout giữa commit và response, confirm chạy đồng thời expiry, và release trễ sau khi tài xế được gán chuyến khác.
- CT-02 trong TEST_PLAN kiểm tra hai lệnh hold cùng ví. Cần môi trường Payment theo phạm vi riêng. Dùng số dư 50.000 VNĐ, hai hold 40.000 VNĐ đồng thời, kiểm tra đúng một thành công và số dư khả dụng còn 10.000 VNĐ.
