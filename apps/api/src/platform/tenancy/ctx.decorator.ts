import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { DomainError, type RequestContext } from '@claude-company/contracts';
import type { Request } from 'express';

/** Lấy `RequestContext` do TenantGuard dựng; chỉ dùng cho route dưới `/companies/{companyId}`. */
export const Ctx = createParamDecorator(
  (_data: unknown, context: ExecutionContext): RequestContext => {
    const ctx = context.switchToHttp().getRequest<Request>().requestContext;
    if (!ctx)
      throw new DomainError(
        'INTERNAL',
        'Thiếu RequestContext: route không nằm dưới /companies/{companyId}',
      );
    return ctx;
  },
);
