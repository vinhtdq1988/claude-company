import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Milestone, MilestoneKey } from '@claude-company/contracts';
import { api } from '../../lib/api';
import { queryClient, queryKeys } from '../../lib/query';
import { realtime } from '../../realtime/socket';
import { milestoneKeyOf } from './milestone-model';

export const useMilestones = (companyId: string) =>
  useQuery({
    queryKey: queryKeys.milestones(companyId),
    queryFn: () => api.get<Milestone[]>(`/companies/${companyId}/milestones`),
  });

/**
 * Nghe realtime `milestone.achieved`: làm mới danh sách và trả Achievement vừa đạt gần nhất để hiển thị thông báo.
 * Dùng ở Layout nên thông báo hiện trên mọi màn hình. Danh sách trên server là nguồn sự thật, sự kiện chỉ là tín hiệu.
 */
export function useMilestoneRealtime(companyId: string | undefined): {
  latest: MilestoneKey | null;
  dismiss: () => void;
} {
  const [latest, setLatest] = useState<MilestoneKey | null>(null);
  useEffect(() => {
    if (!companyId) return;
    return realtime.onEnvelope((envelope) => {
      if (envelope.type !== 'milestone.achieved') return;
      void queryClient.invalidateQueries({ queryKey: queryKeys.milestones(companyId) });
      setLatest(milestoneKeyOf(envelope.payload));
    });
  }, [companyId]);
  return { latest, dismiss: () => setLatest(null) };
}
