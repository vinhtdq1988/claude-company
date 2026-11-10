import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OfficeSimulationService } from '../../apps/api/src/engines/office-simulation/office-simulation.service';
import {
  prepareDatabase,
  seedDatabase,
  startInfra,
  type StartedInfra,
} from '../support/containers';
import { createFlowHarness, type FlowHarness } from '../support/flow-harness';
import {
  assignTo,
  domainEvents,
  officeTeam,
  statusChanges,
  statusRow,
} from '../support/office-fixtures';

/**
 * SC-006 (T147): đối chiếu trạng thái Virtual Office với nhật ký thực thi. 50 lần chuyển trạng thái đều có
 * `source_event_seq` trỏ tới một `domain_event` thật, đúng loại; không có sự kiện thì nhân viên giữ `idle`;
 * không có animation/trạng thái nào xuất hiện mà thiếu sự kiện nguồn (Nguyên tắc I, IV).
 */
describe('Integration: đối chiếu trạng thái office với sự kiện thật (T147; SC-006)', () => {
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

  it('50 lần chuyển trạng thái, mỗi lần có source_event_seq trỏ tới domain_event thật đúng loại', async () => {
    const t = await officeTeam(h);
    await h.settle();
    const before = (await statusChanges(t.scene.companyId, t.dev.id)).length;

    const ctx = t.scene.humanCtx(t.scene.ceo.memberId);
    for (let i = 0; i < 25; i += 1) {
      await h.employees.suspend(ctx, t.dev.id);
      await h.settle();
      await h.employees.resume(ctx, t.dev.id);
      await h.settle();
    }

    const events = new Map((await domainEvents(t.scene.companyId)).map((e) => [e.seq, e]));
    const changes = (await statusChanges(t.scene.companyId, t.dev.id)).slice(before);
    expect(changes).toHaveLength(50);
    for (const [i, change] of changes.entries()) {
      const source = events.get(change.seq);
      expect(source, `thiếu domain_event seq ${change.seq}`).toBeDefined();
      expect(source?.type).toBe(change.sourceEventType);
      expect(source?.type).toBe(i % 2 === 0 ? 'employee.suspended' : 'employee.resumed');
      expect(change.state).toBe(i % 2 === 0 ? 'break' : 'idle');
      expect(change.previousState).toBe(i % 2 === 0 ? 'idle' : 'break');
    }
    // Seq của nguồn tăng dần: không đảo thứ tự.
    expect(changes.map((c) => c.seq)).toEqual([...changes.map((c) => c.seq)].sort((a, b) => a - b));
    expect((await statusRow(t.scene.companyId, t.dev.id))?.sourceEventSeq).toBe(
      changes.at(-1)?.seq,
    );
  });

  it('không có sự kiện thì giữ idle: không hàng trạng thái, không bản ghi đổi trạng thái', async () => {
    const t = await officeTeam(h);
    await h.settle();
    await h.relay.tick();
    await h.settle();
    expect(await statusChanges(t.scene.companyId)).toEqual([]);
    for (const e of [t.manager, t.dev, t.ba])
      expect(await statusRow(t.scene.companyId, e.id)).toBeUndefined();
    const snap = await h.office.getSnapshot(t.scene.humanCtx(t.scene.ceo.memberId));
    expect(snap.employees.map((e) => e.state)).toEqual(['idle', 'idle', 'idle']);
  });

  it('chạy một task thật: mọi trạng thái đều từ run/task/approval thật; completed → idle qua sự kiện server phát', async () => {
    const t = await officeTeam(h);
    await assignTo(h, t, t.ba.id);
    // Giữ job hết hạn `completed` lại để quan sát trạng thái đang hiển thị.
    await h.settleExcept(['office.completed-elapsed']);

    const events = new Map((await domainEvents(t.scene.companyId)).map((e) => [e.seq, e]));
    const changes = await statusChanges(t.scene.companyId);
    expect(changes.length).toBeGreaterThan(0);
    for (const c of changes) {
      const source = events.get(c.seq);
      expect(source?.type).toBe(c.sourceEventType);
    }
    const ba = changes.filter((c) => c.aiEmployeeId === t.ba.id).map((c) => c.state);
    expect(ba).toContain('working');
    expect(ba.at(-1)).toBe('completed');
    // AI Manager xác nhận/review task: communicating, và chỉ khi có run tương ứng.
    const manager = changes.filter((c) => c.aiEmployeeId === t.manager.id);
    expect(
      manager.some((c) => c.state === 'communicating' && c.sourceEventType === 'run.started'),
    ).toBe(true);

    // Còn `completed` đúng cho tới khi job 60 giây ghi sự kiện hết hạn.
    expect((await statusRow(t.scene.companyId, t.ba.id))?.state).toBe('completed');
    await h.settle();
    const row = await statusRow(t.scene.companyId, t.ba.id);
    expect(row?.state).toBe('idle');
    const last = (await statusChanges(t.scene.companyId, t.ba.id)).at(-1);
    expect(last).toMatchObject({ state: 'idle', previousState: 'completed' });
    expect(last?.sourceEventType).toBe('office.completed_display_elapsed');
  });

  it('chiếu lại các sự kiện đã áp (relay giao lại) không đổi trạng thái hay nhật ký', async () => {
    const t = await officeTeam(h);
    await assignTo(h, t, t.ba.id);
    await h.settle();
    const first = await h.office.getSnapshot(t.scene.humanCtx(t.scene.ceo.memberId));
    const logBefore = await statusChanges(t.scene.companyId);
    // Relay giao ít nhất một lần: chiếu lại sự kiện đã áp phải idempotent.
    const service = h.app.get(OfficeSimulationService, { strict: false });
    for (const e of await domainEvents(t.scene.companyId)) await service.project(e);
    const second = await h.office.getSnapshot(t.scene.humanCtx(t.scene.ceo.memberId));
    expect(second).toEqual(first);
    expect(await statusChanges(t.scene.companyId)).toEqual(logBefore);
  });
});
