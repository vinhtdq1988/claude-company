import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { EMPLOYEE_NAME_MAX, type EmployeeProfileInput, type RequestContext } from '@claude-company/contracts';
import { closeDatabase, initDatabase, newId, withTenant } from '@claude-company/db';
import { domainEvent } from '@claude-company/db/schema/events';
import { orgUnit } from '@claude-company/db/schema/organization';
import { asc, eq } from 'drizzle-orm';
import pg from 'pg';
import { EmployeeRepository } from '../../apps/api/src/engines/employee/employee.repository';
import { EmployeeService } from '../../apps/api/src/engines/employee/employee.service';
import { HumanMemberService } from '../../apps/api/src/engines/employee/human-member.service';
import {
  BUDGET_SERVICE,
  IDENTITY_DIRECTORY,
  MODEL_CATALOG,
  ORGANIZATION_ENGINE,
  TASK_ENGINE,
} from '../../apps/api/src/platform/engine-tokens';
import { EventPublisher } from '../../apps/api/src/platform/events/event-publisher';
import { prepareDatabase, seedDatabase, startInfra, type StartedInfra } from '../support/containers';
import {
  FakeIdentityDirectory,
  FakeOrganizationEngine,
  FakeTaskEngine,
  makeTask,
} from '../support/fake-engines';

