import { describe, expect, it, vi } from 'vitest';
import type { AgentRunEvent, AgentRunIO, AgentRunRequest } from '@claude-company/model-gateway';
import { RunExecutor, type RunLoopDeps } from '../src/runtime/run-loop';
import type { RunContext } from '../src/runtime/run-context';

const PRICE = {
  modelId: 'm',
  inputPerMtok: 1,
  outputPerMtok: 1,
  cacheReadPerMtok: 0,
  cacheWritePerMtok: 0,
};

type Overrides = {
  status?: 'queued' | 'waiting_approval';
  runtimeKind?: 'claude_agent_sdk' | 'messages_api';
  providerSessionId?: string | null;
  approval?: Record<string, unknown>;
  conversation?: unknown;
};

/** RunExecutor với phụ thuộc giả đủ dùng để kiểm tra riêng nhánh tạm dừng và resume sau phê duyệt (US4). */
function setup(
  script: (req: AgentRunRequest, io: AgentRunIO) => AsyncGenerator<AgentRunEvent>,
  over: Overrides = {},
) {
  const statuses: Array<{ status?: string; errorCode?: string }> = [];
  const requests: AgentRunRequest[] = [];
  let status = over.status ?? 'queued';
  const run = () => ({
    id: 'run-1',
    taskId: 'task-1',
    employeeId: 'emp-1',
    purpose: 'execute',
    attempt: 1,
    status,
    runtimeKind: over.runtimeKind ?? 'claude_agent_sdk',
    modelId: 'm',
    providerSessionId: over.providerSessionId === undefined ? 's-1' : over.providerSessionId,
    steps: [],
    toolInvocations: [
      {
        id: 'inv-1',
        status: 'succeeded',
        adapterMode: 'dry_run',
        result: { dryRun: true },
      },
    ],
  });
  const orchestration = {
    getRun: vi.fn(async () => run()),
    updateRunStatus: vi.fn(
      async (_c: unknown, _r: string, patch: { status?: string; errorCode?: string }) => {
        statuses.push(patch);
        if (patch.status) status = patch.status as typeof status;
      },
    ),
    heartbeat: vi.fn(async () => 'running'),
    publishRunEvent: vi.fn(async () => undefined),
    appendRunStep: vi.fn(async () => ({ id: 's', seq: 1 })),
    listRuns: vi.fn(async () => ({ items: [], nextCursor: null })),
    loadConversationState: vi.fn(async () => over.conversation ?? null),
    saveConversationState: vi.fn(async () => undefined),
    enqueueRetry: vi.fn(async () => ({ runId: 'run-2' })),
  };
  const budget = {
    isModelAllowed: vi.fn(async () => true),
    reserve: vi.fn(async () => ({
      ok: true,
      reservationId: 'res',
      remainingUsd: 9,
      remainingTokens: 9,
    })),
    commit: vi.fn(async () => ({ warnings: [], overage: false })),
    release: vi.fn(async () => undefined),
    releaseRun: vi.fn(async () => undefined),
    getUsage: vi.fn(async () => ({ tokens: 0, costUsd: 0 })),
  };
  const tasks = {
    get: vi.fn(async () => ({
      id: 'task-1',
      status: 'in_progress',
      tokenCap: null,
      costCap: null,
      reworkCount: 0,
    })),
    transition: vi.fn(async () => undefined),
  };
  const broker = {
    invoke: vi.fn(async (ctx: RunContext) => {
      ctx.state.pendingApprovalId = 'apr-1';
      ctx.state.locked = true;
      return { status: 'pending_approval', output: { approvalRequestId: 'apr-1' } };
    }),
  };
  const deps = {
    gateway: {
      runAgent: (req: AgentRunRequest, io: AgentRunIO) => {
        requests.push(req);
        return script(req, io);
      },
    },
    tasks,
    employees: {
      get: vi.fn(async () => ({
        id: 'emp-1',
        status: 'active',
        toolGrants: ['email.send'],
        workspaceId: null,
        systemPrompt: 'x',
      })),
      getWorkspace: vi.fn(),
    },
    orchestration,
    permissions: {
      getApproval: vi.fn(async () => ({
        toolInvocationId: 'inv-1',
        actionType: 'email.send',
        summary: 'Gửi email',
        status: 'approved',
        decisionReason: 'ok',
        ...over.approval,
      })),
    },
    budget,
    communication: { notifyRouted: vi.fn(async () => undefined) },
    catalog: { listModels: vi.fn(async () => [PRICE]) },
    broker,
    inputs: { build: vi.fn(async () => 'INPUT-GOC') },
    workspaces: { prepare: vi.fn(async () => ({ runId: 'run-1', dir: '/w', kind: 'empty' })) },
    cost: {
      computeCostUsd: () => 0.001,
      estimateSdkRun: () => ({ blocked: false, estTokens: 100, estCostUsd: 1 }),
      sdkMaxBudgetUsd: () => 1,
      sdkTokenCeiling: () => 1_000_000,
    },
    config: {
      RETRY_MAX: 1,
      RETRY_BACKOFF_INITIAL_MS: 1,
      RETRY_BACKOFF_MAX_MS: 1,
      RUN_TIMEOUT_MS: 60_000,
      MODEL_TIMEOUT_MS: 60_000,
      RUN_HEARTBEAT_INTERVAL_MS: 60_000,
      SDK_BUDGET_HEADROOM: 0.1,
      SDK_RUN_RESERVE_USD: 2,
      SDK_RUN_RESERVE_TOKENS: 1000,
      DEFAULT_MONTHLY_COST_LIMIT_USD: 20,
    },
    lockTask: async () => ({ release: async () => undefined }),
    logger: { error: vi.fn(), warn: vi.fn() },
  } as unknown as RunLoopDeps;
  const executor = new RunExecutor(deps);
  const job = (extra: Record<string, unknown> = {}) => ({
    companyId: 'c1',
    taskId: 'task-1',
    runId: 'run-1',
    employeeId: 'emp-1',
    purpose: 'execute' as const,
    traceId: 't',
    ...extra,
  });
  return { executor, job, statuses, requests, orchestration, budget, broker, tasks };
}

