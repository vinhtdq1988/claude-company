import { Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import {
  DomainError,
  pageQuerySchema,
  type CommunicationEngine,
  type Notification,
  type Page,
  type RequestContext,
} from '@claude-company/contracts';
import { z } from 'zod';
import { COMMUNICATION_ENGINE } from '../../platform/engine-tokens';
import { ZodValidationPipe } from '../../platform/http/zod.pipe';
import { Ctx } from '../../platform/tenancy/ctx.decorator';
import { MemberScope } from '../../platform/tenancy/scope.decorators';

const listQuerySchema = pageQuerySchema.extend({
  unread: z.enum(['true', 'false']).optional(),
});

function memberIdOf(ctx: RequestContext): string {
  if (ctx.actor.kind !== 'human') {
    throw new DomainError('FORBIDDEN', 'Chỉ người dùng được truy cập thông báo');
  }
  return ctx.actor.memberId;
}

/** Thông báo của chính thành viên đang đăng nhập: chỉ cần là thành viên công ty (`@MemberScope`). */
@Controller('companies/:companyId/notifications')
export class NotificationController {
  constructor(@Inject(COMMUNICATION_ENGINE) private readonly communication: CommunicationEngine) {}

  @Get()
  @MemberScope()
  list(
    @Ctx() ctx: RequestContext,
    @Query(new ZodValidationPipe(listQuerySchema)) query: z.infer<typeof listQuerySchema>,
  ): Promise<Page<Notification>> {
    return this.communication.listNotifications(ctx, memberIdOf(ctx), {
      unread: query.unread === 'true',
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  @Post('read-all')
  @HttpCode(200)
  @MemberScope()
  async readAll(@Ctx() ctx: RequestContext): Promise<{ updated: number }> {
    return { updated: await this.communication.markAllRead(ctx, memberIdOf(ctx)) };
  }

  @Post(':id/read')
  @HttpCode(204)
  @MemberScope()
  read(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<void> {
    return this.communication.markRead(ctx, memberIdOf(ctx), id);
  }
}
