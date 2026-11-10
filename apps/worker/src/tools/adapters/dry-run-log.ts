import { appendFile, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ToolAdapter, ToolResult } from '@claude-company/contracts';

/** Một dòng JSONL trong log dry-run: bằng chứng hành động nhạy cảm đã được "thực thi" ở chế độ mô phỏng. */
export type DryRunEntry = {
  idempotencyKey: string;
  actionType: string;
  payload: unknown;
  executedAt: string;
  mode: 'dry_run';
};

const LOG_FILE = 'dry-run-actions.jsonl';

/**
 * Log dry-run trên volume riêng (JSONL, chỉ ghi thêm). Là nơi duy nhất ghi nhận hành động nhạy cảm trong v1.0:
 * không có email, xóa dữ liệu hay deploy thật nào xảy ra (FR-027).
 */
export class DryRunLog {
  constructor(private readonly dir: string) {}

  get file(): string {
    return join(this.dir, LOG_FILE);
  }

  async read(): Promise<DryRunEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return raw
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as DryRunEntry];
        } catch {
          return []; // dòng hỏng do ghi dở khi sập: bỏ qua, lookup coi như chưa thực thi
        }
      });
  }

  async find(idempotencyKey: string): Promise<DryRunEntry | undefined> {
    return (await this.read()).find((e) => e.idempotencyKey === idempotencyKey);
  }

  /** Xóa log (chỉ dùng cho test để tách các ca với nhau; sản phẩm không bao giờ xóa log). */
  async clear(): Promise<void> {
    await rm(this.file, { force: true });
  }

  async append(entry: DryRunEntry): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await appendFile(this.file, `${JSON.stringify(entry)}\n`, 'utf8');
  }
}

export const DRY_RUN_LABEL = 'dry-run';

/** Kết quả có nhãn rõ để `Completed` không bị hiểu là đã gửi/deploy thật (plan.md, Complexity Tracking). */
export function dryRunResult(entry: DryRunEntry): ToolResult {
  return {
    status: 'ok',
    output: {
      dryRun: true,
      label: DRY_RUN_LABEL,
      actionType: entry.actionType,
      executedAt: entry.executedAt,
      message:
        'Mô phỏng (dry-run): đã ghi nhận payload đã duyệt, chưa có tác động thật ra bên ngoài.',
    },
  };
}

/**
 * Adapter dry-run dùng chung: ghi payload đã duyệt vào log, idempotent theo key (thực thi lại cùng key không ghi
 * thêm dòng), `lookup` đọc lại log để recovery biết hành động đã chạy hay chưa. Mỗi instance phục vụ đúng một
 * `ActionType` nên log luôn ghi đúng loại hành động (staging khác production).
 */
export class DryRunAdapter implements ToolAdapter {
  readonly mode = 'dry_run' as const;

  constructor(
    protected readonly log: DryRunLog,
    protected readonly actionType: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get actionTypes(): string[] {
    return [this.actionType];
  }

  async execute(input: unknown, idempotencyKey: string): Promise<ToolResult> {
    const existing = await this.log.find(idempotencyKey);
    if (existing) return dryRunResult(existing);
    const entry: DryRunEntry = {
      idempotencyKey,
      actionType: this.actionType,
      payload: input,
      executedAt: this.now().toISOString(),
      mode: 'dry_run',
    };
    await this.log.append(entry);
    return dryRunResult(entry);
  }

  async lookup(idempotencyKey: string): Promise<'succeeded' | 'failed' | 'not_found' | 'unknown'> {
    try {
      return (await this.log.find(idempotencyKey)) ? 'succeeded' : 'not_found';
    } catch {
      return 'unknown';
    }
  }
}
