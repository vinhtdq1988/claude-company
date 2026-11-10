import { describe, expect, it } from 'vitest';
import { payloadHashOf, stableStringify, summarizeAction } from '../src';

describe('payloadHashOf', () => {
  it('không phụ thuộc thứ tự khóa và bỏ qua giá trị undefined', () => {
    expect(payloadHashOf({ a: 1, b: { c: 2, d: 3 } })).toBe(
      payloadHashOf({ b: { d: 3, c: 2 }, a: 1, x: undefined }),
    );
  });

  it('đổi nội dung thì đổi hash', () => {
    expect(payloadHashOf({ to: ['a@x.vn'] })).not.toBe(payloadHashOf({ to: ['b@x.vn'] }));
  });

  it('stableStringify giữ thứ tự mảng', () => {
    expect(stableStringify([2, 1])).toBe('[2,1]');
  });
});

describe('summarizeAction', () => {
  it('email nêu đủ người nhận và tiêu đề', () => {
    const text = summarizeAction('email.send', {
      to: ['a@x.vn', 'b@x.vn'],
      subject: 'Báo cáo',
      body: 'x',
    });
    expect(text).toContain('a@x.vn, b@x.vn');
    expect(text).toContain('Báo cáo');
  });

  it('cắt bớt nội dung quá dài và không bao giờ ném lỗi với payload lạ', () => {
    expect(summarizeAction('data.delete', { target: 'x'.repeat(500) }).length).toBeLessThan(260);
    expect(summarizeAction('deploy.production', null)).toContain('production');
    expect(summarizeAction('lạ.hoắc', 42)).toContain('lạ.hoắc');
  });
});
