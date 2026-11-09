import { Controller, Get, Module, Param, Post } from '@nestjs/common';
import type { RequestContext } from '@claude-company/contracts';
import { humanMember } from '@claude-company/db/schema/employee';
import { count } from 'drizzle-orm';
import { MemberScope, RequireScope } from '../../apps/api/src/platform/tenancy/scope.decorators';
import { Ctx } from '../../apps/api/src/platform/tenancy/ctx.decorator';
import { inTenant } from '../../apps/api/src/platform/tenancy/tenant-store';

/**
 * Route thử tenant, chỉ đăng ký khi test (tests/support/app.ts). Dùng để kiểm tra guard, CSRF, RLS
 * mà không phụ thuộc controller của engine.
 */
@Controller('companies/:companyId/_probe')
export class TenantProbeController {
  /** Chỉ cần là thành viên. */
  @Get('member')
  @MemberScope()
  member(@Ctx() ctx: RequestContext) {
    return { ok: true, companyId: ctx.companyId };
  }

  /** Đọc dữ liệu dưới RLS: số human_member nhìn thấy trong company hiện tại. */
  @Get('data')
  @RequireScope('employee.read')
  async data(@Ctx() ctx: RequestContext) {
    const rows = await inTenant(ctx, (tx) => tx.select({ n: count() }).from(humanMember));
    return { visibleMembers: rows[0]?.n ?? 0 };
  }

  /** Cần phạm vi của một org_unit cụ thể. */
  @Get('units/:unitId')
  @RequireScope('org.manage', (req) => ({ kind: 'org_unit', id: String(req.params.unitId) }))
  unit(@Param('unitId') unitId: string) {
    return { ok: true, unitId };
  }

  /** Route ghi để kiểm tra CSRF. */
  @Post('write')
  @MemberScope()
  write() {
    return { ok: true };
  }
}

@Module({ controllers: [TenantProbeController] })
export class TenantProbeModule {}
