import type {
  AssigneeKind,
  CreateTaskBody,
  Task,
  TaskDetail,
  TaskPriority,
  TaskStatus,
} from '@claude-company/contracts';

/** Cột của Task Board theo thứ tự luồng; `cancelled` nằm cuối và mặc định ẩn bớt. */
export const BOARD_COLUMNS: readonly TaskStatus[] = [
  'draft',
  'assigned',
  'in_progress',
  'in_review',
  'awaiting_human_approval',
  'blocked',
  'completed',
  'cancelled',
];

export const PRIORITIES: readonly TaskPriority[] = ['urgent', 'high', 'medium', 'low'];

/** Tiến độ gần đúng theo trạng thái khi chưa có sự kiện `task.progress` từ run (0–100). */
const STATUS_PROGRESS: Record<TaskStatus, number> = {
  draft: 0,
  assigned: 10,
  in_progress: 40,
  in_review: 80,
  awaiting_human_approval: 90,
  blocked: 0,
  completed: 100,
  cancelled: 0,
};

/**
 * Tiến độ hiển thị: `live` (từ `task.progress`) ưu tiên khi task đang chạy, ngược lại suy ra từ trạng thái.
 * Task bị chặn giữ tiến độ của trạng thái trước khi chặn (`blockedFrom`).
 */
export function progressOf(task: Pick<Task, 'status' | 'blockedFrom'>, live?: number): number {
  const base =
    task.status === 'blocked' && task.blockedFrom
      ? STATUS_PROGRESS[task.blockedFrom]
      : STATUS_PROGRESS[task.status];
  if (task.status === 'in_progress' && live !== undefined)
    return Math.min(100, Math.max(0, Math.round(live)));
  return base;
}

/** Nhóm task theo cột, giữ thứ tự đầu vào; cột `cancelled` chỉ có khi `showCancelled`. */
export function groupByStatus(
  tasks: readonly Task[],
  showCancelled = false,
): Array<[TaskStatus, Task[]]> {
  return BOARD_COLUMNS.filter((s) => showCancelled || s !== 'cancelled').map((status) => [
    status,
    tasks.filter((task) => task.status === status),
  ]);
}

/** Hành động người dùng được phép với task ở trạng thái này (khớp `POST /tasks/{id}/transitions`). */
export function allowedActions(task: Pick<Task, 'status'>): Array<'assign' | 'cancel' | 'resume'> {
  const actions: Array<'assign' | 'cancel' | 'resume'> = [];
  if (task.status === 'draft') actions.push('assign');
  if (task.status === 'blocked') actions.push('resume');
  if (task.status !== 'completed' && task.status !== 'cancelled') actions.push('cancel');
  return actions;
}

/** Quyết định của Human Manager chỉ có ở `awaiting_human_approval`. */
export const canDecide = (task: Pick<Task, 'status'>): boolean =>
  task.status === 'awaiting_human_approval';

/** `resume` task cha có task con bị hủy bị chặn (`SUBTASK_CANCELLED`): chỉ còn hủy task cha. */
export const canResume = (task: Pick<Task, 'status' | 'blockedReason'>): boolean =>
  task.status === 'blocked' && task.blockedReason !== 'SUBTASK_CANCELLED';

export type CriterionCheck = {
  criterionId: string;
  text: string;
  verdict: 'met' | 'not_met' | 'none';
  explanation: string;
};

/**
 * Đối chiếu từng acceptance criterion với bằng chứng MỚI NHẤT của nó (FR-019): thiếu bằng chứng → `none`.
 * Bằng chứng xếp theo `createdAt`; cái sau cùng thắng.
 */
