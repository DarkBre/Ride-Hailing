# Driver / Location Service

Driver chạy cổng 8002, dùng Node 22 và sở hữu PostgreSQL `driver_db`.

Cấu hình `POSTGRES_HOST`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `JWT_SECRET`, `DRIVER_INTERNAL_KEY` và `DRIVER_TRIP_KEY`. Đặt `IDENTITY_URL` và khóa Identity `INTERNAL_KEY` để kiểm tra thu hồi token trực tiếp với Identity. Chế độ chạy độc lập xác minh HS256 cục bộ. `JWT_ISSUER` và `JWT_AUDIENCE` chỉ được kiểm tra khi có giá trị. Khoảng cách giữa hai lần cập nhật GPS mặc định 1000 ms, tuổi tối đa của GPS 60000 ms và hạn giữ tài xế 30000 ms.

- `POST /drivers` dùng JWT DRIVER và JSON gồm `name`, `vehicle_plate`, `vehicle_model` tùy chọn. Hồ sơ mới có trạng thái OFFLINE và chưa có GPS. Gửi lại cập nhật hồ sơ theo cùng user ID, giữ nguyên trạng thái, vị trí và reservation. Bỏ qua định danh, tọa độ hoặc trạng thái do client gửi trong payload hồ sơ.
- `GET /drivers/me` đọc hồ sơ thuộc JWT hiện tại hoặc trả 404 nếu chưa tạo.
- `PUT /drivers/location` và `PUT /drivers/status` cập nhật GPS và trạng thái. Chỉ luồng reservation được đặt RESERVED/BUSY.
- `GET /drivers/nearby` yêu cầu khóa Driver và trả ứng viên có vị trí còn hạn theo SSOT. Gateway cần giới hạn dữ liệu trả về client công khai.
- `POST /internal/reservations` dùng khóa Driver. Confirm và release dùng khóa coordinator riêng. DTO gồm `id`, `trip_id`, `driver_id`, `driver_user_id`, `state` và `expires_at`. Release đánh dấu một chuyến chưa có reservation trả định danh tài xế và thời hạn null.

```sh
docker build -t ds03-driver src/driver-service
npm --prefix src/driver-service install
npm --prefix src/driver-service test
```

Đặt `DRIVER_TEST_DATABASE_URL` trỏ đến PostgreSQL dành cho test có quyền tạo schema. Suite tạo và dọn schema của chính nó. Để seed, đăng nhập tài khoản DRIVER từ Identity rồi gọi `POST /drivers`, cập nhật GPS và đặt AVAILABLE qua API. Xem [điểm ghép integration](../matching-service/PROPOSAL.md).
