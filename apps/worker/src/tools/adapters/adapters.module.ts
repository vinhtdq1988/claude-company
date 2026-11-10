import { Global, Module } from '@nestjs/common';
import { CONFIG, TOOL_ADAPTER_LOOKUP, type AppConfig } from '@claude-company/api';
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
      inject: [CONFIG],
      useFactory: (config: AppConfig) =>
        createAdapterRegistry({ mode: config.ADAPTER_MODE, logDir: config.DRY_RUN_LOG_PATH }),
    },
  ],
  exports: [TOOL_ADAPTER_LOOKUP],
})
export class AdaptersModule {}
