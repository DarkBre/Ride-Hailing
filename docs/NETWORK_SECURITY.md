# TLS và cô lập mạng

Compose mặc định publish Gateway HTTP tại loopback. PostgreSQL, RabbitMQ và management UI không có host port. Service trao đổi qua network của project. PostgreSQL dùng role riêng và thu hồi CONNECT công khai trên ba database nghiệp vụ. Mạng Compose mặc định vẫn cho phép các container trong cùng project liên lạc với nhau.

Overlay `deploy/docker-compose.tls.yml` bật HTTPS trực tiếp ở Gateway, TLS tối thiểu 1.2. Gateway chỉ lấy địa chỉ từ socket và bỏ forwarded headers của client. Overlay dùng đúng port Gateway đã publish, vì vậy không có listener HTTP thứ hai để redirect.

```powershell
$env:GATEWAY_TLS_DIR = 'D:/secure/ride-hailing-tls'
docker compose --env-file .env -f deploy/docker-compose.yml -f deploy/docker-compose.tls.yml up -d --build --wait
```

Mount `fullchain.pem` và `privkey.pem` read-only. Trên Linux chỉ cấp quyền đọc key cho UID/GID 1000 của Gateway hoặc dùng secret mount tương đương. Kiểm tra SAN và chuỗi CA bằng client xác thực bình thường. Probe nội bộ kiểm tra endpoint trên loopback và không dùng làm bằng chứng trust chain.

Dev/demo dùng chứng chỉ test được client trust tường minh. Production cần chứng chỉ CA, giám sát ngày hết hạn, renewal ngoài ứng dụng và rolling restart để nạp file mới. Bật `GATEWAY_HSTS=1` sau khi xác minh HTTPS ổn định. Khi thêm load balancer, cấu hình client IP ở ingress đáng tin cậy. TLS liên service, PostgreSQL và RabbitMQ vẫn là điều kiện trước triển khai production.
