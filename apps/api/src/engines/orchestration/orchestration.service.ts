import { Inject, Injectable, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  DomainError,
  CEO_ASSISTANT_TEMPLATE_KEY,
  FINAL_RUN_STATUSES,
  taskProposalSchema,
  type AgentRunDetail,
  type AgentRunRef,
  type AgentRunStatusPatch,
  type AgentRunSummary,
  type BudgetService,
  type DecompositionPlan,
  type EmployeeEngine,
  type ExecutedAction,
  type OrchestrationEngine,
  type OrganizationEngine,
  type OrgChartNode,
  type OrgChartTeam,
  type Page,
  type PermissionEngine,
  type PermissionLevel,
  type RecoveryReport,
  type RequestContext,
  type ReviewResult,
  type RunEventInput,
  type RunListFilter,
  type RunPurpose,
  type RunStatus,
  type RunStepInput,
  type RunStepRef,
  type Task,
  type TaskEngine,
  type TaskOperation,
  type TaskProposal,
  type ToolAdapter,
  type ToolInvocationInput,
  type ToolInvocationPatch,
  type ToolInvocationRef,
} from '@claude-company/contracts';
import { newId, withGlobal } from '@claude-company/db';
import { ASSISTANT_ONLY_ACTIONS } from '@claude-company/policy';
import { sql } from 'drizzle-orm';
import type { AppConfig } from '../../platform/config/config';
import { CONFIG } from '../../platform/config/infra.providers';
import {
  BUDGET_SERVICE,
  EMPLOYEE_ENGINE,
  ORGANIZATION_ENGINE,
  PERMISSION_ENGINE,
  TASK_ENGINE,
  TOOL_ADAPTER_LOOKUP,
} from '../../platform/engine-tokens';
import { EventPublisher } from '../../platform/events/event-publisher';
import { QueueService, type JobName } from '../../platform/queue/queues';
import { inTenant } from '../../platform/tenancy/tenant-store';
import { pickDecomposer, type SelectionCandidate } from './manager-selection';
import {
  OrchestrationRepository,
  toInvocation,
  toInvocationRef,
  toRunSummary,
  toStep,
  type RunRow,
} from './orchestration.repository';
import { ReviewFlowService } from './review-flow.service';
import { TaskScheduler } from './scheduler.service';

/** Tên job BullMQ theo `purpose` (platform/queue/queues.ts). */
const JOB_FOR_PURPOSE: Record<RunPurpose, JobName> = {
  execute: 'run.start',
  decompose: 'task.decompose',
  synthesize: 'task.synthesize',
  review: 'review.run',
  propose: 'task.propose',
};

/** Hành động điều hành hiển thị ở `GET /tasks/{id}/operations`: tool của trợ lý và `email.send` (US9-AS5). */
const OPERATION_ACTIONS: ReadonlySet<string> = new Set([...ASSISTANT_ONLY_ACTIONS, 'email.send']);

/** Trường của input/kết quả tool dùng để chỉ ra đối tượng bị tác động. */
const TARGET_FIELDS: ReadonlyArray<[kind: string, field: string]> = [
  ['task', 'taskId'],
  ['employee', 'employeeId'],
  ['org_unit', 'orgUnitId'],
  ['team', 'teamId'],
];

/** Run `queued` cũ hơn ngưỡng này mà chưa chạy: job có thể đã mất, enqueue lại (BullMQ khử trùng theo jobId). */
const QUEUED_REPLAY_AFTER_MS = 2 * 60_000;

/** Khung thời gian của jobId phát lại: tối đa một lần phát lại mỗi yêu cầu phê duyệt trong mỗi khung. */
const APPROVAL_REPLAY_BUCKET_MS = 5 * 60_000;

const SYSTEM = (ctx: RequestContext): RequestContext => ({ ...ctx, actor: { kind: 'system' } });

function findTeam(
  nodes: readonly OrgChartNode[],
  teamId: string,
): { orgUnitId: string; team: OrgChartTeam } | undefined {
  for (const node of nodes) {
    const team = node.teams.find((t) => t.id === teamId);
    if (team) return { orgUnitId: node.id, team };
    const inner = findTeam(node.children, teamId);
    if (inner) return inner;
  }
  return undefined;
}

/**
 * Orchestration Engine: lập lịch run, chọn AI Manager phân rã/review, ghi bản ghi run và ledger tool.
 * Worker ghi run chỉ qua các phương thức ở đây (Nguyên tắc VI): không truy cập bảng trực tiếp.
 */
