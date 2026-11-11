import type {
  AgentRunRef,
  AgentRunDetail,
  AgentRunStatusPatch,
  AgentRunSummary,
  ExecutedAction,
  MemoryEntry,
  MemoryEntryInput,
  NotificationInput,
  RecoveryReport,
  RoutedNotification,
  RunEventInput,
  RunListFilter,
  RunStatus,
  RunStepInput,
  RunStepRef,
  ToolInvocationInput,
  ToolInvocationPatch,
  ToolResult,
} from './run';
import type { ApprovalFilter, ApprovalRequest, ToolInvocationRef } from './approval';
import type { Milestone } from './gamification';
import type {
  AppPermission,
  BootstrapContext,
  HumanMember,
  HumanRole,
  ManagedScope,
  MemberRef,
  Membership,
  Page,
  RequestContext,
  ScopeRef,
} from './common';
import type {
  EmployeeFilter,
  EmployeeProfile,
  EmployeeProfileInput,
  ModelInfo,
  RoleTemplate,
  Workspace,
} from './employee';
import type {
  BudgetPolicy,
  BudgetScopeKind,
  ConcurrencyLimit,
  LimitRef,
  UsageRecordInput,
  UsageSummary,
} from './budget';
import type {
  Company,
  OrgChart,
  OrgUnit,
  Team,
  TeamMembershipRef,
  UpsertOrgUnitInput,
  UpsertTeamInput,
} from './organization';
import type {
  EmployeeProfileView,
  EmployeeStatusChange,
  OfficeEmployeeState,
  OfficeSnapshot,
} from './office';
import type { DomainEvent } from './realtime';
import type {
  Artifact,
  ArtifactInput,
  DecompositionPlan,
  TaskDraftPatch,
  TaskOperation,
  TaskProposal,
  EvidenceInput,
  Notification,
  ReviewResult,
  Task,
  TaskAction,
  TaskDecisionInput,
  TaskDetail,
  TaskFilter,
  TaskInput,
  TaskMessage,
  TaskStats,
  TaskStatus,
} from './task';

/** Interface công khai của các engine (contracts/engine-interfaces.md, đã gồm D4). */

export interface OrganizationEngine {
  createCompany(
    ctx: BootstrapContext,
    input: { name: string; templateKey?: string },
  ): Promise<Company>;
  getCompany(ctx: RequestContext): Promise<Company>;
  getOrgChart(ctx: RequestContext): Promise<OrgChart>;
  upsertOrgUnit(ctx: RequestContext, input: UpsertOrgUnitInput): Promise<OrgUnit>;
  /** @throws DomainError ORG_UNIT_NOT_EMPTY */
  archiveOrgUnit(ctx: RequestContext, id: string): Promise<void>;
  upsertTeam(ctx: RequestContext, input: UpsertTeamInput): Promise<Team>;
  /** @throws DomainError TEAM_NOT_EMPTY */
  archiveTeam(ctx: RequestContext, id: string): Promise<void>;
  setTeamMembers(ctx: RequestContext, teamId: string, members: MemberRef[]): Promise<void>;
  /** Chỉ org_unit và team; manager của AI Employee đặt qua EmployeeEngine.update. */
  assignManager(ctx: RequestContext, target: ScopeRef, managerMemberId: string): Promise<void>;
  resolveManagedScope(ctx: RequestContext, memberId: string): Promise<ManagedScope>;
  /** Đơn vị và mọi tổ tiên của nó (gần nhất trước), để PermissionEngine áp policy theo cây đơn vị. */
  resolveOrgUnitChain(ctx: RequestContext, orgUnitId: string): Promise<string[]>;
  /** `target.kind = company` chỉ đúng khi member có phạm vi toàn công ty (CEO). */
  isInScope(ctx: RequestContext, memberId: string, target: ScopeRef): Promise<boolean>;
  /** Đơn vị chưa archived của công ty, hoặc `null` nếu không có/đã archived. EmployeeEngine dùng để kiểm tra `home_org_unit_id`. */
  getOrgUnit(ctx: RequestContext, id: string): Promise<OrgUnit | null>;
  /** Quan hệ thành viên-team của công ty (team chưa archived), để EmployeeEngine tính `teamIds` và lọc theo team. */
  listTeamMemberships(ctx: RequestContext): Promise<TeamMembershipRef[]>;
}

