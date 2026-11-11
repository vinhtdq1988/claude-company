# Validation: Claude Company v1.0 (MVP)

**Feature**: `001-claude-company-mvp` | **Plan**: [plan.md](./plan.md)

File này ghi kết quả kiểm chứng theo từng mốc. Các mục "Chưa chạy" của test PostgreSQL ở T077a–US6 đã được thay bằng bằng chứng chạy thật ở mục "Bằng chứng chạy thật trên PostgreSQL cục bộ" (cuối file).

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

---

## T143a – Rà soát constitution khi kết thúc Phase 2 lộ trình

**Ngày rà soát**: 2026-11-10 | **Constitution**: v1.0.1 | **Căn cứ**: mục Governance → "Rà soát định kỳ" (Nguyên tắc VIII).

**Phạm vi đã triển khai** (Phase 2 lộ trình "AI Employee, AI Manager, Task Assignment"): thêm US3 (giao việc, thực thi thật, review độc lập, Human Approval cho task) và US4 (phê duyệt hành động nhạy cảm) trên nền Phase 1 ở T077a. Chưa có Virtual Office, Dashboard, trang cài đặt ngân sách, lịch sử thực thi và milestone (US5–US8).

### 1. Trạng thái kiểm chứng

| Hạng mục | Kết quả | Ghi chú |
|---|---|---|
| `tsc --noEmit` mọi tsconfig (gốc, api, web, worker, 4 package) | Đạt | |
| `eslint .` | Đạt | gồm rule `no-restricted-imports` giữa các engine |
| Unit test (`vitest --project unit`) | Đạt 274/274 | mới có: ToolBroker với cổng phê duyệt (8 ca mới, tổng 23), RunExecutor tạm dừng/resume (8), job thực thi hành động đã duyệt + cổng + nhắc (15), hash và tóm tắt action (5), chọn người duyệt (5), model hiển thị phê duyệt (6) |
| Contract không cần Docker | Đạt 62/62 | `tool-adapter` (31: idempotency, `lookup`, nhãn dry-run, `live` → `ADAPTER_LIVE_NOT_CONFIGURED`), `model-gateway-pause` (11, ba provider), `model-gateway` (20, hồi quy sau thay đổi provider) |
| Contract, integration, security trên PostgreSQL (Testcontainers) | **Chưa chạy** | Máy rà soát không có Docker. Đã viết và typecheck: `permission-engine`, `approval-flow`, `approval-bypass`, `prompt-injection`, `unclassified-actions`, cập nhật `agent-sdk-permissions` (D6 → chờ duyệt). Phải chạy `pnpm test:contract test:integration test:security` trước khi merge |
| E2E Playwright (`tests/e2e/approval.spec.ts`, Q6, Q7) | **Chưa chạy** | Cần stack đầy đủ (worker, Redis, MinIO) và `pnpm db:migrate && pnpm db:seed` |
| Migration `0007_approval_request.sql` | **Chưa áp dụng lên PostgreSQL** | Sinh bằng `drizzle-kit`, thêm RLS và hàm `list_companies_with_pending_approvals()` thủ công; sẽ được kiểm tra khi chạy `prepareDatabase` |
| Việc Phase 5 còn mở | Vẫn mở | T088 (6 ca trên container thật), T089 (chạy E2E), T090 (spike Agent SDK, cần `ANTHROPIC_API_KEY`), T111/T111a (build và chạy `sandbox-runner`, `egress-proxy` trên Docker) |

Vì vậy các kết luận ở mục 2 về hành vi lúc chạy dựa trên đọc code, unit test với phụ thuộc giả và test đã viết nhưng chưa chạy, chưa phải bằng chứng chạy thật. Hai lớp cưỡng chế quan trọng nhất đã có bằng chứng chạy được: ToolBroker không bao giờ gọi handler của action `human_approval` (unit test, kể cả hai lời gọi đồng thời và `rationale` chứa lệnh "bỏ qua phê duyệt"), và job thực thi chỉ chạy khi hash khớp, chiếm bản ghi ledger một lần (unit test).

### 2. Đối chiếu Nguyên tắc I–VIII

| Nguyên tắc | Phần đã có ở mốc này | Bằng chứng | Kết luận |
|---|---|---|---|
| I. Công việc thật | Task chạy thật tới artifact và bằng chứng từng criterion; hành động nhạy cảm chỉ được "thực thi" ở dry-run, kết quả mang nhãn `dry-run` (adapter, `listExecutedActions`, chi tiết task, hộp phê duyệt) nên `Completed` không bị hiểu là đã gửi/deploy thật. `live` chưa cấu hình trả `ADAPTER_LIVE_NOT_CONFIGURED` và task `blocked` thay vì giả lập | `apps/worker/src/tools/adapters/`, `approval-jobs.ts`, `TaskDetailPage.tsx`, `ApprovalsPage.tsx` | Phù hợp. Ngoại lệ dry-run đã biện minh ở Complexity Tracking của plan |
| II. Con người lãnh đạo (NON-NEGOTIABLE) | Action `email.send`, `data.delete`, `deploy.*`, `workspace.git.push` có floor `human_approval`: agent chỉ tạo đề xuất, hệ thống thực thi payload có hash khớp sau khi người thật duyệt, kể cả dry-run. Mọi quyết định bắt buộc lý do và ghi người, thời điểm (`approval_request.decided_by/at/reason`, `review_record` bất biến). Không có đường tự duyệt hay hết hạn tự duyệt; người ngoài phạm vi bị `403`. Hành động chưa phân loại và shell ngoài allowlist là `restricted`, không thể "mua" quyền bằng cách xin duyệt | `approval.service.ts`, `approval-gate.ts`, `tool-broker.ts`, `packages/policy`, `approval-bypass.spec.ts`, `unclassified-actions.spec.ts` | Phù hợp. D6 (fail-closed tạm thời) đã được thay bằng cơ chế thật (T137) |
| III. Tổ chức do người dùng định nghĩa, cô lập | `approval_request` có `company_id` + RLS; danh sách và quyết định lọc theo `ManagedScope` ở server; `ApprovalListener` chuyển yêu cầu của người duyệt bị vô hiệu cho CEO | migration 0007, `approval.controller.ts`, `approval.listener.ts` | Phù hợp |
| IV. Tiến độ trung thực | Run chờ duyệt có trạng thái `waiting_approval` thật và sự kiện `approval.requested/decided`, `run.waiting_approval`, `run.resumed` làm đầu vào cho reducer của Office Simulation; task giữ `In Progress` trong lúc chờ. Chưa có màn hình Virtual Office | `orchestration.service.ts`, `permission.module.ts` | Phù hợp; phần hiển thị thuộc US5 (vế Virtual Office của Q6 chưa kiểm chứng được) |
| V. Chi phí và năng lực | Run chờ duyệt không giữ ngân sách (release khi tạm dừng, reserve lại khi resume; không đủ → `blocked`, `BUDGET_EXCEEDED`). Theo scope, `allowed_models`, cảnh báo ngưỡng đã có từ T108; trang cài đặt và dashboard thuộc US6 | `run-loop.ts`, `run-loop-approval.spec.ts` | Phù hợp ở mức cưỡng chế; thiếu UI/Dashboard |
| VI. Độc lập model, tách engine | Permission Engine không đọc bảng của Orchestration/Task: lấy payload qua `findToolInvocationByKey`, nhân viên qua `EmployeeEngine`, phạm vi qua `OrganizationEngine`, thông báo qua `CommunicationEngine`. Worker thực thi qua `ToolAdapter` và `OrchestrationEngine.claimToolInvocation`, không chạm bảng | `eslint.config.mjs` (đạt), `approval.service.ts` | Phù hợp |
| VII. Bằng chứng, độ tin cậy | Mọi đánh giá (kể cả `restricted`) có `tool_invocation`; hành động có tác dụng phụ dùng idempotency key và chiếm bản ghi có điều kiện; recovery: `action.execute-approved`/`run.resume` được BullMQ thử lại, sweeper phát lại job đã mất cho run đã có quyết định (`APPROVAL_REPLAY_AFTER_MS`), tool kẹt `executing` hỏi adapter theo key trước khi làm gì | `approval-jobs.ts`, `orchestration.service.ts`, `queues.ts` | Phù hợp; phần recovery mới được kiểm chứng bằng test đã viết, chưa chạy |
| VIII. Tăng dần, MVP | Chỉ làm phạm vi US4: chưa có adapter thật, chưa có API ghi `action_policy`, chưa có chat hay XP. Dry-run và hộp phê duyệt là phần tối thiểu | `plan.md` | Phù hợp |

