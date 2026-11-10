# RabbitMQ ACL

Compose mặc định giữ cấu hình demo. Overlay `deploy/docker-compose.acl.yml` dùng vhost `ds03` và user `matching`, `trip`, `payment`. Gateway, Identity và Driver giao tiếp HTTP nên không nhận credential AMQP. Service không có quyền quản trị, khai báo topology hoặc đọc queue của service khác. Các service publish event qua topic ACL và retry qua direct exchange riêng.

```powershell
# Đặt RABBITMQ_MATCHING_PASSWORD, RABBITMQ_TRIP_PASSWORD, RABBITMQ_PAYMENT_PASSWORD
# trong process environment từ secret store. Dùng chuỗi URL-safe, tối thiểu 24 ký tự.
./deploy/provision-rabbitmq.ps1 -Project ds03-acl -EnvFile .env
docker compose -p ds03-acl --env-file .env -f deploy/docker-compose.yml -f deploy/docker-compose.acl.yml up -d --build --wait
```

Bootstrap dành cho project mới. Operator quản lý user và import definitions. Retry queue vẫn dùng TTL 1/2/4 giây, DLX và cùng routing key nghiệp vụ. Consumer giữ ACK sau commit và publisher confirm. Giữ credential operator tách khỏi service. Đổi từ vhost demo sang ACL cần drain backlog cũ trước khi cutover. Vhost mới không tự chuyển message cũ.

Đã xác minh bằng broker thật. Matching bị từ chối khi đọc payment queue, tạo queue và publish routing key Payment. Payment bị từ chối khi publish vào DLX. Credential sai và Driver không có broker identity đều bị từ chối. Sau restart RabbitMQ, Gateway trở lại ready và booking E2E chạy lại với cùng ACL.
