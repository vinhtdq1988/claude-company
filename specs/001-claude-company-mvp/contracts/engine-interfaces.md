# Contract: Interface giữa các engine và lớp trừu tượng model

Mỗi engine là một NestJS module, chỉ export các interface dưới đây (khai báo trong `packages/contracts`). Engine khác **không** import repository/bảng nội bộ (lint rule `no-restricted-imports` cưỡng chế). Mọi phương thức nhận `ctx: RequestContext` để áp tenant + scope.

```ts
type RequestContext = {
  companyId: string;
  actor:
    | { kind: "human"; memberId: string; via?: ActingVia }
    | { kind: "ai"; employeeId: string; runId: string }
    | { kind: "system" };
  traceId: string;
};

/** Chú thích audit (FR-051): thao tác do CEO AI Assistant thực hiện thay mặt CEO. Không cấp thêm quyền. */
type ActingVia = { employeeId: string; runId: string; taskId: string };
```

`via` chỉ do handler hệ thống của worker (`company-ops`) đặt, lấy từ run chứ không từ input của model; `TenantGuard` và các controller không bao giờ tạo `via`. Engine bỏ qua `via` khi quyết định quyền (quyền = quyền của `memberId`) và chỉ chép nó vào `domain_event.payload.actingVia` của mọi thay đổi để truy vết.

`createCompany` là thao tác duy nhất không có `RequestContext`: nhận `BootstrapContext = { userId: string; traceId: string }`, tự sinh `company_id` UUIDv7, chạy trong `withTenant` với id đó và tạo CEO bằng `actor.kind = "system"`.

Contract test (`tests/contract/`) kiểm tra từng interface với implementation thật trên Postgres test và với fake.

## OrganizationEngine

```ts
interface OrganizationEngine {
  createCompany(ctx: BootstrapContext, input: { name: string; templateKey?: string }): Promise<Company>;
  getOrgChart(ctx): Promise<OrgChart>;
  upsertOrgUnit(ctx, input): Promise<OrgUnit>;
  archiveOrgUnit(ctx, id: string): Promise<void>;          // throws ORG_UNIT_NOT_EMPTY
  upsertTeam(ctx, input): Promise<Team>; archiveTeam(ctx, id): Promise<void>;
  setTeamMembers(ctx, teamId, members: MemberRef[]): Promise<void>;
  assignManager(ctx, target: ScopeRef, managerMemberId: string): Promise<void>; // chỉ org_unit, team; manager của AI Employee đặt qua EmployeeEngine.update
  /** Phạm vi quản lý đã mở rộng (đơn vị con, team, nhân viên, gồm nhân viên có manager_kind = human trỏ tới member này). Dùng bởi ScopeGuard. */
  resolveManagedScope(ctx, memberId: string): Promise<ManagedScope>;
  isInScope(ctx, memberId: string, target: ScopeRef): Promise<boolean>;
  /** Đơn vị chưa archived, hoặc null. EmployeeEngine dùng để kiểm tra `home_org_unit_id` (US2). */
  getOrgUnit(ctx, id: string): Promise<OrgUnit | null>;
  /** Quan hệ thành viên-team của team chưa archived. EmployeeEngine dùng để tính `teamIds` và lọc theo team (US2). */
  listTeamMemberships(ctx): Promise<Array<{ teamId: string; memberKind: "ai" | "human"; memberId: string }>>;
}
```

## EmployeeEngine

