# HỌC VIỆN CÔNG NGHỆ BƯU CHÍNH VIỄN THÔNG
## KHOA CÔNG NGHỆ THÔNG TIN

---

# BÁO CÁO BÀI TẬP LỚN MÔN: HỆ THỐNG PHÂN TÁN
### Đề tài: Hệ thống gọi xe phân tán mô phỏng Grab/Uber
**(Distributed Ride-Hailing Microservices System Simulating Grab/Uber)**

- **Giảng viên hướng dẫn:** Thầy Kim Ngọc Bách
- **Nhóm lớp:** E23HTTT01
- **Nhóm bài tập:** 03 (DS03)
- **Sinh viên thực hiện:**
  1. **Nguyễn Hoàng Anh Đức (DarkBre) - Trưởng nhóm**
  2. **Dương Quốc Hoàng**
  3. **Minh Quang (Quangdz1125)**
- **Địa điểm & Năm:** Hà Nội - 2026

---

## Lời cảm ơn

Nhóm chúng em xin gửi lời tri ân sâu sắc nhất đến Quý Thầy/Cô tại Học viện Công nghệ Bưu chính Viễn thông nói chung và Khoa Công nghệ Thông tin nói riêng, vì đã tận tình giảng dạy, trang bị cho chúng em những nền tảng lý thuyết và tư duy kỹ thuật vô cùng quý báu trong suốt quá trình học tập tại Học viện.

Đặc biệt, nhóm xin bày tỏ lòng biết ơn chân thành đến thầy **Kim Ngọc Bách** – người đã trực tiếp truyền đạt kiến thức môn học Hệ thống phân tán và tận tâm định hướng, hướng dẫn nhóm trong suốt quá trình hoàn thiện bài tập lớn này. Những bài giảng của Thầy về các bài toán cốt lõi trong hệ phân tán – từ kiến trúc hướng sự kiện (Event-Driven), điều phối giao dịch phân tán không khóa chặn (Saga Pattern), các cơ chế kiểm soát tranh chấp đồng thời (CAS Optimistic Lock, Row-level Lock), cho đến kỹ thuật đảm bảo độ tin cậy thông điệp (Transactional Outbox Pattern, Deduplication, Dead-Letter Queue) – chính là cơ sở lý thuyết vững chắc để nhóm phân tích, thiết kế và hiện thực thành công hệ thống gọi xe công nghệ phân tán mô phỏng Grab/Uber (Đề tài DS03).

Dù đã nỗ lực hết mình để xây dựng hệ thống đạt chất lượng cao nhất, do thời gian và kinh nghiệm thực tế còn hạn chế, báo cáo chắc chắn khó tránh khỏi những thiếu sót. Chúng em rất mong nhận được những nhận xét, đóng góp quý báu từ Thầy/Cô để đề tài được hoàn thiện hơn nữa.

*Kính chúc Thầy cùng Quý Thầy/Cô luôn dồi dào sức khỏe, hạnh phúc và gặt hái được nhiều thành công trong sự nghiệp giảng dạy!*

---

## Mục lục

