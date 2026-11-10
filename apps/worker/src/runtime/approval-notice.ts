import type { ApprovalRequest, ToolInvocation } from '@claude-company/contracts';
import { renderInput } from '@claude-company/model-gateway';

/**
 * Kết quả phê duyệt đưa lại cho agent khi run được resume (US4-AS5). Mọi nội dung là DỮ LIỆU: lý do của người duyệt
 * và kết quả adapter nằm trong thẻ mã hóa JSON như các dữ liệu khác của run (input-format.ts).
 */
export function renderApprovalNotice(
  approval: Pick<ApprovalRequest, 'actionType' | 'summary' | 'status' | 'decisionReason'>,
  invocation: Pick<ToolInvocation, 'status' | 'adapterMode' | 'result'> | undefined,
): string {
  const approved = approval.status === 'approved';
  const executed = approved && invocation?.status === 'succeeded';
  const instruction = approved
    ? executed
      ? 'Yêu cầu phê duyệt của bạn đã được duyệt và hệ thống đã thực thi hành động. Hãy tiếp tục công việc của task và nộp artifact khi xong.'
      : 'Yêu cầu phê duyệt của bạn đã được duyệt nhưng hành động chưa thực thi thành công. Đừng giả định hành động đã xảy ra; hãy báo rõ trong kết quả.'
    : 'Yêu cầu phê duyệt của bạn bị từ chối nên hành động KHÔNG được thực hiện. Hãy tiếp tục công việc theo hướng khác, không đề xuất lại đúng hành động đó, và nộp artifact khi xong.';
  return renderInput(
    {
      approval_result: {
        actionType: approval.actionType,
        summary: approval.summary,
        decision: approved ? 'approved' : 'rejected',
        reason: approval.decisionReason,
        executed,
        adapterMode: executed ? (invocation?.adapterMode ?? null) : null,
        executionResult: executed ? invocation?.result : undefined,
      },
    },
    instruction,
  );
}
