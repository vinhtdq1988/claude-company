import {
  APPROVAL_RATIONALE_FIELD,
  DomainError,
  TOOL_INPUT_SCHEMAS,
  type OrchestrationEngine,
  type PermissionEngine,
  type TaskEngine,
  type ToolInvocationRef,
  type ToolResult,
} from '@claude-company/contracts';
import { classifyShellCommand, getActionDefinition, sha256, stableStringify } from '@claude-company/policy';
import { FailClosedApprovalGate, type HumanApprovalGate, type RunContext, type ToolHandler } from './run-context';
import { redact } from './redact';
import { actionTypeForTool } from './tool-specs';

export { sha256, stableStringify };

export type ToolBrokerDeps = {
  orchestration: Pick<
    OrchestrationEngine,
    | 'appendRunStep'
    | 'recordToolInvocation'
    | 'updateToolInvocation'
    | 'findToolInvocationByKey'
  >;
  permissions: Pick<PermissionEngine, 'evaluate'>;
  tasks: Pick<TaskEngine, 'get'>;
  handlers: ReadonlyMap<string, ToolHandler>;
  humanApproval?: HumanApprovalGate;
  toolTimeoutMs: number;
};

/**
 * Điểm duy nhất thực thi lời gọi tool của agent (R4): ánh xạ tên → ActionType, phân loại lệnh shell bằng parser,
 * `PermissionEngine.evaluate`, ghi ledger `tool_invocation` cho MỌI đánh giá (kể cả `restricted`), chống lặp
 * theo idempotency key. Nội dung prompt/task không bao giờ là đầu vào của đánh giá quyền.
 */
export class ToolBroker {
  private readonly approval: HumanApprovalGate;
  private readonly chains = new WeakMap<object, Promise<void>>();

  constructor(private readonly deps: ToolBrokerDeps) {
    this.approval = deps.humanApproval ?? new FailClosedApprovalGate();
  }

  async invoke(
    run: RunContext,
    call: { name: string; input: unknown; providerCallId: string },
  ): Promise<ToolResult> {
    const locked = await this.lockReason(run);
    if (locked) {
      await this.step(run, `Tool "${call.name}" bị khóa: ${locked}`, { tool: call.name, locked });
      return { status: 'run_locked', message: locked };
    }

    // 1. Ánh xạ tên tool → ActionType; tên không ánh xạ được là `restricted` (FR-024, SC-004).
    let actionType: string = actionTypeForTool(call.name) ?? `unmapped.${call.name}`;
    let input: unknown = call.input;
    const schema = (TOOL_INPUT_SCHEMAS as Record<string, { safeParse(v: unknown): { success: boolean; data?: unknown; error?: { message: string } } }>)[actionType];
    if (schema) {
      const parsed = schema.safeParse(call.input);
      if (!parsed.success) {
        await this.step(run, `Tool "${call.name}" nhận input sai`, { tool: call.name });
        return { status: 'error', message: `Input không hợp lệ: ${parsed.error?.message ?? ''}` };
      }
      input = parsed.data;
    }
    // Lý do do agent đưa ra không thuộc payload: tách trước khi đánh giá quyền và băm (hiển thị như dữ liệu).
    let rationale: string | undefined;
    if (input && typeof input === 'object' && APPROVAL_RATIONALE_FIELD in input) {
      const { [APPROVAL_RATIONALE_FIELD]: raw, ...rest } = input as Record<string, unknown>;
      rationale = typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
      input = rest;
    }

    // 2. Lệnh shell được phân loại lại bằng parser AST: git push → workspace.git.push, ngoài allowlist → restricted.
    if (actionType === 'workspace.shell') {
      const classified = classifyShellCommand((input as { command: string }).command);
      if (classified.actionType === 'workspace.git.push') {
        actionType = 'workspace.git.push';
        input = classified.input;
      } else if (classified.actionType === 'shell.unclassified') {
        actionType = 'shell.unclassified';
      }
    }

    // 3. Quyền: chỉ phụ thuộc nhân viên, loại action và input đã chuẩn hóa.
    const { level, reason } = await this.deps.permissions.evaluate(run.ctx, {
      employeeId: run.employeeId,
      actionType,
      input,
    });

    // 4. Ghi bước chạy rồi dựng idempotency key theo nhóm dedupe/rerun của action-policy.md.
    const inputHash = sha256(stableStringify(input));
    const step = await this.deps.orchestration.appendRunStep(run.ctx, run.runId, {
      kind: 'tool_call',
      summary: `${actionType} → ${level}`,
      payload: redact({ tool: call.name, actionType, level, reason, input }),
    });
    const baseKey = this.idempotencyKey(run, actionType, inputHash, step.seq);

    // 5. Hành động nhóm dedupe đã có trong ledger: nhận trạng thái cũ thay vì thực thi lại.
    let key = baseKey;
    if (getActionDefinition(actionType)?.idempotency === 'dedupe') {
      for (let attempt = 1; ; attempt += 1) {
        const existing = await this.deps.orchestration.findToolInvocationByKey(run.ctx, key);
        if (!existing) break;
        // `pending_approval` chưa có yêu cầu đi kèm (sập giữa lúc ghi ledger và tạo yêu cầu) cũng không được chặn lần thử mới.
        const orphanPending =
          existing.status === 'pending_approval' &&
          !(existing.result as { approvalRequestId?: string } | undefined)?.approvalRequestId;
        if (existing.status === 'failed' || orphanPending) {
          key = `${baseKey}:${attempt + 1}`; // bản ghi `failed` không chặn lần thử mới
          continue;
        }
        return this.fromLedger(existing);
      }
    }

    // 6. Ghi ledger rồi xử lý theo mức quyền.
    const denied = level === 'restricted';
    const invocation = await this.deps.orchestration.recordToolInvocation(run.ctx, {
      runId: run.runId,
      runStepId: step.id,
      actionType,
      permissionLevel: level,
      input: redact(input),
      inputHash,
      idempotencyKey: key,
      status: denied ? 'denied' : level === 'human_approval' ? 'pending_approval' : 'executing',
    });
    if (denied) return { status: 'denied', message: reason };

    if (level === 'human_approval') {
      return this.serialized(run, async () => {
        // Hai lời gọi đồng thời cùng qua kiểm tra khóa ở đầu `invoke`: chỉ lời gọi đầu được tạo yêu cầu duyệt.
        if (run.state.locked) {
          await this.deps.orchestration.updateToolInvocation(run.ctx, invocation.id, {
            status: 'failed',
            result: { message: run.state.lockReason ?? 'Run đã bị khóa' },
          });
          return { status: 'run_locked' as const, message: run.state.lockReason ?? 'Run đã bị khóa' };
        }
        let result: ToolResult;
        try {
          result = await this.approval.handle(run, invocation, {
            actionType,
            input,
            summary: `Đề xuất ${actionType}`,
            rationale,
          });
        } catch (error) {
          // Không tạo được yêu cầu: bản ghi `pending_approval` mồ côi sẽ chặn mọi lần đề xuất lại, nên đóng nó lại.
          const message = error instanceof Error ? error.message : String(error);
          await this.deps.orchestration.updateToolInvocation(run.ctx, invocation.id, {
            status: 'failed',
            result: { error: redact(message) },
          });
          return { status: 'error' as const, message: `Không tạo được yêu cầu phê duyệt: ${redact(message)}` };
        }
        if (result.status === 'denied') {
          await this.deps.orchestration.updateToolInvocation(run.ctx, invocation.id, {
            status: 'denied',
            result: { message: result.message },
          });
        }
        return result;
      });
    }
    if (level === 'review_required') run.state.requiresReview = true;
    return this.execute(run, invocation, actionType, input);
  }

