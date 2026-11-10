import { Global, Module, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { DomainEvent, OfficeLayoutReason } from '@claude-company/contracts';
import { OFFICE_SIMULATION_ENGINE } from '../../platform/engine-tokens';
import { EnvelopeMapperRegistry, type EnvelopeSpec } from '../../platform/events/envelope-mapper';
import { EventBus } from '../../platform/events/event-bus';
import { OfficeController } from './office.controller';
import { OfficeRepository, type ChangeRow } from './office.repository';
import { OfficeSimulationService } from './office-simulation.service';
import { OfficeZonesService } from './office-zones.service';
import { ProfileViewService } from './profile-view.service';

/** Lý do `office.layout_changed` theo loại sự kiện; sự kiện khác không đổi bố cục. */
export function layoutReasonOf(event: DomainEvent): OfficeLayoutReason | null {
  const p = event.payload as { homeOrgUnitId?: string; previousHomeOrgUnitId?: string };
  switch (event.type) {
    case 'org_unit.created':
      return 'org_unit_created';
    case 'org_unit.updated':
      return 'org_unit_updated';
    case 'org_unit.archived':
      return 'org_unit_archived';
    case 'employee.created':
      return 'employee_added';
    case 'employee.archived':
      return 'employee_removed';
    case 'employee.updated':
      return p.previousHomeOrgUnitId !== undefined && p.previousHomeOrgUnitId !== p.homeOrgUnitId
        ? 'employee_moved'
        : 'employee_updated';
    default:
      return null;
  }
}

const toStatusEnvelope = (row: ChangeRow): EnvelopeSpec => ({
  room: 'company',
  type: 'office.employee_status_changed',
  payload: {
    employeeId: row.aiEmployeeId,
    state: row.state,
    previousState: row.previousState,
    currentTaskId: row.currentTaskId ?? undefined,
    currentTool: row.currentTool ?? undefined,
    progress: row.progress ?? undefined,
    sourceEventType: row.sourceEventType,
  },
  visibility: { kind: 'employee', employeeId: row.aiEmployeeId },
});

/** Số envelope đã dựng được nhớ lại để N socket cùng nhận một sự kiện chỉ tốn một lần đọc. */
const MEMO_LIMIT = 1000;

/**
 * Binding thật của OfficeSimulationEngine. Được nạp ở cả api lẫn worker vì relay chạy ở process nào thắng khóa công
 * ty thì process đó chiếu sự kiện (giống OrchestrationModule); controller chỉ có tác dụng ở api.
 */
@Global()
@Module({
  controllers: [OfficeController],
  providers: [
    OfficeRepository,
    OfficeZonesService,
    ProfileViewService,
    OfficeSimulationService,
    { provide: OFFICE_SIMULATION_ENGINE, useExisting: OfficeSimulationService },
  ],
  exports: [OFFICE_SIMULATION_ENGINE, OfficeSimulationService],
})
export class OfficeSimulationModule implements OnModuleInit, OnModuleDestroy {
  private unsubscribe: (() => void) | undefined;
  private readonly memo = new Map<string, Promise<EnvelopeSpec[]>>();

  constructor(
    private readonly bus: EventBus,
    private readonly mappers: EnvelopeMapperRegistry,
    private readonly office: OfficeSimulationService,
  ) {}

  onModuleInit(): void {
    // Chiếu mọi sự kiện trước khi relay phát ra realtime (bus.project).
    this.unsubscribe = this.bus.subscribeProjection('*', (event) => this.office.project(event));

    // `office.employee_status_changed` đọc từ projection đã commit nên mọi lần phát (live hay phát lại) đều giống nhau.
    this.mappers.register('*', (event) => {
      const key = `${event.companyId}:${event.seq}`;
      let specs = this.memo.get(key);
      if (!specs) {
        specs = this.build(event);
        this.memo.set(key, specs);
        // Lỗi không được nhớ: lần phát sau thử lại.
        specs.catch(() => this.memo.delete(key));
        if (this.memo.size > MEMO_LIMIT) {
          const oldest = this.memo.keys().next().value;
          if (oldest !== undefined) this.memo.delete(oldest);
        }
      }
      return specs;
    });
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
  }

  private async build(event: DomainEvent): Promise<EnvelopeSpec[]> {
    const specs: EnvelopeSpec[] = (await this.office.changesFor(event)).map(toStatusEnvelope);
    const reason = layoutReasonOf(event);
    // Cấu trúc văn phòng không nhạy cảm: phát cho mọi thành viên, snapshot mới vẫn lọc theo phạm vi.
    if (reason) {
      specs.push({
        room: 'company',
        type: 'office.layout_changed',
        payload: { reason },
        visibility: { kind: 'all' },
      });
    }
    return specs;
  }
}