/** Agent gọi email_send (broker trả pending_approval) rồi provider phát paused_for_approval. */
async function* pausing(_req: AgentRunRequest, io: AgentRunIO): AsyncGenerator<AgentRunEvent> {
  yield { type: 'session', sessionId: 's-1' };
  await io.invokeTool({ name: 'email_send', input: {}, providerCallId: 'p' });
  yield { type: 'paused_for_approval', approvalRequestId: 'apr-1' };
}

async function* finishing(): AsyncGenerator<AgentRunEvent> {
  yield { type: 'finished', output: { summary: 'xong' }, text: 'xong' };
}

describe('RunExecutor — tạm dừng chờ Human Approval (US4)', () => {
  it('provider phát paused_for_approval → run sang waiting_approval, trả ngân sách đang giữ, không thành công/thất bại', async () => {
    const { executor, job, statuses, budget, tasks } = setup(pausing);
    await executor.execute(job());
    expect(statuses.filter((s) => s.status).map((s) => s.status)).toEqual([
      'running',
      'waiting_approval',
    ]);
    expect(budget.releaseRun).toHaveBeenCalled();
    expect(tasks.transition).not.toHaveBeenCalled(); // task giữ In Progress
  });

  it('tạm dừng mà không có yêu cầu phê duyệt (tool bị khóa vì task đổi trạng thái) → run bị hủy, không treo ở waiting_approval', async () => {
    const { executor, job, statuses, broker } = setup(pausing);
    broker.invoke.mockImplementation(
      async () => ({ status: 'run_locked', message: 'khóa' }) as never,
    );
    await executor.execute(job());
    expect(statuses.filter((s) => s.status).map((s) => s.status)).toEqual(['running', 'cancelled']);
    expect(statuses.at(-1)?.errorCode).toBe('TASK_STATE_CHANGED');
  });
});