  private async execute(
    run: RunContext,
    invocation: ToolInvocationRef,
    actionType: string,
    input: unknown,
  ): Promise<ToolResult> {
    const handler = this.deps.handlers.get(actionType);
    try {
      if (!handler) throw new Error(`Chưa có trình xử lý cho "${actionType}"`);
      const output = await withTimeout(handler(run, input), this.deps.toolTimeoutMs);
      await this.deps.orchestration.updateToolInvocation(run.ctx, invocation.id, {
        status: 'succeeded',
        result: redact(output),
      });
      return { status: 'ok', output };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.deps.orchestration.updateToolInvocation(run.ctx, invocation.id, {
        status: 'failed',
        result: { error: redact(message) },
      });
      return { status: 'error', message: redact(message) };
    }
  }

  /** Lý do khóa tool: bị khóa thủ công, hoặc task đã rời trạng thái mà run này hợp lệ (tạm ngưng, chặn, hủy). */
  private async lockReason(run: RunContext): Promise<string | null> {
    if (run.state.locked) return run.state.lockReason ?? 'Run đã bị khóa';
    try {
      const task = await this.deps.tasks.get(run.ctx, run.taskId);
      if (task.status !== run.expectedTaskStatus) {
        return `Task đã chuyển sang "${task.status}", run không còn hiệu lực`;
      }
    } catch (error) {
      if (error instanceof DomainError && error.code === 'NOT_FOUND') return 'Task không còn tồn tại';
      throw error;
    }
    return null;
  }

  private idempotencyKey(run: RunContext, actionType: string, inputHash: string, stepSeq: number): string {
    const def = getActionDefinition(actionType);
    if (def?.idempotency === 'dedupe') {
      return sha256(`${run.taskId}${run.reworkCount}${actionType}${inputHash}`);
    }
    return `${run.runId}:${stepSeq}`;
  }

  private fromLedger(existing: ToolInvocationRef): ToolResult {
    switch (existing.status) {
      case 'succeeded':
        return { status: 'ok', output: existing.result };
      case 'pending_approval':
        // `result` giữ `approvalRequestId` để provider biết run đang chờ yêu cầu nào.
        return { status: 'pending_approval', output: existing.result, message: 'Đề xuất đang chờ phê duyệt' };
      case 'denied':
        return { status: 'denied', message: 'Hành động này đã bị từ chối trước đó' };
      default:
        return { status: 'error', message: `Hành động đang ở trạng thái "${existing.status}"` };
    }
  }

  /** Chuỗi hóa theo run để chỉ một yêu cầu phê duyệt được tạo trước khi tool khác bị khóa. */
  private async serialized<T>(run: RunContext, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(run.state) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    this.chains.set(
      run.state,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  private async step(run: RunContext, summary: string, payload: Record<string, unknown>): Promise<void> {
    await this.deps.orchestration.appendRunStep(run.ctx, run.runId, {
      kind: 'system',
      summary,
      payload: redact(payload),
    });
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Tool vượt quá ${Math.round(ms / 1000)} giây`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
