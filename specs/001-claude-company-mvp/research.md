# Research: Claude Company v1.0 (MVP)

**Feature**: `001-claude-company-mvp` | **Ngày**: 2026-11-09 | **Plan**: [plan.md](./plan.md)

Technical Context không còn mục `NEEDS CLARIFICATION`. Các quyết định dưới đây giải quyết những điểm spec để lại cho bước plan (xác thực, cơ chế thực thi, cưỡng chế quyền, phục hồi, realtime) và ghi nhận kết quả kiểm chứng khả năng nền tảng Claude theo ràng buộc "Xác minh trước khi dựa vào" của constitution.

---

## R1. Stack và cấu trúc repo

- **Decision**: Monorepo pnpm workspaces, TypeScript toàn bộ. NestJS 11 cho `apps/api` và `apps/worker`; React 19 + Vite + PixiJS 8 cho `apps/web`; PostgreSQL 16, Redis 7, MinIO (S3), Docker Compose.
- **Rationale**: Khớp stack mặc định của constitution; một ngôn ngữ cho phép chia sẻ schema Zod giữa client/server/worker (`packages/contracts`), giảm lệch hợp đồng. NestJS module ánh xạ tự nhiên vào ranh giới engine.
- **Alternatives considered**: Repo tách rời từng app (khó đồng bộ contract); Python/FastAPI cho worker (Agent SDK có bản Python nhưng mất lợi ích chia sẻ type, lệch stack mặc định).

## R2. ORM, cô lập tenant và phân quyền

- **Decision**: Drizzle ORM. Mọi bảng nghiệp vụ có `company_id NOT NULL`. Bật PostgreSQL Row-Level Security; mỗi request/job mở transaction và `SET LOCAL app.company_id = ...` (role DB của ứng dụng không có `BYPASSRLS`). Lớp thứ hai: `ScopeGuard` NestJS kiểm tra phạm vi quản lý (company → org unit → team → employee → task) trên mọi endpoint và mọi handler WebSocket. NestJS chạy guard trước interceptor, nên thứ tự là `SessionGuard` → `CsrfGuard` → `TenantGuard` (kiểm tra membership, dựng `RequestContext`) → `ScopeGuard` → `tenant.interceptor` (transaction `withTenant` của handler). Truy vấn chưa có `app.company_id` (`/auth/me`, relay outbox, sweeper) dùng policy theo `app.user_id` hoặc hàm `SECURITY DEFINER` chỉ trả `company_id`; role ứng dụng vẫn không có `BYPASSRLS`.
- **Rationale**: FR-028/FR-029/SC-012 yêu cầu từ chối ở mọi request kể cả khi đoán đường dẫn. RLS chặn rò rỉ tenant ngay cả khi code quên điều kiện `WHERE`; guard xử lý phạm vi chi tiết trong công ty. Drizzle cho phép kiểm soát SQL/transaction rõ ràng, phù hợp `SET LOCAL`.
- **Alternatives considered**: Prisma (khó dùng `SET LOCAL` theo transaction với RLS); schema-per-tenant (nặng vận hành, chưa cần cho v1.0); chỉ lọc ở tầng ứng dụng (một lỗi quên `WHERE` là rò rỉ).

## R3. Kiểm chứng khả năng Claude Agent SDK (bắt buộc theo constitution)

Đã đọc tài liệu chính thức ngày 2026-11-09: `code.claude.com/docs/en/agent-sdk/permissions`, `/custom-tools`, `/cost-tracking`, `/user-input`, `/typescript`, `/hooks`, `/sessions`, `code.claude.com/docs/en/sandboxing` và `platform.claude.com/docs/en/build-with-claude/structured-outputs`. Kết quả dùng cho plan:

