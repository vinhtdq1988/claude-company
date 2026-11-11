# Data Model: Claude Company v1.0 (MVP)

**Feature**: `001-claude-company-mvp` | **Ngày**: 2026-11-09 | **Plan**: [plan.md](./plan.md)

Quy ước chung cho mọi bảng nghiệp vụ:

- Khóa chính `id uuid` (UUIDv7), `company_id uuid NOT NULL` (trừ `user`, `company` và bảng cấu hình toàn cục `org_template`, `role_template`, `model_price`, ba bảng này không bật RLS), `created_at`, `updated_at`.
- Row-Level Security: `company_id = NULLIF(current_setting('app.company_id', true), '')::uuid`, chưa đặt biến thì không có dòng nào khớp (xem research R2). `human_member` và `company` có thêm policy theo `app.user_id` cho `/auth/me` và `createCompany`. Worker lấy danh sách công ty qua hàm `SECURITY DEFINER` chỉ trả `company_id`, mỗi hàm chỉ đọc bảng của một engine; role ứng dụng không có `BYPASSRLS`.
- Không xóa cứng đơn vị/nhân viên đã có lịch sử: dùng `archived_at` (edge case "lưu trữ thay vì xóa mất").
- Mỗi bảng thuộc đúng một engine hoặc module platform (cột **Engine**); engine khác chỉ truy cập qua interface trong [contracts/engine-interfaces.md](./contracts/engine-interfaces.md).
- Ánh xạ thuật ngữ spec → dữ liệu: Blocked/Error của task = `blocked`; Error/Blocked của nhân viên = `error_blocked`; Division/Department = `org_unit`; "xóa" đơn vị hoặc nhân viên = archive; "worktree của run" = thư mục làm việc riêng `/worktrees/{runId}`; CEO AI Assistant = `ai_employee` có `role_template_key = 'ceo_assistant'` (không có bảng riêng, chỉ ràng buộc thêm).

## Sơ đồ quan hệ (rút gọn)

```text
user 1─* human_member *─1 company 1─* org_unit (self-ref parent_id: division/department)
                                   1─* team *─* team_membership *─1 employee_ref
company 1─* ai_employee ─(manager)→ ai_employee | human_member
human_member 1─* management_assignment ─→ (org_unit | team)
task (self-ref parent_task_id) 1─* task_dependency, artifact, evidence, review_record, task_message, agent_run
agent_run 1─* run_step 1─* tool_invocation ─0..1→ approval_request
usage_ledger *─1 agent_run / task / ai_employee
domain_event → (office projection) employee_status, notification, milestone
```

---

## Organization Engine

### company
| Trường | Kiểu | Ràng buộc |
|---|---|---|
| id | uuid | PK |
| name | text | 1–120 ký tự |
| timezone | text | mặc định `Asia/Ho_Chi_Minh` |
| template_key | text? | template đã áp dụng (chỉ để tham khảo, không ràng buộc) |
| archived_at | timestamptz? | |

### org_unit (Division / Department)
| Trường | Kiểu | Ràng buộc |
|---|---|---|
| kind | enum `division`,`department` | |
| parent_id | uuid? → org_unit | department có thể nằm trong division hoặc trực tiếp dưới company; division không có parent là department |
| name | text | duy nhất trong cùng parent (không tính archived) |
| sort_order | int | sắp xếp lại (FR-002) |
| archived_at | timestamptz? | |

Validation: xóa/archive bị chặn nếu còn `org_unit` con, `ai_employee`/`team` chưa archived hoặc task trạng thái chưa kết thúc thuộc đơn vị (FR-002, US1-AS4).

### team
| Trường | Kiểu | Ràng buộc |
|---|---|---|
| org_unit_id | uuid → org_unit | department "nhà" của team |
| name | text | duy nhất trong org_unit |
| sort_order, archived_at | | |

### team_membership
| Trường | Kiểu | Ràng buộc |
|---|---|---|
| team_id | uuid → team | |
| member_kind | enum `ai`,`human` | |
| member_id | uuid | `ai_employee.id` hoặc `human_member.id` |
| | | UNIQUE(team_id, member_kind, member_id); một AI Employee có thể thuộc nhiều team (FR-007) |

