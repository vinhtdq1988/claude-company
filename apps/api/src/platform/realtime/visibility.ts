import type { ManagedScope } from '@claude-company/contracts';
import type { Visibility } from '../events/envelope-mapper';

/** Phạm vi của một socket: người nhận và những gì họ được quản lý. */
export type SocketViewer = { memberId: string; scope: ManagedScope };

/**
 * Server lọc envelope trên room công ty theo ManagedScope của từng socket (FR-005, FR-028);
 * client không tham gia cưỡng chế. CEO (`companyWide`) thấy tất cả.
 */
export function canView(viewer: SocketViewer, visibility: Visibility): boolean {
  if (visibility.kind === 'all') return true;
  if (viewer.scope.companyWide) return true;
  switch (visibility.kind) {
    case 'employee':
      return viewer.scope.employeeIds.includes(visibility.employeeId);
    case 'assignee':
      switch (visibility.assigneeKind) {
        case 'ai_employee':
          return viewer.scope.employeeIds.includes(visibility.assigneeId);
        case 'team':
          return viewer.scope.teamIds.includes(visibility.assigneeId);
        case 'org_unit':
          return viewer.scope.orgUnitIds.includes(visibility.assigneeId);
      }
  }
}

/** Sự kiện làm đổi phạm vi quản lý, cần tính lại scope của socket trước khi lọc tiếp. */
export const SCOPE_CHANGING_PREFIXES: readonly string[] = [
  'org_unit.',
  'team.',
  'management.',
  'employee.',
  'human_member.',
];

export function changesScope(eventType: string): boolean {
  return SCOPE_CHANGING_PREFIXES.some((p) => eventType.startsWith(p));
}