**Ràng buộc công nghệ và quy trình**: đúng stack mặc định; không thêm dependency mới; secret không đi vào ledger/log (`redact`), adapter dry-run chỉ ghi payload đã duyệt vào volume riêng.

### 3. Điểm cần chú ý và theo dõi

1. **Chưa có bằng chứng chạy thật cho phần PostgreSQL, Redis/BullMQ và trình duyệt** (mục 1). Cần chạy để xác nhận: migration 0007, hai quyết định đồng thời (`FOR UPDATE`), luồng `settle()` của `approval-flow`, và hành vi `attempts` của BullMQ với hai job mới.
2. **Mở rộng interface ngoài danh sách D4** (đã ghi vào `contracts/engine-interfaces.md`): `PermissionEngine.getApproval/listApprovals`, `OrchestrationEngine.claimToolInvocation`, tham số `replay` của `resumeAfterApproval`, bốn trường mới của `ToolInvocationRef`, mã lỗi `APPROVAL_NOT_PENDING`, trường tùy chọn `rationale` trong input của năm tool Human Approval, cấu hình `DRY_RUN_LOG_PATH` và `APPROVAL_REPLAY_AFTER_MS`.
3. **Ai được quyết định**: bất kỳ thành viên có nhân viên đó trong `ManagedScope` (CEO luôn có), không chỉ người giao task. Quyết định luôn ghi `decided_by`. Nếu sau này cần "chỉ người giao task", đổi một điều kiện trong `ApprovalService.decideApproval`.
4. **Yêu cầu bị hủy khi task rời `In Progress`** (hủy, `blocked` vì tạm ngưng/ngân sách…) là mở rộng so với dòng "cancel → hủy approval" của data-model: nếu không, sau `resume` agent đề xuất lại sẽ gặp bản ghi ledger cũ và treo mãi. Đã ghi vào data-model.
5. **Giới hạn của dry-run**: log JSONL không có khóa file đa tiến trình; `execute` kiểm tra `find` rồi `append` nên hai worker cùng một key có thể ghi trùng một dòng trong cửa sổ rất hẹp. Việc chiếm bản ghi ledger trước khi gọi adapter đã chặn trường hợp này ở mức hệ thống; adapter thật phải tự idempotent theo key.
6. **Phát lại job vô thời hạn**: nếu `action.execute-approved` luôn ném lỗi (không phải lỗi nghiệp vụ), sweeper phát lại mỗi 5 phút cho tới khi sửa; lỗi hiện qua job thất bại của BullMQ. Chấp nhận được ở v1.0; US7 (lịch sử thực thi) nên hiển thị run kẹt `waiting_approval` quá lâu dù đã có quyết định.

### 4. Kết luận

Không phát hiện vi phạm Nguyên tắc I–VIII ở phạm vi đã triển khai, và constitution v1.0.1 vẫn phản ánh đúng thực tế sản phẩm nên **không cần sửa đổi**. Điều kiện còn lại trước khi đóng mốc: chạy các bộ test Testcontainers và E2E ở mục 1, áp dụng migration 0007, và hoàn tất các việc Phase 5 còn mở (T088, T089, T090, T111, T111a) trước khi cho `MODEL_PROVIDER=anthropic` chạy không giám sát. Giá model vẫn phải đối chiếu lại trước US6 (mục 3, điểm 1 của T077a).

---

## T163a – Rà soát constitution khi kết thúc Phase 3 lộ trình

**Ngày rà soát**: 2026-11-10 | **Constitution**: v1.0.1 | **Căn cứ**: mục Governance → "Rà soát định kỳ" (Nguyên tắc VIII).

**Phạm vi đã triển khai** (Phase 3 lộ trình "Virtual Office, Animation, Realtime"): thêm US5 (Virtual Office pixel art 2D, Employee Profile, đồng bộ realtime theo `seq`) trên nền Phase 1–2 ở T077a và T143a. Chưa có Company Dashboard, trang cài đặt ngân sách, lịch sử thực thi và milestone (US6–US8).

### 1. Trạng thái kiểm chứng

| Hạng mục | Kết quả | Ghi chú |
|---|---|---|
| `tsc --noEmit` mọi tsconfig (gốc, api, web, worker, 4 package) | Đạt | |
| `eslint .` | Đạt | gồm `no-restricted-imports`: engine `office-simulation` chỉ import schema `office`; pixi.js chỉ trong `renderer-pixi/` |
| Unit test (`vitest --project unit`) | Đạt 335/335 | mới có: reducer office (36 ca: từng dòng bảng ánh xạ, ưu tiên, idempotent, truy vết nguồn), bố cục zone và lý do đổi layout (8), store Virtual Office (17); `di-smoke` xác nhận `AppModule` biên dịch với `OfficeSimulationModule` |
| Contract không cần Docker | Đạt 62/62 | hồi quy `tool-adapter`, `model-gateway`, `model-gateway-pause` |
| Contract, integration, security trên PostgreSQL/Redis (Testcontainers) | **Chưa chạy** | Máy rà soát không có Docker. Đã viết và typecheck: `office-simulation-engine`, `realtime-propagation`, `office-audit`, `realtime-isolation`. Phải chạy `pnpm test:contract test:integration test:security` trước khi merge. Mọi test cũ dùng `createFlowHarness` cũng chạy qua bộ chiếu office nên cần chạy lại để loại trừ hồi quy |
| E2E Playwright (`tests/e2e/virtual-office.spec.ts`: Q8 và phần Waiting Approval của Q6) | **Chưa chạy** | Cần stack đầy đủ và `pnpm db:migrate && pnpm db:seed` |
| Migration `0008_office_simulation.sql` | **Chưa áp dụng lên PostgreSQL** | Sinh bằng `drizzle-kit`, bật RLS thủ công cho bốn bảng |
| Renderer PixiJS trên trình duyệt | **Chưa chạy** | Chỉ typecheck; chưa đo ~60 fps với 10–20 nhân vật; sprite sinh bằng mã mới được xem thử một lần (`characters.png`) |
| Việc Phase 5–6 còn mở | Vẫn mở | T088, T089, T090, T111, T111a, T131 như ở T143a |

