import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AgentRunSummary, AgentRunView, Page } from '@claude-company/contracts';
import { api } from '../../lib/api';
import { queryClient, queryKeys } from '../../lib/query';
import { realtime } from '../../realtime/socket';

export type RunFilter = { taskId?: string; employeeId?: string };

export const useRuns = (companyId: string, filter: RunFilter = {}) =>
  useQuery({
    queryKey: [...queryKeys.runs(companyId), 'list', filter],
    queryFn: () =>
      api.get<Page<AgentRunSummary>>(`/companies/${companyId}/runs`, {
        query: { ...filter, limit: 200 },
      }),
  });

export const useRun = (companyId: string, runId: string) =>
  useQuery({
    queryKey: queryKeys.run(companyId, runId),
    queryFn: () => api.get<AgentRunView>(`/companies/${companyId}/runs/${runId}`),
  });

export const invalidateRuns = (companyId: string) =>
  queryClient.invalidateQueries({ queryKey: queryKeys.runs(companyId) });

/** Nghe realtime: bước mới của run (`run.step_appended`) hoặc chi phí mới (`usage.updated`) làm mới lịch sử. */
export function useRunRealtime(companyId: string): void {
  useEffect(
    () =>
      realtime.onEnvelope((envelope) => {
        if (envelope.type === 'run.step_appended' || envelope.type === 'usage.updated') {
          void invalidateRuns(companyId);
        }
      }),
    [companyId],
  );
}