export function checkCriteria(
  task: Pick<TaskDetail, 'acceptanceCriteria' | 'evidence'>,
): CriterionCheck[] {
  return task.acceptanceCriteria.map((criterion) => {
    const latest = [...task.evidence]
      .filter((e) => e.criterionId === criterion.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .at(-1);
    return {
      criterionId: criterion.id,
      text: criterion.text,
      verdict: latest?.verdict ?? 'none',
      explanation: latest?.explanation ?? '',
    };
  });
}

export type TraceStep = {
  kind: 'created' | 'decomposed' | 'artifact' | 'evidence' | 'review';
  at: string;
  label: string;
};

/**
 * Chuỗi truy vết SC-014 của một task: tạo → phân rã → artifact → bằng chứng → review/quyết định, theo thời gian.
 * `label` là dữ liệu gốc (tiêu đề artifact, lý do), phần giao diện tự gắn tên loại bước.
 */
export function buildTrace(task: TaskDetail): TraceStep[] {
  const steps: TraceStep[] = [{ kind: 'created', at: task.createdAt, label: task.title }];
  if (task.decompositionPlan && task.decomposedByEmployeeId) {
    steps.push({
      kind: 'decomposed',
      // Kế hoạch không có mốc thời gian riêng: đặt ngay sau lúc tạo để thứ tự ổn định.
      at: task.createdAt,
      label: task.decompositionPlan.mode,
    });
  }
  for (const a of task.artifacts) steps.push({ kind: 'artifact', at: a.createdAt, label: a.title });
  for (const e of task.evidence) {
    steps.push({ kind: 'evidence', at: e.createdAt, label: `${e.criterionId}: ${e.verdict}` });
  }
  for (const r of task.reviews) {
    steps.push({ kind: 'review', at: r.decidedAt, label: `${r.stage}/${r.decision}: ${r.reason}` });
  }
  return steps.sort((a, b) => a.at.localeCompare(b.at));
}

export type TaskFormState = {
  title: string;
  objective: string;
  assigneeKind: AssigneeKind;
  assigneeId: string;
  /** Giá trị của `<input type="datetime-local">` (giờ địa phương), rỗng nếu chưa chọn. */
  deadline: string;
  priority: TaskPriority;
  /** Mỗi dòng là một tiêu chí. */
  acceptanceCriteria: string;
  expectedOutput: string;
  tokenCap: string;
  costCap: string;
};

export const emptyTaskForm = (): TaskFormState => ({
  title: '',
  objective: '',
  assigneeKind: 'ai_employee',
  assigneeId: '',
  deadline: '',
  priority: 'medium',
  acceptanceCriteria: '',
  expectedOutput: '',
  tokenCap: '',
  costCap: '',
});

export type TaskFormField = keyof TaskFormState;

const positive = (value: string): number | null | 'invalid' => {
  if (value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 'invalid';
};

/**
 * Kiểm tra đầu vào theo FR-014 trước khi gọi API (server vẫn kiểm tra lại). Trả về các trường lỗi;
 * rỗng nghĩa là hợp lệ. `tokenCap` phải là số nguyên dương, `costCap` là số dương.
 */
export function validateTaskForm(form: TaskFormState): TaskFormField[] {
  const invalid: TaskFormField[] = [];
  if (!form.title.trim()) invalid.push('title');
  if (!form.objective.trim()) invalid.push('objective');
  if (!form.assigneeId) invalid.push('assigneeId');
  if (!form.deadline || Number.isNaN(new Date(form.deadline).getTime())) invalid.push('deadline');
  if (parseCriteria(form.acceptanceCriteria).length === 0) invalid.push('acceptanceCriteria');
  if (!form.expectedOutput.trim()) invalid.push('expectedOutput');
  const tokenCap = positive(form.tokenCap);
  if (tokenCap === 'invalid' || (typeof tokenCap === 'number' && !Number.isInteger(tokenCap)))
    invalid.push('tokenCap');
  if (positive(form.costCap) === 'invalid') invalid.push('costCap');
  return invalid;
}

export const parseCriteria = (text: string): string[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

/** Dựng body `POST /tasks` từ biểu mẫu đã hợp lệ; `deadline` đổi sang ISO UTC. */
export function toCreateBody(form: TaskFormState): CreateTaskBody {
  const tokenCap = positive(form.tokenCap);
  const costCap = positive(form.costCap);
  return {
    title: form.title.trim(),
    objective: form.objective.trim(),
    assignee: { kind: form.assigneeKind, id: form.assigneeId },
    deadline: new Date(form.deadline).toISOString(),
    priority: form.priority,
    acceptanceCriteria: parseCriteria(form.acceptanceCriteria),
    expectedOutput: form.expectedOutput.trim(),
    ...(typeof tokenCap === 'number' ? { tokenCap } : {}),
    ...(typeof costCap === 'number' ? { costCap } : {}),
  };
}

/** Khóa i18n cho `blocked_reason`; mã lạ rơi về khóa chung để không hiển thị mã thô. */
export const BLOCKED_REASONS = [
  'HUMAN_REJECTED',
  'MAX_REWORK_REACHED',
  'NO_AI_MANAGER',
  'NO_INDEPENDENT_REVIEWER',
  'NO_SUITABLE_ASSIGNEE',
  'DEPENDENCY_CYCLE',
  'SUBTASK_CANCELLED',
  'EMPLOYEE_SUSPENDED',
  'MODEL_NOT_ALLOWED',
  'BUDGET_EXCEEDED',
  'RUN_INTERRUPTED',
  'TOOL_OUTCOME_UNKNOWN',
] as const;
export type BlockedReason = (typeof BLOCKED_REASONS)[number];

export const isKnownBlockedReason = (reason: string): reason is BlockedReason =>
  (BLOCKED_REASONS as readonly string[]).includes(reason);
