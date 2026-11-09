import { sql } from 'drizzle-orm';
import { bigint, index, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { companyIdColumn, idColumn } from './_columns';

/** Outbox: ghi cùng transaction với thay đổi nghiệp vụ; `seq` liên tục theo company. */
export const domainEvent = pgTable(
  'domain_event',
  {
    id: idColumn(),
    companyId: companyIdColumn(),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    type: text('type').notNull(),
    aggregateKind: text('aggregate_kind').notNull(),
    aggregateId: uuid('aggregate_id').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
  },
  (t) => [
    unique('domain_event_company_seq_unique').on(t.companyId, t.seq),
    index('domain_event_unpublished_idx')
      .on(t.companyId, t.seq)
      .where(sql`${t.publishedAt} is null`),
  ],
);