export interface EmployeeEngine {
  create(ctx: RequestContext, input: EmployeeProfileInput): Promise<EmployeeProfile>;
  update(
    ctx: RequestContext,
    id: string,
    patch: Partial<EmployeeProfileInput>,
  ): Promise<EmployeeProfile>;
  suspend(ctx: RequestContext, id: string): Promise<void>;
  resume(ctx: RequestContext, id: string): Promise<void>;
  /** @throws DomainError EMPLOYEE_HAS_OPEN_TASKS */
  archive(ctx: RequestContext, id: string): Promise<void>;
  get(ctx: RequestContext, id: string): Promise<EmployeeProfile>;
  list(ctx: RequestContext, filter: EmployeeFilter): Promise<EmployeeProfile[]>;
  /** Người thật cuối chuỗi quản lý (chịu trách nhiệm). */
  resolveAccountableHuman(ctx: RequestContext, employeeId: string): Promise<string>;
  getCapacity(ctx: RequestContext, employeeId: string): Promise<{ active: number; max: number }>;
  addHumanMember(
    ctx: RequestContext,
    input: { userId: string; role: HumanRole; title?: string },
  ): Promise<HumanMember>;
  listHumanMembers(ctx: RequestContext): Promise<HumanMember[]>;
  /** Không có ctx: chạy theo app.user_id, dùng cho TenantGuard và /auth/me. */
  findMemberships(userId: string): Promise<Membership[]>;
  /** @throws DomainError MANAGEMENT_CHAIN_INVALID */
  deactivateHumanMember(ctx: RequestContext, memberId: string): Promise<void>;
  /** Workspace được đăng ký của công ty (worker dùng để dựng thư mục làm việc của run). */
  getWorkspace(ctx: RequestContext, id: string): Promise<Workspace>;
  /** Thư mục gốc cho phép của workspace theo công ty (cài đặt của CEO, hoặc mặc định theo cấu hình). */
  getWorkspaceRoot(ctx: RequestContext): Promise<string>;
  /** Mẫu vai trò (dữ liệu seed toàn cục): `employee.create` của CEO AI Assistant lấy model, công cụ, prompt từ mẫu. */
  listRoleTemplates(): Promise<RoleTemplate[]>;
  /** CEO AI Assistant chưa lưu trữ của công ty (kể cả `suspended`), hoặc `null`. Chỉ CEO gọi được (FR-046). */
  getCeoAssistant(ctx: RequestContext): Promise<EmployeeProfile | null>;
  /**
   * Tạo AI Manager mặc định (mẫu `ai_manager`) cho team chưa có AI Manager và thêm vào team. Người thật quản lý
   * team (hoặc CEO) là manager trực tiếp. Một AI Manager có thể thuộc nhiều team nên chỉ gọi khi team chưa có.
   */
  provisionTeamManager(
    ctx: RequestContext,
    input: { teamId: string; teamName: string; orgUnitId: string; humanManagerId: string | null },
  ): Promise<EmployeeProfile>;
}

