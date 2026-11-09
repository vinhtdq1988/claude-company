import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EmployeeProfile } from '@claude-company/contracts';
import { createTestApp, type TestApp } from '../support/app';
import {
  prepareDatabase,
  seedDatabase,
  startInfra,
  type StartedInfra,
} from '../support/containers';
import { departmentIds, employeeBody, hireVia, memberIdOf } from '../support/employee-fixtures';
import { registerUser, type TestSession } from '../support/factories';

/** Phạm vi quản lý với AI Employee và các thao tác chỉ CEO (T063a; FR-005, FR-028, SC-012). */
describe('Phạm vi quản lý của Employee Engine (T063a)', () => {
  let infra: StartedInfra;
  let t: TestApp;
  let ceo: TestSession;
  let manager: TestSession;
  let outsider: TestSession;
  let companyId: string;
  let ceoMemberId: string;
  let managerMemberId: string;
  let units: Record<string, string>;
  let devEmployee: EmployeeProfile;
  let qaEmployee: EmployeeProfile;

  const base = () => `/companies/${companyId}`;

  beforeAll(async () => {
    infra = await startInfra({ postgres: true, redis: true });
    await prepareDatabase(infra);
    await seedDatabase(infra);
    t = await createTestApp({ infra });

    ceo = await registerUser(t, { displayName: 'CEO' });
    manager = await registerUser(t, { displayName: 'Manager Dev' });
    outsider = await registerUser(t, { displayName: 'Người ngoài' });

    const created = await ceo.post('/companies', {
      name: 'Công ty phạm vi nhân viên',
      templateKey: 'software_company',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    companyId = created.body.id as string;
    units = await departmentIds(ceo, companyId);
    ceoMemberId = await memberIdOf(ceo, companyId);

    const added = await ceo.post(`${base()}/members`, {
      email: manager.email,
      role: 'manager',
    });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    managerMemberId = added.body.id as string;
    const assigned = await ceo.put(`${base()}/management-assignments`, {
      targetKind: 'org_unit',
      targetId: units.Development,
      managerMemberId,
    });
    expect(assigned.status).toBe(204);

    const ceoRef = { kind: 'human', id: ceoMemberId } as const;
    devEmployee = await hireVia(
      ceo,
      companyId,
      employeeBody(units.Development!, ceoRef, { name: 'Dev trong phạm vi' }),
    );
    qaEmployee = await hireVia(
      ceo,
      companyId,
      employeeBody(units.QA!, ceoRef, { name: 'QA ngoài phạm vi' }),
    );
  });

  afterAll(async () => {
    await t?.close();
    await infra?.stop();
  });

  describe('xem', () => {
    it('danh sách chỉ trả nhân viên trong phạm vi; CEO thấy tất cả', async () => {
      const mine = await manager.get(`${base()}/employees`);
      expect(mine.status).toBe(200);
      expect((mine.body as EmployeeProfile[]).map((e) => e.name)).toEqual(['Dev trong phạm vi']);

      const all = await ceo.get(`${base()}/employees`);
      expect((all.body as EmployeeProfile[]).map((e) => e.name).sort()).toEqual([
        'Dev trong phạm vi',
        'QA ngoài phạm vi',
      ]);
    });

    it('bộ lọc theo đơn vị ngoài phạm vi không làm lộ nhân viên', async () => {
      const res = await manager.get(`${base()}/employees?orgUnitId=${units.QA}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('xem hồ sơ: trong phạm vi 200, ngoài phạm vi 403', async () => {
      expect((await manager.get(`${base()}/employees/${devEmployee.id}`)).status).toBe(200);
      const denied = await manager.get(`${base()}/employees/${qaEmployee.id}`);
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe('FORBIDDEN');
    });
  });

  describe('thao tác trên nhân viên ngoài phạm vi', () => {
    it('sửa, suspend, resume, archive đều bị 403 và dữ liệu không đổi', async () => {
      const id = qaEmployee.id;
      expect((await manager.patch(`${base()}/employees/${id}`, { name: 'Bị đổi' })).status).toBe(
        403,
      );
      expect((await manager.post(`${base()}/employees/${id}/suspend`)).status).toBe(403);
      expect((await manager.post(`${base()}/employees/${id}/resume`)).status).toBe(403);
      expect((await manager.delete(`${base()}/employees/${id}`)).status).toBe(403);

      const reload = await ceo.get(`${base()}/employees/${id}`);
      expect(reload.body).toMatchObject({ name: 'QA ngoài phạm vi', status: 'active' });
    });

    it('tạo nhân viên vào đơn vị ngoài phạm vi bị 403; vào đơn vị trong phạm vi được', async () => {
      const ceoRef = { kind: 'human', id: ceoMemberId } as const;
      const denied = await manager.post(
        `${base()}/employees`,
        employeeBody(units.QA!, ceoRef, { name: 'Lẻn vào QA' }),
      );
      expect(denied.status).toBe(403);
      const allowed = await manager.post(
        `${base()}/employees`,
        employeeBody(units.Development!, ceoRef, { name: 'Manager tuyển dev' }),
      );
      expect(allowed.status, JSON.stringify(allowed.body)).toBe(201);
    });

    it('chuyển nhân viên trong phạm vi sang đơn vị ngoài phạm vi bị 403', async () => {
      const res = await manager.patch(`${base()}/employees/${devEmployee.id}`, {
        homeOrgUnitId: units.QA,
      });
      expect(res.status).toBe(403);
      const reload = await ceo.get(`${base()}/employees/${devEmployee.id}`);
      expect(reload.body.homeOrgUnitId).toBe(units.Development);
    });

    it('manager sửa nhân viên trong phạm vi được', async () => {
      const res = await manager.patch(`${base()}/employees/${devEmployee.id}`, {
        position: 'Senior AI Developer',
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.position).toBe('Senior AI Developer');
    });
  });

  describe('thao tác chỉ CEO', () => {
    it('Manager bị 403 khi thêm hoặc vô hiệu thành viên', async () => {
      const newcomer = await registerUser(t);
      const add = await manager.post(`${base()}/members`, {
        email: newcomer.email,
        role: 'manager',
      });
      expect(add.status).toBe(403);
      const deactivate = await manager.delete(`${base()}/members/${managerMemberId}`);
      expect(deactivate.status).toBe(403);
      // CEO thêm được, chứng tỏ 403 ở trên do phạm vi chứ không do dữ liệu.
      const ok = await ceo.post(`${base()}/members`, { email: newcomer.email, role: 'manager' });
      expect(ok.status).toBe(201);
    });

    it('Manager bị 403 khi đăng ký workspace; xem danh sách workspace thì được', async () => {
      const create = await manager.post(`${base()}/workspaces`, {
        name: 'Repo',
        kind: 'git_repo',
        mountPath: 'repo',
      });
      expect(create.status).toBe(403);
      expect((await manager.get(`${base()}/workspaces`)).status).toBe(200);
    });
  });

  describe('người không thuộc công ty', () => {
    it('mọi endpoint nhân viên và workspace trả 404, không tiết lộ sự tồn tại', async () => {
      for (const path of [
        `${base()}/employees`,
        `${base()}/employees/${devEmployee.id}`,
        `${base()}/workspaces`,
      ]) {
        expect((await outsider.get(path)).status, path).toBe(404);
      }
      expect(
        (
          await outsider.post(
            `${base()}/employees`,
            employeeBody(units.Development!, { kind: 'human', id: ceoMemberId }),
          )
        ).status,
      ).toBe(404);
    });
  });
});