```ts
interface EmployeeEngine {
  create(ctx, input: EmployeeProfileInput): Promise<EmployeeProfile>; // MANAGER_REQUIRED, MANAGEMENT_CHAIN_INVALID, MODEL_NOT_ALLOWED
  update(ctx, id, patch: Partial<EmployeeProfileInput>): Promise<EmployeeProfile>;
  suspend(ctx, id): Promise<void>; resume(ctx, id): Promise<void>;
  archive(ctx, id): Promise<void>;                            // EMPLOYEE_HAS_OPEN_TASKS
  get(ctx, id): Promise<EmployeeProfile>;
  list(ctx, filter): Promise<EmployeeProfile[]>;
  /** Người thật cuối chuỗi quản lý (chịu trách nhiệm). */
  resolveAccountableHuman(ctx, employeeId): Promise<string /* memberId */>;
  /** Slot còn trống để nhận task (FR-007). */
  getCapacity(ctx, employeeId): Promise<{ active: number; max: number }>;
  addHumanMember(ctx, input: { userId: string; role: "ceo"|"manager"; title?: string }): Promise<HumanMember>;
  listHumanMembers(ctx): Promise<HumanMember[]>;
  /** Không có ctx: chạy theo app.user_id, dùng cho TenantGuard và /auth/me. */
  findMemberships(userId: string): Promise<Membership[]>;
  deactivateHumanMember(ctx, memberId): Promise<void>;        // MANAGEMENT_CHAIN_INVALID
  /** Workspace được đăng ký của công ty; worker dùng để dựng thư mục làm việc của run. */
  getWorkspace(ctx, id): Promise<Workspace>;
  /**
   * FR-016a: tạo AI Manager cho Team chưa có (mẫu `ai_manager`, manager trực tiếp là người quản lý Team hoặc CEO), thêm vào Team.
   * Gọi đồng thời cho cùng Team dùng chung một lần tạo. `ctx.actor` là `system`. Không tạo được → ném DomainError, OrchestrationEngine đổi thành task `blocked` `NO_AI_MANAGER`.
   */
  provisionTeamManager(ctx, input: { teamId: string; teamName: string; orgUnitId: string; humanManagerId: string | null }): Promise<EmployeeProfile>;
  /** CEO AI Assistant chưa lưu trữ của công ty, hoặc null (US9). */
  getCeoAssistant(ctx): Promise<EmployeeProfile | null>;
}
```

Quy ước bổ sung của US2:

- `list` mặc định loại nhân viên `archived` (lọc `status: "archived"` để xem); không lọc theo phạm vi quản lý vì `OrganizationEngine.resolveManagedScope` cũng gọi `list`. Controller lọc theo `ManagedScope` của người xem.
- `list` chỉ tính `performance` (gọi `TaskEngine.getStats`) khi `filter.withPerformance = true`; `get` luôn tính.
- `getCapacity.active` đếm task của nhân viên ở trạng thái `in_progress`; run `decompose`, `review`, `synthesize` không chiếm slot.
- `EmployeeEngine` lấy `OrganizationEngine` muộn qua `ModuleRef` vì `OrganizationEngine` cũng phụ thuộc `EmployeeEngine`.
- `archive` gỡ nhân viên khỏi mọi Team; bị chặn khi còn task chưa kết thúc (`EMPLOYEE_HAS_OPEN_TASKS`) hoặc khi AI Manager còn cấp dưới (`MANAGEMENT_CHAIN_INVALID`).

Quy ước bổ sung của US9 (CEO AI Assistant): `create` với `roleTemplateKey = "ceo_assistant"` ném `CEO_ASSISTANT_EXISTS` nếu đã có trợ lý chưa lưu trữ, ép `kind = employee`, `runtimeKind = messages_api`, `homeOrgUnitId = null` và `manager = { kind: "human", id: <CEO> }`; `update` từ chối đổi các trường đó và từ chối `toolGrants` ngoài danh sách của [action-policy.md](./action-policy.md). `homeOrgUnitId` rỗng chỉ hợp lệ cho mẫu này. Các phương thức khác (`list`, `suspend`, `archive`…) không đổi; `list` trả cả trợ lý (controller lọc theo `ManagedScope`, nên chỉ CEO thấy).

`EmployeeProfile` (hợp đồng Nguyên tắc VI): `{ id, name, avatarKey, position, homeOrgUnitId, teamIds, kind, roleTemplateKey, personality, skills, seniority, modelId, runtimeKind, systemPrompt, toolGrants, workspaceId, manager: {kind,id}, maxConcurrentTasks, status, performance: { completedTasks, onTimeRate, reworkRate } }`.

## TaskEngine

