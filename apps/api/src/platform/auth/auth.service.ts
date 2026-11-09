import { Injectable } from '@nestjs/common';
import argon2 from 'argon2';
import {
  DomainError,
  type AuthUser,
  type LoginInput,
  type RegisterInput,
} from '@claude-company/contracts';
import { withGlobal } from '@claude-company/db';
import { user } from '@claude-company/db/schema/auth';
import { eq } from 'drizzle-orm';

// Băm giả để thời gian phản hồi không lộ email có tồn tại hay không.
const DUMMY_HASH = argon2.hash('khong-ton-tai', { type: argon2.argon2id });

const UNIQUE_VIOLATION = '23505';

function pgErrorCode(error: unknown): string | undefined {
  const e = error as { code?: string; cause?: { code?: string } };
  return e.code ?? e.cause?.code;
}

@Injectable()
export class AuthService {
  async register(input: RegisterInput): Promise<AuthUser> {
    const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
    try {
      const [row] = await withGlobal((tx) =>
        tx
          .insert(user)
          .values({ email: input.email, passwordHash, displayName: input.displayName })
          .returning({ id: user.id, email: user.email, displayName: user.displayName }),
      );
      if (!row) throw new Error('Không tạo được user');
      return row;
    } catch (error) {
      if (pgErrorCode(error) === UNIQUE_VIOLATION)
        throw new DomainError('EMAIL_TAKEN', 'Email đã được đăng ký');
      throw error;
    }
  }

  async login(input: LoginInput): Promise<AuthUser> {
    const [row] = await withGlobal((tx) =>
      tx.select().from(user).where(eq(user.email, input.email)).limit(1),
    );
    const hash = row && !row.disabledAt ? row.passwordHash : await DUMMY_HASH;
    const ok = await argon2.verify(hash, input.password).catch(() => false);
    if (!row || row.disabledAt || !ok) {
      throw new DomainError('INVALID_CREDENTIALS', 'Email hoặc mật khẩu không đúng');
    }
    return { id: row.id, email: row.email, displayName: row.displayName };
  }

  async getUser(id: string): Promise<AuthUser | null> {
    const [row] = await withGlobal((tx) => tx.select().from(user).where(eq(user.id, id)).limit(1));
    if (!row || row.disabledAt) return null;
    return { id: row.id, email: row.email, displayName: row.displayName };
  }
}
