# Báo cáo tải DS03

Chạy ngày 09/11/2026 trên Docker Desktop Linux backend, 12 vCPU và khoảng 7,60 GiB RAM cấp cho engine. Node host 25.9, PostgreSQL 17 và RabbitMQ 4, Gateway loopback tại port 18080. Compose dùng nguồn cung thật cho Pricing. Bộ phát tải là Node.js trong `tests/compose.e2e.test.cjs`.

```powershell
$env:RUN_LOAD_TEST = '1'
node --test --test-name-pattern 'Load:' tests/compose.e2e.test.cjs
```

8 người dùng ảo gồm 4 tài xế cập nhật GPS và 4 hành khách gọi nearby, wallet và booking liên tục. Tài khoản thiết lập qua Identity. Các chuyến cùng khu vực tranh chấp tài xế; ví rỗng tạo các lệnh hold thất bại và bù trừ. CT-02 kiểm tra riêng đường hold cạnh tranh trên ví có tiền.

| Nhóm request | Số request | Lỗi HTTP/client | Trung bình (ms) | P95 (ms) | P99 (ms) |
|---|---:|---:|---:|---:|---:|
| GPS | 192 | 0 | 24,4 | 50,2 | 117,2 |
| Nearby | 135 | 0 | 14,6 | 29,1 | 54,7 |
| Wallet | 135 | 0 | 19,3 | 36,9 | 51,9 |
| Booking | 135 | 0 | 27,0 | 52,3 | 66,0 |

597 request trong 61,55 giây, trung bình **9,70 request/giây**, lỗi **0%**. Bốn mẫu queue của `trip.queue`, `matching.queue` và `payment.queue` có 0 message ready và tối đa 1 unacked trên mỗi queue. Đỉnh quan sát ở bốn mẫu kết nối PostgreSQL là Driver 5, Matching 3 và Payment 2. Sau vòng tải, test đợi tất cả reservation của bốn tài xế giải phóng.

**PASS cho kịch bản đã chạy.** Không áp SLO vì đề bài chưa cung cấp ngưỡng. Thông lượng phản ánh pacing của script. Kết quả chưa đo điểm bão hòa, thời gian từ booking đến match hoặc tải Identity login kéo dài.
