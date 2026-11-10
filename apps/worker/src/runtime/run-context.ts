import type {
  RequestContext,
  RunPurpose,
  TaskStatus,
  ToolInvocationRef,
  ToolResult,
} from '@claude-company/contracts';

/** Thư mục làm việc riêng của một run (`/worktrees/{runId}`). */
export type RunWorkspace = {
  runId: string;
  dir: string;
  kind: 'git_repo' | 'docs_folder' | 'empty';
};

/** Trạng thái chia sẻ giữa run-loop và ToolBroker trong một run. */
export type RunState = {
  /** Đã khóa tool (hết ngân sách, bị hủy): ToolBroker trả `run_locked` và không thực thi. */
  locked: boolean;
  lockReason?: string;
  /** `review_required` đã được dùng: run phải qua review (luôn đúng vì mọi task đều qua In Review). */
  requiresReview: boolean;
  /** Yêu cầu phê duyệt run đang chờ; có giá trị thì run sẽ tạm dừng (`waiting_approval`) khi agent kết thúc lượt. */
  pendingApprovalId?: string;
};

export type RunContext = {
  /** `actor.kind = 'ai'` kèm `runId`. */
  ctx: RequestContext;
  runId: string;
  taskId: string;
  employeeId: string;
  purpose: RunPurpose;
  reworkCount: number;
  /** Trạng thái task mà run này hợp lệ: task rời trạng thái đó thì tool bị khóa (nhân viên bị tạm ngưng, task bị chặn/hủy). */
  expectedTaskStatus: TaskStatus;
  state: RunState;
  workspace?: RunWorkspace;
};

/** Hàm thực thi một tool nội bộ/workspace; ném lỗi nếu thất bại. Kết quả trả cho agent. */
export type ToolHandler = (run: RunContext, input: unknown) => Promise<unknown>;

/**
 * Cổng xử lý hành động `human_approval`. Agent không bao giờ tự thực thi: cổng chỉ tạo đề xuất.
 * Cổng fail-closed (D6) chỉ còn dùng khi chưa nối Permission Engine; `ApprovalRequestGate` tạo `approval_request` thật.
 */
export interface HumanApprovalGate {
  handle(
    run: RunContext,
    invocation: ToolInvocationRef,
    detail: { actionType: string; input: unknown; summary: string; rationale?: string },
  ): Promise<ToolResult>;
}

/** D6: từ US3 đến khi xong US4, mọi hành động `human_approval` bị từ chối. */
export class FailClosedApprovalGate implements HumanApprovalGate {
  async handle(): Promise<ToolResult> {
    return {
      status: 'denied',
      message: 'Hành động cần Human Approval nhưng cơ chế phê duyệt chưa khả dụng nên bị từ chối',
    };
  }
}
