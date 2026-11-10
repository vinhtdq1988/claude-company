import { describe, expect, it } from 'vitest';
import { MILESTONE_KEYS } from '@claude-company/contracts';
import { milestoneKeyFor } from '../../src/engines/gamification/milestone-rules';

const ev = (type: string, payload: Record<string, unknown> = {}) => ({ type, payload });

describe('milestoneKeyFor (T189, FR-045)', () => {
  it('employee.created → first_employee', () => {
    expect(milestoneKeyFor(ev('employee.created', { employeeId: 'e', kind: 'employee' }))).toBe(
      'first_employee',
    );
  });

  describe('org_unit.created', () => {
    it('department do người dùng tạo → first_department', () => {
      expect(milestoneKeyFor(ev('org_unit.created', { kind: 'department' }))).toBe(
        'first_department',
      );
    });

    it('department do cơ cấu mẫu dựng lúc tạo công ty không phải việc người dùng đã làm', () => {
      expect(
        milestoneKeyFor(ev('org_unit.created', { kind: 'department', fromTemplate: true })),
      ).toBeNull();
    });

    it('division không phải department', () => {
      expect(milestoneKeyFor(ev('org_unit.created', { kind: 'division' }))).toBeNull();
    });
  });

  describe('task.status_changed', () => {
    it('chỉ khi người thật phê duyệt (awaiting_human_approval → completed) mới là first_approved_task', () => {
      expect(
        milestoneKeyFor(
          ev('task.status_changed', { from: 'awaiting_human_approval', to: 'completed' }),
        ),
      ).toBe('first_approved_task');
    });

    it.each([
      ['in_progress', 'in_review'],
      ['in_review', 'awaiting_human_approval'],
      ['awaiting_human_approval', 'in_progress'],
      ['awaiting_human_approval', 'blocked'],
      ['in_progress', 'cancelled'],
      ['in_progress', 'completed'],
    ])('%s → %s không cấp cột mốc', (from, to) => {
      expect(milestoneKeyFor(ev('task.status_changed', { from, to }))).toBeNull();
    });
  });

  it('US8-AS2: sự kiện về token, chi phí, run hay thời lượng không bao giờ cấp cột mốc, dù số liệu rất lớn', () => {
    const heavy = {
      tokensDelta: 9_999_999_999,
      costDelta: 1e9,
      durationMs: 86_400_000,
      progress: 100,
    };
    for (const type of [
      'usage.updated',
      'run.queued',
      'run.started',
      'run.succeeded',
      'run.step_appended',
      'budget.policy_changed',
      'task.progress',
      'office.employee_status_changed',
      'milestone.achieved',
    ]) {
      expect(milestoneKeyFor(ev(type, heavy)), type).toBeNull();
    }
  });

  it('chỉ trả về các khóa cột mốc đã khai báo', () => {
    const produced = [
      milestoneKeyFor(ev('employee.created')),
      milestoneKeyFor(ev('org_unit.created', { kind: 'department' })),
      milestoneKeyFor(
        ev('task.status_changed', { from: 'awaiting_human_approval', to: 'completed' }),
      ),
    ];
    for (const key of produced) expect(MILESTONE_KEYS).toContain(key);
  });
});
