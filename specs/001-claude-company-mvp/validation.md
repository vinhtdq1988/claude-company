# Validation: Claude Company v1.0 (MVP)

**Feature**: `001-claude-company-mvp` | **Plan**: [plan.md](./plan.md)

File này ghi kết quả kiểm chứng theo từng mốc. T143a, T163a và T200 sẽ bổ sung các mục tiếp theo.

---

## T077a – Rà soát constitution khi kết thúc Phase 1 lộ trình

**Ngày rà soát**: 2026-11-09 | **Constitution**: v1.0.1 | **Căn cứ**: mục Governance → "Rà soát định kỳ" (rà soát khi kết thúc mỗi phase phát triển, Nguyên tắc VIII).

**Phạm vi đã triển khai** (Phase 1 lộ trình "Company / Department / Employee / Organization"): Phase 1–2 Spec Kit (hạ tầng, tenancy, xác thực, chính sách quyền, outbox/realtime), US1 (cơ cấu tổ chức) và US2 (hồ sơ AI Employee, chuỗi quản lý, thành viên người thật, workspace). Chưa có Task Engine, Orchestration, Virtual Office, ngân sách (các story này nằm ở Phase 5 trở đi của tasks).

### 1. Trạng thái kiểm chứng

| Hạng mục | Kết quả | Ghi chú |
|---|---|---|
| `tsc --noEmit` mọi tsconfig (gốc, api, web, worker, 4 package) | Đạt | |
| `eslint .` và `prettier --check .` | Đạt | gồm rule `no-restricted-imports` giữa các engine |
| Unit test (`vitest --project unit`) | Đạt 120/120 | gồm chuỗi quản lý thuần, `resolveMountPath`, mô hình biểu mẫu tuyển dụng, DI graph của `AppModule` |
| `vite build` của `apps/web` | Đạt | |
| Contract, integration, security (Testcontainers) | **Chưa chạy** | Máy rà soát không có Docker. Đã viết và typecheck: `employee-engine`, `model-catalog`, `employee`, `management-chain`, `employee-scope` (kèm cập nhật `organization-engine`, `human-member`). Phải chạy `pnpm test:contract test:integration test:security` trước khi merge |
| E2E Playwright (`tests/e2e/employee.spec.ts`, Q2) | **Chưa chạy** | Cần stack chạy và `pnpm db:migrate && pnpm db:seed` |
| Migration `0005_ai_employee_model_price.sql` | **Chưa áp dụng lên PostgreSQL** | Sinh bằng `drizzle-kit`, thêm RLS thủ công; sẽ được kiểm tra khi chạy `prepareDatabase` trong các test trên |

Vì vậy các kết luận ở mục 2 về hành vi lúc chạy dựa trên đọc code và test đã viết, chưa phải bằng chứng chạy thật.

### 2. Đối chiếu Nguyên tắc I–VIII

