import {
  DomainError,
  type OrchestrationEngine,
  type PermissionEngine,
  type RequestContext,
  type TaskEngine,
  type ToolAdapter,
} from '@claude-company/contracts';
import { payloadHashOf, stableStringify } from '@claude-company/policy';
import type { JobEnqueuer } from './run-jobs';
import { redact } from '../runtime/redact';

export type ApprovalJobPayload = {
  companyId: string;
  taskId: string;
  runId: string;
  employeeId: string;
  approvalRequestId: string;
  traceId: string;
  /** Có khi sweeper phát lại job đã mất: jobId của bước kế tiếp mang hậu tố này để không bị khử trùng với job cũ. */
  replay?: string;
  purpose?: string;
};

export type ExecuteApprovedDeps = {
  permissions: Pick<PermissionEngine, 'getApproval'>;
  orchestration: Pick<
    OrchestrationEngine,
    'getRun' | 'claimToolInvocation' | 'updateToolInvocation' | 'appendRunStep'
  >;
  tasks: Pick<TaskEngine, 'transition'>;
  adapters: { find(actionType: string): ToolAdapter | undefined };
  enqueue: JobEnqueuer;
};

export type ExecuteApprovedOutcome =
  'skipped' | 'executed' | 'failed' | 'blocked' | 'already_executed';

/**
 * Job `action.execute-approved` (T139): HỆ THỐNG, không phải agent, thực thi đúng payload đã duyệt qua adapter
 * (mặc định dry-run) rồi mới cho run tiếp tục. Chỉ chạy khi yêu cầu `approved`, hash payload khớp và payload khớp bản
 * ghi ledger; chiếm bản ghi bằng cập nhật có điều kiện nên duyệt/giao job hai lần chỉ thực thi một lần (SC-003).
 */
export async function executeApprovedAction(
  job: ApprovalJobPayload,
  deps: ExecuteApprovedDeps,
): Promise<ExecuteApprovedOutcome> {
  const sys: RequestContext = {
    companyId: job.companyId,
    actor: { kind: 'system' },
    traceId: job.traceId,
  };
  const approval = await deps.permissions.getApproval(sys, job.approvalRequestId);
  if (approval.status !== 'approved') return 'skipped'; // chưa duyệt, bị từ chối hoặc đã hủy: không thực thi

  const run = await deps.orchestration.getRun(sys, approval.runId);
  const invocation = run.toolInvocations.find((i) => i.id === approval.toolInvocationId);
  if (!invocation) return 'skipped';

  const resume = () =>
    deps.enqueue(
      'run.resume',
      { ...job, purpose: run.purpose },
      { jobId: `resume-${approval.id}${job.replay ? `-r${job.replay}` : ''}` },
    );
  const fail = async (code: string, message: string): Promise<'failed'> => {
    await deps.orchestration.updateToolInvocation(sys, invocation.id, {
      status: 'failed',
      result: { error: code, message },
    });
    await note(`Không thực thi ${approval.actionType}: ${message}`);
    await resume();
    return 'failed';
  };
  const note = (summary: string) =>
    deps.orchestration
      .appendRunStep(sys, run.id, {
        kind: 'system',
        summary,
        payload: redact({ approvalRequestId: approval.id }),
      })
      .then(
        () => undefined,
        () => undefined,
      );

  // Chỉ thực thi đúng thứ người duyệt đã xem: payload lưu trữ còn nguyên vẹn và trùng bản ghi ledger.
  if (payloadHashOf(approval.payload) !== approval.payloadHash) {
    return fail('APPROVAL_PAYLOAD_CHANGED', 'Payload của yêu cầu không còn khớp hash đã duyệt');
  }
  if (stableStringify(invocation.input) !== stableStringify(approval.payload)) {
    return fail('APPROVAL_PAYLOAD_CHANGED', 'Payload khác với bản ghi ledger của hành động');
  }

  const claimed = await deps.orchestration.claimToolInvocation(sys, invocation.id);
  if (!claimed && invocation.status !== 'executing') {
    // Job đã chạy trước đó (hoặc giao lại): không thực thi lần hai, chỉ bảo đảm run được đánh thức.
    await resume();
    return 'already_executed';
  }

  const adapter = deps.adapters.find(approval.actionType);
  if (!adapter) return fail('NO_ADAPTER', `Chưa có adapter cho ${approval.actionType}`);
  // Adapter nội bộ cần biết người duyệt và run/nhân viên đề xuất để dựng ngữ cảnh kèm `via` (R14 Decision 7).
  const adapterContext = {
    companyId: job.companyId,
    traceId: job.traceId,
    actionType: approval.actionType,
    approverMemberId: approval.decidedBy ?? approval.approverMemberId,
    employeeId: approval.employeeId,
    runId: approval.runId,
    taskId: approval.taskId,
  };

  if (!claimed) {
    // Lần chạy trước sập giữa chừng: hỏi adapter theo idempotency key trước khi làm gì tiếp.
    const state = await adapter.lookup(invocation.idempotencyKey, {
      ...adapterContext,
      input: invocation.input,
    });
    if (state === 'unknown') {
      await deps.orchestration.updateToolInvocation(sys, invocation.id, { status: 'unknown' });
      await blockTask(deps, sys, job.taskId, 'TOOL_OUTCOME_UNKNOWN');
      return 'blocked';
    }
  }

  try {
    const result = await adapter.execute(approval.payload, invocation.idempotencyKey, adapterContext);
    if (result.status !== 'ok') {
      return fail('ADAPTER_ERROR', result.message ?? 'Adapter không thực thi được');
    }
    await deps.orchestration.updateToolInvocation(sys, invocation.id, {
      status: 'succeeded',
      adapterMode: adapter.mode,
      result: redact(result.output),
    });
    await note(`Đã thực thi ${approval.actionType} (${adapter.mode}) sau khi được duyệt`);
    await resume();
    return 'executed';
  } catch (error) {
    if (error instanceof DomainError && error.code === 'ADAPTER_LIVE_NOT_CONFIGURED') {
      // Không có tích hợp thật: không được coi là đã thực thi. Task `blocked` để người thật quyết định.
      await deps.orchestration.updateToolInvocation(sys, invocation.id, {
        status: 'failed',
        result: { error: error.code, message: error.message },
      });
      await blockTask(deps, sys, job.taskId, 'ADAPTER_LIVE_NOT_CONFIGURED');
      return 'blocked';
    }
    return fail('ADAPTER_ERROR', error instanceof Error ? error.message : String(error));
  }
}

async function blockTask(
  deps: Pick<ExecuteApprovedDeps, 'tasks'>,
  ctx: RequestContext,
  taskId: string,
  blockedReason: string,
): Promise<void> {
  try {
    await deps.tasks.transition(ctx, taskId, 'block', { blockedReason });
  } catch (error) {
    // Task đã đổi trạng thái (hủy, đã bị chặn bởi luồng khác): không còn gì để chặn.
    if (!(error instanceof DomainError) || error.code !== 'TASK_INVALID_TRANSITION') throw error;
  }
}