Vì vậy các kết luận về hành vi lúc chạy dựa trên đọc code, unit test thuần và test đã viết nhưng chưa chạy. Phần có bằng chứng chạy được: reducer (mọi dòng bảng ánh xạ, thứ tự ưu tiên, tính idempotent khi relay giao lại, nguồn của trạng thái) và store phía client (áp theo `seq`, phát hiện gap, nhãn stale, đồng bộ lại).

### 2. Đối chiếu Nguyên tắc I–VIII

| Nguyên tắc | Phần đã có ở mốc này | Bằng chứng | Kết luận |
|---|---|---|---|
| I. Công việc thật | Trạng thái nhân vật chỉ đến từ `domain_event` thật; không sự kiện thì `idle`. Animation chỉ chạy cho trạng thái đang hoạt động (`ANIMATED_STATES`), nhân vật `idle`/`completed`/`break` đứng yên. Không có chat hay hoạt cảnh giả: Profile chỉ hiển thị tin nhắn gắn task, artifact và review thật | `office-reducer.ts`, `OfficeRenderer.ts`, `office-reducer.spec.ts`, `office-audit.spec.ts` (chưa chạy) | Phù hợp |
| II. Con người lãnh đạo (NON-NEGOTIABLE) | Không thêm đường thực thi hay phê duyệt nào. Office chỉ hiển thị `waiting_approval`; quyết định vẫn qua `PermissionEngine.decideApproval` | `permission.module.ts` (không đổi), `EmployeeProfilePanel.tsx` (chỉ đọc) | Phù hợp |
| III. Tổ chức do người dùng định nghĩa, cô lập | Bốn bảng mới có `company_id` + RLS. Gateway lọc `office.employee_status_changed` theo `ManagedScope` của từng socket kể cả khi phát lại; snapshot chỉ gồm nhân viên và zone trong phạm vi; `profile-view` ngoài phạm vi bị `ScopeGuard` từ chối. Mỗi department một zone | migration 0008, `office-simulation.module.ts`, `office.controller.ts`, `realtime-isolation.spec.ts` (chưa chạy) | Phù hợp ở mức thiết kế; cần chạy security test |
| IV. Tiến độ trung thực | Reducer thuần là nguồn trạng thái duy nhất; `source_event_seq` và nhật ký `employee_status_change` cho phép đối chiếu SC-006. Client dựa vào `seq`, hiện "Trạng thái có thể đã cũ" khi mất kết nối hoặc gap rồi tải lại snapshot. `office/state` thuần TS tách khỏi `renderer-pixi`, renderer chỉ nhận `OfficeSnapshot` | `office-store.ts`, `placement.ts`, `OfficeRenderer.ts`, `VirtualOfficePage.tsx` | Phù hợp |
| V. Chi phí và năng lực | Profile hiển thị token và chi phí tháng này và tổng qua `BudgetService.getUsage`; không đổi cơ chế ngân sách | `profile-view.service.ts` | Phù hợp; Dashboard và cài đặt thuộc US6 |
| VI. Độc lập model, tách engine | Office Simulation Engine chỉ đọc bảng của mình; nhân viên, org chart, task, tin nhắn, ngân sách, phê duyệt đều qua interface. Không import `@anthropic-ai/*` | `eslint.config.mjs` (đạt), `profile-view.service.ts`, `office-zones.service.ts` | Phù hợp |
| VII. Bằng chứng, độ tin cậy | Projection là phép gấp theo `seq` có mốc `office_cursor` và khóa advisory theo công ty nên chiếu bù, chiếu lại và giao lại đều idempotent; bộ chiếu chạy trước khi phát Redis nên client không nhận sự kiện trước dữ liệu của nó; lỗi đồng bộ zone nằm trong savepoint, không chặn chiếu trạng thái | `office-simulation.service.ts`, `outbox-relay.ts`, `event-bus.ts` | Phù hợp; cần chạy test để xác nhận |
| VIII. Tăng dần, MVP | Không thêm `meeting` (Phase 4), Meeting Room, XP/Level, tùy chỉnh bố cục hay multiplayer. Tài sản tự vẽ, không dùng tài sản của `ref/Claude-Office` | `LICENSES.md`, `office-reducer.ts` | Phù hợp |

**Ràng buộc công nghệ và quy trình**: đúng stack mặc định (PixiJS 8 đã có trong plan); không thêm dependency mới; không có secret trong tài sản hay payload realtime (room công ty không mang nội dung task hay approval, có test đã viết).

### 3. Điểm cần chú ý và theo dõi

1. **Chưa có bằng chứng chạy thật cho PostgreSQL, Redis và trình duyệt** (mục 1). Cần xác nhận: migration 0008; luồng relay → bộ chiếu → Redis → gateway (đặc biệt thứ tự và độ trễ so với SC-005 ≤ 3 giây p95); cú pháp `tracks ? $1` của jsonb; savepoint khi đồng bộ zone; và các test cũ dùng `createFlowHarness` không bị hồi quy vì mọi sự kiện giờ đi qua bộ chiếu.
2. **Đổi thứ tự trong `OutboxRelay`** (ngoài danh sách D4): `bus.project` → Redis → `bus.emit`. Bộ chiếu chạy tuần tự trước khi phát nên mỗi sự kiện chịu thêm vài truy vấn (khóa, đọc mốc, ghi trạng thái); nếu đo thấy độ trễ vượt SC-005 thì gộp theo lô trong `relayCompany`. `EnvelopeMapperRegistry.map` và `EnvelopeMapper` giờ bất đồng bộ.
3. **Mở rộng hợp đồng ngoài thiết kế ban đầu** (đã ghi vào data-model, engine-interfaces, realtime-events, rest-api, research): `OfficeSimulationEngine.apply(event, previous?)`, `getProfileView`, `completeDisplayElapsed`; bảng `employee_status_change` và `office_cursor`; cột `suspended`, `tracks`, `applied_seq`; thêm lý do `org_unit_updated`, `employee_added`, `employee_updated`, `employee_removed` cho `office.layout_changed` (nếu không, nhân viên mới tuyển không xuất hiện trên office khi chưa tải lại); trường `runId` trong payload `task.message_posted`; job `office.completed-elapsed`; trường `currentTool` trong snapshot.
4. **Khác biệt so với bảng ánh xạ**: (a) tin nhắn của AI chỉ chuyển `communicating` khi gắn với run đang chạy của chính họ, vì không có sự kiện nào kết thúc trạng thái này khi tin nhắn gửi ngoài run; hoạt động của AI Manager (decompose/review/synthesize) vẫn là `communicating` qua `run.started`. (b) `employee.resumed` chỉ xóa lỗi do chính việc tạm ngưng (`EMPLOYEE_SUSPENDED`); task `blocked` vì lý do khác vẫn hiển thị `error_blocked`. (c) `progress` đổi cũng phát `office.employee_status_changed` (cùng `state`) để Profile và thanh tiến độ khớp.
5. **Hết hạn `completed` phụ thuộc BullMQ**: nếu Redis mất job `office.completed-elapsed` thì nhân viên giữ `completed` cho tới khi có sự kiện khác. Chiếu bù sự kiện cũ đặt độ trễ 0 nên tự dọn khi chiếu lại, nhưng chưa có sweeper riêng; nên thêm vào sweeper nếu thực tế gặp.
6. **Nhật ký `employee_status_change` chưa có chính sách dọn**; mỗi lần đổi hiển thị một dòng. Với v1.0 (≤ ~50 nhân viên) chấp nhận được; cần giữ tối thiểu 10 phút cho phát lại.
7. **Công ty đã có lịch sử sự kiện**: lần chiếu đầu tiên gấp toàn bộ `domain_event` (theo lô 500) trong lúc giữ khóa công ty nên lần mở office đầu tiên có thể chậm hơn. Chấp nhận được ở v1.0; nếu lịch sử lớn nên chiếu nền khi khởi động.
8. **Renderer dựng lại toàn cảnh mỗi lần cập nhật** (≤ ~20 nhân vật nên rẻ) và co giãn theo số nguyên để pixel art sắc nét; cần đo thực tế ~60 fps (plan.md). Canvas không đọc được bằng DOM nên E2E kiểm chứng qua danh sách nhân viên dùng chung store; nhân vật `break` hiển thị ở Break Room chỉ là cách trình bày.
9. **Nội dung do AI sinh ra trong Profile** (tin nhắn, tiêu đề artifact, lý do review) được hiển thị như văn bản thuần (React escape, không dùng `dangerouslySetInnerHTML`).

