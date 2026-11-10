import type { DomainEvent, MilestoneKey } from '@claude-company/contracts';

/**
 * Quy tắc cột mốc (FR-045): hàm thuần, chỉ nhìn loại sự kiện và vài trường nghiệp vụ trong payload. Cố ý không có
 * cách nào đọc token, chi phí hay thời lượng run, nên không cột mốc nào có thể được cấp chỉ vì dùng nhiều token hay
 * chạy lâu (US8-AS2, Nguyên tắc I).
 */
export function milestoneKeyFor(event: Pick<DomainEvent, 'type' | 'payload'>): MilestoneKey | null {
  const p = event.payload as {
    kind?: string;
    fromTemplate?: boolean;
    from?: string;
    to?: string;
  };
  switch (event.type) {
    case 'employee.created':
      return 'first_employee';
    case 'org_unit.created':
      // Phòng ban do cơ cấu mẫu tự dựng lúc tạo công ty không phải việc người dùng đã làm.
      return p.kind === 'department' && p.fromTemplate !== true ? 'first_department' : null;
    case 'task.status_changed':
      // Task đầu tiên được người thật phê duyệt: rời `awaiting_human_approval` sang `completed`.
      return p.from === 'awaiting_human_approval' && p.to === 'completed'
        ? 'first_approved_task'
        : null;
    default:
      return null;
  }
}