```ts
interface TaskEngine {
  create(ctx, input: TaskInput): Promise<Task>;                 // ASSIGNEE_OUT_OF_SCOPE, TASK_FIELDS_REQUIRED
  transition(ctx, taskId, action: TaskAction, meta?): Promise<Task>; // TASK_INVALID_TRANSITION – máy trạng thái FR-020a duy nhất
  /** Chỉ task `draft` (FR-047): sửa title, objective, deadline, priority, acceptanceCriteria, expectedOutput, tokenCap, costCap. TASK_NOT_DRAFT, PROPOSAL_PENDING (khi người gọi là người dùng; run `propose` của trợ lý được phép), TASK_FIELDS_REQUIRED. */
  updateDraft(ctx, taskId, patch: TaskDraftPatch): Promise<Task>;
  attachArtifact(ctx, taskId, artifact: ArtifactInput): Promise<Artifact>; // chỉ khi task `in_progress`
  /** Nội dung artifact (tối đa `maxBytes` byte đầu) và cờ `truncated`; không kiểm tra phạm vi người dùng (controller kiểm tra). */
  readArtifact(ctx, artifactId, maxBytes: number): Promise<{ content: Buffer; truncated: boolean }>;
  recordEvidence(ctx, taskId, evidence: EvidenceInput[]): Promise<void>; // REVIEWER_NOT_INDEPENDENT; chỉ khi `in_review` hoặc `awaiting_human_approval`
  /** Người thật: `approve|reject|rework` ở `awaiting_human_approval`. AI Manager: `pass|rework` ở `in_review`. Sai loại tác nhân → FORBIDDEN. */
  recordDecision(ctx, taskId, d: { decision: "approve"|"reject"|"rework"|"pass"; reason: string }): Promise<Task>; // EVIDENCE_INCOMPLETE, VALIDATION_FAILED (thiếu reason)
  applyDecomposition(ctx, parentTaskId, plan: DecompositionPlan): Promise<Task[]>; // DEPENDENCY_CYCLE, NO_SUITABLE_ASSIGNEE
  markOverdue(ctx, now: Date): Promise<Task[]>;                 // sweeper: đặt is_overdue, trả các task vừa quá hạn; task `draft` (chưa giao) không bị tính quá hạn
  get(ctx, id): Promise<TaskDetail>; list(ctx, filter: TaskFilter): Promise<Page<Task>>; // filter gồm assigneeKind, assigneeId, statusIn
  getStats(ctx, filter: { employeeId?: string; orgUnitId?: string }): Promise<TaskStats>;
  listCompaniesWithOpenTasks(): Promise<string[]>;              // sweeper: chỉ trả company_id
}
```

## OrchestrationEngine

```ts
interface OrchestrationEngine {
  /**
   * Chọn nhân viên theo `purpose` (execute: assignee; decompose: AI Manager theo FR-016a/FR-018; review: reviewer độc lập theo D5;
   * synthesize: AI Manager đã phân rã), tạo `agent_run` và xếp job. Không chọn được → task `blocked`
   * (`NO_AI_MANAGER` / `NO_INDEPENDENT_REVIEWER`) rồi ném lỗi cùng mã. Đã có run chưa kết thúc cùng task + purpose thì trả lại run đó.
   */
  enqueueRun(ctx, taskId, purpose: "execute"|"decompose"|"review"|"synthesize"|"propose"): Promise<AgentRunRef>;
  /** Lần thử kế tiếp (retry) của run lỗi tạm thời: cùng task/nhân viên/purpose, `attempt + 1`, sau `delayMs`. */
  enqueueRetry(ctx, runId, delayMs: number): Promise<AgentRunRef>;
  resumeAfterApproval(ctx, approvalRequestId, options?: { replay?: boolean }): Promise<void>; // duyệt → action.execute-approved; từ chối → ledger denied + run.resume
  cancelRunsForTask(ctx, taskId): Promise<void>;
  getRun(ctx, runId): Promise<AgentRunDetail>;
  listRuns(ctx, filter: { taskId?; employeeId? }): Promise<Page<AgentRunSummary>>;
  listExecutedActions(ctx, taskId): Promise<ExecutedAction[]>;  // hành động nhạy cảm đã thực thi, kèm adapterMode
  recoverStaleRuns(): Promise<RecoveryReport>;                 // gọi bởi sweeper: run quá hạn heartbeat → failed RUN_INTERRUPTED/TOOL_OUTCOME_UNKNOWN + task blocked
  /** Kết quả job `task.decompose`: áp kế hoạch qua TaskEngine; kế hoạch sai (DEPENDENCY_CYCLE, NO_SUITABLE_ASSIGNEE) → task `blocked`. */
  applyDecompositionPlan(ctx, taskId, plan: DecompositionPlan): Promise<void>;
  /** Kết quả job `review.run`: ghi bằng chứng rồi quyết định `pass`/`rework`; `ctx.actor` là reviewer. */
  applyReviewResult(ctx, taskId, result: ReviewResult): Promise<void>;
  /**
   * Kết quả job `task.propose` (US9): kiểm tra `TaskProposal` (≥ 1 tiêu chí, deadline trong tương lai, priority hợp lệ) rồi ghi đè task `draft`
   * qua `TaskEngine.updateDraft` và đặt `proposal_status = ready`; sai hoặc hết retry → `failed`. Không đổi trạng thái task.
   */
  applyTaskProposal(ctx, taskId, proposal: TaskProposal | { failed: true; reason: string }): Promise<void>;
  // Worker ghi bản ghi run chỉ qua các phương thức dưới đây, không truy cập bảng trực tiếp (Nguyên tắc VI)
  updateRunStatus(ctx, runId, patch: AgentRunStatusPatch): Promise<void>;
  heartbeat(ctx, runId): Promise<RunStatus>;                   // trả trạng thái hiện tại để run-loop biết khi run bị hủy
  appendRunStep(ctx, runId, step: RunStepInput): Promise<RunStepRef>;
  /** Phát sự kiện run/tiến độ/usage thành `domain_event` (nguồn duy nhất cho realtime). */
  publishRunEvent(ctx, runId, event: RunEventInput): Promise<void>;
  recordToolInvocation(ctx, inv: ToolInvocationInput): Promise<ToolInvocationRef>;
  updateToolInvocation(ctx, id, patch: ToolInvocationPatch): Promise<void>;
  /** `pending_approval` → `executing` bằng cập nhật có điều kiện; chỉ một người gọi nhận `true` (duyệt hai lần / job giao lại chỉ thực thi một lần). */
  claimToolInvocation(ctx, id): Promise<boolean>;
  findToolInvocationByKey(ctx, idempotencyKey: string): Promise<ToolInvocationRef | null>;
  saveConversationState(ctx, runId, messages: unknown): Promise<void>;       // chỉ messages_api
  loadConversationState(ctx, runId): Promise<unknown | null>;
}
```

