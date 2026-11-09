import { describe, expect, it } from 'vitest';
import { ACTION_CATALOG } from '@claude-company/policy';
import {
  actionTypeForTool,
  buildToolSpecs,
  toolNameFor,
} from '../src/runtime/tool-specs';

const names = (specs: ReturnType<typeof buildToolSpecs>) => specs.map((s) => s.name).sort();

describe('buildToolSpecs', () => {
  it('tên tool là ActionType đổi "." thành "_"', () => {
    expect(toolNameFor('email.send')).toBe('email_send');
    expect(toolNameFor('workspace.git.push')).toBe('workspace_git_push');
  });

  it('chỉ sinh tool đã cấp, đúng runtime', () => {
    const specs = buildToolSpecs(['workspace.read', 'artifact.publish', 'workspace.shell'], 'messages_api');
    // workspace.shell chỉ dành cho claude_agent_sdk
    expect(names(specs)).toEqual(['artifact_publish', 'workspace_read']);
    const sdk = buildToolSpecs(['workspace.read', 'workspace.shell'], 'claude_agent_sdk');
    expect(names(sdk)).toEqual(['workspace_read', 'workspace_shell']);
  });

  it('không bao giờ sinh network.fetch dù được cấp', () => {
    for (const runtime of ['claude_agent_sdk', 'messages_api'] as const) {
      expect(buildToolSpecs(['network.fetch'], runtime)).toEqual([]);
    }
  });

  it('không sinh tool cho action ngoài danh mục hoặc chưa cấp', () => {
    expect(buildToolSpecs(['made.up.action'], 'claude_agent_sdk')).toEqual([]);
    expect(buildToolSpecs([], 'messages_api')).toEqual([]);
  });

  it('mọi ActionType có runtime đều có schema và JSON Schema dạng object', () => {
    for (const def of ACTION_CATALOG.filter((a) => a.runtimes.length > 0)) {
      for (const runtime of def.runtimes) {
        const [spec] = buildToolSpecs([def.actionType], runtime);
        expect(spec, def.actionType).toBeDefined();
        expect(spec?.actionType).toBe(def.actionType);
        expect(spec?.inputSchema.type).toBe('object');
        expect(spec?.zodShape).toBeDefined();
      }
    }
  });

  it('loại trùng lặp trong tool_grants', () => {
    expect(buildToolSpecs(['workspace.read', 'workspace.read'], 'messages_api')).toHaveLength(1);
  });

  it('bảng ánh xạ tên tool ↔ ActionType hai chiều; tên lạ không ánh xạ được', () => {
    expect(actionTypeForTool('workspace_git_push')).toBe('workspace.git.push');
    expect(actionTypeForTool('email_send')).toBe('email.send');
    expect(actionTypeForTool('network_fetch')).toBeUndefined();
    expect(actionTypeForTool('rm_rf')).toBeUndefined();
  });

  it('action Human Approval có schema input (email.send, data.delete, deploy.*, git.push)', () => {
    const grants = ['email.send', 'data.delete', 'deploy.staging', 'deploy.production'];
    expect(names(buildToolSpecs(grants, 'messages_api'))).toEqual([
      'data_delete',
      'deploy_production',
      'deploy_staging',
      'email_send',
    ]);
    expect(names(buildToolSpecs(['workspace.git.push'], 'claude_agent_sdk'))).toEqual([
      'workspace_git_push',
    ]);
  });
});
