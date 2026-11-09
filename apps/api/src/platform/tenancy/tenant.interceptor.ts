import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { withTenant } from '@claude-company/db';
import type { Request } from 'express';
import { defer, lastValueFrom, type Observable } from 'rxjs';
import { runWithTenantTx } from './tenant-store';

/**
 * Chạy handler trong `withTenant` với RequestContext đã dựng ở TenantGuard, nên mọi truy vấn của request
 * chịu RLS và cùng một transaction (thay đổi nghiệp vụ và domain_event commit cùng nhau).
 * Request không thuộc company nào đi thẳng, không mở transaction.
 */
@Injectable()
export class TenantInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request>();
    const ctx = req.requestContext;
    if (!ctx) return next.handle();
    const userId = req.session?.userId;
    return defer(() =>
      withTenant(
        ctx.companyId,
        (tx) =>
          runWithTenantTx(ctx.companyId, tx, () =>
            lastValueFrom(next.handle(), { defaultValue: undefined }),
          ),
        userId ? { userId } : {},
      ),
    );
  }
}
