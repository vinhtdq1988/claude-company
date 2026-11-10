import { describe, expect, it } from 'vitest';
import type { OfficeEmployee, OfficeSnapshot, RealtimeEnvelope } from '@claude-company/contracts';
import { OfficeStore } from '../src/office/state/office-store';
import { officeBounds, placeEmployees } from '../src/office/state/placement';

const zone = (
  id: string,
  kind: 'department' | 'ceo_office' | 'break_room',
  x: number,
  y: number,
) => ({
  id,
  kind,
  name: id,
  orgUnitId: kind === 'department' ? `ou-${id}` : null,
  layout: { x, y, cols: 9, rows: 6 },
});

const emp = (
  id: string,
  zoneId: string,
  deskIndex: number,
  patch: Partial<OfficeEmployee> = {},
): OfficeEmployee => ({
  id,
  name: id,
  avatarKey: 'developer',
  zoneId,
  deskIndex,
  state: 'idle',
  currentTaskId: null,
  currentTool: null,
  progress: null,
  ...patch,
});

const snapshot = (seq = 10): OfficeSnapshot => ({
  seq,
  zones: [zone('dev', 'department', 0, 0), zone('break', 'break_room', 10, 0)],
  employees: [emp('a', 'dev', 0), emp('b', 'dev', 1)],
});

const env = (seq: number, type: string, payload: unknown): RealtimeEnvelope<unknown> => ({
  seq,
  companyId: 'c1',
  type,
  occurredAt: '2026-11-10T00:00:00.000Z',
  payload,
});
const status = (
  seq: number,
  employeeId: string,
  state: string,
  extra: Record<string, unknown> = {},
) =>
  env(seq, 'office.employee_status_changed', {
    employeeId,
    state,
    previousState: 'idle',
    sourceEventType: 'run.started',
    ...extra,
  });

