import { type DynamicModule, Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { IdentityModule } from './auth/identity.module';
import { ConfigModule } from './config/infra.providers';
import { EventsModule } from './events/events.module';
import { HttpModule } from './http/http.module';
import { ObservabilityModule } from './observability/observability.module';
import { QueueModule } from './queue/queues';
import { RealtimeModule } from './realtime/realtime.module';
import { EmptyEnginesModule } from './stubs/empty-engines';
import { StorageModule } from './storage/storage.module';
import { TenancyModule } from './tenancy/tenancy.module';
import { UsageBudgetModule } from './usage-budget/usage-budget.module';

/**
 * Gom config, observability, events, storage, queue, usage-budget, tenancy, auth, realtime.
 * Worker gọi `register({ http: false })`: không nạp auth, tenancy HTTP và realtime gateway.
 */
@Module({})
export class PlatformModule {
  static register(options: { http: boolean }): DynamicModule {
    const shared = [
      ConfigModule,
      IdentityModule,
      ObservabilityModule,
      EventsModule,
      StorageModule,
      QueueModule,
      UsageBudgetModule,
      EmptyEnginesModule,
    ];
    const http = options.http ? [HttpModule, AuthModule, TenancyModule, RealtimeModule] : [];
    return {
      module: PlatformModule,
      imports: [...shared, ...http],
      exports: [...shared, ...http],
    };
  }
}
