import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import {
  approvalDecisionSchema,
  approvalListQuerySchema,
  DomainError,
  type ApprovalDecisionBody,
  type ApprovalListQuery,
  type ApprovalRequest,
  type OrganizationEngine,
  type Page,
  type PermissionEngine,
  type RequestContext,
} from '@claude-company/contracts';
import { ORGANIZATION_ENGINE, PERMISSION_ENGINE } from '../../platform/engine-tokens';
import { ZodValidationPipe } from '../../platform/http/zod.pipe';
import { Ctx } from '../../platform/tenancy/ctx.decorator';
import { MemberScope } from '../../platform/tenancy/scope.decorators';

function memberIdOf(ctx: RequestContext): string {
  if (ctx.actor.kind !== 'human') {
    throw new DomainError('FORBIDDEN', 'Chỉ người dùng được truy cập qua API');
  }
  return ctx.actor.memberId;
}

/**
 * Mục Approvals của contracts/rest-api.md. Phạm vi cưỡng chế phía server: danh sách chỉ gồm yêu cầu của nhân viên
 * trong phạm vi quản lý của người xem; quyết định do `PermissionEngine.decideApproval` kiểm tra phạm vi lần nữa.
 */
@Controller('companies/:companyId')
export class ApprovalController {
  constructor(
    @Inject(PERMISSION_ENGINE) private readonly permissions: PermissionEngine,
    @Inject(ORGANIZATION_ENGINE)
    private readonly organization: Pick<OrganizationEngine, 'resolveManagedScope'>,
  ) {}

  @Get('approvals')
  @MemberScope()
  async list(
    @Ctx() ctx: RequestContext,
    @Query(new ZodValidationPipe(approvalListQuerySchema)) query: ApprovalListQuery,
  ): Promise<Page<ApprovalRequest>> {
    const scope = await this.organization.resolveManagedScope(ctx, memberIdOf(ctx));
    return this.permissions.listApprovals(ctx, {
      status: query.status,
      employeeIds: scope.companyWide ? undefined : scope.employeeIds,
      limit: query.limit,
    });
  }

  @Get('approvals/:id')
  @MemberScope()
  async get(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<ApprovalRequest> {
    const approval = await this.permissions.getApproval(ctx, id);
    await this.permissions.authorize(ctx, 'approval.decide', {
      kind: 'ai_employee',
      id: approval.employeeId,
    });
    return approval;
  }

  /** `reason` bắt buộc cho cả approve và reject (thiếu → 422); `payloadHash` sai → `409 APPROVAL_PAYLOAD_CHANGED`. */
  @Post('approvals/:id/decision')
  @HttpCode(200)
  @MemberScope()
  async decide(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(approvalDecisionSchema)) body: ApprovalDecisionBody,
  ): Promise<ApprovalRequest> {
    return this.permissions.decideApproval(ctx, id, body);
  }
}