describe('OfficeStore (T149)', () => {
  it('nạp snapshot: có seq, zone và nhân viên; không stale', () => {
    const store = new OfficeStore();
    store.loadSnapshot(snapshot(10));
    const s = store.getState();
    expect(s).toMatchObject({ loaded: true, seq: 10, snapshotSeq: 10, stale: false });
    expect(Object.keys(s.employees)).toEqual(['a', 'b']);
  });

  it('chưa có snapshot thì bỏ qua mọi sự kiện', () => {
    const store = new OfficeStore();
    expect(store.apply(status(1, 'a', 'working'))).toBe('ignored');
  });

  it('áp sự kiện trạng thái theo thứ tự và tiến seq', () => {
    const store = new OfficeStore();
    store.loadSnapshot(snapshot(10));
    expect(
      store.apply(
        status(11, 'a', 'working', { currentTaskId: 't1', currentTool: 'file.read', progress: 20 }),
      ),
    ).toBe('applied');
    expect(store.getState().employees.a).toMatchObject({
      state: 'working',
      currentTaskId: 't1',
      currentTool: 'file.read',
      progress: 20,
    });
    expect(store.apply(status(12, 'a', 'thinking'))).toBe('applied');
    // Trường không có trong payload nghĩa là không còn: tool/task/tiến độ được xóa.
    expect(store.getState().employees.a).toMatchObject({
      state: 'thinking',
      currentTaskId: null,
      currentTool: null,
      progress: null,
    });
    expect(store.getState().seq).toBe(12);
  });

  it('nhiều envelope cùng seq (D2) đều được áp, không phải gap', () => {
    const store = new OfficeStore();
    store.loadSnapshot(snapshot(10));
    expect(store.apply(status(11, 'a', 'working'))).toBe('applied');
    expect(store.apply(status(11, 'b', 'thinking'))).toBe('applied');
    expect(store.getState().stale).toBe(false);
    expect(store.getState().employees.b?.state).toBe('thinking');
  });

  it('envelope đã nằm trong snapshot (seq <= snapshotSeq) bị bỏ qua, không làm lùi trạng thái', () => {
    const store = new OfficeStore();
    store.loadSnapshot({
      ...snapshot(10),
      employees: [emp('a', 'dev', 0, { state: 'working' }), emp('b', 'dev', 1)],
    });
    expect(store.apply(status(9, 'a', 'idle'))).toBe('ignored');
    expect(store.apply(status(10, 'a', 'idle'))).toBe('ignored');
    expect(store.getState().employees.a?.state).toBe('working');
  });

  it('phát hiện mất sự kiện (seq > last + 1): stale và yêu cầu tải lại', () => {
    const store = new OfficeStore();
    store.loadSnapshot(snapshot(10));
    expect(store.apply(status(13, 'a', 'working'))).toBe('gap');
    expect(store.getState().stale).toBe(true);
    // Không áp sự kiện sau khoảng trống.
    expect(store.getState().employees.a?.state).toBe('idle');
  });

  it('nhãn stale được xóa khi nạp snapshot mới và seq nhảy tới mốc mới', () => {
    const store = new OfficeStore();
    store.loadSnapshot(snapshot(10));
    store.markStale();
    expect(store.getState().stale).toBe(true);
    store.loadSnapshot(snapshot(20));
    expect(store.getState()).toMatchObject({ stale: false, seq: 20, snapshotSeq: 20 });
  });

  it('markStale khi mất kết nối nhưng chưa có snapshot thì không làm gì', () => {
    const store = new OfficeStore();
    store.markStale();
    expect(store.getState().stale).toBe(false);
  });

  it('sync.seq_advanced chỉ tiến seq, không đổi trạng thái', () => {
    const store = new OfficeStore();
    store.loadSnapshot(snapshot(10));
    expect(store.apply(env(11, 'sync.seq_advanced', {}))).toBe('advanced');
    expect(store.getState().seq).toBe(11);
    expect(store.apply(env(13, 'sync.seq_advanced', {}))).toBe('gap');
  });

  it('sự kiện task/run chỉ tiến seq; sự kiện room user bị bỏ qua và không tính seq', () => {
    const store = new OfficeStore();
    store.loadSnapshot(snapshot(10));
    expect(store.apply(env(11, 'task.status_changed', { taskId: 't' }))).toBe('advanced');
    expect(store.apply(env(99, 'notification.created', {}))).toBe('ignored');
    expect(store.apply(env(98, 'approval.requested', {}))).toBe('ignored');
    expect(store.getState().seq).toBe(11);
    expect(store.getState().stale).toBe(false);
  });

  it('office.layout_changed và nhân viên chưa có trong snapshot yêu cầu tải lại (không phải lỗi)', () => {
    const store = new OfficeStore();
    store.loadSnapshot(snapshot(10));
    expect(store.apply(env(11, 'office.layout_changed', { reason: 'employee_added' }))).toBe(
      'reload',
    );
    expect(store.apply(status(12, 'new-hire', 'working'))).toBe('reload');
    expect(store.getState().stale).toBe(false);
    expect(store.getState().seq).toBe(12);
  });

  it('payload sai định dạng bị bỏ qua, không làm hỏng trạng thái', () => {
    const store = new OfficeStore();
    store.loadSnapshot(snapshot(10));
    expect(
      store.apply(env(11, 'office.employee_status_changed', { employeeId: 'a', state: 'dancing' })),
    ).toBe('ignored');
    expect(store.getState().employees.a?.state).toBe('idle');
  });

  it('10 nhân viên đổi trạng thái liên tục: không mất, không đảo thứ tự', () => {
    const employees = Array.from({ length: 10 }, (_, i) => emp(`e${i}`, 'dev', i));
    const store = new OfficeStore();
    store.loadSnapshot({ ...snapshot(100), employees });
    const states = ['working', 'thinking', 'waiting_approval', 'working', 'completed'] as const;
    let seq = 100;
    const expected: Record<string, string> = {};
    for (const state of states) {
      for (const e of employees) {
        seq += 1;
        expect(store.apply(status(seq, e.id, state))).toBe('applied');
        expected[e.id] = state;
      }
    }
    expect(store.getState().seq).toBe(seq);
    expect(store.getState().stale).toBe(false);
    for (const e of employees) expect(store.getState().employees[e.id]?.state).toBe(expected[e.id]);
  });

  it('thông báo cho người nghe mỗi lần đổi', () => {
    const store = new OfficeStore();
    let calls = 0;
    const off = store.subscribe(() => (calls += 1));
    store.loadSnapshot(snapshot(10));
    store.apply(status(11, 'a', 'working'));
    off();
    store.apply(status(12, 'a', 'thinking'));
    expect(calls).toBe(2);
  });

  it('toSnapshot khớp dữ liệu đã nạp cộng sự kiện', () => {
    const store = new OfficeStore();
    store.loadSnapshot(snapshot(10));
    store.apply(status(11, 'a', 'working'));
    const out = store.toSnapshot();
    expect(out.seq).toBe(11);
    expect(out.employees.find((e) => e.id === 'a')?.state).toBe('working');
  });
});

describe('placement (trình bày, không phải nghiệp vụ)', () => {
  it('nhân viên đứng ở bàn của mình; break ra Break Room', () => {
    const snap: OfficeSnapshot = {
      ...snapshot(1),
      employees: [emp('a', 'dev', 0), emp('b', 'dev', 1, { state: 'break' })],
    };
    const [a, b] = placeEmployees(snap);
    expect(a?.stand).toEqual(a?.desk);
    expect(b?.stand).not.toEqual(b?.desk);
    expect(b!.stand.col).toBeGreaterThanOrEqual(10); // trong Break Room
  });

  it('không có Break Room thì break vẫn ở bàn; bao trọn mọi zone', () => {
    const snap: OfficeSnapshot = {
      seq: 1,
      zones: [zone('dev', 'department', 0, 0)],
      employees: [emp('a', 'dev', 0, { state: 'break' })],
    };
    const [a] = placeEmployees(snap);
    expect(a?.stand).toEqual(a?.desk);
    expect(officeBounds(snap.zones)).toEqual({ cols: 9, rows: 6 });
  });
});
