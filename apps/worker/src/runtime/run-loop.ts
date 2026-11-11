import {
  CEO_ASSISTANT_TEMPLATE_KEY,
  DomainError,
  decompositionPlanSchema,
  reviewResultSchema,
  taskProposalSchema,
  FINAL_RUN_STATUSES,
  type AgentRunDetail,
  type BudgetService,
  type CommunicationEngine,
  type EmployeeEngine,
  type EmployeeProfile,
  type ModelCatalog,
  type OrchestrationEngine,
  type PermissionEngine,
  type RequestContext,
  type RunPurpose,
  type TaskDetail,
  type TaskEngine,
  type TaskStatus,
} from '@claude-company/contracts';
import {
  GATEWAY_ERROR,
  type AgentRunEvent,
  type AgentRunIO,
  type AgentRunRequest,
  type ModelGateway,
  type TokenUsage,
} from '@claude-company/model-gateway';
import { renderApprovalNotice } from './approval-notice';
import { InputBuilder, systemPromptFor } from './input-builder';
import type { RunContext, RunState } from './run-context';
import { ToolBroker } from './tool-broker';
import { buildToolSpecs } from './tool-specs';
import type { RunWorkspaceManager } from '../tools/run-workspace';

/** Dữ liệu của job BullMQ cho mọi loại run. */
export type RunJobPayload = {
  companyId: string;
  taskId: string;
  runId: string;
  employeeId: string;
  purpose: RunPurpose;
  traceId: string;
  /** Có giá trị: job `run.resume` tiếp tục run đang `waiting_approval` sau quyết định của người duyệt (US4). */
  approvalRequestId?: string;
};

/** Trạng thái task mà mỗi loại run hợp lệ; ngoài trạng thái đó run bị hủy thay vì chạy. */
export const EXPECTED_TASK_STATUS: Record<RunPurpose, TaskStatus> = {
  execute: 'in_progress',
  decompose: 'assigned',
  review: 'in_review',
  synthesize: 'in_progress',
  // Run đề xuất của CEO AI Assistant chạy trên task nháp và không đổi trạng thái task.
  propose: 'draft',
};

/** Một lượt gọi model `messages_api` trả tối đa chừng này token. */
const MESSAGES_MAX_TOKENS = 8_192;

export type RunLoopConfig = {
  RETRY_MAX: number;
  RETRY_BACKOFF_INITIAL_MS: number;
  RETRY_BACKOFF_MAX_MS: number;
  RUN_TIMEOUT_MS: number;
  MODEL_TIMEOUT_MS: number;
  RUN_HEARTBEAT_INTERVAL_MS: number;
  SDK_BUDGET_HEADROOM: number;
  SDK_RUN_RESERVE_USD: number;
  SDK_RUN_RESERVE_TOKENS: number;
  DEFAULT_MONTHLY_COST_LIMIT_USD: number;
};

/** Hàm tính chi phí/ước tính dùng chung với api (`platform/usage-budget/cost.ts`). */
export type CostFns = {
  computeCostUsd(usage: TokenUsage & { cacheReadTokens: number; cacheWriteTokens: number }, price: Price): number;
  estimateSdkRun(input: {
    reserveUsd: number;
    reserveTokens: number;
    costCapRemaining?: number | null;
    tokenCapRemaining?: number | null;
  }): { blocked: true } | { blocked: false; estTokens: number; estCostUsd: number };
  sdkMaxBudgetUsd(reservedUsd: number, headroom: number): number;
  sdkTokenCeiling(reservedTokens: number, headroom: number): number;
};

type Price = {
  inputPerMtok: number;
  outputPerMtok: number;
  cacheReadPerMtok: number;
  cacheWritePerMtok: number;
};

export type RunLoopDeps = {
  gateway: ModelGateway;
  tasks: TaskEngine;
  employees: EmployeeEngine;
  orchestration: OrchestrationEngine;
  permissions: Pick<PermissionEngine, 'getApproval'>;
  budget: BudgetService;
  communication: CommunicationEngine;
  catalog: ModelCatalog;
  broker: ToolBroker;
  inputs: InputBuilder;
  workspaces: RunWorkspaceManager;
  cost: CostFns;
  config: RunLoopConfig;
  /** Khóa theo task: một task chỉ có một run hoạt động tại một thời điểm. */
  lockTask(taskId: string, ttlMs: number): Promise<{ release(): Promise<void> } | null>;
  logger: { error(message: string, error?: unknown): void; warn(message: string): void };
};

