import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { closeDatabase, type Database } from '@claude-company/db';
import request from 'supertest';
import { AppModule } from '../../apps/api/src/app.module';
import { API_PREFIX, configureApp } from '../../apps/api/src/app.setup';
import {
  EMPLOYEE_ENGINE,
  ORGANIZATION_ENGINE,
  TASK_ENGINE,
} from '../../apps/api/src/platform/engine-tokens';
import { loadConfig, type AppConfig } from '../../apps/api/src/platform/config/config';
import { CONFIG, DATABASE } from '../../apps/api/src/platform/config/infra.providers';
import { StorageService } from '../../apps/api/src/platform/storage/storage.service';
import { QueueService } from '../../apps/api/src/platform/queue/queues';
import { WorkerModule } from '../../apps/worker/src/worker.module';
import type { StartedInfra } from './containers';
import { TenantProbeModule } from './tenant-probe.controller';

export type EngineOverrides = {
  organization?: object;
  employee?: object;
  task?: object;
};

export interface CreateTestAppOptions {
  infra: StartedInfra;
  overrides?: EngineOverrides;
  /** Biến môi trường ghi đè cấu hình test. */
  env?: Record<string, string>;
  /** Khởi động thêm worker (application context) dùng chung hạ tầng. */
  withWorker?: boolean;
  /**
   * ModelGateway cho worker. T098 đăng ký FakeModelProvider tại đây; Phase 2 chưa có ModelGateway
   * nên tham số chỉ được giữ lại để test các story sau không phải đổi chữ ký.
   */
  modelGateway?: unknown;
  /** Mặc định đăng ký route thử tenant. */
  tenantProbe?: boolean;
}

export interface TestApp {
  app: INestApplication;
  worker?: INestApplicationContext;
  config: AppConfig;
  database: Database;
  /** Gọi supertest tới đường dẫn đã có tiền tố `/api/v1`. */
  http: ReturnType<typeof request>;
  url(path: string): string;
  close(): Promise<void>;
}

export function buildTestConfig(infra: StartedInfra, env: Record<string, string> = {}): AppConfig {
  if (!infra.databaseUrl) throw new Error('Gọi prepareDatabase(infra) trước createTestApp');
  if (!infra.redisUrl) throw new Error('Cần bật redis trong startInfra');
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: infra.databaseUrl,
    REDIS_URL: infra.redisUrl,
    SESSION_SECRET: 'test-session-secret-test-session-secret',
    S3_ENDPOINT: infra.s3Endpoint ?? 'http://localhost:9000',
    S3_BUCKET: 'test-artifacts',
    S3_ACCESS_KEY: infra.s3AccessKey ?? 'test',
    S3_SECRET_KEY: infra.s3SecretKey ?? 'test-secret',
    MODEL_PROVIDER: 'fake',
    OUTBOX_POLL_MS: '0',
    ...env,
  });
}

/** Stub lưu trữ khi test không bật MinIO. */
const noopStorage = {
  onModuleInit: async () => undefined,
  put: async () => {
    throw new Error('StorageService bị stub trong test; bật minio trong startInfra');
  },
  getStream: async () => {
    throw new Error('StorageService bị stub trong test; bật minio trong startInfra');
  },
};

function applyOverrides(
  builder: TestingModuleBuilder,
  config: AppConfig,
  o: CreateTestAppOptions,
): TestingModuleBuilder {
  builder.overrideProvider(CONFIG).useValue(config);
  if (!o.infra.minio) builder.overrideProvider(StorageService).useValue(noopStorage);
  if (o.overrides?.organization)
    builder.overrideProvider(ORGANIZATION_ENGINE).useValue(o.overrides.organization);
  if (o.overrides?.task) builder.overrideProvider(TASK_ENGINE).useValue(o.overrides.task);
  if (o.overrides?.employee)
    builder.overrideProvider(EMPLOYEE_ENGINE).useValue(o.overrides.employee);
  return builder;
}

/** Dựng API (và worker nếu cần) trên hạ tầng test, dùng đúng AppModule của sản phẩm. */
export async function createTestApp(options: CreateTestAppOptions): Promise<TestApp> {
  const config = buildTestConfig(options.infra, options.env);
  const imports: Array<typeof AppModule | typeof TenantProbeModule> = [AppModule];
  if (options.tenantProbe !== false) imports.push(TenantProbeModule);

  const moduleRef = await applyOverrides(
    Test.createTestingModule({ imports }),
    config,
    options,
  ).compile();
  const app = moduleRef.createNestApplication();
  configureApp(app, config);
  try {
    await app.init();
  } catch (error) {
    // Khởi động thất bại (ví dụ role DB không an toàn): giải phóng kết nối trước khi báo lỗi.
    await app.close().catch(() => undefined);
    await closeDatabase().catch(() => undefined);
    throw error;
  }

  let worker: INestApplicationContext | undefined;
  if (options.withWorker) {
    const workerRef = await applyOverrides(
      Test.createTestingModule({ imports: [WorkerModule] }),
      config,
      options,
    ).compile();
    worker = await workerRef.init();
  }

  const database = app.get<Database>(DATABASE);
  return {
    app,
    worker,
    config,
    database,
    http: request(app.getHttpServer()),
    url: (path) => `/${API_PREFIX}${path.startsWith('/') ? path : `/${path}`}`,
    async close() {
      await worker?.close();
      await app
        .get(QueueService)
        .queue.close()
        .catch(() => undefined);
      await app.close();
      await closeDatabase().catch(() => undefined);
    },
  };
}
