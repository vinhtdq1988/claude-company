import { Injectable } from '@nestjs/common';
import type { OfficeEmployeeState, OfficeTrack } from '@claude-company/contracts';
import type { Tx } from '@claude-company/db';
import {
  employeeStatus,
  employeeStatusChange,
  officeCursor,
  officeZone,
} from '@claude-company/db/schema/office';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { initialEmployeeState } from './office-reducer';

export type StatusRow = typeof employeeStatus.$inferSelect;
export type ChangeRow = typeof employeeStatusChange.$inferSelect;
export type ZoneRow = typeof officeZone.$inferSelect;

export function toEmployeeState(row: StatusRow): OfficeEmployeeState {
  return {
    employeeId: row.aiEmployeeId,
    suspended: row.suspended,
    tracks: row.tracks as Record<string, OfficeTrack>,
    appliedSeq: row.appliedSeq,
    state: row.state,
    currentTaskId: row.currentTaskId,
    currentTool: row.currentTool,
    progress: row.progress,
    sourceSeq: row.sourceEventSeq,
  };
}

/** Truy cập bảng của Office Simulation Engine (employee_status, employee_status_change, office_cursor, office_zone). */
@Injectable()
export class OfficeRepository {
  /** Khóa tuần tự hóa chiếu và đọc snapshot của một công ty; giữ đến hết transaction. */
  async lockCompany(tx: Tx, companyId: string): Promise<void> {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`office:${companyId}`}, 0))`,
    );
  }

  /** Trả mốc đã chiếu và `true` nếu đây là lần đầu công ty có projection. */
  async ensureCursor(tx: Tx, companyId: string): Promise<{ appliedSeq: number; created: boolean }> {
    const inserted = await tx
      .insert(officeCursor)
      .values({ companyId })
      .onConflictDoNothing()
      .returning({ appliedSeq: officeCursor.appliedSeq });
    if (inserted[0]) return { appliedSeq: inserted[0].appliedSeq, created: true };
    const [row] = await tx
      .select({ appliedSeq: officeCursor.appliedSeq })
      .from(officeCursor)
      .where(eq(officeCursor.companyId, companyId));
    return { appliedSeq: row?.appliedSeq ?? 0, created: false };
  }

  async setCursor(tx: Tx, companyId: string, appliedSeq: number): Promise<void> {
    await tx.update(officeCursor).set({ appliedSeq }).where(eq(officeCursor.companyId, companyId));
  }

  async readCursor(tx: Tx, companyId: string): Promise<number> {
    const [row] = await tx
      .select({ appliedSeq: officeCursor.appliedSeq })
      .from(officeCursor)
      .where(eq(officeCursor.companyId, companyId));
    return row?.appliedSeq ?? 0;
  }

  async getStatus(tx: Tx, companyId: string, employeeId: string): Promise<StatusRow | undefined> {
    const [row] = await tx
      .select()
      .from(employeeStatus)
      .where(
        and(eq(employeeStatus.companyId, companyId), eq(employeeStatus.aiEmployeeId, employeeId)),
      );
    return row;
  }

  async listStatuses(tx: Tx, companyId: string): Promise<StatusRow[]> {
    return tx.select().from(employeeStatus).where(eq(employeeStatus.companyId, companyId));
  }

  /** Nhân viên đang có track trên task: sự kiện cấp task (rời `blocked`, hủy…) phải áp cho cả họ. */
  async employeesWithTrack(tx: Tx, companyId: string, taskId: string): Promise<string[]> {
    const rows = await tx
      .select({ id: employeeStatus.aiEmployeeId })
      .from(employeeStatus)
      .where(
        and(eq(employeeStatus.companyId, companyId), sql`${employeeStatus.tracks} ? ${taskId}`),
      );
    return rows.map((r) => r.id);
  }

  async loadState(tx: Tx, companyId: string, employeeId: string): Promise<OfficeEmployeeState> {
    const row = await this.getStatus(tx, companyId, employeeId);
    return row ? toEmployeeState(row) : initialEmployeeState(employeeId);
  }

  async saveState(
    tx: Tx,
    companyId: string,
    s: OfficeEmployeeState,
    changedAt: Date,
    displayChanged: boolean,
  ): Promise<void> {
    const values = {
      state: s.state,
      currentTaskId: s.currentTaskId,
      currentTool: s.currentTool,
      progress: s.progress === null ? null : Math.round(s.progress),
      suspended: s.suspended,
      tracks: s.tracks,
      appliedSeq: s.appliedSeq,
      sourceEventSeq: s.sourceSeq,
    };
    await tx
      .insert(employeeStatus)
      .values({ companyId, aiEmployeeId: s.employeeId, ...values, changedAt })
      .onConflictDoUpdate({
        target: [employeeStatus.companyId, employeeStatus.aiEmployeeId],
        set: displayChanged ? { ...values, changedAt } : values,
      });
  }

  async insertChange(tx: Tx, row: ChangeRow): Promise<void> {
    await tx.insert(employeeStatusChange).values(row).onConflictDoNothing();
  }

  async changesAt(tx: Tx, companyId: string, seq: number): Promise<ChangeRow[]> {
    return tx
      .select()
      .from(employeeStatusChange)
      .where(and(eq(employeeStatusChange.companyId, companyId), eq(employeeStatusChange.seq, seq)))
      .orderBy(asc(employeeStatusChange.aiEmployeeId));
  }

  async listZones(tx: Tx, companyId: string): Promise<ZoneRow[]> {
    return tx.select().from(officeZone).where(eq(officeZone.companyId, companyId));
  }

  async insertZone(
    tx: Tx,
    companyId: string,
    z: Pick<ZoneRow, 'kind' | 'orgUnitId' | 'name' | 'layout'>,
  ): Promise<void> {
    await tx.insert(officeZone).values({ companyId, ...z });
  }

  async updateZone(
    tx: Tx,
    companyId: string,
    id: string,
    z: Pick<ZoneRow, 'name' | 'layout'>,
  ): Promise<void> {
    await tx
      .update(officeZone)
      .set(z)
      .where(and(eq(officeZone.companyId, companyId), eq(officeZone.id, id)));
  }

  async deleteZones(tx: Tx, companyId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await tx
      .delete(officeZone)
      .where(and(eq(officeZone.companyId, companyId), inArray(officeZone.id, ids)));
  }
}
