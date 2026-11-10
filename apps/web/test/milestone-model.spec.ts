import { describe, expect, it } from 'vitest';
import { MILESTONE_KEYS } from '@claude-company/contracts';
import {
  MILESTONE_LABELS,
  buildAchievements,
  milestoneKeyOf,
} from '../src/features/milestones/milestone-model';
import { messages } from '../src/i18n/vi';

describe('milestone-model', () => {
  it('mọi cột mốc đều có tên và cách đạt bằng tiếng Việt', () => {
    expect(Object.keys(MILESTONE_LABELS).sort()).toEqual([...MILESTONE_KEYS].sort());
    for (const { title, how } of Object.values(MILESTONE_LABELS)) {
      expect(messages[title]).toBeTruthy();
      expect(messages[how]).toBeTruthy();
    }
  });

  it('buildAchievements liệt kê đủ ba Achievement theo thứ tự cố định, cái đã đạt mang thời điểm đạt', () => {
    expect(buildAchievements([])).toEqual([
      { key: 'first_employee', achievedAt: null },
      { key: 'first_department', achievedAt: null },
      { key: 'first_approved_task', achievedAt: null },
    ]);
    const items = buildAchievements([
      { key: 'first_approved_task', achievedAt: '2026-11-10T09:00:00.000Z' },
      { key: 'first_employee', achievedAt: '2026-11-09T09:00:00.000Z' },
    ]);
    expect(items.map((i) => i.key)).toEqual(MILESTONE_KEYS);
    expect(items.map((i) => i.achievedAt)).toEqual([
      '2026-11-09T09:00:00.000Z',
      null,
      '2026-11-10T09:00:00.000Z',
    ]);
  });

  it('milestoneKeyOf chỉ nhận khóa hợp lệ từ payload realtime', () => {
    expect(milestoneKeyOf({ key: 'first_employee' })).toBe('first_employee');
    expect(milestoneKeyOf({ key: 'xp_level_10' })).toBeNull();
    expect(milestoneKeyOf({ key: 42 })).toBeNull();
    expect(milestoneKeyOf(null)).toBeNull();
    expect(milestoneKeyOf(undefined)).toBeNull();
  });
});
