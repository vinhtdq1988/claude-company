import { createHmac, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { CONFIG, REDIS } from '../config/infra.providers';
import type { AppConfig } from '../config/config';
import type { SessionData } from '../http/request';

/** Session lưu Redis. Khóa Redis là HMAC của session id nên lộ Redis không lộ cookie dùng được. */
@Injectable()
export class SessionService {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  private key(sid: string): string {
    return `sess:${createHmac('sha256', this.config.SESSION_SECRET).update(sid).digest('hex')}`;
  }

  async create(userId: string): Promise<{ sid: string; session: SessionData }> {
    const sid = randomBytes(32).toString('base64url');
    const session: SessionData = {
      userId,
      csrfToken: randomBytes(24).toString('base64url'),
      createdAt: Date.now(),
    };
    await this.redis.set(
      this.key(sid),
      JSON.stringify(session),
      'EX',
      this.config.SESSION_TTL_SECONDS,
    );
    return { sid, session };
  }

  async get(sid: string): Promise<SessionData | null> {
    if (!/^[\w-]{20,100}$/.test(sid)) return null;
    const raw = await this.redis.get(this.key(sid));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as SessionData;
    } catch {
      return null;
    }
  }

  async destroy(sid: string): Promise<void> {
    await this.redis.del(this.key(sid));
  }
}
