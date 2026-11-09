import { describe, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io-client';
import type { RealtimeEnvelope } from '@claude-company/contracts';
import { RealtimeClient, type ConnectionStatus } from '../src/realtime/socket';
import { SeqTracker } from '../src/realtime/seq';

const env = (seq: number, type = 'sync.seq_advanced'): RealtimeEnvelope<unknown> => ({
  seq,
  companyId: 'c1',
  type,
  occurredAt: new Date().toISOString(),
  payload: {},
});

describe('SeqTracker (D2)', () => {
  it('nhiều envelope cùng seq là hợp lệ; seq > last + 1 là mất sự kiện', () => {
    const t = new SeqTracker();
    t.reset(5);
    expect(t.observe(env(6))).toBe('ok');
    expect(t.observe(env(6, 'task.status_changed'))).toBe('ok');
    expect(t.observe(env(7))).toBe('ok');
    expect(t.observe(env(9))).toBe('gap');
  });

  it('sự kiện phát lại cũ hơn không làm lùi mốc', () => {
    const t = new SeqTracker();
    t.reset(10);
    expect(t.observe(env(8))).toBe('ok');
    expect(t.lastSeq).toBe(10);
  });

  it('room user:{id} không kiểm tra liên tục', () => {
    const t = new SeqTracker();
    t.reset(3);
    expect(t.observe(env(99, 'notification.created'))).toBe('ignored');
    expect(t.observe(env(50, 'approval.requested'))).toBe('ignored');
    expect(t.lastSeq).toBe(3);
  });

  it('chưa có mốc thì nhận seq đầu tiên làm mốc', () => {
    const t = new SeqTracker();
    expect(t.observe(env(42))).toBe('ok');
    expect(t.lastSeq).toBe(42);
  });
});

/** Socket giả đủ cho RealtimeClient. */
function fakeSocket() {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  let any: ((event: string, payload: unknown) => void) | null = null;
  const emitted: Array<{ event: string; body: unknown }> = [];
  let ackFn: ((r: unknown) => void) | null = null;
  const socket = {
    connected: true,
    on: (event: string, fn: (...args: unknown[]) => void) => handlers.set(event, fn),
    onAny: (fn: (event: string, payload: unknown) => void) => {
      any = fn;
    },
    emit: (event: string, body: unknown, ack?: (r: unknown) => void) => {
      emitted.push({ event, body });
      ackFn = ack ?? null;
    },
    removeAllListeners: () => handlers.clear(),
    close: vi.fn(),
  };
  return {
    socket: socket as unknown as Socket,
    emitted,
    fire: (event: string) => handlers.get(event)?.(),
    push: (envelope: RealtimeEnvelope<unknown>) => any?.(envelope.type, envelope),
    ack: (r: unknown) => ackFn?.(r),
  };
}

describe('RealtimeClient (FR-037)', () => {
  function setup(sinceSeq?: number) {
    const f = fakeSocket();
    const client = new RealtimeClient({ createSocket: () => f.socket });
    const statuses: ConnectionStatus[] = [];
    client.onStatus((s) => statuses.push(s));
    const received: number[] = [];
    client.onEnvelope((e) => received.push(e.seq));
    const resync = vi.fn();
    client.onResyncNeeded(resync);
    client.connect('c1', sinceSeq);
    return { f, client, statuses, received, resync };
  }

  it('subscribe với sinceSeq của snapshot rồi chuyển sang live khi server xác nhận', () => {
    const { f, statuses } = setup(10);
    f.fire('connect');
    expect(f.emitted).toEqual([{ event: 'subscribe', body: { companyId: 'c1', sinceSeq: 10 } }]);
    f.ack({ status: 'ok', seq: 10 });
    expect(statuses).toEqual(['disconnected', 'connecting', 'live']);
  });

  it('phát hiện seq > last + 1: báo cũ, bỏ envelope, yêu cầu tải lại snapshot', () => {
    const { f, client, statuses, received, resync } = setup(10);
    f.fire('connect');
    f.ack({ status: 'ok', seq: 10 });
    f.push(env(11));
    f.push(env(13)); // thiếu 12
    expect(received).toEqual([11]);
    expect(statuses.at(-1)).toBe('stale');
    expect(resync).toHaveBeenCalledTimes(1);

    client.resubscribe(20);
    expect(f.emitted.at(-1)).toEqual({
      event: 'subscribe',
      body: { companyId: 'c1', sinceSeq: 20 },
    });
    f.ack({ status: 'ok', seq: 20 });
    expect(client.connectionStatus).toBe('live');
    f.push(env(21));
    expect(received).toEqual([11, 21]);
  });

  it('mất kết nối chuyển sang cũ và yêu cầu tải lại snapshot', () => {
    const { f, client, resync } = setup(5);
    f.fire('connect');
    f.ack({ status: 'ok', seq: 5 });
    f.fire('disconnect');
    expect(client.connectionStatus).toBe('stale');
    expect(resync).toHaveBeenCalledTimes(1);
  });

  it('resync_required từ server buộc tải lại snapshot kể cả khi đang ở trạng thái cũ', () => {
    const { f, resync } = setup(5);
    f.fire('connect');
    f.ack({ status: 'ok', seq: 5 });
    f.fire('disconnect'); // lần 1
    f.fire('connect');
    f.ack({ status: 'resync_required' }); // lần 2
    expect(resync).toHaveBeenCalledTimes(2);
  });

  it('chưa có snapshot thì subscribe không kèm sinceSeq', () => {
    const { f } = setup();
    f.fire('connect');
    expect(f.emitted[0]?.body).toEqual({ companyId: 'c1' });
  });
});