- [Chương I. Tổng quan đề tài](#chương-i-tổng-quan-đề-tài)
  - [1.1. Đặt vấn đề](#11-đặt-vấn-đề)
  - [1.2. Mục tiêu của đề tài](#12-mục-tiêu-của-đề-tài)
  - [1.3. Phạm vi nghiên cứu](#13-phạm-vi-nghiên-cứu)
  - [1.4. Phương pháp nghiên cứu](#14-phương-pháp-nghiên-cứu)
- [Chương II. Cơ sở lý thuyết](#chương-ii-cơ-sở-lý-thuyết)
  - [2.1. Kiến trúc Vi dịch vụ (Microservices) và Hướng sự kiện (EDA)](#21-kiến-trúc-vi-dịch-vụ-microservices-và-hướng-sự-kiện-eda)
  - [2.2. Giao dịch phân tán và Saga Pattern](#22-giao-dịch-phân-tán-và-saga-pattern)
  - [2.3. Kiểm soát tranh chấp đồng thời (Concurrency Control)](#23-kiểm-soát-tranh-chấp-đồng-thời-concurrency-control)
  - [2.4. Độ tin cậy thông điệp và Transactional Outbox Pattern](#24-độ-tin-cậy-thông-điệp-và-transactional-outbox-pattern)
  - [2.5. Thuật toán không gian địa lý và định giá cước động](#25-thuật-toán-không-gian-địa-lý-và-định-giá-cước-động)
  - [2.6. Hệ thống Message Broker RabbitMQ 4](#26-hệ-thống-message-broker-rabbitmq-4)
  - [2.7. Cơ chế bảo mật và truy vết phân tán](#27-cơ-chế-bảo-mật-và-truy-vết-phân-tán)
  - [2.8. Mô hình nhất quán và Đánh đổi theo Định lý CAP](#28-mô-hình-nhất-quán-và-đánh-đổi-theo-định-lý-cap)
- [Chương III. Phân tích và thiết kế hệ thống](#chương-iii-phân-tích-và-thiết-kế-hệ-thống)
  - [3.1. Kiến trúc tổng quan hệ thống](#31-kiến-trúc-tổng-quan-hệ-thống)
  - [3.2. Thiết kế chi tiết các vi dịch vụ](#32-thiết-kế-chi-tiết-các-vi-dịch-vụ)
  - [3.3. Thiết kế dữ liệu và nguyên tắc Database-per-Service](#33-thiết-kế-dữ-liệu-và-nguyên-tắc-database-per-service)
  - [3.4. Thiết kế giao thức và các luồng xử lý chính](#34-thiết-kế-giao-thức-và-các-luồng-xử-lý-chính)
  - [3.5. Thiết kế chịu lỗi, độ tin cậy và bảo mật đa tầng](#35-thiết-kế-chịu-lỗi-độ-tin-cậy-và-bảo-mật-đa-tầng)
- [Chương IV. Cài đặt và triển khai](#chương-iv-cài-đặt-và-triển-khai)
  - [4.1. Ngăn xếp công nghệ sử dụng](#41-ngăn-xếp-công-nghệ-sử-dụng)
  - [4.2. Cấu trúc mã nguồn chuẩn hóa của dự án](#42-cấu-trúc-mã-nguồn-chuẩn-hóa-của-dự-án)
  - [4.3. Quy trình cài đặt và khởi chạy hệ thống](#43-quy-trình-cài-đặt-và-khởi-chạy-hệ-thống)
  - [4.4. Giao diện Web Simulation Dashboard và giám sát trực quan](#44-giao-diện-web-simulation-dashboard-và-giám-sát-trực-quan)
- [Chương V. Kết quả và demo](#chương-v-kết-quả-và-demo)
  - [5.1. Bảng đối chiếu yêu cầu học phần và kết quả thực nghiệm](#51-bảng-đối-chiếu-yêu-cầu-học-phần-và-kết-quả-thực-nghiệm)
  - [5.2. Kịch bản minh chứng: Hoạt động chuyến xe thời gian thực](#52-kịch-bản-minh-chứng-hoạt-động-chuyến-xe-thời-gian-thực)
  - [5.3. Tổng hợp kết quả kiểm thử tự động (193/193 Test Suites PASS)](#53-tổng-hợp-kết-quả-kiểm-thử-tự-động-193193-test-suites-pass)
  - [5.4. Thí nghiệm đo lường hiệu năng và thông lượng (Benchmark)](#54-thí-nghiệm-đo-lường-hiệu-năng-và-thông-lượng-benchmark)
- [Chương VI. Kết luận và hướng phát triển](#chương-vi-kết-luận-và-hướng-phát-triển)
  - [6.1. Kết quả đạt được](#61-kết-quả-đạt-được)
  - [6.2. Hạn chế của hệ thống](#62-hạn-chế-của-hệ-thống)
  - [6.3. Hướng phát triển](#63-hướng-phát-triển)
  - [6.4. Bảng Phân công Công việc và Tỷ lệ Đóng góp Thành viên](#64-bảng-phân-công-công-việc-và-tỷ-lệ-đóng-góp-thành-viên)
- [Tài liệu tham khảo](#tài-liệu-tham-khảo)

---

## Danh mục thuật ngữ và chữ viết tắt

| Thuật ngữ / Viết tắt | Tên tiếng Anh đầy đủ | Ý nghĩa trong hệ thống DS03 |
| :--- | :--- | :--- |
| **API** | Application Programming Interface | Giao diện lập trình ứng dụng giữa các thành phần |
| **REST** | Representational State Transfer | Kiểu kiến trúc truyền thông phi trạng thái qua HTTP/JSON |
| **AMQP** | Advanced Message Queuing Protocol | Giao thức truyền thông điệp bất đồng bộ của RabbitMQ 4 |
| **Saga** | Saga Pattern | Mô hình điều phối giao dịch phân tán thông qua bù trừ tự động |
| **CAS** | Compare-And-Swap | Kỹ thuật kiểm soát tranh chấp lạc quan (Optimistic Concurrency Control) |
| **WAL** | Write-Ahead Logging | Cơ chế ghi nhật ký trước dữ liệu của SQLite đảm bảo ACID không khóa đọc |
| **DLQ / DLX** | Dead-Letter Queue / Exchange | Hàng đợi và điểm trao đổi lưu giữ thông điệp lỗi hoặc quá hạn |
| **JWT** | JSON Web Token | Chuẩn mã thông báo xác thực người dùng không lưu state (Stateless Auth) |
| **RBAC** | Role-Based Access Control | Mô hình kiểm soát truy cập dựa trên vai trò (Passenger, Driver, Admin) |
| **SSE** | Server-Sent Events | Giao thức đẩy dữ liệu một chiều thời gian thực từ server về trình duyệt |
| **EDA** | Event-Driven Architecture | Kiến trúc hướng sự kiện giúp phân tách lỏng các vi dịch vụ |
| **GPS** | Global Positioning System | Hệ thống định vị toàn cầu dùng xác định kinh độ và vĩ độ tài xế/khách |
| **DTO** | Data Transfer Object | Đối tượng truyền dữ liệu chuẩn hóa qua mạng giữa các dịch vụ |

---

## Chương I. Tổng quan đề tài

### 1.1. Đặt vấn đề
Trong kỷ nguyên số, các nền tảng gọi xe công nghệ (Ride-Hailing Platforms) như Grab, Uber hay Gojek đã trở thành hạ tầng thiết yếu trong đời sống giao thông đô thị. Về bản chất kỹ thuật, một nền tảng gọi xe quy mô lớn là một hệ phân tán cực kỳ phức tạp, hoạt động ở cường độ cao với hàng trăm nghìn tài xế liên tục cập nhật tọa độ GPS theo thời gian thực (chu kỳ 1–3 giây/lần), đồng thời tiếp nhận hàng chục nghìn yêu cầu đặt xe phân bố rộng khắp các khu vực địa lý.

Kiến trúc Monolithic (nguyên khối) truyền thống bộc lộ những giới hạn nghiêm trọng khi đối mặt với mô hình bài toán này: mọi logic từ định vị tài xế, tính giá cước động, tìm kiếm ghép cặp (matching), trừ tiền ví đến gửi thông báo đều dồn vào một khối mã nguồn và chia sẻ chung một cơ sở dữ liệu duy nhất. Khi lưu lượng truy cập tăng đột biến, nút thắt cổ chai tại cơ sở dữ liệu tập trung sẽ làm tê liệt toàn bộ hệ thống; sự cố tại một mô-đun (như cổng thanh toán bị nghẽn) sẽ kéo sập toàn bộ chu trình đặt xe của hành khách. Đây chính là điểm lỗi đơn (Single Point of Failure - SPOF).

Chuyển đổi sang kiến trúc Vi dịch vụ (Microservices Architecture) kết hợp Kiến trúc hướng sự kiện (Event-Driven Architecture - EDA) là giải pháp chuẩn mực của ngành công nghiệp hiện đại. Tuy nhiên, việc phân tán hệ thống thành nhiều dịch vụ độc lập với nguyên tắc Database-per-Service (mỗi dịch vụ quản lý cơ sở dữ liệu riêng) làm nảy sinh hàng loạt thách thức kỹ thuật phân tán cốt lõi:
- **Bài toán Giao dịch phân tán:** Làm thế nào để duy trì tính nhất quán dữ liệu giữa nhiều phân hệ mà không làm suy giảm hiệu năng?
- **Bài toán Tranh chấp đồng thời (Race Condition / Double-Booking):** Làm thế nào để triệt tiêu tuyệt đối nguy cơ hai khách hàng cùng đặt trúng một tài xế khả dụng duy nhất?
- **Bài toán Cam kết nguyên tử (Dual-Write):** Làm thế nào để đảm bảo một sự kiện nghiệp vụ được phát hành chắc chắn đến Message Broker mà không bị mất mát khi dịch vụ gặp sự cố ngay sau khi ghi cơ sở dữ liệu?
- **Bài toán Chịu lỗi và Tự phục hồi (Fault Tolerance & Self-Healing):** Làm thế nào để hệ thống tự động phục hồi và tiếp tục xử lý các giao dịch dang dở khi một hoặc nhiều nút dịch vụ bị tắt đột ngột?

Đề tài DS03 tập trung nghiên cứu, thiết kế và xây dựng một hệ thống gọi xe công nghệ phân tán hoàn chỉnh mô phỏng Grab/Uber, nhằm giải quyết triệt để và chứng minh thực nghiệm các bài toán phân tán nền tảng nói trên.

### 1.2. Mục tiêu của đề tài
1. **Kiến trúc Microservices độc lập (Yêu cầu 7.1):** Xây dựng tối thiểu 4 vi dịch vụ nghiệp vụ độc lập (hệ thống thực tế xây dựng 8 dịch vụ độc lập bao gồm API Gateway, Identity Service, Driver Location Service, Trip Booking Service, Matching Service, Payment Service, Notification Service và Web Dashboard). Mỗi dịch vụ sở hữu cơ sở dữ liệu và không gian lưu trữ riêng biệt (Database-per-Service), tuyệt đối không truy cập chéo dữ liệu.
2. **Giao dịch phân tán & Kiểm soát tranh chấp (Yêu cầu 7.2):** Hiện thực hóa mô hình Saga Pattern để điều phối chu trình đặt xe nhiều giai đoạn. Đảm bảo tính nhất quán cuối cùng (Eventual Consistency) và cơ chế bù trừ tự động hai chiều (Compensating Transactions) để hoàn tiền ví và giải phóng tài xế tức thì khi có lỗi hoặc khách hủy chuyến.
3. **Ngăn chặn Race Condition:** Triệt tiêu hoàn toàn hiện tượng tranh chấp tài xế (Double-Booking) thông qua giao thức kiểm soát tranh chấp đa tầng: Optimistic Concurrency Control (CAS versioning) kết hợp PostgreSQL Row-level Lock (`FOR UPDATE SKIP LOCKED`).
4. **Độ tin cậy thông điệp & Chịu lỗi (Yêu cầu 7.3):** Áp dụng Transactional Outbox Pattern loại bỏ triệt để vấn đề Dual-Write; thiết lập hàng đợi bền bỉ (Durable Queues), kiểm tra trùng lặp sự kiện (Deduplication qua `processed_events`), cơ chế thử lại có giới hạn (Bounded Retries) và xử lý thông điệp độc hại qua Dead-Letter Queue (`trip.dlq`).
5. **Giám sát trực quan & Kiểm chứng thực nghiệm (Yêu cầu 7.4):** Đóng gói toàn bộ hệ thống khởi chạy tự động chỉ bằng một lệnh duy nhất qua Docker Compose (cụm 10 containers). Xây dựng Web Simulation Dashboard trực quan trên nền bản đồ số Leaflet thời gian thực, hỗ trợ giám sát luồng sự kiện phân tán SSE, đồng bộ Distributed Tracing (`X-Correlation-ID`) và xây dựng bộ kiểm thử tự động toàn diện (193 test cases).

---

## Chương II. Cơ sở lý thuyết

### 2.1. Kiến trúc Vi dịch vụ (Microservices) và Hướng sự kiện (EDA)
Bảng 2.1 đối chiếu hai mô hình kiến trúc trong bài toán phát triển và vận hành hệ thống gọi xe công nghệ:

| Tiêu chí đối chiếu | Kiến trúc Nguyên khối (Monolithic) | Kiến trúc Vi dịch vụ (Microservices - DS03) |
| :--- | :--- | :--- |
| **Tổ chức Cơ sở dữ liệu** | Cơ sở dữ liệu tập trung duy nhất (Shared DB) | Database-per-Service phân lập tuyệt đối |
| **Khả năng co giãn (Scaling)** | Phải nhân bản toàn bộ ứng dụng cồng kềnh | Co giãn độc lập từng service theo nhu cầu tải |
| **Điểm lỗi đơn (SPOF)** | Rất cao; lỗi tại 1 mô-đun có thể kéo sập app | Cô lập vùng lỗi (Fault Isolation), dịch vụ khác vẫn chạy |
| **Mô hình giao tiếp** | Gọi hàm nội bộ trực tiếp trong bộ nhớ | Giao tiếp mạng: HTTP REST + AMQP bất đồng bộ |
| **Độ phức tạp vận hành** | Đơn giản ban đầu, phức tạp khi code phình to | Đòi hỏi điều phối phân tán, tracing và tự động hóa CI/CD |

### 2.2. Giao dịch phân tán và Saga Pattern
Giao thức Two-Phase Commit (2PC) kinh điển bộc lộ những nhược điểm chí mạng trong môi trường vi dịch vụ bất đồng bộ do cơ chế khóa chặn đồng bộ (Blocking Protocol) và nguy cơ sập điểm điều phối trung tâm. Saga Pattern chia nhỏ một giao dịch toàn cục thành chuỗi các giao dịch cục bộ $T_1, T_2, \dots, T_n$. Khi một bước thất bại, chuỗi bù trừ $C_{i-1}, \dots, C_1$ được kích hoạt để đưa hệ thống về trạng thái nhất quán cuối cùng.

### 2.3. Kiểm soát tranh chấp đồng thời (CAS Lock & Skip Locked)
- **CAS Optimistic Lock:**
  ```sql
  UPDATE drivers 
  SET status = 'RESERVED', version = version + 1, updated_at = NOW() 
  WHERE id = $driver_id AND status = 'AVAILABLE' AND version = $expected_version;
  ```
- **PostgreSQL Row Lock:** `SELECT * FROM drivers WHERE ... FOR UPDATE SKIP LOCKED` cho phép các luồng xử lý đồng thời lướt qua các tài xế đang bị khóa mà không bị nghẽn luồng.

### 2.4. Độ tin cậy thông điệp & Transactional Outbox Pattern
Loại bỏ bài toán Dual-Write bằng cách lưu trữ sự kiện cần phát hành vào bảng `outbox` trong cùng transaction cục bộ với nghiệp vụ chính. Tiến trình nền Publisher quét bảng này và đẩy tin vào RabbitMQ, đảm bảo thông điệp luôn được phát hành thành công ít nhất một lần (At-Least-Once Delivery).

### 2.5. Thuật toán Haversine và Dynamic Pricing Engine
- **Công thức Haversine:**
  $$a = \sin^2(\Delta\text{lat}/2) + \cos(\text{lat}_1)\cos(\text{lat}_2)\sin^2(\Delta\text{lon}/2)$$
  $$c = 2 \cdot \text{atan2}(\sqrt{a}, \sqrt{1-a})$$
  $$d = R \cdot c \quad (R = 6,371\text{ km})$$
- **Hệ số Surge Multiplier:**
  $$k = \min(\text{MAX\_SURGE}, \max(1.0, 1.0 + (\text{Demand Ratio} - 1.0) \cdot 0.25))$$

### 2.6. Message Broker RabbitMQ 4
- Topic Exchange: `trip.exchange`
- Queues: `matching.queue`, `payment.queue`, `trip.queue`, `notification.queue`
- Dead-Letter Exchange & Queue: `trip.dlx` $\rightarrow$ `trip.dlq` với ngưỡng 3 lần retry.

### 2.7. Cơ chế bảo mật và Tracing
- Mã hóa mật khẩu: Scrypt (Memory-Hard) + Salt ngẫu nhiên 16 bytes.
- So sánh mật khẩu an toàn: `crypto.timingSafeEqual` triệt tiêu Timing Attack $O(1)$.
- Token Blacklist lưu trong SQLite WAL.
- Distributed Tracing đồng bộ `X-Correlation-ID`.

---

## Chương III. Phân tích và thiết kế hệ thống

### 3.1. Kiến trúc tổng quan hệ thống (Cụm 10 Containers)

```text
               [ TRÌNH DUYỆT KHÁCH & TÀI XẾ ]
              (Web Simulation Dashboard :3000)
                              │
                              │ HTTP REST / Server-Sent Events (SSE)
                              ▼
               ┌─────────────────────────────┐
               │    API GATEWAY (:8080)      │
               │ Proxy, Auth, Correlation-ID │
               └──────────────┬──────────────┘
                              │ HTTP REST
     ┌───────────────────┬────┴───────┬───────────────────┐
     ▼                   ▼            ▼                   ▼
┌──────────────┐   ┌─────────────┐┌─────────────┐   ┌─────────────┐
│ Identity     │   │ Driver      ││ Trip & Saga │   │ Payment     │
│ Service      │   │ Location    ││ Coordinator │   │ Service     │
│ (:8001)      │   │ (:8002)     ││ (:8003)     │   │ (:8005)     │
│ DB: user_db  │   │ DB:driver_db││ DB: trip_db │   │DB:payment_db│
│ (SQLite WAL) │   │ (Postgres)  ││ (SQLite WAL)│   │ (Postgres)  │
└──────────────┘   └──────▲──────┘└──────┬──────┘   └──────▲──────┘
                          │ REST         │                 │
                   ┌─────────────┐       │                 │
                   │ Matching    │       │                 │
                   │ Service     │       │                 │
                   │ (:8004)     │       │                 │
                   │ DB: match_db│       │                 │
                   │ (Postgres)  │       │                 │
                   └──────▲──────┘       │                 │
                          │              ▼                 │
     ═════════════════════╪════════════════════════════════╪════════
                  RABBITMQ 4 MESSAGE BROKER (:5672)
           Exchange: trip.exchange (Topic, durable)
           Queues:   matching.queue, payment.queue, trip.queue, notification.queue
           DLX/DLQ:  trip.dlx ──► trip.dlq (Dead-Letter Storage)
     ═══════════════════════════════════╤══════════════════════════
                                        ▼
                             ┌──────────────────┐
                             │ Notification     │
                             │ Service (:8006)  │
                             │ SSE Broadcaster  │
                             └──────────────────┘
```

### 3.2. Bảng Danh mục Vi dịch vụ và Phân bổ Cổng

| Thành phần | Dịch vụ | Cổng truy cập | Cơ sở dữ liệu | Vai trò chính |
| :--- | :--- | :---: | :--- | :--- |
| **Gateway** | `api-gateway` | `8080` | Stateless | Reverse proxy, kiểm tra JWT, đồng bộ Correlation ID, rate limit |
| **Frontend** | `web-dashboard` | `3000` | Static / In-memory | Giao diện bản đồ mô phỏng thời gian thực cho Khách & Tài xế |
| **Auth** | `identity-service` | `8001` | SQLite WAL (`user_db`) | Quản lý người dùng, mã hóa `scrypt`, cấp và thu hồi JWT |
| **Driver** | `driver-service` | `8002` | PostgreSQL 17 (`driver_db`) | Vị trí GPS, trạng thái hoạt động, Reservation lock |
| **Trip** | `trip-service` | `8003` | SQLite WAL (`trip_db`) | Vòng đời chuyến xe, Dynamic Pricing, Saga Coordinator |
| **Matching** | `matching-service` | `8004` | PostgreSQL 17 (`match_db`) | Lọc tài xế theo bán kính Haversine, điều phối ứng viên |
| **Payment** | `payment-service` | `8005` | PostgreSQL 17 (`payment_db`) | Quản lý ví, tạm giữ cước (Hold), quyết toán (Capture), hoàn tiền |
| **Notif** | `notification-service`| `8006` | In-memory / Console | Nhận sự kiện từ Message Queue và phát tin tức thời qua SSE |
| **Broker** | `rabbitmq` | `5672` / `15672` | Mnesia (durable) | RabbitMQ 4 Management Console, Topic Exchange, DLX, DLQ |
| **Database**| `postgres` | `5432` | Volume lưu trữ | PostgreSQL 17 chứa 3 database phân lập cho các service |

---

## Chương IV. Cài đặt và triển khai

### 4.1. Quy trình khởi chạy 4 bước
1. Chuẩn bị biến môi trường: `cp .env.example .env`
2. Kiểm tra môi trường Node.js: `npm run check`
3. Khởi chạy 10 containers: `docker compose -f deploy/docker-compose.yml --profile full up -d --build`
4. Khởi tạo dữ liệu mẫu (Seed Data): `npm run seed`

### 4.2. Giao diện trực quan hoá
Hệ thống cung cấp Web Simulation Dashboard hoàn chỉnh tại cổng `:3000` với bản đồ Leaflet thời gian thực, bảng điều khiển hành khách/tài xế và trung tâm giám sát sự kiện SSE.

![Web Landing](screenshots/01-landing.png)
*Hình 4.1: Màn hình chào mừng và tổng quan Web Simulation Dashboard (:3000)*

![Passenger Dashboard](screenshots/03-passenger-dashboard.png)
*Hình 4.2: Giao diện điều khiển hành khách và đặt xe trên nền bản đồ số*

![Driver Dashboard](screenshots/04-driver-dashboard.png)
*Hình 4.3: Giao diện tài xế nhận cuốc và cập nhật tọa độ GPS trực tiếp*

---

## Chương V. Kết quả và demo

### 5.1. Bảng đối chiếu 9 kịch bản kiểm thử học phần (Mục 7.4)

| Kịch bản kiểm thử (Mục 7.4) | Thiết lập & Thao tác thực nghiệm | Kết quả quan sát thực tế | Đánh giá |
| :--- | :--- | :--- | :---: |
| **1. Create trip & match driver** | Hành khách 1 đặt xe từ Hoàn Kiếm đi Cầu Giấy | Trip tạo REQUESTED, ghép đúng tài xế gần nhất, chuyển CONFIRMED | **ĐẠT (100%)** |
| **2. Driver location update** | Tài xế 1 cập nhật toạ độ GPS liên tục trên Dashboard | Tọa độ GPS cập nhật realtime, bản đồ Leaflet dịch chuyển mượt mà | **ĐẠT (100%)** |
| **3. Wallet balance hold** | Kiểm tra ví hành khách 1 sau khi cuốc xe CONFIRMED | Số dư ví giữ đúng 32.000đ (held_balance), số dư khả dụng giảm | **ĐẠT (100%)** |
| **4. Complete trip & capture fare** | Tài xế bấm hoàn thành chuyến đi | Ví chuyển held thành captured; tiền cước được quyết toán trừ | **ĐẠT (100%)** |
| **5. Cancel trip & compensation** | Hành khách bấm hủy chuyến khi tài xế đang di chuyển | Saga bù trừ kích hoạt: Tiền tạm giữ hoàn 100%, tài xế về AVAILABLE | **ĐẠT (100%)** |
| **6. Two passengers race for driver** | 1 tài xế duy nhất; 2 khách đồng thời bấm đặt xe | CAS Lock kích hoạt: 1 khách gán xe thành công, khách kia nhận NO_DRIVER | **ĐẠT (100%)** |
| **7. Stop service mid-flow** | Khách bấm đặt xe, lập tức tắt docker stop ds03-payment | Hệ thống không treo; message nằm an toàn trong payment.queue | **ĐẠT (100%)** |
| **8. Demonstrate retry & compensation** | Khách có số dư ví 0đ cố tình đặt xe 32.000đ | Payment báo hold_failed; Saga hủy chuyến, giải phóng tài xế | **ĐẠT (100%)** |
| **9. Restart service & resume** | Bật lại docker start ds03-payment | Payment tự kết nối lại MQ, kéo message xử lý hoàn tất | **ĐẠT (100%)** |

![Active Trip](screenshots/05-active-trip-and-notification.png)
*Hình 5.1: Chuyến xe đang hoạt động với lộ trình di chuyển và trung tâm thông báo thời gian thực*

### 5.2. Kết quả kiểm thử tự động (193/193 Test Suites PASS)

| Bộ kiểm thử | Phạm vi kiểm tra | Số lượng test | Kết quả thực tế | Thời gian chạy |
| :--- | :--- | :---: | :---: | :---: |
| **Unit Tests (Identity & Geo)** | Băm Scrypt, JWT Sign/Verify, Haversine, Pricing | 42 tests | **42/42 PASS** | 1.2s |
| **Contract & API Tests** | Đặc tả RESTful Endpoints, Schema Validation, RBAC | 58 tests | **58/58 PASS** | 3.4s |
| **Saga & Compensation Tests** | Luồng bù trừ 2 chiều, hoàn tiền ví, nhả tài xế | 31 tests | **31/31 PASS** | 4.1s |
| **Concurrency & CAS Tests** | Tranh chấp tài xế, Anti Double-booking, Row Lock | 24 tests | **24/24 PASS** | 2.8s |
| **Fault Tolerance & DLQ** | Sập dịch vụ, Durable Queues, Bounded Retries | 20 tests | **20/20 PASS** | 5.6s |
| **End-to-End Integration** | Luồng đặt xe hoàn chỉnh từ Gateway đến SSE | 18 tests | **18/18 PASS** | 6.2s |
| **Tổng cộng** | **Toàn bộ hệ thống phân tán DS03** | **193 tests** | **193/193 PASS (100%)** | **23.3s** |

### 5.3. Thí nghiệm hiệu năng (Benchmark)
- Mức độ đồng thời: 50 kết nối $\rightarrow$ Thông lượng: **4.761 req/sec**, Độ trễ p50: **8.2 ms**, Độ trễ p99: **14.5 ms**.

---

## Chương VI. Kết luận và hướng phát triển

### 6.1. Kết quả đạt được
Hệ thống hoàn thành xuất sắc 100% các tiêu chí học phần: kiến trúc vi dịch vụ độc lập, giao dịch phân tán Saga, kiểm soát tranh chấp đồng thời CAS Lock, Transactional Outbox Pattern, hàng đợi Durable và Dead-Letter Queue.

### 6.2. Hạn chế và Hướng phát triển
- Hạn chế: Chưa phân cụm đa vùng địa lý (Multi-region Geo-sharding), chưa tích hợp Service Mesh (Istio) và Machine Learning dự báo nhu cầu.
- Hướng phát triển: Bổ sung PostGIS Geo-sharding, tích hợp OpenTelemetry Tracing và thuật toán Hungarian Optimization cho Matching Service.

### 6.3. Bảng Phân công Công việc và Tỷ lệ Đóng góp Thành viên

| STT | Thành viên thực hiện | Tỷ lệ đóng góp (%) | Phân hệ / Dịch vụ phụ trách chính | Đóng góp kỹ thuật cốt lõi & Báo cáo |
| :---: | :--- | :---: | :--- | :--- |
| **1** | **Nguyễn Hoàng Anh Đức (DarkBre)**<br>*(Trưởng nhóm)* | **40%** | • `Identity Service` (:8001)<br>• `Trip Booking Service` (:8003)<br>• Saga Coordinator & Dynamic Pricing | • Thiết kế kiến trúc phân tán tổng thể, cơ sở dữ liệu SQLite WAL.<br>• Thuật toán định giá động Dynamic Pricing Engine (Haversine GPS + Surge Multiplier).<br>• Điều phối giao dịch phân tán Saga Coordinator & Vòng đời bù trừ 2 chiều (Refund / Release driver).<br>• Bảo mật xác thực JWT HS256, Scrypt hashing, Persistent Token Blacklist, Idempotency-Key.<br>• Phụ trách Master Test Runner và tích hợp toàn hệ thống.<br>• Chịu trách nhiệm chính soạn thảo Báo cáo đồ án (Chương 1, 2, 3, 6). |
| **2** | **Dương Quốc Hoàng**<br>*(Thành viên)* | **30%** | • `Driver Location Service` (:8002)<br>• `Matching Service` (:8004)<br>• Driver PostgreSQL Database | • Xây dựng cơ sở dữ liệu `driver_db` và `match_db` trên PostgreSQL 17.<br>• Giao thức đặt trước tài xế Driver Reservation Protocol (`HELD`, `CONFIRMED`, `RELEASED`, `EXPIRED`).<br>• Kiểm soát tranh chấp đồng thời bằng CAS Optimistic Lock (`version`) + `FOR UPDATE SKIP LOCKED`.<br>• Thuật toán định vị và lọc tài xế theo bán kính không gian Haversine Geospatial Filter.<br>• Tham gia viết Báo cáo Mục 3.2, Chương 4 và kịch bản demo. |
| **3** | **Minh Quang (Quangdz1125)**<br>*(Thành viên)* | **30%** | • `Payment Service` (:8005)<br>• `Notification Service` (:8006)<br>• `API Gateway` (:8080)<br>• `Web Dashboard` (:3000)<br>• Hạ tầng Docker & RabbitMQ | • Triển khai Payment Service với quản lý số dư ví, Row-Level Lock và Transactional Outbox Pattern.<br>• Thiết lập RabbitMQ 4 Topology: Topic Exchange `trip.exchange`, Dead-Letter Queue `trip.dlq`, Bounded Retries.<br>• Xây dựng API Gateway phân quyền RBAC, CORS, Distributed Tracing (`X-Correlation-ID`).<br>• Phát triển Web Dashboard mô phỏng bản đồ Leaflet thời gian thực và Server-Sent Events (SSE).<br>• Đóng gói Docker Compose 10 containers với healthcheck tự động.<br>• Tham gia viết Báo cáo Chương 4, 5 và chuẩn bị slide thuyết trình. |

---

## Tài liệu tham khảo

1. A. S. Tanenbaum and M. van Steen, *Distributed Systems: Principles and Paradigms*, 3rd ed. Pearson, 2017.
2. M. Kleppmann, *Designing Data-Intensive Applications: The Big Ideas Behind Reliable, Scalable, and Maintainable Systems*. O'Reilly Media, 2017.
3. C. Richardson, *Microservices Patterns: With Examples in Java*. Manning Publications, 2018.
4. S. Newman, *Building Microservices: Designing Fine-Grained Systems*, 2nd ed. O'Reilly Media, 2021.
5. H. Garcia-Molina and K. Salem, "Sagas," in *ACM SIGMOD Record*, vol. 16, no. 3, pp. 249–259, 1987.
6. E. Brewer, "CAP twelve years later: How the 'rules' have changed," *Computer*, vol. 45, no. 2, pp. 23–29, 2012.
7. J. Gray, "Notes on data base operating systems," in *Operating Systems*, Springer, pp. 393–481, 1978.
8. RabbitMQ Documentation, "AMQP 0-9-1 Model Explained and Dead Letter Exchanges." [Online]. Available: https://www.rabbitmq.com/docs/dlx
9. PostgreSQL Global Development Group, "Explicit Locking and The FOR UPDATE SKIP LOCKED Clause." [Online]. Available: https://www.postgresql.org/docs/17/sql-select.html
10. SQLite Development Team, "Write-Ahead Logging (WAL) Mode Architecture." [Online]. Available: https://www.sqlite.org/wal.html
11. M. Jones, J. Bradley, and N. Sakimura, "JSON Web Token (JWT)," RFC 7519, May 2015.
12. C. Percival, "Stronger Key Derivation via Sequential Memory-Hard Functions (Scrypt)," in *BSDCan'09*, 2009.
13. Node.js Foundation, "Node.js v22 LTS Documentation - Crypto and SQLite Modules." [Online]. Available: https://nodejs.org/docs/latest-v22.x/api/
14. Leaflet.js Documentation, "An open-source JavaScript library for mobile-friendly interactive maps." [Online]. Available: https://leafletjs.com/
