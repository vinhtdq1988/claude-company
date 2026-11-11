import {
  DomainError,
  type AdapterContext,
  type EmployeeEngine,
  type OrganizationEngine,
  type RequestContext,
  type TaskEngine,
  type ToolAdapter,
  type ToolInput,
  type ToolResult,
} from '@claude-company/contracts';

/** Hành động thao tác trên dữ liệu của chính ứng dụng, chạy thật sau khi người duyệt đồng ý (R14 Decision 7). */
export const INTERNAL_ACTION_TYPES = ['org.archive', 'employee.archive', 'task.cancel'] as const;
type InternalAction = (typeof INTERNAL_ACTION_TYPES)[number];

/** Chỉ interface công khai của engine (Nguyên tắc VI): adapter không đọc bảng của engine nào. */
export type InternalOpsEngines = {
  organization: Pick<OrganizationEngine, 'archiveOrgUnit' | 'archiveTeam' | 'getOrgUnit' | 'getOrgChart'>;
  employees: Pick<EmployeeEngine, 'archive' | 'get'>;
  tasks: Pick<TaskEngine, 'transition' | 'get'>;
};

type Lookup = 'succeeded' | 'failed' | 'not_found' | 'unknown';

const isInternal = (actionType: string): actionType is InternalAction =>
  (INTERNAL_ACTION_TYPES as readonly string[]).includes(actionType);

function findTeam(nodes: ReadonlyArray<{ teams: Array<{ id: string }>; children: unknown[] }>, id: string): boolean {
  return nodes.some(
    (n) =>
      n.teams.some((t) => t.id === id) ||
      findTeam(n.children as Parameters<typeof findTeam>[0], id),
  );
}

/**
 * `InternalOpsAdapter` (`mode = "internal"`) cho `org.archive`, `employee.archive`, `task.cancel`. Khác `EmailAdapter`
 * (dry-run mặc định), adapter này thực sự lưu trữ/hủy vì đối tượng là dữ liệu của chính ứng dụng và đã có người duyệt;
 * lưu trữ là mềm (`archived_at`) nên hoàn tác được ở mức dữ liệu. `ADAPTER_MODE` không áp dụng cho adapter này.
 *
 * Chỉ được gọi bởi job `action.execute-approved` với payload có `payload_hash` khớp. Ngữ cảnh thực thi là của NGƯỜI DUYỆT
 * kèm `via` (nhân viên, run, task đề xuất) để audit; `via` không mở thêm quyền.
 */
export class InternalOpsAdapter implements ToolAdapter {
  readonly mode = 'internal' as const;
  readonly actionTypes: string[] = [...INTERNAL_ACTION_TYPES];

  constructor(private readonly engines: () => InternalOpsEngines) {}

  async execute(input: unknown, _idempotencyKey: string, context?: AdapterContext): Promise<ToolResult> {
    if (!context || !isInternal(context.actionType)) {
      return { status: 'error', message: 'Thiếu ngữ cảnh người duyệt hoặc hành động không thuộc adapter nội bộ' };
    }
    const ctx = this.contextOf(context);
    if (!ctx) {
      return { status: 'error', message: 'Thiếu người duyệt, nhân viên hoặc run để dựng ngữ cảnh thực thi' };
    }
    const { organization, employees, tasks } = this.engines();
    try {
      switch (context.actionType) {
        case 'org.archive': {
          const { targetKind, targetId } = input as ToolInput<'org.archive'>;
          if (targetKind === 'org_unit') await organization.archiveOrgUnit(ctx, targetId);
          else await organization.archiveTeam(ctx, targetId);
          return this.ok(`Đã lưu trữ ${targetKind === 'org_unit' ? 'đơn vị' : 'team'}`, targetKind, targetId);
        }
        case 'employee.archive': {
          const { employeeId } = input as ToolInput<'employee.archive'>;
          await employees.archive(ctx, employeeId);
          return this.ok('Đã lưu trữ AI Employee', 'employee', employeeId);
        }
        case 'task.cancel': {
          const { taskId, reason } = input as ToolInput<'task.cancel'>;
          await tasks.transition(ctx, taskId, 'cancel', { reason });
          return this.ok('Đã hủy task', 'task', taskId);
        }
      }
    } catch (error) {
      // Đối tượng đã được lưu trữ/hủy ở lần chạy trước (job giao lại): coi như đã xong, không thực hiện lại.
      if (await this.alreadyDone(context.actionType, input, context)) {
        return this.ok('Đối tượng đã ở trạng thái đích từ trước', undefined, undefined);
      }
      if (error instanceof DomainError) {
        // Lỗi nghiệp vụ (ví dụ ORG_UNIT_NOT_EMPTY) trả cho agent, không thực hiện lại: lưu trữ vẫn bị chặn nếu còn nhân viên/task.
        return { status: 'error', message: `${error.code}: ${error.message}` };
      }
      throw error;
    }
  }

  /** Đối tượng đã `archived_at` hoặc `cancelled` là `succeeded` để recovery không thực hiện lại. */
  async lookup(
    _idempotencyKey: string,
    context?: AdapterContext & { input?: unknown },
  ): Promise<Lookup> {
    if (!context || !isInternal(context.actionType) || context.input === undefined) return 'unknown';
    try {
      return (await this.alreadyDone(context.actionType, context.input, context)) ? 'succeeded' : 'not_found';
    } catch {
      return 'unknown';
    }
  }

  private async alreadyDone(
    actionType: InternalAction,
    input: unknown,
    context: AdapterContext,
  ): Promise<boolean> {
    const system: RequestContext = {
      companyId: context.companyId,
      actor: { kind: 'system' },
      traceId: context.traceId,
    };
    const { organization, employees, tasks } = this.engines();
    switch (actionType) {
      case 'org.archive': {
        const { targetKind, targetId } = input as ToolInput<'org.archive'>;
        if (targetKind === 'org_unit') return (await organization.getOrgUnit(system, targetId)) === null;
        const chart = await organization.getOrgChart(system);
        return !findTeam(chart.roots, targetId);
      }
      case 'employee.archive': {
        const { employeeId } = input as ToolInput<'employee.archive'>;
        return (await employees.get(system, employeeId)).status === 'archived';
      }
      case 'task.cancel': {
        const { taskId } = input as ToolInput<'task.cancel'>;
        return (await tasks.get(system, taskId)).status === 'cancelled';
      }
    }
  }

  /** Ngữ cảnh của người duyệt kèm `via` lấy từ yêu cầu phê duyệt (không từ input của model). */
  private contextOf(context: AdapterContext): RequestContext | null {
    const { approverMemberId, employeeId, runId, taskId } = context;
    if (!approverMemberId || !employeeId || !runId || !taskId) return null;
    return {
      companyId: context.companyId,
      actor: { kind: 'human', memberId: approverMemberId, via: { employeeId, runId, taskId } },
      traceId: context.traceId,
    };
  }

  private ok(summary: string, targetKind?: string, targetId?: string): ToolResult {
    return {
      status: 'ok',
      output: { summary, ...(targetKind && targetId ? { targetKind, targetId } : {}) },
    };
  }
}