@Injectable()
export class OrchestrationService implements OrchestrationEngine {
  constructor(
    private readonly repo: OrchestrationRepository,
    private readonly events: EventPublisher,
    private readonly queue: QueueService,
    private readonly reviewFlow: ReviewFlowService,
    private readonly scheduler: TaskScheduler,
    private readonly moduleRef: ModuleRef,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Optional() @Inject(TOOL_ADAPTER_LOOKUP) private readonly adapters?: { find(actionType: string): ToolAdapter | undefined },
  ) {}

  private get tasks(): TaskEngine {
    return this.moduleRef.get<TaskEngine>(TASK_ENGINE, { strict: false });
  }
  private get employees(): EmployeeEngine {
    return this.moduleRef.get<EmployeeEngine>(EMPLOYEE_ENGINE, { strict: false });
  }
  private get organization(): OrganizationEngine {
    return this.moduleRef.get<OrganizationEngine>(ORGANIZATION_ENGINE, { strict: false });
  }
  private get permission(): PermissionEngine {
    return this.moduleRef.get<PermissionEngine>(PERMISSION_ENGINE, { strict: false });
  }
  private get budget(): BudgetService {
    return this.moduleRef.get<BudgetService>(BUDGET_SERVICE, { strict: false });
  }

  // --- tạo run ---

  async enqueueRun(
    ctx: RequestContext,
    taskId: string,
    purpose: RunPurpose,
  ): Promise<AgentRunRef> {
    const task = await this.tasks.get(ctx, taskId);
    const employeeId = await this.resolveRunner(ctx, task, purpose);
    const employee = await this.employees.get(ctx, employeeId);
    if (employee.status !== 'active') {
      throw new DomainError('EMPLOYEE_SUSPENDED', 'Nhân viên không ở trạng thái active', {
        employeeId,
        status: employee.status,
      });
    }
    // Run `propose` chỉ dành cho CEO AI Assistant và task nháp đang chờ đề xuất; nó không đổi trạng thái task.
    if (
      purpose === 'propose' &&
      (employee.roleTemplateKey !== CEO_ASSISTANT_TEMPLATE_KEY ||
        task.status !== 'draft' ||
        task.proposalStatus !== 'pending')
    ) {
      throw new DomainError(
        'VALIDATION_FAILED',
        'Run propose chỉ dành cho CEO AI Assistant với task nháp đang chờ đề xuất',
        { taskId, purpose },
      );
    }

    const { row, created } = await inTenant(ctx, async (tx) => {
      const existing = await this.repo.findActiveRun(tx, ctx.companyId, taskId, purpose);
      if (existing) return { row: existing, created: false };
      const inserted = await this.repo.insertRun(tx, {
        id: newId(),
        companyId: ctx.companyId,
        taskId,
        aiEmployeeId: employeeId,
        purpose,
        attempt: 1,
        status: 'queued',
        runtimeKind: employee.runtimeKind,
        modelId: employee.modelId,
        traceId: ctx.traceId,
      });
      await this.events.publish(tx, ctx, {
        type: 'run.queued',
        aggregateKind: 'agent_run',
        aggregateId: inserted.id,
        payload: this.runPayload(inserted),
      });
      return { row: inserted, created: true };
    });
    if (created) await this.dispatch(ctx, row);
    return { runId: row.id };
  }

  async enqueueRetry(ctx: RequestContext, runId: string, delayMs: number): Promise<AgentRunRef> {
    const previous = await inTenant(ctx, (tx) => this.repo.findRun(tx, ctx.companyId, runId));
    if (!previous) throw new DomainError('NOT_FOUND', 'Không tìm thấy run');
    const row = await inTenant(ctx, (tx) =>
      this.repo.insertRun(tx, {
        id: newId(),
        companyId: ctx.companyId,
        taskId: previous.taskId,
        aiEmployeeId: previous.aiEmployeeId,
        purpose: previous.purpose,
        attempt: previous.attempt + 1,
        status: 'queued',
        runtimeKind: previous.runtimeKind,
        modelId: previous.modelId,
        providerSessionId: previous.providerSessionId,
        traceId: previous.traceId,
      }),
    );
    await this.dispatch(ctx, row, delayMs);
    return { runId: row.id };
  }

