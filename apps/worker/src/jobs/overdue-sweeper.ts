import type {
  OrchestrationEngine,
  PermissionEngine,
  RequestContext,
  TaskEngine,
} from '@claude-company/contracts';
import { remindPendingApprovalsOnce } from './approval-reminder';
import { recoverOnce } from './recovery-sweeper';

export type SweepReport = {
  overdue: number;
  companies: number;
  recovered: number;
  interrupted: number;
  /** Số yêu cầu phê duyệt đã nhắc người duyệt (không bao giờ tự duyệt). */
  reminded: number;
};

/**
 * Quét định kỳ: đặt cờ `is_overdue` cho task quá hạn (duyệt công ty qua `TaskEngine.listCompaniesWithOpenTasks`,
 * D3), phục hồi run chết và nhắc người duyệt các yêu cầu phê duyệt đang chờ. Thông báo `task_overdue` cho người giao task do Task Engine phát từ sự kiện
 * `task.overdue` (task-notifications.ts), nên sweeper không cần biết người nhận.
 */
export async function sweepOnce(deps: {
  tasks: Pick<TaskEngine, 'listCompaniesWithOpenTasks' | 'markOverdue'>;
  orchestration: Pick<OrchestrationEngine, 'recoverStaleRuns'>;
  permissions?: Pick<PermissionEngine, 'listCompaniesWithPendingApprovals' | 'remindPendingApprovals'>;
  now?: () => Date;
}): Promise<SweepReport> {
  const now = deps.now?.() ?? new Date();
  const companies = await deps.tasks.listCompaniesWithOpenTasks();
  let overdue = 0;
  for (const companyId of companies) {
    const ctx: RequestContext = { companyId, actor: { kind: 'system' }, traceId: `sweep-${now.getTime()}` };
    overdue += (await deps.tasks.markOverdue(ctx, now)).length;
  }
  const recovery = await recoverOnce({ orchestration: deps.orchestration });
  const reminders = deps.permissions
    ? await remindPendingApprovalsOnce({ permissions: deps.permissions, now: () => now })
    : { reminded: 0 };
  return {
    reminded: reminders.reminded,
    overdue,
    companies: companies.length,
    recovered: recovery.recovered,
    interrupted: recovery.failed,
  };
}