## PermissionEngine

```ts
type PermissionLevel = "auto_execute" | "review_required" | "human_approval" | "restricted";

interface PermissionEngine {
  /** Thuần quyết định; KHÔNG nhận nội dung prompt/task làm đầu vào. */
  evaluate(ctx, req: { employeeId: string; actionType: string; input: unknown }): Promise<{ level: PermissionLevel; reason: string }>;
  /** `ctx.actor` phải là run của AI; payload lấy lại từ ledger chứ không từ `inv`. Idempotent theo `tool_invocation`. */
  createApprovalRequest(ctx, inv: ToolInvocationRef, summary: string, rationale: string): Promise<ApprovalRequest>; // FORBIDDEN
  /** Chỉ người thật trong phạm vi quản lý của nhân viên. */
  decideApproval(ctx, id, d: { decision: "approve"|"reject"; reason: string; payloadHash: string }): Promise<ApprovalRequest>; // FORBIDDEN, NOT_FOUND, VALIDATION_FAILED (thiếu reason), APPROVAL_NOT_PENDING, APPROVAL_PAYLOAD_CHANGED
  getApproval(ctx, id): Promise<ApprovalRequest>;                                  // NOT_FOUND; kèm taskTitle, employeeName
  listApprovals(ctx, filter: { status?; taskId?; employeeIds?: string[]; limit? }): Promise<Page<ApprovalRequest>>; // employeeIds rỗng = không có gì trong phạm vi
  remindPendingApprovals(ctx, now: Date): Promise<number>;     // sweeper: nhắc người duyệt, không bao giờ tự duyệt
  listCompaniesWithPendingApprovals(): Promise<string[]>;      // sweeper: chỉ trả company_id
  /** Scope guard dùng cho mọi request HTTP/WS. */
  authorize(ctx, permission: AppPermission, target: ScopeRef): Promise<void>; // throws FORBIDDEN
}
```

Quy ước bổ sung của US4:

