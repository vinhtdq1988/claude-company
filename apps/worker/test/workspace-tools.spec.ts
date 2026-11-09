import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunContext } from '../src/runtime/run-context';
import type { SandboxClient } from '../src/tools/sandbox-client';
import { RunWorkspaceManager, isInside } from '../src/tools/run-workspace';
import { PathEscapeError, createWorkspaceHandlers, resolveInside } from '../src/tools/workspace-tools';

let root: string;
let outside: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cc-run-'));
  outside = await mkdtemp(join(tmpdir(), 'cc-outside-'));
  await writeFile(join(outside, 'secret.txt'), 'bí mật');
  await writeFile(join(root, 'README.md'), '# Xin chào\nDòng hai có từ KHÓA');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

const run = (dir: string): RunContext =>
  ({
    ctx: { companyId: 'c', actor: { kind: 'ai', employeeId: 'e', runId: 'r1' }, traceId: 't' },
    runId: 'r1',
    taskId: 't',
    employeeId: 'e',
    purpose: 'execute',
    reworkCount: 0,
    expectedTaskStatus: 'in_progress',
    state: { locked: false, requiresReview: false },
    workspace: { runId: 'r1', dir, kind: 'docs_folder' },
  }) as RunContext;

describe('resolveInside', () => {
  it('chấp nhận đường dẫn tương đối trong thư mục run', async () => {
    expect(await resolveInside(root, 'a/b.txt')).toBe(join(await import('node:fs/promises').then((m) => m.realpath(root)), 'a', 'b.txt'));
  });

  it.each(['../secret.txt', 'a/../../secret.txt', '/etc/passwd', 'C:\\Windows\\win.ini', 'a\0b'])(
    'từ chối đường dẫn thoát khỏi workspace: %s',
    async (p) => {
      await expect(resolveInside(root, p)).rejects.toBeInstanceOf(PathEscapeError);
    },
  );

  it('từ chối symlink trỏ ra ngoài', async () => {
    try {
      await symlink(outside, join(root, 'link'), 'dir');
    } catch {
      return; // máy không cho tạo symlink (Windows không đặc quyền): bỏ qua
    }
    await expect(resolveInside(root, 'link/secret.txt')).rejects.toBeInstanceOf(PathEscapeError);
  });
});

describe('workspace handlers', () => {
  const sandbox: SandboxClient = {
    available: true,
    exec: vi.fn(async () => ({ exitCode: 0, stdout: 'ok', stderr: '', timedOut: false })),
    prepare: vi.fn(async () => undefined),
  };
  const handlers = () => createWorkspaceHandlers({ sandbox, toolTimeoutMs: 1000 });

  it('đọc, tìm và ghi file trong thư mục run', async () => {
    const h = handlers();
    const read = (await h.get('workspace.read')!(run(root), { path: 'README.md' })) as { content: string };
    expect(read.content).toContain('Xin chào');

    const found = (await h.get('workspace.search')!(run(root), { query: 'khóa' })) as {
      matches: Array<{ path: string; line: number }>;
    };
    expect(found.matches).toEqual([expect.objectContaining({ path: 'README.md', line: 2 })]);

    await h.get('workspace.write')!(run(root), { path: 'docs/new.md', content: 'nội dung' });
    expect(await readFile(join(root, 'docs', 'new.md'), 'utf8')).toBe('nội dung');
  });

  it('đọc/ghi ngoài workspace bị từ chối, không đụng file bên ngoài', async () => {
    const h = handlers();
    await expect(h.get('workspace.read')!(run(root), { path: '../' + outside.split(/[\\/]/).pop() + '/secret.txt' })).rejects.toBeInstanceOf(PathEscapeError);
    await expect(h.get('workspace.write')!(run(root), { path: '../x.txt', content: 'x' })).rejects.toBeInstanceOf(PathEscapeError);
  });

  it('không ghi vào thư mục .git', async () => {
    await mkdir(join(root, '.git'));
    await expect(
      handlers().get('workspace.write')!(run(root), { path: '.git/config', content: 'x' }),
    ).rejects.toBeInstanceOf(PathEscapeError);
  });

  it('shell/test chạy qua sandbox-runner, target test chứa ký tự lạ bị từ chối', async () => {
    const h = handlers();
    await h.get('workspace.shell')!(run(root), { command: 'git status' });
    expect(sandbox.exec).toHaveBeenCalledWith(expect.objectContaining({ runId: 'r1', command: 'git status' }));
    await h.get('workspace.test.run')!(run(root), { target: 'src/a.spec.ts' });
    expect(sandbox.exec).toHaveBeenLastCalledWith(expect.objectContaining({ command: 'npm test -- src/a.spec.ts' }));
    await expect(h.get('workspace.test.run')!(run(root), { target: 'a; rm -rf /' })).rejects.toThrow();
  });
});

