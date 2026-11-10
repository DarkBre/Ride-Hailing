# Nghiệm thu DS03

**READY FOR DEMO qua API và READY FOR REVIEW.** TLS của đường dữ liệu và PITR một PostgreSQL DB đã được kiểm chứng. Chưa đạt production candidate vì HTTP liên service, HA, recovery giữa transaction và các điều kiện vận hành production còn mở.

| Hạng mục | Trạng thái | Bằng chứng |
|---|---|---|
| Build | PASS | Build TypeScript, kiểm tra cú pháp các service và build Compose |
| Regression TV1 | PASS | Identity 18/18, Trip 24/24, Saga 14/14 |
| Unit/integration | PASS | 15/15, gồm HTTP và PostgreSQL thật cùng SQLite WAL recovery |
| Driver API | PASS | FT-03/FT-04, GPS và chuyển trạng thái |
| Matching | PASS | FT-06, E2E chọn tài xế gần nhất và phục hồi sau mất network |
| Reservation concurrency | PASS | CT-01 trên demo và TLS/ACL, đúng một reservation hoạt động |
| Payment | PASS | CT-02 trên demo, E2E capture/refund trên TLS |
| Gateway HTTPS | PASS | Client tin CA test, xác minh hostname |
| Internal TLS | PASS cho PostgreSQL và AMQPS, NOT RUN cho HTTP/mTLS | `pg_stat_ssl`, AMQPS, từ chối plaintext/sai CA/sai SAN. Node TLS từ chối leaf hết hạn |
| RabbitMQ ACL | PASS | E2E với service credential, probe quyền chéo và sai routing key |
| Backup/restore | PASS | Drill logic baseline đã giữ ba trạng thái nghiệp vụ. Lượt này kiểm tra lại checksum, SQLite integrity và E2E trên đích |
| PITR | PASS một DB, NOT RUN production | Base backup + WAL, phục hồi đúng timestamp trước DELETE và đúng hai hàng |
| HA | BLOCKED | Không có cluster quorum hoặc failover PostgreSQL đa node |
| Load benchmark | PASS cho workload kiểm thử | [Benchmark A/B](PERFORMANCE_BENCHMARK.md). Chưa có SLO hoặc benchmark bão hòa |
| Chaos testing | PASS cho các probe đã xác minh, NOT RUN cho các fault giữa transaction | Network partition Matching, retry/DLQ và restart broker/Driver/PostgreSQL qua khi cô lập. Lần FAIL dưới nhiều stack được ghi riêng |
| Documentation | PASS | Baseline, TLS, benchmark, DR, HA, chaos, security, demo và báo cáo này |

[Demo từng bước](FINAL_DEMO_SCRIPT.md) · [TLS](INTERNAL_TLS.md) · [Disaster recovery](DISASTER_RECOVERY.md) · [HA](HA_VALIDATION.md) · [Chaos](FINAL_CHAOS_VALIDATION.md) · [Security](FINAL_SECURITY_REVIEW.md)

TV1 review giới hạn single-writer và phương án TLS HTTP cho Identity/Trip. TV2 review fault injection trong reserve/capture và đối soát ba database sau sự cố. TV3 review CA/rotation, AMQPS ACL, quorum và WAL archive ngoài failure domain. Không thay contract nghiệp vụ, database schema hoặc quyền sở hữu trong đợt này.
