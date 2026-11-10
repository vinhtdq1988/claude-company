import { Injectable } from '@nestjs/common';
import type { Tx } from '@claude-company/db';
import { milestone } from '@claude-company/db/schema/gamification';
import type { Milestone, MilestoneKey } from '@claude-company/contracts';
import { asc, eq } from 'drizzle-orm';

export type MilestoneRow = typeof milestone.$inferSelect;

export const toMilestone = (row: MilestoneRow): Milestone => ({
  key: row.key,
  achievedAt: row.achievedAt.toISOString(),
  sourceEventSeq: row.sourceEventSeq,
});

@Injectable()
export class GamificationRepository {
  /** `null` nếu cột mốc đã có (UNIQUE(company_id, key)): sự kiện giao lại không tạo bản ghi thứ hai. */
  async insertIfAbsent(
    tx: Tx,
    companyId: string,
    values: { key: MilestoneKey; achievedAt: Date; sourceEventSeq: number },
  ): Promise<MilestoneRow | null> {
    const [row] = await tx
      .insert(milestone)
      .values({ companyId, ...values })
      .onConflictDoNothing({ target: [milestone.companyId, milestone.key] })
      .returning();
    return row ?? null;
  }

  list(tx: Tx, companyId: string): Promise<MilestoneRow[]> {
    return tx
      .select()
      .from(milestone)
      .where(eq(milestone.companyId, companyId))
      .orderBy(asc(milestone.achievedAt), asc(milestone.sourceEventSeq));
  }
}
