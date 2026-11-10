import { z } from 'zod';
import type { ToolInvocationStatus } from './run';

export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;
export const approvalStatusSchema = z.enum(APPROVAL_STATUSES);
/** Không có `expired`: yêu cầu không bao giờ tự hết hạn hay tự duyệt (edge case, FR-026). */
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;

/**
 * Tham chiếu tới một dòng ledger `tool_invocation` (kèm trạng thái để dedupe theo idempotency key).
 * `runId`, `taskId`, `permissionLevel`, `input` cho phép PermissionEngine tạo yêu cầu phê duyệt từ bản ghi đã lưu
 * mà không phải đọc bảng của Orchestration Engine.
 */
export type ToolInvocationRef = {
  id: string;
  runId: string;
  taskId: string;
  actionType: string;
  permissionLevel: string;
  payloadHash: string;
  idempotencyKey: string;
  status: ToolInvocationStatus;
  /** Input đã chuẩn hóa và che secret, đúng bản được ghi vào ledger. */
  input: unknown;
  result?: unknown;
};

export type ApprovalRequest = {
  id: string;
  toolInvocationId: string;
  runId: string;
  taskId: string;
  employeeId: string;
  actionType: string;
  /** Hệ thống tự sinh từ payload: AI định làm gì. */
  summary: string;
  /** Do agent cung cấp: vì sao. Luôn hiển thị như dữ liệu, không render HTML. */
  rationale: string;
  /** Đúng payload sẽ được thực thi sau khi duyệt. */
  payload: unknown;
  payloadHash: string;
  approverMemberId: string;
  status: ApprovalStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  lastRemindedAt: string | null;
  createdAt: string;
  /** Chỉ có ở `get`/`list`: tên hiển thị cho hộp phê duyệt. */
  taskTitle?: string;
  employeeName?: string;
};

/** Cả approve lẫn reject đều bắt buộc lý do (FR-019); thiếu → 422. */
export const approvalDecisionSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  reason: z.string().trim().min(1).max(5_000),
  payloadHash: z.string().trim().min(1).max(128),
});
export type ApprovalDecisionBody = z.infer<typeof approvalDecisionSchema>;

export const approvalListQuerySchema = z.object({
  status: approvalStatusSchema.optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ApprovalListQuery = z.infer<typeof approvalListQuerySchema>;

export type ApprovalFilter = {
  status?: ApprovalStatus;
  taskId?: string;
  /** Chỉ yêu cầu của nhân viên trong phạm vi này (undefined = không lọc, dành cho tác nhân hệ thống). */
  employeeIds?: string[];
  limit?: number;
};
