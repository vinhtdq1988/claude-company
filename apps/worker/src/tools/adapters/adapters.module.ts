import { Global, Module } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  CONFIG,
  EMPLOYEE_ENGINE,
  ORGANIZATION_ENGINE,
  TASK_ENGINE,
  TOOL_ADAPTER_LOOKUP,
  type AppConfig,
} from '@claude-company/api';
import type { EmployeeEngine, OrganizationEngine, TaskEngine } from '@claude-company/contracts';
import { createAdapterRegistry } from './registry';

/**
 * Global để `OrchestrationService` (trong API module dùng lại ở worker) nhận được registry qua `TOOL_ADAPTER_LOOKUP`
 * cho recovery; API thuần không cung cấp token này nên không có adapter nào ở process API.
 */
@Global()
@Module({
  providers: [
    {
      provide: TOOL_ADAPTER_LOOKUP,
      inject: [CONFIG, ModuleRef],
      useFactory: (config: AppConfig, moduleRef: ModuleRef) =>
        createAdapterRegistry({
          mode: config.ADAPTER_MODE,
          logDir: config.DRY_RUN_LOG_PATH,
          // Engine lấy muộn: provider alias (`useExisting`) của engine chưa sẵn sàng lúc dựng registry.
          internalEngines: () => ({
            organization: moduleRef.get<OrganizationEngine>(ORGANIZATION_ENGINE, { strict: false }),
            employees: moduleRef.get<EmployeeEngine>(EMPLOYEE_ENGINE, { strict: false }),
            tasks: moduleRef.get<TaskEngine>(TASK_ENGINE, { strict: false }),
          }),
        }),
    },
  ],
  exports: [TOOL_ADAPTER_LOOKUP],
})
export class AdaptersModule {}
