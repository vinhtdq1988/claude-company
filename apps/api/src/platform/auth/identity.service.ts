import { Injectable } from '@nestjs/common';
import { withGlobal } from '@claude-company/db';
import { user } from '@claude-company/db/schema/auth';
import type { IdentityDirectory } from '@claude-company/contracts';
import { and, eq, inArray, isNull } from 'drizzle-orm';

/** Nơi duy nhất đọc ghi bảng `user`; engine khác hỏi qua IdentityDirectory. */
@Injectable()
export class IdentityService implements IdentityDirectory {
  async findUserByEmail(email: string): Promise<{ id: string; displayName: string } | null> {
    const rows = await withGlobal((tx) =>
      tx
        .select({ id: user.id, displayName: user.displayName })
        .from(user)
        .where(and(eq(user.email, email.trim().toLowerCase()), isNull(user.disabledAt)))
        .limit(1),
    );
    return rows[0] ?? null;
  }

  async getUsers(
    ids: string[],
  ): Promise<Array<{ id: string; displayName: string; email: string }>> {
    if (ids.length === 0) return [];
    return withGlobal((tx) =>
      tx
        .select({ id: user.id, displayName: user.displayName, email: user.email })
        .from(user)
        .where(inArray(user.id, ids)),
    );
  }
}