| Nguyên tắc | Phần đã có ở mốc này | Bằng chứng | Kết luận |
|---|---|---|---|
| I. Công việc thật | Chưa có task, chat hay animation nào được phát hành. `ai_employee` là hồ sơ có `tool_grants`, workspace và manager thật, không phải vỏ chatbot | `packages/db/src/schema/employee.ts`, `EmployeeService` | Phù hợp; phần thực thi thật thuộc US3 |
| II. Con người lãnh đạo (NON-NEGOTIABLE) | Mỗi nhân viên bắt buộc có manager (`MANAGER_REQUIRED`); chuỗi phải kết thúc ở người thật đang hoạt động, ≤ 10 bước, không vòng; AI Manager còn cấp dưới không archive/đổi `kind` được; người thật cuối chuỗi không vô hiệu được; `tool_grants` chỉ nhận action trong danh mục, khớp runtime | `management-chain.ts`, `employee.service.ts`, `human-member.service.ts`; `tests/security/management-chain.spec.ts`; unit test `management-chain.spec.ts` | Phù hợp. Danh mục quyền bốn mức và `evaluate` đã có từ Phase 2; Human Approval thuộc US4 |
| III. Tổ chức do người dùng định nghĩa, cô lập | `ai_employee`, `workspace` có `company_id` và RLS + FORCE; một nhân viên thuộc nhiều Team; phạm vi quản lý quyết định xem/sửa/tạo nhân viên và danh sách trả về | migration 0005; `employee.controller.ts`; `tests/security/employee-scope.spec.ts` | Phù hợp. `home_org_unit_id` buộc là department, không gắn cứng tên phòng ban nào |
| IV. Tiến độ trung thực | Mỗi thay đổi nhân viên ghi `domain_event` cùng transaction (`employee.created/updated/suspended/resumed/archived`, `human_member.deactivated`, `workspace.created`); các sự kiện này phát `sync.seq_advanced` theo D2 | `employee.service.ts`, `envelope-mapper.ts` | Phù hợp. Chưa có trạng thái làm việc và Profile đầy đủ (US5); `performance` lấy từ `TaskEngine.getStats` |
| V. Chi phí và năng lực | `max_concurrent_tasks` có ràng buộc `≥ 1`; `getCapacity` sẵn sàng cho lập lịch; `model_id` phải thuộc `ModelCatalog` (`MODEL_NOT_ALLOWED`); bảng `model_price` đã seed | `employee.service.ts`, `model-catalog.service.ts` | Phù hợp ở mức nền tảng; `allowed_models` theo scope, token/ngân sách thuộc US6 |
| VI. Độc lập model, tách engine | Không import SDK nhà cung cấp; `EmployeeEngine` chỉ đọc bảng của mình, hỏi đơn vị/team qua `OrganizationEngine`, task qua `TaskEngine`, model qua `ModelCatalog`; runtime chọn theo từng nhân viên, AI Manager bắt buộc `messages_api`; `EmployeeProfile` là schema Zod dùng chung | `eslint.config.mjs` (đạt); `packages/contracts/src/employee.ts` | Phù hợp |
| VII. Bằng chứng, độ tin cậy | Chưa có task/run. Hành vi ghi có `lockChain` (advisory lock theo công ty) để hai thao tác song song không tạo vòng; mọi lỗi nghiệp vụ có mã rõ ràng | `employee.service.ts` | Phù hợp; phần bằng chứng và phục hồi thuộc US3, US7 |
| VIII. Tăng dần, MVP | Chỉ làm phạm vi US2; không thêm gamification hay multiplayer. Tính năng đưa sớm đã có biện minh trong Complexity Tracking của plan | `plan.md` | Phù hợp |

**Ràng buộc công nghệ và quy trình**: đúng stack mặc định; secret không nằm trong mã nguồn; mount workspace bị giới hạn trong `WORKSPACE_HOST_PATH` (chống thoát đường dẫn, có unit test); phân quyền cưỡng chế phía server ở mọi route (`@RequireScope`) và `authn-coverage` tự phát hiện route thiếu khai báo.

### 3. Điểm cần chú ý và theo dõi

1. **Giá model cần xác nhận**: `model_price` seed theo tra cứu ngày 2026-11-09, nhưng trang giá chính vẫn liệt kê Sonnet 5/Haiku 4.5 và chưa khớp hẳn trang riêng của Sonnet 5.5/Haiku 5.5. Phải đối chiếu lại trước khi dùng để tính chi phí ở US6 (SC-008, SC-009). Thay giá bằng cách thêm dòng `effective_from` mới.
2. **Chi phí của `EmployeeEngine.get` trên đường nóng**: `PermissionEngine.evaluate` gọi `get` cho mỗi lần đánh giá và `get` luôn truy vấn thành viên team và `getStats`. Nếu đo ở US3/US4 thấy chậm thì thêm cách đọc không kèm `performance` cho `evaluate`.
3. **Vòng phụ thuộc Organization ↔ Employee** được giải bằng `ModuleRef` (lấy muộn) thay cho `forwardRef` như T041 dự kiến; đã ghi trong `contracts/engine-interfaces.md`.
4. **Interface mở rộng thêm ngoài D4**: `OrganizationEngine.getOrgUnit`, `OrganizationEngine.listTeamMemberships`, `EmployeeFilter.withPerformance`, `OrgChartTeam.members`. Đã ghi trong `contracts/engine-interfaces.md`.
5. **Slot của nhân viên**: US2 tạm định nghĩa `active` = task `in_progress`. US3 (lập lịch) phải xác nhận lại định nghĩa này.
6. **Hạn chế đã biết của thao tác nhiều bước**: `archive` gỡ nhân viên khỏi Team trong cùng transaction nên tất cả cùng thành công hoặc cùng quay lại.

### 4. Kết luận

Không phát hiện vi phạm Nguyên tắc I–VIII ở phạm vi đã triển khai, và constitution v1.0.1 vẫn phản ánh đúng thực tế sản phẩm nên **không cần sửa đổi**. Điều kiện còn lại trước khi đóng mốc: chạy các bộ test Testcontainers và E2E ở mục 1 và xử lý điểm 1 ở mục 3 trước US6.
