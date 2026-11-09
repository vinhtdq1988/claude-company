import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url));

export type MigrateOptions = {
  /** URL của role owner (`DATABASE_MIGRATION_URL`). */
  migrationUrl: string;
  /** Mật khẩu của role `app_user` (`APP_DB_PASSWORD`). */
  appDbPassword: string;
};

/** Chạy migration bằng role owner rồi đặt mật khẩu cho `app_user`. Idempotent. */
export async function runMigrations({
  migrationUrl,
  appDbPassword,
}: MigrateOptions): Promise<void> {
  const pool = new pg.Pool({ connectionString: migrationUrl, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });
    // ALTER ROLE không nhận tham số bind nên dùng escapeLiteral.
    const client = await pool.connect();
    try {
      await client.query(
        `ALTER ROLE app_user WITH LOGIN PASSWORD ${client.escapeLiteral(appDbPassword)}`,
      );
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Thiếu biến môi trường ${name}`);
  return value;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runMigrations({
    migrationUrl: requireEnv('DATABASE_MIGRATION_URL'),
    appDbPassword: requireEnv('APP_DB_PASSWORD'),
  })
    .then(() => console.log('Migration hoàn tất'))
    .catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
}
