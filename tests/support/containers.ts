import { randomBytes } from 'node:crypto';
import { MinioContainer, type StartedMinioContainer } from '@testcontainers/minio';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import pg from 'pg';

export interface TestInfra {
  postgres: StartedPostgreSqlContainer;
  redis: StartedRedisContainer;
  minio: StartedMinioContainer;
  /** URL role owner (superuser của container hoặc của server ngoài), dùng để chạy migration. */
  databaseMigrationUrl: string;
  /** URL role `app_user` sau khi `prepareDatabase` chạy migration. */
  databaseUrl: string;
  redisUrl: string;
  s3Endpoint: string;
  s3AccessKey: string;
  s3SecretKey: string;
}

export interface StartInfraOptions {
  postgres?: boolean;
  redis?: boolean;
  minio?: boolean;
}

export type StartedInfra = Partial<TestInfra> & { stop(): Promise<void> };

/** Mật khẩu role `app_user` trong môi trường test. */
export const TEST_APP_DB_PASSWORD = 'app-test-password';

/**
 * Khởi động PostgreSQL 16, Redis 7 và MinIO bằng Testcontainers.
 * Chỉ bật thành phần test cần để giảm thời gian chạy.
 *
 * Máy không chạy được Docker có thể trỏ test vào dịch vụ có sẵn:
 * `TEST_POSTGRES_URL` (role superuser, mỗi lần gọi tạo database riêng) và `TEST_REDIS_URL`.
 */
export async function startInfra(options: StartInfraOptions = {}): Promise<StartedInfra> {
  const { postgres = true, redis = true, minio = false } = options;
  const started: Array<{ stop(): Promise<unknown> }> = [];
  const cleanups: Array<() => Promise<void>> = [];
  const infra: Partial<TestInfra> = {};

  try {
    if (postgres) {
      const external = process.env.TEST_POSTGRES_URL;
      if (external) {
        const dbName = `test_${randomBytes(6).toString('hex')}`;
        const admin = new pg.Pool({ connectionString: external, max: 1 });
        await admin.query(`CREATE DATABASE ${dbName}`);
        await admin.end();
        const url = new URL(external);
        url.pathname = `/${dbName}`;
        infra.databaseMigrationUrl = url.toString();
        cleanups.push(async () => {
          const pool = new pg.Pool({ connectionString: external, max: 1 });
          await pool.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => undefined);
          await pool.end();
        });
      } else {
        const c = await new PostgreSqlContainer('postgres:16')
          .withDatabase('claude_company')
          .start();
        started.push(c);
        infra.postgres = c;
        infra.databaseMigrationUrl = c.getConnectionUri();
      }
    }
    if (redis) {
      const external = process.env.TEST_REDIS_URL;
      if (external) {
        infra.redisUrl = external;
      } else {
        const c = await new RedisContainer('redis:7').start();
        started.push(c);
        infra.redis = c;
        infra.redisUrl = c.getConnectionUrl();
      }
    }
    if (minio) {
      const c = await new MinioContainer('minio/minio:latest').start();
      started.push(c);
      infra.minio = c;
      infra.s3Endpoint = `http://${c.getHost()}:${c.getMappedPort(9000)}`;
      infra.s3AccessKey = c.getUsername();
      infra.s3SecretKey = c.getPassword();
    }
  } catch (error) {
    await Promise.allSettled(started.map((c) => c.stop()));
    await Promise.allSettled(cleanups.map((fn) => fn()));
    throw error;
  }

  return {
    ...infra,
    async stop() {
      await Promise.allSettled(started.map((c) => c.stop()));
      await Promise.allSettled(cleanups.map((fn) => fn()));
    },
  };
}

/** Seed bảng cấu hình toàn cục (template tổ chức, role template, bảng giá) bằng role owner. */
export async function seedDatabase(infra: StartedInfra): Promise<void> {
  if (!infra.databaseMigrationUrl) throw new Error('Cần bật postgres trong startInfra');
  const { runSeeds } = await import('../../packages/db/src/seed');
  await runSeeds(infra.databaseMigrationUrl);
}

/** Chạy migration bằng role owner và trả URL của role `app_user` (không superuser, không BYPASSRLS). */
export async function prepareDatabase(infra: StartedInfra): Promise<string> {
  if (!infra.databaseMigrationUrl) throw new Error('Cần bật postgres trong startInfra');
  const { runMigrations } = await import('../../packages/db/src/migrate');
  await runMigrations({
    migrationUrl: infra.databaseMigrationUrl,
    appDbPassword: TEST_APP_DB_PASSWORD,
  });
  const url = new URL(infra.databaseMigrationUrl);
  url.username = 'app_user';
  url.password = TEST_APP_DB_PASSWORD;
  infra.databaseUrl = url.toString();
  return infra.databaseUrl;
}
