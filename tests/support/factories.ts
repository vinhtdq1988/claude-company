import { randomUUID } from 'node:crypto';
import type { AuthSessionResponse, HumanRole } from '@claude-company/contracts';
import { newId, withTenant } from '@claude-company/db';
import { company } from '@claude-company/db/schema/organization';
import { humanMember } from '@claude-company/db/schema/employee';
import type { TestApp } from './app';

/** Phiên đã đăng nhập. Cookie `Secure` không được agent gửi lại qua HTTP nên gắn header thủ công. */
export interface TestSession {
  userId: string;
  email: string;
  cookie: string;
  csrfToken: string;
  get(path: string): ReturnType<TestApp['http']['get']>;
  post(path: string, body?: object): ReturnType<TestApp['http']['post']>;
  put(path: string, body?: object): ReturnType<TestApp['http']['put']>;
  patch(path: string, body?: object): ReturnType<TestApp['http']['patch']>;
  delete(path: string): ReturnType<TestApp['http']['delete']>;
  /** POST không gắn CSRF, để kiểm tra bị từ chối. */
  postWithoutCsrf(path: string, body?: object): ReturnType<TestApp['http']['post']>;
}

export function uniqueEmail(prefix = 'user'): string {
  return `${prefix}-${randomUUID().slice(0, 8)}@example.com`;
}

export function sessionCookie(setCookie: string[] | string | undefined): string {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const sid = list.find((c) => c.startsWith('cc_sid='));
  if (!sid) throw new Error('Response không có cookie cc_sid');
  return sid.split(';')[0] ?? '';
}

function toSession(
  t: TestApp,
  email: string,
  cookie: string,
  body: AuthSessionResponse,
): TestSession {
  return {
    userId: body.user.id,
    email,
    cookie,
    csrfToken: body.csrfToken,
    get: (path) => t.http.get(t.url(path)).set('Cookie', cookie),
    post: (path, payload) =>
      t.http
        .post(t.url(path))
        .set('Cookie', cookie)
        .set('X-CSRF-Token', body.csrfToken)
        .send(payload ?? {}),
    put: (path, payload) =>
      t.http
        .put(t.url(path))
        .set('Cookie', cookie)
        .set('X-CSRF-Token', body.csrfToken)
        .send(payload ?? {}),
    patch: (path, payload) =>
      t.http
        .patch(t.url(path))
        .set('Cookie', cookie)
        .set('X-CSRF-Token', body.csrfToken)
        .send(payload ?? {}),
    delete: (path) =>
      t.http.delete(t.url(path)).set('Cookie', cookie).set('X-CSRF-Token', body.csrfToken),
    postWithoutCsrf: (path, payload) =>
      t.http
        .post(t.url(path))
        .set('Cookie', cookie)
        .send(payload ?? {}),
  };
}

export async function registerUser(
  t: TestApp,
  overrides: { email?: string; password?: string; displayName?: string } = {},
): Promise<TestSession> {
  const email = overrides.email ?? uniqueEmail();
  const res = await t.http.post(t.url('/auth/register')).send({
    email,
    password: overrides.password ?? 'mat-khau-manh-123',
    displayName: overrides.displayName ?? 'Người dùng',
  });
  if (res.status !== 201)
    throw new Error(`register lỗi ${res.status}: ${JSON.stringify(res.body)}`);
  return toSession(
    t,
    email,
    sessionCookie(res.headers['set-cookie']),
    res.body as AuthSessionResponse,
  );
}

export async function loginUser(
  t: TestApp,
  email: string,
  password = 'mat-khau-manh-123',
): Promise<TestSession> {
  const res = await t.http.post(t.url('/auth/login')).send({ email, password });
  if (res.status !== 200) throw new Error(`login lỗi ${res.status}: ${JSON.stringify(res.body)}`);
  return toSession(
    t,
    email,
    sessionCookie(res.headers['set-cookie']),
    res.body as AuthSessionResponse,
  );
}

/** Tạo company cùng CEO trực tiếp dưới RLS (OrganizationEngine.createCompany chưa có ở Phase 2). */
export async function createCompanyWithCeo(
  t: TestApp,
  ceo: Pick<TestSession, 'userId'>,
  name = 'Công ty thử nghiệm',
): Promise<{ companyId: string; ceoMemberId: string }> {
  const companyId = newId();
  const ceoMemberId = newId();
  await withTenant(
    companyId,
    async (tx) => {
      await tx.insert(company).values({ id: companyId, name });
      await tx
        .insert(humanMember)
        .values({ id: ceoMemberId, companyId, userId: ceo.userId, role: 'ceo' });
    },
    { database: t.database, userId: ceo.userId },
  );
  return { companyId, ceoMemberId };
}

export async function addMember(
  t: TestApp,
  companyId: string,
  user: Pick<TestSession, 'userId'>,
  role: HumanRole = 'manager',
): Promise<string> {
  const memberId = newId();
  await withTenant(
    companyId,
    (tx) => tx.insert(humanMember).values({ id: memberId, companyId, userId: user.userId, role }),
    { database: t.database },
  );
  return memberId;
}
