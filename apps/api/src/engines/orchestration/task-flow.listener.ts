import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  DomainError,
  type DomainEvent,
  type MemoryEngine,
  type OrchestrationEngine,
  type RequestContext,
  type TaskAction,
  type TaskDetail,
  type TaskEngine,
  type TaskStatus,
} from '@claude-company/contracts';
import {
  MEMORY_ENGINE,
  ORCHESTRATION_ENGINE,
  TASK_ENGINE,
} from '../../platform/engine-tokens';
import { EventBus } from '../../platform/events/event-bus';
import { ParentTaskService } from './parent-task.service';
import { TaskScheduler } from './scheduler.service';

type StatusPayload = {
  taskId: string;
  title?: string;
  parentTaskId: string | null;
  from?: TaskStatus;
  to?: TaskStatus;
  status?: TaskStatus;
  action?: TaskAction;
  assigneeKind: 'ai_employee' | 'team' | 'org_unit';
  assigneeId: string;
  blockedReason?: string | null;
};

/** Lỗi chuyển trạng thái do sự kiện được giao lại hoặc task đã đổi trạng thái: bỏ qua. */
const isStale = (error: unknown): boolean =>
  error instanceof DomainError &&
  (error.code === 'TASK_INVALID_TRANSITION' || error.code === 'NOT_FOUND');

/**
 * Điều phối theo sự kiện (T115a): mỗi `domain_event` của task/run/nhân viên kéo theo bước kế tiếp của luồng
 * `assigned → xác nhận/phân rã → thực thi → review → chờ duyệt → hoàn tất`. Bộ xử lý idempotent vì relay giao
 * ít nhất một lần; mọi việc dài đều đi qua hàng đợi (`enqueueRun`), listener chỉ ra quyết định.
 */
