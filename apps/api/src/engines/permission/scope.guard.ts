import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { withTenant } from '@claude-company/db';
import { DomainError, type PermissionEngine } from '@claude-company/contracts';
import type { Request } from 'express';
import { IS_PUBLIC } from '../../platform/auth/public.decorator';
import { PERMISSION_ENGINE } from '../../platform/engine-tokens';
import {
  MEMBER_SCOPE,
  REQUIRE_SCOPE,
  type RequireScopeMeta,
} from '../../platform/tenancy/scope.decorators';
import { runWithTenantTx } from '../../platform/tenancy/tenant-store';

/**
 * Guard thứ 4: cưỡng chế phạm vi quản lý phía server. Mọi controller dưới `/companies/{cid}` phải gắn
 * `@RequireScope` hoặc `@MemberScope`; thiếu cả hai thì từ chối (fail-closed).
 */
@Injectable()
export class ScopeGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(PERMISSION_ENGINE) private readonly permissions: Pick<PermissionEngine, 'authorize'>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;
    const req = context.switchToHttp().getRequest<Request>();
    const ctx = req.requestContext;
    if (!ctx) return true; // route ngoài /companies/{cid}

    if (this.reflector.getAllAndOverride<boolean>(MEMBER_SCOPE, targets)) return true;
    const meta = this.reflector.getAllAndOverride<RequireScopeMeta | undefined>(
      REQUIRE_SCOPE,
      targets,
    );
    if (!meta) throw new DomainError('FORBIDDEN', 'Route thiếu khai báo phạm vi truy cập');

    const target = meta.target?.(req) ?? { kind: 'company' };
    // Đọc phạm vi trong transaction riêng, chỉ đọc, dưới RLS của công ty.
    await withTenant(
      ctx.companyId,
      (tx) =>
        runWithTenantTx(ctx.companyId, tx, () =>
          this.permissions.authorize(ctx, meta.permission, target),
        ),
      req.session ? { userId: req.session.userId } : {},
    );
    return true;
  }
}
