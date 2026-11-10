import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EmployeeProfile, Task } from '@claude-company/contracts';
import { withTenant } from '@claude-company/db';
import { agentRun } from '@claude-company/db/schema/orchestration';
import { eq } from 'drizzle-orm';
import {
  prepareDatabase,
  seedDatabase,
  startInfra,
  type StartedInfra,
} from '../support/containers';
import {
  createFlowHarness,
  managerProfile,
  type FlowHarness,
  type Scene,
} from '../support/flow-harness';

/**
 * Contract test `OrchestrationEngine` (T080; Nguyên tắc VI, R5): tạo run, trạng thái, heartbeat, run step,
 * ledger tool, trạng thái hội thoại, hủy và `recoverStaleRuns`. Engine thật trên PostgreSQL (RLS bật).
 */
describe('Contract: OrchestrationEngine (T080)', () => {
  let infra: StartedInfra;
  let h: FlowHarness;

  beforeAll(async () => {
    infra = await startInfra({ redis: false });
    await prepareDatabase(infra);
    await seedDatabase(infra);
    h = await createFlowHarness({ infra, env: { RUN_STALE_AFTER_MS: '60000' } });
  });

  afterAll(async () => {
    await h?.close();
    await infra?.stop();
  });

  type Setup = { scene: Scene; manager: EmployeeProfile; dev: EmployeeProfile };

  async function setup(): Promise<Setup> {
    const scene = await h.newScene();
    const manager = await h.hire(scene, managerProfile(scene));
    const dev = await h.hire(scene, { manager: { kind: 'ai', id: manager.id } });
    return { scene, manager, dev };
  }

  /** Task đã `assigned` nhưng sự kiện chưa được phát, nên chưa có run nào tự tạo. */
  async function assignedTask(s: Setup, assigneeId = s.dev.id): Promise<Task> {
    const ctx = s.scene.humanCtx(s.scene.ceo.memberId);
    const task = await h.tasks.create(ctx, {
      title: 'Việc thử',
      objective: 'Phân tích tài liệu',
      assignee: { kind: 'ai_employee', id: assigneeId },
      deadline: '2027-12-31T00:00:00Z',
      priority: 'medium',
      acceptanceCriteria: ['Có kết quả'],
      expectedOutput: 'Báo cáo',
    });
    await h.tasks.transition(ctx, task.id, 'assign');
    return task;
  }

  const sys = (s: Setup) => s.scene.ctx();

  describe('enqueueRun', () => {
    it('execute: tạo run queued cho assignee, ảnh chụp runtime/model và xếp job run.start', async () => {
      const s = await setup();
      const task = await assignedTask(s);
      const { runId } = await h.orchestration.enqueueRun(sys(s), task.id, 'execute');
      const run = await h.orchestration.getRun(sys(s), runId);
      expect(run).toMatchObject({
        taskId: task.id,
        employeeId: s.dev.id,
        purpose: 'execute',
        attempt: 1,
        status: 'queued',
        runtimeKind: s.dev.runtimeKind,
        modelId: s.dev.modelId,
      });
      const job = h.queue.history.find((j) => j.payload.runId === runId);
      expect(job).toMatchObject({
        name: 'run.start',
        payload: { taskId: task.id, employeeId: s.dev.id },
      });
    });

    it('đã có run chưa kết thúc cùng task + purpose thì trả lại run đó (khử trùng), không xếp thêm job', async () => {
      const s = await setup();
      const task = await assignedTask(s);
      const first = await h.orchestration.enqueueRun(sys(s), task.id, 'execute');
      const jobs = h.queue.history.length;
      const second = await h.orchestration.enqueueRun(sys(s), task.id, 'execute');
      expect(second.runId).toBe(first.runId);
      expect(h.queue.history.length).toBe(jobs);
      expect((await h.orchestration.listRuns(sys(s), { taskId: task.id })).items).toHaveLength(1);
    });

    it('decompose: chọn AI Manager của nhân viên, xếp job task.decompose', async () => {
      const s = await setup();
      const task = await assignedTask(s);
      const { runId } = await h.orchestration.enqueueRun(sys(s), task.id, 'decompose');
      const run = await h.orchestration.getRun(sys(s), runId);
      expect(run).toMatchObject({ purpose: 'decompose', employeeId: s.manager.id });
      expect(h.queue.history.find((j) => j.payload.runId === runId)?.name).toBe('task.decompose');
    });

    it('decompose không có AI Manager → task blocked NO_AI_MANAGER và ném lỗi cùng mã', async () => {
      // Công ty không có AI Manager nào (nhân viên báo cáo thẳng cho CEO).
      const scene = await h.newScene();
      const dev = await h.hire(scene);
      const s: Setup = { scene, manager: dev, dev };
      const task = await assignedTask(s);
      await expect(h.orchestration.enqueueRun(sys(s), task.id, 'decompose')).rejects.toMatchObject({
        code: 'NO_AI_MANAGER',
      });
      const after = await h.tasks.get(sys(s), task.id);
      expect(after).toMatchObject({ status: 'blocked', blockedReason: 'NO_AI_MANAGER' });
    });

    it('nhân viên suspended không bắt đầu run mới (EMPLOYEE_SUSPENDED)', async () => {
      const s = await setup();
      const task = await assignedTask(s);
      await h.employees.suspend(sys(s), s.dev.id);
      await expect(h.orchestration.enqueueRun(sys(s), task.id, 'execute')).rejects.toMatchObject({
        code: 'EMPLOYEE_SUSPENDED',
      });
    });

    it('task không tồn tại → NOT_FOUND', async () => {
      const s = await setup();
      await expect(
        h.orchestration.enqueueRun(sys(s), randomUUID(), 'execute'),
      ).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('review: reviewer luôn khác người thực thi; không có reviewer độc lập → NO_INDEPENDENT_REVIEWER', async () => {
      // Không có AI Manager nào ngoài chính người thực thi: AI Manager được giao trực tiếp tự đảm nhiệm.
      const scene = await h.newScene();
      const solo = await h.hire(scene, managerProfile(scene));
      const ctx = scene.humanCtx(scene.ceo.memberId);
      const task = await h.tasks.create(ctx, {
        title: 'Việc của manager',
        objective: 'Mục tiêu',
        assignee: { kind: 'ai_employee', id: solo.id },
        deadline: '2027-12-31T00:00:00Z',
        priority: 'medium',
        acceptanceCriteria: ['Có kết quả'],
        expectedOutput: 'Báo cáo',
      });
      await h.tasks.transition(ctx, task.id, 'assign');
      await h.tasks.transition(scene.ctx(), task.id, 'start');
      await h.tasks.transition(scene.ctx(), task.id, 'submit');
      await expect(
        h.orchestration.enqueueRun(scene.ctx(), task.id, 'review'),
      ).rejects.toMatchObject({
        code: 'NO_INDEPENDENT_REVIEWER',
      });
      expect(await h.tasks.get(scene.ctx(), task.id)).toMatchObject({
        status: 'blocked',
        blockedReason: 'NO_INDEPENDENT_REVIEWER',
      });
    });
  });

  describe('enqueueRetry', () => {
    it('tạo lần thử kế tiếp cùng task, nhân viên và purpose với attempt + 1', async () => {
      const s = await setup();
      const task = await assignedTask(s);
      const first = await h.orchestration.enqueueRun(sys(s), task.id, 'execute');
      await h.orchestration.updateRunStatus(sys(s), first.runId, {
        status: 'failed',
        errorCode: 'PROVIDER_ERROR',
      });
      const retry = await h.orchestration.enqueueRetry(sys(s), first.runId, 0);
      expect(retry.runId).not.toBe(first.runId);
      expect(await h.orchestration.getRun(sys(s), retry.runId)).toMatchObject({
        taskId: task.id,
        employeeId: s.dev.id,
        purpose: 'execute',
        attempt: 2,
        status: 'queued',
      });
    });

    it('run không tồn tại → NOT_FOUND', async () => {
      const s = await setup();
      await expect(h.orchestration.enqueueRetry(sys(s), randomUUID(), 0)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });
  });

  describe('trạng thái run, heartbeat và run step', () => {
    it('updateRunStatus: running đặt startedAt; trạng thái cuối đặt finishedAt và không đổi nữa', async () => {
      const s = await setup();
      const task = await assignedTask(s);
      const { runId } = await h.orchestration.enqueueRun(sys(s), task.id, 'execute');
      await h.orchestration.updateRunStatus(sys(s), runId, {
        status: 'running',
        providerSessionId: 'sess-1',
      });
      let run = await h.orchestration.getRun(sys(s), runId);
      expect(run).toMatchObject({ status: 'running', providerSessionId: 'sess-1' });
      expect(run.startedAt).not.toBeNull();
      expect(run.finishedAt).toBeNull();

      await h.orchestration.updateRunStatus(sys(s), runId, { status: 'succeeded' });
      run = await h.orchestration.getRun(sys(s), runId);
      expect(run.status).toBe('succeeded');
      expect(run.finishedAt).not.toBeNull();

      // Run đã kết thúc thì không bị ghi đè (ví dụ worker chậm báo muộn sau khi run đã bị hủy).
      await h.orchestration.updateRunStatus(sys(s), runId, { status: 'failed', errorCode: 'LATE' });
      expect((await h.orchestration.getRun(sys(s), runId)).status).toBe('succeeded');
    });

    it('heartbeat cập nhật nhịp sống và trả trạng thái hiện tại để run-loop biết khi bị hủy', async () => {
      const s = await setup();
      const task = await assignedTask(s);
      const { runId } = await h.orchestration.enqueueRun(sys(s), task.id, 'execute');
      await h.orchestration.updateRunStatus(sys(s), runId, { status: 'running' });
      expect(await h.orchestration.heartbeat(sys(s), runId)).toBe('running');
      await h.orchestration.cancelRunsForTask(sys(s), task.id);
      expect(await h.orchestration.heartbeat(sys(s), runId)).toBe('cancelled');
    });

    it('appendRunStep đánh seq tăng dần theo run; getRun trả đủ bước theo thứ tự', async () => {
      const s = await setup();
      const task = await assignedTask(s);
      const { runId } = await h.orchestration.enqueueRun(sys(s), task.id, 'execute');
      const a = await h.orchestration.appendRunStep(sys(s), runId, {
        kind: 'system',
        summary: 'Bắt đầu',
      });
      const b = await h.orchestration.appendRunStep(sys(s), runId, {
        kind: 'model_call',
        summary: 'Lượt 1',
        payload: { tokens: 10 },
      });
      const c = await h.orchestration.appendRunStep(sys(s), runId, {
        kind: 'tool_call',
        summary: 'Đọc file',
      });
      expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3]);
      const run = await h.orchestration.getRun(sys(s), runId);
      expect(run.steps.map((x) => x.summary)).toEqual(['Bắt đầu', 'Lượt 1', 'Đọc file']);
    });
  });

  describe('ledger tool_invocation', () => {
    const invocation = (runId: string, key: string) => ({
      runId,
      actionType: 'workspace.read',
      permissionLevel: 'auto_execute',
      input: { path: 'README.md' },
      inputHash: 'a'.repeat(64),
      idempotencyKey: key,
      status: 'executing' as const,
    });

    it('ghi, tìm theo idempotency key và cập nhật kết quả', async () => {
      const s = await setup();
      const task = await assignedTask(s);
      const { runId } = await h.orchestration.enqueueRun(sys(s), task.id, 'execute');
      const key = `key-${randomUUID()}`;
      const ref = await h.orchestration.recordToolInvocation(sys(s), invocation(runId, key));
      expect(ref).toMatchObject({ idempotencyKey: key, status: 'executing' });
      expect((await h.orchestration.findToolInvocationByKey(sys(s), key))?.id).toBe(ref.id);

      await h.orchestration.updateToolInvocation(sys(s), ref.id, {
        status: 'succeeded',
        result: { ok: true },
        adapterMode: 'dry_run',
      });
      const found = await h.orchestration.findToolInvocationByKey(sys(s), key);
      expect(found).toMatchObject({ id: ref.id, status: 'succeeded' });
      const run = await h.orchestration.getRun(sys(s), runId);
      expect(run.toolInvocations.map((i) => i.id)).toEqual([ref.id]);
    });

    it('trùng idempotency key trả bản ghi đã có, không tạo bản thứ hai', async () => {
      const s = await setup();
      const task = await assignedTask(s);
      const { runId } = await h.orchestration.enqueueRun(sys(s), task.id, 'execute');
      const key = `key-${randomUUID()}`;
      const first = await h.orchestration.recordToolInvocation(sys(s), invocation(runId, key));
      const second = await h.orchestration.recordToolInvocation(sys(s), invocation(runId, key));
      expect(second.id).toBe(first.id);
      expect((await h.orchestration.getRun(sys(s), runId)).toolInvocations).toHaveLength(1);
    });

    it('key không tồn tại → null; ledger của công ty khác không thấy được', async () => {
      const s = await setup();
      const other = await h.newScene();
      const task = await assignedTask(s);
      const { runId } = await h.orchestration.enqueueRun(sys(s), task.id, 'execute');
      const key = `key-${randomUUID()}`;
      await h.orchestration.recordToolInvocation(sys(s), invocation(runId, key));
      expect(await h.orchestration.findToolInvocationByKey(sys(s), 'khong-co')).toBeNull();
      expect(await h.orchestration.findToolInvocationByKey(other.ctx(), key)).toBeNull();
      await expect(h.orchestration.getRun(other.ctx(), runId)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('listExecutedActions chỉ trả hành động đã thực thi của task', async () => {
      const s = await setup();
      const task = await assignedTask(s);
      const { runId } = await h.orchestration.enqueueRun(sys(s), task.id, 'execute');
      const done = await h.orchestration.recordToolInvocation(
        sys(s),
        invocation(runId, `k-${randomUUID()}`),
      );
      await h.orchestration.updateToolInvocation(sys(s), done.id, {
        status: 'succeeded',
        adapterMode: 'dry_run',
      });
      await h.orchestration.recordToolInvocation(sys(s), {
        ...invocation(runId, `k-${randomUUID()}`),
        status: 'denied',
      });
      const actions = await h.orchestration.listExecutedActions(sys(s), task.id);
      expect(actions.map((a) => a.toolInvocationId)).toEqual([done.id]);
      expect(actions[0]).toMatchObject({
        actionType: 'workspace.read',
        adapterMode: 'dry_run',
        status: 'succeeded',
      });
    });
  });

  describe('trạng thái hội thoại', () => {
    it('lưu rồi đọc lại; ghi đè bằng lần lưu sau; run chưa có trạng thái → null', async () => {
      const s = await setup();
      const task = await assignedTask(s);
      const { runId } = await h.orchestration.enqueueRun(sys(s), task.id, 'execute');
      expect(await h.orchestration.loadConversationState(sys(s), runId)).toBeNull();
      await h.orchestration.saveConversationState(sys(s), runId, [{ role: 'user', content: 'a' }]);
      await h.orchestration.saveConversationState(sys(s), runId, [{ role: 'user', content: 'b' }]);
      expect(await h.orchestration.loadConversationState(sys(s), runId)).toEqual([
        { role: 'user', content: 'b' },
      ]);
    });
  });

  describe('listRuns và cancelRunsForTask', () => {
    it('lọc theo task và theo nhân viên', async () => {
      const s = await setup();
      const t1 = await assignedTask(s);
      const t2 = await assignedTask(s);
      await h.orchestration.enqueueRun(sys(s), t1.id, 'execute');
      await h.orchestration.enqueueRun(sys(s), t2.id, 'execute');
      expect((await h.orchestration.listRuns(sys(s), { taskId: t1.id })).items).toHaveLength(1);
      expect((await h.orchestration.listRuns(sys(s), { employeeId: s.dev.id })).items).toHaveLength(
        2,
      );
      expect(
        (await h.orchestration.listRuns(sys(s), { employeeId: s.manager.id })).items,
      ).toHaveLength(0);
    });

    it('cancelRunsForTask hủy mọi run chưa kết thúc của task và giữ nguyên run đã kết thúc', async () => {
      const s = await setup();
      const task = await assignedTask(s);
      const finished = await h.orchestration.enqueueRun(sys(s), task.id, 'decompose');
      await h.orchestration.updateRunStatus(sys(s), finished.runId, { status: 'succeeded' });
      const active = await h.orchestration.enqueueRun(sys(s), task.id, 'execute');
      await h.orchestration.updateRunStatus(sys(s), active.runId, { status: 'running' });

      await h.orchestration.cancelRunsForTask(sys(s), task.id);
      expect((await h.orchestration.getRun(sys(s), active.runId)).status).toBe('cancelled');
      expect((await h.orchestration.getRun(sys(s), finished.runId)).status).toBe('succeeded');
    });
  });

  describe('recoverStaleRuns (R5)', () => {
    async function makeRunning(s: Setup): Promise<{ task: Task; runId: string }> {
      const task = await assignedTask(s);
      await h.tasks.transition(sys(s), task.id, 'start');
      const { runId } = await h.orchestration.enqueueRun(sys(s), task.id, 'execute');
      await h.orchestration.updateRunStatus(sys(s), runId, { status: 'running' });
      return { task, runId };
    }

    const ageHeartbeat = (s: Setup, runId: string, ms: number) =>
      withTenant(s.scene.companyId, (tx) =>
        tx
          .update(agentRun)
          .set({ heartbeatAt: new Date(Date.now() - ms) })
          .where(eq(agentRun.id, runId)),
      );

    it('run quá hạn heartbeat → failed RUN_INTERRUPTED, task blocked để người thật quyết định', async () => {
      const s = await setup();
      const { task, runId } = await makeRunning(s);
      await ageHeartbeat(s, runId, 10 * 60_000);

      const report = await h.orchestration.recoverStaleRuns();
      expect(report.failed).toBeGreaterThanOrEqual(1);
      expect(await h.orchestration.getRun(sys(s), runId)).toMatchObject({
        status: 'failed',
        errorCode: 'RUN_INTERRUPTED',
      });
      expect(await h.tasks.get(sys(s), task.id)).toMatchObject({
        status: 'blocked',
        blockedReason: 'RUN_INTERRUPTED',
      });
    });

    it('run còn heartbeat gần đây không bị động tới', async () => {
      const s = await setup();
      const { task, runId } = await makeRunning(s);
      await h.orchestration.heartbeat(sys(s), runId);
      await h.orchestration.recoverStaleRuns();
      expect((await h.orchestration.getRun(sys(s), runId)).status).toBe('running');
      expect((await h.tasks.get(sys(s), task.id)).status).toBe('in_progress');
    });

    it('tool kẹt ở executing không xác định được kết quả → TOOL_OUTCOME_UNKNOWN, tool đánh dấu unknown', async () => {
      const s = await setup();
      const { task, runId } = await makeRunning(s);
      const inv = await h.orchestration.recordToolInvocation(sys(s), {
        runId,
        actionType: 'email.send',
        permissionLevel: 'human_approval',
        input: { to: ['a@example.com'] },
        inputHash: 'b'.repeat(64),
        idempotencyKey: `k-${randomUUID()}`,
        status: 'executing',
      });
      await ageHeartbeat(s, runId, 10 * 60_000);

      await h.orchestration.recoverStaleRuns();
      expect(await h.orchestration.getRun(sys(s), runId)).toMatchObject({
        status: 'failed',
        errorCode: 'TOOL_OUTCOME_UNKNOWN',
      });
      const run = await h.orchestration.getRun(sys(s), runId);
      expect(run.toolInvocations.find((i) => i.id === inv.id)?.status).toBe('unknown');
      expect(await h.tasks.get(sys(s), task.id)).toMatchObject({
        status: 'blocked',
        blockedReason: 'TOOL_OUTCOME_UNKNOWN',
      });
    });

    it('mặc định không tự resume session (SDK_RESUME_AFTER_CRASH = false) dù run có provider_session_id', async () => {
      const s = await setup();
      const { runId } = await makeRunning(s);
      await h.orchestration.updateRunStatus(sys(s), runId, { providerSessionId: 'sess-crash' });
      await ageHeartbeat(s, runId, 10 * 60_000);
      const before = h.queue.history.length;
      await h.orchestration.recoverStaleRuns();
      expect((await h.orchestration.getRun(sys(s), runId)).status).toBe('failed');
      expect(h.queue.history.slice(before).some((j) => j.name === 'run.resume')).toBe(false);
    });
  });
});
