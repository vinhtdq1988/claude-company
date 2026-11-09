import { describe, expect, it } from 'vitest';
import type { OrgChart, OrgChartNode } from '@claude-company/contracts';
import {
  blockerLines,
  findTeam,
  findUnit,
  flattenUnits,
  moveWithin,
  sortOrderChanges,
  unitSiblings,
} from '../src/features/org/org-tree';

const node = (id: string, over: Partial<OrgChartNode> = {}): OrgChartNode => ({
  id,
  kind: 'department',
  parentId: null,
  name: id,
  sortOrder: 0,
  archivedAt: null,
  managerMemberId: null,
  employeeCount: 0,
  teams: [],
  children: [],
  ...over,
});

const chart: OrgChart = {
  companyId: 'c',
  roots: [
    node('eng', {
      kind: 'division',
      sortOrder: 0,
      children: [
        node('backend', { parentId: 'eng', sortOrder: 0 }),
        node('data', {
          parentId: 'eng',
          sortOrder: 1,
          teams: [
            {
              id: 'ml',
              orgUnitId: 'data',
              name: 'ML',
              sortOrder: 0,
              archivedAt: null,
              managerMemberId: null,
              employeeCount: 2,
              members: [],
            },
          ],
        }),
      ],
    }),
    node('qa', { sortOrder: 1 }),
  ],
};

describe('org-tree', () => {
  it('flattenUnits duyệt cây theo thứ tự hiển thị', () => {
    expect(flattenUnits(chart.roots).map((n) => n.id)).toEqual(['eng', 'backend', 'data', 'qa']);
  });

  it('findUnit và findTeam tìm ở mọi cấp', () => {
    expect(findUnit(chart, 'data')?.name).toBe('data');
    expect(findUnit(chart, 'khong-co')).toBeUndefined();
    expect(findTeam(chart, 'ml')?.unit.id).toBe('data');
  });

  it('unitSiblings trả danh sách cùng cấp, gồm cả gốc', () => {
    expect(unitSiblings(chart, 'qa').map((n) => n.id)).toEqual(['eng', 'qa']);
    expect(unitSiblings(chart, 'data').map((n) => n.id)).toEqual(['backend', 'data']);
    expect(unitSiblings(chart, 'khong-co')).toEqual([]);
  });

  it('moveWithin dời một bước và từ chối khi ở biên', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(moveWithin(items, 'b', -1)?.map((i) => i.id)).toEqual(['b', 'a', 'c']);
    expect(moveWithin(items, 'b', 1)?.map((i) => i.id)).toEqual(['a', 'c', 'b']);
    expect(moveWithin(items, 'a', -1)).toBeNull();
    expect(moveWithin(items, 'c', 1)).toBeNull();
    expect(moveWithin(items, 'x', 1)).toBeNull();
    expect(items.map((i) => i.id)).toEqual(['a', 'b', 'c']); // không đổi dữ liệu gốc
  });

  it('sortOrderChanges chỉ trả phần tử lệch thứ tự và đánh số lại từ 0', () => {
    const ordered = [
      { id: 'b', sortOrder: 1 },
      { id: 'a', sortOrder: 0 },
      { id: 'c', sortOrder: 2 },
    ];
    expect(sortOrderChanges(ordered)).toEqual([
      { id: 'b', sortOrder: 0 },
      { id: 'a', sortOrder: 1 },
    ]);
    expect(sortOrderChanges([{ id: 'x', sortOrder: 7 }])).toEqual([{ id: 'x', sortOrder: 0 }]);
  });

  it('blockerLines mô tả cản trở khi xóa (US1-AS4), bỏ qua mục rỗng', () => {
    const lines = blockerLines({
      childUnits: [{ id: '1', name: 'Backend' }],
      teams: [],
      employees: [
        { id: '2', name: 'An' },
        { id: '3', name: 'Bình' },
      ],
      tasks: [{ id: '4', title: 'Viết báo cáo' }],
      members: [
        { kind: 'human', id: '5' },
        { kind: 'ai', id: '6' },
      ],
    });
    expect(lines).toEqual([
      'Đơn vị con: Backend',
      'Nhân viên: An, Bình',
      'Task chưa kết thúc: Viết báo cáo',
      'Thành viên: 2',
    ]);
    expect(blockerLines({})).toEqual([]);
  });
});