@Injectable()
export class TaskFlowListener implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TaskFlowListener.name);
  private readonly unsubscribe: Array<() => void> = [];

  constructor(
    private readonly bus: EventBus,
    private readonly scheduler: TaskScheduler,
    private readonly parentTasks: ParentTaskService,
    private readonly moduleRef: ModuleRef,
  ) {}

  private get tasks(): TaskEngine {
    return this.moduleRef.get<TaskEngine>(TASK_ENGINE, { strict: false });
  }
  private get orchestration(): OrchestrationEngine {
    return this.moduleRef.get<OrchestrationEngine>(ORCHESTRATION_ENGINE, { strict: false });
  }
  private get memory(): MemoryEngine {
    return this.moduleRef.get<MemoryEngine>(MEMORY_ENGINE, { strict: false });
  }

  onModuleInit(): void {
    this.unsubscribe.push(
      this.bus.subscribe('task.', (e) => this.guard(e, () => this.onTaskEvent(e))),
      this.bus.subscribe('employee.', (e) => this.guard(e, () => this.onEmployeeEvent(e))),
      this.bus.subscribe('run.', (e) => this.guard(e, () => this.onRunEvent(e))),
      this.bus.subscribe('approval.decided', (e) => this.guard(e, () => this.onApprovalDecided(e))),
      // Giới hạn đồng thời có thể vừa được nới: task đang chờ slot được xét lại.
      this.bus.subscribe('budget.policy_changed', (e) =>
        this.guard(e, async () => {
          await this.scheduler.scheduleAllWaiting(this.ctxOf(e));
        }),
      ),
    );
  }

  onModuleDestroy(): void {
    this.unsubscribe.forEach((fn) => fn());
  }

  private ctxOf(event: DomainEvent): RequestContext {
    return { companyId: event.companyId, actor: { kind: 'system' }, traceId: `event-${event.seq}` };
  }

  private async guard(event: DomainEvent, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      if (isStale(error)) return;
      this.logger.error(
        `Điều phối ${event.type} (seq ${event.seq}) lỗi`,
        error instanceof Error ? error : String(error),
      );
    }
  }

  // --- task ---

  async onTaskEvent(event: DomainEvent): Promise<void> {
    const ctx = this.ctxOf(event);
    const p = event.payload as StatusPayload;
    if (event.type === 'task.created') {
      // Task con do AI Manager tạo thẳng ở `assigned`: lập lịch cho người nhận (chờ phụ thuộc và slot).
      if (p.parentTaskId && p.status === 'assigned' && p.assigneeKind === 'ai_employee') {
        await this.scheduler.scheduleEmployee(ctx, p.assigneeId);
      }
      return;
    }
    if (event.type !== 'task.status_changed' || !p.to) return;

    switch (p.to) {
      case 'assigned':
        await this.onAssigned(ctx, p);
        break;
      case 'in_progress':
        await this.onInProgress(ctx, p);
        break;
      case 'in_review':
        await this.orchestration.enqueueRun(ctx, p.taskId, 'review').catch(blockedAlready);
        break;
      case 'completed':
        await this.onCompleted(ctx, p);
        break;
      case 'blocked':
        await this.orchestration.cancelRunsForTask(ctx, p.taskId);
        break;
      case 'cancelled':
        await this.onCancelled(ctx, p);
        break;
      default:
        break;
    }

    // Rời `in_progress` giải phóng slot của nhân viên: lấy task kế tiếp đang chờ theo priority rồi deadline.
    if (p.from === 'in_progress' && p.assigneeKind === 'ai_employee') {
      // Cũng đánh thức nhân viên cùng scope đang bị giới hạn `max_concurrent_tasks` của team/đơn vị/công ty giữ lại.
      await this.scheduler.scheduleAfterRelease(ctx, p.assigneeId);
    }
  }

  private async onAssigned(ctx: RequestContext, p: StatusPayload): Promise<void> {
    const task = await this.tasks.get(ctx, p.taskId);
    if (task.parentTaskId) {
      if (task.assigneeKind === 'ai_employee') await this.scheduler.scheduleEmployee(ctx, task.assigneeId);
      return;
    }
    // Task gốc đã được AI Manager xác nhận (kế hoạch `confirm`) thì chờ slot; chưa thì đi qua job decompose.
    if (task.decompositionPlan?.mode === 'confirm' && task.assigneeKind === 'ai_employee') {
      await this.scheduler.scheduleEmployee(ctx, task.assigneeId);
      return;
    }
    await this.orchestration.enqueueRun(ctx, p.taskId, 'decompose').catch(blockedAlready);
  }

  private async onInProgress(ctx: RequestContext, p: StatusPayload): Promise<void> {
    const task = await this.tasks.get(ctx, p.taskId);
    const isParent = task.subtasks.length > 0;
    if (isParent) {
      // Task cha: `start` do việc áp kế hoạch phân rã; `rework`/`resume` chạy lại tổng hợp khi đủ task con.
      if (p.action === 'rework' || p.action === 'resume') {
        await this.parentTasks.maybeSynthesize(ctx, p.taskId);
      }
      return;
    }
    if (task.assigneeKind !== 'ai_employee') return;
    await this.orchestration.enqueueRun(ctx, p.taskId, 'execute');
  }

  private async onCompleted(ctx: RequestContext, p: StatusPayload): Promise<void> {
    const task = await this.tasks.get(ctx, p.taskId);
    await this.remember(ctx, task);
    if (!task.parentTaskId) return;
    // Mở task phụ thuộc: các task con còn chờ của cùng task cha có thể đã đủ điều kiện chạy.
    const parent = await this.tasks.get(ctx, task.parentTaskId);
    const employeeIds = new Set(
      parent.subtasks
        .filter((s) => s.status === 'assigned' && s.assigneeKind === 'ai_employee')
        .map((s) => s.assigneeId),
    );
    for (const id of employeeIds) await this.scheduler.scheduleEmployee(ctx, id);
    await this.parentTasks.maybeSynthesize(ctx, parent.id);
  }

  private async onCancelled(ctx: RequestContext, p: StatusPayload): Promise<void> {
    await this.orchestration.cancelRunsForTask(ctx, p.taskId);
    const task = await this.tasks.get(ctx, p.taskId);
    // Hủy task cha hủy mọi task con chưa kết thúc.
    for (const child of task.subtasks) {
      if (child.status === 'completed' || child.status === 'cancelled') continue;
      await this.tasks.transition(ctx, child.id, 'cancel').catch(ignoreStale);
    }
    // Task con bị hủy khi task cha chưa hủy: task cha `blocked`, chỉ `cancel` được.
    if (task.parentTaskId) {
      const parent = await this.tasks.get(ctx, task.parentTaskId);
      if (!['cancelled', 'completed', 'blocked'].includes(parent.status)) {
        await this.tasks
          .transition(ctx, parent.id, 'block', { blockedReason: 'SUBTASK_CANCELLED' })
          .catch(ignoreStale);
      }
    }
  }

  /** Tóm tắt task đã xong vào bộ nhớ của người/đơn vị chịu trách nhiệm (không gọi model, R11). */
  private async remember(ctx: RequestContext, task: TaskDetail): Promise<void> {
    const artifacts = task.artifacts.map((a) => a.title).join(', ') || 'không có';
    const content = [
      `Task "${task.title}" đã hoàn thành.`,
      `Mục tiêu: ${task.objective.slice(0, 500)}`,
      `Đầu ra mong đợi: ${task.expectedOutput.slice(0, 300)}`,
      `Artifact: ${artifacts}`,
      `Số vòng làm lại: ${task.reworkCount}`,
    ].join('\n');
    await this.memory.remember(ctx, {
      ownerScopeKind: task.assigneeKind,
      ownerScopeId: task.assigneeId,
      sourceTaskId: task.id,
      kind: 'task_summary',
      content,
    });
  }

  // --- nhân viên ---

  async onEmployeeEvent(event: DomainEvent): Promise<void> {
    const ctx = this.ctxOf(event);
    const employeeId = (event.payload as { employeeId?: string }).employeeId;
    if (!employeeId) return;
    if (event.type === 'employee.suspended') {
      // Khóa tool run đang chạy (ToolBroker thấy task rời `in_progress`) và chuyển task sang `blocked`.
      const running = await this.tasks.list(ctx, {
        assigneeKind: 'ai_employee',
        assigneeId: employeeId,
        statusIn: ['in_progress'],
        limit: 200,
      });
      for (const task of running.items) {
        await this.tasks
          .transition(ctx, task.id, 'block', { blockedReason: 'EMPLOYEE_SUSPENDED' })
          .catch(ignoreStale);
      }
    } else if (event.type === 'employee.resumed') {
      await this.scheduler.scheduleEmployee(ctx, employeeId);
    }
  }

  // --- phê duyệt ---

  /** Quyết định của người thật: duyệt → job thực thi hành động đã duyệt; từ chối → agent nhận lý do (US4-AS5). */
  async onApprovalDecided(event: DomainEvent): Promise<void> {
    const approvalRequestId = (event.payload as { approvalRequestId?: string }).approvalRequestId;
    if (!approvalRequestId) return;
    await this.orchestration.resumeAfterApproval(this.ctxOf(event), approvalRequestId);
  }

  // --- run ---

  async onRunEvent(event: DomainEvent): Promise<void> {
    if (event.type !== 'run.succeeded') return;
    const ctx = this.ctxOf(event);
    const p = event.payload as { taskId: string; purpose: string };
    // Run thực thi/tổng hợp xong thì nộp để review. Kết quả decompose/review đã được job áp dụng trực tiếp.
    if (p.purpose === 'execute' || p.purpose === 'synthesize') {
      await this.tasks.transition(ctx, p.taskId, 'submit');
    }
  }
}

const ignoreStale = (error: unknown): void => {
  if (!isStale(error)) throw error;
};

/** `enqueueRun` đã chặn task (NO_AI_MANAGER, NO_INDEPENDENT_REVIEWER) trước khi ném: không cần làm gì thêm. */
const blockedAlready = (error: unknown): void => {
  if (
    error instanceof DomainError &&
    (error.code === 'NO_AI_MANAGER' ||
      error.code === 'NO_INDEPENDENT_REVIEWER' ||
      error.code === 'EMPLOYEE_SUSPENDED')
  ) {
    return;
  }
  throw error;
};
