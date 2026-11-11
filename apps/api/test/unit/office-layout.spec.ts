import { describe, expect, it } from 'vitest';
import { deskCell, ZONE_MIN_COLS, ZONE_MIN_ROWS, zoneRowsFor } from '@claude-company/contracts';
import {
  assignDesks,
  placeZones,
  type ZoneSlot,
} from '../../src/engines/office-simulation/office-layout';
import { layoutReasonOf } from '../../src/engines/office-simulation/office-simulation.module';

const dept = (id: string, employeeCount: number): ZoneSlot => ({
  key: `org_unit:${id}`,
  kind: 'department',
  name: id,
  orgUnitId: id,
  employeeCount,
});

describe('placeZones (FR-034)', () => {
  it('có CEO Office đầu, Break Room cuối và mỗi department một zone', () => {
    const zones = placeZones([dept('dev', 3), dept('ba', 2), dept('qa', 1)]);
    expect(zones.map((z) => z.kind)).toEqual([
      'ceo_office',
      'department',
      'department',
      'department',
      'break_room',
    ]);
    expect(zones.filter((z) => z.kind === 'department').map((z) => z.orgUnitId)).toEqual([
      'dev',
      'ba',
      'qa',
    ]);
  });

  it('tất định: cùng đầu vào cho cùng bố cục', () => {
    const input = [dept('dev', 3), dept('ba', 2)];
    expect(placeZones(input)).toEqual(placeZones(structuredClone(input)));
  });

  it('các zone không chồng nhau', () => {
    const zones = placeZones(Array.from({ length: 7 }, (_, i) => dept(`d${i}`, i * 3)));
    for (const [i, a] of zones.entries()) {
      for (const b of zones.slice(i + 1)) {
        const overlap =
          a.layout.x < b.layout.x + b.layout.cols &&
          b.layout.x < a.layout.x + a.layout.cols &&
          a.layout.y < b.layout.y + b.layout.rows &&
          b.layout.y < a.layout.y + a.layout.rows;
        expect(overlap, `${a.key} chồng ${b.key}`).toBe(false);
      }
    }
  });

  it('zone cao thêm khi nhiều nhân viên hơn sức chứa mặc định', () => {
    const [, small, big] = placeZones([dept('a', 2), dept('b', 20)]);
    expect(small?.layout.rows).toBe(ZONE_MIN_ROWS);
    expect(big?.layout.rows).toBe(zoneRowsFor(20));
    expect(big?.layout.rows).toBeGreaterThan(ZONE_MIN_ROWS);
    expect(big?.layout.cols).toBe(ZONE_MIN_COLS);
  });

  it('mọi bàn của nhân viên nằm trong zone của họ', () => {
    const [, zone] = placeZones([dept('a', 13)]);
    for (let i = 0; i < 13; i += 1) {
      const { col, row } = deskCell(zone!.layout, i);
      expect(col).toBeGreaterThanOrEqual(zone!.layout.x);
      expect(col).toBeLessThan(zone!.layout.x + zone!.layout.cols);
      expect(row).toBeGreaterThanOrEqual(zone!.layout.y);
      expect(row).toBeLessThan(zone!.layout.y + zone!.layout.rows);
    }
  });
});

