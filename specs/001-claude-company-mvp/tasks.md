---

description: "Danh sách task triển khai Claude Company v1.0 (MVP)"
---

# Tasks: Claude Company v1.0 (MVP) – Công ty AI ảo vận hành thật

**Input**: Design documents from `/specs/001-claude-company-mvp/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Phase (Lộ trình MVP)**: Phase 1 + Phase 2 + Phase 3. "Phase N" trong file này là giai đoạn triển khai của Spec Kit, không phải phase của lộ trình sản phẩm.

**Tests**: Có. Constitution (mục "Kiểm thử") bắt buộc test tự động cho phân quyền, phê duyệt, giới hạn ngân sách, cô lập tenant, lan truyền trạng thái, và contract test cho mọi interface engine cùng lớp model. Viết test trước, xác nhận FAIL rồi mới triển khai.

**Organization**: Task nhóm theo user story để triển khai và kiểm thử độc lập từng story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Chạy song song được (khác file, không phụ thuộc task chưa xong)
- **[Story]**: User story của task (US1…US8)
- Mọi mô tả đều có đường dẫn file chính xác

## Path Conventions

Monorepo pnpm: `apps/api/src/`, `apps/worker/src/`, `apps/web/src/`, `packages/{contracts,policy,db,model-gateway}/src/`, `tests/{contract,integration,security,e2e}/`, `docker/`. Test đơn vị đặt trong `test/` của từng package/app. Tên package: `@claude-company/<tên>`.

## Quyết định chốt khi sinh tasks

Tài liệu thiết kế để hở hoặc mâu thuẫn ở các điểm dưới đây. Các quyết định này đã được ghi vào spec, contracts, data-model và research (T012).

| # | Vấn đề | Quyết định mặc định |
|---|---|---|
| D1 | FR-020a và data-model không có cạnh cho quyết định `reject` của Human Manager | `reject` ghi `review_record` rồi đi cạnh `block` có sẵn: task sang `blocked`, `blocked_from = in_progress`, `blocked_reason = HUMAN_REJECTED` (lý do nằm ở `review_record`); người quản lý chọn `resume` (run mới nhận lý do từ chối, không approve lại được) hoặc `cancel`. Không thêm cạnh mới, không tự chạy lại tốn token. Tính là một vòng vào `rework_count`. Reject chạm `MAX_REWORK` vẫn giữ `HUMAN_REJECTED`, không gửi `escalation` vì người quyết định đã là người thật; `resume` đặt `rework_baseline = rework_count` khi `rework_count - rework_baseline ≥ MAX_REWORK`. |
| D2 | Contract yêu cầu `seq` liên tục (`seq ≠ last + 1` là mất sự kiện), nhưng nhiều `domain_event` không có envelope trên room công ty, và một event có thể sinh nhiều envelope | Mỗi `domain_event.seq` phát ≥ 1 envelope trên room `company:{id}`. Event không có payload công khai hoặc không đổi trạng thái phát `sync.seq_advanced {}`. Nhiều envelope được dùng chung `seq`. Client chỉ coi `seq > last + 1` là mất sự kiện, bỏ qua kiểm tra liên tục trên room `user:{id}`. |
| D3 | RLS chặn các truy vấn chưa có `app.company_id`: `/auth/me`, relay outbox, sweeper | Policy `human_member` và `company` cho phép thêm theo `app.user_id`. Mỗi hàm `SECURITY DEFINER` chỉ trả `company_id` và chỉ đọc bảng của một engine; worker lấy danh sách công ty qua interface của engine sở hữu bảng (D4), rồi xử lý từng công ty trong `withTenant`. Role ứng dụng vẫn không có `BYPASSRLS`. |
| D4 | Interface engine thiếu thao tác cần dùng | Thêm `EmployeeEngine.addHumanMember/listHumanMembers/findMemberships/deactivateHumanMember`, `TaskEngine.getStats`, `TaskEngine.markOverdue`, `TaskEngine.listCompaniesWithOpenTasks`, `PermissionEngine.remindPendingApprovals`, `PermissionEngine.listCompaniesWithPendingApprovals`, `OrchestrationEngine.listExecutedActions`, `BudgetService.getUsage`; interface mới `ModelCatalog`, `IdentityDirectory`; `TaskEngine.list` lọc được theo `assigneeKind, assigneeId, statusIn`. |
| D5 | Chưa định nghĩa ai review khi manager trực tiếp của nhân viên là người thật (kịch bản Q3) | Thứ tự chọn reviewer AI: manager AI trực tiếp → AI Manager cùng `home_org_unit_id` → AI Manager bất kỳ đang `active` trong công ty; luôn `reviewer_id ≠` người thực thi. Không có → `blocked`, `blocked_reason = NO_INDEPENDENT_REVIEWER`, notification `escalation`. |
| D6 | US4 phải có trước khi AI chạy việc thật, nhưng US3 được xếp trước US4 | Danh mục quyền, `evaluate` và parser shell nằm ở Phase 2. Từ US3 đến khi xong US4, `ToolBroker` từ chối (fail-closed) mọi hành động `human_approval`. |

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Khởi tạo monorepo, công cụ build/test và môi trường Docker

- [x] T001 Khởi tạo git (`git init`) và tạo monorepo pnpm ở gốc repo: `package.json` (scripts `dev`, `lint`, `db:migrate`, `db:seed`, `test:unit`, `test:contract`, `test:integration`, `test:security`, `test:e2e`), `pnpm-workspace.yaml` (`apps/*`, `packages/*`), `.nvmrc` (Node 24), `.gitignore` (`node_modules`, `dist`, `.env`, `docker/.env`, dữ liệu MinIO/Postgres local)
- [x] T002 Tạo `tsconfig.base.json` ở gốc repo với `strict: true`, `noUncheckedIndexedAccess: true`, path alias `@claude-company/*`
- [x] T003 [P] Tạo khung bốn package `packages/contracts`, `packages/policy`, `packages/db`, `packages/model-gateway` (mỗi package có `package.json`, `tsconfig.json`, `src/index.ts`); thêm dependency Zod vào `packages/contracts/package.json`, Drizzle + `pg` vào `packages/db/package.json`
- [x] T004 [P] Tạo khung NestJS 11 trong `apps/api/package.json`, `apps/api/src/main.ts`, `apps/api/src/app.module.ts`, và `apps/api/src/index.ts` export các module engine + platform để worker dùng lại
- [x] T005 [P] Tạo khung worker trong `apps/worker/package.json`, `apps/worker/src/main.ts`, `apps/worker/src/worker.module.ts` dùng `NestFactory.createApplicationContext` và import module engine qua `@claude-company/api`
- [x] T006 [P] Tạo khung web trong `apps/web/package.json`, `apps/web/vite.config.ts`, `apps/web/src/main.tsx` với React 19, React Router, TanStack Query, PixiJS 8, `socket.io-client`
- [x] T007 [P] Cấu hình lint trong `eslint.config.mjs` với `no-restricted-imports`: chỉ `packages/model-gateway/src/providers/**` được import `@anthropic-ai/*`; engine không import file nội bộ của engine khác (chỉ qua `@claude-company/contracts`) và chỉ import schema bảng do mình sở hữu; `apps/worker/**` không import schema bảng, chỉ gọi interface engine; chỉ `apps/api/src/platform/auth/**` được import schema `auth.ts`; chỉ `apps/web/src/office/renderer-pixi/**` được import `pixi.js`; thêm `.prettierrc`
- [x] T008 [P] Cấu hình test trong `vitest.config.ts` (projects `unit`, `contract`, `integration`, `security`) và `playwright.config.ts` (`MODEL_PROVIDER=fake`)
- [x] T009 [P] Tạo tiện ích test trong `tests/support/containers.ts` (Testcontainers PostgreSQL 16, Redis 7, MinIO)
- [x] T010 [P] Tạo `docker/docker-compose.yml` (api, worker, web, postgres:16, redis:7, minio, volume dữ liệu dry-run, volume `run_worktrees`; `sandbox-runner` và `egress-proxy` do T111, T111a thêm) và `docker/.env.example` với `ANTHROPIC_API_KEY`, `SESSION_SECRET`, `WORKSPACE_HOST_PATH`, `MODEL_PROVIDER=anthropic|fake`, `ADAPTER_MODE=dry_run`, `BUDGET_WARN_THRESHOLD=0.8`, `MAX_REWORK=3`, `RUN_TIMEOUT_MS=900000`, `RETRY_MAX=3`, `DEFAULT_MONTHLY_COST_LIMIT_USD=20`, `DEFAULT_MONTHLY_TOKEN_LIMIT=2000000`, `SDK_BUDGET_HEADROOM=0.1`, `SDK_RUN_RESERVE_USD=2`, `SDK_RUN_RESERVE_TOKENS=200000`, `SDK_RESUME_AFTER_CRASH=false`, `ARTIFACT_CONTEXT_MAX_BYTES=200000`, `EGRESS_PROXY_URL`, `SANDBOX_RUNNER_URL`, `SANDBOX_RUNNER_TOKEN`, `DATABASE_URL` (role `app_user`), `DATABASE_MIGRATION_URL` (role owner), `APP_DB_PASSWORD`, `REDIS_URL`, `S3_*` (chỉ giá trị mẫu, không có secret thật)
- [x] T011 [P] Tạo `docker/Dockerfile.api`, `docker/Dockerfile.worker`, `docker/Dockerfile.web` dạng multi-stage, chạy bằng user không phải root; `Dockerfile.worker` cài thêm `git`
- [x] T011a [P] Tạo `.github/pull_request_template.md` với các mục xác nhận: đã được người khác tác giả review, tuân thủ Nguyên tắc I–VIII, action mới đã có mức quyền, hành vi agent mới có đo chi phí và logging, bản sửa lỗi có regression test; ghi quy trình review vào `CONTRIBUTING.md`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Hợp đồng dùng chung, tenancy + RLS, xác thực, chính sách quyền, outbox/realtime

**⚠️ CRITICAL**: Không user story nào được bắt đầu trước khi phase này xong

### Hợp đồng dùng chung

- [x] T012 Cập nhật `specs/001-claude-company-mvp/contracts/engine-interfaces.md`, `specs/001-claude-company-mvp/contracts/realtime-events.md`, `specs/001-claude-company-mvp/data-model.md`, `specs/001-claude-company-mvp/research.md` để ghi các quyết định D1–D6 ở đầu file này (`spec.md` đã ghi D1, D5 tại FR-020a, FR-018)
- [x] T013 [P] Khai báo `RequestContext`, `ScopeRef`, `MemberRef`, `ManagedScope`, `Page<T>` trong `packages/contracts/src/common.ts` và toàn bộ mã lỗi nghiệp vụ trong `packages/contracts/src/errors.ts` (`ORG_UNIT_NOT_EMPTY`, `TEAM_NOT_EMPTY`, `MANAGER_REQUIRED`, `MANAGEMENT_CHAIN_INVALID`, `MODEL_NOT_ALLOWED`, `EMPLOYEE_HAS_OPEN_TASKS`, `TASK_FIELDS_REQUIRED`, `ASSIGNEE_OUT_OF_SCOPE`, `TASK_INVALID_TRANSITION`, `EVIDENCE_INCOMPLETE`, `REVIEWER_NOT_INDEPENDENT`, `DEPENDENCY_CYCLE`, `NO_SUITABLE_ASSIGNEE`, `NO_AI_MANAGER`, `APPROVAL_PAYLOAD_CHANGED`, `NO_INDEPENDENT_REVIEWER`, `EMPLOYEE_SUSPENDED`, `ADAPTER_LIVE_NOT_CONFIGURED`, `HUMAN_REJECTED`, `MAX_REWORK_REACHED`, `SUBTASK_CANCELLED`, `RUN_INTERRUPTED`, `BUDGET_EXCEEDED`, `RETRIES_EXHAUSTED`, `TOOL_OUTCOME_UNKNOWN`, `FORBIDDEN`)
- [x] T014 Khai báo interface `OrganizationEngine`, `EmployeeEngine`, `TaskEngine`, `OrchestrationEngine`, `PermissionEngine`, `BudgetService`, `OfficeSimulationEngine`, `CommunicationEngine`, `MemoryEngine`, `GamificationEngine`, `ModelCatalog`, `IdentityDirectory`, `ToolAdapter` đúng `contracts/engine-interfaces.md` (đã bổ sung D4) trong `packages/contracts/src/engines.ts`. DTO do story sau khai báo (`EmployeeProfile` T067, Task và `DecompositionPlan` T096, Approval T133, `OfficeSnapshot` T152, Budget T167, Run T179) được tạo trước dưới dạng type khung trong đúng file đích để package biên dịch được; story tương ứng thay bằng Zod schema
- [x] T015 [P] Khai báo `RealtimeEnvelope<T>`, Zod schema từng loại sự kiện trong `contracts/realtime-events.md` và `sync.seq_advanced` trong `packages/contracts/src/realtime.ts`

### Chính sách quyền (viết test trước)

- [x] T016 [P] Viết unit test trong `packages/policy/test/evaluate.spec.ts`: mức hiệu lực = max(floor, mọi policy theo scope), thứ tự `auto_execute < review_required < human_approval < restricted`; policy không hạ được floor; action ngoài danh mục → `restricted`; action không thuộc `tool_grants` → `restricted`; `input` chứa văn bản ép bỏ qua phê duyệt không đổi kết quả
- [x] T017 [P] Viết unit test trong `packages/policy/test/shell-classifier.spec.ts`: `git push` → `workspace.git.push`; lệnh trong allowlist → `workspace.shell`; mọi lệnh ngoài allowlist → `restricted`, gồm `rm`, `git clean`, `git reset --hard`, `find -delete`, `psql`, `npm publish`, `python -c`, `node -e`, `ssh`, `scp`, `curl`, `wget`, `nc`, mail CLI, `kubectl`, `docker push`, `terraform apply`; subshell lồng phức tạp và chuỗi base64 thực thi → `restricted`; lệnh ẩn sau `&&`, `;`, `|`, `$(...)` vẫn bị phát hiện
- [x] T018 [P] Tạo danh mục `ActionType` trong `packages/policy/src/catalog.ts` đúng từng dòng bảng `contracts/action-policy.md` (mặc định, floor, runtime): `workspace.read`, `workspace.search`, `workspace.test.run`, `artifact.publish`, `task.message.post`, `task.decompose.propose` = auto_execute; `workspace.write`, `workspace.shell` = review_required; `email.send`, `data.delete`, `deploy.staging`, `deploy.production`, `workspace.git.push` có floor human_approval; `network.fetch` = restricted; mỗi action có nhãn chống lặp `dedupe` hoặc `rerun`
- [x] T019 Triển khai hàm thuần `evaluatePermission` trong `packages/policy/src/evaluate.ts`; chữ ký chỉ nhận `{ actionType, toolGrants, policies, input }`, không có tham số nào mang nội dung prompt/task/tin nhắn (phụ thuộc T018)
- [x] T020 Triển khai `classifyShellCommand` trong `packages/policy/src/shell-classifier.ts` theo allowlist `packages/policy/src/shell-allowlist.ts` đúng `contracts/action-policy.md`, bằng parser AST (ưu tiên `mvdan-sh`, thay bằng `tree-sitter-bash` nếu gói không còn bảo trì), không chỉ dùng regex; không phân tích được → `restricted`

### Database và tenancy

- [x] T021 Tạo kết nối Drizzle trong `packages/db/src/client.ts` và `withTenant(companyId, fn)` trong `packages/db/src/with-tenant.ts`: mở transaction và `SET LOCAL app.company_id` (kèm `app.user_id` nếu có)
- [x] T022 [P] Tạo helper cột chung trong `packages/db/src/schema/_columns.ts`: `id uuid` (UUIDv7) khóa chính, `company_id uuid NOT NULL`, `created_at`, `updated_at`
- [x] T025 Tạo migration thủ công đầu tiên bằng `drizzle-kit generate --custom --name=roles_rls` (`packages/db/migrations/0000_roles_rls.sql`, làm trước T023): role `app_user` không có `BYPASSRLS`; helper bật RLS + `FORCE ROW LEVEL SECURITY` với policy `company_id = NULLIF(current_setting('app.company_id', true), '')::uuid`. Migration này chỉ tạo role và helper, không tạo policy cho bảng cụ thể vì chưa có bảng nào. Các hàm `SECURITY DEFINER` chỉ trả `company_id` (D3) được tạo trong migration của bảng mà chúng đọc: T024, T091, T092, T132. Mọi migration về sau phải bật RLS cho bảng nghiệp vụ mới
- [x] T023 Tạo schema trong `packages/db/src/schema/organization.ts` (bảng `company`: `name` text "1–120 ký tự", `timezone` "mặc định `Asia/Ho_Chi_Minh`", `template_key` text?, `archived_at` timestamptz?), `packages/db/src/schema/auth.ts` (bảng `user` do `platform/auth` sở hữu: `email` "unique, lowercase", `password_hash` argon2id, `display_name`, `disabled_at`) và `packages/db/src/schema/employee.ts` (bảng `human_member`: `user_id` với `UNIQUE(company_id, user_id)`, `role` enum `ceo`,`manager`, `title` text?, `disabled_at` timestamptz?); sinh migration kèm RLS theo D3, gồm policy bổ sung theo `app.user_id` cho `human_member`, `company` và policy `company` theo `id = app.company_id` để `createCompany` tạo bản ghi đầu tiên (`user` là bảng toàn cục)
- [x] T024 Tạo schema `domain_event` trong `packages/db/src/schema/events.ts`: `seq bigint` "tăng dần theo company" với `UNIQUE(company_id, seq)`, `type`, `aggregate_kind`, `aggregate_id`, `payload jsonb`, `occurred_at`, `published_at?`; sinh migration kèm RLS và hàm `SECURITY DEFINER` `list_companies_with_unpublished_events()`
- [x] T026 Tạo `packages/db/drizzle.config.ts`, `packages/db/src/migrate.ts` (chạy bằng role owner qua `DATABASE_MIGRATION_URL`, đặt mật khẩu `app_user` từ `APP_DB_PASSWORD`) và `packages/db/src/seed.ts` (idempotent), nối vào scripts `db:migrate`, `db:seed`

### Test nền tảng

- [x] T009a Tạo tiện ích test phụ thuộc hợp đồng: `tests/support/fake-engines.ts` (fake `EmployeeEngine`, `TaskEngine` có dữ liệu cấu hình được), `tests/support/factories.ts` (company, member, session), `tests/support/app.ts` (bootstrap api + worker, nhận `ModelGateway` qua tham số; T098 đăng ký `FakeModelProvider`)
- [x] T027 [P] Viết `tests/security/tenant-isolation.spec.ts`: với role `app_user`, truy vấn không có `WHERE` chỉ trả dữ liệu công ty hiện tại; không đặt `app.company_id` → 0 dòng; quét `information_schema` xác nhận mọi bảng có `company_id` đều bật RLS + FORCE; API từ chối khởi động khi `DATABASE_URL` dùng role superuser hoặc có `BYPASSRLS` (SC-012)
- [x] T028 [P] Viết `tests/security/authn-coverage.spec.ts`: tự liệt kê mọi route từ NestJS router, mọi route trừ `/auth/register`, `/auth/login` trả `401` khi chưa đăng nhập; mọi request POST/PUT/PATCH/DELETE thiếu `X-CSRF-Token` bị từ chối, trừ `/auth/register`, `/auth/login`; không thành viên gọi `/companies/{cid}/...` nhận `404`, kiểm tra qua route thử `tests/support/tenant-probe.controller.ts` chỉ đăng ký khi test (FR-028, FR-030); mọi route dưới `/companies/{cid}` phải có metadata `@RequireScope` hoặc `@MemberScope`, thiếu thì test fail; `ScopeGuard` nhận được `RequestContext` và đọc được dữ liệu dưới RLS: thành viên trong phạm vi → `2xx`, thành viên ngoài phạm vi → `403`
- [x] T029 [P] Viết `tests/integration/auth.spec.ts`: đăng ký, đăng nhập, đăng xuất, `/auth/me` trả membership + `csrfToken`; cookie `cc_sid` có `HttpOnly; Secure; SameSite=Lax`; session bị thu hồi sau logout

### Platform API

- [x] T030 Tạo cấu hình kiểm tra bằng Zod trong `apps/api/src/platform/config/config.ts` với mặc định R13: cảnh báo 80%, làm lại 3 vòng, retry 3 lần backoff 2s→30s, timeout run/model/tool 15 phút/2 phút/5 phút, nhắc duyệt sau 1 giờ rồi mỗi 24 giờ, hạn mức công ty mặc định 20 USD và 2.000.000 token mỗi tháng, headroom `maxBudgetUsd` 10%, `SDK_RESUME_AFTER_CRASH` mặc định false, reservation mỗi run SDK 2 USD và 200.000 token, trần nội dung artifact đưa vào ngữ cảnh 200.000 byte (`ARTIFACT_CONTEXT_MAX_BYTES`); thiếu biến bắt buộc thì không khởi động; kiểm tra `rolsuper`, `rolbypassrls` của role đang kết nối và không khởi động nếu một trong hai là true
- [x] T031 [P] Tạo logging có cấu trúc và OpenTelemetry trace id trong `apps/api/src/platform/observability/observability.module.ts`; che secret trong log
- [x] T032 [P] Tạo exception filter trong `apps/api/src/platform/http/error.filter.ts` theo format `{ "error": { "code", "message", "details" } }`, `409` cho xung đột, `422` cho validation; thêm `ZodValidationPipe` trong `apps/api/src/platform/http/zod.pipe.ts`
- [x] T041 Tạo injection token trong `apps/api/src/platform/engine-tokens.ts` (gồm `TOOL_ADAPTER_LOOKUP` để worker bind registry adapter và `IDENTITY_DIRECTORY` để `platform/auth` bind `IdentityDirectory`) và stub trả danh sách rỗng `apps/api/src/platform/stubs/empty-engines.ts` cho `TaskEngine`, `EmployeeEngine`, và stub `OrganizationEngine` với `isInScope` luôn trả `false` (fail-closed); dùng `forwardRef` cho phụ thuộc vòng giữa các module. `TaskEngine.getStats` của stub trả 0; phần human member của `EmployeeEngine` không dùng stub (T041a). Mỗi stub được thay bằng binding thật ở story tương ứng
- [x] T035 Tạo schema `action_policy` trong `packages/db/src/schema/permission.ts`: `action_type`, `level` enum `auto_execute`,`review_required`,`human_approval`,`restricted`, `scope_kind` enum `company`,`org_unit`,`team`,`ai_employee`, `scope_id`; sinh migration kèm RLS; v1.0 không có API ghi, bảng chỉ nhận seed
- [x] T035a [P] Viết contract test `PermissionEngine.evaluate` và `authorize` trong `tests/contract/permission-evaluate.spec.ts`, trước T036
- [x] T036 Triển khai `PermissionEngine.evaluate` và `authorize` trong `apps/api/src/engines/permission/permission.service.ts` và `ScopeGuard` + decorator `@RequireScope`, `@MemberScope` (route chỉ cần là thành viên, như notification của chính mình; mọi controller phải gắn một trong hai) trong `apps/api/src/engines/permission/scope.guard.ts`; ngoài phạm vi → `403`; dùng `OrganizationEngine.isInScope` qua injection token; `evaluate` gọi `evaluatePermission`; `ScopeGuard` lấy `RequestContext` do `TenantGuard` (T033) gắn vào request và gọi `isInScope` trong một `withTenant` riêng, chỉ đọc; đăng ký `PermissionModule` trong `apps/api/src/engines/permission/permission.module.ts`
- [x] T009b Tạo `tests/support/tenant-probe.controller.ts` (route thử tenant gắn `@MemberScope` và `@RequireScope`, chỉ đăng ký khi test)
- [x] T041a Viết contract test `addHumanMember`, `listHumanMembers`, `findMemberships` trong `tests/contract/human-member.spec.ts` rồi triển khai thật trong `apps/api/src/engines/employee/human-member.service.ts`, kèm `GET`, `POST /companies/{cid}/members` (POST chỉ CEO, gắn `@RequireScope`) trong `apps/api/src/engines/employee/human-member.controller.ts`; POST đổi `email` thành `userId` qua `IdentityDirectory.findUserByEmail`, test dùng fake; T033 và `/auth/me` hỏi membership qua `findMemberships`
- [x] T033 Tạo tenancy trong `apps/api/src/platform/tenancy/`: `tenant.guard.ts` (`TenantGuard`) đọc `companyId` từ đường dẫn, hỏi `findMemberships`, không phải thành viên → `404`, dựng `RequestContext` và gắn vào request; `tenant.interceptor.ts` chạy handler trong `withTenant` với context đó
- [x] T034 Triển khai xác thực trong `apps/api/src/platform/auth/` (`auth.controller.ts`, `auth.service.ts`, `session.guard.ts`, `csrf.guard.ts`): argon2id, session lưu Redis, cookie `cc_sid` `HttpOnly; Secure; SameSite=Lax`, đúng 4 endpoint `/auth/*` của `contracts/rest-api.md`; guard bật toàn cục theo thứ tự `SessionGuard` → `CsrfGuard` → `TenantGuard` → `ScopeGuard` (NestJS chạy guard trước interceptor); triển khai `IdentityDirectory`, là nơi duy nhất đọc ghi bảng `user`
- [x] T037 Triển khai outbox trong `apps/api/src/platform/events/`: `event-publisher.ts` ghi `domain_event` cùng transaction, cấp `seq` liên tục bằng `pg_advisory_xact_lock` theo company; `outbox-relay.ts` đẩy sang Redis pub/sub và phát qua event bus nội bộ; engine đăng ký nhận sự kiện qua `event-bus.ts`
- [x] T038 Triển khai `apps/api/src/platform/realtime/realtime.gateway.ts`: Socket.IO namespace `/realtime`, `@socket.io/redis-adapter`, xác thực cookie khi handshake, `subscribe { companyId, sinceSeq }` kiểm tra membership, join `company:{id}` và `user:{memberId}`, phát lại sự kiện `> sinceSeq` từ `domain_event` (giữ ≥ 10 phút) hoặc trả `resync_required`, phát envelope theo D2; mỗi instance lọc envelope theo `ManagedScope` của từng socket và tính lại scope theo `contracts/realtime-events.md`
- [x] T039 [P] Triển khai lưu trữ S3/MinIO trong `apps/api/src/platform/storage/storage.service.ts`: `put` trả `checksum_sha256`, `size_bytes`; `getStream`
- [x] T040 [P] Khai báo hàng đợi BullMQ trong `apps/api/src/platform/queue/queues.ts`: job `run.start`, `run.resume`, `action.execute-approved`, `task.decompose`, `task.synthesize`, `review.run`, kèm `companyId` trong payload và lock theo `task_id`
- [x] T040a Tạo `apps/api/src/platform/platform.module.ts` gom config, observability, tenancy, auth, events, realtime, storage, queue; import vào `apps/api/src/app.module.ts` và `apps/worker/src/worker.module.ts` (worker không nạp auth và realtime gateway); export qua `apps/api/src/index.ts`

### Nền tảng Web

- [x] T042 [P] Tạo API client trong `apps/web/src/lib/api.ts`: cookie, header `X-CSRF-Token`, ánh xạ lỗi nghiệp vụ; cấu hình TanStack Query trong `apps/web/src/lib/query.ts`
- [x] T043 [P] Tạo i18n trong `apps/web/src/i18n/vi.ts` và `apps/web/src/i18n/index.ts`: tiếng Việt mặc định, thuật ngữ sản phẩm giữ tiếng Anh, thông điệp cho mọi mã lỗi trong `errors.ts`
- [x] T044 Tạo khung ứng dụng và định tuyến có bảo vệ trong `apps/web/src/app/router.tsx` và `apps/web/src/app/layout.tsx` (bảng route và điều hướng khai báo sẵn mọi màn hình: Onboarding, Org, Members, Employees, Workspaces, Task Center, Approvals, Office, Dashboard, Budget, History, Achievement; nạp lười qua `import.meta.glob` trên `../{features,office}/**/*Page.tsx`; màn hình chưa có file hiển thị "Chưa triển khai", story sau không sửa router)
- [x] T045 [P] Tạo trang đăng ký/đăng nhập trong `apps/web/src/features/auth/`
- [x] T046 [P] Tạo Socket.IO client dùng chung trong `apps/web/src/realtime/socket.ts`: trạng thái kết nối, `subscribe` với `sinceSeq`, phát hiện `seq > last + 1` theo D2

**Checkpoint**: Nền tảng sẵn sàng. `pnpm test:security` pass với T027, T028

---

## Phase 3: User Story 1 - Dựng công ty ảo và cơ cấu tổ chức (Priority: P1) 🎯 Lõi P1

**Goal**: Người dùng tạo công ty, dựng cơ cấu từ template hoặc tự thiết kế, xem sơ đồ tổ chức và gán người quản lý.

**Independent Test**: Tạo công ty mới, áp dụng template (Development, BA, QA), đổi tên một phòng ban, thêm một Team, mở sơ đồ tổ chức và thấy đúng cấu trúc cùng người quản lý của từng đơn vị.

### Tests for User Story 1 ⚠️

> **NOTE: Viết test trước, xác nhận FAIL trước khi triển khai**

- [x] T047 [P] [US1] Viết contract test `OrganizationEngine` (mọi phương thức, gồm mở rộng phạm vi department → team → nhân viên) trong `tests/contract/organization-engine.spec.ts`
- [x] T048 [P] [US1] Viết integration test US1-AS1, AS2, AS4 (template sinh 3 phòng ban; thêm/đổi tên/xóa; `409 ORG_UNIT_NOT_EMPTY` kèm danh sách; nhánh còn nhân viên/task dùng `tests/support/fake-engines.ts` vì stub T041 trả rỗng; archive division còn department con → `409 ORG_UNIT_NOT_EMPTY`; `POST /companies` của user mới chạy được dưới role `app_user`) trong `tests/integration/organization.spec.ts`
- [x] T049 [P] [US1] Viết security test US1-AS3 (manager chỉ thấy và thao tác trong đơn vị được gán, ngoài phạm vi → `403`; CEO có phạm vi toàn công ty) trong `tests/security/organization-scope.spec.ts`

### Implementation for User Story 1

- [x] T050 [US1] Bổ sung vào `packages/db/src/schema/organization.ts` các bảng: `org_unit` (`kind` enum `division`,`department`; `parent_id` uuid? "department có thể nằm trong division hoặc trực tiếp dưới company; division không có parent là department"; `name` "duy nhất trong cùng parent (không tính archived)"; `sort_order` int; `archived_at`), `team` (`org_unit_id`; `name` "duy nhất trong org_unit"; `sort_order`; `archived_at`), `team_membership` (`member_kind` enum `ai`,`human`; `UNIQUE(team_id, member_kind, member_id)`), `management_assignment` (`manager_member_id` → human_member; `target_kind` enum `org_unit`,`team`; `UNIQUE(target_kind, target_id)`), `org_template` (`key`, `name`, `definition jsonb`, không theo company); sinh migration kèm RLS, trừ `org_template`
- [x] T051 [P] [US1] Thêm seed template `software_company` (cây Development, BA, QA) vào `packages/db/src/seeds/org-templates.ts`
- [x] T052 [P] [US1] Khai báo Zod DTO cho endpoint Organization trong `packages/contracts/src/organization.ts`
- [x] T053 [US1] Tạo repository trong `apps/api/src/engines/organization/organization.repository.ts`
- [x] T054 [US1] Triển khai `OrganizationEngine` trong `apps/api/src/engines/organization/organization.service.ts`: `createCompany` nhận `BootstrapContext`, tự sinh `company_id` UUIDv7, chạy trong `withTenant` với id đó, tạo CEO qua `EmployeeEngine.addHumanMember` và sao chép template thành bản ghi `org_unit` độc lập; `archiveOrgUnit` chặn khi còn đơn vị con, nhân viên/team chưa archived hoặc task chưa kết thúc (qua `EmployeeEngine.list`, `TaskEngine.list`); `resolveManagedScope` (gồm `management_assignment` và nhân viên có `manager_kind = human` lấy qua `EmployeeEngine.list`), `isInScope`; phát `domain_event` `org_unit.created`, `org_unit.archived`, `team.*`, `management.assigned`
- [x] T055 [US1] Tạo controller đúng mục Organization của `contracts/rest-api.md` (trừ `/members`, do T041a và T072 đảm nhiệm) trong `apps/api/src/engines/organization/organization.controller.ts`, gắn `@RequireScope` cho mọi route
- [x] T056 [US1] Đăng ký `OrganizationModule` và binding `OrganizationEngine` thật trong `apps/api/src/engines/organization/organization.module.ts`
- [x] T057 [P] [US1] Tạo màn hình onboarding (tạo công ty, chọn template hoặc tự thiết kế) trong `apps/web/src/features/org/OnboardingPage.tsx`
- [x] T058 [P] [US1] Tạo sơ đồ tổ chức hiển thị cây division/department/team + manager + số nhân viên trong `apps/web/src/features/org/OrgChartPage.tsx`
- [x] T059 [US1] Tạo thao tác thêm, đổi tên, sắp xếp, xóa đơn vị (hiển thị danh sách cản trở khi `409`) và gán manager trong `apps/web/src/features/org/OrgUnitEditor.tsx`
- [x] T060 [P] [US1] Viết E2E kịch bản Q1 trong `tests/e2e/organization.spec.ts`

**Checkpoint**: US1 chạy độc lập; T047–T049 và T060 pass

---

## Phase 4: User Story 2 - Tuyển và cấu hình AI Employee (Priority: P1)

**Goal**: Tạo AI Employee từ mẫu vai trò hoặc tùy chỉnh, với hồ sơ đầy đủ và chuỗi quản lý hợp lệ.

**Independent Test**: Tạo một AI Employee từ mẫu và một tùy chỉnh, hồ sơ hiển thị đủ thuộc tính FR-009, mỗi nhân viên có manager trực tiếp; lưu thiếu manager bị chặn.

### Tests for User Story 2 ⚠️

- [x] T061 [P] [US2] Viết contract test `EmployeeEngine` (gồm `resolveAccountableHuman`, `getCapacity`, các phương thức human member) trong `tests/contract/employee-engine.spec.ts`
- [x] T062 [P] [US2] Viết integration test US2-AS1, AS2, AS3, AS4 (mẫu điền sẵn; `422 MANAGER_REQUIRED`; đổi model chỉ ảnh hưởng một nhân viên; `409 EMPLOYEE_HAS_OPEN_TASKS` kèm danh sách, nhánh task mở dùng `tests/support/fake-engines.ts`) trong `tests/integration/employee.spec.ts`
- [x] T063 [P] [US2] Viết security test FR-006 (chuỗi quản lý có vòng, dài quá 10 bước, kết thúc ở người đã vô hiệu → `MANAGEMENT_CHAIN_INVALID`; vô hiệu người thật cuối chuỗi và archive AI Manager giữa chuỗi bị chặn; `manager_kind = ai` trỏ tới nhân viên `kind = employee` → `MANAGEMENT_CHAIN_INVALID`; đổi `kind` của AI Manager đang có cấp dưới bị chặn) trong `tests/security/management-chain.spec.ts`
- [x] T063a [P] [US2] Viết security test trong `tests/security/employee-scope.spec.ts`: Manager ngoài phạm vi → `403` với xem, sửa, suspend, resume, archive nhân viên và tạo nhân viên vào đơn vị ngoài phạm vi; danh sách chỉ trả nhân viên trong phạm vi; người không phải CEO → `403` khi thêm, vô hiệu thành viên hoặc đăng ký workspace

### Implementation for User Story 2

- [x] T064 [US2] Bổ sung vào `packages/db/src/schema/employee.ts`: `ai_employee` (`name` "1–80"; `avatar_key`; `position`; `home_org_unit_id`; `kind` enum `employee`,`manager`; `role_template_key` "`ai_developer`,`ai_ba`,`ai_qa`,`ai_manager` hoặc null"; `personality`; `skills` text[]; `seniority` enum `junior`,`middle`,`senior`,`expert`; `model_id`; `runtime_kind` enum `claude_agent_sdk`,`messages_api`; `system_prompt`; `tool_grants` text[]; `workspace_id` uuid?; `manager_kind` enum `human`,`ai` NOT NULL; `manager_id`; `max_concurrent_tasks` "mặc định 2"; `status` enum `active`,`suspended`,`archived`), `role_template` (`key`, `name`, `defaults jsonb`), `workspace` (`name`, `kind` enum `git_repo`,`docs_folder`, `mount_path`, `default_branch?`); sinh migration kèm RLS, trừ `role_template`
- [x] T065 [US2] Tạo bảng `model_price` trong `packages/db/src/schema/usage.ts`: `model_id`, `input_per_mtok`, `output_per_mtok`, `cache_read_per_mtok`, `cache_write_per_mtok`, `effective_from`; sinh migration (bảng cấu hình toàn cục, không RLS)
- [x] T066 [P] [US2] Thêm seed vào `packages/db/src/seeds/role-templates.ts` (AI Developer, AI QA Engineer: `claude_agent_sdk`; AI Business Analyst, AI Manager: `messages_api`; `tool_grants` tối thiểu theo catalog; model gợi ý `claude-opus-5-5`) và `packages/db/src/seeds/model-prices.ts` (`claude-fable-5-1`, `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`; giá lấy từ trang pricing chính thức tại thời điểm triển khai, ghi nguồn và ngày trong comment)
- [x] T067 [P] [US2] Khai báo Zod `EmployeeProfile`, `EmployeeProfileInput` đúng hợp đồng Nguyên tắc VI trong `packages/contracts/src/employee.ts`; `toolGrants` phải thuộc catalog và tương thích cột Runtime của `action-policy.md` với `runtimeKind`; `kind = manager` bắt buộc `runtimeKind = messages_api`
- [x] T068 [US2] Triển khai kiểm tra chuỗi quản lý thuần trong `apps/api/src/engines/employee/management-chain.ts`: đi theo `manager_id` khi `manager_kind = ai`, mỗi manager AI phải có `kind = manager`, phải kết thúc ở `human_member` đang hoạt động trong ≤ 10 bước, không vòng
- [x] T069 [US2] Tạo repository trong `apps/api/src/engines/employee/employee.repository.ts`
- [x] T069a [US2] Viết contract test `tests/contract/model-catalog.spec.ts` rồi triển khai `ModelCatalog` (`listModels`, `hasModel`) trong `apps/api/src/platform/usage-budget/model-catalog.service.ts`; đây là nơi duy nhất engine khác hỏi về `model_price`
- [x] T070 [US2] Triển khai `EmployeeEngine` trong `apps/api/src/engines/employee/employee.service.ts`: `create`, `update` (kiểm tra chuỗi; chặn đổi `kind` của AI Manager đang có cấp dưới; `model_id` phải tồn tại theo `ModelCatalog.hasModel`, US6 bổ sung `allowed_models`), `suspend`/`resume` (phát `employee.suspended`, `employee.resumed`), `archive` chặn và trả danh sách task mở qua `TaskEngine.list`, `getCapacity`, `resolveAccountableHuman`, `performance` từ `TaskEngine.getStats`; phát `employee.created`, `employee.updated`, `employee.archived`
- [x] T071 [US2] Bổ sung `deactivateHumanMember` (chặn khi là người thật cuối của một chuỗi quản lý AI; thành công thì phát `human_member.deactivated`) trong `apps/api/src/engines/employee/human-member.service.ts`
- [x] T072 [US2] Tạo controller trong `apps/api/src/engines/employee/employee.controller.ts` cho các endpoint mục Employees của `contracts/rest-api.md` (trừ `profile-view`, làm ở US5), `/role-templates`, `/models` (qua `ModelCatalog`), `DELETE /companies/{cid}/members/{id}` (vô hiệu, chỉ CEO), `/companies/{cid}/workspaces` (POST chỉ CEO; `mount_path` chuẩn hóa và phải nằm trong `WORKSPACE_HOST_PATH`); gắn `@RequireScope` cho mọi route
- [x] T073 [US2] Đăng ký `EmployeeModule`, thay stub `EmployeeEngine` bằng binding thật trong `apps/api/src/engines/employee/employee.module.ts`
- [x] T074 [P] [US2] Tạo danh sách nhân viên có bộ lọc trong `apps/web/src/features/employees/EmployeeListPage.tsx`
- [x] T075 [P] [US2] Tạo form tuyển dụng đủ trường FR-009 (chọn mẫu rồi chỉnh sửa, bắt buộc manager, chọn model/runtime/tools/workspace, nhập `maxConcurrentTasks`) trong `apps/web/src/features/employees/EmployeeForm.tsx`
- [x] T076 [P] [US2] Tạo trang hồ sơ nhân viên (suspend/resume/archive, hiển thị danh sách task cản trở) trong `apps/web/src/features/employees/EmployeeDetailPage.tsx`
- [x] T076a [P] [US2] Tạo panel gán AI Employee và người thật vào Team (một nhân viên thuộc nhiều Team, FR-007) trong `apps/web/src/features/org/TeamMembersPanel.tsx`
- [x] T076b [P] [US2] Tạo màn hình thêm và vô hiệu người thật trong công ty (chỉ CEO) trong `apps/web/src/features/org/MembersPage.tsx`
- [x] T076c [P] [US2] Tạo màn hình đăng ký workspace (chỉ CEO) trong `apps/web/src/features/employees/WorkspacesPage.tsx`
- [x] T077 [P] [US2] Viết E2E kịch bản Q2 trong `tests/e2e/employee.spec.ts`

- [x] T077a [US2] Rà soát constitution khi kết thúc Phase 1 lộ trình theo mục Governance, ghi kết quả vào `specs/001-claude-company-mvp/validation.md`

**Checkpoint**: US1 và US2 đều chạy độc lập

---

## Phase 5: User Story 3 - Giao việc và nhận kết quả thực thi thật (Priority: P1)

**Goal**: Giao task cho AI Employee/Team/Department, AI Manager xác nhận hoặc chia việc, AI thực thi thật và trả artifact, AI Manager review, Human Manager quyết định.

**Independent Test**: Giao AI BA "phân tích tài liệu yêu cầu và viết báo cáo", theo dõi đến khi có artifact rồi phê duyệt; task chỉ `completed` khi có bằng chứng đối chiếu từng acceptance criterion.

### Tests for User Story 3 ⚠️

- [X] T078 [P] [US3] Viết unit test máy trạng thái trong `apps/api/test/unit/task-state-machine.spec.ts`: duyệt toàn bộ cặp (trạng thái, action), chỉ các cạnh FR-020a + D1 hợp lệ
- [X] T079 [P] [US3] Viết contract test `TaskEngine` trong `tests/contract/task-engine.spec.ts`
- [X] T080 [P] [US3] Viết contract test `OrchestrationEngine` (gồm `recoverStaleRuns`) trong `tests/contract/orchestration-engine.spec.ts`
- [X] T081 [P] [US3] Viết contract test `ModelGateway` chạy chung cho cả ba provider (provider thật dùng HTTP mock) trong `tests/contract/model-gateway.spec.ts`: mọi tool đi qua `io.invokeTool`; với `messages_api` và fake, `beforeModelCall` trả false thì dừng; với `claude_agent_sdk`, `maxBudgetUsd` nhỏ hơn reservation theo headroom và `error_max_budget_usd` thành lỗi hết ngân sách; cả ba provider phát `model_call_started` trước mỗi lượt model; usage dedupe theo `message.id`
- [X] T082 [P] [US3] Viết contract test `CommunicationEngine`, `MemoryEngine` trong `tests/contract/communication-memory.spec.ts`
- [X] T082a [P] [US3] Viết integration test quy tắc người nhận FR-041 trong `tests/integration/notification-routing.spec.ts`: từng loại notification tới đúng người nhận; phạm vi không có manager hoặc người nhận bị vô hiệu thì gửi CEO
- [X] T083 [P] [US3] Viết integration test US3-AS1, AS4, AS5 (luồng đầy đủ `assigned` → AI Manager xác nhận → `in_progress → in_review → awaiting_human_approval → completed`; `409 EVIDENCE_INCOMPLETE`; `approve` thiếu `reason` → `422`; reject theo D1, `resume` tạo run mới và kết quả bị từ chối không approve lại được; suspend khi run đang chạy → khóa tool, `blocked`, `EMPLOYEE_SUSPENDED`, task chờ slot giữ `assigned` và tự chạy khi nhân viên `resume`; `resume` task có assignee còn `suspended` → `409 EMPLOYEE_SUSPENDED`) và US2-AS5 (hết slot → giữ `assigned`, xếp hàng theo priority rồi deadline), và FR-022 (tin nhắn của người quản lý gắn đúng task và được đưa vào run kế tiếp dưới dạng dữ liệu) trong `tests/integration/task-flow.spec.ts`
- [X] T084 [P] [US3] Viết integration test US3-AS2 trong `tests/integration/task-decomposition.spec.ts`: task giao trực tiếp qua AI Manager với `confirm` và `decompose`, không có AI Manager → `blocked`, `NO_AI_MANAGER`; kế hoạch phân rã xem được; task con kế thừa deadline và priority; nhân viên hết slot thì kế hoạch vẫn áp dụng và task con xếp hàng; task con chạy theo phụ thuộc; phụ thuộc vòng hoặc không có nhân viên phù hợp → `blocked` + notification; task cha đi `assigned → in_progress → in_review` và chỉ `completed` sau mọi task con; task phụ thuộc chỉ chạy sau khi task con trước được duyệt; AI Manager tổng hợp không tự review artifact tổng hợp; reviewer artifact tổng hợp là AI Manager khác, không có → `blocked`, `NO_INDEPENDENT_REVIEWER`; đơn vị không có AI Manager → `blocked`, `NO_AI_MANAGER`; task giao Team nhận `mode = confirm` hoặc không có task con → `blocked`, `NO_SUITABLE_ASSIGNEE`; AI Manager được giao trực tiếp tự đảm nhiệm bước xác nhận; task con không chạy job decompose; nhiều AI Manager cùng bậc chọn `id` nhỏ nhất; task giao Team không có AI Manager thì lấy AI Manager của department chứa Team; task con bị hủy → task cha `blocked`, `SUBTASK_CANCELLED`, `resume` bị từ chối; hủy task cha hủy task con và run của chúng; job `decompose` nhận danh sách nhân viên trong phạm vi kèm kỹ năng và slot; job `review`, `synthesize` nhận nội dung artifact trong trần `ARTIFACT_CONTEXT_MAX_BYTES` và có nhãn đã cắt khi vượt trần
- [X] T085 [P] [US3] Viết integration test US3-AS3 trong `tests/integration/task-rework.spec.ts`: rework ghi nhận từng vòng, đạt 3 vòng → `blocked` + notification `escalation`; reject chạm giới hạn giữ `HUMAN_REJECTED`, `resume` đặt `rework_baseline` và vòng rework kế tiếp không escalate ngay; `resume` đặt `rework_baseline`, tổng `rework_count` không giảm; kiểm tra `is_overdue`; rework hoặc reject rồi `resume` ở task cha chạy lại `synthesize` kèm lý do, không mở lại task con
- [X] T086 [P] [US3] Viết security test trong `tests/security/task-scope.spec.ts`: US3-AS6 (`403 ASSIGNEE_OUT_OF_SCOPE`), `REVIEWER_NOT_INDEPENDENT`, người ngoài phạm vi không xem được task/artifact, không đọc hoặc gửi được tin nhắn (`/tasks/{id}/messages` → `403`) và không quyết định được; `UPDATE`/`DELETE` lên `review_record` bị từ chối
- [X] T087 [P] [US3] Viết security test FR-013 trong `tests/security/memory-isolation.spec.ts`: `recall` không trả dữ liệu ngoài scope khi `share_rule` null, kể cả giữa hai công ty
- [ ] T088 [P] [US3] Viết security test trong `tests/security/agent-sdk-permissions.spec.ts`: với `tools: []` không built-in nào khả dụng và mọi MCP tool đều tới `io.invokeTool`; `.claude/settings.json` trong workspace không nới được quyền; lệnh trong `sandbox-runner` không có secret trong env và không kết nối được Postgres, Redis, MinIO, API model hay internet; đường dẫn thoát khỏi workspace bị từ chối; `human_approval` bị từ chối theo D6; worker không kết nối được host ngoài allowlist của `egress-proxy`; lệnh của run A không đọc hoặc ghi được thư mục của run B *(Đã viết, 22 ca chạy được pass; 6 ca trên container thật bị bỏ qua vì chưa có Docker, cần `TEST_SANDBOX_URL`/`TEST_SANDBOX_TOKEN`.)*
- [ ] T089 [P] [US3] Viết E2E kịch bản Q3, Q5 (`MODEL_PROVIDER=fake`, gồm reject rồi resume và cancel từ chi tiết task) trong `tests/e2e/task-flow.spec.ts` *(Đã viết, chưa chạy: cần stack đầy đủ gồm worker, Redis, MinIO và trình duyệt.)*
- [X] T089a [P] [US3] Viết contract test `BudgetService.reserve`, `commit`, `release`, `isModelAllowed`, `getUsage` trong `tests/contract/budget-core.spec.ts`: hai run đồng thời không cùng vượt, reservation theo run của `claude_agent_sdk`, ước tính theo R6 gồm giảm theo `cost_cap`/`token_cap` và chặn khi trần còn 0, không có policy thì áp hạn mức mặc định
- [X] T089b [P] [US3] Viết integration test với engine thật trong `tests/integration/archive-guards.spec.ts`: US1-AS4 và US2-AS4 trả `409` kèm danh sách khi còn nhân viên hoặc task mở

### Implementation for User Story 3

- [ ] T090 [US3] Chạy spike với Agent SDK thật rồi ghi kết quả vào R3 của `specs/001-claude-company-mvp/research.md`: tool search có trì hoãn MCP tool khi `tools: []` không; session có `resume` được sau `AbortController` hoặc `Query.close()` không; `PostToolBatch` có dừng được vòng lặp trước lượt model kế tiếp không; session có `resume` được sau khi process worker bị kill giữa lượt không (transcript có tool call chưa có kết quả). Chỉ bật `SDK_RESUME_AFTER_CRASH` khi điểm cuối được xác nhận; các kết quả khác chỉ để tối ưu, thiết kế khóa tool ở R4 và recovery mặc định không phụ thuộc các điểm này *(Chưa làm: cần `ANTHROPIC_API_KEY`; xem ghi chú trạng thái trong R3 của research.md.)*
- [X] T091 [US3] Tạo schema trong `packages/db/src/schema/task.ts`: `task` (`parent_task_id` uuid?; `title`; `objective` bắt buộc; `created_by_member_id`; `assigned_by_ai_employee_id` uuid?; `assignee_kind` enum `ai_employee`,`team`,`org_unit`; `assignee_id`; `deadline` timestamptz bắt buộc; `priority` enum `low`,`medium`,`high`,`urgent`; `acceptance_criteria` jsonb `[{id, text}]` "≥ 1 mục"; `expected_output` bắt buộc; `status`; `blocked_from`; `is_overdue` bool; `rework_count` int "≥ 0"; `rework_baseline` int "mặc định 0"; `token_cap`, `cost_cap` tùy chọn; `blocked_reason`; `completed_at`), `task_dependency`, `artifact` (`kind` enum `document`,`code_diff`,`test_report`,`file`; `storage_key`, `mime_type`, `size_bytes`, `checksum_sha256`), `evidence` (`reviewer_kind` enum `ai`,`human`; `verdict` enum `met`,`not_met`; `explanation`), `review_record` (`stage` enum `ai_review`,`human_approval`; `decision` enum `pass`,`rework`,`approve`,`reject`; `reason` "bắt buộc với mọi quyết định"; `decided_at`; trigger chặn UPDATE/DELETE); sinh migration kèm RLS và hàm `SECURITY DEFINER` `list_companies_with_open_tasks()` (chỉ đọc `task`, lấy task chưa kết thúc)
- [X] T092 [US3] Tạo schema trong `packages/db/src/schema/orchestration.ts`: `agent_run` (`task_id`; `ai_employee_id`; `purpose` enum `execute`,`decompose`,`review`,`synthesize`; `attempt`; `status` enum `queued`,`running`,`waiting_approval`,`succeeded`,`failed`,`timed_out`,`cancelled`; ảnh chụp `runtime_kind`, `model_id`; `provider_session_id`; `heartbeat_at`; `started_at`, `finished_at`; `error_code`, `error_message`; `trace_id`), `run_step` (`seq` "UNIQUE per run"; `kind` enum `model_call`,`tool_call`,`message`,`system`; `summary`; `payload jsonb` "đã che secret"; `started_at`, `finished_at`), `tool_invocation` (`run_step_id`; `action_type`; `permission_level`; `input` jsonb; `input_hash` sha256; `idempotency_key` UNIQUE; `status` enum `denied`,`pending_approval`,`pending`,`executing`,`succeeded`,`failed`,`unknown`; `adapter_mode` enum `dry_run`,`live`?; `result` jsonb?), `run_conversation_state` (`agent_run_id` UNIQUE; `messages` jsonb); sinh migration kèm RLS và hàm `SECURITY DEFINER` `list_companies_with_active_runs()`
- [X] T093 [US3] Bổ sung vào `packages/db/src/schema/usage.ts`: `budget_policy` (`monthly_token_limit?`, `monthly_cost_limit?`, `max_concurrent_tasks?` "chỉ company, org_unit, team", `allowed_models text[]?`, `warn_threshold` "mặc định 0.8", `UNIQUE(scope_kind, scope_id)`), `usage_ledger` (chỉ INSERT, trigger chặn UPDATE/DELETE; `cost_usd numeric(12,6)`; `period char(7)` "`YYYY-MM` theo timezone công ty"; `provider_message_id` UNIQUE; `is_overage bool`; `org_unit_id`, `team_ids uuid[]` là ảnh chụp), `budget_reservation` (`status` enum `held`,`committed`,`released`); sinh migration kèm RLS
- [X] T094 [US3] Tạo schema trong `packages/db/src/schema/communication.ts`: `task_message` (`task_id` NOT NULL; `author_kind` enum `human`,`ai`; `author_id`; `body`; `agent_run_id?`), `notification` (`recipient_member_id`; `type` enum `task_completed`,`task_error`,`task_overdue`,`approval_needed`,`budget_warning`,`budget_blocked`,`overload_warning`,`escalation`; `task_id?`; `approval_request_id?`; `title`; `body`; `read_at?`); sinh migration kèm RLS
- [X] T095 [US3] Tạo schema `memory_entry` trong `packages/db/src/schema/memory.ts`: `owner_scope_kind` enum `ai_employee`,`team`,`org_unit`; `owner_scope_id`; `source_task_id?`; `kind` enum `task_summary`,`note`; `content`; `share_rule jsonb?` "null = không chia sẻ ngoài scope"; sinh migration kèm RLS
- [X] T096 [P] [US3] Khai báo Zod DTO Task, Artifact, Evidence, `DecompositionPlan { mode: "confirm"|"decompose", subtasks[{ title, objective, acceptanceCriteria[], expectedOutput, assigneeId, dependsOn[] }] }`, Notification trong `packages/contracts/src/task.ts`
- [X] T097 [US3] Khai báo `ModelGateway`, `AgentRunRequest`, `AgentRunIO`, `AgentRunEvent`, `ToolSpec` đúng contract trong `packages/model-gateway/src/types.ts`
- [X] T097a [US3] Viết unit test `apps/worker/test/tool-specs.spec.ts` rồi khai báo Zod input cho mọi `ActionType` agent gọi được trong `packages/contracts/src/tool-inputs.ts` và `buildToolSpecs(toolGrants, runtimeKind)` cùng bảng ánh xạ tên tool ↔ `ActionType` trong `apps/worker/src/runtime/tool-specs.ts`, đúng mục "Tool cho agent" của `contracts/action-policy.md`: không sinh tool chưa cấp, sai runtime hoặc `network.fetch`
- [X] T098 [P] [US3] Triển khai `FakeModelProvider` kịch bản tất định trong `packages/model-gateway/src/providers/fake.provider.ts`: thành công, gọi tool, gọi `network.fetch`, prompt injection yêu cầu gửi email, lỗi retryable, timeout, kết quả decompose (`confirm` và `decompose`)/review theo schema; phát `model_call_started` trước mỗi lượt; đăng ký provider này vào `tests/support/app.ts`
- [X] T099 [P] [US3] Triển khai `MessagesApiProvider` trong `packages/model-gateway/src/providers/messages-api.provider.ts`: vòng lặp tool-use bằng `@anthropic-ai/sdk`, gọi `beforeModelCall` rồi phát `model_call_started` trước mỗi request, `max_tokens` theo `limits`, structured output qua `output_config.format` cho decompose/review
- [X] T100 [US3] Triển khai `ClaudeAgentSdkProvider` trong `packages/model-gateway/src/providers/claude-agent-sdk.provider.ts`: `query()` với `permissionMode: "default"`, `tools: []`, `allowedTools: ["mcp__cc__*"]`, `settingSources: []`, `cwd` là worktree của run, `model`, `maxTurns`, `env` chỉ gồm `PATH`, `HOME`, `ANTHROPIC_API_KEY`, `HTTPS_PROXY`, `NO_PROXY`, `mcpServers` in-process với mỗi handler gọi `io.invokeTool`, hook `PreToolUse` từ chối mọi tool ngoài `mcp__cc__*`, `maxBudgetUsd = limits.maxCostUsd`, `resume`; phát `model_call_started` khi bắt đầu `query()` và sau mỗi lần handler tool trả kết quả; usage dedupe theo `message.id`
- [X] T101 [US3] Tạo factory chọn provider theo `MODEL_PROVIDER` và `runtimeKind` trong `packages/model-gateway/src/index.ts`
- [X] T102 [US3] Triển khai máy trạng thái thuần FR-020a + D1 trong `apps/api/src/engines/task/task-state-machine.ts`; cạnh ngoài danh sách → `TASK_INVALID_TRANSITION`; `blocked` lưu và khôi phục `blocked_from`
- [X] T103 [US3] Tạo repository trong `apps/api/src/engines/task/task.repository.ts`
- [X] T104 [US3] Triển khai `TaskEngine` trong `apps/api/src/engines/task/task.service.ts`: `create` (FR-014, scope người giao), `transition` ghi `domain_event` cùng transaction, `attachArtifact`, `recordEvidence` (`reviewer_id ≠` AI Employee đã tạo artifact), `recordDecision` (`in_review → awaiting_human_approval` chỉ khi mọi criterion có `evidence.verdict = met` và ≥ 1 artifact; `completed` chỉ qua `decision = approve` của human_member có quyền review), `getStats` (theo quy tắc thống kê trong `data-model.md`), `markOverdue`, `listCompaniesWithOpenTasks`, `list`, `get`; `recordDecision` bắt buộc `reason`; rework tăng `rework_count`, `rework_count - rework_baseline ≥ MAX_REWORK` → `blocked`, `blocked_from = in_progress`, `MAX_REWORK_REACHED` + `escalation`; mọi `resume` lúc đã đạt ngưỡng này đặt `rework_baseline = rework_count`, gồm cả sau `HUMAN_REJECTED`; `resume` khi `blocked_reason = SUBTASK_CANCELLED` → `409 SUBTASK_CANCELLED`; `resume` khi assignee là AI Employee còn `suspended` → `409 EMPLOYEE_SUSPENDED`, bất kể `blocked_reason`
- [X] T105 [US3] Triển khai `applyDecomposition` trong `apps/api/src/engines/task/decomposition.service.ts`: `mode = confirm` không tạo task con và chỉ hợp lệ với `assignee_kind = ai_employee`; task giao team/org_unit nhận `confirm` hoặc danh sách task con rỗng → `NO_SUITABLE_ASSIGNEE`; `mode = decompose`: assignee thuộc scope của `created_by_member_id` và đang `active`, hết slot thì xếp hàng chứ không từ chối, kiểm tra vòng bằng topological sort, sinh task con + `task_dependency`, task con kế thừa `created_by_member_id`, `deadline`, `priority` và ghi `assigned_by_ai_employee_id`, tạo ở `assigned`, không qua job decompose, chỉ giao cho `ai_employee`; chuyển task cha sang `in_progress`; vi phạm → `DEPENDENCY_CYCLE`/`NO_SUITABLE_ASSIGNEE`
- [X] T106 [P] [US3] Triển khai `CommunicationEngine` trong `apps/api/src/engines/communication/communication.service.ts`: `task_message` luôn gắn task; `notify` lưu `notification` và phát `notification.created` tới `user:{memberId}`; đăng ký module trong `apps/api/src/engines/communication/communication.module.ts`
- [X] T106a [US3] Triển khai chọn người nhận theo FR-041 trong `apps/api/src/engines/communication/notification-routing.ts`, chỉ qua interface engine: task hoàn thành, lỗi, quá hạn, escalation, chặn vì ngân sách → người giao task; cần phê duyệt → người duyệt; quá tải → `EmployeeEngine.resolveAccountableHuman`; cảnh báo ngân sách → manager của phạm vi (CEO với phạm vi công ty, người thật cuối chuỗi với phạm vi nhân viên); phạm vi không có manager hoặc người nhận bị vô hiệu → CEO
- [X] T107 [P] [US3] Triển khai `MemoryEngine` trong `apps/api/src/engines/memory/memory.service.ts`: `recall` theo scope và độ gần đây, `remember` lưu tóm tắt trích xuất từ task (không gọi model); không dùng vector search; đăng ký module trong `apps/api/src/engines/memory/memory.module.ts`
- [X] T108 [US3] Triển khai `BudgetService` lõi trong `apps/api/src/platform/usage-budget/budget.service.ts` và tính chi phí trong `apps/api/src/platform/usage-budget/cost.ts` (token × `model_price`): `reserve` kiểm tra mọi scope + trần task trong transaction, đã dùng + đang giữ không vượt giới hạn; `commit` ghi `usage_ledger`, dedupe theo `provider_message_id`; `release`; `isModelAllowed`; `getUsage` (lọc theo nhân viên, task, phòng ban, kỳ và `groupBy`); công ty không có `budget_policy` thì áp hạn mức mặc định từ config, không bao giờ coi là không giới hạn; đăng ký module trong `apps/api/src/platform/usage-budget/usage-budget.module.ts`
- [X] T109 [US3] Triển khai `ToolBroker.invoke` trong `apps/worker/src/runtime/tool-broker.ts`: ánh xạ tên tool → `ActionType` bằng bảng của T097a (không ánh xạ được → `restricted`), `workspace.shell` qua `classifyShellCommand`, gọi `PermissionEngine.evaluate`, ghi `tool_invocation` qua `OrchestrationEngine.recordToolInvocation` cho mọi đánh giá kể cả `restricted`, `idempotency_key` theo nhóm `dedupe`/`rerun` của `action-policy.md`, lần gọi lại nhóm `dedupe` nhận trạng thái từ ledger thay vì thực thi lại; `review_required` đánh dấu run phải review; `human_approval` bị từ chối theo D6
- [X] T110 [P] [US3] Triển khai tool workspace trong `apps/worker/src/tools/workspace-tools.ts` (`workspace.read`, `workspace.search`, `workspace.write`, chặn thoát đường dẫn và symlink; `workspace.shell`, `workspace.test.run` gọi `sandbox-runner` qua `apps/worker/src/tools/sandbox-client.ts`) và `apps/worker/src/tools/run-workspace.ts` (mỗi run có thư mục `/worktrees/{runId}` trên volume `run_worktrees`: `git_repo` dùng `git clone --local` với branch `cc/run-{id}`, `docs_folder` là bản sao; agent không ghi vào nguồn; run rework, retry và run sau `resume` của cùng task khởi tạo bằng cách sao chép nguyên thư mục của run gần nhất, gồm thay đổi chưa commit, rồi đổi owner sang UID của run mới; thư mục của run được giữ đến khi task kết thúc)
- [ ] T111 [US3] Tạo service `sandbox-runner` trong `docker/sandbox-runner/` (Dockerfile, server nhận lệnh có token): mỗi run chạy bằng một UID không đặc quyền riêng, thư mục `/worktrees/{runId}` có owner là UID đó, group của worker, mode `2770`, thư mục cha `0711`; `cap_drop: ALL` và chỉ thêm `CAP_SETUID`, `CAP_SETGID`, `CAP_CHOWN`; env đã xóa secret; timeout theo tool; nối trong `docker/docker-compose.yml` vào mạng `internal` riêng, không có đường tới Postgres, Redis, MinIO, API model hay internet. Worker ra ngoài qua `egress-proxy` (T111a) *(Đã viết `docker/sandbox-runner/` và nối vào compose; logic được test, chưa build image hay chạy trên Docker.)*
- [ ] T111a [US3] Tạo service `egress-proxy` trong `docker/egress-proxy/` (Dockerfile, cấu hình allowlist chỉ gồm host API model), nối trong `docker/docker-compose.yml`: worker chỉ ra ngoài qua proxy này bằng `HTTPS_PROXY`, `NO_PROXY` cho dịch vụ nội bộ *(Đã viết `docker/egress-proxy/` và nối vào compose; logic được test, chưa build image hay chạy trên Docker.)*
- [X] T112 [US3] Triển khai tool nội bộ `artifact.publish` (lưu S3 rồi gọi `TaskEngine.attachArtifact`), `task.message.post`, `task.decompose.propose` trong `apps/worker/src/tools/internal-tools.ts`
- [X] T113 [US3] Triển khai vòng lặp run trong `apps/worker/src/runtime/run-loop.ts`: dựng `AgentRunRequest` (ngữ cảnh memory và tin nhắn người dùng đánh dấu là dữ liệu; chỉ tool đã cấp, lấy từ `buildToolSpecs` của T097a), kiểm tra `isModelAllowed` trước khi chạy (không được phép → `blocked`, `MODEL_NOT_ALLOWED`); `messages_api`: `beforeModelCall` → `BudgetService.reserve` theo lượt; `claude_agent_sdk`: reserve một lần theo run (ước tính của cả hai runtime theo R6), `limits.maxCostUsd = phần đã giữ × (1 − SDK_BUDGET_HEADROOM)`, commit từng `model_call`, release phần dư khi kết thúc, sau mỗi `model_call` chạm `reserved_tokens × (1 − SDK_BUDGET_HEADROOM)` thì khóa tool và ghi overage nếu phản hồi cuối vượt; run chuyển `waiting_approval` thì release phần đang giữ; hết ngân sách → khóa tool của run, task `blocked`, `BUDGET_EXCEEDED` + `budget_blocked`; ghi `run_step` qua `OrchestrationEngine.appendRunStep`, đã che secret bằng `apps/worker/src/runtime/redact.ts`; phát `run.started`, `run.model_call_started`, `run.tool_call_started`, `run.succeeded`, `run.failed`, `task.progress`, `run.step_appended`, `usage.updated`
- [X] T114 [US3] Triển khai job handler `run.start`, `task.decompose`, `task.synthesize`, `review.run` trong `apps/worker/src/jobs/run-jobs.ts`; mỗi job dựng `input` theo mục "Ngữ cảnh đầu vào theo purpose" của `contracts/engine-interfaces.md`
- [X] T115 [US3] Triển khai `OrchestrationEngine` trong `apps/api/src/engines/orchestration/orchestration.service.ts`: nhận sự kiện `task.assigned` để chạy decompose cho mọi task gốc, task con bỏ qua (team/org_unit chọn AI Manager theo FR-016a, task giao trực tiếp theo thứ tự FR-018 và nhân viên được giao là AI Manager thì tự đảm nhiệm, nhiều AI Manager cùng bậc chọn `id` nhỏ nhất; không có → `blocked`, `NO_AI_MANAGER`, notification `escalation`); sau `confirm` thì execute khi nhân viên còn slot; hết slot giữ `assigned` và xếp hàng theo priority rồi deadline; task con chỉ chạy khi phụ thuộc `completed`; `enqueueRun`, `getRun`, `listRuns`, `cancelRunsForTask`, `updateRunStatus`, `heartbeat`, `appendRunStep`, `recordToolInvocation`, `updateToolInvocation`, `findToolInvocationByKey`, `saveConversationState`, `loadConversationState`; nhân viên `suspended` không bắt đầu run mới; nhận `employee.suspended` thì khóa tool run đang chạy và chuyển task sang `blocked`, `blocked_reason = EMPLOYEE_SUSPENDED`; đăng ký module trong `apps/api/src/engines/orchestration/orchestration.module.ts`
- [X] T115a [US3] Triển khai điều phối theo sự kiện trong `apps/api/src/engines/orchestration/task-flow.listener.ts`: run `execute` thành công → `submit` + `review.run`; review `rework` hoặc quyết định `rework` của người thật → run `execute` mới kèm lý do, task cha thì chạy lại `task.synthesize` kèm lý do; `resume` → chạy lại đúng bước theo `data-model.md`; run kết thúc hoặc task `blocked`, `cancelled`, `completed` → lấy task kế tiếp đang chờ slot theo priority rồi deadline; `employee.resumed` → lấy các task đang chờ slot của nhân viên đó theo cùng thứ tự đến khi hết slot; task con `completed` → mở task phụ thuộc và kích hoạt T117 khi đủ; task `completed` → `MemoryEngine.remember`; task `cancelled` → `cancelRunsForTask` và hủy mọi task con chưa kết thúc; task con `cancelled` khi task cha chưa hủy → task cha `blocked`, `SUBTASK_CANCELLED` + notification `escalation`
- [X] T116 [US3] Triển khai chọn reviewer theo D5 (nhiều AI Manager cùng bậc chọn `id` nhỏ nhất) và xử lý kết quả review trong `apps/api/src/engines/orchestration/review-flow.service.ts`: sinh `evidence` từng criterion, ghi `review_record` stage `ai_review`, `pass` hoặc `rework` kèm lý do
- [X] T117 [US3] Triển khai hoàn tất task cha trong `apps/api/src/engines/orchestration/parent-task.service.ts`: khi mọi task con `completed`, job `task.synthesize` (run `purpose = synthesize`) để AI Manager sinh artifact tổng hợp, chuyển task cha `in_progress → in_review`, rồi `review.run` do một AI Manager khác AI Manager đã tổng hợp, ưu tiên AI Manager không làm task con nào, sinh evidence theo FR-018; không có reviewer → `blocked`, `NO_INDEPENDENT_REVIEWER`
- [X] T118 [US3] Triển khai job định kỳ (duyệt công ty qua `TaskEngine.listCompaniesWithOpenTasks`, gọi `TaskEngine.markOverdue`) đặt `is_overdue` và gửi notification `task_overdue` cho người giao task trong `apps/worker/src/jobs/overdue-sweeper.ts`; hoàn thành/lỗi task gửi notification `task_completed`/`task_error` qua `apps/api/src/engines/task/task-notifications.ts`
- [X] T119 [US3] Tạo controller đúng mục Tasks của `contracts/rest-api.md` trong `apps/api/src/engines/task/task.controller.ts`; thay stub `TaskEngine` bằng binding thật trong `apps/api/src/engines/task/task.module.ts`
- [X] T120 [P] [US3] Tạo controller `/notifications`, `/notifications/{id}/read`, `/read-all` trong `apps/api/src/engines/communication/notification.controller.ts`
- [X] T121 [P] [US3] Tạo Task Board (màn hình chính của Task Center) theo trạng thái với tiến độ, priority, deadline, assignee, phòng ban, bộ lọc FR-021 trong `apps/web/src/features/tasks/TaskBoardPage.tsx`
- [X] T122 [P] [US3] Tạo form tạo task đủ trường FR-014, giao cho AI Employee/Team/Department, nhập `tokenCap`, `costCap` tùy chọn, trong `apps/web/src/features/tasks/TaskForm.tsx`
- [X] T123 [P] [US3] Tạo chi tiết task (kế hoạch phân rã, task con, artifact mở xem được, evidence từng criterion, trao đổi, nút approve/reject/rework bắt buộc lý do, `blocked_reason` cùng nút resume/cancel, chuỗi truy vết SC-014) trong `apps/web/src/features/tasks/TaskDetailPage.tsx`
- [X] T124 [P] [US3] Tạo chuông và hộp thông báo đã đọc/chưa đọc, nhận realtime, trong `apps/web/src/features/notifications/NotificationCenter.tsx`, gắn vào `apps/web/src/app/layout.tsx`

**Checkpoint**: Task chạy thật đến artifact; hành động `human_approval` đang bị từ chối fail-closed

---

## Phase 6: User Story 4 - Kiểm soát quyền hạn và phê duyệt hành động nhạy cảm (Priority: P1)

**Goal**: Hành động nhạy cảm luôn dừng chờ Human Approval do hệ thống cưỡng chế; hệ thống (không phải agent) thực thi đúng payload đã duyệt.

**Independent Test**: Yêu cầu AI Employee gửi email: hành động giữ ở trạng thái chờ đến khi được duyệt; hành động chưa phân loại bị từ chối.

### Tests for User Story 4 ⚠️

- [X] T125 [P] [US4] Viết contract test `PermissionEngine.createApprovalRequest`, `decideApproval`, `remindPendingApprovals`, `listCompaniesWithPendingApprovals` trong `tests/contract/permission-engine.spec.ts` *(Đã viết và typecheck, chưa chạy: cần Docker cho PostgreSQL; xem validation.md T143a.)*
- [X] T126 [P] [US4] Viết contract test `ToolAdapter` (idempotency, `lookup`, kết quả dry-run có nhãn) trong `tests/contract/tool-adapter.spec.ts`
- [X] T127 [P] [US4] Viết security test trong `tests/security/approval-bypass.spec.ts`: 100% `email.send`, `data.delete`, `deploy.staging`, `deploy.production`, `workspace.git.push` bị giữ, kể cả dry-run (SC-003); `payloadHash` sai → `409 APPROVAL_PAYLOAD_CHANGED`; duyệt hai lần chỉ thực thi một lần; người ngoài phạm vi không duyệt được; không có auto-approve; `action_policy` không hạ được floor *(Đã viết và typecheck, chưa chạy: cần Docker cho PostgreSQL; xem validation.md T143a.)*
- [X] T128 [P] [US4] Viết security test US4-AS4 với kịch bản prompt injection của `FakeModelProvider` (trong task, tin nhắn, kết quả tool) trong `tests/security/prompt-injection.spec.ts` *(Đã viết và typecheck, chưa chạy: cần Docker cho PostgreSQL; xem validation.md T143a.)*
- [X] T129 [P] [US4] Viết security test trong `tests/security/unclassified-actions.spec.ts`: action chưa phân loại và tool ngoài `tool_grants` → `restricted`, có ghi `tool_invocation`; lệnh shell bị phân loại lại đúng khi chạy qua `ToolBroker` (SC-004) *(Đã viết và typecheck, chưa chạy: cần Docker cho PostgreSQL; xem validation.md T143a.)*
- [X] T130 [P] [US4] Viết integration test US4-AS1, AS2, AS5 trong `tests/integration/approval-flow.spec.ts`: tạo yêu cầu đủ ngữ cảnh, run `waiting_approval`, approve thực thi đúng payload rồi resume, reject không thực thi và agent nhận lý do, nhắc sau 1 giờ, approve thiếu lý do → `422`, người duyệt bị vô hiệu thì yêu cầu chuyển cho CEO *(Đã viết và typecheck, chưa chạy: cần Docker cho PostgreSQL; xem validation.md T143a.)*
- [ ] T131 [P] [US4] Viết E2E kịch bản Q6, Q7 trong `tests/e2e/approval.spec.ts` *(Đã viết, chưa chạy: cần stack đầy đủ gồm worker, Redis, MinIO và trình duyệt; vế Virtual Office của Q6 chờ US5.)*
- [X] T131a [P] [US4] Viết contract test `paused_for_approval` cho cả ba provider (provider thật dùng HTTP mock) trong `tests/contract/model-gateway-pause.spec.ts`, trước T138: `pending_approval` và `run_locked` không thực thi tool, giữ `sessionId`, không treo callback; `messages_api` gọi `saveConversation` trước khi tạm dừng

### Implementation for User Story 4

- [X] T132 [US4] Bổ sung `approval_request` vào `packages/db/src/schema/permission.ts`: `tool_invocation_id` UNIQUE; `task_id`, `ai_employee_id`; `action_type`; `summary`; `rationale`; `payload` jsonb; `payload_hash`; `approver_member_id` uuid?; `status` enum `pending`,`approved`,`rejected`,`cancelled` "không có `expired`/auto-approve"; `decided_by`, `decided_at`, `decision_reason` "lý do bắt buộc với mọi quyết định"; `last_reminded_at`; sinh migration kèm RLS; tạo hàm `SECURITY DEFINER` `list_companies_with_pending_approvals()` (chỉ đọc `approval_request`)
- [X] T133 [P] [US4] Khai báo Zod DTO Approval trong `packages/contracts/src/approval.ts`
- [X] T134 [US4] Triển khai `createApprovalRequest` (payload chuẩn hóa, `payload_hash` sha256, người duyệt = `created_by_member_id` của task, người này bị vô hiệu thì chuyển yêu cầu đang chờ cho CEO khi nhận `human_member.deactivated`, phát `approval.requested`, notification `approval_needed`) và `decideApproval` (bắt buộc lý do, kiểm tra scope và hash, phát `approval.decided`), `remindPendingApprovals`, `listCompaniesWithPendingApprovals`, và nhận `task.cancelled` để chuyển approval đang chờ của task sang `cancelled` trong `apps/api/src/engines/permission/approval.service.ts`
- [X] T135 [P] [US4] Triển khai adapter dry-run trong `apps/worker/src/tools/adapters/email.adapter.ts`, `data-delete.adapter.ts`, `deploy.adapter.ts`, `git-push.adapter.ts`, ghi payload vào file JSONL trên volume dry-run qua `dry-run-log.ts`, kết quả có nhãn "dry-run", `lookup` theo idempotency key; v1.0 không triển khai adapter thật, chế độ `live` → lỗi `ADAPTER_LIVE_NOT_CONFIGURED`
- [X] T136 [US4] Tạo registry chọn adapter theo `ADAPTER_MODE` trong `apps/worker/src/tools/adapters/registry.ts`, bind vào token `TOOL_ADAPTER_LOOKUP`
- [X] T137 [US4] Thay nhánh từ chối D6 trong `apps/worker/src/runtime/tool-broker.ts`: `human_approval` tạo `tool_invocation` `pending_approval` + `approval_request`, agent không thực thi; cập nhật assertion D6 trong `tests/security/agent-sdk-permissions.spec.ts` (T088) thành: `human_approval` tạo yêu cầu chờ duyệt và không thực thi
- [X] T138 [US4] Hỗ trợ tạm dừng trong `packages/model-gateway/src/providers/claude-agent-sdk.provider.ts` và `packages/model-gateway/src/providers/messages-api.provider.ts`: khi tool trả `pending_approval`, `ToolBroker` khóa mọi tool còn lại của run (trả `run_locked`, không thực thi); provider chờ agent kết thúc lượt, kể cả dừng vì `maxTurns`, rồi phát `paused_for_approval`, giữ `sessionId` để resume; `messages_api` lưu hội thoại vào `run_conversation_state` qua `io.saveConversation` trước khi phát `paused_for_approval`; không treo callback
- [X] T139 [US4] Triển khai job `action.execute-approved` (chỉ thực thi khi hash khớp, qua adapter, ghi ledger) và `run.resume` (reserve lại ngân sách, không đủ thì task `blocked`, `BUDGET_EXCEEDED`; `messages_api` nạp `run_conversation_state`; đưa kết quả hoặc lý do từ chối cho agent) trong `apps/worker/src/jobs/approval-jobs.ts`
- [X] T140 [US4] Triển khai `resumeAfterApproval` trong `apps/api/src/engines/orchestration/orchestration.service.ts`
- [X] T141 [US4] Tạo job nhắc người duyệt (sau 1 giờ, rồi mỗi 24 giờ, không bao giờ tự duyệt; duyệt công ty qua `PermissionEngine.listCompaniesWithPendingApprovals`, gọi `PermissionEngine.remindPendingApprovals`) trong `apps/worker/src/jobs/approval-reminder.ts`
- [X] T142 [US4] Tạo controller `/approvals`, `/approvals/{id}/decision` trong `apps/api/src/engines/permission/approval.controller.ts`
- [X] T142a [US4] Viết contract test `OrchestrationEngine.listExecutedActions` trong `tests/contract/orchestration-engine.spec.ts` rồi triển khai trong `apps/api/src/engines/orchestration/orchestration.service.ts`, thêm `GET /tasks/{id}/executed-actions` vào `apps/api/src/engines/task/task.controller.ts` và hiển thị nhãn "dry-run" cho từng hành động trong `apps/web/src/features/tasks/TaskDetailPage.tsx`
- [X] T143 [P] [US4] Tạo hộp phê duyệt hiển thị action, summary, rationale (như dữ liệu, không render HTML), payload, employee, task, bắt buộc lý do cho cả approve và reject, trong `apps/web/src/features/approvals/ApprovalsPage.tsx`

- [X] T143a [US4] Rà soát constitution khi kết thúc Phase 2 lộ trình theo mục Governance, ghi kết quả vào `specs/001-claude-company-mvp/validation.md`

**Checkpoint**: Toàn bộ P1 hoàn tất; `pnpm test:security` pass; có thể chạy `MODEL_PROVIDER=anthropic`, `ADAPTER_MODE=dry_run` khi có người giám sát; timeout, heartbeat và recovery (T180–T182) đến US7 mới có, nên không chạy không giám sát trước đó

---

## Phase 7: User Story 5 - Quan sát công ty vận hành trong Virtual Office (Priority: P2)

**Goal**: Văn phòng pixel art 2D phản ánh trạng thái thật theo thời gian thực, từ một nguồn trạng thái duy nhất.

**Independent Test**: Mở Virtual Office khi task đang chạy; nhân vật chuyển Working/Thinking/Waiting Approval đúng lúc có sự kiện; Employee Profile hiển thị đúng task và tiến độ.

### Tests for User Story 5 ⚠️

- [X] T144 [P] [US5] Viết unit test reducer cho từng dòng bảng ánh xạ trong `contracts/realtime-events.md` và thứ tự ưu tiên `error_blocked` > `waiting_approval` > `working`/`thinking`, trong `apps/api/test/unit/office-reducer.spec.ts` *(Đã chạy: 36 ca reducer + 8 ca bố cục zone đạt.)*
- [X] T145 [P] [US5] Viết contract test `OfficeSimulationEngine` trong `tests/contract/office-simulation-engine.spec.ts` *(Đã viết và typecheck, chưa chạy: cần Docker cho PostgreSQL; xem validation.md T163a.)*
- [X] T146 [P] [US5] Viết integration test lan truyền trong `tests/integration/realtime-propagation.spec.ts`: `seq` liên tục theo D2, phát lại theo `sinceSeq`, `resync_required`, 10 nhân viên đổi trạng thái liên tục không mất hoặc đảo thứ tự *(Đã viết và typecheck, chưa chạy: cần Docker cho PostgreSQL và Redis; xem validation.md T163a.)*
- [X] T147 [P] [US5] Viết integration test SC-006 trong `tests/integration/office-audit.spec.ts`: 50 lần chuyển trạng thái đều có `source_event_seq` trỏ tới `domain_event` thật; không sự kiện thì giữ `idle` *(Đã viết và typecheck, chưa chạy: cần Docker cho PostgreSQL; xem validation.md T163a.)*
- [X] T148 [P] [US5] Viết security test trong `tests/security/realtime-isolation.spec.ts`: cookie không hợp lệ bị ngắt; không subscribe được công ty khác; không có nội dung task hoặc payload approval trên room công ty; Manager ngoài phạm vi chỉ nhận `sync.seq_advanced`, kể cả khi phát lại theo `sinceSeq`, và snapshot không có nhân viên ngoài phạm vi; `profile-view` ngoài phạm vi bị từ chối *(Đã viết và typecheck, chưa chạy: cần Docker cho PostgreSQL và Redis; xem validation.md T163a.)*
- [X] T149 [P] [US5] Viết unit test store trong `apps/web/test/office-store.spec.ts`: áp sự kiện, phát hiện gap, nhãn stale, đồng bộ lại *(Đã chạy: 17 ca đạt.)*
- [X] T150 [P] [US5] Viết E2E kịch bản Q8 (gồm mất mạng rồi khôi phục, mở Profile < 1 giây với 10 nhân viên) trong `tests/e2e/virtual-office.spec.ts` *(Đã viết và typecheck, chưa chạy: cần stack đầy đủ và Playwright; canvas không đọc được bằng DOM nên trạng thái được kiểm chứng qua danh sách nhân viên cùng store; xem validation.md T163a.)*

### Implementation for User Story 5

- [X] T151 [US5] Tạo schema trong `packages/db/src/schema/office.ts`: `employee_status` (`ai_employee_id` PK cùng company; `state` enum `idle`,`working`,`thinking`,`communicating`,`meeting`,`waiting_approval`,`completed`,`error_blocked`,`break`; `current_task_id?`; `current_tool?`; `progress?` "0–100, do run báo"; `source_event_seq bigint`; `changed_at`), `office_zone` (`kind` enum `department`,`ceo_office`,`break_room`; `org_unit_id?`; `layout jsonb` "vị trí ô, sinh tất định"); sinh migration kèm RLS *(Migration `0008_office_simulation.sql` sinh bằng `drizzle-kit`, thêm RLS thủ công, chưa áp dụng lên PostgreSQL. Ngoài hai bảng đã nêu còn thêm `employee_status_change` (nhật ký theo `seq`), `office_cursor` (mốc đã chiếu) và các cột `suspended`, `tracks`, `applied_seq`; xem data-model.md.)*
- [X] T152 [P] [US5] Khai báo `OfficeSnapshot`, Employee Profile view và danh sách `avatar_key` trong `packages/contracts/src/office.ts` *(Thêm schema `EmployeeProfileView`, `deskCell`, kích thước zone; `AVATAR_KEYS` chuyển từ web sang contracts.)*
- [X] T153 [US5] Triển khai reducer thuần `(EmployeeState, DomainEvent) → EmployeeState` trong `apps/api/src/engines/office-simulation/office-reducer.ts` *(Đã chạy qua unit test T144. Reducer theo từng nhân viên có `tracks` theo task; `employeeOf`/`taskOfTaskLevelEvent` chọn nhân viên bị ảnh hưởng.)*
- [X] T154 [US5] Triển khai `OfficeSimulationEngine` trong `apps/api/src/engines/office-simulation/office-simulation.service.ts`: nhận `domain_event`, cập nhật `employee_status` kèm `source_event_seq`, phát `office.employee_status_changed`; chọn trạng thái theo run hoạt động gần nhất khi nhân viên có nhiều task; đăng ký module trong `apps/api/src/engines/office-simulation/office-simulation.module.ts` *(Chiếu qua `EventBus.project` trong relay (chạy trước khi phát Redis) với mốc `office_cursor`; gateway dựng envelope từ `employee_status_change` qua `EnvelopeMapperRegistry` bất đồng bộ. Interface thêm `previous`, `getProfileView`, `completeDisplayElapsed`; xem engine-interfaces.md.)*
- [X] T155 [US5] Triển khai đồng bộ zone trong `apps/api/src/engines/office-simulation/office-zones.service.ts`: mỗi department một zone + CEO Office + Break Room, vị trí bàn tất định theo thứ tự nhân viên, phát `office.layout_changed` *(`office-layout.ts` thuần + `office-zones.service.ts`; `office.layout_changed` mở rộng lý do, xem realtime-events.md.)*
- [X] T156 [P] [US5] Tạo job delay 60 giây ghi `domain_event` `office.completed_display_elapsed` để đưa `completed` về `idle` trong `apps/worker/src/jobs/office-jobs.ts` *(Job `office.completed-elapsed` do engine lên lịch khi tạo track `completed`; `jobId` theo (nhân viên, `seq`) để khử trùng.)*
- [X] T157 [US5] Tạo `GET /office/snapshot` (kèm `seq`, chỉ gồm nhân viên trong phạm vi người xem) trong `apps/api/src/engines/office-simulation/office.controller.ts` *(`GET /office/snapshot` và route `profile-view` cùng nằm trong `office.controller.ts`.)*
- [X] T158 [US5] Triển khai `GET /employees/{id}/profile-view` đủ mục FR-038 (status, currentTask + progress, currentTool, recentMessages, latestResults, reviewHistory, usage tháng này + tổng, blockers), chỉ gọi interface engine và `BudgetService.getUsage`, trong `apps/api/src/engines/office-simulation/profile-view.service.ts` *(Mỗi danh sách tối đa 5 mục; gọi song song để mở Profile < 1 giây.)*
- [X] T159 [US5] Tạo store thuần TS trong `apps/web/src/office/state/office-store.ts`: snapshot + `seq`, áp sự kiện, stale khi mất kết nối hoặc gap, tự tải lại snapshot; không import PixiJS *(Đã chạy qua unit test T149.)*
- [X] T160 [P] [US5] Thêm tài sản pixel art tự vẽ hoặc giấy phép mở (tilemap, sprite theo `avatar_key` và theo trạng thái) trong `apps/web/public/office/`, ghi nguồn và giấy phép ở `apps/web/public/office/LICENSES.md`; không dùng tài sản của `ref/Claude-Office` hoặc thương hiệu khác *(Tài sản sinh bằng `apps/web/scripts/generate-office-assets.mjs`, CC0.)*
- [X] T161 [US5] Triển khai renderer trong `apps/web/src/office/renderer-pixi/OfficeRenderer.ts`: chỉ nhận `OfficeSnapshot`, phát `onSelectEmployee`, animation chạy chỉ khi trạng thái đang hoạt động, ~60 fps với 10–20 nhân vật *(Typecheck; canvas WebGL chưa chạy trên trình duyệt, cần mở bằng `pnpm dev`.)*
- [X] T162 [US5] Tạo trang Virtual Office với nhãn "Trạng thái có thể đã cũ" trong `apps/web/src/office/VirtualOfficePage.tsx` *(Typecheck; kèm danh sách nhân viên cùng store để thao tác và kiểm thử được qua DOM.)*
- [X] T163 [P] [US5] Tạo panel Employee Profile đủ mục FR-038 trong `apps/web/src/office/EmployeeProfilePanel.tsx` *(Typecheck; chưa chạy trên trình duyệt.)*

- [X] T163a [US5] Rà soát constitution khi kết thúc Phase 3 lộ trình theo mục Governance, ghi kết quả vào `specs/001-claude-company-mvp/validation.md` *(Xem validation.md T163a.)*

**Checkpoint**: Trạng thái office khớp sự kiện thật; thay renderer không đụng logic nghiệp vụ

---

## Phase 8: User Story 6 - Theo dõi chi phí AI, tiến độ và giới hạn ngân sách (Priority: P2)

**Goal**: Đặt giới hạn theo bốn phạm vi, cảnh báo và chặn trước khi vượt, xem chi phí và tiến độ trên Company Dashboard.

**Independent Test**: Đặt ngân sách thấp cho một nhân viên, giao task vượt mức: task bị chặn và chuyển người thật; Dashboard khớp số liệu từng task.

### Tests for User Story 6 ⚠️

- [X] T164 [P] [US6] Viết contract test `BudgetService` cho cảnh báo, overage và unit test làm tròn chi phí trong `tests/contract/budget-service.spec.ts` *(Đã viết và typecheck, chưa chạy: cần Docker cho PostgreSQL; xem validation.md mục US6. Phần reserve/commit lõi vẫn ở `budget-core.spec.ts`; file này thêm chính sách, cảnh báo bền vững, `allowed_models`, giới hạn đồng thời, usage theo phạm vi.)*
- [X] T165 [P] [US6] Viết security test trong `tests/security/budget-enforcement.spec.ts`: 100% task sắp vượt bị chặn (SC-009) ở cả 4 scope và trần task; giới hạn chạm trước thắng; giới hạn token và `token_cap` chặn được run `claude_agent_sdk` dù còn ngân sách USD; hai run đồng thời không cùng vượt; lời gọi đơn lẻ vượt → `is_overage` và chặn lượt sau; đặt lại đầu tháng theo timezone công ty; model ngoài `allowed_models` bị từ chối khi tạo/sửa và khi bắt đầu run *(Đã viết và typecheck, chưa chạy: cần Docker cho PostgreSQL; xem validation.md mục US6.)*
- [X] T165a [P] [US6] Viết security test trong `tests/security/budget-dashboard-scope.spec.ts`: Manager ngoài phạm vi → `403` khi đọc hoặc sửa `budget-policies`; Manager không sửa được scope company hoặc đơn vị cha; `/usage` và `/dashboard` chỉ trả dữ liệu trong phạm vi; `orgUnitId` ngoài phạm vi → `403` *(Đã viết và typecheck, chưa chạy: cần Docker cho PostgreSQL và Redis; xem validation.md mục US6.)*
- [X] T166 [P] [US6] Viết integration test trong `tests/integration/dashboard-usage.spec.ts`: Dashboard và Profile khớp tổng theo task ±1% (SC-008); lọc theo phòng ban; On-time Completion Rate chỉ đếm task gốc và `null` khi chưa có task `completed`; cảnh báo 80% chỉ một lần mỗi ngưỡng/scope/kỳ; `max_concurrent_tasks` theo team, org_unit, company; `overload_warning` tối đa một lần mỗi ngày *(Đã viết và typecheck, chưa chạy: cần Docker cho PostgreSQL; xem validation.md mục US6. Cảnh báo 80% kiểm ở mức `BudgetService.commit` và nhật ký `budget_warning_log`; đường thông báo từ run-loop vẫn do `apps/worker/test/run-loop-approval.spec.ts` kiểm.)*

### Implementation for User Story 6

- [X] T167 [P] [US6] Khai báo Zod DTO BudgetPolicy, Usage, Dashboard trong `packages/contracts/src/budget.ts` *(Thêm `budgetScopeKindSchema`, `putBudgetPolicySchema`, `usageQuerySchema`, `dashboardQuerySchema`, type `BudgetPolicy`, `Dashboard`, `ConcurrencyLimit`.)*
- [X] T168 [US6] Bổ sung vào `apps/api/src/platform/usage-budget/budget.service.ts`: cảnh báo theo `warn_threshold` (notification `budget_warning` gửi người nhận theo T106a, chỉ một lần mỗi ngưỡng/scope/kỳ), ghi overage và chặn lượt sau *(Cảnh báo ngưỡng giờ bền vững qua bảng `budget_warning_log` (migration `0009_budget_warning_log.sql`, chưa áp dụng lên PostgreSQL): mỗi (phạm vi, kỳ, loại, giới hạn, ngưỡng) một lần, kể cả khi hạ ngưỡng xuống dưới mức đang dùng. Thêm `getPolicy`/`upsertPolicy` (công ty luôn có giới hạn token và chi phí), `allowedModelsFor`, `getConcurrencyLimits`, `getUsage({ scope })`. Việc gửi notification `budget_warning` vẫn do run-loop thực hiện từ kết quả `commit`.)*
- [X] T169 [US6] Áp `allowed_models` hiệu lực vào `create`/`update` trong `apps/api/src/engines/employee/employee.service.ts` (`422 MODEL_NOT_ALLOWED`) *(Kiểm tra khi tạo, và khi sửa `modelId` hoặc `homeOrgUnitId`, qua `BudgetService.allowedModelsFor` (giao danh sách của company, đơn vị và tổ tiên, team, nhân viên). Đã thêm ca vào `tests/contract/employee-engine.spec.ts`.)*
- [X] T170 [US6] Áp `max_concurrent_tasks` theo scope team, org_unit, company vào việc xếp hàng trong `apps/api/src/engines/orchestration/orchestration.service.ts`, gửi notification `overload_warning` (người nhận theo T106a) khi số task chờ slot đạt `max_concurrent_tasks`, tối đa một lần mỗi ngày cho mỗi nhân viên *(Logic nằm ở `scheduler.service.ts` và `concurrency-limits.ts` (cùng Orchestration Engine) thay vì `orchestration.service.ts`, vì đó là nơi cấp slot. Task rời `in_progress` đánh thức cả nhân viên cùng scope; `budget.policy_changed` kéo lập lịch lại khi nới giới hạn. `overload_warning` dedupe một lần mỗi ngày lịch theo múi giờ công ty bằng khóa Redis `SET NX`.)*
- [X] T171 [US6] Tạo `GET/PUT /budget-policies/{scopeKind}/{scopeId}` (scope `ai_employee` không nhận `max_concurrent_tasks`, gửi kèm → `422`) và `/usage` trong `apps/api/src/platform/usage-budget/budget.controller.ts`; gắn `@RequireScope`, `/usage` chỉ trả dữ liệu trong phạm vi người xem *(Thêm tham số lọc `orgUnitId`, `employeeId`, `taskId` cho `/usage`; cả GET và PUT chính sách dùng quyền `budget.manage` theo phạm vi trong đường dẫn.)*
- [X] T172 [US6] Tạo `GET /dashboard` từ `usage_ledger` và `TaskEngine.getStats`, lọc `orgUnitId`, trong `apps/api/src/platform/usage-budget/dashboard.service.ts` và `apps/api/src/platform/usage-budget/dashboard.controller.ts`; gắn `@RequireScope`, chỉ tổng hợp trong phạm vi người xem, `orgUnitId` ngoài phạm vi → `403` *(Thêm `period` (mặc định tháng hiện tại, hoặc `all`) và `allTime` vào kết quả; `TaskEngine.getStats` nhận thêm `scope` để Manager chỉ thấy phạm vi của mình.)*
- [X] T173 [P] [US6] Tạo Company Dashboard (Total Employees, Active Tasks, Completed Tasks, On-time Completion Rate, token, chi phí, lọc phòng ban) trong `apps/web/src/features/dashboard/DashboardPage.tsx` *(Typecheck; chưa chạy trên trình duyệt.)*
- [X] T174 [P] [US6] Tạo màn hình cấu hình giới hạn theo scope trong `apps/web/src/features/budget/BudgetSettingsPage.tsx`, và luồng tăng hạn mức rồi `resume` task bị chặn *(Typecheck; chưa chạy trên trình duyệt. Đổi tên module màn hình `features/budget/BudgetPage` thành `BudgetSettingsPage` trong `screens.ts`. Luồng tăng hạn mức rồi `resume` liệt kê task `blocked` vì `BUDGET_EXCEEDED`.)*
- [X] T175 [US6] Thêm mục token và chi phí theo task vào `apps/web/src/features/employees/EmployeeDetailPage.tsx` *(Typecheck; chưa chạy trên trình duyệt. Component `EmployeeUsageSection.tsx`.)*

**Checkpoint**: Không có chi tiêu vượt mức âm thầm; Dashboard khớp từng task

---

## Phase 9: User Story 7 - Truy vết, xử lý lỗi và phục hồi (Priority: P2)

**Goal**: Xem đầy đủ lịch sử thực thi, xử lý timeout/retry tường minh, phục hồi sau restart không mất hoặc lặp việc.

**Independent Test**: Buộc một run thất bại và restart worker giữa chừng; lịch sử giải thích nguyên nhân, công việc không mất hay lặp.

### Tests for User Story 7 ⚠️

- [X] T176 [P] [US7] Viết integration test US7-AS2 trong `tests/integration/run-retry.spec.ts`: timeout và lỗi provider được retry theo chính sách, hết lượt → `blocked`, `RETRIES_EXHAUSTED` kèm nguyên nhân + notification; thời gian `waiting_approval` không tính vào timeout; file đã ghi của lần chạy trước còn nguyên ở lần retry *(Đã chạy pass trên PostgreSQL cục bộ bằng `node scripts/test-local.mjs`; xem validation.md mục US7. Ca file còn nguyên ở lần retry dựng bằng cách ghi file vào thư mục của lần chạy lỗi rồi chạy lần retry.)*
- [X] T177 [P] [US7] Viết integration test US7-AS3 (SC-010) trong `tests/integration/run-recovery.spec.ts`: kill worker giữa run; mặc định `SDK_RESUME_AFTER_CRASH = false` → run `failed`, task `blocked`, `RUN_INTERRUPTED`; `resume` tạo run mới có đủ file của run bị kill, kể cả thay đổi chưa commit; cờ bật → resume, `resume` lỗi cũng báo lỗi rõ; resume hoặc retry gọi lại hành động nhóm `dedupe` đã `succeeded` không chạy lại; `executing` không xác định → `unknown` + `blocked`, `TOOL_OUTCOME_UNKNOWN`; run `waiting_approval` vẫn chờ, approve sau restart thì resume được ở cả hai runtime *(Đã chạy pass trên PostgreSQL cục bộ bằng `node scripts/test-local.mjs`; xem validation.md mục US7. Worker chết được mô phỏng bằng run `running` quá hạn heartbeat và job bị mất; không kill tiến trình thật. Cờ `SDK_RESUME_AFTER_CRASH` được bật bằng cách đặt trên đối tượng config của harness.)*
- [X] T178 [P] [US7] Viết security test US7-AS4 trong `tests/security/run-history-scope.spec.ts`; `run_step.payload` không chứa secret *(Đã chạy pass trên PostgreSQL cục bộ bằng `node scripts/test-local.mjs`; xem validation.md mục US7.)*

### Implementation for User Story 7

- [X] T179 [P] [US7] Khai báo DTO `AgentRunSummary`, `AgentRunDetail` trong `packages/contracts/src/run.ts` *(Thêm `runListQuerySchema`, `RunListFilter`, `RunUsage`, `AgentRunView` vào `run.ts`; `AgentRunSummary`/`AgentRunDetail` đã có từ US3. `listRuns` nhận thêm `employeeIds` (phạm vi) và `limit`; `BudgetService.getUsage` nhận thêm `runId` để tính usage của một run.)*
- [X] T180 [US7] Thêm heartbeat, timeout (run 15 phút, model 2 phút, tool 5 phút, không tính thời gian `waiting_approval`) và retry backoff mũ 2s→30s vào `apps/worker/src/runtime/run-loop.ts`; hết lượt → `blocked`, `RETRIES_EXHAUSTED` + notification `task_error` *(Phần lớn đã có từ T113: heartbeat, timeout run/model/tool (15 phút/2 phút/5 phút), backoff mũ 2s→30s, hết lượt → `blocked` `RETRIES_EXHAUSTED`; thông báo `task_error` do Task Engine phát từ `task.status_changed` (`task-notifications.ts`). Thời gian `waiting_approval` không tính vì hạn run gắn với mỗi job và resume là job mới. Rà soát lại, không cần sửa thêm.)*
- [X] T181 [US7] Triển khai `recoverStaleRuns` trong `apps/api/src/engines/orchestration/recovery.service.ts`: duyệt công ty qua `list_companies_with_active_runs()`, run `running` quá hạn heartbeat: chỉ khi `SDK_RESUME_AFTER_CRASH = true` và có `provider_session_id` mới `resume`, còn lại hoặc `resume` lỗi thì đánh dấu lỗi `RUN_INTERRUPTED` kèm nguyên nhân và task `blocked`; `tool_invocation` kẹt `executing` hỏi `adapter.lookup` qua token `TOOL_ADAPTER_LOOKUP`, không xác định được → `unknown` + `blocked`, `TOOL_OUTCOME_UNKNOWN`, không thực hiện lại; release `budget_reservation` còn `held` của run đã chết *(Đã có từ T100/US4 trong `orchestration.service.ts` (`recoverStaleRuns`, `recoverOne`), được kiểm ở T177; không đổi thêm.)*
- [X] T182 [US7] Chạy sweeper khi worker khởi động và định kỳ trong `apps/worker/src/jobs/recovery-sweeper.ts` *(Tách `recoverOnce` ra `recovery-sweeper.ts` (không ném lỗi), `WorkerRuntime` chạy ngay khi khởi động rồi định kỳ cùng sweeper (`sweepOnce` gọi lại hàm này). Có unit test `recovery-sweeper.spec.ts`.)*
- [X] T183 [US7] Tạo `GET /runs`, `GET /runs/{id}` (steps, tool invocation với mức quyền và kết quả, lỗi, thời gian, usage) trong `apps/api/src/engines/orchestration/run.controller.ts` *(Thêm `RunController` vào `OrchestrationModule`; quyền `run.read`, danh sách lọc theo `ManagedScope`, chi tiết kiểm `authorize` trên nhân viên của run và kèm `usage`. Typecheck; kiểm bằng T178 (đã chạy pass).)*
- [X] T184 [P] [US7] Tạo danh sách lịch sử lọc theo task/nhân viên trong `apps/web/src/features/history/RunHistoryPage.tsx` *(Typecheck; chưa chạy trên trình duyệt. Router vào `HistoryPage.tsx` (chuyển danh sách/chi tiết bằng `?run=`), có liên kết từ chi tiết task. Logic thuần ở `history-model.ts` có unit test.)*
- [X] T185 [P] [US7] Tạo chi tiết run làm nổi bật nguyên nhân lỗi (SC-011) trong `apps/web/src/features/history/RunDetailPage.tsx` *(Typecheck; chưa chạy trên trình duyệt. Nguyên nhân lỗi nằm khung `role=alert` ở đầu trang; nội dung do AI/tool sinh ra hiển thị là văn bản thuần.)*

**Checkpoint**: Q10 đạt; lịch sử chẩn đoán được nguyên nhân thất bại

---

## Phase 10: User Story 8 - Cột mốc gamification nhẹ (Priority: P3)

**Goal**: Ghi nhận cột mốc từ sự kiện thật, đúng một lần, không dựa trên token hay thời lượng chạy.

**Independent Test**: Tạo AI Employee đầu tiên, cột mốc xuất hiện đúng một lần; tiêu tốn nhiều token không sinh cột mốc.

### Tests for User Story 8 ⚠️

- [X] T186 [P] [US8] Viết contract test `GamificationEngine` trong `tests/contract/gamification-engine.spec.ts` *(Đã chạy pass trên PostgreSQL cục bộ bằng `node scripts/test-local.mjs`; xem validation.md mục US8. Thêm `gamification` vào `FlowHarness`.)*
- [X] T187 [P] [US8] Viết integration test US8-AS1, AS2 và phát lại cùng sự kiện không tạo bản ghi thứ hai, trong `tests/integration/milestones.spec.ts` *(Đã chạy pass trên PostgreSQL cục bộ bằng `node scripts/test-local.mjs`; xem validation.md mục US8. Ca AS2 dùng runtime `messages_api` với usage rất lớn để token thật sự được tiêu mà không sinh cột mốc.)*

### Implementation for User Story 8

- [X] T188 [US8] Tạo schema `milestone` trong `packages/db/src/schema/gamification.ts`: `key` enum `first_employee`,`first_department`,`first_approved_task`; `achieved_at`; `source_event_seq`; `UNIQUE(company_id, key)`; sinh migration kèm RLS *(Migration `0010_gamification_milestone.sql` (chưa áp dụng lên PostgreSQL) kèm `enable_company_rls`. Quyết định: phòng ban do cơ cấu mẫu dựng lúc tạo công ty không tính cho First Department; `org_unit.created` mang cờ `fromTemplate` để phân biệt.)*
- [X] T189 [US8] Triển khai `GamificationEngine.onDomainEvent` trong `apps/api/src/engines/gamification/gamification.service.ts`, không đọc `usage_ledger` hoặc thời lượng run, phát `milestone.achieved`; đăng ký module trong `apps/api/src/engines/gamification/gamification.module.ts` *(Quy tắc thuần ở `milestone-rules.ts` (chỉ nhìn loại sự kiện và `kind`, `fromTemplate`, `from`, `to`) nên không thể đọc token hay thời lượng; ghi bằng `ON CONFLICT DO NOTHING` nên idempotent; `milestone.achieved` chỉ phát ở lần ghi thành công và ánh xạ ra room công ty cho mọi thành viên. `GamificationEngine` thêm phương thức `list`. Unit test `milestone-rules.spec.ts` pass.)*
- [X] T190 [US8] Tạo `GET /milestones` trong `apps/api/src/engines/gamification/gamification.controller.ts` *(Typecheck; kiểm bằng T187 (đã chạy pass). Quyền `MemberScope`: cột mốc là thông tin của cả công ty, không nhạy cảm.)*
- [X] T191 [P] [US8] Tạo màn hình Achievement (tên `milestone` chỉ dùng trong code) trong `apps/web/src/features/milestones/MilestonesPage.tsx` *(Typecheck; chưa chạy trên trình duyệt. Thêm thông báo nổi `MilestoneToast` ở Layout khi nhận `milestone.achieved`. Router dùng `MilestonesPage` thay cho tên cũ `AchievementPage` trong `screens.ts`. Unit test `milestone-model.spec.ts` pass.)*

**Checkpoint**: Tất cả user story hoạt động độc lập

---

## Phase 11: Polish & Cross-Cutting Concerns

**Purpose**: Hoàn thiện xuyên suốt và kiểm chứng toàn bộ

- [X] T192 [P] Sinh OpenAPI từ Zod và phục vụ tại `/api/v1/docs` (chỉ non-production) trong `apps/api/src/platform/http/openapi.ts` *(Bảng route ở `openapi.ts` dùng đúng schema Zod của contracts; `registerOpenApi` phục vụ `/api/v1/docs` (HTML tự chứa) và `/api/v1/docs/openapi.json`, không đăng ký ở production. Unit test `openapi.spec.ts` đối chiếu bảng với route thật của 13 controller nên thêm/xóa route mà quên cập nhật tài liệu sẽ fail; test HTTP ở `tests/security/http-hardening.spec.ts` (đã chạy pass). Response chỉ khai báo `2XX`/`4XX` chung, chưa mô tả schema từng response.)*
- [X] T193 [P] Thêm giới hạn tần suất đăng nhập, security headers và CSP trong `apps/api/src/platform/http/security.ts` *(`security.ts`: header bảo mật + CSP cho mọi phản hồi API, `AuthRateLimitGuard` (mã lỗi mới `RATE_LIMITED`/429 kèm `Retry-After`; theo cặp (IP, email) và theo IP; đếm trong bộ nhớ từng instance), `docker/nginx.conf` thêm CSP khớp `WEB_CSP`. Cấu hình `LOGIN_RATE_LIMIT_MAX`, `LOGIN_RATE_LIMIT_WINDOW_MS`, `TRUST_PROXY`. Unit test `security-http.spec.ts` pass; `tests/security/http-hardening.spec.ts` chạy pass trên PostgreSQL cục bộ. Đồng thời sửa `docker/nginx.conf`: `proxy_pass http://api:3000/` cắt mất tiền tố `/api/` nên mọi request API sẽ 404, và thiếu proxy `/socket.io/` (client dùng path mặc định, không phải `/realtime/`).)*
- [X] T194 [P] Viết `README.md` tiếng Việt: kiến trúc, chạy local, biến cấu hình, cách thêm `ActionType` mới *(Viết `README.md` ở gốc repo: kiến trúc, luồng dữ liệu, dịch vụ/mạng Docker, chạy local (Docker và không Docker), kiểm thử, bảng biến cấu hình, quy trình thêm `ActionType`.)*
- [ ] T195 [P] Đo SC-005, SC-007, ~60 fps với 10–20 nhân vật (đếm `requestAnimationFrame`), API đọc < 300 ms p95 trong `tests/e2e/performance.spec.ts`, ghi kết quả vào `specs/001-claude-company-mvp/validation.md` *(Chưa làm: cần trình duyệt và stack đầy đủ để đo fps và độ trễ; chưa có `tests/e2e/performance.spec.ts`.)*
- [ ] T196 Xác nhận chạy toàn bộ bằng `docker compose -f docker/docker-compose.yml up --build` và sửa cấu hình trong `docker/docker-compose.yml` nếu cần *(Chưa xác nhận: chưa chạy `docker compose up --build` (máy không có Docker). Đã rà tĩnh và sửa 3 lỗi cấu hình (proxy `/api` và `/socket.io` của nginx, thiếu bước migrate/seed); xem validation.md.)*
- [ ] T197 Chạy thủ công Q1–Q12 và truy vết SC-014 theo `specs/001-claude-company-mvp/quickstart.md`, ghi kết quả kèm bằng chứng vào `specs/001-claude-company-mvp/validation.md` *(Chưa làm: cần chạy thủ công trên trình duyệt với stack đầy đủ.)*
- [ ] T198 Tổ chức thử với tối thiểu 10 người chưa từng dùng sản phẩm cho SC-001 và SC-013, ghi số liệu vào `specs/001-claude-company-mvp/validation.md` *(Chưa làm: cần tổ chức thử với người dùng thật.)*
- [X] T199 Rà soát Definition of Done của constitution (mọi action có mức quyền, mọi hành vi agent có đo chi phí và logging, không vi phạm lint ranh giới engine), ghi kết quả vào `specs/001-claude-company-mvp/validation.md` *(Rà soát toàn bộ US1–US8, ghi vào validation.md; `definition-of-done.spec.ts` kiểm tự động phần mức quyền và ranh giới SDK. Mục review bởi người khác tác giả thuộc quy trình PR, chưa có PR để đối chiếu.)*
- [ ] T200 Đối chiếu kết quả rà soát T077a, T143a, T163a, xác nhận mọi điểm cần sửa đã được xử lý trước khi phát hành, ghi kết quả vào `specs/001-claude-company-mvp/validation.md` *(Đã đối chiếu và ghi vào validation.md nhưng chưa thể xác nhận mọi điểm đã xử lý: còn các điểm mở (Redis, E2E, fps, T088/T090/T111/T111a/T131, giá model).)*

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: Bắt đầu ngay
- **Foundational (Phase 2)**: Sau Setup, chặn mọi user story
- **User Stories (Phase 3–10)**: Sau Foundational, theo thứ tự trong đồ thị dưới đây
- **Polish (Phase 11)**: Sau các story muốn phát hành

