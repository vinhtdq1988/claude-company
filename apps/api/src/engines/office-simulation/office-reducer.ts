import type {
  DomainEvent,
  EmployeeState,
  EmployeeStatusChange,
  OfficeEmployeeState,
  OfficeTrack,
  OfficeTrackState,
} from '@claude-company/contracts';

/** Lý do `blocked` của task khi nhân viên bị tạm ngưng; hết tạm ngưng thì không còn lý do để báo lỗi. */
export const EMPLOYEE_SUSPENDED_REASON = 'EMPLOYEE_SUSPENDED';

/** Loại sự kiện báo hết thời gian hiển thị `completed` (server phát, có ghi `domain_event`). */
export const COMPLETED_ELAPSED_EVENT = 'office.completed_display_elapsed';

/** Thời gian giữ trạng thái `completed` trước khi về `idle` (realtime-events.md). */
export const COMPLETED_DISPLAY_MS = 60_000;

const ACTIVE_TRACK_STATES: readonly OfficeTrackState[] = ['working', 'thinking', 'communicating'];

/** Hạng ưu tiên khi nhân viên có nhiều task: `error_blocked` > `waiting_approval` > hoạt động > `completed`. */
const RANK: Record<OfficeTrackState, number> = {
  error_blocked: 4,
  waiting_approval: 3,
  working: 2,
  thinking: 2,
  communicating: 2,
  completed: 1,
};

type Payload = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

export function initialEmployeeState(employeeId: string): OfficeEmployeeState {
  return {
    employeeId,
    suspended: false,
    tracks: {},
    appliedSeq: 0,
    state: 'idle',
    currentTaskId: null,
    currentTool: null,
    progress: null,
    sourceSeq: 0,
  };
}

/** Nhân viên chính của sự kiện (người có trạng thái đổi trực tiếp), hoặc `null` nếu sự kiện không liên quan office. */
export function employeeOf(event: DomainEvent): string | null {
  const p = event.payload as Payload;
  switch (event.type) {
    case 'run.started':
    case 'run.resumed':
    case 'run.model_call_started':
    case 'run.tool_call_started':
    case 'run.succeeded':
    case 'run.failed':
    case 'run.timed_out':
    case 'run.cancelled':
    case 'approval.requested':
    case 'task.progress':
    case 'employee.suspended':
    case 'employee.resumed':
    case COMPLETED_ELAPSED_EVENT:
      return str(p.employeeId);
    case 'task.message_posted':
      return p.authorKind === 'ai' ? str(p.authorId) : null;
    case 'task.status_changed':
      return p.assigneeKind === 'ai_employee' ? str(p.assigneeId) : null;
    default:
      return null;
  }
}

/**
 * Sự kiện cấp task có thể làm đổi track của nhân viên khác (ví dụ reviewer đang `error_blocked` khi task rời `blocked`):
 * engine áp lại cho mọi nhân viên đang có track trên task đó.
 */
export function taskOfTaskLevelEvent(event: DomainEvent): string | null {
  return event.type === 'task.status_changed' ? str((event.payload as Payload).taskId) : null;
}

function setTrack(
  tracks: Record<string, OfficeTrack>,
  taskId: string,
  seq: number,
  patch: Partial<Omit<OfficeTrack, 'taskId' | 'seq'>>,
): void {
  const existing = tracks[taskId];
  tracks[taskId] = {
    taskId,
    runId: existing?.runId ?? null,
    state: existing?.state ?? 'working',
    tool: existing?.tool ?? null,
    progress: existing?.progress ?? null,
    reason: null,
    ...patch,
    seq,
  };
}

