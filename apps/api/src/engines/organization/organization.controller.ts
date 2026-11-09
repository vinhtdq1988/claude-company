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
  Put,
  Req,
} from '@nestjs/common';
import {
  assignManagerSchema,
  createCompanySchema,
  createOrgUnitSchema,
  createTeamSchema,
  setTeamMembersSchema,
  updateOrgUnitSchema,
  updateTeamSchema,
  type AssignManagerInput,
  type Company,
  type CreateCompanyInput,
  type CreateOrgUnitInput,
  type CreateTeamInput,
  type OrgChart,
  type OrgTemplateSummary,
  type OrgUnit,
  type PermissionEngine,
  type RequestContext,
  type ScopeRef,
  type SetTeamMembersInput,
  type Team,
  type UpdateOrgUnitInput,
  type UpdateTeamInput,
} from '@claude-company/contracts';
import type { Request } from 'express';
import { PERMISSION_ENGINE } from '../../platform/engine-tokens';
import { ZodValidationPipe } from '../../platform/http/zod.pipe';
import { currentTraceId } from '../../platform/observability/trace';
import { Ctx } from '../../platform/tenancy/ctx.decorator';
import { RequireScope } from '../../platform/tenancy/scope.decorators';
import { OrganizationService } from './organization.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const asUuid = (value: unknown): string | undefined =>
  typeof value === 'string' && UUID.test(value) ? value : undefined;

const bodyField = (req: Request, field: string): unknown =>
  (req.body as Record<string, unknown> | undefined)?.[field];

/** Đơn vị trong đường dẫn `:id`. */
const orgUnitParam = (req: Request): ScopeRef => ({ kind: 'org_unit', id: String(req.params.id) });
const teamParam = (req: Request): ScopeRef => ({ kind: 'team', id: String(req.params.id) });

/** Đơn vị cha trong body; không có parent nghĩa là cấp công ty (chỉ CEO). */
const orgUnitFromParent = (req: Request): ScopeRef => {
  const id = asUuid(bodyField(req, 'parentId'));
  return id ? { kind: 'org_unit', id } : { kind: 'company' };
};

const orgUnitFromBody = (req: Request): ScopeRef => {
  const id = asUuid(bodyField(req, 'orgUnitId'));
  return id ? { kind: 'org_unit', id } : { kind: 'company' };
};

/**
 * Mục Organization của contracts/rest-api.md (trừ `/members`, do HumanMemberController đảm nhiệm).
 * `@RequireScope` đặt phạm vi của đối tượng được sửa; khi thao tác còn chạm đối tượng thứ hai
 * (parent mới, department mới của team) thì handler gọi thêm `authorize` cho đối tượng đó.
 */
@Controller()
export class OrganizationController {
  constructor(
    private readonly organization: OrganizationService,
    @Inject(PERMISSION_ENGINE) private readonly permissions: Pick<PermissionEngine, 'authorize'>,
  ) {}

  /** Chưa thuộc công ty nào nên không qua TenantGuard/ScopeGuard; người tạo trở thành CEO. */
  @Post('companies')
  @HttpCode(201)
  createCompany(
    @Req() req: Request,
    @Body(new ZodValidationPipe(createCompanySchema)) body: CreateCompanyInput,
  ): Promise<Company> {
    const userId = req.session?.userId;
    if (!userId) throw new Error('SessionGuard phải gắn phiên trước khi vào handler');
    return this.organization.createCompany(
      { userId, traceId: req.traceId ?? currentTraceId() ?? '' },
      body,
    );
  }

  @Get('org-templates')
  listTemplates(): Promise<OrgTemplateSummary[]> {
    return this.organization.listTemplates();
  }

  @Get('companies/:companyId')
  @RequireScope('org.read')
  getCompany(@Ctx() ctx: RequestContext): Promise<Company> {
    return this.organization.getCompany(ctx);
  }

  @Get('companies/:companyId/org-chart')
  @RequireScope('org.read')
  getOrgChart(@Ctx() ctx: RequestContext): Promise<OrgChart> {
    return this.organization.getOrgChart(ctx);
  }

  // --- org units ---

  @Post('companies/:companyId/org-units')
  @HttpCode(201)
  @RequireScope('org.manage', orgUnitFromParent)
  createOrgUnit(
    @Ctx() ctx: RequestContext,
    @Body(new ZodValidationPipe(createOrgUnitSchema)) body: CreateOrgUnitInput,
  ): Promise<OrgUnit> {
    return this.organization.upsertOrgUnit(ctx, body);
  }

  @Patch('companies/:companyId/org-units/:id')
  @RequireScope('org.manage', orgUnitParam)
  async updateOrgUnit(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateOrgUnitSchema)) body: UpdateOrgUnitInput,
  ): Promise<OrgUnit> {
    // Chuyển đơn vị sang parent khác (hoặc lên cấp công ty) cũng cần quyền ở nơi nhận.
    if (body.parentId !== undefined) {
      await this.permissions.authorize(
        ctx,
        'org.manage',
        body.parentId === null ? { kind: 'company' } : { kind: 'org_unit', id: body.parentId },
      );
    }
    return this.organization.upsertOrgUnit(ctx, { ...body, id });
  }

  @Delete('companies/:companyId/org-units/:id')
  @HttpCode(204)
  @RequireScope('org.manage', orgUnitParam)
  archiveOrgUnit(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<void> {
    return this.organization.archiveOrgUnit(ctx, id);
  }

  // --- teams ---

  @Post('companies/:companyId/teams')
  @HttpCode(201)
  @RequireScope('org.manage', orgUnitFromBody)
  createTeam(
    @Ctx() ctx: RequestContext,
    @Body(new ZodValidationPipe(createTeamSchema)) body: CreateTeamInput,
  ): Promise<Team> {
    return this.organization.upsertTeam(ctx, body);
  }

  @Patch('companies/:companyId/teams/:id')
  @RequireScope('org.manage', teamParam)
  async updateTeam(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateTeamSchema)) body: UpdateTeamInput,
  ): Promise<Team> {
    if (body.orgUnitId !== undefined) {
      await this.permissions.authorize(ctx, 'org.manage', {
        kind: 'org_unit',
        id: body.orgUnitId,
      });
    }
    return this.organization.upsertTeam(ctx, { ...body, id });
  }

  @Delete('companies/:companyId/teams/:id')
  @HttpCode(204)
  @RequireScope('org.manage', teamParam)
  archiveTeam(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<void> {
    return this.organization.archiveTeam(ctx, id);
  }

  @Put('companies/:companyId/teams/:id/members')
  @HttpCode(204)
  @RequireScope('org.manage', teamParam)
  setTeamMembers(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(setTeamMembersSchema)) body: SetTeamMembersInput,
  ): Promise<void> {
    return this.organization.setTeamMembers(ctx, id, body.members);
  }

  // --- manager ---

  /** Không có `target`: quyền cấp công ty, chỉ CEO được gán manager (FR-005). */
  @Put('companies/:companyId/management-assignments')
  @HttpCode(204)
  @RequireScope('org.manage')
  assignManager(
    @Ctx() ctx: RequestContext,
    @Body(new ZodValidationPipe(assignManagerSchema)) body: AssignManagerInput,
  ): Promise<void> {
    return this.organization.assignManager(
      ctx,
      { kind: body.targetKind, id: body.targetId },
      body.managerMemberId,
    );
  }
}
