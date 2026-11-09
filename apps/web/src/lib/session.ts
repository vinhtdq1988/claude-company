import { useQuery } from '@tanstack/react-query';
import type { Membership } from '@claude-company/contracts';
import { meQuery } from './query';

/** Membership của người đang đăng nhập trong công ty; dùng để ẩn thao tác chỉ CEO (server vẫn cưỡng chế). */
export function useMyMembership(companyId: string): Membership | undefined {
  const { data: me } = useQuery(meQuery);
  return me?.memberships.find((m) => m.companyId === companyId);
}
