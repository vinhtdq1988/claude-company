import { DomainError, type ToolAdapter, type ToolResult } from '@claude-company/contracts';
import { DataDeleteAdapter } from './data-delete.adapter';
import { DeployAdapter } from './deploy.adapter';
import { DryRunLog } from './dry-run-log';
import { EmailAdapter } from './email.adapter';
import { GitPushAdapter } from './git-push.adapter';

/** Mọi action cần Human Approval trong v1.0 (floor `human_approval`, action-policy.md). */
export const APPROVAL_ACTION_TYPES = [
  'email.send',
  'data.delete',
  'deploy.staging',
  'deploy.production',
  'workspace.git.push',
] as const;

/**
 * Chế độ `live` chưa có tích hợp thật trong v1.0 (FR-027): thực thi trả lỗi rõ ràng thay vì âm thầm giả lập,
 * để task bị chặn với `ADAPTER_LIVE_NOT_CONFIGURED` thay vì được coi là đã gửi/deploy thật.
 */
export class LiveUnconfiguredAdapter implements ToolAdapter {
  readonly mode = 'live' as const;

  constructor(readonly actionTypes: string[]) {}

  async execute(): Promise<ToolResult> {
    throw new DomainError(
      'ADAPTER_LIVE_NOT_CONFIGURED',
      'Adapter thật (live) chưa được cấu hình; v1.0 chỉ hỗ trợ dry_run',
    );
  }

  async lookup(): Promise<'not_found'> {
    return 'not_found';
  }
}

/** Bảng tra adapter theo `ActionType`, bind vào token `TOOL_ADAPTER_LOOKUP`. */
export class AdapterRegistry {
  private readonly byAction = new Map<string, ToolAdapter>();

  constructor(adapters: readonly ToolAdapter[]) {
    for (const adapter of adapters) {
      for (const actionType of adapter.actionTypes) this.byAction.set(actionType, adapter);
    }
  }

  find(actionType: string): ToolAdapter | undefined {
    return this.byAction.get(actionType);
  }
}

/** Chọn adapter theo `ADAPTER_MODE`: `dry_run` ghi vào log JSONL, `live` luôn lỗi `ADAPTER_LIVE_NOT_CONFIGURED`. */
export function createAdapterRegistry(options: {
  mode: 'dry_run' | 'live';
  logDir: string;
}): AdapterRegistry {
  if (options.mode === 'live') {
    return new AdapterRegistry([new LiveUnconfiguredAdapter([...APPROVAL_ACTION_TYPES])]);
  }
  const log = new DryRunLog(options.logDir);
  return new AdapterRegistry([
    new EmailAdapter(log),
    new DataDeleteAdapter(log),
    new DeployAdapter(log, 'deploy.staging'),
    new DeployAdapter(log, 'deploy.production'),
    new GitPushAdapter(log),
  ]);
}
