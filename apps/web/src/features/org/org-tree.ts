import type { OrgChart, OrgChartNode, OrgChartTeam } from '@claude-company/contracts';
import { t, type MessageKey } from '../../i18n';

/** Đối tượng đang được chọn để chỉnh sửa trong sơ đồ. */
export type Selection = { kind: 'org_unit' | 'team'; id: string };

export function flattenUnits(nodes: OrgChartNode[]): OrgChartNode[] {
  return nodes.flatMap((n) => [n, ...flattenUnits(n.children)]);
}

export function findUnit(chart: OrgChart, id: string): OrgChartNode | undefined {
  return flattenUnits(chart.roots).find((n) => n.id === id);
}

export function findTeam(
  chart: OrgChart,
  id: string,
): { team: OrgChartTeam; unit: OrgChartNode } | undefined {
  for (const unit of flattenUnits(chart.roots)) {
    const team = unit.teams.find((x) => x.id === id);
    if (team) return { team, unit };
  }
  return undefined;
}

/** Danh sách anh em cùng cấp (cùng parent) chứa đơn vị `id`, theo thứ tự hiển thị. */
export function unitSiblings(chart: OrgChart, id: string): OrgChartNode[] {
  if (chart.roots.some((n) => n.id === id)) return chart.roots;
  return flattenUnits(chart.roots).find((n) => n.children.some((c) => c.id === id))?.children ?? [];
}

/**
 * Thứ tự mới sau khi dời phần tử `id` một bước (`-1` lên, `1` xuống).
 * Trả về `null` nếu không dời được (đã ở đầu/cuối hoặc không có trong danh sách).
 */
export function moveWithin<T extends { id: string }>(
  items: T[],
  id: string,
  direction: -1 | 1,
): T[] | null {
  const from = items.findIndex((i) => i.id === id);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= items.length) return null;
  const next = [...items];
  const [moved] = next.splice(from, 1);
  if (!moved) return null;
  next.splice(to, 0, moved);
  return next;
}

/** Các thay đổi `sortOrder` cần gửi để danh sách khớp thứ tự mới (đánh số lại từ 0). */
export function sortOrderChanges<T extends { id: string; sortOrder: number }>(
  ordered: T[],
): Array<{ id: string; sortOrder: number }> {
  return ordered.flatMap((item, index) =>
    item.sortOrder === index ? [] : [{ id: item.id, sortOrder: index }],
  );
}

const BLOCKER_LABELS: Array<{
  field: string;
  label: MessageKey;
  text: 'name' | 'title' | 'count';
}> = [
  { field: 'childUnits', label: 'org.blockers.childUnits', text: 'name' },
  { field: 'teams', label: 'org.blockers.teams', text: 'name' },
  { field: 'employees', label: 'org.blockers.employees', text: 'name' },
  { field: 'tasks', label: 'org.blockers.tasks', text: 'title' },
  { field: 'members', label: 'org.blockers.members', text: 'count' },
];

/**
 * Chuyển `details` của lỗi 409 (`ORG_UNIT_NOT_EMPTY`, `TEAM_NOT_EMPTY`) thành các dòng dễ đọc,
 * ví dụ "Đơn vị con: Backend, Data" (US1-AS4).
 */
export function blockerLines(details: Record<string, unknown>): string[] {
  return BLOCKER_LABELS.flatMap(({ field, label, text }) => {
    const list = details[field];
    if (!Array.isArray(list) || list.length === 0) return [];
    // Thành viên team chỉ có id nên hiển thị số lượng thay vì tên.
    if (text === 'count') return [`${t(label)}: ${list.length}`];
    const names = list.map((item) => {
      const record = item as Record<string, unknown>;
      return String(record[text] ?? record.id ?? '');
    });
    return [`${t(label)}: ${names.join(', ')}`];
  });
}