### User Story Dependencies

```text
Foundational → US1 → US2 → US3 → US4 ┬→ US5
                                     ├→ US6
                                     └→ US7
US1 + US2 → US8 (first_approved_task cần US3)
```

- **US1 (P1)**: Chỉ cần Foundational; dùng stub cho `TaskEngine` và phần nhân viên AI của `EmployeeEngine` (T041); human member là triển khai thật (T041a)
- **US2 (P1)**: Cần US1 (phòng ban, người quản lý)
- **US3 (P1)**: Cần US2 (nhân viên). Các hành động nhạy cảm bị từ chối fail-closed cho đến khi xong US4 (D6). Trước khi có API ngân sách ở US6 (T171), hạn mức mặc định được đổi qua `DEFAULT_MONTHLY_COST_LIMIT_USD`, `DEFAULT_MONTHLY_TOKEN_LIMIT`
- **US4 (P1)**: Cần vòng lặp run của US3
- **US5 (P2)**: Cần US3 + US4 để có sự kiện thật; có thể song song với US6, US7
- **US6 (P2)**: Cần `BudgetService` lõi từ US3
- **US7 (P2)**: Cần vòng lặp run của US3 và adapter của US4
- **US8 (P3)**: Hai cột mốc đầu chỉ cần US1 + US2; `first_approved_task` cần US3

