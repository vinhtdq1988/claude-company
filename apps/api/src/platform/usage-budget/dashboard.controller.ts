import { Controller, Get, Query } from '@nestjs/common';
import {
  dashboardQuerySchema,
  type Dashboard,
  type DashboardQuery,
  type RequestContext,
} from '@claude-company/contracts';
import { ZodValidationPipe } from '../http/zod.pipe';
import { Ctx } from '../tenancy/ctx.decorator';
import { RequireScope } from '../tenancy/scope.decorators';
import { usageScope } from './budget.controller';
import { DashboardService } from './dashboard.service';

/** `GET /dashboard?orgUnitId=`: `orgUnitId` ngoài phạm vi quản lý → 403; còn lại chỉ tổng hợp trong phạm vi người xem. */
@Controller('companies/:companyId')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('dashboard')
  @RequireScope('usage.read', usageScope)
  get(
    @Ctx() ctx: RequestContext,
    @Query(new ZodValidationPipe(dashboardQuerySchema)) query: DashboardQuery,
  ): Promise<Dashboard> {
    return this.dashboard.get(ctx, query);
  }
}