  private async dispatch(ctx: RequestContext, run: RunRow, delayMs = 0): Promise<void> {
    await this.queue.enqueue(
      JOB_FOR_PURPOSE[run.purpose],
      {
        companyId: ctx.companyId,
        taskId: run.taskId,
        runId: run.id,
        employeeId: run.aiEmployeeId,
        purpose: run.purpose,
        traceId: run.traceId,
      },
      // jobId ổn định theo run: enqueue lại cùng run không tạo job thứ hai.
      { jobId: `run-${run.id}`, delayMs },
    );
  }

  /** Chọn nhân viên chạy run theo `purpose`; không chọn được thì chặn task rồi ném lỗi cùng mã. */
  private async resolveRunner(ctx: RequestContext, task: Task & { decomposedByEmployeeId: string | null; subtasks: Task[] }, purpose: RunPurpose): Promise<string> {
    switch (purpose) {
      case 'execute': {
        if (task.assigneeKind !== 'ai_employee') {
          throw new DomainError('NO_SUITABLE_ASSIGNEE', 'Task giao cho đơn vị phải được phân rã');
        }
        return task.assigneeId;
      }
      case 'propose': {
        if (task.assigneeKind !== 'ai_employee') {
          throw new DomainError('NO_SUITABLE_ASSIGNEE', 'Đề xuất chỉ dành cho CEO AI Assistant');
        }
        return task.assigneeId;
      }
      case 'synthesize': {
        if (!task.decomposedByEmployeeId) {
          throw new DomainError('NO_AI_MANAGER', 'Task chưa có AI Manager phân rã để tổng hợp');
        }
        return task.decomposedByEmployeeId;
      }
      case 'decompose': {
        const chosen = await this.selectDecomposer(ctx, task);
        if (!chosen) {
          await this.blockTask(ctx, task.id, 'NO_AI_MANAGER');
          throw new DomainError('NO_AI_MANAGER', 'Không có AI Manager để xác nhận hoặc phân rã', {
            taskId: task.id,
          });
        }
        return chosen.id;
      }
      case 'review': {
        const reviewer = await this.reviewFlow.selectReviewer(ctx, task);
        if (!reviewer) {
          await this.blockTask(ctx, task.id, 'NO_INDEPENDENT_REVIEWER');
          throw new DomainError(
            'NO_INDEPENDENT_REVIEWER',
            'Không có AI Manager độc lập để review',
            { taskId: task.id },
          );
        }
        return reviewer.id;
      }
    }
  }

  private async selectDecomposer(ctx: RequestContext, task: Task): Promise<SelectionCandidate | undefined> {
    const profiles = await this.employees.list(ctx, {});
    const employees: SelectionCandidate[] = profiles.map((p) => ({
      id: p.id,
      kind: p.kind,
      status: p.status,
      homeOrgUnitId: p.homeOrgUnitId,
      teamIds: p.teamIds,
      manager: p.manager,
    }));
    if (task.assigneeKind === 'team') {
      const chart = await this.organization.getOrgChart(ctx);
      const found = findTeam(chart.roots, task.assigneeId);
      if (!found) return undefined;
      const picked = pickDecomposer({
        assignee: { kind: 'team', id: task.assigneeId, orgUnitId: found.orgUnitId },
        employees,
      });
      if (picked) return picked;
      // Team chưa có AI Manager: tự tạo một AI Manager cho team (manager trực tiếp là người quản lý team hoặc CEO).
      const created = await this.employees
        .provisionTeamManager(SYSTEM(ctx), {
          teamId: found.team.id,
          teamName: found.team.name,
          orgUnitId: found.orgUnitId,
          humanManagerId: found.team.managerMemberId,
        })
        .catch((error: unknown) => {
          // Không tạo được (thiếu người thật hợp lệ, model không được phép…): giữ hành vi cũ là chặn task NO_AI_MANAGER.
          if (error instanceof DomainError) return undefined;
          throw error;
        });
      if (!created) return undefined;
      return {
        id: created.id,
        kind: created.kind,
        status: created.status,
        homeOrgUnitId: created.homeOrgUnitId,
        teamIds: created.teamIds,
        manager: created.manager,
      };
    }
    return pickDecomposer({ assignee: { kind: task.assigneeKind, id: task.assigneeId }, employees });
  }

  private async blockTask(ctx: RequestContext, taskId: string, reason: string): Promise<void> {
    try {
      await this.tasks.transition(SYSTEM(ctx), taskId, 'block', { blockedReason: reason });
    } catch (error) {
      // Task đã chuyển trạng thái (ví dụ bị hủy) trong lúc chọn: không còn gì để chặn.
      if (!(error instanceof DomainError) || error.code !== 'TASK_INVALID_TRANSITION') throw error;
    }
  }