- `ToolInvocationRef` mang thêm `runId`, `taskId`, `permissionLevel`, `input` (đúng bản đã ghi ledger) để Permission Engine tạo yêu cầu phê duyệt mà không đọc bảng của Orchestration Engine. `createApprovalRequest` vẫn đọc lại bản ghi qua `findToolInvocationByKey` và từ chối (`FORBIDDEN`) nếu `id`, `runId` của tác nhân hoặc `permissionLevel = human_approval` không khớp.
- Người duyệt mặc định là `task.created_by_member_id`; người này bị vô hiệu thì chuyển cho CEO (lúc tạo, và khi nhận `human_member.deactivated`). Quyền quyết định: thành viên có nhân viên trong `ManagedScope` (CEO luôn có). Danh sách `GET /approvals` lọc theo cùng phạm vi.
- `payload_hash = sha256(stableStringify(payload))` (`@claude-company/policy`, `payloadHashOf`). `decideApproval` kiểm tra hash người duyệt gửi lên và tính lại từ payload lưu trữ; job thực thi kiểm tra lại lần nữa và so với bản ghi ledger.
- Yêu cầu `pending` chuyển sang `cancelled` (kèm bản ghi ledger `failed`, để lần đề xuất lại sau `resume` không bị chặn) khi task rời `in_progress` hoặc bị hủy; sự kiện `approval.cancelled`. Người duyệt đổi → `approval.reassigned`.
- `approval.decided` được `TaskFlowListener` chuyển thành `OrchestrationEngine.resumeAfterApproval`. Duyệt → job `action.execute-approved` (worker chiếm bản ghi bằng `claimToolInvocation`, thực thi qua adapter, ghi `succeeded` + `adapter_mode`, rồi xếp `run.resume`); từ chối → ledger `denied` rồi `run.resume`. `run.resume` (payload có `approvalRequestId`) tiếp tục run `waiting_approval`: SDK nối lại session, `messages_api` nạp `run_conversation_state`, kết quả duyệt đi vào `input` dưới thẻ `approval_result` (dữ liệu, không phải chỉ dẫn); ngân sách được reserve lại, không đủ thì task `blocked`, `BUDGET_EXCEEDED`.
- `recoverStaleRuns` phát lại (`resumeAfterApproval(ctx, id, { replay: true })`) cho run `waiting_approval` đã có quyết định nhưng không tiến triển sau `APPROVAL_REPLAY_AFTER_MS`; yêu cầu chưa quyết định không bị đụng tới. Hai job `action.execute-approved` và `run.resume` được BullMQ thử lại tối đa 5 lần vì idempotent.

## Usage & Budget (platform)

```ts
interface BudgetService {
  reserve(ctx, req: { runId; taskId; employeeId; modelId; estTokens: number; estCostUsd: number }): Promise<{ ok: true; reservationId: string; remainingUsd: number; remainingTokens: number } | { ok: false; limitHit: LimitRef }>;
  commit(ctx, reservationId, actual: UsageRecordInput): Promise<{ warnings: LimitRef[]; overage: boolean }>;
  releaseRun(ctx, runId): Promise<void>;      // giải phóng mọi phần đang giữ của một run (run chết, bị hủy)
  release(ctx, reservationId): Promise<void>; // runtime claude_agent_sdk giữ một reservation theo run, commit từng lượt, release phần dư
  isModelAllowed(ctx, employeeId, modelId): Promise<boolean>;
  getUsage(ctx, filter: { employeeId?: string; taskId?: string; orgUnitId?: string; period?: string; groupBy?: "employee"|"task"|"org_unit" }): Promise<UsageSummary>;
}
```

Bổ sung của US6 (D4):

- `getUsage` nhận thêm `scope?: ManagedScope`: chỉ cộng chi tiêu của nhân viên trong `employeeIds` hoặc đơn vị trong `orgUnitIds` (ledger lưu đơn vị nhà tại thời điểm ghi, nên nhân viên đã lưu trữ vẫn tính vào đơn vị cũ). Không đặt = không lọc.
- `allowedModelsFor(ctx, { homeOrgUnitId, teamIds?, employeeId? })` trả giao của `allowed_models` ở company, đơn vị (cả tổ tiên), team, nhân viên; `null` nếu không scope nào khai báo. Dùng được khi nhân viên chưa tồn tại. `EmployeeEngine.create/update` gọi hàm này (lấy muộn qua `ModuleRef`) và trả `MODEL_NOT_ALLOWED` khi `modelId` hoặc `homeOrgUnitId` đổi làm model ra ngoài danh sách.
- `getConcurrencyLimits(ctx, employeeId)` trả `max_concurrent_tasks` của company, đơn vị (cả tổ tiên), team áp lên nhân viên. `TaskScheduler` chỉ `start` task khi cả giới hạn nhân viên lẫn mọi giới hạn scope còn slot (đếm task `in_progress` được giao cho AI Employee thuộc scope); task rời `in_progress` lập lịch lại cả những nhân viên cùng scope đang chờ, và `budget.policy_changed` lập lịch lại mọi nhân viên có task `assigned`.
- `commit` cảnh báo ngưỡng qua `budget_warning_log`: mỗi (phạm vi, kỳ, loại, giới hạn, ngưỡng) đúng một lần. Lớp `UsageBudgetService` (không thuộc interface) có thêm `getPolicy`/`upsertPolicy` cho API chính sách.
- `TaskEngine.getStats` nhận thêm `scope?: ManagedScope` để Dashboard của Manager chỉ tổng hợp phạm vi của mình.
- `overload_warning`: `TaskScheduler` gửi qua `CommunicationEngine.notifyRouted` khi số task `assigned` sẵn sàng nhưng chờ slot đạt `max_concurrent_tasks` của nhân viên; tối đa một lần mỗi ngày lịch (múi giờ công ty) cho mỗi nhân viên, khử trùng bằng khóa Redis `overload:{companyId}:{employeeId}:{YYYY-MM-DD}` (`SET NX`).