export interface TaskEngine {
  /** @throws DomainError TASK_FIELDS_REQUIRED, ASSIGNEE_OUT_OF_SCOPE, DEPENDENCY_CYCLE */
  create(ctx: RequestContext, input: TaskInput): Promise<Task>;
  /**
   * Chỉ task `draft` (FR-047): sửa title, objective, deadline, priority, acceptanceCriteria, expectedOutput, tokenCap,
   * costCap. `ctx.actor` là người dùng thì bị chặn khi `proposal_status = pending`; run `propose` của trợ lý được phép.
   * `meta.proposalStatus` chỉ nhận từ `ctx.actor.kind = ai|system` (Orchestration Engine ghi kết quả run `propose`):
   * `ready` đi kèm đề xuất, `failed` cho phép `patch` rỗng. Phát `task.proposal_applied { taskId, status }`.
   * @throws DomainError TASK_NOT_DRAFT, PROPOSAL_PENDING, TASK_FIELDS_REQUIRED
   */
  updateDraft(
    ctx: RequestContext,
    taskId: string,
    patch: TaskDraftPatch | Record<string, never>,
    meta?: { proposalStatus: 'ready' | 'failed' },
  ): Promise<Task>;
  /**
   * Máy trạng thái FR-020a duy nhất. `meta.blockedReason` bắt buộc khi `block`.
   * @throws DomainError TASK_INVALID_TRANSITION, SUBTASK_CANCELLED, EMPLOYEE_SUSPENDED
   */
  transition(
    ctx: RequestContext,
    taskId: string,
    action: TaskAction,
    meta?: { reason?: string; blockedReason?: string; resumeTo?: TaskStatus },
  ): Promise<Task>;
  attachArtifact(ctx: RequestContext, taskId: string, artifact: ArtifactInput): Promise<Artifact>;
  /** Nội dung artifact (tối đa `maxBytes` byte đầu); `truncated` cho biết có bị cắt không. Không kiểm tra phạm vi người dùng. */
  readArtifact(
    ctx: RequestContext,
    artifactId: string,
    maxBytes: number,
  ): Promise<{ content: Buffer; truncated: boolean }>;
  /** @throws DomainError REVIEWER_NOT_INDEPENDENT */
  recordEvidence(ctx: RequestContext, taskId: string, evidence: EvidenceInput[]): Promise<void>;
  /**
   * Người thật: `approve|reject|rework` ở `awaiting_human_approval`. AI Manager: `pass|rework` ở `in_review`.
   * @throws DomainError EVIDENCE_INCOMPLETE
   */
  recordDecision(ctx: RequestContext, taskId: string, d: TaskDecisionInput): Promise<Task>;
  /** @throws DomainError DEPENDENCY_CYCLE, NO_SUITABLE_ASSIGNEE */
  applyDecomposition(
    ctx: RequestContext,
    parentTaskId: string,
    plan: DecompositionPlan,
  ): Promise<Task[]>;
  /** Sweeper: đặt is_overdue, trả các task vừa quá hạn. */
  markOverdue(ctx: RequestContext, now: Date): Promise<Task[]>;
  get(ctx: RequestContext, id: string): Promise<TaskDetail>;
  list(ctx: RequestContext, filter: TaskFilter): Promise<Page<Task>>;
  getStats(
    ctx: RequestContext,
    filter: {
      employeeId?: string;
      orgUnitId?: string;
      /** Chỉ đếm task có assignee trong phạm vi quản lý này (Dashboard của Manager). Không đặt = không lọc. */
      scope?: ManagedScope;
    },
  ): Promise<TaskStats>;
  /** Sweeper: chỉ trả company_id. */
  listCompaniesWithOpenTasks(): Promise<string[]>;
}

