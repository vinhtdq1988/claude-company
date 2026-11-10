import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { DomainError, ERROR_HTTP_STATUS } from '@claude-company/contracts';
import type { AppConfig } from '../../src/platform/config/config';
import {
  API_CSP,
  AuthRateLimitGuard,
  FixedWindowLimiter,
  WEB_CSP,
  securityHeaders,
} from '../../src/platform/http/security';

describe('FixedWindowLimiter', () => {
  it('cho phép tới max lần trong cửa sổ rồi chặn kèm thời gian chờ', () => {
    let now = 1_000;
    const limiter = new FixedWindowLimiter(3, 10_000, () => now);
    expect([1, 2, 3].map(() => limiter.hit('k').allowed)).toEqual([true, true, true]);
    now = 4_000;
    expect(limiter.hit('k')).toEqual({ allowed: false, retryAfterMs: 7_000 });
  });

  it('hết cửa sổ thì đếm lại từ đầu; khóa khác nhau độc lập', () => {
    let now = 0;
    const limiter = new FixedWindowLimiter(1, 1_000, () => now);
    expect(limiter.hit('a').allowed).toBe(true);
    expect(limiter.hit('a').allowed).toBe(false);
    expect(limiter.hit('b').allowed).toBe(true);
    now = 1_000;
    expect(limiter.hit('a').allowed).toBe(true);
  });

  it('chặn trên số khóa: tấn công bằng nhiều khóa ngẫu nhiên không làm đầy bộ nhớ', () => {
    const limiter = new FixedWindowLimiter(1, 60_000, () => 0, 100);
    for (let i = 0; i < 1_000; i += 1) limiter.hit(`ip-${i}`);
    const size = (limiter as unknown as { windows: Map<string, unknown> }).windows.size;
    expect(size).toBeLessThanOrEqual(100);
  });
});

