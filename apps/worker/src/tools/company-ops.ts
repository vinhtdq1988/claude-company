import {
  CEO_ASSISTANT_TEMPLATE_KEY,
  DEFAULT_MAX_CONCURRENT_TASKS,
  DomainError,
  type BudgetService,
  type CommunicationEngine,
  type CompanyOpsInput,
  type EmployeeEngine,
  type EmployeeProfileInput,
  type ManagerRef,
  type OrganizationEngine,
  type RequestContext,
  type TaskEngine,
} from '@claude-company/contracts';
import type { RunContext, ToolGuard, ToolHandler } from '../runtime/run-context';

/** Dashboard mà `company.query` dùng chung với `GET /dashboard` (token `DASHBOARD_READER` của API). */
export type DashboardReaderLike = {
  get(
    ctx: RequestContext,
    query: { orgUnitId?: string; period?: string },
  ): Promise<unknown>;
};

/**
 * Chỉ `Pick` từ interface engine (Nguyên tắc VI): handler không import schema bảng và không đọc dữ liệu engine khác
 * ngoài các phương thức công khai dưới đây (contracts/engine-interfaces.md, mục `company-ops`).
 */
export type CompanyOpsDeps = {
  organization: Pick<
    OrganizationEngine,
    'getOrgChart' | 'upsertOrgUnit' | 'upsertTeam' | 'listTeamMemberships' | 'setTeamMembers'
  >;
  employees: Pick<
    EmployeeEngine,
    | 'create'
    | 'update'
    | 'suspend'
    | 'resume'
    | 'archive'
    | 'get'
    | 'list'
    | 'listHumanMembers'
    | 'getCeoAssistant'
    | 'listRoleTemplates'
  >;
  tasks: Pick<TaskEngine, 'create' | 'transition' | 'get' | 'list' | 'getStats'>;
  budget: Pick<BudgetService, 'getUsage' | 'getPolicy'>;
  dashboard: DashboardReaderLike;
  communication: Pick<CommunicationEngine, 'listTaskMessages'>;
};

/** Tool điều hành mà handler này phục vụ (`org.archive`, `employee.archive`, `task.cancel` chỉ chạy qua InternalOpsAdapter). */
export const COMPANY_OPS_HANDLED = [
  'company.query',
  'task.create',
  'org.unit.upsert',
  'org.team.upsert',
  'employee.create',
  'employee.update',
  'employee.suspend',
  'employee.resume',
] as const;

/** Số phần tử tối đa trong kết quả `company.query` để không tràn ngữ cảnh model. */
const QUERY_LIMIT = 50;

const systemCtx = (run: RunContext): RequestContext => ({ ...run.ctx, actor: { kind: 'system' } });

/**
 * Dựng `RequestContext` thay mặt CEO sau khi kiểm tra C1 bằng DỮ LIỆU HỆ THỐNG (không bằng input của model): nhân viên
 * của run là `ceo_assistant` đang `active`, là assignee của task của run, và `task.created_by_member_id` là CEO đang
 * hoạt động. `via` lấy từ run, không có đường nào để model hay HTTP đặt nó (C2).
 * @throws DomainError ASSISTANT_CONTEXT_INVALID
 */
export async function delegatedContext(
  run: RunContext,
  deps: Pick<CompanyOpsDeps, 'employees' | 'tasks'>,
): Promise<RequestContext> {
  const sys = systemCtx(run);
  const invalid = (reason: string) =>
    new DomainError('ASSISTANT_CONTEXT_INVALID', `Ngữ cảnh CEO AI Assistant không hợp lệ: ${reason}`, {
      runId: run.runId,
      taskId: run.taskId,
    });
  const employee = await deps.employees.get(sys, run.employeeId).catch(() => null);
  if (employee?.roleTemplateKey !== CEO_ASSISTANT_TEMPLATE_KEY) {
    throw invalid('nhân viên của run không phải CEO AI Assistant');
  }
  if (employee.status !== 'active') throw invalid('CEO AI Assistant không ở trạng thái active');
  const task = await deps.tasks.get(sys, run.taskId).catch(() => null);
  if (!task || task.assigneeKind !== 'ai_employee' || task.assigneeId !== employee.id) {
    throw invalid('task của run không được giao cho CEO AI Assistant');
  }
  const members = await deps.employees.listHumanMembers(sys);
  const ceo = members.find((m) => m.id === task.createdByMemberId && m.role === 'ceo' && !m.disabledAt);
  if (!ceo) throw invalid('task không do CEO đang hoạt động tạo');
  return {
    companyId: run.ctx.companyId,
    traceId: run.ctx.traceId,
    actor: {
      kind: 'human',
      memberId: ceo.id,
      via: { employeeId: employee.id, runId: run.runId, taskId: run.taskId },
    },
  };
}

