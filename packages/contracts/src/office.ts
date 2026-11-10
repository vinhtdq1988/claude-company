import { z } from 'zod';
import { employeeKindSchema, employeeStatusSchema } from './employee';
import { employeeStateSchema, type DomainEvent, type EmployeeState } from './realtime';

/** Bộ sprite nhân vật trong `apps/web/public/office/`; `avatar_key` ngoài bộ này dùng `generic`. */
export const AVATAR_KEYS = ['developer', 'analyst', 'tester', 'manager', 'generic'] as const;
export type AvatarKey = (typeof AVATAR_KEYS)[number];

export const officeZoneKindSchema = z.enum(['department', 'ceo_office', 'break_room']);
export type OfficeZoneKind = z.infer<typeof officeZoneKindSchema>;

/** Hình chữ nhật của zone trên lưới ô (tile). Sinh tất định từ danh sách department và số nhân viên. */
export const zoneLayoutSchema = z.object({
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  cols: z.number().int().min(1),
  rows: z.number().int().min(1),
});
export type ZoneLayout = z.infer<typeof zoneLayoutSchema>;

export const officeZoneSchema = z.object({
  id: z.string().min(1),
  kind: officeZoneKindSchema,
  name: z.string(),
  orgUnitId: z.string().nullable(),
  layout: zoneLayoutSchema,
});
export type OfficeZone = z.infer<typeof officeZoneSchema>;

export const officeEmployeeSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  avatarKey: z.string(),
  zoneId: z.string().min(1),
  deskIndex: z.number().int().min(0),
  state: employeeStateSchema,
  currentTaskId: z.string().nullable(),
  currentTool: z.string().nullable(),
  progress: z.number().min(0).max(100).nullable(),
});
export type OfficeEmployee = z.infer<typeof officeEmployeeSchema>;

/** `GET /office/snapshot`: `seq` là mốc để client subscribe tiếp (`sinceSeq`) và phát hiện mất sự kiện. */
export const officeSnapshotSchema = z.object({
  seq: z.number().int().min(0),
  zones: z.array(officeZoneSchema),
  employees: z.array(officeEmployeeSchema),
});
export type OfficeSnapshot = z.infer<typeof officeSnapshotSchema>;

/** Số bàn trên mỗi hàng trong một zone. */
export const DESKS_PER_ROW = 4;

/** Ô (tile) của bàn thứ `deskIndex` trong zone: tất định theo thứ tự nhân viên, mỗi bàn cách nhau 2 ô. */
export function deskCell(layout: ZoneLayout, deskIndex: number): { col: number; row: number } {
  return {
    col: layout.x + 1 + (deskIndex % DESKS_PER_ROW) * 2,
    row: layout.y + 2 + Math.floor(deskIndex / DESKS_PER_ROW) * 2,
  };
}

/** Chiều rộng/cao tối thiểu của zone; zone cao thêm khi số nhân viên vượt sức chứa. */
export const ZONE_MIN_COLS = DESKS_PER_ROW * 2 + 1;
export const ZONE_MIN_ROWS = 6;

export function zoneRowsFor(employeeCount: number): number {
  const deskRows = Math.max(1, Math.ceil(employeeCount / DESKS_PER_ROW));
  return Math.max(ZONE_MIN_ROWS, 2 + deskRows * 2 + 1);
}

/**
 * Một "đường chạy" của nhân viên trên một task. Trạng thái hiển thị là kết quả gộp các track (nhân viên có nhiều task
 * thì ưu tiên `error_blocked` > `waiting_approval` > đang hoạt động > `completed`, cùng hạng thì theo sự kiện gần nhất).
 */
export const officeTrackStateSchema = z.enum([
  'working',
  'thinking',
  'communicating',
  'waiting_approval',
  'error_blocked',
  'completed',
]);
export type OfficeTrackState = z.infer<typeof officeTrackStateSchema>;

