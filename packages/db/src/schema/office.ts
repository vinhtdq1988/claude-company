import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns, companyIdColumn } from './_columns';

export const employeeStateEnum = pgEnum('employee_state', [
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

export const officeZoneKindEnum = pgEnum('office_zone_kind', [
  'department',
  'ceo_office',
  'break_room',
]);

/** OfficeTrack theo `taskId` (reducer thuần ở apps/api/src/engines/office-simulation/office-reducer.ts). */
type StoredTrack = {
  taskId: string;
  runId: string | null;
  state: string;
  tool: string | null;
  progress: number | null;
  reason: string | null;
  seq: number;
};

/**
 * Projection trạng thái hiển thị của AI Employee (Office Simulation Engine). Nguồn duy nhất của Virtual Office:
 * mỗi lần đổi `state` đều có `source_event_seq` trỏ tới một `domain_event` thật (SC-006). Không FK xuyên engine.
 */
export const employeeStatus = pgTable(
  'employee_status',
  {
    companyId: companyIdColumn(),
    aiEmployeeId: uuid('ai_employee_id').notNull(),
    state: employeeStateEnum('state').notNull().default('idle'),
    currentTaskId: uuid('current_task_id'),
    currentTool: text('current_tool'),
    /** 0–100, do run báo. */
    progress: integer('progress'),
    suspended: boolean('suspended').notNull().default(false),
    /** Các "đường chạy" theo task; trạng thái hiển thị là kết quả gộp của chúng. */
    tracks: jsonb('tracks').$type<Record<string, StoredTrack>>().notNull().default({}),
    /** `seq` lớn nhất đã áp cho nhân viên này: bỏ qua sự kiện giao lại. */
    appliedSeq: bigint('applied_seq', { mode: 'number' }).notNull().default(0),
    sourceEventSeq: bigint('source_event_seq', { mode: 'number' }).notNull().default(0),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.aiEmployeeId] }),
    check(
      'employee_status_progress_range',
      sql`${t.progress} is null or ${t.progress} between 0 and 100`,
    ),
  ],
);

/**
 * Nhật ký mỗi lần thay đổi hiển thị, khóa theo `seq` của sự kiện nguồn: phát lại theo `sinceSeq` và đối chiếu SC-006
 * mà không phải suy ngược từ trạng thái mới nhất.
 */
export const employeeStatusChange = pgTable(
  'employee_status_change',
  {
    companyId: companyIdColumn(),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    aiEmployeeId: uuid('ai_employee_id').notNull(),
    state: employeeStateEnum('state').notNull(),
    previousState: employeeStateEnum('previous_state').notNull(),
    currentTaskId: uuid('current_task_id'),
    currentTool: text('current_tool'),
    progress: integer('progress'),
    sourceEventType: text('source_event_type').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.seq, t.aiEmployeeId] }),
    index('employee_status_change_employee_idx').on(t.companyId, t.aiEmployeeId, t.seq),
  ],
);

/** Mốc đã chiếu: projection đã gấp mọi `domain_event` có `seq <= applied_seq` của công ty. */
export const officeCursor = pgTable('office_cursor', {
  companyId: companyIdColumn().primaryKey(),
  appliedSeq: bigint('applied_seq', { mode: 'number' }).notNull().default(0),
});

/**
 * Khu vực trong Virtual Office: mỗi department một zone cùng CEO Office và Break Room. `layout` là hình chữ nhật
 * trên lưới ô, sinh tất định từ danh sách department và số nhân viên.
 */
export const officeZone = pgTable(
  'office_zone',
  {
    ...baseColumns(),
    kind: officeZoneKindEnum('kind').notNull(),
    orgUnitId: uuid('org_unit_id'),
    name: text('name').notNull(),
    layout: jsonb('layout').$type<{ x: number; y: number; cols: number; rows: number }>().notNull(),
  },
  (t) => [
    uniqueIndex('office_zone_org_unit_unique')
      .on(t.companyId, t.orgUnitId)
      .where(sql`${t.orgUnitId} is not null`),
    uniqueIndex('office_zone_fixed_kind_unique')
      .on(t.companyId, t.kind)
      .where(sql`${t.kind} <> 'department'`),
    check(
      'office_zone_department_org_unit',
      sql`(${t.kind} = 'department') = (${t.orgUnitId} is not null)`,
    ),
  ],
);
