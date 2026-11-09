import { Global, Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { CsrfGuard } from './csrf.guard';
import { SessionGuard } from './session.guard';
import { SessionService } from './session.service';

/** Xác thực. Guard được đăng ký toàn cục theo thứ tự trong AppModule (SessionGuard → CsrfGuard → TenantGuard → ScopeGuard). */
@Global()
@Module({
  controllers: [AuthController],
  providers: [AuthService, SessionService, SessionGuard, CsrfGuard],
  exports: [SessionService, SessionGuard, CsrfGuard],
})
export class AuthModule {}
