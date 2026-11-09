import type { EmployeeKind, EmployeeStatus, ManagerRef } from '@claude-company/contracts';

/** Số bước tối đa từ nhân viên tới người thật cuối chuỗi (FR-006). */
export const MAX_CHAIN_STEPS = 10;

/** Dữ liệu tối thiểu của một AI Employee để đi theo chuỗi quản lý. */
export type ChainNode = {
  id: string;
  kind: EmployeeKind;
  status: EmployeeStatus;
  manager: ManagerRef;
};

export type ChainFailure =
  | 'HUMAN_INACTIVE' // người thật cuối chuỗi không tồn tại hoặc đã vô hiệu
  | 'MANAGER_MISSING' // manager AI không tồn tại hoặc đã archived
  | 'NOT_A_MANAGER' // manager AI nhưng `kind = employee`
  | 'CYCLE'
  | 'TOO_LONG';

export type ChainResult =
  | { ok: true; humanMemberId: string; steps: number }
  | { ok: false; reason: ChainFailure; at?: string };

export type ChainSnapshot = {
  /** AI Employee của công ty, theo id (nhân viên archived bị bỏ qua khi đi chuỗi). */
  employees: ReadonlyMap<string, ChainNode>;
  /** `human_member.id` đang hoạt động. */
  activeHumanIds: ReadonlySet<string>;
};

/**
 * Đi từ `subject` theo `manager` tới người thật. Mỗi manager AI phải có `kind = manager` và chưa archived;
 * chuỗi phải kết thúc ở human_member đang hoạt động trong ≤ MAX_CHAIN_STEPS bước và không có vòng.
 * `steps` đếm cả bước cuối tới người thật. Hàm thuần: không đọc DB, dùng được cho cả kiểm tra
 * trước khi ghi (truyền nhân viên với manager đề xuất) lẫn quét dữ liệu hiện có.
 */
export function walkManagementChain(
  snapshot: ChainSnapshot,
  subject: { id: string; manager: ManagerRef },
): ChainResult {
  const seen = new Set<string>([subject.id]);
  let manager = subject.manager;
  for (let steps = 1; steps <= MAX_CHAIN_STEPS; steps++) {
    if (manager.kind === 'human') {
      return snapshot.activeHumanIds.has(manager.id)
        ? { ok: true, humanMemberId: manager.id, steps }
        : { ok: false, reason: 'HUMAN_INACTIVE', at: manager.id };
    }
    if (seen.has(manager.id)) return { ok: false, reason: 'CYCLE', at: manager.id };
    seen.add(manager.id);
    const node = snapshot.employees.get(manager.id);
    if (!node || node.status === 'archived') {
      return { ok: false, reason: 'MANAGER_MISSING', at: manager.id };
    }
    if (node.kind !== 'manager') return { ok: false, reason: 'NOT_A_MANAGER', at: manager.id };
    manager = node.manager;
  }
  return { ok: false, reason: 'TOO_LONG' };
}

/** Số tầng cấp dưới sâu nhất của `rootId` (0 nếu không có cấp dưới), bỏ qua nhân viên archived. */
export function subtreeHeight(snapshot: ChainSnapshot, rootId: string): number {
  const children = new Map<string, string[]>();
  for (const e of snapshot.employees.values()) {
    if (e.status === 'archived' || e.manager.kind !== 'ai') continue;
    children.set(e.manager.id, [...(children.get(e.manager.id) ?? []), e.id]);
  }
  const onPath = new Set<string>();
  const height = (id: string): number => {
    if (onPath.has(id)) return 0; // vòng đã có sẵn trong dữ liệu: không đệ quy vô hạn
    onPath.add(id);
    const below = (children.get(id) ?? []).map(height);
    onPath.delete(id);
    return below.length === 0 ? 0 : 1 + Math.max(...below);
  };
  return height(rootId);
}

/**
 * Kiểm tra trước khi ghi một nhân viên với manager đề xuất. Ngoài chuỗi của chính nhân viên,
 * còn đảm bảo các cấp dưới hiện có của nó không bị đẩy quá MAX_CHAIN_STEPS bước.
 * `snapshot` phải chứa nhân viên đang sửa với manager đề xuất để bắt được vòng.
 */
export function checkProposedManager(
  snapshot: ChainSnapshot,
  subject: { id: string; manager: ManagerRef },
): ChainResult {
  const result = walkManagementChain(snapshot, subject);
  if (!result.ok) return result;
  if (result.steps + subtreeHeight(snapshot, subject.id) > MAX_CHAIN_STEPS) {
    return { ok: false, reason: 'TOO_LONG', at: subject.id };
  }
  return result;
}