/** Task đang có run khác chạy: caller đặt lại job với độ trễ. */
export class RunBusyError extends Error {}

type Outcome =
  | { kind: 'finished'; output: unknown }
  | { kind: 'paused'; approvalRequestId: string }
  | { kind: 'error'; code: string; message: string; retryable: boolean };

/**
 * Vòng lặp một run (T113): dựng yêu cầu cho ModelGateway, cưỡng chế ngân sách trước khi tiêu, ghi `run_step`,
 * heartbeat, timeout, retry và áp kết quả theo `purpose`. Mọi ghi nhận run đi qua OrchestrationEngine.
 */
export class RunExecutor {
  constructor(private readonly deps: RunLoopDeps) {}

  async execute(job: RunJobPayload): Promise<void> {
    const lock = await this.deps.lockTask(job.taskId, this.deps.config.RUN_TIMEOUT_MS + 60_000);
    if (!lock) throw new RunBusyError(`Task ${job.taskId} đang có run khác`);
    try {
      await this.run(job);
    } finally {
      await lock.release();
    }
  }

  private async run(job: RunJobPayload): Promise<void> {
    const { deps } = this;
    const sys: RequestContext = { companyId: job.companyId, actor: { kind: 'system' }, traceId: job.traceId };
    const run = await deps.orchestration.getRun(sys, job.runId);
    // `queued`: run mới. `waiting_approval`: resume sau quyết định phê duyệt. Trạng thái khác: đã chạy, bị hủy hoặc job bị giao lại.
    const resuming = job.approvalRequestId !== undefined;
    if (run.status !== (resuming ? 'waiting_approval' : 'queued')) return;

    const [task, employee] = await Promise.all([
      deps.tasks.get(sys, job.taskId),
      deps.employees.get(sys, run.employeeId),
    ]);
    const ai: RequestContext = {
      companyId: job.companyId,
      actor: { kind: 'ai', employeeId: employee.id, runId: run.id },
      traceId: job.traceId,
    };
    if (task.status !== EXPECTED_TASK_STATUS[run.purpose] || employee.status !== 'active') {
      await deps.orchestration.updateRunStatus(ai, run.id, {
        status: 'cancelled',
        errorCode: employee.status !== 'active' ? 'EMPLOYEE_SUSPENDED' : 'TASK_STATE_CHANGED',
        errorMessage: 'Task hoặc nhân viên đã đổi trạng thái trước khi run bắt đầu',
      });
      return;
    }

    if (!(await deps.budget.isModelAllowed(ai, employee.id, run.modelId))) {
      await this.fail(ai, run, task, 'MODEL_NOT_ALLOWED', 'Model không được phép dùng', false, 'MODEL_NOT_ALLOWED');
      return;
    }
    const price = (await deps.catalog.listModels()).find((m) => m.modelId === run.modelId);
    if (!price) {
      await this.fail(ai, run, task, 'MODEL_NOT_ALLOWED', 'Model chưa có trong bảng giá', false, 'MODEL_NOT_ALLOWED');
      return;
    }

    await deps.orchestration.updateRunStatus(ai, run.id, { status: 'running' });
    const abort = new AbortController();
    const state: RunState = { locked: false, requiresReview: false };
    const flags = { timedOut: false, cancelled: false, budgetExceeded: false };
    const timeout = setTimeout(() => {
      flags.timedOut = true;
      state.locked = true;
      state.lockReason = 'Run vượt quá thời gian cho phép';
      abort.abort();
    }, deps.config.RUN_TIMEOUT_MS);
    const heartbeat = setInterval(() => {
      deps.orchestration
        .heartbeat(ai, run.id)
        .then((status) => {
          if (status === 'cancelled') {
            flags.cancelled = true;
            state.locked = true;
            state.lockReason = 'Run đã bị hủy';
            abort.abort();
          }
        })
        .catch((error) => deps.logger.warn(`Heartbeat run ${run.id} lỗi: ${String(error)}`));
    }, deps.config.RUN_HEARTBEAT_INTERVAL_MS);

    try {
      const outcome = await this.drive(ai, run, task, employee, price, state, abort, flags, job.approvalRequestId);
      await this.conclude(ai, run, task, outcome, flags, state);
    } catch (error) {
      deps.logger.error(`Run ${run.id} gặp lỗi không lường trước`, error);
      await this.fail(
        ai,
        run,
        task,
        'PROVIDER_ERROR',
        error instanceof Error ? error.message : String(error),
        true,
      ).catch((inner) => deps.logger.error(`Không ghi được lỗi của run ${run.id}`, inner));
    } finally {
      clearTimeout(timeout);
      clearInterval(heartbeat);
      // Mọi phần ngân sách còn giữ được trả lại (idempotent): run xong, lỗi hay bị hủy đều không để treo.
      await deps.budget.releaseRun(ai, run.id).catch(() => undefined);
    }
  }

