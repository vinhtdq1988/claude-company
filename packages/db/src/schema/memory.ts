import { index, jsonb, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { baseColumns } from './_columns';

export const memoryScopeKindEnum = pgEnum('memory_scope_kind', [
  'ai_employee',
  'team',
  'org_unit',
]);
export const memoryKindEnum = pgEnum('memory_kind', ['task_summary', 'note']);

/**
 * Bộ nhớ làm việc theo scope (R11). `share_rule` null = không chia sẻ ngoài scope sở hữu (FR-013).
 * Chưa có vector search; thêm cột embedding (pgvector) khi cần.
 */
export const memoryEntry = pgTable(
  'memory_entry',
  {
    ...baseColumns(),
    ownerScopeKind: memoryScopeKindEnum('owner_scope_kind').notNull(),
    ownerScopeId: uuid('owner_scope_id').notNull(),
    sourceTaskId: uuid('source_task_id'),
    kind: memoryKindEnum('kind').notNull(),
    content: text('content').notNull(),
    shareRule: jsonb('share_rule').$type<Record<string, unknown>>(),
  },
  (t) => [
    index('memory_entry_scope_idx').on(
      t.companyId,
      t.ownerScopeKind,
      t.ownerScopeId,
      t.createdAt,
    ),
  ],
);
