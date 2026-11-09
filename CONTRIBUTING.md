# Hướng dẫn đóng góp

## Môi trường

- Node.js 24 (xem `.nvmrc`), pnpm 12.
- Docker để chạy PostgreSQL, Redis, MinIO và bộ test dùng Testcontainers.
- Sao chép `docker/.env.example` thành `docker/.env` và điền giá trị thật. Không commit file `.env`.

## Quy trình làm việc

Dự án dùng Spec Kit: `specify → clarify → plan → tasks → implement`. Mỗi thay đổi phải truy được về một task trong `specs/<feature>/tasks.md`.

## Quy trình review

1. Mọi thay đổi vào nhánh chính đi qua pull request. Dùng mẫu `.github/pull_request_template.md`.
2. **Người review phải khác tác giả.** Tác giả không tự phê duyệt PR của mình.
3. Người review kiểm tra theo các mục trong mẫu PR:
   - Tuân thủ Nguyên tắc I–VIII của constitution.
   - Action mới có mức quyền trong danh mục và đi qua `PermissionEngine`/`ToolBroker`.
   - Hành vi agent mới có đo chi phí và logging.
   - Bản sửa lỗi có regression test.
4. Chỉ merge khi CI xanh (`lint`, `test:unit`, `test:contract`, `test:integration`, `test:security`).

## Kiểm thử

Viết test trước, xác nhận fail, rồi mới triển khai. Phân quyền, phê duyệt, giới hạn ngân sách, cô lập tenant và lan truyền trạng thái bắt buộc có test tự động.

| Lệnh                    | Phạm vi                                          |
| ----------------------- | ------------------------------------------------ |
| `pnpm test:unit`        | Test đơn vị trong `test/` của từng package/app   |
| `pnpm test:contract`    | Contract test cho interface engine và lớp model  |
| `pnpm test:integration` | API + worker + PostgreSQL/Redis (Testcontainers) |
| `pnpm test:security`    | Phân quyền, approval, ngân sách, cô lập tenant   |
| `pnpm test:e2e`         | Playwright, luôn dùng `MODEL_PROVIDER=fake`      |

## Quy ước

- Mã nguồn, tên file, lệnh: tiếng Anh. Comment, commit message (phần mô tả) và tài liệu: tiếng Việt.
- Commit message dùng tiền tố chuẩn: `feat:`, `fix:`, `docs:`, `test:`, `chore:`.
- Engine chỉ giao tiếp qua `@claude-company/contracts`; quy tắc này được ESLint cưỡng chế (`no-restricted-imports`).
