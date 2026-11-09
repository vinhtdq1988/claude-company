import type { TaskStats, TaskStatus } from '@claude-company/contracts';

export type StatsInput = {
  status: TaskStatus;
  deadline: Date;
  completedAt: Date | null;
  reworkCount: number;
};

/** Task đang hoạt động theo FR-040: khác `draft`, `completed`, `cancelled`. */
const NOT_ACTIVE: readonly TaskStatus[] = ['draft', 'completed', 'cancelled'];

/**
 * Thống kê theo data-model "Thống kê (FR-040)". `onTimeRate` = task `completed` có `completed_at ≤ deadline`
 * trên số task `completed` (0 khi chưa có task nào xong); `reworkRate` = tỷ lệ task `completed` đã qua ít nhất một vòng rework.
 * Caller quyết định tập task (task gốc cho Dashboard, mọi task của nhân viên cho `performance`).
 */
export function computeStats(tasks: readonly StatsInput[]): TaskStats {
  const completed = tasks.filter((t) => t.status === 'completed');
  const onTime = completed.filter(
    (t) => t.completedAt !== null && t.completedAt.getTime() <= t.deadline.getTime(),
  );
  const reworked = completed.filter((t) => t.reworkCount > 0);
  return {
    completedTasks: completed.length,
    onTimeRate: completed.length === 0 ? 0 : onTime.length / completed.length,
    reworkRate: completed.length === 0 ? 0 : reworked.length / completed.length,
    activeTasks: tasks.filter((t) => !NOT_ACTIVE.includes(t.status)).length,
  };
}
