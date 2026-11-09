export type SandboxExecResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

/**
 * Máy khách của service `sandbox-runner`: nơi duy nhất chạy lệnh shell/test do agent sinh ra. Sandbox không có
 * đường tới Postgres, Redis, MinIO, API model hay internet, env không có secret, mỗi run chạy bằng UID riêng
 * (R4, action-policy.md). Worker không bao giờ tự chạy lệnh của agent.
 */
export interface SandboxClient {
  readonly available: boolean;
  exec(params: { runId: string; command: string; timeoutMs: number }): Promise<SandboxExecResult>;
  /** Tạo/chuẩn hóa `/worktrees/{runId}`: owner là UID của run, group của worker, mode `2770`. */
  prepare(params: { runId: string }): Promise<void>;
}

export class HttpSandboxClient implements SandboxClient {
  readonly available = true;

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private async post<T>(path: string, body: unknown, timeoutMs: number): Promise<T> {
    const response = await this.fetchFn(new URL(path, this.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`sandbox-runner trả ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }
    return (await response.json()) as T;
  }

  exec(params: { runId: string; command: string; timeoutMs: number }): Promise<SandboxExecResult> {
    // Cho sandbox thêm chút thời gian để tự cắt tiến trình và trả `timedOut` thay vì ngắt kết nối.
    return this.post<SandboxExecResult>('/exec', params, params.timeoutMs + 10_000);
  }

  async prepare(params: { runId: string }): Promise<void> {
    await this.post('/prepare', params, 30_000);
  }
}

/** Khi chưa cấu hình `SANDBOX_RUNNER_URL`: lệnh shell/test bị từ chối (fail-closed), tool đọc/ghi file vẫn dùng được. */
export class UnconfiguredSandboxClient implements SandboxClient {
  readonly available = false;

  async exec(): Promise<SandboxExecResult> {
    throw new Error('sandbox-runner chưa được cấu hình (SANDBOX_RUNNER_URL): không chạy được lệnh');
  }

  async prepare(): Promise<void> {
    // Không có sandbox thì không có UID riêng để chuẩn hóa quyền.
  }
}
