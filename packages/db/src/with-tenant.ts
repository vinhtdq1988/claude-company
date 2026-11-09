import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { getDatabase, type Database } from './client';

/** Transaction đã đặt `app.company_id` (và `app.user_id` nếu có); mọi truy vấn trong đó chịu RLS. */
export type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0];

export type TenantOptions = {
  /** Đặt `app.user_id` để policy theo người dùng (human_member, company) hoạt động. */
  userId?: string;
  database?: Database;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(name: string, value: string): void {
  if (!UUID.test(value)) throw new Error(`${name} không phải UUID hợp lệ`);
}

/**
 * Mở transaction và `SET LOCAL app.company_id` (kèm `app.user_id` nếu có).
 * Biến chỉ sống trong transaction nên không rò sang request khác dùng chung connection.
 */
export async function withTenant<T>(
  companyId: string,
  fn: (tx: Tx) => Promise<T>,
  options: TenantOptions = {},
): Promise<T> {
  assertUuid('companyId', companyId);
  if (options.userId) assertUuid('userId', options.userId);
  const { db } = options.database ?? getDatabase();
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.company_id', ${companyId}, true)`);
    if (options.userId)
      await tx.execute(sql`select set_config('app.user_id', ${options.userId}, true)`);
    return fn(tx);
  });
}

/**
 * Transaction chỉ có `app.user_id` (chưa có company), dùng cho `/auth/me`, `findMemberships`.
 * RLS chỉ cho thấy dòng của chính người dùng theo policy `user_id` (D3).
 */
export async function withUser<T>(
  userId: string,
  fn: (tx: Tx) => Promise<T>,
  options: { database?: Database } = {},
): Promise<T> {
  assertUuid('userId', userId);
  const { db } = options.database ?? getDatabase();
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    return fn(tx);
  });
}

/** Transaction không có biến tenant: chỉ dành cho bảng toàn cục (`user`, template, giá model) và hàm SECURITY DEFINER. */
export async function withGlobal<T>(
  fn: (tx: Tx) => Promise<T>,
  options: { database?: Database } = {},
): Promise<T> {
  const { db } = options.database ?? getDatabase();
  return db.transaction(fn);
}
