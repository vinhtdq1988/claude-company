import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { TenantGuard } from './tenant.guard';
import { TenantInterceptor } from './tenant.interceptor';

/** TenantGuard được AppModule đăng ký trong chuỗi guard; interceptor chạy handler trong withTenant. */
@Module({
  providers: [TenantGuard, { provide: APP_INTERCEPTOR, useClass: TenantInterceptor }],
  exports: [TenantGuard],
})
export class TenancyModule {}