### 4. Kết luận

Không phát hiện vi phạm Nguyên tắc I–VIII ở phạm vi đã triển khai, và constitution v1.0.1 vẫn phản ánh đúng thực tế sản phẩm nên **không cần sửa đổi**. Điều kiện còn lại trước khi đóng mốc: chạy các bộ test Testcontainers và E2E ở mục 1, áp dụng migration 0008, mở Virtual Office trên trình duyệt để kiểm tra bằng mắt và đo fps, và hoàn tất các việc Phase 5–6 còn mở (T088, T089, T090, T111, T111a, T131). Giá model vẫn phải đối chiếu lại trước US6.


---

## US6 (T164–T175) – Kiểm chứng ngân sách, Dashboard và giới hạn đồng thời

**Ngày**: 2026-11-10 | **Phạm vi**: Phase 8 của Spec Kit (US6, ưu tiên P2). Đây là bản ghi kiểm chứng của story, không phải đợt rà soát constitution theo mốc lộ trình (mốc kế tiếp là khi US7 hoàn tất).

### 1. Trạng thái kiểm chứng

| Hạng mục | Kết quả | Ghi chú |
|---|---|---|
| `tsc --noEmit` (gốc gồm `tests/`, api, web, worker, contracts, db) | Đạt | |
| `eslint .` | Đạt | |
| Unit test (`vitest --project unit`) | Đạt 349/349 | thêm `apps/web/test/budget-model.spec.ts` (định dạng, mức dùng, biểu mẫu chính sách, danh sách phạm vi, task bị chặn) |
| Contract không cần Docker | Đạt 62/62 | hồi quy `tool-adapter`, `model-gateway`, `model-gateway-pause` |
| Contract, integration, security trên PostgreSQL/Redis | **Chưa chạy** | Máy rà soát không có Docker. Đã viết và typecheck: `tests/contract/budget-service.spec.ts`, `tests/security/budget-enforcement.spec.ts`, `tests/security/budget-dashboard-scope.spec.ts`, `tests/integration/dashboard-usage.spec.ts`; ca mới trong `tests/contract/employee-engine.spec.ts` (fake `BUDGET_SERVICE`). Phải chạy `test:contract test:integration test:security` trước khi merge, kèm toàn bộ test cũ dùng `createFlowHarness` vì `TaskScheduler` đổi hành vi |
| Migration `0009_budget_warning_log.sql` | **Chưa áp dụng lên PostgreSQL** | Sinh bằng `drizzle-kit`, bật RLS thủ công |
| Giao diện Dashboard, Budget, mục chi phí ở hồ sơ nhân viên | **Chưa chạy trên trình duyệt** | Chỉ typecheck; phần logic thuần có unit test |

### 2. Đối chiếu Nguyên tắc liên quan

| Nguyên tắc | Bằng chứng |
|---|---|
| V. Chi phí và năng lực | Giới hạn token, chi phí, số task đồng thời, model theo bốn phạm vi có API và màn hình. Công ty không bao giờ không giới hạn: `PUT` từ chối `null` cho token/chi phí công ty. Cảnh báo ngưỡng bền vững qua `budget_warning_log`. Chặn vẫn xảy ra ở `reserve` trước khi tiêu. |
| II. Con người lãnh đạo | Task bị chặn vì ngân sách không tự tiếp tục: người quản lý tăng hạn mức rồi `resume`. Chính sách do người thật đặt qua API có `ScopeGuard`. |
| III. Cô lập và phạm vi | `budget-policies` dùng `budget.manage` theo phạm vi trong đường dẫn (Manager không đọc/sửa company hoặc đơn vị cha); `/usage` và `/dashboard` lọc theo `ManagedScope`; `orgUnitId`/`employeeId` ngoài phạm vi → 403. Bảng mới có `company_id` + RLS. |
| VI. Tách engine | Engine chỉ hỏi nhau qua interface (`allowedModelsFor`, `getConcurrencyLimits`, `getUsage({scope})`, `getStats({scope})`); `EmployeeEngine` lấy `BudgetService` muộn qua `ModuleRef` để tránh vòng phụ thuộc. |
| VII. Quan sát | Dashboard và tổng theo task cùng đọc `usage_ledger` nên khớp (SC-008). |
| VIII. Tăng dần | Không thêm tiền tệ, hóa đơn hay quota ngoài phạm vi US6. |

### 3. Điểm cần chú ý và theo dõi

1. **Chưa có bằng chứng chạy thật** cho phần DB (mục 1). Rủi ro cao nhất là `TaskScheduler`: logic lập lịch đổi (đếm cả slot theo scope, khóa công ty `scopes:{companyId}` chờ tối đa ~1 giây, cảnh báo quá tải), nên mọi test luồng task phải chạy lại.
2. **Khóa phạm vi theo công ty** làm các lần lập lịch của các nhân viên trong cùng công ty chạy nối tiếp khi công ty có `max_concurrent_tasks` ở company/đơn vị/team. Chấp nhận được với ~50 nhân viên; cần theo dõi nếu tăng quy mô. Nếu không lấy được khóa sau ~1 giây thì bỏ lượt và chờ lần kích hoạt kế tiếp (task rời `in_progress` hoặc `budget.policy_changed`).
3. **Đếm slot theo scope** dùng `TaskEngine.list` giới hạn `max` bản ghi và chỉ tính task `in_progress` giao trực tiếp cho AI Employee (cùng định nghĩa với `getCapacity`), nên task cha giao cho đơn vị hoặc team không chiếm slot.
4. **Dedupe `overload_warning` bằng Redis**: mất khóa Redis chỉ làm gửi thêm một cảnh báo trong ngày, không làm mất cảnh báo.
5. **Cảnh báo ngân sách**: `commit` cảnh báo ngay khi mức dùng đạt ngưỡng và chưa có dòng log, kể cả khi hạ ngưỡng xuống dưới mức đang dùng; tạo chính sách mới khi đã vượt ngưỡng sẽ cảnh báo ở lần `commit` kế tiếp. Việc gửi notification vẫn do run-loop thực hiện; nếu gửi lỗi thì không gửi lại (dòng log đã ghi), chỉ ghi cảnh báo trong log.
6. **Ngoài thiết kế ban đầu** (đã ghi vào rest-api, engine-interfaces, data-model, realtime-events): bảng `budget_warning_log`; `BudgetService.allowedModelsFor/getConcurrencyLimits` và `getUsage({scope})`; `TaskEngine.getStats({scope})`; sự kiện `budget.policy_changed`; tham số `orgUnitId/employeeId/taskId/period` của `/usage` và `period/allTime` của `/dashboard`; đổi tên module màn hình `BudgetPage` → `BudgetSettingsPage`.
7. **Chuyển model/đơn vị của nhân viên** cũng bị kiểm tra `allowed_models` (không chỉ khi chọn model). Nhân viên đã có model nằm ngoài danh sách sau khi chính sách đổi vẫn tồn tại nhưng task của họ bị chặn `MODEL_NOT_ALLOWED` lúc bắt đầu run.
8. **Danh sách phạm vi ở màn hình Budget** lấy từ sơ đồ tổ chức và danh sách nhân viên; Manager vẫn thấy các đơn vị ngoài phạm vi trong sơ đồ và sẽ nhận 403 khi chọn (server là nơi cưỡng chế).

