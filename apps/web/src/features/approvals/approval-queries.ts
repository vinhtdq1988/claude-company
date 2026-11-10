import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  ApprovalDecisionBody,
  ApprovalRequest,
  ApprovalStatus,
  Page,
} from '@claude-company/contracts';
import { api } from '../../lib/api';
import { queryClient, queryKeys } from '../../lib/query';
import { realtime } from '../../realtime/socket';

export const useApprovals = (companyId: string, status: ApprovalStatus) =>
  useQuery({
    queryKey: [...queryKeys.approvals(companyId), status],
    queryFn: () =>
      api.get<Page<ApprovalRequest>>(`/companies/${companyId}/approvals`, {
        query: { status, limit: 200 },
      }),
  });

export const decideApproval = (companyId: string, id: string, body: ApprovalDecisionBody) =>
  api.post<ApprovalRequest>(`/companies/${companyId}/approvals/${id}/decision`, body);

/** Quyết định làm đổi cả hộp phê duyệt lẫn trạng thái task và lịch sử thực thi. */
export const invalidateApprovals = (companyId: string) =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.approvals(companyId) }),
    queryClient.invalidateQueries({ queryKey: queryKeys.tasks(companyId) }),
  ]);

/** Nghe realtime: `approval.requested`/`approval.decided` (room người dùng) làm mới hộp phê duyệt. */
export function useApprovalRealtime(companyId: string): void {
  useEffect(
    () =>
      realtime.onEnvelope((envelope) => {
        if (envelope.type === 'approval.requested' || envelope.type === 'approval.decided') {
          void invalidateApprovals(companyId);
        }
      }),
    [companyId],
  );
}
