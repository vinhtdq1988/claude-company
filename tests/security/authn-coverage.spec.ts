import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../support/app';
import { prepareDatabase, startInfra, type StartedInfra } from '../support/containers';
import {
  addMember,
  createCompanyWithCeo,
  registerUser,
  type TestSession,
} from '../support/factories';
import { COMPANY_WIDE, FakeOrganizationEngine } from '../support/fake-engines';
import { fillPath, listRoutes, type RouteInfo } from '../support/routes';

const PUBLIC_ROUTES = new Set(['POST /api/v1/auth/register', 'POST /api/v1/auth/login']);
const key = (r: RouteInfo) => `${r.method} ${r.path}`;
const COMPANY_PREFIX = '/api/v1/companies/:companyId';

describe('Phủ xác thực, CSRF, tenant và scope (T028; FR-028, FR-030)', () => {
  let infra: StartedInfra;
  let t: TestApp;
  const org = new FakeOrganizationEngine();
  let routes: RouteInfo[];
  let ceo: TestSession;
  let manager: TestSession;
  let outsider: TestSession;
  let companyId: string;
  let managerId: string;
  const unitIn = '0197a000-0000-7000-8000-0000000000a1';
  const unitOut = '0197a000-0000-7000-8000-0000000000a2';

  beforeAll(async () => {
    infra = await startInfra({ postgres: true, redis: true });
    await prepareDatabase(infra);
    t = await createTestApp({ infra, overrides: { organization: org } });
    routes = listRoutes(t.app);

    ceo = await registerUser(t);
    manager = await registerUser(t);
    outsider = await registerUser(t);
    const created = await createCompanyWithCeo(t, ceo);
    companyId = created.companyId;
    managerId = await addMember(t, companyId, manager, 'manager');
    org.setScope(created.ceoMemberId, COMPANY_WIDE);
    org.setScope(managerId, {
      companyWide: false,
      orgUnitIds: [unitIn],
      teamIds: [],
      employeeIds: [],
    });
  });

  afterAll(async () => {
    await t?.close();
    await infra?.stop();
  });

  it('liệt kê được route (gồm auth và route thử)', () => {
    const keys = routes.map(key);
    expect(keys).toContain('POST /api/v1/auth/login');
    expect(keys).toContain('GET /api/v1/auth/me');
    expect(keys.some((k) => k.includes('/_probe/'))).toBe(true);
  });

  it('mọi route trừ /auth/register, /auth/login trả 401 khi chưa đăng nhập', async () => {
    const protectedRoutes = routes.filter((r) => !PUBLIC_ROUTES.has(key(r)));
    expect(protectedRoutes.length).toBeGreaterThan(0);
    for (const r of protectedRoutes) {
      const res = await t.http[r.method.toLowerCase() as 'get'](fillPath(r.path, { companyId }));
      expect(res.status, key(r)).toBe(401);
    }
  });

  it('mọi request ghi thiếu X-CSRF-Token bị từ chối, trừ /auth/register, /auth/login', async () => {
    const writes = routes.filter(
      (r) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method) && !PUBLIC_ROUTES.has(key(r)),
    );
    expect(writes.length).toBeGreaterThan(0);
    for (const r of writes) {
      const res = await t.http[r.method.toLowerCase() as 'post'](fillPath(r.path, { companyId }))
        .set('Cookie', ceo.cookie)
        .send({});
      expect(res.status, key(r)).toBe(403);
      expect(res.body.error.code, key(r)).toBe('CSRF_INVALID');
    }
  });

  it('register và login không cần CSRF (chưa có session để cấp token)', async () => {
    const res = await t.http
      .post(t.url('/auth/login'))
      .send({ email: 'khong-ton-tai@example.com', password: 'x' });
    expect(res.status).toBe(401); // sai thông tin chứ không phải 403 CSRF
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('không phải thành viên gọi /companies/{cid}/... nhận 404 (không lộ công ty tồn tại)', async () => {
    const companyRoutes = routes.filter((r) => r.path.startsWith(COMPANY_PREFIX));
    expect(companyRoutes.length).toBeGreaterThan(0);
    for (const r of companyRoutes) {
      const path = fillPath(r.path, { companyId });
      const res =
        r.method === 'GET'
          ? await outsider.get(path.replace('/api/v1', ''))
          : await outsider.post(path.replace('/api/v1', ''), {});
      expect(res.status, key(r)).toBe(404);
    }
    const bogus = await ceo.get('/companies/khong-phai-uuid/_probe/member');
    expect(bogus.status).toBe(404);
  });

  it('mọi route dưới /companies/{cid} có metadata @RequireScope hoặc @MemberScope', () => {
    const missing = routes
      .filter((r) => r.path.startsWith(COMPANY_PREFIX) && !r.hasScopeMetadata)
      .map((r) => `${key(r)} (${r.controller}.${r.handler})`);
    expect(missing).toEqual([]);
  });

  it('thành viên trong phạm vi → 2xx; ngoài phạm vi → 403; CEO có phạm vi toàn công ty', async () => {
    const inScope = await manager.get(`/companies/${companyId}/_probe/units/${unitIn}`);
    expect(inScope.status).toBe(200);

    const outScope = await manager.get(`/companies/${companyId}/_probe/units/${unitOut}`);
    expect(outScope.status).toBe(403);
    expect(outScope.body.error.code).toBe('FORBIDDEN');

    expect((await ceo.get(`/companies/${companyId}/_probe/units/${unitOut}`)).status).toBe(200);
  });

  it('route chỉ cần là thành viên cho phép cả manager lẫn CEO', async () => {
    expect((await manager.get(`/companies/${companyId}/_probe/member`)).status).toBe(200);
    expect((await ceo.post(`/companies/${companyId}/_probe/write`)).status).toBe(201);
  });

  it('ScopeGuard nhận RequestContext và truy vấn dưới RLS đúng công ty', async () => {
    const res = await manager.get(`/companies/${companyId}/_probe/data`);
    expect(res.status).toBe(200);
    expect(res.body.visibleMembers).toBe(2); // CEO + manager của công ty này, không thấy công ty khác

    const other = await createCompanyWithCeo(t, outsider, 'Công ty khác');
    const otherRes = await outsider.get(`/companies/${other.companyId}/_probe/data`);
    expect(otherRes.body.visibleMembers).toBe(1);
  });
});
