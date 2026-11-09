import { Global, Module } from '@nestjs/common';
import { ORGANIZATION_ENGINE } from '../../platform/engine-tokens';
import { OrganizationController } from './organization.controller';
import { OrganizationRepository } from './organization.repository';
import { OrganizationService } from './organization.service';

/**
 * Binding thật của OrganizationEngine (thay stub fail-closed của nền tảng).
 * Phụ thuộc EmployeeEngine và TaskEngine qua injection token, không import nội bộ engine khác.
 */
@Global()
@Module({
  controllers: [OrganizationController],
  providers: [
    OrganizationRepository,
    OrganizationService,
    { provide: ORGANIZATION_ENGINE, useExisting: OrganizationService },
  ],
  exports: [ORGANIZATION_ENGINE, OrganizationService],
})
export class OrganizationModule {}
