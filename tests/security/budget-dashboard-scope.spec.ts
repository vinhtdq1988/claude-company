import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  BudgetPolicy,
  Dashboard,
  EmployeeProfile,
  OrgChart,
  OrgChartNode,
  UsageSummary,
} from '@claude-company/contracts';
import { newId, withTenant } from '@claude-company/db';
import { usageLedger } from '@claude-company/db/schema/usage';
import { createTestApp, type TestApp } from '../support/app';
import {
  prepareDatabase,
  seedDatabase,
  startInfra,
  type StartedInfra,
} from '../support/containers';
import { departmentIds, employeeBody, hireVia, memberIdOf } from '../support/employee-fixtures';
import { registerUser, type TestSession } from '../support/factories';

/** Phạm vi quản lý của API ngân sách, usage và Dashboard (T165a; FR-028, FR-031, FR-040, SC-012). */
describe('Phạm vi quản lý của Budget và Dashboard (T165a)', () => {
  let infra: StartedInfra;
  let t: TestApp;
  let ceo: TestSession;
  let manager: TestSession;
  let outsider: TestSession;
  let companyId: string;
  let managerMemberId: string;
  let units: Record<string, string>;
  let parentUnitId: string;
  let dev: EmployeeProfile;
  let qa: EmployeeProfile;

  const base = () => `/companies/${companyId}`;
  const policyUrl = (kind: string, id: string) => `${base()}/budget-policies/${kind}/${id}`;

  const findParent = (nodes: OrgChartNode[], childId: string): string | undefined => {
    for (const node of nodes) {
      if (node.children.some((c) => c.id === childId)) return node.id;
      const inner = findParent(node.children, childId);
      if (inner) return inner;
    }
    return undefined;
  };

  /** Ghi thẳng một dòng ledger (bảng chỉ INSERT) để dựng dữ liệu chi tiêu. */
  const spend = (employee: EmployeeProfile, tokens: number, costUsd: string) =>
    withTenant(companyId, (tx) =>
      tx.insert(usageLedger).values({
        id: newId(),
        companyId,
        agentRunId: newId(),
        taskId: newId(),
        aiEmployeeId: employee.id,
        orgUnitId: employee.homeOrgUnitId,
        teamIds: [],
        modelId: 'claude-opus-5-5',
        inputTokens: tokens,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd,
        period: '2026-11',
        providerMessageId: `scope-${newId()}`,
        isOverage: false,
      }),
    );

  beforeAll(async () => {
    infra = await startInfra({ postgres: true, redis: true });
    await prepareDatabase(infra);
    await seedDatabase(infra);
    t = await createTestApp({ infra });

    ceo = await registerUser(t, { displayName: 'CEO' });
    manager = await registerUser(t, { displayName: 'Manager Dev' });
    outsider = await registerUser(t, { displayName: 'Người ngoài' });

    const created = await ceo.post('/companies', {
      name: 'Công ty phạm vi ngân sách',
      templateKey: 'software_company',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    companyId = created.body.id as string;
    units = await departmentIds(ceo, companyId);
    // Cơ cấu mẫu không có division: dựng đơn vị cha rồi chuyển Development vào đó.
    const division = await ceo.post(`${base()}/org-units`, { kind: 'division', name: 'Khối kỹ thuật' });
    expect(division.status, JSON.stringify(division.body)).toBe(201);
    const moved = await ceo.patch(`${base()}/org-units/${units.Development}`, {
      parentId: division.body.id,
    });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    const chart = (await ceo.get(`${base()}/org-chart`)).body as OrgChart;
    const parent = findParent(chart.roots, units.Development as string);
    if (!parent) throw new Error('Development phải có đơn vị cha sau khi chuyển');
    parentUnitId = parent;

    const added = await ceo.post(`${base()}/members`, { email: manager.email, role: 'manager' });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    managerMemberId = added.body.id as string;
    expect(
      (
        await ceo.put(`${base()}/management-assignments`, {
          targetKind: 'org_unit',
          targetId: units.Development,
          managerMemberId,
        })
      ).status,
    ).toBe(204);

    const ceoRef = { kind: 'human', id: await memberIdOf(ceo, companyId) } as const;
    dev = await hireVia(ceo, companyId, employeeBody(units.Development!, ceoRef, { name: 'Dev' }));
    qa = await hireVia(ceo, companyId, employeeBody(units.QA!, ceoRef, { name: 'QA' }));
    await spend(dev, 1_000, '0.5');
    await spend(qa, 4_000, '2');
  });

  afterAll(async () => {
    await t?.close();
    await infra?.stop();
  });

  describe('budget-policies', () => {
    it('Manager đọc và sửa được chính sách của đơn vị trong phạm vi', async () => {
      const put = await manager.put(policyUrl('org_unit', units.Development!), {
        monthlyCostLimit: 5,
        monthlyTokenLimit: 100_000,
      });
      expect(put.status, JSON.stringify(put.body)).toBe(200);
      const get = await manager.get(policyUrl('org_unit', units.Development!));
      expect(get.status).toBe(200);
      expect(get.body as BudgetPolicy).toMatchObject({ monthlyCostLimit: 5, isDefault: false });
      // Nhân viên trong phạm vi cũng sửa được.
      expect(
        (await manager.put(policyUrl('ai_employee', dev.id), { monthlyCostLimit: 1 })).status,
      ).toBe(200);
    });

    it('đọc hoặc sửa phạm vi ngoài quản lý đều 403: đơn vị khác, nhân viên khác', async () => {
      for (const [kind, id] of [
        ['org_unit', units.QA!],
        ['ai_employee', qa.id],
      ] as const) {
        const read = await manager.get(policyUrl(kind, id));
        expect(read.status, `${kind} GET`).toBe(403);
        expect(read.body.error.code).toBe('FORBIDDEN');
        expect((await manager.put(policyUrl(kind, id), { monthlyCostLimit: 999 })).status).toBe(
          403,
        );
      }
    });

    it('Manager không sửa được phạm vi company hoặc đơn vị cha', async () => {
      for (const [kind, id] of [
        ['company', companyId],
        ['org_unit', parentUnitId],
      ] as const) {
        expect((await manager.get(policyUrl(kind, id))).status, `${kind} GET`).toBe(403);
        const put = await manager.put(policyUrl(kind, id), {
          monthlyCostLimit: 999,
          monthlyTokenLimit: 999_999_999,
        });
        expect(put.status, `${kind} PUT`).toBe(403);
      }
    });

    it('các PUT bị từ chối không làm đổi dữ liệu', async () => {
      const company = (await ceo.get(policyUrl('company', companyId))).body as BudgetPolicy;
      expect(company).toMatchObject({ isDefault: true, monthlyCostLimit: 20 });
      const outside = (await ceo.get(policyUrl('ai_employee', qa.id))).body as BudgetPolicy;
      expect(outside.isDefault).toBe(true);
    });

    it('thành viên không thuộc công ty nhận 404', async () => {
      expect((await outsider.get(policyUrl('company', companyId))).status).toBe(404);
      expect(
        (await outsider.put(policyUrl('company', companyId), { monthlyCostLimit: 1 })).status,
      ).toBe(404);
    });

    it('CEO: gửi maxConcurrentTasks cho phạm vi nhân viên → 422; thân sai kiểu → 422', async () => {
      const bad = await ceo.put(policyUrl('ai_employee', dev.id), { maxConcurrentTasks: 3 });
      expect(bad.status).toBe(422);
      expect(
        (await ceo.put(policyUrl('company', companyId), { monthlyCostLimit: -1 })).status,
      ).toBe(422);
      expect((await ceo.put(policyUrl('galaxy', companyId), {})).status).toBe(422);
    });
  });

  describe('usage', () => {
    it('CEO thấy chi tiêu cả công ty; Manager chỉ thấy phần trong phạm vi', async () => {
      const all = (await ceo.get(`${base()}/usage?period=all&groupBy=employee`))
        .body as UsageSummary;
      expect(all.tokens).toBe(5_000);
      expect(all.groups.map((g) => g.key).sort()).toEqual([dev.id, qa.id].sort());

      const mine = await manager.get(`${base()}/usage?period=all&groupBy=employee`);
      expect(mine.status).toBe(200);
      const body = mine.body as UsageSummary;
      expect(body.tokens).toBe(1_000);
      expect(body.groups.map((g) => g.key)).toEqual([dev.id]);
    });

    it('orgUnitId hoặc employeeId ngoài phạm vi → 403', async () => {
      expect((await manager.get(`${base()}/usage?orgUnitId=${units.QA}`)).status).toBe(403);
      expect((await manager.get(`${base()}/usage?employeeId=${qa.id}`)).status).toBe(403);
      expect((await manager.get(`${base()}/usage?orgUnitId=${units.Development}`)).status).toBe(
        200,
      );
    });

    it('không đoán được chi tiêu của task ngoài phạm vi qua taskId', async () => {
      const rows = (await ceo.get(`${base()}/usage?period=all&groupBy=task`)).body as UsageSummary;
      const qaTask = rows.groups.find((g) => g.tokens === 4_000);
      expect(qaTask).toBeDefined();
      const peek = await manager.get(`${base()}/usage?period=all&taskId=${qaTask!.key}`);
      expect(peek.status).toBe(200);
      expect(peek.body).toMatchObject({ tokens: 0, costUsd: 0 });
    });

    it('thành viên không thuộc công ty nhận 404', async () => {
      expect((await outsider.get(`${base()}/usage`)).status).toBe(404);
    });
  });

  describe('dashboard', () => {
    it('CEO thấy toàn công ty; Manager chỉ thấy nhân viên và chi tiêu trong phạm vi', async () => {
      const all = (await ceo.get(`${base()}/dashboard?period=all`)).body as Dashboard;
      expect(all).toMatchObject({ totalEmployees: 2, tokens: 5_000, orgUnitId: null });
      expect(all.onTimeCompletionRate).toBeNull();
      expect(all.allTime.costUsd).toBeCloseTo(2.5, 6);

      const mine = await manager.get(`${base()}/dashboard?period=all`);
      expect(mine.status).toBe(200);
      expect(mine.body as Dashboard).toMatchObject({ totalEmployees: 1, tokens: 1_000 });
    });

    it('lọc theo phòng ban trong phạm vi được; ngoài phạm vi → 403', async () => {
      const ok = await manager.get(`${base()}/dashboard?period=all&orgUnitId=${units.Development}`);
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ orgUnitId: units.Development, totalEmployees: 1 });
      expect((await manager.get(`${base()}/dashboard?orgUnitId=${units.QA}`)).status).toBe(403);
      expect((await manager.get(`${base()}/dashboard?orgUnitId=${parentUnitId}`)).status).toBe(403);
    });

    it('CEO lọc theo phòng ban ra đúng số liệu của phòng ban đó', async () => {
      const qaOnly = await ceo.get(`${base()}/dashboard?period=all&orgUnitId=${units.QA}`);
      expect(qaOnly.body as Dashboard).toMatchObject({ totalEmployees: 1, tokens: 4_000 });
    });

    it('orgUnitId sai định dạng → 422; người ngoài công ty → 404', async () => {
      expect((await ceo.get(`${base()}/dashboard?orgUnitId=khong-phai-uuid`)).status).toBe(422);
      expect((await outsider.get(`${base()}/dashboard`)).status).toBe(404);
    });
  });
});
