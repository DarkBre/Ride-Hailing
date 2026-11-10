# Health probes và shutdown

Sáu service có `GET /live` để xác nhận HTTP process còn phản hồi. `GET /ready` kiểm tra SQLite hoặc PostgreSQL với service sở hữu DB. Matching và Payment kiểm tra thêm kết nối broker. Trip sẵn sàng ghi vào SQLite outbox khi broker tạm ngắt. Gateway kiểm tra readiness của các upstream trực tiếp. `/health` cũ giữ tương thích.

Compose dùng readiness cho startup dependency. Probe liveness không phụ thuộc DB hoặc RabbitMQ. Các service dùng SIGTERM/SIGINT để dừng nhận HTTP. Identity và Trip có giới hạn drain HTTP. Trip chờ lượt publish hiện tại và giữ phần chưa phát trong outbox. Consumer Trip, Matching và Payment hủy subscription khi shutdown và đợi các handler đang chạy trong giới hạn. Message chưa ACK có thể được gửi lại, nên inbox/idempotency vẫn là cơ chế chính khi process bị kill.

Đã gửi SIGTERM qua Compose stop trên stack thử nghiệm. Gateway, Identity, Driver, Trip, Matching và Payment đều thoát với mã 0 ở trạng thái idle. Các suite restart giữ reservation đã commit. Chưa chèn SIGTERM có chủ đích giữa từng HTTP handler, DB transaction hoặc capture/ACK.

Identity và Trip dùng user node. Volume mới được khởi tạo thư mục dữ liệu UID/GID 1000. Volume cũ do root tạo cần backup rồi migrate ownership trong thời gian bảo trì, chỉ trong volume dữ liệu của service. Xác minh cả thư mục, file SQLite, WAL và SHM. Không dùng chmod 777.

Sau khi dừng writer và xác minh backup của đúng project, operator có thể sửa ownership của từng volume SQLite:

```powershell
docker compose --env-file .env -f deploy/docker-compose.yml stop identity trip
docker compose --env-file .env -f deploy/docker-compose.yml run --rm --no-deps --user 0 identity chown -R 1000:1000 /app/data
docker compose --env-file .env -f deploy/docker-compose.yml run --rm --no-deps --user 0 trip chown -R 1000:1000 /app/data
docker compose --env-file .env -f deploy/docker-compose.yml up -d --build --wait
```

Đợt thử này dùng volume mới. Chưa áp dụng lệnh migrate ownership lên volume đang sử dụng.
