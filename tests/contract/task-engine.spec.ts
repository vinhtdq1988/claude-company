import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EmployeeProfile, Task, TaskInput } from '@claude-company/contracts';
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
 * Contract test `TaskEngine` (T079; FR-014, FR-019, FR-020a, D1, Nguyên tắc II, VII): tạo task, máy trạng thái,
 * artifact, bằng chứng, quyết định review, phân rã, quá hạn, thống kê. Engine thật trên PostgreSQL (RLS bật).
 * Các sự kiện không được relay tới listener nên không có run nào tự chạy; test điều khiển từng bước.
 */
describe('Contract: TaskEngine (T079)', () => {
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

  type Team = { scene: Scene; manager: EmployeeProfile; dev: EmployeeProfile; ba: EmployeeProfile };

  async function team(): Promise<Team> {
    const scene = await h.newScene();
    const manager = await h.hire(scene, managerProfile(scene));
    const direct = { kind: 'ai' as const, id: manager.id };
    const dev = await h.hire(scene, { manager: direct });
    const ba = await h.hire(scene, {
      name: 'AI BA',
      position: 'AI BA',
      homeOrgUnitId: scene.units.BA!,
      manager: direct,
    });
    return { scene, manager, dev, ba };
  }

  const ceoCtx = (t: Team) => t.scene.humanCtx(t.scene.ceo.memberId);
  const aiCtx = (t: Team, employee: EmployeeProfile) =>
    t.scene.ctx({ kind: 'ai', employeeId: employee.id, runId: randomUUID() });

  const input = (assigneeId: string, over: Partial<TaskInput> = {}): TaskInput => ({
    title: 'Phân tích yêu cầu',
    objective: 'Phân tích tài liệu yêu cầu',
    assignee: { kind: 'ai_employee', id: assigneeId },
    deadline: '2027-12-31T00:00:00Z',
    priority: 'high',
    acceptanceCriteria: ['Nêu đủ yêu cầu', 'Nêu rủi ro'],
    expectedOutput: 'Báo cáo',
    ...over,
  });

  const create = (t: Team, assigneeId: string, over: Partial<TaskInput> = {}) =>
    h.tasks.create(ceoCtx(t), input(assigneeId, over));

  /** Task `in_progress` do `executor` thực hiện. */
  async function inProgress(t: Team, executor = t.dev): Promise<Task> {
    const task = await create(t, executor.id);
    await h.tasks.transition(ceoCtx(t), task.id, 'assign');
    await h.tasks.transition(t.scene.ctx(), task.id, 'start');
    return task;
  }

  const publish = (t: Team, taskId: string, executor: EmployeeProfile) =>
    h.tasks.attachArtifact(aiCtx(t, executor), taskId, {
      kind: 'document',
      title: 'Báo cáo',
      mimeType: 'text/markdown',
      storageKey: `${t.scene.companyId}/${randomUUID()}`,
      sizeBytes: 10,
      checksumSha256: 'a'.repeat(64),
    });

  /** Task `in_review` với một artifact do `dev` nộp. */
  async function inReview(t: Team): Promise<Task> {
    const task = await inProgress(t);
    await publish(t, task.id, t.dev);
    await h.tasks.transition(t.scene.ctx(), task.id, 'submit');
    return task;
  }

  const metAll = (criteria: string[]) =>
    criteria.map((criterionId) => ({
      criterionId,
      verdict: 'met' as const,
      explanation: 'Đáp ứng',
    }));

  describe('create (FR-014)', () => {
    it('tạo task draft với tiêu chí được cấp id c1.., người giao là người thật gọi hàm', async () => {
      const t = await team();
      const task = await create(t, t.dev.id, { tokenCap: 1000, costCap: 0.5 });
      expect(task).toMatchObject({
        status: 'draft',
        title: 'Phân tích yêu cầu',
        assigneeKind: 'ai_employee',
        assigneeId: t.dev.id,
        createdByMemberId: t.scene.ceo.memberId,
        priority: 'high',
        reworkCount: 0,
        isOverdue: false,
        blockedReason: null,
      });
      expect(task.acceptanceCriteria).toEqual([
        { id: 'c1', text: 'Nêu đủ yêu cầu' },
        { id: 'c2', text: 'Nêu rủi ro' },
      ]);
      expect((await h.tasks.get(ceoCtx(t), task.id)).id).toBe(task.id);
    });

    it('thiếu hoặc sai trường bắt buộc → TASK_FIELDS_REQUIRED', async () => {
      const t = await team();
      const bad: Array<Partial<TaskInput>> = [
        { acceptanceCriteria: [] },
        { objective: '  ' },
        { expectedOutput: '' },
        { deadline: 'mai' },
        { title: '' },
      ];
      for (const over of bad) {
        await expect(create(t, t.dev.id, over), JSON.stringify(over)).rejects.toMatchObject({
          code: 'TASK_FIELDS_REQUIRED',
        });
      }
    });

    it('tác nhân không phải người thật và không có createdByMemberId → TASK_FIELDS_REQUIRED', async () => {
      const t = await team();
      await expect(h.tasks.create(t.scene.ctx(), input(t.dev.id))).rejects.toMatchObject({
        code: 'TASK_FIELDS_REQUIRED',
      });
    });

    it('giao ngoài phạm vi quản lý của người giao → ASSIGNEE_OUT_OF_SCOPE', async () => {
      const t = await team();
      const manager = await h.addManager(t.scene);
      await h.org.assignManager(
        t.scene.ctx(),
        { kind: 'org_unit', id: t.scene.units.Development! },
        manager.memberId,
      );
      await expect(
        h.tasks.create(t.scene.humanCtx(manager.memberId), input(t.ba.id)),
      ).rejects.toMatchObject({ code: 'ASSIGNEE_OUT_OF_SCOPE' });
      const inside = await h.tasks.create(t.scene.humanCtx(manager.memberId), input(t.dev.id));
      expect(inside.createdByMemberId).toBe(manager.memberId);
    });

    it('phụ thuộc không tồn tại → NOT_FOUND; phụ thuộc hợp lệ được ghi nhận', async () => {
      const t = await team();
      await expect(create(t, t.dev.id, { dependsOn: [randomUUID()] })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      const first = await create(t, t.dev.id);
      const second = await create(t, t.ba.id, { dependsOn: [first.id] });
      expect((await h.tasks.get(ceoCtx(t), second.id)).dependsOn).toEqual([first.id]);
    });

    it('công ty khác không thấy task qua id (RLS)', async () => {
      const t = await team();
      const other = await h.newScene();
      const task = await create(t, t.dev.id);
      await expect(h.tasks.get(other.ctx(), task.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('transition (FR-020a, D1)', () => {
    it('đi đúng đường draft → assigned → in_progress → in_review', async () => {
      const t = await team();
      const task = await create(t, t.dev.id);
      expect((await h.tasks.transition(ceoCtx(t), task.id, 'assign')).status).toBe('assigned');
      expect((await h.tasks.transition(t.scene.ctx(), task.id, 'start')).status).toBe(
        'in_progress',
      );
      await publish(t, task.id, t.dev);
      expect((await h.tasks.transition(t.scene.ctx(), task.id, 'submit')).status).toBe('in_review');
    });

    it('cạnh không hợp lệ → TASK_INVALID_TRANSITION; hành động chỉ đi qua quyết định review cũng bị từ chối', async () => {
      const t = await team();
      const task = await create(t, t.dev.id);
      await expect(h.tasks.transition(ceoCtx(t), task.id, 'start')).rejects.toMatchObject({
        code: 'TASK_INVALID_TRANSITION',
      });
      await expect(h.tasks.transition(ceoCtx(t), task.id, 'submit')).rejects.toMatchObject({
        code: 'TASK_INVALID_TRANSITION',
      });
      await h.tasks.transition(ceoCtx(t), task.id, 'assign');
      await expect(h.tasks.transition(ceoCtx(t), task.id, 'approve')).rejects.toMatchObject({
        code: 'TASK_INVALID_TRANSITION',
      });
      await expect(h.tasks.transition(ceoCtx(t), task.id, 'pass')).rejects.toMatchObject({
        code: 'TASK_INVALID_TRANSITION',
      });
    });

    it('block bắt buộc blockedReason, lưu blocked_from; resume khôi phục trạng thái trước đó', async () => {
      const t = await team();
      const task = await inProgress(t);
      await expect(h.tasks.transition(t.scene.ctx(), task.id, 'block')).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
      const blocked = await h.tasks.transition(t.scene.ctx(), task.id, 'block', {
        blockedReason: 'CAN_NGUOI',
      });
      expect(blocked).toMatchObject({
        status: 'blocked',
        blockedFrom: 'in_progress',
        blockedReason: 'CAN_NGUOI',
      });
      const resumed = await h.tasks.transition(ceoCtx(t), task.id, 'resume');
      expect(resumed).toMatchObject({
        status: 'in_progress',
        blockedFrom: null,
        blockedReason: null,
      });
    });

    it('cancel từ trạng thái chưa kết thúc; task đã hủy hoặc hoàn tất không chuyển tiếp được', async () => {
      const t = await team();
      const task = await create(t, t.dev.id);
      expect((await h.tasks.transition(ceoCtx(t), task.id, 'cancel')).status).toBe('cancelled');
      await expect(h.tasks.transition(ceoCtx(t), task.id, 'cancel')).rejects.toMatchObject({
        code: 'TASK_INVALID_TRANSITION',
      });
      await expect(h.tasks.transition(ceoCtx(t), task.id, 'assign')).rejects.toMatchObject({
        code: 'TASK_INVALID_TRANSITION',
      });
    });

    it('resume khi assignee còn suspended → EMPLOYEE_SUSPENDED, bất kể blocked_reason', async () => {
      const t = await team();
      const task = await inProgress(t);
      await h.tasks.transition(t.scene.ctx(), task.id, 'block', { blockedReason: 'CAN_NGUOI' });
      await h.employees.suspend(t.scene.ctx(), t.dev.id);
      await expect(h.tasks.transition(ceoCtx(t), task.id, 'resume')).rejects.toMatchObject({
        code: 'EMPLOYEE_SUSPENDED',
      });
      await h.employees.resume(t.scene.ctx(), t.dev.id);
      expect((await h.tasks.transition(ceoCtx(t), task.id, 'resume')).status).toBe('in_progress');
    });

    it('resume khi blocked_reason = SUBTASK_CANCELLED → SUBTASK_CANCELLED', async () => {
      const t = await team();
      const task = await inProgress(t);
      await h.tasks.transition(t.scene.ctx(), task.id, 'block', {
        blockedReason: 'SUBTASK_CANCELLED',
      });
      await expect(h.tasks.transition(ceoCtx(t), task.id, 'resume')).rejects.toMatchObject({
        code: 'SUBTASK_CANCELLED',
      });
    });
  });

  describe('artifact và bằng chứng (Nguyên tắc VII)', () => {
    it('chỉ nộp artifact khi task đang in_progress; artifact ghi người tạo là AI Employee gọi', async () => {
      const t = await team();
      const task = await create(t, t.dev.id);
      await expect(publish(t, task.id, t.dev)).rejects.toMatchObject({
        code: 'TASK_INVALID_TRANSITION',
      });
      await h.tasks.transition(ceoCtx(t), task.id, 'assign');
      await h.tasks.transition(t.scene.ctx(), task.id, 'start');
      const artifact = await publish(t, task.id, t.dev);
      expect(artifact).toMatchObject({
        taskId: task.id,
        createdByEmployeeId: t.dev.id,
        kind: 'document',
      });
      expect((await h.tasks.get(ceoCtx(t), task.id)).artifacts.map((a) => a.id)).toEqual([
        artifact.id,
      ]);
    });

    it('readArtifact trả nội dung, cắt theo maxBytes và báo truncated', async () => {
      const t = await team();
      const task = await inProgress(t);
      const stored = await h.storage.put({
        companyId: t.scene.companyId,
        body: 'Xin chào thế giới',
      });
      const artifact = await h.tasks.attachArtifact(aiCtx(t, t.dev), task.id, {
        kind: 'document',
        title: 'Nội dung',
        mimeType: 'text/plain',
        storageKey: stored.key,
        sizeBytes: stored.sizeBytes,
        checksumSha256: stored.checksumSha256,
      });
      const full = await h.tasks.readArtifact(ceoCtx(t), artifact.id, 1_000);
      expect(full.content.toString()).toBe('Xin chào thế giới');
      expect(full.truncated).toBe(false);
      const cut = await h.tasks.readArtifact(ceoCtx(t), artifact.id, 3);
      expect(cut.content).toHaveLength(3);
      expect(cut.truncated).toBe(true);
      await expect(h.tasks.readArtifact(ceoCtx(t), randomUUID(), 10)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('recordEvidence: chỉ ghi khi đang review, đúng criterion; hệ thống không được ghi', async () => {
      const t = await team();
      const early = await inProgress(t);
      await expect(
        h.tasks.recordEvidence(aiCtx(t, t.manager), early.id, metAll(['c1'])),
      ).rejects.toMatchObject({ code: 'TASK_INVALID_TRANSITION' });

      const task = await inReview(t);
      await expect(
        h.tasks.recordEvidence(t.scene.ctx(), task.id, metAll(['c1'])),
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      await expect(
        h.tasks.recordEvidence(aiCtx(t, t.manager), task.id, metAll(['c99'])),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await h.tasks.recordEvidence(aiCtx(t, t.manager), task.id, metAll(['c1', 'c2']));
      const detail = await h.tasks.get(ceoCtx(t), task.id);
      expect(detail.evidence).toHaveLength(2);
      expect(
        detail.evidence.every((e) => e.reviewerKind === 'ai' && e.reviewerId === t.manager.id),
      ).toBe(true);
    });

    it('người tạo artifact không được review chính nó → REVIEWER_NOT_INDEPENDENT (bằng chứng và quyết định)', async () => {
      const t = await team();
      const task = await inReview(t);
      await expect(
        h.tasks.recordEvidence(aiCtx(t, t.dev), task.id, metAll(['c1', 'c2'])),
      ).rejects.toMatchObject({ code: 'REVIEWER_NOT_INDEPENDENT' });
      await expect(
        h.tasks.recordDecision(aiCtx(t, t.dev), task.id, { decision: 'pass', reason: 'Tự duyệt' }),
      ).rejects.toMatchObject({ code: 'REVIEWER_NOT_INDEPENDENT' });
    });
  });

  describe('recordDecision (FR-019, D1)', () => {
    it('pass thiếu bằng chứng → EVIDENCE_INCOMPLETE; đủ bằng chứng → awaiting_human_approval', async () => {
      const t = await team();
      const task = await inReview(t);
      await expect(
        h.tasks.recordDecision(aiCtx(t, t.manager), task.id, { decision: 'pass', reason: 'Ổn' }),
      ).rejects.toMatchObject({ code: 'EVIDENCE_INCOMPLETE' });
      await h.tasks.recordEvidence(aiCtx(t, t.manager), task.id, [
        { criterionId: 'c1', verdict: 'met', explanation: 'Đáp ứng' },
      ]);
      await expect(
        h.tasks.recordDecision(aiCtx(t, t.manager), task.id, { decision: 'pass', reason: 'Ổn' }),
      ).rejects.toMatchObject({ code: 'EVIDENCE_INCOMPLETE' });
      await h.tasks.recordEvidence(aiCtx(t, t.manager), task.id, [
        { criterionId: 'c2', verdict: 'met', explanation: 'Đáp ứng' },
      ]);
      const passed = await h.tasks.recordDecision(aiCtx(t, t.manager), task.id, {
        decision: 'pass',
        reason: 'Ổn',
      });
      expect(passed.status).toBe('awaiting_human_approval');
    });

    it('mọi quyết định bắt buộc lý do', async () => {
      const t = await team();
      const task = await inReview(t);
      await expect(
        h.tasks.recordDecision(aiCtx(t, t.manager), task.id, { decision: 'rework', reason: '  ' }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('loại quyết định phải khớp loại tác nhân: AI không approve, người thật không pass', async () => {
      const t = await team();
      const task = await inReview(t);
      await expect(
        h.tasks.recordDecision(aiCtx(t, t.manager), task.id, { decision: 'approve', reason: 'x' }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        h.tasks.recordDecision(ceoCtx(t), task.id, { decision: 'pass', reason: 'x' }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        h.tasks.recordDecision(t.scene.ctx(), task.id, { decision: 'pass', reason: 'x' }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('người thật chỉ quyết định khi task đang chờ duyệt', async () => {
      const t = await team();
      const task = await inReview(t);
      await expect(
        h.tasks.recordDecision(ceoCtx(t), task.id, { decision: 'approve', reason: 'x' }),
      ).rejects.toMatchObject({ code: 'TASK_INVALID_TRANSITION' });
    });

    async function awaitingApproval(t: Team): Promise<Task> {
      const task = await inReview(t);
      await h.tasks.recordEvidence(aiCtx(t, t.manager), task.id, metAll(['c1', 'c2']));
      await h.tasks.recordDecision(aiCtx(t, t.manager), task.id, {
        decision: 'pass',
        reason: 'Ổn',
      });
      return task;
    }

    it('approve → completed với completed_at, ghi review_record theo thứ tự', async () => {
      const t = await team();
      const task = await awaitingApproval(t);
      const done = await h.tasks.recordDecision(ceoCtx(t), task.id, {
        decision: 'approve',
        reason: 'Đạt',
      });
      expect(done.status).toBe('completed');
      expect(done.completedAt).not.toBeNull();
      const detail = await h.tasks.get(ceoCtx(t), task.id);
      expect(detail.reviews.map((r) => `${r.stage}/${r.decision}`)).toEqual([
        'ai_review/pass',
        'human_approval/approve',
      ]);
      expect(detail.reviews.every((r) => r.reason.length > 0)).toBe(true);
    });

    it('rework → in_progress và tăng rework_count; vòng mới cần bằng chứng mới', async () => {
      const t = await team();
      const task = await awaitingApproval(t);
      const reworked = await h.tasks.recordDecision(ceoCtx(t), task.id, {
        decision: 'rework',
        reason: 'Bổ sung',
      });
      expect(reworked).toMatchObject({ status: 'in_progress', reworkCount: 1 });
      await publish(t, task.id, t.dev);
      await h.tasks.transition(t.scene.ctx(), task.id, 'submit');
      // Bằng chứng của vòng trước không dùng lại được.
      await expect(
        h.tasks.recordDecision(aiCtx(t, t.manager), task.id, { decision: 'pass', reason: 'Ổn' }),
      ).rejects.toMatchObject({ code: 'EVIDENCE_INCOMPLETE' });
    });

    it('D1: reject → blocked/HUMAN_REJECTED, blocked_from = in_progress, tính một vòng rework', async () => {
      const t = await team();
      const task = await awaitingApproval(t);
      const rejected = await h.tasks.recordDecision(ceoCtx(t), task.id, {
        decision: 'reject',
        reason: 'Sai hướng',
      });
      expect(rejected).toMatchObject({
        status: 'blocked',
        blockedFrom: 'in_progress',
        blockedReason: 'HUMAN_REJECTED',
        reworkCount: 1,
      });
      await expect(
        h.tasks.recordDecision(ceoCtx(t), task.id, { decision: 'approve', reason: 'thử lại' }),
      ).rejects.toMatchObject({ code: 'TASK_INVALID_TRANSITION' });
    });

    it('rework đạt MAX_REWORK → blocked/MAX_REWORK_REACHED; resume đặt rework_baseline, tổng rework_count không giảm', async () => {
      const t = await team();
      const task = await inProgress(t);
      const max = h.config.MAX_REWORK;
      for (let round = 1; round <= max; round += 1) {
        await publish(t, task.id, t.dev);
        await h.tasks.transition(t.scene.ctx(), task.id, 'submit');
        await h.tasks.recordEvidence(aiCtx(t, t.manager), task.id, metAll(['c1', 'c2']));
        await h.tasks.recordDecision(aiCtx(t, t.manager), task.id, {
          decision: 'pass',
          reason: 'Ổn',
        });
        const after = await h.tasks.recordDecision(ceoCtx(t), task.id, {
          decision: 'rework',
          reason: `Vòng ${round}`,
        });
        if (round < max) expect(after).toMatchObject({ status: 'in_progress', reworkCount: round });
        else
          expect(after).toMatchObject({
            status: 'blocked',
            blockedReason: 'MAX_REWORK_REACHED',
            reworkCount: max,
          });
      }
      const resumed = await h.tasks.transition(ceoCtx(t), task.id, 'resume');
      expect(resumed).toMatchObject({ status: 'in_progress', reworkCount: max });
      const detail = await h.tasks.get(ceoCtx(t), task.id);
      expect(detail.reworkCount).toBe(max);
    });
  });

  describe('applyDecomposition (R10)', () => {
    const subtask = (assigneeId: string, over: Record<string, unknown> = {}) => ({
      title: 'Việc con',
      objective: 'Mục tiêu con',
      acceptanceCriteria: ['Xong'],
      expectedOutput: 'Kết quả',
      assigneeId,
      dependsOn: [] as number[],
      ...over,
    });

    async function assigned(t: Team, assigneeId = t.dev.id, over: Partial<TaskInput> = {}) {
      const task = await create(t, assigneeId, over);
      await h.tasks.transition(ceoCtx(t), task.id, 'assign');
      return task;
    }

    it('confirm với ai_employee không tạo task con', async () => {
      const t = await team();
      const task = await assigned(t);
      expect(
        await h.tasks.applyDecomposition(aiCtx(t, t.manager), task.id, {
          mode: 'confirm',
          subtasks: [],
        }),
      ).toEqual([]);
      expect((await h.tasks.get(ceoCtx(t), task.id)).subtasks).toHaveLength(0);
    });

    it('task giao đơn vị chỉ nhận confirm hoặc danh sách rỗng → NO_SUITABLE_ASSIGNEE', async () => {
      const t = await team();
      const task = await h.tasks.create(
        ceoCtx(t),
        input(t.dev.id, { assignee: { kind: 'org_unit', id: t.scene.units.Development! } }),
      );
      await h.tasks.transition(ceoCtx(t), task.id, 'assign');
      await expect(
        h.tasks.applyDecomposition(aiCtx(t, t.manager), task.id, { mode: 'confirm', subtasks: [] }),
      ).rejects.toMatchObject({ code: 'NO_SUITABLE_ASSIGNEE' });
      await expect(
        h.tasks.applyDecomposition(aiCtx(t, t.manager), task.id, {
          mode: 'decompose',
          subtasks: [],
        }),
      ).rejects.toMatchObject({ code: 'NO_SUITABLE_ASSIGNEE' });
    });

    it('decompose tạo task con kế thừa deadline, priority, người giao; task cha sang in_progress', async () => {
      const t = await team();
      const parent = await assigned(t, t.dev.id, {
        deadline: '2028-06-30T00:00:00Z',
        priority: 'urgent',
      });
      const children = await h.tasks.applyDecomposition(aiCtx(t, t.manager), parent.id, {
        mode: 'decompose',
        subtasks: [
          subtask(t.dev.id, { title: 'A' }),
          subtask(t.ba.id, { title: 'B', dependsOn: [0] }),
        ],
      });
      expect(children).toHaveLength(2);
      for (const child of children) {
        expect(child).toMatchObject({
          parentTaskId: parent.id,
          status: 'assigned',
          priority: 'urgent',
          createdByMemberId: t.scene.ceo.memberId,
          assignedByAiEmployeeId: t.manager.id,
        });
        expect(new Date(child.deadline).toISOString()).toBe('2028-06-30T00:00:00.000Z');
      }
      const detail = await h.tasks.get(ceoCtx(t), parent.id);
      expect(detail.status).toBe('in_progress');
      expect(detail.subtasks.map((s) => s.title).sort()).toEqual(['A', 'B']);
      const second = children.find((c) => c.title === 'B')!;
      expect((await h.tasks.get(ceoCtx(t), second.id)).dependsOn).toEqual([
        children.find((c) => c.title === 'A')!.id,
      ]);
    });

    it('phụ thuộc vòng → DEPENDENCY_CYCLE và không tạo task con nào', async () => {
      const t = await team();
      const parent = await assigned(t);
      await expect(
        h.tasks.applyDecomposition(aiCtx(t, t.manager), parent.id, {
          mode: 'decompose',
          subtasks: [subtask(t.dev.id, { dependsOn: [1] }), subtask(t.ba.id, { dependsOn: [0] })],
        }),
      ).rejects.toMatchObject({ code: 'DEPENDENCY_CYCLE' });
      expect((await h.tasks.get(ceoCtx(t), parent.id)).subtasks).toHaveLength(0);
    });

    it('nhân viên được giao việc con đã lưu trữ hoặc ngoài công ty → NO_SUITABLE_ASSIGNEE', async () => {
      const t = await team();
      const parent = await assigned(t);
      await expect(
        h.tasks.applyDecomposition(aiCtx(t, t.manager), parent.id, {
          mode: 'decompose',
          subtasks: [subtask(randomUUID())],
        }),
      ).rejects.toMatchObject({ code: 'NO_SUITABLE_ASSIGNEE' });
    });
  });

  describe('truy vấn', () => {
    it('markOverdue đặt is_overdue cho task quá hạn chưa kết thúc, bỏ qua task còn hạn, không lặp lại', async () => {
      const t = await team();
      const late = await create(t, t.dev.id, { deadline: '2020-01-01T00:00:00Z' });
      await h.tasks.transition(ceoCtx(t), late.id, 'assign');
      // Nháp chưa giao thì chưa tính quá hạn.
      const draft = await create(t, t.dev.id, { deadline: '2020-01-01T00:00:00Z' });
      const ontime = await create(t, t.dev.id);
      const cancelled = await create(t, t.ba.id, { deadline: '2020-01-01T00:00:00Z' });
      await h.tasks.transition(ceoCtx(t), cancelled.id, 'cancel');

      const marked = await h.tasks.markOverdue(t.scene.ctx(), new Date());
      expect(marked.map((x) => x.id)).toEqual([late.id]);
      expect((await h.tasks.get(ceoCtx(t), late.id)).isOverdue).toBe(true);
      expect((await h.tasks.get(ceoCtx(t), ontime.id)).isOverdue).toBe(false);
      expect((await h.tasks.get(ceoCtx(t), draft.id)).isOverdue).toBe(false);
      expect(await h.tasks.markOverdue(t.scene.ctx(), new Date())).toEqual([]);
    });

    it('list lọc theo trạng thái, assignee, priority, overdue, rootOnly và phân trang', async () => {
      const t = await team();
      const a = await create(t, t.dev.id, { priority: 'low' });
      const b = await create(t, t.dev.id, { priority: 'urgent', deadline: '2020-01-01T00:00:00Z' });
      const c = await create(t, t.ba.id, { priority: 'urgent' });
      await h.tasks.transition(ceoCtx(t), b.id, 'assign');
      await h.tasks.transition(ceoCtx(t), c.id, 'assign');
      await h.tasks.markOverdue(t.scene.ctx(), new Date());

      const ids = async (filter: Parameters<typeof h.tasks.list>[1]) =>
        (await h.tasks.list(ceoCtx(t), filter)).items.map((x) => x.id).sort();
      expect(await ids({})).toEqual([a.id, b.id, c.id].sort());
      expect(await ids({ statusIn: ['assigned'] })).toEqual([b.id, c.id].sort());
      expect(await ids({ assigneeKind: 'ai_employee', assigneeId: t.dev.id })).toEqual(
        [a.id, b.id].sort(),
      );
      expect(await ids({ priority: 'urgent' })).toEqual([b.id, c.id].sort());
      expect(await ids({ overdue: true })).toEqual([b.id]);
      expect(await ids({ rootOnly: true })).toEqual([a.id, b.id, c.id].sort());

      const page1 = await h.tasks.list(ceoCtx(t), { limit: 2 });
      expect(page1.items).toHaveLength(2);
      expect(page1.nextCursor).not.toBeNull();
      const page2 = await h.tasks.list(ceoCtx(t), { limit: 2, cursor: page1.nextCursor! });
      expect([...page1.items, ...page2.items].map((x) => x.id).sort()).toEqual(
        [a.id, b.id, c.id].sort(),
      );
    });

    it('list order = queue: priority giảm dần rồi deadline tăng dần', async () => {
      const t = await team();
      const low = await create(t, t.dev.id, { priority: 'low', deadline: '2027-01-01T00:00:00Z' });
      const lateUrgent = await create(t, t.dev.id, {
        priority: 'urgent',
        deadline: '2027-09-01T00:00:00Z',
      });
      const earlyUrgent = await create(t, t.dev.id, {
        priority: 'urgent',
        deadline: '2027-03-01T00:00:00Z',
      });
      const order = (await h.tasks.list(ceoCtx(t), { order: 'queue' })).items.map((x) => x.id);
      expect(order).toEqual([earlyUrgent.id, lateUrgent.id, low.id]);
    });

    it('getStats đếm task hoàn thành đúng hạn, tỉ lệ rework và task đang hoạt động', async () => {
      const t = await team();
      const done = await inReview(t);
      await h.tasks.recordEvidence(aiCtx(t, t.manager), done.id, metAll(['c1', 'c2']));
      await h.tasks.recordDecision(aiCtx(t, t.manager), done.id, {
        decision: 'pass',
        reason: 'Ổn',
      });
      await h.tasks.recordDecision(ceoCtx(t), done.id, { decision: 'approve', reason: 'Đạt' });
      await inProgress(t);

      const stats = await h.tasks.getStats(ceoCtx(t), { employeeId: t.dev.id });
      expect(stats).toMatchObject({
        completedTasks: 1,
        onTimeRate: 1,
        reworkRate: 0,
        activeTasks: 1,
      });
      const none = await h.tasks.getStats(ceoCtx(t), { employeeId: t.ba.id });
      expect(none).toMatchObject({ completedTasks: 0, activeTasks: 0 });
    });

    it('listCompaniesWithOpenTasks chỉ trả công ty có task chưa kết thúc', async () => {
      const t = await team();
      const empty = await h.newScene();
      const task = await create(t, t.dev.id);
      const companies = await h.tasks.listCompaniesWithOpenTasks();
      expect(companies).toContain(t.scene.companyId);
      expect(companies).not.toContain(empty.companyId);
      await h.tasks.transition(ceoCtx(t), task.id, 'cancel');
      expect(await h.tasks.listCompaniesWithOpenTasks()).not.toContain(t.scene.companyId);
    });
  });

  describe('sự kiện miền', () => {
    it('mỗi chuyển trạng thái ghi domain_event cùng transaction (phát ra sau khi relay)', async () => {
      const t = await team();
      const task = await create(t, t.dev.id);
      h.redis.published.length = 0;
      await h.tasks.transition(ceoCtx(t), task.id, 'assign');
      await h.relay.tick();
      const sent = h.redis.published.filter((m) => m.includes(task.id));
      expect(sent.length).toBeGreaterThan(0);
      expect(sent.some((m) => m.includes('assigned'))).toBe(true);
    });
  });
});
