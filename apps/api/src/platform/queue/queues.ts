import { randomUUID } from 'node:crypto';
import { Global, Inject, Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { REDIS } from '../config/infra.providers';

/** Job của hàng đợi BullMQ. Mọi payload mang `companyId` để worker mở đúng tenant. */
export const JOB_NAMES = [
  'run.start',
  'run.resume',
  'action.execute-approved',
  'task.decompose',
  'task.synthesize',
  'review.run',
] as const;
export type JobName = (typeof JOB_NAMES)[number];

export type JobPayload = {
  companyId: string;
  taskId: string;
  traceId?: string;
  [key: string]: unknown;
};

export const QUEUE_NAME = 'claude-company';

const LOCK_PREFIX = 'lock:task:';
const RELEASE_SCRIPT = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

/** Khóa phân tán theo task: một task chỉ có một run hoạt động tại một thời điểm. */
export class TaskLock {
  private constructor(
    private readonly redis: Redis,
    private readonly key: string,
    private readonly token: string,
  ) {}

  static async acquire(redis: Redis, taskId: string, ttlMs: number): Promise<TaskLock | null> {
    const key = `${LOCK_PREFIX}${taskId}`;
    const token = randomUUID();
    const ok = await redis.set(key, token, 'PX', ttlMs, 'NX');
    return ok === 'OK' ? new TaskLock(redis, key, token) : null;
  }

  /** Gia hạn khi run còn sống; false nếu đã mất khóa. */
  async extend(ttlMs: number): Promise<boolean> {
    const current = await this.redis.get(this.key);
    if (current !== this.token) return false;
    await this.redis.pexpire(this.key, ttlMs);
    return true;
  }

  async release(): Promise<void> {
    await this.redis.eval(RELEASE_SCRIPT, 1, this.key, this.token);
  }
}

@Injectable()
export class QueueService implements OnModuleDestroy {
  readonly queue: Queue;

  constructor(@Inject(REDIS) redis: Redis) {
    this.queue = new Queue(QUEUE_NAME, { connection: redis.duplicate() });
  }

  /** `jobId` ổn định để khử trùng khi cùng một việc bị enqueue hai lần. */
  async enqueue(
    name: JobName,
    payload: JobPayload,
    options: { jobId?: string; delayMs?: number } = {},
  ): Promise<string> {
    const job = await this.queue.add(name, payload, {
      jobId: options.jobId,
      delay: options.delayMs,
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 7 * 24 * 3600 },
    });
    return job.id ?? '';
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }
}

@Global()
@Module({ providers: [QueueService], exports: [QueueService] })
export class QueueModule {}
