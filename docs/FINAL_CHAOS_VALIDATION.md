# Xác minh chaos cuối

| Điều kiện và lỗi | Kỳ vọng | Kết quả |
|---|---|---|
| Stack TLS/ACL, Matching tách khỏi network, sau đó tạo chuyến | Trip giữ REQUESTED, sau reconnect ghép đúng tài xế; release/refund khi hủy | PASS. Sau reconnect xác minh driver gần nhất, từ chối, hủy và hết hạn |
| Stack demo restore, restart Matching | Booking tiếp tục qua outbox, trạng thái cuối nhất quán | PASS trong lần chạy baseline demo |
| Stack demo, stop RabbitMQ khi tạo booking, rồi restart Driver và PostgreSQL | Outbox phục hồi trong cửa sổ probe, reservation và hold đã commit còn nguyên | FAIL lần đầu khi nhiều stack cùng chạy. Sau 25 giây booking còn REQUESTED. PASS khi chạy lại với một stack, toàn kịch bản 31,27 giây. Reservation ID giữ nguyên và capture đúng tiền |
| Release lỗi qua RabbitMQ demo | Ba retry rồi DLQ | PASS. Probe đọc đúng retry count |
| CT-01/CT-02 trên PostgreSQL thật | Một reservation hoạt động và một hold hợp lệ | PASS trên demo, CT-01 cũng PASS trên TLS/ACL |
| SQLite đang có committed WAL, backup và làm hỏng bản sao | Backup đọc đúng dữ liệu, bản hỏng bị từ chối | PASS. Hai bản ghi và integrity check đã xác minh |
| PostgreSQL PITR một DB sau lệnh DELETE | Recovery đến timestamp trước DELETE phục hồi đúng hai hàng | PASS ở container không nối mạng |

**NOT RUN** — Signal chính xác giữa transaction hoặc ACK, mất PostgreSQL đúng lúc reserve, Payment restart giữa capture, Trip restart giữa cancellation, xóa volume, partition độc lập từng link Matching–Driver, Matching–RabbitMQ và Payment–PostgreSQL. Probe Matching ngắt toàn bộ network của container, bao gồm PostgreSQL, RabbitMQ và Driver, nên không tách được nguyên nhân cho từng link.

**BLOCKED** — Quorum failover, chưa có cluster quorum để quan sát leader election. [HA validation](HA_VALIDATION.md)
