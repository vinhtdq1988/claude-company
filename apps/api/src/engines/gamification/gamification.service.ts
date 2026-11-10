import { Injectable } from '@nestjs/common';
import type {
  DomainEvent,
  GamificationEngine,
  Milestone,
  RequestContext,
} from '@claude-company/contracts';
import { EventPublisher } from '../../platform/events/event-publisher';
import { inTenant } from '../../platform/tenancy/tenant-store';
import { GamificationRepository, toMilestone } from './gamification.repository';
import { milestoneKeyFor } from './milestone-rules';

/**
 * Gamification Engine (FR-045): ghi cột mốc từ sự kiện nghiệp vụ thật, đúng một lần cho mỗi công ty. Relay giao
 * sự kiện ít nhất một lần và có thể phát lại, nên mọi thao tác đều idempotent nhờ UNIQUE(company_id, key); chỉ lần
 * ghi thành công mới phát `milestone.achieved`.
 */
@Injectable()
export class GamificationService implements GamificationEngine {
  constructor(
    private readonly repo: GamificationRepository,
    private readonly events: EventPublisher,
  ) {}

  async onDomainEvent(event: DomainEvent): Promise<void> {
    const key = milestoneKeyFor(event);
    if (!key) return;
    const ctx: RequestContext = {
      companyId: event.companyId,
      actor: { kind: 'system' },
      traceId: `event-${event.seq}`,
    };
    await inTenant(ctx, async (tx) => {
      const row = await this.repo.insertIfAbsent(tx, event.companyId, {
        key,
        achievedAt: new Date(event.occurredAt),
        sourceEventSeq: event.seq,
      });
      if (!row) return;
      await this.events.publish(tx, ctx, {
        type: 'milestone.achieved',
        aggregateKind: 'milestone',
        aggregateId: row.id,
        payload: { key },
      });
    });
  }

  async list(ctx: RequestContext): Promise<Milestone[]> {
    const rows = await inTenant(ctx, (tx) => this.repo.list(tx, ctx.companyId));
    return rows.map(toMilestone);
  }
}