### Within Each User Story

- Test viết trước và phải FAIL
- Schema → DTO → service → controller → UI
- Spike T090 nên xong trước T100, T138 (chỉ để tối ưu, không chặn); kết quả T090 quyết định cờ `SDK_RESUME_AFTER_CRASH` dùng ở T181
- T014 trước T009a; T036 trước T009b; T097 trước T097a; T097a trước T109, T113; T025 trước T023; T041 trước T035; T035a trước T036; T036 trước T041a; T041a trước T033, T034, T054; T069a trước T070; T082a trước T106a; T089a trước T108; T131a trước T138; T097 trước T098, T099
- Story xong rồi mới sang story ưu tiên kế tiếp

### Parallel Opportunities

- Setup: T003–T011
- Foundational: T013, T015–T018, T022, T027–T029, T031–T032, T035a, T039–T040, T042–T043, T045–T046
- Sau US4: US5, US6, US7 có thể do người khác nhau làm song song. Lưu ý các file dùng chung: `orchestration.service.ts` (T115, T140, T142a, T170), `run-loop.ts` (T113, T180), `EmployeeDetailPage.tsx` (T076, T175)

---

## Parallel Example: User Story 1

```bash
# Viết test cùng lúc:
Task: "Contract test OrganizationEngine trong tests/contract/organization-engine.spec.ts"
Task: "Integration test US1 trong tests/integration/organization.spec.ts"
Task: "Security test phạm vi trong tests/security/organization-scope.spec.ts"

# Các phần độc lập:
Task: "Seed template trong packages/db/src/seeds/org-templates.ts"
Task: "Zod DTO trong packages/contracts/src/organization.ts"
```

