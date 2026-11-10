import { deskCell, type OfficeSnapshot, type OfficeZone } from '@claude-company/contracts';

export type Placement = {
  employeeId: string;
  /** Ô (tile) của bàn làm việc. */
  desk: { col: number; row: number };
  /** Ô nhân vật đứng: bàn của mình, hoặc Break Room khi `state = break`. */
  stand: { col: number; row: number };
};

export type OfficeBounds = { cols: number; rows: number };

/** Kích thước lưới ô bao trọn mọi zone. */
export function officeBounds(zones: readonly OfficeZone[]): OfficeBounds {
  let cols = 1;
  let rows = 1;
  for (const z of zones) {
    cols = Math.max(cols, z.layout.x + z.layout.cols);
    rows = Math.max(rows, z.layout.y + z.layout.rows);
  }
  return { cols, rows };
}

/**
 * Vị trí từng nhân vật (thuần, tất định). Nhân viên `break` ra Break Room theo thứ tự `deskIndex` trong snapshot;
 * trạng thái khác đứng ở bàn của mình. Đây chỉ là cách trình bày: trạng thái luôn lấy từ server.
 */
export function placeEmployees(snapshot: OfficeSnapshot): Placement[] {
  const zones = new Map(snapshot.zones.map((z) => [z.id, z]));
  const breakRoom = snapshot.zones.find((z) => z.kind === 'break_room');
  const onBreak = snapshot.employees
    .filter((e) => e.state === 'break')
    .sort((a, b) => a.id.localeCompare(b.id));

  const placements: Placement[] = [];
  for (const e of snapshot.employees) {
    const zone = zones.get(e.zoneId);
    if (!zone) continue;
    const desk = deskCell(zone.layout, e.deskIndex);
    const breakIndex = onBreak.findIndex((b) => b.id === e.id);
    const stand = breakRoom && breakIndex >= 0 ? deskCell(breakRoom.layout, breakIndex) : desk;
    placements.push({ employeeId: e.id, desk, stand });
  }
  return placements;
}

/** Trạng thái có animation (chỉ khi thực sự đang hoạt động; còn lại đứng yên). */
export const ANIMATED_STATES: ReadonlySet<string> = new Set([
  'working',
  'thinking',
  'communicating',
  'waiting_approval',
  'error_blocked',
]);