/** Contract test EmployeeEngine với implementation thật trên Postgres (RLS bật), engine khác là fake. */
describe('Contract: EmployeeEngine (T061)', () => {
  let infra: StartedInfra;
  let owner: pg.Pool;
  let engine: EmployeeService;
  const org = new FakeOrganizationEngine();
  const tasks = new FakeTaskEngine();
  const identity = new FakeIdentityDirectory();
  const KNOWN_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5']);
  /** `allowed_models` hiệu lực theo đơn vị nhà, thay cho `BudgetService.allowedModelsFor` thật (US6-AS5). */
  const allowedByUnit = new Map<string, string[]>();

  const companyA = newId();
  const companyB = newId();
  const users = { ceo: newId(), mgr: newId(), other: newId() };
  const members: Record<string, string> = {};
  const units = { dev: newId(), qa: newId(), devB: newId() };
  const teamMobile = newId();

  const ctx = (companyId: string): RequestContext => ({
    companyId,
    actor: { kind: 'system' },
    traceId: 't',
  });
  const A = ctx(companyA);

  const profile = (overrides: Partial<EmployeeProfileInput> = {}): EmployeeProfileInput => ({
    name: 'Dev One',
    avatarKey: 'developer',
    position: 'AI Developer',
    homeOrgUnitId: units.dev,
    kind: 'employee',
    roleTemplateKey: 'ai_developer',
    personality: 'cẩn thận',
    skills: ['typescript'],
    seniority: 'middle',
    modelId: 'claude-opus-5-5',
    runtimeKind: 'claude_agent_sdk',
    systemPrompt: 'Bạn là AI Developer.',
    toolGrants: ['workspace.read', 'workspace.write'],
    workspaceId: null,
    manager: { kind: 'human', id: members.ceo as string },
    maxConcurrentTasks: 2,
    ...overrides,
  });

  const aiManager = (name: string, manager: EmployeeProfileInput['manager']) =>
    engine.create(
      A,
      profile({
        name,
        kind: 'manager',
        runtimeKind: 'messages_api',
        toolGrants: ['workspace.read', 'task.decompose.propose'],
        manager,
      }),
    );

  const eventTypes = async (companyId: string) =>
    (
      await withTenant(companyId, (tx) =>
        tx.select({ type: domainEvent.type }).from(domainEvent).orderBy(asc(domainEvent.seq)),
      )
    ).map((e) => e.type);

  beforeAll(async () => {
    infra = await startInfra({ postgres: true, redis: false });
    initDatabase(await prepareDatabase(infra));
    owner = new pg.Pool({ connectionString: infra.databaseMigrationUrl, max: 1 });

    for (const [name, id] of Object.entries(users)) {
      const email = `${name}-${randomUUID().slice(0, 6)}@example.com`;
      await owner.query(
        `insert into "user"(id,email,password_hash,display_name) values ($1,$2,'h',$3)`,
        [id, email, name],
      );
      identity.add({ id, email, displayName: name });
    }
    for (const [companyId, unitIds] of [
      [companyA, [units.dev, units.qa]],
      [companyB, [units.devB]],
    ] as const) {
      await withTenant(companyId, async (tx) => {
        for (const id of unitIds) {
          await tx
            .insert(orgUnit)
            .values({ id, companyId, kind: 'department', name: `Phòng ${id.slice(-6)}` });
          org.addUnit({ id });
        }
      });
    }

    const moduleRef = await Test.createTestingModule({
      providers: [
        EmployeeRepository,
        HumanMemberService,
        EmployeeService,
        EventPublisher,
        { provide: IDENTITY_DIRECTORY, useValue: identity },
        { provide: TASK_ENGINE, useValue: tasks },
        { provide: ORGANIZATION_ENGINE, useValue: org },
        {
          provide: MODEL_CATALOG,
          useValue: { hasModel: async (id: string) => KNOWN_MODELS.has(id) },
        },
        {
          provide: BUDGET_SERVICE,
          useValue: {
            allowedModelsFor: async (_ctx: RequestContext, target: { homeOrgUnitId: string }) =>
              allowedByUnit.get(target.homeOrgUnitId) ?? null,
          },
        },
      ],
    }).compile();
    engine = moduleRef.get(EmployeeService);

    members.ceo = (await engine.addHumanMember(A, { userId: users.ceo, role: 'ceo' })).id;
    members.mgr = (await engine.addHumanMember(A, { userId: users.mgr, role: 'manager' })).id;
  });

  afterAll(async () => {
    await owner?.end();
    await closeDatabase();
    await infra?.stop();
  });

  describe('create / get', () => {
    it('tạo hồ sơ đủ trường FR-009 với giá trị mặc định và phát employee.created', async () => {
      const created = await engine.create(A, profile());
      expect(created).toMatchObject({
        name: 'Dev One',
        kind: 'employee',
        runtimeKind: 'claude_agent_sdk',
        modelId: 'claude-opus-5-5',
        toolGrants: ['workspace.read', 'workspace.write'],
        manager: { kind: 'human', id: members.ceo },
        maxConcurrentTasks: 2,
        status: 'active',
        teamIds: [],
        performance: { completedTasks: 0, onTimeRate: 0, reworkRate: 0 },
      });
      const fetched = await engine.get(A, created.id);
      expect(fetched).toEqual(created);
      expect(await eventTypes(companyA)).toContain('employee.created');
    });

    it('thiếu manager → MANAGER_REQUIRED (US2-AS2), không tạo bản ghi', async () => {
      const before = (await engine.list(A, {})).length;
      const missing = { ...profile(), manager: undefined } as unknown as EmployeeProfileInput;
      await expect(engine.create(A, missing)).rejects.toMatchObject({ code: 'MANAGER_REQUIRED' });
      const nullManager = { ...profile(), manager: null } as unknown as EmployeeProfileInput;
      await expect(engine.create(A, nullManager)).rejects.toMatchObject({
        code: 'MANAGER_REQUIRED',
      });
      expect((await engine.list(A, {})).length).toBe(before);
    });

    it('manager AI phải là AI Manager đang hoạt động; manager người thật phải còn hoạt động', async () => {
      const worker = await engine.create(A, profile({ name: 'Worker' }));
      await expect(
        engine.create(A, profile({ manager: { kind: 'ai', id: worker.id } })),
      ).rejects.toMatchObject({ code: 'MANAGEMENT_CHAIN_INVALID' });
      await expect(
        engine.create(A, profile({ manager: { kind: 'ai', id: newId() } })),
      ).rejects.toMatchObject({ code: 'MANAGEMENT_CHAIN_INVALID' });
      await expect(
        engine.create(A, profile({ manager: { kind: 'human', id: newId() } })),
      ).rejects.toMatchObject({ code: 'MANAGEMENT_CHAIN_INVALID' });
    });

    it('MODEL_NOT_ALLOWED khi model không có trong danh mục', async () => {
      await expect(engine.create(A, profile({ modelId: 'gpt-khong-co' }))).rejects.toMatchObject({
        code: 'MODEL_NOT_ALLOWED',
      });
    });

    it('MODEL_NOT_ALLOWED khi model nằm ngoài allowed_models hiệu lực của đơn vị (US6-AS5)', async () => {
      allowedByUnit.set(units.qa, ['claude-sonnet-5-5']);
      try {
        await expect(
          engine.create(A, profile({ homeOrgUnitId: units.qa, modelId: 'claude-opus-5-5' })),
        ).rejects.toMatchObject({
          code: 'MODEL_NOT_ALLOWED',
          details: { allowedModels: ['claude-sonnet-5-5'] },
        });
        const ok = await engine.create(
          A,
          profile({ name: 'QA đúng model', homeOrgUnitId: units.qa, modelId: 'claude-sonnet-5-5' }),
        );
        // Đổi model hoặc chuyển đơn vị sang phạm vi hạn chế cũng bị kiểm tra lại.
        await expect(engine.update(A, ok.id, { modelId: 'claude-opus-5-5' })).rejects.toMatchObject({
          code: 'MODEL_NOT_ALLOWED',
        });
        const dev = await engine.create(A, profile({ name: 'Dev chuyển đơn vị' }));
        await expect(
          engine.update(A, dev.id, { homeOrgUnitId: units.qa }),
        ).rejects.toMatchObject({ code: 'MODEL_NOT_ALLOWED' });
      } finally {
        allowedByUnit.delete(units.qa);
      }
    });

    it('tool_grants phải thuộc danh mục và khớp runtime; AI Manager chỉ messages_api', async () => {
      await expect(
        engine.create(A, profile({ toolGrants: ['network.fetch'] })),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(
        engine.create(A, profile({ toolGrants: ['khong.co.trong.danh.muc'] })),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      // workspace.shell chỉ dành cho claude_agent_sdk.
      await expect(
        engine.create(A, profile({ runtimeKind: 'messages_api', toolGrants: ['workspace.shell'] })),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(
        engine.create(A, profile({ kind: 'manager', runtimeKind: 'claude_agent_sdk' })),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('đơn vị phải là department đang hoạt động; workspace phải tồn tại', async () => {
      await expect(engine.create(A, profile({ homeOrgUnitId: newId() }))).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
      await expect(engine.create(A, profile({ workspaceId: newId() }))).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
    });

    it('get nhân viên của công ty khác → NOT_FOUND (cô lập tenant)', async () => {
      const created = await engine.create(A, profile({ name: 'Chỉ của A' }));
      await expect(engine.get(ctx(companyB), created.id)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      expect(await engine.list(ctx(companyB), {})).toEqual([]);
    });
  });

  describe('update (US2-AS3)', () => {
    it('đổi model chỉ ảnh hưởng nhân viên được sửa', async () => {
      const a = await engine.create(A, profile({ name: 'Giữ model' }));
      const b = await engine.create(A, profile({ name: 'Đổi model' }));
      const updated = await engine.update(A, b.id, { modelId: 'claude-sonnet-5-5' });
      expect(updated.modelId).toBe('claude-sonnet-5-5');
      expect((await engine.get(A, a.id)).modelId).toBe('claude-opus-5-5');
      expect(await eventTypes(companyA)).toContain('employee.updated');
    });

    it('sửa không đổi gì thì không phát sự kiện', async () => {
      const e = await engine.create(A, profile({ name: 'Không đổi' }));
      const before = (await eventTypes(companyA)).length;
      await engine.update(A, e.id, { name: 'Không đổi' });
      expect((await eventTypes(companyA)).length).toBe(before);
    });

    it('đổi manager được kiểm tra lại chuỗi; model lạ bị từ chối', async () => {
      const e = await engine.create(A, profile({ name: 'Đổi manager' }));
      const m = await aiManager('Manager đổi', { kind: 'human', id: members.mgr as string });
      const moved = await engine.update(A, e.id, { manager: { kind: 'ai', id: m.id } });
      expect(moved.manager).toEqual({ kind: 'ai', id: m.id });
      await expect(
        engine.update(A, e.id, { manager: { kind: 'human', id: newId() } }),
      ).rejects.toMatchObject({ code: 'MANAGEMENT_CHAIN_INVALID' });
      await expect(engine.update(A, e.id, { modelId: 'x' })).rejects.toMatchObject({
        code: 'MODEL_NOT_ALLOWED',
      });
    });

    it('chặn đổi kind của AI Manager đang có cấp dưới', async () => {
      const m = await aiManager('Manager có cấp dưới', {
        kind: 'human',
        id: members.ceo as string,
      });
      await engine.create(A, profile({ name: 'Cấp dưới', manager: { kind: 'ai', id: m.id } }));
      await expect(engine.update(A, m.id, { kind: 'employee' })).rejects.toMatchObject({
        code: 'MANAGEMENT_CHAIN_INVALID',
      });
    });

    it('chuyển sang department khác; department lạ bị từ chối', async () => {
      const e = await engine.create(A, profile({ name: 'Chuyển phòng' }));
      expect((await engine.update(A, e.id, { homeOrgUnitId: units.qa })).homeOrgUnitId).toBe(
        units.qa,
      );
      await expect(engine.update(A, e.id, { homeOrgUnitId: newId() })).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
    });
  });

  describe('suspend / resume / archive', () => {
    it('suspend và resume idempotent, phát đúng sự kiện một lần', async () => {
      const e = await engine.create(A, profile({ name: 'Tạm dừng' }));
      const base = await eventTypes(companyA);
      await engine.suspend(A, e.id);
      await engine.suspend(A, e.id);
      expect((await engine.get(A, e.id)).status).toBe('suspended');
      await engine.resume(A, e.id);
      await engine.resume(A, e.id);
      expect((await engine.get(A, e.id)).status).toBe('active');
      const added = (await eventTypes(companyA)).slice(base.length);
      expect(added).toEqual(['employee.suspended', 'employee.resumed']);
    });

    it('archive bị chặn khi còn task mở (US2-AS4) và kèm danh sách task', async () => {
      const e = await engine.create(A, profile({ name: 'Còn task' }));
      tasks.tasks = [makeTask({ id: newId(), title: 'Task dở dang', assigneeId: e.id })];
      try {
        await expect(engine.archive(A, e.id)).rejects.toMatchObject({
          code: 'EMPLOYEE_HAS_OPEN_TASKS',
          details: { tasks: [expect.objectContaining({ title: 'Task dở dang' })] },
        });
        expect((await engine.get(A, e.id)).status).toBe('active');
      } finally {
        tasks.tasks = [];
      }
      await engine.archive(A, e.id);
      expect((await engine.get(A, e.id)).status).toBe('archived');
      expect((await engine.list(A, {})).map((x) => x.id)).not.toContain(e.id);
      expect((await engine.list(A, { status: 'archived' })).map((x) => x.id)).toContain(e.id);
      expect(await eventTypes(companyA)).toContain('employee.archived');
    });

    it('archive AI Manager giữa chuỗi bị chặn; gỡ cấp dưới rồi mới archive được', async () => {
      const m = await aiManager('Manager giữa chuỗi', { kind: 'human', id: members.ceo as string });
      const sub = await engine.create(
        A,
        profile({ name: 'Cấp dưới', manager: { kind: 'ai', id: m.id } }),
      );
      await expect(engine.archive(A, m.id)).rejects.toMatchObject({
        code: 'MANAGEMENT_CHAIN_INVALID',
      });
      await engine.update(A, sub.id, { manager: { kind: 'human', id: members.ceo as string } });
      await expect(engine.archive(A, m.id)).resolves.toBeUndefined();
    });

    it('archive gỡ nhân viên khỏi các team của họ', async () => {
      const e = await engine.create(A, profile({ name: 'Trong team' }));
      const other = await engine.create(A, profile({ name: 'Bạn cùng team' }));
      org.memberships = [
        { teamId: teamMobile, memberKind: 'ai', memberId: e.id },
        { teamId: teamMobile, memberKind: 'ai', memberId: other.id },
      ];
      try {
        await engine.archive(A, e.id);
        expect(org.memberships).toEqual([
          { teamId: teamMobile, memberKind: 'ai', memberId: other.id },
        ]);
      } finally {
        org.memberships = [];
      }
    });
  });

  describe('list', () => {
    it('lọc theo orgUnitId, kind, status và teamId; teamIds lấy từ Organization Engine', async () => {
      const dev = await engine.create(A, profile({ name: 'Lọc dev', homeOrgUnitId: units.dev }));
      const qa = await engine.create(
        A,
        profile({ name: 'Lọc qa', homeOrgUnitId: units.qa, position: 'AI QA' }),
      );
      const mgr = await aiManager('Lọc manager', { kind: 'human', id: members.ceo as string });
      await engine.suspend(A, qa.id);
      org.memberships = [{ teamId: teamMobile, memberKind: 'ai', memberId: dev.id }];
      try {
        const ids = (filter: Parameters<EmployeeService['list']>[1]) =>
          engine.list(A, filter).then((r) => r.map((x) => x.id));
        expect(await ids({ orgUnitId: units.qa })).toContain(qa.id);
        expect(await ids({ orgUnitId: units.qa })).not.toContain(dev.id);
        expect(await ids({ kind: 'manager' })).toContain(mgr.id);
        expect(await ids({ kind: 'manager' })).not.toContain(dev.id);
        expect(await ids({ status: 'suspended' })).toEqual(expect.arrayContaining([qa.id]));
        expect(await ids({ teamId: teamMobile })).toEqual([dev.id]);
        const withTeam = (await engine.list(A, { teamId: teamMobile }))[0];
        expect(withTeam?.teamIds).toEqual([teamMobile]);
      } finally {
        org.memberships = [];
      }
    });

    it('performance lấy từ TaskEngine.getStats khi yêu cầu', async () => {
      const e = await engine.create(A, profile({ name: 'Có thống kê' }));
      const original = tasks.getStats;
      tasks.getStats = async () => ({
        completedTasks: 4,
        onTimeRate: 0.75,
        reworkRate: 0.25,
        activeTasks: 1,
      });
      try {
        expect((await engine.get(A, e.id)).performance).toEqual({
          completedTasks: 4,
          onTimeRate: 0.75,
          reworkRate: 0.25,
        });
        const listed = (await engine.list(A, { withPerformance: true })).find((x) => x.id === e.id);
        expect(listed?.performance.completedTasks).toBe(4);
        const plain = (await engine.list(A, {})).find((x) => x.id === e.id);
        expect(plain?.performance.completedTasks).toBe(0);
      } finally {
        tasks.getStats = original;
      }
    });
  });

  describe('resolveAccountableHuman / getCapacity', () => {
    it('đi theo chuỗi AI Manager tới người thật cuối chuỗi', async () => {
      const top = await aiManager('Top', { kind: 'human', id: members.mgr as string });
      const mid = await aiManager('Mid', { kind: 'ai', id: top.id });
      const leaf = await engine.create(
        A,
        profile({ name: 'Lá', manager: { kind: 'ai', id: mid.id } }),
      );
      expect(await engine.resolveAccountableHuman(A, leaf.id)).toBe(members.mgr);
      expect(await engine.resolveAccountableHuman(A, top.id)).toBe(members.mgr);
    });

    it('getCapacity trả số task đang chiếm slot và giới hạn của nhân viên', async () => {
      const e = await engine.create(A, profile({ name: 'Slot', maxConcurrentTasks: 3 }));
      expect(await engine.getCapacity(A, e.id)).toEqual({ active: 0, max: 3 });
      tasks.tasks = [makeTask({ assigneeId: e.id })];
      try {
        expect(await engine.getCapacity(A, e.id)).toEqual({ active: 1, max: 3 });
      } finally {
        tasks.tasks = [];
      }
      await expect(engine.getCapacity(A, newId())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('thành viên người thật', () => {
    it('vô hiệu người thật cuối chuỗi bị chặn, kèm danh sách nhân viên bị ảnh hưởng', async () => {
      const lonely = await engine.addHumanMember(A, { userId: users.other, role: 'manager' });
      const e = await engine.create(
        A,
        profile({ name: 'Phụ thuộc người thật', manager: { kind: 'human', id: lonely.id } }),
      );
      await expect(engine.deactivateHumanMember(A, lonely.id)).rejects.toMatchObject({
        code: 'MANAGEMENT_CHAIN_INVALID',
        details: { employees: [expect.objectContaining({ id: e.id })] },
      });
      // Chuyển nhân viên sang người khác thì vô hiệu được, và member không còn trong danh sách.
      await engine.update(A, e.id, { manager: { kind: 'human', id: members.ceo as string } });
      await engine.deactivateHumanMember(A, lonely.id);
      expect((await engine.listHumanMembers(A)).map((m) => m.id)).not.toContain(lonely.id);
      expect(await engine.findMemberships(users.other)).toEqual([]);
      expect(await eventTypes(companyA)).toContain('human_member.deactivated');
    });

    it('chặn cả khi người thật là gốc của một chuỗi qua AI Manager', async () => {
      const u = await owner.query<{ id: string }>(
        `insert into "user"(id,email,password_hash,display_name) values (gen_random_uuid(),$1,'h','root') returning id`,
        [`root-${randomUUID().slice(0, 6)}@example.com`],
      );
      identity.add({
        id: u.rows[0]!.id,
        email: `root-${u.rows[0]!.id}@example.com`,
        displayName: 'root',
      });
      const root = await engine.addHumanMember(A, { userId: u.rows[0]!.id, role: 'manager' });
      const m = await aiManager('Manager của root', { kind: 'human', id: root.id });
      await engine.create(A, profile({ name: 'Dưới manager', manager: { kind: 'ai', id: m.id } }));
      await expect(engine.deactivateHumanMember(A, root.id)).rejects.toMatchObject({
        code: 'MANAGEMENT_CHAIN_INVALID',
      });
    });

    it('vô hiệu thành viên không tồn tại hoặc đã vô hiệu → NOT_FOUND', async () => {
      await expect(engine.deactivateHumanMember(A, newId())).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });
  });

  describe('provisionTeamManager (FR-016a)', () => {
    const provision = (teamName: string, over: Partial<{ teamId: string; humanManagerId: string | null; orgUnitId: string }> = {}) =>
      engine.provisionTeamManager(A, {
        teamId: over.teamId ?? newId(),
        teamName,
        orgUnitId: over.orgUnitId ?? units.dev,
        humanManagerId: over.humanManagerId === undefined ? null : over.humanManagerId,
      });
    const managersNamed = async (name: string) =>
      (await engine.list(A, { kind: 'manager' })).filter((e) => e.name === name);

    beforeAll(async () => {
      await seedDatabase(infra); // mẫu `ai_manager` nằm trong seed
    });

    it('tạo AI Manager từ mẫu: kind manager, messages_api, ở department chứa Team, thành viên của Team', async () => {
      const teamId = newId();
      org.memberships = [{ teamId, memberKind: 'ai', memberId: (await engine.create(A, profile({ name: 'Dev của team' }))).id }];
      const created = await provision('Web', { teamId });
      expect(created).toMatchObject({
        name: 'AI Manager Web',
        kind: 'manager',
        runtimeKind: 'messages_api',
        roleTemplateKey: 'ai_manager',
        homeOrgUnitId: units.dev,
        manager: { kind: 'human', id: members.ceo }, // Team không có người quản lý → CEO
        status: 'active',
      });
      expect(created.teamIds).toContain(teamId);
      // Thành viên cũ của Team được giữ nguyên khi thêm AI Manager.
      const inTeam = org.memberships.filter((m) => m.teamId === teamId);
      expect(inTeam).toHaveLength(2);
      expect(inTeam).toContainEqual({ teamId, memberKind: 'ai', memberId: created.id });
      expect(await eventTypes(companyA)).toContain('employee.created');
    });

    it('manager trực tiếp là người quản lý Team khi có (humanManagerId)', async () => {
      const created = await provision('Mobile', { humanManagerId: members.mgr as string });
      expect(created.manager).toEqual({ kind: 'human', id: members.mgr });
    });

    it('tên cắt theo EMPLOYEE_NAME_MAX', async () => {
      const created = await provision('T'.repeat(200));
      expect(created.name).toHaveLength(EMPLOYEE_NAME_MAX);
      expect(created.name.startsWith('AI Manager TTT')).toBe(true);
    });

    it('hai lần gọi đồng thời cho cùng Team chỉ tạo một AI Manager; Team khác tạo riêng', async () => {
      const teamId = newId();
      const [a, b] = await Promise.all([
        provision('Song song', { teamId }),
        provision('Song song', { teamId }),
      ]);
      expect(a.id).toBe(b.id);
      expect(await managersNamed('AI Manager Song song')).toHaveLength(1);

      const [x, y] = await Promise.all([provision('Team X'), provision('Team Y')]);
      expect(x.id).not.toBe(y.id);
    });

    it('công ty không có người thật hợp lệ → MANAGEMENT_CHAIN_INVALID, không tạo gì', async () => {
      const B = ctx(companyB); // công ty B không có human_member nào
      const before = (await engine.list(B, {})).length;
      await expect(
        engine.provisionTeamManager(B, { teamId: newId(), teamName: 'Mồ côi', orgUnitId: units.devB, humanManagerId: null }),
      ).rejects.toMatchObject({ code: 'MANAGEMENT_CHAIN_INVALID' });
      expect((await engine.list(B, {})).length).toBe(before);
    });

    it('allowed_models chặn model của mẫu ai_manager → MODEL_NOT_ALLOWED, không tạo AI Manager và Team không đổi', async () => {
      const teamId = newId();
      const before = org.memberships.length;
      allowedByUnit.set(units.qa, ['mo-hinh-khac']);
      try {
        await expect(provision('Bị chặn model', { teamId, orgUnitId: units.qa })).rejects.toMatchObject({
          code: 'MODEL_NOT_ALLOWED',
        });
      } finally {
        allowedByUnit.delete(units.qa);
      }
      expect(await managersNamed('AI Manager Bị chặn model')).toHaveLength(0);
      expect(org.memberships).toHaveLength(before);
    });
  });

  it('sự kiện employee.* của công ty A không xuất hiện ở công ty B', async () => {
    const rows = await withTenant(companyB, (tx) =>
      tx.select().from(domainEvent).where(eq(domainEvent.type, 'employee.created')),
    );
    expect(rows).toEqual([]);
  });
});
