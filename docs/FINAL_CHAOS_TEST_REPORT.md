# Chaos và cô lập lỗi

- **PASS** — Trên stack HTTPS/ACL riêng, disconnect container Identity khỏi mạng Compose. Gateway `/live` trả 200, `/ready` trả 503. Sau khi nối lại network alias, readiness trở về 200.
- **PASS** — Restart RabbitMQ với ACL đang bật. Gateway trở lại ready, rồi booking E2E qua HTTPS chạy lại bằng các service credential cũ.
- **PASS** — Baseline trước đợt này đã kiểm tra restart RabbitMQ, Driver và PostgreSQL, đồng thời xác minh hold, reservation và bù trừ. [Báo cáo baseline](CHAOS_TEST_REPORT.md)
- **NOT RUN** — Partition riêng Matching–Driver, Matching–RabbitMQ, Payment–PostgreSQL và broker–consumer bằng network filter. Kiểm thử restart khác với partition một đường truyền.
- **NOT RUN** — Xóa volume. Restore drill dùng volume đích mới để kiểm chứng phục hồi và giữ nguyên dữ liệu ở project nguồn. [Báo cáo restore](BACKUP_RESTORE_REPORT.md)
- **BLOCKED** — RabbitMQ quorum leader failover. Cấu hình đang chạy chỉ có một RabbitMQ node với classic queues. Chưa provision cluster nhiều node và topology quorum riêng.