/** Áp sự kiện lên bản sao của trạng thái (đã kiểm tra sự kiện liên quan nhân viên này). */
function fold(event: DomainEvent, s: OfficeEmployeeState): void {
  const p = event.payload as Payload;
  const taskId = str(p.taskId);
  const track = taskId ? s.tracks[taskId] : undefined;
  const isActive = (t: OfficeTrack | undefined) => !t || ACTIVE_TRACK_STATES.includes(t.state);

  switch (event.type) {
    case 'run.started': {
      if (!taskId) return;
      const executing = p.purpose === 'execute';
      setTrack(s.tracks, taskId, event.seq, {
        runId: str(p.runId),
        state: executing ? 'working' : 'communicating',
        tool: null,
        progress: track?.progress ?? null,
        reason: null,
      });
      return;
    }
    case 'run.resumed':
      if (!taskId) return;
      setTrack(s.tracks, taskId, event.seq, {
        runId: str(p.runId) ?? track?.runId ?? null,
        state: 'working',
        tool: null,
        reason: null,
      });
      return;
    case 'run.model_call_started':
      // Không hồi sinh track đã `completed`/`error_blocked`/`waiting_approval` bằng sự kiện giữa run.
      if (!taskId || !isActive(track)) return;
      setTrack(s.tracks, taskId, event.seq, {
        runId: str(p.runId) ?? track?.runId ?? null,
        state: 'thinking',
        tool: null,
      });
      return;
    case 'run.tool_call_started':
      if (!taskId || !isActive(track)) return;
      setTrack(s.tracks, taskId, event.seq, {
        runId: str(p.runId) ?? track?.runId ?? null,
        state: 'working',
        tool: str(p.tool),
      });
      return;
    case 'run.succeeded':
      if (!taskId) return;
      if (p.purpose === 'execute') {
        setTrack(s.tracks, taskId, event.seq, {
          runId: str(p.runId) ?? track?.runId ?? null,
          state: 'completed',
          tool: null,
          progress: 100,
        });
      } else {
        // decompose/review/synthesize xong: kết quả đã áp trực tiếp, không có gì để hiển thị.
        delete s.tracks[taskId];
      }
      return;
    case 'run.failed':
    case 'run.timed_out':
      if (!taskId) return;
      setTrack(s.tracks, taskId, event.seq, {
        runId: str(p.runId) ?? track?.runId ?? null,
        state: 'error_blocked',
        tool: null,
        reason: str(p.errorCode) ?? event.type,
      });
      return;
    case 'run.cancelled':
      // Task `blocked` đã đặt track lỗi trước khi run bị hủy: không xóa dấu hiệu lỗi.
      if (taskId && track && (isActive(track) || track.state === 'waiting_approval')) {
        delete s.tracks[taskId];
      }
      return;
    case 'approval.requested':
      if (!taskId) return;
      setTrack(s.tracks, taskId, event.seq, { state: 'waiting_approval', tool: null });
      return;
    case 'task.progress':
      if (!taskId || !track || track.state === 'completed') return;
      setTrack(s.tracks, taskId, event.seq, {
        progress: typeof p.progress === 'number' ? p.progress : track.progress,
      });
      // `seq` của track phản ánh sự kiện gần nhất; giữ nguyên trạng thái.
      return;
    case 'task.message_posted': {
      // Chỉ nhân viên đang chạy run (tin nhắn gắn `runId`) mới chuyển sang `communicating`.
      const runId = str(p.runId);
      if (!taskId || !track || !runId || track.runId !== runId || !isActive(track)) return;
      setTrack(s.tracks, taskId, event.seq, { state: 'communicating', tool: null });
      return;
    }
    case 'task.status_changed': {
      if (!taskId) return;
      const to = str(p.to);
      const from = str(p.from);
      const assignee = p.assigneeKind === 'ai_employee' && p.assigneeId === s.employeeId;
      if (to === 'blocked' && assignee) {
        setTrack(s.tracks, taskId, event.seq, {
          state: 'error_blocked',
          tool: null,
          reason: str(p.blockedReason) ?? 'BLOCKED',
        });
      } else if (to === 'cancelled') {
        delete s.tracks[taskId];
      } else if (to === 'completed') {
        if (track && track.state !== 'completed') delete s.tracks[taskId];
      } else if (from === 'blocked' && to !== 'blocked' && track?.state === 'error_blocked') {
        delete s.tracks[taskId];
      }
      return;
    }
    case 'employee.suspended':
      s.suspended = true;
      return;
    case 'employee.resumed':
      s.suspended = false;
      for (const [id, t] of Object.entries(s.tracks)) {
        if (t.state === 'error_blocked' && t.reason === EMPLOYEE_SUSPENDED_REASON)
          delete s.tracks[id];
      }
      return;
    case COMPLETED_ELAPSED_EVENT:
      // Chỉ xóa đúng lần `completed` đã lên lịch; task chạy lại sau đó (track mới) thì giữ nguyên.
      if (taskId && track?.state === 'completed' && track.seq === p.sinceSeq)
        delete s.tracks[taskId];
      return;
    default:
      return;
  }
}

