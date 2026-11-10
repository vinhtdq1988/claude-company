import { useQuery } from '@tanstack/react-query';
import type {
  BudgetPolicy,
  BudgetScopeKind,
  Dashboard,
  PutBudgetPolicyBody,
  UsageSummary,
} from '@claude-company/contracts';
import { api } from '../../lib/api';
import { queryClient, queryKeys } from '../../lib/query';

export const useBudgetPolicy = (companyId: string, kind: BudgetScopeKind, id: string) =>
  useQuery({
    queryKey: queryKeys.budgetPolicy(companyId, kind, id),
    queryFn: () => api.get<BudgetPolicy>(`/companies/${companyId}/budget-policies/${kind}/${id}`),
  });

export const saveBudgetPolicy = (
  companyId: string,
  kind: BudgetScopeKind,
  id: string,
  body: PutBudgetPolicyBody,
) => api.put<BudgetPolicy>(`/companies/${companyId}/budget-policies/${kind}/${id}`, body);

export type UsageFilter = {
  groupBy?: 'employee' | 'task' | 'org_unit';
  period?: string;
  orgUnitId?: string;
  employeeId?: string;
  taskId?: string;
};

export const useUsage = (companyId: string, filter: UsageFilter = {}, enabled = true) =>
  useQuery({
    queryKey: [...queryKeys.usage(companyId), filter],
    queryFn: () => api.get<UsageSummary>(`/companies/${companyId}/usage`, { query: { ...filter } }),
    enabled,
  });

export const useDashboard = (companyId: string, orgUnitId?: string) =>
  useQuery({
    queryKey: queryKeys.dashboard(companyId, orgUnitId ?? null),
    queryFn: () =>
      api.get<Dashboard>(`/companies/${companyId}/dashboard`, { query: { orgUnitId } }),
    // Số liệu đổi theo task và run: làm mới định kỳ thay vì chờ người dùng tải lại.
    refetchInterval: 30_000,
  });

/** Đổi chính sách ảnh hưởng chính sách, usage và Dashboard. */
export const invalidateBudget = async (companyId: string) => {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.budgetPolicies(companyId) }),
    queryClient.invalidateQueries({ queryKey: queryKeys.usage(companyId) }),
    queryClient.invalidateQueries({ queryKey: ['company', companyId, 'dashboard'] }),
  ]);
};
