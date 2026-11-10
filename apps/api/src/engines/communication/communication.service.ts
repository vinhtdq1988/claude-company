import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  DomainError,
  type CommunicationEngine,
  type Notification,
  type NotificationInput,
  type Page,
  type RequestContext,
  type RoutedNotification,
  type TaskEngine,
  type TaskMessage,
} from '@claude-company/contracts';
import { notification, taskMessage } from '@claude-company/db/schema/communication';
import { and, desc, eq, isNull, lt, or, type SQL } from 'drizzle-orm';
import { TASK_ENGINE } from '../../platform/engine-tokens';
import { EventPublisher } from '../../platform/events/event-publisher';
import { inTenant } from '../../platform/tenancy/tenant-store';
import { NotificationRouter } from './notification-routing';

type MessageRow = typeof taskMessage.$inferSelect;
type NotificationRow = typeof notification.$inferSelect;

const toMessage = (row: MessageRow): TaskMessage => ({
  id: row.id,
  taskId: row.taskId,
  authorKind: row.authorKind,
  authorId: row.authorId,
  body: row.body,
  agentRunId: row.agentRunId,
  createdAt: row.createdAt.toISOString(),
});

const toNotification = (row: NotificationRow): Notification => ({
  id: row.id,
  recipientMemberId: row.recipientMemberId,
  type: row.type,
  taskId: row.taskId,
  approvalRequestId: row.approvalRequestId,
  title: row.title,
  body: row.body,
  readAt: row.readAt ? row.readAt.toISOString() : null,
  createdAt: row.createdAt.toISOString(),
});

/**
 * Communication Engine: trao đổi luôn gắn một task (FR-022) và thông báo in-app (FR-041).
 * Không có chat tự do: mọi tin nhắn có `task_id` NOT NULL (Nguyên tắc I).
 */
@Injectable()
export class CommunicationService implements CommunicationEngine {
  constructor(
    private readonly events: EventPublisher,
    private readonly router: NotificationRouter,
    private readonly moduleRef: ModuleRef,
  ) {}

  private get tasks(): TaskEngine {
    return this.moduleRef.get<TaskEngine>(TASK_ENGINE, { strict: false });
  }

  async postTaskMessage(ctx: RequestContext, taskId: string, body: string): Promise<TaskMessage> {
    const text = body.trim();
    if (!text) throw new DomainError('VALIDATION_FAILED', 'Nội dung tin nhắn không được rỗng');
    if (ctx.actor.kind === 'system') {
      throw new DomainError('FORBIDDEN', 'Tin nhắn phải do người thật hoặc AI Employee gửi');
    }
    // Không có chat tự do: tin nhắn chỉ gắn vào task có thật của công ty (không có FK xuyên engine).
    await this.tasks.get(ctx, taskId);
    const author =
      ctx.actor.kind === 'human'
        ? ({ kind: 'human', id: ctx.actor.memberId, runId: null } as const)
        : ({ kind: 'ai', id: ctx.actor.employeeId, runId: ctx.actor.runId } as const);

    const row = await inTenant(ctx, async (tx) => {
      const [inserted] = await tx
        .insert(taskMessage)
        .values({
          companyId: ctx.companyId,
          taskId,
          authorKind: author.kind,
          authorId: author.id,
          body: text,
          agentRunId: author.runId,
        })
        .returning();
      if (!inserted) throw new Error('Không ghi được task_message');
      await this.events.publish(tx, ctx, {
        type: 'task.message_posted',
        aggregateKind: 'task',
        aggregateId: taskId,
        payload: {
          taskId,
          messageId: inserted.id,
          authorKind: author.kind,
          authorId: author.id,
          // Office Simulation chỉ coi nhân viên là `communicating` khi tin nhắn gắn với run đang chạy của họ.
          runId: author.runId,
        },
      });
      return inserted;
    });
    return toMessage(row);
  }

  async listTaskMessages(ctx: RequestContext, taskId: string): Promise<TaskMessage[]> {
    const rows = await inTenant(ctx, (tx) =>
      tx
        .select()
        .from(taskMessage)
        .where(and(eq(taskMessage.companyId, ctx.companyId), eq(taskMessage.taskId, taskId)))
        .orderBy(taskMessage.createdAt, taskMessage.id),
    );
    return rows.map(toMessage);
  }

