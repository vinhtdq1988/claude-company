import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  createEmployeeSchema,
  DomainError,
  employeeFilterQuerySchema,
  updateEmployeeSchema,
  type CreateEmployeeInput,
  type EmployeeProfile,
  type EmployeeProfileInput,
  type ModelCatalog,
  type ModelInfo,
  type OrganizationEngine,
  type PermissionEngine,
  type RequestContext,
  type RoleTemplate,
  type ScopeRef,
  type UpdateEmployeeInput,
} from '@claude-company/contracts';
import type { Request } from 'express';
import {
  MODEL_CATALOG,
  ORGANIZATION_ENGINE,
  PERMISSION_ENGINE,
} from '../../platform/engine-tokens';
import { ZodValidationPipe } from '../../platform/http/zod.pipe';
import { Ctx } from '../../platform/tenancy/ctx.decorator';
import { RequireScope } from '../../platform/tenancy/scope.decorators';
import { EmployeeService } from './employee.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Nhân viên trong đường dẫn `:id`. */
const employeeParam = (req: Request): ScopeRef => ({
  kind: 'ai_employee',
  id: String(req.params.id),
});

/** Department "nhà" trong body; thiếu hoặc sai định dạng nghĩa là cấp công ty (chỉ CEO). */
const homeUnitFromBody = (req: Request): ScopeRef => {
  const value = (req.body as Record<string, unknown> | undefined)?.homeOrgUnitId;
  return typeof value === 'string' && UUID.test(value)
    ? { kind: 'org_unit', id: value }
    : { kind: 'company' };
};

type EmployeeQuery = ReturnType<typeof employeeFilterQuerySchema.parse>;

/** Mục Employees của contracts/rest-api.md (trừ `profile-view`, làm ở US5). */
@Controller()
export class EmployeeController {
  constructor(
    private readonly employees: EmployeeService,
    @Inject(ORGANIZATION_ENGINE)
    private readonly organization: Pick<OrganizationEngine, 'resolveManagedScope'>,
    @Inject(PERMISSION_ENGINE) private readonly permissions: Pick<PermissionEngine, 'authorize'>,
    @Inject(MODEL_CATALOG) private readonly models: Pick<ModelCatalog, 'listModels'>,
  ) {}

  // --- danh mục toàn cục (không thuộc công ty nào) ---

  @Get('role-templates')
  listRoleTemplates(): Promise<RoleTemplate[]> {
    return this.employees.listRoleTemplates();
  }

  @Get('models')
  listModels(): Promise<ModelInfo[]> {
    return this.models.listModels();
  }

  // --- nhân viên ---

  /** Danh sách chỉ gồm nhân viên trong phạm vi quản lý của người xem (FR-028). */
  @Get('companies/:companyId/employees')
  @RequireScope('employee.read')
  async list(
    @Ctx() ctx: RequestContext,
    @Query(new ZodValidationPipe(employeeFilterQuerySchema)) filter: EmployeeQuery,
  ): Promise<EmployeeProfile[]> {
    if (ctx.actor.kind !== 'human') {
      throw new DomainError('FORBIDDEN', 'Chỉ người dùng được truy cập qua API');
    }
    const [scope, all] = await Promise.all([
      this.organization.resolveManagedScope(ctx, ctx.actor.memberId),
      this.employees.list(ctx, { ...filter, withPerformance: true }),
    ]);
    if (scope.companyWide) return all;
    const visible = new Set(scope.employeeIds);
    return all.filter((e) => visible.has(e.id));
  }

  @Post('companies/:companyId/employees')
  @HttpCode(201)
  @RequireScope('employee.manage', homeUnitFromBody)
  create(
    @Ctx() ctx: RequestContext,
    @Body(new ZodValidationPipe(createEmployeeSchema)) body: CreateEmployeeInput,
  ): Promise<EmployeeProfile> {
    // `manager` thiếu được service chuyển thành MANAGER_REQUIRED nên kiểu tại đây được nới có chủ ý.
    return this.employees.create(ctx, body as EmployeeProfileInput);
  }

  @Get('companies/:companyId/employees/:id')
  @RequireScope('employee.read', employeeParam)
  get(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<EmployeeProfile> {
    return this.employees.get(ctx, id);
  }

  @Patch('companies/:companyId/employees/:id')
  @RequireScope('employee.manage', employeeParam)
  async update(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateEmployeeSchema)) body: UpdateEmployeeInput,
  ): Promise<EmployeeProfile> {
    // Chuyển nhân viên sang department khác cũng cần quyền ở nơi nhận.
    if (body.homeOrgUnitId !== undefined) {
      await this.permissions.authorize(ctx, 'employee.manage', {
        kind: 'org_unit',
        id: body.homeOrgUnitId,
      });
    }
    return this.employees.update(ctx, id, body);
  }

  @Post('companies/:companyId/employees/:id/suspend')
  @HttpCode(204)
  @RequireScope('employee.manage', employeeParam)
  suspend(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<void> {
    return this.employees.suspend(ctx, id);
  }

  @Post('companies/:companyId/employees/:id/resume')
  @HttpCode(204)
  @RequireScope('employee.manage', employeeParam)
  resume(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<void> {
    return this.employees.resume(ctx, id);
  }

  @Delete('companies/:companyId/employees/:id')
  @HttpCode(204)
  @RequireScope('employee.manage', employeeParam)
  archive(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<void> {
    return this.employees.archive(ctx, id);
  }
}
