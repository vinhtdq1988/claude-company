import { z } from 'zod';
import type { ScopeRef } from './common';
import type { NotificationType } from './task';
import type { RuntimeKind } from './employee';

export const RUN_PURPOSES = ['execute', 'decompose', 'review', 'synthesize', 'propose'] as const;
export const runPurposeSchema = z.enum(RUN_PURPOSES);
export type RunPurpose = z.infer<typeof runPurposeSchema>;

export const RUN_STATUSES = [
  'queued',
  'running',
  'waiting_approval',
  'succeeded',
  'failed',
  'timed_out',
  'cancelled',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** Run đã kết thúc: không nhận cập nhật trạng thái nữa. */
export const FINAL_RUN_STATUSES: readonly RunStatus[] = [
  'succeeded',
  'failed',
  'timed_out',
  'cancelled',
];

export type AgentRunRef = { runId: string };

export type AgentRunSummary = {
  id: string;
  taskId: string;
  employeeId: string;
  purpose: RunPurpose;
  attempt: number;
  status: RunStatus;
  runtimeKind: RuntimeKind;
  modelId: string;
  providerSessionId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  traceId: string;
  createdAt: string;
};

export type RunStepKind = 'model_call' | 'tool_call' | 'message' | 'system';

export type RunStep = {
  id: string;
  seq: number;
  kind: RunStepKind;
  summary: string;
  payload: unknown;
  startedAt: string;
  finishedAt: string | null;
};

export type ToolInvocationStatus =
  | 'denied'
  | 'pending_approval'
  | 'pending'
  | 'executing'
  | 'succeeded'
  | 'failed'
  | 'unknown';

export type AdapterMode = 'dry_run' | 'live' | 'internal';

export type ToolInvocation = {
  id: string;
  runStepId: string | null;
  actionType: string;
  permissionLevel: string;
  input: unknown;
  inputHash: string;
  idempotencyKey: string;
  status: ToolInvocationStatus;
  adapterMode: AdapterMode | null;
  result: unknown;
  createdAt: string;
};

export type AgentRunDetail = AgentRunSummary & {
  steps: RunStep[];
  toolInvocations: ToolInvocation[];
};

/** Chi phí thực tế của một run, cộng từ `usage_ledger` (US7-AS1). */
export type RunUsage = { tokens: number; costUsd: number };

/** Chi tiết run trả cho người xem: kèm usage do BudgetService cung cấp (OrchestrationEngine không đọc ledger). */
export type AgentRunView = AgentRunDetail & { usage: RunUsage };

/** Query của `GET /runs`: lọc theo task hoặc nhân viên; luôn bị giới hạn theo phạm vi quản lý của người xem. */
export const runListQuerySchema = z.object({
  taskId: z.string().uuid().optional(),
  employeeId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type RunListQuery = z.infer<typeof runListQuerySchema>;

export type RunListFilter = {
  taskId?: string;
  employeeId?: string;
  /** Chỉ run của nhân viên trong tập này (phạm vi quản lý). Không đặt = không lọc. Mảng rỗng = không có gì. */
  employeeIds?: string[];
  limit?: number;
};

export type AgentRunStatusPatch = {
  status?: RunStatus;
  errorCode?: string;
  errorMessage?: string;
  providerSessionId?: string;
};

export type RunStepInput = {
  kind: RunStepKind;
  summary: string;
  /** Đã che secret ở phía gọi (`redact.ts`). */
  payload?: unknown;
  startedAt?: string;
  finishedAt?: string;
};
export type RunStepRef = { id: string; seq: number };

export type ToolInvocationInput = {
  runId: string;
  runStepId?: string;
  actionType: string;
  permissionLevel: string;
  input: unknown;
  inputHash: string;
  idempotencyKey: string;
  status: ToolInvocationStatus;
  adapterMode?: AdapterMode;
  result?: unknown;
};
export type ToolInvocationPatch = {
  status?: ToolInvocationStatus;
  result?: unknown;
  adapterMode?: AdapterMode;
};
/** Sự kiện run/tiến độ do worker báo, được OrchestrationEngine ghi thành `domain_event`. */
export type RunEventInput =
  | { type: 'model_call_started' }
  | { type: 'tool_call_started'; tool: string }
  | { type: 'progress'; progress: number }
  | { type: 'usage'; tokensDelta: number; costDelta: number };

export type RecoveryReport = { recovered: number; failed: number };

export type ExecutedAction = {
  toolInvocationId: string;
  actionType: string;
  adapterMode: AdapterMode;
  status: ToolInvocationStatus;
  executedAt: string;
};

export type MemoryEntry = {
  id: string;
  ownerScopeKind: 'ai_employee' | 'team' | 'org_unit';
  ownerScopeId: string;
  sourceTaskId: string | null;
  kind: 'task_summary' | 'note';
  content: string;
  createdAt: string;
};
export type MemoryEntryInput = {
  ownerScopeKind: 'ai_employee' | 'team' | 'org_unit';
  ownerScopeId: string;
  sourceTaskId?: string;
  kind: 'task_summary' | 'note';
  content: string;
  /** null/bỏ trống = không chia sẻ ngoài scope (FR-013). */
  shareRule?: Record<string, unknown> | null;
};

export type NotificationInput = {
  type: NotificationType;
  title: string;
  body?: string;
  taskId?: string;
  approvalRequestId?: string;
};

/** Thông báo cần định tuyến: ngữ cảnh đủ để chọn người nhận theo FR-041. */
export type RoutedNotification = NotificationInput & {
  /** `overload_warning`: nhân viên quá tải. */
  employeeId?: string;
  /** `budget_warning`: phạm vi bị chạm ngưỡng. */
  scope?: ScopeRef;
  /** `approval_needed`: người duyệt của approval request. */
  approverMemberId?: string;
};

/** Kết quả một lời gọi tool trả về cho agent. */
export type ToolResult = {
  status: 'ok' | 'pending_approval' | 'run_locked' | 'denied' | 'error';
  output?: unknown;
  message?: string;
  /** Mã lỗi nghiệp vụ của engine (`DomainError.code`) khi tool lỗi hoặc bị từ chối. */
  code?: string;
};
