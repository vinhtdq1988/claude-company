import type { ChildProcess } from 'node:child_process';
import type { Server } from 'node:http';

export const RUN_ID_PATTERN: RegExp;
export function buildCommandEnv(dir: string): Record<string, string>;
export function pickUid(runId: string, taken: Set<number>): number;

export type SandboxFs = {
  chown(path: string, uid: number, gid: number): Promise<void>;
  lchown(path: string, uid: number, gid: number): Promise<void>;
  lstat(path: string): Promise<{ uid: number; isDirectory(): boolean; isSymbolicLink(): boolean }>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>;
  readdir(path: string): Promise<string[]>;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
};

export type SandboxSpawn = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    uid: number;
    gid: number;
    detached: boolean;
    stdio: unknown;
  },
) => ChildProcess;

export function createSandboxServer(
  config: { token: string; worktreesDir: string; workerGid: number; stateFile?: string },
  deps?: { fs?: SandboxFs; spawn?: SandboxSpawn },
): {
  server: Server;
  prepare(runId: string): Promise<number>;
  uidOf(runId: string): Promise<number>;
};
