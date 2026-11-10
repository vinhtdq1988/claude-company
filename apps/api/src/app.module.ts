import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { CommunicationModule } from './engines/communication/communication.module';
import { EmployeeModule } from './engines/employee/employee.module';
import { GamificationModule } from './engines/gamification/gamification.module';
import { MemoryModule } from './engines/memory/memory.module';
import { OfficeSimulationModule } from './engines/office-simulation/office-simulation.module';
import { OrchestrationModule } from './engines/orchestration/orchestration.module';
import { OrganizationModule } from './engines/organization/organization.module';
import { PermissionModule } from './engines/permission/permission.module';
import { TaskModule } from './engines/task/task.module';
import { ScopeGuard } from './engines/permission/scope.guard';
import { CsrfGuard } from './platform/auth/csrf.guard';
import { SessionGuard } from './platform/auth/session.guard';
import { PlatformModule } from './platform/platform.module';
import { TenantGuard } from './platform/tenancy/tenant.guard';

/**
 * Composition root của API. Thứ tự APP_GUARD là thứ tự chạy:
 * SessionGuard → CsrfGuard → TenantGuard → ScopeGuard (NestJS chạy mọi guard trước interceptor).
 * Engine thêm module của mình vào `imports` ở từng user story.
 */
@Module({
  imports: [
    PlatformModule.register({ http: true }),
    PermissionModule,
    EmployeeModule,
    OrganizationModule,
    TaskModule,
    CommunicationModule,
    MemoryModule,
    OrchestrationModule,
    OfficeSimulationModule,
    GamificationModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: SessionGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: TenantGuard },
    { provide: APP_GUARD, useClass: ScopeGuard },
  ],
})
export class AppModule {}
