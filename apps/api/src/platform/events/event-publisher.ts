import { Injectable } from '@nestjs/common';
import type { DomainEvent } from '@claude-company/contracts';
import type { Tx } from '@claude-company/db';
import { domainEvent } from '@claude-company/db/schema/events';
import { sql } from 'drizzle-orm';

export type NewDomainEvent = {
  type: string;
  aggregateKind: string;
  aggregateId: string;
  payload?: Record<string, unknown>;
};

type DomainEventRow = typeof domainEvent.$inferSelect;

export function toDomainEvent(row: DomainEventRow): DomainEvent {
  return {
    id: row.id,
    companyId: row.companyId,
    seq: row.seq,
    type: row.type,
    aggregateKind: row.aggregateKind,
    aggregateId: row.aggregateId,
    payload: row.payload,
    occurredAt: row.occurredAt.toISOString(),
  };
}

/**
 * Ghi `domain_event` cùng transaction với thay đổi nghiệp vụ (outbox). `seq` liên tục theo company:
 * khóa advisory theo company giữ đến commit nên transaction khác không cấp `seq` chen ngang,
 * và thứ tự commit trùng thứ tự `seq`.
 */
@Injectable()
export class EventPublisher {
  async publish(tx: Tx, ctx: { companyId: string }, event: NewDomainEvent): Promise<DomainEvent> {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`domain_event:${ctx.companyId}`}, 0))`,
    );
    const result = await tx.execute<{ next: string }>(
      sql`select coalesce(max(seq), 0) + 1 as next from domain_event where company_id = ${ctx.companyId}`,
    );
    const seq = Number(result.rows[0]?.next ?? 1);
    const [row] = await tx
      .insert(domainEvent)
      .values({
        companyId: ctx.companyId,
        seq,
        type: event.type,
        aggregateKind: event.aggregateKind,
        aggregateId: event.aggregateId,
        payload: event.payload ?? {},
      })
      .returning();
    if (!row) throw new Error('Không ghi được domain_event');
    return toDomainEvent(row);
  }
}
