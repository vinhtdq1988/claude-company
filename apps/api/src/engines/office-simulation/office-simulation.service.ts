import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  DomainError,
  type DomainEvent,
  type EmployeeEngine,
  type EmployeeProfileView,
  type EmployeeStatusChange,
  type ManagedScope,
  type OfficeEmployeeState,
  type OfficeSimulationEngine,
  type OfficeSnapshot,
  type OrganizationEngine,
  type RequestContext,
} from '@claude-company/contracts';
import { withTenant, type Tx } from '@claude-company/db';
import { domainEvent } from '@claude-company/db/schema/events';
import { and, asc, eq, gt, lte, sql } from 'drizzle-orm';
import { EMPLOYEE_ENGINE, ORGANIZATION_ENGINE } from '../../platform/engine-tokens';
import { EventPublisher, toDomainEvent } from '../../platform/events/event-publisher';
import { QueueService } from '../../platform/queue/queues';
import { inTenant, runWithTenantTx } from '../../platform/tenancy/tenant-store';
import { assignDesks } from './office-layout';
import {
  applyEvent,
  COMPLETED_DISPLAY_MS,
  COMPLETED_ELAPSED_EVENT,
  employeeOf,
  newlyCompletedTracks,
  reduceEmployee,
  taskOfTaskLevelEvent,
} from './office-reducer';
import { OfficeZonesService } from './office-zones.service';
import { OfficeRepository, type ChangeRow } from './office.repository';
import { ProfileViewService } from './profile-view.service';

/** Số sự kiện chiếu trong một transaction; công ty có lịch sử dài được chiếu bù theo từng đợt. */
const CHUNK = 500;

/** Sự kiện làm đổi cơ cấu zone hoặc danh sách nhân viên trong zone. */
const affectsZones = (type: string): boolean =>
  type.startsWith('org_unit.') ||
  type === 'employee.created' ||
  type === 'employee.updated' ||
  type === 'employee.archived';

type CompletedSchedule = {
  companyId: string;
  employeeId: string;
  taskId: string;
  sinceSeq: number;
  occurredAt: string;
};

/**
 * Office Simulation Engine (US5): nguồn trạng thái duy nhất của Virtual Office. Projection là một phép gấp (fold)
 * tất định của `domain_event` theo `seq` với mốc `office_cursor` cho từng công ty, nên:
 * - relay chiếu trước khi phát realtime, gateway/snapshot đọc lại luôn thấy dữ liệu đã commit;
 * - sự kiện giao lại hoặc chiếu bù đều idempotent (khóa advisory theo công ty + `appliedSeq` từng nhân viên);
 * - mọi lần đổi trạng thái ghi `employee_status_change` với `seq` của sự kiện nguồn (SC-006).
 */
@Injectable()
export class OfficeSimulationService implements OfficeSimulationEngine {
  private readonly logger = new Logger(OfficeSimulationService.name);
  /** Mốc đã chiếu biết trước theo công ty (chỉ để bỏ qua truy vấn; nguồn sự thật là `office_cursor`). */
  private readonly appliedHint = new Map<string, number>();

  constructor(
    private readonly repo: OfficeRepository,
    private readonly zones: OfficeZonesService,
    private readonly profile: ProfileViewService,
    private readonly events: EventPublisher,
    private readonly queue: QueueService,
    private readonly moduleRef: ModuleRef,
  ) {}

  private get organization(): OrganizationEngine {
    return this.moduleRef.get<OrganizationEngine>(ORGANIZATION_ENGINE, { strict: false });
  }
  private get employees(): EmployeeEngine {
    return this.moduleRef.get<EmployeeEngine>(EMPLOYEE_ENGINE, { strict: false });
  }

  apply(event: DomainEvent, previous?: OfficeEmployeeState): EmployeeStatusChange | null {
    return applyEvent(event, previous);
  }

  // --- chiếu ---

  /** Bộ chiếu của relay: gấp mọi sự kiện đến `event.seq`. */
  async project(event: DomainEvent): Promise<void> {
    await this.projectUpTo(event.companyId, event.seq);
  }

  async projectUpTo(companyId: string, target: number): Promise<void> {
    if ((this.appliedHint.get(companyId) ?? 0) >= target) return;
    for (;;) {
      const chunk = await withTenant(companyId, (tx) =>
        runWithTenantTx(companyId, tx, () => this.projectChunk(tx, companyId, target)),
      );
      this.appliedHint.set(
        companyId,
        Math.max(this.appliedHint.get(companyId) ?? 0, chunk.applied),
      );
      // Lên lịch sau khi commit: nếu enqueue lỗi thì projection vẫn đúng, chỉ chậm về `idle`.
      for (const s of chunk.completed) await this.scheduleElapsed(s);
      if (chunk.done) return;
    }
  }

