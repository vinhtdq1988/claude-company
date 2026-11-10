import { Module } from '@nestjs/common';
import {
  CONFIG,
  CommunicationModule,
  EmployeeModule,
  GamificationModule,
  MemoryModule,
  OfficeSimulationModule,
  OrchestrationModule,
  OrganizationModule,
  PermissionModule,
  PlatformModule,
  TaskModule,
  type AppConfig,
} from '@claude-company/api';
import { createModelGateway, type ModelGateway } from '@claude-company/model-gateway';
import { MODEL_GATEWAY, SANDBOX_CLIENT } from './runtime/tokens';
import { AdaptersModule } from './tools/adapters/adapters.module';
import { HttpSandboxClient, UnconfiguredSandboxClient, type SandboxClient } from './tools/sandbox-client';
import { WorkerRuntime } from './worker-runtime';

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
    TaskModule,
    CommunicationModule,
    MemoryModule,
    OrchestrationModule,
    OfficeSimulationModule,
    GamificationModule,
    AdaptersModule,
  ],
  providers: [
    {
      provide: MODEL_GATEWAY,
      inject: [CONFIG],
      // `MODEL_PROVIDER=fake`: FakeModelProvider tất định, không tốn token (Playwright, test).
      useFactory: (config: AppConfig): ModelGateway => {
        if (config.MODEL_PROVIDER === 'fake') return createModelGateway({ provider: 'fake' });
        const agentSdk = {
          httpsProxy: config.EGRESS_PROXY_URL,
          noProxy: 'localhost,127.0.0.1,sandbox-runner,postgres,redis,minio,api',
        };
        // `claude_subscription` (chỉ local): đăng nhập subscription của Claude Code CLI, không có API key.
        return config.MODEL_PROVIDER === 'claude_subscription'
          ? createModelGateway({ provider: 'claude_subscription', agentSdk })
          : createModelGateway({
              provider: 'anthropic',
              apiKey: config.ANTHROPIC_API_KEY ?? '',
              agentSdk,
            });
      },
    },
    {
      provide: SANDBOX_CLIENT,
      inject: [CONFIG],
      useFactory: (config: AppConfig): SandboxClient =>
        config.SANDBOX_RUNNER_URL && config.SANDBOX_RUNNER_TOKEN
          ? new HttpSandboxClient(config.SANDBOX_RUNNER_URL, config.SANDBOX_RUNNER_TOKEN)
          : new UnconfiguredSandboxClient(),
    },
    WorkerRuntime,
  ],
})
export class WorkerModule {}
