import { Module } from '@nestjs/common';
import {
  CONFIG,
  CommunicationModule,
  EmployeeModule,
  MemoryModule,
  OrchestrationModule,
  OrganizationModule,
  PermissionModule,
  PlatformModule,
  TaskModule,
  type AppConfig,
} from '@claude-company/api';
import { createModelGateway, type ModelGateway } from '@claude-company/model-gateway';
import { MODEL_GATEWAY, SANDBOX_CLIENT } from './runtime/tokens';
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
  ],
  providers: [
    {
      provide: MODEL_GATEWAY,
      inject: [CONFIG],
      // `MODEL_PROVIDER=fake`: FakeModelProvider tất định, không tốn token (Playwright, test).
      useFactory: (config: AppConfig): ModelGateway =>
        config.MODEL_PROVIDER === 'fake'
          ? createModelGateway({ provider: 'fake' })
          : createModelGateway({
              provider: 'anthropic',
              apiKey: config.ANTHROPIC_API_KEY ?? '',
              agentSdk: {
                httpsProxy: config.EGRESS_PROXY_URL,
                noProxy: 'localhost,127.0.0.1,sandbox-runner,postgres,redis,minio,api',
              },
            }),
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