| Khả năng | Xác nhận | Cách plan dùng |
|---|---|---|
| Package `@anthropic-ai/claude-agent-sdk`, hàm `query({ prompt, options })` trả async iterable | ✅ | Provider `claude-agent-sdk` trong `model-gateway` |
| Thứ tự đánh giá quyền: Hooks → deny rules (`disallowedTools`) → ask rules → permission mode → allow rules (`allowedTools`) → `canUseTool`. Lượt đọc file trong thư mục làm việc và lệnh Bash chỉ-đọc được tự duyệt ở bước allow, không tới `canUseTool` | ✅ | **Không** dùng `canUseTool` làm điểm cưỡng chế. Tắt mọi built-in và chỉ dùng MCP tool do hệ thống viết, không dùng `bypassPermissions`/`acceptEdits` |
| `canUseTool(toolName, input, { signal })` trả `{behavior:"allow", updatedInput}` hoặc `{behavior:"deny", message}`; có thể pending vô thời hạn | ✅ | Tài liệu chỉ có quyết định allow/deny, không có cách trả kết quả tool thay SDK, nên ledger không biết kết quả của built-in. Không dùng callback này; **không** treo chờ người duyệt (không bền khi restart) – xem R4 |
| Hook `PreToolUse` có quyết định `defer` để process thoát và resume sau | ✅ (chưa xác nhận chi tiết payload) | Không phụ thuộc; chỉ dùng PreToolUse để ghi log/trace |
| Custom tool qua `tool(name, desc, zodShape, handler)` + `createSdkMcpServer`; tên `mcp__{server}__{tool}` | ✅ | Toàn bộ tool của code role là MCP in-process do ta viết; handler gọi `io.invokeTool` nên quyền và ledger nằm trong hệ thống. `allowedTools: ["mcp__cc__*"]` (wildcard có tiền tố server là hợp lệ) chỉ bỏ prompt của SDK |
| `tools: [...]` giới hạn built-in khả dụng; `tools: []` bỏ hết built-in | ✅ | Code role đặt `tools: []` ("All built-ins are removed. Claude can only use your MCP tools"), thêm hook `PreToolUse` từ chối mọi tool ngoài `mcp__cc__*`; doc role không dùng Agent SDK |
| Result message có `total_cost_usd`, `usage`, `modelUsage`, `subtype` (vd. `error_max_budget_usd`); usage từng bước dedupe theo `message.id` | ✅ | `UsageMeter` ghi theo từng lượt; `total_cost_usd` là ước tính client – ta tự tính chi phí từ token × bảng giá cấu hình để thống nhất giữa provider |
| `maxBudgetUsd` dừng query khi ước tính phía client chạm giá trị này, có thể vượt thêm một phản hồi; subtype `error_max_budget_usd` | ✅ | Đặt nhỏ hơn phần đã reservation theo headroom cấu hình (xem R6) |
| `resume` (session ID) | ✅ | Tiếp tục run sau Human Approval (agent đã kết thúc lượt tự nhiên). Sau crash chỉ dùng khi T090 xác nhận, xem R5 |
| `maxTurns`, `cwd`, `model`, `settingSources` (`[]` tắt setting user/project/local) | ✅ | `cwd` là worktree của run, `settingSources: []` để `.claude/settings.json` trong workspace không nới được quyền |
| `env` thay thế hoàn toàn env của subprocess, không merge | ✅ | Truyền tối thiểu `PATH`, `HOME`, `ANTHROPIC_API_KEY`, `HTTPS_PROXY`, `NO_PROXY`. Tài liệu không nói rõ có bắt buộc truyền API key không, nên truyền tường minh |
| Sandbox của Claude Code chỉ phủ lệnh shell, file tool và MCP chạy ngoài; lệnh kế thừa env gồm cả secret; trong container không đặc quyền có thể phải dùng chế độ yếu hơn | ✅ | Không dựa vào sandbox này; dùng service `sandbox-runner` riêng (R4) |
| Hook hoặc callback trước mỗi lượt model có thể dừng run | ⚠️ Không có trong tài liệu ở dạng nguyên văn | Không phụ thuộc; ngân sách code role dùng reservation theo run (R6) |
| Trạng thái session sau `abortController` hoặc `Query.close()`, và khả năng `resume` sau đó | ⚠️ Không có trong tài liệu | Không phụ thuộc; tạm dừng bằng khóa tool và để agent kết thúc lượt tự nhiên (R4). Recovery sau crash mặc định không `resume`; spike T090 quyết định có bật `SDK_RESUME_AFTER_CRASH` hay không |
| Messages API: structured output qua `output_config.format`, không cần beta header; danh sách model hỗ trợ gồm `claude-fable-5-1`, `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5` | ✅ | `MessagesApiProvider` dùng cho decompose/review |

