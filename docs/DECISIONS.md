# ARCHITECTURE DECISION RECORDS (ADR) - DS03

## ADR-007: Bản tích hợp PostgreSQL và RabbitMQ

Trạng thái **triển khai trên nhánh tích hợp, chờ nhóm review**. Port 8001–8005 và RabbitMQ theo contract gốc. Giữ SQLite WAL của Identity và Trip để tích hợp mã TV1 và dữ liệu đã có. Mỗi service PostgreSQL có role và database riêng. Gateway là entry point công khai.

Driver thực hiện reserve/confirm/release vì hàng tài xế thuộc Driver. Matching giữ trạng thái công việc và event, giao tiếp với Driver qua REST. Trip giữ quyền xác thực accept và điều phối Payment theo `hold_requested` hiện có của TV1. Chuyến dùng `trip_id` ổn định để retry reservation. Expiry chỉ thu hồi HELD. Chuyển trạng thái và phát event theo mô hình at-least-once với inbox, outbox và khóa nghiệp vụ tương ứng.

Tạm giữ bằng reservation có thời hạn 30 giây mặc định. GPS và bán kính là cấu hình demo. Provision hồ sơ Driver được thực hiện bởi operator vì contract đăng ký Identity hiện thiếu thông tin xe.

## ADR-008: Giữ quyền sở hữu SQLite của TV1 trong bản demo

