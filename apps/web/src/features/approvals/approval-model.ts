import type { ApprovalRequest, ApprovalStatus } from '@claude-company/contracts';
import type { MessageKey } from '../../i18n/vi';

/** Khóa giao diện cho tên action cần Human Approval; action lạ rơi về mã gốc. */
const ACTION_LABEL_KEYS: Readonly<Record<string, MessageKey>> = {
  'email.send': 'approvals.action.email.send',
  'data.delete': 'approvals.action.data.delete',
  'deploy.staging': 'approvals.action.deploy.staging',
  'deploy.production': 'approvals.action.deploy.production',
  'workspace.git.push': 'approvals.action.workspace.git.push',
};

export function actionLabelKey(actionType: string): MessageKey | null {
  return ACTION_LABEL_KEYS[actionType] ?? null;
}

export const STATUS_LABEL_KEYS: Readonly<Record<ApprovalStatus, MessageKey>> = {
  pending: 'approvals.status.pending',
  approved: 'approvals.status.approved',
  rejected: 'approvals.status.rejected',
  cancelled: 'approvals.status.cancelled',
};

/**
 * Payload hiển thị cho người duyệt: JSON thụt lề, là VĂN BẢN THUẦN (nơi gọi đặt trong `<pre>`, không render HTML
 * nên nội dung do AI sinh ra không chèn được mã vào trang).
 */
export function formatPayload(payload: unknown): string {
  try {
    return JSON.stringify(payload, null, 2) ?? String(payload);
  } catch {
    return String(payload);
  }
}

/** Chỉ yêu cầu `pending` mới quyết định được; trạng thái khác chỉ để xem lại. */
export const canDecideApproval = (approval: Pick<ApprovalRequest, 'status'>): boolean =>
  approval.status === 'pending';

/** Lý do hợp lệ: bắt buộc cho cả duyệt lẫn từ chối (FR-019), không chỉ khoảng trắng. */
export const normalizeReason = (reason: string): string | null => {
  const trimmed = reason.trim();
  return trimmed.length > 0 ? trimmed : null;
};

/** Yêu cầu chờ duyệt lâu nhất lên trước để không bị bỏ quên; các trạng thái khác mới nhất lên trước. */
export function sortApprovals<T extends Pick<ApprovalRequest, 'status' | 'createdAt'>>(
  items: readonly T[],
): T[] {
  return [...items].sort((a, b) =>
    a.status === 'pending' && b.status === 'pending'
      ? a.createdAt.localeCompare(b.createdAt)
      : b.createdAt.localeCompare(a.createdAt),
  );
}
