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
  RunStatus,
  RunStepInput,
  RunStepRef,
  ToolInvocationInput,
  ToolInvocationPatch,
  ToolResult,
} from './run';
import type { ApprovalRequest, ToolInvocationRef } from './approval';
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
  Workspace,
} from './employee';
import type { LimitRef, UsageRecordInput, UsageSummary } from './budget';
import type {
  Company,
  OrgChart,
  OrgUnit,
  Team,
  TeamMembershipRef,
  UpsertOrgUnitInput,
  UpsertTeamInput,
} from './organization';
import type { EmployeeStatusChange, OfficeSnapshot } from './office';
import type { DomainEvent } from './realtime';
import type {
  Artifact,
  ArtifactInput,
  DecompositionPlan,
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
}

export interface TaskEngine {
  /** @throws DomainError TASK_FIELDS_REQUIRED, ASSIGNEE_OUT_OF_SCOPE, DEPENDENCY_CYCLE */
  create(ctx: RequestContext, input: TaskInput): Promise<Task>;
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
    filter: { employeeId?: string; orgUnitId?: string },
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
    purpose: 'execute' | 'decompose' | 'review' | 'synthesize',
  ): Promise<AgentRunRef>;
  /** Tạo lần thử kế tiếp (retry) của một run đã lỗi tạm thời, sau `delayMs`. */
  enqueueRetry(ctx: RequestContext, runId: string, delayMs: number): Promise<AgentRunRef>;
  resumeAfterApproval(ctx: RequestContext, approvalRequestId: string): Promise<void>;
  cancelRunsForTask(ctx: RequestContext, taskId: string): Promise<void>;
  getRun(ctx: RequestContext, runId: string): Promise<AgentRunDetail>;
  listRuns(
    ctx: RequestContext,
    filter: { taskId?: string; employeeId?: string },
  ): Promise<Page<AgentRunSummary>>;
  listExecutedActions(ctx: RequestContext, taskId: string): Promise<ExecutedAction[]>;
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
  decideApproval(
    ctx: RequestContext,
    id: string,
    d: { decision: 'approve' | 'reject'; reason: string; payloadHash: string },
  ): Promise<ApprovalRequest>;
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
  getUsage(
    ctx: RequestContext,
    filter: {
      employeeId?: string;
      taskId?: string;
      orgUnitId?: string;
      period?: string;
      groupBy?: 'employee' | 'task' | 'org_unit';
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
  /** Reducer thuần, tất định. */
  apply(event: DomainEvent): EmployeeStatusChange | null;
  getSnapshot(ctx: RequestContext): Promise<OfficeSnapshot>;
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
  /** Chỉ milestone first_employee / first_department / first_approved_task. */
  onDomainEvent(event: DomainEvent): Promise<void>;
}

export interface ToolAdapter {
  actionTypes: string[];
  mode: 'dry_run' | 'live';
  execute(input: unknown, idempotencyKey: string): Promise<ToolResult>;
  /** Dùng bởi recovery: trạng thái của lần thực thi với key này. */
  lookup(idempotencyKey: string): Promise<'succeeded' | 'failed' | 'not_found' | 'unknown'>;
}