Trạng thái **đề xuất cho nhóm review**. Giữ Identity và Trip trên SQLite WAL riêng, mỗi service một replica ghi. Đặc tả DS03 yêu cầu dữ liệu tách riêng theo service. Quyết định chuyển PostgreSQL phụ thuộc nhu cầu scale ghi, HA và kế hoạch migration/rollback. [Đánh giá triển khai](PRODUCTION_READINESS.md#quyền-sở-hữu-và-sqlite)

Tài liệu này ghi lại các quyết định thiết kế kiến trúc quan trọng, lý do lựa chọn và người phê duyệt theo chuẩn quản trị dự án.

---

## ADR-001: Lựa Chọn Phân Chia 5 Microservices Nghiệp Vụ
* **Trạng thái:** ĐÃ PHÊ DUYỆT (APPROVED).
* **Bối cảnh:** Đề tài DS03 yêu cầu tối thiểu 4 business microservices độc lập (không tính API Gateway).
* **Quyết định:** Chọn 5 Business Services: `Identity Service`, `Driver/Location Service`, `Trip/Booking Service`, `Matching Service`, `Simulated Payment Service`.
* **Lý do:**
  1. `Payment Service` cho phép triển khai trọn vẹn luồng **Giao dịch phân tán (Saga Pattern)** có thao tác bù trừ (Compensating Actions) khi xảy ra lỗi (Hold $\rightarrow$ Capture / Refund).
  2. `Matching Service` tách riêng với `Trip Service` để đóng gói logic tìm kiếm thuật toán và kiểm soát tranh chấp đồng thời (Concurrency Control).

---

## ADR-002: Lựa Chọn Nền Tảng Node.js / TypeScript
* **Trạng thái:** ĐÃ PHÊ DUYỆT (APPROVED).
* **Bối cảnh:** Cần chọn ngôn ngữ phát triển microservices nhẹ, có hệ sinh thái thư viện mạnh cho Message Queue, HTTP, SSE và TypeScript typesafety.
* **Quyết định:** Sử dụng Node.js v20+ với TypeScript.
* **Lý do:**
  1. Hỗ trợ I/O bất đồng bộ tự nhiên (Event Loop), cực kỳ phù hợp cho dịch vụ stream dữ liệu toạ độ GPS và lắng nghe event từ RabbitMQ.
  2. Hỗ trợ Server-Sent Events (SSE) và WebSocket đơn giản, giúp xây dựng Web Simulation Dashboard mượt mà.
  3. Quản lý kiểu dữ liệu chặt chẽ qua TypeScript DTOs, dùng chung interface giữa các services.

---

## ADR-003: Sử Dụng PostgreSQL Thuần & Row-Level Lock (`FOR UPDATE SKIP LOCKED`)
* **Trạng thái:** ĐÃ PHÊ DUYỆT (APPROVED).
* **Bối cảnh:** Cần giải quyết bài toán Concurrency khi 2 khách hàng cùng đặt 1 tài xế tại cùng thời điểm, đồng thời lưu trữ toạ độ và tìm tài xế gần nhất.
* **Quyết định:** Mỗi service sở hữu 1 PostgreSQL Database độc lập. Dùng tính năng `SELECT ... FOR UPDATE SKIP LOCKED` của PostgreSQL để thực hiện Distributed Concurrency Control thay vì phải cài thêm Redis.
* **Lý do:**
  1. Giảm thiểu số lượng dịch vụ hạ tầng phải bảo trì trong Docker Compose (chỉ cần PostgreSQL + RabbitMQ).
  2. PostgreSQL hỗ trợ ACID transaction tuyệt đối, không có rủi ro mất lock do timeout bất thường như Redis Redlock.
  3. `SKIP LOCKED` là giải pháp chuẩn công nghiệp (được PostgreSQL hỗ trợ từ bản 9.5) chuyên dùng cho bài toán tranh chấp hàng đợi và gán tài nguyên độc quyền.

---

## ADR-004: Lựa Chọn RabbitMQ Làm Message Broker & Xử Lý DLQ
* **Trạng thái:** ĐÃ PHÊ DUYỆT (APPROVED).
* **Bối cảnh:** Cần một Message Broker hỗ trợ luồng bất đồng bộ, có tính năng Dead-Letter Queue (DLQ), retry, và đảm bảo thứ tự/bền bỉ.
* **Quyết định:** Sử dụng RabbitMQ với giao thức AMQP 0-9-1.
* **Lý do:**
  1. RabbitMQ hỗ trợ native Dead-Letter Exchanges (`x-dead-letter-exchange`), giúp việc định tuyến các message lỗi về `trip.dlq` diễn ra tự động và minh bạch.
  2. Cơ chế Acknowledgement (`basicAck`, `basicNack`, `requeue`) chuẩn xác, dễ kiểm soát độ tin cậy trong các kịch bản crash service.
  3. Giao diện RabbitMQ Management trực quan (port 15672) giúp quan sát trực tiếp số lượng message trong queue khi chấm điểm bài tập lớn.

---

## ADR-005: Áp Dụng Transactional Outbox Pattern
* **Trạng thái:** ĐÃ PHÊ DUYỆT (APPROVED).
* **Bối cảnh:** Tránh hiện tượng "Dual-Write Inconsistency" (Dữ liệu đã lưu vào database của Trip Service nhưng mạng chập chờn khiến message không bắn được sang RabbitMQ, dẫn đến cuốc xe bị treo vĩnh viễn).
* **Quyết định:** Triển khai Transactional Outbox Pattern với bảng `outbox_events` trong `trip_db`.
* **Lý do:**
  1. Ghi nhận sự kiện ngay trong transaction tạo cuốc xe.
  2. Một tiến trình nền định kỳ quét các event `PENDING`, gửi sang RabbitMQ và chờ `Publisher Confirms` trước khi đánh dấu `PUBLISHED`.
  3. Đạt điểm tối đa cho phần Advanced Features (Mục 7.5 trong đề tài).

---

## ADR-006: Web Simulation Dashboard Tích Hợp Live Tracing Logs
* **Trạng thái:** ĐÃ PHÊ DUYỆT (APPROVED).
* **Bối cảnh:** Trong buổi bảo vệ (7–10 phút), việc dùng curl/Postman và mở 5 cửa sổ terminal docker xem log rất dễ gây rối mắt và khó thuyết phục hội đồng.
* **Quyết định:** Xây dựng một trang Web Dashboard đơn giản chạy tại port 3000 gồm: Bản đồ xe chạy (Leaflet), 2 nút bấm đặt xe đồng thời để chứng minh Concurrency, và cửa sổ Live Stream Logs phân tán.
* **Lý do:** Giúp hội đồng nhìn thấy ngay kết quả hoạt động phân tán thời gian thực chỉ trong 1 màn hình duy nhất.