  /** Chạy ModelGateway tới khi có kết quả; trả `Outcome`. */
  private async drive(
    ai: RequestContext,
    run: AgentRunDetail,
    task: TaskDetail,
    employee: EmployeeProfile,
    price: Price,
    state: RunState,
    abort: AbortController,
    flags: { timedOut: boolean; cancelled: boolean; budgetExceeded: boolean },
    approvalRequestId?: string,
  ): Promise<Outcome> {
    const { deps } = this;
    const purpose = run.purpose;
    const isSdk = run.runtimeKind === 'claude_agent_sdk';
    const structured = purpose === 'decompose' || purpose === 'review' || purpose === 'propose';

    // Thư mục làm việc riêng của run (chỉ run thực thi cần tới file).
    let workspace: RunContext['workspace'];
    if (purpose === 'execute') {
      const source = employee.workspaceId ? await deps.employees.getWorkspace(ai, employee.workspaceId) : null;
      const previous = await deps.orchestration.listRuns(ai, { taskId: task.id });
      const previousRun = previous.items.find(
        (r) => r.id !== run.id && r.purpose === 'execute' && FINAL_RUN_STATUSES.includes(r.status),
      );
      workspace = await deps.workspaces.prepare({
        runId: run.id,
        source,
        previousRunId: previousRun?.id ?? null,
        workspaceRoot: source ? await deps.employees.getWorkspaceRoot(ai) : undefined,
      });
    }

    const runContext: RunContext = {
      ctx: ai,
      runId: run.id,
      taskId: task.id,
      employeeId: employee.id,
      purpose,
      reworkCount: task.reworkCount,
      expectedTaskStatus: EXPECTED_TASK_STATUS[purpose],
      state,
      workspace,
    };

    // Ngân sách runtime SDK: reserve MỘT lần theo run (R6); messages_api reserve theo từng lượt trong beforeModelCall.
    let sdkReservationId: string | null = null;
    let sdkReservedTokens = 0;
    let maxCostUsd = deps.config.DEFAULT_MONTHLY_COST_LIMIT_USD;
    if (isSdk) {
      const used =
        task.tokenCap !== null || task.costCap !== null
          ? await deps.budget.getUsage(ai, { taskId: task.id })
          : null;
      const estimate = deps.cost.estimateSdkRun({
        reserveUsd: deps.config.SDK_RUN_RESERVE_USD,
        reserveTokens: deps.config.SDK_RUN_RESERVE_TOKENS,
        costCapRemaining: task.costCap === null || !used ? null : task.costCap - used.costUsd,
        tokenCapRemaining: task.tokenCap === null || !used ? null : task.tokenCap - used.tokens,
      });
      if (estimate.blocked) {
        flags.budgetExceeded = true;
        return { kind: 'error', code: GATEWAY_ERROR.BUDGET_EXCEEDED, message: 'Trần của task đã hết', retryable: false };
      }
      const reservation = await deps.budget.reserve(ai, {
        runId: run.id,
        taskId: task.id,
        employeeId: employee.id,
        modelId: run.modelId,
        estTokens: estimate.estTokens,
        estCostUsd: estimate.estCostUsd,
      });
      if (!reservation.ok) {
        flags.budgetExceeded = true;
        return {
          kind: 'error',
          code: GATEWAY_ERROR.BUDGET_EXCEEDED,
          message: `Chạm giới hạn ${reservation.limitHit.kind} của ${reservation.limitHit.scopeKind}`,
          retryable: false,
        };
      }
      sdkReservationId = reservation.reservationId;
      sdkReservedTokens = estimate.estTokens;
      maxCostUsd = deps.cost.sdkMaxBudgetUsd(estimate.estCostUsd, deps.config.SDK_BUDGET_HEADROOM);
    }
    const tokenCeiling = deps.cost.sdkTokenCeiling(sdkReservedTokens, deps.config.SDK_BUDGET_HEADROOM);

    // Resume sau phê duyệt: kết quả duyệt là DỮ LIỆU đưa cho agent; SDK nối lại session, messages_api nạp hội thoại đã lưu.
    let input = await deps.inputs.build(ai, task, purpose, employee.id);
    let resumeSessionId = run.providerSessionId ?? undefined;
    let resumeConversation: unknown;
    if (approvalRequestId) {
      const approval = await deps.permissions.getApproval(ai, approvalRequestId);
      const detail = await deps.orchestration.getRun(ai, run.id);
      const notice = renderApprovalNotice(
        approval,
        detail.toolInvocations.find((i) => i.id === approval.toolInvocationId),
      );
      const saved = isSdk ? undefined : await deps.orchestration.loadConversationState(ai, run.id);
      if (isSdk ? resumeSessionId : saved) {
        input = notice;
        resumeConversation = saved ?? undefined;
      } else {
        // Không còn session/hội thoại để nối: bắt đầu lại; sổ ledger (dedupe) chặn việc lặp hành động đã làm.
        input = [input, notice].join('\n\n');
        resumeSessionId = undefined;
      }
    } else if (!isSdk) {
      resumeConversation = (await deps.orchestration.loadConversationState(ai, run.id)) ?? undefined;
    }

    const request: AgentRunRequest = {
      runtimeKind: run.runtimeKind,
      modelId: run.modelId,
      systemPrompt: systemPromptFor(employee.systemPrompt, purpose),
      input,
      tools: structured
        ? []
        : buildToolSpecs(employee.toolGrants, run.runtimeKind, {
            isCeoAssistant: employee.roleTemplateKey === CEO_ASSISTANT_TEMPLATE_KEY,
          }),
      workspacePath: workspace?.dir,
      resumeSessionId,
      resumeConversation,
      limits: {
        maxCostUsd,
        maxTokens: MESSAGES_MAX_TOKENS,
        timeoutMs: deps.config.MODEL_TIMEOUT_MS,
      },
      structuredOutput:
        purpose === 'decompose'
          ? decompositionPlanSchema
          : purpose === 'review'
            ? reviewResultSchema
            : purpose === 'propose'
              ? taskProposalSchema
              : undefined,
    };

    let turnReservationId: string | null = null;
    let tokensUsed = 0;
    const io: AgentRunIO = {
      invokeTool: (call) => deps.broker.invoke(runContext, call),
      beforeModelCall: async (est) => {
        if (state.locked) return false;
        if (isSdk) return true;
        const estInput = est.estInputTokens ?? est.estTokens;
        const estOutput = est.estOutputTokens ?? 0;
        const estCostUsd = (estInput * price.inputPerMtok + estOutput * price.outputPerMtok) / 1_000_000;
        const reservation = await deps.budget.reserve(ai, {
          runId: run.id,
          taskId: task.id,
          employeeId: employee.id,
          modelId: run.modelId,
          estTokens: est.estTokens,
          estCostUsd,
        });
        if (!reservation.ok) {
          flags.budgetExceeded = true;
          state.locked = true;
          state.lockReason = 'Hết ngân sách';
          return false;
        }
        turnReservationId = reservation.reservationId;
        return true;
      },
      saveConversation: (messages) => deps.orchestration.saveConversationState(ai, run.id, messages),
      signal: abort.signal,
    };

    const onModelCall = async (event: Extract<AgentRunEvent, { type: 'model_call' }>) => {
      const costUsd = deps.cost.computeCostUsd(event.usage, price);
      const reservationId = isSdk ? sdkReservationId : turnReservationId;
      if (reservationId) {
        const result = await deps.budget.commit(ai, reservationId, {
          providerMessageId: event.messageId,
          modelId: event.modelId || run.modelId,
          ...event.usage,
          costUsd,
        });
        for (const warning of result.warnings) {
          if (warning.scopeKind === 'task') continue;
          await deps.communication
            .notifyRouted(ai, {
              type: 'budget_warning',
              title: `Đã dùng ${Math.round((warning.used / warning.limit) * 100)}% hạn mức ${warning.kind === 'cost' ? 'chi phí' : 'token'}`,
              body: `Phạm vi ${warning.scopeKind}: ${warning.used}/${warning.limit}`,
              scope: { kind: warning.scopeKind as 'company', id: warning.scopeId },
            })
            .catch((error) => deps.logger.warn(`Không gửi được cảnh báo ngân sách: ${String(error)}`));
        }
        // Một lời gọi đơn lẻ vượt phần đã giữ: ghi overage và chặn các lượt tiếp theo (edge case ngân sách).
        if (result.overage) {
          flags.budgetExceeded = true;
          state.locked = true;
          state.lockReason = 'Vượt ngân sách';
        }
      }
      if (isSdk) {
        tokensUsed += event.usage.inputTokens + event.usage.outputTokens + event.usage.cacheReadTokens + event.usage.cacheWriteTokens;
        // `maxBudgetUsd` chỉ chặn theo USD nên run-loop tự khóa tool khi chạm trần token (R6).
        if (tokensUsed >= tokenCeiling) {
          flags.budgetExceeded = true;
          state.locked = true;
          state.lockReason = 'Chạm trần token của run';
        }
      } else if (turnReservationId) {
        await deps.budget.release(ai, turnReservationId); // trả phần ước tính dư của lượt
        turnReservationId = null;
      }
      const tokens = event.usage.inputTokens + event.usage.outputTokens + event.usage.cacheReadTokens + event.usage.cacheWriteTokens;
      await deps.orchestration.publishRunEvent(ai, run.id, { type: 'usage', tokensDelta: tokens, costDelta: costUsd });
      await deps.orchestration.appendRunStep(ai, run.id, {
        kind: 'model_call',
        summary: `Lượt model: ${event.usage.inputTokens} vào / ${event.usage.outputTokens} ra, $${costUsd.toFixed(6)}`,
        payload: { messageId: event.messageId, modelId: event.modelId, usage: event.usage, costUsd },
      });
    };

    let outcome: Outcome | null = null;
    await deps.orchestration.publishRunEvent(ai, run.id, { type: 'progress', progress: 5 });
    for await (const event of deps.gateway.runAgent(request, io)) {
      switch (event.type) {
        case 'session':
          await deps.orchestration.updateRunStatus(ai, run.id, { providerSessionId: event.sessionId });
          break;
        case 'model_call_started':
          await deps.orchestration.publishRunEvent(ai, run.id, { type: 'model_call_started' });
          break;
        case 'model_call':
          await onModelCall(event);
          break;
        case 'tool_call':
          if (event.status === 'started') {
            await deps.orchestration.publishRunEvent(ai, run.id, { type: 'tool_call_started', tool: event.name });
          }
          break;
        case 'progress':
          await deps.orchestration.publishRunEvent(ai, run.id, { type: 'progress', progress: event.percent });
          break;
        case 'text':
          break;
        case 'paused_for_approval':
          outcome = { kind: 'paused', approvalRequestId: event.approvalRequestId };
          break;
        case 'finished':
          outcome = { kind: 'finished', output: event.output };
          break;
        case 'error':
          outcome = { kind: 'error', code: event.code, message: event.message, retryable: event.retryable };
          break;
      }
    }
    return outcome ?? { kind: 'error', code: GATEWAY_ERROR.PROVIDER_ERROR, message: 'Provider kết thúc mà không có kết quả', retryable: true };
  }