/** Chuẩn hóa để so khớp trích dẫn: gộp khoảng trắng, không phân biệt hoa thường (R14 Decision 6). */
export const normalizeQuote = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase();

const selfTarget = (what: string) =>
  new DomainError('ASSISTANT_SELF_TARGET', `CEO AI Assistant không được ${what} chính mình`);

/**
 * Guard dùng cho ToolBroker: C1 cho mọi tool điều hành, C3 (không nhắm vào chính trợ lý) cho `employee.update|suspend|
 * archive`, `task.cancel`, và `task.create` giao thẳng cho chính trợ lý. Lỗi ném ra được broker ghi ledger `denied`.
 */
export function createCompanyOpsGuards(
  deps: Pick<CompanyOpsDeps, 'employees' | 'tasks'>,
): Map<string, ToolGuard> {
  const guards = new Map<string, ToolGuard>();
  const withContext =
    (check?: (run: RunContext, input: Record<string, unknown>) => void): ToolGuard =>
    async (run, input) => {
      await delegatedContext(run, deps);
      check?.(run, (input ?? {}) as Record<string, unknown>);
    };
  for (const actionType of [
    'company.query',
    'org.unit.upsert',
    'org.team.upsert',
    'employee.create',
    'employee.resume',
    'org.archive',
  ]) {
    guards.set(actionType, withContext());
  }
  for (const [actionType, what] of [
    ['employee.update', 'sửa'],
    ['employee.suspend', 'tạm ngưng'],
    ['employee.archive', 'lưu trữ'],
  ] as const) {
    guards.set(
      actionType,
      withContext((run, input) => {
        if (input.employeeId === run.employeeId) throw selfTarget(what);
      }),
    );
  }
  guards.set(
    'task.cancel',
    withContext((run, input) => {
      if (input.taskId === run.taskId) throw selfTarget('hủy task của');
    }),
  );
  guards.set(
    'task.create',
    withContext((run, input) => {
      const assignee = input.assignee as { kind?: string; id?: string } | undefined;
      if (assignee?.kind === 'ai_employee' && assignee.id === run.employeeId) {
        throw selfTarget('giao việc cho');
      }
    }),
  );
  return guards;
}

/** Mọi trường của OrgChartNode mà báo cáo cần, bỏ phần dư để kết quả gọn. */
type ChartNode = Awaited<ReturnType<OrganizationEngine['getOrgChart']>>['roots'][number];
function summarizeChart(nodes: readonly ChartNode[]): unknown[] {
  return nodes.map((n) => ({
    id: n.id,
    name: n.name,
    kind: n.kind,
    managerMemberId: n.managerMemberId,
    employeeCount: n.employeeCount,
    teams: n.teams.map((t) => ({ id: t.id, name: t.name, memberCount: t.members.length })),
    children: summarizeChart(n.children),
  }));
}