## ModelCatalog (platform)

```ts
interface ModelCatalog {
  listModels(): Promise<ModelInfo[]>;
  hasModel(modelId: string): Promise<boolean>; // nơi duy nhất engine khác dùng để hỏi về `model_price`
}
```

## IdentityDirectory (platform/auth)

```ts
interface IdentityDirectory {
  findUserByEmail(email: string): Promise<{ id: string; displayName: string } | null>;
  getUsers(ids: string[]): Promise<{ id: string; displayName: string; email: string }[]>; // nơi duy nhất engine khác dùng để hỏi về bảng `user`
}
```

## OfficeSimulationEngine

```ts
interface OfficeSimulationEngine {
  /** Reducer thuần, tất định. `previous` bỏ trống = nhân viên chưa có trạng thái (idle). Trả null nếu hiển thị không đổi
   *  (kể cả sự kiện giao lại có seq đã áp). */
  apply(event: DomainEvent, previous?: OfficeEmployeeState): EmployeeStatusChange | null;
  /** Chỉ gồm nhân viên trong phạm vi quản lý của người xem; `seq` là mốc đã chiếu. `FORBIDDEN` với tác nhân AI. */
  getSnapshot(ctx): Promise<OfficeSnapshot>;
  /** Employee Profile (FR-038); chỉ gọi interface engine khác và `BudgetService.getUsage`. */
  getProfileView(ctx, employeeId: string): Promise<EmployeeProfileView>;
  /** Job trễ 60 giây: nếu nhân viên còn đúng lần `completed` có `sinceSeq` thì ghi `domain_event`
   *  `office.completed_display_elapsed`. Trả false nếu không còn gì để làm (idempotent). */
  completeDisplayElapsed(ctx, input: { employeeId: string; taskId: string; sinceSeq: number }): Promise<boolean>;
}
```

Projection là phép gấp tất định của `domain_event` theo `seq` với mốc `office_cursor`; bộ chiếu của relay (`EventBus.project`) chạy trước khi sự kiện được phát ra Redis nên `employee_status`, `employee_status_change` và `office_zone` đã commit khi gateway và client đọc lại. Sự kiện cấp task (`task.status_changed`) được áp cho cả nhân viên đang có track trên task đó (ví dụ reviewer đang `error_blocked`).


## CommunicationEngine, MemoryEngine, GamificationEngine

```ts
interface CommunicationEngine {
  postTaskMessage(ctx, taskId, body: string): Promise<TaskMessage>; // NOT_FOUND nếu task không tồn tại; tác nhân `system` → FORBIDDEN
  listTaskMessages(ctx, taskId): Promise<TaskMessage[]>;
  /** Lưu `notification` và phát `notification.created` tới `user:{memberId}`. */
  notify(ctx, recipientMemberId, n: NotificationInput): Promise<Notification>;
  /** Chọn người nhận theo FR-041 (người giao, người duyệt, manager phạm vi; mặc định CEO) rồi `notify`. */
  notifyRouted(ctx, n: RoutedNotification): Promise<Notification>;
  listNotifications(ctx, memberId, filter: { unread?: boolean; cursor?: string; limit?: number }): Promise<Page<Notification>>;
  markRead(ctx, memberId, notificationId): Promise<void>;       // NOT_FOUND nếu không phải của người này
  markAllRead(ctx, memberId): Promise<number>;
}
interface MemoryEngine {
  recall(ctx, scope: { employeeId: string; taskId: string }, limit: number): Promise<MemoryEntry[]>; // chỉ trong scope
  remember(ctx, entry: MemoryEntryInput): Promise<void>;
}
interface GamificationEngine {
  onDomainEvent(event: DomainEvent): Promise<void>;  // chỉ milestone first_employee/first_department/first_approved_task
}
```

## ModelGateway (`packages/model-gateway`)

