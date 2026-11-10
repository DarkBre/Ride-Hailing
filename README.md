# DS03 Ride-Hailing

Bản tích hợp chạy Gateway, Identity, Driver, Trip, Matching và Payment cùng PostgreSQL và RabbitMQ. Pricing nằm trong Trip. Identity và Trip giữ SQLite WAL riêng của TV1. Driver, Matching và Payment dùng database và role PostgreSQL riêng. Notification, Dashboard và SSE nằm trong phạm vi mở rộng.

## Chạy bằng Docker Compose

Cần Docker Engine, Compose v2 trở lên và Node.js 22.13 trở lên để chạy script kiểm thử trên host.

```powershell
Copy-Item .env.example .env
```

Điền các biến secret trống trong `.env` bằng giá trị ngẫu nhiên. Dùng chuỗi hex hoặc alphanumeric cho mật khẩu RabbitMQ vì Compose ghép chúng vào URI. Lần khởi động đầu tiên, PostgreSQL tạo ba database và role riêng. Service chạy schema của mình trước khi sẵn sàng.

```sh
docker compose --env-file .env -f deploy/docker-compose.yml up -d --build --wait
docker compose --env-file .env -f deploy/docker-compose.yml ps
```

Gateway tại `http://127.0.0.1:8080` và API tại `/api/v1`. Các port trên mạng Compose gồm Identity 8001, Driver 8002, Trip 8003, Matching 8004, Payment 8005, PostgreSQL 5432 và RabbitMQ 5672. Các cổng nội bộ chỉ dùng trong mạng Compose. Đăng nhập lại sau khi chuyển sang cấu hình JWT có issuer/audience.

### Chạy tiến trình riêng

Cài và build Driver và Matching. Cài runtime dependency của Trip và Payment.

```sh
npm --prefix src/driver-service install
npm --prefix src/driver-service run build
npm --prefix src/matching-service install
npm --prefix src/matching-service run build
npm --prefix src/trip-service install
npm --prefix src/payment-service install
npm run build
```

Provision database PostgreSQL bằng `deploy/init-postgres.sh` trên instance mới, hoặc tạo từng database với role sở hữu riêng. Mỗi tiến trình PostgreSQL nhận `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_USER`, `POSTGRES_PASSWORD` tương ứng. `JWT_SECRET` phải giống nhau giữa Identity, Trip và Driver. `INTERNAL_KEY` cấu hình cho Identity và Trip. Cấu hình URL RabbitMQ và URL dịch vụ theo địa chỉ thật, sau đó mở mỗi lệnh trong terminal riêng.

```sh
node src/identity-service/index.js
npm --prefix src/driver-service start
npm --prefix src/matching-service start
node src/trip-service/index.js
npm --prefix src/payment-service start
node src/api-gateway/index.js
```

- Driver cần `DRIVER_INTERNAL_KEY`, `DRIVER_TRIP_KEY`, `DRIVER_LOCATION_MIN_INTERVAL_MS`, `DRIVER_LOCATION_MAX_AGE_MS`.
- Matching cần `DRIVER_URL`, hai khóa Driver, `MATCHING_INTERNAL_KEY` và `RABBITMQ_URL`.
- Trip nhận `URL_DRIVER`, `DRIVER_TRIP_KEY`, `RABBITMQ_URL` và `PAYMENT_REQUIRED=true` cho luồng có giữ cước.
- Payment cần `IDENTITY_URL` và `RABBITMQ_URL`.
- Gateway cần `IDENTITY_URL`, `DRIVER_URL`, `TRIP_URL`, `PAYMENT_URL` và `DRIVER_INTERNAL_KEY`.

## Kiểm thử và demo

```sh
npm run check
node --test tests/security.test.cjs
node tests/run-all-tv1.js
npm --prefix src/matching-service test
```

Đặt `DRIVER_TEST_DATABASE_URL` tới PostgreSQL có quyền tạo schema để chạy Driver và integration HTTP/database:

```sh
npm --prefix src/driver-service test
node --test tests/booking.integration.test.cjs
```

Dùng project Compose riêng cho E2E và DLQ. Script tự đăng ký tài khoản, dùng tọa độ mô phỏng, provision hồ sơ tài xế trong database Driver và kiểm tra kết quả cuối.

```powershell
$env:COMPOSE_TEST_ENV_FILE = '.env'
$env:COMPOSE_TEST_PROJECT = 'ds03-demo'
$env:GATEWAY_TEST_URL = 'http://127.0.0.1:8080'
docker compose -p ds03-demo --env-file .env -f deploy/docker-compose.yml up -d --build --wait
node --test tests/compose.e2e.test.cjs
docker compose -p ds03-demo --env-file .env -f deploy/docker-compose.yml logs driver matching trip
```

Trong demo CT-01, đưa đúng một tài xế AVAILABLE ở khu vực tìm kiếm. Hai hành khách gửi request đồng thời, một chuyến được xác nhận giữ cước và một chuyến bị hủy. Kiểm tra chỉ một reservation hoạt động cho tài xế trong Driver DB. Sau accept, Driver chuyển BUSY. Sau complete, Payment capture và Driver trở lại AVAILABLE. Script in ID chuyến thắng để đối chiếu log.

- [Kiến trúc](docs/ARCHITECTURE.md)
- [API và sự kiện](docs/CONTRACTS.md)
- [Tiêu chí nghiệm thu](docs/TEST_PLAN.md)
- [Audit và bằng chứng chạy](docs/INTEGRATION_REPORT.md)
- [Audit bảo mật](docs/SECURITY_AUDIT.md)
- [Đánh giá triển khai](docs/PRODUCTION_READINESS.md)
- [Kịch bản demo và fault recovery](docs/DEMO_SCRIPT.md)
- [Kết quả load test](docs/LOAD_TEST_REPORT.md)
- [Kết quả chaos test](docs/CHAOS_TEST_REPORT.md)
- [Audit production](docs/FINAL_PRODUCTION_AUDIT.md)
- [HTTPS và mạng](docs/NETWORK_SECURITY.md)
- [RabbitMQ ACL](docs/RABBITMQ_SECURITY.md)
- [Backup và restore drill](docs/BACKUP_RESTORE_REPORT.md)
