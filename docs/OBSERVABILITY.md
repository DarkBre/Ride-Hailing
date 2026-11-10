# Observability

Gateway tạo hoặc chuyển correlation ID đã kiểm tra định dạng. Driver và Matching log kết quả reservation/matching bằng JSON với correlation ID và trip ID. RabbitMQ ghi nhận reconnect và DLQ. Giữ thông tin xác thực, JWT, password và payload định danh ngoài log.

Theo dõi HTTP latency/error rate theo route, độ trễ booking-to-match, reservation timeout, payment failure theo nguyên nhân, số event retry/DLQ, queue ready/unacked, PostgreSQL connections và thời gian chờ lock. Không dùng trip ID làm nhãn metric vì cardinality cao.

RabbitMQ image có endpoint Prometheus nội bộ. Để bổ sung Prometheus/Grafana, dùng overlay monitoring riêng với quyền read-only. Đặt SLO, alert và retention sau khi có workload production. Stack monitoring và alerting chưa triển khai.
