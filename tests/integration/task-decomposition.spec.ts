import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DecompositionPlan, EmployeeProfile, Task } from '@claude-company/contracts';
import type { FakeInput } from '@claude-company/model-gateway';
import { eq } from 'drizzle-orm';
import { withTenant } from '@claude-company/db';
import { humanMember } from '@claude-company/db/schema/employee';
import { UsageBudgetService } from '../../apps/api/src/platform/usage-budget/budget.service';
import { prepareDatabase, seedDatabase, startInfra, type StartedInfra } from '../support/containers';
import {
  createFlowHarness,
  managerProfile,
  type FlowHarness,
  type Scene,
} from '../support/flow-harness';

/** Hook thay đổi được giữa các test; FakeModelProvider gọi chúng khi chạy decompose/review. */
const hooks: {
  decompose?: (input: FakeInput) => DecompositionPlan | undefined;
  review?: (input: FakeInput) => undefined;
} = {};

describe('Integration: phân rã task bởi AI Manager (US3-AS2, FR-016, FR-018)', () => {
  let infra: StartedInfra;
  let h: FlowHarness;
  let small: FlowHarness;

  beforeAll(async () => {
    infra = await startInfra({ redis: false });
    await prepareDatabase(infra);
    await seedDatabase(infra);
    const fake = {
      decompose: (input: FakeInput) => hooks.decompose?.(input),
      review: (input: FakeInput) => hooks.review?.(input),
    };
    h = await createFlowHarness({ infra, fake });
    // Trần ngữ cảnh nhỏ để kiểm tra nhãn "đã cắt" (ARTIFACT_CONTEXT_MAX_BYTES).
    small = await createFlowHarness({ infra, fake, env: { ARTIFACT_CONTEXT_MAX_BYTES: '40' } });
  });

  afterAll(async () => {
    hooks.decompose = undefined;
    hooks.review = undefined;
    await small?.close();
    await h?.close();
    await infra?.stop();
  });

  type Company = {
    scene: Scene;
    m1: EmployeeProfile;
    m2: EmployeeProfile;
    d1: EmployeeProfile;
    d2: EmployeeProfile;
  };

  /** Hai AI Manager (Development, BA) và hai Developer báo cáo cho m1. */
  async function company(harness = h, devMax = 2): Promise<Company> {
    const scene = await harness.newScene();
    const m1 = await harness.hire(scene, managerProfile(scene, { name: 'Manager Dev' }));
    const m2 = await harness.hire(
      scene,
      managerProfile(scene, { name: 'Manager BA', homeOrgUnitId: scene.units.BA! }),
    );
    const direct = { kind: 'ai' as const, id: m1.id };
    const d1 = await harness.hire(scene, { name: 'Dev 1', manager: direct, maxConcurrentTasks: devMax });
    const d2 = await harness.hire(scene, { name: 'Dev 2', manager: direct, maxConcurrentTasks: devMax });
    return { scene, m1, m2, d1, d2 };
  }

  const taskBody = (assignee: { kind: 'ai_employee' | 'team' | 'org_unit'; id: string }, over: Record<string, unknown> = {}) => ({
    title: 'Xây tính năng báo cáo',
    objective: 'Xây tính năng báo cáo doanh thu',
    assignee,
    deadline: '2027-09-01T00:00:00Z',
    priority: 'high' as const,
    acceptanceCriteria: ['Có API', 'Có kiểm thử'],
    expectedOutput: 'Mã nguồn và tài liệu',
    ...over,
  });

  async function give(c: Company, harness: FlowHarness, body: ReturnType<typeof taskBody>): Promise<Task> {
    const ctx = c.scene.humanCtx(c.scene.ceo.memberId);
    const created = await harness.tasks.create(ctx, body);
    await harness.tasks.transition(ctx, created.id, 'assign');
    return created;
  }

  const detail = (c: Company, id: string, harness = h) => harness.tasks.get(c.scene.ctx(), id);
  const approve = (c: Company, id: string) =>
    h.tasks.recordDecision(c.scene.humanCtx(c.scene.ceo.memberId), id, { decision: 'approve', reason: 'Đạt' });

  it('task giao Department: phân rã thành task con theo phụ thuộc, kế thừa deadline/priority/người giao, tổng hợp và review bởi AI Manager khác', async () => {
    const c = await company();
    let seen: FakeInput | undefined;
    hooks.decompose = (input) => {
      seen = input;
      return undefined; // dùng hành vi mặc định (chỉ thị trong objective)
    };
    const parent = await give(
      c,
      h,
      taskBody(
        { kind: 'org_unit', id: c.scene.units.Development! },
        { objective: 'Xây tính năng báo cáo [[fake:decompose=2;chain]]' },
      ),
    );
    await h.settle();

    // Job decompose nhận danh sách nhân viên trong phạm vi kèm kỹ năng và slot.
    expect(seen?.employees.map((e) => e.id).sort()).toEqual([c.d1.id, c.d2.id, c.m1.id, c.m2.id].sort());
    expect(seen?.employees.find((e) => e.id === c.d1.id)).toMatchObject({
      skills: ['typescript'],
      active: 0,
      max: 2,
    });

    let p = await detail(c, parent.id);
    expect(p.status).toBe('in_progress');
    expect(p.decompositionPlan?.mode).toBe('decompose');
    expect(p.decomposedByEmployeeId).toBe(c.m1.id); // AI Manager có home_org_unit_id là Development
    expect(p.subtasks).toHaveLength(2);
    const [first, second] = [...p.subtasks].sort((a, b) => a.title.localeCompare(b.title));
    for (const sub of [first!, second!]) {
      expect(sub).toMatchObject({
        parentTaskId: parent.id,
        deadline: p.deadline,
        priority: p.priority,
        createdByMemberId: p.createdByMemberId,
        assignedByAiEmployeeId: c.m1.id,
        assigneeKind: 'ai_employee',
      });
    }
    // Task con 1 chạy trước và đi đủ vòng đời tới Human Approval; task con 2 chờ phụ thuộc.
    expect((await detail(c, first!.id)).status).toBe('awaiting_human_approval');
    expect((await detail(c, second!.id)).status).toBe('assigned');
    expect((await detail(c, second!.id)).dependsOn).toEqual([first!.id]);

    await approve(c, first!.id);
    await h.settle();
    expect((await detail(c, second!.id)).status).toBe('awaiting_human_approval');
    expect((await detail(c, parent.id)).status).toBe('in_progress'); // chưa đủ task con completed

    await approve(c, second!.id);
    await h.settle();
    p = await detail(c, parent.id);
    expect(p.status).toBe('awaiting_human_approval');
    // Artifact tổng hợp do AI Manager đã phân rã tạo; review bởi AI Manager KHÁC (m2).
    expect(p.artifacts).toHaveLength(1);
    expect(p.artifacts[0]?.createdByEmployeeId).toBe(c.m1.id);
    expect(p.evidence.every((e) => e.reviewerId === c.m2.id)).toBe(true);
    // Task cha đi assigned → in_progress → in_review ở các run tương ứng.
    const runs = (await h.orchestration.listRuns(c.scene.ctx(), { taskId: parent.id })).items;
    expect(runs.map((r) => `${r.purpose}:${r.status}`).sort()).toEqual([
      'decompose:succeeded',
      'review:succeeded',
      'synthesize:succeeded',
    ]);

    const done = await approve(c, parent.id);
    expect(done.status).toBe('completed');
  });

  it('task con không chạy job decompose và task cha không có run execute', async () => {
    const c = await company();
    hooks.decompose = undefined;
    const parent = await give(
      c,
      h,
      taskBody(
        { kind: 'org_unit', id: c.scene.units.Development! },
        { objective: 'Việc lớn [[fake:decompose=2]]' },
      ),
    );
    await h.settle();
    const p = await detail(c, parent.id);
    const childRuns = (
      await Promise.all(p.subtasks.map((s) => h.orchestration.listRuns(c.scene.ctx(), { taskId: s.id })))
    ).flatMap((page) => page.items);
    expect(childRuns.some((r) => r.purpose === 'decompose')).toBe(false);
    const parentRuns = (await h.orchestration.listRuns(c.scene.ctx(), { taskId: parent.id })).items;
    expect(parentRuns.some((r) => r.purpose === 'execute')).toBe(false);
  });

  it('phụ thuộc vòng → blocked/DEPENDENCY_CYCLE kèm escalation, không tạo task con nào', async () => {
    const c = await company();
    hooks.decompose = (input) => {
      const a = input.employees.find((e) => e.id === c.d1.id)!;
      const b = input.employees.find((e) => e.id === c.d2.id)!;
      const sub = (assigneeId: string, dependsOn: number[]) => ({
        title: 'Việc',
        objective: 'x',
        acceptanceCriteria: ['ok'],
        expectedOutput: 'y',
        assigneeId,
        dependsOn,
      });
      return { mode: 'decompose', subtasks: [sub(a.id, [1]), sub(b.id, [0])] };
    };
    const parent = await give(c, h, taskBody({ kind: 'org_unit', id: c.scene.units.Development! }));
    await h.settle();
    const p = await detail(c, parent.id);
    expect(p).toMatchObject({ status: 'blocked', blockedReason: 'DEPENDENCY_CYCLE', blockedFrom: 'assigned' });
    expect(p.subtasks).toHaveLength(0);
    const notices = await h.communication.listNotifications(c.scene.humanCtx(c.scene.ceo.memberId), c.scene.ceo.memberId, {});
    expect(notices.items.some((n) => n.type === 'escalation' && n.taskId === parent.id)).toBe(true);
    hooks.decompose = undefined;
  });

  it('kế hoạch giao người ngoài phạm vi/không tồn tại, hoặc confirm/rỗng cho đơn vị → blocked/NO_SUITABLE_ASSIGNEE', async () => {
    const c = await company();
    // (a) giao đơn vị nhưng AI Manager chỉ confirm.
    hooks.decompose = () => ({ mode: 'confirm', subtasks: [] });
    const unit = await give(c, h, taskBody({ kind: 'org_unit', id: c.scene.units.Development! }));
    // (b) decompose nhưng assignee không tồn tại.
    hooks.decompose = () => ({
      mode: 'decompose',
      subtasks: [
        {
          title: 'Việc',
          objective: 'x',
          acceptanceCriteria: ['ok'],
          expectedOutput: 'y',
          assigneeId: '00000000-0000-7000-8000-000000000000',
          dependsOn: [],
        },
      ],
    });
    const ghost = await give(c, h, taskBody({ kind: 'org_unit', id: c.scene.units.Development! }, { title: 'Ma' }));
    // (c) decompose với danh sách task con rỗng.
    hooks.decompose = () => ({ mode: 'decompose', subtasks: [] });
    const empty = await give(c, h, taskBody({ kind: 'org_unit', id: c.scene.units.Development! }, { title: 'Rỗng' }));
    await h.settle();
    for (const t of [unit, ghost, empty]) {
      expect(await detail(c, t.id)).toMatchObject({ status: 'blocked', blockedReason: 'NO_SUITABLE_ASSIGNEE' });
    }
    hooks.decompose = undefined;
  });

  it('đơn vị không có AI Manager → blocked/NO_AI_MANAGER', async () => {
    const c = await company();
    const qa = await give(c, h, taskBody({ kind: 'org_unit', id: c.scene.units.QA! }));
    await h.settle();
    expect(await detail(c, qa.id)).toMatchObject({ status: 'blocked', blockedReason: 'NO_AI_MANAGER' });
  });

  it('task giao Team không có AI Manager trong team thì lấy AI Manager của department chứa Team', async () => {
    const c = await company();
    const team = await h.org.upsertTeam(c.scene.ctx(), { orgUnitId: c.scene.units.Development!, name: 'Team Mobile' });
    await h.org.setTeamMembers(c.scene.ctx(), team.id, [{ kind: 'ai', id: c.d1.id }]);
    hooks.decompose = undefined;
    const t = await give(
      c,
      h,
      taskBody({ kind: 'team', id: team.id }, { objective: 'Việc team [[fake:decompose=1]]' }),
    );
    await h.settle();
    const p = await detail(c, t.id);
    expect(p.decomposedByEmployeeId).toBe(c.m1.id);
    expect(p.subtasks).toHaveLength(1);
  });

  it('task giao Team chưa có AI Manager nào → tự tạo AI Manager cho team (CEO là manager trực tiếp) rồi phân rã', async () => {
    const scene = await h.newScene();
    const dev = await h.hire(scene, { name: 'Dev Solo', homeOrgUnitId: scene.units.Development! });
    const team = await h.org.upsertTeam(scene.ctx(), { orgUnitId: scene.units.Development!, name: 'Team Web' });
    await h.org.setTeamMembers(scene.ctx(), team.id, [{ kind: 'ai', id: dev.id }]);
    hooks.decompose = undefined;
    const c = { scene } as Company;
    const t = await give(c, h, taskBody({ kind: 'team', id: team.id }, { objective: 'Việc team [[fake:decompose=1]]' }));
    await h.settle();

    const p = await detail(c, t.id);
    expect(p.status).not.toBe('blocked');
    const manager = await h.employees.get(scene.ctx(), p.decomposedByEmployeeId!);
    expect(manager).toMatchObject({
      kind: 'manager',
      runtimeKind: 'messages_api',
      name: 'AI Manager Team Web',
      homeOrgUnitId: scene.units.Development!,
      manager: { kind: 'human', id: scene.ceo.memberId },
    });
    expect(manager.teamIds).toContain(team.id);

    // Task thứ hai dùng lại chính AI Manager đó, không tạo thêm.
    const t2 = await give(c, h, taskBody({ kind: 'team', id: team.id }, { objective: 'Việc 2 [[fake:decompose=1]]' }));
    await h.settle();
    expect((await detail(c, t2.id)).decomposedByEmployeeId).toBe(manager.id);
    const managers = await h.employees.list(scene.ctx(), { kind: 'manager' });
    expect(managers).toHaveLength(1);
  });

  /** Công ty có Team Web với một Developer, chưa có AI Manager nào. */
  async function teamWithoutManager() {
    const scene = await h.newScene();
    const dev = await h.hire(scene, { name: 'Dev Solo', homeOrgUnitId: scene.units.Development! });
    const team = await h.org.upsertTeam(scene.ctx(), { orgUnitId: scene.units.Development!, name: 'Team Web' });
    await h.org.setTeamMembers(scene.ctx(), team.id, [{ kind: 'ai', id: dev.id }]);
    hooks.decompose = undefined;
    return { scene, dev, team, c: { scene } as Company };
  }
  const managersOf = (scene: Scene) => h.employees.list(scene.ctx(), { kind: 'manager' });
  const blockedNotices = async (scene: Scene) =>
    (await h.communication.listNotifications(scene.humanCtx(scene.ceo.memberId), scene.ceo.memberId, {})).items;

  it('manager trực tiếp của AI Manager tự tạo là người quản lý Team khi Team có', async () => {
    const { scene, team, c } = await teamWithoutManager();
    const mgr = await h.addManager(scene);
    await h.org.assignManager(scene.ctx(), { kind: 'team', id: team.id }, mgr.memberId);
    const t = await give(c, h, taskBody({ kind: 'team', id: team.id }, { objective: 'Việc team [[fake:decompose=1]]' }));
    await h.settle();

    const created = await h.employees.get(scene.ctx(), (await detail(c, t.id)).decomposedByEmployeeId!);
    expect(created.manager).toEqual({ kind: 'human', id: mgr.memberId });
  });

  it('công ty không còn người thật hợp lệ → không tạo được AI Manager: task blocked/NO_AI_MANAGER (không có ai nhận thông báo)', async () => {
    const { scene, team, c } = await teamWithoutManager();
    const t = await give(c, h, taskBody({ kind: 'team', id: team.id }));
    await withTenant(scene.companyId, (tx) =>
      tx.update(humanMember).set({ disabledAt: new Date() }).where(eq(humanMember.id, scene.ceo.memberId)),
    );
    await h.settle();

    expect(await detail(c, t.id)).toMatchObject({ status: 'blocked', blockedReason: 'NO_AI_MANAGER' });
    expect(await managersOf(scene)).toHaveLength(0);
    // Không còn CEO đang hoạt động nên bộ định tuyến thông báo cũng không có người nhận (chỉ ghi log lỗi).
    await withTenant(scene.companyId, (tx) =>
      tx.update(humanMember).set({ disabledAt: null }).where(eq(humanMember.id, scene.ceo.memberId)),
    );
    expect((await blockedNotices(scene)).filter((n) => n.type === 'escalation')).toHaveLength(0);
  });

  it('allowed_models chặn model của mẫu ai_manager → task blocked/NO_AI_MANAGER kèm escalation, không có AI Manager', async () => {
    const { scene, team, c } = await teamWithoutManager();
    await h.app.get(UsageBudgetService, { strict: false }).upsertPolicy(scene.ctx(), 'org_unit', scene.units.Development!, { allowedModels: ['claude-haiku-5-5'] });
    const t = await give(c, h, taskBody({ kind: 'team', id: team.id }));
    await h.settle();

    expect(await detail(c, t.id)).toMatchObject({ status: 'blocked', blockedReason: 'NO_AI_MANAGER' });
    expect(await managersOf(scene)).toHaveLength(0);
    expect((await blockedNotices(scene)).map((n) => n.type)).toContain('escalation');
  });

  it('task giao trực tiếp cho AI Employee không tự tạo AI Manager; không có AI Manager thì vẫn blocked/NO_AI_MANAGER', async () => {
    const { scene, dev, c } = await teamWithoutManager();
    const t = await give(c, h, taskBody({ kind: 'ai_employee', id: dev.id }));
    await h.settle();

    expect(await detail(c, t.id)).toMatchObject({ status: 'blocked', blockedReason: 'NO_AI_MANAGER' });
    expect(await managersOf(scene)).toHaveLength(0);
  });

  it('bước chọn reviewer (D5) không tự tạo AI Manager: thiếu reviewer độc lập vẫn blocked/NO_INDEPENDENT_REVIEWER', async () => {
    const scene = await h.newScene();
    const m1 = await h.hire(scene, managerProfile(scene));
    const dev = await h.hire(scene, { manager: { kind: 'ai', id: m1.id } });
    const c: Company = { scene, m1, m2: m1, d1: dev, d2: dev };
    hooks.decompose = undefined;
    const parent = await give(
      c,
      h,
      taskBody({ kind: 'org_unit', id: scene.units.Development! }, { objective: 'Việc [[fake:decompose=1]]' }),
    );
    await h.settle();
    await approve(c, (await detail(c, parent.id)).subtasks[0]!.id);
    await h.settle();

    expect(await detail(c, parent.id)).toMatchObject({ status: 'blocked', blockedReason: 'NO_INDEPENDENT_REVIEWER' });
    expect(await managersOf(scene)).toHaveLength(1); // vẫn chỉ có m1
  });

  it('AI Manager đã thuộc nhiều Team: giao việc cho Team thứ hai dùng lại đúng AI Manager, không tạo mới', async () => {
    const c = await company();
    const teamA = await h.org.upsertTeam(c.scene.ctx(), { orgUnitId: c.scene.units.Development!, name: 'Team A' });
    const teamB = await h.org.upsertTeam(c.scene.ctx(), { orgUnitId: c.scene.units.Development!, name: 'Team B' });
    await h.org.setTeamMembers(c.scene.ctx(), teamA.id, [{ kind: 'ai', id: c.m1.id }, { kind: 'ai', id: c.d1.id }]);
    await h.org.setTeamMembers(c.scene.ctx(), teamB.id, [{ kind: 'ai', id: c.m1.id }, { kind: 'ai', id: c.d2.id }]);
    hooks.decompose = undefined;
    const before = (await managersOf(c.scene)).length;

    const t = await give(c, h, taskBody({ kind: 'team', id: teamB.id }, { objective: 'Việc team B [[fake:decompose=1]]' }));
    await h.settle();

    expect((await detail(c, t.id)).decomposedByEmployeeId).toBe(c.m1.id);
    expect(await managersOf(c.scene)).toHaveLength(before);
  });

  it('AI Manager được giao trực tiếp tự đảm nhiệm bước xác nhận; nhiều AI Manager cùng bậc chọn id nhỏ nhất', async () => {
    const c = await company();
    const t = await give(c, h, taskBody({ kind: 'ai_employee', id: c.m2.id }));
    await h.settle();
    const p = await detail(c, t.id);
    expect(p.decomposedByEmployeeId).toBe(c.m2.id);

    // Task giao Department BA: chỉ có m2 ở BA. Task giao AI Employee ở Development: manager trực tiếp là m1.
    const direct = await give(c, h, taskBody({ kind: 'ai_employee', id: c.d1.id }, { title: 'Trực tiếp' }));
    await h.settle();
    expect((await detail(c, direct.id)).decomposedByEmployeeId).toBe(c.m1.id);
  });

  it('nhân viên hết slot thì kế hoạch vẫn áp dụng và task con xếp hàng', async () => {
    const c = await company(h, 1);
    hooks.decompose = (input) => ({
      mode: 'decompose',
      subtasks: [1, 2].map((n) => ({
        title: `Việc ${n}`,
        objective: 'x',
        acceptanceCriteria: ['ok'],
        expectedOutput: 'y',
        assigneeId: input.employees.find((e) => e.id === c.d1.id)!.id,
        dependsOn: [],
      })),
    });
    const parent = await give(c, h, taskBody({ kind: 'org_unit', id: c.scene.units.Development! }));
    await h.settleExcept(['run.start']);
    const p = await detail(c, parent.id);
    expect(p.subtasks.map((s) => s.status).sort()).toEqual(['assigned', 'in_progress']);
    hooks.decompose = undefined;
    await h.settle();
    const after = await detail(c, parent.id);
    expect(after.subtasks.every((s) => s.status === 'awaiting_human_approval')).toBe(true);
  });

  it('hủy task cha hủy task con và run của chúng; task con bị hủy → task cha blocked/SUBTASK_CANCELLED, resume bị từ chối', async () => {
    const c = await company();
    hooks.decompose = undefined;
    const ctx = c.scene.humanCtx(c.scene.ceo.memberId);
    const mk = async () => {
      const parent = await give(
        c,
        h,
        taskBody({ kind: 'org_unit', id: c.scene.units.Development! }, { objective: 'Việc lớn [[fake:decompose=2]]' }),
      );
      await h.settleExcept(['run.start']);
      return parent;
    };

    // (1) hủy task cha
    const parent = await mk();
    const children = (await detail(c, parent.id)).subtasks;
    await h.tasks.transition(ctx, parent.id, 'cancel');
    await h.settle();
    expect((await detail(c, parent.id)).status).toBe('cancelled');
    for (const child of children) {
      expect((await detail(c, child.id)).status).toBe('cancelled');
      const runs = (await h.orchestration.listRuns(c.scene.ctx(), { taskId: child.id })).items;
      expect(runs.every((r) => r.status === 'cancelled' || r.status === 'succeeded')).toBe(true);
    }

    // (2) hủy một task con
    const parent2 = await mk();
    const [firstChild] = (await detail(c, parent2.id)).subtasks;
    await h.tasks.transition(ctx, firstChild!.id, 'cancel');
    await h.settle();
    expect(await detail(c, parent2.id)).toMatchObject({ status: 'blocked', blockedReason: 'SUBTASK_CANCELLED' });
    await expect(h.tasks.transition(ctx, parent2.id, 'resume')).rejects.toMatchObject({
      code: 'SUBTASK_CANCELLED',
    });
    await h.tasks.transition(ctx, parent2.id, 'cancel'); // chỉ cancel được
    expect((await detail(c, parent2.id)).status).toBe('cancelled');
  });

  it('không có AI Manager độc lập để review artifact tổng hợp → task cha blocked/NO_INDEPENDENT_REVIEWER', async () => {
    const scene = await h.newScene();
    const m1 = await h.hire(scene, managerProfile(scene));
    const dev = await h.hire(scene, { manager: { kind: 'ai', id: m1.id } });
    const c: Company = { scene, m1, m2: m1, d1: dev, d2: dev };
    hooks.decompose = undefined;
    const parent = await give(
      c,
      h,
      taskBody({ kind: 'org_unit', id: scene.units.Development! }, { objective: 'Việc [[fake:decompose=1]]' }),
    );
    await h.settle();
    const child = (await detail(c, parent.id)).subtasks[0]!;
    // Task con: reviewer phải khác dev → m1 hợp lệ. Sau khi duyệt, tổng hợp do m1 và không còn AI Manager nào khác.
    await approve(c, child.id);
    await h.settle();
    expect(await detail(c, parent.id)).toMatchObject({
      status: 'blocked',
      blockedReason: 'NO_INDEPENDENT_REVIEWER',
    });
  });

  it('job review nhận nội dung artifact trong trần ARTIFACT_CONTEXT_MAX_BYTES và có nhãn đã cắt khi vượt trần', async () => {
    const c = await company(small);
    let seen: FakeInput | undefined;
    hooks.review = (input) => {
      seen = input;
      return undefined;
    };
    await give(c, small, taskBody({ kind: 'ai_employee', id: c.d1.id }));
    await small.settle();
    expect(seen?.artifacts).toHaveLength(1);
    expect(seen?.artifacts[0]?.truncated).toBe(true);
    expect(Buffer.byteLength(seen?.artifacts[0]?.content ?? '')).toBeLessThanOrEqual(40);
    hooks.review = undefined;
  });
});
