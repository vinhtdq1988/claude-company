import { useQuery } from '@tanstack/react-query';
import type { Company, HumanMember, OrgChart, OrgTemplateSummary } from '@claude-company/contracts';
import { api } from '../../lib/api';
import { queryKeys } from '../../lib/query';

export const useOrgChart = (companyId: string) =>
  useQuery({
    queryKey: queryKeys.orgChart(companyId),
    queryFn: () => api.get<OrgChart>(`/companies/${companyId}/org-chart`),
  });

export const useCompany = (companyId: string) =>
  useQuery({
    queryKey: queryKeys.company(companyId),
    queryFn: () => api.get<Company>(`/companies/${companyId}`),
  });

export const useMembers = (companyId: string) =>
  useQuery({
    queryKey: queryKeys.members(companyId),
    queryFn: () => api.get<HumanMember[]>(`/companies/${companyId}/members`),
  });

export const useOrgTemplates = () =>
  useQuery({
    queryKey: queryKeys.orgTemplates,
    queryFn: () => api.get<OrgTemplateSummary[]>('/org-templates'),
  });
