# Báo cáo release hardening DS03

## Kết luận

**READY FOR DEMO qua API và READY FOR REVIEW.** Các điều kiện production còn mở gồm TLS nội bộ, failover đa node, RPO/PITR và rollout trên volume cũ. Stack demo vẫn gồm sáu service. SQLite ownership của TV1 và contract nghiệp vụ được giữ nguyên.

| Hạng mục | Kết quả | Bằng chứng |
|---|---|---|
| Build, regression TV1 | PASS | Root build và 56/56 ca |
| Unit/integration | PASS | 14/14, HTTP/SQLite và PostgreSQL thật |
| FT-03/04/06, CT-01 và E2E | PASS | Suite cục bộ và Compose trên target đã restore, thêm E2E qua HTTPS/ACL |
| CT-02 | PASS | Hai lệnh hold 40.000 VNĐ trên ví 50.000 VNĐ. Một lệnh thắng |
| Load smoke sau restore | PASS chức năng | 512 request, 0 lỗi; Booking P95 93,1 ms, cao hơn baseline 52,3 ms |
| TLS | PASS cho Gateway | HTTPS với CA test được trust và hostname khớp. Client không trust cert bị từ chối |
| RabbitMQ ACL | PASS | Dùng credential riêng, từ chối queue chéo, configure, exchange/key ngoài ACL và mật khẩu sai |
| Rate limit | PASS | Hai IP, cùng account, concurrent request, cooldown và spoofing |
| Non-root | PASS trên volume mới | Identity và Trip UID 1000, E2E ghi SQLite thành công |
| Graceful shutdown | PASS khi idle, xác minh một phần khi có tải | Sáu process thoát SIGTERM mã 0. Restart giữ reservation. Chưa chèn tín hiệu đúng lúc mọi handler đang chạy |
| Backup/Restore | PASS | Project đích độc lập, xác minh Trip, reservation, hold và E2E |
| Network partition | PASS một đường | Gateway–Identity disconnect/reconnect, liveness và readiness tách biệt |
| Volume loss | NOT RUN | Restore vào volume mới đã qua. Không xóa volume |
| Quorum failover | BLOCKED | Chưa có cluster quorum và failure domain riêng |
| Monitoring production | NOT RUN | Chưa triển khai SLO, Prometheus/Grafana và alerting |

Load chạy 8 VU trong 62,24 giây, khoảng 8,23 request/giây. Các stack kiểm thử cùng chạy trên Docker Desktop. Kết quả tải này xác minh luồng hoạt động dưới tải. Cần benchmark A/B trên cùng điều kiện máy để xác định tác động của hardening đến độ trễ.

## Chạy và review

- [Production audit](FINAL_PRODUCTION_AUDIT.md), [Network/TLS](NETWORK_SECURITY.md), [rate limiting](RATE_LIMITING.md), [RabbitMQ](RABBITMQ_SECURITY.md).
- [HA và SQLite](HA_ARCHITECTURE.md), [restore drill](BACKUP_RESTORE_REPORT.md), [health/shutdown](HEALTH_CHECKS.md), [chaos](FINAL_CHAOS_TEST_REPORT.md), [observability](OBSERVABILITY.md).

TV1 review rate limit, contract registration trùng email, ownership và rollout volume SQLite. TV2 review restore và kiểm thử contention ở mô hình nhiều instance. TV3 review CA/renewal, vhost/ACL, migration classic sang quorum và topology mạng. Production approval cần runbook failover, backup off-site và restore/PITR đã diễn tập.
