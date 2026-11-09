import { Inject, Injectable } from '@nestjs/common';
import {
  DomainError,
  orgTemplateDefinitionSchema,
  type BootstrapContext,
  type Company,
  type EmployeeEngine,
  type ManagedScope,
  type MemberRef,
  type OrgChart,
  type OrgChartNode,
  type OrgChartTeam,
  type OrgTemplateSummary,
  type OrgTemplateUnit,
  type OrgUnit,
  type OrgUnitBlockers,
  type OrganizationEngine,
  type RequestContext,
  type ScopeRef,
  type TaskEngine,
  type TaskStatus,
  type Team,
  type TeamBlockers,
  type TeamMembershipRef,
  type UpsertOrgUnitInput,
  type UpsertTeamInput,
} from '@claude-company/contracts';
import { newId, withGlobal, withTenant, type Tx } from '@claude-company/db';
import { EMPLOYEE_ENGINE, TASK_ENGINE } from '../../platform/engine-tokens';
import { EventPublisher } from '../../platform/events/event-publisher';
import { inTenant, runWithTenantTx } from '../../platform/tenancy/tenant-store';
import {
  OrganizationRepository,
  pgErrorCode,
  UNIQUE_VIOLATION,
  type CompanyRow,
  type OrgUnitRow,
  type TeamRow,
} from './organization.repository';

/** Task chưa kết thúc: chặn archive đơn vị/team còn task loại này (FR-002). */
const OPEN_TASK_STATUSES: TaskStatus[] = [
  'draft',
  'assigned',
  'in_progress',
  'in_review',
  'awaiting_human_approval',
  'blocked',
];

/** Số mục tối đa trả về trong danh sách cản trở khi archive. */
const BLOCKER_LIMIT = 50;

/** Chặn vòng lặp vô hạn khi duyệt cây nếu dữ liệu bị hỏng. */
const MAX_TREE_DEPTH = 64;

const emptyScope = (): ManagedScope => ({
  companyWide: false,
  orgUnitIds: [],
  teamIds: [],
  employeeIds: [],
});

type EmployeeOps = Pick<EmployeeEngine, 'addHumanMember' | 'listHumanMembers' | 'list'>;
type TaskOps = Pick<TaskEngine, 'list'>;

const toCompany = (row: CompanyRow): Company => ({
  id: row.id,
  name: row.name,
  timezone: row.timezone,
  templateKey: row.templateKey,
  archivedAt: row.archivedAt?.toISOString() ?? null,
});

const toOrgUnit = (row: OrgUnitRow): OrgUnit => ({
  id: row.id,
  kind: row.kind,
  parentId: row.parentId,
  name: row.name,
  sortOrder: row.sortOrder,
  archivedAt: row.archivedAt?.toISOString() ?? null,
});

const toTeam = (row: TeamRow): Team => ({
  id: row.id,
  orgUnitId: row.orgUnitId,
  name: row.name,
  sortOrder: row.sortOrder,
  archivedAt: row.archivedAt?.toISOString() ?? null,
});

function cleanName(value: string | undefined, field = 'name'): string {
  const name = value?.trim();
  if (!name || name.length > 120) {
    throw new DomainError('VALIDATION_FAILED', 'Tên phải dài 1–120 ký tự', { field });
  }
  return name;
}

/**
 * Organization Engine: công ty, cây Division/Department, Team, manager theo phạm vi và cơ cấu mẫu.
 * Chỉ truy cập bảng của mình; nhân viên và task của đơn vị lấy qua interface của engine sở hữu chúng.
 */
@Injectable()
export class OrganizationService implements OrganizationEngine {
  constructor(
    private readonly repo: OrganizationRepository,
    private readonly events: EventPublisher,
    @Inject(EMPLOYEE_ENGINE) private readonly employees: EmployeeOps,
    @Inject(TASK_ENGINE) private readonly tasks: TaskOps,
  ) {}

