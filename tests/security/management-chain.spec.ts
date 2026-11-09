import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EmployeeProfile } from '@claude-company/contracts';
import { createTestApp, type TestApp } from '../support/app';
import {
  prepareDatabase,
  seedDatabase,
  startInfra,
  type StartedInfra,
} from '../support/containers';
import {
  departmentIds,
  employeeBody,
  hireVia,
  managerBody,
  memberIdOf,
} from '../support/employee-fixtures';
import { registerUser, type TestSession } from '../support/factories';

/** FR-006: mỗi AI Employee có chuỗi quản lý kết thúc ở một người thật đang hoạt động, không vòng, ≤ 10 bước. */
describe('Chuỗi quản lý AI Employee (T063; FR-006, Nguyên tắc II)', () => {
  let infra: StartedInfra;
  let t: TestApp;

  beforeAll(async () => {
    infra = await startInfra({ postgres: true, redis: true });
    await prepareDatabase(infra);
    await seedDatabase(infra);
    t = await createTestApp({ infra });
  });

  afterAll(async () => {
    await t?.close();
    await infra?.stop();
  });

  async function setup() {
    const session = await registerUser(t);
    const created = await session.post('/companies', {
      name: 'Chuỗi quản lý',
      templateKey: 'software_company',
    });
    expect(created.status).toBe(201);
    const companyId = created.body.id as string;
    const base = `/companies/${companyId}`;
    const units = await departmentIds(session, companyId);
    const ceo = await memberIdOf(session, companyId);
    const home = units.Development!;
    const hire = (body: Record<string, unknown>) => hireVia(session, companyId, body);
    const tryCreate = (body: Record<string, unknown>) => session.post(`${base}/employees`, body);
    const expectChainInvalid = (res: { status: number; body: { error: { code: string } } }) => {
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('MANAGEMENT_CHAIN_INVALID');
    };
    return { session, companyId, base, home, ceo, hire, tryCreate, expectChainInvalid };
  }

  async function addManagerUser(s: Awaited<ReturnType<typeof setup>>): Promise<{
    user: TestSession;
    memberId: string;
  }> {
    const user = await registerUser(t);
    const added = await s.session.post(`${s.base}/members`, { email: user.email, role: 'manager' });
    expect(added.status).toBe(201);
    return { user, memberId: added.body.id as string };
  }

  it('manager AI phải là AI Manager: trỏ tới nhân viên thường bị chặn', async () => {
    const s = await setup();
    const worker = await s.hire(employeeBody(s.home, { kind: 'human', id: s.ceo }));
    s.expectChainInvalid(
      await s.tryCreate(
        employeeBody(s.home, { kind: 'ai', id: worker.id }, { name: 'Dưới worker' }),
      ),
    );
    const manager = await s.hire(managerBody(s.home, { kind: 'human', id: s.ceo }));
    expect((await s.tryCreate(employeeBody(s.home, { kind: 'ai', id: manager.id }))).status).toBe(
      201,
    );
  });

  it('đổi manager sang nhân viên thường qua PATCH cũng bị chặn', async () => {
    const s = await setup();
    const worker = await s.hire(employeeBody(s.home, { kind: 'human', id: s.ceo }));
    const other = await s.hire(
      employeeBody(s.home, { kind: 'human', id: s.ceo }, { name: 'Khác' }),
    );
    s.expectChainInvalid(
      await s.session.patch(`${s.base}/employees/${other.id}`, {
        manager: { kind: 'ai', id: worker.id },
      }),
    );
  });

  it('chuỗi có vòng bị chặn, kể cả tự trỏ vào chính mình', async () => {
    const s = await setup();
    const top = await s.hire(managerBody(s.home, { kind: 'human', id: s.ceo }, { name: 'Top' }));
    const low = await s.hire(managerBody(s.home, { kind: 'ai', id: top.id }, { name: 'Low' }));
    s.expectChainInvalid(
      await s.session.patch(`${s.base}/employees/${top.id}`, {
        manager: { kind: 'ai', id: low.id },
      }),
    );
    s.expectChainInvalid(
      await s.session.patch(`${s.base}/employees/${top.id}`, {
        manager: { kind: 'ai', id: top.id },
      }),
    );
    // Dữ liệu không bị đổi sau các lần bị chặn.
    const reload = await s.session.get(`${s.base}/employees/${top.id}`);
    expect(reload.body.manager).toEqual({ kind: 'human', id: s.ceo });
  });

  it('chuỗi dài quá 10 bước bị chặn, đúng 10 bước thì hợp lệ', async () => {
    const s = await setup();
    let parent: EmployeeProfile | undefined;
    // m1 → người thật (1 bước), m2 → m1 (2 bước)… m9 (9 bước).
    for (let i = 1; i <= 9; i++) {
      parent = await s.hire(
        managerBody(s.home, parent ? { kind: 'ai', id: parent.id } : { kind: 'human', id: s.ceo }, {
          name: `Manager ${i}`,
        }),
      );
    }
    // Nhân viên dưới m9 có đúng 10 bước.
    const tenth = await s.hire(
      employeeBody(s.home, { kind: 'ai', id: parent!.id }, { name: 'Bước thứ 10' }),
    );
    // Manager thứ 10 dưới m9 cũng hợp lệ (10 bước), nhưng nhân viên dưới nó sẽ là bước 11.
    const m10 = await s.hire(
      managerBody(s.home, { kind: 'ai', id: parent!.id }, { name: 'Manager 10' }),
    );
    s.expectChainInvalid(
      await s.tryCreate(employeeBody(s.home, { kind: 'ai', id: m10.id }, { name: 'Bước thứ 11' })),
    );
    expect(tenth.manager.id).toBe(parent!.id);
  });

  it('chuỗi kết thúc ở người đã vô hiệu bị chặn khi tạo mới', async () => {
    const s = await setup();
    const { memberId } = await addManagerUser(s);
    expect((await s.session.delete(`${s.base}/members/${memberId}`)).status).toBe(204);
    s.expectChainInvalid(await s.tryCreate(employeeBody(s.home, { kind: 'human', id: memberId })));
    // Cũng áp dụng qua một AI Manager đã tồn tại: không thể trỏ vào người thật không tồn tại.
    s.expectChainInvalid(
      await s.tryCreate(
        employeeBody(s.home, { kind: 'human', id: '0197a000-0000-7000-8000-0000000000ee' }),
      ),
    );
  });

  it('vô hiệu người thật cuối của chuỗi bị chặn, gồm chuỗi đi qua AI Manager', async () => {
    const s = await setup();
    const { memberId } = await addManagerUser(s);
    const manager = await s.hire(managerBody(s.home, { kind: 'human', id: memberId }));
    await s.hire(employeeBody(s.home, { kind: 'ai', id: manager.id }, { name: 'Cuối chuỗi' }));

    const blocked = await s.session.delete(`${s.base}/members/${memberId}`);
    s.expectChainInvalid(blocked);
    expect(blocked.body.error.details.employees.length).toBe(2);

    // Chuyển AI Manager sang CEO thì người kia vô hiệu được.
    const moved = await s.session.patch(`${s.base}/employees/${manager.id}`, {
      manager: { kind: 'human', id: s.ceo },
    });
    expect(moved.status).toBe(200);
    expect((await s.session.delete(`${s.base}/members/${memberId}`)).status).toBe(204);
  });

  it('archive AI Manager giữa chuỗi bị chặn cho tới khi cấp dưới được chuyển đi', async () => {
    const s = await setup();
    const manager = await s.hire(managerBody(s.home, { kind: 'human', id: s.ceo }));
    const sub = await s.hire(employeeBody(s.home, { kind: 'ai', id: manager.id }));
    const blocked = await s.session.delete(`${s.base}/employees/${manager.id}`);
    s.expectChainInvalid(blocked);
    expect(blocked.body.error.details.employees).toEqual([expect.objectContaining({ id: sub.id })]);

    await s.session.patch(`${s.base}/employees/${sub.id}`, {
      manager: { kind: 'human', id: s.ceo },
    });
    expect((await s.session.delete(`${s.base}/employees/${manager.id}`)).status).toBe(204);
  });

  it('đổi kind của AI Manager đang có cấp dưới bị chặn; không có cấp dưới thì đổi được', async () => {
    const s = await setup();
    const manager = await s.hire(managerBody(s.home, { kind: 'human', id: s.ceo }));
    const sub = await s.hire(employeeBody(s.home, { kind: 'ai', id: manager.id }));
    s.expectChainInvalid(
      await s.session.patch(`${s.base}/employees/${manager.id}`, { kind: 'employee' }),
    );
    await s.session.patch(`${s.base}/employees/${sub.id}`, {
      manager: { kind: 'human', id: s.ceo },
    });
    const changed = await s.session.patch(`${s.base}/employees/${manager.id}`, {
      kind: 'employee',
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body.kind).toBe('employee');
  });
});
