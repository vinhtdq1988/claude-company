import { QueryClient } from '@tanstack/react-query';
import type { AuthSessionResponse } from '@claude-company/contracts';
import { api, ApiError } from './api';

/** Không retry lỗi 4xx (đã rõ nguyên nhân); retry tối đa 2 lần với lỗi mạng và 5xx. */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
        return failureCount < 2;
      },
    },
    mutations: { retry: false },
  },
});

export const queryKeys = {
  me: ['auth', 'me'] as const,
  company: (companyId: string) => ['company', companyId] as const,
  orgChart: (companyId: string) => ['company', companyId, 'org-chart'] as const,
  members: (companyId: string) => ['company', companyId, 'members'] as const,
  orgTemplates: ['org-templates'] as const,
  employees: (companyId: string) => ['company', companyId, 'employees'] as const,
  employee: (companyId: string, id: string) => ['company', companyId, 'employees', id] as const,
  workspaces: (companyId: string) => ['company', companyId, 'workspaces'] as const,
  workspaceSettings: (companyId: string) =>
    ['company', companyId, 'workspaces', 'settings'] as const,
  roleTemplates: ['role-templates'] as const,
  models: ['models'] as const,
  tasks: (companyId: string) => ['company', companyId, 'tasks'] as const,
  task: (companyId: string, id: string) => ['company', companyId, 'tasks', id] as const,
  taskMessages: (companyId: string, id: string) =>
    ['company', companyId, 'tasks', id, 'messages'] as const,
  taskActions: (companyId: string, id: string) =>
    ['company', companyId, 'tasks', id, 'executed-actions'] as const,
  notifications: (companyId: string) => ['company', companyId, 'notifications'] as const,
  approvals: (companyId: string) => ['company', companyId, 'approvals'] as const,
  officeSnapshot: (companyId: string) => ['company', companyId, 'office', 'snapshot'] as const,
  budgetPolicies: (companyId: string) => ['company', companyId, 'budget-policies'] as const,
  budgetPolicy: (companyId: string, kind: string, id: string) =>
    ['company', companyId, 'budget-policies', kind, id] as const,
  usage: (companyId: string) => ['company', companyId, 'usage'] as const,
  runs: (companyId: string) => ['company', companyId, 'runs'] as const,
  run: (companyId: string, id: string) => ['company', companyId, 'runs', id] as const,
  milestones: (companyId: string) => ['company', companyId, 'milestones'] as const,
  dashboard: (companyId: string, orgUnitId: string | null) =>
    ['company', companyId, 'dashboard', orgUnitId] as const,
  profileView: (companyId: string, employeeId: string) =>
    ['company', companyId, 'employees', employeeId, 'profile-view'] as const,
};

/** Tải phiên hiện tại và lưu CSRF token cho các request ghi. Trả null nếu chưa đăng nhập. */
export async function fetchMe(): Promise<AuthSessionResponse | null> {
  try {
    const me = await api.get<AuthSessionResponse>('/auth/me');
    api.setCsrfToken(me.csrfToken);
    return me;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      api.setCsrfToken(null);
      return null;
    }
    throw error;
  }
}

export const meQuery = { queryKey: queryKeys.me, queryFn: fetchMe, staleTime: 60_000 } as const;
