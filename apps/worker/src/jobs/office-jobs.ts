import type { OfficeSimulationEngine, RequestContext } from '@claude-company/contracts';

export type CompletedElapsedPayload = {
  companyId: string;
  taskId: string;
  employeeId: string;
  /** `seq` của sự kiện đưa nhân viên vào `completed`: chỉ đúng lần đó mới bị hết hạn. */
  sinceSeq: number;
  traceId?: string;
};

/**
 * Job `office.completed-elapsed` (T156): sau 60 giây, nếu nhân viên vẫn giữ đúng lần `completed` đó thì ghi
 * `domain_event` `office.completed_display_elapsed` để Office Simulation Engine đưa họ về `idle`. Trạng thái không bao
 * giờ đổi ngầm: mọi thay đổi đều có sự kiện nguồn (SC-006). Idempotent: chạy lại khi đã hết hạn thì không ghi gì thêm.
 */
export async function completeDisplayElapsed(
  job: CompletedElapsedPayload,
  deps: { office: Pick<OfficeSimulationEngine, 'completeDisplayElapsed'> },
): Promise<boolean> {
  const ctx: RequestContext = {
    companyId: job.companyId,
    actor: { kind: 'system' },
    traceId: job.traceId ?? `office-completed-${job.sinceSeq}`,
  };
  return deps.office.completeDisplayElapsed(ctx, {
    employeeId: job.employeeId,
    taskId: job.taskId,
    sinceSeq: job.sinceSeq,
  });
}
