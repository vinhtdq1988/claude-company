import { Injectable, Logger } from '@nestjs/common';
import type { DomainEvent } from '@claude-company/contracts';

export type DomainEventHandler = (event: DomainEvent) => void | Promise<void>;

/**
 * Event bus nội bộ: engine đăng ký nhận domain_event theo tiền tố loại (`task.`, `run.`…) hoặc `*`.
 * Relay gọi `emit` sau khi đã đẩy sự kiện sang Redis; lỗi của một handler không chặn handler khác.
 */
@Injectable()
export class EventBus {
  private readonly logger = new Logger(EventBus.name);
  private readonly handlers: Array<{ prefix: string; handler: DomainEventHandler }> = [];
  private readonly projections: Array<{ prefix: string; handler: DomainEventHandler }> = [];

  subscribe(prefix: string, handler: DomainEventHandler): () => void {
    const entry = { prefix, handler };
    this.handlers.push(entry);
    return () => {
      const i = this.handlers.indexOf(entry);
      if (i >= 0) this.handlers.splice(i, 1);
    };
  }

  /**
   * Bộ chiếu (projection) chạy TRƯỚC khi relay phát sự kiện ra realtime, nên dữ liệu chiếu (ví dụ trạng thái office)
   * đã commit khi gateway và client đọc lại. Handler phải idempotent vì relay giao ít nhất một lần.
   */
  subscribeProjection(prefix: string, handler: DomainEventHandler): () => void {
    const entry = { prefix, handler };
    this.projections.push(entry);
    return () => {
      const i = this.projections.indexOf(entry);
      if (i >= 0) this.projections.splice(i, 1);
    };
  }

  async project(event: DomainEvent): Promise<void> {
    await this.run(this.projections, event, 'Bộ chiếu');
  }

  async emit(event: DomainEvent): Promise<void> {
    await this.run(this.handlers, event, 'Handler');
  }

  private async run(
    entries: Array<{ prefix: string; handler: DomainEventHandler }>,
    event: DomainEvent,
    label: string,
  ): Promise<void> {
    for (const { prefix, handler } of entries) {
      if (prefix !== '*' && !event.type.startsWith(prefix)) continue;
      try {
        await handler(event);
      } catch (error) {
        this.logger.error(
          `${label} cho ${event.type} (seq ${event.seq}) lỗi`,
          error instanceof Error ? error : String(error),
        );
      }
    }
  }
}
