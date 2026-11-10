import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EmployeeProfile } from '@claude-company/contracts';
import { newId, withTenant } from '@claude-company/db';
import { usageLedger } from '@claude-company/db/schema/usage';
import { UsageBudgetService } from '../../apps/api/src/platform/usage-budget/budget.service';
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
 * Cưỡng chế ngân sách (T165; SC-009, FR-031..FR-033, Nguyên tắc V): task sắp vượt giới hạn luôn bị chặn, ở cả bốn
 * phạm vi và trần của task; không có chi tiêu vượt mức âm thầm.
 */
describe('Security: cưỡng chế ngân sách (T165)', () => {
  let infra: StartedInfra;
  let h: FlowHarness;
  let service: UsageBudgetService;

  beforeAll(async () => {
    infra = await startInfra({ redis: false });
    await prepareDatabase(infra);
    await seedDatabase(infra);
    h = await createFlowHarness({ infra });
    service = h.app.get(UsageBudgetService, { strict: false });
  });

  afterAll(async () => {
    await h?.close();
    await infra?.stop();
  });

  type Team = { scene: Scene; manager: EmployeeProfile; dev: EmployeeProfile };

  async function team(): Promise<Team> {
    const scene = await h.newScene();
    const manager = await h.hire(scene, managerProfile(scene));
    const dev = await h.hire(scene, { manager: { kind: 'ai', id: manager.id } });
    return { scene, manager, dev };
  }

  async function newTask(t: Team, caps: { tokenCap?: number; costCap?: number } = {}) {
    const ctx = t.scene.humanCtx(t.scene.ceo.memberId);
    const created = await h.tasks.create(ctx, {
      title: 'Việc thử ngân sách',
      objective: 'Viết báo cáo',
      assignee: { kind: 'ai_employee', id: t.dev.id },
      deadline: '2027-12-31T00:00:00Z',
      priority: 'high',
      acceptanceCriteria: ['Có báo cáo'],
      expectedOutput: 'Báo cáo',
      ...caps,
    });
    return { ctx, id: created.id };
  }

  const reserve = (t: Team, taskId: string, estTokens: number, estCostUsd: number) =>
    h.budget.reserve(t.scene.ctx(), {
      runId: newId(),
      taskId,
      employeeId: t.dev.id,
      modelId: 'claude-opus-5-5',
      estTokens,
      estCostUsd,
    });

  const usage = (id: string, tokens: number, costUsd: number) => ({
    providerMessageId: id,
    modelId: 'claude-opus-5-5',
    inputTokens: tokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd,
  });

  describe('chặn trước khi vượt ở từng phạm vi (SC-009)', () => {
    it.each(['company', 'org_unit', 'team', 'ai_employee'] as const)(
      'phạm vi %s: reserve vượt giới hạn bị chặn và báo đúng phạm vi',
      async (kind) => {
        const t = await team();
        const unit = t.scene.units.Development as string;
        let scopeId: string;
        if (kind === 'company') scopeId = t.scene.companyId;
        else if (kind === 'org_unit') scopeId = unit;
        else if (kind === 'ai_employee') scopeId = t.dev.id;
        else {
          const created = await h.org.upsertTeam(t.scene.ctx(), {
            orgUnitId: unit,
            name: 'Team ngân sách',
          });
          await h.org.setTeamMembers(t.scene.ctx(), created.id, [{ kind: 'ai', id: t.dev.id }]);
          scopeId = created.id;
        }
        await service.upsertPolicy(t.scene.ctx(), kind, scopeId, {
          monthlyCostLimit: 1,
          monthlyTokenLimit: 1_000_000,
        });
        const task = await newTask(t);
        expect(await reserve(t, task.id, 100, 0.6)).toMatchObject({ ok: true });
        const blocked = await reserve(t, task.id, 100, 0.6); // 0.6 + 0.6 > 1
        expect(blocked).toMatchObject({
          ok: false,
          limitHit: { scopeKind: kind, scopeId, kind: 'cost', limit: 1 },
        });
      },
    );

    it('trần riêng của task (cost_cap, token_cap) chặn dù các phạm vi còn rộng', async () => {
      const t = await team();
      const task = await newTask(t, { costCap: 0.5, tokenCap: 1_000 });
      expect(await reserve(t, task.id, 500, 0.3)).toMatchObject({ ok: true });
      expect(await reserve(t, task.id, 100, 0.3)).toMatchObject({
        ok: false,
        limitHit: { scopeKind: 'task', scopeId: task.id, kind: 'cost' },
      });
      expect(await reserve(t, task.id, 600, 0.01)).toMatchObject({
        ok: false,
        limitHit: { scopeKind: 'task', scopeId: task.id, kind: 'tokens' },
      });
    });

    it('giới hạn chạm trước thắng: phạm vi hẹp hơn được báo thay cho phạm vi rộng', async () => {
      const t = await team();
      await service.upsertPolicy(t.scene.ctx(), 'company', t.scene.companyId, {
        monthlyCostLimit: 100,
        monthlyTokenLimit: 10_000_000,
      });
      await service.upsertPolicy(t.scene.ctx(), 'ai_employee', t.dev.id, {
        monthlyCostLimit: 2,
        monthlyTokenLimit: 10_000_000,
      });
      const task = await newTask(t);
      expect(await reserve(t, task.id, 100, 3)).toMatchObject({
        ok: false,
        limitHit: { scopeKind: 'ai_employee', scopeId: t.dev.id },
      });
    });

    it('hai run đồng thời không cùng vượt giới hạn của nhân viên', async () => {
      const t = await team();
      await service.upsertPolicy(t.scene.ctx(), 'ai_employee', t.dev.id, {
        monthlyCostLimit: 1,
        monthlyTokenLimit: 1_000_000,
      });
      const task = await newTask(t);
      const results = await Promise.all([
        reserve(t, task.id, 100, 0.7),
        reserve(t, task.id, 100, 0.7),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
    });
  });

  describe('giới hạn token', () => {
    it('chặn run claude_agent_sdk dù còn ngân sách USD, task chuyển blocked và báo người giao', async () => {
      const t = await team();
      // Còn rất nhiều USD nhưng chỉ 10 token: reservation theo run (SDK_RUN_RESERVE_TOKENS) không vừa.
      await service.upsertPolicy(t.scene.ctx(), 'ai_employee', t.dev.id, {
        monthlyCostLimit: 1_000,
        monthlyTokenLimit: 10,
      });
      const task = await newTask(t);
      await h.tasks.transition(task.ctx, task.id, 'assign');
      await h.settle();

      expect(await h.tasks.get(t.scene.ctx(), task.id)).toMatchObject({
        status: 'blocked',
        blockedReason: 'BUDGET_EXCEEDED',
      });
      const usageTotal = await h.budget.getUsage(t.scene.ctx(), { employeeId: t.dev.id });
      expect(usageTotal.tokens).toBe(0); // không chi tiêu nào xảy ra
      const inbox = await h.communication.listNotifications(
        t.scene.ctx(),
        t.scene.ceo.memberId,
        {},
      );
      expect(inbox.items.map((n) => n.type)).toContain('budget_blocked');
    });

    it('token_cap của task nhỏ hơn reservation theo run cũng chặn run claude_agent_sdk', async () => {
      const t = await team();
      const task = await newTask(t, { tokenCap: 50 });
      await h.tasks.transition(task.ctx, task.id, 'assign');
      await h.settle();
      expect(await h.tasks.get(t.scene.ctx(), task.id)).toMatchObject({
        status: 'blocked',
        blockedReason: 'BUDGET_EXCEEDED',
      });
    });
  });

  describe('vượt đơn lẻ và đặt lại theo tháng', () => {
    it('lời gọi đơn lẻ vượt phần giữ ghi overage và chặn lượt sau', async () => {
      const t = await team();
      await service.upsertPolicy(t.scene.ctx(), 'ai_employee', t.dev.id, {
        monthlyCostLimit: 1,
        monthlyTokenLimit: 1_000_000,
      });
      const task = await newTask(t);
      const r = await reserve(t, task.id, 1_000, 0.5);
      if (!r.ok) throw new Error('phải reserve được');
      const committed = await h.budget.commit(
        t.scene.ctx(),
        r.reservationId,
        usage('ov-1', 500, 2),
      );
      expect(committed.overage).toBe(true);
      expect(await reserve(t, task.id, 10, 0.01)).toMatchObject({ ok: false });
    });

    it('chi tiêu của kỳ cũ không tính vào hạn mức kỳ hiện tại', async () => {
      const t = await team();
      await service.upsertPolicy(t.scene.ctx(), 'ai_employee', t.dev.id, {
        monthlyCostLimit: 1,
        monthlyTokenLimit: 1_000_000,
      });
      const task = await newTask(t);
      await withTenant(t.scene.companyId, (tx) =>
        tx.insert(usageLedger).values({
          id: newId(),
          companyId: t.scene.companyId,
          agentRunId: newId(),
          taskId: task.id,
          aiEmployeeId: t.dev.id,
          orgUnitId: t.scene.units.Development as string,
          teamIds: [],
          modelId: 'claude-opus-5-5',
          inputTokens: 900_000,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: '0.99',
          period: '2020-01',
          providerMessageId: `old-${newId()}`,
          isOverage: false,
        }),
      );
      // Kỳ 2020-01 gần chạm hạn mức nhưng kỳ hiện tại bắt đầu từ 0.
      expect(await reserve(t, task.id, 500_000, 0.9)).toMatchObject({ ok: true });
    });
  });

  describe('allowed_models', () => {
    it('tạo hoặc sửa nhân viên với model ngoài danh sách được phép bị từ chối', async () => {
      const t = await team();
      await service.upsertPolicy(t.scene.ctx(), 'org_unit', t.scene.units.Development as string, {
        allowedModels: ['claude-haiku-5-5'],
      });
      await expect(
        h.hire(t.scene, { name: 'Dev sai model', modelId: 'claude-opus-5-5' }),
      ).rejects.toMatchObject({ code: 'MODEL_NOT_ALLOWED' });
      const ok = await h.hire(t.scene, { name: 'Dev đúng model', modelId: 'claude-haiku-5-5' });
      await expect(
        h.employees.update(t.scene.ctx(), ok.id, { modelId: 'claude-sonnet-5-5' }),
      ).rejects.toMatchObject({ code: 'MODEL_NOT_ALLOWED' });
    });

    it('model bị loại khỏi allowed_models sau khi tuyển thì task bị chặn khi bắt đầu run', async () => {
      const t = await team();
      await service.upsertPolicy(t.scene.ctx(), 'ai_employee', t.dev.id, {
        allowedModels: ['claude-haiku-5-5'],
      });
      const task = await newTask(t);
      await h.tasks.transition(task.ctx, task.id, 'assign');
      await h.settle();
      expect(await h.tasks.get(t.scene.ctx(), task.id)).toMatchObject({
        status: 'blocked',
        blockedReason: 'MODEL_NOT_ALLOWED',
      });
    });
  });
});
