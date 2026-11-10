import type {
  OrchestrationEngine,
  PermissionEngine,
  TaskEngine,
  ToolInvocationRef,
  ToolResult,
} from '@claude-company/contracts';
import { summarizeAction } from '@claude-company/policy';
import { redact } from './redact';
import type { HumanApprovalGate, RunContext } from './run-context';

export type ApprovalGateDeps = {
  permissions: Pick<PermissionEngine, 'createApprovalRequest'>;
  orchestration: Pick<OrchestrationEngine, 'updateToolInvocation'>;
  tasks: Pick<TaskEngine, 'get'>;
};

/**
 * Cổng Human Approval (US4): agent chỉ TẠO ĐỀ XUẤT. Cổng tạo `approval_request`, khóa mọi tool còn lại của run
 * (`run_locked`) và để provider tạm dừng run chờ quyết định. Hành động chỉ được thực thi sau khi duyệt, bởi job
 * `action.execute-approved` của hệ thống (R4, FR-025) — không bao giờ ở đây.
 */
export class ApprovalRequestGate implements HumanApprovalGate {
  constructor(private readonly deps: ApprovalGateDeps) {}

  async handle(
    run: RunContext,
    invocation: ToolInvocationRef,
    detail: { actionType: string; input: unknown; summary: string; rationale?: string },
  ): Promise<ToolResult> {
    const task = await this.deps.tasks.get(run.ctx, run.taskId);
    // Tóm tắt do hệ thống sinh từ payload; lý do của agent chỉ là dữ liệu bổ sung, đã che secret.
    const summary = summarizeAction(detail.actionType, invocation.input ?? detail.input);
    const rationale =
      detail.rationale !== undefined
        ? String(redact(detail.rationale))
        : `Phục vụ task "${task.title}". Agent không nêu lý do riêng.`;
    const approval = await this.deps.permissions.createApprovalRequest(
      run.ctx,
      invocation,
      summary,
      rationale,
    );
    // Lưu id vào ledger để lời gọi lặp lại (dedupe) biết run đang chờ yêu cầu nào.
    await this.deps.orchestration.updateToolInvocation(run.ctx, invocation.id, {
      result: { approvalRequestId: approval.id },
    });
    run.state.pendingApprovalId = approval.id;
    run.state.locked = true;
    run.state.lockReason =
      'Đang chờ Human Approval; các tool khác bị khóa cho đến khi có quyết định';
    return {
      status: 'pending_approval',
      output: { approvalRequestId: approval.id },
      message:
        'Đã tạo yêu cầu phê duyệt. Hành động chưa được thực hiện; hãy kết thúc lượt và chờ quyết định.',
    };
  }
}