export interface OrchestrationEngine {
  /**
   * Chọn nhân viên theo `purpose` (execute: assignee; decompose: AI Manager theo FR-016a/FR-018; review: reviewer
   * độc lập theo D5; synthesize: AI Manager đã phân rã), tạo `agent_run` và đưa job vào hàng đợi.
   * Không chọn được → task `blocked` (`NO_AI_MANAGER` / `NO_INDEPENDENT_REVIEWER`) rồi ném lỗi cùng mã.
   * Đã có run chưa kết thúc cùng task + purpose thì trả lại run đó (khử trùng khi sự kiện giao lại).
   */
  enqueueRun(
    ctx: RequestContext,
    taskId: string,
    purpose: 'execute' | 'decompose' | 'review' | 'synthesize' | 'propose',
  ): Promise<AgentRunRef>;
  /** Tạo lần thử kế tiếp (retry) của một run đã lỗi tạm thời, sau `delayMs`. */
  enqueueRetry(ctx: RequestContext, runId: string, delayMs: number): Promise<AgentRunRef>;
  /**
   * Sau `approval.decided`: duyệt → xếp job `action.execute-approved`; từ chối → ghi `denied` rồi xếp `run.resume`
   * kèm lý do. Idempotent (jobId ổn định) vì sự kiện được giao ít nhất một lần. `replay` (sweeper) dùng jobId theo
   * khung thời gian để phát lại job đã mất (Redis mất dữ liệu) mà không bị BullMQ khử trùng với job cũ.
   */
  resumeAfterApproval(
    ctx: RequestContext,
    approvalRequestId: string,
    options?: { replay?: boolean },
  ): Promise<void>;
  cancelRunsForTask(ctx: RequestContext, taskId: string): Promise<void>;
  getRun(ctx: RequestContext, runId: string): Promise<AgentRunDetail>;
  listRuns(ctx: RequestContext, filter: RunListFilter): Promise<Page<AgentRunSummary>>;
  listExecutedActions(ctx: RequestContext, taskId: string): Promise<ExecutedAction[]>;
  /**
   * Thao tác điều hành của CEO AI Assistant trên task (ghép `tool_invocation`, `approval_request`, `run_step` của các run
   * do `ceo_assistant` chạy); task khác trả `[]`.
   */
  listOperations(ctx: RequestContext, taskId: string): Promise<TaskOperation[]>;
  /**
   * Kết quả job `task.propose` (US9): kiểm tra `TaskProposal` (≥ 1 tiêu chí, deadline trong tương lai, priority hợp lệ)
   * rồi ghi đè task `draft` qua `TaskEngine.updateDraft` và đặt `proposal_status = ready`; sai hoặc hết retry → `failed`.
   * Không đổi trạng thái task.
   */
  applyTaskProposal(
    ctx: RequestContext,
    taskId: string,
    proposal: TaskProposal | { failed: true; reason: string },
  ): Promise<void>;
  recoverStaleRuns(): Promise<RecoveryReport>;
  /**
   * Kết quả job `task.decompose`: áp kế hoạch qua TaskEngine; kế hoạch sai (`DEPENDENCY_CYCLE`,
   * `NO_SUITABLE_ASSIGNEE`) → task `blocked`. `ctx.actor` là AI Manager của run.
   */
  applyDecompositionPlan(ctx: RequestContext, taskId: string, plan: DecompositionPlan): Promise<void>;
  /** Kết quả job `review.run`: ghi bằng chứng rồi quyết định `pass`/`rework`. `ctx.actor` là reviewer. */
  applyReviewResult(ctx: RequestContext, taskId: string, result: ReviewResult): Promise<void>;
  // Worker ghi bản ghi run chỉ qua các phương thức dưới đây, không truy cập bảng trực tiếp (Nguyên tắc VI)
  updateRunStatus(ctx: RequestContext, runId: string, patch: AgentRunStatusPatch): Promise<void>;
  /** Cập nhật `heartbeat_at` và trả trạng thái hiện tại để run-loop biết khi run bị hủy. */
  heartbeat(ctx: RequestContext, runId: string): Promise<RunStatus>;
  appendRunStep(ctx: RequestContext, runId: string, step: RunStepInput): Promise<RunStepRef>;
  /** Phát sự kiện run/tiến độ/usage thành `domain_event` (nguồn duy nhất cho realtime). */
  publishRunEvent(ctx: RequestContext, runId: string, event: RunEventInput): Promise<void>;
  recordToolInvocation(ctx: RequestContext, inv: ToolInvocationInput): Promise<ToolInvocationRef>;
  updateToolInvocation(ctx: RequestContext, id: string, patch: ToolInvocationPatch): Promise<void>;
  findToolInvocationByKey(
    ctx: RequestContext,
    idempotencyKey: string,
  ): Promise<ToolInvocationRef | null>;
  /**
   * Chiếm quyền thực thi một hành động đã duyệt: chuyển `pending_approval` → `executing` trong một câu lệnh có điều kiện.
   * Chỉ một người gọi nhận `true`, nên duyệt hai lần hoặc job chạy hai lần vẫn chỉ thực thi một lần.
   */
  claimToolInvocation(ctx: RequestContext, id: string): Promise<boolean>;
  saveConversationState(ctx: RequestContext, runId: string, messages: unknown): Promise<void>;
  loadConversationState(ctx: RequestContext, runId: string): Promise<unknown | null>;
}

export type PermissionLevel = 'auto_execute' | 'review_required' | 'human_approval' | 'restricted';

