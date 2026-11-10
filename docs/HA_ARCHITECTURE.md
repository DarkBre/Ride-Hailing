# Kiến trúc HA đề xuất

| Thành phần | Triển khai hiện tại | Đường lên HA |
|---|---|---|
| Gateway | Stateless, một container | Nhiều replica sau ingress với cùng cấu hình trust/IP |
| Identity và Trip | Một writer SQLite WAL riêng | Giữ một writer cho demo. PostgreSQL là bước cần đánh giá nếu yêu cầu failover tự động hoặc nhiều writer |
| Driver, Matching, Payment | Tiến trình tách dữ liệu, transaction và idempotency | Nhiều replica sau khi kiểm tra contention, connection budget, lease, outbox duplicate và rollback |
| PostgreSQL | Primary duy nhất | Primary/replica có fencing, endpoint failover, đo lag, PITR và restore drill |
| RabbitMQ | Một node, classic queues | Ba node trên failure domain riêng, quorum queue, client reconnect và xác minh confirm khi mất leader |

Quorum yêu cầu đa số node. Chuyển queue hiện hữu từ classic sang quorum cần vhost hoặc queue mới và kế hoạch drain/cutover. Không đổi kiểu queue ngay trên dữ liệu demo. HA và quorum failover chưa được xác minh trên cluster thật. Đợt này chưa provision môi trường nhiều failure domain.

SQLite WAL cho phép đọc đồng thời và một writer tại một thời điểm. Không mount cùng file ghi qua nhiều container hoặc network filesystem để đạt HA. Nếu nhóm duyệt PostgreSQL, map UUID/timestamp, khóa duy nhất, JWT revocation, Trip/Saga/inbox/outbox. Thực hiện backup nhất quán, so số hàng, khóa và đối chiếu nghiệp vụ. Chuyển một service mỗi lần. Sau cutover có write mới, rollback cần đối soát hoặc đồng bộ ngược trước khi mở writer cũ.