describe('RunWorkspaceManager', () => {
  const sandbox: SandboxClient = {
    available: true,
    exec: vi.fn(),
    prepare: vi.fn(async () => undefined),
  };

  it('docs_folder: sao chép thư mục nguồn vào /worktrees/{runId} và chuẩn hóa quyền qua sandbox', async () => {
    const base = await mkdtemp(join(tmpdir(), 'cc-base-'));
    const hostRoot = await mkdtemp(join(tmpdir(), 'cc-host-'));
    try {
      await mkdir(join(hostRoot, 'docs'));
      await writeFile(join(hostRoot, 'docs', 'a.md'), 'nguồn');
      const manager = new RunWorkspaceManager({ baseDir: base, workspaceRoot: hostRoot, sandbox });
      const ws = await manager.prepare({
        runId: 'run-1',
        source: { kind: 'docs_folder', mountPath: join(hostRoot, 'docs'), defaultBranch: null },
      });
      expect(await readFile(join(ws.dir, 'a.md'), 'utf8')).toBe('nguồn');
      expect(sandbox.prepare).toHaveBeenCalledWith({ runId: 'run-1' });

      // Agent ghi vào bản sao, không đụng nguồn.
      await writeFile(join(ws.dir, 'a.md'), 'đã sửa');
      expect(await readFile(join(hostRoot, 'docs', 'a.md'), 'utf8')).toBe('nguồn');
    } finally {
      await rm(base, { recursive: true, force: true });
      await rm(hostRoot, { recursive: true, force: true });
    }
  });

  it('run rework sao chép nguyên thư mục của run trước, gồm thay đổi chưa commit', async () => {
    const base = await mkdtemp(join(tmpdir(), 'cc-base-'));
    try {
      const manager = new RunWorkspaceManager({ baseDir: base, workspaceRoot: base, sandbox });
      const first = await manager.prepare({ runId: 'run-1' });
      await writeFile(join(first.dir, 'draft.md'), 'dang dở, chưa commit');
      const second = await manager.prepare({ runId: 'run-2', previousRunId: 'run-1' });
      expect(await readFile(join(second.dir, 'draft.md'), 'utf8')).toBe('dang dở, chưa commit');
      expect(second.dir).not.toBe(first.dir);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('workspace nguồn nằm ngoài WORKSPACE_HOST_PATH bị từ chối', async () => {
    const base = await mkdtemp(join(tmpdir(), 'cc-base-'));
    try {
      const manager = new RunWorkspaceManager({ baseDir: base, workspaceRoot: join(base, 'allowed'), sandbox });
      await expect(
        manager.prepare({
          runId: 'run-9',
          source: { kind: 'docs_folder', mountPath: outside, defaultBranch: null },
        }),
      ).rejects.toThrow(/WORKSPACE_HOST_PATH/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('isInside: chuẩn hóa và chặn thoát bằng ..', () => {
    expect(isInside('/a/b', '/a/b/c')).toBe(true);
    expect(isInside('/a/b', '/a/b/../c')).toBe(false);
    expect(isInside('/a/b', '/a/bc')).toBe(false);
  });
});
