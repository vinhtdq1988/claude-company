import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EmployeeProfile, Task } from '@claude-company/contracts';
import {
  prepareDatabase,
  seedDatabase,
  startInfra,
  type StartedInfra,
} from '../support/containers';
import { createFlowHarness, type FlowHarness, type Scene } from '../support/flow-harness';

/**
 * Contract test `CommunicationEngine` và `MemoryEngine` (T082; Nguyên tắc VI, FR-013, FR-022, FR-041, R11).
 * Chạy với engine thật trên PostgreSQL (RLS bật); Redis/BullMQ/S3 là bản trong bộ nhớ.
 */
describe('Contract: CommunicationEngine và MemoryEngine (T082)', () => {
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

  async function draftTask(scene: Scene, assigneeId: string): Promise<Task> {
    return h.tasks.create(scene.humanCtx(scene.ceo.memberId), {
      title: 'Việc thử',
      objective: 'Mục tiêu thử',
      assignee: { kind: 'ai_employee', id: assigneeId },
      deadline: '2027-12-31T00:00:00Z',
      priority: 'medium',
      acceptanceCriteria: ['Có kết quả'],
      expectedOutput: 'Báo cáo',
    });
  }

  describe('CommunicationEngine — tin nhắn gắn task (FR-022)', () => {
    it('postTaskMessage lưu tin nhắn của người thật gắn đúng task, listTaskMessages trả theo thứ tự', async () => {
      const scene = await h.newScene();
      const dev = await h.hire(scene);
      const task = await draftTask(scene, dev.id);
      const other = await draftTask(scene, dev.id);
      const ctx = scene.humanCtx(scene.ceo.memberId);

      const first = await h.communication.postTaskMessage(
        ctx,
        task.id,
        '  Hãy ưu tiên phần rủi ro  ',
      );
      const second = await h.communication.postTaskMessage(ctx, task.id, 'Thêm ví dụ');
      await h.communication.postTaskMessage(ctx, other.id, 'Tin của task khác');

      expect(first).toMatchObject({
        taskId: task.id,
        authorKind: 'human',
        authorId: scene.ceo.memberId,
        body: 'Hãy ưu tiên phần rủi ro',
        agentRunId: null,
      });
      const list = await h.communication.listTaskMessages(ctx, task.id);
      expect(list.map((m) => m.id)).toEqual([first.id, second.id]);
    });

    it('tin nhắn của AI Employee ghi author_kind=ai kèm run', async () => {
      const scene = await h.newScene();
      const dev = await h.hire(scene);
      const task = await draftTask(scene, dev.id);
      const runId = randomUUID();
      const message = await h.communication.postTaskMessage(
        scene.ctx({ kind: 'ai', employeeId: dev.id, runId }),
        task.id,
        'Đã hoàn thành phần 1',
      );
      expect(message).toMatchObject({ authorKind: 'ai', authorId: dev.id, agentRunId: runId });
    });

    it('từ chối nội dung rỗng (VALIDATION_FAILED) và tác nhân hệ thống (FORBIDDEN)', async () => {
      const scene = await h.newScene();
      const dev = await h.hire(scene);
      const task = await draftTask(scene, dev.id);
      await expect(
        h.communication.postTaskMessage(scene.humanCtx(scene.ceo.memberId), task.id, '   '),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(
        h.communication.postTaskMessage(scene.ctx(), task.id, 'Tin từ hệ thống'),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('không có chat tự do: tin nhắn tới task không tồn tại bị từ chối', async () => {
      const scene = await h.newScene();
      await expect(
        h.communication.postTaskMessage(scene.humanCtx(scene.ceo.memberId), randomUUID(), 'Lạc đề'),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('tin nhắn công ty khác không đọc được qua task id của công ty này (RLS)', async () => {
      const a = await h.newScene('Công ty A');
      const b = await h.newScene('Công ty B');
      const dev = await h.hire(a);
      const task = await draftTask(a, dev.id);
      await h.communication.postTaskMessage(a.humanCtx(a.ceo.memberId), task.id, 'Bí mật của A');
      expect(await h.communication.listTaskMessages(b.humanCtx(b.ceo.memberId), task.id)).toEqual(
        [],
      );
    });
  });

  describe('CommunicationEngine — thông báo (FR-041)', () => {
    it('notify lưu notification chưa đọc và phát notification.created tới user:{memberId}', async () => {
      const scene = await h.newScene();
      h.redis.published.length = 0;
      const created = await h.communication.notify(scene.ctx(), scene.ceo.memberId, {
        type: 'budget_warning',
        title: 'Sắp hết ngân sách',
        body: 'Đã dùng 80%',
      });
      expect(created).toMatchObject({
        recipientMemberId: scene.ceo.memberId,
        type: 'budget_warning',
        title: 'Sắp hết ngân sách',
        readAt: null,
      });
      await h.relay.tick();
      const sent = h.redis.published
        .map((m) => m)
        .filter((m) => m.includes('notification.created'));
      expect(sent.length).toBeGreaterThan(0);
      expect(
        sent.some((m) => m.includes(`user:${scene.ceo.memberId}`) || m.includes(created.id)),
      ).toBe(true);
    });

    it('listNotifications lọc chưa đọc, chỉ trả thông báo của người nhận, phân trang bằng cursor', async () => {
      const scene = await h.newScene();
      const manager = await h.addManager(scene);
      for (let i = 0; i < 5; i += 1) {
        await h.communication.notify(scene.ctx(), scene.ceo.memberId, {
          type: 'escalation',
          title: `Tin ${i}`,
        });
      }
      await h.communication.notify(scene.ctx(), manager.memberId, {
        type: 'escalation',
        title: 'Của manager',
      });

      const ctx = scene.humanCtx(scene.ceo.memberId);
      const page1 = await h.communication.listNotifications(ctx, scene.ceo.memberId, { limit: 2 });
      expect(page1.items).toHaveLength(2);
      expect(page1.nextCursor).not.toBeNull();
      const page2 = await h.communication.listNotifications(ctx, scene.ceo.memberId, {
        limit: 10,
        cursor: page1.nextCursor!,
      });
      expect(page2.items).toHaveLength(3);
      expect(page2.nextCursor).toBeNull();
      const ids = [...page1.items, ...page2.items].map((n) => n.id);
      expect(new Set(ids).size).toBe(5);
      expect(
        [...page1.items, ...page2.items].every((n) => n.recipientMemberId === scene.ceo.memberId),
      ).toBe(true);
    });

    it('markRead đánh dấu một thông báo; markAllRead trả số thông báo vừa đọc; lọc unread phản ánh đúng', async () => {
      const scene = await h.newScene();
      const ctx = scene.humanCtx(scene.ceo.memberId);
      const a = await h.communication.notify(scene.ctx(), scene.ceo.memberId, {
        type: 'task_error',
        title: 'A',
      });
      await h.communication.notify(scene.ctx(), scene.ceo.memberId, {
        type: 'task_error',
        title: 'B',
      });
      await h.communication.notify(scene.ctx(), scene.ceo.memberId, {
        type: 'task_error',
        title: 'C',
      });

      await h.communication.markRead(ctx, scene.ceo.memberId, a.id);
      const unread = await h.communication.listNotifications(ctx, scene.ceo.memberId, {
        unread: true,
      });
      expect(unread.items.map((n) => n.title).sort()).toEqual(['B', 'C']);

      expect(await h.communication.markAllRead(ctx, scene.ceo.memberId)).toBe(2);
      expect(await h.communication.markAllRead(ctx, scene.ceo.memberId)).toBe(0);
      const all = await h.communication.listNotifications(ctx, scene.ceo.memberId, {});
      expect(all.items.every((n) => n.readAt !== null)).toBe(true);
    });

    it('markRead của thông báo thuộc người khác hoặc không tồn tại → NOT_FOUND', async () => {
      const scene = await h.newScene();
      const manager = await h.addManager(scene);
      const mine = await h.communication.notify(scene.ctx(), scene.ceo.memberId, {
        type: 'task_error',
        title: 'Của CEO',
      });
      await expect(
        h.communication.markRead(scene.humanCtx(manager.memberId), manager.memberId, mine.id),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        h.communication.markRead(
          scene.humanCtx(scene.ceo.memberId),
          scene.ceo.memberId,
          randomUUID(),
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('notifyRouted chọn người nhận rồi lưu thông báo cho người đó', async () => {
      const scene = await h.newScene();
      const manager = await h.addManager(scene);
      const routed = await h.communication.notifyRouted(scene.ctx(), {
        type: 'approval_needed',
        title: 'Cần duyệt',
        approverMemberId: manager.memberId,
      });
      expect(routed.recipientMemberId).toBe(manager.memberId);
    });
  });

  describe('MemoryEngine (FR-013, R11)', () => {
    async function setup(): Promise<{ scene: Scene; dev: EmployeeProfile; ba: EmployeeProfile }> {
      const scene = await h.newScene();
      const dev = await h.hire(scene);
      const ba = await h.hire(scene, {
        name: 'AI BA',
        position: 'AI Business Analyst',
        homeOrgUnitId: scene.units.BA!,
      });
      return { scene, dev, ba };
    }

    const scopeOf = (employeeId: string) => ({ employeeId, taskId: randomUUID() });

    it('remember rồi recall theo scope ai_employee; mới nhất trước; tôn trọng limit', async () => {
      const { scene, dev } = await setup();
      for (const content of ['Một', 'Hai', 'Ba']) {
        await h.memory.remember(scene.ctx(), {
          ownerScopeKind: 'ai_employee',
          ownerScopeId: dev.id,
          kind: 'note',
          content,
        });
      }
      const all = await h.memory.recall(scene.ctx(), scopeOf(dev.id), 10);
      expect(all.map((m) => m.content)).toEqual(['Ba', 'Hai', 'Một']);
      expect(await h.memory.recall(scene.ctx(), scopeOf(dev.id), 2)).toHaveLength(2);
      expect(await h.memory.recall(scene.ctx(), scopeOf(dev.id), 0)).toEqual([]);
    });

    it('chỉ trả ký ức trong scope của nhân viên: bản thân và đơn vị chứa nó, không phải nhân viên/đơn vị khác', async () => {
      const { scene, dev, ba } = await setup();
      const put = (kind: 'ai_employee' | 'org_unit', id: string, content: string) =>
        h.memory.remember(scene.ctx(), {
          ownerScopeKind: kind,
          ownerScopeId: id,
          kind: 'note',
          content,
        });
      await put('ai_employee', dev.id, 'riêng của dev');
      await put('ai_employee', ba.id, 'riêng của ba');
      await put('org_unit', scene.units.Development!, 'của phòng Development');
      await put('org_unit', scene.units.BA!, 'của phòng BA');

      const forDev = (await h.memory.recall(scene.ctx(), scopeOf(dev.id), 20)).map(
        (m) => m.content,
      );
      expect(forDev.sort()).toEqual(['của phòng Development', 'riêng của dev']);
      const forBa = (await h.memory.recall(scene.ctx(), scopeOf(ba.id), 20)).map((m) => m.content);
      expect(forBa.sort()).toEqual(['của phòng BA', 'riêng của ba']);
    });

    it('share_rule liệt kê scope thì chia sẻ cho scope đó, share_rule null thì không', async () => {
      const { scene, dev, ba } = await setup();
      await h.memory.remember(scene.ctx(), {
        ownerScopeKind: 'ai_employee',
        ownerScopeId: dev.id,
        kind: 'note',
        content: 'chia sẻ cho BA',
        shareRule: { scopes: [{ kind: 'ai_employee', id: ba.id }] },
      });
      await h.memory.remember(scene.ctx(), {
        ownerScopeKind: 'ai_employee',
        ownerScopeId: dev.id,
        kind: 'note',
        content: 'không chia sẻ',
        shareRule: null,
      });
      const forBa = (await h.memory.recall(scene.ctx(), scopeOf(ba.id), 20)).map((m) => m.content);
      expect(forBa).toEqual(['chia sẻ cho BA']);
    });

    it('cùng task tóm tắt hai lần (sự kiện giao lại) chỉ lưu một bản', async () => {
      const { scene, dev } = await setup();
      const task = await draftTask(scene, dev.id);
      const entry = {
        ownerScopeKind: 'ai_employee' as const,
        ownerScopeId: dev.id,
        sourceTaskId: task.id,
        kind: 'task_summary' as const,
        content: 'Tóm tắt task',
      };
      await h.memory.remember(scene.ctx(), entry);
      await h.memory.remember(scene.ctx(), entry);
      const recalled = await h.memory.recall(scene.ctx(), scopeOf(dev.id), 10);
      expect(recalled.filter((m) => m.sourceTaskId === task.id)).toHaveLength(1);
    });

    it('từ chối nội dung rỗng (VALIDATION_FAILED)', async () => {
      const { scene, dev } = await setup();
      await expect(
        h.memory.remember(scene.ctx(), {
          ownerScopeKind: 'ai_employee',
          ownerScopeId: dev.id,
          kind: 'note',
          content: '   ',
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });
  });
});
