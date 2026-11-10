import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io, type Socket } from 'socket.io-client';
import type { EmployeeProfile, OfficeSnapshot, RealtimeEnvelope } from '@claude-company/contracts';
import { OutboxRelay } from '../../apps/api/src/platform/events/outbox-relay';
import { createTestApp, type TestApp } from '../support/app';
import { departmentIds, employeeBody, hireVia, memberIdOf } from '../support/employee-fixtures';
import {
  prepareDatabase,
  seedDatabase,
  startInfra,
  type StartedInfra,
} from '../support/containers';
import { registerUser, type TestSession } from '../support/factories';

type Received = RealtimeEnvelope<unknown>;
type StatusPayload = {
  employeeId: string;
  state: string;
  previousState: string;
  sourceEventType: string;
};

const until = async (predicate: () => boolean, timeoutMs = 8000) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('Hết thời gian chờ sự kiện realtime');
    await new Promise((r) => setTimeout(r, 25));
  }
};

/**
 * Lan truyền trạng thái office (T146; FR-037, SC-005, D2): snapshot → subscribe `sinceSeq` → áp theo `seq`;
 * `seq` liên tục, phát lại theo `sinceSeq`, `resync_required`, 10 nhân viên đổi trạng thái liên tục không mất hoặc
 * đảo thứ tự. Nguồn sự kiện: tạm ngưng/tiếp tục nhân viên (`employee.suspended`/`employee.resumed` → break/idle).
 */
