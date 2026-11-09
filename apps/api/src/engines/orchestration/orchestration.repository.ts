import { Injectable } from '@nestjs/common';
import type { Tx } from '@claude-company/db';
import {
  agentRun,
  runConversationState,
  runStep,
  toolInvocation,
} from '@claude-company/db/schema/orchestration';
import type {
  AgentRunSummary,
  RunStatus,
  RunStep,
  ToolInvocation,
  ToolInvocationRef,
} from '@claude-company/contracts';
import { and, asc, desc, eq, inArray, lt, sql, type SQL } from 'drizzle-orm';

export type RunRow = typeof agentRun.$inferSelect;
export type StepRow = typeof runStep.$inferSelect;
export type InvocationRow = typeof toolInvocation.$inferSelect;

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function toRunSummary(row: RunRow): AgentRunSummary {
  return {
    id: row.id,
    taskId: row.taskId,
    employeeId: row.aiEmployeeId,
    purpose: row.purpose,
    attempt: row.attempt,
    status: row.status,
    runtimeKind: row.runtimeKind,
    modelId: row.modelId,
    providerSessionId: row.providerSessionId,
    startedAt: iso(row.startedAt),
    finishedAt: iso(row.finishedAt),
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    traceId: row.traceId,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toStep(row: StepRow): RunStep {
  return {
    id: row.id,
    seq: row.seq,
    kind: row.kind,
    summary: row.summary,
    payload: row.payload,
    startedAt: row.startedAt.toISOString(),
    finishedAt: iso(row.finishedAt),
  };
}

export function toInvocation(row: InvocationRow): ToolInvocation {
  return {
    id: row.id,
    runStepId: row.runStepId,
    actionType: row.actionType,
    permissionLevel: row.permissionLevel,
    input: row.input,
    inputHash: row.inputHash,
    idempotencyKey: row.idempotencyKey,
    status: row.status,
    adapterMode: row.adapterMode,
    result: row.result,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toInvocationRef(row: InvocationRow): ToolInvocationRef {
  return {
    id: row.id,
    actionType: row.actionType,
    payloadHash: row.inputHash,
    idempotencyKey: row.idempotencyKey,
    status: row.status,
    result: row.result ?? undefined,
  };
}

/** Run chưa kết thúc. */
export const ACTIVE_RUN_STATUSES: RunStatus[] = ['queued', 'running', 'waiting_approval'];

/** Truy cập bảng của Orchestration Engine. Mọi phương thức chạy trong transaction `withTenant` (RLS). */
@Injectable()
export class OrchestrationRepository {
  // --- agent_run ---

  async insertRun(tx: Tx, values: typeof agentRun.$inferInsert): Promise<RunRow> {
    const [row] = await tx.insert(agentRun).values(values).returning();
    if (!row) throw new Error('Không tạo được agent_run');
    return row;
  }

  async findRun(
    tx: Tx,
    companyId: string,
    id: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<RunRow | undefined> {
    const query = tx
      .select()
      .from(agentRun)
      .where(and(eq(agentRun.companyId, companyId), eq(agentRun.id, id)));
    const [row] = options.forUpdate ? await query.for('update') : await query;
    return row;
  }

  async updateRun(
    tx: Tx,
    companyId: string,
    id: string,
    patch: Partial<typeof agentRun.$inferInsert>,
  ): Promise<RunRow> {
    const [row] = await tx
      .update(agentRun)
      .set(patch)
      .where(and(eq(agentRun.companyId, companyId), eq(agentRun.id, id)))
      .returning();
    if (!row) throw new Error('Không cập nhật được agent_run');
    return row;
  }

  /** Run chưa kết thúc của task theo `purpose` (khử trùng khi sự kiện được giao lại). */
  async findActiveRun(
    tx: Tx,
    companyId: string,
    taskId: string,
    purpose: RunRow['purpose'],
  ): Promise<RunRow | undefined> {
    const [row] = await tx
      .select()
      .from(agentRun)
      .where(
        and(
          eq(agentRun.companyId, companyId),
          eq(agentRun.taskId, taskId),
          eq(agentRun.purpose, purpose),
          inArray(agentRun.status, ACTIVE_RUN_STATUSES),
        ),
      )
      .orderBy(desc(agentRun.createdAt))
      .limit(1);
    return row;
  }

  listActiveRunsOfTask(tx: Tx, companyId: string, taskId: string): Promise<RunRow[]> {
    return tx
      .select()
      .from(agentRun)
      .where(
        and(
          eq(agentRun.companyId, companyId),
          eq(agentRun.taskId, taskId),
          inArray(agentRun.status, ACTIVE_RUN_STATUSES),
        ),
      );
  }

  async listRuns(
    tx: Tx,
    companyId: string,
    filter: { taskId?: string; employeeId?: string; limit: number },
  ): Promise<RunRow[]> {
    const conditions: SQL[] = [eq(agentRun.companyId, companyId)];
    if (filter.taskId) conditions.push(eq(agentRun.taskId, filter.taskId));
    if (filter.employeeId) conditions.push(eq(agentRun.aiEmployeeId, filter.employeeId));
    return tx
      .select()
      .from(agentRun)
      .where(and(...conditions))
      .orderBy(desc(agentRun.createdAt), desc(agentRun.id))
      .limit(filter.limit);
  }

  async countRunsOfTask(
    tx: Tx,
    companyId: string,
    taskId: string,
    purpose: RunRow['purpose'],
  ): Promise<number> {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(agentRun)
      .where(
        and(
          eq(agentRun.companyId, companyId),
          eq(agentRun.taskId, taskId),
          eq(agentRun.purpose, purpose),
        ),
      );
    return row?.n ?? 0;
  }

  /** Run `running` mà heartbeat cũ hơn `before`: ứng viên cho recovery. */
  listStaleRuns(tx: Tx, companyId: string, before: Date): Promise<RunRow[]> {
    return tx
      .select()
      .from(agentRun)
      .where(
        and(
          eq(agentRun.companyId, companyId),
          eq(agentRun.status, 'running'),
          lt(sql`coalesce(${agentRun.heartbeatAt}, ${agentRun.startedAt}, ${agentRun.createdAt})`, before),
        ),
      );
  }

  // --- run_step ---

  /** Cấp `seq` liên tục trong run; khóa dòng run để hai lần ghi song song không đụng UNIQUE(run, seq). */
  async insertStep(
    tx: Tx,
    companyId: string,
    runId: string,
    values: Omit<typeof runStep.$inferInsert, 'companyId' | 'agentRunId' | 'seq'>,
  ): Promise<StepRow> {
    await tx
      .select({ id: agentRun.id })
      .from(agentRun)
      .where(and(eq(agentRun.companyId, companyId), eq(agentRun.id, runId)))
      .for('update');
    const [max] = await tx
      .select({ seq: sql<number>`coalesce(max(${runStep.seq}), 0)::int` })
      .from(runStep)
      .where(eq(runStep.agentRunId, runId));
    const [row] = await tx
      .insert(runStep)
      .values({ ...values, companyId, agentRunId: runId, seq: (max?.seq ?? 0) + 1 })
      .returning();
    if (!row) throw new Error('Không ghi được run_step');
    return row;
  }

  listSteps(tx: Tx, companyId: string, runId: string): Promise<StepRow[]> {
    return tx
      .select()
      .from(runStep)
      .where(and(eq(runStep.companyId, companyId), eq(runStep.agentRunId, runId)))
      .orderBy(asc(runStep.seq));
  }

  // --- tool_invocation ---

  async insertInvocation(tx: Tx, values: typeof toolInvocation.$inferInsert): Promise<InvocationRow> {
    const [row] = await tx.insert(toolInvocation).values(values).returning();
    if (!row) throw new Error('Không ghi được tool_invocation');
    return row;
  }

  /** Ghi ledger; trùng `idempotency_key` thì trả `undefined` để caller đọc lại bản đã có. */
  async insertInvocationIfAbsent(
    tx: Tx,
    values: typeof toolInvocation.$inferInsert,
  ): Promise<InvocationRow | undefined> {
    const [row] = await tx
      .insert(toolInvocation)
      .values(values)
      .onConflictDoNothing({ target: toolInvocation.idempotencyKey })
      .returning();
    return row;
  }

  async findInvocationByKey(
    tx: Tx,
    companyId: string,
    key: string,
  ): Promise<InvocationRow | undefined> {
    const [row] = await tx
      .select()
      .from(toolInvocation)
      .where(and(eq(toolInvocation.companyId, companyId), eq(toolInvocation.idempotencyKey, key)));
    return row;
  }

  async updateInvocation(
    tx: Tx,
    companyId: string,
    id: string,
    patch: Partial<typeof toolInvocation.$inferInsert>,
  ): Promise<void> {
    await tx
      .update(toolInvocation)
      .set(patch)
      .where(and(eq(toolInvocation.companyId, companyId), eq(toolInvocation.id, id)));
  }

  listInvocationsOfRun(tx: Tx, companyId: string, runId: string): Promise<InvocationRow[]> {
    return tx
      .select()
      .from(toolInvocation)
      .where(and(eq(toolInvocation.companyId, companyId), eq(toolInvocation.agentRunId, runId)))
      .orderBy(asc(toolInvocation.createdAt), asc(toolInvocation.id));
  }

  /** Hành động đã thực thi thật qua adapter (có `adapter_mode`) của task. */
  listExecutedInvocations(tx: Tx, companyId: string, taskId: string): Promise<InvocationRow[]> {
    return tx
      .select()
      .from(toolInvocation)
      .where(
        and(
          eq(toolInvocation.companyId, companyId),
          eq(toolInvocation.taskId, taskId),
          eq(toolInvocation.status, 'succeeded'),
          sql`${toolInvocation.adapterMode} is not null`,
        ),
      )
      .orderBy(asc(toolInvocation.createdAt));
  }

  /** Tool đang `executing` của một run đã chết: không biết kết quả nếu không hỏi adapter. */
  listStuckInvocations(tx: Tx, companyId: string, runId: string): Promise<InvocationRow[]> {
    return tx
      .select()
      .from(toolInvocation)
      .where(
        and(
          eq(toolInvocation.companyId, companyId),
          eq(toolInvocation.agentRunId, runId),
          inArray(toolInvocation.status, ['executing', 'pending']),
        ),
      );
  }

  // --- run_conversation_state ---

  async saveConversation(tx: Tx, companyId: string, runId: string, messages: unknown): Promise<void> {
    await tx
      .insert(runConversationState)
      .values({ companyId, agentRunId: runId, messages })
      .onConflictDoUpdate({ target: runConversationState.agentRunId, set: { messages } });
  }

  async loadConversation(tx: Tx, companyId: string, runId: string): Promise<unknown | null> {
    const [row] = await tx
      .select({ messages: runConversationState.messages })
      .from(runConversationState)
      .where(
        and(
          eq(runConversationState.companyId, companyId),
          eq(runConversationState.agentRunId, runId),
        ),
      );
    return row ? row.messages : null;
  }
}
