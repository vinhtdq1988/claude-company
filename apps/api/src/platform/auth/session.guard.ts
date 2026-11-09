import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DomainError } from '@claude-company/contracts';
import type { Request } from 'express';
import { parseCookies, SESSION_COOKIE } from './cookies';
import { IS_PUBLIC } from './public.decorator';
import { SessionService } from './session.service';

/** Guard thứ 1: xác thực cookie `cc_sid`; mọi route trừ `@Public()` trả 401 khi chưa đăng nhập (FR-030). */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
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
    const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const session = sid ? await this.sessions.get(sid) : null;
    if (!sid || !session) throw new DomainError('UNAUTHENTICATED', 'Chưa đăng nhập');
    req.session = { ...session, sid };
    return true;
  }
}