  /** Áp kết quả của run theo `purpose` hoặc xử lý lỗi/timeout/ngân sách. */
  private async conclude(
    ai: RequestContext,
    run: AgentRunDetail,
    task: TaskDetail,
    outcome: Outcome,
    flags: { timedOut: boolean; cancelled: boolean; budgetExceeded: boolean },
    state: RunState,
  ): Promise<void> {
    const { deps } = this;
    if (flags.cancelled) return; // run đã `cancelled` ở phía engine; không ghi đè
    if (flags.budgetExceeded) {
      await this.fail(ai, run, task, 'BUDGET_EXCEEDED', 'Hết ngân sách của phạm vi áp dụng', false, 'BUDGET_EXCEEDED');
      return;
    }
    if (state.blockedReason) {
      // Chốt chặn của CEO AI Assistant (vượt số thao tác tối đa của một run): không thử lại, buộc CEO xem lại.
      await this.fail(ai, run, task, state.blockedReason, state.lockReason ?? 'Run bị khóa', false, state.blockedReason);
      return;
    }
    if (flags.timedOut) {
      await this.fail(ai, run, task, 'TIMEOUT', 'Run vượt quá thời gian cho phép', true, undefined, 'timed_out');
      return;
    }
    if (outcome.kind === 'error') {
      await this.fail(ai, run, task, outcome.code, outcome.message, outcome.retryable);
      return;
    }
    if (outcome.kind === 'paused') {
      // Provider chỉ tạm dừng khi có tool trả `pending_approval`/`run_locked`. Không có yêu cầu phê duyệt nào do
      // run này tạo nghĩa là tool bị khóa vì task đã đổi trạng thái: không có gì để chờ nên không treo ở waiting_approval.
      if (!state.pendingApprovalId) {
        await deps.orchestration.updateRunStatus(ai, run.id, {
          status: 'cancelled',
          errorCode: 'TASK_STATE_CHANGED',
          errorMessage: 'Task đổi trạng thái trong lúc run đang chạy',
        });
        return;
      }
      // Phần ngân sách đang giữ được trả lại; lúc resume sẽ reserve lại (không đủ thì task `blocked`).
      await deps.budget.releaseRun(ai, run.id);
      await deps.orchestration.updateRunStatus(ai, run.id, { status: 'waiting_approval' });
      return;
    }

    switch (run.purpose) {
      case 'decompose': {
        await deps.orchestration.applyDecompositionPlan(ai, task.id, decompositionPlanSchema.parse(outcome.output));
        break;
      }
      case 'review': {
        await deps.orchestration.applyReviewResult(ai, task.id, reviewResultSchema.parse(outcome.output));
        break;
      }
      case 'propose': {
        // Đề xuất sai định dạng không ném lỗi ra ngoài: `applyTaskProposal` đánh dấu `failed` để CEO sửa tay.
        const proposal = taskProposalSchema.safeParse(outcome.output);
        await deps.orchestration.applyTaskProposal(
          ai,
          task.id,
          proposal.success ? proposal.data : { failed: true, reason: 'Đề xuất không đúng định dạng' },
        );
        break;
      }
      default:
        break;
    }
    await deps.orchestration.publishRunEvent(ai, run.id, { type: 'progress', progress: 100 });
    // `succeeded` phát cuối cùng: listener nộp task (submit) ngay khi thấy sự kiện này.
    await deps.orchestration.updateRunStatus(ai, run.id, { status: 'succeeded' });
  }

