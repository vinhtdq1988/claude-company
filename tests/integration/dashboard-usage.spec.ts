import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EmployeeProfile, RequestContext } from '@claude-company/contracts';
import { newId, withTenant } from '@claude-company/db';
import { budgetWarningLog } from '@claude-company/db/schema/usage';
import { UsageBudgetService } from '../../apps/api/src/platform/usage-budget/budget.service';
import { DashboardService } from '../../apps/api/src/platform/usage-budget/dashboard.service';
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
 * Dashboard, usage và giới hạn đồng thời trên engine thật (T166; SC-008, FR-040, US6-AS3/AS4, FR-041):
 * số liệu Dashboard khớp từng task và Employee Profile, cảnh báo một lần, `max_concurrent_tasks` theo scope.
 */
describe('Integration: Dashboard, usage và giới hạn đồng thời (T166)', () => {
  let infra: StartedInfra;
  let h: FlowHarness;
  let budget: UsageBudgetService;
  let dashboard: DashboardService;

  beforeAll(async () => {
    infra = await startInfra({ redis: false });
    await prepareDatabase(infra);
    await seedDatabase(infra);
    h = await createFlowHarness({ infra });
    budget = h.app.get(UsageBudgetService, { strict: false });
    dashboard = h.app.get(DashboardService, { strict: false });
  });

  afterAll(async () => {
    await h?.close();
    await infra?.stop();
  });

  type Team = {
    scene: Scene;
    ceo: RequestContext;
    manager: EmployeeProfile;
    devA: EmployeeProfile;
    devB: EmployeeProfile;
    ba: EmployeeProfile;
  };

  /** Công ty mới: AI Manager, hai Developer (Development) và một BA (BA). */
  async function team(devMax = 2): Promise<Team> {
    const scene = await h.newScene();
    const manager = await h.hire(scene, managerProfile(scene));
    const direct = { kind: 'ai' as const, id: manager.id };
    const devA = await h.hire(scene, {
      name: 'Dev A',
      manager: direct,
      maxConcurrentTasks: devMax,
    });
    const devB = await h.hire(scene, {
      name: 'Dev B',
      manager: direct,
      maxConcurrentTasks: devMax,
    });
    const ba = await h.hire(scene, {
      name: 'AI BA',
      homeOrgUnitId: scene.units.BA!,
      runtimeKind: 'messages_api',
      manager: direct,
    });
    return { scene, ceo: scene.humanCtx(scene.ceo.memberId), manager, devA, devB, ba };
  }

  async function assignTask(
    t: Team,
    assigneeId: string,
    title: string,
    priority: 'low' | 'high' = 'high',
  ) {
    const created = await h.tasks.create(t.ceo, {
      title,
      objective: 'Viết báo cáo ngắn',
      assignee: { kind: 'ai_employee', id: assigneeId },
      deadline: '2027-12-31T00:00:00Z',
      priority,
      acceptanceCriteria: ['Có báo cáo'],
      expectedOutput: 'Báo cáo',
    });
    await h.tasks.transition(t.ceo, created.id, 'assign');
    return created;
  }

  const status = async (t: Team, id: string) => (await h.tasks.get(t.scene.ctx(), id)).status;
  const inProgressCount = async (t: Team, ids: string[]) =>
    (await Promise.all(ids.map((id) => status(t, id)))).filter((s) => s === 'in_progress').length;

  describe('Dashboard khớp từng task và Employee Profile (SC-008)', () => {
    it('tổng token/chi phí của Dashboard bằng tổng theo task và tổng các Profile (±1%)', async () => {
      const t = await team();
      const tasks = [
        await assignTask(t, t.devA.id, 'Việc 1'),
        await assignTask(t, t.ba.id, 'Việc 2'),
        await assignTask(t, t.devB.id, 'Việc 3'),
      ];
      await h.settle();
      const memberCtx = t.ceo;

      const board = await dashboard.get(memberCtx, { period: 'all' });
      const byTask = await h.budget.getUsage(t.scene.ctx(), { groupBy: 'task', period: 'all' });
      expect(byTask.groups.length).toBeGreaterThanOrEqual(tasks.length);
      const sumTokens = byTask.groups.reduce((s, g) => s + g.tokens, 0);
      const sumCost = byTask.groups.reduce((s, g) => s + g.costUsd, 0);
      expect(board.tokens).toBeGreaterThan(0);
      expect(Math.abs(board.tokens - sumTokens)).toBeLessThanOrEqual(board.tokens * 0.01);
      expect(Math.abs(board.costUsd - sumCost)).toBeLessThanOrEqual(board.costUsd * 0.01);
      expect(board.allTime).toEqual({ tokens: board.tokens, costUsd: board.costUsd });

      // Tổng Profile của mọi nhân viên bằng Dashboard.
      let profileTokens = 0;
      let profileCost = 0;
      for (const e of [t.manager, t.devA, t.devB, t.ba]) {
        const view = await h.office.getProfileView(memberCtx, e.id);
        profileTokens += view.usage.total.tokens;
        profileCost += view.usage.total.costUsd;
      }
      expect(Math.abs(profileTokens - board.tokens)).toBeLessThanOrEqual(board.tokens * 0.01);
      expect(Math.abs(profileCost - board.costUsd)).toBeLessThanOrEqual(board.costUsd * 0.01);
    });

    it('lọc theo phòng ban chỉ tính nhân viên, task và chi tiêu của phòng ban đó', async () => {
      const t = await team();
      await assignTask(t, t.devA.id, 'Việc Dev');
      await assignTask(t, t.ba.id, 'Việc BA');
      await h.settle();

      const all = await dashboard.get(t.ceo, { period: 'all' });
      const dev = await dashboard.get(t.ceo, {
        period: 'all',
        orgUnitId: t.scene.units.Development,
      });
      const ba = await dashboard.get(t.ceo, { period: 'all', orgUnitId: t.scene.units.BA });
      expect(all.totalEmployees).toBe(4);
      expect(dev.totalEmployees).toBe(3); // AI Manager + 2 Developer
      expect(ba.totalEmployees).toBe(1);
      expect(dev.tokens + ba.tokens).toBe(all.tokens);
      expect(dev.activeTasks).toBe(1);
      expect(ba.activeTasks).toBe(1);
      expect(all.activeTasks).toBe(2);
    });

    it('On-time Completion Rate chỉ đếm task gốc Completed và là null khi chưa có', async () => {
      const t = await team();
      const created = await assignTask(t, t.ba.id, 'Việc đúng hạn');
      expect(await dashboard.get(t.ceo, {})).toMatchObject({
        completedTasks: 0,
        onTimeCompletionRate: null,
      });
      await h.settle();
      expect(await dashboard.get(t.ceo, {})).toMatchObject({
        activeTasks: 1,
        completedTasks: 0,
        onTimeCompletionRate: null,
      });
      await h.tasks.recordDecision(t.ceo, created.id, { decision: 'approve', reason: 'Đạt' });
      await h.settle();
      expect(await dashboard.get(t.ceo, {})).toMatchObject({
        activeTasks: 0,
        completedTasks: 1,
        onTimeCompletionRate: 1,
      });
    });
  });

  describe('cảnh báo ngân sách', () => {
    it('cảnh báo ngưỡng 80% được ghi nhật ký một lần cho mỗi ngưỡng/phạm vi/kỳ', async () => {
      const t = await team();
      await budget.upsertPolicy(t.scene.ctx(), 'company', t.scene.companyId, {
        monthlyCostLimit: 1,
        monthlyTokenLimit: 10_000_000,
        warnThreshold: 0.8,
      });
      const task = await assignTask(t, t.devA.id, 'Việc cảnh báo');
      const r = await h.budget.reserve(t.scene.ctx(), {
        runId: newId(),
        taskId: task.id,
        employeeId: t.devA.id,
        modelId: 'claude-opus-5-5',
        estTokens: 1_000,
        estCostUsd: 0.95,
      });
      if (!r.ok) throw new Error('phải reserve được');
      const usage = (id: string, cost: number) => ({
        providerMessageId: id,
        modelId: 'claude-opus-5-5',
        inputTokens: 10,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: cost,
      });
      const warned = [
        ...(await h.budget.commit(t.scene.ctx(), r.reservationId, usage('w1', 0.85))).warnings,
        ...(await h.budget.commit(t.scene.ctx(), r.reservationId, usage('w2', 0.05))).warnings,
        ...(await h.budget.commit(t.scene.ctx(), r.reservationId, usage('w3', 0.02))).warnings,
      ];
      expect(warned).toHaveLength(1);
      const log = await withTenant(t.scene.companyId, (tx) => tx.select().from(budgetWarningLog));
      expect(log.filter((l) => l.scopeKind === 'company' && l.metric === 'cost')).toHaveLength(1);
    });
  });

  describe('max_concurrent_tasks theo scope (US6, FR-031)', () => {
    async function scopedLimitScenario(t: Team, scope: 'company' | 'org_unit' | 'team') {
      let scopeId = t.scene.companyId;
      if (scope === 'org_unit') scopeId = t.scene.units.Development as string;
      if (scope === 'team') {
        const created = await h.org.upsertTeam(t.scene.ctx(), {
          orgUnitId: t.scene.units.Development as string,
          name: 'Team đồng thời',
        });
        await h.org.setTeamMembers(t.scene.ctx(), created.id, [
          { kind: 'ai', id: t.devA.id },
          { kind: 'ai', id: t.devB.id },
        ]);
        scopeId = created.id;
      }
      await budget.upsertPolicy(t.scene.ctx(), scope, scopeId, { maxConcurrentTasks: 1 });
      return scopeId;
    }

    it.each(['company', 'org_unit', 'team'] as const)(
      'giới hạn ở scope %s: chỉ một task chạy cùng lúc dù hai nhân viên còn slot, task sau tự chạy khi slot trống',
      async (scope) => {
        const t = await team();
        await scopedLimitScenario(t, scope);
        const a = await assignTask(t, t.devA.id, 'Việc A');
        const b = await assignTask(t, t.devB.id, 'Việc B');
        await h.settleExcept(['run.start']);
        expect(await inProgressCount(t, [a.id, b.id])).toBe(1);

        await h.settle();
        expect(await status(t, a.id)).toBe('awaiting_human_approval');
        expect(await status(t, b.id)).toBe('awaiting_human_approval');
      },
    );

    it('nới giới hạn thì task đang chờ slot được lập lịch ngay', async () => {
      const t = await team();
      const scopeId = await scopedLimitScenario(t, 'org_unit');
      const a = await assignTask(t, t.devA.id, 'Việc A');
      const b = await assignTask(t, t.devB.id, 'Việc B');
      await h.settleExcept(['run.start']);
      expect(await inProgressCount(t, [a.id, b.id])).toBe(1);

      await budget.upsertPolicy(t.scene.ctx(), 'org_unit', scopeId, { maxConcurrentTasks: 2 });
      await h.settleExcept(['run.start']);
      expect(await inProgressCount(t, [a.id, b.id])).toBe(2);
    });

    it('giới hạn của scope khác không ảnh hưởng nhân viên ngoài scope', async () => {
      const t = await team();
      await scopedLimitScenario(t, 'org_unit'); // chỉ phòng Development
      const dev = await assignTask(t, t.devA.id, 'Việc Dev');
      const ba = await assignTask(t, t.ba.id, 'Việc BA');
      await h.settleExcept(['run.start']);
      expect(await inProgressCount(t, [dev.id, ba.id])).toBe(2);
    });
  });

  describe('overload_warning', () => {
    it('gửi khi số task chờ slot đạt max_concurrent_tasks, tối đa một lần mỗi ngày cho mỗi nhân viên', async () => {
      const t = await team(1);
      const tasks = [await assignTask(t, t.devA.id, 'Việc 1')];
      await h.settleExcept(['run.start']);
      const countWarnings = async () =>
        (await h.communication.listNotifications(t.ceo, t.scene.ceo.memberId, {})).items.filter(
          (n) => n.type === 'overload_warning',
        ).length;
      expect(await countWarnings()).toBe(0);

      tasks.push(await assignTask(t, t.devA.id, 'Việc 2')); // 1 task chờ = max (1)
      await h.settleExcept(['run.start']);
      expect(await countWarnings()).toBe(1);

      tasks.push(await assignTask(t, t.devA.id, 'Việc 3')); // vẫn quá tải, cùng ngày
      tasks.push(await assignTask(t, t.devA.id, 'Việc 4'));
      await h.settleExcept(['run.start']);
      expect(await countWarnings()).toBe(1);

      // Nhân viên khác có hàng chờ riêng nên có cảnh báo riêng.
      await assignTask(t, t.devB.id, 'Việc B1');
      await assignTask(t, t.devB.id, 'Việc B2');
      await h.settleExcept(['run.start']);
      expect(await countWarnings()).toBe(2);
    });
  });
});
