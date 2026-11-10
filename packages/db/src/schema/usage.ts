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
import { baseColumns, createdAtColumn, idColumn } from './_columns';
import { policyScopeKindEnum } from './permission';

/**
 * Bảng giá model (USD cho mỗi triệu token). Cấu hình toàn cục, không theo company và không bật RLS.
 * Chỉ `ModelCatalog` đọc bảng này; engine khác hỏi qua interface.
 */
export const modelPrice = pgTable(
  'model_price',
  {
    id: idColumn(),
    modelId: text('model_id').notNull(),
    inputPerMtok: numeric('input_per_mtok', { precision: 12, scale: 6 }).notNull(),
    outputPerMtok: numeric('output_per_mtok', { precision: 12, scale: 6 }).notNull(),
    cacheReadPerMtok: numeric('cache_read_per_mtok', { precision: 12, scale: 6 }).notNull(),
    cacheWritePerMtok: numeric('cache_write_per_mtok', { precision: 12, scale: 6 }).notNull(),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    createdAt: createdAtColumn(),
  },
  (t) => [
    unique('model_price_effective_unique').on(t.modelId, t.effectiveFrom),
    index('model_price_lookup_idx').on(t.modelId, t.effectiveFrom),
  ],
);

/**
 * Giới hạn theo phạm vi. `max_concurrent_tasks` chỉ dùng cho company, org_unit, team; giới hạn của từng
 * nhân viên lưu ở `ai_employee.max_concurrent_tasks`. `scope_id` đặt bằng `company_id` khi scope là company
 * để ràng buộc UNIQUE(scope_kind, scope_id) có hiệu lực (NULL không bao giờ trùng nhau).
 */
export const budgetPolicy = pgTable(
  'budget_policy',
  {
    ...baseColumns(),
    scopeKind: policyScopeKindEnum('scope_kind').notNull(),
    scopeId: uuid('scope_id').notNull(),
    monthlyTokenLimit: bigint('monthly_token_limit', { mode: 'number' }),
    monthlyCostLimit: numeric('monthly_cost_limit', { precision: 12, scale: 6 }),
    maxConcurrentTasks: integer('max_concurrent_tasks'),
    allowedModels: text('allowed_models').array(),
    warnThreshold: numeric('warn_threshold', { precision: 4, scale: 3 }).notNull().default('0.8'),
  },
  (t) => [
    unique('budget_policy_scope_unique').on(t.companyId, t.scopeKind, t.scopeId),
    check('budget_policy_warn_range', sql`${t.warnThreshold} between 0 and 1`),
  ],
);

/** Sổ chi tiêu: chỉ INSERT (trigger chặn UPDATE/DELETE). `provider_message_id` UNIQUE chống đếm trùng. */
export const usageLedger = pgTable(
  'usage_ledger',
  {
    ...baseColumns(),
    agentRunId: uuid('agent_run_id').notNull(),
    taskId: uuid('task_id').notNull(),
    aiEmployeeId: uuid('ai_employee_id').notNull(),
    orgUnitId: uuid('org_unit_id'),
    teamIds: uuid('team_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    modelId: text('model_id').notNull(),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull(),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull(),
    cacheReadTokens: bigint('cache_read_tokens', { mode: 'number' }).notNull().default(0),
    cacheWriteTokens: bigint('cache_write_tokens', { mode: 'number' }).notNull().default(0),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }).notNull(),
    period: text('period').notNull(),
    providerMessageId: text('provider_message_id').notNull(),
    isOverage: boolean('is_overage').notNull().default(false),
  },
  (t) => [
    unique('usage_ledger_message_unique').on(t.providerMessageId),
    check('usage_ledger_period_format', sql`${t.period} ~ '^[0-9]{4}-[0-9]{2}$'`),
    index('usage_ledger_period_idx').on(t.companyId, t.period),
    index('usage_ledger_task_idx').on(t.companyId, t.taskId),
    index('usage_ledger_employee_idx').on(t.companyId, t.aiEmployeeId, t.period),
  ],
);

export const reservationStatusEnum = pgEnum('budget_reservation_status', [
  'held',
  'committed',
  'released',
]);

/** Phần ngân sách đang giữ cho run/lượt gọi; tổng đã dùng + đang giữ không vượt giới hạn của mọi scope. */
export const budgetReservation = pgTable(
  'budget_reservation',
  {
    ...baseColumns(),
    agentRunId: uuid('agent_run_id').notNull(),
    taskId: uuid('task_id').notNull(),
    aiEmployeeId: uuid('ai_employee_id').notNull(),
    scopes: jsonb('scopes').$type<Array<{ kind: string; id: string }>>().notNull(),
    period: text('period').notNull(),
    reservedTokens: bigint('reserved_tokens', { mode: 'number' }).notNull(),
    reservedCost: numeric('reserved_cost', { precision: 12, scale: 6 }).notNull(),
    status: reservationStatusEnum('status').notNull().default('held'),
  },
  (t) => [index('budget_reservation_held_idx').on(t.companyId, t.period, t.status)],
);

/**
 * Nhật ký cảnh báo ngưỡng: mỗi (phạm vi, kỳ, loại giới hạn, giá trị giới hạn, ngưỡng) chỉ cảnh báo một lần.
 * Đổi giới hạn hoặc ngưỡng là một "ngưỡng" khác nên được cảnh báo lại; bản ghi cũ giữ nguyên.
 */
export const budgetWarningLog = pgTable(
  'budget_warning_log',
  {
    ...baseColumns(),
    scopeKind: policyScopeKindEnum('scope_kind').notNull(),
    scopeId: uuid('scope_id').notNull(),
    period: text('period').notNull(),
    metric: text('metric').notNull(),
    limitValue: numeric('limit_value', { precision: 18, scale: 6 }).notNull(),
    threshold: numeric('threshold', { precision: 4, scale: 3 }).notNull(),
  },
  (t) => [
    unique('budget_warning_log_unique').on(
      t.companyId,
      t.scopeKind,
      t.scopeId,
      t.period,
      t.metric,
      t.limitValue,
      t.threshold,
    ),
    check('budget_warning_log_metric', sql`${t.metric} in ('tokens', 'cost')`),
  ],
);
