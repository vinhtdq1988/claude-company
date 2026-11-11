import { z } from 'zod';
import { uuidSchema, type ManagedScope } from './common';

export const TASK_STATUSES = [
  'draft',
  'assigned',
  'in_progress',
  'in_review',
  'awaiting_human_approval',
  'completed',
  'blocked',
  'cancelled',
] as const;
export const taskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

/** Trạng thái kết thúc: không có cạnh đi ra. */
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ['completed', 'cancelled'];

/** Trạng thái "task mở": chặn archive đơn vị/nhân viên (US1-AS4, US2-AS4). */
export const OPEN_TASK_STATUSES: readonly TaskStatus[] = [
  'draft',
  'assigned',
  'in_progress',
  'in_review',
  'awaiting_human_approval',
  'blocked',
];

/**
 * Cạnh của máy trạng thái FR-020a + D1. `reject` của Human Manager không có cạnh riêng:
 * ghi `review_record` rồi đi cạnh `block` với `blocked_reason = HUMAN_REJECTED`.
 */
export const TASK_ACTIONS = [
  'assign',
  'start',
  'submit',
  'pass',
  'approve',
  'rework',
  'block',
  'resume',
  'cancel',
] as const;
export const taskActionSchema = z.enum(TASK_ACTIONS);
export type TaskAction = z.infer<typeof taskActionSchema>;

/** Hành động người dùng được gọi trực tiếp qua REST `/transitions`. */
export const userTransitionActionSchema = z.enum(['assign', 'cancel', 'resume']);

export const taskPrioritySchema = z.enum(['low', 'medium', 'high', 'urgent']);
export type TaskPriority = z.infer<typeof taskPrioritySchema>;
/** Thứ tự ưu tiên khi xếp hàng chờ slot: số lớn hơn chạy trước. */
export const PRIORITY_RANK: Record<TaskPriority, number> = { low: 0, medium: 1, high: 2, urgent: 3 };

export const assigneeKindSchema = z.enum(['ai_employee', 'team', 'org_unit']);
export type AssigneeKind = z.infer<typeof assigneeKindSchema>;
export const assigneeRefSchema = z.object({ kind: assigneeKindSchema, id: uuidSchema });
export type AssigneeRef = z.infer<typeof assigneeRefSchema>;

export type AcceptanceCriterion = { id: string; text: string };

/** Trạng thái đề xuất của task yêu cầu gửi CEO AI Assistant (FR-047); null với mọi task khác. */
export const PROPOSAL_STATUSES = ['pending', 'ready', 'failed'] as const;
export const proposalStatusSchema = z.enum(PROPOSAL_STATUSES);
export type ProposalStatus = z.infer<typeof proposalStatusSchema>;

export type Task = {
  id: string;
  parentTaskId: string | null;
  title: string;
  objective: string;
  createdByMemberId: string;
  assignedByAiEmployeeId: string | null;
  assigneeKind: AssigneeKind;
  assigneeId: string;
  deadline: string;
  priority: TaskPriority;
  acceptanceCriteria: AcceptanceCriterion[];
  expectedOutput: string;
  status: TaskStatus;
  blockedFrom: TaskStatus | null;
  blockedReason: string | null;
  isOverdue: boolean;
  reworkCount: number;
  reworkBaseline: number;
  tokenCap: number | null;
  costCap: number | null;
  completedAt: string | null;
  createdAt: string;
  /** `pending` chặn `assign` và `PATCH` của người dùng; chỉ task yêu cầu gửi CEO AI Assistant mới có. */
  proposalStatus: ProposalStatus | null;
  /** AI Employee đã tạo task thay người giao (CEO AI Assistant); có khi đọc chi tiết hoặc danh sách. */
  assignedByEmployee?: { id: string; name: string } | null;
};

export const TITLE_MAX = 200;

/** Body `POST /companies/{cid}/tasks` (FR-014). Tiêu chí nghiệm thu gửi dạng văn bản, hệ thống cấp `id`. */
export const createTaskSchema = z.object({
  title: z.string().trim().min(1).max(TITLE_MAX),
  objective: z.string().trim().min(1).max(20_000),
  assignee: assigneeRefSchema,
  deadline: z.iso.datetime({ offset: true }),
  priority: taskPrioritySchema,
  acceptanceCriteria: z.array(z.string().trim().min(1).max(2_000)).min(1).max(30),
  expectedOutput: z.string().trim().min(1).max(5_000),
  tokenCap: z.number().int().positive().optional(),
  costCap: z.number().positive().optional(),
  dependsOn: z.array(uuidSchema).max(50).optional(),
});
export type CreateTaskBody = z.infer<typeof createTaskSchema>;

