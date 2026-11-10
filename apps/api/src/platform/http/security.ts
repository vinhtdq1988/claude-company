import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { DomainError } from '@claude-company/contracts';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AppConfig } from '../config/config';
import { CONFIG } from '../config/infra.providers';

/**
 * CSP của API: mọi phản hồi là JSON (hoặc trang tài liệu không có script/style), nên không cần tải tài nguyên nào
 * và không được nhúng vào khung.
 */
export const API_CSP =
  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/**
 * CSP của ứng dụng web (nginx thêm vào mọi phản hồi, `docker/nginx.conf`; test `security-http.spec.ts` kiểm hai bản
 * khớp nhau). Không có `unsafe-inline`/`unsafe-eval`: web không dùng style hay script nội tuyến. `blob:` cho texture
 * và worker của PixiJS.
 */
export const WEB_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** Header bảo mật cho mọi phản hồi của API. HSTS chỉ bật ở production (cookie `Secure` đã yêu cầu HTTPS). */
export function securityHeaders(options: { production: boolean }): RequestHandler {
  return (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Content-Security-Policy', API_CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    // Dữ liệu theo phiên và theo công ty không được lưu ở cache dùng chung.
    res.setHeader('Cache-Control', 'no-store');
    if (options.production) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  };
}

/** Bộ đếm cửa sổ cố định trong bộ nhớ, có chặn trên số khóa để kẻ tấn công không làm đầy bộ nhớ. */
export class FixedWindowLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 50_000,
  ) {}

  /** Ghi nhận một lần thử; `allowed = false` khi đã quá `max` trong cửa sổ hiện tại. */
  hit(key: string): { allowed: boolean; retryAfterMs: number } {
    const now = this.now();
    let entry = this.windows.get(key);
    if (!entry || entry.resetAt <= now) {
      this.makeRoom(now);
      entry = { count: 0, resetAt: now + this.windowMs };
      this.windows.set(key, entry);
    }
    entry.count += 1;
    return entry.count > this.max
      ? { allowed: false, retryAfterMs: Math.max(0, entry.resetAt - now) }
      : { allowed: true, retryAfterMs: 0 };
  }

  private makeRoom(now: number): void {
    if (this.windows.size < this.maxKeys) return;
    for (const [key, entry] of this.windows) if (entry.resetAt <= now) this.windows.delete(key);
    // Vẫn đầy: bỏ khóa cũ nhất (Map giữ thứ tự chèn).
    while (this.windows.size >= this.maxKeys) {
      const oldest = this.windows.keys().next().value;
      if (oldest === undefined) break;
      this.windows.delete(oldest);
    }
  }
}

const MAX_EMAIL_LENGTH = 254;

/**
 * Giới hạn tần suất đăng nhập và đăng ký (chống dò mật khẩu và tạo tài khoản hàng loạt). Hai lớp:
 * - mỗi cặp (IP, email) tối đa `LOGIN_RATE_LIMIT_MAX` lần mỗi cửa sổ: chặn dò mật khẩu một tài khoản;
 * - mỗi IP tối đa 5 lần mức trên, cho từng route: chặn dò nhiều tài khoản từ một nguồn.
 * Không khóa theo email riêng lẻ: người ngoài không thể khóa tài khoản của người khác từ IP khác. Bộ đếm nằm trong
 * bộ nhớ của từng instance API; chạy nhiều instance thì giới hạn thực tế nhân theo số instance.
 */
@Injectable()
export class AuthRateLimitGuard implements CanActivate {
  private readonly perAccount: FixedWindowLimiter;
  private readonly perIp: FixedWindowLimiter;

  constructor(@Inject(CONFIG) config: AppConfig) {
    this.perAccount = new FixedWindowLimiter(
      config.LOGIN_RATE_LIMIT_MAX,
      config.LOGIN_RATE_LIMIT_WINDOW_MS,
    );
    this.perIp = new FixedWindowLimiter(
      config.LOGIN_RATE_LIMIT_MAX * 5,
      config.LOGIN_RATE_LIMIT_WINDOW_MS,
    );
  }

  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const route = req.path.endsWith('/register') ? 'register' : 'login';
    const ip = req.ip ?? 'unknown';
    const email = String((req.body as { email?: unknown } | undefined)?.email ?? '')
      .trim()
      .toLowerCase()
      .slice(0, MAX_EMAIL_LENGTH);

    const results = [this.perIp.hit(`${route}|${ip}`)];
    if (route === 'login') results.push(this.perAccount.hit(`${ip}|${email}`));
    const blocked = results.find((r) => !r.allowed);
    if (!blocked) return true;

    const retryAfterSeconds = Math.max(1, Math.ceil(blocked.retryAfterMs / 1000));
    res.setHeader('Retry-After', String(retryAfterSeconds));
    throw new DomainError('RATE_LIMITED', 'Quá nhiều lần thử, hãy đợi rồi thử lại', {
      retryAfterSeconds,
    });
  }
}
