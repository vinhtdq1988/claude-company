import { Injectable } from '@nestjs/common';
import type { Tx } from '@claude-company/db';
import {
  artifact,
  evidence,
  reviewRecord,
  task,
  taskDependency,
} from '@claude-company/db/schema/task';
import {
  PRIORITY_RANK,
  type Artifact,
  type Evidence,
  type ReviewRecord,
  type Task,
  type TaskFilter,
  type TaskStatus,
} from '@claude-company/contracts';
import { and, asc, desc, eq, inArray, lt, ne, notInArray, or, sql, type SQL } from 'drizzle-orm';

export type TaskRow = typeof task.$inferSelect;
export type NewTaskRow = typeof task.$inferInsert;
export type ArtifactRow = typeof artifact.$inferSelect;
export type EvidenceRow = typeof evidence.$inferSelect;
export type ReviewRow = typeof reviewRecord.$inferSelect;

const FINISHED: TaskStatus[] = ['completed', 'cancelled'];

export function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    parentTaskId: row.parentTaskId,
    title: row.title,
    objective: row.objective,
    createdByMemberId: row.createdByMemberId,
    assignedByAiEmployeeId: row.assignedByAiEmployeeId,
    assigneeKind: row.assigneeKind,
    assigneeId: row.assigneeId,
    deadline: row.deadline.toISOString(),
    priority: row.priority,
    acceptanceCriteria: row.acceptanceCriteria,
    expectedOutput: row.expectedOutput,
    status: row.status,
    blockedFrom: row.blockedFrom,
    blockedReason: row.blockedReason,
    isOverdue: row.isOverdue,
    reworkCount: row.reworkCount,
    reworkBaseline: row.reworkBaseline,
    tokenCap: row.tokenCap,
    costCap: row.costCap === null ? null : Number(row.costCap),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toArtifact(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    taskId: row.taskId,
    agentRunId: row.agentRunId,
    createdByEmployeeId: row.createdByEmployeeId,
    kind: row.kind,
    title: row.title,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    checksumSha256: row.checksumSha256,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toEvidence(row: EvidenceRow): Evidence {
  return {
    id: row.id,
    taskId: row.taskId,
    criterionId: row.criterionId,
    artifactId: row.artifactId,
    reviewerKind: row.reviewerKind,
    reviewerId: row.reviewerId,
    verdict: row.verdict,
    explanation: row.explanation,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toReview(row: ReviewRow): ReviewRecord {
  return {
    id: row.id,
    taskId: row.taskId,
    stage: row.stage,
    reviewerKind: row.reviewerKind,
    reviewerId: row.reviewerId,
    decision: row.decision,
    reason: row.reason,
    decidedAt: row.decidedAt.toISOString(),
  };
}

/** Con trỏ phân trang theo (created_at, id) giảm dần. */
export function encodeCursor(row: Pick<TaskRow, 'createdAt' | 'id'>): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`).toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  try {
    const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    const createdAt = new Date(iso ?? '');
    return id && !Number.isNaN(createdAt.getTime()) ? { createdAt, id } : null;
  } catch {
    return null;
  }
}

/**
 * Các tập assignee đã được mở rộng cho bộ lọc theo đơn vị hoặc phạm vi quản lý.
 * Task Engine không đọc bảng của engine khác nên service mở rộng id trước rồi truyền vào repository.
 */
export type AssigneeSets = {
  employeeIds: string[];
  teamIds: string[];
  orgUnitIds: string[];
};

/** Truy cập bảng của Task Engine. Mọi phương thức chạy trong transaction `withTenant` (RLS). */
@Injectable()
export class TaskRepository {
  // --- task ---

  async insert(tx: Tx, values: NewTaskRow): Promise<TaskRow> {
    const [row] = await tx.insert(task).values(values).returning();
    if (!row) throw new Error('Không tạo được task');
    return row;
  }

  async update(
    tx: Tx,
    companyId: string,
    id: string,
    patch: Partial<Omit<NewTaskRow, 'id' | 'companyId'>>,
  ): Promise<TaskRow> {
    const [row] = await tx
      .update(task)
      .set(patch)
      .where(and(eq(task.companyId, companyId), eq(task.id, id)))
      .returning();
    if (!row) throw new Error('Không cập nhật được task');
    return row;
  }

  /** `forUpdate` khóa dòng trong transaction để hai chuyển trạng thái song song không chồng nhau. */
  async find(
    tx: Tx,
    companyId: string,
    id: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<TaskRow | undefined> {
    const query = tx
      .select()
      .from(task)
      .where(and(eq(task.companyId, companyId), eq(task.id, id)));
    const [row] = options.forUpdate ? await query.for('update') : await query;
    return row;
  }

  async findMany(tx: Tx, companyId: string, ids: string[]): Promise<TaskRow[]> {
    if (ids.length === 0) return [];
    return tx
      .select()
      .from(task)
      .where(and(eq(task.companyId, companyId), inArray(task.id, ids)));
  }

  listChildren(tx: Tx, companyId: string, parentId: string): Promise<TaskRow[]> {
    return tx
      .select()
      .from(task)
      .where(and(eq(task.companyId, companyId), eq(task.parentTaskId, parentId)))
      .orderBy(asc(task.createdAt), asc(task.id));
  }

  /**
   * Danh sách có lọc. `assignees` (từ phạm vi hoặc đơn vị) giới hạn task có assignee thuộc các tập đó.
   * `order = queue`: priority giảm dần, deadline tăng dần, rồi thứ tự tạo — thứ tự chờ slot (US2-AS5).
   */
  async list(
    tx: Tx,
    companyId: string,
    filter: TaskFilter,
    assignees?: AssigneeSets,
  ): Promise<{ rows: TaskRow[]; nextCursor: string | null }> {
    const conditions: SQL[] = [eq(task.companyId, companyId)];
    if (filter.statusIn) {
      if (filter.statusIn.length === 0) return { rows: [], nextCursor: null };
      conditions.push(inArray(task.status, filter.statusIn));
    }
    if (filter.assigneeKind) conditions.push(eq(task.assigneeKind, filter.assigneeKind));
    if (filter.assigneeId) conditions.push(eq(task.assigneeId, filter.assigneeId));
    if (filter.priority) conditions.push(eq(task.priority, filter.priority));
    if (filter.overdue !== undefined) conditions.push(eq(task.isOverdue, filter.overdue));
    if (filter.deadlineBefore) conditions.push(lt(task.deadline, new Date(filter.deadlineBefore)));
    if (filter.rootOnly) conditions.push(sql`${task.parentTaskId} is null`);
    if (filter.parentTaskId) conditions.push(eq(task.parentTaskId, filter.parentTaskId));
    if (filter.ids) {
      if (filter.ids.length === 0) return { rows: [], nextCursor: null };
      conditions.push(inArray(task.id, filter.ids));
    }
    if (assignees) {
      const parts: SQL[] = [];
      if (assignees.employeeIds.length > 0)
        parts.push(
          and(
            eq(task.assigneeKind, 'ai_employee'),
            inArray(task.assigneeId, assignees.employeeIds),
          ) as SQL,
        );
      if (assignees.teamIds.length > 0)
        parts.push(
          and(eq(task.assigneeKind, 'team'), inArray(task.assigneeId, assignees.teamIds)) as SQL,
        );
      if (assignees.orgUnitIds.length > 0)
        parts.push(
          and(
            eq(task.assigneeKind, 'org_unit'),
            inArray(task.assigneeId, assignees.orgUnitIds),
          ) as SQL,
        );
      if (parts.length === 0) return { rows: [], nextCursor: null };
      conditions.push(or(...parts) as SQL);
    }

    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    if (filter.order === 'queue') {
      const rank = sql`case ${task.priority} when 'urgent' then ${PRIORITY_RANK.urgent} when 'high' then ${PRIORITY_RANK.high} when 'medium' then ${PRIORITY_RANK.medium} else ${PRIORITY_RANK.low} end`;
      const rows = await tx
        .select()
        .from(task)
        .where(and(...conditions))
        .orderBy(desc(rank), asc(task.deadline), asc(task.createdAt), asc(task.id))
        .limit(limit);
      return { rows, nextCursor: null };
    }

    const cursor = filter.cursor ? decodeCursor(filter.cursor) : null;
    if (cursor) {
      conditions.push(
        or(
          lt(task.createdAt, cursor.createdAt),
          and(eq(task.createdAt, cursor.createdAt), lt(task.id, cursor.id)),
        ) as SQL,
      );
    }
    const rows = await tx
      .select()
      .from(task)
      .where(and(...conditions))
      .orderBy(desc(task.createdAt), desc(task.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { rows: page, nextCursor: rows.length > limit && last ? encodeCursor(last) : null };
  }

  /** Task chưa kết thúc đã quá hạn mà chưa đặt cờ `is_overdue`. */
  async markOverdue(tx: Tx, companyId: string, now: Date): Promise<TaskRow[]> {
    return tx
      .update(task)
      .set({ isOverdue: true })
      .where(
        and(
          eq(task.companyId, companyId),
          eq(task.isOverdue, false),
          lt(task.deadline, now),
          notInArray(task.status, FINISHED),
          ne(task.status, 'draft'),
        ),
      )
      .returning();
  }

  // --- thống kê ---

  async statsRows(
    tx: Tx,
    companyId: string,
    options: { assignees?: AssigneeSets; rootOnly?: boolean },
  ): Promise<TaskRow[]> {
    const conditions: SQL[] = [eq(task.companyId, companyId)];
    if (options.rootOnly) conditions.push(sql`${task.parentTaskId} is null`);
    const a = options.assignees;
    if (a) {
      const parts: SQL[] = [];
      if (a.employeeIds.length > 0)
        parts.push(
          and(eq(task.assigneeKind, 'ai_employee'), inArray(task.assigneeId, a.employeeIds)) as SQL,
        );
      if (a.teamIds.length > 0)
        parts.push(and(eq(task.assigneeKind, 'team'), inArray(task.assigneeId, a.teamIds)) as SQL);
      if (a.orgUnitIds.length > 0)
        parts.push(
          and(eq(task.assigneeKind, 'org_unit'), inArray(task.assigneeId, a.orgUnitIds)) as SQL,
        );
      if (parts.length === 0) return [];
      conditions.push(or(...parts) as SQL);
    }
    return tx
      .select()
      .from(task)
      .where(and(...conditions));
  }

  // --- task_dependency ---

  async insertDependencies(
    tx: Tx,
    companyId: string,
    edges: Array<{ taskId: string; dependsOnTaskId: string }>,
  ): Promise<void> {
    if (edges.length === 0) return;
    await tx.insert(taskDependency).values(edges.map((e) => ({ ...e, companyId })));
  }

  async listDependencyIds(tx: Tx, companyId: string, taskId: string): Promise<string[]> {
    const rows = await tx
      .select({ id: taskDependency.dependsOnTaskId })
      .from(taskDependency)
      .where(and(eq(taskDependency.companyId, companyId), eq(taskDependency.taskId, taskId)));
    return rows.map((r) => r.id);
  }

  /** Mọi cạnh phụ thuộc của công ty, để kiểm tra vòng khi tạo task có `dependsOn`. */
  async listAllEdges(tx: Tx, companyId: string): Promise<Array<readonly [string, string]>> {
    const rows = await tx
      .select({ from: taskDependency.taskId, to: taskDependency.dependsOnTaskId })
      .from(taskDependency)
      .where(eq(taskDependency.companyId, companyId));
    return rows.map((r) => [r.from, r.to] as const);
  }

  // --- artifact ---

  async insertArtifact(tx: Tx, values: typeof artifact.$inferInsert): Promise<ArtifactRow> {
    const [row] = await tx.insert(artifact).values(values).returning();
    if (!row) throw new Error('Không tạo được artifact');
    return row;
  }

  listArtifacts(tx: Tx, companyId: string, taskId: string): Promise<ArtifactRow[]> {
    return tx
      .select()
      .from(artifact)
      .where(and(eq(artifact.companyId, companyId), eq(artifact.taskId, taskId)))
      .orderBy(asc(artifact.createdAt), asc(artifact.id));
  }

  async findArtifact(tx: Tx, companyId: string, id: string): Promise<ArtifactRow | undefined> {
    const [row] = await tx
      .select()
      .from(artifact)
      .where(and(eq(artifact.companyId, companyId), eq(artifact.id, id)));
    return row;
  }

  // --- evidence ---

  async insertEvidence(tx: Tx, values: Array<typeof evidence.$inferInsert>): Promise<void> {
    if (values.length > 0) await tx.insert(evidence).values(values);
  }

  listEvidence(tx: Tx, companyId: string, taskId: string): Promise<EvidenceRow[]> {
    return tx
      .select()
      .from(evidence)
      .where(and(eq(evidence.companyId, companyId), eq(evidence.taskId, taskId)))
      .orderBy(asc(evidence.createdAt), asc(evidence.id));
  }

  // --- review_record (chỉ INSERT) ---

  async insertReview(tx: Tx, values: typeof reviewRecord.$inferInsert): Promise<ReviewRow> {
    const [row] = await tx.insert(reviewRecord).values(values).returning();
    if (!row) throw new Error('Không ghi được review_record');
    return row;
  }

  listReviews(tx: Tx, companyId: string, taskId: string): Promise<ReviewRow[]> {
    return tx
      .select()
      .from(reviewRecord)
      .where(and(eq(reviewRecord.companyId, companyId), eq(reviewRecord.taskId, taskId)))
      .orderBy(asc(reviewRecord.decidedAt), asc(reviewRecord.id));
  }
}