---

## Bằng chứng chạy thật trên PostgreSQL cục bộ (cập nhật 2026-11-10)

Các mục "Chưa chạy" ở T077a, T143a, T163a và US6 ghi rằng máy rà soát không có Docker nên test PostgreSQL chưa chạy. Điều đó **không còn đúng**: `node scripts/test-local.mjs <file>` dựng một cluster PostgreSQL 17 tạm từ bản cài sẵn và chạy được contract, integration, security có DB (không cần Docker). Chạy toàn bộ nhóm contract + integration + security lần đầu:

| Kết quả | Chi tiết |
|---|---|
| 46 file, 551 test pass | gồm toàn bộ test của US1–US6 viết ở các phase trước, được chạy lần đầu |
| 1 test fail, đã sửa | `tests/integration/task-flow.spec.ts` (prompt injection) vẫn kỳ vọng hành vi D6 (`denied`) của US3; từ US4 hành động Human Approval tạo yêu cầu chờ duyệt (`pending_approval`, run `waiting_approval`). Lỗi nằm ở test cũ, không ở mã |
| 3 file bị skip do cách chạy | Chạy các file song song làm `prepareDatabase` đụng nhau khi tạo role cluster-wide. Chạy lại từng file: `budget-core` 10/10, `task-engine` 35/35, `budget-dashboard-scope` 14/14 (sau khi sửa setup test: cơ cấu mẫu không có division cha nên test tự dựng division rồi chuyển Development vào) |
| Không chạy được | `outbox-realtime`, `realtime-propagation`, `realtime-isolation` (cần Redis thật; máy không có), Playwright E2E (cần cả stack), mọi thứ cần Docker |

Từ đây, ghi chú "chưa chạy" cho test DB ở các mục cũ nên đọc là **đã chạy pass** (trừ ba file realtime và E2E). Các migration 0001–0010 đã được áp dụng thật bởi `prepareDatabase` trong các lần chạy này. Lưu ý khi chạy: dùng từng file một, không chạy song song nhiều file DB.

---

## US7 (T176–T185) – Truy vết, xử lý lỗi và phục hồi

**Ngày**: 2026-11-10 | **Phạm vi**: Phase 9 của Spec Kit (US7, ưu tiên P2). Bản ghi kiểm chứng của story, không phải đợt rà soát constitution.

### 1. Trạng thái kiểm chứng

| Hạng mục | Kết quả | Ghi chú |
|---|---|---|
| `tsc --noEmit` mọi tsconfig, `eslint .` | Đạt | |
| Unit test (`vitest --project unit`) | Đạt 415/415 (toàn bộ, gồm US8 và Polish) | mới cho US7: `history-model.spec.ts` (8), `recovery-sweeper.spec.ts` (3) |
| `tests/integration/run-retry.spec.ts` (T176) | Đạt 6/6 | retry theo chính sách, hết lượt → `blocked` `RETRIES_EXHAUSTED` + thông báo `task_error`, lỗi không thể retry, timeout `timed_out`/`TIMEOUT`, thời gian `waiting_approval` không tính vào hạn run, file lần chạy trước còn nguyên ở lần retry |
| `tests/integration/run-recovery.spec.ts` (T177, SC-010) | Đạt 11/11 | run chết → `RUN_INTERRUPTED` + task `blocked`; `resume` giữ cả thay đổi chưa commit; bật `SDK_RESUME_AFTER_CRASH` → `run.resume` và `resume` lỗi vẫn báo lỗi rõ; hành động `dedupe` đã `succeeded` không chạy lại; `executing` không xác định → `unknown` + `TOOL_OUTCOME_UNKNOWN`; run `waiting_approval` qua restart ở cả hai runtime |
| `tests/security/run-history-scope.spec.ts` (T178) | Đạt | danh sách và chi tiết run lọc theo phạm vi, `403` ngoài phạm vi, `404` người ngoài công ty, `run_step`/ledger không chứa secret |
| Giao diện lịch sử (`RunHistoryPage`, `RunDetailPage`, `HistoryPage`) | **Chưa chạy trên trình duyệt** | Chỉ typecheck và `vite build`; logic thuần có unit test |

Worker chết được mô phỏng bằng run `running` quá hạn heartbeat và job biến mất khỏi hàng đợi, không kill tiến trình thật.

### 2. Điểm cần chú ý

1. **Phần lớn US7 đã có từ US3/US4** (heartbeat, timeout, retry, `recoverStaleRuns`). Story này bổ sung `GET /runs`, UI lịch sử, quét phục hồi khi khởi động, DTO và test. T180 và T181 được rà lại, không sửa mã.
2. **Chỉ thị test mới** `[[fake:...;only=execute]]` ở `FakeModelProvider`: kịch bản lỗi chỉ áp cho run thực thi, vì run phân rã của AI Manager đọc cùng `objective` và sẽ hỏng trước khi có run thực thi.
3. **Thông báo `task_error` khi hết lượt** chỉ nêu lý do `RETRIES_EXHAUSTED`; nguyên nhân gốc của từng lần nằm ở run (`error_code`, `error_message`) và hiển thị nổi bật ở trang chi tiết run (SC-011), chưa đưa vào nội dung thông báo.
4. **Mã lỗi riêng của run** (`TIMEOUT`, `PROVIDER_ERROR`, `INVALID_OUTPUT`, `MAX_TURNS`, `TASK_STATE_CHANGED`) không thuộc `ErrorCode` của API nên lịch sử có khóa giải thích riêng (`history.error.*`).
5. **T090 (spike Agent SDK thật) vẫn mở**: chưa xác nhận `resume` sau crash, nên `SDK_RESUME_AFTER_CRASH` giữ mặc định `false`.

---

## US8 (T186–T191) – Cột mốc gamification nhẹ

**Ngày**: 2026-11-10 | **Phạm vi**: Phase 10 của Spec Kit (US8, ưu tiên P3).

### 1. Trạng thái kiểm chứng

