# Rate limit xác thực

Identity lưu bộ đếm trong SQLite WAL và cập nhật atomically. Login mặc định 60 lần/IP và 10 lần/account trong cửa sổ 60 giây. Registration mặc định 20 lần/IP. Khi chạm giới hạn, trả HTTP 429 với `Retry-After`. Login tính cả lần thành công để hạn chế tốc độ kiểm tra credential. Các response sai credential giữ cùng thông điệp hiện tại. Hết cửa sổ, bucket tự hết hạn.

Gateway chuyển địa chỉ socket bằng header nội bộ có HMAC. Đặt cùng `RATE_PROXY_KEY` ở Gateway và Identity để phân biệt IP qua Gateway. Khi thiếu khóa hoặc chữ ký sai, Identity dùng địa chỉ socket. Client không được truyền X-Forwarded-For hay chữ ký của mình qua Gateway. Các replica Gateway chia sẻ budget tại cùng Identity, nên không có limiter RAM riêng làm nguồn quyết định. Identity SQLite vẫn chạy một writer.

Các biến `AUTH_RATE_WINDOW_MS`, `AUTH_RATE_IP_LIMIT`, `AUTH_RATE_ACCOUNT_LIMIT` và `AUTH_RATE_REGISTER_LIMIT` cấu hình cửa sổ và budget. Refresh token chưa có trong API. Account bucket giảm credential stuffing phân tán nhưng có thể làm chậm login hợp lệ đến hết cooldown. Chọn ngưỡng production theo tải và mô hình NAT thực tế.

Login dùng scrypt cả khi email chưa tồn tại để giảm chênh lệch thời gian phản hồi. Registration vẫn giữ HTTP 409 theo contract cũ khi email trùng. Việc ẩn khả năng liệt kê tài khoản qua registration cần thay đổi contract và luồng xác minh email.

`node --test tests/rate-limit.test.cjs` chạy HTTP và SQLite thật, kiểm tra login hợp lệ, lỗi liên tiếp, hai IP, cùng account từ nhiều IP, đồng thời, cooldown và proxy spoofing.