  // --- company ---

  async createCompany(
    ctx: BootstrapContext,
    input: { name: string; templateKey?: string },
  ): Promise<Company> {
    const name = cleanName(input.name);
    const companyId = newId();
    const systemCtx: RequestContext = {
      companyId,
      actor: { kind: 'system' },
      traceId: ctx.traceId,
    };
    // Cùng một transaction cho company, CEO, cơ cấu mẫu và domain_event: lỗi ở bước nào cũng không để lại gì.
    return withTenant(
      companyId,
      (tx) =>
        runWithTenantTx(companyId, tx, async () => {
          const definition = input.templateKey
            ? await this.loadTemplate(tx, input.templateKey)
            : undefined;
          const row = await this.repo.insertCompany(tx, {
            id: companyId,
            name,
            templateKey: input.templateKey ?? null,
          });
          await this.employees.addHumanMember(systemCtx, { userId: ctx.userId, role: 'ceo' });
          await this.events.publish(tx, systemCtx, {
            type: 'company.created',
            aggregateKind: 'company',
            aggregateId: companyId,
            payload: { name, templateKey: input.templateKey ?? null },
          });
          if (definition) await this.applyTemplate(tx, systemCtx, definition, null);
          return toCompany(row);
        }),
      { userId: ctx.userId },
    );
  }

  private async loadTemplate(tx: Tx, key: string): Promise<OrgTemplateUnit[]> {
    const template = await this.repo.findTemplate(tx, key);
    if (!template) {
      throw new DomainError('VALIDATION_FAILED', 'Cơ cấu mẫu không tồn tại', {
        field: 'templateKey',
      });
    }
    return orgTemplateDefinitionSchema.parse(template.definition).units;
  }

  /** Sao chép cây mẫu thành bản ghi độc lập; sau đó mẫu không còn ràng buộc gì (FR-003). */
  private async applyTemplate(
    tx: Tx,
    ctx: RequestContext,
    units: OrgTemplateUnit[],
    parentId: string | null,
  ): Promise<void> {
    for (const [index, unit] of units.entries()) {
      if (unit.kind === 'department' && unit.children?.length) {
        throw new DomainError(
          'VALIDATION_FAILED',
          'Cơ cấu mẫu không hợp lệ: department có đơn vị con',
        );
      }
      if (unit.kind !== 'department' && unit.teams?.length) {
        throw new DomainError(
          'VALIDATION_FAILED',
          'Cơ cấu mẫu không hợp lệ: chỉ department có team',
        );
      }
      const row = await this.repo.insertOrgUnit(tx, {
        companyId: ctx.companyId,
        kind: unit.kind,
        parentId,
        name: unit.name,
        sortOrder: index,
      });
      await this.publishUnitCreated(tx, ctx, row);
      for (const [teamIndex, teamName] of (unit.teams ?? []).entries()) {
        const teamRow = await this.repo.insertTeam(tx, {
          companyId: ctx.companyId,
          orgUnitId: row.id,
          name: teamName,
          sortOrder: teamIndex,
        });
        await this.publishTeamCreated(tx, ctx, teamRow);
      }
      await this.applyTemplate(tx, ctx, unit.children ?? [], row.id);
    }
  }

  /** Danh sách cơ cấu mẫu (`GET /org-templates`). Bảng toàn cục nên không cần tenant. */
  async listTemplates(): Promise<OrgTemplateSummary[]> {
    const rows = await withGlobal((tx) => this.repo.listTemplates(tx));
    return rows.map((r) => ({ key: r.key, name: r.name }));
  }

  async getCompany(ctx: RequestContext): Promise<Company> {
    const row = await inTenant(ctx, (tx) => this.repo.findCompany(tx, ctx.companyId));
    if (!row) throw new DomainError('NOT_FOUND', 'Không tìm thấy công ty');
    return toCompany(row);
  }

  // --- sơ đồ tổ chức ---

