import { fileURLToPath } from 'node:url';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { modelPriceSeeder } from './seeds/model-prices';
import { orgTemplateSeeder } from './seeds/org-templates';
import { roleTemplateSeeder } from './seeds/role-templates';

/** Một bước seed. Phải idempotent (dùng `ON CONFLICT DO NOTHING/UPDATE`). */
export type Seeder = { name: string; run(db: NodePgDatabase): Promise<void> };

/**
 * Danh sách seeder, thêm dần theo từng user story:
 * org-templates (T051), role-templates và model-prices (T066), action-policy (v1.0 chỉ nhận seed).
 */
export const seeders: Seeder[] = [orgTemplateSeeder, roleTemplateSeeder, modelPriceSeeder];

export async function runSeeds(
  connectionUrl: string,
  list: readonly Seeder[] = seeders,
): Promise<void> {
  const pool = new pg.Pool({ connectionString: connectionUrl, max: 1 });
  try {
    const db = drizzle(pool);
    for (const seeder of list) {
      await seeder.run(db);
      console.log(`Seed ${seeder.name}: xong`);
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  // Seed bảng cấu hình toàn cục bằng role owner (bảng này không bật RLS).
  const url = process.env.DATABASE_MIGRATION_URL;
  if (!url) {
    console.error('Thiếu biến môi trường DATABASE_MIGRATION_URL');
    process.exit(1);
  }
  runSeeds(url).catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
