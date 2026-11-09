import type { Job } from 'bullmq';
import type { JobName, JobPayload } from '@claude-company/api';
import { RunBusyError, type RunExecutor, type RunJobPayload } from '../runtime/run-loop';

/** Job chạy một `agent_run`; khác nhau ở `purpose` đã nằm trong payload. */
export const RUN_JOB_NAMES: readonly JobName[] = [
  'run.start',
  'run.resume',
  'task.decompose',
  'task.synthesize',
  'review.run',
];

/** Task đang có run khác: đặt lại job sau chừng này (ms). */
export const BUSY_REQUEUE_DELAY_MS = 5_000;

export type JobEnqueuer = (
  name: JobName,
  payload: JobPayload,
  options: { jobId?: string; delayMs?: number },
) => Promise<unknown>;

/**
 * Bộ xử lý job BullMQ (T114). Mỗi job `run.start`, `task.decompose`, `task.synthesize`, `review.run` chạy một
 * `agent_run` với `input` dựng theo mục "Ngữ cảnh đầu vào theo purpose". `action.execute-approved` thuộc US4.
 */
export async function processJob(
  job: Pick<Job, 'id' | 'name' | 'data'>,
  deps: { executor: Pick<RunExecutor, 'execute'>; enqueue: JobEnqueuer },
): Promise<void> {
  const name = job.name as JobName;
  if (RUN_JOB_NAMES.includes(name)) {
    const payload = job.data as RunJobPayload;
    try {
      await deps.executor.execute(payload);
    } catch (error) {
      if (!(error instanceof RunBusyError)) throw error;
      await deps.enqueue(name, payload, {
        jobId: `${job.id ?? payload.runId}-busy-${Date.now()}`,
        delayMs: BUSY_REQUEUE_DELAY_MS,
      });
    }
    return;
  }
  if (name === 'action.execute-approved') {
    throw new Error('Thực thi hành động đã duyệt thuộc US4 (Human Approval), chưa được triển khai');
  }
  throw new Error(`Job không được hỗ trợ: ${job.name}`);
}