/** Đầu vào engine: thêm các trường chỉ hệ thống đặt (task con do AI Manager tạo). */
export type TaskInput = CreateTaskBody & {
  parentTaskId?: string | null;
  assignedByAiEmployeeId?: string | null;
  /** Task con kế thừa người giao từ task cha; bỏ trống thì lấy từ `ctx.actor`. */
  createdByMemberId?: string;
  /** Chỉ hệ thống đặt (`POST /ceo-assistant/requests`): giá trị tạm đang chờ đề xuất của trợ lý. */
  proposalStatus?: 'pending';
};

/**
 * Body `PATCH /companies/{cid}/tasks/{id}` và đầu vào `TaskEngine.updateDraft`: chỉ task `draft` (FR-047).
 * Mọi trường tùy chọn; phải có ít nhất một.
 */
export const taskDraftPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(TITLE_MAX),
    objective: z.string().trim().min(1).max(20_000),
    deadline: z.iso.datetime({ offset: true }),
    priority: taskPrioritySchema,
    acceptanceCriteria: z.array(z.string().trim().min(1).max(2_000)).min(1).max(30),
    expectedOutput: z.string().trim().min(1).max(5_000),
    tokenCap: z.number().int().positive().nullable(),
    costCap: z.number().positive().nullable(),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Cần ít nhất một trường để cập nhật' });
export type TaskDraftPatch = z.infer<typeof taskDraftPatchSchema>;

/** Đề xuất của CEO AI Assistant cho task yêu cầu (structured output của run `propose`, FR-047). */
export const taskProposalSchema = z.object({
  title: z.string().trim().min(1).max(TITLE_MAX),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(2_000)).min(1).max(30),
  expectedOutput: z.string().trim().min(1).max(5_000),
  deadline: z.iso.datetime({ offset: true }),
  priority: taskPrioritySchema,
});
export type TaskProposal = z.infer<typeof taskProposalSchema>;

/** Một thao tác điều hành của CEO AI Assistant trên task, ghép từ ledger (`GET /tasks/{id}/operations`). */
export type TaskOperation = {
  toolInvocationId: string;
  actionType: string;
  permissionLevel: 'auto_execute' | 'review_required' | 'human_approval' | 'restricted';
  status: string;
  summary: string;
  targetKind?: string;
  targetId?: string;
  approvalRequestId?: string;
  adapterMode?: 'dry_run' | 'live' | 'internal';
  executedAt?: string;
};

export const taskTransitionSchema = z.object({
  action: userTransitionActionSchema,
  reason: z.string().trim().max(2_000).optional(),
});
export type TaskTransitionBody = z.infer<typeof taskTransitionSchema>;

/** `reason` bắt buộc với mọi quyết định (FR-019): thiếu → 422. */
export const taskDecisionSchema = z.object({
  decision: z.enum(['approve', 'reject', 'rework']),
  reason: z.string().trim().min(1).max(5_000),
});
export type TaskDecisionBody = z.infer<typeof taskDecisionSchema>;

export const taskMessageBodySchema = z.object({ body: z.string().trim().min(1).max(10_000) });

