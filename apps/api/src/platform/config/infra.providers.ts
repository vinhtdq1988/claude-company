import {
  Global,
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { createDatabase, setDatabase, type Database } from '@claude-company/db';
import { Redis } from 'ioredis';
import { loadConfig, type AppConfig } from './config';

export const CONFIG = Symbol('CONFIG');
export const DATABASE = Symbol('DATABASE');
export const REDIS = Symbol('REDIS');

export class UnsafeDatabaseRoleError extends Error {}

/** Từ chối khởi động nếu role đang kết nối là superuser hoặc có BYPASSRLS (SC-012). */
export async function assertRestrictedRole(database: Database): Promise<void> {
  const { rows } = await database.pool.query<{
    rolsuper: boolean;
    rolbypassrls: boolean;
    rolname: string;
  }>('select rolname, rolsuper, rolbypassrls from pg_roles where rolname = current_user');
  const role = rows[0];
  if (!role) throw new UnsafeDatabaseRoleError('Không xác định được role đang kết nối');
  if (role.rolsuper || role.rolbypassrls) {
    throw new UnsafeDatabaseRoleError(
      `DATABASE_URL dùng role "${role.rolname}" có ${role.rolsuper ? 'SUPERUSER' : 'BYPASSRLS'}; ` +
        'phải dùng role app_user để RLS có hiệu lực',
    );
  }
}

@Injectable()
class InfraLifecycle implements OnModuleInit, OnApplicationShutdown {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async onModuleInit(): Promise<void> {
    await assertRestrictedRole(this.database);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.database.close();
    this.redis.disconnect();
  }
}

/** Cấu hình, kết nối PostgreSQL (role app_user) và Redis dùng chung cho api và worker. */
@Global()
@Module({
  providers: [
    { provide: CONFIG, useFactory: (): AppConfig => loadConfig() },
    {
      provide: DATABASE,
      inject: [CONFIG],
      useFactory: (config: AppConfig): Database => {
        const database = createDatabase(config.DATABASE_URL);
        setDatabase(database);
        return database;
      },
    },
    {
      provide: REDIS,
      inject: [CONFIG],
      useFactory: (config: AppConfig): Redis =>
        new Redis(config.REDIS_URL, { maxRetriesPerRequest: null }),
    },
    InfraLifecycle,
  ],
  exports: [CONFIG, DATABASE, REDIS],
})
export class ConfigModule {}