describe('RunExecutor — resume sau quyết định phê duyệt (US4-AS5)', () => {
  it('chỉ resume run đang waiting_approval; run ở trạng thái khác bị bỏ qua', async () => {
    const queued = setup(finishing, { status: 'queued' });
    await queued.executor.execute(queued.job({ approvalRequestId: 'apr-1' }));
    expect(queued.statuses).toEqual([]);
    expect(queued.requests).toHaveLength(0);

    const waiting = setup(finishing, { status: 'waiting_approval' });
    await waiting.executor.execute(waiting.job());
    expect(waiting.statuses).toEqual([]); // job run thường không đụng run đang chờ duyệt
  });

  it('SDK: nối lại session cũ, prompt là kết quả duyệt (dữ liệu), reserve lại ngân sách, hoàn tất → succeeded', async () => {
    const t = setup(finishing, { status: 'waiting_approval' });
    await t.executor.execute(t.job({ approvalRequestId: 'apr-1' }));
    const req = t.requests[0]!;
    expect(req.resumeSessionId).toBe('s-1');
    expect(req.input).toContain('approval_result');
    expect(req.input).toContain('"decision":"approved"');
    expect(req.input).toContain('"executed":true');
    expect(req.input).not.toContain('INPUT-GOC'); // không lặp lại toàn bộ đề bài khi đã có session
    expect(t.budget.reserve).toHaveBeenCalledTimes(1);
    expect(t.statuses.filter((s) => s.status).map((s) => s.status)).toEqual([
      'running',
      'succeeded',
    ]);
  });

  it('từ chối: agent nhận lý do từ chối và biết hành động KHÔNG được thực thi', async () => {
    const t = setup(finishing, {
      status: 'waiting_approval',
      approval: { status: 'rejected', decisionReason: 'Không gửi cho người lạ' },
    });
    t.orchestration.getRun.mockResolvedValue({
      id: 'run-1',
      status: 'waiting_approval',
      runtimeKind: 'claude_agent_sdk',
      modelId: 'm',
      purpose: 'execute',
      providerSessionId: 's-1',
      steps: [],
      toolInvocations: [
        { id: 'inv-1', status: 'denied', adapterMode: null, result: { rejected: true } },
      ],
    } as never);
    await t.executor.execute(t.job({ approvalRequestId: 'apr-1' }));
    const input = t.requests[0]!.input;
    expect(input).toContain('"decision":"rejected"');
    expect(input).toContain('"executed":false');
    expect(input).toContain('Không gửi cho người lạ');
  });

  it('messages_api: nạp hội thoại đã lưu và đưa kết quả duyệt làm lượt user mới', async () => {
    const saved = [{ role: 'user', content: 'goc' }];
    const t = setup(finishing, {
      status: 'waiting_approval',
      runtimeKind: 'messages_api',
      conversation: saved,
    });
    await t.executor.execute(t.job({ approvalRequestId: 'apr-1' }));
    const req = t.requests[0]!;
    expect(req.resumeConversation).toEqual(saved);
    expect(req.input).toContain('approval_result');
  });

  it('mất session và hội thoại: bắt đầu lại với đề bài gốc kèm kết quả duyệt (ledger chặn việc lặp hành động)', async () => {
    const t = setup(finishing, { status: 'waiting_approval', providerSessionId: null });
    await t.executor.execute(t.job({ approvalRequestId: 'apr-1' }));
    const req = t.requests[0]!;
    expect(req.resumeSessionId).toBeUndefined();
    expect(req.input).toContain('INPUT-GOC');
    expect(req.input).toContain('approval_result');
  });

  it('không đủ ngân sách để resume → run thất bại, task blocked BUDGET_EXCEEDED', async () => {
    const t = setup(finishing, { status: 'waiting_approval' });
    t.budget.reserve.mockResolvedValue({
      ok: false,
      limitHit: { kind: 'cost', scopeKind: 'company' },
    } as never);
    await t.executor.execute(t.job({ approvalRequestId: 'apr-1' }));
    expect(t.tasks.transition).toHaveBeenCalledWith(
      expect.anything(),
      'task-1',
      'block',
      expect.objectContaining({ blockedReason: 'BUDGET_EXCEEDED' }),
    );
  });
});
