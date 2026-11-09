import { lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ToolInput } from '@claude-company/contracts';
import type { RunContext, ToolHandler } from '../runtime/run-context';
import type { SandboxClient } from './sandbox-client';

/** Số byte tối đa trả về cho agent khi đọc một file. */
const MAX_READ_BYTES = 200_000;
const MAX_SEARCH_RESULTS = 50;
const MAX_SEARCH_FILE_BYTES = 1_000_000;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage']);
const SAFE_TEST_TARGET = /^[\w@./:=,-]+$/;

export class PathEscapeError extends Error {}

/**
 * Giải đường dẫn tương đối của agent thành đường dẫn tuyệt đối TRONG thư mục làm việc của run.
 * Chặn đường dẫn tuyệt đối, `..` và symlink thoát ra ngoài (kiểm tra bằng realpath của tổ tiên gần nhất tồn tại).
 */
export async function resolveInside(root: string, requested: string): Promise<string> {
  if (requested.includes('\0')) throw new PathEscapeError('Đường dẫn chứa ký tự không hợp lệ');
  if (isAbsolute(requested)) throw new PathEscapeError('Chỉ chấp nhận đường dẫn tương đối');
  const realRoot = await realpath(root);
  const target = resolve(realRoot, requested);
  const lexical = relative(realRoot, target);
  if (lexical.startsWith('..') || isAbsolute(lexical)) {
    throw new PathEscapeError('Đường dẫn thoát khỏi thư mục làm việc');
  }
  // Tổ tiên gần nhất đã tồn tại phải nằm trong root sau khi giải symlink.
  let probe = target;
  for (;;) {
    try {
      await lstat(probe);
      break;
    } catch {
      const parent = dirname(probe);
      if (parent === probe) throw new PathEscapeError('Đường dẫn không hợp lệ');
      probe = parent;
    }
  }
  const realProbe = await realpath(probe);
  const rel = relative(realRoot, realProbe);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new PathEscapeError('Đường dẫn trỏ ra ngoài thư mục làm việc qua symlink');
  }
  return target;
}

function requireWorkspace(run: RunContext): string {
  if (!run.workspace) throw new Error('Run chưa có thư mục làm việc');
  return run.workspace.dir;
}

async function* walk(dir: string, root: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(full, root);
    } else if (entry.isFile()) {
      yield relative(root, full).split(sep).join('/');
    }
  }
}

export type WorkspaceToolsOptions = {
  sandbox: SandboxClient;
  toolTimeoutMs: number;
};

/** Tool workspace: đọc/tìm/ghi chạy trong worker (chỉ trên thư mục của run), shell/test chạy trong `sandbox-runner`. */
export function createWorkspaceHandlers(options: WorkspaceToolsOptions): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();

  handlers.set('workspace.read', async (run, raw) => {
    const { path } = raw as ToolInput<'workspace.read'>;
    const file = await resolveInside(requireWorkspace(run), path);
    const content = await readFile(file);
    const truncated = content.length > MAX_READ_BYTES;
    return {
      path,
      truncated,
      content: content.subarray(0, MAX_READ_BYTES).toString('utf8'),
      sizeBytes: content.length,
    };
  });

  handlers.set('workspace.search', async (run, raw) => {
    const { query, path } = raw as ToolInput<'workspace.search'>;
    const root = requireWorkspace(run);
    const start = path ? await resolveInside(root, path) : root;
    const needle = query.toLowerCase();
    const matches: Array<{ path: string; line: number; text: string }> = [];
    for await (const file of walk(start, root)) {
      if (matches.length >= MAX_SEARCH_RESULTS) break;
      const full = join(root, file);
      const info = await lstat(full);
      if (info.size > MAX_SEARCH_FILE_BYTES) continue;
      const text = (await readFile(full)).toString('utf8');
      const lines = text.split('\n');
      for (let i = 0; i < lines.length && matches.length < MAX_SEARCH_RESULTS; i += 1) {
        if (lines[i]!.toLowerCase().includes(needle)) {
          matches.push({ path: file, line: i + 1, text: lines[i]!.slice(0, 300) });
        }
      }
    }
    return { query, matches, truncated: matches.length >= MAX_SEARCH_RESULTS };
  });

  handlers.set('workspace.write', async (run, raw) => {
    const { path, content } = raw as ToolInput<'workspace.write'>;
    const root = requireWorkspace(run);
    const file = await resolveInside(root, path);
    // Không ghi vào metadata git: lịch sử chỉ thay đổi qua `git` trong sandbox (đã phân loại).
    const rel = relative(await realpath(root), file).split(sep);
    if (rel[0] === '.git') throw new PathEscapeError('Không ghi vào thư mục .git');
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content, 'utf8');
    return { path, sizeBytes: Buffer.byteLength(content) };
  });

  const runCommand = async (run: RunContext, command: string) => {
    requireWorkspace(run);
    const result = await options.sandbox.exec({
      runId: run.runId,
      command,
      timeoutMs: options.toolTimeoutMs,
    });
    const clip = (s: string) => (s.length > 20_000 ? `${s.slice(0, 20_000)}\n…(đã cắt)` : s);
    return { exitCode: result.exitCode, timedOut: result.timedOut, stdout: clip(result.stdout), stderr: clip(result.stderr) };
  };

  handlers.set('workspace.shell', (run, raw) =>
    runCommand(run, (raw as ToolInput<'workspace.shell'>).command),
  );

  handlers.set('workspace.test.run', async (run, raw) => {
    const { target } = raw as ToolInput<'workspace.test.run'>;
    if (target !== undefined && target !== '' && !SAFE_TEST_TARGET.test(target)) {
      throw new Error('Tên mục tiêu test chứa ký tự không hợp lệ');
    }
    return runCommand(run, target ? `npm test -- ${target}` : 'npm test');
  });

  return handlers;
}
