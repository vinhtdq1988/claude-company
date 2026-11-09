import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgChart, OrgChartNode } from '@claude-company/contracts';
import { createTestApp, type TestApp } from '../support/app';
import {
  prepareDatabase,
  seedDatabase,
  startInfra,
  type StartedInfra,
} from '../support/containers';
import { registerUser, type TestSession } from '../support/factories';

const flatten = (nodes: OrgChartNode[]): OrgChartNode[] =>
  nodes.flatMap((n) => [n, ...flatten(n.children)]);

describe('Phạm vi quản lý của Organization (T049; US1-AS3, FR-005, FR-028)', () => {
  let infra: StartedInfra;
  let t: TestApp;
  let ceo: TestSession;
  let manager: TestSession;
  let idleManager: TestSession;
  let companyId: string;
  let managerMemberId: string;
  const ids: Record<string, string> = {};
  let mobileTeamId: string;
  let baTeamId: string;

  const base = () => `/companies/${companyId}`;
  const chartOf = async (s: TestSession) => (await s.get(`${base()}/org-chart`)).body as OrgChart;

  beforeAll(async () => {
    infra = await startInfra({ postgres: true, redis: true });
    await prepareDatabase(infra);
    await seedDatabase(infra);
    t = await createTestApp({ infra });

    ceo = await registerUser(t, { displayName: 'CEO' });
    manager = await registerUser(t, { displayName: 'Manager Dev' });
    idleManager = await registerUser(t, { displayName: 'Manager chưa gán' });

    const created = await ceo.post('/companies', {
      name: 'Công ty phạm vi',
      templateKey: 'software_company',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    companyId = created.body.id as string;

    for (const node of flatten((await chartOf(ceo)).roots)) ids[node.name] = node.id;

    for (const [session, title] of [
      [manager, 'Manager Dev'],
      [idleManager, 'Manager chưa gán'],
    ] as const) {
      const added = await ceo.post(`${base()}/members`, {
        email: session.email,
        role: 'manager',
        title,
      });
      expect(added.status, JSON.stringify(added.body)).toBe(201);
    }
    const members = await ceo.get(`${base()}/members`);
    managerMemberId = (members.body as Array<{ id: string; userId: string }>).find(
      (m) => m.userId === manager.userId,
    )!.id;

    const assigned = await ceo.put(`${base()}/management-assignments`, {
      targetKind: 'org_unit',
      targetId: ids.Development,
      managerMemberId,
    });
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(204);

    mobileTeamId = (
      await ceo.post(`${base()}/teams`, { orgUnitId: ids.Development, name: 'Mobile' })
    ).body.id as string;
    baTeamId = (await ceo.post(`${base()}/teams`, { orgUnitId: ids.BA, name: 'Analysis' })).body
      .id as string;
  });

  afterAll(async () => {
    await t?.close();
    await infra?.stop();
  });

  describe('xem', () => {
    it('manager chỉ thấy đơn vị được gán (và team của nó), không thấy phòng ban khác', async () => {
      const chart = await chartOf(manager);
      const names = flatten(chart.roots).map((n) => n.name);
      expect(names).toEqual(['Development']);
      expect(chart.roots[0]?.teams.map((x) => x.name)).toEqual(['Mobile']);
      expect(chart.roots[0]?.managerMemberId).toBe(managerMemberId);
    });

    it('CEO có phạm vi toàn công ty: thấy mọi đơn vị và team', async () => {
      const names = flatten((await chartOf(ceo)).roots).map((n) => n.name);
      expect(names).toEqual(expect.arrayContaining(['Development', 'BA', 'QA']));
      const teams = flatten((await chartOf(ceo)).roots).flatMap((n) => n.teams.map((x) => x.name));
      expect(teams.sort()).toEqual(['Analysis', 'Mobile']);
    });

    it('manager chưa được gán đơn vị nào thấy sơ đồ trống nhưng vẫn đọc được thông tin công ty', async () => {
      expect((await chartOf(idleManager)).roots).toEqual([]);
      expect((await idleManager.get(base())).status).toBe(200);
    });
  });

  describe('thao tác trong phạm vi', () => {
    it('manager đổi tên đơn vị mình quản lý và tạo team trong đó', async () => {
      const renamed = await manager.patch(`${base()}/org-units/${ids.Development}`, {
        name: 'Dev Team',
      });
      expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
      const team = await manager.post(`${base()}/teams`, {
        orgUnitId: ids.Development,
        name: 'Web',
      });
      expect(team.status, JSON.stringify(team.body)).toBe(201);
      const setMembers = await manager.put(`${base()}/teams/${team.body.id}/members`, {
        members: [{ kind: 'human', id: managerMemberId }],
      });
      expect(setMembers.status).toBe(204);
    });
  });

  describe('thao tác ngoài phạm vi → 403', () => {
    it('sửa hoặc xóa phòng ban khác', async () => {
      const patch = await manager.patch(`${base()}/org-units/${ids.BA}`, { name: 'Chiếm quyền' });
      expect(patch.status).toBe(403);
      expect(patch.body.error.code).toBe('FORBIDDEN');
      expect((await manager.delete(`${base()}/org-units/${ids.QA}`)).status).toBe(403);
      expect(flatten((await chartOf(ceo)).roots).map((n) => n.name)).toEqual(
        expect.arrayContaining(['BA', 'QA']),
      );
    });

    it('thêm team vào phòng ban khác, sửa/xóa/đổi thành viên team khác', async () => {
      expect(
        (await manager.post(`${base()}/teams`, { orgUnitId: ids.BA, name: 'Lén' })).status,
      ).toBe(403);
      expect((await manager.patch(`${base()}/teams/${baTeamId}`, { name: 'Đổi tên' })).status).toBe(
        403,
      );
      expect((await manager.delete(`${base()}/teams/${baTeamId}`)).status).toBe(403);
      expect(
        (
          await manager.put(`${base()}/teams/${baTeamId}/members`, {
            members: [{ kind: 'human', id: managerMemberId }],
          })
        ).status,
      ).toBe(403);
    });

    it('tạo đơn vị cấp công ty (không có parent) là việc của CEO', async () => {
      const res = await manager.post(`${base()}/org-units`, { kind: 'department', name: 'Mới' });
      expect(res.status).toBe(403);
    });

    it('không thoát phạm vi bằng cách chuyển đơn vị/team sang chỗ khác', async () => {
      // Đưa đơn vị của mình lên cấp công ty (parent = null) cần quyền cấp công ty.
      const toRoot = await manager.patch(`${base()}/org-units/${ids.Development}`, {
        parentId: null,
      });
      expect(toRoot.status).toBe(403);
      // Chuyển team của mình sang phòng ban ngoài phạm vi.
      const moveTeam = await manager.patch(`${base()}/teams/${mobileTeamId}`, {
        orgUnitId: ids.BA,
      });
      expect(moveTeam.status).toBe(403);
      // Đích nhận cũng phải trong phạm vi: kéo team của phòng ban khác về phòng ban mình.
      const pullTeam = await manager.patch(`${base()}/teams/${baTeamId}`, {
        orgUnitId: ids.Development,
      });
      expect(pullTeam.status).toBe(403);
    });

    it('gán manager chỉ dành cho CEO, kể cả với đơn vị của chính mình', async () => {
      for (const targetId of [ids.Development, ids.BA]) {
        const res = await manager.put(`${base()}/management-assignments`, {
          targetKind: 'org_unit',
          targetId,
          managerMemberId,
        });
        expect(res.status).toBe(403);
      }
    });

    it('manager chưa được gán mọi thao tác ghi đều 403', async () => {
      const writes = [
        idleManager.patch(`${base()}/org-units/${ids.Development}`, { name: 'X' }),
        idleManager.post(`${base()}/teams`, { orgUnitId: ids.Development, name: 'X' }),
        idleManager.post(`${base()}/org-units`, { kind: 'department', name: 'X' }),
        idleManager.delete(`${base()}/org-units/${ids.BA}`),
      ];
      for (const res of await Promise.all(writes)) expect(res.status).toBe(403);
    });
  });

  describe('CEO', () => {
    it('thao tác được trên mọi đơn vị', async () => {
      expect(
        (await ceo.patch(`${base()}/org-units/${ids.BA}`, { name: 'Business Analysis' })).status,
      ).toBe(200);
      expect((await ceo.patch(`${base()}/teams/${baTeamId}`, { name: 'Phân tích' })).status).toBe(
        200,
      );
      expect(
        (await ceo.post(`${base()}/org-units`, { kind: 'division', name: 'Khối mới' })).status,
      ).toBe(201);
    });
  });

  describe('người ngoài công ty', () => {
    it('không phải thành viên → 404 với cả đọc lẫn ghi', async () => {
      const stranger = await registerUser(t);
      expect((await stranger.get(`${base()}/org-chart`)).status).toBe(404);
      expect((await stranger.patch(`${base()}/org-units/${ids.BA}`, { name: 'X' })).status).toBe(
        404,
      );
    });
  });
});
