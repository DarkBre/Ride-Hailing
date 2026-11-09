# Báo cáo fault recovery DS03

Chạy trên project Compose thử nghiệm riêng với PostgreSQL 17 và RabbitMQ 4. Các thao tác stop/restart giữ nguyên volume. Suite tạo tài khoản và chuyến mô phỏng qua Gateway.

```powershell
$env:RUN_CHAOS_TEST = '1'
node --test tests/compose.e2e.test.cjs
```

- **PASS — Matching stop/start.** Trip vẫn nhận booking trong thời gian Matching dừng. Sau khi Matching lên lại, chuyến được xử lý và tài xế gần nhất được giữ.
- **PASS — Hủy, từ chối và timeout.** Reservation được giải phóng, khoản hold được hoàn và tài xế trở lại AVAILABLE.
- **PASS — Retry/DLQ.** Lệnh release lỗi có ba lần retry rồi đến DLQ. Probe đọc được retry count bằng 3.
- **PASS — Duplicates và event đến trễ.** Suite cục bộ xử lý lặp event, khôi phục cùng reservation ID sau khi Driver đã commit và chặn hold failure đến trễ sửa chuyến hoàn tất.

Lần chạy đầu của probe RabbitMQ/Driver gặp lỗi HTTP socket ở harness ngay sau lệnh Docker đồng bộ chạy lâu. Chuyển các lệnh Docker dài sang async để HTTP event loop tiếp tục xử lý socket trong thời gian chờ.

**PASS — RabbitMQ, Driver và PostgreSQL.** Lần chạy lại hoàn thành probe trong 33,62 giây. Trip được tạo khi RabbitMQ dừng, giữ REQUESTED cho đến khi event được gửi lại và sau đó nhận CONFIRMED. Sau accept, restart Driver và PostgreSQL giữ nguyên ID reservation và khoản hold. Complete capture đúng cước, ví hết khoản giữ và reservation chuyển RELEASED. Kết quả suite lần chạy lại là 5 pass, 0 fail, 1 skip do load chạy riêng.

**NOT RUN** — Network partition riêng, kill consumer ngay giữa transaction/ACK, mất volume broker, failover quorum và restore từ backup. Restart giữ volume chỉ xác minh khả năng phục hồi của bản demo một node.
