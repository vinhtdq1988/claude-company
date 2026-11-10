import { bigint, pgEnum, pgTable, timestamp, unique } from 'drizzle-orm/pg-core';
import { baseColumns } from './_columns';

export const milestoneKeyEnum = pgEnum('milestone_key', [
  'first_employee',
  'first_department',
  'first_approved_task',
]);

/**
 * Cột mốc Achievement cơ bản (Gamification Engine, FR-045). UNIQUE(company_id, key) bảo đảm mỗi cột mốc chỉ xuất hiện
 * một lần dù sự kiện nguồn được giao lại hay phát lại (US8-AS1). Không có cột nào đo token hay thời lượng chạy
 * (US8-AS2). `source_event_seq` trỏ tới `domain_event` đã làm phát sinh cột mốc. Không FK xuyên engine.
 */
export const milestone = pgTable(
  'milestone',
  {
    ...baseColumns(),
    key: milestoneKeyEnum('key').notNull(),
    achievedAt: timestamp('achieved_at', { withTimezone: true }).notNull(),
    sourceEventSeq: bigint('source_event_seq', { mode: 'number' }).notNull(),
  },
  (t) => [unique('milestone_company_key_unique').on(t.companyId, t.key)],
);
