# Claude Company

Công ty AI ảo vận hành thật: một người thật (CEO/Manager) dựng cơ cấu tổ chức, tuyển **AI Employee**, giao task và nhận **artifact** thực thi thật. Quyền hạn của AI được cưỡng chế phía server, hành động nhạy cảm luôn qua **Human Approval**, chi phí bị giới hạn theo ngân sách, và **Virtual Office** phản ánh trạng thái thật theo thời gian thực.

Phiên bản hiện tại là v1.0 (MVP, Phase 1–3 của lộ trình sản phẩm). Định hướng sản phẩm nằm ở `ref/Claude_Company_Product_Concept_V1.docx`; các nguyên tắc bắt buộc nằm ở `.specify/memory/constitution.md`; đặc tả, kế hoạch và danh sách task nằm ở `specs/001-claude-company-mvp/`.

## Kiến trúc

Monorepo pnpm, TypeScript trên Node.js 24.

```text
apps/
  api/       NestJS 11: REST + Socket.IO. Mỗi engine là một module độc lập (xem bên dưới).
  worker/    Chạy job BullMQ: vòng lặp AgentRun, ToolBroker, thực thi action đã duyệt, sweeper.
  web/       React 19 + Vite + TanStack Query. Virtual Office render bằng PixiJS 8.
packages/
  contracts/       Zod schema và type dùng chung: DTO REST, sự kiện realtime, interface engine, mã lỗi.
  policy/          Danh mục ActionType, mức quyền mặc định, hàm đánh giá quyền thuần, parser lệnh shell.
  db/              Drizzle schema, migration, RLS, seed.
  model-gateway/   Interface ModelGateway và các provider (claude-agent-sdk, messages-api, fake).
tests/             contract / integration / security / e2e (Playwright).
docker/            Dockerfile từng app, docker-compose.yml, nginx.conf, egress-proxy, sandbox-runner.
```

### Các engine (trong `apps/api/src/engines/`)

| Engine            | Trách nhiệm                                                                             |
| ----------------- | --------------------------------------------------------------------------------------- |
| organization      | Company, Division/Department, Team, người quản lý theo phạm vi, cơ cấu mẫu              |
| employee          | AI Employee, thành viên là người thật, role template, chuỗi quản lý                     |
| task              | Task, vòng đời trạng thái, artifact, bằng chứng, review                                 |
| orchestration     | Lập lịch run, AI Manager phân rã, retry/timeout, phục hồi sau restart, lịch sử thực thi |
| permission        | ActionPolicy, ApprovalRequest, kiểm tra phạm vi                                         |
| communication     | Trao đổi gắn task, thông báo trong ứng dụng                                             |
| memory            | Ngữ cảnh và lịch sử làm việc theo phạm vi                                               |
| gamification      | Achievement cơ bản, chỉ cấp từ sự kiện nghiệp vụ thật                                   |
| office-simulation | Reducer trạng thái nhân viên, snapshot Virtual Office                                   |

Quy tắc ranh giới (kiểm bằng `eslint.config.mjs`): engine không import file nội bộ của engine khác và chỉ đụng bảng do mình sở hữu; `apps/worker` không import schema bảng mà gọi interface engine; chỉ `packages/model-gateway/src/providers/**` được import `@anthropic-ai/*`; chỉ `apps/web/src/office/renderer-pixi/**` được import `pixi.js`.

### Luồng dữ liệu chính

- **Một nguồn sự thật**: PostgreSQL 16 với Row-Level Security theo `company_id`. Mọi thay đổi nghiệp vụ ghi `domain_event` cùng transaction (outbox); relay phát sự kiện cho các engine khác và cho Socket.IO. Client phát hiện mất sự kiện qua `seq` liên tục và đồng bộ lại bằng snapshot.
- **Run của agent**: task được giao → Orchestration tạo `agent_run` và job BullMQ → worker chạy qua `ModelGateway`. Mọi lời gọi công cụ đi qua `ToolBroker` → `PermissionEngine`, ghi ledger `tool_invocation` có idempotency key. Chạy `claude_agent_sdk` luôn tắt built-in (`tools: []`) và chỉ dùng công cụ do hệ thống định nghĩa.
- **Human Approval**: agent chỉ tạo đề xuất; sau khi được duyệt, hệ thống (không phải agent) thực thi đúng payload đã duyệt (ràng buộc bằng hash) qua adapter. v1.0 chỉ có adapter dry-run, kết quả luôn có nhãn dry-run.
- **Phục hồi**: worker gửi heartbeat; run chết bị đánh dấu `RUN_INTERRUPTED` và task `blocked` để người thật quyết định. Chỉ khi bật `SDK_RESUME_AFTER_CRASH` mới thử resume session.
- **Ngân sách**: giữ chỗ (reserve) trước mỗi lượt gọi model, ghi `usage_ledger` sau đó, giới hạn theo công ty, đơn vị, team, nhân viên và task. Không có chính sách thì áp hạn mức mặc định.

### Dịch vụ và mạng khi chạy bằng Docker