### management_assignment
| Trường | Kiểu | Ràng buộc |
|---|---|---|
| manager_member_id | uuid → human_member | luôn là người thật (FR-005) |
| target_kind | enum `org_unit`,`team` | manager của AI Employee lưu ở `ai_employee.manager_id` |
| target_id | uuid | |
| | | UNIQUE(target_kind, target_id) cho manager chính của đơn vị |

Phạm vi quản lý của một human_member = các target được gán + mọi con cháu (department → team → nhân viên) + các AI Employee có `manager_kind = human` và `manager_id` là member này. CEO (`human_member.role = ceo`) có phạm vi toàn công ty.

### org_template (dữ liệu seed, không theo company)
`key`, `name`, `definition jsonb` (cây đơn vị: Development, BA, QA). Áp dụng = sao chép thành các bản ghi `org_unit` độc lập (FR-003).

## Employee Engine

### user (toàn cục – xác thực)
`email` (unique, lowercase), `password_hash` (argon2id), `display_name`, `disabled_at`. Bảng này thuộc `platform/auth`, không thuộc Employee Engine; engine khác chỉ truy cập qua `IdentityDirectory`.

### human_member
| Trường | Kiểu | Ràng buộc |
|---|---|---|
| user_id | uuid → user | UNIQUE(company_id, user_id) |
| role | enum `ceo`,`manager` | |
| title | text? | |
| disabled_at | timestamptz? | vô hiệu bị chặn nếu là người thật cuối của một chuỗi quản lý AI (edge case) |

### ai_employee (hợp đồng EmployeeProfile – FR-009)
| Trường | Kiểu | Ràng buộc |
|---|---|---|
| name | text | 1–80 |
| avatar_key | text | sprite trong bộ tài sản office |
| position | text | chức danh |
| home_org_unit_id | uuid? → org_unit | department (zone trong office). NOT NULL, ngoại lệ duy nhất là `role_template_key = 'ceo_assistant'` (cấp công ty, hiển thị ở zone `ceo_office`): `CHECK (home_org_unit_id IS NOT NULL OR role_template_key = 'ceo_assistant')` |
| kind | enum `employee`,`manager` | AI Manager vs AI Employee (FR-011) |
| role_template_key | text? | `ai_developer`,`ai_ba`,`ai_qa`,`ai_manager`,`ceo_assistant` hoặc null (tùy chỉnh) |
| personality | text | |
| skills | text[] | |
| seniority | enum `junior`,`middle`,`senior`,`expert` | |
| model_id | text | phải ∈ allowed_models hiệu lực của scope (US6-AS5) |
| runtime_kind | enum `claude_agent_sdk`,`messages_api` | cấu hình theo từng nhân viên (FR-012) |
| system_prompt | text | chỉ dẫn vai trò |
| tool_grants | text[] | danh sách `ActionType` được cấp (xem [action-policy.md](./contracts/action-policy.md)) |
| workspace_id | uuid? → workspace | |
| manager_kind | enum `human`,`ai` | NOT NULL (US2-AS2) |
| manager_id | uuid | nguồn sự thật duy nhất về manager trực tiếp (FR-005, FR-006) |
| max_concurrent_tasks | int | mặc định 2 |
| status | enum `active`,`suspended`,`archived` | |

Validation chuỗi quản lý (FR-006): đi theo `manager_id` khi `manager_kind = ai` phải kết thúc ở `human_member` đang hoạt động trong ≤ 10 bước, không vòng. `manager_kind = ai` thì `manager_id` phải trỏ tới `ai_employee` có `kind = manager`; đổi `kind` của AI Manager đang có cấp dưới bị chặn. Kiểm tra khi tạo/sửa nhân viên, đổi manager, vô hiệu human_member, archive AI Manager.

Xóa/archive (US2-AS4): bị chặn nếu còn task chưa kết thúc được giao cho nhân viên; API trả danh sách task cần hủy hoặc chờ hoàn tất.

Ràng buộc riêng của CEO AI Assistant (FR-046, FR-011, FR-050):

