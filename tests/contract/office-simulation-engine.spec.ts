import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainError, type DomainEvent } from '@claude-company/contracts';
import {
  applyEvent,
  initialEmployeeState,
} from '../../apps/api/src/engines/office-simulation/office-reducer';
import {
  prepareDatabase,
  seedDatabase,
  startInfra,
  type StartedInfra,
} from '../support/containers';
import { createFlowHarness, type FlowHarness } from '../support/flow-harness';
import { assignTo, domainEvents, officeTeam, statusChanges } from '../support/office-fixtures';

/**
 * Contract test `OfficeSimulationEngine` (T145; FR-034, FR-038, SC-006, Nguyên tắc IV, VI): `apply` là reducer thuần,
 * `getSnapshot` chỉ gồm nhân viên trong phạm vi người xem, `getProfileView` đủ mục FR-038, `completeDisplayElapsed`
 * idempotent. Engine thật trên PostgreSQL (RLS bật).
 */
describe('Contract: OfficeSimulationEngine (T145)', () => {
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

  const event = (seq: number, type: string, payload: Record<string, unknown>): DomainEvent => ({
    id: randomUUID(),
    companyId: randomUUID(),
    seq,
    type,
    aggregateKind: 'agent_run',
    aggregateId: randomUUID(),
    payload,
    occurredAt: new Date().toISOString(),
  });

  describe('apply (reducer thuần)', () => {
    it('cùng đầu vào cho cùng kết quả, không đọc DB hay đồng hồ', () => {
      const e = event(1, 'run.started', {
        runId: 'r',
        taskId: 't',
        employeeId: 'e1',
        purpose: 'execute',
      });
      expect(h.office.apply(e)).toEqual(h.office.apply(e));
      expect(h.office.apply(e)).toMatchObject({
        employeeId: 'e1',
        state: 'working',
        previousState: 'idle',
      });
    });

    it('sự kiện không liên quan hoặc đã áp thì trả null', () => {
      expect(h.office.apply(event(1, 'task.created', {}))).toBeNull();
      const e = event(5, 'run.started', {
        runId: 'r',
        taskId: 't',
        employeeId: 'e1',
        purpose: 'execute',
      });
      const first = applyEvent(e, initialEmployeeState('e1'));
      expect(h.office.apply(e, first?.next)).toBeNull();
    });
  });

  describe('getSnapshot', () => {
    it('mỗi department một zone cùng CEO Office và Break Room; nhân viên ở đúng zone, bàn theo thứ tự', async () => {
      const t = await officeTeam(h);
      await h.settle();
      const snap = await h.office.getSnapshot(t.scene.humanCtx(t.scene.ceo.memberId));

      const kinds = snap.zones.map((z) => z.kind);
      expect(kinds).toContain('ceo_office');
      expect(kinds).toContain('break_room');
      const names = snap.zones.filter((z) => z.kind === 'department').map((z) => z.name);
      expect(names).toEqual(expect.arrayContaining(['Development', 'BA', 'QA']));

      const zoneOf = (id: string) =>
        snap.zones.find((z) => z.id === snap.employees.find((e) => e.id === id)?.zoneId);
      expect(zoneOf(t.dev.id)?.orgUnitId).toBe(t.scene.units.Development);
      expect(zoneOf(t.ba.id)?.orgUnitId).toBe(t.scene.units.BA);
      // Manager và Dev cùng Development: bàn theo thứ tự tạo (manager tạo trước).
      const desks = snap.employees
        .filter((e) => zoneOf(e.id)?.orgUnitId === t.scene.units.Development)
        .sort((a, b) => a.deskIndex - b.deskIndex)
        .map((e) => e.id);
      expect(desks).toEqual([t.manager.id, t.dev.id].sort());
      expect(snap.employees.every((e) => e.state === 'idle')).toBe(true);
    });

    it('seq của snapshot đã bao trùm mọi sự kiện đã chiếu', async () => {
      const t = await officeTeam(h);
      const task = await assignTo(h, t, t.dev.id);
      await h.settle();
      const snap = await h.office.getSnapshot(t.scene.humanCtx(t.scene.ceo.memberId));
      const events = await domainEvents(t.scene.companyId);
      expect(snap.seq).toBe(events.at(-1)?.seq);
      expect(task.id).toBeTruthy();
    });

    it('chỉ gồm nhân viên trong phạm vi người xem; Manager không có phạm vi chỉ thấy zone cố định', async () => {
      const t = await officeTeam(h);
      const outsider = await h.addManager(t.scene);
      await h.settle();
      const snap = await h.office.getSnapshot(t.scene.humanCtx(outsider.memberId));
      expect(snap.employees).toEqual([]);
      expect(snap.zones.every((z) => z.kind !== 'department')).toBe(true);
    });

    it('tác nhân AI không xem được office', async () => {
      const t = await officeTeam(h);
      await expect(
        h.office.getSnapshot(
          t.scene.ctx({ kind: 'ai', employeeId: t.dev.id, runId: randomUUID() }),
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
  });

  describe('trạng thái theo sự kiện thật (SC-006)', () => {
    it('mỗi lần đổi trạng thái ghi `employee_status_change` với seq trỏ tới domain_event có thật', async () => {
      const t = await officeTeam(h);
      await assignTo(h, t, t.dev.id);
      await h.settle();
      const changes = await statusChanges(t.scene.companyId);
      const seqs = new Set((await domainEvents(t.scene.companyId)).map((e) => e.seq));
      expect(changes.length).toBeGreaterThan(0);
      for (const c of changes) expect(seqs.has(c.seq)).toBe(true);
    });
  });

  describe('getProfileView (FR-038)', () => {
    it('nhân viên mới: idle, chưa có task, chi phí 0, không vướng mắc', async () => {
      const t = await officeTeam(h);
      await h.settle();
      const view = await h.office.getProfileView(t.scene.humanCtx(t.scene.ceo.memberId), t.dev.id);
      expect(view.employee).toMatchObject({ id: t.dev.id, name: t.dev.name, kind: 'employee' });
      expect(view.status.state).toBe('idle');
      expect(view.currentTask).toBeNull();
      expect(view.currentTool).toBeNull();
      expect(view.recentMessages).toEqual([]);
      expect(view.latestResults).toEqual([]);
      expect(view.reviewHistory).toEqual([]);
      expect(view.blockers).toEqual([]);
      expect(view.usage.month.tokens).toBe(0);
      expect(view.usage.total.costUsd).toBe(0);
    });

    it('sau khi task chạy xong: có kết quả, lịch sử review, chi phí và trao đổi', async () => {
      const t = await officeTeam(h);
      const task = await assignTo(h, t, t.ba.id);
      await h.settle();
      const view = await h.office.getProfileView(t.scene.humanCtx(t.scene.ceo.memberId), t.ba.id);
      expect(view.latestResults.some((r) => r.taskId === task.id)).toBe(true);
      expect(view.reviewHistory.some((r) => r.taskId === task.id && r.stage === 'ai_review')).toBe(
        true,
      );
      expect(view.usage.total.tokens).toBeGreaterThan(0);
      expect(view.usage.month.tokens).toBeLessThanOrEqual(view.usage.total.tokens);
    });

    it('nhân viên không tồn tại → NOT_FOUND', async () => {
      const t = await officeTeam(h);
      await expect(
        h.office.getProfileView(t.scene.humanCtx(t.scene.ceo.memberId), randomUUID()),
      ).rejects.toBeInstanceOf(DomainError);
    });
  });

  describe('completeDisplayElapsed', () => {
    it('không còn lần completed khớp thì trả false và không ghi sự kiện', async () => {
      const t = await officeTeam(h);
      await h.settle();
      const before = (await domainEvents(t.scene.companyId)).length;
      const ok = await h.office.completeDisplayElapsed(t.scene.ctx(), {
        employeeId: t.dev.id,
        taskId: randomUUID(),
        sinceSeq: 1,
      });
      expect(ok).toBe(false);
      expect((await domainEvents(t.scene.companyId)).length).toBe(before);
    });
  });
});
