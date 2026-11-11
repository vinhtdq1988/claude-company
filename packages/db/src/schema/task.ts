import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import type { AcceptanceCriterion, DecompositionPlan } from '@claude-company/contracts';
import { baseColumns, companyIdColumn, createdAtColumn, idColumn } from './_columns';

export const taskStatusEnum = pgEnum('task_status', [
  'draft',
  'assigned',
  'in_progress',
  'in_review',
  'awaiting_human_approval',
  'completed',
  'blocked',
  'cancelled',
]);
// Trạng thái đề xuất của task yêu cầu gửi CEO AI Assistant (FR-047); null với mọi task khác.
export const taskProposalStatusEnum = pgEnum('task_proposal_status', ['pending', 'ready', 'failed']);
export const taskPriorityEnum = pgEnum('task_priority', ['low', 'medium', 'high', 'urgent']);
export const taskAssigneeKindEnum = pgEnum('task_assignee_kind', [
  'ai_employee',
  'team',
  'org_unit',
]);
export const artifactKindEnum = pgEnum('artifact_kind', [
  'document',
  'code_diff',
  'test_report',
  'file',
]);
export const reviewerKindEnum = pgEnum('reviewer_kind', ['ai', 'human']);
export const evidenceVerdictEnum = pgEnum('evidence_verdict', ['met', 'not_met']);
export const reviewStageEnum = pgEnum('review_stage', ['ai_review', 'human_approval']);
export const reviewDecisionEnum = pgEnum('review_decision', [
  'pass',
  'rework',
  'approve',
  'reject',
]);

/**
 * Task (FR-014, FR-020a). `parent_task_id` / `assignee_id` / `created_by_member_id` không có khóa ngoại:
 * assignee trỏ tới ba loại đối tượng của hai engine khác, người giao trỏ `human_member` của Employee Engine.
 * `decomposition_plan` và `decomposed_by_employee_id` là cột bổ sung (ngoài data-model gốc) để xem được
 * kế hoạch phân rã và để `rework` task cha chạy lại `synthesize` đúng AI Manager đã phân rã.
 */
export const task = pgTable(
  'task',
  {
    ...baseColumns(),
    parentTaskId: uuid('parent_task_id'),
    title: text('title').notNull(),
    objective: text('objective').notNull(),
    createdByMemberId: uuid('created_by_member_id').notNull(),
    assignedByAiEmployeeId: uuid('assigned_by_ai_employee_id'),
    assigneeKind: taskAssigneeKindEnum('assignee_kind').notNull(),
    assigneeId: uuid('assignee_id').notNull(),
    deadline: timestamp('deadline', { withTimezone: true }).notNull(),
    priority: taskPriorityEnum('priority').notNull(),
    acceptanceCriteria: jsonb('acceptance_criteria').$type<AcceptanceCriterion[]>().notNull(),
    expectedOutput: text('expected_output').notNull(),
    status: taskStatusEnum('status').notNull().default('draft'),
    blockedFrom: taskStatusEnum('blocked_from'),
    blockedReason: text('blocked_reason'),
    isOverdue: boolean('is_overdue').notNull().default(false),
    reworkCount: integer('rework_count').notNull().default(0),
    reworkBaseline: integer('rework_baseline').notNull().default(0),
    tokenCap: bigint('token_cap', { mode: 'number' }),
    costCap: numeric('cost_cap', { precision: 12, scale: 6 }),
    decompositionPlan: jsonb('decomposition_plan').$type<DecompositionPlan>(),
    decomposedByEmployeeId: uuid('decomposed_by_employee_id'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    proposalStatus: taskProposalStatusEnum('proposal_status'),
  },
  (t) => [
    check('task_rework_count_nonneg', sql`${t.reworkCount} >= 0`),
    check('task_rework_baseline_range', sql`${t.reworkBaseline} between 0 and ${t.reworkCount}`),
    check('task_criteria_nonempty', sql`jsonb_array_length(${t.acceptanceCriteria}) >= 1`),
    index('task_assignee_idx').on(t.companyId, t.assigneeKind, t.assigneeId, t.status),
    index('task_parent_idx').on(t.companyId, t.parentTaskId),
    index('task_status_idx').on(t.companyId, t.status, t.deadline),
  ],
);

export const taskDependency = pgTable(
  'task_dependency',
  {
    id: idColumn(),
    companyId: companyIdColumn(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => task.id),
    dependsOnTaskId: uuid('depends_on_task_id')
      .notNull()
      .references(() => task.id),
    createdAt: createdAtColumn(),
  },
  (t) => [
    unique('task_dependency_unique').on(t.taskId, t.dependsOnTaskId),
    check('task_dependency_not_self', sql`${t.taskId} <> ${t.dependsOnTaskId}`),
    index('task_dependency_reverse_idx').on(t.companyId, t.dependsOnTaskId),
  ],
);

export const artifact = pgTable(
  'artifact',
  {
    ...baseColumns(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => task.id),
    agentRunId: uuid('agent_run_id'),
    /** AI Employee đã tạo artifact; dùng kiểm tra `reviewer_id ≠` người tạo (Nguyên tắc VII). */
    createdByEmployeeId: uuid('created_by_employee_id'),
    kind: artifactKindEnum('kind').notNull(),
    title: text('title').notNull(),
    storageKey: text('storage_key').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    checksumSha256: text('checksum_sha256').notNull(),
    /** `rework_count` lúc nộp: chỉ artifact của vòng hiện tại tính cho điều kiện sang Awaiting Human Approval. */
    round: integer('round').notNull().default(0),
  },
  (t) => [index('artifact_task_idx').on(t.companyId, t.taskId, t.createdAt)],
);

/** Bằng chứng đối chiếu từng acceptance criterion. `round` = `rework_count` lúc ghi, để bằng chứng cũ không tính cho vòng mới. */
export const evidence = pgTable(
  'evidence',
  {
    ...baseColumns(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => task.id),
    criterionId: text('criterion_id').notNull(),
    artifactId: uuid('artifact_id').references(() => artifact.id),
    reviewerKind: reviewerKindEnum('reviewer_kind').notNull(),
    reviewerId: uuid('reviewer_id').notNull(),
    verdict: evidenceVerdictEnum('verdict').notNull(),
    explanation: text('explanation').notNull(),
    round: integer('round').notNull().default(0),
  },
  (t) => [index('evidence_task_idx').on(t.companyId, t.taskId, t.round)],
);

/** Bất biến, chỉ INSERT (trigger chặn UPDATE/DELETE). Phục vụ SC-014. */
export const reviewRecord = pgTable(
  'review_record',
  {
    id: idColumn(),
    companyId: companyIdColumn(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => task.id),
    stage: reviewStageEnum('stage').notNull(),
    reviewerKind: reviewerKindEnum('reviewer_kind').notNull(),
    reviewerId: uuid('reviewer_id').notNull(),
    decision: reviewDecisionEnum('decision').notNull(),
    reason: text('reason').notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAtColumn(),
  },
  (t) => [
    check('review_record_reason_nonempty', sql`char_length(btrim(${t.reason})) > 0`),
    index('review_record_task_idx').on(t.companyId, t.taskId, t.decidedAt),
  ],
);
