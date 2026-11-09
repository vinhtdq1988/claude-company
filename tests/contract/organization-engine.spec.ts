import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import {
  DomainError,
  type Company,
  type OrgChart,
  type OrgChartNode,
  type OrgUnit,
  type OrganizationEngine,
  type RequestContext,
} from '@claude-company/contracts';
import { closeDatabase, initDatabase, newId, withTenant } from '@claude-company/db';
import { domainEvent } from '@claude-company/db/schema/events';
import { asc } from 'drizzle-orm';
import pg from 'pg';
import { EmployeeRepository } from '../../apps/api/src/engines/employee/employee.repository';
import { HumanMemberService } from '../../apps/api/src/engines/employee/human-member.service';
import { OrganizationRepository } from '../../apps/api/src/engines/organization/organization.repository';
import { OrganizationService } from '../../apps/api/src/engines/organization/organization.service';
import {
  EMPLOYEE_ENGINE,
  IDENTITY_DIRECTORY,
  TASK_ENGINE,
} from '../../apps/api/src/platform/engine-tokens';
import { EventPublisher } from '../../apps/api/src/platform/events/event-publisher';
import {
  prepareDatabase,
  seedDatabase,
  startInfra,
  type StartedInfra,
} from '../support/containers';
import {
  employeeEngineWithMembers,
  FakeEmployeeEngine,
  FakeIdentityDirectory,
  FakeTaskEngine,
  makeEmployeeProfile,
  makeTask,
} from '../support/fake-engines';

async function rejection(promise: Promise<unknown>): Promise<DomainError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('Mong đợi bị từ chối nhưng thao tác thành công');
}

const flatten = (nodes: OrgChartNode[]): OrgChartNode[] =>
  nodes.flatMap((n) => [n, ...flatten(n.children)]);
const findNode = (chart: OrgChart, name: string): OrgChartNode => {
  const node = flatten(chart.roots).find((n) => n.name === name);
  if (!node) throw new Error(`Không thấy đơn vị "${name}" trong sơ đồ`);
  return node;
};

