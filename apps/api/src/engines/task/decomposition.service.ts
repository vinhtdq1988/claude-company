import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  CEO_ASSISTANT_TEMPLATE_KEY,
  DomainError,
  decompositionPlanSchema,
  type DecompositionPlan,
  type EmployeeEngine,
  type OrganizationEngine,
  type RequestContext,
  type Task,
} from '@claude-company/contracts';
import { newId } from '@claude-company/db';
import { EMPLOYEE_ENGINE, ORGANIZATION_ENGINE } from '../../platform/engine-tokens';
import { EventPublisher } from '../../platform/events/event-publisher';
import { inTenant } from '../../platform/tenancy/tenant-store';
import { topologicalOrder, validateDependencyIndexes } from './dependency-graph';
import { TaskRepository, toTask, type TaskRow } from './task.repository';
import { TaskTransitions } from './task-transitions';

/**
 * Áp dụng kế hoạch phân rã do AI Manager đề xuất (R10). Hệ thống kiểm tra lại mọi ràng buộc
 * (phạm vi, trạng thái, vòng phụ thuộc) trước khi tạo task con; kế hoạch sai không bao giờ được áp một phần.
 */
@Injectable()
export class DecompositionService {
  constructor(
    private readonly repo: TaskRepository,
    private readonly events: EventPublisher,
    private readonly transitions: TaskTransitions,
    private readonly moduleRef: ModuleRef,
  ) {}

  private get employees(): EmployeeEngine {
    return this.moduleRef.get<EmployeeEngine>(EMPLOYEE_ENGINE, { strict: false });
  }

  private get organization(): OrganizationEngine {
    return this.moduleRef.get<OrganizationEngine>(ORGANIZATION_ENGINE, { strict: false });
  }

