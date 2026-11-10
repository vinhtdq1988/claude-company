import {
  ZONE_MIN_COLS,
  ZONE_MIN_ROWS,
  zoneRowsFor,
  type OfficeZoneKind,
  type ZoneLayout,
} from '@claude-company/contracts';

/** Số zone trên mỗi dải ngang của văn phòng. */
export const ZONES_PER_BAND = 3;
/** Khoảng trống (ô) giữa các zone. */
export const ZONE_GAP = 1;

export type ZoneSlot = {
  /** Khóa ổn định: `ceo_office`, `break_room` hoặc `org_unit:<id>`. */
  key: string;
  kind: OfficeZoneKind;
  name: string;
  orgUnitId: string | null;
  /** Số nhân viên của department (quyết định chiều cao zone). */
  employeeCount: number;
};

export type PlacedZone = ZoneSlot & { layout: ZoneLayout };

/**
 * Bố cục tất định (FR-034): CEO Office đứng đầu, kế đó mỗi department một zone theo thứ tự đã cho, Break Room cuối.
 * Các zone xếp lần lượt thành từng dải `ZONES_PER_BAND` zone; chiều cao dải là zone cao nhất trong dải.
 * Cùng đầu vào luôn cho cùng kết quả (không phụ thuộc thời gian hay thứ tự thêm dữ liệu).
 */
export function placeZones(departments: ZoneSlot[]): PlacedZone[] {
  const ceo: ZoneSlot = {
    key: 'ceo_office',
    kind: 'ceo_office',
    name: 'CEO Office',
    orgUnitId: null,
    employeeCount: 0,
  };
  const breakRoom: ZoneSlot = {
    key: 'break_room',
    kind: 'break_room',
    name: 'Break Room',
    orgUnitId: null,
    employeeCount: 0,
  };
  const slots = [ceo, ...departments, breakRoom];
  const rowsOf = (slot: ZoneSlot) =>
    slot.kind === 'department' ? zoneRowsFor(slot.employeeCount) : ZONE_MIN_ROWS;

  const placed: PlacedZone[] = [];
  let bandY = 0;
  for (let start = 0; start < slots.length; start += ZONES_PER_BAND) {
    const band = slots.slice(start, start + ZONES_PER_BAND);
    band.forEach((slot, i) => {
      placed.push({
        ...slot,
        layout: {
          x: i * (ZONE_MIN_COLS + ZONE_GAP),
          y: bandY,
          cols: ZONE_MIN_COLS,
          rows: rowsOf(slot),
        },
      });
    });
    bandY += Math.max(...band.map(rowsOf)) + ZONE_GAP;
  }
  return placed;
}

/**
 * Bàn của từng nhân viên: thứ tự tạo (UUIDv7 tăng dần theo thời gian) trong department "nhà", nên cùng một dữ liệu
 * luôn cho cùng vị trí và người xem nào cũng thấy một bố cục.
 */
export function assignDesks(
  employees: ReadonlyArray<{ id: string; homeOrgUnitId: string }>,
): Map<string, { orgUnitId: string; deskIndex: number }> {
  const next = new Map<string, number>();
  const result = new Map<string, { orgUnitId: string; deskIndex: number }>();
  for (const e of [...employees].sort((a, b) => a.id.localeCompare(b.id))) {
    const deskIndex = next.get(e.homeOrgUnitId) ?? 0;
    next.set(e.homeOrgUnitId, deskIndex + 1);
    result.set(e.id, { orgUnitId: e.homeOrgUnitId, deskIndex });
  }
  return result;
}
