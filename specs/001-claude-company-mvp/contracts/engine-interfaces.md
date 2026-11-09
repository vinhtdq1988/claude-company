# Contract: Interface giữa các engine và lớp trừu tượng model

Mỗi engine là một NestJS module, chỉ export các interface dưới đây (khai báo trong `packages/contracts`). Engine khác **không** import repository/bảng nội bộ (lint rule `no-restricted-imports` cưỡng chế). Mọi phương thức nhận `ctx: RequestContext` để áp tenant + scope.

```ts
type RequestContext = {
  companyId: string;
  actor: { kind: "human"; memberId: string } | { kind: "ai"; employeeId: string; runId: string } | { kind: "system" };
  traceId: string;
};
```

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
}
```

`EmployeeProfile` (hợp đồng Nguyên tắc VI): `{ id, name, avatarKey, position, homeOrgUnitId, teamIds, kind, roleTemplateKey, personality, skills, seniority, modelId, runtimeKind, systemPrompt, toolGrants, workspaceId, manager: {kind,id}, maxConcurrentTasks, status, performance: { completedTasks, onTimeRate, reworkRate } }`.

## TaskEngine

```ts
interface TaskEngine {
  create(ctx, input: TaskInput): Promise<Task>;                 // ASSIGNEE_OUT_OF_SCOPE, TASK_FIELDS_REQUIRED
  transition(ctx, taskId, action: TaskAction, meta?): Promise<Task>; // TASK_INVALID_TRANSITION – máy trạng thái FR-020a duy nhất
  attachArtifact(ctx, taskId, artifact: ArtifactInput): Promise<Artifact>;
  recordEvidence(ctx, taskId, evidence: EvidenceInput[]): Promise<void>; // REVIEWER_NOT_INDEPENDENT
  recordDecision(ctx, taskId, d: { decision: "approve"|"reject"|"rework"; reason: string }): Promise<Task>; // EVIDENCE_INCOMPLETE
  applyDecomposition(ctx, parentTaskId, plan: DecompositionPlan): Promise<Task[]>; // DEPENDENCY_CYCLE, NO_SUITABLE_ASSIGNEE
  markOverdue(ctx, now: Date): Promise<Task[]>;                 // sweeper: đặt is_overdue, trả các task vừa quá hạn
  get(ctx, id): Promise<TaskDetail>; list(ctx, filter: TaskFilter): Promise<Page<Task>>; // filter gồm assigneeKind, assigneeId, statusIn
  getStats(ctx, filter: { employeeId?: string; orgUnitId?: string }): Promise<TaskStats>;
  listCompaniesWithOpenTasks(): Promise<string[]>;              // sweeper: chỉ trả company_id
}
```

## OrchestrationEngine

```ts
interface OrchestrationEngine {
  enqueueRun(ctx, taskId, purpose: "execute"|"decompose"|"review"|"synthesize"): Promise<AgentRunRef>;
  resumeAfterApproval(ctx, approvalRequestId): Promise<void>;
  cancelRunsForTask(ctx, taskId): Promise<void>;
  getRun(ctx, runId): Promise<AgentRunDetail>;
  listRuns(ctx, filter: { taskId?; employeeId? }): Promise<Page<AgentRunSummary>>;
  listExecutedActions(ctx, taskId): Promise<ExecutedAction[]>;  // hành động nhạy cảm đã thực thi, kèm adapterMode
  recoverStaleRuns(): Promise<RecoveryReport>;                 // gọi bởi sweeper
  // Worker ghi bản ghi run chỉ qua các phương thức dưới đây, không truy cập bảng trực tiếp (Nguyên tắc VI)
  updateRunStatus(ctx, runId, patch: AgentRunStatusPatch): Promise<void>;
  heartbeat(ctx, runId): Promise<void>;
  appendRunStep(ctx, runId, step: RunStepInput): Promise<RunStepRef>;
  recordToolInvocation(ctx, inv: ToolInvocationInput): Promise<ToolInvocationRef>;
  updateToolInvocation(ctx, id, patch: ToolInvocationPatch): Promise<void>;
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
  createApprovalRequest(ctx, inv: ToolInvocationRef, summary: string, rationale: string): Promise<ApprovalRequest>;
  decideApproval(ctx, id, d: { decision: "approve"|"reject"; reason: string; payloadHash: string }): Promise<ApprovalRequest>;
  remindPendingApprovals(ctx, now: Date): Promise<number>;     // sweeper: nhắc người duyệt, không bao giờ tự duyệt
  listCompaniesWithPendingApprovals(): Promise<string[]>;      // sweeper: chỉ trả company_id
  /** Scope guard dùng cho mọi request HTTP/WS. */
  authorize(ctx, permission: AppPermission, target: ScopeRef): Promise<void>; // throws FORBIDDEN
}
```

## Usage & Budget (platform)

```ts
interface BudgetService {
  reserve(ctx, req: { runId; taskId; employeeId; modelId; estTokens: number; estCostUsd: number }): Promise<{ ok: true; reservationId: string; remainingUsd: number; remainingTokens: number } | { ok: false; limitHit: LimitRef }>;
  commit(ctx, reservationId, actual: UsageRecordInput): Promise<{ warnings: LimitRef[]; overage: boolean }>;
  release(ctx, reservationId): Promise<void>; // runtime claude_agent_sdk giữ một reservation theo run, commit từng lượt, release phần dư
  isModelAllowed(ctx, employeeId, modelId): Promise<boolean>;
  getUsage(ctx, filter: { employeeId?: string; taskId?: string; orgUnitId?: string; period?: string; groupBy?: "employee"|"task"|"org_unit" }): Promise<UsageSummary>;
}
```

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
  apply(event: DomainEvent): EmployeeStatusChange | null;   // reducer thuần, tất định
  getSnapshot(ctx): Promise<OfficeSnapshot>;
}
```

