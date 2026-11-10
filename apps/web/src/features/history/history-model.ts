import type {
  AgentRunSummary,
  RunPurpose,
  RunStatus,
  RunStepKind,
  ToolInvocationStatus,
} from '@claude-company/contracts';
import { errorMessages, type MessageKey } from '../../i18n/vi';

export const RUN_STATUS_LABEL_KEYS: Readonly<Record<RunStatus, MessageKey>> = {
  queued: 'history.status.queued',
  running: 'history.status.running',
  waiting_approval: 'history.status.waiting_approval',
  succeeded: 'history.status.succeeded',
  failed: 'history.status.failed',
  timed_out: 'history.status.timed_out',
  cancelled: 'history.status.cancelled',
};

export const PURPOSE_LABEL_KEYS: Readonly<Record<RunPurpose, MessageKey>> = {
  execute: 'history.purpose.execute',
  decompose: 'history.purpose.decompose',
  review: 'history.purpose.review',
  synthesize: 'history.purpose.synthesize',
};

export const STEP_KIND_LABEL_KEYS: Readonly<Record<RunStepKind, MessageKey>> = {
  model_call: 'history.step.model_call',
  tool_call: 'history.step.tool_call',
  message: 'history.step.message',
  system: 'history.step.system',
};

export const INVOCATION_STATUS_LABEL_KEYS: Readonly<Record<ToolInvocationStatus, MessageKey>> = {
  denied: 'history.invocation.denied',
  pending_approval: 'history.invocation.pending_approval',
  pending: 'history.invocation.pending',
  executing: 'history.invocation.executing',
  succeeded: 'history.invocation.succeeded',
  failed: 'history.invocation.failed',
  unknown: 'history.invocation.unknown',
};

/** Mã lỗi riêng của run (ngoài `ErrorCode` của API) có thông điệp giải thích bằng tiếng Việt. */
const RUN_ERROR_KEYS: Readonly<Record<string, MessageKey>> = {
  TIMEOUT: 'history.error.TIMEOUT',
  PROVIDER_ERROR: 'history.error.PROVIDER_ERROR',
  INVALID_OUTPUT: 'history.error.INVALID_OUTPUT',
  MAX_TURNS: 'history.error.MAX_TURNS',
  TASK_STATE_CHANGED: 'history.error.TASK_STATE_CHANGED',
};

/** Trạng thái run kết thúc mà không thành công: lịch sử phải nêu nguyên nhân (SC-011). */
const FAILURE_STATUSES: readonly RunStatus[] = ['failed', 'timed_out', 'cancelled'];

export type RunFailure = {
  code: string;
  /** Khóa giao diện giải thích mã lỗi riêng của run; `null` nếu mã thuộc `ErrorCode` hoặc không biết. */
  messageKey: MessageKey | null;
  /** Giải thích dùng khi không có `messageKey`: thông điệp của `ErrorCode`, hoặc chính mã lỗi nếu lạ. */
  fallback: string;
  /** Thông điệp chi tiết do hệ thống ghi (văn bản thuần). */
  detail: string | null;
};

/**
 * Nguyên nhân thất bại của một run, hoặc `null` nếu run không lỗi. Run `cancelled` chỉ coi là có lỗi khi hệ thống ghi
 * mã lỗi (người dùng chủ động hủy thì không có mã).
 */
export function failureOf(
  run: Pick<AgentRunSummary, 'status' | 'errorCode' | 'errorMessage'>,
): RunFailure | null {
  if (!FAILURE_STATUSES.includes(run.status)) return null;
  if (run.status === 'cancelled' && !run.errorCode) return null;
  const code = run.errorCode ?? 'UNKNOWN';
  return {
    code,
    messageKey: RUN_ERROR_KEYS[code] ?? null,
    fallback: (errorMessages as Record<string, string | undefined>)[code] ?? code,
    detail: run.errorMessage,
  };
}

/** Thời lượng dạng "1 phút 05 giây"; `null` khi run chưa bắt đầu hoặc mốc thời gian không hợp lệ. */
export function formatDuration(
  startedAt: string | null,
  finishedAt: string | null,
  now = Date.now(),
): string | null {
  if (!startedAt) return null;
  const start = Date.parse(startedAt);
  const end = finishedAt ? Date.parse(finishedAt) : now;
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  const totalSeconds = Math.round((end - start) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds} giây`;
  return `${minutes} phút ${String(seconds).padStart(2, '0')} giây`;
}

/** Mới nhất lên trước; cùng thời điểm thì sắp theo `attempt` giảm dần để lần thử sau nằm trên. */
export function sortRuns<T extends Pick<AgentRunSummary, 'createdAt' | 'attempt'>>(
  items: readonly T[],
): T[] {
  return [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.attempt - a.attempt);
}

export const formatCost = (usd: number): string => `$${usd.toFixed(4)}`;
