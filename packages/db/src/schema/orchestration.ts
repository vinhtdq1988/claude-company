import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns } from './_columns';
import { runtimeKindEnum } from './employee';
import { permissionLevelEnum } from './permission';

export const runPurposeEnum = pgEnum('run_purpose', [
  'execute',
  'decompose',
  'review',
  'synthesize',
  'propose',
]);
export const runStatusEnum = pgEnum('run_status', [
  'queued',
  'running',
  'waiting_approval',
  'succeeded',
  'failed',
  'timed_out',
  'cancelled',
]);
export const runStepKindEnum = pgEnum('run_step_kind', [
  'model_call',
  'tool_call',
  'message',
  'system',
]);
export const toolInvocationStatusEnum = pgEnum('tool_invocation_status', [
  'denied',
  'pending_approval',
  'pending',
  'executing',
  'succeeded',
  'failed',
  'unknown',
]);
export const adapterModeEnum = pgEnum('adapter_mode', ['dry_run', 'live', 'internal']);

/** Một lượt chạy của AI Employee. `runtime_kind`, `model_id` là ảnh chụp lúc chạy (US2-AS3). */
export const agentRun = pgTable(
  'agent_run',
  {
    ...baseColumns(),
    taskId: uuid('task_id').notNull(),
    aiEmployeeId: uuid('ai_employee_id').notNull(),
    purpose: runPurposeEnum('purpose').notNull(),
    attempt: integer('attempt').notNull().default(1),
    status: runStatusEnum('status').notNull().default('queued'),
    runtimeKind: runtimeKindEnum('runtime_kind').notNull(),
    modelId: text('model_id').notNull(),
    providerSessionId: text('provider_session_id'),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    traceId: text('trace_id').notNull(),
  },
  (t) => [
    index('agent_run_task_idx').on(t.companyId, t.taskId, t.createdAt),
    index('agent_run_employee_idx').on(t.companyId, t.aiEmployeeId, t.status),
    index('agent_run_active_idx').on(t.companyId, t.status),
  ],
);

export const runStep = pgTable(
  'run_step',
  {
    ...baseColumns(),
    agentRunId: uuid('agent_run_id')
      .notNull()
      .references(() => agentRun.id),
    seq: integer('seq').notNull(),
    kind: runStepKindEnum('kind').notNull(),
    summary: text('summary').notNull(),
    /** Đã che secret ở phía worker trước khi ghi. */
    payload: jsonb('payload'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [unique('run_step_seq_unique').on(t.agentRunId, t.seq)],
);

/**
 * Ledger tác dụng phụ. `idempotency_key` UNIQUE theo công thức nhóm `dedupe`/`rerun` của action-policy.md.
 * `agent_run_id`, `task_id` bổ sung để truy vết và `listExecutedActions` không phải nối qua run_step.
 */
export const toolInvocation = pgTable(
  'tool_invocation',
  {
    ...baseColumns(),
    agentRunId: uuid('agent_run_id')
      .notNull()
      .references(() => agentRun.id),
    taskId: uuid('task_id').notNull(),
    runStepId: uuid('run_step_id').references(() => runStep.id),
    actionType: text('action_type').notNull(),
    permissionLevel: permissionLevelEnum('permission_level').notNull(),
    input: jsonb('input').notNull(),
    inputHash: text('input_hash').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    status: toolInvocationStatusEnum('status').notNull(),
    adapterMode: adapterModeEnum('adapter_mode'),
    result: jsonb('result'),
  },
  (t) => [
    unique('tool_invocation_idempotency_unique').on(t.idempotencyKey),
    index('tool_invocation_run_idx').on(t.companyId, t.agentRunId),
    index('tool_invocation_task_idx').on(t.companyId, t.taskId, t.status),
  ],
);

/** Hội thoại của run `messages_api` khi tạm dừng chờ duyệt. Không chứa credential. */
export const runConversationState = pgTable('run_conversation_state', {
  ...baseColumns(),
  agentRunId: uuid('agent_run_id')
    .notNull()
    .unique()
    .references(() => agentRun.id),
  messages: jsonb('messages').notNull(),
});
