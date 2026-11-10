import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NotificationType, RoutedNotification } from '@claude-company/contracts';
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
 * Quy tắc người nhận thông báo FR-041 (T082a): từng loại notification tới đúng người nhận;
 * phạm vi không có manager hoặc người nhận bị vô hiệu thì gửi CEO. Engine thật trên PostgreSQL (RLS bật).
 */
describe('Integration: định tuyến người nhận thông báo (FR-041)', () => {
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

  /** Công ty có một Manager quản lý Development; AI Developer báo cáo cho Manager đó; task do Manager giao. */
  async function setup() {
    const scene = await h.newScene();
    const manager = await h.addManager(scene);
    await h.org.assignManager(
      scene.ctx(),
      { kind: 'org_unit', id: scene.units.Development! },
      manager.memberId,
    );
    const dev = await h.hire(scene, { manager: { kind: 'human', id: manager.memberId } });
    const task = await h.tasks.create(scene.humanCtx(manager.memberId), {
      title: 'Việc của manager',
      objective: 'Mục tiêu',
      assignee: { kind: 'ai_employee', id: dev.id },
      deadline: '2027-12-31T00:00:00Z',
      priority: 'medium',
      acceptanceCriteria: ['Có kết quả'],
      expectedOutput: 'Báo cáo',
    });
    return { scene, manager, dev, task };
  }

  const route = async (scene: Scene, n: RoutedNotification) =>
    (await h.communication.notifyRouted(scene.ctx(), n)).recipientMemberId;

  it('task_completed, task_error, task_overdue, budget_blocked, escalation → người giao task', async () => {
    const { scene, manager, task } = await setup();
    const types: NotificationType[] = [
      'task_completed',
      'task_error',
      'task_overdue',
      'budget_blocked',
      'escalation',
    ];
    for (const type of types) {
      const recipient = await route(scene, { type, title: type, taskId: task.id });
      expect(recipient, type).toBe(manager.memberId);
      expect(recipient, type).not.toBe(scene.ceo.memberId);
    }
  });

  it('approval_needed → người duyệt của approval request', async () => {
    const { scene, manager } = await setup();
    expect(
      await route(scene, {
        type: 'approval_needed',
        title: 'Cần duyệt',
        approverMemberId: manager.memberId,
      }),
    ).toBe(manager.memberId);
    expect(
      await route(scene, {
        type: 'approval_needed',
        title: 'Cần duyệt',
        approverMemberId: scene.ceo.memberId,
      }),
    ).toBe(scene.ceo.memberId);
  });

  it('overload_warning → người thật cuối chuỗi quản lý của nhân viên quá tải', async () => {
    const { scene, manager, dev } = await setup();
    expect(
      await route(scene, { type: 'overload_warning', title: 'Quá tải', employeeId: dev.id }),
    ).toBe(manager.memberId);
    // Nhân viên báo cáo qua AI Manager: vẫn tới người thật cuối chuỗi.
    const aiManager = await h.hire(
      scene,
      managerProfile(scene, { manager: { kind: 'human', id: manager.memberId } }),
    );
    const report = await h.hire(scene, {
      name: 'AI Dev 2',
      manager: { kind: 'ai', id: aiManager.id },
    });
    expect(
      await route(scene, { type: 'overload_warning', title: 'Quá tải', employeeId: report.id }),
    ).toBe(manager.memberId);
  });

  it('budget_warning → manager của phạm vi: CEO với công ty, người thật cuối chuỗi với nhân viên, manager đơn vị', async () => {
    const { scene, manager, dev } = await setup();
    const warn = (scope: RoutedNotification['scope']) =>
      route(scene, { type: 'budget_warning', title: 'Ngân sách', scope });
    expect(await warn({ kind: 'company', id: scene.companyId })).toBe(scene.ceo.memberId);
    expect(await warn({ kind: 'ai_employee', id: dev.id })).toBe(manager.memberId);
    expect(await warn({ kind: 'org_unit', id: scene.units.Development! })).toBe(manager.memberId);
  });

  it('budget_warning: phạm vi không có manager → CEO', async () => {
    const { scene } = await setup();
    // BA chưa được gán manager.
    expect(
      await route(scene, {
        type: 'budget_warning',
        title: 'Ngân sách',
        scope: { kind: 'org_unit', id: scene.units.BA! },
      }),
    ).toBe(scene.ceo.memberId);
  });

  it('thiếu ngữ cảnh để chọn người nhận (không có task/người duyệt/nhân viên) → CEO', async () => {
    const { scene } = await setup();
    for (const type of ['task_completed', 'approval_needed', 'overload_warning'] as const) {
      expect(await route(scene, { type, title: type }), type).toBe(scene.ceo.memberId);
    }
  });

  it('người nhận bị vô hiệu → CEO', async () => {
    const { scene, manager, task } = await setup();
    // Gỡ Manager khỏi mọi vị trí quản lý để có thể vô hiệu hóa.
    await h.org.assignManager(
      scene.ctx(),
      { kind: 'org_unit', id: scene.units.Development! },
      scene.ceo.memberId,
    );
    await h.employees.update(scene.ctx(), task.assigneeId, {
      manager: { kind: 'human', id: scene.ceo.memberId },
    });
    await h.employees.deactivateHumanMember(scene.ctx(), manager.memberId);

    expect(await route(scene, { type: 'task_error', title: 'Lỗi', taskId: task.id })).toBe(
      scene.ceo.memberId,
    );
    expect(
      await route(scene, {
        type: 'approval_needed',
        title: 'Duyệt',
        approverMemberId: manager.memberId,
      }),
    ).toBe(scene.ceo.memberId);
  });

  it('thông báo được lưu cho đúng người nhận và người khác không thấy', async () => {
    const { scene, manager, task } = await setup();
    const created = await h.communication.notifyRouted(scene.ctx(), {
      type: 'task_completed',
      title: 'Xong',
      taskId: task.id,
    });
    const mine = await h.communication.listNotifications(
      scene.humanCtx(manager.memberId),
      manager.memberId,
      {},
    );
    expect(mine.items.map((n) => n.id)).toContain(created.id);
    const ceos = await h.communication.listNotifications(
      scene.humanCtx(scene.ceo.memberId),
      scene.ceo.memberId,
      {},
    );
    expect(ceos.items.map((n) => n.id)).not.toContain(created.id);
  });
});
