import { describe, expect, it } from 'vitest';
import { redact, redactString } from '../src/runtime/redact';

describe('redact', () => {
  it('che API key, bearer token, khóa AWS và token GitHub', () => {
    const text =
      'key sk-ant-api03-abcdefghij1234 Authorization: Bearer abc.def.ghi-123456 AKIAABCDEFGHIJKLMNOP ghp_abcdefghijklmnopqrstuvwxyz0123';
    const out = redactString(text);
    expect(out).not.toMatch(/sk-ant-api03/);
    expect(out).not.toMatch(/abc\.def\.ghi/);
    expect(out).not.toMatch(/AKIAABCDEFGHIJKLMNOP/);
    expect(out).not.toMatch(/ghp_abcdef/);
    expect(out).toContain('[REDACTED]');
  });

  it('che giá trị biến môi trường dạng NAME=value và credential trong URL', () => {
    expect(redactString('ANTHROPIC_API_KEY=sk-live-xyz DATABASE_PASSWORD="hunter2"')).toBe(
      'ANTHROPIC_API_KEY=[REDACTED] DATABASE_PASSWORD=[REDACTED]',
    );
    expect(redactString('postgres://app_user:secretpw@db:5432/x')).toBe(
      'postgres://[REDACTED]@db:5432/x',
    );
  });

  it('che khóa riêng PEM nhiều dòng', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----';
    expect(redactString(`a ${pem} b`)).toBe('a [REDACTED] b');
  });

  it('che sâu theo tên thuộc tính nhạy cảm và không đổi dữ liệu thường', () => {
    const out = redact({
      path: 'README.md',
      nested: { apiKey: 'abc', list: [{ password: 'x', ok: 1 }], note: 'Bearer abcdefgh12345' },
      n: 5,
      nothing: null,
    });
    expect(out).toEqual({
      path: 'README.md',
      nested: { apiKey: '[REDACTED]', list: [{ password: '[REDACTED]', ok: 1 }], note: 'Bearer [REDACTED]' },
      n: 5,
      nothing: null,
    });
  });
});
