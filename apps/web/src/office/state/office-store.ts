import {
  officeEmployeeStatusChangedSchema,
  type OfficeEmployee,
  type OfficeSnapshot,
  type OfficeZone,
  type RealtimeEnvelope,
} from '@claude-company/contracts';

export type OfficeStoreState = {
  loaded: boolean;
  /** `seq` của snapshot đã tải: envelope có `seq <= snapshotSeq` đã nằm trong snapshot. */
  snapshotSeq: number;
  /** `seq` lớn nhất đã áp. */
  seq: number;
  zones: OfficeZone[];
  employees: Record<string, OfficeEmployee>;
  /** Mất đồng bộ (gap hoặc mất kết nối): hiển thị "Trạng thái có thể đã cũ" cho tới khi tải lại snapshot. */
  stale: boolean;
};

/**
 * - `applied`: đã áp và có thể đổi hiển thị; `advanced`: chỉ tiến `seq`; `ignored`: đã có trong snapshot hoặc không liên quan;
 * - `gap`: mất sự kiện (store đã đánh dấu stale) → tải lại snapshot;
 * - `reload`: bố cục đổi hoặc nhân viên chưa có trong snapshot → tải lại snapshot (không phải lỗi).
 */
export type ApplyResult = 'applied' | 'advanced' | 'ignored' | 'gap' | 'reload';

/** Sự kiện room `user:{id}` không thuộc dòng `seq` của công ty (D2). */
const USER_ROOM_TYPES: ReadonlySet<string> = new Set([
  'notification.created',
  'approval.requested',
  'approval.decided',
]);

const EMPTY: OfficeStoreState = {
  loaded: false,
  snapshotSeq: 0,
  seq: 0,
  zones: [],
  employees: {},
  stale: false,
};

/**
 * Store trạng thái Virtual Office (T159): snapshot + `seq`, áp sự kiện theo thứ tự, phát hiện mất sự kiện (FR-037).
 * Thuần TypeScript, không import PixiJS hay React nên thay renderer không đụng logic (FR-039, Nguyên tắc IV).
 * Chỉ nhận trạng thái từ server; không tự suy ra hay tự đổi trạng thái nhân viên.
 */
export class OfficeStore {
  private state: OfficeStoreState = EMPTY;
  private readonly listeners = new Set<(state: OfficeStoreState) => void>();

  getState(): OfficeStoreState {
    return this.state;
  }

  subscribe(listener: (state: OfficeStoreState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(next: OfficeStoreState): void {
    this.state = next;
    this.listeners.forEach((l) => l(next));
  }

  /** Nạp snapshot mới; xóa nhãn stale vì dữ liệu vừa lấy từ server. */
  loadSnapshot(snapshot: OfficeSnapshot): void {
    this.set({
      loaded: true,
      snapshotSeq: snapshot.seq,
      seq: snapshot.seq,
      zones: snapshot.zones,
      employees: Object.fromEntries(snapshot.employees.map((e) => [e.id, e])),
      stale: false,
    });
  }

  markStale(): void {
    if (!this.state.loaded || this.state.stale) return;
    this.set({ ...this.state, stale: true });
  }

  toSnapshot(): OfficeSnapshot {
    const { seq, zones, employees } = this.state;
    return { seq, zones, employees: Object.values(employees) };
  }

  apply(envelope: RealtimeEnvelope<unknown>): ApplyResult {
    const s = this.state;
    if (!s.loaded || USER_ROOM_TYPES.has(envelope.type)) return 'ignored';
    if (envelope.seq <= s.snapshotSeq) return 'ignored';
    // Nhiều envelope cùng seq là hợp lệ (D2); chỉ seq > last + 1 là mất sự kiện.
    if (envelope.seq > s.seq + 1) {
      this.markStale();
      return 'gap';
    }
    const seq = Math.max(s.seq, envelope.seq);

    if (envelope.type === 'office.layout_changed') {
      this.set({ ...s, seq });
      return 'reload';
    }
    if (envelope.type !== 'office.employee_status_changed') {
      if (seq !== s.seq) this.set({ ...s, seq });
      return seq === s.seq ? 'ignored' : 'advanced';
    }

    const parsed = officeEmployeeStatusChangedSchema.safeParse(envelope.payload);
    if (!parsed.success) return 'ignored';
    const p = parsed.data;
    const current = s.employees[p.employeeId];
    if (!current) {
      // Nhân viên mới hoặc vừa vào phạm vi xem: cần snapshot để biết zone và bàn.
      this.set({ ...s, seq });
      return 'reload';
    }
    this.set({
      ...s,
      seq,
      employees: {
        ...s.employees,
        [p.employeeId]: {
          ...current,
          state: p.state,
          currentTaskId: p.currentTaskId ?? null,
          currentTool: p.currentTool ?? null,
          progress: p.progress ?? null,
        },
      },
    });
    return 'applied';
  }
}
