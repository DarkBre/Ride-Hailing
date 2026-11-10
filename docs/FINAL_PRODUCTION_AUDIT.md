# Audit production DS03

Mốc đối chiếu `ab1ade7`, nhánh `feature/tv2-driver-matching`. Kiểm tra thực tế cho thấy working tree sạch, tám container healthy và bốn volume ở project `ds03-verify`. Các thử nghiệm mới dùng project riêng.

| Hạng mục | Hiện trạng tại mốc đối chiếu | Rủi ro | Mức | Hành động |
|---|---|---|---|---|
| TLS | Gateway HTTP trên loopback | Lộ dữ liệu nếu công khai HTTP | HIGH | Overlay HTTPS và kiểm thử trust/hostname |
| Authentication | JWT HS256 và owner check | Phạm vi chia sẻ khóa | MEDIUM | Giữ contract, hạn chế phân phối secret |
| Login Rate Limit | Chưa có | Brute force | HIGH | Budget IP và account bền vững tại Identity |
| RabbitMQ ACL | Một credential và topology tự khai báo | Service có quyền thừa | HIGH | Vhost, service users, topic ACL và bootstrap operator |
| PostgreSQL Security | Role và DB riêng | Thiếu TLS, một node | HIGH | Giữ quyền sở hữu, đánh giá TLS và failover riêng |
| High Availability | Compose một node | Điểm lỗi đơn | HIGH | Lộ trình HA, giữ demo tách biệt |
| Backup | Chưa có quy trình chạy lại | Mất dữ liệu | HIGH | Logical dump, SQLite backup API, checksum |
| Restore | Chưa diễn tập | RTO/RPO chưa biết | HIGH | Project độc lập với kiểm tra trạng thái |
| Non-root | Identity/Trip chạy root | Tăng phạm vi ảnh hưởng | MEDIUM | UID node, volume mới và hướng dẫn migrate quyền |
| Graceful Shutdown | Không đồng nhất | Cắt request hoặc ACK | MEDIUM | Đóng HTTP, drain AMQP có giới hạn, giữ outbox |
| Health Probes | Một endpoint | Nhầm process sống với dependency ready | MEDIUM | Tách live/ready, giữ health cũ |
| Logging | Correlation ID, một phần structured | Thiếu số liệu vận hành | MEDIUM | Phân loại tín hiệu và quy tắc log |
| Monitoring | Số liệu benchmark rời rạc | Không có cảnh báo | MEDIUM | Đề xuất scrape riêng, chưa thêm stack |

Kết quả chạy và phần chưa đạt được ghi trong [báo cáo release](FINAL_RELEASE_REPORT.md).