- Duy nhất: `CREATE UNIQUE INDEX ai_employee_one_ceo_assistant ON ai_employee (company_id) WHERE role_template_key = 'ceo_assistant' AND status <> 'archived'` → tạo thêm khi còn trợ lý chưa lưu trữ trả `409 CEO_ASSISTANT_EXISTS` (kể cả trợ lý đang `suspended`).
- `kind = 'employee'` (không phải AI Manager), `runtime_kind = 'messages_api'`, `home_org_unit_id` rỗng, `manager_kind = 'human'` và `manager_id` là `human_member` có `role = 'ceo'`. `EmployeeEngine` ép các giá trị này khi tạo và từ chối (`422 VALIDATION_FAILED`) mọi `PATCH` đổi `kind`, `runtimeKind`, `manager`, `homeOrgUnitId` của trợ lý; `deactivateHumanMember` của CEO vẫn bị chặn bởi quy tắc chuỗi quản lý.
- `tool_grants` chỉ nhận `ActionType` mà [action-policy.md](./contracts/action-policy.md) cho phép với trợ lý (không có `workspace.*`, không có `ActionType` `restricted`); `PATCH` thêm tool ngoài danh sách → `422`.
- Chỉ CEO thấy, sửa, tạm ngưng, lưu trữ trợ lý (nhân viên không có đơn vị nhà nên không rơi vào `ManagedScope` của Manager thường).
- Phạm vi thống kê: trợ lý không có đơn vị nhà nên chỉ nằm trong tổng toàn công ty; `usage_ledger.org_unit_id` và bộ lọc theo `orgUnitId` bỏ qua dòng của trợ lý (null).

AI Manager do hệ thống tạo cho Team (FR-016a): bản ghi `ai_employee` bình thường (`kind = manager`, `role_template_key = ai_manager`, tên `AI Manager {tên Team}`, `home_org_unit_id` là phòng ban chứa Team, `manager_kind = human` trỏ tới người quản lý Team hoặc CEO) cùng một dòng `team_membership`. Không có cột đánh dấu "tự tạo"; truy vết qua `domain_event` `employee.created` có `actor.kind = system`.

### role_template (seed)
`key`, `name`, `defaults jsonb` (position, skills, seniority, runtime_kind, system_prompt, tool_grants, model_id gợi ý). Seed gồm `ai_developer`, `ai_ba`, `ai_qa`, `ai_manager`, `ceo_assistant`. Mẫu `ceo_assistant`: `kind = employee`, `runtime_kind = messages_api`, `tool_grants` mặc định theo R14 Decision 1, `system_prompt` nêu rõ ranh giới (chỉ báo cáo từ dữ liệu `company.query`; việc quyết định của con người phải nhờ CEO; hỏi lại khi yêu cầu chưa rõ thay vì đoán – US9-AS8).

### workspace
`name`, `kind` enum `git_repo`,`docs_folder`, `mount_path`, `default_branch?`. Chỉ CEO đăng ký.

## Task Engine

### task
| Trường | Kiểu | Ràng buộc |
|---|---|---|
| parent_task_id | uuid? → task | task con từ phân rã |
| title | text | |
| objective | text | bắt buộc |
| created_by_member_id | uuid → human_member | người thật giao việc và chịu trách nhiệm; task con kế thừa từ task cha |
| assigned_by_ai_employee_id | uuid? → ai_employee | AI Employee đã tạo task thay người giao: AI Manager khi tạo task con, hoặc CEO AI Assistant khi giao việc thay mặt CEO (SC-014, FR-051); `created_by_member_id` vẫn là người thật chịu trách nhiệm |
| proposal_status | enum? `pending`,`ready`,`failed` | chỉ dùng cho task yêu cầu gửi trợ lý (FR-047): `pending` từ lúc tạo đến khi run `propose` xong; null với mọi task khác. `pending` thì `assign` và `PATCH` bị chặn `409 PROPOSAL_PENDING` |
| assignee_kind | enum `ai_employee`,`team`,`org_unit` | |
| assignee_id | uuid | phải trong phạm vi quản lý của người giao (US3-AS6) |
| deadline | timestamptz | bắt buộc |
| priority | enum `low`,`medium`,`high`,`urgent` | |
| acceptance_criteria | jsonb `[{id, text}]` | ≥ 1 mục |
| expected_output | text | bắt buộc |
| status | enum (xem dưới) | |
| is_overdue | bool | cờ, tính lại khi qua deadline và chưa kết thúc |
| rework_count | int | ≥ 0; tổng số vòng, không bao giờ đặt lại; `rework_count - rework_baseline` đạt `max_rework` (3) → escalate |
| rework_baseline | int | mặc định 0; đặt bằng `rework_count` khi người thật `resume` lúc đã đạt `max_rework` |
| token_cap, cost_cap | bigint?, numeric? | trần tùy chọn (FR-031) |
| blocked_reason | text? | mã trong `packages/contracts/src/errors.ts`, gồm `NO_AI_MANAGER`, `NO_INDEPENDENT_REVIEWER`, `EMPLOYEE_SUSPENDED`, `HUMAN_REJECTED`, `MAX_REWORK_REACHED`, `SUBTASK_CANCELLED`, `MODEL_NOT_ALLOWED`, `BUDGET_EXCEEDED`, `RETRIES_EXHAUSTED`, `RUN_INTERRUPTED`, `TOOL_OUTCOME_UNKNOWN`, `NO_SUITABLE_ASSIGNEE`, `DEPENDENCY_CYCLE` |
| completed_at | timestamptz? | |

