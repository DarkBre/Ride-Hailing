# Xác minh và giới hạn HA

**BLOCKED cho quorum failover và HA production.** Môi trường chỉ chạy các project RabbitMQ một node độc lập với classic queues. Restart broker và nhận lại message chứng minh recovery trên cùng volume. Chưa quan sát leader election, mất đa số, publisher confirm khi mất node hoặc phục hồi liên failure domain.

Gateway có thể scale sau ingress. Identity và Trip cần một writer SQLite cho mỗi database. Không dùng network filesystem chứa cùng SQLite file cho nhiều replica. Muốn HA tự động cho hai service, review migration, idempotency và fencing writer trước khi đổi quyền sở hữu dữ liệu. Driver và Payment dùng transaction/unique constraint; Matching có job lease và inbox/outbox. Cần nghiệm thu thêm trên nhiều replica để định lượng contention và backlog khi failover.

Quorum drill cần vhost riêng và ba node. Ghi một batch persistent message có confirm, xác định leader, dừng leader, kiểm tra confirm tiếp tục, đo redelivery và kiểm tra inbox không lặp side effect. Tách một node khỏi đa số, xác minh phía thiểu số từ chối ghi. Giữ classic queues demo để tránh đổi queue type tại chỗ. PostgreSQL HA cần cluster primary/replica và thử fencing, lag, promotion, endpoint và rollback.