  async getOrgChart(ctx: RequestContext): Promise<OrgChart> {
    const data = await inTenant(ctx, async (tx) => ({
      units: await this.repo.listActiveOrgUnits(tx, ctx.companyId),
      teams: await this.repo.listActiveTeams(tx, ctx.companyId),
      memberships: await this.repo.listTeamMemberships(tx, ctx.companyId),
      assignments: await this.repo.listAssignments(tx, ctx.companyId),
    }));
    const scope = await this.scopeOf(ctx);
    const employees = (await this.employees.list(ctx, {})).filter((e) => e.status !== 'archived');

    const managerOf = new Map(
      data.assignments.map((a) => [`${a.targetKind}:${a.targetId}`, a.managerMemberId]),
    );
    const ownCount = new Map<string, number>();
    for (const e of employees) {
      ownCount.set(e.homeOrgUnitId, (ownCount.get(e.homeOrgUnitId) ?? 0) + 1);
    }
    const teamMembers = new Map<string, MemberRef[]>();
    for (const m of data.memberships) {
      teamMembers.set(m.teamId, [
        ...(teamMembers.get(m.teamId) ?? []),
        { kind: m.memberKind, id: m.memberId },
      ]);
    }

    const scopedUnits = new Set(scope.orgUnitIds);
    const scopedTeams = new Set(scope.teamIds);
    const visibleUnit = (id: string) => scope.companyWide || scopedUnits.has(id);
    const visibleTeam = (id: string) => scope.companyWide || scopedTeams.has(id);

    const nodes = new Map<string, OrgChartNode>();
    for (const u of data.units) {
      if (!visibleUnit(u.id)) continue;
      nodes.set(u.id, {
        ...toOrgUnit(u),
        managerMemberId: managerOf.get(`org_unit:${u.id}`) ?? null,
        employeeCount: ownCount.get(u.id) ?? 0,
        teams: [],
        children: [],
      });
    }
    for (const t of data.teams) {
      const node = nodes.get(t.orgUnitId);
      if (!node || !visibleTeam(t.id)) continue;
      const entry: OrgChartTeam = {
        ...toTeam(t),
        managerMemberId: managerOf.get(`team:${t.id}`) ?? null,
        employeeCount: teamMembers.get(t.id)?.length ?? 0,
        members: teamMembers.get(t.id) ?? [],
      };
      node.teams.push(entry);
    }
    // Đơn vị hiển thị mà đơn vị cha ngoài phạm vi trở thành gốc của sơ đồ người xem.
    const roots: OrgChartNode[] = [];
    for (const u of data.units) {
      const node = nodes.get(u.id);
      if (!node) continue;
      const parent = u.parentId ? nodes.get(u.parentId) : undefined;
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
    // Nhân viên đếm cộng dồn lên đơn vị cha (sau khi cây đã dựng xong).
    const accumulate = (node: OrgChartNode): number => {
      node.employeeCount += node.children.reduce((sum, c) => sum + accumulate(c), 0);
      return node.employeeCount;
    };
    roots.forEach(accumulate);

    return { companyId: ctx.companyId, roots };
  }

  // --- org_unit ---

  async upsertOrgUnit(ctx: RequestContext, input: UpsertOrgUnitInput): Promise<OrgUnit> {
    return inTenant(ctx, (tx) =>
      input.id ? this.updateOrgUnit(tx, ctx, input.id, input) : this.createOrgUnit(tx, ctx, input),
    );
  }

  private async createOrgUnit(
    tx: Tx,
    ctx: RequestContext,
    input: UpsertOrgUnitInput,
  ): Promise<OrgUnit> {
    const kind = input.kind;
    if (!kind) {
      throw new DomainError('VALIDATION_FAILED', 'Thiếu loại đơn vị', { field: 'kind' });
    }
    const name = cleanName(input.name);
    const parentId = input.parentId ?? null;
    await this.assertValidParent(tx, ctx, parentId);
    const sortOrder =
      input.sortOrder ?? (await this.repo.nextOrgUnitSortOrder(tx, ctx.companyId, parentId));
    const row = await this.onDuplicate('Đã có đơn vị cùng tên trong đơn vị cha này', () =>
      this.repo.insertOrgUnit(tx, {
        companyId: ctx.companyId,
        kind,
        parentId,
        name,
        sortOrder,
      }),
    );
    await this.publishUnitCreated(tx, ctx, row);
    return toOrgUnit(row);
  }

  private async updateOrgUnit(
    tx: Tx,
    ctx: RequestContext,
    id: string,
    input: UpsertOrgUnitInput,
  ): Promise<OrgUnit> {
    const unit = await this.requireActiveUnit(tx, ctx, id);
    if (input.kind !== undefined && input.kind !== unit.kind) {
      throw new DomainError('VALIDATION_FAILED', 'Không đổi được loại đơn vị sau khi tạo', {
        field: 'kind',
      });
    }
    const patch: Partial<Pick<OrgUnitRow, 'name' | 'parentId' | 'sortOrder'>> = {};
    if (input.name !== undefined && input.name.trim() !== unit.name) {
      patch.name = cleanName(input.name);
    }
    if (input.parentId !== undefined && input.parentId !== unit.parentId) {
      await this.assertValidParent(tx, ctx, input.parentId, unit.id);
      patch.parentId = input.parentId;
    }
    if (input.sortOrder !== undefined && input.sortOrder !== unit.sortOrder) {
      patch.sortOrder = input.sortOrder;
    }
    if (Object.keys(patch).length === 0) return toOrgUnit(unit);

    const row = await this.onDuplicate('Đã có đơn vị cùng tên trong đơn vị cha này', () =>
      this.repo.updateOrgUnit(tx, ctx.companyId, id, patch),
    );
    await this.events.publish(tx, ctx, {
      type: 'org_unit.updated',
      aggregateKind: 'org_unit',
      aggregateId: id,
      payload: { orgUnitId: id, changed: Object.keys(patch) },
    });
    return toOrgUnit(row);
  }

  /**
   * Parent của mọi đơn vị là division (hoặc không có). Khi chuyển đơn vị (`movingId`),
   * parent mới không được là chính nó hay con cháu của nó.
   */
  private async assertValidParent(
    tx: Tx,
    ctx: RequestContext,
    parentId: string | null,
    movingId?: string,
  ): Promise<void> {
    if (parentId === null) return;
    const parent = await this.repo.findOrgUnit(tx, ctx.companyId, parentId);
    if (!parent || parent.archivedAt) {
      throw new DomainError('NOT_FOUND', 'Đơn vị cha không tồn tại hoặc đã lưu trữ');
    }
    if (parent.kind !== 'division') {
      throw new DomainError('VALIDATION_FAILED', 'Đơn vị cha phải là division', {
        field: 'parentId',
      });
    }
    if (movingId === undefined) return;
    let cursor: OrgUnitRow | undefined = parent;
    for (let depth = 0; cursor && depth < MAX_TREE_DEPTH; depth++) {
      if (cursor.id === movingId) {
        throw new DomainError(
          'VALIDATION_FAILED',
          'Không thể chuyển đơn vị vào chính nó hoặc đơn vị con của nó',
          { field: 'parentId' },
        );
      }
      cursor = cursor.parentId
        ? await this.repo.findOrgUnit(tx, ctx.companyId, cursor.parentId)
        : undefined;
    }
  }

  async archiveOrgUnit(ctx: RequestContext, id: string): Promise<void> {
    await inTenant(ctx, async (tx) => {
      const unit = await this.requireActiveUnit(tx, ctx, id);
      const [units, teams, employees, tasks] = await Promise.all([
        this.repo.listActiveOrgUnits(tx, ctx.companyId),
        this.repo.listActiveTeams(tx, ctx.companyId),
        this.employees.list(ctx, { orgUnitId: id }),
        this.tasks.list(ctx, { orgUnitId: id, statusIn: OPEN_TASK_STATUSES, limit: BLOCKER_LIMIT }),
      ]);
      const blockers: OrgUnitBlockers = {
        childUnits: units.filter((u) => u.parentId === id).map((u) => ({ id: u.id, name: u.name })),
        teams: teams.filter((t) => t.orgUnitId === id).map((t) => ({ id: t.id, name: t.name })),
        employees: employees
          .filter((e) => e.status !== 'archived')
          .map((e) => ({ id: e.id, name: e.name })),
        tasks: tasks.items.map((t) => ({ id: t.id, title: t.title })),
      };
      if (Object.values(blockers).some((list) => list.length > 0)) {
        throw new DomainError(
          'ORG_UNIT_NOT_EMPTY',
          'Đơn vị còn đơn vị con, team, nhân viên hoặc task chưa kết thúc',
          { ...blockers },
        );
      }
      await this.repo.updateOrgUnit(tx, ctx.companyId, id, { archivedAt: new Date() });
      await this.repo.deleteAssignmentsOf(tx, ctx.companyId, 'org_unit', [id]);
      await this.events.publish(tx, ctx, {
        type: 'org_unit.archived',
        aggregateKind: 'org_unit',
        aggregateId: id,
        payload: { orgUnitId: id, kind: unit.kind, parentId: unit.parentId },
      });
    });
  }

  // --- team ---

  async upsertTeam(ctx: RequestContext, input: UpsertTeamInput): Promise<Team> {
    return inTenant(ctx, (tx) =>
      input.id ? this.updateTeam(tx, ctx, input.id, input) : this.createTeam(tx, ctx, input),
    );
  }

  private async createTeam(tx: Tx, ctx: RequestContext, input: UpsertTeamInput): Promise<Team> {
    const orgUnitId = input.orgUnitId;
    if (!orgUnitId) {
      throw new DomainError('VALIDATION_FAILED', 'Thiếu department của team', {
        field: 'orgUnitId',
      });
    }
    const name = cleanName(input.name);
    await this.assertTeamHome(tx, ctx, orgUnitId);
    const sortOrder =
      input.sortOrder ?? (await this.repo.nextTeamSortOrder(tx, ctx.companyId, orgUnitId));
    const row = await this.onDuplicate('Đã có team cùng tên trong đơn vị này', () =>
      this.repo.insertTeam(tx, {
        companyId: ctx.companyId,
        orgUnitId,
        name,
        sortOrder,
      }),
    );
    await this.publishTeamCreated(tx, ctx, row);
    return toTeam(row);
  }

  private async updateTeam(
    tx: Tx,
    ctx: RequestContext,
    id: string,
    input: UpsertTeamInput,
  ): Promise<Team> {
    const current = await this.requireActiveTeam(tx, ctx, id);
    const patch: Partial<Pick<TeamRow, 'name' | 'orgUnitId' | 'sortOrder'>> = {};
    if (input.name !== undefined && input.name.trim() !== current.name) {
      patch.name = cleanName(input.name);
    }
    if (input.orgUnitId !== undefined && input.orgUnitId !== current.orgUnitId) {
      await this.assertTeamHome(tx, ctx, input.orgUnitId);
      patch.orgUnitId = input.orgUnitId;
    }
    if (input.sortOrder !== undefined && input.sortOrder !== current.sortOrder) {
      patch.sortOrder = input.sortOrder;
    }
    if (Object.keys(patch).length === 0) return toTeam(current);

    const row = await this.onDuplicate('Đã có team cùng tên trong đơn vị này', () =>
      this.repo.updateTeam(tx, ctx.companyId, id, patch),
    );
    await this.events.publish(tx, ctx, {
      type: 'team.updated',
      aggregateKind: 'team',
      aggregateId: id,
      payload: { teamId: id, orgUnitId: row.orgUnitId, changed: Object.keys(patch) },
    });
    return toTeam(row);
  }

  /** Team luôn nằm trong một department đang hoạt động (data-model: department "nhà" của team). */
  private async assertTeamHome(tx: Tx, ctx: RequestContext, orgUnitId: string): Promise<void> {
    const unit = await this.repo.findOrgUnit(tx, ctx.companyId, orgUnitId);
    if (!unit || unit.archivedAt) {
      throw new DomainError('NOT_FOUND', 'Đơn vị không tồn tại hoặc đã lưu trữ');
    }
    if (unit.kind !== 'department') {
      throw new DomainError('VALIDATION_FAILED', 'Team chỉ nằm trong department', {
        field: 'orgUnitId',
      });
    }
  }

  async archiveTeam(ctx: RequestContext, id: string): Promise<void> {
    await inTenant(ctx, async (tx) => {
      const current = await this.requireActiveTeam(tx, ctx, id);
      const [members, tasks] = await Promise.all([
        this.repo.listMembersOfTeam(tx, ctx.companyId, id),
        this.tasks.list(ctx, {
          assigneeKind: 'team',
          assigneeId: id,
          statusIn: OPEN_TASK_STATUSES,
          limit: BLOCKER_LIMIT,
        }),
      ]);
      const blockers: TeamBlockers = {
        members: members.map((m) => ({ kind: m.memberKind, id: m.memberId })),
        tasks: tasks.items.map((t) => ({ id: t.id, title: t.title })),
      };
      if (blockers.members.length > 0 || blockers.tasks.length > 0) {
        throw new DomainError('TEAM_NOT_EMPTY', 'Team còn thành viên hoặc task chưa kết thúc', {
          ...blockers,
        });
      }
      await this.repo.updateTeam(tx, ctx.companyId, id, { archivedAt: new Date() });
      await this.repo.deleteAssignmentsOf(tx, ctx.companyId, 'team', [id]);
      await this.events.publish(tx, ctx, {
        type: 'team.archived',
        aggregateKind: 'team',
        aggregateId: id,
        payload: { teamId: id, orgUnitId: current.orgUnitId },
      });
    });
  }

  async setTeamMembers(ctx: RequestContext, teamId: string, members: MemberRef[]): Promise<void> {
    const unique = [...new Map(members.map((m) => [`${m.kind}:${m.id}`, m])).values()];
    await inTenant(ctx, async (tx) => {
      await this.requireActiveTeam(tx, ctx, teamId);
      await this.assertMembersExist(ctx, unique);
      await this.repo.replaceTeamMembers(tx, ctx.companyId, teamId, unique);
      await this.events.publish(tx, ctx, {
        type: 'team.members_changed',
        aggregateKind: 'team',
        aggregateId: teamId,
        payload: { teamId, memberCount: unique.length },
      });
    });
  }

  private async assertMembersExist(ctx: RequestContext, members: MemberRef[]): Promise<void> {
    const ai = members.filter((m) => m.kind === 'ai');
    const human = members.filter((m) => m.kind === 'human');
    const known = new Set<string>();
    if (ai.length > 0) {
      for (const e of await this.employees.list(ctx, {})) {
        if (e.status !== 'archived') known.add(`ai:${e.id}`);
      }
    }
    if (human.length > 0) {
      for (const h of await this.employees.listHumanMembers(ctx)) known.add(`human:${h.id}`);
    }
    for (const m of members) {
      if (!known.has(`${m.kind}:${m.id}`)) {
        throw new DomainError(
          'VALIDATION_FAILED',
          'Thành viên không tồn tại hoặc đã ngừng hoạt động',
          {
            field: 'members',
            memberKind: m.kind,
            memberId: m.id,
          },
        );
      }
    }
  }

  // --- manager và phạm vi ---

  async assignManager(
    ctx: RequestContext,
    target: ScopeRef,
    managerMemberId: string,
  ): Promise<void> {
    if ((target.kind !== 'org_unit' && target.kind !== 'team') || !target.id) {
      throw new DomainError('VALIDATION_FAILED', 'Chỉ gán manager cho đơn vị hoặc team', {
        field: 'targetKind',
      });
    }
    const targetKind = target.kind;
    const targetId = target.id;
    await inTenant(ctx, async (tx) => {
      if (targetKind === 'org_unit') await this.requireActiveUnit(tx, ctx, targetId);
      else await this.requireActiveTeam(tx, ctx, targetId);
      const humans = await this.employees.listHumanMembers(ctx);
      if (!humans.some((h) => h.id === managerMemberId)) {
        throw new DomainError(
          'VALIDATION_FAILED',
          'Manager phải là thành viên người thật đang hoạt động của công ty',
          { field: 'managerMemberId' },
        );
      }
      await this.repo.upsertAssignment(tx, {
        companyId: ctx.companyId,
        targetKind,
        targetId,
        managerMemberId,
      });
      await this.events.publish(tx, ctx, {
        type: 'management.assigned',
        aggregateKind: targetKind,
        aggregateId: targetId,
        payload: { targetKind, targetId, managerMemberId },
      });
    });
  }

  async resolveManagedScope(ctx: RequestContext, memberId: string): Promise<ManagedScope> {
    const member = (await this.employees.listHumanMembers(ctx)).find((m) => m.id === memberId);
    if (!member) return emptyScope();
    if (member.role === 'ceo') return { ...emptyScope(), companyWide: true };

    const { units, teams, assignments } = await inTenant(ctx, async (tx) => ({
      units: await this.repo.listActiveOrgUnits(tx, ctx.companyId),
      teams: await this.repo.listActiveTeams(tx, ctx.companyId),
      assignments: await this.repo.listAssignments(tx, ctx.companyId),
    }));
    const mine = assignments.filter((a) => a.managerMemberId === memberId);

    const childrenOf = new Map<string, string[]>();
    for (const u of units) {
      if (u.parentId) childrenOf.set(u.parentId, [...(childrenOf.get(u.parentId) ?? []), u.id]);
    }
    const activeUnitIds = new Set(units.map((u) => u.id));
    const orgUnitIds = new Set<string>();
    const queue = mine
      .filter((a) => a.targetKind === 'org_unit' && activeUnitIds.has(a.targetId))
      .map((a) => a.targetId);
    while (queue.length > 0) {
      const id = queue.pop()!;
      if (orgUnitIds.has(id)) continue;
      orgUnitIds.add(id);
      queue.push(...(childrenOf.get(id) ?? []));
    }

    const assignedTeams = new Set(
      mine.filter((a) => a.targetKind === 'team').map((a) => a.targetId),
    );
    const teamIds = new Set<string>();
    for (const t of teams) {
      if (orgUnitIds.has(t.orgUnitId) || assignedTeams.has(t.id)) teamIds.add(t.id);
    }

    const employeeIds: string[] = [];
    for (const e of await this.employees.list(ctx, {})) {
      if (e.status === 'archived') continue;
      const managedDirectly = e.manager.kind === 'human' && e.manager.id === memberId;
      if (
        managedDirectly ||
        orgUnitIds.has(e.homeOrgUnitId) ||
        e.teamIds.some((t) => teamIds.has(t))
      ) {
        employeeIds.push(e.id);
      }
    }

    return {
      companyWide: false,
      orgUnitIds: [...orgUnitIds],
      teamIds: [...teamIds],
      employeeIds,
    };
  }

  async isInScope(ctx: RequestContext, memberId: string, target: ScopeRef): Promise<boolean> {
    const scope = await this.resolveManagedScope(ctx, memberId);
    if (scope.companyWide) return true;
    if (target.kind === 'company' || target.id === undefined) return false;
    switch (target.kind) {
      case 'org_unit':
        return scope.orgUnitIds.includes(target.id);
      case 'team':
        return scope.teamIds.includes(target.id);
      case 'ai_employee':
        return scope.employeeIds.includes(target.id);
    }
  }

  async getOrgUnit(ctx: RequestContext, id: string): Promise<OrgUnit | null> {
    const row = await inTenant(ctx, (tx) => this.repo.findOrgUnit(tx, ctx.companyId, id));
    return row && !row.archivedAt ? toOrgUnit(row) : null;
  }

  async listTeamMemberships(ctx: RequestContext): Promise<TeamMembershipRef[]> {
    const { teams, memberships } = await inTenant(ctx, async (tx) => ({
      teams: await this.repo.listActiveTeams(tx, ctx.companyId),
      memberships: await this.repo.listTeamMemberships(tx, ctx.companyId),
    }));
    const active = new Set(teams.map((t) => t.id));
    return memberships
      .filter((m) => active.has(m.teamId))
      .map((m) => ({ teamId: m.teamId, memberKind: m.memberKind, memberId: m.memberId }));
  }

  async resolveOrgUnitChain(ctx: RequestContext, orgUnitId: string): Promise<string[]> {
    return inTenant(ctx, async (tx) => {
      const chain: string[] = [];
      let cursor: OrgUnitRow | undefined = await this.repo.findOrgUnit(
        tx,
        ctx.companyId,
        orgUnitId,
      );
      for (let depth = 0; cursor && depth < MAX_TREE_DEPTH; depth++) {
        chain.push(cursor.id);
        cursor = cursor.parentId
          ? await this.repo.findOrgUnit(tx, ctx.companyId, cursor.parentId)
          : undefined;
      }
      return chain.length > 0 ? chain : [orgUnitId];
    });
  }

  /** Phạm vi của người đang xem sơ đồ: hệ thống thấy tất cả, AI không thấy gì. */
  private async scopeOf(ctx: RequestContext): Promise<ManagedScope> {
    switch (ctx.actor.kind) {
      case 'human':
        return this.resolveManagedScope(ctx, ctx.actor.memberId);
      case 'system':
        return { ...emptyScope(), companyWide: true };
      case 'ai':
        return emptyScope();
    }
  }

  // --- tiện ích ---

  private async requireActiveUnit(tx: Tx, ctx: RequestContext, id: string): Promise<OrgUnitRow> {
    const row = await this.repo.findOrgUnit(tx, ctx.companyId, id);
    if (!row || row.archivedAt) throw new DomainError('NOT_FOUND', 'Không tìm thấy đơn vị');
    return row;
  }

  private async requireActiveTeam(tx: Tx, ctx: RequestContext, id: string): Promise<TeamRow> {
    const row = await this.repo.findTeam(tx, ctx.companyId, id);
    if (!row || row.archivedAt) throw new DomainError('NOT_FOUND', 'Không tìm thấy team');
    return row;
  }

  /** Đổi vi phạm UNIQUE (tên trùng trong cùng parent) thành 409 CONFLICT. */
  private async onDuplicate<T>(message: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (pgErrorCode(error) === UNIQUE_VIOLATION) throw new DomainError('CONFLICT', message);
      throw error;
    }
  }

  private publishUnitCreated(tx: Tx, ctx: RequestContext, row: OrgUnitRow) {
    return this.events.publish(tx, ctx, {
      type: 'org_unit.created',
      aggregateKind: 'org_unit',
      aggregateId: row.id,
      payload: { orgUnitId: row.id, kind: row.kind, parentId: row.parentId, name: row.name },
    });
  }

  private publishTeamCreated(tx: Tx, ctx: RequestContext, row: TeamRow) {
    return this.events.publish(tx, ctx, {
      type: 'team.created',
      aggregateKind: 'team',
      aggregateId: row.id,
      payload: { teamId: row.id, orgUnitId: row.orgUnitId, name: row.name },
    });
  }
}
