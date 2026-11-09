import { Injectable } from '@nestjs/common';
import type {
  RequestContext,
  TaskAction,
  TaskDecisionInput,
  TaskStatus,
} from '@claude-company/contracts';
import type { Tx } from '@claude-company/db';
import { EventPublisher } from '../../platform/events/event-publisher';
import { TaskRepository, type TaskRow } from './task.repository';
import { transitionOrThrow } from './task-state-machine';

export type MoveOptions = {
  blockedReason?: string;
  resumeTo?: TaskStatus;
  decision?: TaskDecisionInput['decision'];
  extra?: Partial<TaskRow>;
};

/**
 * Điểm duy nhất ghi `task.status` (qua máy trạng thái FR-020a) và phát `task.status_changed` cùng
 * transaction. TaskService và DecompositionService dùng chung để không có đường đổi trạng thái thứ hai.
 */
@Injectable()
export class TaskTransitions {
  constructor(
    private readonly repo: TaskRepository,
    private readonly events: EventPublisher,
  ) {}

  async move(
    tx: Tx,
    ctx: RequestContext,
    current: TaskRow,
    action: TaskAction,
    options: MoveOptions = {},
  ): Promise<TaskRow> {
    const next = transitionOrThrow(
      { status: current.status, blockedFrom: current.blockedFrom },
      action,
      { resumeTo: options.resumeTo },
    );
    const updated = await this.repo.update(tx, ctx.companyId, current.id, {
      ...options.extra,
      status: next.status,
      blockedFrom: next.blockedFrom,
      blockedReason: next.status === 'blocked' ? (options.blockedReason ?? null) : null,
    });
    await this.events.publish(tx, ctx, {
      type: 'task.status_changed',
      aggregateKind: 'task',
      aggregateId: current.id,
      payload: this.snapshot(updated, {
        from: current.status,
        to: updated.status,
        action,
        decision: options.decision,
      }),
    });
    return updated;
  }

  /** Dữ liệu sự kiện: đủ để listener điều phối mà không phải đọc lại task. */
  snapshot(row: TaskRow, extra: Record<string, unknown>): Record<string, unknown> {
    return {
      taskId: row.id,
      title: row.title,
      parentTaskId: row.parentTaskId,
      assigneeKind: row.assigneeKind,
      assigneeId: row.assigneeId,
      createdByMemberId: row.createdByMemberId,
      priority: row.priority,
      isOverdue: row.isOverdue,
      blockedReason: row.blockedReason,
      reworkCount: row.reworkCount,
      ...extra,
    };
  }
}