export const officeTrackSchema = z.object({
  taskId: z.string(),
  runId: z.string().nullable(),
  state: officeTrackStateSchema,
  tool: z.string().nullable(),
  progress: z.number().min(0).max(100).nullable(),
  /** Lý do khi `error_blocked` (mã lỗi của run hoặc `blockedReason` của task). */
  reason: z.string().nullable(),
  /** `seq` của sự kiện gần nhất làm đổi track; cũng là nguồn của trạng thái nếu track thắng. */
  seq: z.number().int(),
});
export type OfficeTrack = z.infer<typeof officeTrackSchema>;

/** Trạng thái nội bộ của reducer cho một nhân viên (lưu ở `employee_status.tracks`). */
export type OfficeEmployeeState = {
  employeeId: string;
  suspended: boolean;
  /** Theo `taskId`. */
  tracks: Record<string, OfficeTrack>;
  /** `seq` lớn nhất đã áp: bỏ qua sự kiện giao lại (relay giao ít nhất một lần). */
  appliedSeq: number;
  /** Hạng cao nhất đang hiển thị. */
  state: EmployeeState;
  currentTaskId: string | null;
  currentTool: string | null;
  progress: number | null;
  /** `seq` của sự kiện làm `state` hiện tại (SC-006). */
  sourceSeq: number;
};

export type EmployeeStatusChange = {
  employeeId: string;
  state: EmployeeState;
  previousState: EmployeeState;
  currentTaskId: string | null;
  currentTool: string | null;
  progress: number | null;
  sourceEvent: DomainEvent;
  /** Trạng thái đầy đủ sau khi áp, để engine lưu projection. */
  next: OfficeEmployeeState;
};

const money = z.object({ tokens: z.number(), costUsd: z.number() });

/** Employee Profile cho Virtual Office (FR-038). Mọi nội dung do AI sinh ra là văn bản thuần. */
export const employeeProfileViewSchema = z.object({
  employee: z.object({
    id: z.string(),
    name: z.string(),
    avatarKey: z.string(),
    position: z.string(),
    kind: employeeKindSchema,
    homeOrgUnitId: z.string(),
    status: employeeStatusSchema,
  }),
  status: z.object({
    state: employeeStateSchema,
    sourceEventSeq: z.number().int().nullable(),
    changedAt: z.string().nullable(),
  }),
  currentTask: z
    .object({
      id: z.string(),
      title: z.string(),
      status: z.string(),
      deadline: z.string(),
      isOverdue: z.boolean(),
      progress: z.number().min(0).max(100).nullable(),
    })
    .nullable(),
  currentTool: z.string().nullable(),
  recentMessages: z.array(
    z.object({
      id: z.string(),
      taskId: z.string(),
      taskTitle: z.string(),
      authorKind: z.enum(['human', 'ai']),
      authorId: z.string(),
      body: z.string(),
      createdAt: z.string(),
    }),
  ),
  latestResults: z.array(
    z.object({
      artifactId: z.string(),
      taskId: z.string(),
      taskTitle: z.string(),
      title: z.string(),
      kind: z.string(),
      createdAt: z.string(),
    }),
  ),
  reviewHistory: z.array(
    z.object({
      id: z.string(),
      taskId: z.string(),
      taskTitle: z.string(),
      stage: z.enum(['ai_review', 'human_approval']),
      decision: z.enum(['pass', 'rework', 'approve', 'reject']),
      reason: z.string(),
      decidedAt: z.string(),
    }),
  ),
  usage: z.object({ period: z.string(), month: money, total: money }),
  blockers: z.array(
    z.object({
      kind: z.enum(['blocked', 'waiting_approval', 'overdue']),
      taskId: z.string(),
      taskTitle: z.string(),
      reason: z.string(),
    }),
  ),
});
export type EmployeeProfileView = z.infer<typeof employeeProfileViewSchema>;

/** Số mục tối đa mỗi danh sách trong profile-view. */
export const PROFILE_VIEW_LIST_LIMIT = 5;