  // --- kết quả job ---

  async applyDecompositionPlan(
    ctx: RequestContext,
    taskId: string,
    plan: DecompositionPlan,
  ): Promise<void> {
    try {
      await this.tasks.applyDecomposition(ctx, taskId, plan);
    } catch (error) {
      if (
        error instanceof DomainError &&
        (error.code === 'DEPENDENCY_CYCLE' || error.code === 'NO_SUITABLE_ASSIGNEE')
      ) {
        await this.blockTask(ctx, taskId, error.code);
        return;
      }
      throw error;
    }
    if (plan.mode === 'confirm') {
      const task = await this.tasks.get(SYSTEM(ctx), taskId);
      if (task.assigneeKind === 'ai_employee') {
        await this.scheduler.scheduleEmployee(SYSTEM(ctx), task.assigneeId);
      }
    }
  }

  async applyReviewResult(ctx: RequestContext, taskId: string, result: ReviewResult): Promise<void> {
    await this.reviewFlow.applyReviewResult(ctx, taskId, result);
  }

  async applyTaskProposal(
    ctx: RequestContext,
    taskId: string,
    proposal: TaskProposal | { failed: true; reason: string },
  ): Promise<void> {
    if ('failed' in proposal) {
      await this.tasks.updateDraft(ctx, taskId, {}, { proposalStatus: 'failed' });
      return;
    }
    const parsed = taskProposalSchema.safeParse(proposal);
    // Đề xuất sai (thiếu tiêu chí, deadline đã qua…) coi như lỗi: CEO vẫn sửa tay được, task không đổi trạng thái.
    if (!parsed.success || new Date(parsed.data.deadline).getTime() <= Date.now()) {
      await this.tasks.updateDraft(ctx, taskId, {}, { proposalStatus: 'failed' });
      return;
    }
    const { title, acceptanceCriteria, expectedOutput, deadline, priority } = parsed.data;
    await this.tasks.updateDraft(
      ctx,
      taskId,
      { title, acceptanceCriteria, expectedOutput, deadline, priority },
      { proposalStatus: 'ready' },
    );
  }

  async listOperations(ctx: RequestContext, taskId: string): Promise<TaskOperation[]> {
    const task = await this.tasks.get(ctx, taskId);
    if (task.assigneeKind !== 'ai_employee') return [];
    const assignee = await this.employees.get(ctx, task.assigneeId).catch(() => null);
    if (assignee?.roleTemplateKey !== CEO_ASSISTANT_TEMPLATE_KEY) return [];
    const rows = await inTenant(ctx, (tx) => this.repo.listInvocationsOfTask(tx, ctx.companyId, taskId));
    return rows
      .filter((r) => OPERATION_ACTIONS.has(r.actionType) && r.actionType !== 'company.query')
      .map((r) => {
        const result = (r.result ?? {}) as Record<string, unknown>;
        const input = (r.input ?? {}) as Record<string, unknown>;
        const source = { ...input, ...result };
        const target = TARGET_FIELDS.map(([kind, field]) => [kind, source[field] ?? source.id] as const).find(
          ([, id]) => typeof id === 'string',
        );
        const kindFromInput =
          typeof input.targetKind === 'string' ? (input.targetKind as string) : undefined;
        const targetId =
          typeof input.targetId === 'string' ? input.targetId : (target?.[1] as string | undefined);
        const approvalRequestId =
          typeof result.approvalRequestId === 'string' ? result.approvalRequestId : undefined;
        return {
          toolInvocationId: r.id,
          actionType: r.actionType,
          permissionLevel: r.permissionLevel,
          status: r.status,
          summary: typeof result.summary === 'string' ? result.summary : `${r.actionType} → ${r.status}`,
          ...(targetId ? { targetKind: kindFromInput ?? target?.[0] ?? 'unknown', targetId } : {}),
          ...(approvalRequestId ? { approvalRequestId } : {}),
          ...(r.adapterMode ? { adapterMode: r.adapterMode } : {}),
          ...(r.status === 'succeeded' ? { executedAt: r.updatedAt.toISOString() } : {}),
        };
      });
  }

  // --- trạng thái run ---

