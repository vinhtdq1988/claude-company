import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  DomainError,
  loginSchema,
  registerSchema,
  type AuthSessionResponse,
  type EmployeeEngine,
  type LoginInput,
  type RegisterInput,
} from '@claude-company/contracts';
import type { Request, Response } from 'express';
import type { AppConfig } from '../config/config';
import { CONFIG } from '../config/infra.providers';
import { EMPLOYEE_ENGINE } from '../engine-tokens';
import { AuthRateLimitGuard } from '../http/security';
import { ZodValidationPipe } from '../http/zod.pipe';
import { AuthService } from './auth.service';
import { SESSION_COOKIE } from './cookies';
import { Public } from './public.decorator';
import { SessionService } from './session.service';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    @Inject(EMPLOYEE_ENGINE) private readonly employees: Pick<EmployeeEngine, 'findMemberships'>,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  private cookieOptions() {
    return { httpOnly: true, secure: true, sameSite: 'lax', path: '/' } as const;
  }

  private setCookie(res: Response, sid: string): void {
    res.cookie(SESSION_COOKIE, sid, {
      ...this.cookieOptions(),
      maxAge: this.config.SESSION_TTL_SECONDS * 1000,
    });
  }

  @Public()
  @UseGuards(AuthRateLimitGuard)
  @Post('register')
  async register(
    @Body(new ZodValidationPipe(registerSchema)) body: RegisterInput,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthSessionResponse> {
    const user = await this.auth.register(body);
    const { sid, session } = await this.sessions.create(user.id);
    this.setCookie(res, sid);
    return { user, csrfToken: session.csrfToken, memberships: [] };
  }

  @Public()
  @UseGuards(AuthRateLimitGuard)
  @Post('login')
  @HttpCode(200)
  async login(
    @Body(new ZodValidationPipe(loginSchema)) body: LoginInput,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthSessionResponse> {
    const user = await this.auth.login(body);
    const { sid, session } = await this.sessions.create(user.id);
    this.setCookie(res, sid);
    return {
      user,
      csrfToken: session.csrfToken,
      memberships: await this.employees.findMemberships(user.id),
    };
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    if (req.session) await this.sessions.destroy(req.session.sid);
    res.clearCookie(SESSION_COOKIE, this.cookieOptions());
  }

  @Get('me')
  async me(@Req() req: Request): Promise<AuthSessionResponse> {
    const session = req.session;
    if (!session) throw new DomainError('UNAUTHENTICATED', 'Chưa đăng nhập');
    const user = await this.auth.getUser(session.userId);
    if (!user) throw new DomainError('UNAUTHENTICATED', 'Tài khoản không còn hiệu lực');
    return {
      user,
      csrfToken: session.csrfToken,
      memberships: await this.employees.findMemberships(user.id),
    };
  }
}
