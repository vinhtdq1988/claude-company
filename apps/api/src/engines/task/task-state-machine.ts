import {
  DomainError,
  TASK_ACTIONS,
  TASK_STATUSES,
  TERMINAL_TASK_STATUSES,
  type TaskAction,
  type TaskStatus,
} from '@claude-company/contracts';

export type TaskState = { status: TaskStatus; blockedFrom: TaskStatus | null };

export type TransitionOptions = {
  /**
   * Chỉ dùng với `block`: trạng thái `resume` sẽ quay về. Mặc định là trạng thái hiện tại.
   * D1 và ngưỡng rework: `reject` / `MAX_REWORK_REACHED` đi từ trạng thái review nhưng `resume` quay về `in_progress`.
   */
  resumeTo?: TaskStatus;
};

/** Trạng thái được phép `block` và là đích hợp lệ của `blocked_from`. */
const BLOCKABLE: readonly TaskStatus[] = [
  'draft',
  'assigned',
  'in_progress',
  'in_review',
  'awaiting_human_approval',
];

/** Cạnh cố định (không phụ thuộc `blocked_from`). Nguồn: FR-020a + D1, data-model "Vòng đời". */
const EDGES: Readonly<Partial<Record<TaskAction, Partial<Record<TaskStatus, TaskStatus>>>>> = {
  assign: { draft: 'assigned' },
  start: { assigned: 'in_progress' },
  submit: { in_progress: 'in_review' },
  pass: { in_review: 'awaiting_human_approval' },
  approve: { awaiting_human_approval: 'completed' },
  rework: { in_review: 'in_progress', awaiting_human_approval: 'in_progress' },
};

/**
 * Máy trạng thái FR-020a + D1 thuần và tất định: trả trạng thái mới hoặc `null` nếu cạnh không hợp lệ.
 * `reject` của Human Manager không có cạnh riêng mà đi qua `block` (D1).
 */
export function applyTransition(
  state: TaskState,
  action: TaskAction,
  options: TransitionOptions = {},
): TaskState | null {
  const { status, blockedFrom } = state;

  if (action === 'cancel') {
    return TERMINAL_TASK_STATUSES.includes(status) ? null : { status: 'cancelled', blockedFrom: null };
  }
  if (action === 'block') {
    if (!BLOCKABLE.includes(status)) return null;
    const resumeTo = options.resumeTo ?? status;
    if (!BLOCKABLE.includes(resumeTo)) return null;
    return { status: 'blocked', blockedFrom: resumeTo };
  }
  if (action === 'resume') {
    if (status !== 'blocked' || blockedFrom === null) return null;
    return { status: blockedFrom, blockedFrom: null };
  }

  const to = EDGES[action]?.[status];
  return to ? { status: to, blockedFrom: null } : null;
}

export function canTransition(status: TaskStatus, action: TaskAction): boolean {
  // `resume` hợp lệ khi có `blocked_from`; với mục đích liệt kê cạnh coi mọi `blocked` là có.
  const probe: TaskState = { status, blockedFrom: status === 'blocked' ? 'in_progress' : null };
  return applyTransition(probe, action) !== null;
}

/** Toàn bộ cặp (trạng thái, action) hợp lệ, dùng cho unit test và tài liệu. */
export function listValidEdges(): Array<{ from: TaskStatus; action: TaskAction }> {
  return TASK_STATUSES.flatMap((from) =>
    TASK_ACTIONS.filter((action) => canTransition(from, action)).map((action) => ({
      from,
      action,
    })),
  );
}

/** Ném `TASK_INVALID_TRANSITION` (409) nếu cạnh không hợp lệ. */
export function transitionOrThrow(
  state: TaskState,
  action: TaskAction,
  options: TransitionOptions = {},
): TaskState {
  const next = applyTransition(state, action, options);
  if (!next) {
    throw new DomainError(
      'TASK_INVALID_TRANSITION',
      `Không thể "${action}" task đang ở trạng thái "${state.status}"`,
      { from: state.status, action },
    );
  }
  return next;
}
