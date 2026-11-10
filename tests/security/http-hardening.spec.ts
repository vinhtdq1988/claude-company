import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_CSP } from '../../apps/api/src/platform/http/security';
import { createTestApp, type TestApp } from '../support/app';
import {
  prepareDatabase,
  seedDatabase,
  startInfra,
  type StartedInfra,
} from '../support/containers';
import { registerUser } from '../support/factories';

const MAX = 3;

/**
 * Cứng hóa HTTP (T193, T192): header bảo mật và CSP trên mọi phản hồi, giới hạn tần suất đăng nhập, và tài liệu
 * OpenAPI ở `/api/v1/docs` (không phải production). Chạy với Redis giả nên chỉ cần PostgreSQL.
 */
describe('Cứng hóa HTTP (T192, T193)', () => {
  let infra: StartedInfra;
  let t: TestApp;

  beforeAll(async () => {
    infra = await startInfra({ redis: false });
    await prepareDatabase(infra);
    await seedDatabase(infra);
    t = await createTestApp({
      infra,
      inMemory: true,
      env: {
        LOGIN_RATE_LIMIT_MAX: String(MAX),
        LOGIN_RATE_LIMIT_WINDOW_MS: '600000',
        TRUST_PROXY: 'true',
      },
    });
  });

  afterAll(async () => {
    await t?.close();
    await infra?.stop();
  });

  const login = (email: string, ip: string) =>
    t.http
      .post(t.url('/auth/login'))
      .set('X-Forwarded-For', ip)
      .send({ email, password: 'sai-mat-khau-12345' });

  it('mọi phản hồi (kể cả lỗi 401) mang header bảo mật, CSP chặt và không lộ X-Powered-By', async () => {
    const res = await t.http.get(t.url('/auth/me'));
    expect(res.status).toBe(401);
    expect(res.headers['content-security-policy']).toBe(API_CSP);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  describe('giới hạn tần suất đăng nhập', () => {
    it('vượt quá hạn mức cho cùng (IP, email) → 429 RATE_LIMITED kèm Retry-After', async () => {
      const user = await registerUser(t, { displayName: 'Người dùng thật' });
      for (let i = 0; i < MAX; i += 1) {
        expect((await login(user.email, '10.0.0.1')).status).toBe(401);
      }
      const blocked = await login(user.email, '10.0.0.1');
      expect(blocked.status).toBe(429);
      expect(blocked.body.error.code).toBe('RATE_LIMITED');
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    });

    it('IP khác vẫn đăng nhập được: người ngoài không khóa được tài khoản của người khác', async () => {
      const user = await registerUser(t, { displayName: 'Nạn nhân' });
      for (let i = 0; i < MAX + 2; i += 1) await login(user.email, '10.0.0.2');
      expect((await login(user.email, '10.0.0.2')).status).toBe(429);
      expect((await login(user.email, '10.0.0.3')).status).toBe(401); // sai mật khẩu nhưng không bị chặn
    });
  });

  describe('tài liệu OpenAPI', () => {
    it('/api/v1/docs là HTML tự chứa, /api/v1/docs/openapi.json là OpenAPI 3.1 hợp lệ; không cần đăng nhập', async () => {
      const page = await t.http.get(t.url('/docs'));
      expect(page.status).toBe(200);
      expect(page.headers['content-type']).toContain('text/html');
      expect(page.text).toContain('/api/v1/auth/login');

      const spec = await t.http.get(t.url('/docs/openapi.json'));
      expect(spec.status).toBe(200);
      expect(spec.body.openapi).toBe('3.1.0');
      expect(Object.keys(spec.body.paths)).toContain('/companies/{companyId}/runs/{id}');
    });
  });
});
