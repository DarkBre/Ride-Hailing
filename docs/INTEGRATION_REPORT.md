# Báo cáo audit và nghiệm thu tích hợp DS03

Đợt hardening ngày 10/11/2026 được ghi riêng trong [báo cáo release](FINAL_RELEASE_REPORT.md).

## Xác minh phát hành 09/11/2026

Build, 56 regression case TV1, 13 kết quả unit/integration cục bộ và 5 test Compose đã qua. Load 597 request không ghi nhận lỗi HTTP/client. Probe RabbitMQ, Driver và PostgreSQL restart giữ dữ liệu đã commit. Xem [security audit](SECURITY_AUDIT.md), [load test](LOAD_TEST_REPORT.md), [chaos test](CHAOS_TEST_REPORT.md) và [production readiness](PRODUCTION_READINESS.md). Các bảng bên dưới lưu kết quả ở mốc tích hợp trước đợt hardening.

## Audit tại c7a99e0

Nhánh làm việc `feature/tv2-driver-matching` sạch trước khi bắt đầu. Mã TV1 tại `origin/feature/tv1-identity-trip` commit `8758e74` có Identity, Trip, Pricing và regression suite. Bản tích hợp lấy các file triển khai và test từ commit đó vào working tree. Đặc tả môn học mục 7 yêu cầu giao tiếp mạng, message queue và quyền sở hữu dữ liệu riêng. ADR-003/004 và CONTRACTS định hướng PostgreSQL/RabbitMQ. README cũ mô tả SQLite và broker HTTP, trùng với một phần mã TV1.

| Hạng mục | Trạng thái ban đầu | Vấn đề | Hướng xử lý đã chọn |
|---|---|---|---|
| Driver | HTTP và PostgreSQL | Chưa có reservation | Driver giữ độc quyền, CAS, TTL và tombstone |
| Matching | Thư viện Haversine | Chưa có tiến trình, dữ liệu và event | Worker có lease, inbox/outbox, chọn ứng viên qua Driver API |
| RabbitMQ | Có contract | TV1 gửi HTTP tới broker chưa có mã | Adapter AMQP confirm, queue bền vững, retry và DLQ |
| PostgreSQL | Driver có schema | Thiếu provision các DB và role | Tách ba database và role, migration khi khởi động |
| API Gateway | Có contract | Thiếu mã | Proxy theo danh sách route, xác thực và correlation ID |
| Authentication | JWT Driver; mã Identity ở nhánh TV1 | Khác tên claim và secret mặc định | Giữ claim tương thích và yêu cầu secret theo môi trường khi triển khai |
| Trip | Có trên nhánh TV1 | Chưa gắn accept với reservation | Giữ SQLite riêng, thêm metadata và tích hợp Driver |
| Payment | Có contract | Thiếu mã | Ví PostgreSQL, hold/capture/refund theo lệnh của Trip |
| Integration Test | Driver và regression TV1 riêng | Chưa chạy xuyên service | Thêm test HTTP/PostgreSQL và Compose E2E |
| Docker | Driver có Dockerfile | Chưa có stack tích hợp | Compose với volume, health check, dependency readiness và mạng riêng |

## Cách đọc kết quả

PASS chỉ ghi cho test đã chạy thành công. Test PostgreSQL cục bộ chạy trên PostgreSQL 18.6. Test Compose chạy trên PostgreSQL 17 và RabbitMQ 4. Suite booking HTTP dùng cầu nối HTTP trong fixture để kiểm tra trạng thái service và dữ liệu. Suite Compose đi qua RabbitMQ thật.

| Kịch bản | Kết quả | Bằng chứng |
|---|---|---|
| Unit | PASS | Ba bài Haversine, validation và lọc/xếp hạng |
| Regression TV1 | PASS | 55/55 bài Identity, Trip, Saga và Pricing |
| Driver integration | PASS | Tám kết quả Node test gồm suite, kiểm tra ghi lỗi và rollback, GPS stale, quyền JWT, reservation và khóa hàng thật |
| Booking integration HTTP/PostgreSQL | PASS | Hai worker xử lý đồng thời, event trùng, accept và hủy, phục hồi cùng reservation sau khi Driver đã commit |
| FT-03 | PASS | GPS được lưu dưới đúng chủ hồ sơ |
| FT-04 | PASS | Chuyển AVAILABLE và chặn quyền tự đặt trạng thái hệ thống |
| FT-06 | PASS | RabbitMQ chuyển TripCreated tới Matching, sau reservation Trip nhận kết quả và giữ cước |
| CT-01 | PASS | Hai yêu cầu đặt xe đồng thời, một chuyến có tài xế, một chuyến hủy, một reservation hoạt động |
| CT-02 | PASS | Hai lệnh giữ 40.000 VNĐ trên ví 50.000 VNĐ. Một thành công, số dư khả dụng 10.000 VNĐ |
| E2E | PASS | Đăng nhập, nạp tiền, GPS, đặt, giữ, accept, BUSY, complete, capture và giải phóng |
| Recovery và DLQ | PASS | Matching dừng rồi chạy lại, từ chối, hủy, hết hạn, retry ba lần và DLQ |
| Docker | PASS | Build sáu image dịch vụ, tám container healthy |
| Load test dài và thông báo đẩy | NOT RUN | Ngoài bộ chạy lần này |

## Giới hạn bàn giao

Identity và Trip vẫn dùng SQLite WAL riêng. Việc chuyển sang PostgreSQL cần migration và xác nhận phạm vi riêng với TV1. Đăng ký Identity tạo tài khoản, còn provision hồ sơ tài xế cần operator. Pricing giữ thuật toán TV1 với nguồn cung mô phỏng. Notification, dashboard và SSE chưa có trong stack. Bản tích hợp dùng RabbitMQ một node và chưa đánh giá khả năng chịu lỗi mất node broker. Các thay đổi contract bổ sung cần nhóm review trước khi hợp nhất.
