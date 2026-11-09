import type { OrchestrationEngine, RequestContext, TaskEngine } from '@claude-company/contracts';

export type SweepReport = { overdue: number; companies: number; recovered: number; interrupted: number };

/**
 * Quét định kỳ: đặt cờ `is_overdue` cho task quá hạn (duyệt công ty qua `TaskEngine.listCompaniesWithOpenTasks`,
 * D3) và phục hồi run chết. Thông báo `task_overdue` cho người giao task do Task Engine phát từ sự kiện
 * `task.overdue` (task-notifications.ts), nên sweeper không cần biết người nhận.
 */
export async function sweepOnce(deps: {
  tasks: Pick<TaskEngine, 'listCompaniesWithOpenTasks' | 'markOverdue'>;
  orchestration: Pick<OrchestrationEngine, 'recoverStaleRuns'>;
  now?: () => Date;
}): Promise<SweepReport> {
  const now = deps.now?.() ?? new Date();
  const companies = await deps.tasks.listCompaniesWithOpenTasks();
  let overdue = 0;
  for (const companyId of companies) {
    const ctx: RequestContext = { companyId, actor: { kind: 'system' }, traceId: `sweep-${now.getTime()}` };
    overdue += (await deps.tasks.markOverdue(ctx, now)).length;
  }
  const recovery = await deps.orchestration.recoverStaleRuns();
  return {
    overdue,
    companies: companies.length,
    recovered: recovery.recovered,
    interrupted: recovery.failed,
  };
}