- **Decision**: Agent SDK cho vai trò làm việc với mã nguồn (AI Developer, AI QA Engineer khi chạy test); Messages API (`@anthropic-ai/sdk`) với vòng lặp tool-use tự viết cho vai trò tài liệu/phân tích (AI BA, AI Manager). Lựa chọn lưu ở `ai_employee.runtime_kind` (FR-012).
- **Rationale**: Đúng khuyến nghị Nguyên tắc VI; Messages API cho vòng lặp ngắn, kiểm soát chặt từng lượt (ngân sách, tool) với vai trò không cần shell.
- **Alternatives considered**: Một runtime duy nhất cho mọi vai trò (trái FR-012); spawn CLI Claude Code và đọc hooks như dự án tham khảo `ref/Claude-Office` (khó cưỡng chế quyền phía server, phụ thuộc cấu hình máy người dùng).

## R4. Cưỡng chế bốn mức quyền và Human Approval bền vững

- **Decision**: Mọi lời gọi tool của agent → `ToolBroker.invoke()` → `PermissionEngine.evaluate(actionType, context)`:
  - **Auto Execute**: thực thi, ghi ledger.
  - **Review Required**: thực thi (chỉ cho phép action hoàn tác được / không tác động ra ngoài – ví dụ ghi file trong workspace git), đánh dấu `requires_review` trên run; task bắt buộc qua In Review.
  - **Human Approval**: **agent không thực thi**. Broker tạo `approval_request` với payload chuẩn hóa + `payload_hash`, trả cho agent kết quả "đã gửi yêu cầu phê duyệt", kết thúc lượt chạy; nhân viên chuyển `Waiting Approval`. Khi được duyệt, worker thực thi đúng payload có hash khớp qua adapter (dry-run mặc định), ghi ledger, rồi `resume` phiên agent với kết quả. Từ chối → agent nhận lý do, task chuyển theo FR-020a.
  - **Restricted** hoặc `actionType` không có trong danh mục: từ chối, ghi log.
- Danh mục `ActionType` nằm trong `packages/policy`; nhóm `sensitive` (`email.send`, `data.delete`, `deploy.*`) có `floor = HUMAN_APPROVAL` – cấu hình công ty chỉ được nâng mức, không được hạ (FR-025). Nội dung prompt/task không bao giờ là đầu vào của `evaluate` (chống prompt injection, US4-AS4).
- Shell cho code role là tool `workspace.shell` do hệ thống viết, chạy trong service `sandbox-runner` (không có đường tới Postgres, Redis, MinIO hay internet, env không có secret, mỗi run chạy bằng UID riêng và chỉ truy cập được thư mục `/worktrees/{runId}`). Chỉ lệnh khớp allowlist mới là `workspace.shell` = Review Required; `git push` thành `workspace.git.push`; mọi lệnh khác là Restricted (xem [contracts/action-policy.md](./contracts/action-policy.md)). Worker chỉ ra ngoài qua `egress-proxy` với allowlist host API model.
- Danh mục quyền, `evaluate` và parser shell được làm ở nền tảng. Từ US3 đến khi xong US4, `ToolBroker` từ chối (fail-closed) mọi hành động Human Approval.
- Tạm dừng chờ duyệt hoặc khi hết ngân sách không cần dừng cứng query: `ToolBroker` khóa mọi tool còn lại của run (trả `run_locked`, không thực thi), agent kết thúc lượt, provider giữ session để `resume`. `maxTurns` và `maxBudgetUsd` chặn trên số lượt nếu agent chưa chịu dừng.
- **Rationale**: Không giữ callback mở trong lúc chờ người (có thể vài giờ) → sống sót qua restart (FR-044). Hash payload bảo đảm thứ được thực thi đúng là thứ người duyệt đã xem.
- **Alternatives considered**: Treo `canUseTool` chờ duyệt (mất trạng thái khi crash); chỉ dựa vào system prompt (vi phạm Nguyên tắc II); hook `defer` của SDK (chưa kiểm chứng đủ chi tiết, và không áp dụng cho runtime Messages API).

## R5. Thực thi bền vững, timeout, retry, phục hồi

