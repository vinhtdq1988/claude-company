import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EmployeeProfile } from '@claude-company/contracts';
import { newId, withTenant } from '@claude-company/db';
import { budgetPolicy } from '@claude-company/db/schema/usage';
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

/** Contract test BudgetService lõi trên Postgres thật (T089a; Nguyên tắc V, R6, FR-031..FR-033). */
describe('Contract: BudgetService (T089a)', () => {
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

  type World = { scene: Scene; dev: EmployeeProfile; taskId: string };

  async function world(taskCaps: { tokenCap?: number; costCap?: number } = {}): Promise<World> {
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
      ...taskCaps,
    });
    return { scene, dev, taskId: task.id };
  }

  const policy = (
    scene: Scene,
    scopeKind: 'company' | 'org_unit' | 'team' | 'ai_employee',
    scopeId: string,
    values: Partial<typeof budgetPolicy.$inferInsert>,
  ) =>
    withTenant(scene.companyId, (tx) =>
      tx
        .insert(budgetPolicy)
        .values({ id: newId(), companyId: scene.companyId, scopeKind, scopeId, ...values }),
    );

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

  it('không có budget_policy thì áp hạn mức mặc định (20 USD, 2.000.000 token), không bao giờ là vô hạn', async () => {
    const w = await world();
    const ok = await h.budget.reserve(w.scene.ctx(), req(w, 1_000, 1));
    expect(ok).toMatchObject({ ok: true });
    const tooCostly = await h.budget.reserve(w.scene.ctx(), req(w, 1_000, 25));
    expect(tooCostly).toMatchObject({
      ok: false,
      limitHit: { scopeKind: 'company', scopeId: w.scene.companyId, kind: 'cost', limit: 20 },
    });
    const tooManyTokens = await h.budget.reserve(w.scene.ctx(), req(w, 2_500_000, 0.1));
    expect(tooManyTokens).toMatchObject({
      ok: false,
      limitHit: { scopeKind: 'company', kind: 'tokens' },
    });
  });

  it('reserve rồi commit ghi usage_ledger; commit trùng provider_message_id không đếm lại; release trả phần dư', async () => {
    const w = await world();
    await policy(w.scene, 'company', w.scene.companyId, {
      monthlyCostLimit: '10',
      monthlyTokenLimit: 1_000_000,
    });
    const r = await h.budget.reserve(w.scene.ctx(), req(w, 100_000, 2));
    if (!r.ok) throw new Error('phải reserve được');
    expect(r.remainingUsd).toBeCloseTo(8, 6);

    const first = await h.budget.commit(
      w.scene.ctx(),
      r.reservationId,
      usage('msg-1', 40_000, 0.8),
    );
    expect(first).toMatchObject({ overage: false, warnings: [] });
    const dup = await h.budget.commit(w.scene.ctx(), r.reservationId, usage('msg-1', 40_000, 0.8));
    expect(dup).toMatchObject({ overage: false, warnings: [] });
    expect((await h.budget.getUsage(w.scene.ctx(), { taskId: w.taskId })).tokens).toBe(40_000);

    await h.budget.release(w.scene.ctx(), r.reservationId);
    // Phần giữ còn lại đã trả: có thể reserve gần hết hạn mức còn lại (10 − 0.8 = 9.2 USD).
    const big = await h.budget.reserve(w.scene.ctx(), req(w, 1_000, 9.1));
    expect(big).toMatchObject({ ok: true });
    const over = await h.budget.reserve(w.scene.ctx(), req(w, 1_000, 0.2));
    expect(over).toMatchObject({ ok: false, limitHit: { kind: 'cost' } });
  });

  it('hai run đồng thời không cùng vượt hạn mức', async () => {
    const w = await world();
    await policy(w.scene, 'company', w.scene.companyId, {
      monthlyCostLimit: '1',
      monthlyTokenLimit: 1_000_000,
    });
    const results = await Promise.all([
      h.budget.reserve(w.scene.ctx(), req(w, 1_000, 0.7)),
      h.budget.reserve(w.scene.ctx(), req(w, 1_000, 0.7)),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(1);
  });

  it('giới hạn chạm trước thắng: scope hẹp hơn (đơn vị, nhân viên) được báo thay vì công ty', async () => {
    const w = await world();
    await policy(w.scene, 'company', w.scene.companyId, {
      monthlyCostLimit: '100',
      monthlyTokenLimit: 10_000_000,
    });
    await policy(w.scene, 'org_unit', w.scene.units.Development!, { monthlyCostLimit: '5' });
    await policy(w.scene, 'ai_employee', w.dev.id, { monthlyCostLimit: '3' });
    const blocked = await h.budget.reserve(w.scene.ctx(), req(w, 1_000, 4));
    expect(blocked).toMatchObject({
      ok: false,
      limitHit: { scopeKind: 'ai_employee', scopeId: w.dev.id, limit: 3 },
    });
    const fine = await h.budget.reserve(w.scene.ctx(), req(w, 1_000, 2.5));
    expect(fine.ok).toBe(true);
  });

  it('trần riêng của task: token_cap / cost_cap giảm hạn mức và chặn khi vượt', async () => {
    const w = await world({ costCap: 0.5, tokenCap: 10_000 });
    expect(await h.budget.reserve(w.scene.ctx(), req(w, 5_000, 0.3))).toMatchObject({ ok: true });
    const byCost = await h.budget.reserve(w.scene.ctx(), req(w, 100, 0.3));
    expect(byCost).toMatchObject({
      ok: false,
      limitHit: { scopeKind: 'task', scopeId: w.taskId, kind: 'cost' },
    });
    const byTokens = await h.budget.reserve(w.scene.ctx(), req(w, 6_000, 0.01));
    expect(byTokens).toMatchObject({ ok: false, limitHit: { scopeKind: 'task', kind: 'tokens' } });
  });

  it('reservation theo run của claude_agent_sdk: commit từng lượt, giữ phần dư tới khi release', async () => {
    const w = await world();
    await policy(w.scene, 'company', w.scene.companyId, {
      monthlyCostLimit: '10',
      monthlyTokenLimit: 1_000_000,
    });
    const run = req(w, 200_000, 2);
    const r = await h.budget.reserve(w.scene.ctx(), run);
    if (!r.ok) throw new Error('phải reserve được');
    await h.budget.commit(w.scene.ctx(), r.reservationId, usage('sdk-1', 50_000, 0.5));
    await h.budget.commit(w.scene.ctx(), r.reservationId, usage('sdk-2', 30_000, 0.3));
    // Còn giữ ≈ 1.2 USD: một reserve khác chỉ còn 10 − 0.8 − 1.2 = 8 USD.
    const during = await h.budget.reserve(w.scene.ctx(), req(w, 1_000, 8.1));
    expect(during.ok).toBe(false);
    await h.budget.releaseRun(w.scene.ctx(), run.runId);
    const after = await h.budget.reserve(w.scene.ctx(), req(w, 1_000, 9.1));
    expect(after.ok).toBe(true);
  });

  it('một lời gọi đơn lẻ vượt phần đã giữ ghi overage; cảnh báo ở ngưỡng 80% chỉ một lần', async () => {
    const w = await world();
    await policy(w.scene, 'company', w.scene.companyId, {
      monthlyCostLimit: '1',
      monthlyTokenLimit: 10_000_000,
      warnThreshold: '0.8',
    });
    const r = await h.budget.reserve(w.scene.ctx(), req(w, 50_000, 0.9));
    if (!r.ok) throw new Error('phải reserve được');
    const low = await h.budget.commit(w.scene.ctx(), r.reservationId, usage('w-1', 1_000, 0.5));
    expect(low.warnings).toEqual([]);
    const crossing = await h.budget.commit(
      w.scene.ctx(),
      r.reservationId,
      usage('w-2', 1_000, 0.35),
    );
    expect(crossing.warnings).toEqual([
      expect.objectContaining({ scopeKind: 'company', kind: 'cost', limit: 1 }),
    ]);
    const again = await h.budget.commit(w.scene.ctx(), r.reservationId, usage('w-3', 1_000, 0.02));
    expect(again.warnings).toEqual([]);
    const big = await h.budget.commit(w.scene.ctx(), r.reservationId, usage('w-4', 1_000, 5));
    expect(big.overage).toBe(true);
  });

  it('isModelAllowed: model phải thuộc allowed_models của mọi scope có khai báo', async () => {
    const w = await world();
    expect(await h.budget.isModelAllowed(w.scene.ctx(), w.dev.id, 'claude-opus-5-5')).toBe(true);
    await policy(w.scene, 'company', w.scene.companyId, {
      allowedModels: ['claude-opus-5-5', 'claude-haiku-5-5'],
    });
    await policy(w.scene, 'ai_employee', w.dev.id, { allowedModels: ['claude-haiku-5-5'] });
    expect(await h.budget.isModelAllowed(w.scene.ctx(), w.dev.id, 'claude-haiku-5-5')).toBe(true);
    expect(await h.budget.isModelAllowed(w.scene.ctx(), w.dev.id, 'claude-opus-5-5')).toBe(false);
    expect(await h.budget.isModelAllowed(w.scene.ctx(), w.dev.id, 'claude-fable-5-1')).toBe(false);
  });

  it('getUsage lọc theo task/nhân viên/đơn vị và nhóm theo employee, task, org_unit', async () => {
    const w = await world();
    const run = req(w, 100_000, 3);
    const r = await h.budget.reserve(w.scene.ctx(), run);
    if (!r.ok) throw new Error('phải reserve được');
    await h.budget.commit(w.scene.ctx(), r.reservationId, usage('u-1', 1_000, 0.1));
    await h.budget.commit(w.scene.ctx(), r.reservationId, usage('u-2', 2_000, 0.2));
    const byTask = await h.budget.getUsage(w.scene.ctx(), { taskId: w.taskId, groupBy: 'task' });
    expect(byTask).toMatchObject({ tokens: 3_000 });
    expect(byTask.costUsd).toBeCloseTo(0.3, 6);
    expect(byTask.groups).toEqual([expect.objectContaining({ key: w.taskId, tokens: 3_000 })]);
    const byUnit = await h.budget.getUsage(w.scene.ctx(), {
      orgUnitId: w.scene.units.Development!,
      groupBy: 'org_unit',
    });
    expect(byUnit.groups.map((g) => g.key)).toEqual([w.scene.units.Development]);
    const none = await h.budget.getUsage(w.scene.ctx(), { orgUnitId: w.scene.units.QA! });
    expect(none).toMatchObject({ tokens: 0, costUsd: 0 });
    const byEmployee = await h.budget.getUsage(w.scene.ctx(), { employeeId: w.dev.id });
    expect(byEmployee.period).toMatch(/^\d{4}-\d{2}$/);
  });

  it('cô lập tenant: usage công ty khác không tính vào hạn mức của công ty này', async () => {
    const a = await world();
    const b = await world();
    await policy(a.scene, 'company', a.scene.companyId, {
      monthlyCostLimit: '1',
      monthlyTokenLimit: 1_000_000,
    });
    const rb = await h.budget.reserve(b.scene.ctx(), req(b, 1_000, 15));
    expect(rb.ok).toBe(true); // công ty B dùng mặc định 20 USD, không bị ảnh hưởng bởi A
    const ra = await h.budget.reserve(a.scene.ctx(), req(a, 1_000, 1.5));
    expect(ra.ok).toBe(false);
  });
});
