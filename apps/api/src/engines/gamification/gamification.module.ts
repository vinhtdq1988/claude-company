import { Global, Logger, Module, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { DomainEvent } from '@claude-company/contracts';
import { GAMIFICATION_ENGINE } from '../../platform/engine-tokens';
import { EnvelopeMapperRegistry } from '../../platform/events/envelope-mapper';
import { EventBus } from '../../platform/events/event-bus';
import { GamificationController } from './gamification.controller';
import { GamificationRepository } from './gamification.repository';
import { GamificationService } from './gamification.service';

/** Loại sự kiện nguồn của cột mốc; khớp `milestoneKeyFor`. */
const SOURCE_EVENTS = ['employee.created', 'org_unit.created', 'task.status_changed'] as const;

/**
 * Binding thật của GamificationEngine. Nạp ở cả api lẫn worker vì relay chạy ở process nào thắng khóa công ty thì
 * process đó phát sự kiện (giống OrchestrationModule); controller chỉ có tác dụng ở api.
 */
@Global()
@Module({
  controllers: [GamificationController],
  providers: [
    GamificationRepository,
    GamificationService,
    { provide: GAMIFICATION_ENGINE, useExisting: GamificationService },
  ],
  exports: [GAMIFICATION_ENGINE, GamificationService],
})
export class GamificationModule implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GamificationModule.name);
  private readonly unsubscribe: Array<() => void> = [];

  constructor(
    private readonly bus: EventBus,
    private readonly mappers: EnvelopeMapperRegistry,
    private readonly gamification: GamificationService,
  ) {}

  onModuleInit(): void {
    for (const type of SOURCE_EVENTS) {
      this.unsubscribe.push(this.bus.subscribe(type, (event) => this.guard(event)));
    }
    // Cột mốc là thông tin của cả công ty, không nhạy cảm: phát cho mọi thành viên (BROADCAST_EVENT_TYPES).
    this.mappers.register('milestone.', (event) => [
      {
        room: 'company',
        type: 'milestone.achieved',
        payload: { key: (event.payload as { key: string }).key },
        visibility: { kind: 'all' },
      },
    ]);
  }

  onModuleDestroy(): void {
    this.unsubscribe.forEach((fn) => fn());
  }

  /** Lỗi của một sự kiện không được chặn relay; cột mốc idempotent nên lần phát lại sẽ ghi bù. */
  private async guard(event: DomainEvent): Promise<void> {
    try {
      await this.gamification.onDomainEvent(event);
    } catch (error) {
      this.logger.error(
        `Xử lý ${event.type} (seq ${event.seq}) cho cột mốc lỗi`,
        error instanceof Error ? error : String(error),
      );
    }
  }
}
