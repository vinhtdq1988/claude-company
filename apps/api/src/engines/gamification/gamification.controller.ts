import { Controller, Get, Inject } from '@nestjs/common';
import type { GamificationEngine, Milestone, RequestContext } from '@claude-company/contracts';
import { GAMIFICATION_ENGINE } from '../../platform/engine-tokens';
import { Ctx } from '../../platform/tenancy/ctx.decorator';
import { MemberScope } from '../../platform/tenancy/scope.decorators';

/**
 * Mục Notifications & Milestones của contracts/rest-api.md. Cột mốc là thông tin của cả công ty (không gắn với
 * nhân viên cụ thể, cũng không chứa dữ liệu nhạy cảm) nên mọi thành viên đều xem được.
 */
@Controller('companies/:companyId')
export class GamificationController {
  constructor(@Inject(GAMIFICATION_ENGINE) private readonly gamification: GamificationEngine) {}

  @Get('milestones')
  @MemberScope()
  list(@Ctx() ctx: RequestContext): Promise<Milestone[]> {
    return this.gamification.list(ctx);
  }
}
