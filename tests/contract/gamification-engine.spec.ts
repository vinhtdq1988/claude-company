import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DomainEvent } from '@claude-company/contracts';
import { withTenant } from '@claude-company/db';
import { domainEvent } from '@claude-company/db/schema/events';
import { eq } from 'drizzle-orm';
import {
  prepareDatabase,
  seedDatabase,
  startInfra,
  type StartedInfra,
} from '../support/containers';
import { createFlowHarness, type FlowHarness, type Scene } from '../support/flow-harness';

/**
 * Contract test `GamificationEngine` (T186; Nguyên tắc VI, FR-045, US8). Engine thật trên PostgreSQL (RLS bật), các
 * sự kiện nguồn được dựng tay để kiểm soát chính xác `seq` và payload.
 */
describe('Contract: GamificationEngine (T186)', () => {
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

  const event = (
    scene: Scene,
    seq: number,
    type: string,
    payload: Record<string, unknown> = {},
  ): DomainEvent => ({
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    companyId: scene.companyId,
    seq,
    type,
    aggregateKind: 'test',
    aggregateId: scene.companyId,
    payload,
    occurredAt: new Date(Date.UTC(2026, 10, 10, 8, seq)).toISOString(),
  });

  const achieved = (scene: Scene) =>
    withTenant(scene.companyId, (tx) =>
      tx.select().from(domainEvent).where(eq(domainEvent.type, 'milestone.achieved')),
    );

  it('công ty mới chưa có cột mốc nào', async () => {
    const scene = await h.newScene();
    expect(await h.gamification.list(scene.ctx())).toEqual([]);
  });

  it('employee.created ghi first_employee kèm sự kiện nguồn và phát milestone.achieved đúng một lần', async () => {
    const scene = await h.newScene();
    await h.gamification.onDomainEvent(event(scene, 101, 'employee.created', { kind: 'employee' }));

    expect(await h.gamification.list(scene.ctx())).toEqual([
      { key: 'first_employee', achievedAt: '2026-11-10T09:41:00.000Z', sourceEventSeq: 101 },
    ]);
    const published = await achieved(scene);
    expect(published).toHaveLength(1);
    expect(published[0]?.payload).toEqual({ key: 'first_employee' });
  });

  it('idempotent: giao lại cùng sự kiện hay một sự kiện cùng loại khác không tạo bản ghi thứ hai và không phát lại', async () => {
    const scene = await h.newScene();
    const first = event(scene, 5, 'employee.created');
    await h.gamification.onDomainEvent(first);
    await h.gamification.onDomainEvent(first);
    await h.gamification.onDomainEvent(event(scene, 9, 'employee.created'));
    await Promise.all([
      h.gamification.onDomainEvent(first),
      h.gamification.onDomainEvent(event(scene, 12, 'employee.created')),
    ]);

    const list = await h.gamification.list(scene.ctx());
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ key: 'first_employee', sourceEventSeq: 5 });
    expect(await achieved(scene)).toHaveLength(1);
  });

  it('chỉ ba cột mốc được hỗ trợ, mỗi loại độc lập; list trả cũ nhất trước', async () => {
    const scene = await h.newScene();
    await h.gamification.onDomainEvent(
      event(scene, 30, 'task.status_changed', { from: 'awaiting_human_approval', to: 'completed' }),
    );
    await h.gamification.onDomainEvent(
      event(scene, 10, 'org_unit.created', { kind: 'department' }),
    );
    await h.gamification.onDomainEvent(event(scene, 20, 'employee.created'));

    expect((await h.gamification.list(scene.ctx())).map((m) => m.key)).toEqual([
      'first_department',
      'first_employee',
      'first_approved_task',
    ]);
  });

  it('sự kiện không liên quan hay phòng ban từ cơ cấu mẫu không tạo cột mốc', async () => {
    const scene = await h.newScene();
    for (const [seq, type, payload] of [
      [1, 'org_unit.created', { kind: 'department', fromTemplate: true }],
      [2, 'org_unit.created', { kind: 'division' }],
      [3, 'task.status_changed', { from: 'in_progress', to: 'in_review' }],
      [4, 'usage.updated', { tokensDelta: 9_999_999_999, costDelta: 1_000_000 }],
      [5, 'run.succeeded', { durationMs: 86_400_000 }],
    ] as const) {
      await h.gamification.onDomainEvent(event(scene, seq, type, { ...payload }));
    }
    expect(await h.gamification.list(scene.ctx())).toEqual([]);
    expect(await achieved(scene)).toEqual([]);
  });

  it('cô lập tenant: cột mốc của công ty này không xuất hiện ở công ty khác', async () => {
    const a = await h.newScene('Công ty A');
    const b = await h.newScene('Công ty B');
    await h.gamification.onDomainEvent(event(a, 1, 'employee.created'));
    expect(await h.gamification.list(a.ctx())).toHaveLength(1);
    expect(await h.gamification.list(b.ctx())).toEqual([]);

    // Công ty B vẫn đạt được cột mốc của riêng mình (UNIQUE theo cặp company + key, không toàn cục).
    await h.gamification.onDomainEvent(event(b, 1, 'employee.created'));
    expect(await h.gamification.list(b.ctx())).toHaveLength(1);
  });
});