  /**
   * Ghi lỗi run. Lỗi tạm thời được thử lại theo `RETRY_MAX` với backoff mũ; hết lượt (hoặc lỗi không thể thử lại)
   * thì task `blocked` để người thật quyết định (`RETRIES_EXHAUSTED` hoặc `blockedReason` chỉ định).
   */
  private async fail(
    ai: RequestContext,
    run: AgentRunDetail,
    task: Pick<TaskDetail, 'id'>,
    code: string,
    message: string,
    retryable: boolean,
    blockedReason?: string,
    status: 'failed' | 'timed_out' = 'failed',
  ): Promise<void> {
    const { deps } = this;
    await deps.orchestration.updateRunStatus(ai, run.id, { status, errorCode: code, errorMessage: message });
    if (retryable && !blockedReason && run.attempt <= deps.config.RETRY_MAX) {
      const delay = Math.min(
        deps.config.RETRY_BACKOFF_INITIAL_MS * 2 ** (run.attempt - 1),
        deps.config.RETRY_BACKOFF_MAX_MS,
      );
      await deps.orchestration.enqueueRetry(ai, run.id, delay);
      return;
    }
    if (run.purpose === 'propose') {
      // Hết lượt thử: task nháp giữ nguyên trạng thái, đề xuất `failed` để CEO sửa tay (R14 Decision 5).
      await deps.orchestration.applyTaskProposal({ ...ai, actor: { kind: 'system' } }, task.id, {
        failed: true,
        reason: message,
      });
      return;
    }
    try {
      await deps.tasks.transition({ ...ai, actor: { kind: 'system' } }, task.id, 'block', {
        blockedReason: blockedReason ?? 'RETRIES_EXHAUSTED',
      });
    } catch (error) {
      // Task đã chuyển trạng thái (bị hủy, đã bị chặn bởi luồng khác): không còn gì để chặn.
      if (!(error instanceof DomainError) || error.code !== 'TASK_INVALID_TRANSITION') throw error;
    }
  }
}