- **Decision**:
  - `agent_run` (một lượt chạy) gồm các `run_step`; mỗi tác dụng phụ là một `tool_invocation` có `idempotency_key` và trạng thái `pending → executing → succeeded|failed`. Hành động có tác dụng phụ (nhóm `dedupe` trong [action-policy.md](./contracts/action-policy.md)) dùng key ổn định `sha256(task_id + rework_count + action_type + input_hash)`, nên resume hoặc retry gọi lại cùng hành động sẽ nhận trạng thái từ ledger. Hành động chỉ tác động worktree của run (nhóm `rerun`) dùng key `run_id + step_seq` và được phép chạy lại vì không có tác động ra ngoài. Adapter nhận idempotency key; kết quả đã `succeeded` được trả lại từ ledger, không gọi lại.
  - Job BullMQ: `run.start`, `run.resume`, `action.execute-approved`, `task.decompose`, `task.synthesize`, `review.run`; lock theo `task_id`. Timeout mặc định 15 phút/run, 2 phút/lời gọi model; retry 3 lần, backoff mũ (cấu hình được).
  - Outbox: thay đổi trạng thái + `domain_event` ghi cùng transaction; relay đẩy sang Redis pub/sub và hàng đợi.
  - Recovery sweeper khi worker khởi động và định kỳ: run `running` có heartbeat quá hạn → mặc định đánh dấu Error kèm nguyên nhân và task Blocked; chỉ khi `SDK_RESUME_AFTER_CRASH = true` (T090 đã xác nhận) và có `session_id` mới `resume`, `resume` lỗi thì cũng đánh dấu Error; `tool_invocation` kẹt ở `executing` → hỏi adapter theo idempotency key, nếu không xác định được → Blocked, chuyển người thật (không thực hiện lại).
  - Giữ công việc dở dang: run mới sau `resume`, retry hoặc rework của cùng task sao chép nguyên thư mục của run gần nhất (gồm thay đổi chưa commit, không dùng `git clone` vì sẽ mất các thay đổi đó) rồi đổi owner sang UID của run mới.
- **Rationale**: Đáp ứng FR-043/FR-044/SC-010 mà không cần thêm workflow engine.
- **Alternatives considered**: Temporal (mạnh nhưng thêm hạ tầng lớn cho MVP – YAGNI); chỉ dùng retry của BullMQ (không chống lặp tác dụng phụ).

## R6. Ngân sách, giới hạn và đo chi phí

- **Decision**: `budget_policy` theo scope (company, org_unit, team, employee) với `monthly_token_limit`, `monthly_cost_limit`, `max_concurrent_tasks`, `allowed_models`; task có `token_cap`/`cost_cap` tùy chọn. `usage_ledger` ghi từng lượt gọi model (input/output/cache tokens, model, chi phí tính từ bảng giá cấu hình, `period = YYYY-MM` theo múi giờ công ty).
  - Runtime `messages_api`, trước mỗi lượt gọi: `BudgetService.reserve(estimate)` kiểm tra mọi scope áp dụng (giới hạn chạm trước thắng – FR-031). Không đủ → không gọi, task Blocked + thông báo + yêu cầu quyết định người thật.
  - Sau lượt gọi: `commit(actual)`; nếu một lời gọi đơn lẻ vượt, ghi `overage` và chặn các lượt tiếp theo (edge case).
  - Cảnh báo ở 80% (cấu hình) qua notification, chỉ một lần mỗi ngưỡng/scope/kỳ.
  - Runtime `claude_agent_sdk` không có hook đã kiểm chứng trước mỗi lượt, nên `reserve` một lần theo run trước khi gọi `query()`. `maxBudgetUsd = phần đã giữ × (1 − SDK_BUDGET_HEADROOM)` vì ước tính của SDK có thể vượt thêm một phản hồi. Reservation giữ trong lúc run chạy (release khi chờ duyệt, reserve lại lúc resume) nên hai run đồng thời không cùng vượt; commit từng lượt, release phần dư khi kết thúc. Sau mỗi `model_call`, run-loop cộng token đã dùng và khóa tool khi chạm `reserved_tokens × (1 − SDK_BUDGET_HEADROOM)`, vì `maxBudgetUsd` chỉ chặn theo USD. Messages API: `max_tokens` giới hạn theo token còn lại.
  - Công thức ước tính cho `reserve`: `messages_api` dùng `estTokens = input ước tính + max_tokens`, trong đó input ước tính là `input + cache tokens` của lượt trước cộng `ceil(số byte nội dung mới / 3)`, lượt đầu chỉ tính phần sau; `estCostUsd` tính theo `model_price` với input giá thường, không giảm giá cache. `claude_agent_sdk` dùng `SDK_RUN_RESERVE_USD` (mặc định 2) và `SDK_RUN_RESERVE_TOKENS` (mặc định 200.000), giảm xuống phần còn lại của `cost_cap`/`token_cap` nếu task có trần; phần còn lại của trần bằng 0 thì chặn. "Sắp vượt" (FR-033) nghĩa là đã dùng + đang giữ + ước tính vượt giới hạn của bất kỳ scope nào.
  - Không có `budget_policy` cấp công ty thì áp hạn mức mặc định từ cấu hình, không bao giờ coi là không giới hạn.
  - Dashboard tổng hợp từ `usage_ledger` (cùng một nguồn) → khớp từng task (SC-008).
