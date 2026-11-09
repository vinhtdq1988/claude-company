import { index, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core';
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
