# Demo nghiệm thu qua Gateway

Dùng project test riêng với tài khoản và tọa độ mô phỏng. Script tự động [Compose E2E](../tests/compose.e2e.test.cjs) là kịch bản chạy lại. Bảng dưới mô tả những bước có thể trình diễn thủ công. Các URL API dùng tiền tố `/api/v1`.

| Bước | API và request mẫu | Kết quả và dữ liệu kỳ vọng |
|---|---|---|
| Startup | `docker compose --env-file .env -f deploy/docker-compose.yml up -d --build --wait` | Sáu service cùng PostgreSQL và RabbitMQ healthy |
| Probe | `GET /live`, `GET /ready` | 200 khi process sống và upstream sẵn sàng |
| Tạo tài khoản | `POST /auth/register` với `{"name":"Demo","email":"passenger@example.test","password":"<mật khẩu demo>","role":"PASSENGER"}` | 201. Identity lưu user. Lặp với email khác và role DRIVER |
| Đăng nhập | `POST /auth/login` với `{"email":"passenger@example.test","password":"<mật khẩu demo>"}` | 200 và JWT dùng qua Authorization Bearer |
| Provision Driver | Dùng fixture trong suite để tạo hồ sơ bằng user ID đã đăng ký | Hồ sơ Driver riêng trong driver_db |
| GPS và online | `PUT /drivers/location` với `{"latitude":17,"longitude":-141}`, rồi `PUT /drivers/status` với `{"status":"AVAILABLE"}` | Driver AVAILABLE, có GPS mới |
| Nạp ví | `POST /payments/topup` với `{"amount":100000}` | Ví hành khách tăng số dư khả dụng |
| Đặt chuyến | `POST /trips` với `{"pickup_latitude":17,"pickup_longitude":-141,"pickup_address":"Demo A","dropoff_latitude":17.01,"dropoff_longitude":-141,"dropoff_address":"Demo B"}` | 201 REQUESTED. Trip outbox phát created, Matching giữ Driver |
| Retry | Gửi lại đúng booking với cùng JWT, body và `Idempotency-Key` | Cùng trip ID, một Trip và một outbox created |
| Poll | `GET /trips/<id>` | CONFIRMED khi Payment giữ cước. Driver RESERVED, reservation HELD |
| Accept | `POST /trips/<id>/accept` với `{}` và JWT Driver | Trip ACCEPTED, reservation CONFIRMED, Driver BUSY |
| Đi và hoàn tất | `POST /trips/<id>/start`, sau đó `POST /trips/<id>/complete`, body `{}` | IN_PROGRESS rồi COMPLETED. Capture đúng hold, Driver về AVAILABLE |
| Hủy và hoàn tiền | Tạo chuyến khác, đợi CONFIRMED, `POST /trips/<id>/cancel` với `{"reason":"PASSENGER_CANCELLED"}` | CANCELLED, release đúng reservation, refund khoản HELD |
| CT-01 | Hai passenger gọi `POST /trips` đồng thời khi chỉ một Driver khả dụng trong bán kính | Một chuyến thắng, một chuyến CANCELLED, đúng một reservation hoạt động |
| Recovery | Bật `RUN_CHAOS_TEST=1` và chạy suite trên stack riêng | Trip ghi outbox lúc broker ngắt, reconnect tiếp tục; reservation đã commit tồn tại qua restart |

Backend có thể demo bằng API hiện tại. Repo chưa có frontend. Nếu cần giao diện, ưu tiên client nhỏ chỉ gọi Gateway với hai vai Passenger/Driver. Sơ đồ kiến trúc, booking, reservation, payment, cancellation và event nằm trong [ARCHITECTURE](ARCHITECTURE.md). Sơ đồ restore và kiểm tra nghiệp vụ nằm trong [DISASTER_RECOVERY](DISASTER_RECOVERY.md).