- **Rationale**: Chặn *trước* khi tiêu là cách duy nhất để "không âm thầm vượt".
- **Alternatives considered**: Kiểm tra sau mỗi run (đã vượt rồi mới biết); dựa hoàn toàn vào `total_cost_usd` (chỉ là ước tính, không có ở runtime Messages API).

## R7. Realtime và Office Simulation Engine

- **Decision**: `OfficeSimulationEngine` là reducer thuần `(EmployeeState, DomainEvent) → EmployeeState`, chạy trong api, lưu `employee_status` (projection) và phát `office.employee_status_changed` với `seq` tăng dần theo công ty. Socket.IO namespace `/realtime`, room `company:{id}` và `user:{id}`; xác thực bằng session cookie khi handshake, kiểm tra scope khi join. Client: tải `GET /office/snapshot` (kèm `seq`), áp sự kiện theo `seq`; `seq > last + 1` hoặc mất kết nối → hiển thị nhãn "dữ liệu có thể đã cũ" và tải lại snapshot (FR-037). Ánh xạ sự kiện → trạng thái ở [contracts/realtime-events.md](./contracts/realtime-events.md). Không sự kiện → Idle; Break chỉ khi nhân viên bị tạm ngưng, không ngẫu nhiên.
- **Rationale**: Một nguồn sự thật, thứ tự đảm bảo bằng seq (edge case 10 nhân viên đổi trạng thái liên tục), test được bằng unit test reducer (SC-006).
- **Alternatives considered**: SSE (một chiều, đủ dùng nhưng kém linh hoạt cho Phase 4 chat); client tự suy trạng thái từ task (nhiều nguồn sự thật).

## R8. Virtual Office rendering

- **Decision**: PixiJS 8, tilemap pixel art 2D tự vẽ/tài sản giấy phép mở (không dùng tài sản hay nhân vật của dự án tham khảo hoặc thương hiệu khác). Layout sinh từ dữ liệu: mỗi Department một zone, cộng CEO Office và Break Room; vị trí bàn tính tất định từ thứ tự nhân viên. `office/state` (thuần TS) tách khỏi `office/renderer-pixi`; renderer chỉ nhận `OfficeSnapshot` và phát sự kiện `onSelectEmployee`. Animation chỉ chạy khi trạng thái tương ứng đang hoạt động.
- **Rationale**: FR-039 – đổi phong cách (isometric sau này) không đụng logic. Hiệu năng 60 fps với vài chục sprite là dễ với PixiJS.
- **Alternatives considered**: Phaser (framework game đầy đủ, nặng hơn cần thiết); Canvas/DOM thuần (tự viết nhiều).

## R9. Xác thực

- **Decision**: Email + mật khẩu (argon2id), session phía server lưu Redis, cookie `HttpOnly; Secure; SameSite=Lax`, CSRF token cho request ghi. Người dùng đầu tiên đăng ký trở thành CEO của công ty họ tạo. Mô hình `user` ↔ `human_member` (theo công ty) sẵn sàng cho đa người dùng (Phase 6). Bảng `user` thuộc `platform/auth`; engine khác chỉ truy cập qua `IdentityDirectory`.
- **Rationale**: Spec nói "đăng nhập tiêu chuẩn"; session server-side đơn giản, thu hồi được, không lộ token cho JS.
- **Alternatives considered**: JWT (khó thu hồi, dễ lộ qua JS); OAuth/OIDC (thêm phụ thuộc bên ngoài, để sau).

## R10. AI Manager phân rã mục tiêu và review độc lập

