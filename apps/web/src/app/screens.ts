import type { MessageKey } from '../i18n/vi';

/**
 * Bảng màn hình khai báo sẵn cho toàn bộ ứng dụng. `module` là đường dẫn file (không đuôi) dưới `src/`,
 * nạp lười qua `import.meta.glob`; chưa có file thì router hiển thị "Chưa triển khai",
 * nên story sau chỉ cần thêm file `*Page.tsx` mà không sửa router.
 */
export type Screen = {
  /** Đường dẫn con dưới `/c/:companyId/`. */
  path: string;
  labelKey: MessageKey;
  module: string;
};

export const COMPANY_SCREENS: readonly Screen[] = [
  { path: 'org', labelKey: 'nav.org', module: 'features/org/OrgChartPage' },
  { path: 'members', labelKey: 'nav.members', module: 'features/org/MembersPage' },
  { path: 'employees', labelKey: 'nav.employees', module: 'features/employees/EmployeesPage' },
  { path: 'workspaces', labelKey: 'nav.workspaces', module: 'features/employees/WorkspacesPage' },
  { path: 'tasks', labelKey: 'nav.tasks', module: 'features/tasks/TaskCenterPage' },
  { path: 'approvals', labelKey: 'nav.approvals', module: 'features/approvals/ApprovalsPage' },
  { path: 'office', labelKey: 'nav.office', module: 'office/VirtualOfficePage' },
  { path: 'dashboard', labelKey: 'nav.dashboard', module: 'features/dashboard/DashboardPage' },
  { path: 'budget', labelKey: 'nav.budget', module: 'features/budget/BudgetSettingsPage' },
  { path: 'history', labelKey: 'nav.history', module: 'features/history/HistoryPage' },
  {
    path: 'achievements',
    labelKey: 'nav.achievements',
    module: 'features/milestones/MilestonesPage',
  },
];

/** Màn hình chưa thuộc công ty nào. */
export const ONBOARDING_SCREEN = {
  path: 'onboarding',
  labelKey: 'nav.onboarding',
  module: 'features/org/OnboardingPage',
} as const;
export const LOGIN_SCREEN = { path: 'login', module: 'features/auth/LoginPage' } as const;
export const REGISTER_SCREEN = { path: 'register', module: 'features/auth/RegisterPage' } as const;