describe('CEO Office cho nhân viên không có đơn vị nhà (CEO AI Assistant, FR-035)', () => {
  it('layout ceo_office đủ ô cho số bàn (tối thiểu 1) và tất định', () => {
    for (const desks of [0, 1, 4, 5, 13]) {
      const [ceo] = placeZones([dept('dev', 2)], desks);
      expect(ceo?.kind).toBe('ceo_office');
      expect(ceo?.layout.rows).toBe(zoneRowsFor(desks));
      expect(ceo?.layout.rows).toBeGreaterThanOrEqual(ZONE_MIN_ROWS);
      for (let i = 0; i < Math.max(desks, 1); i += 1) {
        const { col, row } = deskCell(ceo!.layout, i);
        expect(col).toBeGreaterThanOrEqual(ceo!.layout.x);
        expect(col).toBeLessThan(ceo!.layout.x + ceo!.layout.cols);
        expect(row).toBeGreaterThanOrEqual(ceo!.layout.y);
        expect(row).toBeLessThan(ceo!.layout.y + ceo!.layout.rows);
      }
    }
    expect(placeZones([dept('dev', 2)], 3)).toEqual(placeZones([dept('dev', 2)], 3));
  });

  it('zone ceo_office cao thêm không làm các zone chồng nhau', () => {
    const zones = placeZones([dept('a', 3), dept('b', 3), dept('c', 3)], 20);
    for (const [i, a] of zones.entries()) {
      for (const b of zones.slice(i + 1)) {
        const overlap =
          a.layout.x < b.layout.x + b.layout.cols &&
          b.layout.x < a.layout.x + a.layout.cols &&
          a.layout.y < b.layout.y + b.layout.rows &&
          b.layout.y < a.layout.y + a.layout.rows;
        expect(overlap, `${a.key} chồng ${b.key}`).toBe(false);
      }
    }
  });

  it('assignDesks đặt nhân viên không có đơn vị nhà ở nhóm null theo thứ tự tạo', () => {
    const desks = assignDesks([
      { id: '0003', homeOrgUnitId: null },
      { id: '0001', homeOrgUnitId: 'dev' },
      { id: '0002', homeOrgUnitId: null },
    ]);
    expect(desks.get('0002')).toEqual({ orgUnitId: null, deskIndex: 0 });
    expect(desks.get('0003')).toEqual({ orgUnitId: null, deskIndex: 1 });
    expect(desks.get('0001')).toEqual({ orgUnitId: 'dev', deskIndex: 0 });
  });
});

describe('assignDesks', () => {
  it('bàn đánh số theo thứ tự tạo trong department "nhà", độc lập thứ tự đầu vào', () => {
    const list = [
      { id: '0003', homeOrgUnitId: 'dev' },
      { id: '0001', homeOrgUnitId: 'dev' },
      { id: '0002', homeOrgUnitId: 'ba' },
      { id: '0004', homeOrgUnitId: 'dev' },
    ];
    const a = assignDesks(list);
    const b = assignDesks([...list].reverse());
    expect(a).toEqual(b);
    expect(a.get('0001')).toEqual({ orgUnitId: 'dev', deskIndex: 0 });
    expect(a.get('0003')).toEqual({ orgUnitId: 'dev', deskIndex: 1 });
    expect(a.get('0004')).toEqual({ orgUnitId: 'dev', deskIndex: 2 });
    expect(a.get('0002')).toEqual({ orgUnitId: 'ba', deskIndex: 0 });
  });
});

describe('layoutReasonOf', () => {
  const ev = (type: string, payload: Record<string, unknown> = {}) => ({
    id: 'e',
    companyId: 'c',
    seq: 1,
    type,
    aggregateKind: 'x',
    aggregateId: 'x',
    payload,
    occurredAt: '2026-11-10T00:00:00.000Z',
  });

  it('ánh xạ sự kiện cơ cấu sang lý do đổi bố cục', () => {
    expect(layoutReasonOf(ev('org_unit.created'))).toBe('org_unit_created');
    expect(layoutReasonOf(ev('org_unit.archived'))).toBe('org_unit_archived');
    expect(layoutReasonOf(ev('employee.created'))).toBe('employee_added');
    expect(layoutReasonOf(ev('employee.archived'))).toBe('employee_removed');
    expect(
      layoutReasonOf(ev('employee.updated', { homeOrgUnitId: 'a', previousHomeOrgUnitId: 'b' })),
    ).toBe('employee_moved');
    expect(
      layoutReasonOf(ev('employee.updated', { homeOrgUnitId: 'a', previousHomeOrgUnitId: 'a' })),
    ).toBe('employee_updated');
  });

  it('sự kiện khác (kể cả tạm ngưng) không đổi bố cục', () => {
    for (const type of ['employee.suspended', 'employee.resumed', 'task.created', 'run.started']) {
      expect(layoutReasonOf(ev(type))).toBeNull();
    }
  });
});
