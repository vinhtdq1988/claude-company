import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EmployeeProfile, ManagedScope } from '@claude-company/contracts';
import { newId, withTenant } from '@claude-company/db';
import { domainEvent } from '@claude-company/db/schema/events';
import { eq } from 'drizzle-orm';
import { UsageBudgetService } from '../../apps/api/src/platform/usage-budget/budget.service';
import { computeCostUsd, periodOf, roundUsd } from '../../apps/api/src/platform/usage-budget/cost';
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
 * Contract test phần chính sách của BudgetService (T164; Nguyên tắc V, FR-031..FR-033, US6): cảnh báo ngưỡng một
 * lần, overage, chính sách theo phạm vi, `allowed_models` và giới hạn đồng thời hiệu lực, usage theo phạm vi quản lý.
 * Phần reserve/commit/release lõi nằm ở `budget-core.spec.ts`.
 */
describe('Contract: BudgetService – chính sách và cảnh báo (T164)', () => {
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

  type World = { scene: Scene; dev: EmployeeProfile; taskId: string };

  async function world(): Promise<World> {
    const scene = await h.newScene();
    const manager = await h.hire(scene, managerProfile(scene));
    const dev = await h.hire(scene, { manager: { kind: 'ai', id: manager.id } });
    const task = await h.tasks.create(scene.humanCtx(scene.ceo.memberId), {
      title: 'Việc thử ngân sách',
      objective: 'x',
      assignee: { kind: 'ai_employee', id: dev.id },
      deadline: '2027-12-31T00:00:00Z',
      priority: 'medium',
      acceptanceCriteria: ['ok'],
      expectedOutput: 'y',
    });
    return { scene, dev, taskId: task.id };
  }

  const req = (w: World, estTokens: number, estCostUsd: number) => ({
    runId: newId(),
    taskId: w.taskId,
    employeeId: w.dev.id,
    modelId: 'claude-opus-5-5',
    estTokens,
    estCostUsd,
  });
  const usage = (messageId: string, tokens: number, costUsd: number) => ({
    providerMessageId: messageId,
    modelId: 'claude-opus-5-5',
    inputTokens: tokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd,
  });
  const companyPolicy = (w: World, costLimit: number, warnThreshold = 0.8) =>
    service.upsertPolicy(w.scene.ctx(), 'company', w.scene.companyId, {
      monthlyCostLimit: costLimit,
      monthlyTokenLimit: 10_000_000,
      warnThreshold,
    });

  describe('làm tròn chi phí', () => {
    it('chi phí tính từ token × bảng giá, làm tròn 6 chữ số thập phân', () => {
      const price = {
        inputPerMtok: 3,
        outputPerMtok: 15,
        cacheReadPerMtok: 0.3,
        cacheWritePerMtok: 3.75,
      };
      expect(
        computeCostUsd(
          { inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 1 },
          price,
        ),
      ).toBe(0.000022);
      expect(roundUsd(0.1234567891)).toBe(0.123457);
      expect(roundUsd(0.0000004)).toBe(0);
    });

    it('kỳ ngân sách là tháng lịch theo múi giờ công ty', () => {
      const edge = new Date('2026-12-31T20:00:00Z'); // 03:00 ngày 1/1 theo giờ Việt Nam
      expect(periodOf(edge, 'Asia/Ho_Chi_Minh')).toBe('2027-01');
      expect(periodOf(edge, 'UTC')).toBe('2026-12');
    });
  });

  describe('cảnh báo ngưỡng', () => {
    it('cảnh báo đúng một lần cho mỗi (phạm vi, kỳ, loại, giới hạn, ngưỡng) dù commit lặp lại', async () => {
      const w = await world();
      await companyPolicy(w, 1);
      const r = await h.budget.reserve(w.scene.ctx(), req(w, 50_000, 0.95));
      if (!r.ok) throw new Error('phải reserve được');
      const ctx = w.scene.ctx();
      expect(
        (await h.budget.commit(ctx, r.reservationId, usage('a-1', 100, 0.5))).warnings,
      ).toEqual([]);
      const crossing = await h.budget.commit(ctx, r.reservationId, usage('a-2', 100, 0.35));
      expect(crossing.warnings).toEqual([
        expect.objectContaining({ scopeKind: 'company', kind: 'cost', limit: 1 }),
      ]);
      const more = await h.budget.commit(ctx, r.reservationId, usage('a-3', 100, 0.05));
      expect(more.warnings).toEqual([]);
    });

    it('hạ ngưỡng xuống dưới mức đang dùng thì cảnh báo ở lần commit kế tiếp, đúng một lần', async () => {
      const w = await world();
      await companyPolicy(w, 1, 0.9);
      const r = await h.budget.reserve(w.scene.ctx(), req(w, 50_000, 0.9));
      if (!r.ok) throw new Error('phải reserve được');
      const ctx = w.scene.ctx();
      await h.budget.commit(ctx, r.reservationId, usage('b-1', 100, 0.6));
      await companyPolicy(w, 1, 0.5); // đang dùng 60% > ngưỡng mới 50%
      const first = await h.budget.commit(ctx, r.reservationId, usage('b-2', 100, 0.01));
      expect(first.warnings).toHaveLength(1);
      const second = await h.budget.commit(ctx, r.reservationId, usage('b-3', 100, 0.01));
      expect(second.warnings).toEqual([]);
    });

    it('nâng giới hạn rồi chạm ngưỡng mới thì được cảnh báo lại', async () => {
      const w = await world();
      await companyPolicy(w, 1);
      const r = await h.budget.reserve(w.scene.ctx(), req(w, 50_000, 0.95));
      if (!r.ok) throw new Error('phải reserve được');
      const ctx = w.scene.ctx();
      const first = await h.budget.commit(ctx, r.reservationId, usage('c-1', 100, 0.85));
      expect(first.warnings).toHaveLength(1);
      await companyPolicy(w, 2); // ngưỡng mới ở 1.6 USD
      const below = await h.budget.commit(ctx, r.reservationId, usage('c-2', 100, 0.05));
      expect(below.warnings).toEqual([]);
      await h.budget.release(ctx, r.reservationId);
      const r2 = await h.budget.reserve(ctx, req(w, 50_000, 0.9));
      if (!r2.ok) throw new Error('phải reserve được');
      const again = await h.budget.commit(ctx, r2.reservationId, usage('c-3', 100, 0.8));
      expect(again.warnings).toEqual([
        expect.objectContaining({ scopeKind: 'company', kind: 'cost', limit: 2 }),
      ]);
    });

    it('phạm vi nhân viên và phạm vi công ty cảnh báo độc lập', async () => {
      const w = await world();
      await companyPolicy(w, 100);
      await service.upsertPolicy(w.scene.ctx(), 'ai_employee', w.dev.id, {
        monthlyCostLimit: 1,
        monthlyTokenLimit: 1_000_000,
      });
      const r = await h.budget.reserve(w.scene.ctx(), req(w, 50_000, 0.95));
      if (!r.ok) throw new Error('phải reserve được');
      const crossing = await h.budget.commit(
        w.scene.ctx(),
        r.reservationId,
        usage('d-1', 100, 0.9),
      );
      expect(crossing.warnings).toEqual([
        expect.objectContaining({ scopeKind: 'ai_employee', scopeId: w.dev.id, kind: 'cost' }),
      ]);
    });
  });

  describe('overage', () => {
    it('lời gọi vượt phần giữ ghi is_overage và reserve lượt sau bị chặn', async () => {
      const w = await world();
      await companyPolicy(w, 1);
      const r = await h.budget.reserve(w.scene.ctx(), req(w, 10_000, 0.5));
      if (!r.ok) throw new Error('phải reserve được');
      const over = await h.budget.commit(w.scene.ctx(), r.reservationId, usage('o-1', 100, 3));
      expect(over.overage).toBe(true);
      const next = await h.budget.reserve(w.scene.ctx(), req(w, 100, 0.01));
      expect(next).toMatchObject({ ok: false, limitHit: { scopeKind: 'company', kind: 'cost' } });
    });
  });

  describe('chính sách theo phạm vi', () => {
    it('chưa có bản ghi: công ty trả hạn mức mặc định, phạm vi khác không đặt giới hạn riêng', async () => {
      const w = await world();
      const company = await service.getPolicy(w.scene.ctx(), 'company', w.scene.companyId);
      expect(company).toMatchObject({
        isDefault: true,
        monthlyCostLimit: 20,
        monthlyTokenLimit: 2_000_000,
        warnThreshold: 0.8,
      });
      const unit = await service.getPolicy(
        w.scene.ctx(),
        'org_unit',
        w.scene.units.Development as string,
      );
      expect(unit).toMatchObject({
        isDefault: true,
        monthlyCostLimit: null,
        monthlyTokenLimit: null,
        allowedModels: null,
      });
    });

    it('PUT thay thế chính sách và đọc lại đúng; phạm vi không tồn tại → NOT_FOUND', async () => {
      const w = await world();
      const saved = await service.upsertPolicy(
        w.scene.ctx(),
        'org_unit',
        w.scene.units.Development as string,
        {
          monthlyCostLimit: 5,
          monthlyTokenLimit: 500_000,
          maxConcurrentTasks: 3,
          allowedModels: ['claude-haiku-5-5'],
          warnThreshold: 0.7,
        },
      );
      expect(saved).toMatchObject({
        isDefault: false,
        monthlyCostLimit: 5,
        monthlyTokenLimit: 500_000,
        maxConcurrentTasks: 3,
        allowedModels: ['claude-haiku-5-5'],
        warnThreshold: 0.7,
      });
      const replaced = await service.upsertPolicy(
        w.scene.ctx(),
        'org_unit',
        w.scene.units.Development as string,
        { monthlyCostLimit: 6 },
      );
      expect(replaced).toMatchObject({
        monthlyCostLimit: 6,
        monthlyTokenLimit: null,
        maxConcurrentTasks: null,
        allowedModels: null,
        warnThreshold: 0.7, // bỏ trống thì giữ ngưỡng hiện có
      });
      await expect(service.getPolicy(w.scene.ctx(), 'team', newId())).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await expect(service.getPolicy(w.scene.ctx(), 'company', newId())).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('từ chối: maxConcurrentTasks ở phạm vi nhân viên, bỏ giới hạn công ty, model ngoài danh mục', async () => {
      const w = await world();
      await expect(
        service.upsertPolicy(w.scene.ctx(), 'ai_employee', w.dev.id, { maxConcurrentTasks: 2 }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(
        service.upsertPolicy(w.scene.ctx(), 'company', w.scene.companyId, {
          monthlyCostLimit: null,
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(
        service.upsertPolicy(w.scene.ctx(), 'company', w.scene.companyId, {
          allowedModels: ['gpt-khong-co'],
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('công ty đã có bản ghi vẫn không bao giờ không giới hạn', async () => {
      const w = await world();
      await service.upsertPolicy(w.scene.ctx(), 'company', w.scene.companyId, {
        allowedModels: ['claude-opus-5-5'],
      });
      const policy = await service.getPolicy(w.scene.ctx(), 'company', w.scene.companyId);
      expect(policy).toMatchObject({ monthlyCostLimit: 20, monthlyTokenLimit: 2_000_000 });
      const tooCostly = await h.budget.reserve(w.scene.ctx(), req(w, 1_000, 25));
      expect(tooCostly.ok).toBe(false);
    });

    it('lưu chính sách phát domain_event budget.policy_changed', async () => {
      const w = await world();
      await companyPolicy(w, 3);
      const events = await withTenant(w.scene.companyId, (tx) =>
        tx.select().from(domainEvent).where(eq(domainEvent.type, 'budget.policy_changed')),
      );
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toMatchObject({
        scopeKind: 'company',
        scopeId: w.scene.companyId,
      });
    });
  });

  describe('allowed_models và giới hạn đồng thời hiệu lực', () => {
    it('allowedModelsFor giao danh sách của mọi phạm vi và dùng được khi nhân viên chưa tồn tại', async () => {
      const w = await world();
      const home = w.scene.units.Development as string;
      expect(await h.budget.allowedModelsFor(w.scene.ctx(), { homeOrgUnitId: home })).toBeNull();
      await service.upsertPolicy(w.scene.ctx(), 'company', w.scene.companyId, {
        allowedModels: ['claude-opus-5-5', 'claude-haiku-5-5'],
      });
      await service.upsertPolicy(w.scene.ctx(), 'org_unit', home, {
        allowedModels: ['claude-haiku-5-5', 'claude-sonnet-5-5'],
      });
      expect(await h.budget.allowedModelsFor(w.scene.ctx(), { homeOrgUnitId: home })).toEqual([
        'claude-haiku-5-5',
      ]);
      // Đơn vị khác không chịu giới hạn của đơn vị Development, chỉ chịu giới hạn của công ty.
      expect(
        await h.budget.allowedModelsFor(w.scene.ctx(), {
          homeOrgUnitId: w.scene.units.QA as string,
        }),
      ).toEqual(['claude-opus-5-5', 'claude-haiku-5-5']);
    });

    it('getConcurrencyLimits chỉ trả giới hạn company/đơn vị (và tổ tiên)/team áp lên nhân viên', async () => {
      const w = await world();
      await service.upsertPolicy(w.scene.ctx(), 'company', w.scene.companyId, {
        maxConcurrentTasks: 10,
      });
      await service.upsertPolicy(w.scene.ctx(), 'org_unit', w.scene.units.Development as string, {
        maxConcurrentTasks: 4,
      });
      await service.upsertPolicy(w.scene.ctx(), 'org_unit', w.scene.units.QA as string, {
        maxConcurrentTasks: 1,
      });
      const limits = await h.budget.getConcurrencyLimits(w.scene.ctx(), w.dev.id);
      expect(limits).toHaveLength(2);
      expect(limits).toEqual(
        expect.arrayContaining([
          { scopeKind: 'company', scopeId: w.scene.companyId, max: 10 },
          { scopeKind: 'org_unit', scopeId: w.scene.units.Development, max: 4 },
        ]),
      );
    });
  });

  describe('usage theo phạm vi quản lý', () => {
    it('scope giới hạn chỉ cộng chi tiêu của nhân viên/đơn vị trong phạm vi', async () => {
      const w = await world();
      const r = await h.budget.reserve(w.scene.ctx(), req(w, 50_000, 1));
      if (!r.ok) throw new Error('phải reserve được');
      await h.budget.commit(w.scene.ctx(), r.reservationId, usage('s-1', 1_000, 0.4));

      const none: ManagedScope = {
        companyWide: false,
        orgUnitIds: [],
        teamIds: [],
        employeeIds: [],
      };
      const outside = await h.budget.getUsage(w.scene.ctx(), { scope: none });
      expect(outside).toMatchObject({ tokens: 0, costUsd: 0 });

      const byUnit = await h.budget.getUsage(w.scene.ctx(), {
        scope: { ...none, orgUnitIds: [w.scene.units.Development as string] },
      });
      expect(byUnit.tokens).toBe(1_000);
      const byEmployee = await h.budget.getUsage(w.scene.ctx(), {
        scope: { ...none, employeeIds: [w.dev.id] },
        groupBy: 'employee',
      });
      expect(byEmployee.groups).toEqual([
        expect.objectContaining({ key: w.dev.id, tokens: 1_000 }),
      ]);
      const wide = await h.budget.getUsage(w.scene.ctx(), {
        scope: { ...none, companyWide: true },
      });
      expect(wide.tokens).toBe(1_000);
    });
  });
});