describe('Contract: OrganizationEngine (T047)', () => {
  let infra: StartedInfra;
  let owner: pg.Pool;
  let org: OrganizationEngine;
  let members: HumanMemberService;
  const identity = new FakeIdentityDirectory();
  const employees = new FakeEmployeeEngine();
  const tasks = new FakeTaskEngine();

  async function newUser(name: string): Promise<string> {
    const id = newId();
    const email = `${name}-${randomUUID().slice(0, 6)}@example.com`;
    await owner.query(
      `insert into "user"(id,email,password_hash,display_name) values ($1,$2,'h',$3)`,
      [id, email, name],
    );
    identity.add({ id, email, displayName: name });
    return id;
  }

  /** Tạo công ty qua engine; trả company, ctx của CEO và id member CEO. */
  async function bootstrap(templateKey?: string) {
    const userId = await newUser('ceo');
    const company = await org.createCompany(
      { userId, traceId: 't' },
      { name: `Công ty ${randomUUID().slice(0, 4)}`, templateKey },
    );
    const systemCtx: RequestContext = {
      companyId: company.id,
      actor: { kind: 'system' },
      traceId: 't',
    };
    const [ceo] = await members.listHumanMembers(systemCtx);
    if (!ceo) throw new Error('createCompany không tạo CEO');
    const ctx: RequestContext = {
      companyId: company.id,
      actor: { kind: 'human', memberId: ceo.id },
      traceId: 't',
    };
    return { company, ctx, ceoId: ceo.id, userId };
  }

  async function addManager(ctx: RequestContext): Promise<string> {
    const userId = await newUser('manager');
    const member = await members.addHumanMember(ctx, { userId, role: 'manager' });
    return member.id;
  }

  const dept = (ctx: RequestContext, name: string, parentId?: string): Promise<OrgUnit> =>
    org.upsertOrgUnit(ctx, { kind: 'department', name, parentId: parentId ?? null });

  beforeAll(async () => {
    infra = await startInfra({ postgres: true, redis: false });
    initDatabase(await prepareDatabase(infra));
    await seedDatabase(infra);
    owner = new pg.Pool({ connectionString: infra.databaseMigrationUrl, max: 2 });

    const moduleRef = await Test.createTestingModule({
      providers: [
        OrganizationService,
        OrganizationRepository,
        HumanMemberService,
        EmployeeRepository,
        EventPublisher,
        { provide: IDENTITY_DIRECTORY, useValue: identity },
        { provide: TASK_ENGINE, useValue: tasks },
        {
          provide: EMPLOYEE_ENGINE,
          inject: [HumanMemberService],
          useFactory: (m: HumanMemberService) => employeeEngineWithMembers(employees, () => m),
        },
      ],
    }).compile();
    org = moduleRef.get(OrganizationService);
    members = moduleRef.get(HumanMemberService);
  });

  beforeEach(() => {
    employees.employees.clear();
    tasks.tasks = [];
  });

  afterAll(async () => {
    await owner?.end();
    await closeDatabase();
    await infra?.stop();
  });

  describe('createCompany', () => {
    it('tạo company cùng CEO là người tạo, sơ đồ trống khi không chọn template', async () => {
      const { company, ctx, userId } = await bootstrap();
      expect(company).toMatchObject({ templateKey: null, timezone: 'Asia/Ho_Chi_Minh' });
      const list = await members.listHumanMembers(ctx);
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ role: 'ceo', userId });
      expect((await org.getCompany(ctx)).id).toBe(company.id);
      expect((await org.getOrgChart(ctx)).roots).toEqual([]);
    });

    it('áp template software_company sinh ba phòng ban Development, BA, QA (US1-AS1)', async () => {
      const { company, ctx } = await bootstrap('software_company');
      expect(company.templateKey).toBe('software_company');
      const chart = await org.getOrgChart(ctx);
      expect(chart.roots.map((n) => [n.name, n.kind])).toEqual([
        ['Development', 'department'],
        ['BA', 'department'],
        ['QA', 'department'],
      ]);
      expect(chart.roots.every((n) => n.children.length === 0 && n.teams.length === 0)).toBe(true);
    });

    it('template chỉ là bản sao: sửa cơ cấu công ty không đổi template (FR-003)', async () => {
      const { ctx } = await bootstrap('software_company');
      const chart = await org.getOrgChart(ctx);
      await org.upsertOrgUnit(ctx, { id: findNode(chart, 'QA').id, name: 'Quality' });
      const { ctx: other } = await bootstrap('software_company');
      expect((await org.getOrgChart(other)).roots.map((n) => n.name)).toEqual([
        'Development',
        'BA',
        'QA',
      ]);
    });

    it('template không tồn tại → VALIDATION_FAILED và không để lại company nào', async () => {
      const name = `Không-template-${randomUUID().slice(0, 6)}`;
      const userId = await newUser('x');
      const error = await rejection(
        org.createCompany({ userId, traceId: 't' }, { name, templateKey: 'khong_ton_tai' }),
      );
      expect(error.code).toBe('VALIDATION_FAILED');
      const left = await owner.query(`select count(*)::int as n from company where name = $1`, [
        name,
      ]);
      expect(left.rows[0].n).toBe(0);
    });

    it('ghi domain_event company.created và org_unit.created cùng transaction, seq liên tục', async () => {
      const { company } = await bootstrap('software_company');
      const events = await withTenant(company.id, (tx) =>
        tx.select().from(domainEvent).orderBy(asc(domainEvent.seq)),
      );
      expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
      const types = events.map((e) => e.type);
      expect(types).toContain('company.created');
      expect(types.filter((t) => t === 'org_unit.created')).toHaveLength(3);
    });
  });

  describe('upsertOrgUnit và sơ đồ tổ chức', () => {
    it('dựng cây Division → Department và hiển thị đúng thứ tự sortOrder', async () => {
      const { ctx } = await bootstrap();
      const div = await org.upsertOrgUnit(ctx, { kind: 'division', name: 'Engineering' });
      const a = await dept(ctx, 'Backend', div.id);
      const b = await dept(ctx, 'Frontend', div.id);
      expect(div).toMatchObject({ kind: 'division', parentId: null, archivedAt: null });
      expect(a.sortOrder).toBeLessThan(b.sortOrder);

      await org.upsertOrgUnit(ctx, { id: b.id, sortOrder: 0 });
      await org.upsertOrgUnit(ctx, { id: a.id, sortOrder: 5 });
      const chart = await org.getOrgChart(ctx);
      expect(chart.roots).toHaveLength(1);
      expect(chart.roots[0]?.children.map((c) => c.name)).toEqual(['Frontend', 'Backend']);
    });

    it('đổi tên và chuyển đơn vị sang division khác được phản ánh ngay (US1-AS2)', async () => {
      const { ctx } = await bootstrap();
      const d1 = await org.upsertOrgUnit(ctx, { kind: 'division', name: 'D1' });
      const d2 = await org.upsertOrgUnit(ctx, { kind: 'division', name: 'D2' });
      const unit = await dept(ctx, 'Ops', d1.id);

      await org.upsertOrgUnit(ctx, { id: unit.id, name: 'Operations', parentId: d2.id });
      const chart = await org.getOrgChart(ctx);
      expect(findNode(chart, 'D1').children).toEqual([]);
      expect(findNode(chart, 'D2').children.map((c) => c.name)).toEqual(['Operations']);
    });

    it('tên phải duy nhất trong cùng parent, khác parent thì được; archive xong dùng lại được tên', async () => {
      const { ctx } = await bootstrap();
      const d1 = await org.upsertOrgUnit(ctx, { kind: 'division', name: 'D1' });
      const d2 = await org.upsertOrgUnit(ctx, { kind: 'division', name: 'D2' });
      const first = await dept(ctx, 'QA', d1.id);

      expect((await rejection(dept(ctx, 'QA', d1.id))).code).toBe('CONFLICT');
      await expect(dept(ctx, 'QA', d2.id)).resolves.toMatchObject({ name: 'QA' });

      await org.archiveOrgUnit(ctx, first.id);
      await expect(dept(ctx, 'QA', d1.id)).resolves.toMatchObject({ name: 'QA' });
    });

    it('parent phải là division; department không lồng trong department', async () => {
      const { ctx } = await bootstrap();
      const parent = await dept(ctx, 'Dev');
      const error = await rejection(dept(ctx, 'Con', parent.id));
      expect(error.code).toBe('VALIDATION_FAILED');
    });

    it('không cho chuyển division vào chính cây con của nó', async () => {
      const { ctx } = await bootstrap();
      const outer = await org.upsertOrgUnit(ctx, { kind: 'division', name: 'Outer' });
      const inner = await org.upsertOrgUnit(ctx, {
        kind: 'division',
        name: 'Inner',
        parentId: outer.id,
      });
      expect(
        (await rejection(org.upsertOrgUnit(ctx, { id: outer.id, parentId: inner.id }))).code,
      ).toBe('VALIDATION_FAILED');
      expect(
        (await rejection(org.upsertOrgUnit(ctx, { id: outer.id, parentId: outer.id }))).code,
      ).toBe('VALIDATION_FAILED');
    });

    it('tạo thiếu kind hoặc name → VALIDATION_FAILED; đổi kind sau khi tạo bị chặn', async () => {
      const { ctx } = await bootstrap();
      expect((await rejection(org.upsertOrgUnit(ctx, { name: 'X' }))).code).toBe(
        'VALIDATION_FAILED',
      );
      expect((await rejection(org.upsertOrgUnit(ctx, { kind: 'department' }))).code).toBe(
        'VALIDATION_FAILED',
      );
      const unit = await dept(ctx, 'Dev');
      expect(
        (await rejection(org.upsertOrgUnit(ctx, { id: unit.id, kind: 'division' }))).code,
      ).toBe('VALIDATION_FAILED');
    });

    it('employeeCount của division cộng dồn nhân viên của đơn vị con; nhân viên archived không tính', async () => {
      const { ctx } = await bootstrap();
      const div = await org.upsertOrgUnit(ctx, { kind: 'division', name: 'Eng' });
      const backend = await dept(ctx, 'Backend', div.id);
      const qa = await dept(ctx, 'QA', div.id);
      employees
        .add(makeEmployeeProfile({ id: newId(), homeOrgUnitId: backend.id }))
        .add(makeEmployeeProfile({ id: newId(), homeOrgUnitId: backend.id }))
        .add(makeEmployeeProfile({ id: newId(), homeOrgUnitId: qa.id }))
        .add(makeEmployeeProfile({ id: newId(), homeOrgUnitId: qa.id, status: 'archived' }));

      const chart = await org.getOrgChart(ctx);
      expect(findNode(chart, 'Backend').employeeCount).toBe(2);
      expect(findNode(chart, 'QA').employeeCount).toBe(1);
      expect(findNode(chart, 'Eng').employeeCount).toBe(3);
    });

    it('đơn vị của công ty khác không truy cập được (tenant)', async () => {
      const a = await bootstrap();
      const b = await bootstrap();
      const unit = await dept(a.ctx, 'Riêng của A');
      expect(
        (await rejection(org.upsertOrgUnit(b.ctx, { id: unit.id, name: 'Chiếm quyền' }))).code,
      ).toBe('NOT_FOUND');
      expect((await rejection(org.archiveOrgUnit(b.ctx, unit.id))).code).toBe('NOT_FOUND');
      expect((await org.getOrgChart(b.ctx)).roots).toEqual([]);
    });
  });

  describe('archiveOrgUnit (US1-AS4)', () => {
    it('chặn khi còn đơn vị con, trả danh sách cản trở', async () => {
      const { ctx } = await bootstrap();
      const div = await org.upsertOrgUnit(ctx, { kind: 'division', name: 'Eng' });
      const child = await dept(ctx, 'Backend', div.id);

      const error = await rejection(org.archiveOrgUnit(ctx, div.id));
      expect(error.code).toBe('ORG_UNIT_NOT_EMPTY');
      expect(error.details.childUnits).toEqual([{ id: child.id, name: 'Backend' }]);
    });

    it('chặn khi còn team chưa archived', async () => {
      const { ctx } = await bootstrap();
      const unit = await dept(ctx, 'Dev');
      const team = await org.upsertTeam(ctx, { orgUnitId: unit.id, name: 'Mobile' });

      const error = await rejection(org.archiveOrgUnit(ctx, unit.id));
      expect(error.code).toBe('ORG_UNIT_NOT_EMPTY');
      expect(error.details.teams).toEqual([{ id: team.id, name: 'Mobile' }]);
    });

    it('chặn khi còn nhân viên đang hoạt động, bỏ qua nhân viên đã archived', async () => {
      const { ctx } = await bootstrap();
      const unit = await dept(ctx, 'Dev');
      const gone = makeEmployeeProfile({ id: newId(), homeOrgUnitId: unit.id, status: 'archived' });
      employees.add(gone);
      await expect(org.archiveOrgUnit(ctx, unit.id)).resolves.toBeUndefined();

      const unit2 = await dept(ctx, 'Dev 2');
      const alive = makeEmployeeProfile({ id: newId(), name: 'An', homeOrgUnitId: unit2.id });
      employees.add(alive);
      const error = await rejection(org.archiveOrgUnit(ctx, unit2.id));
      expect(error.code).toBe('ORG_UNIT_NOT_EMPTY');
      expect(error.details.employees).toEqual([{ id: alive.id, name: 'An' }]);
    });

    it('chặn khi còn task chưa kết thúc thuộc đơn vị', async () => {
      const { ctx } = await bootstrap();
      const unit = await dept(ctx, 'Dev');
      const task = makeTask({ id: newId(), title: 'Viết báo cáo' });
      tasks.tasks = [task];

      const error = await rejection(org.archiveOrgUnit(ctx, unit.id));
      expect(error.code).toBe('ORG_UNIT_NOT_EMPTY');
      expect(error.details.tasks).toEqual([{ id: task.id, title: 'Viết báo cáo' }]);
    });

    it('đơn vị trống được archive: biến khỏi sơ đồ, ghi org_unit.archived, gỡ manager', async () => {
      const { ctx, company, ceoId } = await bootstrap();
      const unit = await dept(ctx, 'Tạm');
      await org.assignManager(ctx, { kind: 'org_unit', id: unit.id }, ceoId);

      await org.archiveOrgUnit(ctx, unit.id);
      expect((await org.getOrgChart(ctx)).roots).toEqual([]);
      const events = await withTenant(company.id, (tx) => tx.select().from(domainEvent));
      expect(events.some((e) => e.type === 'org_unit.archived' && e.aggregateId === unit.id)).toBe(
        true,
      );
      const left = await owner.query(
        `select count(*)::int as n from management_assignment where target_id = $1`,
        [unit.id],
      );
      expect(left.rows[0].n).toBe(0);
    });
  });

  describe('Team', () => {
    it('tạo, đổi tên, chuyển team giữa các department; trùng tên trong cùng department bị chặn', async () => {
      const { ctx } = await bootstrap();
      const dev = await dept(ctx, 'Dev');
      const qa = await dept(ctx, 'QA');
      const mobile = await org.upsertTeam(ctx, { orgUnitId: dev.id, name: 'Mobile' });

      expect(
        (await rejection(org.upsertTeam(ctx, { orgUnitId: dev.id, name: 'Mobile' }))).code,
      ).toBe('CONFLICT');

      await org.upsertTeam(ctx, { id: mobile.id, name: 'Mobile App' });
      await org.upsertTeam(ctx, { id: mobile.id, orgUnitId: qa.id });
      const chart = await org.getOrgChart(ctx);
      expect(findNode(chart, 'Dev').teams).toEqual([]);
      expect(findNode(chart, 'QA').teams.map((t) => t.name)).toEqual(['Mobile App']);
    });

    it('team chỉ nằm trong department, không nằm trong division', async () => {
      const { ctx } = await bootstrap();
      const div = await org.upsertOrgUnit(ctx, { kind: 'division', name: 'Eng' });
      expect(
        (await rejection(org.upsertTeam(ctx, { orgUnitId: div.id, name: 'Mobile' }))).code,
      ).toBe('VALIDATION_FAILED');
    });

    it('setTeamMembers thay toàn bộ thành viên, kiểm tra thành viên tồn tại, đếm vào employeeCount của team', async () => {
      const { ctx, ceoId } = await bootstrap();
      const dev = await dept(ctx, 'Dev');
      const team = await org.upsertTeam(ctx, { orgUnitId: dev.id, name: 'Mobile' });
      const ai = makeEmployeeProfile({ id: newId(), homeOrgUnitId: dev.id });
      employees.add(ai);

      await org.setTeamMembers(ctx, team.id, [
        { kind: 'ai', id: ai.id },
        { kind: 'human', id: ceoId },
      ]);
      const full = findNode(await org.getOrgChart(ctx), 'Dev').teams[0];
      expect(full?.employeeCount).toBe(2);
      expect(full?.members).toEqual(
        expect.arrayContaining([
          { kind: 'ai', id: ai.id },
          { kind: 'human', id: ceoId },
        ]),
      );

      await org.setTeamMembers(ctx, team.id, [{ kind: 'human', id: ceoId }]);
      expect(findNode(await org.getOrgChart(ctx), 'Dev').teams[0]?.employeeCount).toBe(1);

      expect(
        (await rejection(org.setTeamMembers(ctx, team.id, [{ kind: 'ai', id: newId() }]))).code,
      ).toBe('VALIDATION_FAILED');
      expect(
        (await rejection(org.setTeamMembers(ctx, team.id, [{ kind: 'human', id: newId() }]))).code,
      ).toBe('VALIDATION_FAILED');
      // Lỗi giữ nguyên thành viên cũ.
      expect(findNode(await org.getOrgChart(ctx), 'Dev').teams[0]?.employeeCount).toBe(1);
    });

    it('archiveTeam bị chặn khi còn thành viên (TEAM_NOT_EMPTY), thành công khi trống', async () => {
      const { ctx, ceoId, company } = await bootstrap();
      const dev = await dept(ctx, 'Dev');
      const team = await org.upsertTeam(ctx, { orgUnitId: dev.id, name: 'Mobile' });
      await org.setTeamMembers(ctx, team.id, [{ kind: 'human', id: ceoId }]);

      const error = await rejection(org.archiveTeam(ctx, team.id));
      expect(error.code).toBe('TEAM_NOT_EMPTY');
      expect(error.details.members).toEqual([{ kind: 'human', id: ceoId }]);

      await org.setTeamMembers(ctx, team.id, []);
      tasks.tasks = [makeTask({ id: newId(), title: 'Việc của team' })];
      const blocked = await rejection(org.archiveTeam(ctx, team.id));
      expect(blocked.code).toBe('TEAM_NOT_EMPTY');
      expect(blocked.details.tasks).toHaveLength(1);

      tasks.tasks = [];
      await org.archiveTeam(ctx, team.id);
      expect(findNode(await org.getOrgChart(ctx), 'Dev').teams).toEqual([]);
      const events = await withTenant(company.id, (tx) => tx.select().from(domainEvent));
      expect(events.map((e) => e.type)).toEqual(
        expect.arrayContaining(['team.created', 'team.members_changed', 'team.archived']),
      );
    });
  });

  describe('assignManager (FR-005)', () => {
    it('gán người thật làm manager của department và team, gán lại thì thay thế', async () => {
      const { ctx, ceoId, company } = await bootstrap();
      const m1 = await addManager(ctx);
      const dev = await dept(ctx, 'Dev');
      const team = await org.upsertTeam(ctx, { orgUnitId: dev.id, name: 'Mobile' });

      await org.assignManager(ctx, { kind: 'org_unit', id: dev.id }, ceoId);
      await org.assignManager(ctx, { kind: 'team', id: team.id }, m1);
      let chart = await org.getOrgChart(ctx);
      expect(findNode(chart, 'Dev').managerMemberId).toBe(ceoId);
      expect(findNode(chart, 'Dev').teams[0]?.managerMemberId).toBe(m1);

      await org.assignManager(ctx, { kind: 'org_unit', id: dev.id }, m1);
      chart = await org.getOrgChart(ctx);
      expect(findNode(chart, 'Dev').managerMemberId).toBe(m1);

      const rows = await owner.query(
        `select count(*)::int as n from management_assignment where target_id = $1`,
        [dev.id],
      );
      expect(rows.rows[0].n).toBe(1);
      const events = await withTenant(company.id, (tx) => tx.select().from(domainEvent));
      expect(events.filter((e) => e.type === 'management.assigned')).toHaveLength(3);
    });

    it('chỉ nhận org_unit hoặc team làm đích; manager phải là human_member đang hoạt động', async () => {
      const { ctx, ceoId } = await bootstrap();
      const dev = await dept(ctx, 'Dev');

      expect((await rejection(org.assignManager(ctx, { kind: 'company' }, ceoId))).code).toBe(
        'VALIDATION_FAILED',
      );
      expect(
        (await rejection(org.assignManager(ctx, { kind: 'ai_employee', id: newId() }, ceoId))).code,
      ).toBe('VALIDATION_FAILED');
      expect(
        (await rejection(org.assignManager(ctx, { kind: 'org_unit', id: dev.id }, newId()))).code,
      ).toBe('VALIDATION_FAILED');
      expect(
        (await rejection(org.assignManager(ctx, { kind: 'org_unit', id: newId() }, ceoId))).code,
      ).toBe('NOT_FOUND');

      const m = await addManager(ctx);
      await owner.query(`update human_member set disabled_at = now() where id = $1`, [m]);
      expect(
        (await rejection(org.assignManager(ctx, { kind: 'org_unit', id: dev.id }, m))).code,
      ).toBe('VALIDATION_FAILED');
    });
  });

  describe('resolveManagedScope và isInScope (US1-AS3)', () => {
    /** Eng(division) ⊃ Backend(dept) ⊃ Mobile(team); Eng ⊃ Data(dept); QA(dept) ngoài Eng. */
    async function buildTree() {
      const base = await bootstrap();
      const { ctx } = base;
      const eng = await org.upsertOrgUnit(ctx, { kind: 'division', name: 'Eng' });
      const backend = await dept(ctx, 'Backend', eng.id);
      const data = await dept(ctx, 'Data', eng.id);
      const qa = await dept(ctx, 'QA');
      const mobile = await org.upsertTeam(ctx, { orgUnitId: backend.id, name: 'Mobile' });
      const qaTeam = await org.upsertTeam(ctx, { orgUnitId: qa.id, name: 'Auto' });
      const manager = await addManager(ctx);
      return { ...base, eng, backend, data, qa, mobile, qaTeam, manager };
    }

    it('CEO có phạm vi toàn công ty', async () => {
      const t = await buildTree();
      const scope = await org.resolveManagedScope(t.ctx, t.ceoId);
      expect(scope.companyWide).toBe(true);
      for (const target of [
        { kind: 'company' as const },
        { kind: 'org_unit' as const, id: t.qa.id },
        { kind: 'team' as const, id: t.mobile.id },
        { kind: 'ai_employee' as const, id: newId() },
      ]) {
        expect(await org.isInScope(t.ctx, t.ceoId, target)).toBe(true);
      }
    });

    it('manager của division mở rộng ra department con, team và nhân viên, không lan sang đơn vị ngoài', async () => {
      const t = await buildTree();
      const inBackend = makeEmployeeProfile({ id: newId(), homeOrgUnitId: t.backend.id });
      const inTeam = makeEmployeeProfile({
        id: newId(),
        homeOrgUnitId: t.qa.id,
        teamIds: [t.mobile.id],
      });
      const direct = makeEmployeeProfile({
        id: newId(),
        homeOrgUnitId: t.qa.id,
        manager: { kind: 'human', id: t.manager },
      });
      const outside = makeEmployeeProfile({ id: newId(), homeOrgUnitId: t.qa.id });
      for (const e of [inBackend, inTeam, direct, outside]) employees.add(e);
      await org.assignManager(t.ctx, { kind: 'org_unit', id: t.eng.id }, t.manager);

      const scope = await org.resolveManagedScope(t.ctx, t.manager);
      expect(scope.companyWide).toBe(false);
      expect(scope.orgUnitIds.sort()).toEqual([t.eng.id, t.backend.id, t.data.id].sort());
      expect(scope.teamIds).toEqual([t.mobile.id]);
      expect(scope.employeeIds.sort()).toEqual([inBackend.id, inTeam.id, direct.id].sort());

      const check = (target: Parameters<OrganizationEngine['isInScope']>[2]) =>
        org.isInScope(t.ctx, t.manager, target);
      expect(await check({ kind: 'company' })).toBe(false);
      expect(await check({ kind: 'org_unit', id: t.backend.id })).toBe(true);
      expect(await check({ kind: 'org_unit', id: t.qa.id })).toBe(false);
      expect(await check({ kind: 'team', id: t.mobile.id })).toBe(true);
      expect(await check({ kind: 'team', id: t.qaTeam.id })).toBe(false);
      expect(await check({ kind: 'ai_employee', id: inTeam.id })).toBe(true);
      expect(await check({ kind: 'ai_employee', id: outside.id })).toBe(false);
    });

    it('manager chỉ được gán một team thì không có quyền trên department chứa team', async () => {
      const t = await buildTree();
      const member = makeEmployeeProfile({
        id: newId(),
        homeOrgUnitId: t.backend.id,
        teamIds: [t.mobile.id],
      });
      employees.add(member);
      await org.assignManager(t.ctx, { kind: 'team', id: t.mobile.id }, t.manager);

      const scope = await org.resolveManagedScope(t.ctx, t.manager);
      expect(scope.orgUnitIds).toEqual([]);
      expect(scope.teamIds).toEqual([t.mobile.id]);
      expect(scope.employeeIds).toEqual([member.id]);
      expect(await org.isInScope(t.ctx, t.manager, { kind: 'org_unit', id: t.backend.id })).toBe(
        false,
      );
    });

    it('manager chưa được gán, đã bị vô hiệu hoặc không tồn tại thì không có phạm vi nào', async () => {
      const t = await buildTree();
      const empty = { companyWide: false, orgUnitIds: [], teamIds: [], employeeIds: [] };
      expect(await org.resolveManagedScope(t.ctx, t.manager)).toEqual(empty);

      await org.assignManager(t.ctx, { kind: 'org_unit', id: t.eng.id }, t.manager);
      await owner.query(`update human_member set disabled_at = now() where id = $1`, [t.manager]);
      expect(await org.resolveManagedScope(t.ctx, t.manager)).toEqual(empty);
      expect(await org.resolveManagedScope(t.ctx, newId())).toEqual(empty);
      expect(await org.isInScope(t.ctx, t.manager, { kind: 'org_unit', id: t.eng.id })).toBe(false);
    });

    it('đơn vị đã archived rời khỏi phạm vi', async () => {
      const t = await buildTree();
      await org.assignManager(t.ctx, { kind: 'org_unit', id: t.eng.id }, t.manager);
      await org.archiveOrgUnit(t.ctx, t.data.id);
      const scope = await org.resolveManagedScope(t.ctx, t.manager);
      expect(scope.orgUnitIds).not.toContain(t.data.id);
    });

    it('getOrgChart của manager chỉ gồm đơn vị trong phạm vi', async () => {
      const t = await buildTree();
      await org.assignManager(t.ctx, { kind: 'org_unit', id: t.eng.id }, t.manager);
      const managerCtx: RequestContext = {
        ...t.ctx,
        actor: { kind: 'human', memberId: t.manager },
      };
      const names = flatten((await org.getOrgChart(managerCtx)).roots).map((n) => n.name);
      expect(names.sort()).toEqual(['Backend', 'Data', 'Eng']);
      const full = flatten((await org.getOrgChart(t.ctx)).roots).map((n) => n.name);
      expect(full).toContain('QA');
    });
  });

  describe('resolveOrgUnitChain', () => {
    it('trả đơn vị rồi các tổ tiên, gần nhất trước', async () => {
      const { ctx } = await bootstrap();
      const top = await org.upsertOrgUnit(ctx, { kind: 'division', name: 'Top' });
      const mid = await org.upsertOrgUnit(ctx, { kind: 'division', name: 'Mid', parentId: top.id });
      const leaf = await dept(ctx, 'Leaf', mid.id);
      expect(await org.resolveOrgUnitChain(ctx, leaf.id)).toEqual([leaf.id, mid.id, top.id]);
      expect(await org.resolveOrgUnitChain(ctx, top.id)).toEqual([top.id]);
    });
  });

  describe('getOrgUnit và listTeamMemberships (D4, cho EmployeeEngine)', () => {
    it('getOrgUnit trả đơn vị đang hoạt động, null khi đã archived, ở công ty khác hoặc không tồn tại', async () => {
      const a = await bootstrap();
      const b = await bootstrap();
      const unit = await dept(a.ctx, 'Có thật');
      expect(await org.getOrgUnit(a.ctx, unit.id)).toMatchObject({
        id: unit.id,
        kind: 'department',
      });
      expect(await org.getOrgUnit(b.ctx, unit.id)).toBeNull();
      expect(await org.getOrgUnit(a.ctx, randomUUID())).toBeNull();
      await org.archiveOrgUnit(a.ctx, unit.id);
      expect(await org.getOrgUnit(a.ctx, unit.id)).toBeNull();
    });

    it('listTeamMemberships chỉ trả quan hệ của team chưa archived', async () => {
      const { ctx } = await bootstrap();
      const unit = await dept(ctx, 'Có team');
      const kept = await org.upsertTeam(ctx, { orgUnitId: unit.id, name: 'Giữ' });
      const emptied = await org.upsertTeam(ctx, { orgUnitId: unit.id, name: 'Dọn' });
      const aiId = newId();
      employees.add(makeEmployeeProfile({ id: aiId, homeOrgUnitId: unit.id }));
      await org.setTeamMembers(ctx, kept.id, [{ kind: 'ai', id: aiId }]);
      await org.setTeamMembers(ctx, emptied.id, []);
      await org.archiveTeam(ctx, emptied.id);
      expect(await org.listTeamMemberships(ctx)).toEqual([
        { teamId: kept.id, memberKind: 'ai', memberId: aiId },
      ]);
    });
  });

  describe('getCompany', () => {
    it('chỉ trả công ty của ctx', async () => {
      const a = await bootstrap();
      const b = await bootstrap();
      const companyA: Company = await org.getCompany(a.ctx);
      expect(companyA.id).toBe(a.company.id);
      expect((await org.getCompany(b.ctx)).id).toBe(b.company.id);
    });
  });
});