**Vòng đời (FR-020a)** – cạnh hợp lệ duy nhất:

```text
draft ──assign──▶ assigned ──start──▶ in_progress ──submit──▶ in_review ──pass──▶ awaiting_human_approval ──approve──▶ completed
                                         ▲                       │                       │
                                         └──────rework───────────┴───────rework──────────┘
(draft|assigned|in_progress|in_review|awaiting_human_approval) ──block/error──▶ blocked
blocked ──resume──▶ (trạng thái trước khi block, lưu ở blocked_from)
(mọi trạng thái chưa kết thúc) ──cancel──▶ cancelled
```

Quy tắc bổ sung:
- `in_review → awaiting_human_approval` chỉ khi mọi acceptance criterion có `evidence.verdict = met` và ≥ 1 artifact (FR-020, SC-002).
- `awaiting_human_approval → completed` chỉ qua `review_record.decision = approve` của human_member có quyền review task đó.
- Task giao cho team/org_unit: `assigned` → job decompose; áp dụng kế hoạch phân rã thì task cha `start` sang `in_progress`; mọi task con `completed` thì task cha `submit` sang `in_review`. Task cha chỉ `completed` qua Human Approval của chính nó. Kế hoạch `mode = confirm` hoặc không có task con cho task loại này → `blocked`, `blocked_reason = NO_SUITABLE_ASSIGNEE`.
- Mỗi task con đi đủ vòng đời, kể cả Human Approval; task phụ thuộc chỉ bắt đầu khi task nó phụ thuộc đã `completed`.
- AI Manager phụ trách phân rã (FR-016a): AI Manager thuộc team được giao → AI Manager có `home_org_unit_id` là đơn vị đó (task giao team: department chứa team); nhiều AI Manager cùng bậc thì lấy `id` nhỏ nhất; task giao Team mà vẫn không có thì hệ thống tự tạo AI Manager cho Team (`provisionTeamManager`, xem mục `ai_employee`) rồi dùng AI Manager đó; chỉ khi không tạo được → `blocked`, `blocked_reason = NO_AI_MANAGER`. Một AI Manager có thể thuộc nhiều Team nên AI Manager đã có ở Team khác vẫn được dùng nếu thuộc đúng Team được giao.
- Task giao trực tiếp cho `ai_employee`: `assigned` → job decompose do AI Manager chọn theo FR-018 (nhân viên được giao là AI Manager thì tự đảm nhiệm). `mode = confirm` thì giữ assignee và chờ slot để `start`; `mode = decompose` thì đi như task cha; không có AI Manager → `blocked`, `blocked_reason = NO_AI_MANAGER`.
- Task con kế thừa `deadline`, `priority`, `created_by_member_id` từ task cha.
- Reviewer AI (FR-018): manager AI trực tiếp → AI Manager cùng `home_org_unit_id` → AI Manager bất kỳ đang `active` trong công ty, luôn khác người thực thi; không có → `blocked`, `blocked_reason = NO_INDEPENDENT_REVIEWER`, notification `escalation`.
- Nhân viên `suspended`: không bắt đầu run mới; run đang chạy bị khóa tool, task sang `blocked`, `blocked_reason = EMPLOYEE_SUSPENDED`; task đang chờ slot giữ `assigned`. Khi nhân viên hoạt động lại (`employee.resumed`), task chờ slot được lấy theo priority rồi deadline. `resume` task có assignee còn `suspended` trả `409 EMPLOYEE_SUSPENDED`.
- Task giao trực tiếp cho AI Employee mà nhân viên hết slot: giữ `assigned`, xếp hàng theo priority rồi deadline (US2-AS5).
- Task của CEO AI Assistant (US9): assignee là trợ lý (`assignee_kind = ai_employee`) và đi đúng vòng đời FR-020a. (1) Tạo ở `draft` với `proposal_status = pending`; run `propose` điền các trường qua `TaskEngine.updateDraft` rồi `proposal_status = ready` hoặc `failed` (CEO sửa tay được trong cả hai trường hợp). (2) `draft` chỉ sửa được bằng `PATCH` (title, objective, deadline, priority, acceptance_criteria, expected_output, token_cap, cost_cap), mọi trạng thái khác `409 TASK_NOT_DRAFT`. (3) Job decompose chỉ chấp nhận `mode = confirm` (xem research R10); `decompose` → `blocked`, `NO_SUITABLE_ASSIGNEE`. (4) Reviewer luôn là AI Manager khác trợ lý theo FR-018; trợ lý không bao giờ là reviewer vì `kind = employee`. (5) Các task mà trợ lý tạo thay CEO (`assigned_by_ai_employee_id = trợ lý`) là task gốc độc lập có `created_by_member_id = CEO`; chúng ở `draft` hoặc `assigned` tùy nguồn tiêu chí (research R14 Decision 6), và không phải task con của task yêu cầu (không có `parent_task_id`) nên Dashboard đếm chúng như task gốc bình thường. (6) Hủy task yêu cầu của trợ lý không tự hủy các task trợ lý đã tạo; CEO hủy từng task qua luồng thường.
- Cột phụ: `blocked_from` (enum trạng thái).
- `reject` của Human Manager: ghi `review_record`, task sang `blocked`, `blocked_from = in_progress`, `blocked_reason = HUMAN_REJECTED`, tăng `rework_count`. `resume` tạo run `execute` mới nhận lý do từ chối; kết quả đã bị từ chối không approve lại được.
- `rework` làm `rework_count - rework_baseline ≥ max_rework`: task sang `blocked`, `blocked_from = in_progress`, `blocked_reason = MAX_REWORK_REACHED`, notification `escalation`. `reject` chạm ngưỡng này vẫn giữ `HUMAN_REJECTED` và không gửi `escalation`, vì người quyết định đã là người thật. Mọi `resume` lúc đã đạt ngưỡng đều đặt `rework_baseline = rework_count`.
- Sau `resume`, hệ thống chạy lại đúng bước: `assigned` → job decompose hoặc xếp hàng; `in_progress` → run `execute` mới (task cha: còn task con chưa `completed` thì tiếp tục chờ, đủ rồi thì chạy lại `synthesize`); `in_review` → `review.run`; `awaiting_human_approval` → chờ người duyệt. Run `execute` mới sau `resume`, retry hoặc rework của cùng task khởi tạo bằng cách sao chép nguyên thư mục của run gần nhất, gồm thay đổi chưa commit (FR-044).
- Task cha là task có task con và không có run `execute`. `rework`, hoặc `resume` sau `reject`, chạy lại `synthesize` do AI Manager đã phân rã thực hiện, kèm lý do; task con đã `completed` không mở lại.
- Task con (`parent_task_id` khác null) tạo ở `assigned`, không đi qua job decompose, chỉ giao cho `ai_employee`; chờ phụ thuộc và slot rồi `start`.
- Task con bị `cancelled` khi task cha chưa hủy: task cha `blocked`, `blocked_reason = SUBTASK_CANCELLED`; `resume` trả `409 SUBTASK_CANCELLED`, chỉ `cancel` được.
- `cancel` một task: hủy các run của task, chuyển approval đang chờ sang `cancelled`, và hủy mọi task con chưa kết thúc.
- Thống kê (FR-040): Dashboard chỉ đếm task gốc (`parent_task_id` null). `activeTasks` = task gốc khác `draft`, `completed`, `cancelled`; `completedTasks` = task gốc `completed`; `onTimeCompletionRate` = số task gốc `completed` có `completed_at ≤ deadline` / `completedTasks`, là `null` khi `completedTasks = 0`. `performance` của nhân viên đếm task có assignee là nhân viên đó, gồm task con.

