import { index, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { baseColumns } from './_columns';

export const messageAuthorKindEnum = pgEnum('message_author_kind', ['human', 'ai']);
export const notificationTypeEnum = pgEnum('notification_type', [
  'task_completed',
  'task_error',
  'task_overdue',
  'approval_needed',
  'budget_warning',
  'budget_blocked',
  'overload_warning',
  'escalation',
]);

/** Trao đổi luôn gắn một task (FR-022, Nguyên tắc I): không có chat tự do. */
export const taskMessage = pgTable(
  'task_message',
  {
    ...baseColumns(),
    taskId: uuid('task_id').notNull(),
    authorKind: messageAuthorKindEnum('author_kind').notNull(),
    authorId: uuid('author_id').notNull(),
    body: text('body').notNull(),
    agentRunId: uuid('agent_run_id'),
  },
  (t) => [index('task_message_task_idx').on(t.companyId, t.taskId, t.createdAt)],
);

/** Thông báo in-app (FR-041). */
export const notification = pgTable(
  'notification',
  {
    ...baseColumns(),
    recipientMemberId: uuid('recipient_member_id').notNull(),
    type: notificationTypeEnum('type').notNull(),
    taskId: uuid('task_id'),
    approvalRequestId: uuid('approval_request_id'),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    readAt: timestamp('read_at', { withTimezone: true }),
  },
  (t) => [index('notification_recipient_idx').on(t.companyId, t.recipientMemberId, t.readAt)],
);
