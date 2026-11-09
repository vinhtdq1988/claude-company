import { timestamp, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';

export const newId = (): string => uuidv7();

/** `id uuid` (UUIDv7) khóa chính. */
export const idColumn = () =>
  uuid('id')
    .primaryKey()
    .$defaultFn(() => newId());

/** `company_id uuid NOT NULL`: bảng nghiệp vụ nào cũng có và bật RLS theo cột này. */
export const companyIdColumn = () => uuid('company_id').notNull();

export const createdAtColumn = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const updatedAtColumn = () =>
  timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/** Bộ cột chung cho bảng nghiệp vụ theo company. */
export const baseColumns = () => ({
  id: idColumn(),
  companyId: companyIdColumn(),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
});
