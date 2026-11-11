import { execFile } from 'node:child_process';
import { chmod, cp, mkdir, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Workspace } from '@claude-company/contracts';
import type { RunWorkspace } from '../runtime/run-context';
import type { SandboxClient } from './sandbox-client';

const execFileAsync = promisify(execFile);

export type RunWorkspaceOptions = {
  /** `RUN_WORKTREES_PATH`: thư mục cha của `/worktrees/{runId}` (volume `run_worktrees`). */
  baseDir: string;
  /** `WORKSPACE_HOST_PATH`: gốc cho phép của workspace nguồn. */
  workspaceRoot: string;
  sandbox: SandboxClient;
  /** Thay thế chạy `git` (test). */
  git?: (args: string[], cwd?: string) => Promise<void>;
};

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** `child` nằm trong `root` (đã chuẩn hóa), không thoát bằng `..`. */
export function isInside(root: string, child: string): boolean {
  const rel = relative(resolve(root), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Mỗi run có thư mục làm việc riêng `/worktrees/{runId}` (R12): `git_repo` dùng `git clone --local` với branch
 * `cc/run-{id}` để không chia sẻ metadata git giữa các run; `docs_folder` là bản sao thư mục. Agent không bao giờ
 * ghi vào nguồn. Run rework, retry và run sau `resume` của cùng task sao chép NGUYÊN thư mục của run gần nhất
 * (gồm thay đổi chưa commit, nên không dùng `git clone`) rồi đổi owner sang UID của run mới (FR-044).
 */
export class RunWorkspaceManager {
  constructor(private readonly options: RunWorkspaceOptions) {}

  dirOf(runId: string): string {
    return join(this.options.baseDir, runId);
  }

  async prepare(input: {
    runId: string;
    source?: Pick<Workspace, 'kind' | 'mountPath' | 'defaultBranch'> | null;
    previousRunId?: string | null;
    /** Gốc cho phép theo cài đặt của công ty; thiếu thì dùng `options.workspaceRoot`. */
    workspaceRoot?: string;
  }): Promise<RunWorkspace> {
    const dir = this.dirOf(input.runId);
    if (await exists(dir)) {
      await this.options.sandbox.prepare({ runId: input.runId });
      return { runId: input.runId, dir, kind: input.source?.kind ?? 'empty' };
    }
    await mkdir(this.options.baseDir, { recursive: true });

    const previous = input.previousRunId ? this.dirOf(input.previousRunId) : null;
    if (previous && (await exists(previous))) {
      await cp(previous, dir, {
        recursive: true,
        preserveTimestamps: true,
        verbatimSymlinks: true,
      });
    } else if (input.source) {
      await this.populateFromSource(
        dir,
        input.runId,
        input.source,
        input.workspaceRoot ?? this.options.workspaceRoot,
      );
    } else {
      await mkdir(dir, { recursive: true });
    }
    await this.normalizeModes(dir);
    await this.options.sandbox.prepare({ runId: input.runId });
    return { runId: input.runId, dir, kind: input.source?.kind ?? 'empty' };
  }

  /**
   * Thư mục run do worker tạo (owner = worker) nên chỉ worker đổi được mode. `sandbox-runner` chỉ có CAP_CHOWN,
   * SETUID, SETGID (không có DAC_OVERRIDE): cây con phải đọc/duyệt được thì nó mới chown được sang UID của run.
   * Thư mục gốc của run trở lại `2770` (setgid, group worker) nên UID khác vẫn không vào được.
   */
  private async normalizeModes(dir: string): Promise<void> {
    if (process.platform === 'win32') return; // Không có UID/group kiểu POSIX; chỉ chạy dev không Docker.
    await execFileAsync('chmod', ['-R', 'a+rX', dir]);
    await chmod(dir, 0o2770);
  }

  private async populateFromSource(
    dir: string,
    runId: string,
    source: Pick<Workspace, 'kind' | 'mountPath' | 'defaultBranch'>,
    workspaceRoot: string,
  ): Promise<void> {
    const mount = resolve(source.mountPath);
    if (!isInside(workspaceRoot, mount)) {
      throw new Error('Workspace nằm ngoài WORKSPACE_HOST_PATH');
    }
    if (source.kind === 'docs_folder') {
      await cp(mount, dir, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
      return;
    }
    const git =
      this.options.git ??
      ((args, cwd) => execFileAsync('git', args, { cwd }).then(() => undefined));
    await git(['clone', '--local', '--no-hardlinks', mount, dir]);
    await git(['checkout', '-b', `cc/run-${runId}`], dir);
    await git(['config', 'user.name', 'Claude Company Agent'], dir);
    await git(['config', 'user.email', 'agent@claude-company.local'], dir);
  }
}