  async apply(ctx: RequestContext, parentTaskId: string, rawPlan: DecompositionPlan): Promise<Task[]> {
    if (ctx.actor.kind !== 'ai') {
      throw new DomainError('FORBIDDEN', 'Kế hoạch phân rã phải do AI Manager đề xuất');
    }
    const managerId = ctx.actor.employeeId;
    const parsed = decompositionPlanSchema.safeParse(rawPlan);
    if (!parsed.success) {
      throw new DomainError('NO_SUITABLE_ASSIGNEE', 'Kế hoạch phân rã không đúng định dạng', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const plan = parsed.data;

    // Đọc trước ngoài transaction chính: cần đọc nhân viên và phạm vi qua engine khác.
    const parent = await inTenant(ctx, (tx) => this.repo.find(tx, ctx.companyId, parentTaskId));
    if (!parent) throw new DomainError('NOT_FOUND', 'Không tìm thấy task');
    if (parent.parentTaskId !== null || parent.status !== 'assigned') {
      throw new DomainError(
        'TASK_INVALID_TRANSITION',
        'Chỉ phân rã task gốc đang ở trạng thái assigned',
        { from: parent.status },
      );
    }

    if (plan.mode === 'confirm') {
      // `confirm` chỉ hợp lệ với task giao trực tiếp cho một AI Employee (FR-018).
      if (parent.assigneeKind !== 'ai_employee' || plan.subtasks.length > 0) {
        throw new DomainError(
          'NO_SUITABLE_ASSIGNEE',
          'Task giao cho Team/Department phải được phân rã thành task con',
          { mode: plan.mode, assigneeKind: parent.assigneeKind },
        );
      }
      await inTenant(ctx, (tx) =>
        this.repo.update(tx, ctx.companyId, parent.id, {
          decompositionPlan: plan,
          decomposedByEmployeeId: managerId,
        }),
      );
      return [];
    }

    // Trợ lý tự thực hiện yêu cầu của CEO (R10, R14): task giao cho trợ lý chỉ được `confirm`, không phân rã.
    if (parent.assigneeKind === 'ai_employee') {
      const assignee = await this.employees.get(ctx, parent.assigneeId).catch(() => null);
      if (assignee?.roleTemplateKey === CEO_ASSISTANT_TEMPLATE_KEY) {
        throw new DomainError(
          'NO_SUITABLE_ASSIGNEE',
          'Task giao cho CEO AI Assistant không được phân rã',
          { mode: plan.mode, assigneeId: parent.assigneeId },
        );
      }
    }
    if (plan.subtasks.length === 0) {
      throw new DomainError('NO_SUITABLE_ASSIGNEE', 'Kế hoạch phân rã không có task con', {
        mode: plan.mode,
      });
    }
    const indexIssue = validateDependencyIndexes(plan.subtasks.map((s) => s.dependsOn));
    const order = topologicalOrder(plan.subtasks.map((s) => s.dependsOn));
    if (indexIssue || !order.ok) {
      throw new DomainError('DEPENDENCY_CYCLE', 'Kế hoạch phân rã có phụ thuộc vòng hoặc không hợp lệ', {
        issue: indexIssue ?? 'CYCLE',
        cycle: order.ok ? [] : order.cycle,
      });
    }

    // Người nhận của mỗi task con phải còn hoạt động và nằm trong phạm vi của người giao task cha.
    for (const [index, sub] of plan.subtasks.entries()) {
      const employee = await this.employees.get(ctx, sub.assigneeId).catch(() => null);
      const inScope = employee
        ? await this.organization.isInScope(ctx, parent.createdByMemberId, {
            kind: 'ai_employee',
            id: sub.assigneeId,
          })
        : false;
      if (
        !employee ||
        employee.status !== 'active' ||
        !inScope ||
        employee.roleTemplateKey === CEO_ASSISTANT_TEMPLATE_KEY // task con không giao cho trợ lý cấp công ty
      ) {
        throw new DomainError('NO_SUITABLE_ASSIGNEE', 'Không có nhân viên phù hợp cho task con', {
          subtaskIndex: index,
          assigneeId: sub.assigneeId,
        });
      }
    }

    const created = await inTenant(ctx, async (tx) => {
      const current = await this.repo.find(tx, ctx.companyId, parentTaskId, { forUpdate: true });
      if (!current || current.status !== 'assigned') {
        throw new DomainError('TASK_INVALID_TRANSITION', 'Task không còn ở trạng thái assigned', {
          from: current?.status,
        });
      }
      const ids = plan.subtasks.map(() => newId());
      // Chỉ số theo kế hoạch (không theo thứ tự topological) để trả về đúng thứ tự người dùng thấy.
      const rows: TaskRow[] = [];
      for (const index of order.order) {
        const sub = plan.subtasks[index]!;
        const row = await this.repo.insert(tx, {
          id: ids[index]!,
          companyId: ctx.companyId,
          parentTaskId: current.id,
          title: sub.title,
          objective: sub.objective,
          // Task con kế thừa người giao, hạn chót và độ ưu tiên từ task cha.
          createdByMemberId: current.createdByMemberId,
          assignedByAiEmployeeId: managerId,
          assigneeKind: 'ai_employee',
          assigneeId: sub.assigneeId,
          deadline: current.deadline,
          priority: current.priority,
          acceptanceCriteria: sub.acceptanceCriteria.map((text, i) => ({ id: `c${i + 1}`, text })),
          expectedOutput: sub.expectedOutput,
          // Task con không qua job decompose: tạo thẳng ở `assigned`, chờ phụ thuộc và slot.
          status: 'assigned',
        });
        rows[index] = row;
      }
      await this.repo.insertDependencies(
        tx,
        ctx.companyId,
        plan.subtasks.flatMap((sub, index) =>
          [...new Set(sub.dependsOn)].map((dep) => ({
            taskId: ids[index]!,
            dependsOnTaskId: ids[dep]!,
          })),
        ),
      );
      for (const row of rows) {
        await this.events.publish(tx, ctx, {
          type: 'task.created',
          aggregateKind: 'task',
          aggregateId: row.id,
          payload: this.transitions.snapshot(row, { status: row.status }),
        });
      }
      await this.repo.update(tx, ctx.companyId, current.id, {
        decompositionPlan: plan,
        decomposedByEmployeeId: managerId,
      });
      await this.transitions.move(tx, ctx, current, 'start', {});
      await this.events.publish(tx, ctx, {
        type: 'task.decomposition_applied',
        aggregateKind: 'task',
        aggregateId: current.id,
        payload: { taskId: current.id, subtaskIds: ids, managerId },
      });
      return rows;
    });
    return created.map(toTask);
  }
}
