import { Body, Controller, Get, Inject, Param, Put, Query } from '@nestjs/common';
import {
  budgetScopeKindSchema,
  DomainError,
  putBudgetPolicySchema,
  usageQuerySchema,
  uuidSchema,
  type BudgetPolicy,
  type BudgetScopeKind,
  type OrganizationEngine,
  type PutBudgetPolicyBody,
  type RequestContext,
  type ScopeRef,
  type UsageQuery,
  type UsageSummary,
} from '@claude-company/contracts';
import type { Request } from 'express';
import { ORGANIZATION_ENGINE } from '../engine-tokens';
import { ZodValidationPipe } from '../http/zod.pipe';
import { Ctx } from '../tenancy/ctx.decorator';
import { RequireScope } from '../tenancy/scope.decorators';
import { UsageBudgetService } from './budget.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS: readonly string[] = ['company', 'org_unit', 'team', 'ai_employee'];

/**
 * Phạm vi trong đường dẫn `/budget-policies/:scopeKind/:scopeId`. Công ty là phạm vi cấp công ty (chỉ CEO);
 * đơn vị cha, team hay nhân viên ngoài phạm vi quản lý thì bị `ScopeGuard` từ chối (403) cả khi đọc lẫn khi sửa.
 */
const policyScope = (req: Request): ScopeRef => {
  const kind = String(req.params.scopeKind);
  const id = String(req.params.scopeId);
  if (kind === 'company' || !KINDS.includes(kind) || !UUID.test(id)) return { kind: 'company' };
  return { kind: kind as ScopeRef['kind'], id };
};

/** Bộ lọc `orgUnitId`/`employeeId` trong query ngoài phạm vi → 403; không có thì cấp công ty (dữ liệu được lọc theo phạm vi). */
export const usageScope = (req: Request): ScopeRef => {
  const orgUnitId = req.query.orgUnitId;
  if (typeof orgUnitId === 'string' && UUID.test(orgUnitId))
    return { kind: 'org_unit', id: orgUnitId };
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

/** Mục Budget & Dashboard của contracts/rest-api.md (phần chính sách và usage). */
@Controller('companies/:companyId')
export class BudgetController {
  constructor(
    private readonly budget: UsageBudgetService,
    @Inject(ORGANIZATION_ENGINE)
    private readonly organization: Pick<OrganizationEngine, 'resolveManagedScope'>,
  ) {}

  @Get('budget-policies/:scopeKind/:scopeId')
  @RequireScope('budget.manage', policyScope)
  getPolicy(
    @Ctx() ctx: RequestContext,
    @Param('scopeKind', new ZodValidationPipe(budgetScopeKindSchema)) scopeKind: BudgetScopeKind,
    @Param('scopeId', new ZodValidationPipe(uuidSchema)) scopeId: string,
  ): Promise<BudgetPolicy> {
    return this.budget.getPolicy(ctx, scopeKind, scopeId);
  }

  @Put('budget-policies/:scopeKind/:scopeId')
  @RequireScope('budget.manage', policyScope)
  putPolicy(
    @Ctx() ctx: RequestContext,
    @Param('scopeKind', new ZodValidationPipe(budgetScopeKindSchema)) scopeKind: BudgetScopeKind,
    @Param('scopeId', new ZodValidationPipe(uuidSchema)) scopeId: string,
    @Body(new ZodValidationPipe(putBudgetPolicySchema)) body: PutBudgetPolicyBody,
  ): Promise<BudgetPolicy> {
    return this.budget.upsertPolicy(ctx, scopeKind, scopeId, body);
  }

  /** Chỉ cộng dữ liệu thuộc phạm vi quản lý của người xem (FR-028). */
  @Get('usage')
  @RequireScope('usage.read', usageScope)
  async usage(
    @Ctx() ctx: RequestContext,
    @Query(new ZodValidationPipe(usageQuerySchema)) query: UsageQuery,
  ): Promise<UsageSummary> {
    const scope = await this.organization.resolveManagedScope(ctx, memberIdOf(ctx));
    return this.budget.getUsage(ctx, { ...query, scope });
  }
}
