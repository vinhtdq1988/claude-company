import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '@claude-company/db';
import { domainEvent } from '@claude-company/db/schema/events';
import { payloadHashOf } from '@claude-company/policy';
import { asc } from 'drizzle-orm';
import {
  FAKE_EMAIL_PAYLOAD,
  approvalTeam,
  decideAs,
  pendingEmailInvocation,
} from '../support/approval-fixtures';
import {
  prepareDatabase,
  seedDatabase,
  startInfra,
  type StartedInfra,
} from '../support/containers';
import { createFlowHarness, type FlowHarness } from '../support/flow-harness';

/**
 * Contract test `PermissionEngine` — phần Human Approval (T125; FR-025, FR-026, SC-003, Nguyên tắc II):
 * `createApprovalRequest`, `decideApproval`, `remindPendingApprovals`, `listCompaniesWithPendingApprovals`.
 * Engine thật trên PostgreSQL (RLS bật).
 */
describe('Contract: PermissionEngine — Human Approval (T125)', () => {
  let infra: StartedInfra;
  let h: FlowHarness;

  beforeAll(async () => {
    infra = await startInfra({ redis: false });
    await prepareDatabase(infra);
    await seedDatabase(infra);
    h = await createFlowHarness({ infra });
  });

  afterAll(async () => {
    await h?.close();
    await infra?.stop();
  });

  const eventTypes = async (companyId: string) =>
    (
      await withTenant(companyId, (tx) =>
        tx.select({ type: domainEvent.type }).from(domainEvent).orderBy(asc(domainEvent.seq)),
      )
    ).map((e) => e.type);

  async function pending() {
    const team = await approvalTeam(h);
    const made = await pendingEmailInvocation(h, team);
    const approval = await h.permission.createApprovalRequest(
      made.aiCtx,
      made.invocation,
      'Gửi email tới attacker@example.com',
      'Khách yêu cầu',
    );
    return { team, ...made, approval };
  }

  describe('createApprovalRequest', () => {
    it('tạo yêu cầu đủ ngữ cảnh: hành động, lý do, nhân viên, task, payload và hash (FR-026)', async () => {
      const { team, task, invocation, approval } = await pending();
      expect(approval).toMatchObject({
        status: 'pending',
        actionType: 'email.send',
        employeeId: team.dev.id,
        taskId: task.id,
        toolInvocationId: invocation.id,
        summary: 'Gửi email tới attacker@example.com',
        rationale: 'Khách yêu cầu',
        payload: FAKE_EMAIL_PAYLOAD,
        payloadHash: payloadHashOf(FAKE_EMAIL_PAYLOAD),
        decidedBy: null,
        decisionReason: null,
      });
      // Người duyệt mặc định là người giao task.
      expect(approval.approverMemberId).toBe(team.scene.ceo.memberId);
      expect(await eventTypes(team.scene.companyId)).toContain('approval.requested');
    });

    it('payload lấy từ ledger chứ không từ tham số người gọi (không giả mạo được hành động được duyệt)', async () => {
      const team = await approvalTeam(h);
      const made = await pendingEmailInvocation(h, team);
      const forged = {
        ...made.invocation,
        input: { to: ['x@y.z'], subject: 'khác', body: 'khác' },
      };
      const approval = await h.permission.createApprovalRequest(made.aiCtx, forged, 's', 'r');
      expect(approval.payload).toEqual(FAKE_EMAIL_PAYLOAD);
    });

    it('idempotent theo tool_invocation: gọi lại trả cùng yêu cầu, không tạo bản thứ hai', async () => {
      const { team, aiCtx, invocation, approval } = await pending();
      const again = await h.permission.createApprovalRequest(aiCtx, invocation, 'khác', 'khác');
      expect(again.id).toBe(approval.id);
      const all = await h.permission.listApprovals(team.scene.ctx(), { status: 'pending' });
      expect(all.items).toHaveLength(1);
    });

    it('chỉ run của AI mới tạo được: tác nhân người hoặc hệ thống → FORBIDDEN', async () => {
      const team = await approvalTeam(h);
      const made = await pendingEmailInvocation(h, team);
      await expect(
        h.permission.createApprovalRequest(team.scene.ctx(), made.invocation, 's', 'r'),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        h.permission.createApprovalRequest(
          team.scene.humanCtx(team.scene.ceo.memberId),
          made.invocation,
          's',
          'r',
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('từ chối bản ghi không phải human_approval hoặc thuộc run khác → FORBIDDEN', async () => {
      const team = await approvalTeam(h);
      const made = await pendingEmailInvocation(h, team);
      // Bản ghi auto_execute không có lý do gì để xin duyệt.
      const auto = await h.orchestration.recordToolInvocation(made.aiCtx, {
        runId: made.aiCtx.actor.kind === 'ai' ? made.aiCtx.actor.runId : '',
        actionType: 'artifact.publish',
        permissionLevel: 'auto_execute',
        input: { title: 'x' },
        inputHash: 'h',
        idempotencyKey: `auto-${randomUUID()}`,
        status: 'pending_approval',
      });
      await expect(
        h.permission.createApprovalRequest(made.aiCtx, auto, 's', 'r'),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });

      const other = await pendingEmailInvocation(h, team);
      await expect(
        h.permission.createApprovalRequest(made.aiCtx, other.invocation, 's', 'r'),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('người giao task bị vô hiệu → yêu cầu chuyển cho CEO (FR-026)', async () => {
      const team = await approvalTeam(h);
      const manager = await h.addManager(team.scene);
      const ceoCtx = team.scene.humanCtx(team.scene.ceo.memberId);
      // Manager này quản lý nhân viên rồi tạo task; sau đó bị vô hiệu trước khi yêu cầu được tạo.
      await h.employees.update(ceoCtx, team.dev.id, {
        manager: { kind: 'human', id: manager.memberId },
      });
      const task = await h.tasks.create(team.scene.humanCtx(manager.memberId), {
        title: 'Việc của manager',
        objective: 'Gửi email',
        assignee: { kind: 'ai_employee', id: team.dev.id },
        deadline: '2027-12-31T00:00:00Z',
        priority: 'low',
        acceptanceCriteria: ['Xong'],
        expectedOutput: 'Email',
      });
      await h.tasks.transition(team.scene.humanCtx(manager.memberId), task.id, 'assign');
      await h.employees.update(ceoCtx, team.dev.id, {
        manager: { kind: 'human', id: team.scene.ceo.memberId },
      });
      await h.employees.deactivateHumanMember(ceoCtx, manager.memberId);

      const { runId } = await h.orchestration.enqueueRun(team.scene.ctx(), task.id, 'execute');
      const aiCtx = {
        companyId: team.scene.companyId,
        actor: { kind: 'ai' as const, employeeId: team.dev.id, runId },
        traceId: 't',
      };
      const invocation = await h.orchestration.recordToolInvocation(aiCtx, {
        runId,
        actionType: 'email.send',
        permissionLevel: 'human_approval',
        input: FAKE_EMAIL_PAYLOAD,
        inputHash: payloadHashOf(FAKE_EMAIL_PAYLOAD),
        idempotencyKey: `k-${randomUUID()}`,
        status: 'pending_approval',
      });
      const approval = await h.permission.createApprovalRequest(aiCtx, invocation, 's', 'r');
      expect(approval.approverMemberId).toBe(team.scene.ceo.memberId);
    });
  });

  describe('decideApproval', () => {
    it('approve ghi người quyết định, thời điểm, lý do và phát approval.decided', async () => {
      const { team, approval } = await pending();
      const decided = await decideAs(h, team, approval, 'approve', 'Nội dung ổn');
      expect(decided).toMatchObject({
        status: 'approved',
        decidedBy: team.scene.ceo.memberId,
        decisionReason: 'Nội dung ổn',
      });
      expect(decided.decidedAt).not.toBeNull();
      expect(await eventTypes(team.scene.companyId)).toContain('approval.decided');
    });

    it('reject cũng ghi lý do và không đổi payload', async () => {
      const { team, approval } = await pending();
      const decided = await decideAs(h, team, approval, 'reject', 'Không gửi cho người lạ');
      expect(decided).toMatchObject({
        status: 'rejected',
        decisionReason: 'Không gửi cho người lạ',
      });
      expect(decided.payload).toEqual(FAKE_EMAIL_PAYLOAD);
    });

    it('lý do bắt buộc với cả approve và reject (thiếu → VALIDATION_FAILED, yêu cầu vẫn chờ)', async () => {
      const { team, approval } = await pending();
      for (const decision of ['approve', 'reject'] as const) {
        for (const reason of ['', '   ']) {
          await expect(decideAs(h, team, approval, decision, reason)).rejects.toMatchObject({
            code: 'VALIDATION_FAILED',
          });
        }
      }
      expect((await h.permission.getApproval(team.scene.ctx(), approval.id)).status).toBe(
        'pending',
      );
    });

    it('payloadHash sai → APPROVAL_PAYLOAD_CHANGED, yêu cầu vẫn chờ', async () => {
      const { team, approval } = await pending();
      await expect(
        decideAs(h, team, { id: approval.id, payloadHash: 'sai' }, 'approve', 'ok'),
      ).rejects.toMatchObject({ code: 'APPROVAL_PAYLOAD_CHANGED' });
      expect((await h.permission.getApproval(team.scene.ctx(), approval.id)).status).toBe(
        'pending',
      );
    });

    it('quyết định hai lần → APPROVAL_NOT_PENDING, quyết định đầu được giữ nguyên', async () => {
      const { team, approval } = await pending();
      await decideAs(h, team, approval, 'approve', 'ok');
      await expect(decideAs(h, team, approval, 'reject', 'đổi ý')).rejects.toMatchObject({
        code: 'APPROVAL_NOT_PENDING',
      });
      expect(await h.permission.getApproval(team.scene.ctx(), approval.id)).toMatchObject({
        status: 'approved',
        decisionReason: 'ok',
      });
    });

    it('hai quyết định đồng thời: đúng một bên thành công', async () => {
      const { team, approval } = await pending();
      const results = await Promise.allSettled([
        decideAs(h, team, approval, 'approve', 'a'),
        decideAs(h, team, approval, 'reject', 'b'),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(failed.reason).toMatchObject({ code: 'APPROVAL_NOT_PENDING' });
    });

    it('tác nhân AI hoặc hệ thống không được quyết định (không có auto-approve)', async () => {
      const { team, aiCtx, approval } = await pending();
      const d = {
        decision: 'approve' as const,
        reason: 'tự duyệt',
        payloadHash: approval.payloadHash,
      };
      await expect(h.permission.decideApproval(aiCtx, approval.id, d)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      await expect(
        h.permission.decideApproval(team.scene.ctx(), approval.id, d),
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    });

    it('người ngoài phạm vi quản lý của nhân viên → FORBIDDEN', async () => {
      const { team, approval } = await pending();
      const outsider = await h.addManager(team.scene);
      await expect(
        decideAs(h, team, approval, 'approve', 'ok', outsider.memberId),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('yêu cầu của công ty khác không tồn tại với CEO này (cô lập tenant) → NOT_FOUND', async () => {
      const { approval } = await pending();
      const other = await approvalTeam(h);
      await expect(decideAs(h, other, approval, 'approve', 'ok')).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await expect(h.permission.getApproval(other.scene.ctx(), approval.id)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });
  });

  describe('getApproval, listApprovals', () => {
    it('lọc theo trạng thái và theo nhân viên trong phạm vi; kèm tên task và nhân viên', async () => {
      const { team, task, approval } = await pending();
      const listed = await h.permission.listApprovals(team.scene.ctx(), { status: 'pending' });
      expect(listed.items.map((a) => a.id)).toEqual([approval.id]);
      expect(listed.items[0]).toMatchObject({
        taskTitle: 'Báo cáo và gửi email',
        employeeName: team.dev.name,
      });
      expect(
        (await h.permission.listApprovals(team.scene.ctx(), { status: 'pending', taskId: task.id }))
          .items,
      ).toHaveLength(1);
      expect(
        (await h.permission.listApprovals(team.scene.ctx(), { status: 'approved' })).items,
      ).toHaveLength(0);
      // Phạm vi không có nhân viên nào → danh sách rỗng, không rơi về "không lọc".
      expect(
        (await h.permission.listApprovals(team.scene.ctx(), { employeeIds: [] })).items,
      ).toHaveLength(0);
      expect(
        (await h.permission.listApprovals(team.scene.ctx(), { employeeIds: [team.dev.id] })).items,
      ).toHaveLength(1);
    });
  });

  describe('remindPendingApprovals, listCompaniesWithPendingApprovals', () => {
    const HOUR = 3_600_000;

    it('nhắc lần đầu sau 1 giờ, lặp lại sau 24 giờ, không bao giờ tự duyệt', async () => {
      const { team, approval } = await pending();
      const ctx = team.scene.ctx();
      const now = Date.now();
      expect(await h.permission.remindPendingApprovals(ctx, new Date(now + 30 * 60_000))).toBe(0);
      expect(await h.permission.remindPendingApprovals(ctx, new Date(now + HOUR + 60_000))).toBe(1);
      // Vừa nhắc xong: chưa nhắc lại.
      expect(await h.permission.remindPendingApprovals(ctx, new Date(now + 2 * HOUR))).toBe(0);
      expect(await h.permission.remindPendingApprovals(ctx, new Date(now + 26 * HOUR))).toBe(1);

      const after = await h.permission.getApproval(ctx, approval.id);
      expect(after.status).toBe('pending');
      expect(after.lastRemindedAt).not.toBeNull();
      const notices = await h.communication.listNotifications(
        team.scene.humanCtx(team.scene.ceo.memberId),
        team.scene.ceo.memberId,
        {},
      );
      expect(
        notices.items.filter(
          (n) => n.type === 'approval_needed' && n.approvalRequestId === approval.id,
        ).length,
      ).toBeGreaterThanOrEqual(3); // lúc tạo + hai lần nhắc
    });

    it('yêu cầu đã quyết định không được nhắc', async () => {
      const { team, approval } = await pending();
      await decideAs(h, team, approval, 'reject', 'không');
      expect(
        await h.permission.remindPendingApprovals(
          team.scene.ctx(),
          new Date(Date.now() + 48 * HOUR),
        ),
      ).toBe(0);
    });

    it('listCompaniesWithPendingApprovals chỉ trả company_id có yêu cầu đang chờ', async () => {
      const { team, approval } = await pending();
      const idle = await approvalTeam(h);
      expect(await h.permission.listCompaniesWithPendingApprovals()).toContain(
        team.scene.companyId,
      );
      expect(await h.permission.listCompaniesWithPendingApprovals()).not.toContain(
        idle.scene.companyId,
      );
      await decideAs(h, team, approval, 'reject', 'không');
      expect(await h.permission.listCompaniesWithPendingApprovals()).not.toContain(
        team.scene.companyId,
      );
    });
  });
});
