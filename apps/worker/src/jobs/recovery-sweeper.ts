import type { OrchestrationEngine, RecoveryReport } from '@claude-company/contracts';

type Logger = { log(message: string): void; error(message: string, error?: unknown): void };

/**
 * Phục hồi run chết (US7-AS3, R5). Chạy khi worker khởi động và định kỳ cùng sweeper. Phần quyết định nằm ở
 * `OrchestrationEngine.recoverStaleRuns`: mặc định run `running` quá hạn heartbeat bị đánh dấu lỗi `RUN_INTERRUPTED`
 * và task `blocked`; chỉ `resume` khi `SDK_RESUME_AFTER_CRASH` đã bật. Hàm này không bao giờ ném lỗi ra ngoài để một
 * lần quét hỏng không làm sập worker; lần quét kế tiếp sẽ thử lại.
 */
export async function recoverOnce(deps: {
  orchestration: Pick<OrchestrationEngine, 'recoverStaleRuns'>;
  logger?: Logger;
}): Promise<RecoveryReport> {
  try {
    const report = await deps.orchestration.recoverStaleRuns();
    if (report.recovered > 0 || report.failed > 0) {
      deps.logger?.log(
        `Phục hồi run: ${report.recovered} đưa lại hàng đợi, ${report.failed} đánh dấu lỗi`,
      );
    }
    return report;
  } catch (error) {
    deps.logger?.error('Phục hồi run lỗi', error);
    return { recovered: 0, failed: 0 };
  }
}
