import { Module } from '@nestjs/common';
import {
  EmployeeModule,
  OrganizationModule,
  PermissionModule,
  PlatformModule,
} from '@claude-company/api';

/**
 * Worker dùng lại module engine + platform của API qua '@claude-company/api'.
 * `http: false`: không nạp auth, tenancy HTTP và realtime gateway.
 */
@Module({
  imports: [
    PlatformModule.register({ http: false }),
    PermissionModule,
    EmployeeModule,
    OrganizationModule,
  ],
})
export class WorkerModule {}