  async updateRunStatus(ctx: RequestContext, runId: string, patch: AgentRunStatusPatch): Promise<void> {
    await inTenant(ctx, async (tx) => {
      const current = await this.repo.findRun(tx, ctx.companyId, runId, { forUpdate: true });
      if (!current) throw new DomainError('NOT_FOUND', 'Không tìm thấy run');
      // Run đã kết thúc thì không đổi nữa (ví dụ bị hủy trong lúc worker vẫn đang chạy).
      if (FINAL_RUN_STATUSES.includes(current.status)) return;

      const now = new Date();
      const status = patch.status;
      const updated = await this.repo.updateRun(tx, ctx.companyId, runId, {
        ...(status ? { status } : {}),
        ...(status === 'running'
          ? { startedAt: current.startedAt ?? now, heartbeatAt: now }
          : {}),
        ...(status && FINAL_RUN_STATUSES.includes(status) ? { finishedAt: now } : {}),
        ...(patch.errorCode !== undefined ? { errorCode: patch.errorCode } : {}),
        ...(patch.errorMessage !== undefined ? { errorMessage: patch.errorMessage } : {}),
        ...(patch.providerSessionId !== undefined
          ? { providerSessionId: patch.providerSessionId }
          : {}),
      });
      if (status && status !== current.status) {
        const type =
          status === 'running' && current.status === 'waiting_approval'
            ? 'run.resumed'
            : `run.${status === 'queued' ? 'queued' : status}`;
        await this.events.publish(tx, ctx, {
          type: status === 'running' && current.status !== 'waiting_approval' ? 'run.started' : type,
          aggregateKind: 'agent_run',
          aggregateId: runId,
          payload: {
            ...this.runPayload(updated),
            errorCode: updated.errorCode ?? undefined,
          },
        });
      }
    });
  }

  async heartbeat(ctx: RequestContext, runId: string): Promise<RunStatus> {
    const row = await inTenant(ctx, (tx) =>
      this.repo.updateRun(tx, ctx.companyId, runId, { heartbeatAt: new Date() }),
    );
    return row.status;
  }

  async appendRunStep(ctx: RequestContext, runId: string, step: RunStepInput): Promise<RunStepRef> {
    return inTenant(ctx, async (tx) => {
      const run = await this.repo.findRun(tx, ctx.companyId, runId);
      if (!run) throw new DomainError('NOT_FOUND', 'Không tìm thấy run');
      const row = await this.repo.insertStep(tx, ctx.companyId, runId, {
        kind: step.kind,
        summary: step.summary,
        payload: step.payload ?? null,
        startedAt: step.startedAt ? new Date(step.startedAt) : new Date(),
        finishedAt: step.finishedAt ? new Date(step.finishedAt) : null,
      });
      await this.events.publish(tx, ctx, {
        type: 'run.step_appended',
        aggregateKind: 'agent_run',
        aggregateId: runId,
        payload: {
          runId,
          taskId: run.taskId,
          employeeId: run.aiEmployeeId,
          seq: row.seq,
          kind: row.kind,
        },
      });
      return { id: row.id, seq: row.seq };
    });
  }

  async publishRunEvent(ctx: RequestContext, runId: string, event: RunEventInput): Promise<void> {
    await inTenant(ctx, async (tx) => {
      const run = await this.repo.findRun(tx, ctx.companyId, runId);
      if (!run) throw new DomainError('NOT_FOUND', 'Không tìm thấy run');
      const base = { runId, taskId: run.taskId, employeeId: run.aiEmployeeId };
      switch (event.type) {
        case 'model_call_started':
          await this.events.publish(tx, ctx, {
            type: 'run.model_call_started',
            aggregateKind: 'agent_run',
            aggregateId: runId,
            payload: base,
          });
          return;
        case 'tool_call_started':
          await this.events.publish(tx, ctx, {
            type: 'run.tool_call_started',
            aggregateKind: 'agent_run',
            aggregateId: runId,
            payload: { ...base, tool: event.tool },
          });
          return;
        case 'progress':
          await this.events.publish(tx, ctx, {
            type: 'task.progress',
            aggregateKind: 'task',
            aggregateId: run.taskId,
            payload: {
              taskId: run.taskId,
              employeeId: run.aiEmployeeId,
              progress: Math.max(0, Math.min(100, Math.round(event.progress))),
            },
          });
          return;
        case 'usage':
          await this.events.publish(tx, ctx, {
            type: 'usage.updated',
            aggregateKind: 'agent_run',
            aggregateId: runId,
            payload: {
              employeeId: run.aiEmployeeId,
              taskId: run.taskId,
              tokensDelta: event.tokensDelta,
              costDelta: event.costDelta,
            },
          });
          return;
      }
    });
  }

