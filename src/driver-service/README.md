# Driver / Location Service

Driver chạy ở port 8002 theo mặc định và kết nối PostgreSQL `driver_db`. Môi trường cần Node.js 20+, npm, một database riêng đã được provision và role Driver có quyền chạy schema khi khởi động.

Biến cần cấu hình qua môi trường gồm `POSTGRES_HOST`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `JWT_SECRET`, `DRIVER_INTERNAL_KEY`, `DRIVER_LOCATION_MIN_INTERVAL_MS` và `DRIVER_LOCATION_MAX_AGE_MS`. Hai biến GPS là số nguyên dương tính theo mili giây. Hệ thống yêu cầu cấu hình tường minh vì tài liệu chưa chốt hai giá trị này. Có thể đặt thêm `POSTGRES_PORT`, `DRIVER_DB_NAME` và `DRIVER_SERVICE_PORT`.

```sh
npm --prefix src/driver-service install
npm --prefix src/driver-service run build
npm --prefix src/driver-service start
docker build -t ds03-driver src/driver-service
```

Container dùng cùng các biến môi trường. Cấu hình mạng riêng để kết nối PostgreSQL và giữ thông tin xác thực ngoài Git.

- `PUT /drivers/location` dùng JWT vai trò `DRIVER` và trường JSON `latitude`, `longitude`. Lần ghi vượt tần suất trả HTTP 429.
- `PUT /drivers/status` cho chủ hồ sơ đổi giữa `OFFLINE` và `AVAILABLE`. Luồng gán chuyến sở hữu quyền thay đổi `BUSY`.
- `GET /drivers/nearby?lat=0&lon=0&radius_km=5` dùng `X-Internal-Key` và chỉ trả ID cùng khoảng cách km của các tài xế khả dụng có GPS còn hạn.

Provision hồ sơ thử nghiệm bằng SQL với UUID người dùng khớp JWT do Identity ký. Ví dụ chỉ dùng dữ liệu giả lập:

```sql
INSERT INTO drivers (user_id, name, vehicle_plate)
VALUES ('00000000-0000-4000-8000-000000000001', 'Demo Driver', 'SIM-001');
```

Đặt `DRIVER_TEST_DATABASE_URL` tới một PostgreSQL dành cho test có quyền tạo schema rồi chạy `npm --prefix src/driver-service test`. Test tự tạo và dọn một schema riêng. Phần Haversine của Matching chạy bằng `npm --prefix src/matching-service test` sau khi cài phụ thuộc của package tương ứng. Xem [đề xuất giao thức](../matching-service/PROPOSAL.md) để biết các quyết định tích hợp còn chờ.
