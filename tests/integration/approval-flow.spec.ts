import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId, withTenant } from '@claude-company/db';
import { domainEvent } from '@claude-company/db/schema/events';
import { budgetPolicy, budgetReservation } from '@claude-company/db/schema/usage';
import { asc } from 'drizzle-orm';
import { remindPendingApprovalsOnce } from '../../apps/worker/src/jobs/approval-reminder';
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

/**
 * Luồng Human Approval từ đầu đến cuối với engine thật trên PostgreSQL (T130; US4-AS1, AS2, AS5, FR-025, FR-026,
 * FR-041): agent đề xuất → hệ thống tạo yêu cầu và tạm dừng run → người duyệt quyết định → hệ thống (không phải
 * agent) thực thi đúng payload qua adapter dry-run → run tiếp tục với kết quả hoặc lý do từ chối.
 */
describe('Integration: luồng Human Approval (US4)', () => {
  let infra: StartedInfra;
  let h: FlowHarness;

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

  // Log dry-run dùng chung trong một harness: tách từng ca để khẳng định "chưa có email nào" không bị ca khác làm nhiễu.
  beforeEach(async () => {
    await h.dryRun.clear();
  });

  const events = async (companyId: string) =>
    (
      await withTenant(companyId, (tx) =>
        tx.select({ type: domainEvent.type }).from(domainEvent).orderBy(asc(domainEvent.seq)),
      )
    ).map((e) => e.type);

  async function executeRun(team: ApprovalTeam, taskId: string) {
    const runs = (await h.orchestration.listRuns(team.scene.ctx(), { taskId })).items;
    const exec = runs.filter((r) => r.purpose === 'execute').at(-1)!;
    return h.orchestration.getRun(team.scene.ctx(), exec.id);
  }

  async function artifactText(team: ApprovalTeam, taskId: string): Promise<string> {
    const detail = await h.tasks.get(team.scene.ctx(), taskId);
    const artifact = detail.artifacts.at(-1)!;
    const { content } = await h.tasks.readArtifact(team.scene.ctx(), artifact.id, 100_000);
    return content.toString('utf8');
  }

  /** Giao task có đề xuất gửi email rồi chạy tới khi run dừng chờ duyệt. */
  async function paused(options: { runtimeKind?: 'claude_agent_sdk' | 'messages_api' } = {}) {
    const team = await approvalTeam(h, { runtimeKind: options.runtimeKind });
    const task = await assignEmailTask(h, team);
    await h.settle();
    const [approval] = await pendingApprovals(h, team, task.id);
    expect(approval, 'phải có yêu cầu phê duyệt đang chờ').toBeDefined();
    return { team, task, approval: approval! };
  }

  it('AS1: hành động auto_execute diễn ra không cần can thiệp và vẫn được ghi nhận', async () => {
    const team = await approvalTeam(h);
    const task = await assignEmailTask(h, team, { objective: 'Viết báo cáo phân tích yêu cầu' });
    await h.settle();
    const run = await executeRun(team, task.id);
    const publish = run.toolInvocations.find((i) => i.actionType === 'artifact.publish');
    expect(publish).toMatchObject({ permissionLevel: 'auto_execute', status: 'succeeded' });
    expect(await pendingApprovals(h, team)).toHaveLength(0);
    expect((await h.tasks.get(team.scene.ctx(), task.id)).status).toBe('awaiting_human_approval');
  });

  describe('AS2: hành động nhạy cảm tạo yêu cầu phê duyệt và tạm dừng', () => {
    it('tạo yêu cầu đủ ngữ cảnh, run chờ duyệt, task giữ In Progress, người duyệt được thông báo, chưa có email nào', async () => {
      const { team, task, approval } = await paused();
      expect(approval).toMatchObject({
        status: 'pending',
        actionType: 'email.send',
        employeeId: team.dev.id,
        taskId: task.id,
        payload: FAKE_EMAIL_PAYLOAD,
      });
      expect(approval.summary).toContain('attacker@example.com');
      expect(approval.approverMemberId).toBe(team.scene.ceo.memberId);

      const run = await executeRun(team, task.id);
      expect(run.status).toBe('waiting_approval');
      expect(run.toolInvocations.find((i) => i.actionType === 'email.send')?.status).toBe(
        'pending_approval',
      );
      expect((await h.tasks.get(team.scene.ctx(), task.id)).status).toBe('in_progress');
      expect(await h.dryRun.read()).toEqual([]);

      const notices = await h.communication.listNotifications(
        team.scene.humanCtx(team.scene.ceo.memberId),
        team.scene.ceo.memberId,
        {},
      );
      expect(
        notices.items.some(
          (n) => n.type === 'approval_needed' && n.approvalRequestId === approval.id,
        ),
      ).toBe(true);
      const types = await events(team.scene.companyId);
      expect(types).toEqual(expect.arrayContaining(['approval.requested', 'run.waiting_approval']));
    });

    it('không còn reservation `held` trong lúc run chờ duyệt (không giữ ngân sách khi chờ)', async () => {
      const { team } = await paused();
      const rows = await withTenant(team.scene.companyId, (tx) =>
        tx.select().from(budgetReservation),
      );
      expect(rows.filter((r) => r.status === 'held')).toHaveLength(0);
    });
  });

  describe('duyệt', () => {
    it('approve: hệ thống thực thi đúng payload đã duyệt (dry-run), ghi ledger, run tiếp tục tới review', async () => {
      const { team, task, approval } = await paused();
      const decided = await decideAs(h, team, approval, 'approve', 'Nội dung ổn');
      expect(decided).toMatchObject({ status: 'approved', decidedBy: team.scene.ceo.memberId });
      await h.settle();

      const entries = await h.dryRun.read();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        actionType: 'email.send',
        payload: FAKE_EMAIL_PAYLOAD,
        mode: 'dry_run',
      });

      const run = await executeRun(team, task.id);
      expect(run.status).toBe('succeeded');
      const email = run.toolInvocations.find((i) => i.actionType === 'email.send')!;
      expect(email).toMatchObject({ status: 'succeeded', adapterMode: 'dry_run' });
      expect(entries[0]!.idempotencyKey).toBe(email.idempotencyKey);
      expect(JSON.stringify(email.result)).toContain('dry-run');

      const executed = await h.orchestration.listExecutedActions(team.scene.ctx(), task.id);
      expect(executed).toEqual([
        expect.objectContaining({
          actionType: 'email.send',
          adapterMode: 'dry_run',
          status: 'succeeded',
        }),
      ]);

      // Agent nhận kết quả và nêu rõ trong artifact; task đi tiếp theo vòng đời thường.
      expect(await artifactText(team, task.id)).toContain('đã được duyệt và thực thi (dry-run)');
      expect((await h.tasks.get(team.scene.ctx(), task.id)).status).toBe('awaiting_human_approval');
      expect(await events(team.scene.companyId)).toEqual(
        expect.arrayContaining(['approval.decided', 'run.resumed', 'run.succeeded']),
      );
    });

    it('AS5 reject: hành động KHÔNG được thực hiện, run tiếp tục với lý do từ chối, quyết định được ghi lại', async () => {
      const { team, task, approval } = await paused();
      await decideAs(h, team, approval, 'reject', 'Không gửi cho người lạ');
      await h.settle();

      expect(await h.dryRun.read()).toEqual([]);
      expect(await h.orchestration.listExecutedActions(team.scene.ctx(), task.id)).toEqual([]);
      const run = await executeRun(team, task.id);
      expect(run.status).toBe('succeeded');
      expect(run.toolInvocations.find((i) => i.actionType === 'email.send')?.status).toBe('denied');

      const text = await artifactText(team, task.id);
      expect(text).toContain('bị từ chối');
      expect(text).toContain('Không gửi cho người lạ'); // lý do được đưa cho AI Employee
      expect(await h.permission.getApproval(team.scene.ctx(), approval.id)).toMatchObject({
        status: 'rejected',
        decidedBy: team.scene.ceo.memberId,
        decisionReason: 'Không gửi cho người lạ',
      });
      expect((await h.tasks.get(team.scene.ctx(), task.id)).status).toBe('awaiting_human_approval');
    });

    it('runtime messages_api: hội thoại được lưu khi chờ duyệt và run tiếp tục sau khi duyệt', async () => {
      const { team, task, approval } = await paused({ runtimeKind: 'messages_api' });
      const run = await executeRun(team, task.id);
      expect(run.status).toBe('waiting_approval');
      expect(await h.orchestration.loadConversationState(team.scene.ctx(), run.id)).not.toBeNull();

      await decideAs(h, team, approval, 'approve', 'ok');
      await h.settle();
      expect(await h.dryRun.read()).toHaveLength(1);
      expect((await executeRun(team, task.id)).status).toBe('succeeded');
      expect((await h.tasks.get(team.scene.ctx(), task.id)).status).toBe('awaiting_human_approval');
    });

    it('sau duyệt không đủ ngân sách để resume → task blocked BUDGET_EXCEEDED (hành động đã duyệt vẫn đã thực thi)', async () => {
      const { team, task, approval } = await paused();
      await withTenant(team.scene.companyId, (tx) =>
        tx.insert(budgetPolicy).values({
          id: newId(),
          companyId: team.scene.companyId,
          scopeKind: 'company',
          scopeId: team.scene.companyId,
          monthlyCostLimit: '0.0001',
        }),
      );
      await decideAs(h, team, approval, 'approve', 'ok');
      await h.settle();
      expect(await h.tasks.get(team.scene.ctx(), task.id)).toMatchObject({
        status: 'blocked',
        blockedReason: 'BUDGET_EXCEEDED',
      });
      expect(await h.dryRun.read()).toHaveLength(1);
    });
  });

  describe('thông báo, nhắc và chuyển người duyệt', () => {
    it('nhắc người duyệt sau 1 giờ rồi mỗi 24 giờ, không bao giờ tự duyệt', async () => {
      const { team, approval } = await paused();
      const at = (hours: number) => () => new Date(Date.now() + hours * 3_600_000);
      const deps = { permissions: h.permission };
      const count = async (hours: number) =>
        (await remindPendingApprovalsOnce({ ...deps, now: at(hours) })).reminded;

      expect(await count(0.5)).toBe(0);
      expect(await count(1.1)).toBeGreaterThanOrEqual(1);
      expect(await count(2)).toBe(0);
      expect(await count(26)).toBeGreaterThanOrEqual(1);
      await h.settle();
      expect((await h.permission.getApproval(team.scene.ctx(), approval.id)).status).toBe(
        'pending',
      );
      expect(await h.dryRun.read()).toEqual([]);
    });

    it('người duyệt bị vô hiệu → yêu cầu đang chờ chuyển cho CEO (FR-026)', async () => {
      const team = await approvalTeam(h);
      const manager = await h.addManager(team.scene);
      const ceoCtx = team.scene.humanCtx(team.scene.ceo.memberId);
      await h.employees.update(ceoCtx, team.dev.id, {
        manager: { kind: 'human', id: manager.memberId },
      });
      const task = await assignEmailTask(h, team, { by: manager.memberId, injection: true });
      await h.settle();
      const [approval] = await pendingApprovals(h, team, task.id);
      expect(approval?.approverMemberId).toBe(manager.memberId);

      // Chuyển manager của nhân viên về CEO rồi vô hiệu người duyệt.
      await h.employees.update(ceoCtx, team.dev.id, {
        manager: { kind: 'human', id: team.scene.ceo.memberId },
      });
      await h.employees.deactivateHumanMember(ceoCtx, manager.memberId);
      await h.settle();

      const after = await h.permission.getApproval(team.scene.ctx(), approval!.id);
      expect(after).toMatchObject({ status: 'pending', approverMemberId: team.scene.ceo.memberId });
      const notices = await h.communication.listNotifications(ceoCtx, team.scene.ceo.memberId, {});
      expect(
        notices.items.some(
          (n) => n.type === 'approval_needed' && n.approvalRequestId === approval!.id,
        ),
      ).toBe(true);

      // CEO duyệt được và luồng tiếp tục bình thường.
      await decideAs(h, team, after, 'approve', 'ok');
      await h.settle();
      expect(await h.dryRun.read()).toHaveLength(1);
    });
  });

  describe('phục hồi', () => {
    it('job bị mất sau khi duyệt (Redis mất dữ liệu): sweeper phát lại, run tiếp tục, hành động chỉ thực thi một lần', async () => {
      const { team, task, approval } = await paused();
      await decideAs(h, team, approval, 'approve', 'ok');
      await h.relay.tick(); // phát approval.decided → job thực thi được xếp hàng
      h.queue.jobs.splice(0); // …rồi bị mất
      await h.settle();
      expect(await h.dryRun.read()).toEqual([]);
      expect((await executeRun(team, task.id)).status).toBe('waiting_approval');

      const report = await h.orchestration.recoverStaleRuns();
      expect(report.recovered).toBeGreaterThanOrEqual(1);
      await h.settle();
      expect(await h.dryRun.read()).toHaveLength(1);
      expect((await executeRun(team, task.id)).status).toBe('succeeded');

      // Chạy sweeper lần nữa: không còn gì để phát lại, không thực thi lần hai.
      await h.orchestration.recoverStaleRuns();
      await h.settle();
      expect(await h.dryRun.read()).toHaveLength(1);
    });

    it('yêu cầu chưa được quyết định không bị sweeper đụng tới (chờ người duyệt không phải lỗi)', async () => {
      const { team, task, approval } = await paused();
      await h.orchestration.recoverStaleRuns();
      await h.settle();
      expect((await executeRun(team, task.id)).status).toBe('waiting_approval');
      expect((await h.permission.getApproval(team.scene.ctx(), approval.id)).status).toBe(
        'pending',
      );
      expect(await h.dryRun.read()).toEqual([]);
    });
  });

  describe('task thay đổi trong lúc chờ duyệt', () => {
    it('hủy task → hủy run và chuyển yêu cầu sang cancelled; sau đó không duyệt được và không thực thi gì', async () => {
      const { team, task, approval } = await paused();
      await h.tasks.transition(team.scene.humanCtx(team.scene.ceo.memberId), task.id, 'cancel');
      await h.settle();

      expect((await h.permission.getApproval(team.scene.ctx(), approval.id)).status).toBe(
        'cancelled',
      );
      const run = await executeRun(team, task.id);
      expect(run.status).toBe('cancelled');
      expect(run.toolInvocations.find((i) => i.actionType === 'email.send')?.status).toBe('failed');
      await expect(decideAs(h, team, approval, 'approve', 'muộn')).rejects.toMatchObject({
        code: 'APPROVAL_NOT_PENDING',
      });
      await h.settle();
      expect(await h.dryRun.read()).toEqual([]);
    });

    it('nhân viên bị tạm ngưng → task blocked, yêu cầu cũ bị hủy; sau resume agent đề xuất lại và có yêu cầu mới', async () => {
      const { team, task, approval } = await paused();
      const ceoCtx = team.scene.humanCtx(team.scene.ceo.memberId);
      await h.employees.suspend(ceoCtx, team.dev.id);
      await h.settle();
      expect(await h.tasks.get(team.scene.ctx(), task.id)).toMatchObject({
        status: 'blocked',
        blockedReason: 'EMPLOYEE_SUSPENDED',
      });
      expect((await h.permission.getApproval(team.scene.ctx(), approval.id)).status).toBe(
        'cancelled',
      );

      await h.employees.resume(ceoCtx, team.dev.id);
      await h.tasks.transition(ceoCtx, task.id, 'resume');
      await h.settle();
      const fresh = await pendingApprovals(h, team, task.id);
      expect(fresh).toHaveLength(1);
      expect(fresh[0]!.id).not.toBe(approval.id);
      expect(await h.dryRun.read()).toEqual([]);
    });
  });
});