  // --- ledger tool ---

  async recordToolInvocation(
    ctx: RequestContext,
    inv: ToolInvocationInput,
  ): Promise<ToolInvocationRef> {
    return inTenant(ctx, async (tx) => {
      const run = await this.repo.findRun(tx, ctx.companyId, inv.runId);
      if (!run) throw new DomainError('NOT_FOUND', 'Không tìm thấy run');
      const inserted = await this.repo.insertInvocationIfAbsent(tx, {
        companyId: ctx.companyId,
        agentRunId: inv.runId,
        taskId: run.taskId,
        runStepId: inv.runStepId ?? null,
        actionType: inv.actionType,
        permissionLevel: inv.permissionLevel as PermissionLevel,
        input: inv.input ?? {},
        inputHash: inv.inputHash,
        idempotencyKey: inv.idempotencyKey,
        status: inv.status,
        adapterMode: inv.adapterMode ?? null,
        result: inv.result ?? null,
      });
      // Trùng idempotency_key (hai lần gọi gần như đồng thời): trả bản ghi đã có thay vì tạo bản thứ hai.
      const row =
        inserted ?? (await this.repo.findInvocationByKey(tx, ctx.companyId, inv.idempotencyKey));
      if (!row) throw new Error('Không ghi được tool_invocation');
      return toInvocationRef(row);
    });
  }

  async updateToolInvocation(
    ctx: RequestContext,
    id: string,
    patch: ToolInvocationPatch,
  ): Promise<void> {
    await inTenant(ctx, (tx) =>
      this.repo.updateInvocation(tx, ctx.companyId, id, {
        ...(patch.status ? { status: patch.status } : {}),
        ...(patch.result !== undefined ? { result: patch.result } : {}),
        ...(patch.adapterMode ? { adapterMode: patch.adapterMode } : {}),
      }),
    );
  }

  async findToolInvocationByKey(
    ctx: RequestContext,
    idempotencyKey: string,
  ): Promise<ToolInvocationRef | null> {
    const row = await inTenant(ctx, (tx) =>
      this.repo.findInvocationByKey(tx, ctx.companyId, idempotencyKey),
    );
    return row ? toInvocationRef(row) : null;
  }

  async saveConversationState(ctx: RequestContext, runId: string, messages: unknown): Promise<void> {
    await inTenant(ctx, (tx) => this.repo.saveConversation(tx, ctx.companyId, runId, messages));
  }

  async loadConversationState(ctx: RequestContext, runId: string): Promise<unknown | null> {
    return inTenant(ctx, (tx) => this.repo.loadConversation(tx, ctx.companyId, runId));
  }

  // --- truy vấn ---

  async getRun(ctx: RequestContext, runId: string): Promise<AgentRunDetail> {
    return inTenant(ctx, async (tx) => {
      const row = await this.repo.findRun(tx, ctx.companyId, runId);
      if (!row) throw new DomainError('NOT_FOUND', 'Không tìm thấy run');
      const steps = await this.repo.listSteps(tx, ctx.companyId, runId);
      const invocations = await this.repo.listInvocationsOfRun(tx, ctx.companyId, runId);
      return {
        ...toRunSummary(row),
        steps: steps.map(toStep),
        toolInvocations: invocations.map(toInvocation),
      };
    });
  }

  async listRuns(ctx: RequestContext, filter: RunListFilter): Promise<Page<AgentRunSummary>> {
    const { limit, ...rest } = filter;
    const rows = await inTenant(ctx, (tx) =>
      this.repo.listRuns(tx, ctx.companyId, { ...rest, limit: Math.min(limit ?? 200, 200) }),
    );
    return { items: rows.map(toRunSummary), nextCursor: null };
  }

  async listExecutedActions(ctx: RequestContext, taskId: string): Promise<ExecutedAction[]> {
    const rows = await inTenant(ctx, (tx) =>
      this.repo.listExecutedInvocations(tx, ctx.companyId, taskId),
    );
    return rows.map((r) => ({
      toolInvocationId: r.id,
      actionType: r.actionType,
      adapterMode: r.adapterMode ?? 'dry_run',
      status: r.status,
      executedAt: r.updatedAt.toISOString(),
    }));
  }