## CommunicationEngine, MemoryEngine, GamificationEngine

```ts
interface CommunicationEngine {
  postTaskMessage(ctx, taskId, body: string): Promise<TaskMessage>;
  listTaskMessages(ctx, taskId): Promise<TaskMessage[]>;
  notify(ctx, recipientMemberId, n: NotificationInput): Promise<void>;
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

Tổng nội dung artifact của một run không vượt `ARTIFACT_CONTEXT_MAX_BYTES`. Artifact vượt trần được cắt và gắn nhãn đã cắt; artifact nhị phân chỉ đưa metadata. Reviewer MUST trả `not_met` kèm giải thích cho criterion không kiểm chứng được từ nội dung nhận được.

Provider:

- `ClaudeAgentSdkProvider`: `query()` với `permissionMode: "default"`, `tools: []`, `allowedTools: ["mcp__cc__*"]`, `settingSources: []`, `cwd`, `model`, `maxTurns`, `env` tối thiểu, `mcpServers` = server in-process với mỗi handler gọi `io.invokeTool`, hook `PreToolUse` từ chối mọi tool ngoài `mcp__cc__*`, `maxBudgetUsd = limits.maxCostUsd`, `resume`. Khi `invokeTool` trả `pending_approval` hoặc `run_locked`, provider chờ agent kết thúc lượt (kể cả dừng vì `maxTurns`) rồi phát `paused_for_approval`. Usage dedupe theo `message.id`. Phát `model_call_started` khi bắt đầu `query()` và sau mỗi lần handler tool trả kết quả.
- `MessagesApiProvider`: vòng lặp tool-use tự viết, `beforeModelCall` trước mỗi request, `model_call_started` ngay trước mỗi request, `max_tokens` theo `limits`. Khi tạm dừng chờ duyệt, gọi `saveConversation` với lịch sử đã có kết quả `pending_approval`/`run_locked`; resume thêm kết quả duyệt thành một lượt user mới.
- `FakeModelProvider`: kịch bản tất định cho test (bao gồm kịch bản prompt injection yêu cầu gửi email).

## ToolAdapter (worker)

```ts
interface ToolAdapter {
  actionTypes: string[];
  mode: "dry_run" | "live";
  execute(input: unknown, idempotencyKey: string): Promise<ToolResult>;
  /** Dùng bởi recovery: trạng thái của lần thực thi với key này. */
  lookup(idempotencyKey: string): Promise<"succeeded" | "failed" | "not_found" | "unknown">;
}
```
