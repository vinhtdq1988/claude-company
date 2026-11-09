import { Inject, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  DomainError,
  type EmployeeEngine,
  type EmployeeFilter,
  type EmployeeProfile,
  type EmployeeProfileInput,
  type HumanMember,
  type HumanRole,
  type ManagerRef,
  type Membership,
  type ModelCatalog,
  type OrganizationEngine,
  type RequestContext,
  type RoleTemplate,
  type TaskEngine,
  type TaskStatus,
  type Workspace,
  roleTemplateDefaultsSchema,
} from '@claude-company/contracts';
import { newId, withGlobal, type Tx } from '@claude-company/db';
import { validateToolGrants } from '@claude-company/policy';
import { sql } from 'drizzle-orm';
import { MODEL_CATALOG, ORGANIZATION_ENGINE, TASK_ENGINE } from '../../platform/engine-tokens';
import { EventPublisher } from '../../platform/events/event-publisher';
import { inTenant } from '../../platform/tenancy/tenant-store';
import { EmployeeRepository, type EmployeeRow } from './employee.repository';
import { HumanMemberService } from './human-member.service';
import {
  checkProposedManager,
  walkManagementChain,
  type ChainFailure,
  type ChainNode,
  type ChainSnapshot,
} from './management-chain';

/** Task chưa kết thúc: chặn archive nhân viên còn task loại này (US2-AS4). */
const OPEN_TASK_STATUSES: TaskStatus[] = [
  'draft',
  'assigned',
  'in_progress',
  'in_review',
  'awaiting_human_approval',
  'blocked',
];

/** Task đang chiếm slot `max_concurrent_tasks` của nhân viên. Run decompose/review/synthesize không chiếm slot. */
const SLOT_TASK_STATUSES: TaskStatus[] = ['in_progress'];

/** Số mục tối đa trong danh sách cản trở trả về cho người dùng. */
const BLOCKER_LIMIT = 50;

const CHAIN_MESSAGES: Record<ChainFailure, string> = {
  HUMAN_INACTIVE: 'Chuỗi quản lý phải kết thúc ở một người thật đang hoạt động',
  MANAGER_MISSING: 'Manager AI không tồn tại hoặc đã được lưu trữ',
  NOT_A_MANAGER: 'Manager AI phải là AI Manager (kind = manager)',
  CYCLE: 'Chuỗi quản lý có vòng',
  TOO_LONG: 'Chuỗi quản lý dài quá 10 bước',
};

const ZERO_PERFORMANCE = { completedTasks: 0, onTimeRate: 0, reworkRate: 0 };

type TaskOps = Pick<TaskEngine, 'list' | 'getStats'>;

function chainError(reason: ChainFailure, details: Record<string, unknown> = {}): DomainError {
  return new DomainError('MANAGEMENT_CHAIN_INVALID', CHAIN_MESSAGES[reason], {
    reason,
    ...details,
  });
}

/**
 * Employee Engine: hồ sơ AI Employee, chuỗi quản lý kết thúc ở người thật, năng lực xử lý đồng thời
 * và thành viên người thật. Chỉ truy cập bảng của mình; đơn vị, team, task, model lấy qua interface.
 */
@Injectable()
export class EmployeeService implements EmployeeEngine {
  constructor(
    private readonly repo: EmployeeRepository,
    private readonly members: HumanMemberService,
    private readonly events: EventPublisher,
    private readonly moduleRef: ModuleRef,
    @Inject(TASK_ENGINE) private readonly tasks: TaskOps,
    @Inject(MODEL_CATALOG) private readonly models: Pick<ModelCatalog, 'hasModel'>,
  ) {}

  /**
   * OrganizationEngine phụ thuộc ngược vào EmployeeEngine (đếm nhân viên, phạm vi quản lý), nên lấy
   * muộn qua ModuleRef thay vì inject trong constructor để tránh vòng phụ thuộc giữa hai provider.
   */
  private get organization(): Pick<
    OrganizationEngine,
    'getOrgUnit' | 'listTeamMemberships' | 'setTeamMembers'
  > {
    return this.moduleRef.get<OrganizationEngine>(ORGANIZATION_ENGINE, { strict: false });
  }