  /**
   * Sau `approval.decided` (US4). Duyệt → xếp job `action.execute-approved` (hệ thống, không phải agent, thực thi đúng
   * payload đã duyệt rồi mới resume run). Từ chối → ghi `denied` và resume run ngay để agent nhận lý do.
   * Idempotent: `jobId` ổn định theo yêu cầu nên sự kiện giao lại không tạo job thứ hai.
   */
  async resumeAfterApproval(
    ctx: RequestContext,
    approvalRequestId: string,
    options: { replay?: boolean } = {},
  ): Promise<void> {
    const approval = await this.permission.getApproval(ctx, approvalRequestId);
    if (approval.status !== 'approved' && approval.status !== 'rejected') return; // pending hoặc đã hủy
    const run = await inTenant(ctx, (tx) => this.repo.findRun(tx, ctx.companyId, approval.runId));
    if (!run) return;
    const replay = options.replay
      ? String(Math.floor(Date.now() / APPROVAL_REPLAY_BUCKET_MS))
      : undefined;
    const suffix = replay ? `-r${replay}` : '';
    const payload = {
      companyId: ctx.companyId,
      taskId: approval.taskId,
      runId: run.id,
      employeeId: run.aiEmployeeId,
      purpose: run.purpose,
      traceId: run.traceId,
      approvalRequestId,
      ...(replay ? { replay } : {}),
    };
    if (approval.status === 'approved') {
      await this.queue.enqueue('action.execute-approved', payload, {
        jobId: `exec-approved-${approvalRequestId}${suffix}`,
      });
      return;
    }
    await inTenant(ctx, (tx) =>
      this.repo.updateInvocation(tx, ctx.companyId, approval.toolInvocationId, {
        status: 'denied',
        result: { rejected: true, message: approval.decisionReason ?? 'Bị từ chối' },
      }),
    );
    await this.queue.enqueue('run.resume', payload, {
      jobId: `resume-${approvalRequestId}${suffix}`,
    });
  }

  async claimToolInvocation(ctx: RequestContext, id: string): Promise<boolean> {
    return inTenant(ctx, (tx) => this.repo.claimInvocation(tx, ctx.companyId, id));
  }

  // --- hủy và phục hồi ---

  async cancelRunsForTask(ctx: RequestContext, taskId: string): Promise<void> {
    const cancelled = await inTenant(ctx, async (tx) => {
      const active = await this.repo.listActiveRunsOfTask(tx, ctx.companyId, taskId);
      for (const run of active) {
        const updated = await this.repo.updateRun(tx, ctx.companyId, run.id, {
          status: 'cancelled',
          finishedAt: new Date(),
        });
        await this.events.publish(tx, ctx, {
          type: 'run.cancelled',
          aggregateKind: 'agent_run',
          aggregateId: run.id,
          payload: this.runPayload(updated),
        });
      }
      return active;
    });
    for (const run of cancelled) await this.budget.releaseRun(ctx, run.id);
  }

  /**
   * Phục hồi mặc định (R5): run `running` quá hạn heartbeat bị đánh dấu lỗi `RUN_INTERRUPTED` và task `blocked`
   * để người thật quyết định; không tự `resume` session trừ khi `SDK_RESUME_AFTER_CRASH` đã được T090 xác nhận.
   * Tool kẹt `executing` hỏi adapter theo idempotency key; không xác định được → `TOOL_OUTCOME_UNKNOWN`.
   */
  async recoverStaleRuns(): Promise<RecoveryReport> {
    const companies = await withGlobal((tx) =>
      tx.execute<{ company_id: string }>(sql`select list_companies_with_active_runs() as company_id`),
    );
    const report: RecoveryReport = { recovered: 0, failed: 0 };
    for (const { company_id } of companies.rows) {
      const ctx: RequestContext = {
        companyId: company_id,
        actor: { kind: 'system' },
        traceId: `recovery-${Date.now()}`,
      };
      const { stale, queued, waiting } = await inTenant(ctx, async (tx) => {
        const recent = await this.repo.listRuns(tx, company_id, { limit: 200 });
        return {
          stale: await this.repo.listStaleRuns(
            tx,
            company_id,
            new Date(Date.now() - this.config.RUN_STALE_AFTER_MS),
          ),
          queued: recent.filter(
            (r) =>
              r.status === 'queued' && Date.now() - r.createdAt.getTime() > QUEUED_REPLAY_AFTER_MS,
          ),
          // Run chờ duyệt mà quyết định đã có từ lâu nhưng vẫn chưa tiến triển: job có thể đã mất.
          waiting: recent.filter(
            (r) =>
              r.status === 'waiting_approval' &&
              Date.now() - r.updatedAt.getTime() > this.config.APPROVAL_REPLAY_AFTER_MS,
          ),
        };
      });

      for (const run of waiting) {
        report.recovered += await this.replayDecidedApprovals(ctx, run);
      }

      for (const run of queued) {
        await this.dispatch(ctx, run);
        report.recovered += 1;
      }
      for (const run of stale) {
        if (await this.recoverOne(ctx, run)) report.recovered += 1;
        else report.failed += 1;
      }
    }
    return report;
  }