  async notify(
    ctx: RequestContext,
    recipientMemberId: string,
    n: NotificationInput,
  ): Promise<Notification> {
    const row = await inTenant(ctx, async (tx) => {
      const [inserted] = await tx
        .insert(notification)
        .values({
          companyId: ctx.companyId,
          recipientMemberId,
          type: n.type,
          taskId: n.taskId ?? null,
          approvalRequestId: n.approvalRequestId ?? null,
          title: n.title,
          body: n.body ?? '',
        })
        .returning();
      if (!inserted) throw new Error('Không ghi được notification');
      await this.events.publish(tx, ctx, {
        type: 'notification.created',
        aggregateKind: 'notification',
        aggregateId: inserted.id,
        payload: {
          notificationId: inserted.id,
          memberId: recipientMemberId,
          type: inserted.type,
          title: inserted.title,
          taskId: inserted.taskId ?? undefined,
          approvalRequestId: inserted.approvalRequestId ?? undefined,
        },
      });
      return inserted;
    });
    return toNotification(row);
  }

  /** Chọn người nhận theo FR-041 rồi lưu và phát thông báo. */
  async notifyRouted(ctx: RequestContext, n: RoutedNotification): Promise<Notification> {
    const recipient = await this.router.resolveRecipient(ctx, n);
    return this.notify(ctx, recipient, {
      type: n.type,
      title: n.title,
      body: n.body,
      taskId: n.taskId,
      approvalRequestId: n.approvalRequestId,
    });
  }

  async listNotifications(
    ctx: RequestContext,
    memberId: string,
    filter: { unread?: boolean; cursor?: string; limit?: number },
  ): Promise<Page<Notification>> {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const conditions: SQL[] = [
      eq(notification.companyId, ctx.companyId),
      eq(notification.recipientMemberId, memberId),
    ];
    if (filter.unread) conditions.push(isNull(notification.readAt));
    const cursor = decodeCursor(filter.cursor);
    if (cursor) {
      conditions.push(
        or(
          lt(notification.createdAt, cursor.createdAt),
          and(eq(notification.createdAt, cursor.createdAt), lt(notification.id, cursor.id)),
        ) as SQL,
      );
    }
    const rows = await inTenant(ctx, (tx) =>
      tx
        .select()
        .from(notification)
        .where(and(...conditions))
        .orderBy(desc(notification.createdAt), desc(notification.id))
        .limit(limit + 1),
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toNotification),
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(`${last.createdAt.toISOString()}|${last.id}`).toString('base64url')
          : null,
    };
  }

  async markRead(ctx: RequestContext, memberId: string, notificationId: string): Promise<void> {
    const updated = await inTenant(ctx, (tx) =>
      tx
        .update(notification)
        .set({ readAt: new Date() })
        .where(
          and(
            eq(notification.companyId, ctx.companyId),
            eq(notification.recipientMemberId, memberId),
            eq(notification.id, notificationId),
          ),
        )
        .returning({ id: notification.id }),
    );
    if (updated.length === 0) throw new DomainError('NOT_FOUND', 'Không tìm thấy thông báo');
  }

  async markAllRead(ctx: RequestContext, memberId: string): Promise<number> {
    const updated = await inTenant(ctx, (tx) =>
      tx
        .update(notification)
        .set({ readAt: new Date() })
        .where(
          and(
            eq(notification.companyId, ctx.companyId),
            eq(notification.recipientMemberId, memberId),
            isNull(notification.readAt),
          ),
        )
        .returning({ id: notification.id }),
    );
    return updated.length;
  }
}

function decodeCursor(cursor: string | undefined): { createdAt: Date; id: string } | null {
  if (!cursor) return null;
  try {
    const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    const createdAt = new Date(iso ?? '');
    return id && !Number.isNaN(createdAt.getTime()) ? { createdAt, id } : null;
  } catch {
    return null;
  }
}
