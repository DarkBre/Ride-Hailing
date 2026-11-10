# Baseline nghiệm thu DS03

Đầu lượt, nhánh local và remote đều ở `1528530`, working tree sạch. Compose có sáu service. Identity và Trip dùng SQLite WAL riêng. Driver, Matching và Payment có database và role PostgreSQL riêng. Gateway gọi Identity, Driver, Trip và Payment. Matching gọi Driver trực tiếp và nhận booking qua RabbitMQ. Trip phát sự kiện từ outbox, Matching phản hồi kết quả và Payment xử lý hold/capture/refund.

Gateway overlay có TLS. ACL broker chia quyền theo user và topic, nhưng URL của các service vẫn là AMQP plaintext. PostgreSQL dùng SCRAM và database ownership nhưng chưa buộc TLS. HTTP giữa các service vẫn plaintext trên network riêng. Không có frontend trong cây mã.

Baseline được báo cáo trước đây gồm 56 regression TV1, 14 unit/integration, E2E/CT-01/CT-02, ACL, HTTPS và restore logic. Hai phép đo booking P95 52,3 và 93,1 ms có tải nền khác nhau. Docker Engine dừng khi bắt đầu lượt này. Cần chạy lại trên project riêng sau khi khởi động Engine.

Ưu tiên bật mã hóa kèm xác thực server cho hai đường mang credential hạ tầng, xác minh không làm thay đổi Compose demo, sau đó chạy regression và fault probe. Giữ quyền sở hữu dữ liệu và contract hiện có.