### task_dependency
`task_id`, `depends_on_task_id`; không vòng (kiểm tra topological khi tạo).

### artifact
`task_id`, `agent_run_id?`, `kind` enum `document`,`code_diff`,`test_report`,`file`, `title`, `storage_key` (S3), `mime_type`, `size_bytes`, `checksum_sha256`.

### evidence
`task_id`, `criterion_id`, `artifact_id?`, `reviewer_kind` enum `ai`,`human`, `reviewer_id`, `verdict` enum `met`,`not_met`, `explanation`. Ràng buộc: `reviewer_id ≠` AI Employee đã tạo artifact (Nguyên tắc VII), kể cả artifact tổng hợp của task cha.

### review_record (bất biến, chỉ INSERT)
`task_id`, `stage` enum `ai_review`,`human_approval`, `reviewer_kind`, `reviewer_id`, `decision` enum `pass`,`rework`,`approve`,`reject`, `reason` (bắt buộc với mọi quyết định), `decided_at`. Phục vụ SC-014.

## Orchestration Engine

### agent_run
| Trường | Kiểu | Ghi chú |
|---|---|---|
| task_id | uuid | |
| ai_employee_id | uuid | |
| purpose | enum `execute`,`decompose`,`review`,`synthesize`,`propose` | run `decompose`, `review`, `synthesize`, `propose` không chiếm slot `max_concurrent_tasks`. `propose`: chỉ CEO AI Assistant, chỉ trên task `draft` có `proposal_status = pending`, structured output, không có tool |
| attempt | int | lần thử (retry) |
| status | enum `queued`,`running`,`waiting_approval`,`succeeded`,`failed`,`timed_out`,`cancelled` | |
| runtime_kind, model_id | | ảnh chụp tại thời điểm chạy (đổi model không ảnh hưởng lịch sử – US2-AS3) |
| provider_session_id | text? | dùng `resume` (Agent SDK) |
| heartbeat_at | timestamptz | sweeper phát hiện run chết |
| started_at, finished_at | | |
| error_code, error_message | text? | |
| trace_id | text | OpenTelemetry |

