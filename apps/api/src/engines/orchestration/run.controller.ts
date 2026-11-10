import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import {
  DomainError,
  runListQuerySchema,
  uuidSchema,
  type AgentRunSummary,
  type AgentRunView,
  type BudgetService,
  type OrchestrationEngine,
  type OrganizationEngine,
  type Page,
  type PermissionEngine,
  type RequestContext,
  type RunListQuery,
  type ScopeRef,
} from '@claude-company/contracts';
import type { Request } from 'express';
import {
  BUDGET_SERVICE,
  ORCHESTRATION_ENGINE,
  ORGANIZATION_ENGINE,
  PERMISSION_ENGINE,
} from '../../platform/engine-tokens';
import { ZodValidationPipe } from '../../platform/http/zod.pipe';
import { Ctx } from '../../platform/tenancy/ctx.decorator';
import { RequireScope } from '../../platform/tenancy/scope.decorators';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Bộ lọc `employeeId` ngoài phạm vi → 403; không có thì cấp công ty (danh sách được lọc theo phạm vi). */
const runListScope = (req: Request): ScopeRef => {
  const employeeId = req.query.employeeId;
  if (typeof employeeId === 'string' && UUID.test(employeeId)) {
    return { kind: 'ai_employee', id: employeeId };
  }
  return { kind: 'company' };
};

function memberIdOf(ctx: RequestContext): string {
  if (ctx.actor.kind !== 'human') {
    throw new DomainError('FORBIDDEN', 'Chỉ người dùng được truy cập qua API');
  }
  return ctx.actor.memberId;
}

/**
 * Mục Execution History của contracts/rest-api.md (US7). Phạm vi cưỡng chế phía server theo nhân viên thực thi run:
 * danh sách chỉ gồm run của nhân viên trong phạm vi quản lý của người xem, chi tiết ngoài phạm vi → `403`.
 */
@Controller('companies/:companyId')
export class RunController {
  constructor(
    @Inject(ORCHESTRATION_ENGINE)
    private readonly orchestration: Pick<OrchestrationEngine, 'listRuns' | 'getRun'>,
    @Inject(PERMISSION_ENGINE) private readonly permissions: Pick<PermissionEngine, 'authorize'>,
    @Inject(ORGANIZATION_ENGINE)
    private readonly organization: Pick<OrganizationEngine, 'resolveManagedScope'>,
    @Inject(BUDGET_SERVICE) private readonly budget: Pick<BudgetService, 'getUsage'>,
  ) {}

  @Get('runs')
  @RequireScope('run.read', runListScope)
  async list(
    @Ctx() ctx: RequestContext,
    @Query(new ZodValidationPipe(runListQuerySchema)) query: RunListQuery,
  ): Promise<Page<AgentRunSummary>> {
    const scope = await this.organization.resolveManagedScope(ctx, memberIdOf(ctx));
    return this.orchestration.listRuns(ctx, {
      taskId: query.taskId,
      employeeId: query.employeeId,
      employeeIds: scope.companyWide ? undefined : scope.employeeIds,
      limit: query.limit,
    });
  }

  /** Steps, tool invocation (mức quyền, kết quả), lỗi, thời gian và usage của một run (US7-AS1). */
  @Get('runs/:id')
  @RequireScope('run.read')
  async get(
    @Ctx() ctx: RequestContext,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ): Promise<AgentRunView> {
    const run = await this.orchestration.getRun(ctx, id);
    await this.permissions.authorize(ctx, 'run.read', { kind: 'ai_employee', id: run.employeeId });
    const usage = await this.budget.getUsage(ctx, { runId: run.id });
    return { ...run, usage: { tokens: usage.tokens, costUsd: usage.costUsd } };
  }
}
