import type {
  EmployeeEngine,
  EmployeeFilter,
  EmployeeProfile,
  IdentityDirectory,
  ManagedScope,
  MemberRef,
  OrganizationEngine,
  OrgUnit,
  Page,
  RequestContext,
  ScopeRef,
  Task,
  TaskEngine,
  TeamMembershipRef,
} from '@claude-company/contracts';

/** Phạm vi rỗng: không quản lý gì. */
export const NO_SCOPE: ManagedScope = {
  companyWide: false,
  orgUnitIds: [],
  teamIds: [],
  employeeIds: [],
};
export const COMPANY_WIDE: ManagedScope = {
  companyWide: true,
  orgUnitIds: [],
  teamIds: [],
  employeeIds: [],
};

/** OrganizationEngine giả: phạm vi của từng member cấu hình được. Dùng khi engine thật chưa có (US1). */
export class FakeOrganizationEngine implements Pick<
  OrganizationEngine,
  | 'isInScope'
  | 'resolveManagedScope'
  | 'resolveOrgUnitChain'
  | 'getOrgUnit'
  | 'listTeamMemberships'
  | 'setTeamMembers'
> {
  readonly scopes = new Map<string, ManagedScope>();
  readonly chains = new Map<string, string[]>();
  /** Đơn vị hợp lệ cho `getOrgUnit`; id không có trong map coi như không tồn tại. */
  readonly units = new Map<string, OrgUnit>();
  memberships: TeamMembershipRef[] = [];

  addUnit(unit: Partial<OrgUnit> & { id: string }): this {
    this.units.set(unit.id, {
      kind: 'department',
      parentId: null,
      name: unit.id,
      sortOrder: 0,
      archivedAt: null,
      ...unit,
    });
    return this;
  }

  async getOrgUnit(_ctx: RequestContext, id: string): Promise<OrgUnit | null> {
    return this.units.get(id) ?? null;
  }

  async listTeamMemberships(): Promise<TeamMembershipRef[]> {
    return this.memberships;
  }

  /** Thay toàn bộ thành viên của team, giống engine thật. */
  async setTeamMembers(_ctx: RequestContext, teamId: string, members: MemberRef[]): Promise<void> {
    this.memberships = [
      ...this.memberships.filter((m) => m.teamId !== teamId),
      ...members.map((m) => ({ teamId, memberKind: m.kind, memberId: m.id })),
    ];
  }

  setScope(memberId: string, scope: ManagedScope): this {
    this.scopes.set(memberId, scope);
    return this;
  }

  async resolveManagedScope(_ctx: RequestContext, memberId: string): Promise<ManagedScope> {
    return this.scopes.get(memberId) ?? NO_SCOPE;
  }

  async resolveOrgUnitChain(_ctx: RequestContext, orgUnitId: string): Promise<string[]> {
    return this.chains.get(orgUnitId) ?? [orgUnitId];
  }

  async isInScope(ctx: RequestContext, memberId: string, target: ScopeRef): Promise<boolean> {
    const scope = await this.resolveManagedScope(ctx, memberId);
    if (scope.companyWide) return true;
    switch (target.kind) {
      case 'company':
        return false;
      case 'org_unit':
        return target.id !== undefined && scope.orgUnitIds.includes(target.id);
      case 'team':
        return target.id !== undefined && scope.teamIds.includes(target.id);
      case 'ai_employee':
        return target.id !== undefined && scope.employeeIds.includes(target.id);
    }
  }
}

export function makeEmployeeProfile(overrides: Partial<EmployeeProfile> = {}): EmployeeProfile {
  return {
    id: '0197a000-0000-7000-8000-0000000000e1',
    name: 'Dev One',
    avatarKey: 'dev-1',
    position: 'AI Developer',
    homeOrgUnitId: '0197a000-0000-7000-8000-0000000000d1',
    teamIds: [],
    kind: 'employee',
    roleTemplateKey: 'ai_developer',
    personality: 'cẩn thận',
    skills: ['typescript'],
    seniority: 'middle',
    modelId: 'claude-opus-5-5',
    runtimeKind: 'claude_agent_sdk',
    systemPrompt: 'Bạn là AI Developer.',
    toolGrants: ['workspace.read', 'workspace.write', 'email.send'],
    workspaceId: null,
    manager: { kind: 'human', id: '0197a000-0000-7000-8000-0000000000f1' },
    maxConcurrentTasks: 2,
    status: 'active',
    performance: { completedTasks: 0, onTimeRate: 0, reworkRate: 0 },
    ...overrides,
  };
}

/** Phần AI Employee của EmployeeEngine giả, có dữ liệu cấu hình được. */
export class FakeEmployeeEngine implements Pick<EmployeeEngine, 'get' | 'list' | 'getCapacity'> {
  readonly employees = new Map<string, EmployeeProfile>();

