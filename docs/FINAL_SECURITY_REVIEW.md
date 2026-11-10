# Security review cuối

- Gateway chỉ proxy route công khai được liệt kê. Internal endpoint và cổng dữ liệu không publish mặc định. Rate limit Identity xác minh HMAC của header địa chỉ do Gateway tạo. Trường forwarded của client không được dùng làm nguồn IP.
- Identity và Trip xác minh HS256, expiry, issuer/audience trong Compose và role/định danh. Contract hiện dùng `userId` làm định danh thay vì JWT `sub`. Driver dùng owner từ token; Trip tách idempotency theo passenger; wallet xác thực owner qua Identity. JWT shared-secret rotation đồng bộ vẫn cần runbook.
- Các route ghi chính dùng SQL có tham số và giới hạn body. Demo có CORS ở service nội bộ, chưa cung cấp CORS policy production qua ingress. Gateway trả no-store/nosniff và có HSTS opt-in.
- PostgreSQL/AMQPS overlay từ chối plaintext và kiểm tra certificate server. HTTP liên service còn cần TLS. RabbitMQ ACL đã được kiểm tra ở mốc hardening và giữ nguyên trên overlay mới.
- Retry exchange cho phép consumer đưa message lỗi trở lại đường retry của chính nó. Chưa ký envelope giữa producer/consumer. ACL cần được đánh giá cùng trust boundary của từng service credential.
- `npm audit --omit=dev` trên cây runtime Matching báo 0 advisory tại lần kiểm tra. Chưa scan tất cả image và các layer hệ điều hành. Kết quả registry là snapshot tại thời điểm chạy.
- Git history ở `2e59e1f` có giá trị credential mẫu dạng literal. Chưa xác minh từng được dùng bên ngoài repo. Nếu đã tái sử dụng, operator cần rotate. Không in giá trị lịch sử hoặc đổi secret production.

Các test có liên quan gồm `tests/security.test.cjs`, `tests/rate-limit.test.cjs`, `tests/production-probes.test.cjs` và `tests/internal-tls.test.cjs`. Xem [audit baseline](SECURITY_AUDIT.md) để biết phạm vi các phát hiện trước đây.