/** Gộp các track thành trạng thái hiển thị: break khi tạm ngưng, ngược lại theo hạng rồi theo sự kiện gần nhất. */
function derive(
  s: OfficeEmployeeState,
): Pick<OfficeEmployeeState, 'state' | 'currentTaskId' | 'currentTool' | 'progress'> {
  if (s.suspended)
    return { state: 'break', currentTaskId: null, currentTool: null, progress: null };
  let best: OfficeTrack | undefined;
  for (const t of Object.values(s.tracks)) {
    if (
      !best ||
      RANK[t.state] > RANK[best.state] ||
      (RANK[t.state] === RANK[best.state] && t.seq > best.seq)
    ) {
      best = t;
    }
  }
  if (!best) return { state: 'idle', currentTaskId: null, currentTool: null, progress: null };
  return {
    state: best.state as EmployeeState,
    currentTaskId: best.taskId,
    currentTool: best.state === 'working' ? best.tool : null,
    progress: best.progress,
  };
}

export type ReduceResult = {
  next: OfficeEmployeeState;
  /** Trạng thái hiển thị (state, task, tool, progress) có đổi không. */
  displayChanged: boolean;
  /** Track hoặc cờ tạm ngưng có đổi không (cần lưu dù hiển thị không đổi). */
  persistedChanged: boolean;
};

const sameTracks = (a: Record<string, OfficeTrack>, b: Record<string, OfficeTrack>): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * Reducer thuần của một nhân viên: `(OfficeEmployeeState, DomainEvent) → OfficeEmployeeState`. Không đọc DB hay đồng hồ.
 * Sự kiện có `seq <= appliedSeq` (relay giao lại) bị bỏ qua nên áp lặp lại là an toàn.
 */
export function reduceEmployee(event: DomainEvent, previous: OfficeEmployeeState): ReduceResult {
  const unchanged = { next: previous, displayChanged: false, persistedChanged: false };
  if (event.seq <= previous.appliedSeq) return unchanged;
  // Sự kiện chỉ áp cho nhân viên chính của nó, hoặc (cấp task) cho nhân viên đang có track trên task đó.
  const taskLevel = taskOfTaskLevelEvent(event);
  const related =
    employeeOf(event) === previous.employeeId ||
    (taskLevel !== null && taskLevel in previous.tracks);
  if (!related) return unchanged;
  const next: OfficeEmployeeState = {
    ...previous,
    tracks: structuredClone(previous.tracks),
    appliedSeq: event.seq,
  };
  fold(event, next);
  Object.assign(next, derive(next));

  const displayChanged =
    next.state !== previous.state ||
    next.currentTaskId !== previous.currentTaskId ||
    next.currentTool !== previous.currentTool ||
    next.progress !== previous.progress;
  // SC-006: nguồn của trạng thái hiển thị luôn là sự kiện làm nó đổi.
  next.sourceSeq = displayChanged ? event.seq : previous.sourceSeq;
  const persistedChanged =
    displayChanged ||
    next.suspended !== previous.suspended ||
    !sameTracks(next.tracks, previous.tracks);
  return { next, displayChanged, persistedChanged };
}

/** Reducer theo hợp đồng `OfficeSimulationEngine.apply`: chỉ trả thay đổi hiển thị, hoặc `null`. */
export function applyEvent(
  event: DomainEvent,
  previous?: OfficeEmployeeState,
): EmployeeStatusChange | null {
  const employeeId = previous?.employeeId ?? employeeOf(event);
  if (!employeeId) return null;
  const base = previous ?? initialEmployeeState(employeeId);
  const { next, displayChanged } = reduceEmployee(event, base);
  if (!displayChanged) return null;
  return {
    employeeId,
    state: next.state,
    previousState: base.state,
    currentTaskId: next.currentTaskId,
    currentTool: next.currentTool,
    progress: next.progress,
    sourceEvent: event,
    next,
  };
}

/** Track `completed` vừa được tạo/làm mới bởi sự kiện này: cần lên lịch hết thời gian hiển thị. */
export function newlyCompletedTracks(event: DomainEvent, next: OfficeEmployeeState): OfficeTrack[] {
  return Object.values(next.tracks).filter((t) => t.state === 'completed' && t.seq === event.seq);
}
