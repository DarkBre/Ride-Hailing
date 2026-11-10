# Benchmark A/B

A dùng Gateway HTTPS và RabbitMQ ACL ở baseline `1528530`, PostgreSQL và AMQP plaintext nội bộ. B giữ application code và workload, bật TLS PostgreSQL/AMQP. A solo và B solo chỉ có tám container chạy. B multi có thêm tám container của A chạy nền, không bắn tải vào A.

Mỗi điều kiện chạy ba lần, 8 VU, warm-up 3 giây và cửa sổ phát request 6 giây. Mỗi lượt có 4 tài xế, 4 hành khách và cùng tọa độ mô phỏng. Workload gồm GPS, nearby, wallet và booking. Ví rỗng kiểm tra đường hold thất bại và bù trừ. Booking success đo HTTP tạo Trip thành công. Tỷ lệ chuyến hoàn tất có tài xế và capture được xác minh riêng bằng E2E.

```powershell
$env:NODE_EXTRA_CA_CERTS = 'D:/secure/demo-gateway-ca.pem'
./deploy/benchmark-acceptance.ps1 -Project ds03-acceptance -EnvFile tmp/ds03-acceptance.env -GatewayUrl https://127.0.0.1:18444 -Log tmp/bench-b.log -RabbitVhost ds03 -Runs 3 -WarmupMs 3000 -DurationMs 6000
```

Runner ghi throughput, latency theo endpoint, lỗi/timeout, số booking được Matching xử lý, P95 từ event created đến matching outbox, mẫu CPU/memory từng container, connection pool và RabbitMQ ready/unacked. Dùng một log mới mỗi điều kiện. Ngoài lúc đo, khôi phục các stack kiểm thử đã tạm dừng.

| Điều kiện | Request | Request/s | Lỗi / timeout | Booking được xử lý | Booking P50 / Avg / P95 / P99 (ms) | Event P95 (ms) |
|---|---:|---:|---:|---:|---:|---:|
| A solo | 204 | 9,14 | 0 / 0 | 48/48 | 47,0 / 47,1 / 106,7 / 106,7 | 1.477 |
| B solo | 204 | 9,42 | 0 / 0 | 48/48 | 28,4 / 34,1 / 61,3 / 61,3 | 1.331 |
| B multi | 183 | 8,19 | 0 / 0 | 41/41 | 79,4 / 87,8 / 241,9 / 241,9 | 1.575 |

Request/s là tổng request chia tổng thời gian ba lượt. Latency trong bảng là trung vị của thống kê từng lượt. Booking P95 theo lượt lần lượt là A solo `66,8 / 106,7 / 108,6`, B solo `86,3 / 61,3 / 61,1` và B multi `241,9 / 297,1 / 174,3` ms. Sampling thu CPU, memory, queue và kết nối; ví dụ B solo quan sát tối đa 5 connection Driver, 3 Matching và 3 Payment. Các số này là mẫu, không phải đỉnh tuyệt đối.

B solo có latency thấp hơn A solo trong các lượt đã đo. B multi chậm hơn B solo với cùng overlay khi thêm stack nền. Kết quả cho thấy độ nhạy với tải nền của host. Các lượt quá ngắn và chạy tuần tự, nên chưa tách được hiệu ứng TLS khỏi cache, tuổi dữ liệu và scheduling. Chưa có bằng chứng bottleneck để chỉnh SQLite, pool hay RabbitMQ.

Mẫu ngắn đo smoke và độ nhạy với môi trường. P95/P99 có thể trùng nhau vì số booking mỗi lần chạy nhỏ. GPS và booking có pacing, nên throughput dưới tải này không xác định trần hệ thống. Hai số P95 52,3 và 93,1 ms từ lần chạy trước chưa tách được tác động của TLS. WAL single-writer, pool, row lock, SKIP LOCKED, consumer concurrency và timeout giữ nguyên. Chưa có profile lock wait hoặc saturation để biện minh cho tuning.
