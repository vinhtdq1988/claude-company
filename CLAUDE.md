# Claude Company – Hướng dẫn cho Claude

## Ngôn ngữ

- **Giao tiếp với người dùng**: luôn trả lời bằng **tiếng Việt** (câu hỏi làm rõ, giải thích, tóm tắt, báo cáo kết quả, thông báo lỗi).
- **Tài liệu và file do Claude tạo ra** (spec, plan, tasks, checklist, research, data-model, quickstart, README, ghi chú, báo cáo, tài liệu thiết kế…): viết bằng **tiếng Việt**.
- **Giữ nguyên tiếng Anh** cho:
  - Mã nguồn: tên biến, hàm, class, module, tên file/thư mục, tên bảng/cột, API endpoint, commit type.
  - Lệnh, đường dẫn, cấu hình, tên công cụ và thư viện.
  - Thuật ngữ sản phẩm đã dùng trong Product Concept: AI Employee, AI Manager, Virtual Office, Task Center, Company Dashboard, XP, Level, Achievement, Auto Execute, Review Required, Human Approval, Restricted…
  - Tiêu đề mục cố định, ID và marker của template Spec Kit (ví dụ `FR-001`, `SC-001`, `T001`, `[NEEDS CLARIFICATION]`, `[P]`, `[US1]`, Given/When/Then), để các lệnh Spec Kit vẫn nhận diện đúng cấu trúc. Nội dung bên dưới các tiêu đề đó viết bằng tiếng Việt.
- **Comment trong code** và **commit message**: dùng tiếng Việt cho phần mô tả; giữ tiền tố chuẩn bằng tiếng Anh (ví dụ `feat:`, `fix:`, `docs:`).
- Nếu người dùng yêu cầu rõ một ngôn ngữ khác cho một file cụ thể, làm theo yêu cầu đó.

## Tài liệu tham chiếu

- Định hướng sản phẩm: `ref/Claude_Company_Product_Concept_V1.docx` (nguồn ý định sản phẩm).
- Hiến pháp dự án: `.specify/memory/constitution.md` (các nguyên tắc bắt buộc; mọi plan phải qua bước Constitution Check).

## Quy trình làm việc

- Dự án dùng Spec Kit: `specify → clarify → plan → tasks → implement`. Mỗi spec phải nêu rõ thuộc Phase nào trong lộ trình MVP.
- Không tự thực hiện yêu cầu ngoài phạm vi của lệnh đang chạy (ví dụ lệnh cập nhật constitution không được sinh code); thay vào đó nêu ở phần `Next Actions` và gợi ý lệnh Spec Kit tiếp theo.
- Với hành động khó hoàn tác hoặc ảnh hưởng bên ngoài (xóa dữ liệu, push, deploy), hỏi xác nhận trước khi thực hiện.
