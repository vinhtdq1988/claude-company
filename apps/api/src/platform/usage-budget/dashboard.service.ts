import { Inject, Injectable } from '@nestjs/common';
import {
  DomainError,
  type Dashboard,
  type DashboardQuery,
  type EmployeeEngine,
  type OrganizationEngine,
  type RequestContext,
  type TaskEngine,
} from '@claude-company/contracts';
import { EMPLOYEE_ENGINE, ORGANIZATION_ENGINE, TASK_ENGINE } from '../engine-tokens';
import { UsageBudgetService } from './budget.service';
import { findNode, subtreeIds } from './org-tree';

/**
 * Company Dashboard (FR-040, SC-008). Task và nhân viên lấy qua interface engine; token và chi phí lấy từ
 * `usage_ledger` qua `BudgetService.getUsage`, cùng một nguồn với tổng theo từng task nên hai con số khớp nhau.
 * Chỉ tổng hợp trong phạm vi quản lý của người xem.
 */
@Injectable()
export class DashboardService {
  constructor(
    @Inject(TASK_ENGINE) private readonly tasks: Pick<TaskEngine, 'getStats'>,
    @Inject(EMPLOYEE_ENGINE) private readonly employees: Pick<EmployeeEngine, 'list'>,
    @Inject(ORGANIZATION_ENGINE)
    private readonly organization: Pick<OrganizationEngine, 'getOrgChart' | 'resolveManagedScope'>,
    private readonly budget: UsageBudgetService,
  ) {}

  async get(ctx: RequestContext, query: DashboardQuery): Promise<Dashboard> {
    if (ctx.actor.kind !== 'human') {
      throw new DomainError('FORBIDDEN', 'Chỉ người dùng được truy cập qua API');
    }
    const scope = await this.organization.resolveManagedScope(ctx, ctx.actor.memberId);
    const orgUnitId = query.orgUnitId;

    // Tuần tự: trong một request, các lời gọi engine dùng chung transaction (một client pg).
    const stats = await this.tasks.getStats(ctx, { orgUnitId, scope });
    const usage = await this.budget.getUsage(ctx, { orgUnitId, scope, period: query.period });
    const allTime = await this.budget.getUsage(ctx, { orgUnitId, scope, period: 'all' });
    const totalEmployees = await this.countEmployees(ctx, orgUnitId, scope);

    return {
      orgUnitId: orgUnitId ?? null,
      period: usage.period,
      totalEmployees,
      activeTasks: stats.activeTasks,
      completedTasks: stats.completedTasks,
      // Chưa có task gốc hoàn thành thì "chưa có dữ liệu", không phải 0%.
      onTimeCompletionRate: stats.completedTasks === 0 ? null : stats.onTimeRate,
      tokens: usage.tokens,
      costUsd: usage.costUsd,
      allTime: { tokens: allTime.tokens, costUsd: allTime.costUsd },
    };
  }

  /** AI Employee chưa lưu trữ trong đơn vị (kể cả đơn vị con) và phạm vi quản lý của người xem. */
  private async countEmployees(
    ctx: RequestContext,
    orgUnitId: string | undefined,
    scope: Awaited<ReturnType<OrganizationEngine['resolveManagedScope']>>,
  ): Promise<number> {
    let unitIds: Set<string> | undefined;
    if (orgUnitId) {
      const chart = await this.organization.getOrgChart(ctx);
      const node = findNode(chart.roots, orgUnitId);
      unitIds = new Set(node ? subtreeIds(node) : []);
    }
    const visible = scope.companyWide ? undefined : new Set(scope.employeeIds);
    const all = await this.employees.list(ctx, {});
    return all.filter(
      (e) => (!unitIds || unitIds.has(e.homeOrgUnitId)) && (!visible || visible.has(e.id)),
    ).length;
  }
}
