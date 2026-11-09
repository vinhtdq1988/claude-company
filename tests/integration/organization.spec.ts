import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgChart, OrgChartNode } from '@claude-company/contracts';
import { newId } from '@claude-company/db';
import { HumanMemberService } from '../../apps/api/src/engines/employee/human-member.service';
import { createTestApp, type TestApp } from '../support/app';
import {
  prepareDatabase,
  seedDatabase,
  startInfra,
  type StartedInfra,
} from '../support/containers';
import { registerUser, type TestSession } from '../support/factories';
import {
  employeeEngineWithMembers,
  FakeEmployeeEngine,
  FakeTaskEngine,
  makeEmployeeProfile,
  makeTask,
} from '../support/fake-engines';

const flatten = (nodes: OrgChartNode[]): OrgChartNode[] =>
  nodes.flatMap((n) => [n, ...flatten(n.children)]);

describe('Integration: Organization (T048; US1-AS1, AS2, AS4)', () => {
  let infra: StartedInfra;
  let t: TestApp;
  const employees = new FakeEmployeeEngine();
  const tasks = new FakeTaskEngine();
  const members: { service?: HumanMemberService } = {};

  beforeAll(async () => {
    infra = await startInfra({ postgres: true, redis: true });
    await prepareDatabase(infra);
    await seedDatabase(infra);
    // Stub T041 trả rỗng nên các nhánh "còn nhân viên/task" dùng fake; phần human member vẫn là bản thật.
    t = await createTestApp({
      infra,
      overrides: {
        employee: employeeEngineWithMembers(employees, () => {
          if (!members.service) throw new Error('HumanMemberService chưa sẵn sàng');
          return members.service;
        }),
        task: tasks,
      },
    });
    members.service = t.app.get(HumanMemberService);
  });

  afterAll(async () => {
    await t?.close();
    await infra?.stop();
  });

  /** Đăng ký user mới rồi tạo công ty qua API. */
  async function setup(templateKey?: string) {
    const session = await registerUser(t);
    const res = await session.post('/companies', { name: 'Công ty ABC', templateKey });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const companyId = res.body.id as string;
    const chart = async () =>
      (await session.get(`/companies/${companyId}/org-chart`)).body as OrgChart;
    const unit = async (name: string) => {
      const found = flatten((await chart()).roots).find((n) => n.name === name);
      if (!found) throw new Error(`Không thấy đơn vị ${name}`);
      return found;
    };
    return { session, companyId, chart, unit };
  }

  const base = (companyId: string) => `/companies/${companyId}`;

  it('GET /org-templates liệt kê template software_company', async () => {
    const session = await registerUser(t);
    const res = await session.get('/org-templates');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: 'software_company' })]),
    );
  });

  describe('AS1: tạo công ty', () => {
    it('chọn template software_company → ba phòng ban Development, BA, QA, người tạo là CEO', async () => {
      const { session, companyId, chart } = await setup('software_company');

      expect((await chart()).roots.map((n) => n.name)).toEqual(['Development', 'BA', 'QA']);

      const me = await session.get('/auth/me');
      expect(me.body.memberships).toEqual([expect.objectContaining({ companyId, role: 'ceo' })]);
      const company = await session.get(base(companyId));
      expect(company.body).toMatchObject({ id: companyId, name: 'Công ty ABC' });
    });

    it('tự thiết kế (không template) → sơ đồ trống; tên rỗng hoặc template lạ bị từ chối', async () => {
      const { chart } = await setup();
      expect((await chart()).roots).toEqual([]);

      const session = await registerUser(t);
      expect((await session.post('/companies', { name: '   ' })).status).toBe(422);
      const unknown = await session.post('/companies', { name: 'X', templateKey: 'khong_co' });
      expect(unknown.status).toBe(422);
      expect(unknown.body.error.code).toBe('VALIDATION_FAILED');
      // Không để lại công ty nửa vời.
      expect((await session.get('/auth/me')).body.memberships).toEqual([]);
    });
  });

  describe('AS2: thêm, đổi tên, xóa', () => {
    it('thay đổi phản ánh ngay trong sơ đồ tổ chức', async () => {
      const { session, companyId, chart, unit } = await setup('software_company');
      const dev = await unit('Development');
      const qa = await unit('QA');
      const ba = await unit('BA');

      const renamed = await session.patch(`${base(companyId)}/org-units/${qa.id}`, {
        name: 'Quality',
      });
      expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);

      const team = await session.post(`${base(companyId)}/teams`, {
        orgUnitId: dev.id,
        name: 'Mobile',
      });
      expect(team.status, JSON.stringify(team.body)).toBe(201);

      const division = await session.post(`${base(companyId)}/org-units`, {
        kind: 'division',
        name: 'Back Office',
      });
      expect(division.status).toBe(201);
      const hr = await session.post(`${base(companyId)}/org-units`, {
        kind: 'department',
        parentId: division.body.id,
        name: 'HR',
      });
      expect(hr.status).toBe(201);

      expect((await session.delete(`${base(companyId)}/org-units/${ba.id}`)).status).toBe(204);

      const after = await chart();
      const names = flatten(after.roots).map((n) => n.name);
      expect(names).toEqual(
        expect.arrayContaining(['Development', 'Quality', 'Back Office', 'HR']),
      );
      expect(names).not.toContain('BA');
      expect(names).not.toContain('QA');
      expect((await unit('Development')).teams.map((x) => x.name)).toEqual(['Mobile']);
      expect((await unit('HR')).parentId).toBe(division.body.id);
    });

    it('sắp xếp lại bằng sortOrder và trùng tên trong cùng parent → 409', async () => {
      const { session, companyId, chart, unit } = await setup('software_company');
      const qa = await unit('QA');
      await session.patch(`${base(companyId)}/org-units/${qa.id}`, { sortOrder: 0 });
      const dev = await unit('Development');
      await session.patch(`${base(companyId)}/org-units/${dev.id}`, { sortOrder: 9 });
      expect((await chart()).roots.map((n) => n.name)[0]).toBe('QA');

      const dup = await session.post(`${base(companyId)}/org-units`, {
        kind: 'department',
        name: 'BA',
      });
      expect(dup.status).toBe(409);
      expect(dup.body.error.code).toBe('CONFLICT');
    });

    it('body sai (kind lạ, thiếu tên, parentId không phải UUID) → 422', async () => {
      const { session, companyId } = await setup();
      const bad = [
        { kind: 'team', name: 'X' },
        { kind: 'department' },
        { kind: 'department', name: 'X', parentId: 'abc' },
      ];
      for (const body of bad) {
        const res = await session.post(`${base(companyId)}/org-units`, body);
        expect(res.status, JSON.stringify(body)).toBe(422);
      }
    });
  });

  describe('AS4: chặn xóa khi còn nội dung', () => {
    it('division còn department con → 409 ORG_UNIT_NOT_EMPTY kèm danh sách', async () => {
      const { session, companyId } = await setup();
      const division = await session.post(`${base(companyId)}/org-units`, {
        kind: 'division',
        name: 'Engineering',
      });
      const child = await session.post(`${base(companyId)}/org-units`, {
        kind: 'department',
        parentId: division.body.id,
        name: 'Backend',
      });

      const res = await session.delete(`${base(companyId)}/org-units/${division.body.id}`);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('ORG_UNIT_NOT_EMPTY');
      expect(res.body.error.details.childUnits).toEqual([{ id: child.body.id, name: 'Backend' }]);
    });

    it('phòng ban còn nhân viên hoặc task đang chạy → 409 nêu rõ nhân viên/task', async () => {
      const { session, companyId, unit } = await setup('software_company');
      const dev = await unit('Development');
      const emp = makeEmployeeProfile({ id: newId(), name: 'An', homeOrgUnitId: dev.id });
      employees.add(emp);
      const task = makeTask({ id: newId(), title: 'Viết báo cáo rủi ro' });
      tasks.tasks = [task];
      try {
        const res = await session.delete(`${base(companyId)}/org-units/${dev.id}`);
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('ORG_UNIT_NOT_EMPTY');
        expect(res.body.error.details.employees).toEqual([{ id: emp.id, name: 'An' }]);
        expect(res.body.error.details.tasks).toEqual([{ id: task.id, title: task.title }]);
        // Đơn vị vẫn còn nguyên.
        expect((await unit('Development')).id).toBe(dev.id);
      } finally {
        employees.employees.clear();
        tasks.tasks = [];
      }
    });

    it('team còn thành viên → 409 TEAM_NOT_EMPTY; gỡ hết thành viên thì xóa được', async () => {
      const { session, companyId, unit } = await setup('software_company');
      const dev = await unit('Development');
      const team = await session.post(`${base(companyId)}/teams`, {
        orgUnitId: dev.id,
        name: 'Mobile',
      });
      const me = (await session.get('/auth/me')).body.memberships[0].memberId as string;
      const set = await session.put(`${base(companyId)}/teams/${team.body.id}/members`, {
        members: [{ kind: 'human', id: me }],
      });
      expect(set.status, JSON.stringify(set.body)).toBe(204);

      const blocked = await session.delete(`${base(companyId)}/teams/${team.body.id}`);
      expect(blocked.status).toBe(409);
      expect(blocked.body.error.code).toBe('TEAM_NOT_EMPTY');

      await session.put(`${base(companyId)}/teams/${team.body.id}/members`, { members: [] });
      expect((await session.delete(`${base(companyId)}/teams/${team.body.id}`)).status).toBe(204);
    });
  });

  describe('gán manager (FR-005)', () => {
    it('CEO gán người thật làm manager; sơ đồ hiển thị; manager không phải thành viên bị từ chối', async () => {
      const { session, companyId, unit } = await setup('software_company');
      const dev = await unit('Development');
      const ceoMember = (await session.get('/auth/me')).body.memberships[0].memberId as string;

      const ok = await session.put(`${base(companyId)}/management-assignments`, {
        targetKind: 'org_unit',
        targetId: dev.id,
        managerMemberId: ceoMember,
      });
      expect(ok.status, JSON.stringify(ok.body)).toBe(204);
      expect((await unit('Development')).managerMemberId).toBe(ceoMember);

      const bad = await session.put(`${base(companyId)}/management-assignments`, {
        targetKind: 'org_unit',
        targetId: dev.id,
        managerMemberId: newId(),
      });
      expect(bad.status).toBe(422);
      const wrongKind = await session.put(`${base(companyId)}/management-assignments`, {
        targetKind: 'company',
        targetId: dev.id,
        managerMemberId: ceoMember,
      });
      expect(wrongKind.status).toBe(422);
    });
  });

  describe('cô lập công ty', () => {
    it('người dùng khác không đọc hay sửa được cơ cấu của công ty này (404)', async () => {
      const { companyId, unit } = await setup('software_company');
      const dev = await unit('Development');
      const stranger: TestSession = await registerUser(t);
      expect((await stranger.get(`${base(companyId)}/org-chart`)).status).toBe(404);
      expect(
        (await stranger.patch(`${base(companyId)}/org-units/${dev.id}`, { name: 'Hack' })).status,
      ).toBe(404);
      expect((await stranger.delete(`${base(companyId)}/org-units/${dev.id}`)).status).toBe(404);
    });
  });
});