describe('securityHeaders', () => {
  const run = (production: boolean) => {
    const headers = new Map<string, string>();
    const next = vi.fn();
    securityHeaders({ production })(
      {} as never,
      { setHeader: (k: string, v: string) => headers.set(k, v) } as never,
      next,
    );
    expect(next).toHaveBeenCalledOnce();
    return headers;
  };

  it('đặt CSP chặt, chống nhúng khung, chống đoán MIME và không cho cache dữ liệu theo phiên', () => {
    const headers = run(false);
    expect(headers.get('Content-Security-Policy')).toBe(API_CSP);
    expect(API_CSP).toContain("default-src 'none'");
    expect(API_CSP).toContain("frame-ancestors 'none'");
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(headers.get('X-Frame-Options')).toBe('DENY');
    expect(headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(headers.get('Cache-Control')).toBe('no-store');
    expect(headers.get('Permissions-Policy')).toContain('camera=()');
  });

  it('HSTS chỉ bật ở production', () => {
    expect(run(false).has('Strict-Transport-Security')).toBe(false);
    expect(run(true).get('Strict-Transport-Security')).toContain('max-age=31536000');
  });
});

describe('CSP của web', () => {
  it('không cho phép script hoặc style nội tuyến, eval hay nguồn ngoài', () => {
    expect(WEB_CSP).not.toMatch(/unsafe-inline|unsafe-eval/);
    expect(WEB_CSP).not.toMatch(/https?:|\*/);
    expect(WEB_CSP).toContain("script-src 'self'");
    expect(WEB_CSP).toContain("object-src 'none'");
    expect(WEB_CSP).toContain("frame-ancestors 'none'");
  });

  it('docker/nginx.conf dùng đúng WEB_CSP và các header bảo mật', () => {
    const conf = readFileSync(join(__dirname, '../../../../docker/nginx.conf'), 'utf8');
    expect(conf).toContain(`add_header Content-Security-Policy "${WEB_CSP}" always;`);
    for (const header of ['X-Content-Type-Options', 'X-Frame-Options', 'Referrer-Policy']) {
      expect(conf).toContain(`add_header ${header}`);
    }
  });

  it('nginx giữ nguyên đường dẫn /api/v1 và proxy Socket.IO ở /socket.io/', () => {
    const conf = readFileSync(join(__dirname, '../../../../docker/nginx.conf'), 'utf8');
    // `proxy_pass http://api:3000/` (có dấu / cuối) sẽ cắt tiền tố /api/ và làm mọi request API trả 404.
    expect(conf).toMatch(/location \/api\/ \{[^}]*proxy_pass http:\/\/api:3000;/s);
    expect(conf).toMatch(/location \/socket\.io\/ \{[^}]*proxy_pass http:\/\/api:3000;/s);
    expect(conf).toMatch(/location \/socket\.io\/ \{[^}]*Upgrade/s);
  });
});

describe('AuthRateLimitGuard', () => {
  const config = { LOGIN_RATE_LIMIT_MAX: 3, LOGIN_RATE_LIMIT_WINDOW_MS: 60_000 } as AppConfig;

  function context(path: string, ip: string, email?: string) {
    const headers = new Map<string, string>();
    const res = { setHeader: (k: string, v: string) => headers.set(k, v) };
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => ({ path, ip, body: email === undefined ? {} : { email } }),
        getResponse: () => res,
      }),
    } as unknown as ExecutionContext;
    return { ctx, headers };
  }

  const attempt = (guard: AuthRateLimitGuard, path: string, ip: string, email?: string) => {
    const { ctx, headers } = context(path, ip, email);
    try {
      return { allowed: guard.canActivate(ctx), headers };
    } catch (error) {
      return { allowed: false, error, headers };
    }
  };

  it('đăng nhập sai nhiều lần cho cùng (IP, email) bị chặn bằng 429 RATE_LIMITED kèm Retry-After', () => {
    const guard = new AuthRateLimitGuard(config);
    for (let i = 0; i < 3; i += 1) {
      expect(attempt(guard, '/api/v1/auth/login', '1.1.1.1', 'a@x.vn').allowed).toBe(true);
    }
    const blocked = attempt(guard, '/api/v1/auth/login', '1.1.1.1', 'a@x.vn');
    expect(blocked.allowed).toBe(false);
    expect(blocked.error).toBeInstanceOf(DomainError);
    expect((blocked.error as DomainError).code).toBe('RATE_LIMITED');
    expect((blocked.error as DomainError).httpStatus).toBe(429);
    expect(ERROR_HTTP_STATUS.RATE_LIMITED).toBe(429);
    expect(Number(blocked.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
  });

  it('email viết hoa/thường và khoảng trắng được coi là cùng một tài khoản', () => {
    const guard = new AuthRateLimitGuard(config);
    const variants = ['a@x.vn', ' A@X.VN ', 'a@x.vn'];
    for (const email of variants)
      expect(attempt(guard, '/auth/login', '1.1.1.1', email).allowed).toBe(true);
    expect(attempt(guard, '/auth/login', '1.1.1.1', 'A@x.vn').allowed).toBe(false);
  });

  it('người ngoài không khóa được tài khoản từ IP khác', () => {
    const guard = new AuthRateLimitGuard(config);
    for (let i = 0; i < 10; i += 1) attempt(guard, '/auth/login', '6.6.6.6', 'nan-nhan@x.vn');
    expect(attempt(guard, '/auth/login', '2.2.2.2', 'nan-nhan@x.vn').allowed).toBe(true);
  });

  it('một IP dò nhiều tài khoản bị chặn theo hạn mức theo IP (gấp 5 lần)', () => {
    const guard = new AuthRateLimitGuard(config);
    for (let i = 0; i < 15; i += 1) {
      expect(attempt(guard, '/auth/login', '3.3.3.3', `user${i}@x.vn`).allowed).toBe(true);
    }
    expect(attempt(guard, '/auth/login', '3.3.3.3', 'user99@x.vn').allowed).toBe(false);
    expect(attempt(guard, '/auth/login', '4.4.4.4', 'user99@x.vn').allowed).toBe(true);
  });

  it('đăng ký tính riêng, theo IP', () => {
    const guard = new AuthRateLimitGuard(config);
    for (let i = 0; i < 15; i += 1)
      expect(attempt(guard, '/auth/register', '5.5.5.5').allowed).toBe(true);
    expect(attempt(guard, '/auth/register', '5.5.5.5').allowed).toBe(false);
    expect(attempt(guard, '/auth/login', '5.5.5.5', 'a@x.vn').allowed).toBe(true);
  });
});