### run_step
`agent_run_id`, `seq` int (UNIQUE per run), `kind` enum `model_call`,`tool_call`,`message`,`system`, `summary`, `payload jsonb` (đã che secret), `started_at`, `finished_at`.

### tool_invocation (ledger tác dụng phụ)
| Trường | Kiểu | Ghi chú |
|---|---|---|
| run_step_id | uuid | |
| action_type | text | trong danh mục |
| permission_level | enum `auto_execute`,`review_required`,`human_approval`,`restricted` | kết quả evaluate |
| input | jsonb | đã chuẩn hóa |
| input_hash | text | sha256 |
| idempotency_key | text | UNIQUE; công thức theo nhóm `dedupe`/`rerun` trong [action-policy.md](./contracts/action-policy.md) |
| status | enum `denied`,`pending_approval`,`pending`,`executing`,`succeeded`,`failed`,`unknown` | `unknown` → Blocked, người thật quyết |
| adapter_mode | enum `dry_run`,`live`,`internal`? | `internal`: thao tác trên dữ liệu của chính ứng dụng do CEO AI Assistant đề xuất (lưu trữ đơn vị/nhân viên, hủy task) sau khi được duyệt; chỉ `dry_run` mới hiện nhãn "dry-run" trên giao diện || result | jsonb? | |

Dấu "thay mặt CEO" (FR-051) không cần cột riêng: một `tool_invocation` là hành động của CEO AI Assistant khi `agent_run.ai_employee_id` trỏ tới nhân viên có `role_template_key = 'ceo_assistant'`. Yêu cầu nguồn = `agent_run.task_id` (task yêu cầu, có `objective` là lời CEO); mức quyền = `permission_level`; kết quả = `status` + `result`; thời điểm = `run_step`. Giao diện lịch sử thực thi và `GET /tasks/{id}/operations` ghép các trường này.

### run_conversation_state
`agent_run_id` (UNIQUE), `messages jsonb`, `updated_at`. Chỉ dùng cho runtime `messages_api`: lưu hội thoại khi run tạm dừng chờ duyệt để resume, kể cả sau khi worker restart. Không chứa credential vì credential không bao giờ đi vào ngữ cảnh model.

## Permission Engine

