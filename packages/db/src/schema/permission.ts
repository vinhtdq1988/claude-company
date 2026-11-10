import { index, jsonb, pgEnum, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { baseColumns } from './_columns';

export const permissionLevelEnum = pgEnum('permission_level', [
  'auto_execute',
  'review_required',
  'human_approval',
  'restricted',
]);

export const policyScopeKindEnum = pgEnum('policy_scope_kind', [
  'company',
  'org_unit',
  'team',
  'ai_employee',
]);

/**
 * Chính sách nâng mức quyền theo phạm vi (chỉ nâng, không hạ floor).
 * v1.0 chưa có API ghi: bảng chỉ nhận seed. `scope_id` null khi scope_kind = company.
 */
export const actionPolicy = pgTable(
  'action_policy',
  {
    ...baseColumns(),
    actionType: text('action_type').notNull(),
    level: permissionLevelEnum('level').notNull(),
    scopeKind: policyScopeKindEnum('scope_kind').notNull(),
    scopeId: uuid('scope_id'),
  },
  (t) => [index('action_policy_lookup_idx').on(t.companyId, t.actionType)],
);

export const approvalStatusEnum = pgEnum('approval_status', [
  'pending',
  'approved',
  'rejected',
  'cancelled',
]);

/**
 * Yêu cầu Human Approval cho một lời gọi tool (FR-026). Không có trạng thái `expired`: yêu cầu không bao giờ tự
 * hết hạn hay tự duyệt. `payload_hash` ràng buộc hành động được thực thi với đúng bản người duyệt đã xem.
 * `tool_invocation_id`, `task_id`, `ai_employee_id`, `agent_run_id` là uuid thường (không FK) vì bảng thuộc engine khác.
 */
export const approvalRequest = pgTable(
  'approval_request',
  {
    ...baseColumns(),
    toolInvocationId: uuid('tool_invocation_id').notNull(),
    agentRunId: uuid('agent_run_id').notNull(),
    taskId: uuid('task_id').notNull(),
    aiEmployeeId: uuid('ai_employee_id').notNull(),
    actionType: text('action_type').notNull(),
    summary: text('summary').notNull(),
    rationale: text('rationale').notNull().default(''),
    payload: jsonb('payload').notNull(),
    payloadHash: text('payload_hash').notNull(),
    approverMemberId: uuid('approver_member_id'),
    status: approvalStatusEnum('status').notNull().default('pending'),
    decidedBy: uuid('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decisionReason: text('decision_reason'),
    lastRemindedAt: timestamp('last_reminded_at', { withTimezone: true }),
  },
  (t) => [
    unique('approval_request_invocation_unique').on(t.toolInvocationId),
    index('approval_request_status_idx').on(t.companyId, t.status, t.createdAt),
    index('approval_request_task_idx').on(t.companyId, t.taskId),
    index('approval_request_approver_idx').on(t.companyId, t.approverMemberId, t.status),
  ],
);