| Service              | Vai trò                                                                             | Mạng                                       |
| -------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------ |
| postgres/redis/minio | Dữ liệu, hàng đợi và pub/sub, lưu artifact (S3)                                     | backend                                    |
| migrate              | Chạy một lần: migration rồi seed cấu hình toàn cục                                  | backend                                    |
| api, worker          | REST + realtime; chạy agent                                                         | api: backend+edge; worker: backend+sandbox |
| sandbox-runner       | Nơi duy nhất chạy lệnh shell/test của agent, mỗi run một UID riêng, không có secret | sandbox                                    |
| egress-proxy         | Lối ra internet duy nhất của worker, chỉ cho phép host API model                    | backend+edge                               |
| web                  | nginx phục vụ giao diện, proxy `/api` và `/socket.io`, gắn header bảo mật và CSP    | edge                                       |

Mạng `backend` và `sandbox` là `internal` (không có đường ra internet). Lệnh của agent không với tới Postgres, Redis, MinIO hay API model.

## Chạy local

### Bằng Docker Compose

```bash
cp docker/.env.example docker/.env     # rồi điền giá trị thật; KHÔNG commit docker/.env
docker compose -f docker/docker-compose.yml --env-file docker/.env up --build
```

Giao diện ở <http://localhost:8080>, API ở <http://localhost:3000/api/v1>, tài liệu API (chỉ khi không phải production) ở <http://localhost:3000/api/v1/docs>. Mặc định `MODEL_PROVIDER=fake` nên không tốn token; đặt `MODEL_PROVIDER=anthropic` và `ANTHROPIC_API_KEY` để chạy Claude thật.

### Máy không có Docker/pnpm (Windows)

```bash
node scripts/dev-local.mjs            # PostgreSQL + Redis + S3 giả + migrate/seed + api + worker + web
node scripts/dev-local.mjs --reset    # xóa dữ liệu dev trước khi chạy
```

Giao diện ở <http://localhost:5173>, API ở <http://localhost:3000/api/v1>. Script tạo cluster PostgreSQL riêng (cổng 55432) và cần Redis 6.2+ giải nén vào `%LOCALAPPDATA%\cc-dev-stack\redis` (hoặc đặt `REDIS_BIN`; bản Windows ở github.com/redis-windows/redis-windows). MinIO đã ngừng phân phối bản cài nên `scripts/dev-s3.mjs` thay bằng S3 giả lưu file ra đĩa. Dừng bằng Ctrl+C. Mặc định `MODEL_PROVIDER=fake`; lệnh shell của agent không chạy được vì không có `sandbox-runner`.

### Không dùng Docker (phát triển)

Cần Node.js 24, pnpm 12, PostgreSQL 16+ và Redis 7, MinIO (hoặc dịch vụ S3 tương thích).

```bash
pnpm install
pnpm db:migrate          # cần DATABASE_MIGRATION_URL và APP_DB_PASSWORD
pnpm db:seed
pnpm dev                 # api, worker và web song song
```

### Kiểm thử

| Lệnh                          | Phạm vi                                                                                  |
| ----------------------------- | ---------------------------------------------------------------------------------------- |
| `pnpm lint`                   | ESLint (gồm ranh giới engine) và Prettier                                                |
| `pnpm test:unit`              | Test đơn vị trong `test/` của từng package/app                                           |
| `pnpm test:contract`          | Contract test cho mọi interface engine và ModelGateway (cần PostgreSQL)                  |
| `pnpm test:integration`       | API + worker + PostgreSQL/Redis                                                          |
| `pnpm test:security`          | Phân quyền, phê duyệt, ngân sách, cô lập tenant, prompt injection                        |
| `pnpm test:e2e`               | Playwright (cần cả stack)                                                                |
| `node scripts/test-local.mjs` | Chạy contract + integration + security trên máy không có Docker, dùng PostgreSQL cài sẵn |

Các test dùng `FakeModelProvider` tất định nên không tốn token. Xem `CONTRIBUTING.md` để biết quy trình review.

## Biến cấu hình

Giá trị mẫu ở `docker/.env.example`; kiểm tra và giá trị mặc định ở `apps/api/src/platform/config/config.ts`. Thiếu biến bắt buộc thì ứng dụng không khởi động.

