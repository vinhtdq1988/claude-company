import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  DomainError,
  type EmployeeEngine,
  type HumanMember,
  type OrganizationEngine,
  type OrgChartNode,
  type RequestContext,
  type RoutedNotification,
  type TaskEngine,
} from '@claude-company/contracts';
import { EMPLOYEE_ENGINE, ORGANIZATION_ENGINE, TASK_ENGINE } from '../../platform/engine-tokens';

/**
 * Người nhận hợp lệ: ứng viên nếu còn hoạt động, ngược lại CEO đầu tiên còn hoạt động
 * ("phạm vi không có manager hoặc người nhận bị vô hiệu thì gửi CEO", FR-041).
 */
export function pickRecipient(
  candidate: string | null | undefined,
  members: readonly Pick<HumanMember, 'id' | 'role' | 'disabledAt'>[],
): string {
  const active = members.filter((m) => m.disabledAt === null);
  if (candidate && active.some((m) => m.id === candidate)) return candidate;
  const ceo = active.find((m) => m.role === 'ceo');
  if (!ceo) throw new DomainError('INTERNAL', 'Công ty không có CEO đang hoạt động để nhận thông báo');
  return ceo.id;
}

function findNode(nodes: readonly OrgChartNode[], id: string): OrgChartNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findNode(node.children, id);
    if (found) return found;
  }
  return undefined;
}

/**
 * Chọn người nhận thông báo chỉ qua interface engine. `task_completed`, `task_error`, `task_overdue`,
 * `budget_blocked`, `escalation` → người giao task; `approval_needed` → người duyệt;
 * `overload_warning` → người thật cuối chuỗi quản lý; `budget_warning` → manager của phạm vi.
 */
@Injectable()
export class NotificationRouter {
  constructor(private readonly moduleRef: ModuleRef) {}

  private get tasks(): TaskEngine {
    return this.moduleRef.get<TaskEngine>(TASK_ENGINE, { strict: false });
  }
  private get employees(): EmployeeEngine {
    return this.moduleRef.get<EmployeeEngine>(EMPLOYEE_ENGINE, { strict: false });
  }
  private get organization(): OrganizationEngine {
    return this.moduleRef.get<OrganizationEngine>(ORGANIZATION_ENGINE, { strict: false });
  }

  async resolveRecipient(ctx: RequestContext, n: RoutedNotification): Promise<string> {
    const members = await this.employees.listHumanMembers(ctx);
    return pickRecipient(await this.candidate(ctx, n, members), members);
  }

  private async candidate(
    ctx: RequestContext,
    n: RoutedNotification,
    members: readonly HumanMember[],
  ): Promise<string | undefined> {
    switch (n.type) {
      case 'task_completed':
      case 'task_error':
      case 'task_overdue':
      case 'budget_blocked':
      case 'escalation': {
        if (!n.taskId) return undefined;
        return (await this.tasks.get(ctx, n.taskId)).createdByMemberId;
      }
      case 'approval_needed':
        return n.approverMemberId;
      case 'overload_warning':
        return n.employeeId ? this.employees.resolveAccountableHuman(ctx, n.employeeId) : undefined;
      case 'budget_warning':
        return this.budgetWarningRecipient(ctx, n, members);
    }
  }

  private async budgetWarningRecipient(
    ctx: RequestContext,
    n: RoutedNotification,
    members: readonly HumanMember[],
  ): Promise<string | undefined> {
    const scope = n.scope;
    if (!scope || scope.kind === 'company') return members.find((m) => m.role === 'ceo')?.id;
    if (scope.kind === 'ai_employee' && scope.id) {
      return this.employees.resolveAccountableHuman(ctx, scope.id);
    }
    if (scope.kind === 'org_unit' && scope.id) {
      const chart = await this.organization.getOrgChart(ctx);
      return findNode(chart.roots, scope.id)?.managerMemberId ?? undefined;
    }
    if (scope.kind === 'team' && scope.id) {
      const chart = await this.organization.getOrgChart(ctx);
      const walk = (nodes: readonly OrgChartNode[]): string | null | undefined => {
        for (const node of nodes) {
          const team = node.teams.find((t) => t.id === scope.id);
          if (team) return team.managerMemberId ?? node.managerMemberId;
          const inner = walk(node.children);
          if (inner !== undefined) return inner;
        }
        return undefined;
      };
      return walk(chart.roots) ?? undefined;
    }
    return undefined;
  }
}
