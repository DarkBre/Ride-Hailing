# Kịch bản demo DS03

Chuẩn bị Docker Desktop, tạo `.env` từ mẫu và điền secret. Dùng project riêng để các probe restart không ảnh hưởng stack khác.

```powershell
$env:COMPOSE_TEST_PROJECT = 'ds03-demo'
$env:COMPOSE_TEST_ENV_FILE = '.env'
$env:GATEWAY_TEST_URL = 'http://127.0.0.1:8080'
docker compose -p ds03-demo --env-file .env -f deploy/docker-compose.yml up -d --build --wait
node --test tests/compose.e2e.test.cjs
```

1. Suite đăng ký và đăng nhập tài khoản mô phỏng, provision hồ sơ Driver, đưa tài xế AVAILABLE và cập nhật GPS.
2. Hai hành khách nạp ví và đặt xe đồng thời. Một chuyến CONFIRMED, một chuyến CANCELLED, một reservation hoạt động. Đối chiếu ID chuyến thắng trong output với log Driver và Matching.
3. Tài xế accept, start và complete. Theo dõi Driver chuyển BUSY rồi AVAILABLE. Ví hết khoản giữ, số tiền cước được capture. Trạng thái ARRIVED chưa có trong contract.
4. CT-02 gửi hai hold 40.000 VNĐ vào ví 50.000 VNĐ. Kiểm tra một hold thành công, số dư khả dụng 10.000 VNĐ.
5. Suite dừng và khởi động lại Matching, kiểm tra hủy/từ chối/hết hạn. Event release lỗi đi vào DLQ sau ba retry.

```powershell
$env:RUN_CHAOS_TEST = '1'
node --test --test-name-pattern 'Chaos:' tests/compose.e2e.test.cjs
docker compose -p ds03-demo --env-file .env -f deploy/docker-compose.yml logs driver matching trip
```

Probe chaos dừng RabbitMQ, tạo chuyến khi broker ngắt, kiểm tra Trip tiếp tục sau khi broker trở lại. Sau accept, restart Driver và PostgreSQL, đối chiếu cùng reservation ID và khoản giữ trước khi complete.
