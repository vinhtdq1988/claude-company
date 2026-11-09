import { z } from 'zod';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

/** Cấu hình kiểm tra bằng Zod, mặc định theo R13. Thiếu biến bắt buộc thì không khởi động. */
const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().default(3000),
    WEB_ORIGIN: z.string().default('http://localhost:5173'),

    DATABASE_URL: z.string().min(1),
    DATABASE_MIGRATION_URL: z.string().optional(),
    REDIS_URL: z.string().min(1),

    /** Chu kỳ quét outbox (ms); 0 tắt relay tự chạy (test gọi `OutboxRelay.tick()` thủ công). */
    OUTBOX_POLL_MS: z.coerce.number().int().min(0).default(250),

    SESSION_SECRET: z.string().min(32, 'SESSION_SECRET phải dài ít nhất 32 ký tự'),
    SESSION_TTL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(7 * 24 * 3600),

    S3_ENDPOINT: z.string().min(1),
    S3_REGION: z.string().default('us-east-1'),
    S3_BUCKET: z.string().min(1),
    S3_ACCESS_KEY: z.string().min(1),
    S3_SECRET_KEY: z.string().min(1),
    S3_FORCE_PATH_STYLE: bool.default(true),

    MODEL_PROVIDER: z.enum(['anthropic', 'fake']).default('fake'),
    ANTHROPIC_API_KEY: z.string().optional(),
    ADAPTER_MODE: z.enum(['dry_run', 'live']).default('dry_run'),
    WORKSPACE_HOST_PATH: z.string().default('./data/workspaces'),
    /** Thư mục chứa `/worktrees/{runId}` (volume `run_worktrees`). */
    RUN_WORKTREES_PATH: z.string().default('./data/worktrees'),

    BUDGET_WARN_THRESHOLD: z.coerce.number().min(0).max(1).default(0.8),
    MAX_REWORK: z.coerce.number().int().min(0).default(3),
    RETRY_MAX: z.coerce.number().int().min(0).default(3),
    RETRY_BACKOFF_INITIAL_MS: z.coerce.number().int().positive().default(2_000),
    RETRY_BACKOFF_MAX_MS: z.coerce.number().int().positive().default(30_000),
    RUN_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(15 * 60_000),
    MODEL_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(2 * 60_000),
    TOOL_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(5 * 60_000),
    /** `false`: worker không nhận job BullMQ (chỉ chạy sweeper), dùng khi tách tiến trình hoặc trong test. */
    WORKER_CONSUME_JOBS: bool.default(true),
    /** Chu kỳ worker gửi heartbeat của run (ms) và ngưỡng coi run `running` là đã chết (ms). */
    RUN_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
    RUN_STALE_AFTER_MS: z.coerce.number().int().positive().default(60_000),
    /** Chu kỳ sweeper (task quá hạn, phục hồi run); 0 tắt sweeper tự chạy (test gọi thủ công). */
    SWEEP_INTERVAL_MS: z.coerce.number().int().min(0).default(30_000),
    APPROVAL_REMINDER_FIRST_MS: z.coerce.number().int().positive().default(3_600_000),
    APPROVAL_REMINDER_REPEAT_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(24 * 3_600_000),
    DEFAULT_MONTHLY_COST_LIMIT_USD: z.coerce.number().positive().default(20),
    DEFAULT_MONTHLY_TOKEN_LIMIT: z.coerce.number().int().positive().default(2_000_000),
    SDK_BUDGET_HEADROOM: z.coerce.number().min(0).max(1).default(0.1),
    SDK_RUN_RESERVE_USD: z.coerce.number().positive().default(2),
    SDK_RUN_RESERVE_TOKENS: z.coerce.number().int().positive().default(200_000),
    SDK_RESUME_AFTER_CRASH: bool.default(false),
    ARTIFACT_CONTEXT_MAX_BYTES: z.coerce.number().int().positive().default(200_000),

    EGRESS_PROXY_URL: z.string().optional(),
    SANDBOX_RUNNER_URL: z.string().optional(),
    SANDBOX_RUNNER_TOKEN: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.MODEL_PROVIDER === 'anthropic' && !env.ANTHROPIC_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['ANTHROPIC_API_KEY'],
        message: 'Bắt buộc khi MODEL_PROVIDER=anthropic',
      });
    }
  });

export type AppConfig = z.infer<typeof envSchema>;

export class ConfigError extends Error {}

/** Đọc và kiểm tra cấu hình; ném ConfigError (không lộ giá trị biến) nếu thiếu hoặc sai. */
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `- ${i.path.join('.') || '(env)'}: ${i.message}`);
    throw new ConfigError(`Cấu hình không hợp lệ:\n${lines.join('\n')}`);
  }
  return parsed.data;
}