export interface PermissionEngine {
  /** Quyết định thuần; KHÔNG nhận nội dung prompt/task làm đầu vào. */
  evaluate(
    ctx: RequestContext,
    req: { employeeId: string; actionType: string; input: unknown },
  ): Promise<{ level: PermissionLevel; reason: string }>;
  createApprovalRequest(
    ctx: RequestContext,
    inv: ToolInvocationRef,
    summary: string,
    rationale: string,
  ): Promise<ApprovalRequest>;
  /** @throws DomainError FORBIDDEN, APPROVAL_NOT_PENDING, APPROVAL_PAYLOAD_CHANGED, VALIDATION_FAILED */
  decideApproval(
    ctx: RequestContext,
    id: string,
    d: { decision: 'approve' | 'reject'; reason: string; payloadHash: string },
  ): Promise<ApprovalRequest>;
  /** Một yêu cầu phê duyệt kèm tên task và nhân viên. @throws DomainError NOT_FOUND */
  getApproval(ctx: RequestContext, id: string): Promise<ApprovalRequest>;
  /** Mới nhất trước. Người gọi truyền `employeeIds` theo `ManagedScope` của người xem. */
  listApprovals(ctx: RequestContext, filter: ApprovalFilter): Promise<Page<ApprovalRequest>>;
  /** Sweeper: nhắc người duyệt, không bao giờ tự duyệt. */
  remindPendingApprovals(ctx: RequestContext, now: Date): Promise<number>;
  listCompaniesWithPendingApprovals(): Promise<string[]>;
  /** @throws DomainError FORBIDDEN */
  authorize(ctx: RequestContext, permission: AppPermission, target: ScopeRef): Promise<void>;
}

export interface BudgetService {
  reserve(
    ctx: RequestContext,
    req: {
      runId: string;
      taskId: string;
      employeeId: string;
      modelId: string;
      estTokens: number;
      estCostUsd: number;
    },
  ): Promise<
    | { ok: true; reservationId: string; remainingUsd: number; remainingTokens: number }
    | { ok: false; limitHit: LimitRef }
  >;
  commit(
    ctx: RequestContext,
    reservationId: string,
    actual: UsageRecordInput,
  ): Promise<{ warnings: LimitRef[]; overage: boolean }>;
  release(ctx: RequestContext, reservationId: string): Promise<void>;
  /** Giải phóng mọi phần đang giữ của một run (run chết, bị hủy). */
  releaseRun(ctx: RequestContext, runId: string): Promise<void>;
  isModelAllowed(ctx: RequestContext, employeeId: string, modelId: string): Promise<boolean>;
  /**
   * Model được phép sau khi giao các `allowed_models` của mọi scope áp dụng cho nhân viên (có thể chưa tồn tại: lúc tạo
   * hoặc đổi đơn vị). `null` = không scope nào hạn chế. `employeeId` bỏ trống khi nhân viên chưa được tạo.
   */
  allowedModelsFor(
    ctx: RequestContext,
    target: { homeOrgUnitId: string | null; teamIds?: string[]; employeeId?: string },
  ): Promise<string[] | null>;
  /** Giới hạn `max_concurrent_tasks` của scope company, org_unit (cả tổ tiên), team áp dụng cho nhân viên. */
  getConcurrencyLimits(ctx: RequestContext, employeeId: string): Promise<ConcurrencyLimit[]>;
  /** Chính sách ngân sách của một phạm vi (công ty chưa có bản ghi thì trả hạn mức mặc định đang áp dụng). */
  getPolicy(ctx: RequestContext, scopeKind: BudgetScopeKind, scopeId: string): Promise<BudgetPolicy>;
  getUsage(
    ctx: RequestContext,
    filter: {
      employeeId?: string;
      taskId?: string;
      /** Một lần chạy cụ thể; cộng dồn mọi kỳ như `taskId`. */
      runId?: string;
      orgUnitId?: string;
      period?: string;
      groupBy?: 'employee' | 'task' | 'org_unit';
      /** Chỉ cộng dữ liệu thuộc phạm vi quản lý này. Không đặt = không lọc (engine gọi engine). */
      scope?: ManagedScope;
    },
  ): Promise<UsageSummary>;
}

export interface ModelCatalog {
  listModels(): Promise<ModelInfo[]>;
  /** Nơi duy nhất engine khác dùng để hỏi về `model_price`. */
  hasModel(modelId: string): Promise<boolean>;
}

export interface IdentityDirectory {
  findUserByEmail(email: string): Promise<{ id: string; displayName: string } | null>;
  /** Nơi duy nhất engine khác dùng để hỏi về bảng `user`. */
  getUsers(ids: string[]): Promise<Array<{ id: string; displayName: string; email: string }>>;
}

