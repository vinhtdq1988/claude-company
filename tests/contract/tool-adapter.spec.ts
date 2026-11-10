import { appendFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolAdapter } from '@claude-company/contracts';
import { DataDeleteAdapter } from '../../apps/worker/src/tools/adapters/data-delete.adapter';
import { DeployAdapter } from '../../apps/worker/src/tools/adapters/deploy.adapter';
import { DryRunLog } from '../../apps/worker/src/tools/adapters/dry-run-log';
import { EmailAdapter } from '../../apps/worker/src/tools/adapters/email.adapter';
import { GitPushAdapter } from '../../apps/worker/src/tools/adapters/git-push.adapter';
import {
  APPROVAL_ACTION_TYPES,
  createAdapterRegistry,
} from '../../apps/worker/src/tools/adapters/registry';

/**
 * Contract test `ToolAdapter` (T126; FR-027, R4): idempotency theo key, `lookup` cho recovery, kết quả dry-run có nhãn,
 * chế độ `live` chưa cấu hình trả `ADAPTER_LIVE_NOT_CONFIGURED`. Chạy được không cần Docker (log là file JSONL).
 */
describe('Contract: ToolAdapter (T126)', () => {
  let dir: string;
  let log: DryRunLog;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cc-adapter-'));
    log = new DryRunLog(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const cases: Array<{
    name: string;
    make: () => ToolAdapter;
    actionType: string;
    payload: unknown;
  }> = [
    {
      name: 'EmailAdapter',
      make: () => new EmailAdapter(log),
      actionType: 'email.send',
      payload: { to: ['a@x.vn'], subject: 'Chào', body: 'Nội dung' },
    },
    {
      name: 'DataDeleteAdapter',
      make: () => new DataDeleteAdapter(log),
      actionType: 'data.delete',
      payload: { target: 'bảng khách hàng', reason: 'Dọn dữ liệu thử' },
    },
    {
      name: 'DeployAdapter (staging)',
      make: () => new DeployAdapter(log, 'deploy.staging'),
      actionType: 'deploy.staging',
      payload: { ref: 'main', notes: 'thử' },
    },
    {
      name: 'DeployAdapter (production)',
      make: () => new DeployAdapter(log, 'deploy.production'),
      actionType: 'deploy.production',
      payload: { ref: 'v1.0.0' },
    },
    {
      name: 'GitPushAdapter',
      make: () => new GitPushAdapter(log),
      actionType: 'workspace.git.push',
      payload: { remote: 'origin', branch: 'main' },
    },
  ];

  describe.each(cases)('$name', ({ make, actionType, payload }) => {
    it('khai báo đúng action và chế độ dry_run', () => {
      const adapter = make();
      expect(adapter.actionTypes).toEqual([actionType]);
      expect(adapter.mode).toBe('dry_run');
    });

    it('execute ghi đúng payload đã duyệt vào log và trả kết quả có nhãn dry-run', async () => {
      const adapter = make();
      const result = await adapter.execute(payload, 'key-1');
      expect(result.status).toBe('ok');
      expect(result.output).toMatchObject({ dryRun: true, label: 'dry-run', actionType });
      const entries = await log.read();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        idempotencyKey: 'key-1',
        actionType,
        payload,
        mode: 'dry_run',
      });
    });

    it('idempotent: cùng key thực thi hai lần chỉ ghi một dòng và trả cùng thời điểm', async () => {
      const adapter = make();
      const first = await adapter.execute(payload, 'key-1');
      const second = await adapter.execute(payload, 'key-1');
      expect(second).toEqual(first);
      expect(await log.read()).toHaveLength(1);
    });

    it('key khác nhau là hành động khác nhau', async () => {
      const adapter = make();
      await adapter.execute(payload, 'key-1');
      await adapter.execute(payload, 'key-2');
      expect((await log.read()).map((e) => e.idempotencyKey)).toEqual(['key-1', 'key-2']);
    });

    it('lookup: not_found trước khi thực thi, succeeded sau đó (recovery không thực thi lặp)', async () => {
      const adapter = make();
      expect(await adapter.lookup('key-1')).toBe('not_found');
      await adapter.execute(payload, 'key-1');
      expect(await adapter.lookup('key-1')).toBe('succeeded');
      expect(await adapter.lookup('key-khac')).toBe('not_found');
    });
  });

  it('log chịu được dòng hỏng do ghi dở khi sập: bỏ qua dòng đó, lookup vẫn đúng', async () => {
    const adapter = new EmailAdapter(log);
    await adapter.execute({ to: ['a@x.vn'], subject: 's', body: 'b' }, 'key-1');
    await appendFile(log.file, '{"idempotencyKey":"key-2","action');
    expect(await adapter.lookup('key-1')).toBe('succeeded');
    expect(await adapter.lookup('key-2')).toBe('not_found');
  });

  it('thư mục log chưa tồn tại: lookup trả not_found và execute tự tạo thư mục', async () => {
    const nested = new DryRunLog(join(dir, 'chua', 'co'));
    const adapter = new EmailAdapter(nested);
    expect(await adapter.lookup('k')).toBe('not_found');
    await adapter.execute({ to: ['a@x.vn'], subject: 's', body: 'b' }, 'k');
    expect(await nested.read()).toHaveLength(1);
  });

  it('lookup trả unknown khi không đọc được log', async () => {
    // Một thư mục đứng ở vị trí file log: đọc ném EISDIR (không phải ENOENT) nên không xác định được trạng thái.
    await mkdir(log.file);
    expect(await new EmailAdapter(log).lookup('k')).toBe('unknown');
  });

  describe('registry', () => {
    it('dry_run: có adapter cho mọi action cần Human Approval và không cho action khác', () => {
      const registry = createAdapterRegistry({ mode: 'dry_run', logDir: dir });
      for (const actionType of APPROVAL_ACTION_TYPES) {
        const adapter = registry.find(actionType);
        expect(adapter, actionType).toBeDefined();
        expect(adapter!.mode).toBe('dry_run');
        expect(adapter!.actionTypes).toContain(actionType);
      }
      for (const other of ['network.fetch', 'workspace.write', 'artifact.publish', 'lạ.hoắc']) {
        expect(registry.find(other)).toBeUndefined();
      }
    });

    it('deploy.production và deploy.staging ghi đúng loại hành động vào log', async () => {
      const registry = createAdapterRegistry({ mode: 'dry_run', logDir: dir });
      await registry.find('deploy.production')!.execute({ ref: 'v1' }, 'p');
      await registry.find('deploy.staging')!.execute({ ref: 'v1' }, 's');
      expect((await log.read()).map((e) => e.actionType)).toEqual([
        'deploy.production',
        'deploy.staging',
      ]);
    });

    it('live chưa cấu hình: execute ném ADAPTER_LIVE_NOT_CONFIGURED và không ghi gì', async () => {
      const registry = createAdapterRegistry({ mode: 'live', logDir: dir });
      for (const actionType of APPROVAL_ACTION_TYPES) {
        const adapter = registry.find(actionType)!;
        expect(adapter.mode).toBe('live');
        await expect(adapter.execute({}, 'k')).rejects.toMatchObject({
          code: 'ADAPTER_LIVE_NOT_CONFIGURED',
        });
        expect(await adapter.lookup('k')).toBe('not_found');
      }
      expect(await log.read()).toHaveLength(0);
    });
  });
});