| Nhóm        | Biến                                                                                                            | Mặc định / ghi chú                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Model       | `MODEL_PROVIDER`, `ANTHROPIC_API_KEY`                                                                           | `fake`; `anthropic` bắt buộc có key                                    |
| Phiên       | `SESSION_SECRET`, `SESSION_TTL_SECONDS`                                                                         | secret ≥ 32 ký tự; TTL 7 ngày                                          |
| Dữ liệu     | `DATABASE_URL` (role `app_user`), `DATABASE_MIGRATION_URL` (role owner), `APP_DB_PASSWORD`, `REDIS_URL`, `S3_*` | bắt buộc                                                               |
| Hành động   | `ADAPTER_MODE`                                                                                                  | `dry_run`; `live` chưa cấu hình sẽ trả `ADAPTER_LIVE_NOT_CONFIGURED`   |
| Ngân sách   | `DEFAULT_MONTHLY_COST_LIMIT_USD`, `DEFAULT_MONTHLY_TOKEN_LIMIT`, `BUDGET_WARN_THRESHOLD`                        | 20 USD, 2.000.000 token, 0.8                                           |
| Runtime SDK | `SDK_BUDGET_HEADROOM`, `SDK_RUN_RESERVE_USD`, `SDK_RUN_RESERVE_TOKENS`, `SDK_RESUME_AFTER_CRASH`                | 0.1, 2, 200000, `false`                                                |
| Vòng đời    | `MAX_REWORK`, `RUN_TIMEOUT_MS`, `MODEL_TIMEOUT_MS`, `TOOL_TIMEOUT_MS`, `RETRY_MAX`                              | 3, 15 phút, 2 phút, 5 phút, 3                                          |
| Phê duyệt   | `APPROVAL_REPLAY_AFTER_MS`, `APPROVAL_REMINDER_FIRST_MS`, `APPROVAL_REMINDER_REPEAT_MS`                         | 2 phút, 1 giờ, 24 giờ (không bao giờ tự duyệt)                         |
| Sandbox     | `SANDBOX_RUNNER_URL`, `SANDBOX_RUNNER_TOKEN`, `EGRESS_PROXY_URL`, `EGRESS_ALLOWLIST`                            | compose tự đặt URL; token ≥ 16 ký tự                                   |
| Bảo mật     | `LOGIN_RATE_LIMIT_MAX`, `LOGIN_RATE_LIMIT_WINDOW_MS`, `TRUST_PROXY`                                             | 10 lần mỗi (IP, email) trong 15 phút; `TRUST_PROXY=true` khi sau nginx |
| Workspace   | `WORKSPACE_HOST_PATH`, `RUN_WORKTREES_PATH`, `DRY_RUN_LOG_PATH`                                                 | thư mục dữ liệu local                                                  |

Giới hạn đăng nhập đếm trong bộ nhớ của từng instance API; chạy nhiều instance thì giới hạn thực tế nhân theo số instance.

## Cách thêm `ActionType` mới

Mọi hành động của agent phải có mức quyền; hành động không có trong danh mục mặc định là `restricted` (fail-closed). Để thêm một `ActionType`:

1. **Danh mục và mức quyền** – thêm một `ActionDefinition` vào `ACTION_CATALOG` trong `packages/policy/src/catalog.ts`: `defaultLevel`, `floor` (mức tối thiểu không hạ được; hành động có tác dụng ra ngoài hoặc không hoàn tác được phải có `floor: 'human_approval'`), `runtimes` được phép và nhãn `idempotency` (`dedupe` cho hành động có tác dụng phụ, `rerun` cho hành động đọc/ghi cục bộ).
2. **Input** – nếu agent gọi được, thêm Zod schema vào `TOOL_INPUT_SCHEMAS` trong `packages/contracts/src/tool-inputs.ts`. Tên tool là `ActionType` đổi `.` thành `_`. Hành động Human Approval cho phép thêm trường `rationale` (không thuộc payload được băm).
3. **Mô tả cho model** – thêm mô tả vào `DESCRIPTIONS` trong `apps/worker/src/runtime/tool-specs.ts` (kiểu `Record` bắt buộc đủ khóa nên thiếu sẽ lỗi biên dịch).
4. **Thực thi**
   - Hành động tự thực thi hoặc cần review: thêm handler vào `apps/worker/src/tools/workspace-tools.ts` hoặc `internal-tools.ts`.
   - Hành động cần Human Approval: thêm adapter vào `apps/worker/src/tools/adapters/`, đăng ký trong `registry.ts` (`APPROVAL_ACTION_TYPES`). Agent không bao giờ tự thực thi; hệ thống thực thi sau khi duyệt. Adapter phải có `lookup(idempotencyKey)` để phục hồi sau restart xác định được kết quả.
5. **Giao diện duyệt** – thêm tóm tắt cho người duyệt trong `packages/policy/src/approval-summary.ts`, nhãn trong `apps/web/src/features/approvals/approval-model.ts` và `apps/web/src/i18n/vi.ts`.
6. **Kiểm thử** – cập nhật `packages/policy/test/evaluate.spec.ts`, `tests/security/unclassified-actions.spec.ts`, `tests/contract/tool-adapter.spec.ts`; hành động mới phải có test chứng minh không thể vượt quyền (kể cả khi nội dung task cố ép bỏ qua phê duyệt).
7. **Tài liệu** – cập nhật `specs/001-claude-company-mvp/contracts/action-policy.md`.

Hành vi agent mới phải có đo chi phí và logging (Nguyên tắc VII); mẫu pull request có mục xác nhận các điểm này.

## Tài liệu

- API: `/api/v1/docs` (OpenAPI 3.1 sinh từ Zod; không có ở production).
- Đặc tả và thiết kế: `specs/001-claude-company-mvp/` (`spec.md`, `plan.md`, `research.md`, `data-model.md`, `contracts/`, `quickstart.md`, `tasks.md`).
- Kết quả kiểm chứng và rà soát: `specs/001-claude-company-mvp/validation.md`.
