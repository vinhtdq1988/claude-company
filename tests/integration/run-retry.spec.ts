import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FAKE_EMAIL_PAYLOAD,
  approvalTeam,
  assignEmailTask,
  decideAs,
  pendingApprovals,
  type ApprovalTeam,
} from '../support/approval-fixtures';
import {
  prepareDatabase,
  seedDatabase,
  startInfra,
  type StartedInfra,
} from '../support/containers';
import { createFlowHarness, type FlowHarness } from '../support/flow-harness';

/** Hạn run đủ lớn để run bình thường xong, đủ nhỏ để ca timeout và ca "không tính waiting_approval" chạy nhanh. */
const RUN_TIMEOUT_MS = 2_000;
const RETRY_MAX = 2;

/**
 * Timeout và retry có chính sách của run (T176; US7-AS2, FR-024, Nguyên tắc VII): lỗi tạm thời được thử lại với backoff,
 * hết lượt thì task `blocked` với `RETRIES_EXHAUSTED` kèm nguyên nhân và thông báo `task_error`, thời gian chờ duyệt
 * không bị tính vào hạn của run, và file của lần chạy trước còn nguyên ở lần retry. Engine thật trên PostgreSQL.
 */
describe('Integration: retry và timeout của run (US7-AS2)', () => {
  let infra: StartedInfra;
  let h: FlowHarness;

  beforeAll(async () => {
    infra = await startInfra({ redis: false });
    await prepareDatabase(infra);
    await seedDatabase(infra);
    h = await createFlowHarness({
      infra,
      env: {
        RETRY_MAX: String(RETRY_MAX),
        RUN_TIMEOUT_MS: String(RUN_TIMEOUT_MS),
        APPROVAL_REPLAY_AFTER_MS: '0',
      },
    });
  });

  afterAll(async () => {
    await h?.close();
    await infra?.stop();
  });

  const executeRuns = async (team: ApprovalTeam, taskId: string) =>
    (await h.orchestration.listRuns(team.scene.ctx(), { taskId })).items
      .filter((r) => r.purpose === 'execute')
      .sort((a, b) => a.attempt - b.attempt);

  const assign = (team: ApprovalTeam, directive: string) =>
    assignEmailTask(h, team, { objective: `Viết báo cáo phân tích yêu cầu ${directive}` });

  it('lỗi tạm thời được thử lại theo chính sách; lần thử cuối thành công thì task đi tiếp bình thường', async () => {
    const team = await approvalTeam(h);
    const task = await assign(team, '[[fake:error=retryable;times=2;only=execute]]');
    await h.settle();

    const runs = await executeRuns(team, task.id);
    expect(runs.map((r) => [r.attempt, r.status])).toEqual([
      [1, 'failed'],
      [2, 'failed'],
      [3, 'succeeded'],
    ]);
    expect(runs[0]).toMatchObject({
      errorCode: 'PROVIDER_ERROR',
      errorMessage: expect.any(String),
    });
    expect((await h.tasks.get(team.scene.ctx(), task.id)).status).toBe('awaiting_human_approval');
  });

  it('hết lượt thử lại: task blocked RETRIES_EXHAUSTED, lịch sử giữ nguyên nhân từng lần và người quản lý được thông báo', async () => {
    const team = await approvalTeam(h);
    const task = await assign(team, '[[fake:error=retryable;times=99;only=execute]]');
    await h.settle();

    const runs = await executeRuns(team, task.id);
    // 1 lần đầu + RETRY_MAX lần thử lại, rồi dừng.
    expect(runs).toHaveLength(RETRY_MAX + 1);
    for (const run of runs) {
      expect(run).toMatchObject({ status: 'failed', errorCode: 'PROVIDER_ERROR' });
      expect(run.errorMessage).toContain('Lỗi tạm thời');
    }
    const blocked = await h.tasks.get(team.scene.ctx(), task.id);
    expect(blocked).toMatchObject({ status: 'blocked', blockedReason: 'RETRIES_EXHAUSTED' });

    await h.settle();
    const notices = await h.communication.listNotifications(
      team.scene.humanCtx(team.scene.ceo.memberId),
      team.scene.ceo.memberId,
      {},
    );
    const alert = notices.items.find((n) => n.type === 'task_error' && n.taskId === task.id);
    expect(alert, 'phải có thông báo task_error cho người quản lý').toBeDefined();
    expect(h.queue.jobs.filter((j) => j.payload.taskId === task.id)).toEqual([]); // không tự thử lại mãi
  });

  it('lỗi không thể thử lại: blocked ngay ở lần đầu, không retry', async () => {
    const team = await approvalTeam(h);
    const task = await assign(team, '[[fake:error=fatal;only=execute]]');
    await h.settle();
    expect(await executeRuns(team, task.id)).toHaveLength(1);
    expect(await h.tasks.get(team.scene.ctx(), task.id)).toMatchObject({
      status: 'blocked',
      blockedReason: 'RETRIES_EXHAUSTED',
    });
  });

  it('timeout: run ghi timed_out kèm mã TIMEOUT, được thử lại, hết lượt thì blocked', async () => {
    const team = await approvalTeam(h);
    const task = await assign(team, '[[fake:timeout;only=execute]]');
    await h.settle();

    const runs = await executeRuns(team, task.id);
    expect(runs).toHaveLength(RETRY_MAX + 1);
    for (const run of runs)
      expect(run).toMatchObject({ status: 'timed_out', errorCode: 'TIMEOUT' });
    expect(await h.tasks.get(team.scene.ctx(), task.id)).toMatchObject({
      status: 'blocked',
      blockedReason: 'RETRIES_EXHAUSTED',
    });
  }, 30_000);

  it('thời gian chờ Human Approval không tính vào timeout: chờ lâu hơn RUN_TIMEOUT_MS vẫn resume và thành công', async () => {
    const team = await approvalTeam(h);
    const task = await assignEmailTask(h, team);
    await h.settle();
    const [approval] = await pendingApprovals(h, team, task.id);
    expect(approval).toBeDefined();
    expect(approval!.payload).toEqual(FAKE_EMAIL_PAYLOAD);

    await new Promise((resolve) => setTimeout(resolve, RUN_TIMEOUT_MS + 300));
    await decideAs(h, team, approval!, 'approve', 'ok');
    await h.settle();

    const runs = await executeRuns(team, task.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'succeeded', errorCode: null });
  }, 30_000);

  it('file đã ghi ở lần chạy trước còn nguyên ở lần retry (không làm lại từ đầu)', async () => {
    const team = await approvalTeam(h);
    const task = await assign(team, '[[fake:error=retryable;times=1;only=execute]]');
    await h.settleExcept(['run.start']);

    await h.step(); // lần 1 chạy rồi lỗi tạm thời
    const [first] = await executeRuns(team, task.id);
    expect(first).toMatchObject({ attempt: 1, status: 'failed' });
    // Mô phỏng phần việc agent đã ghi trong thư mục của lần chạy bị lỗi.
    const firstDir = join(h.config.RUN_WORKTREES_PATH, first!.id);
    await mkdir(join(firstDir, 'docs'), { recursive: true });
    await writeFile(join(firstDir, 'docs', 'ban-nhap.md'), '# Bản nháp dở dang\n');

    await h.settle(); // lần 2 chạy và thành công
    const runs = await executeRuns(team, task.id);
    expect(runs.map((r) => r.status)).toEqual(['failed', 'succeeded']);
    const secondDir = join(h.config.RUN_WORKTREES_PATH, runs[1]!.id);
    expect(await readFile(join(secondDir, 'docs', 'ban-nhap.md'), 'utf8')).toBe(
      '# Bản nháp dở dang\n',
    );
    expect(secondDir).not.toBe(firstDir);
  });
});
