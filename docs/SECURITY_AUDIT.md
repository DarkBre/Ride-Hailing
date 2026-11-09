# Audit phát hành DS03

Mốc đầu lượt là `9c37517` trên `feature/tv2-driver-matching`. Working tree sạch. So với ref remote tại `c7a99e0`, bốn commit local thay đổi 58 file. Phần đó đã được lưu trong Git trước audit.

| Thành phần | Trạng thái và phát hiện | Mức độ | Xử lý |
|---|---|---|---|
| Gateway | Danh sách route cố định, loại internal header từ client, kiểm tra Identity | MEDIUM | Thêm no-store và nosniff. Rate limit và TLS vẫn cần ở biên production |
| Identity | Token thiếu hạn có thể vượt kiểm tra. Logout trước đây ghi cả token không hợp lệ | HIGH | Bắt buộc claim và HS256, xác minh trước khi revoke, từ chối khi không kiểm tra được blacklist |
| Driver | CAS, row lock, unique index theo tài xế và chuyến | HIGH | Đồng bộ kiểm tra issuer/audience. Đối chiếu kiểm thử reservation và restart |
| Trip | Khóa idempotency dùng chung có thể tiết lộ kết quả chuyến khác. Hold failure đến trễ có thể ghi đè chuyến đã hoàn tất | HIGH | Tách key theo hành khách và giới hạn bù trừ theo trạng thái, Saga và tài xế thực tế |
| Matching | Job bền vững, reservation và dedup theo chuyến | MEDIUM | Xác minh phục hồi; một số race xuyên service cần Saga bù trừ |
| Payment | Command có thể chứa số tiền hoặc người dùng khác bản ghi hold | HIGH | So khớp với khoản hold trước khi chuyển trạng thái. Capture/refund dùng số tiền đã giữ |
| PostgreSQL | Ba DB và role riêng, ràng buộc unique/check | MEDIUM | Giữ quyền sở hữu. Backup/restore và restart DB cần nghiệm thu riêng |
| RabbitMQ | Một node, queue bền vững và DLQ | HIGH | Kiểm thử restart node; mất volume hoặc quorum chưa có bảo đảm HA |
| Docker | Chỉ Gateway publish trên loopback, Identity và Trip còn chạy bằng user mặc định của image | MEDIUM | Ghi việc chuyển non-root và kiểm tra quyền volume vào readiness |
| Security | Identity và Trip từng trả lỗi 5xx nội bộ và đọc body thiếu giới hạn | HIGH | Giới hạn 16 KiB, timeout và trả thông báo chung cho lỗi 5xx |
| Testing | Có regression và E2E thật. Thiếu bằng chứng load và lỗi broker ở mốc đầu | MEDIUM | Bổ sung test JWT, race và probe opt-in cho Docker stack riêng |

## Tái hiện và kiểm tra lại

- Gửi cùng idempotency key và payload bằng hai JWT hành khách. Mỗi hành khách nhận ID riêng. Retry bằng JWT ban đầu nhận đúng ID của mình. Lookup tiếp tục nhận các key cũ thuộc cùng chủ sở hữu. Regression nằm trong `tests/trip.test.js`.
- Gửi hold failure tới Trip sau khi chuyến đã hoàn tất, hoặc kèm tài xế không khớp. Trip bỏ qua bù trừ ngoài trạng thái hợp lệ. Regression nằm trong `tests/saga.test.js`.
- Ký token có chữ ký hợp lệ nhưng thiếu exp, user ID, role hợp lệ hoặc sai issuer/audience. `node --test tests/security.test.cjs` xác minh Identity và Trip từ chối. Compose cấu hình issuer/audience cho cả Identity, Trip và Driver. Client cần đăng nhập lại sau khi bật cấu hình này.
- Gửi JSON vượt 16 KiB tới Identity/Trip để nhận 413. Mã lỗi SQL hoặc nội dung ngoại lệ 5xx được thay bằng phản hồi chung. Kiểm thử HTTP riêng cho payload quá cỡ chưa chạy.

## Secret và rủi ro còn lại

File cấu hình được track hiện tại dùng biến môi trường và giá trị secret trống. Lịch sử `2e59e1f` từng chứa credential mẫu dạng literal. Audit không xác minh các giá trị đó từng được tái sử dụng trên hệ thống thật. Nếu nhóm đã dùng lại chúng, cần rotate JWT, PostgreSQL và RabbitMQ. Giá trị lịch sử không được in trong báo cáo.

Production còn cần chính sách rate limit đăng nhập, TLS, thông tin xác thực RabbitMQ theo service và phân quyền publish/consume. Envelope source chỉ là metadata và không thay thế ACL broker. Luồng demo legacy khi chạy Trip ngoài Compose tiếp tục hỗ trợ request không token để tương thích bộ TV1. Chỉ dùng chế độ đó trong môi trường test tách biệt.
