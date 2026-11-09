import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EmployeeProfile, Task } from '@claude-company/contracts';
import { withTenant } from '@claude-company/db';
import { task as taskTable } from '@claude-company/db/schema/task';
import { eq } from 'drizzle-orm';
import { prepareDatabase, seedDatabase, startInfra, type StartedInfra } from '../support/containers';
import {
  createFlowHarness,
  managerProfile,
  type FlowHarness,
  type Scene,
} from '../support/flow-harness';

describe('Integration: rework, reject và quá hạn (US3-AS3, D1, FR-019, FR-020)', () => {
  let infra: StartedInfra;
  let h: FlowHarness;

  beforeAll(async () => {
    infra = await startInfra({ redis: false });
    await prepareDatabase(infra);
    await seedDatabase(infra);
    h = await createFlowHarness({ infra }); // MAX_REWORK mặc định = 3
  });

  afterAll(async () => {
    await h?.close();
    await infra?.stop();
  });

  type Team = { scene: Scene; m1: EmployeeProfile; m2: EmployeeProfile; dev: EmployeeProfile };

  async function team(): Promise<Team> {
    const scene = await h.newScene();
    const m1 = await h.hire(scene, managerProfile(scene, { name: 'Manager 1' }));
    const m2 = await h.hire(scene, managerProfile(scene, { name: 'Manager 2', homeOrgUnitId: scene.units.BA! }));
    const dev = await h.hire(scene, { manager: { kind: 'ai', id: m1.id } });
    return { scene, m1, m2, dev };
  }

  const body = (assigneeId: string, objective: string, over: Record<string, unknown> = {}) => ({
    title: 'Việc cần làm lại',
    objective,
    assignee: { kind: 'ai_employee' as const, id: assigneeId },
    deadline: '2027-12-31T00:00:00Z',
    priority: 'medium' as const,
    acceptanceCriteria: ['Đáp ứng yêu cầu A', 'Đáp ứng yêu cầu B'],
    expectedOutput: 'Báo cáo',
    ...over,
  });

  async function give(t: Team, objective: string, over: Record<string, unknown> = {}): Promise<Task> {
    const ctx = t.scene.humanCtx(t.scene.ceo.memberId);
    const created = await h.tasks.create(ctx, body(t.dev.id, objective, over));
    await h.tasks.transition(ctx, created.id, 'assign');
    return created;
  }

  const detail = (t: Team, id: string) => h.tasks.get(t.scene.ctx(), id);
  const notices = async (t: Team) =>
    (await h.communication.listNotifications(t.scene.humanCtx(t.scene.ceo.memberId), t.scene.ceo.memberId, {}))
      .items;

  it('AI review rework một vòng: ghi nhận rework_count, run execute mới nhận lý do, rồi pass', async () => {
    const t = await team();
    const created = await give(t, 'Làm báo cáo [[fake:review=rework_once]]');
    await h.settle();
    const d = await detail(t, created.id);
    expect(d.status).toBe('awaiting_human_approval');
    expect(d.reworkCount).toBe(1);
    expect(d.reviews.map((r) => `${r.stage}/${r.decision}`)).toEqual(['ai_review/rework', 'ai_review/pass']);
    const runs = (await h.orchestration.listRuns(t.scene.ctx(), { taskId: created.id })).items;
    expect(runs.filter((r) => r.purpose === 'execute')).toHaveLength(2);
    expect(runs.filter((r) => r.purpose === 'review')).toHaveLength(2);
    // Run làm lại nhận lý do review (fake đưa vào nội dung artifact vòng mới).
    const newest = d.artifacts[d.artifacts.length - 1]!;
    const text = (await h.tasks.readArtifact(t.scene.ctx(), newest.id, 5000)).content.toString();
    expect(text).toContain('Kết quả chưa đáp ứng tiêu chí, cần làm lại');
  });

  it('đạt 3 vòng rework → blocked/MAX_REWORK_REACHED + escalation; resume đặt rework_baseline và vòng kế tiếp không escalate ngay', async () => {
    const t = await team();
    const created = await give(t, 'Làm báo cáo [[fake:review=rework_always]]');
    await h.settle();
    let d = await detail(t, created.id);
    expect(d).toMatchObject({
      status: 'blocked',
      blockedFrom: 'in_progress',
      blockedReason: 'MAX_REWORK_REACHED',
      reworkCount: 3,
      reworkBaseline: 0,
    });
    expect((await notices(t)).some((n) => n.type === 'escalation' && n.taskId === created.id)).toBe(true);
    const executeRuns = async () =>
      (await h.orchestration.listRuns(t.scene.ctx(), { taskId: created.id })).items.filter(
        (r) => r.purpose === 'execute',
      ).length;
    expect(await executeRuns()).toBe(3);

    const ctx = t.scene.humanCtx(t.scene.ceo.memberId);
    await h.tasks.transition(ctx, created.id, 'resume');
    // Ngay sau resume: mốc được đặt, tổng không giảm, task đang chạy lại (chưa escalate).
    d = await detail(t, created.id);
    expect(d).toMatchObject({ status: 'in_progress', reworkCount: 3, reworkBaseline: 3, blockedReason: null });

    // Fake luôn yêu cầu làm lại nên sau 3 vòng nữa (tính từ mốc mới) mới escalate lần hai.
    await h.settle();
    d = await detail(t, created.id);
    expect(d).toMatchObject({ status: 'blocked', blockedReason: 'MAX_REWORK_REACHED', reworkCount: 6, reworkBaseline: 3 });
    expect(await executeRuns()).toBe(6);
  });

  it('reject chạm giới hạn giữ HUMAN_REJECTED, không gửi escalation; resume đặt rework_baseline', async () => {
    const t = await team();
    const created = await give(t, 'Làm báo cáo');
    await h.settle();
    // Đã làm lại 2 vòng (hạn 3); lần reject này là vòng thứ 3.
    await withTenant(t.scene.companyId, (tx) =>
      tx.update(taskTable).set({ reworkCount: 2 }).where(eq(taskTable.id, created.id)),
    );
    // Cần bằng chứng vòng 2 để phản ánh trạng thái chờ duyệt hợp lệ; reject không đòi bằng chứng.
    const ctx = t.scene.humanCtx(t.scene.ceo.memberId);
    const before = (await notices(t)).filter((n) => n.type === 'escalation').length;
    const rejected = await h.tasks.recordDecision(ctx, created.id, { decision: 'reject', reason: 'Không đạt' });
    expect(rejected).toMatchObject({ status: 'blocked', blockedReason: 'HUMAN_REJECTED', reworkCount: 3 });
    await h.settle();
    expect((await notices(t)).filter((n) => n.type === 'escalation')).toHaveLength(before);

    const resumed = await h.tasks.transition(ctx, created.id, 'resume');
    expect(resumed).toMatchObject({ reworkCount: 3, reworkBaseline: 3 });
  });

  it('rework của người thật quay về in_progress và tính một vòng', async () => {
    const t = await team();
    const created = await give(t, 'Làm báo cáo');
    await h.settle();
    const ctx = t.scene.humanCtx(t.scene.ceo.memberId);
    const reworked = await h.tasks.recordDecision(ctx, created.id, {
      decision: 'rework',
      reason: 'Bổ sung số liệu quý 3',
    });
    expect(reworked).toMatchObject({ status: 'in_progress', reworkCount: 1 });
    await h.settle();
    const d = await detail(t, created.id);
    expect(d.status).toBe('awaiting_human_approval');
    expect(d.reviews.map((r) => `${r.stage}/${r.decision}`)).toEqual([
      'ai_review/pass',
      'human_approval/rework',
      'ai_review/pass',
    ]);
    const newest = d.artifacts[d.artifacts.length - 1]!;
    const text = (await h.tasks.readArtifact(t.scene.ctx(), newest.id, 5000)).content.toString();
    expect(text).toContain('Bổ sung số liệu quý 3');
  });

  it('is_overdue: task quá hạn được đặt cờ một lần và người giao nhận task_overdue; task nháp/đã xong không bị đánh dấu', async () => {
    const t = await team();
    const ctx = t.scene.humanCtx(t.scene.ceo.memberId);
    const overdue = await h.tasks.create(ctx, body(t.dev.id, 'Quá hạn', { deadline: '2026-01-01T00:00:00Z' }));
    await h.tasks.transition(ctx, overdue.id, 'assign');
    const draft = await h.tasks.create(ctx, body(t.dev.id, 'Nháp', { deadline: '2026-01-01T00:00:00Z' }));
    const future = await h.tasks.create(ctx, body(t.dev.id, 'Còn hạn'));
    await h.tasks.transition(ctx, future.id, 'assign');
    await h.settleExcept(['run.start']);

    const first = await h.tasks.markOverdue(t.scene.ctx(), new Date('2026-11-09T00:00:00Z'));
    expect(first.map((x) => x.id)).toEqual([overdue.id]);
    expect((await detail(t, overdue.id)).isOverdue).toBe(true);
    expect((await detail(t, draft.id)).isOverdue).toBe(false);
    expect((await detail(t, future.id)).isOverdue).toBe(false);
    // Lần quét sau không đánh dấu lại.
    expect(await h.tasks.markOverdue(t.scene.ctx(), new Date('2026-11-10T00:00:00Z'))).toEqual([]);
    await h.settleExcept(['run.start']);
    expect((await notices(t)).filter((n) => n.type === 'task_overdue' && n.taskId === overdue.id)).toHaveLength(1);
    // Sweeper dùng danh sách công ty có task mở.
    expect(await h.tasks.listCompaniesWithOpenTasks()).toContain(t.scene.companyId);
  });

  it('rework hoặc reject ở task cha chạy lại synthesize kèm lý do, không mở lại task con', async () => {
    const t = await team();
    const ctx = t.scene.humanCtx(t.scene.ceo.memberId);
    const parent = await h.tasks.create(
      ctx,
      body(t.dev.id, 'Việc lớn [[fake:decompose=2]]', {
        assignee: { kind: 'org_unit', id: t.scene.units.Development! },
      }),
    );
    await h.tasks.transition(ctx, parent.id, 'assign');
    await h.settle();
    const children = (await detail(t, parent.id)).subtasks;
    for (const child of children) await h.tasks.recordDecision(ctx, child.id, { decision: 'approve', reason: 'Đạt' });
    await h.settle();
    expect((await detail(t, parent.id)).status).toBe('awaiting_human_approval');

    // rework ở task cha
    await h.tasks.recordDecision(ctx, parent.id, { decision: 'rework', reason: 'Thiếu phần kết luận' });
    await h.settle();
    let p = await detail(t, parent.id);
    expect(p.status).toBe('awaiting_human_approval');
    const synth = () =>
      h.orchestration
        .listRuns(t.scene.ctx(), { taskId: parent.id })
        .then((r) => r.items.filter((x) => x.purpose === 'synthesize'));
    expect(await synth()).toHaveLength(2);
    const newest = p.artifacts[p.artifacts.length - 1]!;
    expect((await h.tasks.readArtifact(t.scene.ctx(), newest.id, 5000)).content.toString()).toContain(
      'Thiếu phần kết luận',
    );

    // reject rồi resume
    await h.tasks.recordDecision(ctx, parent.id, { decision: 'reject', reason: 'Sai trọng tâm' });
    await h.tasks.transition(ctx, parent.id, 'resume');
    await h.settle();
    p = await detail(t, parent.id);
    expect(p.status).toBe('awaiting_human_approval');
    expect(await synth()).toHaveLength(3);
    // Task con đã completed không bị mở lại.
    for (const child of children) expect((await detail(t, child.id)).status).toBe('completed');
  });
});
