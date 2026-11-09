import { sql } from 'drizzle-orm';
import { check, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { createdAtColumn, idColumn, updatedAtColumn } from './_columns';

/** Bảng toàn cục do `platform/auth` sở hữu; engine khác chỉ truy cập qua IdentityDirectory. Không bật RLS. */
export const user = pgTable(
  'user',
  {
    id: idColumn(),
    email: text('email').notNull().unique(),
    passwordHash: text('password_hash').notNull(),
    displayName: text('display_name').notNull(),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [check('user_email_lowercase', sql`${t.email} = lower(${t.email})`)],
);
