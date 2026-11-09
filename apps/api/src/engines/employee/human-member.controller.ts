import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import {
  addMemberSchema,
  DomainError,
  type AddMemberInput,
  type HumanMember,
  type IdentityDirectory,
  type RequestContext,
} from '@claude-company/contracts';
import { IDENTITY_DIRECTORY } from '../../platform/engine-tokens';
import { ZodValidationPipe } from '../../platform/http/zod.pipe';
import { Ctx } from '../../platform/tenancy/ctx.decorator';
import { RequireScope } from '../../platform/tenancy/scope.decorators';
import { HumanMemberService } from './human-member.service';

@Controller('companies/:companyId/members')
export class HumanMemberController {
  constructor(
    private readonly members: HumanMemberService,
    @Inject(IDENTITY_DIRECTORY) private readonly identity: IdentityDirectory,
  ) {}

  @Get()
  @RequireScope('employee.read')
  list(@Ctx() ctx: RequestContext): Promise<HumanMember[]> {
    return this.members.listHumanMembers(ctx);
  }

  /** Chỉ CEO (quyền cấp công ty không phải `.read`); email phải là tài khoản đã đăng ký. */
  @Post()
  @HttpCode(201)
  @RequireScope('member.manage')
  async add(
    @Ctx() ctx: RequestContext,
    @Body(new ZodValidationPipe(addMemberSchema)) body: AddMemberInput,
  ): Promise<HumanMember> {
    const user = await this.identity.findUserByEmail(body.email);
    if (!user) {
      throw new DomainError('VALIDATION_FAILED', 'Email chưa có tài khoản đã đăng ký', {
        field: 'email',
      });
    }
    return this.members.addHumanMember(ctx, {
      userId: user.id,
      role: body.role,
      title: body.title,
    });
  }

  /** Chỉ CEO; `422 MANAGEMENT_CHAIN_INVALID` nếu là người thật cuối của một chuỗi quản lý AI. */
  @Delete(':id')
  @HttpCode(204)
  @RequireScope('member.manage')
  deactivate(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<void> {
    return this.members.deactivateHumanMember(ctx, id);
  }
}
