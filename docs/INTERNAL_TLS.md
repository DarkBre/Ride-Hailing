# TLS hạ tầng nội bộ

Stack demo tiếp tục dùng HTTP, PostgreSQL và AMQP trên network riêng. Profile nghiệm thu dùng Gateway HTTPS, PostgreSQL TLS và AMQPS. HTTP giữa Gateway và Identity/Driver/Trip/Payment, Matching/Trip và Driver, Payment và Identity vẫn plaintext trên network Compose. Gateway không gọi Matching trực tiếp. mTLS chưa triển khai.

## Cấu hình

Chuẩn bị thư mục ngoài Git với `ca.crt`, `postgres/server.crt`, `postgres/server.key`, `rabbitmq/server.crt`, `rabbitmq/server.key`. PostgreSQL cần SAN `DNS:postgres`, RabbitMQ cần `DNS:rabbitmq`. Dùng key riêng cho mỗi server. CA private key nằm ngoài thư mục mount và ngoài máy chạy Compose. Giữ server key chỉ cho operator và user chạy server đọc. PostgreSQL entrypoint cài key vào thư mục runtime quyền 0600. RabbitMQ cần quyền đọc key trên mount cho user trong container.

Provision ACL trên project mới theo [runbook RabbitMQ](RABBITMQ_SECURITY.md). Sau đó áp dụng overlay theo thứ tự:

```powershell
$env:INTERNAL_TLS_DIR = 'D:/secure/ds03-internal'
docker compose -p ds03-acceptance --env-file .env -f deploy/docker-compose.yml -f deploy/docker-compose.acl.yml -f deploy/docker-compose.tls.yml -f deploy/docker-compose.internal-tls.yml up -d --build --wait
```

PostgreSQL chỉ cho TCP qua `hostssl` với SCRAM. Socket Unix cục bộ trong container dùng cho bootstrap, backup và thao tác operator. AMQP port plaintext tắt. TLS dùng CA tin cậy và kiểm tra SAN. Credentials từng service vẫn được broker và PostgreSQL kiểm tra độc lập.

## Cấp và thay chứng chỉ

Operator tạo CSR với key mới, xác nhận SAN, ký qua CA hoặc PKI được duyệt và đặt cert/key vào secret mount. Đo hạn bằng `openssl x509 -checkend` trong giám sát. Thay leaf bằng file đã xác minh, restart server và kiểm tra reconnect. Khi đổi CA, thêm CA mới vào trust bundle trước khi thay leaf, xác minh tất cả client, sau đó gỡ CA cũ. Client hiện kiểm tra chain, hạn và hostname. Revocation chủ động qua CRL/OCSP chưa bật, cần PKI và phương án thu hồi được duyệt trước production.

Để bật mTLS HTTP, cấp identity riêng cho từng service, xác minh SAN server và map client certificate sang caller được phép. Rollout dual trust trước, thử sai SAN, hết hạn và revoked, sau đó tắt plaintext. JWT và phân quyền nghiệp vụ vẫn cần giữ.

## Kiểm thử

`INTERNAL_TLS_TEST_PROJECT=ds03-acceptance` và `node --test tests/internal-tls.test.cjs` xác minh PostgreSQL qua `pg_stat_ssl`, AMQPS kết nối thành công, và cả hai từ chối plaintext, CA sai và SAN sai. Probe thứ hai dùng leaf test hết hạn, kiểm tra lỗi `CERT_HAS_EXPIRED` của Node TLS. E2E trên stack TLS/ACL xác minh CT-01, accept, complete, capture và release.

Đặt `INTERNAL_TLS_TEST_CA`, `EXPIRED_TLS_CERT` và `EXPIRED_TLS_KEY` tới file fixture khi chạy probe hết hạn. Có thể ký CSR test bằng `openssl x509 -req -days 0` với SAN đúng, sau đó chạy probe khi thời điểm notAfter đã qua. Giữ fixture ngoài Git.
