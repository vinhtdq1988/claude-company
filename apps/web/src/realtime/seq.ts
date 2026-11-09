import type { RealtimeEventType } from '@claude-company/contracts';

/** Sự kiện của room `user:{memberId}`: không kiểm tra seq liên tục (D2). */
const USER_ROOM_TYPES: ReadonlySet<string> = new Set<RealtimeEventType>([
  'notification.created',
  'approval.requested',
  'approval.decided',
]);

export type SeqVerdict = 'ok' | 'gap' | 'ignored';

/**
 * Theo dõi seq của room công ty. Nhiều envelope dùng chung một seq (D2) nên `seq === last` hợp lệ;
 * chỉ `seq > last + 1` là mất sự kiện (FR-037).
 */
export class SeqTracker {
  private last: number | null = null;

  /** Đặt mốc từ snapshot (`seq = S`) hoặc phản hồi subscribe. */
  reset(seq: number | null): void {
    this.last = seq;
  }

  get lastSeq(): number | null {
    return this.last;
  }

  observe(envelope: { seq: number; type: string }): SeqVerdict {
    if (USER_ROOM_TYPES.has(envelope.type)) return 'ignored';
    if (this.last === null) {
      this.last = envelope.seq;
      return 'ok';
    }
    if (envelope.seq > this.last + 1) return 'gap';
    if (envelope.seq > this.last) this.last = envelope.seq;
    return 'ok';
  }
}
