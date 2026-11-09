import { describe, expect, it } from 'vitest';
import { DomainError, TASK_ACTIONS, TASK_STATUSES, type TaskStatus } from '@claude-company/contracts';
import {
  applyTransition,
  listValidEdges,
  transitionOrThrow,
} from '../../src/engines/task/task-state-machine';

/** Cạnh hợp lệ theo FR-020a + D1; mọi cặp khác phải bị từ chối. */
const VALID: Record<string, TaskStatus> = {
  'draft:assign': 'assigned',
  'assigned:start': 'in_progress',
  'in_progress:submit': 'in_review',
  'in_review:pass': 'awaiting_human_approval',
  'awaiting_human_approval:approve': 'completed',
  'in_review:rework': 'in_progress',
  'awaiting_human_approval:rework': 'in_progress',
  'draft:block': 'blocked',
  'assigned:block': 'blocked',
  'in_progress:block': 'blocked',
  'in_review:block': 'blocked',
  'awaiting_human_approval:block': 'blocked',
  'draft:cancel': 'cancelled',
  'assigned:cancel': 'cancelled',
  'in_progress:cancel': 'cancelled',
  'in_review:cancel': 'cancelled',
  'awaiting_human_approval:cancel': 'cancelled',
  'blocked:cancel': 'cancelled',
  // `blocked:resume` kiểm riêng vì đích phụ thuộc blocked_from.
};

describe('máy trạng thái task (FR-020a + D1)', () => {
  it('duyệt toàn bộ cặp (trạng thái, action): chỉ các cạnh đã định nghĩa là hợp lệ', () => {
    for (const status of TASK_STATUSES) {
      for (const action of TASK_ACTIONS) {
        if (action === 'resume') continue;
        const result = applyTransition({ status, blockedFrom: null }, action);
        const expected = VALID[`${status}:${action}`];
        if (expected) {
          expect(result?.status, `${status} --${action}-->`).toBe(expected);
        } else {
          expect(result, `${status} --${action}--> phải bị từ chối`).toBeNull();
        }
      }
    }
  });

  it('trạng thái kết thúc không có cạnh đi ra', () => {
    for (const status of ['completed', 'cancelled'] as const) {
      for (const action of TASK_ACTIONS) {
        expect(applyTransition({ status, blockedFrom: null }, action)).toBeNull();
      }
    }
  });

  it('block lưu blocked_from, resume khôi phục đúng trạng thái trước đó', () => {
    for (const from of [
      'draft',
      'assigned',
      'in_progress',
      'in_review',
      'awaiting_human_approval',
    ] as const) {
      const blocked = applyTransition({ status: from, blockedFrom: null }, 'block');
      expect(blocked).toEqual({ status: 'blocked', blockedFrom: from });
      const resumed = applyTransition(blocked!, 'resume');
      expect(resumed).toEqual({ status: from, blockedFrom: null });
    }
  });

  it('D1: reject đi cạnh block nhưng blocked_from = in_progress', () => {
    const blocked = applyTransition(
      { status: 'awaiting_human_approval', blockedFrom: null },
      'block',
      { resumeTo: 'in_progress' },
    );
    expect(blocked).toEqual({ status: 'blocked', blockedFrom: 'in_progress' });
    expect(applyTransition(blocked!, 'resume')).toEqual({
      status: 'in_progress',
      blockedFrom: null,
    });
  });

  it('resume ngoài trạng thái blocked hoặc thiếu blocked_from bị từ chối', () => {
    for (const status of TASK_STATUSES) {
      if (status === 'blocked') continue;
      expect(applyTransition({ status, blockedFrom: null }, 'resume')).toBeNull();
    }
    expect(applyTransition({ status: 'blocked', blockedFrom: null }, 'resume')).toBeNull();
  });

  it('resumeTo không hợp lệ (trạng thái kết thúc hoặc blocked) bị từ chối', () => {
    const s = { status: 'in_progress', blockedFrom: null } as const;
    expect(applyTransition(s, 'block', { resumeTo: 'completed' })).toBeNull();
    expect(applyTransition(s, 'block', { resumeTo: 'blocked' })).toBeNull();
  });

  it('cancel từ blocked được phép và xóa blocked_from', () => {
    expect(applyTransition({ status: 'blocked', blockedFrom: 'in_review' }, 'cancel')).toEqual({
      status: 'cancelled',
      blockedFrom: null,
    });
  });

  it('transitionOrThrow ném TASK_INVALID_TRANSITION kèm trạng thái và action', () => {
    try {
      transitionOrThrow({ status: 'draft', blockedFrom: null }, 'approve');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe('TASK_INVALID_TRANSITION');
      expect((error as DomainError).httpStatus).toBe(409);
      expect((error as DomainError).details).toMatchObject({ from: 'draft', action: 'approve' });
    }
  });

  it('listValidEdges khớp bảng cạnh (cộng resume từ blocked)', () => {
    const edges = listValidEdges().map((e) => `${e.from}:${e.action}`);
    expect(new Set(edges)).toEqual(new Set([...Object.keys(VALID), 'blocked:resume']));
  });
});
