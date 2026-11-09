import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';

export type Db = NodePgDatabase;

export type Database = {
  pool: pg.Pool;
  db: Db;
  close(): Promise<void>;
};

/** Mở pool kết nối. Ứng dụng phải dùng role `app_user` (không superuser, không BYPASSRLS). */
export function createDatabase(connectionString: string, options: { max?: number } = {}): Database {
  const pool = new pg.Pool({ connectionString, max: options.max ?? 10 });
  // Connection nhàn rỗi bị server ngắt (restart, failover) phát 'error'; không có handler sẽ làm chết process.
  pool.on('error', (error) => console.error('Lỗi connection PostgreSQL nhàn rỗi:', error.message));
  return { pool, db: drizzle(pool), close: () => pool.end() };
}

let defaultDatabase: Database | undefined;

/** Đặt kết nối mặc định cho `withTenant`; gọi một lần khi khởi động (API, worker, test). */
export function initDatabase(connectionString: string, options: { max?: number } = {}): Database {
  defaultDatabase = createDatabase(connectionString, options);
  return defaultDatabase;
}

export function setDatabase(database: Database): void {
  defaultDatabase = database;
}

export function getDatabase(): Database {
  if (!defaultDatabase) {
    throw new Error('Database chưa khởi tạo: gọi initDatabase(DATABASE_URL) khi khởi động');
  }
  return defaultDatabase;
}

export async function closeDatabase(): Promise<void> {
  const current = defaultDatabase;
  defaultDatabase = undefined;
  await current?.close();
}