### action_policy
`action_type`, `level` (enum như trên), `scope_kind` enum `company`,`org_unit`,`team`,`ai_employee`, `scope_id`. Mức hiệu lực = mức chặt nhất giữa `floor` trong danh mục và mọi policy áp dụng. Không có bản ghi và không có trong danh mục → `restricted`. Trong v1.0 bảng chỉ nhận seed, chưa có API ghi.

### approval_request
| Trường | Kiểu | Ghi chú |
|---|---|---|
| tool_invocation_id | uuid | UNIQUE; không có FK vì bảng thuộc Orchestration Engine |
| agent_run_id | uuid | run đang chờ duyệt (để `resumeAfterApproval` biết run nào cần tiếp tục) |
| task_id, ai_employee_id | uuid | ngữ cảnh (FR-026) |
| action_type | text | |
| summary | text | AI định làm gì |
| rationale | text | vì sao (do agent cung cấp, hiển thị như dữ liệu) |
| payload | jsonb | đúng payload sẽ thực thi |
| payload_hash | text | thực thi chỉ khi hash khớp |
| approver_member_id | uuid? | mặc định `task.created_by_member_id`; người này bị vô hiệu thì chuyển cho CEO |
| status | enum `pending`,`approved`,`rejected`,`cancelled` | không có `expired`/auto-approve; `pending` → `cancelled` khi task bị hủy hoặc rời `in_progress` (kèm bản ghi ledger `failed`) |
| decided_by, decided_at, decision_reason | | lý do bắt buộc với mọi quyết định |
| last_reminded_at | timestamptz? | |

## Platform: Usage & Budget

### budget_policy
`scope_kind`, `scope_id`, `monthly_token_limit?`, `monthly_cost_limit?` (numeric, USD), `max_concurrent_tasks?`, `allowed_models text[]?`, `warn_threshold` (mặc định 0.8). UNIQUE(scope_kind, scope_id). `max_concurrent_tasks` chỉ dùng cho scope company, org_unit, team; giới hạn của từng nhân viên lưu ở `ai_employee.max_concurrent_tasks`. Công ty không có bản ghi thì áp hạn mức mặc định từ cấu hình, không bao giờ coi là không giới hạn.

### usage_ledger (chỉ INSERT)
`agent_run_id`, `task_id`, `ai_employee_id`, `org_unit_id` (ảnh chụp; null với CEO AI Assistant), `team_ids uuid[]`, `model_id`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `cost_usd numeric(12,6)`, `period char(7)` (`YYYY-MM` theo timezone công ty), `provider_message_id` (UNIQUE – chống đếm trùng), `is_overage bool`.

### budget_reservation
`agent_run_id`, `scopes jsonb`, `reserved_tokens`, `reserved_cost`, `status` enum `held`,`committed`,`released`. Tổng đã dùng + đang giữ không vượt giới hạn. Runtime `claude_agent_sdk` giữ một reservation `held` trong lúc run chạy; run chết thì sweeper release. Khi run chuyển `waiting_approval`, phần đang giữ được release; lúc resume reserve lại, không đủ thì task `blocked`.

### budget_warning_log (T168)
`scope_kind`, `scope_id`, `period`, `metric` (`tokens`|`cost`), `limit_value`, `threshold`. UNIQUE(company_id, scope_kind, scope_id, period, metric, limit_value, threshold). `BudgetService.commit` ghi một dòng khi mức dùng của phạm vi đạt `limit × threshold`; chèn thành công mới cảnh báo, nên mỗi ngưỡng cảnh báo đúng một lần mỗi kỳ. Đổi giới hạn hoặc ngưỡng tạo ra khóa mới nên được cảnh báo lại.

### model_price (cấu hình)
`model_id`, `input_per_mtok`, `output_per_mtok`, `cache_read_per_mtok`, `cache_write_per_mtok`, `effective_from`.

## Platform: Events

### domain_event (outbox)
`seq bigint` (tăng dần theo company), `type` (xem [realtime-events.md](./contracts/realtime-events.md)), `aggregate_kind`, `aggregate_id`, `payload jsonb`, `occurred_at`, `published_at?`. Thay đổi do CEO AI Assistant thực hiện thay mặt CEO mang `payload.actingVia = { employeeId, runId, taskId }` (FR-051); sự kiện của thao tác người dùng thường không có trường này.