  /**
   * Run `waiting_approval` mà yêu cầu của nó đã được quyết định: phát lại job thực thi/resume. An toàn khi job gốc vẫn
   * còn sống vì thực thi được chiếm bằng cập nhật có điều kiện và resume kiểm tra trạng thái run.
   * Yêu cầu chưa quyết định thì không đụng tới: chờ người duyệt không phải lỗi.
   */
  private async replayDecidedApprovals(ctx: RequestContext, run: RunRow): Promise<number> {
    const { items } = await this.permission.listApprovals(ctx, { taskId: run.taskId, limit: 50 });
    let replayed = 0;
    for (const approval of items) {
      if (approval.runId !== run.id) continue;
      if (approval.status !== 'approved' && approval.status !== 'rejected') continue;
      await this.resumeAfterApproval(ctx, approval.id, { replay: true });
      replayed += 1;
    }
    return replayed;
  }

  /** `true` nếu run được đưa lại vào hàng đợi, `false` nếu bị đánh dấu lỗi. */
  private async recoverOne(ctx: RequestContext, run: RunRow): Promise<boolean> {
    const stuck = await inTenant(ctx, (tx) =>
      this.repo.listStuckInvocations(tx, ctx.companyId, run.id),
    );
    let unknownOutcome = false;
    for (const inv of stuck) {
      const adapter = this.adapters?.find(inv.actionType);
      const state = adapter
        ? await adapter.lookup(inv.idempotencyKey, {
            companyId: ctx.companyId,
            traceId: ctx.traceId,
            actionType: inv.actionType,
            employeeId: run.aiEmployeeId,
            runId: run.id,
            taskId: run.taskId,
            input: inv.input,
          })
        : 'unknown';
      const status = state === 'succeeded' ? 'succeeded' : state === 'failed' ? 'failed' : 'unknown';
      if (status === 'unknown') unknownOutcome = true;
      await inTenant(ctx, (tx) =>
        this.repo.updateInvocation(tx, ctx.companyId, inv.id, { status }),
      );
    }

    if (
      !unknownOutcome &&
      this.config.SDK_RESUME_AFTER_CRASH &&
      run.providerSessionId &&
      run.purpose === 'execute'
    ) {
      await inTenant(ctx, (tx) => this.repo.updateRun(tx, ctx.companyId, run.id, { status: 'queued' }));
      await this.queue.enqueue(
        'run.resume',
        {
          companyId: ctx.companyId,
          taskId: run.taskId,
          runId: run.id,
          employeeId: run.aiEmployeeId,
          purpose: run.purpose,
          traceId: run.traceId,
        },
        { jobId: `resume-${run.id}-${Date.now()}` },
      );
      return true;
    }

    const code = unknownOutcome ? 'TOOL_OUTCOME_UNKNOWN' : 'RUN_INTERRUPTED';
    await this.updateRunStatus(ctx, run.id, {
      status: 'failed',
      errorCode: code,
      errorMessage: unknownOutcome
        ? 'Không xác định được kết quả của một hành động đang chạy'
        : 'Worker ngừng gửi heartbeat nên lượt chạy bị coi là gián đoạn',
    });
    await this.budget.releaseRun(ctx, run.id);
    if (run.purpose === 'propose') {
      // Run đề xuất không đổi trạng thái task: chỉ đánh dấu đề xuất lỗi để CEO sửa tay.
      await this.applyTaskProposal(SYSTEM(ctx), run.taskId, { failed: true, reason: code }).catch(
        () => undefined,
      );
      return false;
    }
    await this.blockTask(ctx, run.taskId, code);
    return false;
  }

  private runPayload(run: RunRow): Record<string, unknown> {
    return {
      runId: run.id,
      taskId: run.taskId,
      employeeId: run.aiEmployeeId,
      purpose: run.purpose,
      attempt: run.attempt,
      status: run.status,
    };
  }
}
