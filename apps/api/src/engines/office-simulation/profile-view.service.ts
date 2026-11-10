import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  PROFILE_VIEW_LIST_LIMIT,
  type BudgetService,
  type CommunicationEngine,
  type EmployeeEngine,
  type EmployeeProfileView,
  type PermissionEngine,
  type RequestContext,
  type Task,
  type TaskDetail,
  type TaskEngine,
} from '@claude-company/contracts';
import { withTenant } from '@claude-company/db';
import {
  BUDGET_SERVICE,
  COMMUNICATION_ENGINE,
  EMPLOYEE_ENGINE,
  PERMISSION_ENGINE,
  TASK_ENGINE,
} from '../../platform/engine-tokens';
import { OfficeRepository } from './office.repository';

/** Số task gần nhất dùng để lấy tin nhắn, kết quả và lịch sử review. */
const RECENT_TASKS = 5;
const OPEN_BLOCKER_STATUSES = new Set(['completed', 'cancelled']);

const byNewest =
  <T>(get: (x: T) => string) =>
  (a: T, b: T) =>
    get(b).localeCompare(get(a));

/**
 * Employee Profile cho Virtual Office (T158, FR-038). Chỉ gọi interface của engine khác và `BudgetService.getUsage`
 * (Nguyên tắc VI); bảng duy nhất đọc trực tiếp là `employee_status` của chính engine này. Nội dung do AI sinh ra
 * (tin nhắn, tiêu đề artifact, lý do) là văn bản thuần, client không render HTML.
 */
@Injectable()
export class ProfileViewService {
  constructor(
    private readonly repo: OfficeRepository,
    private readonly moduleRef: ModuleRef,
  ) {}

  private engine<T>(token: symbol): T {
    return this.moduleRef.get<T>(token, { strict: false });
  }

  async build(ctx: RequestContext, employeeId: string): Promise<EmployeeProfileView> {
    const employees = this.engine<EmployeeEngine>(EMPLOYEE_ENGINE);
    const tasks = this.engine<TaskEngine>(TASK_ENGINE);
    const communication = this.engine<CommunicationEngine>(COMMUNICATION_ENGINE);
    const budget = this.engine<BudgetService>(BUDGET_SERVICE);
    const permissions = this.engine<PermissionEngine>(PERMISSION_ENGINE);

    // `get` ném NOT_FOUND nếu nhân viên không thuộc công ty.
    const employee = await employees.get(ctx, employeeId);
    const [status, assigned, month, total, pending] = await Promise.all([
      withTenant(ctx.companyId, (tx) => this.repo.getStatus(tx, ctx.companyId, employeeId)),
      tasks.list(ctx, { assigneeKind: 'ai_employee', assigneeId: employeeId, limit: 200 }),
      budget.getUsage(ctx, { employeeId }),
      budget.getUsage(ctx, { employeeId, period: 'all' }),
      permissions.listApprovals(ctx, { status: 'pending', employeeIds: [employeeId], limit: 20 }),
    ]);

    const mine = assigned.items;
    const recent = [...mine].sort(byNewest((t: Task) => t.createdAt)).slice(0, RECENT_TASKS);
    const details: TaskDetail[] = await Promise.all(recent.map((t) => tasks.get(ctx, t.id)));
    const titleOf = new Map(mine.map((t) => [t.id, t.title]));

    const messageLists = await Promise.all(
      recent.map((t) => communication.listTaskMessages(ctx, t.id)),
    );
    const recentMessages = messageLists
      .flat()
      .sort(byNewest((m) => m.createdAt))
      .slice(0, PROFILE_VIEW_LIST_LIMIT)
      .map((m) => ({
        id: m.id,
        taskId: m.taskId,
        taskTitle: titleOf.get(m.taskId) ?? '',
        authorKind: m.authorKind,
        authorId: m.authorId,
        body: m.body,
        createdAt: m.createdAt,
      }));

    const latestResults = details
      .flatMap((d) => d.artifacts.map((a) => ({ a, title: d.title })))
      .filter(({ a }) => a.createdByEmployeeId === employeeId)
      .sort(byNewest(({ a }) => a.createdAt))
      .slice(0, PROFILE_VIEW_LIST_LIMIT)
      .map(({ a, title }) => ({
        artifactId: a.id,
        taskId: a.taskId,
        taskTitle: title,
        title: a.title,
        kind: a.kind,
        createdAt: a.createdAt,
      }));

    const reviewHistory = details
      .flatMap((d) => d.reviews.map((r) => ({ r, title: d.title })))
      .sort(byNewest(({ r }) => r.decidedAt))
      .slice(0, PROFILE_VIEW_LIST_LIMIT)
      .map(({ r, title }) => ({
        id: r.id,
        taskId: r.taskId,
        taskTitle: title,
        stage: r.stage,
        decision: r.decision,
        reason: r.reason,
        decidedAt: r.decidedAt,
      }));

    const current = status?.currentTaskId
      ? (mine.find((t) => t.id === status.currentTaskId) ??
        (await tasks.get(ctx, status.currentTaskId).catch(() => undefined)))
      : undefined;

    const blockers: EmployeeProfileView['blockers'] = [
      ...mine
        .filter((t) => t.status === 'blocked')
        .map((t) => ({
          kind: 'blocked' as const,
          taskId: t.id,
          taskTitle: t.title,
          reason: t.blockedReason ?? 'BLOCKED',
        })),
      ...pending.items.map((a) => ({
        kind: 'waiting_approval' as const,
        taskId: a.taskId,
        taskTitle: titleOf.get(a.taskId) ?? a.taskTitle ?? '',
        reason: a.summary,
      })),
      ...mine
        .filter((t) => t.isOverdue && !OPEN_BLOCKER_STATUSES.has(t.status))
        .map((t) => ({
          kind: 'overdue' as const,
          taskId: t.id,
          taskTitle: t.title,
          reason: t.deadline,
        })),
    ];

    return {
      employee: {
        id: employee.id,
        name: employee.name,
        avatarKey: employee.avatarKey,
        position: employee.position,
        kind: employee.kind,
        homeOrgUnitId: employee.homeOrgUnitId,
        status: employee.status,
      },
      status: {
        state: status?.state ?? 'idle',
        sourceEventSeq: status ? status.sourceEventSeq : null,
        changedAt: status ? status.changedAt.toISOString() : null,
      },
      currentTask: current
        ? {
            id: current.id,
            title: current.title,
            status: current.status,
            deadline: current.deadline,
            isOverdue: current.isOverdue,
            progress: status?.progress ?? null,
          }
        : null,
      currentTool: status?.currentTool ?? null,
      recentMessages,
      latestResults,
      reviewHistory,
      usage: {
        period: month.period,
        month: { tokens: month.tokens, costUsd: month.costUsd },
        total: { tokens: total.tokens, costUsd: total.costUsd },
      },
      blockers,
    };
  }
}
