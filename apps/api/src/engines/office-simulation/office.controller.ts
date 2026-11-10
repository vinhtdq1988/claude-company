import { Controller, Get, Inject, Param } from '@nestjs/common';
import type {
  EmployeeProfileView,
  OfficeSimulationEngine,
  OfficeSnapshot,
  RequestContext,
  ScopeRef,
} from '@claude-company/contracts';
import type { Request } from 'express';
import { OFFICE_SIMULATION_ENGINE } from '../../platform/engine-tokens';
import { Ctx } from '../../platform/tenancy/ctx.decorator';
import { MemberScope, RequireScope } from '../../platform/tenancy/scope.decorators';

/** Nhân viên trong đường dẫn `:id`: quyền xem profile-view theo phạm vi quản lý của người xem. */
const employeeParam = (req: Request): ScopeRef => ({
  kind: 'ai_employee',
  id: String(req.params.id),
});

/**
 * Mục Office của contracts/rest-api.md. Phạm vi cưỡng chế phía server: snapshot chỉ gồm nhân viên trong phạm vi
 * người xem; `profile-view` ngoài phạm vi bị `ScopeGuard` từ chối (403).
 */
@Controller('companies/:companyId')
export class OfficeController {
  constructor(@Inject(OFFICE_SIMULATION_ENGINE) private readonly office: OfficeSimulationEngine) {}

  @Get('office/snapshot')
  @MemberScope()
  snapshot(@Ctx() ctx: RequestContext): Promise<OfficeSnapshot> {
    return this.office.getSnapshot(ctx);
  }

  @Get('employees/:id/profile-view')
  @RequireScope('employee.read', employeeParam)
  profileView(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<EmployeeProfileView> {
    return this.office.getProfileView(ctx, id);
  }
}