## Parallel Example: User Story 3

```bash
# Provider model độc lập với nhau:
Task: "FakeModelProvider trong packages/model-gateway/src/providers/fake.provider.ts"
Task: "MessagesApiProvider trong packages/model-gateway/src/providers/messages-api.provider.ts"

# Engine hỗ trợ:
Task: "CommunicationEngine trong apps/api/src/engines/communication/communication.service.ts"
Task: "MemoryEngine trong apps/api/src/engines/memory/memory.service.ts"
```

---

## Implementation Strategy

### Lõi P1 trước (US1 → US4)

Spec coi US1–US3 là lõi MVP, và US4 phải có trước khi AI được thực hiện hành động nhạy cảm, nên mốc đầu tiên là cả bốn story P1. MVP đầy đủ theo constitution còn gồm Virtual Office (US5) và thống kê chi phí (US6).

1. Hoàn tất Phase 1 và Phase 2
2. US1 → kiểm chứng Q1
3. US2 → kiểm chứng Q2
4. US3 → kiểm chứng Q3–Q5
5. US4 → kiểm chứng Q6, Q7
6. **STOP and VALIDATE**: `pnpm test:security` và `pnpm test:contract` pass

### Incremental Delivery

1. US5 → Virtual Office (Q8)
2. US6 → ngân sách và Dashboard (Q9)
3. US7 → truy vết và phục hồi (Q10)
4. US8 → cột mốc (Q12)
5. Phase 11 → kiểm chứng toàn bộ (Q11, SC-001, SC-013)

### Parallel Team Strategy

Cả nhóm làm chung Phase 1–2 và US1–US4 theo thứ tự. Sau đó chia US5, US6, US7 cho từng người.

---

## Notes

- [P] = khác file, không phụ thuộc task chưa xong
- Mọi thay đổi chạm Permission, Task, Orchestration engine hoặc tenant isolation cần review kỹ hơn (constitution)
- Mỗi bản sửa lỗi phải kèm regression test
- Tránh: engine truy cập bảng của engine khác, feature code import SDK nhà cung cấp, trạng thái office không có `domain_event` nguồn