describe('Integration: adapter live chưa cấu hình (FR-027)', () => {
  let infra: StartedInfra;
  let h: FlowHarness;

  beforeAll(async () => {
    infra = await startInfra({ redis: false });
    await prepareDatabase(infra);
    await seedDatabase(infra);
    h = await createFlowHarness({ infra, env: { ADAPTER_MODE: 'live' } });
  });

  afterAll(async () => {
    await h?.close();
    await infra?.stop();
  });

  // Log dry-run dùng chung trong một harness: tách từng ca để khẳng định "chưa có email nào" không bị ca khác làm nhiễu.
  beforeEach(async () => {
    await h.dryRun.clear();
  });

  it('duyệt hành động khi ADAPTER_MODE=live chưa cấu hình → không thực thi, task blocked ADAPTER_LIVE_NOT_CONFIGURED, người giao được báo lỗi', async () => {
    const team = await approvalTeam(h);
    const task = await assignEmailTask(h, team, { injection: true });
    await h.settle();
    const [approval] = await pendingApprovals(h, team, task.id);
    await decideAs(h, team, approval!, 'approve', 'ok');
    await h.settle();

    expect(await h.dryRun.read()).toEqual([]);
    expect(await h.tasks.get(team.scene.ctx(), task.id)).toMatchObject({
      status: 'blocked',
      blockedReason: 'ADAPTER_LIVE_NOT_CONFIGURED',
    });
    expect(await h.orchestration.listExecutedActions(team.scene.ctx(), task.id)).toEqual([]);
    const notices = await h.communication.listNotifications(
      team.scene.humanCtx(team.scene.ceo.memberId),
      team.scene.ceo.memberId,
      {},
    );
    expect(notices.items.some((n) => n.type === 'task_error' && n.taskId === task.id)).toBe(true);
  });
});
