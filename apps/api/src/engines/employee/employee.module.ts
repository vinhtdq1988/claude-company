import { Global, Module } from '@nestjs/common';
import { EMPLOYEE_ENGINE } from '../../platform/engine-tokens';
import { EmployeeController } from './employee.controller';
import { EmployeeRepository } from './employee.repository';
import { EmployeeService } from './employee.service';
import { HumanMemberController } from './human-member.controller';
import { HumanMemberService } from './human-member.service';
import { WorkspaceController } from './workspace.controller';
import { WorkspaceService } from './workspace.service';

/**
 * Binding thật của EmployeeEngine (thay stub AI Employee của nền tảng).
 * Phụ thuộc OrganizationEngine, TaskEngine và ModelCatalog qua injection token, không import nội bộ engine khác.
 */
@Global()
@Module({
  controllers: [EmployeeController, HumanMemberController, WorkspaceController],
  providers: [
    EmployeeRepository,
    HumanMemberService,
    WorkspaceService,
    EmployeeService,
    { provide: EMPLOYEE_ENGINE, useExisting: EmployeeService },
  ],
  exports: [EMPLOYEE_ENGINE, EmployeeService, HumanMemberService],
})
export class EmployeeModule {}