| Hạng mục | Kết quả | Ghi chú |
|---|---|---|
| Unit test | Đạt | `milestone-rules.spec.ts` (13), `milestone-model.spec.ts` (3) |
| `tests/contract/gamification-engine.spec.ts` (T186) | Đạt 6/6 | |
| `tests/integration/milestones.spec.ts` (T187) | Đạt 6/6 | First Employee đúng một lần, First Department (division và phòng ban từ cơ cấu mẫu không tính), First Approved Task chỉ khi người thật duyệt, tiêu hàng triệu token không sinh cột mốc nào, phát lại không tạo bản ghi thứ hai |
| Migration `0010_gamification_milestone.sql` | Đã áp dụng thật trong các lần chạy trên | RLS bật qua `enable_company_rls` |
| Màn hình Achievement, thông báo nổi | **Chưa chạy trên trình duyệt** | Chỉ typecheck và `vite build` |

### 2. Quyết định và điểm cần chú ý

1. **First Department không tính phòng ban từ cơ cấu mẫu**: mọi công ty dùng template đã có sẵn các department ngay khi tạo, nên nếu tính thì cột mốc luôn đạt tức thì và vô nghĩa. `org_unit.created` giờ mang cờ `fromTemplate`; chỉ phòng ban người dùng tạo mới được tính. Công ty tạo không dùng template thì phòng ban đầu tiên được tính.
2. **First Approved Task** = chuyển `awaiting_human_approval → completed` (người thật phê duyệt), không phải run hoàn tất hay AI Manager pass.
3. **US8-AS2** được bảo đảm bằng thiết kế: quy tắc là hàm thuần chỉ nhìn loại sự kiện và các trường `kind`, `fromTemplate`, `from`, `to`, nên không có đường đọc token hay thời lượng; có unit test với số liệu cực lớn.
4. `GamificationEngine` được thêm phương thức `list` (ngoài `onDomainEvent`); `milestone.achieved` được ánh xạ ra room công ty cho mọi thành viên.
5. `milestone.achieved` được ghi bằng `ON CONFLICT DO NOTHING`; nếu ghi thất bại giữa chừng, lần phát lại sự kiện nguồn sẽ ghi bù (handler lỗi chỉ được log, không chặn relay).

---

## Polish (T192–T194) và rà soát cấu hình (T196, một phần)

| Hạng mục | Kết quả | Ghi chú |
|---|---|---|
| T192 OpenAPI | Đạt | `/api/v1/docs` và `/api/v1/docs/openapi.json`, không có ở production; test chống lệch với route thật của 13 controller (`openapi.spec.ts`, 15 ca) và test HTTP (`http-hardening.spec.ts`) |
| T193 Rate limit đăng nhập, security headers, CSP | Đạt | `security-http.spec.ts` (13 ca) và `http-hardening.spec.ts` pass; mã lỗi mới `RATE_LIMITED` (429). Bộ đếm nằm trong bộ nhớ từng instance API |
| T194 README | Đạt | |
| Cấu hình Docker (rà soát tĩnh, chưa chạy `docker compose`) | Đã sửa 3 lỗi | xem dưới; `docker-config.spec.ts` (6 ca) giữ chúng khỏi hồi quy |

Ba lỗi cấu hình tìm thấy khi rà soát tĩnh (chưa từng chạy được vì máy không có Docker):
1. `docker/nginx.conf`: `proxy_pass http://api:3000/;` cắt tiền tố `/api/` nên mọi request tới `/api/v1/...` thành `/v1/...` và trả 404.
2. `docker/nginx.conf`: thiếu proxy `/socket.io/` (client Socket.IO dùng đường dẫn mặc định này, không phải `/realtime/`), nên realtime không kết nối được qua web.
3. `docker/docker-compose.yml`: không có bước migration và seed, nên DB mới không có schema. Thêm service `migrate` chạy một lần, api và worker chờ nó hoàn tất.

**T196 chưa xác nhận**: chưa build image và chưa chạy `docker compose up --build`; các sửa trên chỉ được kiểm bằng đọc cấu hình và test văn bản.

---

## T199 – Rà soát Definition of Done của constitution

**Ngày**: 2026-11-10 | **Constitution**: v1.0.1 | Phạm vi: toàn bộ US1–US8.

| Tiêu chí | Kết quả | Bằng chứng |
|---|---|---|
| Mọi action có mức quyền | Đạt | Mọi `ActionType` agent gọi được đều có trong `ACTION_CATALOG`; hành động ngoài danh mục là `restricted`; shell ngoài allowlist là `restricted`. `definition-of-done.spec.ts` (5), `unclassified-actions.spec.ts`, `approval-bypass.spec.ts` |
| Hành động nhạy cảm không thể hạ mức | Đạt | `email.send`, `data.delete`, `deploy.*`, `workspace.git.push` có `floor: human_approval`, đều có adapter dry-run, nhãn `dedupe` |
| Mọi hành vi agent có đo chi phí | Đạt | Mọi lượt model của mọi `purpose` (execute, decompose, review, synthesize) đi qua `RunExecutor.onModelCall`: `BudgetService.commit` ghi `usage_ledger` và phát `usage.updated`; reserve trước khi tiêu; test `budget-enforcement`, `dashboard-usage` pass |
| Mọi hành vi agent có logging | Đạt | Mỗi lượt model là một `run_step`; mọi lời gọi tool (kể cả bị từ chối) là `run_step` + `tool_invocation`; secret được che trước khi lưu (`run-history-scope.spec.ts`); logger JSON che secret |
| Không vi phạm lint ranh giới engine | Đạt | `eslint .` sạch, gồm `no-restricted-imports` giữa các engine, worker không import schema bảng, chỉ `model-gateway/providers` import `@anthropic-ai/*` (kiểm thêm bằng quét mã trong `definition-of-done.spec.ts`) |
| Bản sửa lỗi có regression test | Đạt | Các lỗi tìm thấy trong đợt này (test D6 cũ, nginx, compose) đều có test giữ (`task-flow.spec.ts`, `security-http.spec.ts`, `docker-config.spec.ts`) |
| Review bởi người khác tác giả | **Chưa kiểm chứng được** | Đây là quy trình pull request (`CONTRIBUTING.md`); repo chưa có PR nào để đối chiếu |

---

## T200 – Đối chiếu kết quả rà soát T077a, T143a, T163a

**Ngày**: 2026-11-10. **Kết luận: chưa thể xác nhận "mọi điểm đã được xử lý trước khi phát hành"**; còn các điểm mở dưới đây, nên T200 giữ trạng thái chưa xong.

