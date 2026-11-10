# Đánh giá triển khai DS03

Bản hardening 10/11/2026 đã bổ sung TLS Gateway, RabbitMQ ACL, login limiter, non-root và probe tách biệt. Các mục cũ phía dưới ghi baseline. Trạng thái hiện tại và bằng chứng ở [báo cáo release](FINAL_RELEASE_REPORT.md).

## Development và demo

Compose khởi tạo database và role theo service, mount volume riêng cho PostgreSQL, RabbitMQ, Identity và Trip. Health check điều phối startup. Gateway là cổng publish duy nhất và bind localhost. Các service khôi phục kết nối RabbitMQ, tiến trình Matching dùng lease và Trip lưu outbox trước khi publish.

Compose mặc định dùng nguồn cung thật qua Driver nearby cho Pricing. Trip lưu fare, distance và hệ số đã tính cùng chuyến. `PRICING_SUPPLY_MODE=demo` giữ nguồn cung mô phỏng; cấu hình này hữu ích khi chạy Trip standalone. Pricing vẫn nằm trong Trip. Contract hiện tại tính giá cơ bản, khoảng cách và surge theo VNĐ. Phụ phí theo thời gian và breakdown mới cần contract riêng.

## Trước production

- **HIGH** — RabbitMQ và PostgreSQL mỗi loại có một node. Kiểm tra restart giúp xác minh recovery trong cùng volume. Cần thiết kế HA và diễn tập khôi phục từ backup.
- **HIGH** — Bổ sung TLS, ACL RabbitMQ theo service, giới hạn đăng nhập và quy trình quản lý secret. Giữ internal endpoints trên mạng riêng.
- **MEDIUM** — Chuyển Identity và Trip sang non-root sau khi kiểm tra owner của volume. Chuẩn hóa graceful shutdown và probe tách liveness khỏi readiness.
- **MEDIUM** — Load test hiện là thử nghiệm quy mô nhỏ trên Docker Desktop. Cần SLO, load dài và kiểm tra backup/restore trước khi đánh giá năng lực production.

## Quyền sở hữu và SQLite

PDF mục DS03 yêu cầu mỗi service sở hữu dữ liệu/schema riêng và chỉ trao đổi qua mạng. SQLite WAL riêng của Identity và Trip đáp ứng ranh giới đó. WAL hỗ trợ đọc đồng thời nhưng chỉ một writer tại một thời điểm. Giữ mỗi service một replica ghi và backup bằng SQLite backup API, hoặc snapshot nhất quán đã xử lý WAL. Diễn tập restore vào volume mới và đối chiếu user, token revocation, Trip/Saga, inbox và outbox.

Nếu nhóm chọn PostgreSQL cho TV1, cần map TEXT UUID/timestamp và JSON sang kiểu PostgreSQL, kiểm tra số hàng và khóa duy nhất, quiesce writer, sao lưu nhất quán, import vào DB thuộc chính service, chạy regression và test replay. Rollback bằng cấu hình trỏ về snapshot SQLite trong cửa sổ trước khi nhận write mới. Sau cutover có write mới cần đồng bộ ngược hoặc kế hoạch đối soát trước rollback.

## Trip và Payment

| Trạng thái | Lệnh hoặc event | Kết quả hợp lệ |
|---|---|---|
| REQUESTED hoặc MATCHING | Matching giữ được tài xế | DRIVER_ASSIGNED |
| REQUESTED hoặc MATCHING | Hết ứng viên | CANCELLED |
| DRIVER_ASSIGNED | Payment giữ cước | CONFIRMED |
| DRIVER_ASSIGNED | Hold thất bại đúng Saga và tài xế | CANCELLED, giải phóng Driver |
| CONFIRMED | Driver accept và confirm reservation | ACCEPTED |
| ACCEPTED | Start | IN_PROGRESS |
| ACCEPTED hoặc IN_PROGRESS | Complete | COMPLETED, capture và release |
| Chưa kết thúc | Cancel hoặc hết hạn chờ nhận | CANCELLED, giải phóng và hoàn hold nếu cần |
| COMPLETED hoặc CANCELLED | Hold failure đến trễ | Giữ trạng thái cuối |

Payment quản lý hold theo trip. HELD có thể chuyển sang CAPTURED hoặc REFUNDED. Refund đến trước hold ghi tombstone. Các trạng thái cuối không phát sinh lần trừ hoặc hoàn thứ hai. Accept và cancel qua hai database được điều phối bằng Saga. Có thể có khoảng ngắn giữa Driver confirm và Trip xử lý hủy; CAS tại Trip và release qua outbox bảo đảm kết quả cuối.
