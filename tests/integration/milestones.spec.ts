import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DomainEvent } from '@claude-company/contracts';
import { withTenant } from '@claude-company/db';
import { domainEvent } from '@claude-company/db/schema/events';
import { milestone } from '@claude-company/db/schema/gamification';
import { eq } from 'drizzle-orm';
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
 * Cột mốc Achievement từ sự kiện thật qua outbox relay (T187; US8-AS1, AS2, FR-045, Q12). Engine thật trên PostgreSQL;
 * mỗi thao tác nghiệp vụ ghi `domain_event`, relay phát, Gamification Engine nhận và ghi cột mốc.
 */
describe('Integration: cột mốc gamification (US8)', () => {
  let infra: StartedInfra;
  let h: FlowHarness;

  beforeAll(async () => {
    infra = await startInfra({ redis: false });
    await prepareDatabase(infra);
    await seedDatabase(infra);
    // Số token rất lớn mỗi lượt: ngân sách được nới để run vẫn chạy, nhằm chứng minh token không sinh cột mốc.
    h = await createFlowHarness({
      infra,
      env: {
        DEFAULT_MONTHLY_TOKEN_LIMIT: '100000000000',
        DEFAULT_MONTHLY_COST_LIMIT_USD: '100000000',
      },
      fake: { usage: { inputTokens: 900_000, outputTokens: 50_000 } },
    });
  });

  afterAll(async () => {
    await h?.close();
    await infra?.stop();
  });

  const keys = async (scene: Scene) => (await h.gamification.list(scene.ctx())).map((m) => m.key);
  const rows = (scene: Scene) =>
    withTenant(scene.companyId, (tx) =>
      tx.select().from(milestone).where(eq(milestone.companyId, scene.companyId)),
    );
  const achievedEvents = (scene: Scene) =>
    withTenant(scene.companyId, (tx) =>
      tx.select().from(domainEvent).where(eq(domainEvent.type, 'milestone.achieved')),
    );

  it('AS1: công ty mới (kể cả phòng ban từ cơ cấu mẫu) chưa có cột mốc; tạo nhân viên đầu tiên → First Employee đúng một lần', async () => {
    const scene = await h.newScene();
    await h.settle();
    expect(await keys(scene)).toEqual([]); // template tự dựng phòng ban nhưng người dùng chưa làm gì

    await h.hire(scene);
    await h.settle();
    expect(await keys(scene)).toEqual(['first_employee']);

    await h.hire(scene, { name: 'AI Developer thứ hai' });
    await h.hire(scene, { name: 'AI Developer thứ ba' });
    await h.settle();
    expect(await keys(scene)).toEqual(['first_employee']);
    expect(await rows(scene)).toHaveLength(1);
    expect(await achievedEvents(scene)).toHaveLength(1);
  });

  it('cột mốc trỏ về sự kiện nguồn thật (employee.created) qua source_event_seq', async () => {
    const scene = await h.newScene();
    const dev = await h.hire(scene);
    await h.settle();
    const [row] = await rows(scene);
    const [source] = await withTenant(scene.companyId, (tx) =>
      tx.select().from(domainEvent).where(eq(domainEvent.seq, row!.sourceEventSeq)),
    );
    expect(source).toMatchObject({ type: 'employee.created', aggregateId: dev.id });
  });

  it('First Department: phòng ban người dùng tạo mới được tính; division thì không', async () => {
    const scene = await h.newScene();
    await h.org.upsertOrgUnit(scene.ctx(), { kind: 'division', name: 'Khối kinh doanh' });
    await h.settle();
    expect(await keys(scene)).toEqual([]);

    await h.org.upsertOrgUnit(scene.ctx(), {
      kind: 'department',
      name: 'Marketing',
      parentId: null,
    });
    await h.settle();
    expect(await keys(scene)).toEqual(['first_department']);

    await h.org.upsertOrgUnit(scene.ctx(), { kind: 'department', name: 'Sales', parentId: null });
    await h.settle();
    expect(await keys(scene)).toEqual(['first_department']);
  });

  it('First Approved Task: chỉ khi người thật phê duyệt, không phải khi run hoàn tất', async () => {
    const scene = await h.newScene();
    const manager = await h.hire(scene, managerProfile(scene));
    // messages_api: ngân sách giữ theo từng lượt nên usage lớn của FakeModelProvider không bị coi là vượt mức.
    const dev = await h.hire(scene, {
      runtimeKind: 'messages_api',
      manager: { kind: 'ai', id: manager.id },
    });
    const ctx = scene.humanCtx(scene.ceo.memberId);
    const task = await h.tasks.create(ctx, {
      title: 'Báo cáo',
      objective: 'Viết báo cáo phân tích yêu cầu',
      assignee: { kind: 'ai_employee', id: dev.id },
      deadline: '2027-12-31T00:00:00Z',
      priority: 'medium',
      acceptanceCriteria: ['Có báo cáo'],
      expectedOutput: 'Báo cáo',
    });
    await h.tasks.transition(ctx, task.id, 'assign');
    await h.settle();
    expect((await h.tasks.get(ctx, task.id)).status).toBe('awaiting_human_approval');
    expect(await keys(scene)).toEqual(['first_employee']); // chưa được duyệt nên chưa có cột mốc thứ hai

    await h.tasks.recordDecision(ctx, task.id, { decision: 'approve', reason: 'Đạt yêu cầu' });
    await h.settle();
    expect(await keys(scene)).toEqual(['first_employee', 'first_approved_task']);
  });

  it('AS2: nhân viên tiêu tốn rất nhiều token và chạy xong nhiều task không làm phát sinh cột mốc nào ngoài các sự kiện nghiệp vụ', async () => {
    const scene = await h.newScene();
    const manager = await h.hire(scene, managerProfile(scene));
    const dev = await h.hire(scene, {
      runtimeKind: 'messages_api',
      manager: { kind: 'ai', id: manager.id },
    });
    const ctx = scene.humanCtx(scene.ceo.memberId);
    for (let i = 0; i < 3; i += 1) {
      const task = await h.tasks.create(ctx, {
        title: `Việc nặng ${i}`,
        objective: 'Phân tích dữ liệu lớn',
        assignee: { kind: 'ai_employee', id: dev.id },
        deadline: '2027-12-31T00:00:00Z',
        priority: 'medium',
        acceptanceCriteria: ['Có kết quả'],
        expectedOutput: 'Báo cáo',
      });
      await h.tasks.transition(ctx, task.id, 'assign');
    }
    await h.settle();

    const usage = await h.budget.getUsage(scene.ctx(), { period: 'all' });
    expect(usage.tokens).toBeGreaterThan(1_000_000); // đã tiêu rất nhiều token thật
    // Chỉ có First Employee (từ việc tuyển người). Không task nào được người thật duyệt nên không có cột mốc nào khác.
    expect(await keys(scene)).toEqual(['first_employee']);
    // Cả ba task đã chạy xong tới bước chờ người duyệt, nhưng chưa task nào được duyệt.
    const waiting = await h.tasks.list(scene.humanCtx(scene.ceo.memberId), {
      statusIn: ['awaiting_human_approval'],
    });
    expect(waiting.items).toHaveLength(3);
  });

  it('phát lại cùng sự kiện nguồn (relay giao lại) không tạo bản ghi thứ hai', async () => {
    const scene = await h.newScene();
    await h.hire(scene);
    await h.settle();
    const sources = await withTenant(scene.companyId, (tx) =>
      tx.select().from(domainEvent).where(eq(domainEvent.type, 'employee.created')),
    );
    const replay: DomainEvent = {
      id: sources[0]!.id,
      companyId: scene.companyId,
      seq: sources[0]!.seq,
      type: sources[0]!.type,
      aggregateKind: sources[0]!.aggregateKind,
      aggregateId: sources[0]!.aggregateId,
      payload: sources[0]!.payload,
      occurredAt: sources[0]!.occurredAt.toISOString(),
    };
    await h.gamification.onDomainEvent(replay);
    await h.gamification.onDomainEvent(replay);
    expect(await rows(scene)).toHaveLength(1);
    expect(await achievedEvents(scene)).toHaveLength(1);
  });
});
