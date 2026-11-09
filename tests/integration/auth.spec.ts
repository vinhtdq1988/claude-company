import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../support/app';
import { prepareDatabase, startInfra, type StartedInfra } from '../support/containers';
import { createCompanyWithCeo, loginUser, registerUser, uniqueEmail } from '../support/factories';

describe('Xác thực (T029)', () => {
  let infra: StartedInfra;
  let t: TestApp;

  beforeAll(async () => {
    infra = await startInfra({ postgres: true, redis: true });
    await prepareDatabase(infra);
    t = await createTestApp({ infra });
  });

  afterAll(async () => {
    await t?.close();
    await infra?.stop();
  });

  it('đăng ký trả user + csrfToken và cookie cc_sid HttpOnly; Secure; SameSite=Lax', async () => {
    const email = uniqueEmail('reg');
    const res = await t.http
      .post(t.url('/auth/register'))
      .send({ email: email.toUpperCase(), password: 'mat-khau-manh-123', displayName: 'Vinh' });
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email, displayName: 'Vinh' }); // email được chuẩn hóa chữ thường
    expect(res.body.csrfToken).toBeTruthy();
    expect(res.body).not.toHaveProperty('password');

    const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('cc_sid='),
    );
    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
  });

  it('đăng ký trùng email → 409 EMAIL_TAKEN; thiếu trường → 422', async () => {
    const s = await registerUser(t);
    const dup = await t.http
      .post(t.url('/auth/register'))
      .send({ email: s.email, password: 'mat-khau-manh-123', displayName: 'X' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('EMAIL_TAKEN');

    const bad = await t.http
      .post(t.url('/auth/register'))
      .send({ email: 'khong-phai-email', password: '1' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('đăng nhập đúng và sai mật khẩu', async () => {
    const s = await registerUser(t);
    const ok = await t.http
      .post(t.url('/auth/login'))
      .send({ email: s.email, password: 'mat-khau-manh-123' });
    expect(ok.status).toBe(200);

    const wrong = await t.http
      .post(t.url('/auth/login'))
      .send({ email: s.email, password: 'sai-mat-khau' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');

    const unknown = await t.http
      .post(t.url('/auth/login'))
      .send({ email: uniqueEmail('none'), password: 'x' });
    expect(unknown.status).toBe(401);
    expect(unknown.body.error.code).toBe('INVALID_CREDENTIALS'); // không lộ email có tồn tại hay không
  });

  it('/auth/me trả user, membership và csrfToken', async () => {
    const s = await registerUser(t);
    const me0 = await s.get('/auth/me');
    expect(me0.status).toBe(200);
    expect(me0.body.memberships).toEqual([]);
    expect(me0.body.csrfToken).toBe(s.csrfToken);

    const { companyId, ceoMemberId } = await createCompanyWithCeo(t, s);
    const me1 = await s.get('/auth/me');
    expect(me1.body.user.email).toBe(s.email);
    expect(me1.body.memberships).toEqual([{ companyId, memberId: ceoMemberId, role: 'ceo' }]);
  });

  it('/auth/me không có session → 401', async () => {
    const res = await t.http.get(t.url('/auth/me'));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('đăng xuất thu hồi session; đăng nhập lại cấp session mới', async () => {
    const s = await registerUser(t);
    expect((await s.get('/auth/me')).status).toBe(200);

    const noCsrf = await s.postWithoutCsrf('/auth/logout');
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.error.code).toBe('CSRF_INVALID');
    expect((await s.get('/auth/me')).status).toBe(200); // chưa bị thu hồi vì CSRF sai

    const out = await s.post('/auth/logout');
    expect(out.status).toBe(204);
    expect((await s.get('/auth/me')).status).toBe(401); // cookie cũ không còn dùng được

    const again = await loginUser(t, s.email);
    expect(again.cookie).not.toBe(s.cookie);
    expect((await again.get('/auth/me')).status).toBe(200);
  });
});
