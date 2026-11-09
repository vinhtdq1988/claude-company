# Implementation Plan: Claude Company v1.0 (MVP) – Công ty AI ảo vận hành thật

**Branch**: `001-claude-company-mvp` | **Date**: 2026-11-09 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-claude-company-mvp/spec.md`

**Phase (Lộ trình MVP)**: Phase 1 + Phase 2 + Phase 3 (Phase 4–6 ngoài phạm vi).

## Summary

Xây dựng ứng dụng web cho phép một người thật (CEO/Manager) dựng công ty ảo (Company → Division → Department → Team → Employee), tuyển AI Employee, giao task và nhận artifact thực thi thật, với quyền hạn bốn mức được cưỡng chế phía server, Human Approval cho hành động nhạy cảm, giới hạn ngân sách theo tháng lịch, Virtual Office pixel art 2D phản ánh trạng thái thật theo thời gian thực và Company Dashboard.

Hướng kỹ thuật (chi tiết ở [research.md](./research.md)):

- Monorepo TypeScript: `apps/web` (React + PixiJS), `apps/api` (NestJS, REST + WebSocket), `apps/worker` (agent runtime chạy job từ hàng đợi), `packages/*` dùng chung (contract, model gateway, policy).
- Mỗi engine trong Nguyên tắc VI là một NestJS module có interface công khai; không module nào truy cập bảng của module khác.
- Truy cập model qua `ModelGateway` với hai runtime: `claude-agent-sdk` (vai trò làm việc với mã nguồn) và `messages-api` (vai trò tài liệu/phân tích), chọn theo từng AI Employee.
- Mọi lời gọi công cụ của agent đi qua `ToolBroker` → `PermissionEngine`. Runtime `claude-agent-sdk` tắt toàn bộ built-in (`tools: []`) và chỉ dùng MCP tool in-process do hệ thống viết; lệnh shell và test chạy trong service `sandbox-runner` tách biệt. Hành động Human Approval **không bao giờ do agent tự thực thi**: agent chỉ tạo đề xuất; sau khi được duyệt, hệ thống thực thi đúng payload đã duyệt (ràng buộc bằng hash) qua adapter (mặc định dry-run), rồi tiếp tục phiên agent.
- Thực thi bền vững: PostgreSQL là nguồn sự thật; ledger `tool_invocation` có idempotency key; job BullMQ trên Redis; phục hồi sau restart bằng cách đọc ledger, chỉ resume session khi đã kiểm chứng, ngược lại đánh dấu lỗi rõ ràng. Run `messages_api` chờ duyệt lưu hội thoại vào `run_conversation_state` để resume.
- Realtime: Socket.IO + Redis adapter; Office Simulation Engine là nguồn trạng thái duy nhất, phát sự kiện có số thứ tự tăng dần theo công ty để client phát hiện mất sự kiện và đồng bộ lại. Gateway lọc theo `ManagedScope` của từng socket trước khi phát.

## Technical Context

**Language/Version**: TypeScript 5.x trên Node.js 24 LTS (backend, worker); TypeScript 5.x + React 19 (frontend).

**Primary Dependencies**: NestJS 11 (REST, WebSocket gateway, DI theo module/engine); Drizzle ORM + `pg`; BullMQ; Socket.IO (+ `@socket.io/redis-adapter`); `@anthropic-ai/claude-agent-sdk` (runtime code roles); `@anthropic-ai/sdk` (Messages API cho vai trò tài liệu); Zod (schema dùng chung API/tool); React 19 + Vite + TanStack Query + React Router; PixiJS 8 (render Virtual Office); argon2 (băm mật khẩu); AWS SDK S3 client (lưu artifact, tương thích MinIO).

**Storage**: PostgreSQL 16 (dữ liệu nghiệp vụ, ledger, sự kiện; Row-Level Security theo `company_id`); Redis 7 (hàng đợi BullMQ, pub/sub realtime, session store); lưu trữ tương thích S3 – MinIO khi chạy local (artifact, file đầu ra).

**Testing**: Vitest (unit + contract test cho interface engine và `ModelGateway`); Supertest + Testcontainers (PostgreSQL, Redis) cho integration test API/worker; Playwright (E2E luồng chính và Virtual Office); `FakeModelProvider` tất định để test không tốn token; bộ test bảo mật riêng cho phân quyền, phê duyệt, ngân sách, cô lập tenant, lan truyền trạng thái.

**Target Platform**: Linux server qua Docker Compose (api, worker, sandbox-runner, egress-proxy, web, postgres, redis, minio); trình duyệt desktop hiện đại (Chrome/Edge/Firefox bản mới).

**Project Type**: Web application (frontend + backend + worker).

**Performance Goals**: Trạng thái nhân viên lên Virtual Office ≤ 3 giây p95 sau sự kiện thật (SC-005); mở Employee Profile < 1 giây khi 10 AI Employee hoạt động (SC-007); Virtual Office giữ ~60 fps với 10–20 nhân vật; API đọc thường dùng < 300 ms p95.

**Constraints**: Phân quyền cưỡng chế phía server ở mọi request; secret không vào source control hoặc client; hành động nhạy cảm luôn qua Human Approval (kể cả adapter dry-run); không âm thầm vượt ngân sách; không mất/lặp hành động sau restart; giao diện tiếng Việt, thuật ngữ sản phẩm giữ tiếng Anh.

**Scale/Scope**: v1.0: 1 công ty, 1 người dùng thật, 5–10 AI Employee (thiết kế chịu được ~50), tối đa ~10 run đồng thời; ~15 màn hình (auth, onboarding, org chart, employee list/profile/form, task board/detail, approvals inbox, notifications, dashboard, budget settings, virtual office, execution history).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Nguyên tắc | Cổng kiểm tra | Cách plan đáp ứng | Trước P0 | Sau P1 |
|---|---|---|---|---|
| I. Công việc thật | Task trả artifact kiểm chứng; không chat/animation giả; Achievement không dựa trên token | Artifact lưu S3 + bảng `artifact`/`evidence`; `Communication` chỉ có `task_message` gắn task; trạng thái office chỉ từ sự kiện; milestone chỉ từ sự kiện nghiệp vụ (FR-045); hành động nhạy cảm chỉ dry-run và luôn có nhãn (xem Complexity Tracking) | ✅ | ✅ |
| II. Con người lãnh đạo, NON-NEGOTIABLE | Manager trực tiếp + chuỗi kết thúc ở người thật; 4 mức quyền, mặc định Restricted; hành động nhạy cảm cưỡng chế bởi hệ thống; quy trình review; ghi quyết định | Ràng buộc chuỗi quản lý kiểm tra ở `EmployeeEngine` (và test); `PermissionEngine` + `ToolBroker` là điểm duy nhất; danh mục `action_type` sensitive khóa cứng ở mức Human Approval (không cấu hình hạ được); hệ thống (không phải agent) thực thi payload đã duyệt; mọi task qua AI Manager (xác nhận hoặc phân rã) trước khi chạy, review do AI Manager độc lập; mọi quyết định bắt buộc lý do; `review_record` bất biến | ✅ | ✅ |
| III. Tổ chức do người dùng định nghĩa, cô lập | Cấu trúc tùy biến; template không cứng; manager theo scope; nhiều team; đa tenant từ mô hình dữ liệu | Bảng `org_unit` tự tham chiếu với `kind`; template là dữ liệu seed JSON; `management_assignment`; `team_membership` nhiều-nhiều; mọi bảng có `company_id` + RLS + guard scope; server lọc realtime và snapshot theo phạm vi | ✅ | ✅ |
| IV. Tiến độ trung thực | Trạng thái suy ra từ sự kiện; realtime từ nguồn duy nhất; Profile đủ trường; trình bày tách domain | `OfficeSimulationEngine` là reducer thuần trên `domain_event`; Socket.IO + seq; `apps/web/src/office/` render chỉ nhận `OfficeSnapshot`; renderer PixiJS có thể thay | ✅ | ✅ |
| V. Chi phí và năng lực | Giới hạn token/ngân sách/đồng thời/model theo 4 scope; đo theo task/employee; chặn trước khi vượt | `budget_policy` + `usage_ledger`; `messages_api` reservation trước mỗi lượt gọi model, `claude_agent_sdk` reservation theo run cộng `maxBudgetUsd` có headroom, đếm token sau mỗi lượt và khóa tool trước giới hạn token; không có policy thì áp hạn mức mặc định; vượt → `Blocked` + Human escalation | ✅ | ✅ |
| VI. Độc lập model, tách engine | Model qua abstraction; engine riêng, interface rõ; runtime theo từng employee; hồ sơ là hợp đồng | `packages/model-gateway` (feature code không import SDK nhà cung cấp – lint rule chặn); 9 engine + module hạ tầng; `employee.runtime_kind` cấu hình từng nhân viên; `EmployeeProfile` schema Zod dùng chung | ✅ | ✅ |
| VII. Bằng chứng, tin cậy, quan sát | Task đủ trường; review độc lập; log/trace; timeout/retry; phục hồi không mất/lặp | Validation tạo task; reviewer ≠ người tạo đầu ra (kiểm tra ID); `agent_run` + `run_step` + OpenTelemetry trace id; retry policy cấu hình; ledger idempotent (key ổn định cho hành động có tác dụng phụ) + recovery sweeper | ✅ | ✅ |
| VIII. Tăng dần, MVP | Thứ tự phase; không đưa XP phức tạp/multiplayer; YAGNI | Thứ tự triển khai US1→US8; chỉ milestone cơ bản; không chat công ty, không billing; mô hình dữ liệu không chặn Phase 4–6 | ✅ | ✅ |
| Ràng buộc công nghệ | Stack mặc định; kiểm chứng khả năng Claude; Docker | Đúng stack mặc định (React/TS, PixiJS, NestJS, PostgreSQL, Redis, WebSocket, Claude API + Claude Code qua Agent SDK, S3, Docker). Các khả năng Agent SDK mà thiết kế dựa vào đã kiểm chứng với tài liệu chính thức ngày 2026-11-09 (xem research R3); điểm tài liệu chưa nêu (`resume` sau dừng cứng hoặc crash) chỉ được dùng khi spike T090 xác nhận và bật `SDK_RESUME_AFTER_CRASH`; mặc định recovery đánh dấu lỗi rõ ràng | ✅ | ✅ |
| Cổng chất lượng | Test tự động cho permission/approval/budget/tenant/state; contract test cho engine + model layer | Ghi rõ trong Testing; `tests/security/` và `tests/contract/` là bắt buộc trong tasks | ✅ | ✅ |

**Kết quả**: Không có vi phạm chưa được biện minh. Có một điểm lệch nhỏ khỏi stack mặc định (thêm process `worker`, các service `sandbox-runner`, `egress-proxy`, dùng Socket.IO thay vì WebSocket thô) – vẫn nằm trong stack (Node/NestJS, "WebSocket hoặc tương đương"), ghi tại Complexity Tracking để minh bạch. Các phần đưa sớm từ Phase 4–5 và ngoại lệ tài khoản Manager cũng được ghi tại đó.

## Project Structure

### Documentation (this feature)

```text
specs/001-claude-company-mvp/
├── plan.md              # File này
├── research.md          # Phase 0
├── data-model.md        # Phase 1
├── quickstart.md        # Phase 1
├── contracts/           # Phase 1
│   ├── rest-api.md
│   ├── realtime-events.md
│   ├── engine-interfaces.md
│   └── action-policy.md
├── checklists/
├── tasks.md             # Phase 2 (/speckit-tasks)
└── validation.md        # Kết quả kiểm chứng, tạo ở T077a, hoàn thiện ở bước Polish
```

### Source Code (repository root)

```text
apps/
├── api/                         # NestJS: REST + WebSocket gateway
│   ├── src/
│   │   ├── engines/
│   │   │   ├── organization/    # Company, OrgUnit, Team, ManagementAssignment, template
│   │   │   ├── employee/        # AI Employee, HumanMember, role template, chuỗi quản lý
│   │   │   ├── task/            # Task, vòng đời FR-020a, artifact, evidence, review
│   │   │   ├── orchestration/   # Lập lịch run, AI Manager decomposition, retry/timeout, recovery
│   │   │   ├── memory/          # Ngữ cảnh/lịch sử làm việc theo scope
│   │   │   ├── communication/   # task_message, notification (in-app)
│   │   │   ├── permission/      # ActionPolicy, ApprovalRequest, scope guard
│   │   │   ├── gamification/    # Milestone cơ bản
│   │   │   └── office-simulation/ # Reducer trạng thái nhân viên, OfficeSnapshot, zone
│   │   ├── platform/            # auth, tenancy (RLS), usage-budget, events (outbox), storage, realtime gateway, config
│   │   └── main.ts
│   └── test/
├── worker/                      # Consumer BullMQ: chạy AgentRun, thực thi action đã duyệt, sweeper
│   └── src/
│       ├── runtime/             # Kết nối ModelGateway + ToolBroker, vòng lặp run
│       ├── tools/               # Workspace tools + sensitive adapters (v1.0 chỉ có dry-run)
│       └── jobs/
└── web/                         # React + Vite
    └── src/
        ├── app/                 # Router có bảo vệ, layout
        ├── lib/                 # API client, cấu hình TanStack Query
        ├── features/            # auth, org, employees, tasks, approvals, dashboard, budget, history, notifications, milestones
        ├── office/              # Virtual Office: state (snapshot/seq) tách khỏi renderer
        │   ├── state/
        │   └── renderer-pixi/   # Chỉ phần này phụ thuộc PixiJS
        ├── realtime/
        └── i18n/                # vi (mặc định)

packages/
├── contracts/                   # Zod schema + type: DTO REST, realtime event, EmployeeProfile, ActionType
├── model-gateway/               # ModelGateway interface + providers (claude-agent-sdk, messages-api, fake)
├── policy/                      # Danh mục ActionType, mức quyền mặc định, hàm evaluate thuần
└── db/                          # Drizzle schema, migration, RLS policy, seed (template công ty phần mềm, role template)

tests/
├── support/                     # Testcontainers, bootstrap, factories, fake engine, route thử tenant
├── contract/                    # Interface engine, ModelGateway, ToolAdapter
├── integration/                 # API + worker + Postgres/Redis (Testcontainers)
├── security/                    # Phân quyền, approval bypass, prompt injection, tenant isolation, budget
└── e2e/                         # Playwright

docker/                          # Dockerfile từng app, docker-compose.yml, .env.example, egress-proxy/, sandbox-runner/
```

**Structure Decision**: Web application dạng monorepo pnpm workspaces. `apps/api` chứa engine dưới dạng NestJS module độc lập (mỗi module sở hữu bảng riêng, chỉ export service interface trong [contracts/engine-interfaces.md](./contracts/engine-interfaces.md)); `apps/worker` tách để run agent dài không chặn API và để restart/scale độc lập; `packages/contracts` là nguồn type duy nhất giữa web, api, worker.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Thêm process `apps/worker` ngoài `apps/api` | Run agent chạy nhiều phút (mặc định tối đa 15 phút thời gian chạy, cấu hình qua `RUN_TIMEOUT_MS`) và có thể chờ duyệt nhiều giờ (không tính vào timeout), cần restart/recovery độc lập và giới hạn đồng thời; không được chặn request API | Chạy run trong process API: một crash/deploy API làm gián đoạn mọi run và trộn tải I/O realtime với tải agent |
| Socket.IO thay cho WebSocket thô | Cần reconnect, room theo company/user, Redis adapter cho nhiều instance | `ws` thô: phải tự viết reconnect, heartbeat, room, fan-out – nhiều code hơn, cùng giao thức nền WebSocket |
| Thêm service `sandbox-runner` | Lệnh shell và test do agent sinh ra không được chạm tới Postgres, Redis, MinIO hay secret của worker | Bật sandbox của SDK trong worker: chỉ phủ Bash, kế thừa env có secret, và trong container có thể phải dùng chế độ yếu hơn theo tài liệu chính thức |
| Thêm service `egress-proxy` | Worker giữ API key và chạy tool do agent quyết định, nên chỉ được ra ngoài tới host API model | Dựa vào danh mục `network.fetch = restricted`: chỉ chặn tool của agent, không chặn đường mạng của tiến trình worker |
| Đưa review theo từng task từ Phase 4 vào v1.0 (FR-018, FR-019) | Nguyên tắc II và VII bắt buộc AI Manager kiểm tra và Human Manager phê duyệt ngay khi AI chạy việc thật | Chỉ để Human Manager review: bỏ bước kiểm tra độc lập của AI Manager, trái quy trình ở Nguyên tắc II |
| Đưa trao đổi gắn task từ Phase 4 vào v1.0 (FR-022) | Employee Profile phải hiển thị các trao đổi liên quan (Nguyên tắc IV), và người quản lý cần gửi chỉ dẫn cho run | Bỏ hẳn trao đổi: Profile thiếu mục bắt buộc. Chat Company/Department/Team đầy đủ: vượt phạm vi MVP |
| Đưa cột mốc Achievement cơ bản từ Phase 5 vào v1.0 (FR-045) | Nguyên tắc VIII cho phép gamification ở mức đủ tạo trải nghiệm thú vị | Bỏ hẳn: MVP mất lớp "Work as Play" tối thiểu. XP/Level đầy đủ: Nguyên tắc VIII không cho đưa vào MVP |
| Cho CEO thêm tài khoản Manager dù MVP chỉ có một người thật | FR-005 và Nguyên tắc III yêu cầu gán được người thật làm manager theo phạm vi | Chỉ có CEO: không kiểm chứng được phạm vi quản lý. Quản lý đa người dùng đầy đủ: thuộc Phase 6 |
| Chỉ giao adapter dry-run cho hành động nhạy cảm trong v1.0 (FR-027) | Tích hợp email và CI/CD thật không thuộc MVP, còn hành động nhầm thì không hoàn tác được. Nguyên tắc I vẫn được giữ vì payload đã duyệt được ghi lại và mọi kết quả dry-run có nhãn rõ trên chi tiết task (T142a), nên `Completed` không bị hiểu là đã gửi hoặc đã deploy thật | Giao adapter live ngay: mở rộng phạm vi và tạo rủi ro tác động ngoài. Mô phỏng không gắn nhãn: là kết quả giả, trái Nguyên tắc I |