## Office Simulation Engine

### employee_status (projection)
`ai_employee_id` (PK cùng company), `state` enum `idle`,`working`,`thinking`,`communicating`,`meeting`,`waiting_approval`,`completed`,`error_blocked`,`break`, `current_task_id?`, `current_tool?`, `progress?` (0–100, do run báo), `source_event_seq bigint`, `changed_at`.

Bất biến: mỗi lần đổi `state` phải có `source_event_seq` trỏ tới một `domain_event` có thật (SC-006).

Cột bổ sung (T151): `suspended boolean` (nhân viên đang tạm ngưng → hiển thị `break`), `tracks jsonb` (các "đường chạy" theo `taskId`: `runId`, `state`, `tool`, `progress`, `reason`, `seq`; trạng thái hiển thị là kết quả gộp, ưu tiên `error_blocked` > `waiting_approval` > hoạt động > `completed`, cùng hạng lấy sự kiện gần nhất) và `applied_seq` (bỏ qua sự kiện giao lại). PK là (`company_id`, `ai_employee_id`).

### employee_status_change (nhật ký, T151)
`company_id`, `seq` (của `domain_event` nguồn), `ai_employee_id`, `state`, `previous_state`, `current_task_id?`, `current_tool?`, `progress?`, `source_event_type`, `occurred_at`. PK (`company_id`, `seq`, `ai_employee_id`). Mỗi dòng là một lần đổi hiển thị; gateway dựng `office.employee_status_changed` từ đây nên phát trực tiếp và phát lại theo `sinceSeq` cho cùng kết quả, và đối chiếu SC-006 không phải suy ngược từ trạng thái mới nhất. Chưa có chính sách dọn (≥ 10 phút theo realtime-events.md là mức tối thiểu).

### office_cursor (T151)
`company_id` PK, `applied_seq`: projection đã gấp mọi `domain_event` có `seq <= applied_seq`. `GET /office/snapshot` trả đúng mốc này.

### office_zone
`kind` enum `department`,`ceo_office`,`break_room`, `org_unit_id?`, `name`, `layout jsonb` (`{x, y, cols, rows}` trên lưới ô, sinh tất định). Nhân viên có `home_org_unit_id` rỗng (CEO AI Assistant, FR-035) được đặt ở zone `ceo_office`, `deskIndex` theo thứ tự tạo như các zone khác; layout `ceo_office` dựng đủ ô cho số bàn này (tối thiểu 1). Tạo/cập nhật tự động khi department hoặc nhân viên thay đổi. Chỉ department có zone; division chỉ có zone khi có nhân viên "nhà" trực tiếp. UNIQUE(`company_id`, `org_unit_id`) và mỗi công ty đúng một `ceo_office`, một `break_room`.

## Communication Engine

### task_message
`task_id` NOT NULL (FR-022), `author_kind` enum `human`,`ai`, `author_id`, `body`, `agent_run_id?`.

### notification
`recipient_member_id`, `type` enum `task_completed`,`task_error`,`task_overdue`,`approval_needed`,`budget_warning`,`budget_blocked`,`overload_warning`,`escalation`, `task_id?`, `approval_request_id?`, `title`, `body`, `read_at?`. Chỉ in-app (FR-041). Người nhận: `task_completed`, `task_error`, `task_overdue`, `budget_blocked`, `escalation` → `task.created_by_member_id`; `approval_needed` → `approver_member_id`; `overload_warning` → `EmployeeEngine.resolveAccountableHuman`; `budget_warning` → manager của scope (CEO với scope company, `resolveAccountableHuman` với scope nhân viên). Người nhận bị vô hiệu thì gửi CEO.

## Memory Engine

### memory_entry
`owner_scope_kind` enum `ai_employee`,`team`,`org_unit`, `owner_scope_id`, `source_task_id?`, `kind` enum `task_summary`,`note`, `content`, `share_rule jsonb?` (null = không chia sẻ ngoài scope). Truy xuất chỉ trong scope của run (FR-013).

## Gamification Engine

### milestone
`key` enum `first_employee`,`first_department`,`first_approved_task`, `achieved_at`, `source_event_seq`. UNIQUE(company_id, key) – chỉ một lần (US8-AS1). Không có quy tắc nào đọc `usage_ledger` hoặc thời lượng run (US8-AS2).