export const taskListQuerySchema = z.object({
  status: z.string().optional(),
  assigneeKind: assigneeKindSchema.optional(),
  assigneeId: uuidSchema.optional(),
  orgUnitId: uuidSchema.optional(),
  priority: taskPrioritySchema.optional(),
  overdue: z.enum(['true', 'false']).optional(),
  deadlineBefore: z.iso.datetime({ offset: true }).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export type TaskFilter = {
  statusIn?: TaskStatus[];
  assigneeKind?: AssigneeKind;
  assigneeId?: string;
  /** Task thuộc đơn vị: assignee là đơn vị, team hoặc nhân viên của đơn vị. */
  orgUnitId?: string;
  priority?: TaskPriority;
  overdue?: boolean;
  deadlineBefore?: string;
  /** Chỉ task gốc (Task Board, Dashboard). */
  rootOnly?: boolean;
  parentTaskId?: string;
  /** Chỉ trả task có assignee trong phạm vi quản lý này. Không đặt = không lọc (engine gọi engine). */
  scope?: ManagedScope;
  ids?: string[];
  /** Gắn `assignedByEmployee` (tên CEO AI Assistant) vào kết quả; chỉ route HTTP bật vì tốn thêm truy vấn. */
  withAssignerLabel?: boolean;
  /** `queue`: thứ tự chờ slot (priority giảm dần, deadline tăng dần). Mặc định: mới nhất trước. */
  order?: 'queue' | 'newest';
  cursor?: string;
  limit?: number;
};

export type TaskStats = {
  completedTasks: number;
  onTimeRate: number;
  reworkRate: number;
  activeTasks: number;
};

export const artifactKindSchema = z.enum(['document', 'code_diff', 'test_report', 'file']);
export type ArtifactKind = z.infer<typeof artifactKindSchema>;

export type Artifact = {
  id: string;
  taskId: string;
  agentRunId: string | null;
  createdByEmployeeId: string | null;
  kind: ArtifactKind;
  title: string;
  mimeType: string;
  sizeBytes: number;
  checksumSha256: string;
  createdAt: string;
};

/** Nội dung artifact do tool `artifact.publish` hoặc run nộp; Task Engine không tự lưu S3. */
export type ArtifactInput = {
  kind: ArtifactKind;
  title: string;
  mimeType: string;
  storageKey: string;
  sizeBytes: number;
  checksumSha256: string;
  agentRunId?: string;
};

export type Evidence = {
  id: string;
  taskId: string;
  criterionId: string;
  artifactId: string | null;
  reviewerKind: 'ai' | 'human';
  reviewerId: string;
  verdict: 'met' | 'not_met';
  explanation: string;
  createdAt: string;
};

export const evidenceInputSchema = z.object({
  criterionId: z.string().min(1),
  artifactId: uuidSchema.optional(),
  verdict: z.enum(['met', 'not_met']),
  explanation: z.string().trim().min(1).max(5_000),
});
export type EvidenceInput = z.infer<typeof evidenceInputSchema>;

export type ReviewRecord = {
  id: string;
  taskId: string;
  stage: 'ai_review' | 'human_approval';
  reviewerKind: 'ai' | 'human';
  reviewerId: string;
  decision: 'pass' | 'rework' | 'approve' | 'reject';
  reason: string;
  decidedAt: string;
};

/**
 * Quyết định ghi bởi `recordDecision`: người thật dùng `approve|reject|rework`, AI Manager dùng `pass|rework`.
 * Loại quyết định phải khớp `ctx.actor.kind`.
 */
export type TaskDecisionInput = {
  decision: 'approve' | 'reject' | 'rework' | 'pass';
  reason: string;
};

/**
 * Kế hoạch phân rã do AI Manager đề xuất (R10). `dependsOn` là chỉ số (0-based) của task con khác trong `subtasks`.
 * `confirm`: giữ nguyên phân công, không có task con.
 */
export const decompositionSubtaskSchema = z.object({
  title: z.string().trim().min(1).max(TITLE_MAX),
  objective: z.string().trim().min(1).max(20_000),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(2_000)).min(1).max(30),
  expectedOutput: z.string().trim().min(1).max(5_000),
  assigneeId: uuidSchema,
  dependsOn: z.array(z.number().int().min(0)).max(50),
});
export const decompositionPlanSchema = z.object({
  mode: z.enum(['confirm', 'decompose']),
  subtasks: z.array(decompositionSubtaskSchema).max(30),
});
export type DecompositionPlan = z.infer<typeof decompositionPlanSchema>;

/** Kết quả review do AI Manager trả (structured output của job `review.run`). */
export const reviewResultSchema = z.object({
  decision: z.enum(['pass', 'rework']),
  reason: z.string().trim().min(1).max(5_000),
  evidence: z.array(evidenceInputSchema).max(60),
});
export type ReviewResult = z.infer<typeof reviewResultSchema>;

export type TaskDetail = Task & {
  subtasks: Task[];
  dependsOn: string[];
  decompositionPlan: DecompositionPlan | null;
  /** AI Manager đã phân rã (hoặc xác nhận) task: chạy lại `synthesize` và chọn reviewer độc lập. */
  decomposedByEmployeeId: string | null;
  artifacts: Artifact[];
  evidence: Evidence[];
  reviews: ReviewRecord[];
};

export const NOTIFICATION_TYPES = [
  'task_completed',
  'task_error',
  'task_overdue',
  'approval_needed',
  'budget_warning',
  'budget_blocked',
  'overload_warning',
  'escalation',
] as const;
export const notificationTypeSchema = z.enum(NOTIFICATION_TYPES);
export type NotificationType = z.infer<typeof notificationTypeSchema>;

export type Notification = {
  id: string;
  recipientMemberId: string;
  type: NotificationType;
  taskId: string | null;
  approvalRequestId: string | null;
  title: string;
  body: string;
  readAt: string | null;
  createdAt: string;
};

export type TaskMessage = {
  id: string;
  taskId: string;
  authorKind: 'human' | 'ai';
  authorId: string;
  body: string;
  agentRunId: string | null;
  createdAt: string;
};
