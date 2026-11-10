import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type {
  BudgetService,
  ConcurrencyLimit,
  EmployeeEngine,
  RequestContext,
  TaskEngine,
  TaskFilter,
} from '@claude-company/contracts';
import { BUDGET_SERVICE, EMPLOYEE_ENGINE, TASK_ENGINE } from '../../platform/engine-tokens';

/** Số nhân viên chờ tối đa xét lại mỗi lần một slot của scope được giải phóng. */
const WAITING_LIMIT = 50;

/**
 * Giới hạn `max_concurrent_tasks` theo scope company, org_unit, team (FR-031, US6): số task `in_progress` của
 * các AI Employee thuộc scope không vượt giới hạn, cộng thêm giới hạn riêng từng nhân viên của `getCapacity`.
 * Chỉ hỏi qua interface của Employee, Task và Budget; không đọc bảng của engine khác.
 */
@Injectable()
export class ScopeConcurrency {
  constructor(private readonly moduleRef: ModuleRef) {}

  private get tasks(): TaskEngine {
    return this.moduleRef.get<TaskEngine>(TASK_ENGINE, { strict: false });
  }
  private get employees(): EmployeeEngine {
    return this.moduleRef.get<EmployeeEngine>(EMPLOYEE_ENGINE, { strict: false });
  }
  private get budget(): BudgetService {
    return this.moduleRef.get<BudgetService>(BUDGET_SERVICE, { strict: false });
  }

  limitsOf(ctx: RequestContext, employeeId: string): Promise<ConcurrencyLimit[]> {
    return this.budget.getConcurrencyLimits(ctx, employeeId);
  }

  /** Slot còn trống theo giới hạn chặt nhất trong các scope; `Infinity` nếu không scope nào đặt giới hạn. */
  async freeSlots(ctx: RequestContext, limits: readonly ConcurrencyLimit[]): Promise<number> {
    let free = Number.POSITIVE_INFINITY;
    for (const limit of limits) {
      free = Math.min(free, limit.max - (await this.activeIn(ctx, limit)));
    }
    return free;
  }

  /** Task `in_progress` được giao cho AI Employee thuộc scope (dừng đếm khi đã đủ để kết luận hết slot). */
  async activeIn(ctx: RequestContext, limit: ConcurrencyLimit): Promise<number> {
    const filter = await this.memberFilter(ctx, limit);
    if (!filter) return 0;
    const page = await this.tasks.list(ctx, {
      ...filter,
      assigneeKind: 'ai_employee',
      statusIn: ['in_progress'],
      limit: Math.max(limit.max, 1),
    });
    return page.items.length;
  }

  /** Nhân viên trong scope đang có task `assigned` chờ slot, để lập lịch lại khi scope có slot trống. */
  async waitingEmployeeIds(ctx: RequestContext, limit: ConcurrencyLimit): Promise<string[]> {
    const filter = await this.memberFilter(ctx, limit);
    if (!filter) return [];
    const page = await this.tasks.list(ctx, {
      ...filter,
      assigneeKind: 'ai_employee',
      statusIn: ['assigned'],
      order: 'queue',
      limit: WAITING_LIMIT,
    });
    return [...new Set(page.items.map((t) => t.assigneeId))];
  }

  /** Bộ lọc task theo thành viên scope; `null` khi scope không có nhân viên nào. */
  private async memberFilter(
    ctx: RequestContext,
    limit: ConcurrencyLimit,
  ): Promise<Pick<TaskFilter, 'orgUnitId' | 'scope'> | null> {
    switch (limit.scopeKind) {
      case 'company':
        return {};
      case 'org_unit':
        return { orgUnitId: limit.scopeId };
      case 'team': {
        const members = await this.employees.list(ctx, { teamId: limit.scopeId });
        if (members.length === 0) return null;
        return {
          scope: {
            companyWide: false,
            orgUnitIds: [],
            teamIds: [],
            employeeIds: members.map((m) => m.id),
          },
        };
      }
    }
  }
}
