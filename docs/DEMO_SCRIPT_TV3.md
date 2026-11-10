# KỊCH BẢN THUYẾT TRÌNH & DEMO THÀNH VIÊN 3 (TV3)
## CHỦ ĐỀ: CHỊU LỖI, SẬP SERVICE, DEAD-LETTER QUEUE VÀ SAGA BÙ TRỪ
**Thời lượng:** 3 phút (Phút 7 – 10 trong tổng thời lượng 10 phút của nhóm)  
**Người trình bày:** Thành viên 3 (Quang)  
**Giao diện sử dụng:** Web Simulation Dashboard (`http://localhost:3000`) & RabbitMQ Management (`http://localhost:15672`)

---

### PHÚT 7:00 – 7:45: MỞ ĐẦU & TỔNG QUAN HẠ TẦNG THÔNG ĐIỆP
* **Lời thoại trình bày:**
  > "Kính thưa Thầy Cô và Hội đồng, em là Quang, đại diện Thành viên 3 phụ trách Hạ tầng Thông điệp RabbitMQ, Transactional Outbox, API Gateway, Simulated Payment Service và Web Simulation Dashboard mà Thầy Cô đang quan sát trên màn hình.
  >
  > Như Thầy Cô đã thấy ở phần trình bày của Thành viên 1 và 2, hệ thống microservices của nhóm chạy trên các tiến trình hoàn toàn độc lập, sở hữu cơ sở dữ liệu riêng biệt. Ở phần 3 này, em sẽ chứng minh hai đặc tính phân tán sống còn của hệ thống: **Khả năng chịu lỗi và tự phục hồi khi sập tiến trình (Fault Tolerance & Self-Healing)** và **Giao dịch phân tán Saga có bù trừ (Compensating Actions)**."
* **Thao tác trên màn hình:**
  - Chỉ vào Web Dashboard: 2 đèn xanh Gateway (:8080) và Payment (:8005) đang hoạt động.
  - Mở tab RabbitMQ Management hiển thị exchange `trip.exchange`, các queue `payment.queue`, `trip.queue` và Dead-Letter Queue `trip.dlq`.

---

### PHÚT 7:45 – 8:45: DEMO 1 — CHỊU LỖI SẬP SERVICE & PHỤC HỒI TỪ QUEUE (FR-01)
* **Kịch bản:**
  1. Đặt một chuyến xe từ Web Dashboard.
  2. Bấm dừng đột ngột tiến trình `Payment Service` trước khi xử lý thanh toán:
     ```bash
     docker stop ds03-payment
     ```
  3. Quan sát:
     - Trên Dashboard: Đèn Payment chuyển sang đỏ (Mất kết nối).
     - Trên RabbitMQ Management: Message `payment.event.hold_requested` nằm an toàn trong `payment.queue` (Ready = 1). Không có dữ liệu nào bị mất nhờ tính chất `durable` và `persistent` của hàng đợi.
  4. Bật lại Payment Service:
     ```bash
     docker start ds03-payment
     ```
  5. Kết quả phục hồi:
     - Payment Service vừa khởi động lập tức kéo message từ queue về xử lý.
     - Outbox Worker phát sinh `payment.event.hold_success`.
     - Cuốc xe trên Dashboard tự động chuyển sang `CONFIRMED`.
* **Lời thoại trình bày:**
  > "Thưa Thầy Cô, khi Payment Service bị dừng đột ngột, toàn bộ các services khác không hề bị nghẽn (no cascading failure). Tin nhắn yêu cầu tạm giữ cước được lưu trữ bền vững trên đĩa cứng của RabbitMQ. Ngay khi chúng em phục hồi service, thông điệp lập tức được tiêu thụ và cuốc xe hoàn tất thành công. Điều này minh chứng tính tự phục hồi chuẩn mực theo đặc tả FR-01."

---

### PHÚT 8:45 – 9:45: DEMO 2 — SAGA BÙ TRỪ KHI LỖI THANH TOÁN (FR-02)
* **Kịch bản:**
  1. Trên Web Dashboard, chọn tài khoản **Khách 3 (Lê Văn C — Số dư ví = 0 đ)**.
  2. Bấm nút màu đỏ: **"💥 Saga Bù Trừ (FR-02)"**.
  3. Diễn biến thời gian thực trên màn hình Live Distributed Tracing:
     - **Bước 1:** Cuốc xe được tạo (`trip.event.created`).
     - **Bước 2:** Matching Service tìm thấy và khoá tài xế D1 (`status: BUSY`).
     - **Bước 3:** Payment Service kiểm tra số dư: Yêu cầu 45,000 đ nhưng số dư = 0 đ $\rightarrow$ Phát sự kiện `payment.event.hold_failed`.
     - **Bước 4 (Kích hoạt Bù trừ):** Trip Service tiếp nhận event lỗi $\rightarrow$ Chuyển trạng thái cuốc sang `CANCELLED` $\rightarrow$ Phát lệnh bù trừ `trip.event.release_driver`.
     - **Bước 5 (Giải phóng tài nguyên):** Driver Service mở khoá tài xế D1 từ `BUSY` trở lại `AVAILABLE`.
* **Lời thoại trình bày:**
  > "Tại đây, Thầy Cô có thể quan sát trực tiếp trên Console Tracing có chung mã `Correlation-ID`: Khách hàng không đủ tiền, hệ thống lập tức kích hoạt Compensating Action. Tài xế D1 được giải phóng trở lại trạng thái AVAILABLE ngay lập tức, cuốc xe bị huỷ an toàn và số dư ví khách không bị âm. Hệ thống bảo toàn tính nhất quán tuyệt đối giữa 3 database: `trip_db`, `payment_db` và `driver_db`."

---

### PHÚT 9:45 – 10:00: KẾT LUẬN & SẴN SÀNG TRẢ LỜI CÂU HỎI HỘI ĐỒNG
* **Lời thoại trình bày:**
  > "Tóm lại, thông qua kiến trúc hướng sự kiện, RabbitMQ topic topology, cơ chế Transactional Outbox, Bounded Retries và Dead-Letter Queue, nhóm chúng em đã giải quyết trọn vẹn các bài toán phân tán cốt lõi của đề tài DS03.
  > Em xin cảm ơn Thầy Cô đã lắng nghe và nhóm chúng em rất mong nhận được những câu hỏi đóng góp từ Hội đồng ạ!"
