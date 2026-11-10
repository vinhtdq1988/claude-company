import { describe, expect, it } from 'vitest';
import {
  actionLabelKey,
  canDecideApproval,
  formatPayload,
  normalizeReason,
  sortApprovals,
} from '../src/features/approvals/approval-model';
import { messages } from '../src/i18n/vi';

describe('approval-model', () => {
  it('chỉ yêu cầu pending mới quyết định được', () => {
    expect(canDecideApproval({ status: 'pending' })).toBe(true);
    for (const status of ['approved', 'rejected', 'cancelled'] as const) {
      expect(canDecideApproval({ status })).toBe(false);
    }
  });

  it('lý do bắt buộc: rỗng hoặc chỉ khoảng trắng không hợp lệ, có nội dung thì được cắt khoảng trắng', () => {
    expect(normalizeReason('')).toBeNull();
    expect(normalizeReason('   \n ')).toBeNull();
    expect(normalizeReason('  Đồng ý  ')).toBe('Đồng ý');
  });

  it('payload hiển thị là JSON văn bản thuần, giữ nguyên thẻ HTML như chuỗi (không bị diễn giải)', () => {
    const text = formatPayload({ to: ['a@x.vn'], body: '<img src=x onerror=alert(1)>' });
    expect(text).toContain('"body": "<img src=x onerror=alert(1)>"');
    expect(formatPayload(undefined)).toBe('undefined');
  });

  it('payload vòng tham chiếu không làm hỏng giao diện', () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(typeof formatPayload(loop)).toBe('string');
  });

  it('mọi action cần Human Approval đều có nhãn tiếng Việt; action lạ không có nhãn', () => {
    for (const action of [
      'email.send',
      'data.delete',
      'deploy.staging',
      'deploy.production',
      'workspace.git.push',
    ]) {
      const key = actionLabelKey(action);
      expect(key, action).not.toBeNull();
      expect(messages[key!]).toBeTruthy();
    }
    expect(actionLabelKey('network.fetch')).toBeNull();
  });

  it('sắp xếp: chờ duyệt lâu nhất lên trước, trạng thái khác mới nhất lên trước', () => {
    const pending = sortApprovals([
      { status: 'pending' as const, createdAt: '2026-11-10T10:00:00Z', id: 'b' },
      { status: 'pending' as const, createdAt: '2026-11-10T08:00:00Z', id: 'a' },
    ]);
    expect(pending.map((p) => p.id)).toEqual(['a', 'b']);
    const decided = sortApprovals([
      { status: 'approved' as const, createdAt: '2026-11-10T08:00:00Z', id: 'a' },
      { status: 'approved' as const, createdAt: '2026-11-10T10:00:00Z', id: 'b' },
    ]);
    expect(decided.map((p) => p.id)).toEqual(['b', 'a']);
  });
});