| Điểm từ rà soát cũ | Trạng thái |
|---|---|
| Chạy contract/integration/security trên PostgreSQL (T077a, T143a, T163a, US6) | **Đã xử lý**: 551 test pass trong lần chạy đầu, 1 test cũ đã sửa (xem mục "Bằng chứng chạy thật") |
| Áp dụng migration 0005, 0007, 0008, 0009 | **Đã xử lý**: áp dụng thật bởi `prepareDatabase` (cả 0010) |
| Hồi quy của mọi test dùng `createFlowHarness` sau khi thêm bộ chiếu office và đổi `TaskScheduler` (T163a, US6) | **Đã xử lý**: các test này chạy pass |
| Chạy 3 test cần Redis (`outbox-realtime`, `realtime-propagation`, `realtime-isolation`) | **Mở**: máy không có Redis |
| Chạy E2E Playwright (Q1–Q12) | **Mở**: cần cả stack |
| Mở Virtual Office trên trình duyệt, kiểm tra bằng mắt, đo ~60 fps, SC-005 ≤ 3 giây p95 (T163a mục 3.1, 3.8) | **Mở** (T195) |
| T088 (6 ca trên container thật), T111/T111a (build và chạy `sandbox-runner`, `egress-proxy`), T131 (E2E duyệt) | **Mở**: cần Docker/trình duyệt |
| T090 (spike Agent SDK thật), kể cả quyết định bật `SDK_RESUME_AFTER_CRASH` | **Mở**: cần `ANTHROPIC_API_KEY` |
| Rà soát T244 (US9) | **Đã xử lý**: không có vi phạm Nguyên tắc I–VIII; điểm theo dõi còn lại ghi ở mục T244 |
| Đối chiếu lại giá model (T077a mục 3.1) trước khi dùng số liệu chi phí | **Mở**: chưa đối chiếu với trang giá chính thức |
| Chi phí `EmployeeEngine.get` trên đường nóng (T077a 3.2) | **Mở, chưa đo**; chưa có dấu hiệu chậm trong test |
| Khóa phạm vi theo công ty của `TaskScheduler` (US6 3.2), nhật ký `employee_status_change` chưa dọn, chiếu office lần đầu chậm (T163a 3.6, 3.7) | **Chấp nhận ở v1.0**, theo dõi khi tăng quy mô |
| Yêu cầu bị hủy khi task rời In Progress, mở rộng interface ngoài D4 | **Đã xử lý**: đã ghi vào data-model và contracts |

---

## US9 (T205–T243) – Kiểm chứng CEO AI Assistant

**Ngày**: 2026-11-10 | **Phạm vi**: Phase 9a của Spec Kit (US9, ưu tiên P2) cùng bổ sung FR-016a (tự tạo AI Manager cho Team).

### 1. Trạng thái kiểm chứng

| Hạng mục | Kết quả | Ghi chú |
|---|---|---|
| `tsc --noEmit` mọi tsconfig (gốc, api, worker, web, 4 package), `eslint .` | Đạt | đợt này sửa thêm 1 lỗi `require-yield` (`assistantOps` của `FakeModelProvider` không có `yield`, đổi thành hàm `async` thường) và 1 lỗi kiểu của `makeTask` (thiếu `proposalStatus`) đã có sẵn từ trước |
| Unit test (`vitest --project unit`) | Đạt 453/453 | gồm `company-ops-catalog.spec.ts` (T205), `company-ops-tool-specs.spec.ts` (T206), `office-reducer`/`office-layout` (T210), `definition-of-done`, `openapi` |
| `tests/contract/ceo-assistant-employee.spec.ts` (T207) | Đạt 9/9 | |
| `tests/contract/task-draft-proposal.spec.ts` (T208) | Đạt 6/6 | |
| `tests/contract/company-ops.spec.ts` (T209) | Đạt 7/7 | |
| `tests/integration/ceo-assistant.spec.ts` (T211) | Đạt 7/7 | AS1, AS2, AS3, AS4, AS8 |
| `tests/integration/ceo-assistant-operations.spec.ts` (T212) | Đạt 14/14 | AS5 (cả ba hành động Human Approval, `ORG_UNIT_NOT_EMPTY`, `email.send` qua dry-run), tạm ngưng giữa chừng, worker restart, SC-017, ngân sách (chặn, cảnh báo 80%, `org_unit_id` null), đối tượng ngoài phạm vi |
| `tests/security/ceo-assistant-boundary.spec.ts` (T213, SC-015) | Đạt 26/26 | gồm lớp HTTP (Manager `403`, `via` bị bỏ qua) |
| `tests/contract/employee-engine.spec.ts` (T202) | Đạt 31/31 | 6 ca mới cho `provisionTeamManager` |
| `tests/integration/task-decomposition.spec.ts` (T202) | Đạt 18/18 | 6 ca mới cho FR-016a |
| E2E Q14–Q18 (T214), chạy thủ công Q1–Q18 (T197) | **Không làm** | quyết định bỏ qua e2e/test thủ công để giảm chi phí (constitution v1.1.0, mục Kiểm thử) |

Mọi test DB chạy bằng `node scripts/test-local.mjs <file>` (từng file một). Worker chết ở T212 được mô phỏng như T177 (run `running` quá hạn heartbeat, job mất khỏi hàng đợi) nhưng sau khi đã có một thao tác ghi `succeeded` trong ledger; chưa kill tiến trình thật.

### 2. Điểm cần chú ý khi chạy test (phát hiện lúc viết T212/T213/T202)

1. **`ToolBroker` khóa run sau lời gọi chờ duyệt**: sau khi một tool trả `pending_approval`, mọi tool khác của run đó trả `run_locked` (kể cả tool chỉ đọc). Đúng thiết kế (run dừng chờ duyệt) nên test kiểm 100% hành động Human Approval dùng một run riêng cho mỗi hành động và còn khẳng định run bị khóa.
2. **Engine không tự kiểm quyền Manager ở `suspend`/`update`**: quyền được cưỡng chế ở controller bằng `@RequireScope` (như mọi engine khác); riêng `getCeoAssistant` kiểm tra trong engine. Vì vậy ca "Manager nhận 403" của T213 nằm ở lớp HTTP, không phải gọi engine trực tiếp.
3. **Công ty không còn CEO hoạt động thì không ai nhận được thông báo**: ca FR-016a "không có người thật hợp lệ" vẫn `blocked`/`NO_AI_MANAGER` nhưng không có notification `escalation` (bộ định tuyến ghi log lỗi "Công ty không có CEO đang hoạt động để nhận thông báo"). Ca `allowed_models` chặn model của mẫu `ai_manager` thì có `escalation`.

---

## T244 – Rà soát constitution khi thêm User Story 9

**Ngày rà soát**: 2026-11-10 | **Constitution**: v1.1.0 | **Căn cứ**: mục Governance → "Rà soát tuân thủ". **Phạm vi**: CEO AI Assistant (FR-046–FR-049), các tool điều hành, `InternalOpsAdapter`, run `propose` và bổ sung FR-016a.

### 1. Đối chiếu Nguyên tắc liên quan