Feature code chỉ dùng interface này; chỉ provider được import `@anthropic-ai/*` (lint rule).

```ts
interface ModelGateway {
  runAgent(req: AgentRunRequest, io: AgentRunIO): AsyncIterable<AgentRunEvent>;
}

type AgentRunRequest = {
  runtimeKind: "claude_agent_sdk" | "messages_api";
  modelId: string;
  systemPrompt: string;
  input: string;                       // mục tiêu + tiêu chí + ngữ cảnh memory (đánh dấu là dữ liệu)
  tools: ToolSpec[];                   // chỉ tool đã cấp, sinh từ danh mục ActionType (buildToolSpecs)
  workspacePath?: string;
  resumeSessionId?: string;
  resumeConversation?: unknown;        // messages_api: hội thoại đã lưu khi tạm dừng
  limits: { maxCostUsd: number; maxTokens: number; timeoutMs: number };
  structuredOutput?: ZodSchema;        // decompose / review
};

type ToolSpec = {
  name: string;                        // ActionType đổi `.` thành `_`, ví dụ `email_send`
  actionType: string;
  description: string;
  inputSchema: object;                 // JSON Schema sinh từ Zod trong packages/contracts/src/tool-inputs.ts
};

type AgentRunIO = {
  /** Mọi lời gọi tool đi qua đây → ToolBroker → PermissionEngine. Provider KHÔNG được thực thi tool theo cách khác. */
  invokeTool(call: { name: string; input: unknown; providerCallId: string }): Promise<ToolResult>;
  /** Gọi trước mỗi lượt model; false → provider dừng ngay. Chỉ messages_api và fake; claude_agent_sdk dùng reservation theo run + maxBudgetUsd. */
  beforeModelCall(est: { modelId: string; estTokens: number }): Promise<boolean>;
  /** Chỉ messages_api: gọi trước khi phát paused_for_approval. */
  saveConversation(messages: unknown): Promise<void>;
  signal: AbortSignal;
};

type AgentRunEvent =
  | { type: "session"; sessionId: string }
  | { type: "model_call_started" }
  | { type: "model_call"; messageId: string; usage: TokenUsage }
  | { type: "tool_call"; name: string; status: "started"|"finished" }
  | { type: "text"; text: string }
  | { type: "progress"; percent: number; summary: string }
  | { type: "paused_for_approval"; approvalRequestId: string }
  | { type: "finished"; output: unknown; artifacts: ArtifactInput[] }
  | { type: "error"; code: string; message: string; retryable: boolean };
```

### Ngữ cảnh đầu vào theo purpose

Hệ thống tự đưa các nội dung này vào `input` dưới dạng dữ liệu (không phải chỉ dẫn), lấy qua interface engine và `StorageService`:

- `decompose`: mục tiêu, acceptance criteria, đầu ra mong đợi của task; danh sách nhân viên `active` trong phạm vi của `created_by_member_id` gồm `id`, `name`, `position`, `kind`, `skills`, `seniority`, `active`/`max` từ `getCapacity`.
- `execute`: mục tiêu, acceptance criteria, đầu ra mong đợi, memory theo scope, tin nhắn người quản lý, lý do rework hoặc reject nếu có.
- `review`: acceptance criteria, đầu ra mong đợi, metadata và nội dung từng artifact, lý do các vòng rework trước.
- `synthesize`: mục tiêu task cha; mục tiêu, kết quả review và artifact của từng task con; lý do rework hoặc reject nếu có.
- `propose` (CEO AI Assistant): lời CEO (`objective`), danh sách rút gọn đơn vị/Team/nhân viên đang hoạt động (id, tên, vị trí), deadline và priority CEO đã nêu nếu có; structured output `TaskProposal { title, acceptanceCriteria[], expectedOutput, deadline, priority }`, không có tool.
- `execute` của CEO AI Assistant: như `execute`, thêm lời CEO và mọi `task_message` của người thật; không có nội dung workspace. Kết quả `company.query` và nội dung artifact của người khác được đưa vào như dữ liệu (thẻ `tool_result`), không phải chỉ dẫn.

Tổng nội dung artifact của một run không vượt `ARTIFACT_CONTEXT_MAX_BYTES`. Artifact vượt trần được cắt và gắn nhãn đã cắt; artifact nhị phân chỉ đưa metadata. Reviewer MUST trả `not_met` kèm giải thích cho criterion không kiểm chứng được từ nội dung nhận được.

Provider:

