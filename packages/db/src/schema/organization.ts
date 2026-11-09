import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns, createdAtColumn, idColumn, updatedAtColumn } from './_columns';
import { humanMember } from './employee';

/** Bảng `company` không có cột company_id: RLS theo `id`. */
export const company = pgTable(
  'company',
  {
    id: idColumn(),
    name: text('name').notNull(),
    timezone: text('timezone').notNull().default('Asia/Ho_Chi_Minh'),
    templateKey: text('template_key'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [check('company_name_length', sql`char_length(${t.name}) between 1 and 120`)],
);

export const orgUnitKindEnum = pgEnum('org_unit_kind', ['division', 'department']);
export const memberKindEnum = pgEnum('member_kind', ['ai', 'human']);
export const managementTargetKindEnum = pgEnum('management_target_kind', ['org_unit', 'team']);

/** UUID rỗng thay cho parent NULL để tên chỉ cần duy nhất trong cùng parent, kể cả ở cấp công ty. */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** Division / Department. Cây tự tham chiếu qua `parent_id`; parent (nếu có) luôn là division. */
export const orgUnit = pgTable(
  'org_unit',
  {
    ...baseColumns(),
    kind: orgUnitKindEnum('kind').notNull(),
    parentId: uuid('parent_id').references((): AnyPgColumn => orgUnit.id),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [
    check('org_unit_name_length', sql`char_length(${t.name}) between 1 and 120`),
    uniqueIndex('org_unit_name_unique')
      .on(t.companyId, sql`coalesce(${t.parentId}, ${sql.raw(`'${NIL_UUID}'::uuid`)})`, t.name)
      .where(sql`${t.archivedAt} is null`),
    index('org_unit_parent_idx').on(t.companyId, t.parentId),
  ],
);

/** Team nằm trong một department "nhà"; một AI Employee có thể thuộc nhiều team (FR-007). */
export const team = pgTable(
  'team',
  {
    ...baseColumns(),
    orgUnitId: uuid('org_unit_id')
      .notNull()
      .references(() => orgUnit.id),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [
    check('team_name_length', sql`char_length(${t.name}) between 1 and 120`),
    uniqueIndex('team_name_unique')
      .on(t.companyId, t.orgUnitId, t.name)
      .where(sql`${t.archivedAt} is null`),
  ],
);

/** `member_id` là `ai_employee.id` hoặc `human_member.id` tùy `member_kind`, nên không có khóa ngoại. */
export const teamMembership = pgTable(
  'team_membership',
  {
    ...baseColumns(),
    teamId: uuid('team_id')
      .notNull()
      .references(() => team.id),
    memberKind: memberKindEnum('member_kind').notNull(),
    memberId: uuid('member_id').notNull(),
  },
  (t) => [
    unique('team_membership_unique').on(t.teamId, t.memberKind, t.memberId),
    index('team_membership_member_idx').on(t.companyId, t.memberKind, t.memberId),
  ],
);

/** Manager chính của một đơn vị/team, luôn là người thật (FR-005). `target_id` trỏ org_unit hoặc team. */
export const managementAssignment = pgTable(
  'management_assignment',
  {
    ...baseColumns(),
    managerMemberId: uuid('manager_member_id')
      .notNull()
      .references(() => humanMember.id),
    targetKind: managementTargetKindEnum('target_kind').notNull(),
    targetId: uuid('target_id').notNull(),
  },
  (t) => [
    unique('management_assignment_target_unique').on(t.companyId, t.targetKind, t.targetId),
    index('management_assignment_manager_idx').on(t.companyId, t.managerMemberId),
  ],
);

/** Cơ cấu mẫu: dữ liệu seed dùng chung, không theo company và không bật RLS. */
export const orgTemplate = pgTable('org_template', {
  id: idColumn(),
  key: text('key').notNull().unique(),
  name: text('name').notNull(),
  definition: jsonb('definition').notNull(),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
});
