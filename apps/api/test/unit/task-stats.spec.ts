import { describe, expect, it } from 'vitest';
import { computeStats } from '../../src/engines/task/task-stats';

const day = (d: number) => new Date(2026, 10, d);

describe('computeStats', () => {
  it('không có task: mọi số liệu bằng 0', () => {
    expect(computeStats([])).toEqual({
      completedTasks: 0,
      onTimeRate: 0,
      reworkRate: 0,
      activeTasks: 0,
    });
  });

  it('đếm active, completed, đúng hạn và rework', () => {
    const stats = computeStats([
      { status: 'completed', deadline: day(10), completedAt: day(9), reworkCount: 0 },
      { status: 'completed', deadline: day(10), completedAt: day(12), reworkCount: 2 },
      { status: 'in_progress', deadline: day(10), completedAt: null, reworkCount: 0 },
      { status: 'blocked', deadline: day(10), completedAt: null, reworkCount: 1 },
      { status: 'draft', deadline: day(10), completedAt: null, reworkCount: 0 },
      { status: 'cancelled', deadline: day(10), completedAt: null, reworkCount: 0 },
    ]);
    expect(stats).toEqual({
      completedTasks: 2,
      onTimeRate: 0.5,
      reworkRate: 0.5,
      activeTasks: 2,
    });
  });
});
