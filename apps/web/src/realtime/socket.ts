import { io, type Socket } from 'socket.io-client';
import type { RealtimeEnvelope, SubscribeResult } from '@claude-company/contracts';
import { SeqTracker } from './seq';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'live' | 'stale';

type EnvelopeHandler = (envelope: RealtimeEnvelope<unknown>) => void;
type StatusHandler = (status: ConnectionStatus) => void;
type SubscribeAck = SubscribeResult | { status: 'forbidden' };

export interface RealtimeClientOptions {
  /** Cho test thay thế bằng socket giả. */
  createSocket?: () => Socket;
}

/**
 * Socket.IO client dùng chung (contracts/realtime-events.md, FR-037):
 * 1) tải snapshot → `seq = S`; 2) `connect(companyId, S)` gửi `subscribe { companyId, sinceSeq: S }`;
 * 3) thấy `seq > last + 1` hoặc mất kết nối → trạng thái `stale` ("Trạng thái có thể đã cũ"),
 *    gọi `onResyncNeeded` để consumer tải lại snapshot rồi gọi `resubscribe(newSeq)`.
 */
export class RealtimeClient {
  private socket: Socket | null = null;
  private companyId: string | null = null;
  private status: ConnectionStatus = 'disconnected';
  private readonly seq = new SeqTracker();
  private readonly envelopeHandlers = new Set<EnvelopeHandler>();
  private readonly statusHandlers = new Set<StatusHandler>();
  private resyncHandler: (() => void) | null = null;

  constructor(private readonly options: RealtimeClientOptions = {}) {}

  get connectionStatus(): ConnectionStatus {
    return this.status;
  }

  get lastSeq(): number | null {
    return this.seq.lastSeq;
  }

  onEnvelope(handler: EnvelopeHandler): () => void {
    this.envelopeHandlers.add(handler);
    return () => this.envelopeHandlers.delete(handler);
  }

  onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    handler(this.status);
    return () => this.statusHandlers.delete(handler);
  }

  /** Consumer đăng ký cách tải lại snapshot (ví dụ Virtual Office gọi `GET /office/snapshot`). */
  onResyncNeeded(handler: () => void): void {
    this.resyncHandler = handler;
  }

  private setStatus(next: ConnectionStatus): void {
    if (this.status === next) return;
    this.status = next;
    this.statusHandlers.forEach((h) => h(next));
  }

  /** Kết nối và subscribe từ mốc `sinceSeq` (seq của snapshot đã tải). */
  connect(companyId: string, sinceSeq?: number): void {
    this.disconnect();
    this.companyId = companyId;
    this.seq.reset(sinceSeq ?? null);
    this.setStatus('connecting');

    const socket =
      this.options.createSocket?.() ??
      io('/realtime', { withCredentials: true, transports: ['websocket'] });
    this.socket = socket;

    socket.on('connect', () => this.subscribe(this.seq.lastSeq));
    socket.on('disconnect', () => this.markStale());
    socket.on('connect_error', () => this.markStale());
    socket.onAny((_event: string, envelope: RealtimeEnvelope<unknown>) =>
      this.handleEnvelope(envelope),
    );
  }

  /** Sau khi tải lại snapshot (seq mới) thì subscribe tiếp từ mốc đó. */
  resubscribe(snapshotSeq: number): void {
    this.seq.reset(snapshotSeq);
    if (this.socket?.connected) this.subscribe(snapshotSeq);
    else this.setStatus('connecting');
  }

  disconnect(): void {
    this.socket?.removeAllListeners();
    this.socket?.close();
    this.socket = null;
    this.setStatus('disconnected');
  }

  private subscribe(sinceSeq: number | null): void {
    const socket = this.socket;
    const companyId = this.companyId;
    if (!socket || !companyId) return;
    const body = sinceSeq === null ? { companyId } : { companyId, sinceSeq };
    socket.emit('subscribe', body, (ack: SubscribeAck) => {
      if (ack.status === 'ok') {
        this.seq.reset(Math.max(ack.seq, this.seq.lastSeq ?? 0));
        this.setStatus('live');
      } else {
        // resync_required hoặc bị từ chối: replay không đủ, consumer phải tải lại snapshot.
        this.setStatus('stale');
        this.resyncHandler?.();
      }
    });
  }

  private handleEnvelope(envelope: RealtimeEnvelope<unknown>): void {
    if (!envelope || typeof envelope.seq !== 'number') return;
    if (this.seq.observe(envelope) === 'gap') {
      this.markStale();
      return;
    }
    this.envelopeHandlers.forEach((h) => h(envelope));
  }

  private markStale(): void {
    if (this.status === 'stale') return;
    this.setStatus('stale');
    this.resyncHandler?.();
  }
}

/** Instance dùng chung; Virtual Office và notification cùng một kết nối. */
export const realtime = new RealtimeClient();