/** Handler của các tool điều hành. Mọi thay đổi đi qua interface engine với ctx thay mặt CEO. */
export function createCompanyOpsHandlers(deps: CompanyOpsDeps): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();

  /** Trích dẫn nguyên văn phải có trong lời CEO: `objective` của task trợ lý hoặc `task_message` của NGƯỜI THẬT. */
  const quoteSources = async (run: RunContext, ctx: RequestContext): Promise<string[]> => {
    const [task, messages] = await Promise.all([
      deps.tasks.get(ctx, run.taskId),
      deps.communication.listTaskMessages(ctx, run.taskId),
    ]);
    return [task.objective, ...messages.filter((m) => m.authorKind === 'human').map((m) => m.body)].map(
      normalizeQuote,
    );
  };

  handlers.set('company.query', async (run, raw) => {
    const input = raw as CompanyOpsInput<'company.query'>;
    const ctx = await delegatedContext(run, deps);
    const queryAt = new Date().toISOString();
    switch (input.view) {
      case 'overview':
        return {
          view: input.view,
          queryAt,
          dashboard: await deps.dashboard.get(ctx, { orgUnitId: input.orgUnitId, period: input.period }),
        };
      case 'org_chart':
        return { view: input.view, queryAt, roots: summarizeChart((await deps.organization.getOrgChart(ctx)).roots) };
      case 'employees': {
        const list = await deps.employees.list(ctx, { orgUnitId: input.orgUnitId, withPerformance: true });
        return {
          view: input.view,
          queryAt,
          total: list.length,
          employees: list.slice(0, QUERY_LIMIT).map((e) => ({
            id: e.id,
            name: e.name,
            position: e.position,
            kind: e.kind,
            status: e.status,
            homeOrgUnitId: e.homeOrgUnitId,
            teamIds: e.teamIds,
            performance: e.performance,
          })),
        };
      }
      case 'tasks': {
        const page = await deps.tasks.list(ctx, {
          rootOnly: true,
          orgUnitId: input.orgUnitId,
          statusIn: input.status ? (input.status.split(',').map((s) => s.trim()) as never) : undefined,
          limit: QUERY_LIMIT,
        });
        return {
          view: input.view,
          queryAt,
          stats: await deps.tasks.getStats(ctx, { orgUnitId: input.orgUnitId }),
          tasks: page.items.map(summarizeTask),
        };
      }
      case 'blockers': {
        const [blocked, overdue] = [
          await deps.tasks.list(ctx, { rootOnly: true, statusIn: ['blocked'], orgUnitId: input.orgUnitId, limit: QUERY_LIMIT }),
          await deps.tasks.list(ctx, { rootOnly: true, overdue: true, orgUnitId: input.orgUnitId, limit: QUERY_LIMIT }),
        ];
        return {
          view: input.view,
          queryAt,
          blocked: blocked.items.map(summarizeTask),
          overdue: overdue.items.map(summarizeTask),
        };
      }
      case 'usage':
        return {
          view: input.view,
          queryAt,
          usage: await deps.budget.getUsage(ctx, {
            orgUnitId: input.orgUnitId,
            period: input.period,
            groupBy: 'employee',
          }),
        };
      case 'budget':
        return {
          view: input.view,
          queryAt,
          policy: await deps.budget.getPolicy(ctx, 'company', ctx.companyId),
          usage: await deps.budget.getUsage(ctx, { period: input.period }),
        };
    }
  });

  handlers.set('task.create', async (run, raw) => {
    const input = raw as CompanyOpsInput<'task.create'>;
    const ctx = await delegatedContext(run, deps);
    const sources = await quoteSources(run, ctx);
    const allQuoted = input.acceptanceCriteria.every(
      (c) => c.source === 'ceo_quote' && sources.some((s) => s.includes(normalizeQuote(c.text))),
    );
    const created = await deps.tasks.create(ctx, {
      title: input.title,
      objective: input.objective,
      assignee: input.assignee,
      deadline: input.deadline,
      priority: input.priority,
      acceptanceCriteria: input.acceptanceCriteria.map((c) => c.text),
      expectedOutput: input.expectedOutput,
      tokenCap: input.tokenCap,
      costCap: input.costCap,
      dependsOn: input.dependsOn,
    });
    // Giao ngay chỉ khi MỌI tiêu chí là trích dẫn nguyên văn của CEO; ngược lại task chờ CEO xác nhận (R14 Decision 6).
    const task = allQuoted ? await deps.tasks.transition(ctx, created.id, 'assign') : created;
    return {
      taskId: task.id,
      title: task.title,
      status: task.status,
      summary: allQuoted
        ? `Đã tạo và giao task "${task.title}"`
        : `Đã tạo task nháp "${task.title}" chờ CEO xác nhận vì có tiêu chí do trợ lý đề xuất`,
      ...(allQuoted ? {} : { awaitingCeoConfirmation: true }),
    };
  });

  handlers.set('org.unit.upsert', async (run, raw) => {
    const input = raw as CompanyOpsInput<'org.unit.upsert'>;
    const ctx = await delegatedContext(run, deps);
    const unit = await deps.organization.upsertOrgUnit(ctx, input);
    return { orgUnitId: unit.id, name: unit.name, kind: unit.kind, summary: `Đã lưu đơn vị "${unit.name}"` };
  });

  handlers.set('org.team.upsert', async (run, raw) => {
    const input = raw as CompanyOpsInput<'org.team.upsert'>;
    const ctx = await delegatedContext(run, deps);
    const team = await deps.organization.upsertTeam(ctx, input);
    return { teamId: team.id, name: team.name, summary: `Đã lưu team "${team.name}"` };
  });

  /**
   * Manager trực tiếp do hệ thống chọn (R14 Decision 4): AI Manager đang hoạt động của phòng ban, nếu không thì người
   * quản lý phòng ban, nếu không thì CEO. Nhân viên mới là AI Manager thì bỏ bậc đầu.
   */
  const pickManager = async (
    ctx: RequestContext,
    homeOrgUnitId: string,
    isManager: boolean,
  ): Promise<ManagerRef> => {
    if (!isManager) {
      const all = await deps.employees.list(ctx, { orgUnitId: homeOrgUnitId });
      const aiManager = all
        .filter((e) => e.kind === 'manager' && e.status === 'active')
        .sort((a, b) => a.id.localeCompare(b.id))[0];
      if (aiManager) return { kind: 'ai', id: aiManager.id };
    }
    const chart = await deps.organization.getOrgChart(ctx);
    const find = (nodes: readonly ChartNode[]): ChartNode | undefined => {
      for (const n of nodes) {
        if (n.id === homeOrgUnitId) return n;
        const inner = find(n.children);
        if (inner) return inner;
      }
      return undefined;
    };
    const unitManager = find(chart.roots)?.managerMemberId;
    if (unitManager) return { kind: 'human', id: unitManager };
    return { kind: 'human', id: (ctx.actor as { memberId: string }).memberId };
  };

  /** Đặt nhân viên vào đúng các team `teamIds` (thêm vào team được nêu, rút khỏi team khác). */
  const syncTeams = async (ctx: RequestContext, employeeId: string, teamIds: string[]) => {
    const memberships = await deps.organization.listTeamMemberships(ctx);
    const teams = new Set([...memberships.map((m) => m.teamId), ...teamIds]);
    for (const teamId of teams) {
      const current = memberships
        .filter((m) => m.teamId === teamId)
        .map((m) => ({ kind: m.memberKind, id: m.memberId }));
      const without = current.filter((m) => !(m.kind === 'ai' && m.id === employeeId));
      const next = teamIds.includes(teamId) ? [...without, { kind: 'ai' as const, id: employeeId }] : without;
      if (next.length !== current.length || next.some((m, i) => m.id !== current[i]?.id)) {
        await deps.organization.setTeamMembers(ctx, teamId, next);
      }
    }
  };

  handlers.set('employee.create', async (run, raw) => {
    const input = raw as CompanyOpsInput<'employee.create'>;
    const ctx = await delegatedContext(run, deps);
    if (input.roleTemplateKey === CEO_ASSISTANT_TEMPLATE_KEY) {
      throw new DomainError('VALIDATION_FAILED', 'Không tạo CEO AI Assistant qua tool', {
        field: 'roleTemplateKey',
      });
    }
    const template = (await deps.employees.listRoleTemplates()).find((t) => t.key === input.roleTemplateKey);
    if (!template) {
      throw new DomainError('NOT_FOUND', `Không có mẫu vai trò "${input.roleTemplateKey}"`);
    }
    const d = template.defaults;
    // Model, system prompt, công cụ và runtime lấy từ mẫu; mô hình không đặt được (FR-049d).
    const profile: EmployeeProfileInput = {
      name: input.name,
      avatarKey: d.avatarKey,
      position: d.position,
      homeOrgUnitId: input.homeOrgUnitId,
      kind: d.kind,
      roleTemplateKey: template.key,
      personality: input.personality ?? d.personality,
      skills: input.skills ?? d.skills,
      seniority: input.seniority ?? d.seniority,
      modelId: d.modelId,
      runtimeKind: d.runtimeKind,
      systemPrompt: d.systemPrompt,
      toolGrants: d.toolGrants,
      workspaceId: null,
      manager: await pickManager(ctx, input.homeOrgUnitId, d.kind === 'manager'),
      maxConcurrentTasks: DEFAULT_MAX_CONCURRENT_TASKS,
    };
    const created = await deps.employees.create(ctx, profile);
    if (input.teamIds?.length) await syncTeams(ctx, created.id, input.teamIds);
    return {
      employeeId: created.id,
      name: created.name,
      position: created.position,
      status: created.status,
      summary: `Đã tạo AI Employee "${created.name}" từ mẫu ${template.key}`,
    };
  });

  handlers.set('employee.update', async (run, raw) => {
    const { employeeId, teamIds, ...patch } = raw as CompanyOpsInput<'employee.update'>;
    const ctx = await delegatedContext(run, deps);
    const updated = Object.keys(patch).length > 0 ? await deps.employees.update(ctx, employeeId, patch) : await deps.employees.get(ctx, employeeId);
    if (teamIds) await syncTeams(ctx, employeeId, teamIds);
    return { employeeId, name: updated.name, summary: `Đã cập nhật hồ sơ "${updated.name}"` };
  });

  handlers.set('employee.suspend', async (run, raw) => {
    const { employeeId } = raw as CompanyOpsInput<'employee.suspend'>;
    await deps.employees.suspend(await delegatedContext(run, deps), employeeId);
    return { employeeId, status: 'suspended', summary: 'Đã tạm ngưng AI Employee' };
  });

  handlers.set('employee.resume', async (run, raw) => {
    const { employeeId } = raw as CompanyOpsInput<'employee.resume'>;
    await deps.employees.resume(await delegatedContext(run, deps), employeeId);
    return { employeeId, status: 'active', summary: 'Đã kích hoạt lại AI Employee' };
  });

  return handlers;
}

function summarizeTask(t: {
  id: string;
  title: string;
  status: string;
  priority: string;
  deadline: string;
  isOverdue: boolean;
  blockedReason: string | null;
  assigneeKind: string;
  assigneeId: string;
}) {
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    deadline: t.deadline,
    isOverdue: t.isOverdue,
    blockedReason: t.blockedReason,
    assigneeKind: t.assigneeKind,
    assigneeId: t.assigneeId,
  };
}
