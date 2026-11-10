import { Injectable } from '@nestjs/common';
import type { ApprovalRequest, ApprovalStatus } from '@claude-company/contracts';
import type { Tx } from '@claude-company/db';
import { approvalRequest } from '@claude-company/db/schema/permission';
import { and, desc, eq, inArray, lte, or, sql, isNull } from 'drizzle-orm';

export type ApprovalRow = typeof approvalRequest.$inferSelect;
export type NewApprovalRow = typeof approvalRequest.$inferInsert;

export function toApproval(row: ApprovalRow): ApprovalRequest {
  return {
    id: row.id,
    toolInvocationId: row.toolInvocationId,
    runId: row.agentRunId,
    taskId: row.taskId,
    employeeId: row.aiEmployeeId,
    actionType: row.actionType,
    summary: row.summary,
    rationale: row.rationale,
    payload: row.payload,
    payloadHash: row.payloadHash,
    approverMemberId: row.approverMemberId ?? '',
    status: row.status,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decisionReason: row.decisionReason,
    lastRemindedAt: row.lastRemindedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Truy cập bảng `approval_request` (Permission Engine sở hữu). Mọi phương thức chạy trong transaction `withTenant` (RLS). */
@Injectable()
export class ApprovalRepository {
  async insert(tx: Tx, row: NewApprovalRow): Promise<ApprovalRow> {
    const [inserted] = await tx.insert(approvalRequest).values(row).returning();
    if (!inserted) throw new Error('Không ghi được approval_request');
    return inserted;
  }

  async findById(
    tx: Tx,
    companyId: string,
    id: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<ApprovalRow | undefined> {
    const query = tx
      .select()
      .from(approvalRequest)
      .where(and(eq(approvalRequest.companyId, companyId), eq(approvalRequest.id, id)));
    const [row] = options.forUpdate ? await query.for('update') : await query;
    return row;
  }

  async findByInvocation(
    tx: Tx,
    companyId: string,
    toolInvocationId: string,
  ): Promise<ApprovalRow | undefined> {
    const [row] = await tx
      .select()
      .from(approvalRequest)
      .where(
        and(
          eq(approvalRequest.companyId, companyId),
          eq(approvalRequest.toolInvocationId, toolInvocationId),
        ),
      );
    return row;
  }

  list(
    tx: Tx,
    companyId: string,
    filter: { status?: ApprovalStatus; taskId?: string; employeeIds?: string[]; limit: number },
  ): Promise<ApprovalRow[]> {
    // Danh sách rỗng nghĩa là "không có nhân viên nào trong phạm vi": không được rơi về "không lọc".
    if (filter.employeeIds && filter.employeeIds.length === 0) return Promise.resolve([]);
    return tx
      .select()
      .from(approvalRequest)
      .where(
        and(
          eq(approvalRequest.companyId, companyId),
          filter.status ? eq(approvalRequest.status, filter.status) : undefined,
          filter.taskId ? eq(approvalRequest.taskId, filter.taskId) : undefined,
          filter.employeeIds
            ? inArray(approvalRequest.aiEmployeeId, filter.employeeIds)
            : undefined,
        ),
      )
      .orderBy(desc(approvalRequest.createdAt))
      .limit(filter.limit);
  }

  /** Cập nhật có điều kiện `status = pending`: trả `undefined` nếu đã có người quyết định trước. */
  async decidePending(
    tx: Tx,
    companyId: string,
    id: string,
    patch: {
      status: 'approved' | 'rejected' | 'cancelled';
      decidedBy: string | null;
      decisionReason: string | null;
    },
  ): Promise<ApprovalRow | undefined> {
    const [row] = await tx
      .update(approvalRequest)
      .set({ ...patch, decidedAt: new Date() })
      .where(
        and(
          eq(approvalRequest.companyId, companyId),
          eq(approvalRequest.id, id),
          eq(approvalRequest.status, 'pending'),
        ),
      )
      .returning();
    return row;
  }

  listPendingOfTask(tx: Tx, companyId: string, taskId: string): Promise<ApprovalRow[]> {
    return tx
      .select()
      .from(approvalRequest)
      .where(
        and(
          eq(approvalRequest.companyId, companyId),
          eq(approvalRequest.taskId, taskId),
          eq(approvalRequest.status, 'pending'),
        ),
      );
  }

  listPendingOfApprover(tx: Tx, companyId: string, memberId: string): Promise<ApprovalRow[]> {
    return tx
      .select()
      .from(approvalRequest)
      .where(
        and(
          eq(approvalRequest.companyId, companyId),
          eq(approvalRequest.approverMemberId, memberId),
          eq(approvalRequest.status, 'pending'),
        ),
      );
  }

  async reassign(tx: Tx, companyId: string, id: string, memberId: string): Promise<void> {
    await tx
      .update(approvalRequest)
      .set({ approverMemberId: memberId })
      .where(and(eq(approvalRequest.companyId, companyId), eq(approvalRequest.id, id)));
  }

  /** Yêu cầu đang chờ đến hạn nhắc: lần đầu sau `firstBefore`, các lần sau sau `repeatBefore`. */
  listDueForReminder(
    tx: Tx,
    companyId: string,
    due: { firstBefore: Date; repeatBefore: Date },
  ): Promise<ApprovalRow[]> {
    return tx
      .select()
      .from(approvalRequest)
      .where(
        and(
          eq(approvalRequest.companyId, companyId),
          eq(approvalRequest.status, 'pending'),
          or(
            and(
              isNull(approvalRequest.lastRemindedAt),
              lte(approvalRequest.createdAt, due.firstBefore),
            ),
            lte(approvalRequest.lastRemindedAt, due.repeatBefore),
          ),
        ),
      );
  }

  async markReminded(tx: Tx, companyId: string, id: string, at: Date): Promise<void> {
    await tx
      .update(approvalRequest)
      .set({ lastRemindedAt: at })
      .where(
        and(
          eq(approvalRequest.companyId, companyId),
          eq(approvalRequest.id, id),
          sql`${approvalRequest.status} = 'pending'`,
        ),
      );
  }
}
