import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import {
  createWorkspaceSchema,
  type CreateWorkspaceInput,
  type RequestContext,
  type Workspace,
} from '@claude-company/contracts';
import { ZodValidationPipe } from '../../platform/http/zod.pipe';
import { Ctx } from '../../platform/tenancy/ctx.decorator';
import { RequireScope } from '../../platform/tenancy/scope.decorators';
import { WorkspaceService } from './workspace.service';

@Controller('companies/:companyId/workspaces')
export class WorkspaceController {
  constructor(private readonly workspaces: WorkspaceService) {}

  @Get()
  @RequireScope('employee.read')
  list(@Ctx() ctx: RequestContext): Promise<Workspace[]> {
    return this.workspaces.list(ctx);
  }

  /** Quyền cấp công ty không phải `.read` nên chỉ CEO đăng ký được. */
  @Post()
  @HttpCode(201)
  @RequireScope('workspace.manage')
  create(
    @Ctx() ctx: RequestContext,
    @Body(new ZodValidationPipe(createWorkspaceSchema)) body: CreateWorkspaceInput,
  ): Promise<Workspace> {
    return this.workspaces.create(ctx, body);
  }
}