describe('Integration: lan truyền realtime của Virtual Office (T146)', () => {
  let infra: StartedInfra;
  let t: TestApp;
  let baseUrl: string;
  let ceo: TestSession;
  let companyId: string;
  const staff: EmployeeProfile[] = [];
  const sockets: Socket[] = [];

  const base = () => `/companies/${companyId}`;
  const relay = () => t.app.get(OutboxRelay);
  const connect = () => {
    const socket = io(`${baseUrl}/realtime`, {
      transports: ['websocket'],
      extraHeaders: { cookie: ceo.cookie },
      reconnection: false,
      forceNew: true,
    });
    sockets.push(socket);
    return socket;
  };
  const connected = (socket: Socket) =>
    new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', reject);
    });
  const subscribe = (socket: Socket, body: object) =>
    new Promise<{ status: string; seq?: number }>((resolve) =>
      socket.emit('subscribe', body, resolve),
    );
  const record = (socket: Socket): Received[] => {
    const received: Received[] = [];
    socket.onAny((_name, envelope: Received) => received.push(envelope));
    return received;
  };
  const snapshot = async () => (await ceo.get(`${base()}/office/snapshot`)).body as OfficeSnapshot;
  const statuses = (received: Received[]) =>
    received.filter((e) => e.type === 'office.employee_status_changed');

  beforeAll(async () => {
    infra = await startInfra({ postgres: true, redis: true });
    await prepareDatabase(infra);
    await seedDatabase(infra);
    t = await createTestApp({ infra });
    await t.app.listen(0, '127.0.0.1');
    baseUrl = await t.app.getUrl();

    ceo = await registerUser(t);
    const created = await ceo.post('/companies', {
      name: 'Công ty office',
      templateKey: 'software_company',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    companyId = created.body.id as string;
    const home = (await departmentIds(ceo, companyId)).Development!;
    const ceoMemberId = await memberIdOf(ceo, companyId);
    for (let i = 0; i < 10; i += 1) {
      staff.push(
        await hireVia(
          ceo,
          companyId,
          employeeBody(home, { kind: 'human', id: ceoMemberId }, { name: `Nhân viên ${i}` }),
        ),
      );
    }
    await relay().tick();
  });

  afterAll(async () => {
    sockets.forEach((s) => s.close());
    await t?.close();
    await infra?.stop();
  });

  it('snapshot có seq, zone và đủ 10 nhân viên idle, mỗi người một bàn', async () => {
    const snap = await snapshot();
    expect(snap.employees).toHaveLength(10);
    expect(snap.employees.every((e) => e.state === 'idle')).toBe(true);
    expect(new Set(snap.employees.map((e) => `${e.zoneId}:${e.deskIndex}`)).size).toBe(10);
    expect(snap.seq).toBeGreaterThan(0);
  });

  it('10 nhân viên đổi trạng thái liên tục: seq liên tục, không mất, không đảo thứ tự', async () => {
    const start = await snapshot();
    const socket = connect();
    await connected(socket);
    const received = record(socket);
    expect((await subscribe(socket, { companyId, sinceSeq: start.seq })).status).toBe('ok');

    for (let round = 0; round < 2; round += 1) {
      for (const e of staff) await ceo.post(`${base()}/employees/${e.id}/suspend`);
      await relay().tick();
      for (const e of staff) await ceo.post(`${base()}/employees/${e.id}/resume`);
      await relay().tick();
    }
    // 2 vòng × 10 người × (suspend + resume) = 40 sự kiện đổi trạng thái.
    await until(() => statuses(received).length >= 40);

    // seq liên tục (D2): mọi seq từ start+1 tới lớn nhất đều có ít nhất một envelope và không bao giờ lùi.
    const seqs = received.map((e) => e.seq);
    expect(seqs.every((s, i) => i === 0 || s >= seqs[i - 1]!)).toBe(true);
    const max = Math.max(...seqs);
    for (let s = start.seq + 1; s <= max; s += 1) expect(seqs).toContain(s);

    // Từng nhân viên: break → idle → break → idle, đúng thứ tự, không thiếu lần nào.
    for (const e of staff) {
      const mine = statuses(received)
        .map((x) => x.payload as StatusPayload)
        .filter((p) => p.employeeId === e.id);
      expect(mine.map((p) => p.state)).toEqual(['break', 'idle', 'break', 'idle']);
      expect(mine.map((p) => p.sourceEventType)).toEqual([
        'employee.suspended',
        'employee.resumed',
        'employee.suspended',
        'employee.resumed',
      ]);
    }
  });

  it('phát lại theo sinceSeq cho đúng chuỗi envelope đã phát trực tiếp', async () => {
    const start = (await snapshot()).seq;
    const live = connect();
    await connected(live);
    const liveGot = record(live);
    await subscribe(live, { companyId, sinceSeq: start });

    await ceo.post(`${base()}/employees/${staff[0]!.id}/suspend`);
    await ceo.post(`${base()}/employees/${staff[1]!.id}/suspend`);
    await relay().tick();
    await until(() => statuses(liveGot).length >= 2);

    const late = connect();
    await connected(late);
    const replayed = record(late);
    const ack = await subscribe(late, { companyId, sinceSeq: start });
    expect(ack.status).toBe('ok');
    await until(() => statuses(replayed).length >= 2);
    expect(replayed.map((e) => [e.seq, e.type, JSON.stringify(e.payload)])).toEqual(
      liveGot.map((e) => [e.seq, e.type, JSON.stringify(e.payload)]),
    );
  });

  it('sinceSeq vượt seq hiện tại → resync_required; snapshot mới khớp trạng thái đã phát', async () => {
    const socket = connect();
    await connected(socket);
    expect((await subscribe(socket, { companyId, sinceSeq: 9_999_999 })).status).toBe(
      'resync_required',
    );

    const snap = await snapshot();
    const suspended = new Set([staff[0]!.id, staff[1]!.id]);
    for (const e of snap.employees) {
      expect(e.state).toBe(suspended.has(e.id) ? 'break' : 'idle');
    }
    // Resubscribe từ mốc snapshot không phải phát lại gì.
    const fresh = connect();
    await connected(fresh);
    const got = record(fresh);
    expect(await subscribe(fresh, { companyId, sinceSeq: snap.seq })).toEqual({
      status: 'ok',
      seq: snap.seq,
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(got).toHaveLength(0);
  });

  it('thêm nhân viên phát office.layout_changed để client tải lại snapshot', async () => {
    const start = (await snapshot()).seq;
    const socket = connect();
    await connected(socket);
    const received = record(socket);
    await subscribe(socket, { companyId, sinceSeq: start });

    const home = (await departmentIds(ceo, companyId)).QA!;
    const ceoMemberId = await memberIdOf(ceo, companyId);
    await hireVia(
      ceo,
      companyId,
      employeeBody(home, { kind: 'human', id: ceoMemberId }, { name: 'Người mới' }),
    );
    await relay().tick();
    await until(() => received.some((e) => e.type === 'office.layout_changed'));
    expect(received.find((e) => e.type === 'office.layout_changed')?.payload).toEqual({
      reason: 'employee_added',
    });
    expect((await snapshot()).employees).toHaveLength(11);
  });
});