- `ClaudeAgentSdkProvider`: `query()` với `permissionMode: "default"`, `tools: []`, `allowedTools: ["mcp__cc__*"]`, `settingSources: []`, `cwd`, `model`, `maxTurns`, `env` tối thiểu, `mcpServers` = server in-process với mỗi handler gọi `io.invokeTool`, hook `PreToolUse` từ chối mọi tool ngoài `mcp__cc__*`, `maxBudgetUsd = limits.maxCostUsd`, `resume`. Khi `invokeTool` trả `pending_approval` hoặc `run_locked`, provider chờ agent kết thúc lượt (kể cả dừng vì `maxTurns`) rồi phát `paused_for_approval`. Usage dedupe theo `message.id`. Phát `model_call_started` khi bắt đầu `query()` và sau mỗi lần handler tool trả kết quả.
- `MessagesApiProvider`: vòng lặp tool-use tự viết, `beforeModelCall` trước mỗi request, `model_call_started` ngay trước mỗi request, `max_tokens` theo `limits`. Khi tạm dừng chờ duyệt, gọi `saveConversation` với lịch sử đã có kết quả `pending_approval`/`run_locked`; resume thêm kết quả duyệt thành một lượt user mới.
- `FakeModelProvider`: kịch bản tất định cho test (bao gồm kịch bản prompt injection yêu cầu gửi email).

## Tool điều hành của CEO AI Assistant (worker)

`apps/worker/src/tools/company-ops.ts` đăng ký handler cho các `ActionType` ở [action-policy.md](./action-policy.md) vào `ToolBroker` (cùng cơ chế với `internal-tools.ts`). Handler chỉ phụ thuộc interface của `OrganizationEngine`, `EmployeeEngine`, `TaskEngine`, `BudgetService`/dashboard service và `CommunicationEngine`; không đọc bảng của engine nào (lint ranh giới engine áp dụng như mọi module).

```ts
type CompanyOpsDeps = {
  organization: Pick<OrganizationEngine, "getOrgChart" | "upsertOrgUnit" | "archiveOrgUnit" | "upsertTeam" | "archiveTeam" | "setTeamMembers">;
  employees: Pick<EmployeeEngine, "create" | "update" | "suspend" | "resume" | "archive" | "list" | "listHumanMembers" | "getCeoAssistant">;
  tasks: Pick<TaskEngine, "create" | "transition" | "get" | "list" | "getStats">;
  usage: Pick<BudgetService, "getUsage">;       // cùng nguồn với GET /usage và /dashboard
  dashboard: DashboardReader;                    // cùng service với GET /dashboard (SC-017)
  communication: Pick<CommunicationEngine, "listTaskMessages">; // kiểm tra nguồn trích dẫn `ceo_quote`
};

/** Dựng ctx thay mặt CEO sau khi kiểm tra điều kiện C1 của action-policy; ném ASSISTANT_CONTEXT_INVALID nếu sai. */
function delegatedContext(run: RunContext, deps): Promise<RequestContext>;
```

Mỗi handler: (1) `delegatedContext`, (2) từ chối đối tượng là chính trợ lý nếu thuộc nhóm C3, (3) gọi engine với ctx đó, (4) trả kết quả rút gọn (id, tên, trạng thái) cho model. Lỗi `DomainError` của engine được trả cho model như `ToolResult { status: "error", code }` để trợ lý giải thích cho CEO; không có đường ghi trực tiếp vào bảng nào.

## ToolAdapter (worker)

```ts
interface ToolAdapter {
  actionTypes: string[];
  mode: "dry_run" | "live" | "internal"; // `internal`: InternalOpsAdapter cho org.archive, employee.archive, task.cancel
  execute(input: unknown, idempotencyKey: string): Promise<ToolResult>;
  /** Dùng bởi recovery: trạng thái của lần thực thi với key này. */
  lookup(idempotencyKey: string): Promise<"succeeded" | "failed" | "not_found" | "unknown">;
}
```

`InternalOpsAdapter.execute` nhận payload đã duyệt, dựng ctx `human` của người duyệt kèm `via` (lấy từ `approval_request.agent_run_id`/`ai_employee_id`/`task_id`) rồi gọi `archiveOrgUnit`/`archiveTeam`/`EmployeeEngine.archive`/`TaskEngine.transition(cancel)`; `lookup` đối chiếu bằng trạng thái đối tượng (đã `archived_at`/`cancelled` thì `succeeded`) nên recovery không thực hiện lại.
