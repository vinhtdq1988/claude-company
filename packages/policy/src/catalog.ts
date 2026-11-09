import type { PermissionLevel, RuntimeKind } from '@claude-company/contracts';

/** Thứ tự chặt dần: auto_execute < review_required < human_approval < restricted. */
export const PERMISSION_LEVELS: readonly PermissionLevel[] = [
  'auto_execute',
  'review_required',
  'human_approval',
  'restricted',
];

export function levelRank(level: PermissionLevel): number {
  return PERMISSION_LEVELS.indexOf(level);
}

export function maxLevel(...levels: PermissionLevel[]): PermissionLevel {
  return levels.reduce((acc, l) => (levelRank(l) > levelRank(acc) ? l : acc), 'auto_execute');
}

/** `dedupe`: khóa ổn định theo task (hành động có tác dụng phụ); `rerun`: khóa theo run + bước. */
export type IdempotencyLabel = 'dedupe' | 'rerun';

export type ActionDefinition = {
  actionType: string;
  description: string;
  defaultLevel: PermissionLevel;
  /** Mức tối thiểu không hạ được bằng cấu hình. */
  floor: PermissionLevel;
  /** Runtime được phép dùng; rỗng nghĩa là không runtime nào. */
  runtimes: readonly RuntimeKind[];
  idempotency: IdempotencyLabel;
};

const BOTH: readonly RuntimeKind[] = ['claude_agent_sdk', 'messages_api'];
const SDK: readonly RuntimeKind[] = ['claude_agent_sdk'];
const API: readonly RuntimeKind[] = ['messages_api'];

/** Nguồn: contracts/action-policy.md. Action ngoài danh mục là `restricted`. */
export const ACTION_CATALOG: readonly ActionDefinition[] = [
  {
    actionType: 'workspace.read',
    description: 'Đọc file/tài liệu trong workspace được cấp',
    defaultLevel: 'auto_execute',
    floor: 'auto_execute',
    runtimes: BOTH,
    idempotency: 'rerun',
  },
  {
    actionType: 'workspace.search',
    description: 'Tìm kiếm trong workspace',
    defaultLevel: 'auto_execute',
    floor: 'auto_execute',
    runtimes: BOTH,
    idempotency: 'rerun',
  },
  {
    actionType: 'workspace.write',
    description: 'Tạo/sửa file trong thư mục làm việc của run',
    defaultLevel: 'review_required',
    floor: 'review_required',
    runtimes: BOTH,
    idempotency: 'rerun',
  },
  {
    actionType: 'workspace.shell',
    description: 'Chạy lệnh trong sandbox (chạy test, build)',
    defaultLevel: 'review_required',
    floor: 'review_required',
    runtimes: SDK,
    idempotency: 'rerun',
  },
  {
    actionType: 'workspace.test.run',
    description: 'Chạy bộ test đã cấu hình',
    defaultLevel: 'auto_execute',
    floor: 'auto_execute',
    runtimes: BOTH,
    idempotency: 'rerun',
  },
  {
    actionType: 'artifact.publish',
    description: 'Nộp artifact cho task',
    defaultLevel: 'auto_execute',
    floor: 'auto_execute',
    runtimes: BOTH,
    idempotency: 'dedupe',
  },
  {
    actionType: 'task.message.post',
    description: 'Gửi trao đổi trên task',
    defaultLevel: 'auto_execute',
    floor: 'auto_execute',
    runtimes: BOTH,
    idempotency: 'dedupe',
  },
  {
    actionType: 'task.decompose.propose',
    description: 'AI Manager đề xuất phân rã',
    defaultLevel: 'auto_execute',
    floor: 'auto_execute',
    runtimes: API,
    idempotency: 'dedupe',
  },
  {
    actionType: 'email.send',
    description: 'Gửi email qua EmailAdapter',
    defaultLevel: 'human_approval',
    floor: 'human_approval',
    runtimes: BOTH,
    idempotency: 'dedupe',
  },
  {
    actionType: 'data.delete',
    description: 'Xóa dữ liệu qua DataDeleteAdapter',
    defaultLevel: 'human_approval',
    floor: 'human_approval',
    runtimes: BOTH,
    idempotency: 'dedupe',
  },
  {
    actionType: 'deploy.staging',
    description: 'Deploy staging qua DeployAdapter',
    defaultLevel: 'human_approval',
    floor: 'human_approval',
    runtimes: BOTH,
    idempotency: 'dedupe',
  },
  {
    actionType: 'deploy.production',
    description: 'Deploy production',
    defaultLevel: 'human_approval',
    floor: 'human_approval',
    runtimes: BOTH,
    idempotency: 'dedupe',
  },
  {
    actionType: 'workspace.git.push',
    description: 'Push lên remote',
    defaultLevel: 'human_approval',
    floor: 'human_approval',
    runtimes: SDK,
    idempotency: 'dedupe',
  },
  {
    actionType: 'network.fetch',
    description: 'Gọi mạng tùy ý',
    defaultLevel: 'restricted',
    floor: 'restricted',
    runtimes: [],
    idempotency: 'dedupe',
  },
];

const BY_TYPE = new Map(ACTION_CATALOG.map((a) => [a.actionType, a]));

export function getActionDefinition(actionType: string): ActionDefinition | undefined {
  return BY_TYPE.get(actionType);
}

export function isCatalogAction(actionType: string): boolean {
  return BY_TYPE.has(actionType);
}

/** Action có floor human_approval: agent chỉ tạo đề xuất, hệ thống thực thi sau khi duyệt. */
export function isHumanApprovalAction(actionType: string): boolean {
  const def = BY_TYPE.get(actionType);
  return (
    def !== undefined &&
    levelRank(def.floor) >= levelRank('human_approval') &&
    def.floor !== 'restricted'
  );
}

export type ToolGrantIssue = {
  actionType: string;
  reason: 'unknown_action' | 'runtime_incompatible';
};

/**
 * Kiểm tra `tool_grants` của một AI Employee: mỗi mục phải thuộc danh mục ActionType và có Runtime
 * khớp `runtimeKind` (cột Runtime của action-policy.md). `network.fetch` không runtime nào dùng được nên luôn bị loại.
 */
export function validateToolGrants(
  toolGrants: readonly string[],
  runtimeKind: RuntimeKind,
): ToolGrantIssue[] {
  const issues: ToolGrantIssue[] = [];
  for (const actionType of new Set(toolGrants)) {
    const def = BY_TYPE.get(actionType);
    if (!def) issues.push({ actionType, reason: 'unknown_action' });
    else if (!def.runtimes.includes(runtimeKind)) {
      issues.push({ actionType, reason: 'runtime_incompatible' });
    }
  }
  return issues;
}