| Nguyên tắc | Điểm rà soát | Bằng chứng | Kết luận |
|---|---|---|---|
| I. Công việc thật | Thao tác điều hành thay đổi dữ liệu thật qua interface engine; `org.archive`, `employee.archive`, `task.cancel` thực thi thật sau khi duyệt (`adapter_mode = internal`, không nhãn "dry-run"). Báo cáo của trợ lý chỉ lấy từ kết quả `company.query`, khớp `/dashboard` và `/usage`. Khi yêu cầu chưa rõ, trợ lý hỏi lại bằng `task_message` và không thay đổi dữ liệu. Không có chat độn | `ceo-assistant-operations.spec.ts` (AS5, SC-017), `ceo-assistant.spec.ts` (AS8) | Phù hợp |
| II. Con người lãnh đạo (NON-NEGOTIABLE) | (a) **Một đường quyền duy nhất**: mọi lời gọi đi qua `ToolBroker` → `PermissionEngine`; `via` chỉ chú thích audit (không có tham chiếu `via` nào trong `engines/permission/`), request HTTP không đặt được `via`. (b) **Trợ lý không là reviewer hay approver**: reviewer là AI Manager độc lập (`kind = manager`) còn trợ lý bị ép `kind = employee`; người duyệt luôn là người thật và `decideApproval` với ngữ cảnh AI bị từ chối. (c) **Không tự nâng quyền**: `approval.decide`, `budget.update`, `policy.update`, `employee.grant_tools`, `member.manage`, `task.decide`, `task.resume` là `restricted` có tên riêng trong ledger; input tool strict, không nhận `toolGrants`/`modelId`/`managerId`; `employee.create` từ chối mẫu `ceo_assistant`. (d) **Human Approval** cho `org.archive`, `employee.archive`, `task.cancel`, `email.send` bị giữ kể cả khi nội dung task, tin nhắn, kết quả tool ép bỏ qua. (e) Task trợ lý tạo ở `draft` nếu tiêu chí không trích nguyên văn lời CEO; `created_by_member_id` vẫn là CEO. (f) Chuỗi quản lý: manager của trợ lý là CEO | `ceo-assistant-boundary.spec.ts` (26 ca), `company-ops.spec.ts` (C1, C3, C6), `ceo-assistant-employee.spec.ts`, `company-ops-catalog.spec.ts`, `company-ops-tool-specs.spec.ts` | Phù hợp |
| III. Tổ chức, cô lập | Trợ lý nằm ngoài `ManagedScope` của Manager thường: Manager nhận `403` ở mọi route `/ceo-assistant` và không thấy trợ lý ở danh sách nhân viên, Virtual Office, Dashboard theo phạm vi; đối tượng công ty khác → `NOT_FOUND` và không bị tác động chéo công ty. `usage_ledger.org_unit_id` null, bộ lọc `orgUnitId` bỏ qua dòng này nhưng tổng toàn công ty vẫn tính | `ceo-assistant-boundary.spec.ts` (HTTP và chéo công ty), `ceo-assistant-operations.spec.ts` | Phù hợp |
| V. Chi phí và năng lực | Ngân sách áp dụng cho trợ lý như mọi nhân viên, không có ngoại lệ: hết ngân sách → task `blocked`/`BUDGET_EXCEEDED` + thông báo `budget_blocked`, không chi tiêu nào xảy ra ở lần chạy bị chặn; ngưỡng 80% cảnh báo đúng một lần; run `propose` không chiếm slot `max_concurrent_tasks`; `ASSISTANT_MAX_OPS_PER_RUN` giới hạn thao tác ghi | `ceo-assistant-operations.spec.ts` (US9-AS7), `company-ops.spec.ts` (C6), `task-draft-proposal.spec.ts` | Phù hợp |
| VI. Độc lập model, tách engine | **Không thêm engine mới** (`apps/api/src/engines/` vẫn chín module). `company-ops.ts` chỉ nhận `Pick` từ interface engine và `DashboardReader`, không import schema bảng; lint ranh giới đạt. Run `propose` và `execute` đi qua `ModelGateway`; không import `@anthropic-ai/*` ngoài `providers/` | `eslint .` đạt, `definition-of-done.spec.ts` | Phù hợp |
| VII. Bằng chứng, tin cậy, quan sát | Mọi lời gọi tool (cả bị từ chối) có `tool_invocation` và `run_step`; `domain_event.payload.actingVia = { employeeId, runId, taskId }` có ở mọi thay đổi do trợ lý thực hiện và vắng ở thao tác của người dùng. Chống lặp: nhóm `dedupe` không tạo trùng khi resume/retry; `InternalOpsAdapter.lookup` coi đối tượng đã lưu trữ/hủy là `succeeded`. Worker restart giữa chuỗi: thao tác `succeeded` không lặp, `GET /tasks/{id}/operations` cho biết trạng thái từng thao tác để `resume` hoặc `cancel`. Task của trợ lý vẫn qua review độc lập của AI Manager và phê duyệt của CEO | `company-ops.spec.ts`, `ceo-assistant-operations.spec.ts`, `ceo-assistant.spec.ts` (AS2) | Phù hợp |
| VIII. Tăng dần, MVP | Trợ lý thuộc Phase 2 (spec ghi rõ: chỉ là một mẫu AI Employee bổ sung, YAGNI). Không chạy theo lịch, không Daily Report, không Project, không thông báo ngoài ứng dụng (các tên này bị `restricted`, có test); không thêm XP/Level. FR-016a chỉ tạo AI Manager khi giao cho Team, không tạo cho task giao trực tiếp hay bước chọn reviewer | `ceo-assistant-boundary.spec.ts`, `task-decomposition.spec.ts` (T202) | Phù hợp |

**Ràng buộc công nghệ và quy trình**: không thêm dependency; không secret trong payload hay ledger; hai biến cấu hình mới (`ASSISTANT_DEFAULT_DEADLINE_HOURS`, `ASSISTANT_MAX_OPS_PER_RUN`) có trong `config.ts`, `docker/.env.example` và README; mọi `ActionType` mới có mức quyền trong `ACTION_CATALOG` (Definition of Done).

### 2. Điểm cần chú ý và theo dõi

1. **Quyền Manager chỉ được cưỡng chế ở controller** (mục 2.2 của phần US9 phía trên): nếu sau này có đường gọi engine không qua controller (job, script), đường đó phải tự kiểm quyền. Hiện chỉ worker gọi engine, với ngữ cảnh `system` hoặc ngữ cảnh CEO + `via` do `delegatedContext` dựng từ dữ liệu hệ thống.
2. **An toàn của ngữ cảnh "thay mặt CEO" dựa hoàn toàn vào `delegatedContext`**: điều kiện C1 (nhân viên của run là `ceo_assistant` đang `active`, là assignee của task, task do CEO đang hoạt động tạo). Đã có test cho từng vế và cho trường hợp tạm ngưng giữa chừng; mọi tool điều hành mới phải đi qua guard C1.
3. **Hành động Human Approval nhắm vào đối tượng công ty khác**: test T213 chỉ khẳng định kết quả cuối (đối tượng không bị đổi dù yêu cầu được duyệt); chưa khẳng định yêu cầu duyệt có được tạo ra hay không. Nếu muốn người duyệt không phải xem yêu cầu vô nghĩa thì cần kiểm tra đối tượng ngay lúc đề xuất.
4. **Chưa kiểm chứng với model thật**: mọi test dùng `FakeModelProvider`. Hành vi thật của model trước prompt injection, chất lượng đề xuất của run `propose` và độ lệch ≤ 1% của báo cáo do model viết (SC-017) cần đo khi có `ANTHROPIC_API_KEY` (T090, T198).
5. **Bước "review bởi người khác tác giả"** (constitution, mục Review) chưa kiểm chứng được vì repo chưa có PR.

### 3. Kết luận

Không phát hiện vi phạm Nguyên tắc I–VIII ở phạm vi US9, và constitution v1.1.0 vẫn phản ánh đúng thực tế sản phẩm nên **không cần sửa đổi**. Các điều kiện mở còn lại là những điều kiện đã ghi ở T200 (Redis, Docker, `ANTHROPIC_API_KEY`, người dùng thật) cộng với điểm 4 và 5 ở trên.
| T197 (chạy thủ công Q1–Q12), T198 (thử với ≥ 10 người, SC-001, SC-013) | **Mở**: cần người và trình duyệt |
