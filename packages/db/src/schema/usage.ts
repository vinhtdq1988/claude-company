import { index, numeric, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core';
import { createdAtColumn, idColumn } from './_columns';

/**
 * Bảng giá model (USD cho mỗi triệu token). Cấu hình toàn cục, không theo company và không bật RLS.
 * Chỉ `ModelCatalog` đọc bảng này; engine khác hỏi qua interface.
 */
export const modelPrice = pgTable(
  'model_price',
  {
    id: idColumn(),
    modelId: text('model_id').notNull(),
    inputPerMtok: numeric('input_per_mtok', { precision: 12, scale: 6 }).notNull(),
    outputPerMtok: numeric('output_per_mtok', { precision: 12, scale: 6 }).notNull(),
    cacheReadPerMtok: numeric('cache_read_per_mtok', { precision: 12, scale: 6 }).notNull(),
    cacheWritePerMtok: numeric('cache_write_per_mtok', { precision: 12, scale: 6 }).notNull(),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    createdAt: createdAtColumn(),
  },
  (t) => [
    unique('model_price_effective_unique').on(t.modelId, t.effectiveFrom),
    index('model_price_lookup_idx').on(t.modelId, t.effectiveFrom),
  ],
);