  private async projectChunk(
    tx: Tx,
    companyId: string,
    target: number,
  ): Promise<{ done: boolean; applied: number; completed: CompletedSchedule[] }> {
    await this.repo.lockCompany(tx, companyId);
    const { appliedSeq, created } = await this.repo.ensureCursor(tx, companyId);
    if (appliedSeq >= target && !created) return { done: true, applied: appliedSeq, completed: [] };

    const rows = await tx
      .select()
      .from(domainEvent)
      .where(
        and(
          eq(domainEvent.companyId, companyId),
          gt(domainEvent.seq, appliedSeq),
          lte(domainEvent.seq, target),
        ),
      )
      .orderBy(asc(domainEvent.seq))
      .limit(CHUNK);
    const events = rows.map(toDomainEvent);

    const completed: CompletedSchedule[] = [];
    for (const event of events) completed.push(...(await this.applyOne(tx, companyId, event)));

    const last = events.at(-1)?.seq ?? appliedSeq;
    if (created || events.some((e) => affectsZones(e.type))) {
      const ctx: RequestContext = {
        companyId,
        actor: { kind: 'system' },
        traceId: `office-zones-${last}`,
      };
      // Lỗi đồng bộ zone (ví dụ engine tổ chức tạm lỗi) không được chặn việc chiếu trạng thái: savepoint giữ
      // transaction còn dùng được; zone sẽ được đồng bộ lại ở sự kiện cơ cấu kế tiếp hoặc khi mở snapshot.
      try {
        await tx.transaction((sp) =>
          runWithTenantTx(companyId, sp, () => this.zones.sync(sp, ctx)),
        );
      } catch (error) {
        this.logger.warn(
          `Đồng bộ office_zone lỗi (seq ${last}): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (events.length > 0) await this.repo.setCursor(tx, companyId, last);
    return { done: events.length < CHUNK, applied: last, completed };
  }

  /** Áp một sự kiện cho nhân viên chính và (sự kiện cấp task) cho mọi nhân viên đang có track trên task. */
  private async applyOne(
    tx: Tx,
    companyId: string,
    event: DomainEvent,
  ): Promise<CompletedSchedule[]> {
    const targets = new Set<string>();
    const primary = employeeOf(event);
    if (primary) targets.add(primary);
    const taskId = taskOfTaskLevelEvent(event);
    if (taskId) {
      for (const id of await this.repo.employeesWithTrack(tx, companyId, taskId)) targets.add(id);
    }

    const completed: CompletedSchedule[] = [];
    for (const employeeId of targets) {
      const previous = await this.repo.loadState(tx, companyId, employeeId);
      const result = reduceEmployee(event, previous);
      if (!result.persistedChanged) continue;
      const at = new Date(event.occurredAt);
      await this.repo.saveState(tx, companyId, result.next, at, result.displayChanged);
      if (result.displayChanged) {
        await this.repo.insertChange(tx, {
          companyId,
          seq: event.seq,
          aiEmployeeId: employeeId,
          state: result.next.state,
          previousState: previous.state,
          currentTaskId: result.next.currentTaskId,
          currentTool: result.next.currentTool,
          progress: result.next.progress === null ? null : Math.round(result.next.progress),
          sourceEventType: event.type,
          occurredAt: at,
        });
      }
      for (const track of newlyCompletedTracks(event, result.next)) {
        completed.push({
          companyId,
          employeeId,
          taskId: track.taskId,
          sinceSeq: track.seq,
          occurredAt: event.occurredAt,
        });
      }
    }
    return completed;
  }

  private async scheduleElapsed(s: CompletedSchedule): Promise<void> {
    const elapsedMs = Date.now() - Date.parse(s.occurredAt);
    try {
      await this.queue.enqueue(
        'office.completed-elapsed',
        {
          companyId: s.companyId,
          taskId: s.taskId,
          employeeId: s.employeeId,
          sinceSeq: s.sinceSeq,
        },
        {
          jobId: `office-completed-${s.employeeId}-${s.sinceSeq}`,
          // Chiếu bù sự kiện cũ thì hết hạn ngay.
          delayMs: Math.max(0, COMPLETED_DISPLAY_MS - elapsedMs),
        },
      );
    } catch (error) {
      this.logger.error(
        `Không lên lịch được office.completed-elapsed (nhân viên ${s.employeeId}, seq ${s.sinceSeq})`,
        error instanceof Error ? error : String(error),
      );
    }
  }

  /** Thay đổi trạng thái do đúng sự kiện này gây ra (đã chiếu, đã commit) để gateway dựng envelope. */
  async changesFor(event: DomainEvent): Promise<ChangeRow[]> {
    await this.projectUpTo(event.companyId, event.seq);
    return withTenant(event.companyId, (tx) => this.repo.changesAt(tx, event.companyId, event.seq));
  }

  // --- snapshot ---

  private async maxSeq(companyId: string): Promise<number> {
    return withTenant(companyId, async (tx) => {
      const r = await tx.execute<{ max: string | null }>(
        sql`select max(seq) as max from domain_event where company_id = ${companyId}`,
      );
      return Number(r.rows[0]?.max ?? 0);
    });
  }

  private async scopeOf(ctx: RequestContext): Promise<ManagedScope> {
    if (ctx.actor.kind === 'human') {
      return this.organization.resolveManagedScope(ctx, ctx.actor.memberId);
    }
    if (ctx.actor.kind === 'system') {
      return { companyWide: true, orgUnitIds: [], teamIds: [], employeeIds: [] };
    }
    throw new DomainError('FORBIDDEN', 'Chỉ người dùng được xem Virtual Office');
  }

  async getSnapshot(ctx: RequestContext): Promise<OfficeSnapshot> {
    const scope = await this.scopeOf(ctx);
    await this.projectUpTo(ctx.companyId, await this.maxSeq(ctx.companyId));

    // Giữ khóa chiếu khi đọc để `seq` và dữ liệu cùng một mốc.
    const read = await withTenant(ctx.companyId, async (tx) => {
      await this.repo.lockCompany(tx, ctx.companyId);
      const seq = await this.repo.readCursor(tx, ctx.companyId);
      let zones = await this.repo.listZones(tx, ctx.companyId);
      if (zones.length === 0) {
        await runWithTenantTx(ctx.companyId, tx, () =>
          this.zones.sync(tx, { ...ctx, actor: { kind: 'system' } }),
        );
        zones = await this.repo.listZones(tx, ctx.companyId);
      }
      return { seq, zones, statuses: await this.repo.listStatuses(tx, ctx.companyId) };
    });

    const all = (await this.employees.list(ctx, {})).filter((e) => e.status !== 'archived');
    const desks = assignDesks(all);
    const zoneOfUnit = new Map(read.zones.filter((z) => z.orgUnitId).map((z) => [z.orgUnitId, z]));
    const ceoZone = read.zones.find((z) => z.kind === 'ceo_office');
    const statusOf = new Map(read.statuses.map((s) => [s.aiEmployeeId, s]));
    const visible = all.filter((e) => scope.companyWide || scope.employeeIds.includes(e.id));

    const employees: OfficeSnapshot['employees'] = [];
    for (const e of visible) {
      const desk = desks.get(e.id);
      const zone = desk
        ? desk.orgUnitId
          ? zoneOfUnit.get(desk.orgUnitId)
          : ceoZone // nhân viên không có đơn vị nhà ngồi ở CEO Office
        : undefined;
      if (!desk || !zone) continue;
      const s = statusOf.get(e.id);
      employees.push({
        id: e.id,
        name: e.name,
        avatarKey: e.avatarKey,
        zoneId: zone.id,
        deskIndex: desk.deskIndex,
        state: s?.state ?? 'idle',
        currentTaskId: s?.currentTaskId ?? null,
        currentTool: s?.currentTool ?? null,
        progress: s?.progress ?? null,
      });
    }

    const unitsInView = new Set<string>([
      ...scope.orgUnitIds,
      ...visible.flatMap((e) => (e.homeOrgUnitId ? [e.homeOrgUnitId] : [])),
    ]);
    const zones = read.zones
      .filter(
        (z) =>
          scope.companyWide ||
          z.kind !== 'department' ||
          (z.orgUnitId && unitsInView.has(z.orgUnitId)),
      )
      .map((z) => ({
        id: z.id,
        kind: z.kind,
        name: z.name,
        orgUnitId: z.orgUnitId,
        layout: z.layout,
      }));
    return { seq: read.seq, zones, employees };
  }

  getProfileView(ctx: RequestContext, employeeId: string): Promise<EmployeeProfileView> {
    return this.profile.build(ctx, employeeId);
  }

  // --- hết thời gian hiển thị completed ---

  async completeDisplayElapsed(
    ctx: RequestContext,
    input: { employeeId: string; taskId: string; sinceSeq: number },
  ): Promise<boolean> {
    return inTenant(ctx, async (tx) => {
      const row = await this.repo.getStatus(tx, ctx.companyId, input.employeeId);
      const track = row?.tracks[input.taskId];
      if (!track || track.state !== 'completed' || track.seq !== input.sinceSeq) return false;
      await this.events.publish(tx, ctx, {
        type: COMPLETED_ELAPSED_EVENT,
        aggregateKind: 'ai_employee',
        aggregateId: input.employeeId,
        payload: { employeeId: input.employeeId, taskId: input.taskId, sinceSeq: input.sinceSeq },
      });
      return true;
    });
  }
}
