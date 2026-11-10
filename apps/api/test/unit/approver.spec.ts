import { describe, expect, it } from 'vitest';
import { pickApprover } from '../../src/engines/permission/approver';

const member = (id: string, role: 'ceo' | 'manager', disabled = false) => ({
  id,
  role,
  disabledAt: disabled ? '2026-11-10T00:00:00Z' : null,
});

describe('pickApprover (FR-026)', () => {
  const members = [member('ceo', 'ceo'), member('mgr', 'manager')];

  it('người giao task còn hoạt động là người duyệt', () => {
    expect(pickApprover('mgr', members)).toBe('mgr');
  });

  it('người giao bị vô hiệu → chuyển cho CEO', () => {
    expect(pickApprover('mgr', [member('ceo', 'ceo'), member('mgr', 'manager', true)])).toBe('ceo');
  });

  it('không có người giao hoặc không còn trong công ty → CEO', () => {
    expect(pickApprover(null, members)).toBe('ceo');
    expect(pickApprover(undefined, members)).toBe('ceo');
    expect(pickApprover('khong-ton-tai', members)).toBe('ceo');
  });

  it('bỏ qua CEO bị vô hiệu, lấy CEO đang hoạt động', () => {
    expect(
      pickApprover(null, [
        member('ceo-cu', 'ceo', true),
        member('ceo-moi', 'ceo'),
        member('mgr', 'manager'),
      ]),
    ).toBe('ceo-moi');
  });

  it('không có CEO đang hoạt động → lỗi rõ ràng thay vì chọn bừa người không có thẩm quyền', () => {
    expect(() => pickApprover(null, [member('mgr', 'manager')])).toThrow(/CEO/);
    expect(() => pickApprover('mgr', [member('mgr', 'manager', true)])).toThrow(/CEO/);
  });
});
