import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io, type Socket } from 'socket.io-client';
import type { RealtimeEnvelope } from '@claude-company/contracts';
import { EnvelopeMapperRegistry } from '../../apps/api/src/platform/events/envelope-mapper';
import { OutboxRelay } from '../../apps/api/src/platform/events/outbox-relay';
import { createTestApp, type TestApp } from '../support/app';
import { prepareDatabase, startInfra, type StartedInfra } from '../support/containers';
import {
  addMember,
  createCompanyWithCeo,
  registerUser,
  type TestSession,
} from '../support/factories';
import { COMPANY_WIDE, FakeOrganizationEngine } from '../support/fake-engines';

type Received = RealtimeEnvelope<unknown>;

/** Gom envelope nhận được theo từng socket. */
function recorder(socket: Socket): Received[] {
  const received: Received[] = [];
  socket.onAny((_name, envelope: Received) => received.push(envelope));
  return received;
}

const until = async (predicate: () => boolean, timeoutMs = 5000) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('Hết thời gian chờ sự kiện realtime');
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe('Outbox, event bus và realtime gateway (T037, T038; FR-037, D2)', () => {
  let infra: StartedInfra;
  let t: TestApp;
  const org = new FakeOrganizationEngine();
  let baseUrl: string;
  let ceo: TestSession;
  let manager: TestSession;
  let outsider: TestSession;
  let companyId: string;
  let ceoMemberId: string;
  const hiddenEmployee = '0197a000-0000-7000-8000-0000000000e9';
  const sockets: Socket[] = [];

  const connect = (cookie: string) => {
    const socket = io(`${baseUrl}/realtime`, {
      transports: ['websocket'],
      extraHeaders: { cookie },
      reconnection: false,
      forceNew: true,
    });
    sockets.push(socket);
    return socket;
  };
  const connected = (socket: Socket) =>
    new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', (e) => reject(e));
    });
  const subscribe = (socket: Socket, body: object) =>
    new Promise<{ status: string; seq?: number }>((resolve) =>
      socket.emit('subscribe', body, resolve),
    );

  const relay = () => t.app.get(OutboxRelay);
  /** Gây một domain_event bằng cách thêm thành viên qua API thật. */
  const addManagerViaApi = async () => {
    const extra = await registerUser(t);
    const res = await ceo.post(`/companies/${companyId}/members`, {
      email: extra.email,
      role: 'manager',
    });
    expect(res.status).toBe(201);
    await relay().tick();
  };

  beforeAll(async () => {
    infra = await startInfra({ postgres: true, redis: true });
    await prepareDatabase(infra);
    t = await createTestApp({ infra, overrides: { organization: org } });
    await t.app.listen(0, '127.0.0.1');
    baseUrl = await t.app.getUrl();

    ceo = await registerUser(t);
    manager = await registerUser(t);
    outsider = await registerUser(t);
    const created = await createCompanyWithCeo(t, ceo);
    companyId = created.companyId;
    ceoMemberId = created.ceoMemberId;
    const managerId = await addMember(t, companyId, manager, 'manager');
    org.setScope(ceoMemberId, COMPANY_WIDE);
    org.setScope(managerId, { companyWide: false, orgUnitIds: [], teamIds: [], employeeIds: [] });
  });

  afterAll(async () => {
    sockets.forEach((s) => s.close());
    await t?.close();
    await infra?.stop();
  });

  it('handshake với cookie không hợp lệ bị ngắt', async () => {
    const bad = connect('cc_sid=khong-hop-le-khong-hop-le-khong-hop-le');
    await expect(connected(bad)).rejects.toThrow(/unauthorized/);
  });

  it('subscribe vào company không phải thành viên bị từ chối', async () => {
    const s = connect(outsider.cookie);
    await connected(s);
    expect((await subscribe(s, { companyId })).status).toBe('forbidden');
    expect((await subscribe(s, { companyId: 'khong-phai-uuid' })).status).toBe('forbidden');
  });

  it('event không có envelope công khai phát sync.seq_advanced giữ seq liên tục (D2)', async () => {
    const s = connect(ceo.cookie);
    await connected(s);
    const received = recorder(s);
    const ack = await subscribe(s, { companyId });
    expect(ack).toEqual({ status: 'ok', seq: 0 });

    await addManagerViaApi();
    await until(() => received.length >= 1);
    expect(received[0]).toMatchObject({
      seq: 1,
      companyId,
      type: 'sync.seq_advanced',
      payload: {},
    });

    await addManagerViaApi();
    await until(() => received.length >= 2);
    expect(received.map((e) => e.seq)).toEqual([1, 2]);
  });

  it('subscribe với sinceSeq phát lại sự kiện bị lỡ, ngoài phạm vi thì yêu cầu resync', async () => {
    const s = connect(ceo.cookie);
    await connected(s);
    const received = recorder(s);
    const ack = await subscribe(s, { companyId, sinceSeq: 0 });
    expect(ack.status).toBe('ok');
    expect(ack.seq).toBe(2);
    expect(received.map((e) => e.seq)).toEqual([1, 2]);

    const ahead = connect(ceo.cookie);
    await connected(ahead);
    expect((await subscribe(ahead, { companyId, sinceSeq: 999 })).status).toBe('resync_required');
  });

  it('server lọc envelope theo ManagedScope và thay bằng sync.seq_advanced cùng seq', async () => {
    t.app.get(EnvelopeMapperRegistry).register('human_member.', () => [
      {
        room: 'company',
        type: 'task.status_changed',
        payload: {
          taskId: 'task-1',
          from: 'draft',
          to: 'assigned',
          assigneeKind: 'ai_employee',
          assigneeId: hiddenEmployee,
          isOverdue: false,
        },
        visibility: { kind: 'assignee', assigneeKind: 'ai_employee', assigneeId: hiddenEmployee },
      },
      {
        room: 'user',
        memberId: ceoMemberId,
        type: 'notification.created',
        payload: { notificationId: 'n1', type: 'escalation', title: 'Cần xem' },
      },
    ]);

    const ceoSocket = connect(ceo.cookie);
    const managerSocket = connect(manager.cookie);
    await Promise.all([connected(ceoSocket), connected(managerSocket)]);
    const ceoGot = recorder(ceoSocket);
    const managerGot = recorder(managerSocket);
    await subscribe(ceoSocket, { companyId });
    await subscribe(managerSocket, { companyId });

    await addManagerViaApi();
    await until(() => ceoGot.length >= 2 && managerGot.length >= 1);

    expect(ceoGot.map((e) => e.type).sort()).toEqual([
      'notification.created',
      'task.status_changed',
    ]);
    expect(ceoGot.every((e) => e.seq === 3)).toBe(true); // nhiều envelope dùng chung seq
    // Manager ngoài phạm vi: không thấy nội dung task, không thấy notification của người khác.
    await new Promise((r) => setTimeout(r, 200));
    expect(managerGot).toHaveLength(1);
    expect(managerGot[0]).toMatchObject({ seq: 3, type: 'sync.seq_advanced', payload: {} });
  });

  it('phạm vi được tính lại khi phát lại: manager chỉ thấy task của nhân viên mình quản lý', async () => {
    const managerId = (await manager.get('/auth/me')).body.memberships[0].memberId as string;
    org.setScope(managerId, {
      companyWide: false,
      orgUnitIds: [],
      teamIds: [],
      employeeIds: [hiddenEmployee],
    });

    const s = connect(manager.cookie);
    await connected(s);
    const got = recorder(s);
    await subscribe(s, { companyId, sinceSeq: 2 });
    expect(got.map((e) => [e.seq, e.type])).toEqual([[3, 'task.status_changed']]);
  });

  it('relay đánh dấu published_at và không phát lại event đã phát', async () => {
    expect(await relay().tick()).toBe(0);
    await addManagerViaApi();
    expect(await relay().tick()).toBe(0);
  });
});
