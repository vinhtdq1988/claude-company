import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@claude-company/db';
import { agentRun } from '@claude-company/db/schema/orchestration';
import { eq } from 'drizzle-orm';
import {
  FAKE_EMAIL_PAYLOAD,
  approvalTeam,
  assignEmailTask,
  brokerFor,
  decideAs,
  pendingApprovals,
  runContextFor,
  type ApprovalTeam,
} from '../support/approval-fixtures';
import {
  prepareDatabase,
  seedDatabase,
  startInfra,
  type StartedInfra,
} from '../support/containers';
import { createFlowHarness, type FlowHarness } from '../support/flow-harness';

const STALE_MS = 10 * 60_000;

/**
 * Phục hồi sau khi worker chết giữa chừng (T177; US7-AS3, SC-010, R5, Nguyên tắc VII): công việc không mất cũng không
 * lặp. Mặc định run chết được đánh dấu lỗi `RUN_INTERRUPTED` và task `blocked` để người thật quyết định; chỉ resume
 * session khi `SDK_RESUME_AFTER_CRASH` bật. Hành động có tác dụng phụ không bao giờ chạy lại khi chưa chắc kết quả.
 */
describe('Integration: phục hồi run sau khi worker chết (US7-AS3, SC-010)', () => {
  let infra: StartedInfra;
  let h: FlowHarness;
  const config = () => h.config as { SDK_RESUME_AFTER_CRASH: boolean };

  beforeAll(async () => {
    infra = await startInfra({ redis: false });
    await prepareDatabase(infra);
    await seedDatabase(infra);
    h = await createFlowHarness({ infra, env: { APPROVAL_REPLAY_AFTER_MS: '0' } });
  });

  afterAll(async () => {
    await h?.close();
    await infra?.stop();
  });

  beforeEach(async () => {
    await h.dryRun.clear();
  });

  afterEach(() => {
    config().SDK_RESUME_AFTER_CRASH = false;
  });

  const ageHeartbeat = (team: ApprovalTeam, runId: string) =>
    withTenant(team.scene.companyId, (tx) =>
      tx
        .update(agentRun)
        .set({ heartbeatAt: new Date(Date.now() - STALE_MS) })
        .where(eq(agentRun.id, runId)),
    );

  /**
   * Run `execute` đang `running` mà worker đã chết: job biến mất khỏi hàng đợi, heartbeat quá hạn. Có thể ghi sẵn file
   * vào thư mục của run để kiểm tra việc giữ lại thay đổi chưa commit.
   */
  async function killedRun(
    team: ApprovalTeam,
    options: { objective?: string; sessionId?: string; file?: string } = {},
  ) {
    const task = await assignEmailTask(h, team, {
      objective: options.objective ?? 'Viết báo cáo phân tích yêu cầu',
    });
    await h.settleExcept(['run.start']);
    const [run] = (await h.orchestration.listRuns(team.scene.ctx(), { taskId: task.id })).items;
    const runId = run!.id;
    await h.orchestration.updateRunStatus(team.scene.ctx(), runId, {
      status: 'running',
      ...(options.sessionId ? { providerSessionId: options.sessionId } : {}),
    });
    if (options.file) {
      const dir = join(h.config.RUN_WORKTREES_PATH, runId);
      await mkdir(join(dir, 'src'), { recursive: true });
      await writeFile(join(dir, 'src', 'chua-commit.ts'), options.file);
    }
    h.queue.jobs.splice(0); // worker chết: job đang giữ không bao giờ xong
    await ageHeartbeat(team, runId);
    return { task, runId };
  }

  /** Chỉ run `execute`: task giao cho nhân viên có AI Manager còn có run `decompose` của AI Manager. */
  const executeRuns = async (team: ApprovalTeam, taskId: string) =>
    (await h.orchestration.listRuns(team.scene.ctx(), { taskId })).items.filter(
      (r) => r.purpose === 'execute',
    );
  const getTask = (team: ApprovalTeam, id: string) => h.tasks.get(team.scene.ctx(), id);
  const getRun = (team: ApprovalTeam, id: string) => h.orchestration.getRun(team.scene.ctx(), id);

  describe('mặc định (SDK_RESUME_AFTER_CRASH = false)', () => {
    it('run chết → failed RUN_INTERRUPTED, task blocked, không tự chạy lại', async () => {
      const team = await approvalTeam(h);
      const { task, runId } = await killedRun(team, { sessionId: 'sess-chet' });

      const report = await h.orchestration.recoverStaleRuns();
      expect(report.failed).toBeGreaterThanOrEqual(1);
      await h.settle();

      expect(await getRun(team, runId)).toMatchObject({
        status: 'failed',
        errorCode: 'RUN_INTERRUPTED',
        errorMessage: expect.stringContaining('heartbeat'),
      });
      expect(await getTask(team, task.id)).toMatchObject({
        status: 'blocked',
        blockedReason: 'RUN_INTERRUPTED',
      });
      expect(
        h.queue.history.some((j) => j.name === 'run.resume' && j.payload.runId === runId),
      ).toBe(false);
      expect(await executeRuns(team, task.id)).toHaveLength(1);
    });

    it('resume tạo run mới có đủ file của run bị kill, kể cả thay đổi chưa commit', async () => {
      const team = await approvalTeam(h);
      const { task, runId } = await killedRun(team, { file: 'export const dangLam = true;\n' });
      await h.orchestration.recoverStaleRuns();
      await h.settle();

      await h.tasks.transition(team.scene.humanCtx(team.scene.ceo.memberId), task.id, 'resume');
      await h.settle();

      const runs = (await h.orchestration.listRuns(team.scene.ctx(), { taskId: task.id })).items
        .filter((r) => r.purpose === 'execute')
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      expect(runs.map((r) => r.status)).toEqual(['failed', 'succeeded']);
      const resumedDir = join(h.config.RUN_WORKTREES_PATH, runs[1]!.id);
      expect(runs[1]!.id).not.toBe(runId);
      expect(await readFile(join(resumedDir, 'src', 'chua-commit.ts'), 'utf8')).toBe(
        'export const dangLam = true;\n',
      );
    });

    it('quét lặp lại không tạo thêm run hay đổi kết quả (idempotent)', async () => {
      const team = await approvalTeam(h);
      const { task, runId } = await killedRun(team);
      await h.orchestration.recoverStaleRuns();
      await h.orchestration.recoverStaleRuns();
      await h.settle();
      expect((await getRun(team, runId)).status).toBe('failed');
      expect(await executeRuns(team, task.id)).toHaveLength(1);
    });
  });

  describe('bật SDK_RESUME_AFTER_CRASH', () => {
    it('có provider_session_id → đưa lại hàng đợi bằng run.resume và chạy tiếp tới khi thành công', async () => {
      config().SDK_RESUME_AFTER_CRASH = true;
      const team = await approvalTeam(h);
      const { task, runId } = await killedRun(team, { sessionId: 'sess-con-song' });

      const report = await h.orchestration.recoverStaleRuns();
      expect(report.recovered).toBeGreaterThanOrEqual(1);
      expect(
        h.queue.history.some((j) => j.name === 'run.resume' && j.payload.runId === runId),
      ).toBe(true);
      await h.settle();

      expect(await getRun(team, runId)).toMatchObject({ status: 'succeeded', errorCode: null });
      expect((await getTask(team, task.id)).status).toBe('awaiting_human_approval');
    });

    it('không có provider_session_id → vẫn đánh dấu lỗi (không có gì để resume)', async () => {
      config().SDK_RESUME_AFTER_CRASH = true;
      const team = await approvalTeam(h);
      const { task, runId } = await killedRun(team);
      await h.orchestration.recoverStaleRuns();
      expect(await getRun(team, runId)).toMatchObject({
        status: 'failed',
        errorCode: 'RUN_INTERRUPTED',
      });
      expect(await getTask(team, task.id)).toMatchObject({ status: 'blocked' });
    });

    it('resume lỗi cũng báo lỗi rõ: run failed kèm mã và thông điệp, task blocked, không lặp vô hạn', async () => {
      config().SDK_RESUME_AFTER_CRASH = true;
      const team = await approvalTeam(h);
      const { task, runId } = await killedRun(team, {
        sessionId: 'sess-hong',
        objective: 'Viết báo cáo [[fake:error=fatal;only=execute]]',
      });
      await h.orchestration.recoverStaleRuns();
      await h.settle();

      const run = await getRun(team, runId);
      expect(run.status).toBe('failed');
      expect(run.errorCode).toBeTruthy();
      expect(run.errorMessage).toBeTruthy();
      expect((await getTask(team, task.id)).status).toBe('blocked');
      await h.orchestration.recoverStaleRuns();
      await h.settle();
      expect(await executeRuns(team, task.id)).toHaveLength(1);
    });
  });

  describe('hành động có tác dụng phụ không chạy lại', () => {
    it('resume hoặc retry gọi lại hành động nhóm dedupe đã succeeded: nhận kết quả cũ, không duyệt lại và không thực thi lại', async () => {
      const team = await approvalTeam(h);
      const task = await assignEmailTask(h, team);
      await h.settle();
      const [approval] = await pendingApprovals(h, team, task.id);
      await decideAs(h, team, approval!, 'approve', 'ok');
      await h.settle();
      expect(await h.dryRun.read()).toHaveLength(1);

      // Một run mới cho cùng task (retry/resume) đề xuất lại đúng hành động đó.
      const again = await runContextFor(h, team, await getTask(team, task.id));
      const result = await brokerFor(h).invoke(again, {
        name: 'email_send',
        input: FAKE_EMAIL_PAYLOAD,
        providerCallId: 'goi-lai',
      });
      expect(result.status).toBe('ok');
      expect(await h.dryRun.read()).toHaveLength(1);
      expect(await pendingApprovals(h, team, task.id)).toHaveLength(0);
    });

    it('tool kẹt ở executing mà adapter xác nhận đã thực thi: ghi succeeded, run vẫn đánh dấu gián đoạn, không chạy lại', async () => {
      const team = await approvalTeam(h);
      const { task, runId } = await killedRun(team);
      const key = `k-${randomUUID()}`;
      const inv = await h.orchestration.recordToolInvocation(team.scene.ctx(), {
        runId,
        actionType: 'email.send',
        permissionLevel: 'human_approval',
        input: FAKE_EMAIL_PAYLOAD,
        inputHash: 'c'.repeat(64),
        idempotencyKey: key,
        status: 'executing',
      });
      await h.dryRun.append({
        idempotencyKey: key,
        actionType: 'email.send',
        payload: FAKE_EMAIL_PAYLOAD,
        executedAt: new Date().toISOString(),
        mode: 'dry_run',
      });

      await h.orchestration.recoverStaleRuns();
      const run = await getRun(team, runId);
      expect(run.toolInvocations.find((i) => i.id === inv.id)?.status).toBe('succeeded');
      expect(run).toMatchObject({ status: 'failed', errorCode: 'RUN_INTERRUPTED' });
      expect((await getTask(team, task.id)).blockedReason).toBe('RUN_INTERRUPTED');
      expect(await h.dryRun.read()).toHaveLength(1);
    });

    it('tool kẹt ở executing không xác định được: unknown + task blocked TOOL_OUTCOME_UNKNOWN, không thực hiện lại', async () => {
      const team = await approvalTeam(h);
      const { task, runId } = await killedRun(team);
      const inv = await h.orchestration.recordToolInvocation(team.scene.ctx(), {
        runId,
        actionType: 'email.send',
        permissionLevel: 'human_approval',
        input: FAKE_EMAIL_PAYLOAD,
        inputHash: 'd'.repeat(64),
        idempotencyKey: `k-${randomUUID()}`,
        status: 'executing',
      });

      await h.orchestration.recoverStaleRuns();
      await h.settle();
      const run = await getRun(team, runId);
      expect(run.toolInvocations.find((i) => i.id === inv.id)?.status).toBe('unknown');
      expect(run).toMatchObject({ status: 'failed', errorCode: 'TOOL_OUTCOME_UNKNOWN' });
      expect(await getTask(team, task.id)).toMatchObject({
        status: 'blocked',
        blockedReason: 'TOOL_OUTCOME_UNKNOWN',
      });
      expect(await h.dryRun.read()).toEqual([]);
    });
  });

  describe('run waiting_approval qua restart', () => {
    it.each(['claude_agent_sdk', 'messages_api'] as const)(
      'runtime %s: run vẫn chờ khi quét, approve sau restart thì resume và thành công, hành động chỉ thực thi một lần',
      async (runtimeKind) => {
        const team = await approvalTeam(h, { runtimeKind });
        const task = await assignEmailTask(h, team);
        await h.settle();
        const [approval] = await pendingApprovals(h, team, task.id);
        expect(approval).toBeDefined();
        const [run] = (
          await h.orchestration.listRuns(team.scene.ctx(), { taskId: task.id })
        ).items.filter((r) => r.purpose === 'execute');

        // "Restart": hàng đợi và mọi tiến trình trong bộ nhớ mất; chỉ còn dữ liệu trong PostgreSQL.
        h.queue.jobs.splice(0);
        await h.orchestration.recoverStaleRuns();
        await h.settle();
        expect((await getRun(team, run!.id)).status).toBe('waiting_approval');
        expect(await h.dryRun.read()).toEqual([]);

        await decideAs(h, team, approval!, 'approve', 'ok');
        await h.settle();
        expect(await getRun(team, run!.id)).toMatchObject({ status: 'succeeded' });
        expect(await h.dryRun.read()).toHaveLength(1);
      },
    );
  });
});
