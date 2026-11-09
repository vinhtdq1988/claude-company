import { describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { EmployeeService } from '../src/engines/employee/employee.service';
import { EMPLOYEE_ENGINE, MODEL_CATALOG } from '../src/platform/engine-tokens';
import { CONFIG } from '../src/platform/config/infra.providers';
import { loadConfig } from '../src/platform/config/config';

describe('DI graph', () => {
  it('AppModule biên dịch được: EMPLOYEE_ENGINE là EmployeeService, có MODEL_CATALOG', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://app_user:x@127.0.0.1:1/x',
      REDIS_URL: 'redis://127.0.0.1:1',
      SESSION_SECRET: 'test-session-secret-test-session-secret',
      S3_ENDPOINT: 'http://127.0.0.1:1',
      S3_BUCKET: 'b',
      S3_ACCESS_KEY: 'a',
      S3_SECRET_KEY: 'bbbbbbbbbbbb',
      MODEL_PROVIDER: 'fake',
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CONFIG)
      .useValue(config)
      .compile();
    const employees = moduleRef.get(EMPLOYEE_ENGINE, { strict: false });
    expect(employees).toBeInstanceOf(EmployeeService);
    // OrganizationEngine được lấy muộn qua ModuleRef để tránh vòng phụ thuộc; phải resolve được.
    expect((employees as unknown as { organization: unknown }).organization).toBeDefined();
    expect(moduleRef.get(MODEL_CATALOG, { strict: false })).toBeDefined();
    await moduleRef.close().catch(() => undefined);
  }, 20_000);
});
