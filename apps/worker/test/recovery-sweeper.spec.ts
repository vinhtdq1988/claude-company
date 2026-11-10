import { describe, expect, it, vi } from 'vitest';
import { recoverOnce } from '../src/jobs/recovery-sweeper';

describe('recoverOnce (T182)', () => {
  it('trả báo cáo của engine và ghi log khi có run được xử lý', async () => {
    const log = vi.fn();
    const report = await recoverOnce({
      orchestration: { recoverStaleRuns: vi.fn(async () => ({ recovered: 1, failed: 2 })) },
      logger: { log, error: vi.fn() },
    });
    expect(report).toEqual({ recovered: 1, failed: 2 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('2 đánh dấu lỗi'));
  });

  it('không có gì để phục hồi thì không ghi log', async () => {
    const log = vi.fn();
    await recoverOnce({
      orchestration: { recoverStaleRuns: vi.fn(async () => ({ recovered: 0, failed: 0 })) },
      logger: { log, error: vi.fn() },
    });
    expect(log).not.toHaveBeenCalled();
  });

  it('lỗi của engine không làm sập worker: ghi lỗi và trả báo cáo rỗng để lần quét sau thử lại', async () => {
    const error = vi.fn();
    const failure = new Error('mất kết nối');
    const report = await recoverOnce({
      orchestration: {
        recoverStaleRuns: vi.fn(async () => {
          throw failure;
        }),
      },
      logger: { log: vi.fn(), error },
    });
    expect(report).toEqual({ recovered: 0, failed: 0 });
    expect(error).toHaveBeenCalledWith(expect.any(String), failure);
  });
});
