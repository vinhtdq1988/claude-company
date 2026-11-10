import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io, type Socket } from 'socket.io-client';
import type {
  EmployeeProfile,
  OfficeSnapshot,
  RealtimeEnvelope,
  Task,
} from '@claude-company/contracts';
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

const until = async (predicate: () => boolean, timeoutMs = 8000) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('Hết thời gian chờ sự kiện realtime');
    await new Promise((r) => setTimeout(r, 25));
  }
};

/**
 * Cô lập realtime của Virtual Office (T148; FR-005, FR-028, FR-037, SC-012): phạm vi cưỡng chế phía server cả khi phát
 * trực tiếp lẫn phát lại theo `sinceSeq`, snapshot và profile-view.
 */
describe('Bảo mật: cô lập realtime và Virtual Office (T148)', () => {
  let infra: StartedInfra;
  let t: TestApp;
  let baseUrl: string;
  let ceo: TestSession;
  let manager: TestSession;
  let outsider: TestSession;
  let otherCeo: TestSession;
  let companyId: string;
  let otherCompanyId: string;
  let dev: EmployeeProfile;
  let qa: EmployeeProfile;
  const sockets: Socket[] = [];

  const base = (id = companyId) => `/companies/${id}`;
  const relay = () => t.app.get(OutboxRelay);
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

  beforeAll(async () => {
    infra = await startInfra({ postgres: true, redis: true });
    await prepareDatabase(infra);
    await seedDatabase(infra);
    t = await createTestApp({ infra });
    await t.app.listen(0, '127.0.0.1');
    baseUrl = await t.app.getUrl();

    ceo = await registerUser(t, { displayName: 'CEO' });
    manager = await registerUser(t, { displayName: 'Manager Dev' });
    outsider = await registerUser(t, { displayName: 'Người ngoài' });
    otherCeo = await registerUser(t, { displayName: 'CEO khác' });

    const created = await ceo.post('/companies', {
      name: 'Công ty A',
      templateKey: 'software_company',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    companyId = created.body.id as string;
    const other = await otherCeo.post('/companies', {
      name: 'Công ty B',
      templateKey: 'software_company',
    });
    otherCompanyId = other.body.id as string;

    const units = await departmentIds(ceo, companyId);
    const ceoMemberId = await memberIdOf(ceo, companyId);
    const added = await ceo.post(`${base()}/members`, { email: manager.email, role: 'manager' });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    const assigned = await ceo.put(`${base()}/management-assignments`, {
      targetKind: 'org_unit',
      targetId: units.Development,
      managerMemberId: added.body.id as string,
    });
    expect(assigned.status).toBe(204);

    const ceoRef = { kind: 'human', id: ceoMemberId } as const;
    dev = await hireVia(
      ceo,
      companyId,
      employeeBody(units.Development!, ceoRef, { name: 'Dev trong phạm vi' }),
    );
    qa = await hireVia(
      ceo,
      companyId,
      employeeBody(units.QA!, ceoRef, { name: 'QA ngoài phạm vi' }),
    );
    await relay().tick();
  });

  afterAll(async () => {
    sockets.forEach((s) => s.close());
    await t?.close();
    await infra?.stop();
  });

  it('cookie không hợp lệ bị ngắt khi handshake', async () => {
    const bad = connect('cc_sid=khong-hop-le-khong-hop-le-khong-hop-le');
    await expect(connected(bad)).rejects.toThrow(/unauthorized/);
  });

  it('không subscribe được công ty khác hoặc công ty không phải thành viên', async () => {
    const s = connect(outsider.cookie);
    await connected(s);
    expect((await subscribe(s, { companyId })).status).toBe('forbidden');
    const cross = connect(ceo.cookie);
    await connected(cross);
    expect((await subscribe(cross, { companyId: otherCompanyId })).status).toBe('forbidden');
    expect((await subscribe(cross, { companyId: otherCompanyId, sinceSeq: 0 })).status).toBe(
      'forbidden',
    );
  });

  it('không có nội dung task hoặc payload approval trên room công ty', async () => {
    const socket = connect(ceo.cookie);
    await connected(socket);
    const received = record(socket);
    await subscribe(socket, { companyId });

    const task = (
      await ceo.post(`${base()}/tasks`, {
        title: 'BÍ-MẬT-TIÊU-ĐỀ',
        objective: 'BÍ-MẬT-MỤC-TIÊU',
        assignee: { kind: 'ai_employee', id: dev.id },
        deadline: '2027-12-31T00:00:00Z',
        priority: 'high',
        acceptanceCriteria: ['BÍ-MẬT-TIÊU-CHÍ'],
        expectedOutput: 'x',
      })
    ).body as Task;
    await ceo.post(`${base()}/tasks/${task.id}/transitions`, { action: 'assign' });
    await relay().tick();
    await ceo.post(`${base()}/employees/${dev.id}/suspend`);
    await relay().tick();
    await until(() => received.some((e) => e.type === 'office.employee_status_changed'));

    const serialized = JSON.stringify(received);
    for (const secret of ['BÍ-MẬT-TIÊU-ĐỀ', 'BÍ-MẬT-MỤC-TIÊU', 'BÍ-MẬT-TIÊU-CHÍ']) {
      expect(serialized).not.toContain(secret);
    }
    // Chỉ các loại sự kiện khai báo cho room công ty; approval/notification chỉ ở room người dùng.
    const allowed = new Set([
      'office.employee_status_changed',
      'office.layout_changed',
      'task.status_changed',
      'task.progress',
      'run.step_appended',
      'usage.updated',
      'milestone.achieved',
      'sync.seq_advanced',
    ]);
    for (const e of received)
      expect(allowed.has(e.type), `loại không được phép: ${e.type}`).toBe(true);
    const status = received.find((e) => e.type === 'office.employee_status_changed');
    expect(Object.keys(status!.payload as object).sort()).toEqual(
      expect.arrayContaining(['employeeId', 'previousState', 'sourceEventType', 'state']),
    );
    expect(Object.keys(status!.payload as object)).not.toContain('title');
  });

  it('Manager ngoài phạm vi chỉ nhận sync.seq_advanced cho nhân viên ngoài phạm vi, kể cả khi phát lại', async () => {
    const start = (await ceo.get(`${base()}/office/snapshot`)).body as OfficeSnapshot;
    const live = connect(manager.cookie);
    await connected(live);
    const liveGot = record(live);
    await subscribe(live, { companyId, sinceSeq: start.seq });

    await ceo.post(`${base()}/employees/${qa.id}/suspend`); // ngoài phạm vi manager
    await ceo.post(`${base()}/employees/${dev.id}/resume`); // trong phạm vi
    await relay().tick();
    await until(() => liveGot.length >= 2);

    const statusOf = (received: Received[]) =>
      received
        .filter((e) => e.type === 'office.employee_status_changed')
        .map((e) => (e.payload as { employeeId: string }).employeeId);
    expect(statusOf(liveGot)).not.toContain(qa.id);
    expect(JSON.stringify(liveGot)).not.toContain(qa.id);
    // Ngoài phạm vi vẫn giữ seq liên tục bằng sync.seq_advanced.
    const seqs = [...new Set(liveGot.map((e) => e.seq))];
    for (let i = 1; i < seqs.length; i += 1) expect(seqs[i]! - seqs[i - 1]!).toBe(1);

    // Phát lại theo sinceSeq cũng phải lọc theo phạm vi hiện tại.
    const replay = connect(manager.cookie);
    await connected(replay);
    const replayed = record(replay);
    expect((await subscribe(replay, { companyId, sinceSeq: start.seq })).status).toBe('ok');
    await until(() => replayed.length >= 2);
    expect(JSON.stringify(replayed)).not.toContain(qa.id);
    expect(replayed.map((e) => e.seq)).toEqual(liveGot.map((e) => e.seq));
  });

  it('snapshot không có nhân viên ngoài phạm vi và không có zone department ngoài phạm vi', async () => {
    const mine = (await manager.get(`${base()}/office/snapshot`)).body as OfficeSnapshot;
    expect(mine.employees.map((e) => e.name)).toEqual(['Dev trong phạm vi']);
    expect(JSON.stringify(mine)).not.toContain(qa.id);
    const names = mine.zones.filter((z) => z.kind === 'department').map((z) => z.name);
    expect(names).toContain('Development');
    expect(names).not.toContain('QA');

    const all = (await ceo.get(`${base()}/office/snapshot`)).body as OfficeSnapshot;
    expect(all.employees.map((e) => e.name).sort()).toEqual([
      'Dev trong phạm vi',
      'QA ngoài phạm vi',
    ]);
  });

  it('snapshot yêu cầu đăng nhập và thành viên của công ty', async () => {
    expect((await t.http.get(`/api/v1${base()}/office/snapshot`)).status).toBe(401);
    const denied = await outsider.get(`${base()}/office/snapshot`);
    expect([403, 404]).toContain(denied.status);
    const cross = await ceo.get(`${base(otherCompanyId)}/office/snapshot`);
    expect([403, 404]).toContain(cross.status);
  });

  it('profile-view: trong phạm vi 200, ngoài phạm vi 403, công ty khác không truy cập được', async () => {
    expect((await manager.get(`${base()}/employees/${dev.id}/profile-view`)).status).toBe(200);
    expect((await manager.get(`${base()}/employees/${qa.id}/profile-view`)).status).toBe(403);
    expect((await ceo.get(`${base()}/employees/${qa.id}/profile-view`)).status).toBe(200);
    const cross = await otherCeo.get(`${base(otherCompanyId)}/employees/${dev.id}/profile-view`);
    expect([403, 404]).toContain(cross.status);
    expect((await outsider.get(`${base()}/employees/${dev.id}/profile-view`)).status).not.toBe(200);
  });
});