  add(profile: EmployeeProfile): this {
    this.employees.set(profile.id, profile);
    return this;
  }

  async get(_ctx: RequestContext, id: string): Promise<EmployeeProfile> {
    const found = this.employees.get(id);
    if (!found) throw new Error(`Không có nhân viên giả ${id}`);
    return found;
  }

  async list(_ctx?: RequestContext, filter: EmployeeFilter = {}): Promise<EmployeeProfile[]> {
    return [...this.employees.values()].filter(
      (e) =>
        (filter.orgUnitId === undefined || e.homeOrgUnitId === filter.orgUnitId) &&
        (filter.teamId === undefined || e.teamIds.includes(filter.teamId)) &&
        (filter.kind === undefined || e.kind === filter.kind) &&
        (filter.status === undefined || e.status === filter.status),
    );
  }

  async getCapacity(_ctx: RequestContext, id: string): Promise<{ active: number; max: number }> {
    return { active: 0, max: this.employees.get(id)?.maxConcurrentTasks ?? 0 };
  }
}

/** TaskEngine giả: danh sách task cấu hình được để kiểm tra nhánh "còn task mở" mà stub rỗng không có. */
export class FakeTaskEngine implements Pick<
  TaskEngine,
  'list' | 'getStats' | 'markOverdue' | 'listCompaniesWithOpenTasks'
> {
  tasks: Task[] = [];

  async list(): Promise<Page<Task>> {
    return { items: this.tasks, nextCursor: null };
  }
  async getStats() {
    return { completedTasks: 0, onTimeRate: 0, reworkRate: 0, activeTasks: this.tasks.length };
  }
  async markOverdue(): Promise<Task[]> {
    return [];
  }
  async listCompaniesWithOpenTasks(): Promise<string[]> {
    return [];
  }
}

/** IdentityDirectory giả cho contract test không cần bảng `user`. */
export class FakeIdentityDirectory implements IdentityDirectory {
  readonly users = new Map<string, { id: string; displayName: string; email: string }>();

  add(user: { id: string; displayName: string; email: string }): this {
    this.users.set(user.id, user);
    return this;
  }

  async findUserByEmail(email: string) {
    const found = [...this.users.values()].find((u) => u.email === email.toLowerCase());
    return found ? { id: found.id, displayName: found.displayName } : null;
  }

  async getUsers(ids: string[]) {
    return ids.flatMap((id) => {
      const u = this.users.get(id);
      return u ? [u] : [];
    });
  }
}

type MemberOps = Pick<EmployeeEngine, 'addHumanMember' | 'listHumanMembers' | 'findMemberships'>;

/**
 * EmployeeEngine dùng được cho cả app thật lẫn dữ liệu giả: phần human member chuyển tiếp tới
 * `HumanMemberService` (lấy muộn sau khi app khởi động), phần AI Employee lấy từ fake.
 * Cần vì TenantGuard và createCompany luôn gọi `findMemberships`/`addHumanMember`.
 */
export function employeeEngineWithMembers(
  fake: FakeEmployeeEngine,
  members: () => MemberOps,
): Pick<EmployeeEngine, 'get' | 'list' | 'getCapacity'> & MemberOps {
  return {
    get: (ctx, id) => fake.get(ctx, id),
    list: (ctx, filter) => fake.list(ctx, filter),
    getCapacity: (ctx, id) => fake.getCapacity(ctx, id),
    addHumanMember: (ctx, input) => members().addHumanMember(ctx, input),
    listHumanMembers: (ctx) => members().listHumanMembers(ctx),
    findMemberships: (userId) => members().findMemberships(userId),
  };
}

export function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: '0197a000-0000-7000-8000-0000000000c1',
    title: 'Task đang chạy',
    objective: 'Mục tiêu',
    status: 'in_progress',
    assigneeKind: 'ai_employee',
    assigneeId: '0197a000-0000-7000-8000-0000000000e1',
    createdByMemberId: '0197a000-0000-7000-8000-0000000000f1',
    assignedByAiEmployeeId: null,
    deadline: '2026-12-31T00:00:00.000Z',
    priority: 'medium',
    acceptanceCriteria: [{ id: 'c1', text: 'Có kết quả' }],
    expectedOutput: 'Báo cáo',
    blockedFrom: null,
    blockedReason: null,
    isOverdue: false,
    reworkCount: 0,
    reworkBaseline: 0,
    tokenCap: null,
    costCap: null,
    completedAt: null,
    createdAt: '2026-11-09T00:00:00.000Z',
    parentTaskId: null,
    ...overrides,
  };
}