export interface OfficeSimulationEngine {
  /**
   * Reducer thuần, tất định: cùng (`event`, `previous`) luôn cho cùng kết quả, không đọc DB hay đồng hồ.
   * `previous` bỏ trống nghĩa là nhân viên chưa có trạng thái (`idle`). Trả `null` nếu sự kiện không đổi
   * trạng thái hiển thị của nhân viên nào (kể cả sự kiện giao lại có `seq` đã áp).
   */
  apply(event: DomainEvent, previous?: OfficeEmployeeState): EmployeeStatusChange | null;
  /** Chỉ gồm nhân viên trong phạm vi quản lý của người xem; `seq` là mốc đã chiếu xong. */
  getSnapshot(ctx: RequestContext): Promise<OfficeSnapshot>;
  /** Dữ liệu Employee Profile (FR-038); `NOT_FOUND` nếu nhân viên không tồn tại. */
  getProfileView(ctx: RequestContext, employeeId: string): Promise<EmployeeProfileView>;
  /**
   * Job trễ 60 giây (T156): nếu nhân viên vẫn giữ đúng lần `completed` có `sinceSeq` thì ghi `domain_event`
   * `office.completed_display_elapsed` để đưa về `idle`. Trả `false` nếu không còn gì để làm (idempotent).
   */
  completeDisplayElapsed(
    ctx: RequestContext,
    input: { employeeId: string; taskId: string; sinceSeq: number },
  ): Promise<boolean>;
}

export interface CommunicationEngine {
  postTaskMessage(ctx: RequestContext, taskId: string, body: string): Promise<TaskMessage>;
  listTaskMessages(ctx: RequestContext, taskId: string): Promise<TaskMessage[]>;
  /** Lưu `notification` và phát `notification.created` tới `user:{memberId}`. */
  notify(ctx: RequestContext, recipientMemberId: string, n: NotificationInput): Promise<Notification>;
  /** Chọn người nhận theo FR-041 (người giao, người duyệt, manager phạm vi; mặc định CEO) rồi `notify`. */
  notifyRouted(ctx: RequestContext, n: RoutedNotification): Promise<Notification>;
  listNotifications(
    ctx: RequestContext,
    memberId: string,
    filter: { unread?: boolean; cursor?: string; limit?: number },
  ): Promise<Page<Notification>>;
  markRead(ctx: RequestContext, memberId: string, notificationId: string): Promise<void>;
  markAllRead(ctx: RequestContext, memberId: string): Promise<number>;
}

export interface MemoryEngine {
  recall(
    ctx: RequestContext,
    scope: { employeeId: string; taskId: string },
    limit: number,
  ): Promise<MemoryEntry[]>;
  remember(ctx: RequestContext, entry: MemoryEntryInput): Promise<void>;
}

export interface GamificationEngine {
  /**
   * Chỉ milestone first_employee / first_department / first_approved_task. Idempotent: sự kiện giao lại hoặc phát lại
   * không tạo bản ghi thứ hai; mỗi cột mốc mới phát đúng một `milestone.achieved`.
   */
  onDomainEvent(event: DomainEvent): Promise<void>;
  /** Cột mốc đã đạt của công ty, cũ nhất trước. */
  list(ctx: RequestContext): Promise<Milestone[]>;
}

/**
 * Ngữ cảnh một lần thực thi/tra cứu hành động đã duyệt. Adapter ra bên ngoài bỏ qua; `InternalOpsAdapter` cần để dựng
 * ngữ cảnh của người duyệt kèm `via` và để tra trạng thái đối tượng khi recovery.
 */
export type AdapterContext = {
  companyId: string;
  traceId: string;
  actionType: string;
  /** Người duyệt (`approval_request.decided_by`): ngữ cảnh thực thi của adapter nội bộ. */
  approverMemberId?: string;
  employeeId?: string;
  runId?: string;
  taskId?: string;
};

export interface ToolAdapter {
  actionTypes: string[];
  /** `internal`: InternalOpsAdapter cho org.archive, employee.archive, task.cancel (dữ liệu của chính ứng dụng). */
  mode: 'dry_run' | 'live' | 'internal';
  execute(input: unknown, idempotencyKey: string, context?: AdapterContext): Promise<ToolResult>;
  /**
   * Dùng bởi recovery: trạng thái của lần thực thi với key này. `context.input` là payload đã ghi ledger để adapter
   * nội bộ đối chiếu trạng thái đối tượng.
   */
  lookup(
    idempotencyKey: string,
    context?: AdapterContext & { input?: unknown },
  ): Promise<'succeeded' | 'failed' | 'not_found' | 'unknown'>;
}
