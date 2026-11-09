import type { ManagerRef } from '@claude-company/contracts';

/** Thông tin tối thiểu của một nhân viên để chọn AI Manager / reviewer. */
export type SelectionCandidate = {
  id: string;
  kind: 'employee' | 'manager';
  status: 'active' | 'suspended' | 'archived';
  homeOrgUnitId: string;
  teamIds: string[];
  manager: ManagerRef;
};

const byId = (a: SelectionCandidate, b: SelectionCandidate) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** AI Manager đang hoạt động; nhiều AI Manager cùng bậc chọn `id` nhỏ nhất (FR-016a). */
function activeManagers(all: readonly SelectionCandidate[]): SelectionCandidate[] {
  return all.filter((e) => e.kind === 'manager' && e.status === 'active').sort(byId);
}

export type DecomposerRequest = {
  assignee:
    | { kind: 'ai_employee'; id: string }
    | { kind: 'team'; id: string; orgUnitId: string }
    | { kind: 'org_unit'; id: string };
  employees: readonly SelectionCandidate[];
};

/**
 * AI Manager phụ trách phân rã (FR-016a, FR-018):
 * - giao Team: AI Manager thuộc team → AI Manager có `home_org_unit_id` là department chứa team;
 * - giao Department: AI Manager có `home_org_unit_id` là đơn vị đó;
 * - giao trực tiếp AI Employee: chính nó nếu là AI Manager, rồi manager AI trực tiếp → AI Manager cùng
 *   `home_org_unit_id` → AI Manager bất kỳ đang `active`.
 * Trả `undefined` khi không có (`NO_AI_MANAGER`).
 */
export function pickDecomposer(req: DecomposerRequest): SelectionCandidate | undefined {
  const managers = activeManagers(req.employees);
  switch (req.assignee.kind) {
    case 'team': {
      const teamId = req.assignee.id;
      return (
        managers.find((m) => m.teamIds.includes(teamId)) ??
        managers.find((m) => m.homeOrgUnitId === (req.assignee as { orgUnitId: string }).orgUnitId)
      );
    }
    case 'org_unit': {
      const unitId = req.assignee.id;
      return managers.find((m) => m.homeOrgUnitId === unitId);
    }
    case 'ai_employee': {
      const assigneeId = req.assignee.id;
      const assignee = req.employees.find((e) => e.id === assigneeId);
      if (!assignee) return undefined;
      if (assignee.kind === 'manager' && assignee.status === 'active') return assignee;
      return pickAiManagerFor(assignee, managers, new Set());
    }
  }
}

/** manager AI trực tiếp → AI Manager cùng `home_org_unit_id` → AI Manager bất kỳ; luôn khác các id bị loại. */
function pickAiManagerFor(
  subject: SelectionCandidate,
  managers: readonly SelectionCandidate[],
  excluded: ReadonlySet<string>,
  preferred: ReadonlySet<string> = new Set(),
): SelectionCandidate | undefined {
  const allowed = managers.filter((m) => m.id !== subject.id && !excluded.has(m.id));
  const tiers: Array<(m: SelectionCandidate) => boolean> = [
    (m) => subject.manager.kind === 'ai' && subject.manager.id === m.id,
    (m) => m.homeOrgUnitId === subject.homeOrgUnitId,
    () => true,
  ];
  // AI Manager chưa tham gia được ưu tiên trên mọi bậc; chỉ khi không còn mới dùng người đã tham gia.
  for (const onlyUninvolved of [true, false]) {
    for (const tier of tiers) {
      const choice = allowed.filter(tier).find((m) => !onlyUninvolved || !preferred.has(m.id));
      if (choice) return choice;
    }
  }
  return undefined;
}

export type ReviewerRequest = {
  /** Người thực thi (hoặc người tổng hợp với task cha); reviewer luôn khác người này. */
  executorId: string;
  employees: readonly SelectionCandidate[];
  /**
   * Chỉ dùng cho artifact tổng hợp của task cha: nhân viên đã làm task con. AI Manager không nằm trong tập
   * này được ưu tiên (FR-018).
   */
  involvedIds?: readonly string[];
};

/**
 * Reviewer AI độc lập theo D5: manager AI trực tiếp → AI Manager cùng `home_org_unit_id` → AI Manager bất kỳ
 * đang `active`, luôn khác người thực thi. Trả `undefined` khi không có (`NO_INDEPENDENT_REVIEWER`).
 */
export function pickReviewer(req: ReviewerRequest): SelectionCandidate | undefined {
  const executor = req.employees.find((e) => e.id === req.executorId);
  if (!executor) return undefined;
  return pickAiManagerFor(
    executor,
    activeManagers(req.employees),
    new Set([req.executorId]),
    new Set(req.involvedIds ?? []),
  );
}
