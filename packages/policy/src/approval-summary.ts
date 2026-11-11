/** Tên hiển thị của các action cần Human Approval (v1.0). */
export const APPROVAL_ACTION_LABELS: Readonly<Record<string, string>> = {
  'email.send': 'Gửi email',
  'data.delete': 'Xóa dữ liệu',
  'deploy.staging': 'Deploy lên staging',
  'deploy.production': 'Deploy lên production',
  'workspace.git.push': 'Push lên remote',
  // Hành động điều hành của CEO AI Assistant (chạy qua InternalOpsAdapter sau khi duyệt).
  'org.archive': 'Lưu trữ đơn vị hoặc team',
  'employee.archive': 'Lưu trữ AI Employee',
  'task.cancel': 'Hủy task',
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

const text = (value: unknown, max = 200): string => {
  const s =
    typeof value === 'string'
      ? value
      : value === undefined || value === null
        ? ''
        : JSON.stringify(value);
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

/**
 * Tóm tắt "AI định làm gì" do HỆ THỐNG sinh từ payload đã chuẩn hóa, không lấy từ lời agent nên agent không thể
 * che giấu hành động thật bằng câu chữ (FR-026). Chỉ là văn bản thuần; nơi hiển thị không được render HTML.
 */
export function summarizeAction(actionType: string, payload: unknown): string {
  const p = asRecord(payload);
  switch (actionType) {
    case 'email.send': {
      const to = Array.isArray(p.to) ? p.to.map((v) => text(v, 80)).join(', ') : text(p.to);
      return `Gửi email tới ${to} với tiêu đề "${text(p.subject, 120)}"`;
    }
    case 'data.delete':
      return `Xóa dữ liệu: ${text(p.target)}`;
    case 'deploy.staging':
      return `Deploy "${text(p.ref, 100)}" lên staging`;
    case 'deploy.production':
      return `Deploy "${text(p.ref, 100)}" lên production`;
    case 'workspace.git.push':
      return `Push nhánh "${text(p.branch, 100)}" lên remote "${text(p.remote, 100)}"`;
    case 'org.archive':
      return `Lưu trữ ${p.targetKind === 'team' ? 'team' : 'đơn vị'} ${text(p.targetId, 80)}`;
    case 'employee.archive':
      return `Lưu trữ AI Employee ${text(p.employeeId, 80)}`;
    case 'task.cancel':
      return `Hủy task ${text(p.taskId, 80)}: ${text(p.reason, 160)}`;
    default:
      return `Thực hiện ${actionType}`;
  }
}
