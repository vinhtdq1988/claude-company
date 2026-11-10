import { useQuery } from '@tanstack/react-query';
import type { EmployeeProfileView, OfficeSnapshot } from '@claude-company/contracts';
import { api } from '../lib/api';
import { queryKeys } from '../lib/query';

/** Snapshot luôn lấy mới từ server: `seq` của nó là mốc để subscribe tiếp (không dùng cache của React Query). */
export const fetchOfficeSnapshot = (companyId: string, signal?: AbortSignal) =>
  api.get<OfficeSnapshot>(`/companies/${companyId}/office/snapshot`, { signal });

export const useProfileView = (companyId: string, employeeId: string | null) =>
  useQuery({
    queryKey: queryKeys.profileView(companyId, employeeId ?? ''),
    queryFn: ({ signal }) =>
      api.get<EmployeeProfileView>(`/companies/${companyId}/employees/${employeeId}/profile-view`, {
        signal,
      }),
    enabled: employeeId !== null,
    // Dữ liệu đổi theo từng sự kiện: luôn tải lại khi mở.
    staleTime: 0,
  });