- **Decision**: Mọi task gốc (không gồm task con, phân rã tối đa một cấp) → job `task.decompose` chạy AI Manager phụ trách (runtime Messages API; task giao Team/Department theo FR-016, task giao trực tiếp theo thứ tự FR-018) với structured output theo schema Zod `DecompositionPlan { mode: "confirm"|"decompose", subtasks[{ title, objective, acceptanceCriteria[], expectedOutput, assigneeId, dependsOn[] }] }`; `confirm` giữ nguyên phân công và không có task con. Hệ thống kiểm tra: assignee thuộc phạm vi của `created_by_member_id` và đang `active`, không phụ thuộc vòng (topological sort), có người phù hợp – nếu lỗi → Blocked + chuyển người thật. Task con kế thừa deadline và priority của task cha; nhân viên hết slot thì task con xếp hàng (FR-007). Task con chỉ chạy khi phụ thuộc Completed. Review: job `review.run` do AI Manager độc lập với điều kiện `reviewer_id ≠ executor_id`, sinh `evidence` cho từng acceptance criterion; thiếu evidence cho criterion nào → không thể sang Awaiting Human Approval. Artifact tổng hợp của task cha do một AI Manager khác AI Manager đã tổng hợp review, ưu tiên AI Manager không làm task con nào (FR-018); bước tổng hợp là run `purpose = synthesize`, job `task.synthesize`. AI Manager trong v1.0 chỉ dùng runtime Messages API vì cần structured output (FR-012). Thứ tự chọn reviewer: manager AI trực tiếp → AI Manager cùng `home_org_unit_id` → AI Manager bất kỳ đang `active`, luôn khác người thực thi. Hệ thống đưa danh sách nhân viên và nội dung artifact vào `input` theo mục "Ngữ cảnh đầu vào theo purpose" của [contracts/engine-interfaces.md](./contracts/engine-interfaces.md), không thêm action đọc artifact.
- **Rationale**: FR-016, FR-018, FR-020, SC-002.
- **Alternatives considered**: Cho AI Manager tự gọi tool "assign" trong vòng lặp tự do (khó kiểm tra ràng buộc trước khi áp dụng).

## R11. Memory Engine (phạm vi v1.0)

- **Decision**: Lưu `memory_entry` (tóm tắt task đã xong, ghi chú làm việc) gắn `company_id` + `owner_scope` (employee/team/org_unit). Truy xuất theo scope và độ gần đây, đưa vào ngữ cảnh run. Không vector search trong v1.0; bảng thiết kế cho phép thêm cột embedding (pgvector) sau.
- **Rationale**: Đủ cho FR-013 với cô lập rõ ràng; YAGNI.
- **Alternatives considered**: Vector DB riêng (thêm hạ tầng chưa cần).

## R12. Workspace và adapter hành động nhạy cảm

- **Decision**: `workspace` do người dùng đăng ký (đường dẫn repo git hoặc thư mục tài liệu được mount vào container worker; `sandbox-runner` chỉ thấy worktree của run). Mỗi run có thư mục làm việc riêng `/worktrees/{runId}` trên volume `run_worktrees` (gọi là worktree của run): `git_repo` dùng `git clone --local` với branch `cc/run-{id}` để không chia sẻ metadata git giữa các run, `docs_folder` là bản sao thư mục. Agent không ghi vào nguồn → Review Required hoàn tác được. Run rework khởi tạo từ thư mục của run trước cùng task. Adapter `EmailAdapter`, `DataDeleteAdapter`, `DeployAdapter` có hai chế độ `dry_run` (mặc định: ghi lại payload, trả kết quả mô phỏng có nhãn rõ "dry-run") và `live` (chỉ bật khi người dùng cấu hình credential tường minh; credential lưu mã hóa, không bao giờ đưa vào ngữ cảnh model).
- **Rationale**: FR-027 và clarification về adapter sandbox; đặc quyền tối thiểu.
- **Alternatives considered**: Cho agent truy cập trực tiếp SMTP/CI (trái nguyên tắc đặc quyền tối thiểu).

## R13. Giá trị mặc định cấu hình

| Tham số | Mặc định |
|---|---|
| Ngưỡng cảnh báo ngân sách | 80% |
| Số vòng làm lại tối đa trước khi chuyển người thật | 3 |
| Retry run / lời gọi model | 3 lần, backoff mũ 2s→30s |
| Timeout run / lời gọi model / tool | 15 phút / 2 phút / 5 phút |
| Task đồng thời mặc định mỗi AI Employee | 2 |
| Nhắc người duyệt khi approval chờ | sau 1 giờ, sau đó mỗi 24 giờ (không bao giờ tự duyệt) |
| Múi giờ công ty (tính tháng lịch) | Asia/Ho_Chi_Minh |
| Hạn mức tháng của công ty khi chưa có `budget_policy` | 20 USD, 2.000.000 token |
| Headroom cho `maxBudgetUsd` | 10% |
| `resume` session Agent SDK sau crash (`SDK_RESUME_AFTER_CRASH`) | `false` cho đến khi T090 xác nhận |
| Trần nội dung artifact trong ngữ cảnh một run (`ARTIFACT_CONTEXT_MAX_BYTES`) | 200.000 byte |
