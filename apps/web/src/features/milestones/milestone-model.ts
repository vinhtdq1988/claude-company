import { MILESTONE_KEYS, type Milestone, type MilestoneKey } from '@claude-company/contracts';
import type { MessageKey } from '../../i18n/vi';

type Labels = { title: MessageKey; how: MessageKey };

/** Nhãn Achievement. Tên `milestone` chỉ dùng trong code; giao diện gọi là Achievement. */
export const MILESTONE_LABELS: Readonly<Record<MilestoneKey, Labels>> = {
  first_employee: { title: 'milestone.first_employee', how: 'milestone.first_employee.how' },
  first_department: { title: 'milestone.first_department', how: 'milestone.first_department.how' },
  first_approved_task: {
    title: 'milestone.first_approved_task',
    how: 'milestone.first_approved_task.how',
  },
};

export type AchievementItem = {
  key: MilestoneKey;
  /** `null` khi chưa đạt: màn hình vẫn liệt kê để người dùng biết cách đạt. */
  achievedAt: string | null;
};

/** Mọi Achievement theo thứ tự cố định; những cái đã đạt mang thời điểm đạt. */
export function buildAchievements(
  earned: readonly Pick<Milestone, 'key' | 'achievedAt'>[],
): AchievementItem[] {
  const byKey = new Map(earned.map((m) => [m.key, m.achievedAt]));
  return MILESTONE_KEYS.map((key) => ({ key, achievedAt: byKey.get(key) ?? null }));
}

/** Khóa hợp lệ từ payload realtime (`milestone.achieved`); giá trị lạ bị bỏ qua thay vì hiển thị sai. */
export function milestoneKeyOf(payload: unknown): MilestoneKey | null {
  const key = (payload as { key?: unknown } | null)?.key;
  return typeof key === 'string' && (MILESTONE_KEYS as readonly string[]).includes(key)
    ? (key as MilestoneKey)
    : null;
}