  async getWorkspace(ctx: RequestContext, id: string): Promise<Workspace> {
    const row = await inTenant(ctx, (tx) => this.repo.findWorkspace(tx, ctx.companyId, id));
    if (!row) throw new DomainError('NOT_FOUND', 'Không tìm thấy workspace');
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      mountPath: row.mountPath,
      defaultBranch: row.defaultBranch,
    };
  }

  // --- tạo, sửa ---

  async create(ctx: RequestContext, input: EmployeeProfileInput): Promise<EmployeeProfile> {
    // Kiểm tra bắt buộc manager trước mọi thứ khác (US2-AS2): thiếu manager luôn là MANAGER_REQUIRED.
    const manager = input.manager as ManagerRef | null | undefined;
    if (!manager?.id) {
      throw new DomainError('MANAGER_REQUIRED', 'Mỗi AI Employee phải có một manager trực tiếp', {
        field: 'manager',
      });
    }
    await this.assertProfileValid(ctx, input);

    const row = await inTenant(ctx, async (tx) => {
      await this.lockChain(tx, ctx);
      const id = newId();
      await this.assertChain(tx, ctx, { id, kind: input.kind, status: 'active', manager });
      const inserted = await this.repo.insert(tx, {
        id,
        companyId: ctx.companyId,
        name: input.name,
        avatarKey: input.avatarKey,
        position: input.position,
        homeOrgUnitId: input.homeOrgUnitId,
        kind: input.kind,
        roleTemplateKey: input.roleTemplateKey,
        personality: input.personality,
        skills: input.skills,
        seniority: input.seniority,
        modelId: input.modelId,
        runtimeKind: input.runtimeKind,
        systemPrompt: input.systemPrompt,
        toolGrants: [...new Set(input.toolGrants)],
        workspaceId: input.workspaceId,
        managerKind: manager.kind,
        managerId: manager.id,
        maxConcurrentTasks: input.maxConcurrentTasks,
      });
      await this.events.publish(tx, ctx, {
        type: 'employee.created',
        aggregateKind: 'ai_employee',
        aggregateId: id,
        payload: {
          employeeId: id,
          name: inserted.name,
          kind: inserted.kind,
          homeOrgUnitId: inserted.homeOrgUnitId,
        },
      });
      return inserted;
    });
    return this.toProfile(row, [], ZERO_PERFORMANCE);
  }

  async update(
    ctx: RequestContext,
    id: string,
    patch: Partial<EmployeeProfileInput>,
  ): Promise<EmployeeProfile> {
    const outcome = await inTenant(ctx, async (tx) => {
      await this.lockChain(tx, ctx);
      const current = await this.requireActive(tx, ctx, id);
      const next = this.merge(current, patch);
      const changed = (Object.keys(patch) as Array<keyof EmployeeProfileInput>).filter(
        (key) =>
          patch[key] !== undefined &&
          JSON.stringify(patch[key]) !== JSON.stringify(this.currentValue(current, key)),
      );
      if (changed.length === 0) return { row: current, changed };

      await this.assertProfileValid(ctx, next, { previous: current, changed });
      if (changed.includes('manager') || changed.includes('kind')) {
        await this.assertChain(tx, ctx, {
          id,
          kind: next.kind,
          status: current.status,
          manager: next.manager,
        });
      }
      if (current.kind === 'manager' && next.kind !== 'manager') {
        const reports = await this.repo.listDirectReports(tx, ctx.companyId, { kind: 'ai', id });
        if (reports.length > 0) {
          throw new DomainError(
            'MANAGEMENT_CHAIN_INVALID',
            'AI Manager đang có cấp dưới nên không đổi được loại',
            { reason: 'HAS_REPORTS', employees: reports.map((r) => ({ id: r.id, name: r.name })) },
          );
        }
      }

      const row = await this.repo.update(tx, ctx.companyId, id, {
        name: next.name,
        avatarKey: next.avatarKey,
        position: next.position,
        homeOrgUnitId: next.homeOrgUnitId,
        kind: next.kind,
        roleTemplateKey: next.roleTemplateKey,
        personality: next.personality,
        skills: next.skills,
        seniority: next.seniority,
        modelId: next.modelId,
        runtimeKind: next.runtimeKind,
        systemPrompt: next.systemPrompt,
        toolGrants: [...new Set(next.toolGrants)],
        workspaceId: next.workspaceId,
        managerKind: next.manager.kind,
        managerId: next.manager.id,
        maxConcurrentTasks: next.maxConcurrentTasks,
      });
      await this.events.publish(tx, ctx, {
        type: 'employee.updated',
        aggregateKind: 'ai_employee',
        aggregateId: id,
        payload: {
          employeeId: id,
          changed,
          homeOrgUnitId: row.homeOrgUnitId,
          previousHomeOrgUnitId: current.homeOrgUnitId,
        },
      });
      return { row, changed };
    });
    return this.profileOf(ctx, outcome.row, true);
  }

  // --- vòng đời ---

  async suspend(ctx: RequestContext, id: string): Promise<void> {
    await this.setStatus(ctx, id, 'active', 'suspended', 'employee.suspended');
  }

  async resume(ctx: RequestContext, id: string): Promise<void> {
    await this.setStatus(ctx, id, 'suspended', 'active', 'employee.resumed');
  }

  /** Đổi trạng thái idempotent: đã ở trạng thái đích thì không làm gì, không phát sự kiện. */
  private async setStatus(
    ctx: RequestContext,
    id: string,
    from: EmployeeRow['status'],
    to: EmployeeRow['status'],
    eventType: string,
  ): Promise<void> {
    await inTenant(ctx, async (tx) => {
      const current = await this.requireActive(tx, ctx, id);
      if (current.status !== from) return;
      await this.repo.update(tx, ctx.companyId, id, { status: to });
      await this.events.publish(tx, ctx, {
        type: eventType,
        aggregateKind: 'ai_employee',
        aggregateId: id,
        payload: { employeeId: id, homeOrgUnitId: current.homeOrgUnitId },
      });
    });
  }

  async archive(ctx: RequestContext, id: string): Promise<void> {
    await inTenant(ctx, async (tx) => {
      await this.lockChain(tx, ctx);
      const current = await this.requireActive(tx, ctx, id);

      const openTasks = await this.tasks.list(ctx, {
        assigneeKind: 'ai_employee',
        assigneeId: id,
        statusIn: OPEN_TASK_STATUSES,
        limit: BLOCKER_LIMIT,
      });
      if (openTasks.items.length > 0) {
        throw new DomainError(
          'EMPLOYEE_HAS_OPEN_TASKS',
          'AI Employee còn task chưa kết thúc: hãy hủy hoặc chờ hoàn tất',
          { tasks: openTasks.items.map((t) => ({ id: t.id, title: t.title })) },
        );
      }
      // Archive AI Manager giữa chuỗi sẽ làm đứt chuỗi của cấp dưới (FR-006).
      const reports = await this.repo.listDirectReports(tx, ctx.companyId, { kind: 'ai', id });
      if (reports.length > 0) {
        throw new DomainError(
          'MANAGEMENT_CHAIN_INVALID',
          'AI Manager còn cấp dưới: hãy chuyển cấp dưới sang manager khác trước khi lưu trữ',
          { reason: 'HAS_REPORTS', employees: reports.map((r) => ({ id: r.id, name: r.name })) },
        );
      }

      await this.repo.update(tx, ctx.companyId, id, { status: 'archived' });
      await this.removeFromTeams(ctx, id);
      await this.events.publish(tx, ctx, {
        type: 'employee.archived',
        aggregateKind: 'ai_employee',
        aggregateId: id,
        payload: { employeeId: id, homeOrgUnitId: current.homeOrgUnitId },
      });
    });
  }

  /** Nhân viên đã lưu trữ không còn là thành viên team (để team khác trống được lưu trữ). */
  private async removeFromTeams(ctx: RequestContext, employeeId: string): Promise<void> {
    const all = await this.organization.listTeamMemberships(ctx);
    const teamIds = new Set(
      all.filter((m) => m.memberKind === 'ai' && m.memberId === employeeId).map((m) => m.teamId),
    );
    for (const teamId of teamIds) {
      const remaining = all
        .filter((m) => m.teamId === teamId && !(m.memberKind === 'ai' && m.memberId === employeeId))
        .map((m) => ({ kind: m.memberKind, id: m.memberId }));
      await this.organization.setTeamMembers(ctx, teamId, remaining);
    }
  }

  // --- truy vấn ---

  async get(ctx: RequestContext, id: string): Promise<EmployeeProfile> {
    const row = await inTenant(ctx, (tx) => this.repo.find(tx, ctx.companyId, id));
    if (!row) throw new DomainError('NOT_FOUND', 'Không tìm thấy AI Employee');
    return this.profileOf(ctx, row, true);
  }

  async list(ctx: RequestContext, filter: EmployeeFilter): Promise<EmployeeProfile[]> {
    const rows = await inTenant(ctx, (tx) =>
      this.repo.list(tx, ctx.companyId, {
        orgUnitId: filter.orgUnitId,
        kind: filter.kind,
        status: filter.status,
      }),
    );
    const memberships = await this.organization.listTeamMemberships(ctx);
    const teamsOf = this.teamsByEmployee(memberships);
    const wanted = filter.teamId
      ? rows.filter((r) => teamsOf.get(r.id)?.includes(filter.teamId as string))
      : rows;
    return Promise.all(
      wanted.map(async (row) =>
        this.toProfile(
          row,
          teamsOf.get(row.id) ?? [],
          filter.withPerformance ? await this.performanceOf(ctx, row.id) : ZERO_PERFORMANCE,
        ),
      ),
    );
  }

  // --- chuỗi quản lý, năng lực ---

  async resolveAccountableHuman(ctx: RequestContext, employeeId: string): Promise<string> {
    return inTenant(ctx, async (tx) => {
      const row = await this.repo.find(tx, ctx.companyId, employeeId);
      if (!row) throw new DomainError('NOT_FOUND', 'Không tìm thấy AI Employee');
      const snapshot = await this.snapshot(tx, ctx);
      const result = walkManagementChain(snapshot, {
        id: row.id,
        manager: { kind: row.managerKind, id: row.managerId },
      });
      if (!result.ok) throw chainError(result.reason, { at: result.at });
      return result.humanMemberId;
    });
  }

  async getCapacity(
    ctx: RequestContext,
    employeeId: string,
  ): Promise<{ active: number; max: number }> {
    const row = await inTenant(ctx, (tx) => this.repo.find(tx, ctx.companyId, employeeId));
    if (!row) throw new DomainError('NOT_FOUND', 'Không tìm thấy AI Employee');
    const slots = await this.tasks.list(ctx, {
      assigneeKind: 'ai_employee',
      assigneeId: employeeId,
      statusIn: SLOT_TASK_STATUSES,
      limit: 200,
    });
    return { active: slots.items.length, max: row.maxConcurrentTasks };
  }

  // --- thành viên người thật (chuyển tiếp tới HumanMemberService) ---

  addHumanMember(
    ctx: RequestContext,
    input: { userId: string; role: HumanRole; title?: string },
  ): Promise<HumanMember> {
    return this.members.addHumanMember(ctx, input);
  }

  listHumanMembers(ctx: RequestContext): Promise<HumanMember[]> {
    return this.members.listHumanMembers(ctx);
  }

  findMemberships(userId: string): Promise<Membership[]> {
    return this.members.findMemberships(userId);
  }

  deactivateHumanMember(ctx: RequestContext, memberId: string): Promise<void> {
    return this.members.deactivateHumanMember(ctx, memberId);
  }

  // --- mẫu vai trò ---

  async listRoleTemplates(): Promise<RoleTemplate[]> {
    const rows = await withGlobal((tx) => this.repo.listRoleTemplates(tx));
    return rows.map((r) => ({
      key: r.key,
      name: r.name,
      defaults: roleTemplateDefaultsSchema.parse(r.defaults),
    }));
  }

  // --- kiểm tra ---

  /**
   * Quy tắc hồ sơ không biểu diễn được trong schema Zod vì cần dữ liệu ngoài: tool_grants thuộc danh mục
   * và khớp runtime, model có trong danh mục, đơn vị/workspace tồn tại. Chỉ kiểm tra lại phần đã đổi khi sửa.
   */
  private async assertProfileValid(
    ctx: RequestContext,
    profile: EmployeeProfileInput,
    update?: { previous: EmployeeRow; changed: Array<keyof EmployeeProfileInput> },
  ): Promise<void> {
    const touched = (...keys: Array<keyof EmployeeProfileInput>) =>
      !update || keys.some((k) => update.changed.includes(k));

    if (profile.kind === 'manager' && profile.runtimeKind !== 'messages_api') {
      throw new DomainError('VALIDATION_FAILED', 'AI Manager phải dùng runtime messages_api', {
        field: 'runtimeKind',
      });
    }
    if (touched('toolGrants', 'runtimeKind')) {
      const issues = validateToolGrants(profile.toolGrants, profile.runtimeKind);
      if (issues.length > 0) {
        throw new DomainError(
          'VALIDATION_FAILED',
          'Công cụ được cấp không thuộc danh mục hoặc không tương thích runtime',
          { field: 'toolGrants', issues },
        );
      }
    }
    if (touched('modelId') && !(await this.models.hasModel(profile.modelId))) {
      throw new DomainError('MODEL_NOT_ALLOWED', 'Model không có trong danh mục cấu hình', {
        field: 'modelId',
        modelId: profile.modelId,
      });
    }
    if (touched('homeOrgUnitId')) {
      const unit = await this.organization.getOrgUnit(ctx, profile.homeOrgUnitId);
      if (!unit || unit.kind !== 'department') {
        throw new DomainError(
          'VALIDATION_FAILED',
          'Đơn vị của nhân viên phải là một department đang hoạt động',
          { field: 'homeOrgUnitId' },
        );
      }
    }
    if (touched('workspaceId') && profile.workspaceId) {
      const found = await inTenant(ctx, (tx) =>
        this.repo.findWorkspace(tx, ctx.companyId, profile.workspaceId as string),
      );
      if (!found) {
        throw new DomainError('VALIDATION_FAILED', 'Workspace không tồn tại', {
          field: 'workspaceId',
        });
      }
    }
  }

  /** Mọi thay đổi chuỗi quản lý trong cùng công ty chạy tuần tự để hai thao tác song song không tạo vòng. */
  private async lockChain(tx: Tx, ctx: RequestContext): Promise<void> {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`employee_chain:${ctx.companyId}`}, 0))`,
    );
  }

  private async snapshot(tx: Tx, ctx: RequestContext): Promise<ChainSnapshot> {
    const [rows, humanIds] = await Promise.all([
      this.repo.list(tx, ctx.companyId),
      this.repo.listActiveHumanIds(tx, ctx.companyId),
    ]);
    return {
      employees: new Map(rows.map((r) => [r.id, this.chainNode(r)])),
      activeHumanIds: new Set(humanIds),
    };
  }

  private chainNode(row: EmployeeRow): ChainNode {
    return {
      id: row.id,
      kind: row.kind,
      status: row.status,
      manager: { kind: row.managerKind, id: row.managerId },
    };
  }

  /** Kiểm tra chuỗi của `subject` với manager đề xuất; ném MANAGEMENT_CHAIN_INVALID nếu vi phạm. */
  private async assertChain(
    tx: Tx,
    ctx: RequestContext,
    subject: {
      id: string;
      kind: ChainNode['kind'];
      status: ChainNode['status'];
      manager: ManagerRef;
    },
  ): Promise<void> {
    const snapshot = await this.snapshot(tx, ctx);
    const employees = new Map(snapshot.employees);
    employees.set(subject.id, { ...subject });
    const result = checkProposedManager(
      { employees, activeHumanIds: snapshot.activeHumanIds },
      { id: subject.id, manager: subject.manager },
    );
    if (!result.ok) throw chainError(result.reason, { at: result.at });
  }

  // --- chuyển đổi dữ liệu ---

  private async requireActive(tx: Tx, ctx: RequestContext, id: string): Promise<EmployeeRow> {
    const row = await this.repo.find(tx, ctx.companyId, id);
    if (!row || row.status === 'archived') {
      throw new DomainError('NOT_FOUND', 'Không tìm thấy AI Employee');
    }
    return row;
  }

  private currentValue(row: EmployeeRow, key: keyof EmployeeProfileInput): unknown {
    return key === 'manager' ? { kind: row.managerKind, id: row.managerId } : row[key];
  }

  /** Hồ sơ hiện tại phủ lên bằng các trường được sửa. */
  private merge(row: EmployeeRow, patch: Partial<EmployeeProfileInput>): EmployeeProfileInput {
    return {
      name: patch.name ?? row.name,
      avatarKey: patch.avatarKey ?? row.avatarKey,
      position: patch.position ?? row.position,
      homeOrgUnitId: patch.homeOrgUnitId ?? row.homeOrgUnitId,
      kind: patch.kind ?? row.kind,
      roleTemplateKey:
        patch.roleTemplateKey === undefined ? row.roleTemplateKey : patch.roleTemplateKey,
      personality: patch.personality ?? row.personality,
      skills: patch.skills ?? row.skills,
      seniority: patch.seniority ?? row.seniority,
      modelId: patch.modelId ?? row.modelId,
      runtimeKind: patch.runtimeKind ?? row.runtimeKind,
      systemPrompt: patch.systemPrompt ?? row.systemPrompt,
      toolGrants: patch.toolGrants ?? row.toolGrants,
      workspaceId: patch.workspaceId === undefined ? row.workspaceId : patch.workspaceId,
      manager: patch.manager ?? { kind: row.managerKind, id: row.managerId },
      maxConcurrentTasks: patch.maxConcurrentTasks ?? row.maxConcurrentTasks,
    };
  }

  private teamsByEmployee(
    memberships: Array<{ teamId: string; memberKind: 'ai' | 'human'; memberId: string }>,
  ): Map<string, string[]> {
    const teamsOf = new Map<string, string[]>();
    for (const m of memberships) {
      if (m.memberKind !== 'ai') continue;
      teamsOf.set(m.memberId, [...(teamsOf.get(m.memberId) ?? []), m.teamId]);
    }
    return teamsOf;
  }

  private async performanceOf(ctx: RequestContext, employeeId: string) {
    const stats = await this.tasks.getStats(ctx, { employeeId });
    return {
      completedTasks: stats.completedTasks,
      onTimeRate: stats.onTimeRate,
      reworkRate: stats.reworkRate,
    };
  }

  private async profileOf(
    ctx: RequestContext,
    row: EmployeeRow,
    withPerformance: boolean,
  ): Promise<EmployeeProfile> {
    const memberships = await this.organization.listTeamMemberships(ctx);
    const teamIds = this.teamsByEmployee(memberships).get(row.id) ?? [];
    return this.toProfile(
      row,
      teamIds,
      withPerformance ? await this.performanceOf(ctx, row.id) : ZERO_PERFORMANCE,
    );
  }

  private toProfile(
    row: EmployeeRow,
    teamIds: string[],
    performance: EmployeeProfile['performance'],
  ): EmployeeProfile {
    return {
      id: row.id,
      name: row.name,
      avatarKey: row.avatarKey,
      position: row.position,
      homeOrgUnitId: row.homeOrgUnitId,
      teamIds,
      kind: row.kind,
      roleTemplateKey: row.roleTemplateKey,
      personality: row.personality,
      skills: row.skills,
      seniority: row.seniority,
      modelId: row.modelId,
      runtimeKind: row.runtimeKind,
      systemPrompt: row.systemPrompt,
      toolGrants: row.toolGrants,
      workspaceId: row.workspaceId,
      manager: { kind: row.managerKind, id: row.managerId },
      maxConcurrentTasks: row.maxConcurrentTasks,
      status: row.status,
      performance,
    };
  }
}
