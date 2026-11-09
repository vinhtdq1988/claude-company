import { z } from 'zod';

/** Sự kiện miền ghi trong bảng domain_event (outbox). */
export type DomainEvent = {
  id: string;
  companyId: string;
  /** Tăng dần, liên tục theo company. */
  seq: number;
  type: string;
  aggregateKind: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  occurredAt: string;
};

export type RealtimeEnvelope<T> = {
  /** Lấy từ domain_event.seq; nhiều envelope của cùng một event dùng chung seq (D2). */
  seq: number;
  companyId: string;
  type: string;
  occurredAt: string;
  payload: T;
};

export const employeeStateSchema = z.enum([
  'idle',
  'working',
  'thinking',
  'communicating',
  'meeting',
  'waiting_approval',
  'completed',
  'error_blocked',
  'break',
]);
export type EmployeeState = z.infer<typeof employeeStateSchema>;

const id = z.string().min(1);

export const officeEmployeeStatusChangedSchema = z.object({
  employeeId: id,
  state: employeeStateSchema,
  previousState: employeeStateSchema,
  currentTaskId: id.optional(),
  currentTool: z.string().optional(),
  progress: z.number().min(0).max(100).optional(),
  sourceEventType: z.string(),
});

export const officeLayoutChangedSchema = z.object({
  reason: z.enum(['org_unit_created', 'org_unit_archived', 'employee_moved']),
});

export const taskStatusChangedSchema = z.object({
  taskId: id,
  from: z.string(),
  to: z.string(),
  assigneeKind: z.enum(['ai_employee', 'team', 'org_unit']),
  assigneeId: id,
  isOverdue: z.boolean(),
});

export const taskProgressSchema = z.object({
  taskId: id,
  employeeId: id,
  progress: z.number().min(0).max(100),
});

export const runStepAppendedSchema = z.object({
  runId: id,
  taskId: id,
  employeeId: id,
  seq: z.number().int(),
  kind: z.string(),
});

export const usageUpdatedSchema = z.object({
  employeeId: id,
  taskId: id,
  tokensDelta: z.number(),
  costDelta: z.number(),
});

export const milestoneAchievedSchema = z.object({ key: z.string() });

export const syncSeqAdvancedSchema = z.object({}).strict();

export const notificationCreatedSchema = z.object({
  notificationId: id,
  type: z.string(),
  title: z.string(),
  taskId: id.optional(),
  approvalRequestId: id.optional(),
});

export const approvalRequestedSchema = z.object({
  approvalRequestId: id,
  taskId: id,
  employeeId: id,
  actionType: z.string(),
});

export const approvalDecidedSchema = z.object({
  approvalRequestId: id,
  decision: z.enum(['approve', 'reject']),
});

/** Sự kiện phát tới room `company:{id}`. */
export const COMPANY_ROOM_EVENT_SCHEMAS = {
  'office.employee_status_changed': officeEmployeeStatusChangedSchema,
  'office.layout_changed': officeLayoutChangedSchema,
  'task.status_changed': taskStatusChangedSchema,
  'task.progress': taskProgressSchema,
  'run.step_appended': runStepAppendedSchema,
  'usage.updated': usageUpdatedSchema,
  'milestone.achieved': milestoneAchievedSchema,
  'sync.seq_advanced': syncSeqAdvancedSchema,
} as const;

/** Sự kiện phát tới room `user:{memberId}`. */
export const USER_ROOM_EVENT_SCHEMAS = {
  'notification.created': notificationCreatedSchema,
  'approval.requested': approvalRequestedSchema,
  'approval.decided': approvalDecidedSchema,
} as const;

export const REALTIME_EVENT_SCHEMAS = {
  ...COMPANY_ROOM_EVENT_SCHEMAS,
  ...USER_ROOM_EVENT_SCHEMAS,
} as const;

export type RealtimeEventType = keyof typeof REALTIME_EVENT_SCHEMAS;
export type RealtimePayload<K extends RealtimeEventType> = z.infer<
  (typeof REALTIME_EVENT_SCHEMAS)[K]
>;

/** Sự kiện chỉ phát cho mọi thành viên, không lọc theo ManagedScope. */
export const BROADCAST_EVENT_TYPES: readonly RealtimeEventType[] = [
  'office.layout_changed',
  'milestone.achieved',
  'sync.seq_advanced',
];

export const subscribeRequestSchema = z.object({
  companyId: z.string().uuid(),
  sinceSeq: z.number().int().min(0).optional(),
});
export type SubscribeRequest = z.infer<typeof subscribeRequestSchema>;

/** Phản hồi subscribe: ok hoặc yêu cầu client tải lại snapshot. */
export type SubscribeResult = { status: 'ok'; seq: number } | { status: 'resync_required' };
