import { useQuery } from '@tanstack/react-query';
import type {
  EmployeeFilter,
  EmployeeProfile,
  ModelInfo,
  RoleTemplate,
  Workspace,
  WorkspaceSettings,
} from '@claude-company/contracts';
import { api } from '../../lib/api';
import { queryClient, queryKeys } from '../../lib/query';

export const useEmployees = (companyId: string, filter: EmployeeFilter = {}) =>
  useQuery({
    queryKey: [...queryKeys.employees(companyId), filter],
    queryFn: () =>
      api.get<EmployeeProfile[]>(`/companies/${companyId}/employees`, {
        query: { ...filter },
      }),
  });

export const useEmployee = (companyId: string, id: string) =>
  useQuery({
    queryKey: queryKeys.employee(companyId, id),
    queryFn: () => api.get<EmployeeProfile>(`/companies/${companyId}/employees/${id}`),
  });

export const useRoleTemplates = () =>
  useQuery({
    queryKey: queryKeys.roleTemplates,
    queryFn: () => api.get<RoleTemplate[]>('/role-templates'),
    staleTime: 5 * 60_000,
  });

export const useModels = () =>
  useQuery({
    queryKey: queryKeys.models,
    queryFn: () => api.get<ModelInfo[]>('/models'),
    staleTime: 5 * 60_000,
  });

export const useWorkspaces = (companyId: string) =>
  useQuery({
    queryKey: queryKeys.workspaces(companyId),
    queryFn: () => api.get<Workspace[]>(`/companies/${companyId}/workspaces`),
  });

export const useWorkspaceSettings = (companyId: string) =>
  useQuery({
    queryKey: queryKeys.workspaceSettings(companyId),
    queryFn: () => api.get<WorkspaceSettings>(`/companies/${companyId}/workspaces/settings`),
  });

/** Thay đổi nhân viên ảnh hưởng danh sách, hồ sơ và số nhân viên/team trong sơ đồ tổ chức. */
export const invalidateEmployees = async (companyId: string) => {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.employees(companyId) }),
    queryClient.invalidateQueries({ queryKey: queryKeys.orgChart(companyId) }),
  ]);
};
