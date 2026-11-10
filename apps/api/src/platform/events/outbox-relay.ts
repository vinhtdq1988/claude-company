import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { withGlobal, withTenant } from '@claude-company/db';
import { domainEvent } from '@claude-company/db/schema/events';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { AppConfig } from '../config/config';
import { CONFIG, REDIS } from '../config/infra.providers';
import { EventBus } from './event-bus';
import { toDomainEvent } from './event-publisher';

export const DOMAIN_EVENT_CHANNEL = 'cc:domain-events';
const BATCH = 100;

/**
 * Đẩy domain_event chưa phát sang bộ chiếu, Redis pub/sub (cho mọi instance realtime) rồi event bus nội bộ.
 * Giao ít nhất một lần: nếu chết giữa chừng thì lần sau phát lại; client dựa vào `seq` để khử trùng.
 * Khóa advisory theo company bảo đảm chỉ một relay xử lý mỗi company tại một thời điểm.
 */
@Injectable()
export class OutboxRelay implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelay.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly bus: EventBus,
  ) {}

  onModuleInit(): void {
    if (this.config.OUTBOX_POLL_MS > 0) {
      this.timer = setInterval(() => void this.tick(), this.config.OUTBOX_POLL_MS);
      this.timer.unref();
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Một vòng quét; trả số event đã phát. An toàn khi gọi chồng (bỏ qua nếu vòng trước chưa xong). */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const rows = await withGlobal((tx) =>
        tx.execute<{ company_id: string }>(
          sql`select list_companies_with_unpublished_events() as company_id`,
        ),
      );
      let published = 0;
      for (const { company_id } of rows.rows) published += await this.relayCompany(company_id);
      return published;
    } catch (error) {
      this.logger.error('Relay outbox lỗi', error instanceof Error ? error : String(error));
      return 0;
    } finally {
      this.running = false;
    }
  }

  private async relayCompany(companyId: string): Promise<number> {
    return withTenant(companyId, async (tx) => {
      const lock = await tx.execute<{ locked: boolean }>(
        sql`select pg_try_advisory_xact_lock(hashtextextended(${`outbox:${companyId}`}, 0)) as locked`,
      );
      if (!lock.rows[0]?.locked) return 0;
      const rows = await tx
        .select()
        .from(domainEvent)
        .where(and(eq(domainEvent.companyId, companyId), isNull(domainEvent.publishedAt)))
        .orderBy(asc(domainEvent.seq))
        .limit(BATCH);
      for (const row of rows) {
        const event = toDomainEvent(row);
        // Chiếu trước, phát sau: gateway và client chỉ thấy sự kiện khi dữ liệu chiếu của nó đã commit.
        await this.bus.project(event);
        await this.redis.publish(DOMAIN_EVENT_CHANNEL, JSON.stringify(event));
        await this.bus.emit(event);
        await tx
          .update(domainEvent)
          .set({ publishedAt: new Date() })
          .where(eq(domainEvent.id, row.id));
      }
      return rows.length;
    });
  }
}
