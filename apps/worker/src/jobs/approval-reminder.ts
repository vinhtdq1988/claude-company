import type { PermissionEngine, RequestContext } from '@claude-company/contracts';

export type ReminderReport = { companies: number; reminded: number };

/**
 * Nhắc người duyệt (T141): lần đầu sau 1 giờ, sau đó mỗi 24 giờ. Duyệt công ty qua
 * `PermissionEngine.listCompaniesWithPendingApprovals` (D3) rồi gọi `remindPendingApprovals` từng công ty.
 * KHÔNG BAO GIỜ tự duyệt hay tự từ chối: nhắc là việc duy nhất job này làm với yêu cầu đang chờ.
 */
export async function remindPendingApprovalsOnce(deps: {
  permissions: Pick<
    PermissionEngine,
    'listCompaniesWithPendingApprovals' | 'remindPendingApprovals'
  >;
  now?: () => Date;
}): Promise<ReminderReport> {
  const now = deps.now?.() ?? new Date();
  const companies = await deps.permissions.listCompaniesWithPendingApprovals();
  let reminded = 0;
  for (const companyId of companies) {
    const ctx: RequestContext = {
      companyId,
      actor: { kind: 'system' },
      traceId: `approval-reminder-${now.getTime()}`,
    };
    reminded += await deps.permissions.remindPendingApprovals(ctx, now);
  }
  return { companies: companies.length, reminded };
}
