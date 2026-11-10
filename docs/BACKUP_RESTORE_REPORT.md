# Backup và restore drill

Nguồn `ds03-drill-source`, đích `ds03-drill-target`. Cả hai là project kiểm thử độc lập. Stack và volume có sẵn được giữ nguyên. Trước khi snapshot, fixture qua Gateway tạo chuyến ACCEPTED, Driver BUSY với reservation CONFIRMED và Payment HELD.

```powershell
docker compose -p ds03-drill-source --env-file tmp/drill-source.env -f deploy/docker-compose.yml stop gateway trip identity driver matching payment
./deploy/database-drill.ps1 -Mode Backup -Project ds03-drill-source -EnvFile tmp/drill-source.env -Archive tmp/drill-archive
docker compose -p ds03-drill-target --env-file tmp/drill-target.env -f deploy/docker-compose.yml up -d --wait postgres rabbitmq
./deploy/database-drill.ps1 -Mode Restore -Project ds03-drill-target -EnvFile tmp/drill-target.env -Archive tmp/drill-archive
docker compose -p ds03-drill-target --env-file tmp/drill-target.env -f deploy/docker-compose.yml up -d --build --wait
```

Script yêu cầu project có prefix `ds03-drill-`, ứng dụng đã dừng và queue đã drain. PostgreSQL dùng `pg_dump -Fc`, `pg_restore --list`, SHA-256 và restore từng database trong transaction. Globals và role được lưu dạng SQL không chứa mật khẩu. Target khởi tạo lại role tương ứng bằng secret của target. SQLite dùng `node:sqlite backup()` qua DB path của service, giữ nội dung đã commit trong WAL. Restore từ chối database đã có bảng và từ chối ghi đè file SQLite.

Snapshot xác minh được tạo lúc **19:06:53 ngày 10/11/2026 (UTC+7)**. Kho lưu trữ có SQLite chứa dữ liệu tài khoản và token đã thu hồi, vì vậy cần bảo vệ quyền truy cập và mã hóa khi lưu ngoài môi trường thử nghiệm.

**PASS.** Target khởi động từ các volume mới, truy vấn xác minh cùng trip ID với Trip ACCEPTED, Driver reservation CONFIRMED và Payment HELD. Sau đó chạy thành công booking/accept/complete/capture mới qua Gateway của target. Đo **209,5 giây** từ lúc bắt đầu provision target đến khi cả stack sẵn sàng và các trạng thái snapshot đã được xác minh. Thời gian gồm khởi động container và build khi cần. RPO production chưa được đo. Chuyến kiểm chứng và khoản giữ đã commit trước khi quiesce đều có trong snapshot.

RabbitMQ topology có thể tái tạo bằng `node deploy/rabbitmq-definitions.cjs` và script provision. Operator có thể xuất definitions bằng `rabbitmqctl export_definitions <path>` và bảo vệ file như secret vì có thể chứa password hash. Definitions chỉ chứa topology và quyền, còn message backlog cần quy trình bảo vệ riêng. Drill snapshot DB này yêu cầu queue rỗng và giữ outbox đã commit.
