import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TOOL_INPUT_SCHEMAS } from '@claude-company/contracts';
import { ACTION_CATALOG, getActionDefinition } from '@claude-company/policy';
import { APPROVAL_ACTION_TYPES } from '../../../worker/src/tools/adapters/registry';

/**
 * Definition of Done của constitution (T199), phần kiểm máy được: mọi action có mức quyền, hành động Human
 * Approval luôn có adapter, và agent không có đường tới hệ thống ngoài `ToolBroker`.
 */
describe('Definition of Done (T199)', () => {
  it('mọi ActionType mà agent gọi được đều có mức quyền trong danh mục', () => {
    for (const actionType of Object.keys(TOOL_INPUT_SCHEMAS)) {
      const def = getActionDefinition(actionType);
      expect(def, `${actionType} thiếu trong ACTION_CATALOG`).toBeDefined();
      expect(def?.defaultLevel).toBeTruthy();
    }
  });

  it('action có tác dụng ra ngoài hoặc không hoàn tác được có floor human_approval và có adapter', () => {
    const sensitive = ACTION_CATALOG.filter((a) => a.floor === 'human_approval');
    expect(sensitive.map((a) => a.actionType).sort()).toEqual([...APPROVAL_ACTION_TYPES].sort());
    for (const action of sensitive) {
      expect(action.idempotency, action.actionType).toBe('dedupe');
    }
  });

  it('action cần Human Approval không bao giờ có mức mặc định thấp hơn floor', () => {
    const rank = ['auto_execute', 'review_required', 'human_approval', 'restricted'];
    for (const a of ACTION_CATALOG) {
      expect(rank.indexOf(a.defaultLevel), a.actionType).toBeGreaterThanOrEqual(
        rank.indexOf(a.floor),
      );
    }
  });

  it('network.fetch không thể sinh thành tool của agent', () => {
    expect(Object.keys(TOOL_INPUT_SCHEMAS)).not.toContain('network.fetch');
  });

  it('mã nguồn ngoài packages/model-gateway không import SDK nhà cung cấp (Nguyên tắc VI)', () => {
    const root = join(__dirname, '../../../..');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (['node_modules', 'dist', '.git', 'providers'].includes(name)) continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (
          /\.(ts|tsx)$/.test(name) &&
          /from '@anthropic-ai\//.test(readFileSync(path, 'utf8'))
        ) {
          offenders.push(path.replace(root, ''));
        }
      }
    };
    for (const dir of ['apps', 'packages/contracts', 'packages/db', 'packages/policy'])
      walk(join(root, dir));
    walk(join(root, 'packages/model-gateway/src'));
    expect(offenders).toEqual([]);
  });
});
