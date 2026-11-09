import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type {
  CommunicationEngine,
  DomainEvent,
  NotificationType,
  RequestContext,
} from '@claude-company/contracts';
import { COMMUNICATION_ENGINE } from '../../platform/engine-tokens';
import { EventBus } from '../../platform/events/event-bus';

/**
 * Lý do `blocked` → loại thông báo. `HUMAN_REJECTED` không có dòng: người quyết định đã là người thật.
 * Thông báo `escalation` của orchestration (NO_AI_MANAGER, NO_INDEPENDENT_REVIEWER…) cũng phát từ đây,
 * theo sự kiện `task.status_changed`, nên mọi đường chặn task đều có đúng một thông báo.
 */
export const BLOCKED_NOTIFICATION: Readonly<Record<string, NotificationType>> = {
  MAX_REWORK_REACHED: 'escalation',
  NO_AI_MANAGER: 'escalation',
  NO_INDEPENDENT_REVIEWER: 'escalation',
  NO_SUITABLE_ASSIGNEE: 'escalation',
  DEPENDENCY_CYCLE: 'escalation',
  SUBTASK_CANCELLED: 'escalation',
  BUDGET_EXCEEDED: 'budget_blocked',
  MODEL_NOT_ALLOWED: 'task_error',
  EMPLOYEE_SUSPENDED: 'task_error',
  RUN_INTERRUPTED: 'task_error',
  RETRIES_EXHAUSTED: 'task_error',
  TOOL_OUTCOME_UNKNOWN: 'task_error',
  ADAPTER_LIVE_NOT_CONFIGURED: 'task_error',
};

const BLOCKED_TEXT: Readonly<Record<string, string>> = {
  MAX_REWORK_REACHED: 'đã đạt giới hạn số vòng làm lại, cần người quyết định',
  NO_AI_MANAGER: 'không có AI Manager để xác nhận hoặc phân rã',
  NO_INDEPENDENT_REVIEWER: 'không có AI Manager độc lập để review',
  NO_SUITABLE_ASSIGNEE: 'không có nhân viên phù hợp cho kế hoạch phân rã',
  DEPENDENCY_CYCLE: 'kế hoạch phân rã có phụ thuộc vòng',
  SUBTASK_CANCELLED: 'một task con đã bị hủy',
  BUDGET_EXCEEDED: 'đã chạm giới hạn ngân sách',
  MODEL_NOT_ALLOWED: 'model của nhân viên không được phép dùng',
  EMPLOYEE_SUSPENDED: 'nhân viên đang bị tạm ngưng',
  RUN_INTERRUPTED: 'lượt chạy bị gián đoạn',
  RETRIES_EXHAUSTED: 'đã hết số lần thử lại',
  TOOL_OUTCOME_UNKNOWN: 'không xác định được kết quả của một hành động',
  ADAPTER_LIVE_NOT_CONFIGURED: 'chưa cấu hình adapter thật cho hành động này',
};

export type TaskNotification = {
  type: NotificationType;
  title: string;
  body: string;
};

/** Thông báo (nếu có) cho một sự kiện `task.*`; thuần để unit test được. */
export function notificationFor(event: Pick<DomainEvent, 'type' | 'payload'>): TaskNotification | null {
  const p = event.payload as {
    title?: string;
    to?: string;
    from?: string;
    blockedReason?: string | null;
    parentTaskId?: string | null;
  };
  const name = `"${p.title ?? 'task'}"`;
  if (event.type === 'task.overdue') {
    return { type: 'task_overdue', title: `Task ${name} đã quá hạn`, body: '' };
  }
  if (event.type !== 'task.status_changed') return null;
  if (p.to === 'completed') {
    return { type: 'task_completed', title: `Task ${name} đã hoàn thành`, body: '' };
  }
  if (p.to === 'awaiting_human_approval') {
    return {
      type: 'approval_needed',
      title: `Task ${name} chờ bạn phê duyệt`,
      body: 'AI Manager đã review độc lập và đối chiếu đủ tiêu chí nghiệm thu.',
    };
  }
  if (p.to === 'blocked' && p.blockedReason) {
    const type = BLOCKED_NOTIFICATION[p.blockedReason];
    if (!type) return null;
    return {
      type,
      title: `Task ${name} bị chặn: ${p.blockedReason}`,
      body: `Task ${name} ${BLOCKED_TEXT[p.blockedReason] ?? 'bị chặn'}.`,
    };
  }
  return null;
}

/** Gửi thông báo in-app khi task hoàn thành, lỗi, quá hạn hoặc bị chặn (FR-041, T118). */
@Injectable()
export class TaskNotifications implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TaskNotifications.name);
  private unsubscribe: (() => void) | undefined;

  constructor(
    private readonly bus: EventBus,
    @Inject(COMMUNICATION_ENGINE) private readonly communication: CommunicationEngine,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.bus.subscribe('task.', (event) => this.handle(event));
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
  }

  async handle(event: DomainEvent): Promise<void> {
    const notification = notificationFor(event);
    if (!notification) return;
    const taskId = (event.payload as { taskId?: string }).taskId;
    if (!taskId) return;
    const ctx: RequestContext = {
      companyId: event.companyId,
      actor: { kind: 'system' },
      traceId: `event-${event.seq}`,
    };
    // Người duyệt task là người đã giao task (Human Manager chịu trách nhiệm).
    const approverMemberId = (event.payload as { createdByMemberId?: string }).createdByMemberId;
    try {
      await this.communication.notifyRouted(ctx, { ...notification, taskId, approverMemberId });
    } catch (error) {
      this.logger.error(
        `Không gửi được thông báo cho ${event.type} của task ${taskId}`,
        error instanceof Error ? error : String(error),
      );
    }
  }
}
