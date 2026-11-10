import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { DomainEvent, RequestContext } from '@claude-company/contracts';
import { EventBus } from '../../platform/events/event-bus';
import { ApprovalService } from './approval.service';

/**
 * Giữ yêu cầu phê duyệt nhất quán với phần còn lại của hệ thống theo sự kiện (relay giao ít nhất một lần nên mọi
 * thao tác đều idempotent):
 * - task rời `in_progress` hoặc bị hủy → yêu cầu đang chờ của task chuyển sang `cancelled`;
 * - người duyệt bị vô hiệu → yêu cầu đang chờ chuyển cho CEO (FR-026).
 */
@Injectable()
export class ApprovalListener implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ApprovalListener.name);
  private readonly unsubscribe: Array<() => void> = [];

  constructor(
    private readonly bus: EventBus,
    private readonly approvals: ApprovalService,
  ) {}

  onModuleInit(): void {
    this.unsubscribe.push(
      this.bus.subscribe('task.status_changed', (e) => this.guard(e, () => this.onTaskChanged(e))),
      this.bus.subscribe('human_member.deactivated', (e) =>
        this.guard(e, () => this.onMemberDeactivated(e)),
      ),
    );
  }

  onModuleDestroy(): void {
    this.unsubscribe.forEach((fn) => fn());
  }

  private ctxOf(event: DomainEvent): RequestContext {
    return { companyId: event.companyId, actor: { kind: 'system' }, traceId: `event-${event.seq}` };
  }

  private async guard(event: DomainEvent, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      this.logger.error(
        `Xử lý ${event.type} (seq ${event.seq}) cho phê duyệt lỗi`,
        error instanceof Error ? error : String(error),
      );
    }
  }

  async onTaskChanged(event: DomainEvent): Promise<void> {
    const p = event.payload as { taskId?: string; from?: string; to?: string };
    if (!p.taskId || (p.from !== 'in_progress' && p.to !== 'cancelled')) return;
    await this.approvals.cancelPendingForTask(
      this.ctxOf(event),
      p.taskId,
      p.to === 'cancelled' ? 'Task đã bị hủy' : 'Task đã rời trạng thái In Progress',
    );
  }

  async onMemberDeactivated(event: DomainEvent): Promise<void> {
    const memberId = (event.payload as { memberId?: string }).memberId;
    if (!memberId) return;
    await this.approvals.reassignFromDeactivated(this.ctxOf(event), memberId);
  }
}
