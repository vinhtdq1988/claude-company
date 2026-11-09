import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DomainError, type EmployeeEngine, type RequestContext } from '@claude-company/contracts';
import type { Request } from 'express';
import { IS_PUBLIC } from '../auth/public.decorator';
import { EMPLOYEE_ENGINE } from '../engine-tokens';
import { currentTraceId, resolveTraceId } from '../observability/trace';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Guard thứ 3: đọc `companyId` từ đường dẫn, hỏi membership của người dùng; không phải thành viên → 404
 * (không tiết lộ công ty có tồn tại), rồi dựng `RequestContext` gắn vào request.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(EMPLOYEE_ENGINE) private readonly employees: Pick<EmployeeEngine, 'findMemberships'>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      return true;
    }
    const req = context.switchToHttp().getRequest<Request>();
    const companyId = req.params.companyId;
    if (typeof companyId !== 'string') return true; // route không thuộc một company cụ thể
    const session = req.session;
    if (!session) throw new DomainError('UNAUTHENTICATED', 'Chưa đăng nhập');
    if (!UUID.test(companyId)) throw new DomainError('NOT_FOUND', 'Không tìm thấy công ty');

    const memberships = await this.employees.findMemberships(session.userId);
    const membership = memberships.find(
      (m) => m.companyId.toLowerCase() === companyId.toLowerCase(),
    );
    if (!membership) throw new DomainError('NOT_FOUND', 'Không tìm thấy công ty');

    const ctx: RequestContext = {
      companyId: membership.companyId,
      actor: { kind: 'human', memberId: membership.memberId },
      traceId: req.traceId ?? currentTraceId() ?? resolveTraceId(req.headers.traceparent),
    };
    req.requestContext = ctx;
    req.membership = membership;
    return true;
  }
}
