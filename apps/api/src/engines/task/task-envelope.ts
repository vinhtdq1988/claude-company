import type { DomainEvent } from '@claude-company/contracts';
import type { EnvelopeSpec } from '../../platform/events/envelope-mapper';

type StatusPayload = {
  taskId: string;
  from?: string;
  to?: string;
  status?: string;
  assigneeKind: 'ai_employee' | 'team' | 'org_unit';
  assigneeId: string;
  isOverdue: boolean;
};

/**
 * Ánh xạ `task.*` → envelope realtime. Chỉ trường công khai (id, trạng thái, assignee) đi qua kênh công ty;
 * nội dung task, lý do chặn… client tải qua REST có kiểm tra quyền. Sự kiện khác → để registry thêm
 * `sync.seq_advanced` (D2).
 */
export function mapTaskEvent(event: DomainEvent): EnvelopeSpec[] {
  if (event.type === 'task.status_changed' || event.type === 'task.overdue') {
    const p = event.payload as StatusPayload;
    const status = p.to ?? p.status ?? '';
    return [
      {
        room: 'company',
        type: 'task.status_changed',
        payload: {
          taskId: p.taskId,
          from: p.from ?? status,
          to: status,
          assigneeKind: p.assigneeKind,
          assigneeId: p.assigneeId,
          isOverdue: p.isOverdue,
        },
        visibility: { kind: 'assignee', assigneeKind: p.assigneeKind, assigneeId: p.assigneeId },
      },
    ];
  }
  if (event.type === 'task.progress') {
    const p = event.payload as { taskId: string; employeeId: string; progress: number };
    return [
      {
        room: 'company',
        type: 'task.progress',
        payload: { taskId: p.taskId, employeeId: p.employeeId, progress: p.progress },
        visibility: { kind: 'employee', employeeId: p.employeeId },
      },
    ];
  }
  return [];
}
